/**
 * 行情指标单测（`PRD-market-v0.md` §4 / `SDD-market-v0.md` §5.3 / §8.1）。
 *
 * ## 测试纪律
 *
 * **不硬编码任何"真实行情软件的精确数值"** —— 因为我们没有可核对的 fixture
 * （MK4 的对账需要在真实数据上做，SDD §8.2）。**伪造精确期望值等于给自己放假**。
 *
 * 这里只断言三类**可独立验证**的东西：
 *   1. **口径正确**：MACD 柱 = 2×(DIF−DEA)、RSI 边界、EMA 用 SMA 做种子…
 *   2. **数学恒等**：EMA(n) 对常数序列恒等于该常数、波动率可由定义独立复算…
 *   3. **样本不足 → null**：绝不用短样本充数（MK16）
 *
 * 覆盖的验收项：MK4（口径）、MK5（MACD 柱 ×2）、MK13（分位可复现）、MK16（样本不足）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  PARAMS,
  MIN_SAMPLES,
  RELIABLE_SAMPLES,
  sma,
  emaSeries,
  rsi,
  macd,
  volumeRatio,
  rangePosition,
  percentileRank,
  volatility,
  maRelation,
  daysSinceCross,
  computeAll,
} = await import('../../skills/market/indicators.js');

/**
 * 造一段收盘价序列。
 * @param {number} n 长度
 * @param {(i: number) => number} [fn] 第 i 根的收盘价，默认 100+i
 * @returns {number[]}
 */
function makeCloses(n, fn = (i) => 100 + i) {
  return Array.from({ length: n }, (_, i) => fn(i));
}

/**
 * 把收盘价数组包成 Bar 数组。
 * @param {number[]} closesArr
 * @param {number} [volume]
 * @returns {{open:number,high:number,low:number,close:number,volume:number}[]}
 */
function toBars(closesArr, volume = 1000) {
  return closesArr.map((c) => ({ open: c, high: c, low: c, close: c, volume }));
}

/**
 * 断言"不是 null"并**返回收窄后的值**。
 *
 * 为什么不用 `assert.notEqual(x, null)`：它不参与 TS 的类型收窄，
 * `strict` 下后续访问 `x.foo` 会报 TS18047。这里是测试，用显式收窄最干净。
 *
 * @template T
 * @param {T | null} value
 * @param {string} what
 * @returns {T}
 */
function mustNotBeNull(value, what) {
  assert.notEqual(value, null, `${what} 不应为 null`);
  assert.notEqual(value, undefined, `${what} 不应为 undefined`);
  return /** @type {T} */ (value);
}

/**
 * 断言 `value` 是有限数字并返回它（同样为了收窄）。
 * @param {number | null} value
 * @param {string} what
 * @returns {number}
 */
function mustBeNumber(value, what) {
  assert.equal(typeof value, 'number', `${what} 应为数字`);
  assert.ok(Number.isFinite(value), `${what} 应为有限数字，实际 ${value}`);
  return /** @type {number} */ (value);
}

/** 断言数组某位是有限数字并返回它。
 * @param {unknown[]} arr
 * @param {number} index
 * @param {string} what
 * @returns {number}
 */
function mustBeNumberAt(arr, index, what) {
  const v = arr[index];
  assert.equal(typeof v, 'number', `${what}[${index}] 应为数字`);
  return /** @type {number} */ (v);
}

// ---------------------------------------------------------------- SMA

test('SMA：样本不足返回 null，不用短样本充数', () => {
  assert.equal(sma([1, 2, 3], 5), null);
  assert.equal(sma([], 1), null);
  assert.equal(sma([1, 2, 3, 4, 5], 5), 3);
  assert.equal(sma([1, 2, 3, 4, 5, 6], 5), 4); // 只取最后 5 根
});

test('SMA：非法参数返回 null', () => {
  assert.equal(sma([1, 2, 3], 0), null);
  assert.equal(sma([1, 2, 3], -1), null);
  assert.equal(sma([1, 2, 3], 1.5), null);
});

// ---------------------------------------------------------------- EMA

test('EMA：种子用前 n 项的 SMA（与 A 股软件一致）', () => {
  const values = makeCloses(10, (i) => i + 1); // 1..10
  const series = emaSeries(values, 9);
  // 前 8 位必须是 null
  for (let i = 0; i < 8; i++) assert.equal(series[i], null);
  // 第 9 位（index 8）= 前 9 项 SMA = (1+..+9)/9 = 5
  assert.equal(series[8], 5);
  // 第 10 位（index 9）= α×10 + (1−α)×5，α = 2/10 = 0.2 → 6
  const lastEma = mustBeNumberAt(series, 9, 'series');
  assert.ok(Math.abs(lastEma - 6) < 1e-12, `期望 6，实际 ${lastEma}`);
});

test('EMA：对常数序列恒等于该常数', () => {
  const values = makeCloses(50, () => 42);
  const series = emaSeries(values, 12);
  const last = mustBeNumberAt(series, series.length - 1, 'series');
  assert.ok(Math.abs(last - 42) < 1e-9);
});

test('EMA：样本不足时整条为 null', () => {
  const series = emaSeries([1, 2, 3], 12);
  assert.equal(series.length, 3);
  assert.ok(series.every((v) => v === null));
});

// ---------------------------------------------------------------- RSI

test('RSI：14 期全涨 → 100（avgLoss = 0 的分支）', () => {
  const values = makeCloses(15, (i) => 100 + i);
  assert.equal(rsi(values), 100);
});

test('RSI：14 期全跌 → 0', () => {
  const values = makeCloses(15, (i) => 100 - i);
  assert.equal(rsi(values), 0);
});

test('RSI：样本不足 15 根返回 null（MK16）', () => {
  assert.equal(rsi(makeCloses(14)), null);
  assert.notEqual(rsi(makeCloses(15, (i) => 100 + i)), null);
});

test('RSI：Wilder 平滑 —— 用独立实现复算并逐位比对', () => {
  // 一段有涨有跌的确定性序列
  const values = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89,
    46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64, 46.21,
  ];
  const period = 14;

  // 独立复算（直接照 PRD §4 的公式写，与被测实现无共享代码）
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gainSum += d;
    else lossSum += -d;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  const expected = 100 - 100 / (1 + avgGain / avgLoss);

  const actual = mustBeNumber(rsi(values), 'rsi');
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `期望 ${expected}，实际 ${actual}`,
  );
  // 这段数据涨多跌少，RSI 应显著高于 50
  assert.ok(actual > 50, `期望 > 50，实际 ${actual}`);
});

// ---------------------------------------------------------------- MACD

test('MACD：柱必须等于 2 × (DIF − DEA)（MK5）', () => {
  const values = makeCloses(120, (i) => 100 + Math.sin(i / 5) * 10 + i * 0.2);
  const m = mustNotBeNull(macd(values), 'macd');
  assert.ok(
    Math.abs(m.histogram - 2 * (m.dif - m.dea)) < 1e-12,
    `柱应等于 2×(DIF−DEA)，实际 ${m.histogram} vs ${2 * (m.dif - m.dea)}`,
  );
});

test('MACD：DIF 必须等于 EMA12 − EMA26（种子为 SMA）', () => {
  const values = makeCloses(120, (i) => 100 + Math.sin(i / 7) * 8);
  const m = mustNotBeNull(macd(values), 'macd');

  const emaFast = emaSeries(values, PARAMS.MACD_FAST);
  const emaSlow = emaSeries(values, PARAMS.MACD_SLOW);
  const last = values.length - 1;
  const expectedDif =
    mustBeNumberAt(emaFast, last, 'emaFast') -
    mustBeNumberAt(emaSlow, last, 'emaSlow');

  assert.ok(
    Math.abs(m.dif - expectedDif) < 1e-9,
    `期望 DIF ${expectedDif}，实际 ${m.dif}`,
  );
});

test('MACD：样本不足 34 根返回 null（MK16）', () => {
  assert.equal(macd(makeCloses(MIN_SAMPLES.MACD - 1)), null);
  assert.notEqual(macd(makeCloses(MIN_SAMPLES.MACD)), null);
});

test('MACD：常数序列 → DIF/柱 收敛到 0', () => {
  const m = mustNotBeNull(macd(makeCloses(200, () => 50)), 'macd');
  assert.ok(Math.abs(m.dif) < 1e-9, `DIF 期望 ≈0，实际 ${m.dif}`);
  assert.ok(Math.abs(m.histogram) < 1e-9, `柱 期望 ≈0，实际 ${m.histogram}`);
});

// ---------------------------------------------------------------- 量比

test('量比：分母用近 20 日均量，且**不含当日**（评审 B-4）', () => {
  const vols = [...Array.from({ length: 20 }, () => 100), 150];
  // 近 20 日均量 = 100（前 20 根），当日 = 150 → 量比 1.5
  const r = mustBeNumber(volumeRatio(vols), 'volumeRatio');
  assert.ok(Math.abs(r - 1.5) < 1e-12, `期望 1.5，实际 ${r}`);
});

test('量比：样本不足 21 根返回 null', () => {
  assert.equal(volumeRatio(Array.from({ length: 20 }, () => 100)), null);
});

test('量比：均量为 0 时返回 null（不除零）', () => {
  const vols = [...Array.from({ length: 20 }, () => 0), 100];
  assert.equal(volumeRatio(vols), null);
});

// ---------------------------------------------------------------- 区间位置 / 分位

test('区间位置：单调递增序列 → 100%', () => {
  const values = makeCloses(250, (i) => 100 + i);
  const r = mustBeNumber(rangePosition(values), 'rangePosition');
  assert.ok(Math.abs(r - 100) < 1e-9);
});

test('区间位置：单调递减序列 → 0%', () => {
  const values = makeCloses(250, (i) => 100 + (250 - i));
  const r = mustBeNumber(rangePosition(values), 'rangePosition');
  assert.ok(Math.abs(r) < 1e-9);
});

test('区间位置：(P−min)/(max−min) 精确成立', () => {
  const values = makeCloses(250, (i) => 100 + i);
  values[values.length - 1] = 200; // min=100, max=249（原末位），现价 200
  const win = values.slice(-250);
  const min = Math.min(...win);
  const max = Math.max(...win);
  const expected = ((200 - min) / (max - min)) * 100;
  const r = mustBeNumber(rangePosition(values), 'rangePosition');
  assert.ok(Math.abs(r - expected) < 1e-9);
});

test('区间位置：样本不足 250 根返回 null（MK16）', () => {
  assert.equal(rangePosition(makeCloses(249)), null);
});

test('分位：单调递增序列 → 100%（当前价即最高）', () => {
  const values = makeCloses(250, (i) => 100 + i);
  const r = mustBeNumber(percentileRank(values), 'percentileRank');
  assert.ok(Math.abs(r - 100) < 1e-9);
});

test('分位：单调递减序列 → 1/250（只有自己 ≤ 自己）', () => {
  const values = makeCloses(250, (i) => 100 + (250 - i));
  const r = mustBeNumber(percentileRank(values), 'percentileRank');
  assert.ok(Math.abs(r - (1 / 250) * 100) < 1e-9, `期望 0.4，实际 ${r}`);
});

test('分位：可复现 —— 同一份数据两次调用结果完全一致（MK13）', () => {
  const values = makeCloses(300, (i) => 100 + Math.sin(i / 3) * 20);
  assert.equal(percentileRank(values), percentileRank(values));
});

test('分位：样本不足 250 根返回 null（MK16）', () => {
  assert.equal(percentileRank(makeCloses(249)), null);
});

// ---------------------------------------------------------------- 波动率

test('波动率：每日恒定收益率 → 标准差为 0', () => {
  const values = makeCloses(21, (i) => 100 * 1.01 ** i);
  const v = mustBeNumber(volatility(values), 'volatility');
  assert.ok(Math.abs(v) < 1e-9, `期望 ≈0，实际 ${v}`);
});

test('波动率：可由定义独立复算（年化 = 日标准差 × √252）', () => {
  // 构造一段收益率确定的序列
  const values = [100];
  const rets = [
    0.01, -0.02, 0.015, 0.0, 0.01, -0.005, 0.02, 0.01, -0.015, 0.0, 0.005, 0.01,
    -0.01, 0.02, 0.0, 0.015, -0.005, 0.01, 0.0, 0.01,
  ];
  for (const r of rets) values.push(values[values.length - 1] * (1 + r));

  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const expected = Math.sqrt(variance) * Math.sqrt(252);

  const actual = mustBeNumber(volatility(values), 'volatility');
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `期望 ${expected}，实际 ${actual}`,
  );
});

test('波动率：样本不足 21 根返回 null（MK16）', () => {
  assert.equal(volatility(makeCloses(20)), null);
});

// ---------------------------------------------------------------- 均线关系

test('均线关系：价格在全部均线之上时，above 含全部窗口', () => {
  const bars = toBars(makeCloses(300, (i) => 100 + i));
  const rel = mustNotBeNull(maRelation(bars), 'maRelation');
  assert.deepEqual(rel.above, [...PARAMS.MA_WINDOWS]);
  assert.deepEqual(rel.below, []);
});

test('均线关系：样本不足最长窗口时，短均线仍照常给出', () => {
  const bars = toBars(makeCloses(30, (i) => 100 + i));
  const rel = mustNotBeNull(maRelation(bars), 'maRelation');
  // 30 根只够算 ma5 / ma10 / ma20
  assert.deepEqual(rel.above, [5, 10, 20]);
  // 键必须存在且为 null（不能是 undefined）
  assert.ok('ma60' in rel.crosses);
  assert.equal(rel.crosses.ma60, null);
  assert.ok('ma250' in rel.crosses);
  assert.equal(rel.crosses.ma250, null);
});

test('daysSinceCross：刚跌破 → 0；跌破 5 根前 → 5', () => {
  // 20 根先平后涨再跌，制造一次明确的上穿与下穿
  const values = [
    100, 100, 100, 100, 100, 100, 100, 100, 100, 100, // 持平
    110, 120, 130, 140, // 拉起 → 站上 ma5
    120, 110, 100, 90, 80, 70, // 回落 → 跌破 ma5
  ];
  const d = mustBeNumber(daysSinceCross(values, 5), 'daysSinceCross');
  assert.ok(d >= 0 && d < values.length, `穿越天数应在范围内，实际 ${d}`);
});

test('daysSinceCross：从未穿越 → null', () => {
  const values = makeCloses(50, () => 100); // 全程持平，恒等于均线
  assert.equal(daysSinceCross(values, 5), null);
});

// ---------------------------------------------------------------- computeAll

test('computeAll：样本不足时逐项降级，且 insufficient 明说缺什么（MK16）', () => {
  const bars = toBars(makeCloses(30, (i) => 100 + i));
  const r = computeAll(bars);

  assert.equal(r.samples, 30);
  assert.notEqual(r.ma.ma5, null); // 短的还算得出
  assert.notEqual(r.rsi, null); // 15 根就够
  assert.notEqual(r.volatility, null); // 21 根就够
  assert.notEqual(r.volumeRatio, null); // 21 根就够
  assert.equal(r.macd, null); // 需 34 根
  assert.equal(r.rangePosition, null); // 需 250 根
  assert.equal(r.percentile, null); // 需 250 根

  // insufficient 必须逐条列明原因，不许静默
  assert.ok(r.insufficient.some((s) => s.includes('MACD')));
  assert.ok(r.insufficient.some((s) => s.includes('区间位置')));
});

test('computeAll：样本充足时所有项都有值，insufficient 为空', () => {
  const bars = toBars(
    makeCloses(300, (i) => 100 + Math.sin(i / 11) * 15 + i * 0.1),
  );
  const r = computeAll(bars);

  assert.equal(r.samples, 300);
  assert.equal(r.insufficient.length, 0);
  assert.notEqual(r.rsi, null);
  assert.notEqual(r.macd, null);
  assert.notEqual(r.rangePosition, null);
  assert.notEqual(r.percentile, null);
  assert.notEqual(r.volatility, null);
  assert.notEqual(r.volumeRatio, null);
  assert.equal(r.ma.ma250 !== null, true);
  assert.notEqual(r.relation, null);
});

test('computeAll：空输入不崩溃', () => {
  const r = computeAll([]);
  assert.equal(r.samples, 0);
  assert.equal(r.price, null);
  assert.equal(r.rsi, null);
  assert.equal(r.macd, null);
  assert.equal(r.relation, null);
  assert.ok(r.insufficient.length > 0);
});

test('computeAll：含 null 的 bar 被跳过，不污染计算', () => {
  const closesArr = makeCloses(300, (i) => 100 + i);
  const bars = toBars(closesArr);
  bars[10] = { open: 0, high: 0, low: 0, close: NaN, volume: NaN };

  const r = computeAll(bars);
  assert.equal(r.samples, 299); // NaN 那根被剔除
  assert.notEqual(r.rsi, null);
});

// ---------------------------------------------------------------- 两档样本阈值（文档一致性）

test('MIN_SAMPLES 与 RELIABLE_SAMPLES 都必须存在，且后者不小于前者', () => {
  const min = /** @type {Record<string, number>} */ (MIN_SAMPLES);
  const rel = /** @type {Record<string, number>} */ (RELIABLE_SAMPLES);
  for (const key of Object.keys(min)) {
    assert.ok(rel[key] !== undefined, `${key} 缺少"建议样本"阈值`);
    assert.ok(
      rel[key] >= min[key],
      `${key}: 建议样本(${rel[key]}) 不该小于可算下限(${min[key]})`,
    );
  }
});

test('🔴 MACD 的建议样本是 60（与 PRD-market §4 / SDD §5.3 的"不足 60 标注不可靠"对齐）', () => {
  assert.equal(RELIABLE_SAMPLES.MACD, 60);
  assert.equal(MIN_SAMPLES.MACD, 34, '数学下限仍是 34（26 暖机 + 9 DEA）');
  assert.ok(RELIABLE_SAMPLES.MACD > MIN_SAMPLES.MACD, '两档必须不同，否则"标注不可靠"永远触发不了');
});

test('🔴 40 根时：MACD **算得出来**，但必须被标为"相对不可靠"', () => {
  // 这是修复前的漏洞：文档说 <60 要标注，而代码从不标注
  const bars = toBars(makeCloses(40, (i) => 100 + Math.sin(i / 5) * 8 + i * 0.3));
  const r = computeAll(bars);

  assert.notEqual(r.macd, null, '34 根以上应当能算出 MACD');
  assert.ok(
    !r.insufficient.some((x) => x.includes('MACD')),
    'MACD 不该出现在"样本不足"里（它算出来了）',
  );
  assert.ok(
    r.unreliable.some((x) => x.includes('MACD')),
    `MACD 必须出现在"相对不可靠"里，实际 unreliable=${JSON.stringify(r.unreliable)}`,
  );
});

test('🔴 样本充足时，"相对不可靠"必须为空（不能无差别报警）', () => {
  const bars = toBars(makeCloses(300, (i) => 100 + Math.sin(i / 11) * 15 + i * 0.1));
  const r = computeAll(bars);
  assert.deepEqual(r.unreliable, [], '300 根时不该有任何"样本偏短"提示');
});

test('两档互斥且完整：每个算不出来的项在 insufficient，每个偏短的项在 unreliable', () => {
  const bars = toBars(makeCloses(40, (i) => 100 + Math.sin(i / 5) * 8 + i * 0.3));
  const r = computeAll(bars);

  // 40 根：MACD 可算(34) 但偏短(60)；分位算不出(250)；RSI/量比/波动率可算但偏短
  const insuff = r.insufficient.join(' ');
  const unrel = r.unreliable.join(' ');
  assert.match(insuff, /区间位置\/分位/, '分位不足 250 → 必须在 insufficient');
  assert.doesNotMatch(insuff, /MACD/, 'MACD 算得出 → 不该在 insufficient');
  assert.match(unrel, /MACD/, 'MACD 偏短 → 必须在 unreliable');
  assert.doesNotMatch(unrel, /分位/, '分位根本没算出来 → 不该在 unreliable');
});

test('computeAll 的 unreliable 在样本极少时也不崩（全 null）', () => {
  const r = computeAll(toBars(makeCloses(5, () => 100)));
  assert.ok(Array.isArray(r.unreliable));
  assert.deepEqual(r.unreliable, [], '全都算不出来时，"偏短"这一档没有意义，应为空');
});
