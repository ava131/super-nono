/**
 * 行情技能单测（PRD-market §6 / SDD-market §5.4–5.6 / §8.1）。
 *
 * ## 全程离线
 *
 * 用**假 `safeFetch`** 返回 `test/fixtures/yahoo-600519.SS.json`（真实抓包存档）。
 * **不打真实接口** —— 实测已证明反复调试会把数据源打封（PRD §12.1 第 4 条）。
 *
 * ## 重点覆盖的设计约束
 *
 * - **降级判据**：首次失败即整体切源；同一次调用内不混源（MK21）
 * - **早失败**：首次请求用短超时（2–3s），不是每只等满 10s
 * - **缓存**：命中不重复出网（MK9）；存的是**原始数据**（评审 B-3）
 * - **中断**：`CANCELLED` 与 `TIMEOUT` 区分（MK19）
 * - **失败隔离**：单只失败不拖累其余（MK11）
 * - **summary 预算**：`String.length ≤ 800` 且减行不减列（MK15）
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.NONO_DEBUG = '';

const { initDb, closeDb } = await import('../../src/main/store/db.js');
const { createSkillStore } = await import('../../src/main/skills/store.js');
const market = await import('../../skills/market/index.js');
const { renderScanSummary, describePercentile, SUMMARY_LIMIT } = await import(
  '../../skills/market/snapshot.js'
);
const { FETCH_TIMEOUT_FIRST_MS, FETCH_TIMEOUT_MS } = await import(
  '../../skills/market/sources/index.js'
);

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(here, '../fixtures/yahoo-600519.SS.json'), 'utf8'),
);

function freshDb() {
  closeDb();
  initDb(':memory:');
}

/**
 * 与"数据源无关"的用例（缓存 / scan / 指标 / summary）需要**确定性**，
 * 所以默认只让 **Yahoo** 可用。
 *
 * 否则东财一旦被启用（生产配置就是启用的），这些用例的假 `safeFetch`
 * 会先被东财调用一次、失败、再降级到 Yahoo —— 请求次数变成 2，
 * 于是"缓存命中不重复出网"这类断言会误报。
 *
 * 要测主源路径的用例，自己用 `withEastmoneyEnabled()` 显式打开。
 */
async function setYahooOnly() {
  const { SOURCES } = await import('../../skills/market/sources/index.js');
  SOURCES.eastmoney.available = false;
}

test.beforeEach(async () => {
  freshDb();
  market.resetRuntimeState();
  await setYahooOnly();
});

test.after(async () => {
  // 还原成生产配置（东财主源可用），免得影响同进程里的其他测试文件
  const { SOURCES } = await import('../../skills/market/sources/index.js');
  SOURCES.eastmoney.available = true;
});

/**
 * 造一个假 safeFetch。
 *
 * @param {{ fail?: boolean, status?: number, delayMs?: number, record?: string[] }} [opts]
 * @returns {(url: string, o?: any) => Promise<any>}
 */
function fakeFetch(opts = {}) {
  return async (url, o) => {
    if (opts.record) opts.record.push(url);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.fail) throw new Error('network down');
    if (opts.status && opts.status !== 200) return { ok: false, status: opts.status };
    return { ok: true, status: 200, json: async () => fixture };
  };
}

/**
 * 造技能上下文。
 * @param {{ safeFetch?: any, watchlistItems?: any[], signal?: AbortSignal }} [opts]
 */
function ctx(opts = {}) {
  return {
    store: createSkillStore('market', { risk: 'read_only', permissions: ['db:cache'] }),
    safeFetch: opts.safeFetch ?? fakeFetch(),
    watchlistItems: opts.watchlistItems ?? [],
    signal: opts.signal,
  };
}

/**
 * 自选股条目
 * @param {string} name
 * @param {string} symbol
 * @param {string} code
 */
function item(name, symbol, code) {
  return { name, symbol, code, market: symbol.endsWith('.SH') ? 'SH' : 'SZ', kind: 'stock', addedAt: 1 };
}

// ---------------------------------------------------------------- overview

test('overview：正常路径产出状况说明书，且带数据时间与数据源', async () => {
  const r = await market.run({ action: 'overview', symbol: '茅台' }, ctx());
  assert.equal(r.ok, true, r.ok ? '' : r.message);
  if (!r.ok) return;
  assert.match(r.summary, /贵州茅台/);
  assert.match(r.summary, /数据截至 \d{4}-\d{2}-\d{2} 收盘/, '必须带数据时间（PRD §3.5）');
  assert.match(r.summary, /yahoo/, '必须标注数据源');
  assert.ok(r.summary.length <= SUMMARY_LIMIT);
});

test('overview：本地表没有时**联网搜一次**（新股/ETF 靠名字查到的唯一途径）', async () => {
  /** @type {string[]} */
  const record = [];
  await market.run(
    { action: 'overview', symbol: '宇树' },
    ctx({
      /** @param {string} url */
      safeFetch: async (url) => {
        record.push(url);
        return {
          ok: true,
          json: async () => ({
            QuotationCodeTable: {
              Status: 0,
              Data: [
                { Code: '688836', Name: '宇树科技-W', QuoteID: '1.688836', SecurityTypeName: '科创板' },
              ],
            },
          }),
        };
      },
    }),
  );
  // 关键断言：**搜索确实发生了**。否则"新股查不到"这个用户可见问题依然存在。
  assert.ok(
    record.some((u) => u.includes('searchapi.eastmoney.com')),
    `应当发起过搜索，实际请求：${record.join(', ')}`,
  );
});

test('🔴 搜索唯一命中且名字包含输入 → **直接用**，不再多问一句', async () => {
  // 真实场景：用户说「宇树科技」，东财返回「宇树科技-W」（多一个 -W 后缀）。
  // 精确匹配不上，但"只搜到 1 条 + 名字包含输入"已经足够确定，
  // 这时再问"你是说宇树科技-W吗？"纯属多余。
  const r = await market.run(
    { action: 'overview', symbol: '宇树科技' },
    ctx({
      /** @param {string} url */
      safeFetch: async (url) => {
        if (url.includes('searchapi')) {
          return {
            ok: true,
            json: async () => ({
              QuotationCodeTable: {
                Status: 0,
                Data: [{ Code: '688836', Name: '宇树科技-W', QuoteID: '1.688836' }],
              },
            }),
          };
        }
        throw new Error('取数失败，本例只验解析');
      },
    }),
  );
  // 解析成功了 → 会去取数（这里故意让它失败），所以不该再出现"你是说…？"
  assert.doesNotMatch(String(r.ok ? '' : r.message), /你是说|是它吗/, '唯一命中时不该再追问');
});

test('🔴 搜到多条 → 仍然让用户选（"不许猜"的底线不放）', async () => {
  const r = await market.run(
    { action: 'overview', symbol: '华夏' },
    ctx({
      /** @param {string} url */
      safeFetch: async (url) => {
        if (url.includes('searchapi')) {
          return {
            ok: true,
            json: async () => ({
              QuotationCodeTable: {
                Status: 0,
                Data: [
                  { Code: '510300', Name: '华夏沪深300ETF', QuoteID: '1.510300' },
                  { Code: '588000', Name: '华夏科创50ETF', QuoteID: '1.588000' },
                ],
              },
            }),
          };
        }
        throw new Error('不该走到取数');
      },
    }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /搜到多个|你是说/);
  assert.match(r.message, /510300/);
});

test('🔴 唯一命中但名字**不包含**输入 → 不自动用，先确认', async () => {
  // 防止"唯一命中就用"被滥用：只回一条与输入无关的，也必须先问。
  // ⚠️ 输入必须**不在内置表里**（否则精确匹配就命中了，根本走不到搜索）。
  const r = await market.run(
    { action: 'overview', symbol: '随便一个新股' },
    ctx({
      /** @param {string} url */
      safeFetch: async (url) => {
        if (url.includes('searchapi')) {
          return {
            ok: true,
            json: async () => ({
              QuotationCodeTable: {
                Status: 0,
                Data: [{ Code: '600519', Name: '贵州茅台', QuoteID: '1.600519' }],
              },
            }),
          };
        }
        throw new Error('不该走到取数');
      },
    }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /是它吗|你是说/);
});

test('overview：搜索也找不到 → 如实说找不到，**不猜一个代码**', async () => {
  /** @type {string[]} */
  const record = [];
  const r = await market.run(
    { action: 'overview', symbol: '某个绝对不存在的票' },
    ctx({
      /** @param {string} url */
      safeFetch: async (url) => {
        record.push(url);
        return { ok: true, json: async () => ({ QuotationCodeTable: { Status: 0, Data: [] } }) };
      },
    }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /没找到|找不到/);
  assert.ok(record.some((u) => u.includes('searchapi')), '应当尝试过搜索');
});

test('overview：代码输入也能查（600519）', async () => {
  const r = await market.run({ action: 'overview', symbol: '600519' }, ctx());
  assert.equal(r.ok, true, r.ok ? '' : r.message);
});

test('quote：输出比 overview 短，但仍有价、涨跌、数据时间', async () => {
  const r = await market.run({ action: 'quote', symbol: '茅台' }, ctx());
  assert.equal(r.ok, true, r.ok ? '' : r.message);
  if (!r.ok) return;
  assert.match(r.summary, /现价/);
  assert.match(r.summary, /涨跌/);
  assert.match(r.summary, /数据截至/);
  assert.ok(r.summary.length < 400, 'quote 应当比 overview 短');
});

test('🔴 直接报代码时，名字从接口补全（否则显示「516350（516350）」）', async () => {
  // ⚠️ 这个用例喂的是**东财格式**的响应，所以要显式开着东财
  //（`beforeEach` 为了确定性默认只开 Yahoo）。
  await withEastmoneyEnabled(async () => {
  // 用户报代码进来时，符号解析拿不到名字，只能先用代码占位。
  // 而接口返回的 meta.longName 就是真名 —— 必须补上，
  // 否则明明查的是"芯片ETF易方达"，界面上却显示两遍代码。
  const r = await market.run(
    { action: 'overview', symbol: '516350' },
    ctx({
      safeFetch: async () => ({
        ok: true,
        json: async () => ({
          rc: 0,
          data: {
            code: '516350',
            market: 1,
            name: '芯片ETF易方达',
            klines: [
              '2026-09-11,1.5000,1.5100,1.5200,1.4900,100000',
              '2026-09-14,1.5100,1.4890,1.5200,1.4800,120000',
            ],
          },
        }),
      }),
    }),
  );
  assert.equal(r.ok, true, r.ok ? '' : r.message);
  if (!r.ok) return;
  assert.match(r.summary, /芯片ETF易方达/, '必须用接口给的真名');
  assert.doesNotMatch(r.summary, /516350（516350）/, '不该显示两遍代码');
  });
});

test('名字补全**不覆盖**本地表里的正式名', async () => {
  await withEastmoneyEnabled(async () => {
  // 本地表里有名字（贵州茅台）时，不该被接口返回的名字冲掉
  const r = await market.run(
    { action: 'overview', symbol: '茅台' },
    ctx({
      safeFetch: async () => ({
        ok: true,
        json: async () => ({
          rc: 0,
          data: {
            code: '600519',
            market: 1,
            name: '别的名字',
            klines: ['2026-09-14,1,1,1,1,1'],
          },
        }),
      }),
    }),
  );
  assert.equal(r.ok, true, r.ok ? '' : r.message);
  if (!r.ok) return;
  assert.match(r.summary, /贵州茅台/);
  });
});

// ---------------------------------------------------------------- 缓存

test('缓存：第二次查询不重复出网（MK9）', async () => {
  /** @type {string[]} */
  const record = [];
  const c = ctx({ safeFetch: fakeFetch({ record }) });
  await market.run({ action: 'overview', symbol: '茅台' }, c);
  const after1 = record.length;
  assert.equal(after1, 1, '首次应出网一次');

  await market.run({ action: 'overview', symbol: '茅台' }, c);
  assert.equal(record.length, after1, '第二次必须命中缓存，不再出网');
});

test('缓存：命中时输出标注"（缓存）"', async () => {
  const c = ctx();
  await market.run({ action: 'overview', symbol: '茅台' }, c);
  const r = await market.run({ action: 'overview', symbol: '茅台' }, c);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.summary, /缓存/);
});

test('缓存：cacheKey 格式与 SDD §5.4 一致', async () => {
  const { cacheKey } = await import('../../skills/market/cache.js');
  assert.equal(cacheKey('yahoo', '600519.SH', '2y'), 'kline:yahoo:600519.SH:2y');
});

test('缓存：存的是**原始数据**，不是复权后结果（评审 B-3）', async () => {
  const store = createSkillStore('market', { risk: 'read_only' });
  await market.run({ action: 'overview', symbol: '茅台' }, ctx({ safeFetch: fakeFetch() }));
  // 直接看库里存了什么
  const { getDb } = await import('../../src/main/store/db.js');
  const rows = /** @type {any[]} */ (
    getDb().prepare('SELECT key, value FROM skill_kv WHERE namespace = ?').all('market')
  );
  assert.equal(rows.length, 1);
  const stored = JSON.parse(rows[0].value);
  assert.ok(Array.isArray(stored.payload.bars), '应存原始 bars');
  assert.ok(
    stored.payload.bars.every((/** @type {any} */ b) => b.factor === undefined),
    '不该存带 factor 的复权后 bar',
  );
  assert.ok('adjclose' in stored.payload, '原始 adjclose 要一起存，供每次现算复权');
});

// ---------------------------------------------------------------- 降级

test('降级：主源（东财）未启用时，自动用备源（Yahoo）', async () => {
  await setYahooOnly();
  const r = await market.run({ action: 'overview', symbol: '茅台' }, ctx());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.summary, /yahoo/);
});

test('降级：网络失败 → 措辞是"数据源暂时拒绝"，**不是**"查不到这只股票"', async () => {
  const r = await market.run(
    { action: 'overview', symbol: '茅台' },
    ctx({ safeFetch: fakeFetch({ fail: true }) }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /过会儿再试/);
  assert.doesNotMatch(r.message, /查不到这只股票/);
});

test('降级：HTTP 429 → 也算"源被拒"，不是"股票不存在"', async () => {
  const r = await market.run(
    { action: 'overview', symbol: '茅台' },
    ctx({ safeFetch: fakeFetch({ status: 429 }) }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /过会儿再试/);
});

test('早失败：首次请求用 3s 短超时，正常请求用 10s', () => {
  assert.equal(FETCH_TIMEOUT_FIRST_MS, 3000);
  assert.equal(FETCH_TIMEOUT_MS, 10000);
  assert.ok(
    FETCH_TIMEOUT_FIRST_MS < FETCH_TIMEOUT_MS,
    '首次必须更快失败，否则 20 只会整体超时',
  );
});

// ---------------------------------------------------------------- scan

test('scan：空自选给出可操作提示', async () => {
  const r = await market.run({ action: 'scan' }, ctx({ watchlistItems: [] }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.summary, /空的/);
});

test('scan：没有注入自选名单时明确报错，而不是当成"空自选"', async () => {
  const c = { store: createSkillStore('market', { risk: 'read_only' }), safeFetch: fakeFetch() };
  const r = await market.run({ action: 'scan' }, c);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /自选股名单/);
});

test('scan：单只失败**不拖累其余**（MK11）', async () => {
  let calls = 0;
  /** @param {string} url */
  const flaky = async (url) => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return { ok: true, status: 200, json: async () => fixture };
  };
  const r = await market.run(
    { action: 'scan' },
    ctx({
      safeFetch: flaky,
      watchlistItems: [item('贵州茅台', '600519.SH', '600519'), item('宁德时代', '300750.SZ', '300750')],
    }),
  );
  assert.equal(r.ok, true, r.ok ? '' : r.message);
  if (!r.ok) return;
  assert.match(r.summary, /没查到/);
  assert.match(r.summary, /贵州茅台/);
});

test('scan：超过 20 只被拒（不会打爆数据源）', async () => {
  const many = Array.from({ length: 21 }, (_, i) =>
    item(`票${i}`, `6000${String(i).padStart(2, '0')}.SH`, `6000${String(i).padStart(2, '0')}`),
  );
  const r = await market.run({ action: 'scan' }, ctx({ watchlistItems: many }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'BAD_ARGS');
});

test('scan：输出带数据源与数据时间', async () => {
  const r = await market.run(
    { action: 'scan' },
    ctx({ watchlistItems: [item('贵州茅台', '600519.SH', '600519')] }),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.summary, /数据源 yahoo/);
  assert.match(r.summary, /数据截至/);
});

// ---------------------------------------------------------------- 中断

test('中断：scan 开始前 signal 已 aborted → 抛 AbortError（不返回结果）', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => market.run({ action: 'scan' }, ctx({ signal: ac.signal, watchlistItems: [item('贵州茅台', '600519.SH', '600519')] })),
    (err) => /** @type {Error} */ (err).name === 'AbortError',
  );
});

test('中断：单只查询时 signal 已 aborted 同样抛 AbortError', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => market.run({ action: 'overview', symbol: '茅台' }, ctx({ signal: ac.signal })),
    (err) => /** @type {Error} */ (err).name === 'AbortError',
  );
});

test('中断：AbortError 的名字可被上层归一成 CANCELLED（与 TIMEOUT 区分，MK19）', async () => {
  const ac = new AbortController();
  ac.abort();
  try {
    await market.run({ action: 'scan' }, ctx({ signal: ac.signal, watchlistItems: [] }));
    assert.fail('应当抛错');
  } catch (err) {
    // agent.js 依赖 err.name === 'AbortError' 来判定 CANCELLED
    const e = /** @type {Error} */ (err);
    assert.equal(e.name, 'AbortError');
    assert.notEqual(e.name, 'TimeoutError');
  }
});

// ---------------------------------------------------------------- 主备顺序与整体切换（MK21）

/**
 * 临时把东财置为可用再还原。
 *
 * `SOURCES` 本身是 `Object.freeze` 的（防误改），但**单个适配器对象没有冻结**，
 * 所以测试可以临时翻转 `available` 来验证主源路径 —— 这正是"解析器已写好、
 * 等实测确认后只需把 available 改 true"那个开关。
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withEastmoneyEnabled(fn) {
  const { SOURCES } = await import('../../skills/market/sources/index.js');
  const prev = SOURCES.eastmoney.available;
  SOURCES.eastmoney.available = true;
  try {
    return await fn();
  } finally {
    SOURCES.eastmoney.available = prev;
  }
}

test('🔴 主备顺序：东财排第一（主源），Yahoo 只作降级', async () => {
  const { SOURCE_ORDER, SOURCES } = await import('../../skills/market/sources/index.js');
  assert.equal(SOURCE_ORDER[0], 'eastmoney', '主源必须是东财');
  assert.equal(SOURCE_ORDER[1], 'yahoo', '备源必须是 Yahoo');
  // 复权口径：东财 fqt=1 已前复权（跳过 adjust.js），Yahoo 需要自己换算
  assert.equal(SOURCES.eastmoney.adjustedAlready, true);
  assert.equal(SOURCES.yahoo.adjustedAlready, false);
});

test('🔴 东财可用时**优先生效，且不碰 Yahoo**', async () => {
  await withEastmoneyEnabled(async () => {
    /** @type {string[]} */
    const hosts = [];
    const r = await market.run(
      { action: 'overview', symbol: '茅台' },
      {
        store: createSkillStore('market', { risk: 'read_only', permissions: ['db:cache'] }),
        watchlistItems: [],
        /** @param {string} url */
        safeFetch: async (url) => {
          hosts.push(new URL(url).hostname);
          return {
            ok: true,
            json: async () => ({
              rc: 0,
              data: {
                code: '600519',
                market: 1,
                name: '贵州茅台',
                klines: ['2026-09-10,1291.00,1285.13,1294.99,1282.00,18900'],
              },
            }),
          };
        },
      },
    );
    assert.equal(r.ok, true, r.ok ? '' : r.message);
    if (!r.ok) return;
    assert.match(r.summary, /eastmoney/, '应当标注数据源为东财');
    assert.deepEqual(
      hosts,
      ['push2his.eastmoney.com'],
      `只该请求东财，实际请求了：${hosts.join(', ')}`,
    );
  });
});

test('🔴 主源失败 → **整体切换**到备源，且在输出里标注实际用的源', async () => {
  await withEastmoneyEnabled(async () => {
    /** @type {string[]} */
    const hosts = [];
    const r = await market.run(
      { action: 'overview', symbol: '茅台' },
      {
        store: createSkillStore('market', { risk: 'read_only', permissions: ['db:cache'] }),
        watchlistItems: [],
        /** @param {string} url */
        safeFetch: async (url) => {
          hosts.push(new URL(url).hostname);
          if (url.includes('eastmoney')) throw new Error('east blocked');
          return { ok: true, json: async () => fixture };
        },
      },
    );
    assert.equal(r.ok, true, r.ok ? '' : r.message);
    if (!r.ok) return;
    assert.match(r.summary, /yahoo/, '必须标注实际用的是备源');
    assert.deepEqual(hosts, ['push2his.eastmoney.com', 'query1.finance.yahoo.com']);
  });
});

test('🔴 备源也要**自己换算复权**（东财路径跳过 adjust.js，Yahoo 路径不能跳）', async () => {
  // 用真实 fixture（含 adjclose）走 Yahoo 路径，确认 OHLC 被换算过
  const r = await market.run({ action: 'overview', symbol: '茅台' }, ctx({ safeFetch: fakeFetch() }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const view = /** @type {any} */ (r.data);
  // 该 fixture 无除权 → factor 全为 1，所以复权后应与原始一致
  assert.ok(view.price !== null);
  // 关键是**没有出现"降级为不复权"的提示** —— 说明 adjust 正常跑过
  assert.doesNotMatch(r.summary, /不复权/);
});

// ---------------------------------------------------------------- 出网次数自检

test('出网自检：正常情况下 scan 的请求数等于股票数', async () => {
  /** @type {string[]} */
  const record = [];
  const items = [item('贵州茅台', '600519.SH', '600519'), item('宁德时代', '300750.SZ', '300750')];
  await market.run({ action: 'scan' }, ctx({ safeFetch: fakeFetch({ record }), watchlistItems: items }));
  assert.equal(record.length, 2, '两只票应当只有两次出网（缓存未命中）');
  assert.ok(market.countFetches() <= 25);
});

// ---------------------------------------------------------------- summary 预算

test('renderScanSummary：列固定，超限时**减行不减列**（评审 D-4）', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    name: `很长的股票名字${i}`,
    price: 100 + i,
    changePct: i - 10,
    rsi: 50,
    rangePos: 60,
    volRatio: 1.2,
  }));
  const r = renderScanSummary(rows, { dataDate: '2026-09-11', limit: 400 });
  assert.ok(r.summary.length <= 400);
  assert.ok(r.omitted > 0, '超限时应当有省略');
  assert.match(r.summary, /另有 \d+ 只未显示/);
  // 表头必须还在（列没被丢掉）
  assert.match(r.summary, /名称/);
  assert.match(r.summary, /RSI/);
  assert.match(r.summary, /量比/);
});

test('renderScanSummary：默认预算下尽量多放，且**永不超限**', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    name: `票${i}`,
    price: 10 + i,
    changePct: 1,
    rsi: 50,
    rangePos: 60,
    volRatio: 1.2,
  }));
  const r = renderScanSummary(rows, { dataDate: '2026-09-11' });
  assert.ok(r.summary.length <= SUMMARY_LIMIT, `实际 ${r.summary.length}`);
  // 800 单位放不下 20 行是**预算的真实约束**（含表头与数据时间行），
  // 所以这里不要求 omitted===0，而是要求"放下了大部分，且省略有明确交代"
  assert.ok(r.shown >= 15, `应当放下大部分，实际只放了 ${r.shown}`);
  if (r.omitted > 0) assert.match(r.summary, /另有 \d+ 只未显示/);
  assert.match(r.summary, /数据截至/);
});

test('renderScanSummary：数据短到能放下时**不该**有省略', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    name: `票${i}`,
    price: 10 + i,
    changePct: 1,
    rsi: 50,
    rangePos: 60,
    volRatio: 1.2,
  }));
  const r = renderScanSummary(rows, { dataDate: '2026-09-11' });
  assert.equal(r.omitted, 0, r.summary);
  assert.doesNotMatch(r.summary, /未显示/);
});

test('renderScanSummary：空名单不崩', () => {
  const r = renderScanSummary([], {});
  assert.equal(r.shown, 0);
  assert.ok(r.summary.length > 0);
});

test('describePercentile：必须带中文读法，不能只给百分数（评审 B-2）', () => {
  const s = describePercentile(12);
  assert.match(s, /只有 12%/);
  assert.match(s, /低于当前价/);
});

// ---------------------------------------------------------------- 边界

test('未知 action → BAD_ARGS', async () => {
  const r = await market.run(/** @type {any} */ ({ action: 'destroy' }), ctx());
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'BAD_ARGS');
});

test('overview：缺 symbol → 不崩，返回失败', async () => {
  const r = await market.run({ action: 'overview' }, ctx());
  assert.equal(r.ok, false);
});

test('缺 ctx.store → INTERNAL，不崩', async () => {
  const r = await market.run({ action: 'overview', symbol: '茅台' }, /** @type {any} */ ({}));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'INTERNAL');
});
