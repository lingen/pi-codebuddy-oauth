import { describe, it, expect } from "vitest";
import { LRUMap } from "../src/lru.js";
import { ConversationTracker } from "../src/conversation.js";

describe("ConversationTracker", () => {
  it("同 session 稳定复用", () => {
    const t = new ConversationTracker(new LRUMap<string, string>(10), { maxTurns: 50 });
    expect(t.get("s", true)).toBe(t.get("s", true));
  });
  it("超过 maxTurns 轮换", () => {
    const t = new ConversationTracker(new LRUMap<string, string>(10), { maxTurns: 3 });
    const first = t.get("s", true);
    t.get("s", true);
    t.get("s", true);
    const rotated = t.get("s", true);
    expect(rotated).not.toBe(first);
    expect(t.usesOf("s")).toBe(1);
  });
  it("stable=false 每次全新", () => {
    const t = new ConversationTracker(new LRUMap<string, string>(10), { maxTurns: 50 });
    expect(t.get("s", false)).not.toBe(t.get("s", false));
  });
  it("delete 后重建", () => {
    const t = new ConversationTracker(new LRUMap<string, string>(10), { maxTurns: 50 });
    const a = t.get("s", true);
    t.delete("s");
    expect(t.get("s", true)).not.toBe(a);
  });
});
