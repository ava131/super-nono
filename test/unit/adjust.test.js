/**
 * 复权换算单测 —— `SDD-market-v0.md` §5.1（MK3）。
 *
 * ## 两类数据分工明确（重要）
 *
 * - **真实 fixture**（`yahoo-600519.SS.json`）：验证**解析形状与真实 schema 兼容**。
 *   ⚠️ 该区间**没有除权**，`adjclose === close` 全程成立，
 *   所以它**验证不了换算是否真的生效** —— 只能验证"不换算时也不出错"。
 * - **合成数据**（本文件内构造）：带**已知除权点**，用来**真正验证**
 *   `factor = adjclose / close` 的换算与跳空抹平。
 *
 * 两者缺一不可：只有合成数据会脱离真实 schema，只有真实数据则验证不了换算。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const {
  adjustForward,
  isIdentityAdjustment,
  checkFactorDirection,
  barReturn,
  findLargestAdjustmentGap,
  ADJUST_STATUS,
} = await import('../../skills/market/adjust.js');
const { parseChartResponse } = await import('../../skills/market/sources/yahoo.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(here, '../fixtures/yahoo-600519.SS.json'), 'utf8'),
);

/**
 * 造一根 bar。
 * @param {number} close
 * @param {{ open?: number, high?: number, low?: number, volume?: number, time?: number }} [opts]
 * @returns {import('../../skills/market/adjust.js').RawBar}
 */
function bar(close, { open = close, high = close, low = close, volume = 100, time = 0 } = {}) {
  return { time, open, high, low, close, volume };
}

/**
 * 把 `RawBar` 补上 `factor` 变成 `AdjustedBar`。
 * @param {import('../../skills/market/adjust.js').RawBar} b
 * @param {number} factor
 * @returns {import('../../skills/market/adjust.js').AdjustedBar}
 */
function withFactor(b, factor) {
  return { ...b, time: b.time ?? null, factor };
}

/**
 * 断言某个值是有限数字并返回它（用于收窄 `factor: number | null`）。
 * @param {number | null} v
 * @param {string} what
 * @returns {number}
 */
function mustBeNumber(v, what) {
  assert.equal(typeof v, 'number', `${what} 应为数字`);
  assert.ok(Number.isFinite(v), `${what} 应为有限数字，实际 ${v}`);
  return /** @type {number} */ (v);
}

/**
 * 断言数组某位的 factor 是有限数字并返回它。
 * @param {import('../../skills/market/adjust.js').AdjustedBar[]} bars
 * @param {number} i
 * @returns {number}
 */
function factorAt(bars, i) {
  return mustBeNumber(bars[i].factor, `bars[${i}].factor`);
}

/**
 * 造一段**带一次除权**的合成数据。
 *
 * 场景：除权前股价 100，10 送 10 → 除权日理论价 50（若不考虑分红，价差就是"跳空"）。
 * Yahoo 的前复权口径会把**除权前**的价格**除以 2**（factor = 0.5），
 * 于是复权后序列连续，跳空消失。
 *
 * 真实场景里 factor 由 `adjclose/close` 给出，这里直接构造出这个关系。
 *
 * @returns {{ rawBars: import('../../skills/market/adjust.js').RawBar[],
 *             adjclose: number[] }}
 */
function makeSplitScenario() {
  // 6 根：前 3 根在除权前（raw 价格 100 附近），后 3 根在除权后（raw 价格 50 附近）
  const rawClose = [100, 102, 104, 52, 53, 54];
  const rawBars = rawClose.map((c, i) =>
    bar(c, { open: c, high: c + 1, low: c - 1, volume: 1000, time: 1000 + i * 86400 }),
  );
  // 前复权：除权前的历史价被等比缩小 0.5
  const adjclose = [50, 51, 52, 52, 53, 54];
  return { rawBars, adjclose };
}

// ---------------------------------------------------------------- 真实 fixture

test('真实 fixture：无除权的区间里，换算结果是"恒等"的（factor 全为 1）', () => {
  const r = parseChartResponse(fixture);
  assert.equal(r.ok, true);
  if (!r.ok) return;

  const adj = adjustForward(r.bars, r.adjclose);
  assert.equal(adj.adjusted, ADJUST_STATUS.FORWARD);
  assert.equal(adj.reason, null);
  assert.equal(adj.skipped, 0);
  assert.equal(adj.bars.length, 22);

  // ⚠️ 这个区间恰好没有除权 → factor 恒为 1，用 isIdentityAdjustment 显式确认，
  // 免得后人误以为"这段 fixture 验证了换算"。
  assert.equal(isIdentityAdjustment(adj.bars), true);
  for (const b of adj.bars) {
    assert.ok(Math.abs(mustBeNumber(b.factor, 'factor') - 1) < 1e-12);
  }
});

test('真实 fixture：复权后 close 必须等于接口给的 adjclose', () => {
  const r = parseChartResponse(fixture);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const adj = adjustForward(r.bars, r.adjclose);
  for (let i = 0; i < adj.bars.length; i++) {
    assert.ok(
      Math.abs(adj.bars[i].close - /** @type {number} */ (r.adjclose[i])) < 1e-9,
      `第 ${i} 根复权收盘价应等于 adjclose`,
    );
  }
});

// ---------------------------------------------------------------- 合成除权场景

test('合成除权：factor = adjclose / close，且 OHLC 全部同倍缩放', () => {
  const { rawBars, adjclose } = makeSplitScenario();
  const adj = adjustForward(rawBars, adjclose);

  assert.equal(adj.adjusted, ADJUST_STATUS.FORWARD);
  assert.equal(adj.bars.length, 6);

  // 第 0 根：close 100 → 50，factor 0.5
  assert.ok(Math.abs(factorAt(adj.bars, 0) - 0.5) < 1e-12);
  assert.ok(Math.abs(adj.bars[0].close - 50) < 1e-12);
  assert.ok(Math.abs(adj.bars[0].open - 50) < 1e-12);
  assert.ok(Math.abs(adj.bars[0].high - 50.5) < 1e-12);
  assert.ok(Math.abs(adj.bars[0].low - 49.5) < 1e-12);

  // 最后一根：不打折
  assert.ok(Math.abs(factorAt(adj.bars, 5) - 1) < 1e-12);

  // 每一根都满足 close_adj == adjclose
  for (let i = 0; i < 6; i++) {
    assert.ok(Math.abs(adj.bars[i].close - adjclose[i]) < 1e-9);
  }
});

test('合成除权：复权**抹平了跳空** —— 这是 MK3 的核心断言', () => {
  const { rawBars, adjclose } = makeSplitScenario();
  const adj = adjustForward(rawBars, adjclose);

  // 不复权：第 3 根从 104 → 52，收益率约 -50%，是"假跳空"
  const rawGap = barReturn(rawBars[2].close, rawBars[3].close);
  assert.ok(rawGap !== null && rawGap < -0.49, `不复权应有约 -50% 的假跳空，实际 ${rawGap}`);

  // 复权后：52 → 52，收益率 ≈ 0，跳空消失
  const adjGap = barReturn(adj.bars[2].close, adj.bars[3].close);
  assert.ok(adjGap !== null && Math.abs(adjGap) < 1e-9, `复权后不应有跳空，实际 ${adjGap}`);

  // findLargestAdjustmentGap 应当精确定位到这一根（index 3）
  const gap = findLargestAdjustmentGap(rawBars, adj.bars);
  assert.notEqual(gap, null);
  if (!gap) return;
  assert.equal(gap.index, 3);
  assert.ok(gap.diff > 0.49, `差异应当很大，实际 ${gap.diff}`);
});

test('合成除权：因子随时间**不降**，且最新一根 ≈ 1（前复权方向）', () => {
  const { rawBars, adjclose } = makeSplitScenario();
  const adj = adjustForward(rawBars, adjclose);
  const { nonDecreasing, violations, lastFactor } = checkFactorDirection(adj.bars);

  assert.equal(nonDecreasing, true, `不应有方向违反，违反处：${violations}`);
  assert.ok(
    lastFactor !== null && Math.abs(lastFactor - 1) < 1e-12,
    `最新一根因子应为 1（前复权基准），实际 ${lastFactor}`,
  );
  // 除权前被缩小，除权后不调整
  assert.ok(Math.abs(/** @type {number} */ (adj.bars[0].factor) - 0.5) < 1e-12);
  assert.ok(Math.abs(/** @type {number} */ (adj.bars[5].factor) - 1) < 1e-12);
});

test('checkFactorDirection：能把"做成后复权"（方向反了）抓出来', () => {
  // 后复权特征：因子随时间递减
  const backwards = [
    withFactor(bar(100), 1.0),
    withFactor(bar(100), 0.8),
    withFactor(bar(100), 0.5),
  ];
  const { nonDecreasing, violations } = checkFactorDirection(backwards);
  assert.equal(nonDecreasing, false, '方向反了必须报警');
  assert.deepEqual(violations, [1, 2]);
});

test('checkFactorDirection：等值（无除权）视为合法，且不报违反', () => {
  const flat = [
    withFactor(bar(100), 1),
    withFactor(bar(100), 1),
    withFactor(bar(100), 1),
  ];
  const { nonDecreasing, violations, lastFactor } = checkFactorDirection(flat);
  assert.equal(nonDecreasing, true);
  assert.deepEqual(violations, []);
  assert.equal(lastFactor, 1);
});

test('checkFactorDirection：空数组不崩，lastFactor 为 null', () => {
  const r = checkFactorDirection([]);
  assert.equal(r.nonDecreasing, true);
  assert.equal(r.lastFactor, null);
});

// ---------------------------------------------------------------- 边界与降级

test('adjclose 缺失 → 降级为不复权，且给出 reason（不静默当复权用）', () => {
  const rawBars = [bar(100), bar(101)];
  const r = adjustForward(rawBars, undefined);
  assert.equal(r.adjusted, ADJUST_STATUS.NONE);
  assert.equal(r.degraded, true);
  assert.match(/** @type {string} */ (r.reason), /adjclose/);
  // 仍然返回可用（不复权的）bar，让上层能标注后继续
  assert.equal(r.bars.length, 2);
  assert.equal(r.bars[0].close, 100);
});

test('adjclose 长度不符 → 降级为不复权', () => {
  const rawBars = [bar(100), bar(101), bar(102)];
  const r = adjustForward(rawBars, [100, 101]);
  assert.equal(r.adjusted, ADJUST_STATUS.NONE);
  assert.equal(r.degraded, true);
  assert.match(/** @type {string} */ (r.reason), /长度不符/);
});

test('adjclose 里有 null → 降级为不复权（宁可不算，不给假数）', () => {
  const rawBars = [bar(100), bar(101), bar(102)];
  const r = adjustForward(rawBars, [100, null, 102]);
  assert.equal(r.adjusted, ADJUST_STATUS.NONE);
  assert.match(/** @type {string} */ (r.reason), /adjclose 不可用/);
});

test('adjclose 为 0 或负数 → 降级为不复权（不产生负价）', () => {
  for (const badVal of [0, -1]) {
    const r = adjustForward([bar(100), bar(101)], [100, badVal]);
    assert.equal(r.adjusted, ADJUST_STATUS.NONE, `adjclose=${badVal} 应降级`);
  }
});

test('close 为 0（停牌）→ 跳过该根，不产生 Infinity', () => {
  const rawBars = [bar(100), bar(0), bar(102)];
  const adjclose = [100, 0, 102];
  const r = adjustForward(rawBars, adjclose);
  assert.equal(r.adjusted, ADJUST_STATUS.FORWARD);
  assert.equal(r.skipped, 1);
  assert.equal(r.bars.length, 2);
  for (const b of r.bars) {
    assert.ok(Number.isFinite(b.close), '不应出现 Infinity/NaN');
  }
});

test('close 为 null/NaN → 跳过该根', () => {
  const rawBars = [bar(100), { ...bar(100), close: NaN }, { ...bar(100), close: /** @type {any} */ (null) }];
  const r = adjustForward(rawBars, [100, 100, 100]);
  assert.equal(r.skipped, 2);
  assert.equal(r.bars.length, 1);
});

test('跳过比例过高（>10%）→ 置 degraded 标记，让上层能察觉', () => {
  const rawBars = [bar(100), bar(0), bar(102), bar(103)];
  const r = adjustForward(rawBars, [100, 0, 102, 103]);
  assert.equal(r.skipped, 1);
  assert.equal(r.degraded, true, '1/4 = 25% > 10% 应标记 degraded');
});

test('全部不可用 → 返回空并说明原因', () => {
  const r = adjustForward([bar(0), bar(0)], [0, 0]);
  assert.equal(r.bars.length, 0);
  assert.equal(r.adjusted, ADJUST_STATUS.NONE);
  assert.match(/** @type {string} */ (r.reason), /没有任何一根/);
});

test('空输入不崩', () => {
  const r = adjustForward([], []);
  assert.equal(r.bars.length, 0);
  assert.equal(r.adjusted, ADJUST_STATUS.NONE);
});

// ---------------------------------------------------------------- 跨分支不变量

test('不变量：两条分支都满足 bars + skipped === 原始根数', () => {
  const raw = [
    { time: 1, open: 100, high: 101, low: 99, close: 100, volume: 5 },
    { time: 2, open: 0, high: 0, low: 0, close: 0, volume: 0 }, // 停牌
    { time: 3, open: 102, high: 103, low: 101, close: 102, volume: 6 },
  ];

  // forward 路径
  const fwd = adjustForward(raw, [100, 0, 102]);
  assert.equal(fwd.adjusted, ADJUST_STATUS.FORWARD);
  assert.equal(fwd.bars.length + fwd.skipped, raw.length);

  // none 路径（adjclose 缺失 / 长度不符）
  for (const adj of [undefined, [1, 2]]) {
    const deg = adjustForward(raw, adj);
    assert.equal(deg.adjusted, ADJUST_STATUS.NONE);
    assert.equal(
      deg.bars.length + deg.skipped,
      raw.length,
      '降级分支同样要满足该不变量',
    );
  }
});

test('不变量：adjusted 字段与 factor 的取值互相印证', () => {
  const raw = [bar(100), bar(101), bar(102)];

  // forward ⇒ 每根都有非 null factor
  const fwd = adjustForward(raw, [100, 101, 102]);
  assert.equal(fwd.adjusted, ADJUST_STATUS.FORWARD);
  assert.ok(
    fwd.bars.every((b) => b.factor !== null),
    'forward 分支不应有 null factor',
  );

  // none ⇒ 每根的 factor 都必须是 null（调用方靠 adjusted 字段判断，不能只看 factor）
  const deg = adjustForward(raw, undefined);
  assert.equal(deg.adjusted, ADJUST_STATUS.NONE);
  assert.ok(
    deg.bars.every((b) => b.factor === null),
    'none 分支不应有非 null factor',
  );
});

test('非数组输入不崩', () => {
  const r = adjustForward(/** @type {any} */ (null), /** @type {any} */ (null));
  assert.equal(r.bars.length, 0);
});

// ---------------------------------------------------------------- 辅助函数

test('isIdentityAdjustment：混合因子时为 false', () => {
  const mixed = [withFactor(bar(1), 1), withFactor(bar(1), 0.5)];
  assert.equal(isIdentityAdjustment(mixed), false);
});

test('isIdentityAdjustment：空数组为 false', () => {
  assert.equal(isIdentityAdjustment([]), false);
});

test('barReturn：正常 / 非法输入', () => {
  assert.ok(Math.abs(mustBeNumber(barReturn(100, 110), 'barReturn') - 0.1) < 1e-12);
  assert.equal(barReturn(0, 110), null);
  assert.equal(barReturn(NaN, 110), null);
});

test('findLargestAdjustmentGap：长度不一致时返回 null，不崩', () => {
  assert.equal(
    findLargestAdjustmentGap([bar(1)], [withFactor(bar(1), 1), withFactor(bar(2), 1)]),
    null,
  );
  assert.equal(findLargestAdjustmentGap([], []), null);
});
