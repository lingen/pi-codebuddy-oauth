// src/index.ts — Pi 扩展入口：注册 codebuddy provider（HTTP 直连 /v2/chat/completions）
//
// 数据流：
//   Pi agent → modelRuntime.streamSimple（auth 解析 + before_provider_headers 合并）
//     → 本插件 streamSimple wrapper（注入动态头 + 自定义 fetch）
//     → auth-fetch 拦截器（认证头注入 + 401 刷新重试 + 11133 瞬时 400 退避）
//     → ${server}/v2/chat/completions
//
// 与 opencode 版的对应关系：
//   opencode auth.loader.fetch  → SimpleStreamOptions.fetch（auth-fetch 拦截器）
//   opencode chat.headers       → wrapper 内 options.headers（provider 边界清晰，事件无 provider 信息）
//   opencode config（模型发现） → registerProvider.models + 登录/启动后主动发现重注册
//   opencode auth.methods       → registerProvider.oauth.login / refreshToken（Pi 原生 /login）
//
// 防识别说明（修改必读，详见 README）：
// - X-Conversation-ID 稳定复用 + 按 turn 轮换；X-Request-ID 系每次 HTTP 尝试必换（含重试）。
// - X-Machine-Id 稳定设备 ID，落盘复用；勿每次生成 fresh UUID。
// - 版本四件套（UA/X-IDE-*）成对覆盖；Accept-Language 必带。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getConfig, resolveServerUrl, PROVIDER_ID, CHAT_COMPLETIONS_PATH, POLL_TOTAL_TIMEOUT_MS, DEFAULT_EXPIRES_MS, STARTUP_DISCOVERY_TIMEOUT_MS, DISCOVERY_CACHE_TTL_MS, DISCOVERY_FALLBACK_TTL_MS } from "./config.js";
import { createLogger } from "./log.js";
import { LRUMap } from "./lru.js";
import { ConversationTracker } from "./conversation.js";
import { getOrCreateDeviceId } from "./device.js";
import { effectiveAuth, pickAuthMode } from "./auth-state.js";
import type { AuthState } from "./auth-state.js";
import { requestAuthState, pollForToken, refreshAccessToken } from "./auth-flow.js";
import { createAuthFetch } from "./auth-fetch.js";
import { createCodebuddyStreamSimple } from "./stream.js";
import { buildRequestHeaders, buildAuthHeaders, buildAttemptHeaders } from "./headers.js";
import { resolveIdentity, decodeJwtPayload } from "./jwt.js";
import { fetchRemoteModels, remoteModelToPi, DEFAULT_MODEL, DiscoveryCache, type RemoteModel } from "./models.js";
import { readCachedModels, writeCachedModels } from "./model-cache.js";
import * as fs from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export default async function codebuddyExtension(pi: ExtensionAPI) {
  const cfg = getConfig();
  const server = resolveServerUrl(cfg);
  const logger = createLogger();
  const conversationIds = new LRUMap<string, string>(cfg.conversationMapMax);
  const tracker = new ConversationTracker(conversationIds, { maxTurns: cfg.conversationMaxTurns });
  const discoveryCache = new DiscoveryCache({
    ttlMs: DISCOVERY_CACHE_TTL_MS,
    fallbackTtlMs: DISCOVERY_FALLBACK_TTL_MS,
    fetchFn: (token, signal) => fetchRemoteModels(token, server, signal, cfg, cfg.discoveryTimeoutMs),
  });

  // 自定义 endpoint 经代理时 SNI 与 X-Domain 不一致，传输层直接暴露；提醒一次
  try {
    if (cfg.endpoint) {
      const host = new URL(server.url).host;
      const looksOfficial = /codebuddy|tencent/i.test(host);
      if (!looksOfficial) {
        logger.warn(`custom endpoint ${server.url} detected — SNI/X-Domain mismatch weakens anti-detection; prefer direct connection`);
      }
    }
  } catch { /* URL 解析失败不影响运行 */ }

  // 稳定设备 ID（防识别）：落盘复用，随 X-Machine-Id 发送；失败则本次进程用临时 ID
  let deviceId = "";
  try {
    deviceId = await getOrCreateDeviceId();
  } catch {
    deviceId = "";
  }

  // --- token 快照（~/.pi/agent/codebuddy-auth.json）---
  // Pi CredentialStore 不对扩展暴露读取接口；login/refresh 全部经过本扩展，
  // 顺手落一份独立快照供请求时读取。真实凭据源仍是 Pi auth.json（由 Pi 自动持久化）。
  // 安全：600 权限 + 原子写（tmp+rename）；双源漂移时以 Pi store 为准，快照仅为请求期读取缓存。
  const snapshotPath = join(homedir(), CONFIG_DIR_NAME || ".pi", "agent", "codebuddy-auth.json");
  const syncSnapshot: { value: OAuthCredentials | undefined } = { value: undefined };

  async function loadSnapshot(): Promise<void> {
    try {
      const raw = await fs.readFile(snapshotPath, "utf8");
      const o = JSON.parse(raw) as Partial<OAuthCredentials>;
      if (typeof o.access === "string" && o.access) {
        syncSnapshot.value = { access: o.access, refresh: o.refresh ?? "", expires: o.expires ?? 0 };
      }
      // 收紧已存在文件的权限（best-effort，Windows 上可能失败）
      try {
        await fs.chmod(snapshotPath, 0o600);
      } catch { /* 忽略 */ }
    } catch { /* 不存在或损坏 → 未登录 */ }
  }
  await loadSnapshot();

  async function persistSnapshot(cred: OAuthCredentials): Promise<void> {
    syncSnapshot.value = cred;
    try {
      await fs.mkdir(dirname(snapshotPath), { recursive: true });
      const tmp = `${snapshotPath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 });
      await fs.rename(tmp, snapshotPath);
      try {
        await fs.chmod(snapshotPath, 0o600);
      } catch { /* 忽略 */ }
    } catch (e) {
      logger.error(`snapshot write failed: ${(e as Error).message}`);
    }
  }

  function credToAuthState(cred: OAuthCredentials | undefined): AuthState | undefined {
    if (!cred) return undefined;
    return { type: "oauth", access: cred.access, refresh: cred.refresh ?? "", expires: cred.expires ?? 0 };
  }

  // --- 刷新（auth-fetch 401 兜底用）：单飞 + 写快照 ---
  // Pi 原生 refreshToken 仅在 resolveStoredOAuth 过期路径触发；流中途 401 由这里兜底
  class RefreshLock {
    private inflight: Promise<AuthState | null> | null = null;
    run(fn: () => Promise<AuthState | null>): Promise<AuthState | null> {
      if (this.inflight) return this.inflight;
      this.inflight = fn().finally(() => { this.inflight = null; });
      return this.inflight;
    }
  }
  const refreshLock = new RefreshLock();

  async function refreshAndPersist(oauthAuth: AuthState & { type: "oauth" }): Promise<AuthState | null> {
    return refreshLock.run(async () => {
      const r = await refreshAccessToken(oauthAuth.refresh, server.url);
      if (r?.accessToken) {
        const cred: OAuthCredentials = {
          access: r.accessToken,
          refresh: r.refreshToken || oauthAuth.refresh,
          expires: r.expiresIn ? Date.now() + r.expiresIn * 1000 : Date.now() + DEFAULT_EXPIRES_MS,
        };
        await persistSnapshot(cred);
        return credToAuthState(cred)!;
      }
      logger.warn("token refresh failed — token may be expired, re-run /login codebuddy");
      return null;
    });
  }

  // --- auth-fetch 拦截器 + streamSimple wrapper ---
  const authFetch = createAuthFetch({
    getAuth: async () => effectiveAuth(credToAuthState(syncSnapshot.value), cfg),
    server,
    buildAuthHeaders,
    resolveIdentity: resolveIdentity as unknown as AuthFetchDeps_resolveIdentity,
    decodeJwtPayload,
    refreshAndPersist,
    cfg,
    logger,
    chatCompletionsPath: CHAT_COMPLETIONS_PATH,
    // 每次 HTTP 尝试换新鲜 Request-ID 系头部（Conversation-ID 保持稳定，由 wrapper 注入）
    freshAttemptHeaders: () => buildAttemptHeaders(),
  });
  const streamSimple = createCodebuddyStreamSimple(authFetch, {
    buildHeaders: (model, options) =>
      buildRequestHeaders(options?.sessionId, model.id, { cfg, server, tracker, deviceId }),
  });

  // --- 模型列表 ---
  function modelsFromRemote(remote: RemoteModel[]) {
    return remote.map(remoteModelToPi);
  }
  function fallbackModels() {
    return modelsFromRemote([DEFAULT_MODEL]);
  }
  // 启动种子：优先用上次落盘的模型列表，避免会话恢复时模型还没发现完（见 model-cache.ts）
  // 刻意不打日志：命中缓存是常规路径，每次启动都打印会污染 TUI/print 输出
  const cachedModels = await readCachedModels();
  let registeredModels = cachedModels.length ? cachedModels : fallbackModels();

  // 主动发现 + 重注册（registerProvider 可随时调用并立即生效）
  async function discoverAndReregister(token: string, opts?: { timeoutMs?: number }): Promise<void> {
    try {
      // 启动期用短超时，避免离线罚站；常规 refreshModels 走正常 TTL/超时
      const remote = opts?.timeoutMs
        ? await fetchRemoteModels(token, server, undefined, cfg, opts.timeoutMs).then((r) => r)
        : await discoveryCache.get(token, { signal: undefined });
      const models = modelsFromRemote(remote);
      if (!models.length) return;
      registeredModels = models;
      register(models);
      await writeCachedModels(models);
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (status === 401 || status === 403) {
        logger.warn("model discovery 401/403 — token may be expired, re-run /login codebuddy");
      } else {
        logger.warn(`model discovery failed: ${(e as Error).message}`);
      }
    }
  }

  function register(models: typeof registeredModels) {
    pi.registerProvider(PROVIDER_ID, {
      name: "CodeBuddy",
      baseUrl: `${server.url}/v2`,
      api: "openai-completions",
      // 认证统一由 auth-fetch 拦截器注入（oauth 双头身份 + api 双头 key）；
      // apiKey 仅作为 OpenAI client 的占位（拦截器会覆写 Authorization）
      apiKey: cfg.apiKey || "not-used",
      models: models as never,
      streamSimple,
      oauth: {
        name: "CodeBuddy (IOA)",
        async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
          const state = await requestAuthState(server.url, cfg.platform);
          callbacks.onAuth({ url: state.url, instructions: "请在浏览器中完成 IOA 登录" });
          const expiresAt = Date.now() + POLL_TOTAL_TIMEOUT_MS;
          const tok = await pollForToken(server.url, state.state, expiresAt, callbacks.signal);
          if (!tok?.accessToken) throw new Error("CodeBuddy IOA login failed or timed out");
          const cred: OAuthCredentials = {
            access: tok.accessToken,
            refresh: tok.refreshToken || "",
            expires: tok.expiresIn ? Date.now() + tok.expiresIn * 1000 : Date.now() + DEFAULT_EXPIRES_MS,
          };
          await persistSnapshot(cred);
          // 登录后立即发现模型并重注册（Pi 的 credential-change refresh 走 allowNetwork:false，不触发网络发现）
          void discoverAndReregister(cred.access);
          return cred;
        },
        async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
          if (!credentials.refresh) throw new Error("codebuddy: no refresh token stored");
          const r = await refreshAccessToken(credentials.refresh, server.url);
          if (!r?.accessToken) throw new Error("codebuddy: token refresh failed — re-run /login codebuddy");
          const cred: OAuthCredentials = {
            access: r.accessToken,
            refresh: r.refreshToken || credentials.refresh,
            expires: r.expiresIn ? Date.now() + r.expiresIn * 1000 : Date.now() + DEFAULT_EXPIRES_MS,
          };
          await persistSnapshot(cred);
          return cred;
        },
        getApiKey(credentials: OAuthCredentials): string {
          return credentials.access;
        },
      },
      refreshModels: async (context: RefreshModelsContext) => {
        // Pi 允许网络时按凭据发现；登录后的 credential-change 刷新 allowNetwork=false，走 fallback
        const cred = context.credential?.type === "oauth" ? context.credential : undefined;
        if (cred?.access && context.allowNetwork) {
          try {
            const remote = await discoveryCache.get(cred.access, { signal: context.signal });
            const models = modelsFromRemote(remote);
            if (models.length) {
              registeredModels = models;
              await writeCachedModels(models);
              return models as never;
            }
          } catch (e) {
            logger.warn(`model discovery failed: ${(e as Error).message}`);
          }
        }
        return registeredModels as never;
      },
    } as never);
  }

  register(registeredModels);

  // 启动时已有快照 token → 发现真实模型列表
  // 启动用短超时（默认 2.5s）：短命进程（--list-models）仍能等到写缓存，离线用户不被罚 5s。
  // 超时后后台 refreshModels（allowNetwork）会补全；缓存种子保证首屏模型可用。
  const mode = pickAuthMode(cfg, credToAuthState(syncSnapshot.value));
  if (mode === "oauth" && syncSnapshot.value?.access) {
    const token = syncSnapshot.value.access;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), STARTUP_DISCOVERY_TIMEOUT_MS);
    try {
      const remote = await fetchRemoteModels(token, server, ctrl.signal, cfg, STARTUP_DISCOVERY_TIMEOUT_MS);
      const models = modelsFromRemote(remote);
      if (models.length) {
        registeredModels = models;
        register(models);
        await writeCachedModels(models);
      }
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (status === 401 || status === 403) {
        logger.warn("model discovery 401/403 — token may be expired, re-run /login codebuddy");
      } else {
        logger.warn(`model discovery failed: ${(e as Error).message}`);
      }
    } finally {
      clearTimeout(timer);
    }
  } else if (mode === "api" && !cfg.apiKey) {
    logger.warn("api key mode requested but no key found — set CODEBUDDY_API_KEY");
  }

  // --- compaction 后淘汰 conversation-id（对应 opencode session.compacted）---
  pi.on("session_before_compact", (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    if (sid) tracker.delete(sid);
  });
}

// 仅为避开 `resolveIdentity as any` 的 eslint 噪音而起的别名（行为不变）
type AuthFetchDeps_resolveIdentity = (payload: unknown, cfg: unknown) => { tenantId: string; enterpriseId: string; userId: string };
