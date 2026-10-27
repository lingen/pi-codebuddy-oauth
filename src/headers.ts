// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Ming Lo — 源自 https://github.com/minglo/opencode-codebuddy-oauth (MIT)
// src/headers.ts — CodeBuddy 客户端头伪装（防识别重点文件）
//
// 防识别要点（修改时必读）：
// 1. Conversation-ID 稳定（同一任务复用，命中上游 prompt cache），Request-ID 系每次 HTTP 尝试必换。
//    之前三 ID 全等 + 重试复用同一 ID，服务端一条规则即可识别本插件（已修复）。
// 2. trace/span/parent 必须三次独立随机；之前 span/parent 是 trace 的前后半，熵自相关（已修复）。
// 3. baseHeaders 缓存 key 必须包含全部指纹字段；之前仅按 domain 缓存，版本覆盖后常驻旧值（已修复）。
// 4. Accept-Language 真实 Electron 必带，缺失是一行规则的指纹（已补，见 config.resolveAcceptLanguage）。
// 5. X-Machine-Id 为稳定设备 ID（device.ts 落盘复用）；字段名为 best-effort，抓到真实包后对齐。
import type { CodeBuddyConfig } from "./config.js";
import type { ConversationTracker } from "./conversation.js";

/** 32 hex：conversation/message/request/trace 用 */
export function generateTraceId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // crypto 整体缺失（Node <19 无 flag 的 npm 安装路径）：Math.random 兜底，保证不崩
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/** 16 hex：span/parent 用，与 trace 独立随机 */
export function generateSpanId(): string {
  const c = globalThis.crypto;
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(8);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "").slice(0, 16);
  let s = "";
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

export function resolveModel(input: string | undefined, cfg: CodeBuddyConfig): string {
  return cfg.model ? cfg.model : (input ?? "");
}

function baseCacheKey(cfg: CodeBuddyConfig, domain: string): string {
  // 指纹字段全进 key：版本四件套成对更新时缓存不留旧值
  return [
    domain, cfg.agentIntent, cfg.ideType, cfg.ideName, cfg.ideVersion,
    cfg.appVersion, cfg.envId, cfg.product, cfg.acceptLanguage,
  ].join("|");
}

const baseHeadersCache = new Map<string, Record<string, string>>();

export function baseHeaders(cfg: CodeBuddyConfig, domain: string): Record<string, string> {
  const key = baseCacheKey(cfg, domain);
  const cached = baseHeadersCache.get(key);
  if (cached) return cached;
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    // 真实 Electron/Chromium 必带；缺失是极强指纹。值跟随系统 locale（config.resolveAcceptLanguage）。
    "Accept-Language": cfg.acceptLanguage || "zh-CN,zh;q=0.9,en;q=0.8",
    "X-Agent-Intent": cfg.agentIntent,
    "X-IDE-Type": cfg.ideType,
    "X-IDE-Name": cfg.ideName,
    "X-IDE-Version": cfg.ideVersion,
    "X-Product-Version": cfg.appVersion,
    "X-Env-ID": cfg.envId,
    "X-Domain": domain,
    "X-Product": cfg.product,
    // UA 与 X-IDE-* 同源（config.getConfig 成对覆盖），避免“VSCode 1.119 配了个不存在的 CodeBuddy 版本”穿帮。
    "User-Agent": `${cfg.ideName}/${cfg.ideVersion} CodeBuddy/${cfg.appVersion}`,
  };
  baseHeadersCache.set(key, headers);
  return headers;
}

/** 测试钩子：清空 baseHeaders 缓存 */
export function __clearBaseHeadersCache(): void {
  baseHeadersCache.clear();
}

/**
 * 每次 HTTP 尝试的新鲜 ID 组（Conversation-ID 除外）。
 * 三个业务 ID 互相独立、trace/span/parent 三次独立随机，打散群体签名。
 */
export function buildAttemptHeaders(): Record<string, string> {
  const requestId = generateTraceId();
  const conversationRequestId = generateTraceId();
  const messageId = generateTraceId();
  const traceId = generateTraceId();
  const spanId = generateSpanId();
  const parentSpanId = generateSpanId();
  return {
    "X-Request-ID": requestId,
    "X-Conversation-Request-ID": conversationRequestId,
    "X-Conversation-Message-ID": messageId,
    "X-Request-Trace-Id": traceId,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    "X-B3-TraceId": traceId,
    "X-B3-ParentSpanId": parentSpanId,
    "X-B3-SpanId": spanId,
    "X-B3-Sampled": "1",
  };
}

export interface RequestHeaderDeps {
  cfg: CodeBuddyConfig;
  server: { url: string; domain: string };
  tracker: ConversationTracker;
  /** 稳定设备 ID（device.ts 落盘复用）；为空则不发，避免每次 fresh UUID 反而暴露 */
  deviceId?: string;
}

export function buildRequestHeaders(
  sessionId: string | undefined,
  modelId: string | undefined,
  deps: RequestHeaderDeps,
): Record<string, string> {
  const { cfg, server, tracker, deviceId } = deps;
  // conversation 稳定（命中 prompt cache，按 turn 轮换见 conversation.ts），其余每次新鲜
  const conversationId = tracker.get(sessionId, cfg.stableConversationId);
  const base = baseHeaders(cfg, server.domain);
  const headers: Record<string, string> = {
    ...base,
    ...buildAttemptHeaders(),
    "X-Conversation-ID": conversationId,
  };
  if (deviceId) headers["X-Machine-Id"] = deviceId;
  const resolved = resolveModel(modelId, cfg);
  if (resolved) headers["X-Model-ID"] = resolved;
  return headers;
}

export function buildAuthHeaders(
  auth: { type: "api"; key: string } | { type: "oauth"; access: string; refresh: string; expires: number },
  identity: { tenantId: string; enterpriseId: string; userId: string },
): Record<string, string> {
  if (auth.type === "api") {
    // D9: 双头保留，服务端校验头未知，生产双头在用，盲删 401
    return { Authorization: `Bearer ${auth.key}`, "X-API-Key": auth.key };
  }
  const h: Record<string, string> = { Authorization: `Bearer ${auth.access}` };
  if (identity.tenantId) h["X-Tenant-Id"] = identity.tenantId;
  if (identity.enterpriseId) h["X-Enterprise-Id"] = identity.enterpriseId;
  if (identity.userId) h["X-User-Id"] = identity.userId;
  return h;
}
