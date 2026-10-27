// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Ming Lo — 源自 https://github.com/minglo/opencode-codebuddy-oauth (MIT)
// src/config.ts — 平移自 opencode-codebuddy-oauth；去掉 SSE 配置与 OpenCode auth.json 路径
export const PROVIDER_ID = "codebuddy";
export const CHAT_COMPLETIONS_PATH = "/v2/chat/completions";
export const PLATFORM = "VSCode";
export const APP_VERSION = "4.9.29177644";
export const IDE_NAME = "VSCode";
export const IDE_TYPE = "VSCode";
export const IDE_VERSION = "1.119.0";
export const DOMAIN_DEFAULT = "www.codebuddy.cn";
export const PRODUCT = "SaaS";
export const AGENT_INTENT = "craft";
export const ENV_ID = "production";
export const DISCOVERY_TIMEOUT_MS = 5000;
export const POLL_INTERVAL_MS = 3000;
export const POLL_TIMEOUT_MS = 8000;
export const POLL_TOTAL_TIMEOUT_MS = 10*60*1000;
export const AUTH_STATE_TIMEOUT_MS = 5000;
export const REFRESH_TIMEOUT_MS = 5000;
export const REFRESH_SKEW_MS = 5*60*1000;
export const DEFAULT_EXPIRES_MS = 24*60*60*1000;
export const DISCOVERY_CACHE_TTL_MS = 5*60*1000;
// fallback（无网络时用 auto 顶上）的负缓存 TTL：比正常 TTL 短得多，避免 5 分钟内不再重试发现
// （防识别附带收益：离线/弱网时不会每请求都打 /v3/config 形成固定节律）
export const DISCOVERY_FALLBACK_TTL_MS = 30*1000;
// 启动期发现超时：短命进程（--list-models）需要等发现写缓存，但离线用户不应被罚 5s
// 启动走更短的超时，后台 refreshModels 会补全

export const STARTUP_DISCOVERY_TIMEOUT_MS = 2500;
// 同一 conversation 连续复用的最大 turn 数，超过后轮换新 ID
// （防识别：真实 IDE 按任务切 conversation，单个 conversation 跑几百 turn 且主题混杂极易被画像）
export const CONVERSATION_MAX_TURNS_DEFAULT = 50;

export interface CodeBuddyConfig {
  endpoint?: string; network: "internal"|"ioa"|"internet"; auth: "auto"|"oauth"|"api";
  model?: string; stableConversationId: boolean; conversationMapMax: number;
  conversationMaxTurns: number; discoveryTimeoutMs: number;
  tenantId?:string; enterpriseId?:string; userId?:string;
  apiKey?:string; platform:string; appVersion:string; ideName:string; ideType:string; ideVersion:string;
  domain:string; product:string; agentIntent:string; envId:string;
  acceptLanguage:string; machineId:string;
}

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

// Accept-Language 跟随系统 locale，缺省按国内默认 zh-CN（与默认国内端点配对）；
// 英文系统自动切 en-US。可用 CODEBUDDY_ACCEPT_LANGUAGE 强制覆盖。
// （防识别：真实 Electron 必带此头，缺失是一行规则就能判定的指纹）
export function resolveAcceptLanguage(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CODEBUDDY_ACCEPT_LANGUAGE;
  if (override && override.trim()) return override.trim();
  const lang = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  if (/^en/i.test(lang)) return "en-US,en;q=0.9";
  return "zh-CN,zh;q=0.9,en;q=0.8";
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): CodeBuddyConfig {
  return {
    endpoint: env.CODEBUDDY_ENDPOINT || "",
    network: (env.CODEBUDDY_NETWORK || "internal").toLowerCase() as CodeBuddyConfig["network"],
    auth: (env.CODEBUDDY_AUTH || "auto").toLowerCase() as CodeBuddyConfig["auth"],
    model: env.CODEBUDDY_MODEL || "",
    stableConversationId: env.CODEBUDDY_STABLE_CONVERSATION !== "0",
    conversationMapMax: num(env.CODEBUDDY_CONVERSATION_MAP_MAX, 1000),
    conversationMaxTurns: num(env.CODEBUDDY_CONVERSATION_MAX_TURNS, CONVERSATION_MAX_TURNS_DEFAULT),
    discoveryTimeoutMs: num(env.CODEBUDDY_DISCOVERY_TIMEOUT_MS, DISCOVERY_TIMEOUT_MS),
    tenantId: env.CODEBUDDY_TENANT_ID || "",
    enterpriseId: env.CODEBUDDY_ENTERPRISE_ID || "",
    userId: env.CODEBUDDY_USER_ID || "",
    apiKey: env.CODEBUDDY_API_KEY || "",
    // 客户端指纹四件套必须成对更新（UA 与 X-IDE-* 同源），硬编码版本过期后会被服务端按版本黑白名单卡死；
    // 允许环境变量覆盖以便跟进官方最新版本。注意：CODEBUDDY_IDE_VERSION 与 CODEBUDDY_APP_VERSION 应成对取自同一期官方发布。
    platform: env.CODEBUDDY_PLATFORM || PLATFORM,
    appVersion: env.CODEBUDDY_APP_VERSION || APP_VERSION,
    ideName: env.CODEBUDDY_IDE_NAME || IDE_NAME,
    ideType: env.CODEBUDDY_IDE_TYPE || IDE_TYPE,
    ideVersion: env.CODEBUDDY_IDE_VERSION || IDE_VERSION,
    domain: DOMAIN_DEFAULT, product: PRODUCT, agentIntent: AGENT_INTENT, envId: ENV_ID,
    acceptLanguage: resolveAcceptLanguage(env),
    machineId: env.CODEBUDDY_MACHINE_ID || "",
  };
}

export function domainForHost(url: string): string {
  try { return new URL(url).host.includes("codebuddy.ai") ? "www.codebuddy.ai" : "www.codebuddy.cn"; } catch { return url.includes("codebuddy.ai") ? "www.codebuddy.ai" : "www.codebuddy.cn"; }
}

export function resolveServerUrl(cfg: Pick<CodeBuddyConfig,"endpoint"|"network">): { url:string; domain:string } {
  if (cfg.endpoint) {
    const url = cfg.endpoint.replace(/\/+$/, "");
    return { url, domain: domainForHost(url) };
  }
  if (cfg.network === "internal" || cfg.network === "ioa") return { url: "https://copilot.tencent.com", domain: "www.codebuddy.cn" };
  return { url: "https://www.codebuddy.ai", domain: "www.codebuddy.ai" };
}
