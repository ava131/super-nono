/**
 * 会话生命周期单测。
 *
 * 这一层能做到纯 Node 单测，是因为存储层（db.js）与日志层（log.js）
 * 都不再 import electron —— 路径由 main.js 注入，这里直接注入 ':memory:'。
 *
 * 重点覆盖**删除的边界情况**，那是最容易写错、且用户一眼能看见的地方：
 *   - 删的不是当前会话 → 当前会话不受影响
 *   - 删的是当前会话 → 自动切到最近的一个
 *   - 删到最后一个    → 自动新建一个空会话（绝不允许"零会话"状态）
 *   - 删不存在的会话  → 返回 ok:false，不破坏任何状态
 * 以及自动起标题与手动改名的相互作用。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NONO_DEBUG = '';

const { initDb, closeDb, getDb } = await import('../../src/main/store/db.js');
const memory = await import('../../src/main/brain/memory.js');

let counter = 0;
/** 每个用例一个全新的内存库 + 清掉进程内缓存的会话 */
function freshDb() {
  closeDb();
  initDb(':memory:');
  memory.resetSessionState();
  counter = 0;
}

/**
 * @param {'user'|'assistant'} role
 * @param {string} content
 */
function say(role, content) {
  counter += 1;
  memory.appendMessage({ turnId: `t${counter}`, role, content });
}

test.beforeEach(() => freshDb());
test.after(() => closeDb());

// ── 会话创建与切换 ──────────────────────────────────────────────────

test('新库上 ensureStartupSession 会创建一个会话', () => {
  const id = memory.ensureStartupSession();
  assert.ok(id);
  assert.equal(memory.listSessions().length, 1);
});

test('最近的会话是空的时，启动复用它而不是堆空会话', () => {
  const a = memory.ensureStartupSession();
  // 模拟"重启"：清掉进程内缓存，但数据库保持不动
  memory.resetSessionState();
  const b = memory.ensureStartupSession();
  assert.equal(b, a, '应当复用那个空会话');
  assert.equal(memory.listSessions().length, 1, '不应堆积空会话');
});

test('最近的会话有消息时，启动会开一个新会话', () => {
  const a = memory.ensureStartupSession();
  say('user', '你好');
  // 模拟重启
  memory.resetSessionState();
  const b = memory.ensureStartupSession();
  assert.notEqual(b, a);
  assert.equal(memory.listSessions().length, 2);
});

test('缓存的会话在库里消失时，ensureStartupSession 不会返回悬空 id', () => {
  const a = memory.ensureStartupSession();
  say('user', 'x');
  // 绕过 memory 直接删掉会话行，模拟"被别处删了"
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(a);

  const b = memory.ensureStartupSession();
  assert.notEqual(b, a, '不能把已不存在的会话当成当前会话');
  assert.ok(memory.listSessions().some((s) => s.id === b));
});

test('switchSession 对不存在的 id 返回 false', () => {
  memory.ensureStartupSession();
  assert.equal(memory.switchSession('nope'), false);
});

// ── 自动起标题 ──────────────────────────────────────────────────────

test('首条用户消息会成为会话标题（截断到 20 字）', () => {
  memory.ensureStartupSession();
  say('user', '帮我写一个500字关于赛尔号的作文');
  const s = memory.listSessions()[0];
  assert.equal(s.title, '帮我写一个500字关于赛尔号的作文');
  assert.equal(s.preview, '帮我写一个500字关于赛尔号的作文');
});

test('超长标题被截到 20 字', () => {
  memory.ensureStartupSession();
  say('user', '一'.repeat(60));
  assert.equal(memory.listSessions()[0].title.length, 20);
});

test('第二条用户消息不会覆盖标题', () => {
  memory.ensureStartupSession();
  say('user', '第一条');
  say('user', '第二条');
  assert.equal(memory.listSessions()[0].title, '第一条');
});

// ── 重命名 ──────────────────────────────────────────────────────────

test('重命名后，后续的自动起标题不会把名字盖回去', () => {
  memory.ensureStartupSession();
  const id = memory.getCurrentSessionId();
  assert.equal(memory.renameSession(id, '我的自定义名字'), true);
  say('user', '这是首条用户消息');
  assert.equal(memory.listSessions()[0].title, '我的自定义名字');
});

test('重命名成空白字符串会被拒绝', () => {
  memory.ensureStartupSession();
  assert.equal(memory.renameSession(memory.getCurrentSessionId(), '   '), false);
});

// ── 删除的边界情况（重点）──────────────────────────────────────────

test('删掉非当前会话：当前会话不变', () => {
  const first = memory.ensureStartupSession();
  say('user', '旧对话');
  const second = memory.createSession();
  say('user', '新对话');

  const res = memory.deleteSession(first);

  assert.equal(res.ok, true);
  assert.equal(res.switched, false, '删的不是当前会话，不该切换');
  assert.equal(memory.getCurrentSessionId(), second);
  assert.equal(memory.listSessions().length, 1);
});

test('删掉当前会话且有别的会话：自动切到最近的一个', () => {
  const first = memory.ensureStartupSession();
  say('user', '旧对话');
  const second = memory.createSession();
  say('user', '新对话');

  // 手动切回旧的，再删掉它
  memory.switchSession(first);
  const res = memory.deleteSession(first);

  assert.equal(res.ok, true);
  assert.equal(res.switched, true);
  assert.equal(res.created, false);
  assert.equal(res.currentId, second);
  assert.equal(memory.getCurrentSessionId(), second);
});

test('删掉最后一个会话：自动新建，绝不允许零会话', () => {
  const only = memory.ensureStartupSession();
  say('user', '就这一个');

  const res = memory.deleteSession(only);

  assert.equal(res.ok, true);
  assert.equal(res.created, true, '应当自动补一个新会话');
  assert.equal(memory.listSessions().length, 1);
  assert.notEqual(res.currentId, only);
});

test('删掉会话会同时清掉它的消息，且不影响别的会话', () => {
  const a = memory.ensureStartupSession();
  say('user', 'a1');
  say('assistant', 'a2');
  const b = memory.createSession();
  say('user', 'b1');

  memory.deleteSession(a);

  // 当前是 b，应该还剩 1 条
  assert.equal(memory.countMessages(), 1);
  assert.equal(memory.recentMessages(10).length, 1);
  assert.equal(memory.recentMessages(10)[0].content, 'b1');
  assert.equal(memory.listSessions().length, 1);
  assert.equal(memory.listSessions()[0].id, b);
});

test('删不存在的会话返回 ok:false 且不破坏状态', () => {
  const a = memory.ensureStartupSession();
  say('user', 'x');

  const res = memory.deleteSession('nope');

  assert.equal(res.ok, false);
  assert.equal(memory.getCurrentSessionId(), a);
  assert.equal(memory.countMessages(), 1);
});

test('会话列表按最近更新倒序', () => {
  const a = memory.ensureStartupSession();
  say('user', 'a');
  const b = memory.createSession();
  say('user', 'b');
  const c = memory.createSession();
  say('user', 'c');

  const ids = memory.listSessions().map((s) => s.id);
  assert.deepEqual(ids, [c, b, a]);
});

test('消息带上 session_id，不会串到别的会话', () => {
  const a = memory.ensureStartupSession();
  say('user', '属于 a');
  memory.createSession();
  say('user', '属于 b');

  memory.switchSession(a);
  const list = memory.recentMessages(10);
  assert.equal(list.length, 1);
  assert.equal(list[0].content, '属于 a');
});
