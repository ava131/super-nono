/**
 * `ctx.store` 单测 —— 技能持久化契约（SDD-market §3.1 / 评审决定 9）。
 *
 * ## 这一层守的是「命名空间隔离 ≠ 权限隔离」
 *
 * 只做命名空间隔离的话，一个声明 `read_only` 的技能**照样能往自己的命名空间里写**。
 * 它写不进别人的，但它自己的数据正是别的技能会当作可信来源读的东西
 * （例如 `market` 读 `watchlist` 的自选股）。
 *
 * 所以本文件重点验证**运行时写闸门**，而不只是"能不能存能取"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NONO_DEBUG = '';

const { initDb, closeDb, getDb } = await import('../../src/main/store/db.js');
const {
  createSkillStore,
  readNamespaceValue,
  writeNamespaceValue,
  checkKey,
  KEY_PATTERN,
  MAX_VALUE_BYTES,
  MAX_NAMESPACE_BYTES,
} = await import('../../src/main/skills/store.js');

function freshDb() {
  closeDb();
  initDb(':memory:');
}

test.beforeEach(() => freshDb());

/** 一个可写的技能声明（L1.5） */
const writable = { risk: 'local_reversible' };
/** 一个只读的（L1） */
const readonly = { risk: 'read_only' };

// ---------------------------------------------------------------- 基本读写

test('set / get 往返（含对象与数组）', () => {
  const s = createSkillStore('demo', writable);
  s.set('a', { x: 1, y: [2, 3] });
  assert.deepEqual(s.get('a'), { x: 1, y: [2, 3] });
});

test('get 不存在的 key → null（不是 undefined）', () => {
  const s = createSkillStore('demo', writable);
  assert.equal(s.get('nope'), null);
});

test('set 覆盖同一个 key 只留一份', () => {
  const s = createSkillStore('demo', writable);
  s.set('a', 1);
  s.set('a', 2);
  assert.equal(s.get('a'), 2);
  assert.equal(s.list().length, 1);
});

test('delete 返回是否真的删掉了', () => {
  const s = createSkillStore('demo', writable);
  s.set('a', 1);
  assert.equal(s.delete('a'), true);
  assert.equal(s.delete('a'), false, '删不存在的应返回 false');
  assert.equal(s.get('a'), null);
});

test('list 支持前缀过滤，且按 key 排序', () => {
  const s = createSkillStore('demo', writable);
  s.set('k:2', 2);
  s.set('k:1', 1);
  s.set('other', 9);
  assert.deepEqual(
    s.list('k:').map((r) => r.key),
    ['k:1', 'k:2'],
  );
  assert.equal(s.list().length, 3);
});

test('clear 只清自己的命名空间', () => {
  const a = createSkillStore('a', writable);
  const b = createSkillStore('b', writable);
  a.set('x', 1);
  b.set('x', 2);
  a.clear();
  assert.equal(a.get('x'), null);
  assert.equal(b.get('x'), 2, '不该清掉别的命名空间');
});

test('命名空间互相隔离', () => {
  const a = createSkillStore('a', writable);
  const b = createSkillStore('b', writable);
  a.set('shared-key', 'from-a');
  assert.equal(b.get('shared-key'), null);
});

// ---------------------------------------------------------------- 写闸门（重点）

test('🔒 read_only 技能**不能写**（这是权限隔离，不是命名空间隔离）', () => {
  const s = createSkillStore('reader', readonly);
  assert.equal(s.writable, false);
  assert.throws(() => s.set('a', 1), /不允许写入/);
  assert.throws(() => s.delete('a'), /不允许写入/);
  assert.throws(() => s.clear(), /不允许写入/);
});

test('🔒 read_only 技能**仍然可以读**（只读不等于禁用）', () => {
  // 先用可写的技能写进去
  createSkillStore('shared', writable).set('cfg', { v: 1 });
  // 换个只读技能读同一个命名空间
  const reader = createSkillStore('shared', readonly);
  assert.deepEqual(reader.get('cfg'), { v: 1 });
  assert.equal(reader.list().length, 1);
});

test('🔒 写闸门按 **risk** 判定，覆盖全部可写档位', () => {
  for (const risk of ['local_write', 'local_reversible', 'external_send']) {
    const s = createSkillStore(`ns_${risk}`, { risk });
    assert.equal(s.writable, true, `${risk} 应当可写`);
    s.set('a', 1);
    assert.equal(s.get('a'), 1);
  }
});

test('🔒 未知 risk 视为不可写（fail-closed，而不是 fail-open）', () => {
  const s = createSkillStore('weird', { risk: 'something_new' });
  assert.equal(s.writable, false);
  assert.throws(() => s.set('a', 1), /不允许写入/);
});

test('🔒 缺少 manifest 时也不可写（fail-closed）', () => {
  const s = createSkillStore('noManifest', /** @type {any} */ (undefined));
  assert.equal(s.writable, false);
  assert.throws(() => s.set('a', 1));
});

// ---------------------------------------------------------------- key 校验

test('key 白名单：合法形状通过', () => {
  for (const k of [
    'a',
    'items',
    'undo:1',
    // ⚠️ 真实用途：内部符号是大写的，缓存键必须能写出来
    'kline:eastmoney:600519.SH:2y',
    'a-b_c.d',
  ]) {
    assert.equal(checkKey(k), k, `${k} 应当合法`);
  }
});

test('key 白名单：非法形状抛 BAD_ARGS', () => {
  for (const k of ['', 'has space', '中文', 'a/b', "a'b", 'a"b', 'a'.repeat(65), /** @type {any} */ (1), null]) {
    assert.throws(() => checkKey(k), /key 不合法/, `${String(k)} 应当被拒`);
  }
});

test('KEY_PATTERN 与文档一致（允许大小写，以兼容含符号的缓存键）', () => {
  assert.equal(String(KEY_PATTERN), String(/^[A-Za-z0-9_:.-]{1,64}$/));
});

// ---------------------------------------------------------------- 容量上限

test('单值上限：超过 64KB 抛错', () => {
  const s = createSkillStore('big', writable);
  const huge = 'x'.repeat(MAX_VALUE_BYTES + 100);
  assert.throws(() => s.set('big', huge), /单个值过大/);
});

test('单值上限：刚好在边界内可以存', () => {
  const s = createSkillStore('big', writable);
  // JSON.stringify 会加两个引号，留出余量
  const ok = 'x'.repeat(MAX_VALUE_BYTES - 10);
  s.set('ok', ok);
  assert.equal(/** @type {string} */ (s.get('ok')).length, ok.length);
});

test('单命名空间上限：累加超过 1MB 抛错', () => {
  const s = createSkillStore('flood', writable);
  const chunk = 'y'.repeat(60 * 1024);
  let written = 0;
  let threw = false;
  for (let i = 0; i < 30; i++) {
    try {
      s.set(`k${i}`, chunk);
      written += 1;
    } catch (err) {
      threw = true;
      assert.match(/** @type {Error} */ (err).message, /超出上限/);
      break;
    }
  }
  assert.equal(threw, true, `应当在达到 ${MAX_NAMESPACE_BYTES} 前抛错`);
  assert.ok(written > 0, '应当允许写入一部分');
});

test('单命名空间上限：**改小一个值**不该被自己挡住', () => {
  const s = createSkillStore('shrink', writable);
  const chunk = 'z'.repeat(60 * 1024);
  for (let i = 0; i < 15; i++) s.set(`k${i}`, chunk);
  // 把其中一个改小 —— 净增量是负的，必须允许
  s.set('k0', 'tiny');
  assert.equal(s.get('k0'), 'tiny');
});

test('usedBytes 反映本命名空间用量，且不串到别的命名空间', () => {
  const a = createSkillStore('a', writable);
  const b = createSkillStore('b', writable);
  assert.equal(a.usedBytes(), 0);
  a.set('x', 'hello');
  assert.ok(a.usedBytes() > 0);
  assert.equal(b.usedBytes(), 0);
});

// ---------------------------------------------------------------- 缓存子 API（与用户数据分开）

test('🔒 read_only 技能**声明了 db:cache** 后可以写自己的缓存', () => {
  const s = createSkillStore('market', { risk: 'read_only', permissions: ['db:cache'] });
  assert.equal(s.writable, false, '用户数据仍然不许写');
  assert.equal(s.cacheWritable, true, '但缓存可以写');
  s.cache.put('kline:yahoo:600519.SH:2y', { ok: 1 });
  assert.deepEqual(s.cache.get('kline:yahoo:600519.SH:2y'), { ok: 1 });
  // 关键：走用户数据通道仍然被拦
  assert.throws(() => s.set('items', [1]), /不允许写入/);
});

test('🔒 read_only 技能**没声明 db:cache** → 连缓存也不能写', () => {
  const s = createSkillStore('reader', { risk: 'read_only', permissions: [] });
  assert.equal(s.cacheWritable, false);
  assert.throws(() => s.cache.put('k', 1), /db:cache/);
  assert.throws(() => s.cache.drop('k'), /db:cache/);
  assert.throws(() => s.cache.clear(), /db:cache/);
});

test('🔒 缓存可以读，即使不可写（读不设限）', () => {
  createSkillStore('ns', { risk: 'read_only', permissions: ['db:cache'] }).cache.put('k', 42);
  const reader = createSkillStore('ns', { risk: 'read_only', permissions: [] });
  assert.equal(reader.cache.get('k'), 42);
});

test('缓存子 API：drop / clear 生效', () => {
  const s = createSkillStore('c', { risk: 'read_only', permissions: ['db:cache'] });
  s.cache.put('a', 1);
  s.cache.put('b', 2);
  assert.equal(s.cache.drop('a'), true);
  assert.equal(s.cache.get('a'), null);
  s.cache.clear();
  assert.equal(s.cache.get('b'), null);
});

test('缓存与用户数据共用同命名空间，但语义分离（都算在 usedBytes 里）', () => {
  const s = createSkillStore('mixed', { risk: 'local_reversible', permissions: ['db:cache'] });
  s.set('items', [1, 2, 3]);
  s.cache.put('kline', 'x'.repeat(100));
  assert.ok(s.usedBytes() > 100);
});

// ---------------------------------------------------------------- 健壮性（续）

// ---------------------------------------------------------------- 越权读取

test('readNamespaceValue：编排层可以跨技能只读（market 读 watchlist 的自选股）', () => {
  createSkillStore('watchlist', { risk: 'local_reversible' }).set('items', [{ code: '600519' }]);
  assert.deepEqual(readNamespaceValue('watchlist', 'items'), [{ code: '600519' }]);
});

test('readNamespaceValue：读不存在的命名空间返回 null，不抛', () => {
  assert.equal(readNamespaceValue('nope', 'items'), null);
});

test('readNamespaceValue：namespace 为空时抛错（调用方式错误要早暴露）', () => {
  assert.throws(() => readNamespaceValue('', 'items'), /namespace/);
});

test('readNamespaceValue：仍然受 key 白名单约束', () => {
  assert.throws(() => readNamespaceValue('watchlist', 'has space'), /key 不合法/);
});

// ---------------------------------------------------------------- 宿主代用户写（自选删除）

test('writeNamespaceValue：宿主可以代用户删掉自选股（界面按钮那条路）', () => {
  const wl = createSkillStore('watchlist', { risk: 'local_reversible' });
  wl.set('items', [{ symbol: '600519.SH' }, { symbol: '300750.SZ' }]);

  // 模拟用户在气泡里点删除
  const items = /** @type {any[]} */ (readNamespaceValue('watchlist', 'items'));
  const next = items.filter((e) => e.symbol !== '600519.SH');
  writeNamespaceValue('watchlist', 'items', next);

  assert.deepEqual(readNamespaceValue('watchlist', 'items'), [{ symbol: '300750.SZ' }]);
});

test('writeNamespaceValue：仍然受 key 白名单与序列化约束', () => {
  assert.throws(() => writeNamespaceValue('watchlist', 'has space', 1), /key 不合法/);
  assert.throws(() => writeNamespaceValue('watchlist', 'items', undefined), /无法序列化/);
  assert.throws(() => writeNamespaceValue('', 'items', 1), /namespace/);
});

test('值无法序列化（函数 / undefined）→ 抛 BAD_ARGS，不静默', () => {
  const s = createSkillStore('demo', writable);
  assert.throws(() => s.set('f', () => 1), /无法序列化/);
  assert.throws(() => s.set('u', undefined), /无法序列化/);
});

test('循环引用 → 抛 BAD_ARGS，不崩进程', () => {
  const s = createSkillStore('demo', writable);
  /** @type {any} */
  const cyc = {};
  cyc.self = cyc;
  assert.throws(() => s.set('c', cyc), /无法序列化/);
});

test('库里被外部写入畸形 JSON 时，get 返回 null 而不是抛异常', () => {
  const s = createSkillStore('demo', writable);
  s.set('a', 1);
  // 绕过 store 直接改库，模拟外部损坏
  getDb().prepare('UPDATE skill_kv SET value = ? WHERE namespace = ? AND key = ?').run('{oops', 'demo', 'a');
  assert.equal(s.get('a'), null);
});

test('空 namespace 抛错（调用方式错误要早暴露）', () => {
  assert.throws(() => createSkillStore('', writable), /namespace/);
});
