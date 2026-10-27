import { describe, it, expect } from "vitest";
import { baseHeaders, buildRequestHeaders, buildAuthHeaders, buildAttemptHeaders, resolveModel, __clearBaseHeadersCache } from "../src/headers.js";
import { LRUMap } from "../src/lru.js";
import { ConversationTracker } from "../src/conversation.js";

function makeDeps(overrides: Record<string, unknown> = {}) {
  const cfg: any = {
    platform: "VSCode", appVersion: "4.9.29177644", ideName: "VSCode", ideType: "VSCode",
    ideVersion: "1.119.0", product: "SaaS", agentIntent: "craft", envId: "production",
    acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
    model: "", stableConversationId: true, conversationMapMax: 100, conversationMaxTurns: 50, ...overrides,
  };
  const server = { url: "https://copilot.tencent.com", domain: "www.codebuddy.cn" };
  const tracker = new ConversationTracker(new LRUMap<string, string>(100), { maxTurns: cfg.conversationMaxTurns });
  return { cfg, server, tracker, deviceId: "dev123" };
}

describe("headers", () => {
  it("baseHeaders 含 Accept-Language（Electron 必带头）", () => {
    __clearBaseHeadersCache();
    const h = baseHeaders(makeDeps().cfg, "www.codebuddy.cn");
    expect(h["X-Agent-Intent"]).toBe("craft");
    expect(h["X-Domain"]).toBe("www.codebuddy.cn");
    expect(h["X-Product"]).toBe("SaaS");
    expect(h["Accept-Language"]).toBe("zh-CN,zh;q=0.9,en;q=0.8");
  });
  it("版本覆盖成对生效（UA 与 X-IDE-* 同源）", () => {
    __clearBaseHeadersCache();
    const deps = makeDeps({ ideVersion: "9.9.9", appVersion: "1.2.3" });
    const h = baseHeaders(deps.cfg, "www.codebuddy.cn");
    expect(h["User-Agent"]).toBe("VSCode/9.9.9 CodeBuddy/1.2.3");
    expect(h["X-IDE-Version"]).toBe("9.9.9");
    expect(h["X-Product-Version"]).toBe("1.2.3");
  });
  it("X-Conversation-ID 用 conversationId 而非 messageId", () => {
    const deps = makeDeps();
    const h = buildRequestHeaders("sess-1", "m1", deps);
    expect(h["X-Conversation-ID"]).not.toBe(h["X-Request-ID"]);
  });
  it("三 ID 互相独立（打散群体签名）", () => {
    const h = buildRequestHeaders("s", "m", makeDeps());
    expect(h["X-Request-ID"]).not.toBe(h["X-Conversation-Request-ID"]);
    expect(h["X-Request-ID"]).not.toBe(h["X-Conversation-Message-ID"]);
    expect(h["X-Conversation-Request-ID"]).not.toBe(h["X-Conversation-Message-ID"]);
    expect(h["X-Request-ID"]).toMatch(/^[0-9a-f]{32}$/);
  });
  it("b3 合法：trace 32hex，span/parent 独立随机各16hex", () => {
    const h = buildRequestHeaders("s", undefined, makeDeps());
    const [trace, span, sampled, parent] = h["b3"].split("-");
    expect(trace).toMatch(/^[0-9a-f]{32}$/);
    expect(span).toMatch(/^[0-9a-f]{16}$/);
    expect(parent).toMatch(/^[0-9a-f]{16}$/);
    expect(span).not.toBe(parent);
    expect(sampled).toBe("1");
  });
  it("buildAttemptHeaders 不含 Conversation-ID 且每次新鲜", () => {
    const a = buildAttemptHeaders();
    const b = buildAttemptHeaders();
    expect(a["X-Conversation-ID"]).toBeUndefined();
    expect(a["X-Request-ID"]).not.toBe(b["X-Request-ID"]);
    expect(a["X-Conversation-Request-ID"]).not.toBe(b["X-Conversation-Request-ID"]);
  });
  it("X-Machine-Id 随稳定设备 ID 发送", () => {
    expect(buildRequestHeaders("s", "m", makeDeps())["X-Machine-Id"]).toBe("dev123");
    const noDev: any = { ...makeDeps(), deviceId: "" };
    expect(buildRequestHeaders("s", "m", noDev)["X-Machine-Id"]).toBeUndefined();
  });
  it("resolveModel 优先 cfg.model", () => {
    expect(resolveModel("input", { model: "cfg-model" } as any)).toBe("cfg-model");
    expect(resolveModel("input", { model: "" } as any)).toBe("input");
  });
  it("X-Model-ID 仅非空注入", () => {
    const deps = makeDeps({ model: "" });
    expect(buildRequestHeaders("s", "", deps)["X-Model-ID"]).toBeUndefined();
    expect(buildRequestHeaders("s", "m1", deps)["X-Model-ID"]).toBe("m1");
  });
  it("api 双头保留", () => {
    const h = buildAuthHeaders({ type: "api", key: "k" } as any, { tenantId: "", enterpriseId: "", userId: "" });
    expect(h["Authorization"]).toBe("Bearer k");
    expect(h["X-API-Key"]).toBe("k");
  });
  it("动态头全量快照（含 Accept-Language 与 X-Machine-Id，不含三ID相等）", () => {
    const h = buildRequestHeaders("s", "", makeDeps({ model: "" }));
    const keys = Object.keys(h).sort();
    for (const k of ["Accept", "Accept-Language", "Content-Type", "User-Agent", "X-Agent-Intent",
      "X-B3-ParentSpanId", "X-B3-Sampled", "X-B3-SpanId", "X-B3-TraceId", "X-Conversation-ID",
      "X-Conversation-Message-ID", "X-Conversation-Request-ID", "X-Domain", "X-Env-ID",
      "X-IDE-Name", "X-IDE-Type", "X-IDE-Version", "X-Machine-Id", "X-Product", "X-Product-Version",
      "X-Request-ID", "X-Request-Trace-Id", "X-Requested-With", "b3"]) {
      expect(keys).toContain(k);
    }
    // 三 ID 必须互不相同
    const ids = new Set([h["X-Request-ID"], h["X-Conversation-Request-ID"], h["X-Conversation-Message-ID"]]);
    expect(ids.size).toBe(3);
  });
  it("oauth 条件注入 X-Tenant-Id/X-Enterprise-Id/X-User-Id", () => {
    const h = buildAuthHeaders({ type: "oauth", access: "a", refresh: "r", expires: 1 } as any, { tenantId: "t", enterpriseId: "e", userId: "u" });
    expect(h["X-Tenant-Id"]).toBe("t");
    expect(h["X-Enterprise-Id"]).toBe("e");
    expect(h["X-User-Id"]).toBe("u");
    const empty = buildAuthHeaders({ type: "oauth", access: "a", refresh: "r", expires: 1 } as any, { tenantId: "", enterpriseId: "", userId: "" });
    expect(empty["X-Tenant-Id"]).toBeUndefined();
    expect(empty["X-Enterprise-Id"]).toBeUndefined();
    expect(empty["X-User-Id"]).toBeUndefined();
  });
});
