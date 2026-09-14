/**
 * 数据源注册表 + 降级（SDD-market §5.6）。
 *
 * ## 主备顺序
 *
 * **东财优先（主源），Yahoo 兜底（备源）**（评审决定 1，依 PM"在国内用"）。
 *
 * ## ⚠️ 降级判据（补充记录 §5(a)，必须写进实现）
 *
 * 只画"顺序"是不够的，必须定义**什么时候算失败**，否则会出现一个隐蔽的正确性问题：
 *
 * > **同一次 `scan` 混用两个源。**
 * > 最坏情况：扫 20 只，第 7 只时东财偶发失败 → 切 Yahoo → 第 8–20 只来自 Yahoo。
 * > 于是**前 6 只用东财的前复权基准、后 14 只用 Yahoo 的基准，两组数值不可直接比较**
 * > —— 这正是 PRD §4 与 T-4 一直在防的事。
 *
 * 所以三条硬规定：
 *
 * 1. **首次数据请求失败 → 整体切换数据源**，不是每只单独降级
 * 2. **同一次工具调用内不换源** —— 一次 `scan` / `overview` 的结果全部来自同一个源
 * 3. 输出必须标注本次实际使用的源
 *
 * ## ⚠️「早失败」是性能硬要求（补充记录 §5(b)）
 *
 * 若每只票都等满超时才失败：`20 只 × 10s = 200 秒 ≫ scan 的 45s 超时`
 * → 超时会在扫到第 5 只时就触发，用户拿到一个残缺结果。
 * 所以**首次请求用短超时（2–3 秒）快速探活**，失败即整体切源。
 */
import { fetchYahooDaily } from './yahoo.js';
import { fetchEastmoneyDaily } from './eastmoney.js';
import { silentLogger } from '../log.js';

/** 首次探活的短超时：宁可 2 秒内换源，不要每只各等 10 秒然后整体超时 */
export const FETCH_TIMEOUT_FIRST_MS = 3000;

/** 确定源之后的正常请求超时 */
export const FETCH_TIMEOUT_MS = 10000;

/** 主备顺序（前面的先试） */
export const SOURCE_ORDER = Object.freeze(['eastmoney', 'yahoo']);

/**
 * @typedef {object} SourceAdapter
 * @property {string} name 用于缓存键与输出标注
 * @property {(symbol: string, deps: { safeFetch: any, timeoutMs: number }) => Promise<any>} fetchDaily
 * @property {boolean} adjustedAlready 该源是否**直接返回前复权**（东财 fqt=1 是；Yahoo 不是）
 * @property {boolean} available 该源是否已实现
 */

/** @type {Record<string, SourceAdapter>} */
export const SOURCES = Object.freeze({
  eastmoney: {
    name: 'eastmoney',
    fetchDaily: fetchEastmoneyDaily,
    adjustedAlready: true,
    // ✅ 2026-09-14 启用。真实响应已抓取并验证
    //    （test/fixtures/eastmoney-600519.SH.json，30 根茅台日线）：
    //    · 每行 6 字段，实测确证顺序 = 日期,开,收,高,低,量
    //    · 30 根全部满足 low ≤ open, close ≤ high
    //    · 最大单日涨跌 -3.64%（远小于 A 股 ±10% 涨跌停）
    //      → 确认 fqt=1 是**前复权**、无除权跳空
    available: true,
  },
  yahoo: {
    name: 'yahoo',
    fetchDaily: fetchYahooDaily,
    adjustedAlready: false,
    available: true,
  },
});

/**
 * 按主备顺序依次尝试，**成功即锁定该源**（不在后续请求中改换）。
 *
 * @param {string} symbol 内部符号 `<code>.<MARKET>`
 * @param {{ safeFetch: any, signal?: AbortSignal, logger?: { warn: (e: string, d?: unknown) => void } }} deps
 * @returns {Promise<{ ok: true, source: string, data: any, switched: boolean, attempts: Array<{source: string, code: string, message: string}> }
 *                 | { ok: false, code: string, message: string, attempts: Array<{source: string, code: string, message: string}> }>}
 */
export async function fetchWithFailover(symbol, deps) {
  /** @type {Array<{source: string, code: string, message: string}>} */
  const attempts = [];
  const logger = deps.logger ?? silentLogger;
  let isFirstAttempt = true;

  for (const name of SOURCE_ORDER) {
    const src = SOURCES[name];
    if (!src || !src.available) {
      attempts.push({
        source: name,
        code: 'UNAVAILABLE',
        message: `${name} 数据源当前未启用`,
      });
      continue;
    }

    if (deps.signal?.aborted) {
      return { ok: false, code: 'CANCELLED', message: '用户已停止。', attempts };
    }

    const timeoutMs = isFirstAttempt ? FETCH_TIMEOUT_FIRST_MS : FETCH_TIMEOUT_MS;
    isFirstAttempt = false;

    const res = await src.fetchDaily(symbol, {
      safeFetch: deps.safeFetch,
      timeoutMs,
    });

    if (res.ok) {
      return {
        ok: true,
        source: name,
        data: res,
        switched: attempts.length > 0,
        attempts,
      };
    }

    attempts.push({ source: name, code: res.code, message: res.message });
    logger.warn('sourceFailed', { source: name, symbol, code: res.code });

    // 用户主动取消时**不要**继续换源 —— 那不是"源失败"
    if (res.code === 'CANCELLED') {
      return { ok: false, code: 'CANCELLED', message: '用户已停止。', attempts };
    }
  }

  // 全部失败：措辞必须诚实 —— 区分"源被拒"与"这只股票不存在"
  const rejected = attempts.some((a) => a.code === 'NETWORK' || a.code === 'RATE_LIMIT');
  return {
    ok: false,
    code: rejected ? 'NETWORK' : 'NOT_FOUND',
    message: rejected
      ? '数据源暂时拒绝了请求，过会儿再试。'
      : '查不到这只股票。',
    attempts,
  };
}

/**
 * 该源是否需要我们自己换算复权。
 * @param {string} name
 * @returns {boolean}
 */
export function needsAdjustment(name) {
  return SOURCES[name]?.adjustedAlready === false;
}
