// SPDX-License-Identifier: MIT
// src/conversation.ts — session 级 conversation 跟踪 + 按 turn 轮换（防识别）
//
// 背景：真实 IDE 按任务切 conversation；单个 conversation 跑几百 turn 且主题混杂，
// 服务端做画像时极易异常。之前同一 Pi session 永久复用同一 ID（仅 compaction 淘汰）。
// 此处按 turn 计数轮换：超过 maxTurns 即生成新 ID，老 ID 自然过期。
import type { LRUMap } from "./lru.js";

export interface ConversationTrackerOpts {
  /** 每个 conversation 最多复用多少次 buildRequestHeaders 调用（≈ turn 数）；<=0 表示不限 */
  maxTurns: number;
  /** 生成新 ID 的函数，便于测试注入 */
  genId?: () => string;
}

function defaultGenId(): string {
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

/**
 * LRU<string,string> 存 conversationId；uses 存已用 turn 数。
 * - stable=false 或 sessionId 为空 → 每次返回全新 ID（与旧行为一致，不跟踪）；
 * - 否则命中复用，uses+1，超过 maxTurns 则轮换。
 */
export class ConversationTracker {
  private uses = new Map<string, number>();
  constructor(
    private readonly lru: LRUMap<string, string>,
    private readonly opts: ConversationTrackerOpts,
  ) {}

  get(sessionId: string | undefined, stable: boolean): string {
    const gen = this.opts.genId ?? defaultGenId;
    if (!stable || !sessionId) return gen();
    const hit = this.lru.get(sessionId);
    if (hit) {
      const n = (this.uses.get(sessionId) ?? 0) + 1;
      const max = this.opts.maxTurns;
      if (max > 0 && n > max) {
        const id = gen();
        this.lru.set(sessionId, id);
        this.uses.set(sessionId, 1);
        return id;
      }
      this.uses.set(sessionId, n);
      return hit;
    }
    const id = gen();
    this.lru.set(sessionId, id);
    this.uses.set(sessionId, 1);
    return id;
  }

  delete(sessionId: string): void {
    this.lru.delete(sessionId);
    this.uses.delete(sessionId);
  }

  /** 测试/观测用 */
  usesOf(sessionId: string): number {
    return this.uses.get(sessionId) ?? 0;
  }
}
