/**
 * Mock provider —— M3 的交付物之一（SDD v0.1 §6.13）。
 *
 * 它一次性解锁好几条验收：
 *   - AB7  死循环 5 步中止        （脚本一直返回工具调用）
 *   - AB12 预算闸门              （不用真烧钱）
 *   - AB13 长跑内存               （soak 脚本）
 *   - 工具调用闭环的集成测试
 *
 * 形状与真实 provider 完全一致（async generator + 同一套事件），
 * 所以 agent 循环察觉不到区别。
 */

/**
 * @typedef {{ text?: string, toolCalls?: { id?: string, name: string, arguments: string }[], usage?: object, throwError?: Error }} MockStep
 */

/**
 * 按脚本依次返回。脚本用完后**重复最后一步**（方便造死循环）。
 *
 * @param {MockStep[]} script
 * @returns {{ provider: (params: any) => AsyncGenerator<any, void, void>, calls: { messages: any[], tools: any[] }[] }}
 */
export function scriptedProvider(script) {
  /** @type {{ messages: any[], tools: any[] }[]} */
  const calls = [];
  let index = 0;

  /**
   * @param {any} params
   * @returns {AsyncGenerator<any, void, void>}
   */
  async function* provider(params) {
    const { messages, tools, signal } = params;
    calls.push({ messages: structuredClone(messages), tools: structuredClone(tools ?? []) });

    const step = script[Math.min(index, script.length - 1)];
    index += 1;

    if (!step) {
      yield { type: 'finish', reason: 'stop' };
      return;
    }

    if (step.throwError) throw step.throwError;

    // 模拟流式：把文本切成两半，顺便验证 delta 累积
    if (step.text) {
      const half = Math.ceil(step.text.length / 2);
      yield { type: 'text', text: step.text.slice(0, half) };
      if (signal?.aborted) return;
      yield { type: 'text', text: step.text.slice(half) };
    }

    for (const [i, tc] of (step.toolCalls ?? []).entries()) {
      yield {
        type: 'tool_call',
        id: tc.id ?? `call_${index}_${i}`,
        name: tc.name,
        arguments: tc.arguments,
      };
    }

    yield {
      type: 'usage',
      usage: step.usage ?? { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    };
    yield { type: 'finish', reason: step.toolCalls?.length ? 'tool_calls' : 'stop' };
  }

  return { provider, calls };
}

/**
 * 一个什么都不做的技能执行桩。
 * @param {Record<string, unknown>} [result]
 */
export function stubToolExecutor(result = {}) {
  /** @type {{ name: string, args: unknown }[]} */
  const invoked = [];
  return {
    invoked,
    runTool: async (/** @type {string} */ name, /** @type {unknown} */ args) => {
      invoked.push({ name, args });
      return { ok: true, summary: '（桩结果）', ...result };
    },
  };
}
