/**
 * K 线缓存（SDD-market §5.4）。
 *
 * ## 缓存规则（两条同时成立才算命中）
 *
 * 1. 距上次拉取 **< 6 小时**
 * 2. 缓存里**最后一根 K 线的日期** == 该标的"最近一个已收盘交易日"
 *
 * ## ⚠️ 缓存里必须存**原始数据**，不能存算好的复权价（评审 B-3）
 *
 * 前复权以**最新一根为基准**，所以每过一天，全序列的历史价都会微调。
 * 如果存复权后的结果，用户会拿两次对话的数字对照并发现不一致。
 * 因此缓存只存"接口原样返回的东西"，复权与指标**每次现算**。
 *
 * ## ⚠️ 缓存是**保护**，不是优化
 *
 * 实测教训：开发期约 160 次请求就把东财打硬封、Yahoo 也在 ~40 次触发 429。
 * 正常使用一天只有 20 次请求，余量很大；但**一个缓存 bug 就能在一分钟内打出上百次**。
 * 所以这里还提供 `countFetches()` 供上层做"出网次数自检"（PRD §12.1 第 5 条）。
 */

import * as LIMITS from '../../shared/limits.js';
import { silentLogger } from './log.js';

/** 时区固定为 A 股（UTC+8）。v0 只做 A 股，不需要多市场时区处理。 */
export const CN_OFFSET_SECONDS = 8 * 3600;

/** 缓存存活时间 */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** 收盘后的宽限期：15:00 收市，但当日 K 线通常 15:30–16:00 才稳定 */
export const POST_CLOSE_GRACE_MINUTES = 60;

/** 盘后数据"应当可用"的时刻（A 股 15:00 + 60 分钟 = 16:00） */
export const DATA_READY_HOUR = 16;

/**
 * 把 UTC 秒转成**交易所当地**的 `YYYY-MM-DD`。
 *
 * 直接 `new Date(ts*1000)` 取日期，在"机器时区 ≠ 交易所时区"时会**差一天**。
 *
 * @param {number} tsSeconds
 * @param {number} [offsetSeconds]
 * @returns {string | null}
 */
export function toCnDate(tsSeconds, offsetSeconds = CN_OFFSET_SECONDS) {
  if (!Number.isFinite(tsSeconds)) return null;
  const d = new Date((tsSeconds + offsetSeconds) * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 把当前时间换算成 A 股的"本地日历"。便于判断"今天"是哪天、是否已过盘后宽限期。
 *
 * @param {number} [nowMs]
 * @returns {{ date: string, hour: number, minute: number, weekday: number, dataReady: boolean }}
 *          `dataReady` = 是否已过盘后宽限期（16:00）
 */
export function cnTradingClock(nowMs = Date.now()) {
  const shifted = new Date(nowMs + CN_OFFSET_SECONDS * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  return {
    date: `${y}-${m}-${d}`,
    hour,
    minute,
    weekday: shifted.getUTCDay(), // 0=周日
    dataReady: hour >= DATA_READY_HOUR,
  };
}

/**
 * K 线缓存的键（格式与 SDD §5.4 一致）。
 *
 * ⚠️ 符号是大写的（`600519.SH`），所以 `store` 的 key 白名单必须允许大写 ——
 * 这一点在 `src/main/skills/store.js` 里有专门说明（曾经只允许小写，导致
 * 按文档写的键被自己的校验拒掉）。
 *
 * @param {string} source
 * @param {string} symbol
 * @param {string} range
 * @returns {string}
 */
export function cacheKey(source, symbol, range) {
  return `kline:${source}:${symbol}:${range}`;
}

/**
 * 进程内缓存（跨 `ctx.store` 的快速层）。
 *
 * 为什么还要内存层：`ctx.store` 每次技能调用都会新建实例并读 SQLite，
 * 而 `scan` 在一次调用里可能查 20 只 —— 内存层让"同一批次内不重复读库"。
 *
 * @type {Map<string, { at: number, source: string, payload: unknown }>}
 */
const memory = new Map();

/** 出网次数自检计数器（PRD §12.1 第 5 条） */
let fetchCount = 0;

/** 每次"技能调用"开始时重置计数器 */
export function resetFetchCount() {
  fetchCount = 0;
}

/** 本次调用已发起的真实网络请求数 */
export function countFetches() {
  return fetchCount;
}

/** 记一次真实出网（由编排层在确实发起请求时调用） */
export function noteFetch() {
  fetchCount += 1;
}

/**
 * 单次 `scan` 的请求数告警阈值。
 *
 * `scan` 最多 20 只，加上重试余量取 25。**超过就说明缓存没生效** ——
 * 这是发现缓存 bug 的唯一早期信号。
 */
export const FETCH_WARN_THRESHOLD = LIMITS.FETCH_WARN_THRESHOLD;

/**
 * 检查本次调用的出网次数是否异常。
 *
 * ⚠️ 这个告警是**发现缓存 bug 的唯一早期信号**（PRD §12.1 第 5 条）：
 * 正常 20 只/天有 8 倍余量，但一个缓存 bug 就能在一分钟内打出上百次请求，
 * 然后用户当天彻底查不到行情。所以它必须真的记进日志，不能被静默掉。
 *
 * @param {string} action
 * @param {{ warn: (e: string, d?: unknown) => void }} [logger]
 * @returns {boolean} 是否触发了告警
 */
export function checkFetchBudget(action, logger = silentLogger) {
  if (fetchCount > FETCH_WARN_THRESHOLD) {
    logger.warn('fetchBudgetExceeded', { action, fetchCount, threshold: FETCH_WARN_THRESHOLD });
    return true;
  }
  return false;
}

/** 清空内存缓存（单测用） */
export function clearMemoryCache() {
  memory.clear();
}

/**
 * 读缓存（内存 → `ctx.store`）。
 *
 * @param {any} store 技能 store（用其 `cache` 子 API）
 * @param {string} key
 * @param {number} [nowMs]
 * @returns {{ source: string, payload: any } | null} 未命中或已过期返回 null
 */
export function readCache(store, key, nowMs = Date.now()) {
  // ① 内存
  const hit = memory.get(key);
  if (hit && nowMs - hit.at < CACHE_TTL_MS) {
    return { source: hit.source, payload: hit.payload };
  }

  // ② 跨重启的持久层（走 cache 子 API —— 只读技能也能写自己的缓存）
  const persisted = store?.cache?.get?.(key) ?? store?.get?.(key);
  if (
    persisted &&
    typeof persisted === 'object' &&
    typeof persisted.at === 'number' &&
    nowMs - persisted.at < CACHE_TTL_MS
  ) {
    // 回填内存层，省掉同一批次内的重复读库
    memory.set(key, { at: persisted.at, source: persisted.source, payload: persisted.payload });
    return { source: persisted.source, payload: persisted.payload };
  }

  return null;
}

/**
 * 写缓存（两层都写）。
 *
 * ⚠️ 存的是**原始 payload**，不是复权后/算好的结果（评审 B-3）。
 *
 * @param {any} store
 * @param {string} key
 * @param {string} source
 * @param {unknown} payload
 * @param {{ warn: (e: string, d?: unknown) => void }} [logger]
 * @param {number} [nowMs]
 */
export function writeCache(store, key, source, payload, logger = silentLogger, nowMs = Date.now()) {
  memory.set(key, { at: nowMs, source, payload });
  try {
    const entry = { at: nowMs, source, payload };
    if (typeof store?.cache?.put === 'function') store.cache.put(key, entry);
    else store?.set?.(key, entry);
  } catch (err) {
    // 缓存写失败不该让整个查询失败 —— 它是"保护"，不是"功能"
    logger.warn('cacheWriteFailed', { key, message: String(err) });
  }
}

/**
 * 判断缓存是否**新鲜**：最后那根 K 线的日期 == 期望日期。
 *
 * 期望日期由调用方给出（对 Yahoo 路径就是"接口返回的最后一根"，
 * 因为 v0 **不判断节假日**，不自己推算交易日）。
 *
 * @param {{ bars: Array<{ time: number }> } | null | undefined} payload
 * @param {string | null} expectedDate
 * @param {number} [offsetSeconds]
 * @returns {boolean}
 */
export function cacheMatchesDate(payload, expectedDate, offsetSeconds = CN_OFFSET_SECONDS) {
  if (!expectedDate) return false;
  const bars = payload?.bars;
  if (!Array.isArray(bars) || bars.length === 0) return false;
  const last = bars[bars.length - 1];
  const d = toCnDate(last?.time, offsetSeconds);
  return d === expectedDate;
}
