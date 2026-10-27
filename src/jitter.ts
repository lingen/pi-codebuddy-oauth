// SPDX-License-Identifier: MIT
// src/jitter.ts — 退避抖动（防识别）
//
// 固定退避（1s/4s/10s/25s 精确到毫秒、固定 3s 轮询）让全网插件用户节奏完全一致，
// 服务端按时序聚类零成本识别。本模块给所有延迟加 ±20% 均匀抖动，打散群体签名。
//
// 测试通过注入随机函数或 Math.random mock 控制；生产直接用 Math.random。
export const JITTER_RATIO_DEFAULT = 0.2;

/** 对 baseMs 加抖动：base * (1 - ratio + rand * 2 * ratio)，下限 0 */
export function jitteredDelay(baseMs: number, rand: () => number = Math.random, ratio = JITTER_RATIO_DEFAULT): number {
  const r = Math.max(0, Math.min(1, rand()));
  const jittered = baseMs * (1 - ratio + r * 2 * ratio);
  return Math.max(0, Math.round(jittered));
}

/** 可中断的 sleep，abort 时提前返回 false，否则等待足时返回 true */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!(signal?.aborted ?? false));
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const t = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
