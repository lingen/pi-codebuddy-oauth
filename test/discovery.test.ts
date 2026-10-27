import { describe, it, expect, vi, afterEach } from "vitest";
import { remoteModelToPi, DiscoveryCache, type RemoteModel } from "../src/models.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("remoteModelToPi 服务端字段优先", () => {
  it("supportsReasoning=true 时即使 id 不匹配也为 true", () => {
    const p = remoteModelToPi({ id: "plain-xyz", name: "P", supportsReasoning: true });
    expect(p.reasoning).toBe(true);
  });
  it("supportsReasoning=false 时即使 id 匹配也为 false", () => {
    const p = remoteModelToPi({ id: "claude-x", name: "C", supportsReasoning: false });
    expect(p.reasoning).toBe(false);
    expect(p.thinkingLevelMap).toBeUndefined();
  });
  it("supportsImages=false 时即使 id 匹配也不给 image", () => {
    const p = remoteModelToPi({ id: "gpt-x", name: "G", supportsImages: false });
    expect(p.input).toEqual(["text"]);
  });
  it("undefined 时走正则兜底（兼容老网关）", () => {
    expect(remoteModelToPi({ id: "claude-x", name: "C" }).reasoning).toBe(true);
    expect(remoteModelToPi({ id: "plain", name: "P" }).reasoning).toBe(false);
  });
});

describe("DiscoveryCache fallback 短 TTL", () => {
  it("失败无数据返回 [DEFAULT] 且标记 fallback", async () => {
    const cache = new DiscoveryCache({ ttlMs: 300_000, fallbackTtlMs: 1000, fetchFn: async () => { throw new Error("down"); } });
    const d = await cache.get("t", {});
    expect(d.map((m: RemoteModel) => m.id)).toEqual(["auto"]);
    expect(cache.__isFallback()).toBe(true);
  });
  it("空数组按 fallback 处理", async () => {
    const cache = new DiscoveryCache({ ttlMs: 300_000, fetchFn: async () => [] });
    const d = await cache.get("t", {});
    expect(d.map((m) => m.id)).toEqual(["auto"]);
    expect(cache.__isFallback()).toBe(true);
  });
  it("成功数据标记非 fallback", async () => {
    const m: RemoteModel = { id: "x", name: "X" };
    const cache = new DiscoveryCache({ ttlMs: 300_000, fetchFn: async () => [m] });
    await cache.get("t", {});
    expect(cache.__isFallback()).toBe(false);
  });
  it("401/403 直接抛出不吞", async () => {
    const err = Object.assign(new Error("discovery 401"), { status: 401 });
    const cache = new DiscoveryCache({ ttlMs: 300_000, fetchFn: async () => { throw err; } });
    await expect(cache.get("t", {})).rejects.toMatchObject({ status: 401 });
  });
});
