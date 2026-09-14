/**
 * 行情技能入口（PRD-market §6 / SDD-market §4.3）。
 *
 * ## 职责边界
 *
 * 本文件只做**分发、降级编排、缓存、限流**。具体算法在别处：
 *   - 取数与解析 → `sources/`
 *   - Yahoo 路径的复权换算 → `adjust.js`
 *   - 指标计算 → `indicators.js`
 *   - summary 渲染 → `snapshot.js`
 *   - 缓存与限流 → `cache.js`
 *
 * ## ⚠️ 数字必须全部来自本模块（PRD §2.1 / WX-2 的同类约束）
 *
 * 模型**只负责把数字翻译成人话**，不得自行编造或"估算"任何数值。
 * 这是本功能最重要的一条：一段编造的行情数字比"查不到"有害得多。
 */
import * as LIMITS from '../../shared/limits.js';
import { adjustForward, ADJUST_STATUS } from './adjust.js';
import {
  cacheKey,
  cacheMatchesDate,
  clearMemoryCache,
  countFetches,
  checkFetchBudget,
  readCache,
  resetFetchCount,
  toCnDate,
  writeCache,
} from './cache.js';
import { computeAll } from './indicators.js';
import { createLogger, silentLogger } from './log.js';
import { quoteIdToSymbol, searchSymbol } from './search.js';
import { renderOverview, renderScanSummary } from './snapshot.js';
import { resolveSymbol } from './symbols.js';
import { fetchWithFailover, needsAdjustment } from './sources/index.js';

/** 默认拉取范围：约 2 年（PRD §4「数据量要求」） */
export const DEFAULT_RANGE = '2y';

/** 相邻请求的最小间隔（评审 A-2：东财按源 IP 限流，200ms 偏激进） */
export const MIN_REQUEST_INTERVAL_MS = 500;

/**
 * 自选股上限 —— 与 `watchlist` 技能**共用同一个定义**（`shared/limits.js`）。
 *
 * ⚠️ 不一致的后果：能加 30 支但 `scan` 只接受 20 → 用户加了却扫不了。
 */
export const WATCHLIST_LIMIT = LIMITS.WATCHLIST_LIMIT;

/** @type {number} 上次真实出网的时间戳，用于串行节流 */
let lastRequestAt = 0;

/** 便于单测：重置节流与内存缓存 */
export function resetRuntimeState() {
  lastRequestAt = 0;
  clearMemoryCache();
  resetFetchCount();
}

/**
 * 串行节流：确保相邻真实请求间隔 ≥ `MIN_REQUEST_INTERVAL_MS`。
 * @param {number} [nowMs]
 * @returns {Promise<void>}
 */
export async function throttle(nowMs = Date.now()) {
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - nowMs;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

/**
 * 抛取消错误 —— 与 TIMEOUT 区分（MK19）。
 *
 * ⚠️ 用 `CANCELLED` 而不是 `TIMEOUT`：否则用户点「停止」会看到"超时"文案。
 * @returns {never}
 */
function throwCancelled() {
  const err = new Error('用户已停止。');
  err.name = 'AbortError';
  throw err;
}

/**
 * 把原始 bar 转成"用于计算指标的 bar"。
 *
 * 东财路径直接用；Yahoo 路径需要换算前复权（评审 B-3：缓存只存原始数据，
 * 所以复权**每次现算**，不缓存结果）。
 *
 * @param {string} source
 * @param {any} payload
 * @returns {{ bars: any[], adjusted: string, note: string | null }}
 */
export function prepareBars(source, payload) {
  if (!needsAdjustment(source)) {
    return { bars: payload.bars, adjusted: ADJUST_STATUS.FORWARD, note: null };
  }
  const adj = adjustForward(payload.bars, payload.adjclose);
  if (adj.adjusted === ADJUST_STATUS.FORWARD) {
    return { bars: adj.bars, adjusted: ADJUST_STATUS.FORWARD, note: null };
  }
  // 降级为不复权 —— **必须让用户知道**，不许静默当复权用
  return {
    bars: adj.bars,
    adjusted: ADJUST_STATUS.NONE,
    note: `复权数据不可用（${adj.reason}），以下为不复权价格`,
  };
}

/**
 * 取一只股票的日线（缓存优先）。
 *
 * @param {{ symbol: string, deps: any, store: any, logger?: { warn: (e: string, d?: unknown) => void }, range?: string }} p
 * @returns {Promise<{ ok: true, source: string, payload: any, fromCache: boolean, dataDate: string | null }
 *                 | { ok: false, code: string, message: string }>}
 */
async function loadDaily({ symbol, deps, store, logger = silentLogger, range = DEFAULT_RANGE }) {
  // ① 缓存：先看任一源有没有新鲜的
  for (const source of ['eastmoney', 'yahoo']) {
    const key = cacheKey(source, symbol, range);
    const hit = readCache(store, key);
    if (!hit) continue;
    // 命中条件②：最后一根 K 线的日期 == 该标的最近一个已收盘交易日。
    // v0 不判断节假日，用"缓存自己最后一根"作为期望日期 → 只要 TTL 未过就算新鲜。
    // 之所以还要这一层：防止缓存里存的是**很短的历史**（例如中途换过 range）。
    const last = hit.payload?.bars?.[hit.payload.bars.length - 1];
    const date = toCnDate(last?.time);
    if (date && cacheMatchesDate(hit.payload, date)) {
      return { ok: true, source: hit.source, payload: hit.payload, fromCache: true, dataDate: date };
    }
  }

  // ② 未命中 → 出网（主备降级 + 串行节流）
  await throttle();
  if (deps.signal?.aborted) throwCancelled();

  const res = await fetchWithFailover(symbol, { ...deps, logger });
  if (!res.ok) {
    if (res.code === 'CANCELLED') throwCancelled();
    return { ok: false, code: res.code, message: res.message };
  }

  const payload = {
    bars: res.data.bars,
    adjclose: res.data.adjclose ?? null,
    meta: res.data.meta ?? null,
    gmtoffset: res.data.gmtoffset ?? null,
  };
  const lastBar = payload.bars[payload.bars.length - 1];
  const dataDate = toCnDate(lastBar?.time);

  // ⚠️ 存**原始** payload，不存复权后结果（评审 B-3）
  writeCache(store, cacheKey(res.source, symbol, range), res.source, payload, logger);

  return { ok: true, source: res.source, payload, fromCache: false, dataDate };
}

/**
 * 组装单只股票的完整指标视图。
 *
 * @param {{ name: string, code: string, source: string, bars: any[], dataDate: string | null, adjustedNote: string | null }} p
 * @returns {ReturnType<typeof computeAll> & { prevClose: number | null }}
 */
function buildView({ bars, ...rest }) {
  const computed = computeAll(bars);
  const prevClose = bars.length >= 2 ? bars[bars.length - 2].close : null;
  return { ...computed, prevClose, ...rest };
}

/**
 * `overview` / `quote` 共用：解析符号 → 取数 → 计算 → 渲染。
 *
 * @param {string} rawSymbol
 * @param {any} ctx
 * @param {{ brief: boolean }} opts
 * @returns {Promise<{ ok: true, summary: string, data: unknown } | { ok: false, code: string, message: string }>}
 */
async function singleStock(rawSymbol, ctx, { brief }) {
  const store = ctx?.store;
  const logger = createLogger(ctx);
  if (!store) {
    return { ok: false, code: 'INTERNAL', message: '缺少 ctx.store，无法读写缓存。' };
  }

  // 符号解析：本地表优先（自选股 + 内置种子表）。
  // 自选股名单由 runner 注入 ctx.watchlistItems（跨技能只读，见 store.js）。
  const local = Array.isArray(ctx?.watchlistItems) ? ctx.watchlistItems : [];
  let resolved = resolveSymbol(rawSymbol, { localEntries: local });

  // 本地表没有 → **联网兜底**（东财搜索）。
  //
  // 为什么必须有这一步：内置表刻意只收主要指数与各行业龙头，
  // 所以新上市的（宇树科技）、ETF、小众个股必然查不到。
  // 没有它，用户就只能背代码 —— 而这正是不该要求用户做的事（PRD §3.3）。
  if (!resolved.ok && resolved.reason === 'needs-network') {
    const found = await searchSymbol(rawSymbol, ctx);
    if (found.ok && found.hits.length > 0) {
      /** @type {Array<{symbol: string, code: string, market: 'SH'|'SZ', kind: 'stock'|'fund', name: string}>} */
      const asEntries = [];
      for (const h of found.hits) {
        const sym = quoteIdToSymbol(h.secid);
        if (!sym) continue;
        asEntries.push({
          symbol: sym.symbol,
          code: h.code,
          market: h.market,
          kind: /** @type {'stock'|'fund'} */ (h.code[0] === '5' || h.code[0] === '1' ? 'fund' : 'stock'),
          name: h.name,
        });
      }

      // ① 先用**同一套精确匹配**再解析一次（处理"搜到的名字与输入完全一致"）
      const retry = resolveSymbol(rawSymbol, { localEntries: asEntries });
      if (retry.ok) {
        resolved = retry;
      } else {
        // ② 精确匹配不上时，判断"搜索是不是已经足够确定"。
        //
        // ## 为什么需要这一步（真实场景）
        //
        // 用户说「宇树科技」，东财返回 **`宇树科技-W`** —— 名字多一个 `-W` 后缀，
        // 精确匹配不上。但**搜索结果只有这一条，且名字包含用户输入**，
        // 这时再问一句"你是说宇树科技-W吗？"纯属多余，体验很差。
        //
        // 判据刻意保守，**三条必须同时成立**：
        //   · 只搜到 1 条
        //   · 它的名字**包含**用户输入（不是反过来，也不是毫不相干）
        //   · 输入本身有 2 个字以上（单字太容易误命中）
        // 任一不满足就仍然让人选 —— "不许猜"这条底线不放。
        const q = rawSymbol.trim();
        const only = asEntries.length === 1 ? asEntries[0] : null;
        if (only && q.length >= 2 && only.name.includes(q)) {
          resolved = { ok: true, entry: only, source: 'known-table' };
        } else {
          const list = asEntries.slice(0, 5).map((c) => `${c.name}（${c.code}）`).join('、');
          return {
            ok: false,
            code: 'NOT_FOUND',
            message:
              asEntries.length > 1
                ? `「${rawSymbol}」搜到多个，你是说：${list}？报其中一个代码我就能查。`
                : `「${rawSymbol}」搜到的是「${list}」—— 是它吗？确认一下我就查。`,
          };
        }
      }
    }
  }

  if (!resolved.ok) {
    if (resolved.reason === 'needs-network') {
      // 联网也没搜到（或搜索不可用）—— 说清是**收录 + 搜索**都没命中，
      // 并给出仍然走得通的路（报代码），不要含糊其辞。
      return {
        ok: false,
        code: 'NOT_FOUND',
        message:
          `没找到「${rawSymbol}」。本地名单和联网搜索都没有这个标的。\n` +
          '可以试试：直接报 6 位代码（如 600519 / 510300），或者确认一下名字有没有写错。',
      };
    }
    const hint =
      resolved.candidates.length > 0
        ? `你是说：${resolved.candidates.map((c) => `${c.name}(${c.code})`).join('、')}？`
        : '';
    return { ok: false, code: 'NOT_FOUND', message: `${resolved.message} ${hint}`.trim() };
  }
  const entry = resolved.entry;

  let loaded;
  try {
    loaded = await loadDaily({ symbol: entry.symbol, deps: ctx, store, logger });
  } catch (err) {
    return { ok: false, code: 'CANCELLED', message: /** @type {Error} */ (err).message };
  }
  if (!loaded.ok) return loaded;

  const prepared = prepareBars(loaded.source, loaded.payload);

  // ⚠️ 直接报**代码**进来时，符号解析拿不到名字，只能先用代码占位
  // （见 symbols.js 的 input-code 分支）。而接口返回的 `meta.longName` **就是真名** ——
  // 所以这里补一次，否则用户会看到「516350（516350）」这种废话，
  // 明明查的是"芯片ETF易方达"。
  //
  // 只在"名字还是占位符"时覆盖，避免把本地表/自选股里的用户自定义名字冲掉。
  if (entry.name === entry.code && loaded.payload?.meta?.longName) {
    entry.name = loaded.payload.meta.longName;
  }

  const view = buildView({
    name: entry.name,
    code: entry.code,
    source: loaded.source,
    bars: prepared.bars,
    dataDate: loaded.dataDate,
    adjustedNote: prepared.note,
  });

  if (brief) {
    const change =
      view.price !== null && view.prevClose !== null && view.prevClose !== 0
        ? (view.price / view.prevClose - 1) * 100
        : null;
    const lines = [
      `${entry.name}（${entry.code}）`,
      `数据截至 ${loaded.dataDate ?? '未知'} 收盘`,
      `现价 ${view.price === null ? '-' : view.price.toFixed(2)}　涨跌 ${
        change === null ? '-' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`
      }`,
      `量比 ${view.volumeRatio === null ? '-' : view.volumeRatio.toFixed(2)}`,
      `数据源 ${loaded.source}${loaded.fromCache ? '（缓存）' : ''}`,
    ];
    if (prepared.note) lines.push(prepared.note);
    return { ok: true, summary: lines.join('\n').slice(0, 800), data: view };
  }

  const { summary } = renderOverview(view);
  const extra = [];
  extra.push(`数据源 ${loaded.source}${loaded.fromCache ? '（缓存）' : ''}`);
  if (prepared.note) extra.push(prepared.note);

  return {
    ok: true,
    summary: `${summary}\n${extra.join('\n')}`.slice(0, 800),
    data: view,
  };
}

/**
 * `scan`：批量扫全部自选股。
 *
 * @param {any} ctx
 * @returns {Promise<{ ok: true, summary: string, data: unknown } | { ok: false, code: string, message: string }>}
 */
async function scanAll(ctx) {
  const store = ctx?.store;
  const logger = createLogger(ctx);
  if (!store) {
    return { ok: false, code: 'INTERNAL', message: '缺少 ctx.store，无法读取自选股。' };
  }

  // ⚠️ 自选股由 watchlist 技能在**它自己的命名空间**里维护，
  // 而本技能的 ctx.store 是隔离的 —— 所以名单通过 ctx.watchlist 传入（由上层注入）。
  const items = Array.isArray(ctx?.watchlistItems) ? ctx.watchlistItems : null;
  if (items === null) {
    return {
      ok: false,
      code: 'INTERNAL',
      message: '没有拿到自选股名单（需要上层注入 ctx.watchlistItems）。',
    };
  }
  if (items.length === 0) {
    return { ok: true, summary: '自选股是空的。可以说「把茅台加进自选」来添加。', data: { rows: [] } };
  }
  if (items.length > WATCHLIST_LIMIT) {
    return {
      ok: false,
      code: 'BAD_ARGS',
      message: `一次最多扫 ${WATCHLIST_LIMIT} 只，当前自选有 ${items.length} 只。`,
    };
  }

  /** @type {import('./snapshot.js').ScanRow[]} */
  const rows = [];
  /** @type {string[]} */
  const failures = [];
  let dataDate = null;
  let source = null;

  for (const item of items) {
    // ⚠️ 每次循环前检查中断 —— 否则用户点「停止」要等整批跑完（MK19）
    if (ctx.signal?.aborted) throwCancelled();

    let loaded;
    try {
      loaded = await loadDaily({ symbol: item.symbol, deps: ctx, store, logger });
    } catch (err) {
      throw err; // AbortError 向上冒泡，由 runner 归一成 CANCELLED
    }

    if (!loaded.ok) {
      // 失败隔离：单只失败只标注该只，不影响其余（PRD §3.4）
      failures.push(`${item.name}(${item.code})`);
      continue;
    }

    // ⚠️ 同一次 scan **不换源**：以第一只成功的结果为准，后续不一致要提示
    source = source ?? loaded.source;
    dataDate = dataDate ?? loaded.dataDate;

    const prepared = prepareBars(loaded.source, loaded.payload);
    const view = computeAll(prepared.bars);
    const prevClose =
      prepared.bars.length >= 2 ? prepared.bars[prepared.bars.length - 2].close : null;
    rows.push({
      name: item.name,
      code: item.code,
      price: view.price,
      changePct:
        view.price !== null && prevClose !== null && prevClose !== 0
          ? (view.price / prevClose - 1) * 100
          : null,
      rsi: view.rsi,
      rangePos: view.rangePosition,
      volRatio: view.volumeRatio,
      insufficient: view.insufficient,
    });
  }

  const rendered = renderScanSummary(rows, { dataDate });
  /** @type {string[]} */
  const notes = [`数据源 ${source ?? '无'}`];
  if (failures.length > 0) notes.push(`有 ${failures.length} 只没查到：${failures.join('、')}`);
  const warned = checkFetchBudget('scan', logger);
  if (warned) notes.push('（本次请求次数异常偏多，缓存可能没生效）');

  return {
    ok: true,
    summary: `${rendered.summary}\n${notes.join('　')}`.slice(0, 800),
    data: { rows, shown: rendered.shown, omitted: rendered.omitted, failures },
  };
}

/**
 * 技能入口。
 *
 * @param {{ action: 'quote'|'overview'|'scan', symbol?: string }} args
 * @param {any} ctx
 * @returns {Promise<any>}
 */
export async function run(args, ctx = {}) {
  resetFetchCount();
  if (ctx?.signal?.aborted) throwCancelled();

  switch (args.action) {
    case 'scan':
      return scanAll(ctx);
    case 'overview':
      return singleStock(String(args.symbol ?? ''), ctx, { brief: false });
    case 'quote':
      return singleStock(String(args.symbol ?? ''), ctx, { brief: true });
    default:
      return {
        ok: false,
        code: 'BAD_ARGS',
        message: `不认识的 action：${String(args.action)}`,
      };
  }
}

/** 便于单测：暴露本次调用发起了多少次真实出网 */
export { countFetches };
