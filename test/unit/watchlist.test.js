/**
 * 自选股技能单测（PRD-market §5 / §8，评审决定 3 与 5）。
 *
 * 重点覆盖四件事：
 *   1. **增删查的基本正确性**（含幂等与上限）
 *   2. **恰好 20 支的上限**，第 21 支被拒且说清原因
 *   3. **解析不到时不猜** —— 返回候选而不是硬塞进去
 *   4. ✅ **零出网**：即使没有 `safeFetch` 也必须能工作（MK18 的自选名单依赖这一点）
 */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NONO_DEBUG = '';

const { initDb, closeDb } = await import('../../src/main/store/db.js');
const { createSkillStore } = await import('../../src/main/skills/store.js');
const { run, WATCHLIST_LIMIT } = await import('../../skills/watchlist/index.js');

function freshDb() {
  closeDb();
  initDb(':memory:');
}

test.beforeEach(() => freshDb());

/**
 * 造一个技能上下文。
 *
 * ⚠️ **刻意不给 `safeFetch`** —— 本技能不该出网，给了反而会掩盖"偷偷联网"的实现。
 * 如果哪天实现里真的发起网络请求，这里会因缺少 safeFetch 而立刻暴露。
 * @returns {{ store: any }}
 */
function ctx() {
  return { store: createSkillStore('watchlist', { risk: 'local_reversible' }) };
}

// ---------------------------------------------------------------- list

test('list：空自选时给出可操作的提示，而不是空字符串', async () => {
  const r = await run({ action: 'list' }, ctx());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.summary, /空/);
  assert.match(r.summary, /怎么加|加进自选/);
  assert.deepEqual(/** @type {any} */ (r.data).items, []);
});

// ---------------------------------------------------------------- add

test('add：中文全名 → 存入统一的内部符号与代码', async () => {
  const c = ctx();
  const r = await run({ action: 'add', symbol: '贵州茅台' }, c);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.summary, /贵州茅台/);
  assert.match(r.summary, /600519/);

  const items = /** @type {any} */ (r.data).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].symbol, '600519.SH');
  assert.equal(items[0].code, '600519');
  assert.equal(items[0].market, 'SH');
  assert.equal(items[0].kind, 'stock');
  assert.ok(typeof items[0].addedAt === 'number');
});

test('add：别名也能命中（"茅台" → 贵州茅台）', async () => {
  const r = await run({ action: 'add', symbol: '茅台' }, ctx());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(/** @type {any} */ (r.data).items[0].symbol, '600519.SH');
});

test('add：代码也能命中（600519）', async () => {
  const r = await run({ action: 'add', symbol: '600519' }, ctx());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(/** @type {any} */ (r.data).items[0].name, '贵州茅台');
});

test('add：**重复添加是幂等的**，不报错也不重复存', async () => {
  const c = ctx();
  await run({ action: 'add', symbol: '茅台' }, c);
  const r2 = await run({ action: 'add', symbol: '600519' }, c);
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  assert.match(r2.summary, /已经在自选里/);
  assert.equal(/** @type {any} */ (r2.data).items.length, 1);
});

test('add：解析不到时**返回候选而不是硬塞进去**', async () => {
  const c = ctx();
  const r = await run({ action: 'add', symbol: '五粮' }, c); // 不精确，但有候选
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /五粮液/);
  // 关键：失败的添加不能留下任何痕迹
  const list = await run({ action: 'list' }, c);
  assert.equal(list.ok, true);
  if (!list.ok) return;
  assert.equal(/** @type {any} */ (list.data).items.length, 0);
});

test('add：完全找不到的票 → 失败且不写入', async () => {
  const c = ctx();
  const r = await run({ action: 'add', symbol: '某个不存在的股票' }, c);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'NOT_FOUND');
  const list = await run({ action: 'list' }, c);
  if (!list.ok) return;
  assert.equal(/** @type {any} */ (list.data).items.length, 0);
});

test('add：缺少 symbol → BAD_ARGS（说清要什么）', async () => {
  const r = await run({ action: 'add' }, ctx());
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'BAD_ARGS');
});

// ---------------------------------------------------------------- 上限

test(`add：最多 ${WATCHLIST_LIMIT} 支，第 ${WATCHLIST_LIMIT + 1} 支被拒并说清原因`, async () => {
  const c = ctx();
  // 用内置种子表凑满 20 支（种子表有 60+ 只个股，足够）
  const symbols = [
    '贵州茅台', '五粮液', '泸州老窖', '山西汾酒', '洋河股份', '伊利股份', '海天味业', '双汇发展',
    '工商银行', '建设银行', '农业银行', '中国银行', '招商银行', '兴业银行', '浦发银行', '中国平安',
    '中国人寿', '中信证券', '东方财富', '中国石油',
  ];
  assert.equal(symbols.length, WATCHLIST_LIMIT);

  for (const s of symbols) {
    const r = await run({ action: 'add', symbol: s }, c);
    assert.equal(r.ok, true, `${s} 应当能加入：${r.ok ? '' : r.message}`);
  }

  const full = await run({ action: 'list' }, c);
  assert.equal(full.ok, true);
  if (!full.ok) return;
  assert.equal(/** @type {any} */ (full.data).items.length, WATCHLIST_LIMIT);

  // 第 21 支
  const over = await run({ action: 'add', symbol: '中国石化' }, c);
  assert.equal(over.ok, false);
  if (over.ok) return;
  assert.equal(over.code, 'BAD_ARGS');
  assert.match(over.message, new RegExp(String(WATCHLIST_LIMIT)));
  assert.match(over.message, /满/);

  // 上限不能把已有的挤掉
  const after = await run({ action: 'list' }, c);
  if (!after.ok) return;
  assert.equal(/** @type {any} */ (after.data).items.length, WATCHLIST_LIMIT);
});

// ---------------------------------------------------------------- remove

test('remove：删掉已存在的 → 数量减少，且该支不在名单里', async () => {
  const c = ctx();
  await run({ action: 'add', symbol: '茅台' }, c);
  await run({ action: 'add', symbol: '五粮液' }, c);

  const r = await run({ action: 'remove', symbol: '茅台' }, c);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.summary, /移出自选/);
  const items = /** @type {any} */ (r.data).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].symbol, '000858.SZ');
});

test('remove：删不存在的 → 幂等，不报错', async () => {
  const c = ctx();
  await run({ action: 'add', symbol: '茅台' }, c);
  const r = await run({ action: 'remove', symbol: '五粮液' }, c);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.summary, /本来就不在/);
  assert.equal(/** @type {any} */ (r.data).items.length, 1);
});

test('remove：缺 symbol → BAD_ARGS', async () => {
  const r = await run({ action: 'remove' }, ctx());
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'BAD_ARGS');
});

// ---------------------------------------------------------------- 持久化 / 隔离

test('持久化：同一个 store 实例上连续操作能累积', async () => {
  const c = ctx();
  await run({ action: 'add', symbol: '茅台' }, c);
  await run({ action: 'add', symbol: '五粮液' }, c);
  const r = await run({ action: 'list' }, c);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(/** @type {any} */ (r.data).items.length, 2);
});

test('隔离：换一个 store 实例（模拟新技能上下文）读的是同一份数据', async () => {
  const c1 = ctx();
  await run({ action: 'add', symbol: '茅台' }, c1);
  // runner 每次执行都会 createSkillStore，这里模拟第二次调用
  const c2 = ctx();
  const r = await run({ action: 'list' }, c2);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(/** @type {any} */ (r.data).items.length, 1, '自选股必须跨调用保留');
});

test('隔离：别的技能的命名空间读不到自选股', async () => {
  await run({ action: 'add', symbol: '茅台' }, ctx());
  const other = createSkillStore('market', { risk: 'read_only' });
  assert.equal(other.get('items'), null);
});

// ---------------------------------------------------------------- 零出网

test('✅ 零出网：没有 safeFetch 也能完成全部操作（MK18）', async () => {
  // ctx() 刻意不提供 safeFetch —— 本技能不该出网
  const c = ctx();
  assert.equal((await run({ action: 'add', symbol: '茅台' }, c)).ok, true);
  assert.equal((await run({ action: 'list' }, c)).ok, true);
  assert.equal((await run({ action: 'remove', symbol: '茅台' }, c)).ok, true);
});

// ---------------------------------------------------------------- 健壮性

test('缺少 ctx.store → 明确报错，而不是崩', async () => {
  const r = await run({ action: 'list' }, /** @type {any} */ ({}));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'INTERNAL');
  assert.match(r.message, /ctx\.store/);
});

test('未知 action → BAD_ARGS', async () => {
  const r = await run(/** @type {any} */ ({ action: 'destroy' }), ctx());
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'BAD_ARGS');
});

test('库里存了畸形数据时 list 不崩（过滤掉坏条目）', async () => {
  const c = ctx();
  c.store.set('items', [
    { symbol: '600519.SH', code: '600519', market: 'SH', kind: 'stock', name: '贵州茅台', addedAt: 1 },
    { garbage: true },
    null,
    'not-an-object',
  ]);
  const r = await run({ action: 'list' }, c);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(/** @type {any} */ (r.data).items.length, 1, '只保留合法条目');
});

test('summary 简短（≤800），且 list 的 summary 不含行情数值', async () => {
  const c = ctx();
  await run({ action: 'add', symbol: '茅台' }, c);
  const r = await run({ action: 'list' }, c);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.summary.length <= 800, `summary 过长：${r.summary.length}`);
  // 名单里不该出现价格/涨跌这类事实层数字（那要另外出网查）
  assert.doesNotMatch(r.summary, /\d+\.\d{2}/, '名单不该带价格');
});
