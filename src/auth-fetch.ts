// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Ming Lo — 源自 https://github.com/minglo/opencode-codebuddy-oauth (MIT)
// src/auth-fetch.ts — Pi 版 auth 拦截器
// 1. 删除 SSE 缓冲（pi-ai 原生解析 SSE，无 opencode UI 碎片化问题）
// 2. 删除预刷新（Pi resolveStoredOAuth 原生 5min skew 预刷新 + 双检锁）
// 3. 401 刷新经 refreshAndPersist 回调落地到 Pi CredentialStore（由 index.ts 接线）
// 4. 11133 瞬时 400 退避重发保留（加抖动，防识别）
//
// 防识别要点：
// - 每次 HTTP 尝试（含重试）必换 X-Request-ID 系头部；复用同一 Request-ID 重发是强签名（已修复）。
// - 退避加 ±20% 抖动；固定节律全网一致会被时序聚类（已修复）。
// - 仅 401 触发刷新；403 多为租户/权限永久失败，刷新只是浪费 refresh-token 配额且多一次异常请求（已修复）。
// - 非字符串 body（Stream/FormData）不可幂等重发，只走单次尝试（已修复）。
// - CODEBUDDY_MODEL 覆盖时同步改写 body.model，避免“头与 body 不一致”的改写痕迹（已修复）。
import type { AuthState } from "./auth-state.js";
import type { CodeBuddyConfig } from "./config.js";
import type { Logger } from "./log.js";
import { jitteredDelay } from "./jitter.js";

export type AuthFetchDeps = {
  getAuth: () => Promise<AuthState | null>;
  server: { url: string; domain: string };
  buildAuthHeaders: (auth: AuthState, identity: { tenantId: string; enterpriseId: string; userId: string }) => Record<string, string>;
  resolveIdentity: (payload: unknown, cfg: unknown) => { tenantId: string; enterpriseId: string; userId: string };
  decodeJwtPayload: (token: string) => unknown;
  refreshAndPersist: (oauthAuth: AuthState & { type: "oauth" }) => Promise<AuthState | null>;
  cfg: CodeBuddyConfig;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  chatCompletionsPath: string;
  /** 每次 HTTP 尝试的新鲜 ID 组（不含 Conversation-ID）；由 index.ts 传入 buildAttemptHeaders */
  freshAttemptHeaders?: () => Record<string, string>;
  /** 测试注入：抖动随机源 */
  rand?: () => number;
};

export const TRANSIENT_400_RETRIES = 4;
export const RETRY_DELAYS_MS = [1000, 4000, 10000, 25000];

export function createAuthFetch(deps: AuthFetchDeps) {
  const { getAuth, server, buildAuthHeaders, resolveIdentity, decodeJwtPayload, refreshAndPersist, cfg, fetchImpl, chatCompletionsPath } = deps;
  const doFetch = () => fetchImpl ?? globalThis.fetch;
  const rand = deps.rand ?? Math.random;
  let lastRefreshFailedAt = 0;
  const COOLDOWN_MS = 15_000;
  const inCooldown = () => Date.now() - lastRefreshFailedAt < COOLDOWN_MS;

  return async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = url.toString();
    if (!urlStr.includes(chatCompletionsPath)) return doFetch()(url, init);
    const auth = await getAuth();
    if (!auth) {
      // 不抛异常：OpenAI SDK 会把 fetch 抛错包装成 "Connection error" 丢失信息；
      // 返回 401 Response 走 SDK 标准错误路径，message 保留我们的指引
      return new Response(JSON.stringify({ error: { message: "codebuddy: not authenticated — run `/login codebuddy` (oauth) or set CODEBUDDY_API_KEY" } }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    if (!init?.body) return new Response(JSON.stringify({ error: "Missing request body" }), { status: 400, headers: { "Content-Type": "application/json" } });

    // 只有字符串 JSON body 可幂等重发；Stream/FormData/Blob 消费后无法二次发送
    const replayable = typeof init.body === "string";
    const baseBodyText = replayable ? (init.body as string) : undefined;

    /** 按当前 auth 准备一次请求的 headers+body；每次调用都换新鲜 Request-ID 系头部 */
    const prepareRequest = (a: AuthState): { headers: Headers; body: BodyInit } => {
      const headers = new Headers(init.headers as HeadersInit);
      const identity = a.type === "oauth" ? resolveIdentity(decodeJwtPayload(a.access), cfg) : { tenantId: "", enterpriseId: "", userId: "" };
      for (const [k, v] of Object.entries(buildAuthHeaders(a, identity))) headers.set(k, v);
      // 重试必须换 Request-ID：服务端看“同一 Request-ID 短时间 POST 多次”即判定重放
      if (deps.freshAttemptHeaders) {
        for (const [k, v] of Object.entries(deps.freshAttemptHeaders())) headers.set(k, v);
      }
      let body: BodyInit = init.body as BodyInit;
      if (baseBodyText !== undefined) {
        try {
          const parsed = JSON.parse(baseBodyText) as Record<string, unknown>;
          let mutated = false;
          if (parsed.stream === true && !(parsed as Record<string, unknown>).stream_options) {
            (parsed as Record<string, unknown>).stream_options = { include_usage: true };
            mutated = true;
          }
          // 头与 body 一致性：CODEBUDDY_MODEL 覆盖时同步改写 body.model，避免网关看到双值
          const resolved = cfg.model;
          if (resolved && typeof parsed.model === "string" && parsed.model !== resolved) {
            parsed.model = resolved;
            mutated = true;
          }
          body = mutated ? JSON.stringify(parsed) : baseBodyText;
        } catch {
          body = baseBodyText;
        }
      }
      return { headers, body: body as BodyInit };
    };

    const doRequest = async (a: AuthState) => {
      const { headers, body } = prepareRequest(a);
      return doFetch()(`${server.url}${chatCompletionsPath}`, { method: "POST", headers, body: body as BodyInit, signal: init.signal });
    };

    let activeAuth: AuthState = auth;
    let response = await doRequest(activeAuth);
    // 仅 401 触发刷新重试：403 多为永久失败（租户/权限），刷新无意义且多一次异常请求
    if (activeAuth.type === "oauth" && response.status === 401 && activeAuth.refresh && !inCooldown()) {
      if (!replayable) return response;
      try {
        const next = await refreshAndPersist(activeAuth);
        if (next) {
          lastRefreshFailedAt = 0;
          activeAuth = next;
          response = await doRequest(activeAuth);
        } else {
          lastRefreshFailedAt = Date.now();
        }
      } catch {
        lastRefreshFailedAt = Date.now();
      }
    }
    // 瞬时 400（code 11133）重试：CodeBuddy 网关偶发把上游厂商的瞬时校验失败包装成 11133 返回
    // （服务端侧故障窗口，同构请求稍后重发即成功）。body 为字符串 JSON 可幂等重发；400 到达即流未开始。
    // 非 replayable body 直接返回，避免二次发送已消费的流。
    if (!replayable) return response;
    for (let attempt = 0; response.status === 400 && attempt < TRANSIENT_400_RETRIES; attempt++) {
      const text = await response.text();
      let code: unknown;
      try { code = (JSON.parse(text) as { code?: unknown })?.code; } catch { /* 非 JSON 按非 11133 处理 */ }
      if (code !== 11133) {
        const h = new Headers(response.headers);
        h.set("Content-Type", "application/json");
        return new Response(text, { status: 400, headers: h });
      }
      if (init.signal?.aborted) break;
      const waitMs = jitteredDelay(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)], rand);
      deps.logger?.warn(`upstream transient 400 (11133), retry ${attempt + 1}/${TRANSIENT_400_RETRIES} in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      if (init.signal?.aborted) break;
      response = await doRequest(activeAuth);
    }
    if (!response.ok) {
      const text = await response.text();
      const h = new Headers(response.headers);
      h.set("Content-Type", "application/json");
      return new Response(text, { status: response.status, headers: h });
    }
    return response;
  };
}
