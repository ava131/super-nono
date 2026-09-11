/**
 * Agent 会话循环 —— 用 mock provider 跑，不烧真 token（SDD v0.1 §6.13）。
 *
 * 覆盖 AB5/AB6/AB7/AB12：
 *   - 普通一问一答
 *   - 工具调用闭环（模型决策 → 执行 → 回填 → 再叙述）
 *   - 工具参数不是合法 JSON
 *   - 技能失败不崩、把错误如实回填
 *   - 死循环 5 步中止（AB7）
 *   - 预算闸门（AB12）
 *   - 取消
 *   - 时间注入位置（B-3.1）
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { initDb, closeDb } = await import('../../src/main/store/db.js');
const memory = await import('../../src/main/brain/memory.js');
const agent = await import('../../src/main/brain/agent.js');
const usage = await import('../../src/main/brain/usage.js');
const { scriptedProvider } = await import('../mocks/provider.js');

const CONFIG = { apiKey: 'sk-test', model: 'deepseek-chat', dailyCostLimit: 10, overBudget: false };

/** 收集 emit 出来的事件 */
function collector() {
  /** @type {any[]} */
  const events = [];
  return {
    events,
    emit: (/** @type {any} */ e) => events.push(e),
    texts: () => events.filter((e) => e.type === 'delta').map((e) => e.text).join(''),
    states: () => events.filter((e) => e.type === 'state').map((e) => e.state),
    errors: () => events.filter((e) => e.type === 'error'),
  };
}

test.beforeEach(() => {
  closeDb();
  initDb(':memory:');
  memory.resetSessionState();
  memory.ensureStartupSession();
});

test.after(() => closeDb());

// ── 基本问答 ────────────────────────────────────────────────────────

test('一问一答：流式增量拼起来等于最终文本', async () => {
  const { provider, calls } = scriptedProvider([{ text: '你好呀，我是 NONO。' }]);
  const c = collector();

  const res = await agent.runTurn({ text: '你好', emit: c.emit, config: CONFIG, provider });

  assert.equal(res.text, '你好呀，我是 NONO。');
  assert.equal(c.texts(), '你好呀，我是 NONO。');
  assert.equal(calls.length, 1, '没有工具调用时只应该请求一次');
  assert.ok(c.states().includes('think'));
  assert.equal(c.states().at(-1), 'idle');
});

test('一轮问答会落两条消息（user + assistant）', async () => {
  const { provider } = scriptedProvider([{ text: '嗯。' }]);
  await agent.runTurn({ text: '在吗', emit: () => {}, config: CONFIG, provider });

  const msgs = memory.recentMessages(10);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].content, '在吗');
  assert.equal(msgs[1].role, 'assistant');
});

test('时间前缀加在**本轮 user 消息**上，且不进 system、不落库（B-3.1）', async () => {
  const { provider, calls } = scriptedProvider([{ text: '好。' }]);
  await agent.runTurn({ text: '今天几号', emit: () => {}, config: CONFIG, provider });

  const sent = calls[0].messages;
  const system = sent.find((/** @type {any} */ m) => m.role === 'system');
  const lastUser = sent.filter((/** @type {any} */ m) => m.role === 'user').at(-1);

  assert.match(lastUser.content, /^\[现在是 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 周.\] 今天几号$/);
  assert.doesNotMatch(system.content, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, 'system 提示词里不能有真实时间戳，否则前缀缓存失效');

  // 落库的是原话
  assert.equal(memory.recentMessages(10)[0].content, '今天几号');
});

test('system 前缀在多次请求间保持逐字节稳定（前缀缓存的前提）', async () => {
  const a = scriptedProvider([{ text: 'a' }]);
  await agent.runTurn({ text: '第一句', emit: () => {}, config: CONFIG, provider: a.provider });
  const b = scriptedProvider([{ text: 'b' }]);
  await agent.runTurn({ text: '第二句', emit: () => {}, config: CONFIG, provider: b.provider });

  const sysA = a.calls[0].messages[0].content;
  const sysB = b.calls[0].messages[0].content;
  assert.equal(sysA, sysB);
});

test('历史会被带进下一轮', async () => {
  const first = scriptedProvider([{ text: '记得了。' }]);
  await agent.runTurn({ text: '我叫小明', emit: () => {}, config: CONFIG, provider: first.provider });

  const second = scriptedProvider([{ text: '你叫小明。' }]);
  await agent.runTurn({ text: '我叫什么', emit: () => {}, config: CONFIG, provider: second.provider });

  const sent = second.calls[0].messages;
  assert.ok(sent.some((/** @type {any} */ m) => m.content === '我叫小明'));
});

// ── 工具调用闭环 ────────────────────────────────────────────────────

test('工具调用闭环：模型决策 → 执行 → 回填 → 再叙述', async () => {
  const { provider, calls } = scriptedProvider([
    { toolCalls: [{ id: 'c1', name: 'weather', arguments: '{"city":"上海","action":"now"}' }] },
    { text: '上海现在 26°C，阴。' },
  ]);

  /** @type {{ name: string, args: unknown }[]} */
  const invoked = [];
  const c = collector();

  const res = await agent.runTurn({
    text: '上海天气怎么样',
    emit: c.emit,
    config: CONFIG,
    provider,
    tools: {
      skills: [{ name: 'weather', description: '查天气' }],
      toolSpecs: () => [
        { type: 'function', function: { name: 'weather', description: '查天气', parameters: { type: 'object' } } },
      ],
      runTool: async (name, args) => {
        invoked.push({ name, args });
        return { ok: true, summary: '上海 26°C 阴（观测时间 15:00）' };
      },
    },
  });

  assert.equal(res.text, '上海现在 26°C，阴。');
  assert.equal(calls.length, 2, '一次工具调用应该产生两次模型往返');
  assert.deepEqual(invoked, [{ name: 'weather', args: { city: '上海', action: 'now' } }]);

  // 第二次请求里应该带上 assistant 的 tool_calls 与 tool 结果
  const second = calls[1].messages;
  const assistantWithTools = second.find((/** @type {any} */ m) => m.role === 'assistant' && m.tool_calls);
  const toolMsg = second.find((/** @type {any} */ m) => m.role === 'tool');
  assert.ok(assistantWithTools, '第二次请求必须带上 assistant.tool_calls');
  assert.equal(toolMsg.tool_call_id, 'c1');
  assert.equal(toolMsg.content, '上海 26°C 阴（观测时间 15:00）');
  assert.equal(toolMsg.content.length < 900, true, '只回填 summary，不回填整个 data');
});

test('工具清单会被传给 provider', async () => {
  const { provider, calls } = scriptedProvider([{ text: 'ok' }]);
  await agent.runTurn({
    text: 'x',
    emit: () => {},
    config: CONFIG,
    provider,
    tools: {
      skills: [],
      toolSpecs: () => [{ type: 'function', function: { name: 'weather', description: '查天气', parameters: { type: 'object' } } }],
      runTool: async () => ({ ok: true, summary: 'y' }),
    },
  });
  assert.equal(calls[0].tools.length, 1);
  assert.equal(calls[0].tools[0].function.name, 'weather');
});

test('技能失败不崩：错误原样回填，模型能接着解释（B-2d）', async () => {
  const { provider, calls } = scriptedProvider([
    { toolCalls: [{ id: 'c1', name: 'weather', arguments: '{}' }] },
    { text: '这个我暂时查不到。' },
  ]);

  const c = collector();
  const res = await agent.runTurn({
    text: '查一下',
    emit: c.emit,
    config: CONFIG,
    provider,
    tools: {
      skills: [],
      toolSpecs: () => [],
      runTool: async () => ({ ok: false, summary: '查不到「火星」这个地方。' }),
    },
  });

  assert.equal(res.text, '这个我暂时查不到。');
  const toolMsg = calls[1].messages.find((/** @type {any} */ m) => m.role === 'tool');
  assert.match(toolMsg.content, /查不到/);
  assert.equal(c.errors().length, 0, '工具失败不应该变成对话错误');
});

test('模型给的参数不是合法 JSON → 如实告诉模型，不让它崩', async () => {
  const { provider, calls } = scriptedProvider([
    { toolCalls: [{ id: 'c1', name: 'weather', arguments: '{这不是JSON' }] },
    { text: '我参数给错了，重来。' },
  ]);

  let executed = false;
  await agent.runTurn({
    text: 'x',
    emit: () => {},
    config: CONFIG,
    provider,
    tools: {
      skills: [],
      toolSpecs: () => [],
      runTool: async () => {
        executed = true;
        return { ok: true, summary: 'y' };
      },
    },
  });

  assert.equal(executed, false, '参数坏了就不该执行');
  const toolMsg = calls[1].messages.find((/** @type {any} */ m) => m.role === 'tool');
  assert.match(toolMsg.content, /JSON/);
});

test('AB7：模型一直要调工具时，5 步后中止而不是无限循环', async () => {
  // 脚本只有一步，会被重复使用 → 永远返回工具调用
  const { provider, calls } = scriptedProvider([
    { toolCalls: [{ id: 'c1', name: 'loop', arguments: '{}' }] },
  ]);

  let runs = 0;
  const c = collector();
  const res = await agent.runTurn({
    text: '循环吧',
    emit: c.emit,
    config: CONFIG,
    provider,
    tools: {
      skills: [],
      toolSpecs: () => [],
      runTool: async () => {
        runs += 1;
        return { ok: true, summary: '又转了一圈' };
      },
    },
  });

  assert.equal(calls.length, agent.MAX_STEPS, `应当正好请求 ${agent.MAX_STEPS} 次`);
  assert.equal(runs, agent.MAX_STEPS);
  assert.match(res.text, /绕了太多圈/);
  assert.equal(c.states().at(-1), 'idle', '中止后必须回到 idle，不能卡在 think');
});

test('工具调用前模型说了话 → 先收尾一个气泡，最终回答另起一个', async () => {
  const { provider } = scriptedProvider([
    { text: '我查一下。', toolCalls: [{ id: 'c1', name: 'weather', arguments: '{}' }] },
    { text: '查到了：晴。' },
  ]);
  const c = collector();
  await agent.runTurn({
    text: 'x',
    emit: c.emit,
    config: CONFIG,
    provider,
    tools: { skills: [], toolSpecs: () => [], runTool: async () => ({ ok: true, summary: '晴' }) },
  });

  const finals = c.events.filter((e) => e.type === 'message' && e.done);
  assert.equal(finals.length, 2);
  assert.equal(finals[0].text, '我查一下。');
  assert.equal(finals[1].text, '查到了：晴。');
});

// ── 闸门与异常 ──────────────────────────────────────────────────────

test('AB12：超预算时直接拒绝，一次请求都不发', async () => {
  const { provider, calls } = scriptedProvider([{ text: '不该跑到这里' }]);
  const c = collector();

  await agent.runTurn({
    text: 'x',
    emit: c.emit,
    config: { ...CONFIG, overBudget: true },
    provider,
  });

  assert.equal(calls.length, 0, '超预算时不应该发出任何请求');
  assert.equal(c.errors().length, 1);
  assert.equal(c.errors()[0].code, 'BUDGET');
});

test('没有 API Key → AUTH 错误，且带真实 turnId（否则界面会把它当串台丢掉）', async () => {
  const { provider, calls } = scriptedProvider([{ text: 'x' }]);
  const c = collector();

  const res = await agent.runTurn({ text: 'x', emit: c.emit, config: { apiKey: '' }, provider });

  assert.equal(calls.length, 0);
  assert.equal(c.errors().length, 1);
  assert.equal(c.errors()[0].code, 'AUTH');
  assert.equal(c.errors()[0].turnId, res.turnId);
  assert.notEqual(c.errors()[0].turnId, 'n/a');
});

test('provider 抛错 → 归一化成 error 事件，不抛给调用方', async () => {
  const boom = new Error('网络炸了');
  const { provider } = scriptedProvider([{ throwError: boom }]);
  const c = collector();

  await agent.runTurn({ text: 'x', emit: c.emit, config: CONFIG, provider });

  assert.equal(c.errors().length, 1);
  assert.equal(c.errors()[0].code, 'INTERNAL');
  assert.equal(c.states().at(-1), 'error');
});

test('取消：abort 后发出 idle + 已停止，且不抛异常', async () => {
  /** @type {AbortSignal | undefined} */
  let captured;
  /** @type {any} */
  const provider = async function* (/** @type {any} */ { signal }) {
    captured = signal;
    yield { type: 'text', text: '开头' };
    agent.cancelCurrentTurn();
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    yield { type: 'text', text: '结尾' };
  };

  const c = collector();
  const res = await agent.runTurn({ text: 'x', emit: c.emit, config: CONFIG, provider });

  assert.ok(captured, 'provider 应该拿到 signal');
  assert.equal(res.text, '');
  assert.ok(c.events.some((e) => e.type === 'notice' && /已停止/.test(e.text)));
  assert.equal(c.states().at(-1), 'idle');
});

// ── 记账 ────────────────────────────────────────────────────────────

test('每一次模型往返都记账，而不是只看最后一轮（否则成本统计失真）', async () => {
  const { provider } = scriptedProvider([
    { toolCalls: [{ id: 'c1', name: 'w', arguments: '{}' }], usage: { prompt_tokens: 100, completion_tokens: 10 } },
    { text: '好了', usage: { prompt_tokens: 200, completion_tokens: 30 } },
  ]);

  await agent.runTurn({
    text: 'x',
    emit: () => {},
    config: CONFIG,
    provider,
    tools: { skills: [], toolSpecs: () => [], runTool: async () => ({ ok: true, summary: 'y' }) },
  });

  const totals = usage.todayTotals();
  assert.equal(totals.calls, 2, '两次往返应该有两条用量记录');
  assert.equal(totals.tokensIn, 300);
  assert.equal(totals.tokensOut, 40);
  assert.ok(totals.cost > 0, '费用估算应该有值（价格表命中 deepseek-chat）');
});

test('普通一问一答也会记账（这是刚才修掉的一个 bug）', async () => {
  const { provider } = scriptedProvider([{ text: '嗯', usage: { prompt_tokens: 50, completion_tokens: 5 } }]);
  await agent.runTurn({ text: 'x', emit: () => {}, config: CONFIG, provider });

  assert.equal(usage.todayTotals().calls, 1);
});
