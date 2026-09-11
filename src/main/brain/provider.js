/**
 * DeepSeek 模型适配层。
 *
 * 刻意**不使用 `openai` SDK**：反正所有出网都必须经过 `safeFetch`
 * （域名白名单 + 飞行模式 + signal 合并），用 SDK 也得注入自定义 fetch，
 * 不如直接手写。收益：运行时依赖再减一个。
 *
 * 对外只暴露 `streamChat()`，返回一个事件流。上层（agent.js）不需要知道
 * DeepSeek 的任何字段细节——将来换供应商只改这一个文件。
 */
import { safeFetch } from '../skills/egress.js';
import { AppError, fromHttpStatus, normalize } from './errors.js';
import { DONE_SENTINEL, createSseDecoder } from './sse.js';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-chat';

/**
 * @typedef {{ role: string, content: string | null, tool_call_id?: string, tool_calls?: unknown[] }} ChatMessage
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'tool_call', id: string, name: string, arguments: string }
 *   | { type: 'usage', usage: { prompt_tokens?: number, completion_tokens?: number, total_tokens?: number, prompt_cache_hit_tokens?: number } }
 *   | { type: 'finish', reason: string | null }} ProviderEvent
 */

/**
 * 发起一次流式对话。
 *
 * @param {object} params
 * @param {string} params.apiKey
 * @param {string} [params.model]
 * @param {ChatMessage[]} params.messages
 * @param {unknown[]} [params.tools]
 * @param {AbortSignal} [params.signal]
 * @param {string} [params.baseUrl]
 * @returns {AsyncGenerator<ProviderEvent, void, void>}
 */
export async function* streamChat({ apiKey, model, messages, tools, signal, baseUrl }) {
  if (!apiKey) throw new AppError('AUTH', '还没有配置 API Key');

  /** @type {Record<string, unknown>} */
  const payload = {
    model: model || DEFAULT_MODEL,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools && tools.length > 0) {
    payload.tools = tools;
    payload.tool_choice = 'auto';
  }

  const res = await safeFetch(`${baseUrl || DEFAULT_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal,
    timeoutMs: 120000, // 流式：整体超时给宽一点；取消由 signal 负责
  });

  if (!res.ok) {
    // ⚠️ 只取前 200 字符，且 fromHttpStatus 不会再往外带请求头
    const body = await res.text().catch(() => '');
    throw fromHttpStatus(res.status, body);
  }
  if (!res.body) throw new AppError('INTERNAL', '响应没有 body');

  /** @type {Map<number, { id: string, name: string, args: string }>} */
  const toolCalls = new Map();
  let finishReason = null;
  /** @type {{ prompt_tokens?: number, completion_tokens?: number, total_tokens?: number, prompt_cache_hit_tokens?: number } | null} */
  let usage = null;

  /**
   * 处理一个 SSE data 帧，把能立刻产出的文本 yield 出去。
   * @param {string} data
   */
  function* handleData(data) {
    if (data === DONE_SENTINEL) return;

    /** @type {any} */
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      return; // 脏帧直接跳过，不让它炸掉整条流
    }

    if (json.usage) usage = json.usage;

    const choice = json.choices?.[0];
    if (!choice) return;

    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content !== '') {
      yield /** @type {ProviderEvent} */ ({ type: 'text', text: delta.content });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        const cur = toolCalls.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        // 分片可能把函数名和参数切开，必须累加
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        toolCalls.set(idx, cur);
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const decoder = new TextDecoder();
  const sse = createSseDecoder();
  const reader = res.body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const data of sse.push(chunk)) yield* handleData(data);
    }
    for (const data of sse.flush()) yield* handleData(data);
  } catch (err) {
    throw normalize(err);
  } finally {
    // 取消 / 出错 / 正常结束三条路径都要把底层连接放掉（防泄漏第 5 条）
    try {
      await reader.cancel();
    } catch {
      /* 已经关了就算了 */
    }
  }

  for (const [idx, tc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    yield { type: 'tool_call', id: tc.id || `call_${idx}`, name: tc.name, arguments: tc.args };
  }

  if (usage) yield { type: 'usage', usage };
  yield { type: 'finish', reason: finishReason };
}
