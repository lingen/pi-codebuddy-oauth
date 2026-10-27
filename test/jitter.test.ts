import { describe, it, expect } from "vitest";
import { jitteredDelay } from "../src/jitter.js";

describe("jitteredDelay", () => {
  it("rand=0.5 时返回基准", () => {
    expect(jitteredDelay(1000, () => 0.5)).toBe(1000);
  });
  it("抖动范围 ±20%", () => {
    expect(jitteredDelay(1000, () => 0)).toBe(800);
    expect(jitteredDelay(1000, () => 1)).toBe(1200);
  });
  it("下限不为负", () => {
    expect(jitteredDelay(0, () => 0)).toBe(0);
  });
});
