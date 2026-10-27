import { describe, it, expect, vi, afterEach } from "vitest";
import { getConfig, resolveAcceptLanguage } from "../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("config 指纹覆盖", () => {
  it("版本四件套可用环境变量覆盖", () => {
    vi.stubEnv("CODEBUDDY_IDE_VERSION", "9.9.9");
    vi.stubEnv("CODEBUDDY_APP_VERSION", "1.2.3");
    const cfg = getConfig();
    expect(cfg.ideVersion).toBe("9.9.9");
    expect(cfg.appVersion).toBe("1.2.3");
  });
  it("Accept-Language 跟随系统 locale", () => {
    expect(resolveAcceptLanguage({ LANG: "en_US.UTF-8" } as any)).toMatch(/^en-US/);
    expect(resolveAcceptLanguage({ LANG: "zh_CN.UTF-8" } as any)).toMatch(/^zh-CN/);
    expect(resolveAcceptLanguage({ CODEBUDDY_ACCEPT_LANGUAGE: "fr-FR" } as any)).toBe("fr-FR");
  });
  it("conversation 轮换与发现超时可配", () => {
    vi.stubEnv("CODEBUDDY_CONVERSATION_MAX_TURNS", "7");
    vi.stubEnv("CODEBUDDY_DISCOVERY_TIMEOUT_MS", "1234");
    const cfg = getConfig();
    expect(cfg.conversationMaxTurns).toBe(7);
    expect(cfg.discoveryTimeoutMs).toBe(1234);
  });
});
