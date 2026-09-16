/**
 * 技能结果 → 气泡 的跨层管线（评审 Q7 / SDD §8.2-22 的 T20–T22）。
 *
 * 这条管线横跨五层：`agent`（emit）→ `ipc`（转发）→ `channels`（契约）
 * → `preload`（桥）→ `renderer`（渲染）。
 *
 * 为什么必须有这组测试：`test/` 里**没有 bubble 单测**，渲染层是既有盲区。
 * 而这条管线恰好有两类会出事的改动：
 *   ① 频道少登记一处 → 事件静默不到渲染端（不报错，列表就是不出现）
 *   ② 渲染端用 `innerHTML` 渲染 issue 标题 → **把外部文本当 HTML 解析**
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import channels from '../../src/shared/channels.cjs';
import {
  ALLOWED_EXTERNAL_HOSTS,
  isAllowedExternalUrl,
} from '../../src/shared/external-link.js';

const { initDb, closeDb } = await import('../../src/main/store/db.js');
const memory = await import('../../src/main/brain/memory.js');
const agent = await import('../../src/main/brain/agent.js');
const { scriptedProvider } = await import('../mocks/provider.js');

const CONFIG = { apiKey: 'sk-test', model: 'deepseek-chat', dailyCostLimit: 10, overBudget: false };

const readSource = (/** @type {string} */ rel) =>
  fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

/** 收集 emit 出来的事件 */
function collector() {
  /** @type {any[]} */
  const events = [];
  return {
    events,
    emit: (/** @type {any} */ e) => events.push(e),
    skillResults: () => events.filter((e) => e.type === 'skillResult'),
  };
}

test.beforeEach(() => {
  closeDb();
  initDb(':memory:');
});

test.after(() => closeDb());

// ─────────────────── T20：agent 必须把 data emit 出去 ───────────────────

test('T20 技能返回 data 时，agent 必须 emit skillResult', async () => {
  const c = collector();
  const provider = scriptedProvider([
    { toolCalls: [{ id: 't1', name: 'github_issues', arguments: '{"domain":"ai infra"}' }] },
    { text: '好，这是结果。' },
  ]);

  await agent.runTurn({
    text: '帮我找一下 ai infra 的 issue',
    emit: c.emit,
    config: CONFIG,
    provider: provider.provider,
    tools: {
      runTool: async () => /** @type {any} */ ({
        ok: true,
        summary: 'summary 文本',
        data: { total: 42, items: [{ repo: 'a/b', number: 1, url: 'https://github.com/a/b/issues/1' }] },
      }),
    },
  });

  const results = c.skillResults();
  assert.equal(results.length, 1);
  assert.equal(results[0].skill, 'github_issues');
  assert.equal(results[0].data.total, 42);
  assert.ok(results[0].turnId, '必须带 turnId（渲染端靠它丢弃串台的旧事件）');
});

test('T20 技能没有 data（或失败）时不该 emit skillResult', async () => {
  for (const result of [{ ok: true, summary: 'x' }, { ok: false, summary: '失败了' }]) {
    const c = collector();
    const provider = scriptedProvider([
      { toolCalls: [{ id: 't1', name: 'weather', arguments: '{}' }] },
      { text: 'ok' },
    ]);
    await agent.runTurn({
      text: 'hi',
      emit: c.emit,
      config: CONFIG,
      provider: provider.provider,
      tools: { runTool: async () => /** @type {any} */ (result) },
    });
    assert.equal(c.skillResults().length, 0, `${JSON.stringify(result)} 不该产生 skillResult`);
  }
});

test('T20 ★data 不得进入模型上下文（只回填 summary）', async () => {
  const c = collector();
  const SECRET = 'THIS_SHOULD_NEVER_REACH_THE_MODEL';
  const provider = scriptedProvider([
    { toolCalls: [{ id: 't1', name: 'github_issues', arguments: '{}' }] },
    { text: 'done' },
  ]);

  await agent.runTurn({
    text: 'hi',
    emit: c.emit,
    config: CONFIG,
    provider: provider.provider,
    tools: {
      runTool: async () => /** @type {any} */ ({
        ok: true,
        summary: '只有这句该被模型看到',
        data: { secret: SECRET },
      }),
    },
  });

  // 第二次请求带上了完整 messages —— data 里的内容绝不能出现
  const second = provider.calls[1];
  const serialized = JSON.stringify(second.messages);
  assert.ok(!serialized.includes(SECRET), 'data 泄漏进了模型上下文');
  assert.ok(serialized.includes('只有这句该被模型看到'), 'summary 应该被回填');
});

// ─────────────────── 频道契约：五层任一处漏登记就静默失效 ───────────────────

test('T20 BRAIN_SKILL_RESULT 必须在 RECEIVE_CHANNELS 白名单里', () => {
  assert.equal(channels.CH.BRAIN_SKILL_RESULT, 'brain:skillResult');
  assert.ok(
    channels.RECEIVE_CHANNELS.includes(channels.CH.BRAIN_SKILL_RESULT),
    '不在白名单 → preload 的 subscribe 会抛错 → 列表永远不出现',
  );
});

test('T20 SHELL_OPEN_EXTERNAL 必须在 INVOKE_CHANNELS 白名单里', () => {
  assert.equal(channels.CH.SHELL_OPEN_EXTERNAL, 'shell:openExternal');
  assert.ok(channels.INVOKE_CHANNELS.includes(channels.CH.SHELL_OPEN_EXTERNAL));
});

test('T20 ipc.js 必须把 skillResult 事件转发到渲染端', () => {
  const src = readSource('src/main/ipc.js');
  assert.match(src, /case 'skillResult':/);
  assert.match(src, /CH\.BRAIN_SKILL_RESULT/);
});

test('T20 preload 必须暴露 onSkillResult 与 openExternal', () => {
  const src = readSource('src/preload/preload.cjs');
  assert.match(src, /onSkillResult: \(fn\) => subscribe\(CH\.BRAIN_SKILL_RESULT/);
  assert.match(src, /openExternal: \(url\) => invoke\(CH\.SHELL_OPEN_EXTERNAL/);
});

test('T20 渲染端必须订阅 onSkillResult', () => {
  const src = readSource('src/renderer/bubble.js');
  assert.match(src, /api\.onSkillResult\(/);
  assert.match(src, /function renderSkillResult\(/);
});

// ─────────────────── T21：渲染端绝不能把外部文本当 HTML ───────────────────

test('T21 ★renderSkillResult 里不许出现 innerHTML（issue 标题是外部不可信文本）', () => {
  const src = readSource('src/renderer/bubble.js');
  const start = src.indexOf('function renderSkillResult(');
  assert.ok(start > 0, '找不到 renderSkillResult');
  // 取到函数末尾（下一个顶层 function 之前）
  const rest = src.slice(start + 10);
  const nextFn = rest.indexOf('\nfunction ');
  const body = nextFn > 0 ? rest.slice(0, nextFn) : rest;

  assert.ok(!/innerHTML/.test(body), 'renderSkillResult 里出现了 innerHTML —— 那是注入面');
  assert.ok(!/insertAdjacentHTML|outerHTML|document\.write/.test(body));
  assert.match(body, /textContent/, '必须用 textContent 落文本');
  assert.match(body, /createElement/, '必须用 createElement 建节点');
});

test('T21 渲染端只让 https://github.com/ 的链接可点，且走 openExternal', () => {
  const src = readSource('src/renderer/bubble.js');
  const start = src.indexOf('function renderSkillResult(');
  const rest = src.slice(start + 10);
  const nextFn = rest.indexOf('\nfunction ');
  const body = nextFn > 0 ? rest.slice(0, nextFn) : rest;

  assert.match(body, /\^https:\\\/\\\/github\\\.com\\\//, '应有 github.com 前缀校验');
  assert.match(body, /api\.openExternal\(/, '外链必须走主进程');
  assert.ok(!/<a\s/.test(body), '不许用 <a href>（会把整个应用界面导航走）');
});

// ─────────────────── T22：外链 host 校验 ───────────────────

test('T22 外链白名单只放行 https + github.com', () => {
  assert.deepEqual([...ALLOWED_EXTERNAL_HOSTS], ['github.com']);

  const allow = [
    'https://github.com/vllm-project/vllm/issues/1',
    'https://github.com/a/b',
  ];
  for (const u of allow) assert.equal(isAllowedExternalUrl(u), true, `应放行：${u}`);

  const deny = [
    'http://github.com/a/b', // 非 https
    'https://evil.com/a/b', // 其它域名
    'https://evil-github.com/a/b', // ★ 后缀伪装：必须精确匹配域名
    'https://github.com.evil.com/a/b', // ★ 子域伪装
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'https://api.github.com/repos/a/b', // API 域名不是网页，不放行
    '',
    null,
    undefined,
    123,
    'not a url',
  ];
  for (const u of deny) assert.equal(isAllowedExternalUrl(u), false, `应拒绝：${String(u)}`);
});

test('T22 window.js 必须装导航护栏与 window.open 拒绝', () => {
  const src = readSource('src/main/window.js');
  assert.match(src, /will-navigate/, '缺 will-navigate → 漏一处直接 <a href> 就能把界面导航走');
  assert.match(src, /setWindowOpenHandler/);
  assert.match(src, /action: 'deny'/);
});

test('T22 ipc 的外链 handler 走的是同一个纯函数（不是各写一份判断）', () => {
  const src = readSource('src/main/ipc.js');
  assert.match(src, /isAllowedExternalUrl\(url\)/);
  assert.match(src, /from '\.\.\/shared\/external-link\.js'/);
});
