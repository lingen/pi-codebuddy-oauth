// src/stream.ts — streamSimple wrapper：包 pi-ai 内置 openai-completions 实现，注入自定义 fetch。
// 协议栈（消息转换 / tool-calling / SSE 解析）全部复用 pi-ai；本模块负责：
// 1. options.headers 注入 CodeBuddy 动态头（X-Conversation-ID 稳定化 + 每次新鲜 Request-ID 系，provider 边界清晰）
// 2. options.fetch 换成 auth-fetch 拦截器（认证头注入 + 401/403 刷新重试 + 11133 退避重发）
// 3. 透传 Pi 的 onPayload / onResponse / sessionId / transformHeaders 等约定参数
import type {
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderHeaders,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";

type FetchFn = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CodebuddyStreamOptions {
  /** 构建动态请求头（X-Conversation-ID 稳定 + 每次新鲜 Request-ID 系 / B3 / X-Model-ID 等） */
  buildHeaders?: (model: Model<any>, options?: SimpleStreamOptions) => Record<string, string>;
}

/**
 * 包装 pi-ai 内置 openai-completions.streamSimple：
 * - headers 合并动态头（本插件动态头优先：Conversation-ID 稳定复用，Request-ID 系每次新鲜；
 *   调用方透传头仅作补充，避免外部复用旧 Request-ID 造成重放签名）
 * - fetch 换成拦截器（重试时同样换新鲜 Request-ID，见 auth-fetch.prepareRequest）
 */
export function createCodebuddyStreamSimple(fetchFn: FetchFn, extra?: CodebuddyStreamOptions) {
  const builtin = openAICompletionsApi().streamSimple;
  return function streamCodebuddy(
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const dynamicHeaders = extra?.buildHeaders?.(model, options);
    const opts: SimpleStreamOptions = {
      ...(options ?? {}),
      ...(dynamicHeaders ? { headers: { ...options?.headers, ...dynamicHeaders } as ProviderHeaders } : {}),
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    };
    return builtin(model, context, opts);
  };
}
