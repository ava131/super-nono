/**
 * 复权因子换算 —— **只服务 Yahoo 备源路径**。
 *
 * 东财（主源）用 `fqt=1` **直接返回前复权 OHLC**，**跳过本模块**。
 * 所以本模块的存在是"双源"的**代价**，不是收益（见 SDD-market §5.1 开头说明）。
 *
 * ## 为什么必须换算
 *
 * Yahoo 的 chart 端点返回的是 **原始 OHLC** + **复权后的收盘价 `adjclose`**。
 * 均线与 MACD 需要**复权后的整根 K 线**；只调收盘价会让 K 线形态失真。
 *
 * ## 算法（逐根独立）
 *
 * ```
 * factor_i = adjclose_i / close_i
 * adj_X_i  = X_i × factor_i       // X ∈ {open, high, low, close}
 * ```
 *
 * 最新一根 `factor ≈ 1`，历史被等比缩小 → 这就是**前复权**
 * （最新价不变、历史价调整），正是技术分析要的口径。
 *
 * ## ⚠️ 基准日会移动（评审 B-3）
 *
 * 前复权以**最新一根为基准**，所以**每过一天全序列的历史价都会微调**。
 * 两个后果，调用方必须知道：
 *
 * 1. **缓存必须存原始数据**，不要存算好的复权价 —— 否则用户会拿两次对话的数字对照
 *    并发现不一致（SDD-market §5.4「缓存存什么」）。
 * 2. **MK13「分位可复现」只能是"同一天内可复现"**，跨天不同属正常。
 *
 * @typedef {{ time?: number, open: number, high: number, low: number, close: number, volume: number }} RawBar
 * @typedef {{ time: number | null, open: number, high: number, low: number, close: number, volume: number, factor: number | null }} AdjustedBar
 */

/** `adjust` 返回结果里的 `adjusted` 字段取值。 */
export const ADJUST_STATUS = Object.freeze({
  /** 用 adjclose 换算出前复权 OHLC */
  FORWARD: 'forward',
  /** 降级为不复权（adjclose 缺失/不可用），**必须在输出里标注** */
  NONE: 'none',
});

/**
 * 判断一个数是否可用于计算。
 *
 * 写成 **TS 类型谓词**（`v is number`），这样调用处 `if (!usable(x)) return;`
 * 之后的 `x` 会被收窄成 `number`，不必到处加断言。
 *
 * @param {unknown} v
 * @returns {v is number}
 */
function usable(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 把 Yahoo 的原始 OHLC + adjclose 换算成**前复权 OHLC**。
 *
 * **不做任何静默降级**：`adjclose` 缺失或不可用时，返回 `adjusted: 'none'`
 * 并给出 `reason`，调用方**必须在输出里标注**（不许把不复权当复权用）。
 *
 * ## 边界处理（SDD-market §5.1「必须处理的边界」）
 *
 * | 边界 | 处理 |
 * |---|---|
 * | `close_i` 为 0 / null（停牌） | **跳过该根**，不计入结果，并在 `skipped` 里记数 |
 * | 跳过比例过高 | 置 `degraded: true`（连续缺失过多时报错而不是猜） |
 * | `adjclose` 缺失 / 长度不符 | **降级为不复权** + `reason` |
 * | `factor` 非有限 / ≤ 0 | **降级为不复权** + `reason`（宁可不算，不给假数） |
 *
 * @param {RawBar[]} rawBars
 * @param {(number | null | undefined)[]} [adjclose] 与 rawBars 等长
 * @returns {{
 *   bars: AdjustedBar[],
 *   adjusted: 'forward' | 'none',
 *   reason: string | null,
 *   degraded: boolean,
 *   skipped: number
 * }}
 */
export function adjustForward(rawBars, adjclose) {
  const bars = Array.isArray(rawBars) ? rawBars : [];

  /** @type {AdjustedBar[]} */
  const rawOut = [];
  let skipped = 0;

  for (const b of bars) {
    const ok =
      b &&
      usable(b.close) &&
      b.close !== 0 &&
      usable(b.open) &&
      usable(b.high) &&
      usable(b.low);
    if (!ok) {
      skipped += 1;
      continue;
    }
    rawOut.push({
      time: usable(b.time) ? b.time : null,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: usable(b.volume) ? b.volume : 0,
      factor: null,
    });
  }

  // 无可用的复权数据 → 降级为不复权
  if (!Array.isArray(adjclose)) {
    return {
      bars: rawOut,
      adjusted: ADJUST_STATUS.NONE,
      reason: '接口未返回 adjclose（无法换算前复权）',
      degraded: true,
      skipped,
    };
  }
  if (adjclose.length !== bars.length) {
    return {
      bars: rawOut,
      adjusted: ADJUST_STATUS.NONE,
      reason: `adjclose 长度不符（${adjclose.length} ≠ ${bars.length}）`,
      degraded: true,
      skipped,
    };
  }

  /** @type {AdjustedBar[]} */
  const out = [];
  let idx = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const ok =
      b &&
      usable(b.close) &&
      b.close !== 0 &&
      usable(b.open) &&
      usable(b.high) &&
      usable(b.low);
    if (!ok) continue;

    const a = adjclose[i];
    if (!usable(a) || a <= 0) {
      return {
        bars: rawOut,
        adjusted: ADJUST_STATUS.NONE,
        reason: `第 ${i} 根 adjclose 不可用（${String(a)}），无法可靠换算`,
        degraded: true,
        skipped,
      };
    }

    const factor = a / b.close;
    if (!Number.isFinite(factor) || factor <= 0) {
      return {
        bars: rawOut,
        adjusted: ADJUST_STATUS.NONE,
        reason: `第 ${i} 根复权因子异常（${factor}）`,
        degraded: true,
        skipped,
      };
    }

    out.push({
      time: usable(b.time) ? b.time : null,
      open: b.open * factor,
      high: b.high * factor,
      low: b.low * factor,
      close: b.close * factor, // == adjclose_i（浮点意义下）
      volume: usable(b.volume) ? b.volume : 0,
      factor,
    });
    idx += 1;
  }

  if (out.length === 0) {
    return {
      bars: [],
      adjusted: ADJUST_STATUS.NONE,
      reason: '没有任何一根可用于换算的 K 线',
      degraded: true,
      skipped,
    };
  }

  // 跳过的比例过高 → 标记 degraded（连续缺失过多时不该装作正常）
  const degraded = skipped > 0 && skipped / bars.length > 0.1;

  return {
    bars: out,
    adjusted: ADJUST_STATUS.FORWARD,
    reason: null,
    degraded,
    skipped,
  };
}

/**
 * 该区间的复权是否"什么都没做"（`adjclose` 全程等于 `close`）。
 *
 * 全等是**正常**的：说明该标的在这段区间内**从未分红送转**（SDD §5.1 边界表）。
 * ⚠️ 但这意味着**这段 fixture 无法验证换算是否真的生效** —— 测试时要注意，
 * 真想验证换算就得用带除权点的数据。
 *
 * @param {AdjustedBar[]} bars
 * @returns {boolean}
 */
export function isIdentityAdjustment(bars) {
  if (!Array.isArray(bars) || bars.length === 0) return false;
  return bars.every((b) => b.factor === null || Math.abs(b.factor - 1) < 1e-12);
}

/**
 * 复权因子的方向检查。
 *
 * ## ⚠️ 方向容易写反（这里曾经写错过一次）
 *
 * 前复权以**最新一根为基准**，所以：
 *
 * - **最新一根**的 `factor ≈ 1`（不调整）
 * - **越旧**被缩得越多 → `factor` 越小
 *
 * 因此因子序列随时间应当是 **单调不降** 的（不是"不增"）。
 * 直觉上也对：除权把历史价缩小，事件发生后因子就抬到 1 并保持。
 *
 * ```
 * 例：10 送 10，除权日在第 4 根
 *   factor = [0.5, 0.5, 0.5, 1, 1, 1]      ← 不降（对的）
 *   factor = [1, 1, 1, 0.5, 0.5, 0.5]      ← 不增（算反了/后复权）
 * ```
 *
 * **"不增"意味着把口径做成了后复权**，那与技术分析要的口径相反 → 应当报警。
 *
 * ⚠️ 现实里有**浮点抖动**，所以用容差判断。
 *
 * @param {AdjustedBar[]} bars
 * @param {number} [tolerance]
 * @returns {{ nonDecreasing: boolean, violations: number[], lastFactor: number | null }}
 *          violations 为"因子比前一根小"的索引；lastFactor 供校验是否 ≈ 1
 */
export function checkFactorDirection(bars, tolerance = 1e-6) {
  /** @type {number[]} */
  const violations = [];
  if (!Array.isArray(bars) || bars.length === 0) {
    return { nonDecreasing: true, violations, lastFactor: null };
  }

  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].factor;
    const cur = bars[i].factor;
    if (prev === null || cur === null) continue;
    // 从旧到新，因子应当**不降**（允许容差）
    if (cur < prev - tolerance) violations.push(i);
  }

  const last = bars[bars.length - 1].factor;
  return {
    nonDecreasing: violations.length === 0,
    violations,
    lastFactor: typeof last === 'number' ? last : null,
  };
}

/**
 * 计算单根 bar 的**收益率**（用于验证复权是否抹平了除权跳空）。
 *
 * @param {number} prevClose
 * @param {number} close
 * @returns {number | null}
 */
export function barReturn(prevClose, close) {
  if (!usable(prevClose) || !usable(close) || prevClose === 0) return null;
  return close / prevClose - 1;
}

/**
 * 找出**复权前 / 复权后收益率差异最大**的那一根。
 *
 * ## 这是 MK3 的核心检查
 *
 * 除权除息那天，**不复权**的价格会跳空（出现一个假的大跌），
 * 而**前复权**会把历史价等比缩小，使跳空消失。
 *
 * 因此：**在真的发生了除权的区间上**，应当存在某一根，其
 * `|不复权收益率 − 复权收益率|` 明显大于 0。
 *
 * ⚠️ 反过来：如果整段区间**没有除权**，这个差值会全程 ≈ 0 —— 那是正常的，
 * **不能**据此判定"复权失效"。所以本函数返回差值，**判断留给调用方/测试**。
 *
 * @param {RawBar[]} rawBars 已过滤过的原始 bar（与 adjustedBars 一一对应）
 * @param {AdjustedBar[]} adjustedBars
 * @returns {{ index: number, rawReturn: number, adjustedReturn: number, diff: number } | null}
 *          差异最大的那一根；样本不足时 null
 */
export function findLargestAdjustmentGap(rawBars, adjustedBars) {
  if (
    !Array.isArray(rawBars) ||
    !Array.isArray(adjustedBars) ||
    rawBars.length !== adjustedBars.length ||
    rawBars.length < 2
  ) {
    return null;
  }

  let best = null;
  for (let i = 1; i < rawBars.length; i++) {
    const rawReturn = barReturn(rawBars[i - 1].close, rawBars[i].close);
    const adjustedReturn = barReturn(
      adjustedBars[i - 1].close,
      adjustedBars[i].close,
    );
    if (rawReturn === null || adjustedReturn === null) continue;
    const diff = Math.abs(rawReturn - adjustedReturn);
    if (best === null || diff > best.diff) {
      best = { index: i, rawReturn, adjustedReturn, diff };
    }
  }
  return best;
}
