/**
 * 行情指标计算 —— **纯函数，零依赖**。
 *
 * 设计约束（见 `docs/market/PRD-market-v0.md` §4 与 `docs/market/SDD-market-v0.md` §5.3）：
 *
 * 1. **口径必须与 A 股行情软件一致**，否则用户一对照就发现对不上（MK4 / MK5）。
 * 2. **参数写死**，不接受调用方传入 windows —— 含糊的参数会让同一个问题在不同
 *    时间得到不同答案，也让"解读"无法复现。
 * 3. **样本不足一律返回 `null`，绝不用短样本充数**（PRD §4 末段 / MK16）。
 * 4. 本模块**不认识任何股票、不碰网络、不碰存储** —— 输入是 OHLCV 数组，
 *    输出是数值。这是它最容易测、也最该被测死的原因。
 *
 * 所有函数返回的数值序列/最后一根的值都以**输入数组的最后一根**为"当前"。
 *
 * @typedef {{ open: number, high: number, low: number, close: number, volume: number }} Bar
 */

/** 参数冻结：改这里等于改验收口径，必须同步改文档。 */
export const PARAMS = Object.freeze({
  MA_WINDOWS: Object.freeze([5, 10, 20, 60, 250]),
  RSI_PERIOD: 14,
  MACD_FAST: 12,
  MACD_SLOW: 26,
  MACD_SIGNAL: 9,
  VOLUME_WINDOW: 20,
  /** 区间位置 / 分位 / 均线关系的最长回看窗口 */
  RANGE_WINDOW: 250,
  VOLATILITY_WINDOW: 20,
  /** A 股年化交易日数 */
  TRADING_DAYS_PER_YEAR: 252,
});

/**
 * 各指标**能算出来**的最小样本数（不足即返回 `null`）。
 *
 * ⚠️ 这与「**算出来是否可靠**」是**两件事** —— 见 `RELIABLE_SAMPLES`。
 * 混为一谈会造成文档与代码不一致：文档说"不足 60 根要标注不可靠"，
 * 而代码在 34 根就静默给出一个 MACD。
 */
export const MIN_SAMPLES = Object.freeze({
  RSI: PARAMS.RSI_PERIOD + 1, // 14 期涨跌幅需要 15 根
  MACD: PARAMS.MACD_SLOW + PARAMS.MACD_SIGNAL - 1, // 26 根暖机 + 9 根给 DEA
  VOLUME_RATIO: PARAMS.VOLUME_WINDOW + 1, // 20 日均量 + 当日
  RANGE: PARAMS.RANGE_WINDOW,
  VOLATILITY: PARAMS.VOLATILITY_WINDOW + 1, // 20 个收益率需要 21 根
});

/**
 * 各指标**结果可靠**的建议样本数（低于它仍会算，但必须**显式标注**）。
 *
 * ## 为什么要有这一档（文档一致性）
 *
 * `PRD-market` §4 的"最小样本"列给的是**建议样本**（MACD 60、MA 250…），
 * `SDD-market` §5.3 也写"`N < 60` → MACD 标注不可靠"。
 * 而**能算出来**的数学下限要低得多（MACD 34 根即可）。
 *
 * 两者都对，只是回答的问题不同：
 *
 * | 阈值 | 回答的问题 | 行为 |
 * |---|---|---|
 * | `MIN_SAMPLES` | 数学上够不够**算** | 不够 → **不输出**（`null`） |
 * | `RELIABLE_SAMPLES` | 算出来**可不可靠** | 不够 → **照常输出，但标注"相对不可靠"** |
 *
 * 这样既不假装"22 根也能给可信 MACD"，也不因为样本短就拒绝给任何信息 ——
 * 用户至少知道**它为什么不可靠**。
 */
export const RELIABLE_SAMPLES = Object.freeze({
  RSI: 60,
  MACD: 60,
  VOLUME_RATIO: 60,
  RANGE: 250,
  VOLATILITY: 60,
});

/**
 * 取出干净的收盘价序列（过滤掉 null / NaN / 非有限值）。
 * @param {Bar[]} bars
 * @returns {number[]}
 */
function closes(bars) {
  const out = [];
  for (const b of bars) {
    const c = b?.close;
    if (typeof c === 'number' && Number.isFinite(c)) out.push(c);
  }
  return out;
}

/**
 * 取出干净的成交量序列。
 * @param {Bar[]} bars
 * @returns {number[]}
 */
function volumes(bars) {
  const out = [];
  for (const b of bars) {
    const v = b?.volume;
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * 简单移动平均：返回**最后一根**的 SMA。
 *
 * 样本不足 `n` 时返回 `null`（不用短样本充数）。
 *
 * @param {number[]} values
 * @param {number} n
 * @returns {number | null}
 */
export function sma(values, n) {
  if (!Array.isArray(values) || !Number.isInteger(n) || n <= 0) return null;
  if (values.length < n) return null;
  const slice = values.slice(values.length - n);
  let sum = 0;
  for (const v of slice) {
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  return sum / n;
}

/**
 * 指数移动平均（整条序列）。
 *
 * **种子用前 `n` 项的 SMA** —— 与 TA-Lib / A 股行情软件一致。
 * 若用首值做种子，整条曲线会系统性偏移（SDD-market §5.3）。
 *
 * 返回数组与输入等长；前 `n - 1` 位为 `null`。
 *
 * @param {number[]} values
 * @param {number} n
 * @returns {(number | null)[]}
 */
export function emaSeries(values, n) {
  /** @type {(number | null)[]} */
  const out = new Array(values.length).fill(null);
  if (!Array.isArray(values) || !Number.isInteger(n) || n <= 0) return out;
  if (values.length < n) return out;

  const seed = sma(values.slice(0, n), n);
  if (seed === null) return out;
  out[n - 1] = seed;

  const alpha = 2 / (n + 1);
  for (let i = n; i < values.length; i++) {
    const prev = out[i - 1];
    const cur = values[i];
    if (prev === null || !Number.isFinite(cur)) continue;
    out[i] = alpha * cur + (1 - alpha) * prev;
  }
  return out;
}

/**
 * 取 EMA 序列的最后一个有效值。
 * @param {(number | null)[]} series
 * @returns {number | null}
 */
function lastOf(series) {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return series[i];
  }
  return null;
}

/**
 * RSI（**Wilder 平滑**，参数 14）。
 *
 * 口径（写死，见 PRD §4 / SDD §5.3）：
 * - 种子 = 前 14 期涨跌幅的**简单平均**；
 * - 之后 `avg = (prev × 13 + cur) / 14`；
 * - `RSI = 100 − 100 / (1 + RS)`，`RS = avgGain / avgLoss`；
 * - `avgLoss === 0` 时 RSI = 100。
 *
 * 样本不足 15 根返回 `null`。
 *
 * @param {number[]} values 收盘价序列
 * @param {number} [period]
 * @returns {number | null}
 */
export function rsi(values, period = PARAMS.RSI_PERIOD) {
  if (!Array.isArray(values) || values.length < period + 1) return null;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (!Number.isFinite(diff)) return null;
    if (diff >= 0) gainSum += diff;
    else lossSum += -diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (!Number.isFinite(diff)) return null;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * MACD（12 / 26 / 9）。
 *
 * 口径（写死）：
 * - `DIF = EMA12 − EMA26`
 * - `DEA = EMA9(DIF)`
 * - **柱 = 2 × (DIF − DEA)** ← A 股软件惯例，**必须乘 2**，否则与行情软件对不上（MK5）
 *
 * 样本不足 `26 + 9 − 1 = 34` 根返回 `null`。
 *
 * @param {number[]} values 收盘价序列
 * @returns {{ dif: number, dea: number, histogram: number } | null}
 */
export function macd(values) {
  const { MACD_FAST: fast, MACD_SLOW: slow, MACD_SIGNAL: signal } = PARAMS;
  if (!Array.isArray(values) || values.length < MIN_SAMPLES.MACD) return null;

  const emaFast = emaSeries(values, fast);
  const emaSlow = emaSeries(values, slow);

  // DIF 序列：从 slow-1 开始才有值
  /** @type {number[]} */
  const difValues = [];
  for (let i = 0; i < values.length; i++) {
    const f = emaFast[i];
    const s = emaSlow[i];
    if (f === null || s === null) continue;
    difValues.push(f - s);
  }
  if (difValues.length < signal) return null;

  const deaSeries = emaSeries(difValues, signal);
  const dif = difValues[difValues.length - 1];
  const dea = lastOf(deaSeries);
  if (dea === null || !Number.isFinite(dif)) return null;

  return { dif, dea, histogram: 2 * (dif - dea) };
}

/**
 * 量比：**当日成交量 ÷ 近 20 日均量（不含当日）**。
 *
 * 口径已按评审 B-4 与 PRD 统一为"不含当日"。
 * 样本不足 21 根返回 `null`。
 *
 * @param {number[]} vols 成交量序列
 * @param {number} [n]
 * @returns {number | null}
 */
export function volumeRatio(vols, n = PARAMS.VOLUME_WINDOW) {
  if (!Array.isArray(vols) || vols.length < n + 1) return null;
  const today = vols[vols.length - 1];
  const avg = sma(vols.slice(0, vols.length - 1), n);
  if (avg === null || !Number.isFinite(today) || avg === 0) return null;
  return today / avg;
}

/**
 * 区间位置：`(P − min) / (max − min) × 100%`，窗口 250 日。
 *
 * 直观含义："在最高最低之间哪个位置"。
 * 样本不足 250 根返回 `null`。
 *
 * @param {number[]} values 收盘价序列
 * @param {number} [n]
 * @returns {number | null} 0–100
 */
export function rangePosition(values, n = PARAMS.RANGE_WINDOW) {
  if (!Array.isArray(values) || values.length < n) return null;
  const win = values.slice(values.length - n);
  let min = Infinity;
  let max = -Infinity;
  for (const v of win) {
    if (!Number.isFinite(v)) return null;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max === min) return 50; // 全平的极端情况，避免除零
  return ((win[win.length - 1] - min) / (max - min)) * 100;
}

/**
 * 分位：`count(收盘 ≤ 当前价) / N × 100%`，窗口 250 日。
 *
 * ⚠️ **读法极易搞反**（评审 B-2）：它表达的是"**近一年只有这么多个百分比的
 * 交易日收盘价低于当前价**"。返回 12 意味着当前价**偏低**（只有 12% 的日子比现在低）。
 * 因此调用方**不允许只把百分数丢给用户**，必须附中文说明。
 *
 * 样本不足 250 根返回 `null`。
 *
 * @param {number[]} values 收盘价序列
 * @param {number} [n]
 * @returns {number | null} 0–100
 */
export function percentileRank(values, n = PARAMS.RANGE_WINDOW) {
  if (!Array.isArray(values) || values.length < n) return null;
  const win = values.slice(values.length - n);
  const current = win[win.length - 1];
  if (!Number.isFinite(current)) return null;
  let count = 0;
  for (const v of win) {
    if (!Number.isFinite(v)) return null;
    if (v <= current) count++;
  }
  return (count / win.length) * 100;
}

/**
 * 年化波动率：日收益率标准差 × √252，窗口 20 日。
 *
 * 样本不足 21 根返回 `null`。
 *
 * @param {number[]} values 收盘价序列
 * @param {number} [n]
 * @returns {number | null} 年化波动率（小数，如 0.32 表示 32%）
 */
export function volatility(values, n = PARAMS.VOLATILITY_WINDOW) {
  if (!Array.isArray(values) || values.length < n + 1) return null;
  const win = values.slice(values.length - (n + 1));
  /** @type {number[]} */
  const returns = [];
  for (let i = 1; i < win.length; i++) {
    const prev = win[i - 1];
    if (!Number.isFinite(prev) || prev === 0) return null;
    returns.push(win[i] / prev - 1);
  }
  if (returns.length < 2) return null;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(PARAMS.TRADING_DAYS_PER_YEAR);
}

/**
 * 价格与各均线的关系，以及**最近一次穿越发生在几根 bar 之前**。
 *
 * 样本不足 250 根时，仍返回能算出来的均线（短窗口），但 `daysSinceCross`
 * 为 `null` —— 宁可少给，不给假结论。
 *
 * @param {Bar[]} bars
 * @returns {{
 *   price: number,
 *   above: number[],
 *   below: number[],
 *   crosses: Record<string, number | null>
 * } | null}
 */
export function maRelation(bars) {
  const values = closes(bars);
  if (values.length < Math.min(...PARAMS.MA_WINDOWS)) return null;

  const price = values[values.length - 1];
  /** @type {number[]} */
  const above = [];
  /** @type {number[]} */
  const below = [];
  /** @type {Record<string, number | null>} */
  const crosses = {};

  for (const w of PARAMS.MA_WINDOWS) {
    const ma = sma(values, w);
    // 键必须始终存在：算不出也要显式给 null，不能留 undefined
    // （否则调用方 `crosses.ma60` 拿到 undefined，会与"没有穿越"混淆）
    crosses[`ma${w}`] = ma === null ? null : daysSinceCross(values, w);
    if (ma === null) continue;
    if (price > ma) above.push(w);
    else if (price < ma) below.push(w);
  }

  return { price, above, below, crosses };
}

/**
 * 最近一次**价格穿越某均线**发生在多少根 bar 之前。
 *
 * 约定：`0` = 当前这根刚穿（当前根与上一根分列均线两侧）。
 * 找不到穿越（或样本不足）返回 `null`。
 *
 * @param {number[]} values
 * @param {number} w 均线窗口
 * @returns {number | null}
 */
export function daysSinceCross(values, w) {
  if (!Array.isArray(values) || values.length < w + 1) return null;

  /** @type {(number | null)[]} */
  const maSeries = new Array(values.length).fill(null);
  for (let i = w - 1; i < values.length; i++) {
    maSeries[i] = sma(values.slice(0, i + 1), w);
  }

  for (let i = values.length - 1; i >= 1; i--) {
    const cur = values[i];
    const curMa = maSeries[i];
    const prev = values[i - 1];
    const prevMa = maSeries[i - 1];
    if (curMa === null || prevMa === null) continue;
    if (!Number.isFinite(cur) || !Number.isFinite(prev)) continue;

    const curAbove = cur > curMa;
    const prevAbove = prev > prevMa;
    if (curAbove !== prevAbove) return values.length - 1 - i;
  }
  return null;
}

/**
 * 一次性算出一份「状况说明书」所需的全部指标。
 *
 * 这是 `snapshot.js` 的唯一入口。**它不做任何判断、不写任何建议** ——
 * 只把数字摆出来（PRD §2.1 的事实层）。
 *
 * 各项独立降级：某项样本不足则该项为 `null`，**不影响其他项**。
 *
 * @param {Bar[]} bars
 * @returns {{
 *   samples: number,
 *   price: number | null,
 *   ma: Record<string, number | null>,
 *   rsi: number | null,
 *   macd: { dif: number, dea: number, histogram: number } | null,
 *   volumeRatio: number | null,
 *   rangePosition: number | null,
 *   percentile: number | null,
 *   volatility: number | null,
 *   relation: ReturnType<typeof maRelation>,
 *   insufficient: string[],
 *   unreliable: string[]
 * }}
 */
export function computeAll(bars) {
  const values = closes(bars);
  const vols = volumes(bars);
  const n = values.length;

  /** @type {Record<string, number | null>} */
  const ma = {};
  for (const w of PARAMS.MA_WINDOWS) ma[`ma${w}`] = sma(values, w);

  /** @type {string[]} */
  const insufficient = [];
  /** @type {string[]} 算得出来、但样本偏短 → 要有"相对不可靠"提示 */
  const unreliable = [];

  const result = {
    samples: n,
    price: n > 0 ? values[n - 1] : null,
    ma,
    rsi: rsi(values),
    macd: macd(values),
    volumeRatio: volumeRatio(vols),
    rangePosition: rangePosition(values),
    percentile: percentileRank(values),
    volatility: volatility(values),
    relation: maRelation(bars),
    insufficient,
    unreliable,
  };

  // 显式记录哪些项因样本不足而缺失（MK16：必须明说，不许装成完整结论）
  if (result.rsi === null) {
    result.insufficient.push(`RSI（需 ≥ ${MIN_SAMPLES.RSI} 根，当前 ${n} 根）`);
  }
  if (result.macd === null) {
    result.insufficient.push(`MACD（需 ≥ ${MIN_SAMPLES.MACD} 根，当前 ${n} 根）`);
  }
  if (result.rangePosition === null || result.percentile === null) {
    result.insufficient.push(
      `区间位置/分位（需 ≥ ${MIN_SAMPLES.RANGE} 根，当前 ${n} 根）`,
    );
  }
  if (result.volumeRatio === null) {
    result.insufficient.push(`量比（需 ≥ ${MIN_SAMPLES.VOLUME_RATIO} 根）`);
  }
  if (result.volatility === null) {
    result.insufficient.push(`波动率（需 ≥ ${MIN_SAMPLES.VOLATILITY} 根）`);
  }

  // 第二档：**算得出来但样本偏短** → 照常输出，但标注"相对不可靠"。
  // 不能因为"能算"就不提醒 —— PRD §4 与 SDD §5.3 都要求把"样本偏短"说出来。
  /** @type {Array<[string, boolean, number]>} */
  const reliabilityChecks = [
    ['RSI', result.rsi !== null, RELIABLE_SAMPLES.RSI],
    ['MACD', result.macd !== null, RELIABLE_SAMPLES.MACD],
    ['量比', result.volumeRatio !== null, RELIABLE_SAMPLES.VOLUME_RATIO],
    ['波动率', result.volatility !== null, RELIABLE_SAMPLES.VOLATILITY],
  ];
  for (const [label, computed, need] of reliabilityChecks) {
    if (computed && n < need) {
      result.unreliable.push(`${label}（建议 ≥ ${need} 根，当前 ${n} 根）`);
    }
  }

  return result;
}
