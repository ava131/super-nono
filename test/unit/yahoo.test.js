/**
 * 备源解析器（Yahoo）单测 —— `SDD-market-v0.md` §5.2 / §8.1。
 *
 * **全程离线**：形状类断言吃 `test/fixtures/yahoo-600519.SS.json`（真实抓包存档），
 * 边界类断言在测试内派生。**不打真实接口**（PRD-market §12.1 第 4 条）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const {
  toYahooSymbol,
  buildChartUrl,
  toExchangeDate,
  parseChartResponse,
  fetchYahooDaily,
  YAHOO_HOST,
} = await import('../../skills/market/sources/yahoo.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(here, '../fixtures/yahoo-600519.SS.json'), 'utf8'),
);

// ---------------------------------------------------------------- 符号转换

test('toYahooSymbol：A 股上交所 .SH → .SS', () => {
  assert.equal(toYahooSymbol('600519.SH'), '600519.SS');
});

test('toYahooSymbol：A 股深交所 .SZ 保持不变', () => {
  assert.equal(toYahooSymbol('000001.SZ'), '000001.SZ');
});

test('toYahooSymbol：v0 不支持的港股/美股返回 null（不猜）', () => {
  assert.equal(toYahooSymbol('00700.HK'), null);
  assert.equal(toYahooSymbol('AAPL.US'), null);
});

test('toYahooSymbol：畸形输入返回 null', () => {
  assert.equal(toYahooSymbol('600519'), null);
  assert.equal(toYahooSymbol(''), null);
  assert.equal(toYahooSymbol(/** @type {any} */ (null)), null);
});

// ---------------------------------------------------------------- URL

test('buildChartUrl：域名必须在白名单主机上，且默认日线 / 2 年', () => {
  const url = new URL(buildChartUrl('600519.SS'));
  assert.equal(url.hostname, YAHOO_HOST);
  assert.equal(url.searchParams.get('interval'), '1d');
  assert.equal(url.searchParams.get('range'), '2y');
  assert.equal(url.searchParams.get('includePrePost'), 'false');
});

test('buildChartUrl：range 可覆盖', () => {
  const url = new URL(buildChartUrl('600519.SS', { range: '1mo' }));
  assert.equal(url.searchParams.get('range'), '1mo');
});

// ---------------------------------------------------------------- 时区

test('toExchangeDate：用交易所偏移换算，不受机器时区影响', () => {
  // 2026-09-14 09:30 CST == 01:30 UTC
  const ts = Date.UTC(2026, 8, 14, 1, 30) / 1000;
  assert.equal(toExchangeDate(ts, 28800), '2026-09-14');
  // 同一个 UTC 时刻，用 UTC 直接取日期也是 14 号；但跨零点时必须用偏移
  const lateTs = Date.UTC(2026, 8, 13, 23, 0) / 1000; // UTC 13 日 23:00 = CST 14 日 07:00
  assert.equal(toExchangeDate(lateTs, 28800), '2026-09-14');
});

test('toExchangeDate：非法输入返回 null', () => {
  assert.equal(toExchangeDate(NaN, 28800), null);
  assert.equal(toExchangeDate(1e12, NaN), null);
});

// ---------------------------------------------------------------- 解析真实响应

test('parseChartResponse：吃真实抓包，解析出 22 根且字段齐全', () => {
  const r = parseChartResponse(fixture);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.bars.length, 22);
  assert.equal(r.adjclose.length, 22);
  assert.equal(r.currency, 'CNY');
  assert.equal(r.exchange, 'SHH');
  assert.equal(r.gmtoffset, 28800);
  for (const b of r.bars) {
    assert.ok(Number.isFinite(b.open));
    assert.ok(Number.isFinite(b.high));
    assert.ok(Number.isFinite(b.low));
    assert.ok(Number.isFinite(b.close));
    assert.ok(Number.isFinite(b.time));
  }
});

test('parseChartResponse：真实数据里 high ≥ low 且 close 在区间内', () => {
  const r = parseChartResponse(fixture);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  for (const b of r.bars) {
    assert.ok(b.high >= b.low, `high ${b.high} < low ${b.low}`);
    assert.ok(b.close <= b.high + 1e-9 && b.close >= b.low - 1e-9);
  }
});

test('parseChartResponse：真实抓包里 adjclose 齐全（22/22）', () => {
  const r = parseChartResponse(fixture);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.adjclose.filter((v) => v !== null).length, 22);
});

test('parseChartResponse：缺失的 bar 会被跳过，且 adjclose 同步跳过（保持一一对应）', () => {
  const broken = structuredClone(fixture);
  // 把第 3 根的 close 置为 null，模拟 Yahoo 偶尔的占位 null
  broken.chart.result[0].indicators.quote[0].close[3] = null;

  const r = parseChartResponse(broken);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.bars.length, 21);
  assert.equal(r.adjclose.length, 21, 'adjclose 必须与 bars 等长，否则复权换算会错位');
});

test('parseChartResponse：chart.error 时返回结构化失败，不抛异常', () => {
  const r = parseChartResponse({
    chart: { result: null, error: { code: 'Not Found', description: 'No data found' } },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /No data found/);
});

test('parseChartResponse：result 为空 → NOT_FOUND', () => {
  const r = parseChartResponse({ chart: { result: [], error: null } });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'NOT_FOUND');
});

test('parseChartResponse：畸形输入不崩', () => {
  for (const bad of [null, undefined, {}, { chart: {} }, { chart: { result: [{}] } }]) {
    const r = parseChartResponse(bad);
    assert.equal(r.ok, false, `输入 ${JSON.stringify(bad)} 应当失败而不是抛异常`);
  }
});

// ---------------------------------------------------------------- 拉取流程

test('fetchYahooDaily：v0 不支持的符号直接返回 NOT_FOUND，且不发请求', async () => {
  let called = 0;
  const r = await fetchYahooDaily('00700.HK', {
    safeFetch: async () => {
      called += 1;
      return { ok: true, json: async () => fixture };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(called, 0, '不该为不支持的符号发请求');
});

test('fetchYahooDaily：happy path 走注入的 safeFetch 并解析', async () => {
  let seenUrl = '';
  const r = await fetchYahooDaily('600519.SH', {
    safeFetch: async (url) => {
      seenUrl = url;
      return { ok: true, json: async () => fixture };
    },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(seenUrl.includes('600519.SS'));
  assert.ok(seenUrl.startsWith('https://'));
  assert.equal(r.bars.length, 22);
});

test('fetchYahooDaily：safeFetch 抛异常 → NETWORK，不冒泡', async () => {
  const r = await fetchYahooDaily('600519.SH', {
    safeFetch: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'NETWORK');
  assert.match(r.message, /boom/);
});

test('fetchYahooDaily：HTTP 429 → RATE_LIMIT（供上层退避，不是 NOT_FOUND）', async () => {
  const r = await fetchYahooDaily('600519.SH', {
    safeFetch: async () => ({ ok: false, status: 429 }),
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'RATE_LIMIT');
});

test('fetchYahooDaily：响应不是合法 JSON → INTERNAL，不冒泡', async () => {
  const r = await fetchYahooDaily('600519.SH', {
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
