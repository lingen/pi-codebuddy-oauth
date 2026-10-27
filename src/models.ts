// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Ming Lo — 源自 https://github.com/minglo/opencode-codebuddy-oauth (MIT)
// src/models.ts — 平移自 opencode-codebuddy-oauth；RemoteModel → Pi ProviderModelConfig
import { fetchJson } from "./fetch-json.js";
import { AGENT_INTENT, DISCOVERY_TIMEOUT_MS, IDE_NAME, IDE_TYPE, IDE_VERSION, APP_VERSION, ENV_ID, PRODUCT, type CodeBuddyConfig } from "./config.js";

export interface RemoteModel { id:string; name:string; maxInputTokens?:number; maxOutputTokens?:number; maxAllowedSize?:number; supportsToolCall?:boolean; supportsImages?:boolean; supportsReasoning?:boolean; disabledMultimodal?:boolean; reasoning?:{ effort?:string; defaultEffort?:string; supportedEfforts?:string[] }; }
export const DEFAULT_MODEL: RemoteModel = { id:"auto", name:"Auto", maxInputTokens:168000, maxOutputTokens:32000, supportsToolCall:true };

export interface PiModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string>;
  compat?: { supportsDeveloperRole?: boolean };
}

export interface RemoteConfigResponse { code:number; data?:{ agents?:Array<{name:string; models?:string[]}>; models?:RemoteModel[] } }
export interface FetchVersions {
  ideName: string; ideType: string; ideVersion: string;
  appVersion: string; agentIntent: string; envId: string; product: string;
  acceptLanguage: string;
}

function versionsFromCfg(cfg: Partial<CodeBuddyConfig>): FetchVersions {
  return {
    ideName: cfg.ideName ?? IDE_NAME,
    ideType: cfg.ideType ?? IDE_TYPE,
    ideVersion: cfg.ideVersion ?? IDE_VERSION,
    appVersion: cfg.appVersion ?? APP_VERSION,
    agentIntent: cfg.agentIntent ?? AGENT_INTENT,
    envId: cfg.envId ?? ENV_ID,
    product: cfg.product ?? PRODUCT,
    acceptLanguage: cfg.acceptLanguage ?? "zh-CN,zh;q=0.9,en;q=0.8",
  };
}

export async function fetchRemoteModels(
  accessToken: string,
  server: { url: string; domain: string },
  signal?: AbortSignal,
  versions?: Partial<CodeBuddyConfig>,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<RemoteModel[]> {
  const v = versionsFromCfg(versions ?? {});
  const headers: Record<string,string> = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "Accept-Language": v.acceptLanguage,
    Authorization: `Bearer ${accessToken}`,
    "X-Agent-Intent": v.agentIntent,
    "X-IDE-Type": v.ideType, "X-IDE-Name": v.ideName, "X-IDE-Version": v.ideVersion,
    "X-Product-Version": v.appVersion, "X-Env-ID": v.envId,
    "X-Domain": server.domain, "X-Product": v.product,
    "User-Agent": `${v.ideName}/${v.ideVersion} CodeBuddy/${v.appVersion}`,
  };
  const res = await fetchJson<RemoteConfigResponse>(`${server.url}/v3/config`, {
    headers, timeoutMs, signal,
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      const e = new Error(`discovery ${res.status}`) as Error & { status?: number };
      e.status = res.status;
      throw e;
    }
    return [];
  }
  const body = res.data;
  if (!body || body.code !== 0 || !body.data) return [];
  const allModels = body.data.models || [];
  const modelMap = new Map(allModels.map((m) => [m.id, m]));
  const craftAgent = (body.data.agents || []).find((a) => a.name === AGENT_INTENT);
  const craftIds = craftAgent?.models || [];
  if (craftIds.length === 0) return [DEFAULT_MODEL];
  return craftIds
    .map((id) => modelMap.get(id))
    .filter((m): m is RemoteModel => m !== undefined && m.supportsToolCall !== false);
}

const DEFAULT_CONTEXT = 131_072;
const DEFAULT_MAX_TOKENS = 8192;

function detectThinking(id: string): boolean {
  return /claude|gemini|gpt-5|hy3|deepseek|glm/i.test(id);
}

function detectImages(id: string): boolean {
  return /claude|gemini|gpt/i.test(id);
}

/** RemoteModel → Pi ProviderModelConfig 所需字段
 *
 * 防识别/正确性：服务端字段优先，id 正则只是兜底。新模型 id 命名一变正则即错配，
 * 而服务端 supportsReasoning/supportsImages 是权威信号。
 */
export function remoteModelToPi(m: RemoteModel): PiModelConfig {
  const contextWindow = m.maxAllowedSize ?? m.maxInputTokens ?? DEFAULT_CONTEXT;
  const maxTokens = m.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  // supportsReasoning 明确时以服务端为准；undefined 时才用 id 正则兜底（兼容老网关）
  const reasoning = m.supportsReasoning !== undefined ? m.supportsReasoning : detectThinking(m.id);
  // supportsImages 明确时以服务端为准；undefined 时用正则兜底；disabledMultimodal 一票否决
  const imagesByServer = m.supportsImages !== undefined ? m.supportsImages : detectImages(m.id);
  const cfg: PiModelConfig = {
    id: m.id,
    name: m.name,
    reasoning,
    input: (imagesByServer && !m.disabledMultimodal) ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    // CodeBuddy 网关不接受 assistant-role 之外的 system→developer 角色：pi-ai 对
    // reasoning 模型默认发 role:"developer" 承载 systemPrompt，网关返回 400 (code 11128)，
    // 且 body 无 error 字段 → OpenAI SDK 报 "400 status code (no body)"。强制回退 system。
    compat: { supportsDeveloperRole: false },
  };
  const effort = m.reasoning?.defaultEffort ?? m.reasoning?.effort;
  const efforts = m.reasoning?.supportedEfforts;
  if (cfg.reasoning && efforts?.length) {
    cfg.thinkingLevelMap = Object.fromEntries(efforts.map((e) => [e, e]));
    if (effort) cfg.thinkingLevelMap.default = effort;
  }
  return cfg;
}

export class DiscoveryCache {
  private data: RemoteModel[] | null = null;
  private fetchedAt = 0;
  private isFallback = false;
  private inflight: Promise<RemoteModel[]> | null = null;
  private readonly fetchFn: (token: string, signal?: AbortSignal) => Promise<RemoteModel[]>;
  constructor(private opts: { ttlMs: number; fallbackTtlMs?: number; fetchFn: (token: string, signal?: AbortSignal) => Promise<RemoteModel[]> }) { this.fetchFn = opts.fetchFn; }
  /** 测试钩子 */
  __isFallback(): boolean { return this.isFallback; }
  async get(token: string, { signal }: { signal?: AbortSignal }): Promise<RemoteModel[]> {
    const now = Date.now();
    // fallback 用短 TTL（默认 30s），正常数据用长 TTL（默认 5min）：
    // 失败时用 [DEFAULT_MODEL] 顶上但不压制后续重试，避免 5 分钟内不再发现
    const ttl = this.isFallback ? (this.opts.fallbackTtlMs ?? 30 * 1000) : this.opts.ttlMs;
    if (this.data && (now - this.fetchedAt) < ttl) return this.data;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchFn(token, signal).then((d) => {
      this.data = d.length ? d : [DEFAULT_MODEL];
      this.isFallback = !d.length;
      this.fetchedAt = Date.now();
      return this.data;
    }).catch((e) => {
      if ((e as unknown as { status?: number })?.status === 401 || (e as unknown as { status?: number })?.status === 403) throw e;
      if (!this.data) {
        // 无历史数据：返回 fallback 但标记为 fallback，下次按短 TTL 重试
        this.data = [DEFAULT_MODEL];
        this.isFallback = true;
        this.fetchedAt = now;
        return this.data;
      }
      return this.data;
    }).finally(() => { this.inflight = null; });
    if (this.data) { this.inflight.catch(() => {}); return this.data; }
    return this.inflight;
  }
}
