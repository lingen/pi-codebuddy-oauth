// SPDX-License-Identifier: MIT
// src/device.ts — 稳定设备 ID（防识别）
//
// 真实 IDE 插件必带稳定 machineId/deviceId（重装前不变）；之前每请求全是 fresh UUID，
// 表现为“同一 token 每次换设备”。此处落盘一个 UUID 并复用，随 X-Machine-Id 发送。
//
// 字段名说明：未经抓包确认官方真实字段名，X-Machine-Id 是 VSCode 生态最常见的机器标识头，
// 属于 best-effort；抓到真实包后应对齐字段名（见 README 防识别章节）。
import * as fs from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

const FILE_NAME = "codebuddy-device.json";

export function getDeviceFilePath(): string {
  return join(homedir(), CONFIG_DIR_NAME || ".pi", "agent", FILE_NAME);
}

function newDeviceId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

let cached: string | undefined;

/** 测试钩子：清空内存缓存 */
export function __resetDeviceCache(): void {
  cached = undefined;
}

function isValidDeviceId(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-fA-F]{32}$/.test(v);
}

/**
 * 获取稳定设备 ID：
 * 1. CODEBUDDY_MACHINE_ID 环境变量优先（CI/多机隔离用）；
 * 2. 其次读磁盘文件；缺失/损坏则生成并以 600 权限落盘。
 * 永不抛错（失败时返回内存生成的临时 ID，保证请求不断）。
 */
export async function getOrCreateDeviceId(): Promise<string> {
  const override = process.env.CODEBUDDY_MACHINE_ID;
  if (override && override.trim()) return override.trim();
  if (cached) return cached;
  const path = getDeviceFilePath();
  try {
    const raw = await fs.readFile(path, "utf8");
    const o = JSON.parse(raw) as { deviceId?: unknown };
    if (isValidDeviceId(o.deviceId)) {
      cached = o.deviceId;
      return cached;
    }
  } catch {
    // 缺失或损坏 → 生成新的
  }
  const id = newDeviceId();
  cached = id;
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ deviceId: id }, null, 2), { mode: 0o600 });
    await fs.rename(tmp, path);
    try {
      await fs.chmod(path, 0o600);
    } catch {
      // Windows 等平台 chmod 可能失败，忽略
    }
  } catch {
    // 落盘失败不影响运行（本次进程内仍用同一 ID）
  }
  return id;
}
