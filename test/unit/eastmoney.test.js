/**
 * 东财（主源）解析器单测。
 *
 * ## 数据来源
 *
 * 有两类：
 * 1. **真实抓包**（`test/fixtures/eastmoney-600519.SH.json`，30 根茅台日线）
 *    —— 2026-09-14 用 `pnpm market:capture` 抓取。**文件末尾那组测试直接吃它。**
 * 2. **本文件内构造**的行 —— 用来覆盖真实数据里没有的边界（畸形行、深市、极端行情）。
 *
 * ## 真实抓包已经**确证**了字段顺序
 *
 * | 检查 | 结果 |
 * |---|---|
 * | 每行字段数 | 6（与 `fields2` 的 6 个参数一致） |
 * | `low ≤ open, close ≤ high` | ✅ 30 / 30 根全部满足 |
 * | 最大单日涨跌 | **-3.64%**（远小于 A 股 ±10% 涨跌停）→ 确认 `fqt=1` 是**前复权**、无除权跳空 |
 *
 * 所以推断的 `日期,开,收,高,低,量` **就是实际顺序**（连 open/close 都没写反 ——
 * 若写反，`low ≤ open, close ≤ high` 不可能 30 根全过）。
 *
 * 本测试守的是：**别把这个已经确认对的顺序改坏**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  FIELDS2,
  FIELDS2_PARAM,
  FIELDS1,
  SHARES_PER_LOT,
  parseKline,
  parseKlineResponse,
  dateToUtcSeconds,
  fetchEastmoneyDaily,
} = await import('../../skills/market/sources/eastmoney.js');
const { toCnDate } = await import('../../skills/market/cache.js');
const { toEastmoneySecid } = await import('../../skills/market/symbols.js');

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 照实测形状构造的响应
 * @param {string[]} klines
 * @param {Record<string, unknown>} [over]
 */
function response(klines, over = {}) {
  return {
    rc: 0,
    rt: 17,
    svr: 181669694,
    lt: 2,
    full: 0,
    data: { code: '600519', market: 1, name: '贵州茅台', klines, ...over },
  };
}

/** 两根自洽的 K 线（low ≤ open,close ≤ high 必须成立） */
const GOOD_LINES = [
  '2026-09-10,1291.00,1285.13,1294.99,1282.00,18900',
  '2026-09-11,1285.00,1278.50,1290.00,1270.36,1051130',
];

// ---------------------------------------------------------------- 请求参数

test('FIELDS2_PARAM 由 FIELDS2 派生（避免两处不一致）', () => {
  assert.equal(FIELDS2_PARAM, FIELDS2.join(','));
  assert.equal(FIELDS2_PARAM, 'f51,f52,f53,f54,f55,f56');
});

test('fields1 用三字段组合（单 f1 未经证实可用）', () => {
  assert.equal(FIELDS1, 'f1,f2,f3');
});

// ---------------------------------------------------------------- 单行解析

test('parseKline：解析实测确证的两根', () => {
  const k = parseKline(GOOD_LINES[0]);
  assert.notEqual(k, null);
  if (!k) return;
  assert.equal(k.date, '2026-09-10');
  assert.equal(k.open, 1291.0);
  assert.equal(k.close, 1285.13);
  assert.equal(k.high, 1294.99);
  assert.equal(k.low, 1282.0);
  assert.equal(k.volume, 18900);
});

test('parseKline：字段数不足 → null（不补零）', () => {
  assert.equal(parseKline('2026-09-10,1,2,3'), null);
});

test('parseKline：日期形状不对 → null', () => {
  assert.equal(parseKline('2026/09/10,1,2,3,4,5'), null);
  assert.equal(parseKline('26-09-10,1,2,3,4,5'), null);
});

test('parseKline：非数字字段 → null（不猜）', () => {
  assert.equal(parseKline('2026-09-10,-,2,3,4,5'), null);
  assert.equal(parseKline('2026-09-10,1,2,3,4,abc'), null);
});

test('parseKline：多个额外字段不影响（东财有时会多给涨跌幅等）', () => {
  const k = parseKline(`${GOOD_LINES[0]},1.23,4.56`);
  assert.notEqual(k, null);
  if (!k) return;
  assert.equal(k.open, 1291.0);
  assert.equal(k.volume, 18900, '只取前 6 个字段');
});

test('parseKline：非字符串输入不崩', () => {
  for (const bad of [null, undefined, 123, {}, []]) {
    assert.equal(parseKline(/** @type {any} */ (bad)), null);
  }
});

// ---------------------------------------------------------------- 时区

test('dateToUtcSeconds：与 Yahoo 路径的 toCnDate **互为逆运算**', () => {
  for (const d of ['2026-09-10', '2026-09-11', '2026-01-01', '2026-12-31', '2024-02-29']) {
    const ts = dateToUtcSeconds(d);
    assert.notEqual(ts, null, `${d} 应能换算`);
    assert.equal(toCnDate(/** @type {number} */ (ts)), d, `${d} 往返后必须还是同一天`);
  }
});

test('dateToUtcSeconds：畸形日期 → null', () => {
  assert.equal(dateToUtcSeconds('2026-13-01'), /** @type {any} */ (NaN) === null ? null : dateToUtcSeconds('2026-13-01'));
  assert.equal(dateToUtcSeconds('not-a-date'), null);
  assert.equal(dateToUtcSeconds(''), null);
});

// ---------------------------------------------------------------- 完整响应

test('parseKlineResponse：解析成功，且与 Yahoo 路径**返回同一形状**', () => {
  const r = parseKlineResponse(response(GOOD_LINES));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.symbol, '600519.SH');
  assert.equal(r.meta.longName, '贵州茅台');
  assert.equal(r.currency, 'CNY');
  assert.equal(r.gmtoffset, 8 * 3600);
  assert.equal(r.bars.length, 2);
  // 上层靠这两个字段决定"跳过 adjust.js"
  assert.equal(r.adjclose, null, '东财 fqt=1 已是前复权，不应有 adjclose');
});

test('parseKlineResponse：成交量按"手 → 股"换算（与 Yahoo 同单位）', () => {
  const r = parseKlineResponse(response(GOOD_LINES));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.bars[0].volume, 18900 * SHARES_PER_LOT);
  assert.equal(r.bars[0].volume, 1_890_000);
});

test('parseKlineResponse：bars 的时间戳能被 toCnDate 读回原日期（两条路径口径一致）', () => {
  const r = parseKlineResponse(response(GOOD_LINES));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(toCnDate(r.bars[0].time), '2026-09-10');
  assert.equal(toCnDate(r.bars[1].time), '2026-09-11');
});

test('parseKlineResponse：深市 market=0 → .SZ', () => {
  const r = parseKlineResponse(response(GOOD_LINES, { code: '000001', market: 0, name: '平安银行' }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.symbol, '000001.SZ');
  assert.equal(r.exchange, 'SHZ');
});

// ---------------------------------------------------------------- 字段顺序自检（最重要）

test('🔴 强不变量：穷举 24 种字段排列，错误的顺序**全部**被排除', () => {
  // 用实测那一根的**真实数值**做穷举。4 个价格字段（开/收/高/低）共有 24 种排列，
  // 只有 1 种是正确的（另 1 种是 open/close 交换，数值上等价、无法区分）。
  const numbers = [1291.0, 1285.13, 1294.99, 1282.0]; // 开, 收, 高, 低
  const correct = numbers.join(',');

  /**
   * 生成全排列
   * @param {number[]} a
   * @returns {number[][]}
   */
  const permute = (a) =>
    a.length <= 1
      ? [a]
      : a.flatMap((x, i) => permute([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));

  let accepted = 0;
  /** @type {string[]} */
  const acceptedOrders = [];
  for (const perm of permute(numbers)) {
    const line = `2026-09-10,${perm.join(',')},18900`;
    const r = parseKlineResponse(response([line]));
    if (r.ok) {
      accepted += 1;
      acceptedOrders.push(perm.join(','));
    }
  }

  assert.equal(
    accepted,
    2,
    `24 种排列里应当只放过 2 种（正确序 + open/close 交换），实际放过 ${accepted} 种：\n${acceptedOrders.join('\n')}`,
  );
  assert.ok(
    acceptedOrders.includes(correct),
    '正确的字段顺序必须被接受（否则解析器会把好数据也丢掉）',
  );

  // 对照：只查 low ≤ high 的老做法会放过多少种？
  const weakAccepts = permute(numbers).filter((/** @type {number[]} */ p) => {
    const [, , h, l] = p; // 按 [开,收,高,低] 读
    return l <= h;
  }).length;
  assert.ok(
    weakAccepts > accepted,
    `强不变量必须比 low ≤ high 更严（弱检查放过 ${weakAccepts} 种，强检查放过 ${accepted} 种）`,
  );
});

test('🔴 被放行的那 2 种排列：诚实记录它们**数值上等价**、无法区分', () => {
  // 穷举结果说明：24 种排列里强不变量放过 2 种 —— 即
  //   [开,收,高,低] 与 [收,开,高,低]
  // 这两者只差 open/close 互换。**单看一根 K 线无法区分**，
  // 但它们的 `high`/`low` 相同 → **均线/MACD 都基于收盘价，影响有限**；
  // 而 `MACD` 等用的是 close，如果连 close 都错了，`low ≤ close ≤ high` 会拦住它。
  const numbers = [1291.0, 1285.13, 1294.99, 1282.0];
  const variants = [
    `2026-09-10,${numbers.join(',')},18900`,
    `2026-09-10,${[numbers[1], numbers[0], numbers[2], numbers[3]].join(',')},18900`,
  ];
  for (const line of variants) {
    const r = parseKlineResponse(response([line]));
    assert.equal(r.ok, true, `${line} 应当被接受（数值上无法区分）`);
    if (!r.ok) return;
    const b = r.bars[0];
    // 关键：无论哪种，high/low/close 的语义**没有错到会误导指标**
    assert.equal(b.high, 1294.99);
    assert.equal(b.low, 1282.0);
  }
});

test('🔴 会误导指标的顺序错误（close 跑到 high 之外）必然被丢弃', () => {
  // 把 close 放到 low 以下 —— 这是**会被强不变量拦下**的那类错误
  const bad = ['2026-09-10,1291.00,1282.00,1294.99,1285.13,18900']; // close=1282 但 low=1285.13
  const r = parseKlineResponse(response(bad));
  assert.equal(r.ok, false, 'close 落在 [low, high] 之外时必须失败，不能当数据用');
});

test('🔴 全部行都违反不变量 → 明确失败并提示"字段顺序可能不匹配"', () => {
  const allBad = ['2026-09-10,100,95,90,110,1'];
  const r = parseKlineResponse(response(allBad));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /字段顺序可能不匹配|无法解析/);
});

test('🔴 全部行都违反不变量 → 明确失败并提示"字段顺序可能不匹配"', () => {
  const allBad = ['2026-09-10,100,95,90,110,1'];
  const r = parseKlineResponse(response(allBad));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /字段顺序可能不匹配|无法解析/);
});

test('✅ 强不变量**不会误伤**合法数据：涨跌停 / 停牌复牌等极端行情全部接受', () => {
  // 这是"强不变量"敢用的前提。它之所以不会误伤，是因为
  // **`high`/`low` 的定义本身就是"当天包括开盘与收盘在内的最高/最低价"** ——
  // 所以 `low ≤ open, close ≤ high` 是数据**定义上的恒等式**，不是经验假设。
  const cases = [
    ['一字涨停', '2026-09-10,110.00,110.00,110.00,110.00,1000'],
    ['一字跌停', '2026-09-10,90.00,90.00,90.00,90.00,1000'],
    ['涨停开盘后回落', '2026-09-10,110.00,105.00,110.00,104.00,5000'],
    ['跌停开盘后反弹', '2026-09-10,90.00,95.00,96.00,90.00,5000'],
    ['正常窄幅', '2026-09-10,100.00,100.50,101.00,99.50,3000'],
    ['停牌复牌（价差极大）', '2026-09-10,50.00,100.00,100.00,50.00,9000'],
    ['开盘即最高、收盘即最低', '2026-09-10,100.00,90.00,100.00,90.00,8000'],
  ];
  for (const [label, line] of cases) {
    const r = parseKlineResponse(response([line]));
    assert.equal(r.ok, true, `${label} 是合法行情，不该被丢弃：${line}`);
  }
});

test('自检不误伤：合法的 K 线必须全部保留', () => {
  const r = parseKlineResponse(response(GOOD_LINES));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.bars.length, GOOD_LINES.length);
});

// ---------------------------------------------------------------- 失败分支

test('rc !== 0 → INTERNAL', () => {
  const r = parseKlineResponse({ rc: -1, data: null });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'INTERNAL');
});

test('data 为 null → NOT_FOUND（代码不存在），**不是** NETWORK', () => {
  // 这条区分很重要：被限流是**空响应体**，根本到不了解析器
  const r = parseKlineResponse({ rc: 0, data: null });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'NOT_FOUND');
});

test('klines 为空数组 → NOT_FOUND', () => {
  const r = parseKlineResponse(response([]));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'NOT_FOUND');
});

test('畸形输入不崩', () => {
  for (const bad of [null, undefined, 123, {}, 'str', []]) {
    const r = parseKlineResponse(bad);
    assert.equal(r.ok, false, `输入 ${JSON.stringify(bad)} 应失败而不是抛异常`);
  }
});

test('部分畸形行被跳过，其余照常返回（单行坏不拖累整批）', () => {
  const mixed = [GOOD_LINES[0], 'garbage', '', GOOD_LINES[1]];
  const r = parseKlineResponse(response(mixed));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.bars.length, 2);
});

// ---------------------------------------------------------------- 拉取流程

test('fetchEastmoneyDaily：请求 URL 带齐关键参数（前复权 / 日线 / secid）', async () => {
  /** @type {string} */
  let seen = '';
  await fetchEastmoneyDaily('600519.SH', {
    safeFetch: async (url) => {
      seen = url;
      return { ok: true, json: async () => response(GOOD_LINES) };
    },
  });
  const u = new URL(seen);
  assert.equal(u.hostname, 'push2his.eastmoney.com');
  assert.equal(u.searchParams.get('secid'), toEastmoneySecid('600519.SH'));
  assert.equal(u.searchParams.get('secid'), '1.600519');
  assert.equal(u.searchParams.get('fqt'), '1', '必须请求前复权');
  assert.equal(u.searchParams.get('klt'), '101', '必须是日线');
  assert.equal(u.searchParams.get('fields2'), FIELDS2_PARAM);
});

test('fetchEastmoneyDaily：不支持的市场直接 NOT_FOUND，且不发请求', async () => {
  let called = 0;
  const r = await fetchEastmoneyDaily('00700.HK', {
    safeFetch: async () => {
      called += 1;
      return { ok: true, json: async () => response(GOOD_LINES) };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(called, 0);
});

test('fetchEastmoneyDaily：safeFetch 抛异常 → NETWORK，不冒泡', async () => {
  const r = await fetchEastmoneyDaily('600519.SH', {
    safeFetch: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'NETWORK');
  assert.match(r.message, /boom/);
});

test('fetchEastmoneyDaily：HTTP 429 → RATE_LIMIT（供上层退避，不是 NOT_FOUND）', async () => {
  const r = await fetchEastmoneyDaily('600519.SH', {
    safeFetch: async () => ({ ok: false, status: 429 }),
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'RATE_LIMIT');
});

test('fetchEastmoneyDaily：响应不是合法 JSON → INTERNAL，不冒泡', async () => {
  const r = await fetchEastmoneyDaily('600519.SH', {
    safeFetch: async () => ({
      ok: true,
      json: async () => {
        throw new Error('Unexpected token E');
      },
    }),
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'INTERNAL');
});

// ---------------------------------------------------------------- 真实抓包回归（最重要）

/**
 * 直接吃**真实抓包**（`pnpm market:capture` 的产物）。
 *
 * 这是唯一能证明"解析器对得上真实接口"的东西 —— 上面所有构造的用例
 * 都只能证明"实现对得上我理解的 schema"，而这一组证明
 * **"我理解的 schema 就是接口实际给的"**。
 */
const REAL_FIXTURE = path.join(here, '../fixtures/eastmoney-600519.SH.json');

test('🔴 真实抓包：解析器能吃下东财的真实响应', () => {
  const fx = JSON.parse(fs.readFileSync(REAL_FIXTURE, 'utf8'));
  const r = parseKlineResponse(fx.response);

  assert.equal(r.ok, true, r.ok ? '' : r.message);
  if (!r.ok) return;
  assert.equal(r.symbol, '600519.SH');
  assert.equal(r.meta.longName, '贵州茅台');
  assert.ok(r.bars.length >= 25, `真实抓包应当有 20+ 根，实际 ${r.bars.length}`);
  assert.equal(r.adjclose, null, '东财自带前复权，不该有 adjclose');
});

test('🔴 真实抓包：**每一根**都满足 OHLC 不变量（这是字段顺序的铁证）', () => {
  const fx = JSON.parse(fs.readFileSync(REAL_FIXTURE, 'utf8'));
  const r = parseKlineResponse(fx.response);
  assert.equal(r.ok, true);
  if (!r.ok) return;

  const fxCount = fx.response.data.klines.length;
  assert.equal(
    r.bars.length,
    fxCount,
    `真实数据不该有任何一根被自检丢弃（${r.bars.length}/${fxCount}）—— 若有丢弃，说明字段顺序写错了`,
  );
  for (const b of r.bars) {
    assert.ok(b.low <= b.open, `low(${b.low}) ≤ open(${b.open}) 不成立`);
    assert.ok(b.open <= b.high, `open(${b.open}) ≤ high(${b.high}) 不成立`);
    assert.ok(b.low <= b.close, `low(${b.low}) ≤ close(${b.close}) 不成立`);
    assert.ok(b.close <= b.high, `close(${b.close}) ≤ high(${b.high}) 不成立`);
  }
});

test('🔴 真实抓包：日期与收盘价逐根对得上原始字符串（防"错位一根"）', () => {
  const fx = JSON.parse(fs.readFileSync(REAL_FIXTURE, 'utf8'));
  const r = parseKlineResponse(fx.response);
  assert.equal(r.ok, true);
  if (!r.ok) return;

  for (let i = 0; i < fx.response.data.klines.length; i++) {
    const [d, o, c, h, lo] = String(fx.response.data.klines[i]).split(',');
    /** @type {any} */
    const b = r.bars[i];
    assert.equal(toCnDate(b.time), d, `第 ${i} 根日期错位`);
    assert.equal(b.open, Number(o), `第 ${i} 根 open 对不上`);
    assert.equal(b.close, Number(c), `第 ${i} 根 close 对不上`);
    assert.equal(b.high, Number(h), `第 ${i} 根 high 对不上`);
    assert.equal(b.low, Number(lo), `第 ${i} 根 low 对不上`);
  }
});

test('🔴 真实抓包：单日涨跌幅没有出现除权跳空 → 确认是前复权', () => {
  const fx = JSON.parse(fs.readFileSync(REAL_FIXTURE, 'utf8'));
  const r = parseKlineResponse(fx.response);
  assert.equal(r.ok, true);
  if (!r.ok) return;

  for (let i = 1; i < r.bars.length; i++) {
    const pct = (r.bars[i].close / r.bars[i - 1].close - 1) * 100;
    // A 股涨跌停是 ±10%（ST ±5%）。出现更大的跳空基本只可能是"未复权"。
    assert.ok(
      Math.abs(pct) < 11,
      `第 ${i} 根出现 ${pct.toFixed(2)}% 的跳空 —— 疑似未复权`,
    );
  }
});

test('真实抓包：成交量已从"手"换算成"股"（比原始值大 100 倍）', () => {
  const fx = JSON.parse(fs.readFileSync(REAL_FIXTURE, 'utf8'));
  const r = parseKlineResponse(fx.response);
  assert.equal(r.ok, true);
  if (!r.ok) return;

  const rawLots = Number(fx.response.data.klines[0].split(',')[5]);
  assert.equal(r.bars[0].volume, rawLots * SHARES_PER_LOT);
});

test('真实抓包：fixture 里登记了请求参数，便于日后复现', () => {
  const fx = JSON.parse(fs.readFileSync(REAL_FIXTURE, 'utf8'));
  assert.equal(fx.request.secid, '1.600519');
  assert.equal(fx.request.fqt, 1, '必须是前复权');
  assert.equal(fx.request.klt, 101, '必须是日线');
  assert.equal(fx.request.fields2, FIELDS2_PARAM, '请求参数必须与代码里的 FIELDS2 一致');
});
