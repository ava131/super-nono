/**
 * Yahoo Finance chart 端点 —— **备源**（主源是东财）。
 *
 * 为什么它是备源而不是主源（SDD-market §2.1）：PM 长期在**国内**使用，
 * 东财是境内源；Yahoo 在海外实测完全可用（86ms、含 `adjclose`），
 * 但**国内大概率不可达**，所以只作降级路径。
 *
 * ## 本模块只做三件事
 *
 * 1. 内部符号 → Yahoo 符号（`600519.SH` → `600519.SS`）
 * 2. 构造请求 URL
 * 3. **解析响应成统一结构**（只解析，不算指标、不做复权 —— 复权交给 `adjust.js`）
 *
 * ## 失败一律返回结构化结果，不抛异常
 *
 * 这样调用方（`index.js` 的降级编排）可以用同一套逻辑处理两个源。
 * 抛异常会让"主源失败 → 切备源"的编排变成一堆 try/catch。
 *
 * ## ⚠️ 关于时间戳的时区（一个容易错的地方）
 *
 * Yahoo 返回的 `timestamp` 是 **UTC 秒**，但该时刻对应的是**交易所当地的开盘时间**。
 * 直接把 UTC 秒转成日期，在"机器时区 ≠ 交易所时区"时会**差一天**。
 *
 * 正确做法是用 `meta.gmtoffset`（交易所相对 UTC 的秒偏移）：
 *
 * ```
 * 交易所当地日期 = new Date((ts + gmtoffset) * 1000) 再用 getUTC* 读取
 * ```
 *
 * 本模块按此实现。**不要**改成硬编码 `+8h` —— 那样 v1 加美股时会静默出错。
 */

/**
 * @typedef {{ time: number, open: number, high: number, low: number, close: number, volume: number }} RawBar
 * @typedef {{ symbol: string, currency: string|null, exchange: string|null, longName: string|null }} YahooMeta
 * @typedef {object} YahooSuccess
 * @property {true} ok
 * @property {string} symbol
 * @property {string|null} currency
 * @property {string|null} exchange
 * @property {string|null} timezone
 * @property {number} gmtoffset
 * @property {RawBar[]} bars
 * @property {(number|null)[]} adjclose
 * @property {YahooMeta} meta
 * @typedef {object} YahooFailure
 * @property {false} ok
 * @property {string} code
 * @property {string} message
 * @typedef {YahooSuccess | YahooFailure} ParseResult
 */

export const YAHOO_HOST = 'query1.finance.yahoo.com';

/**
 * 内部符号 → Yahoo 符号。
 *
 * | 内部 | Yahoo |
 * |---|---|
 * | `600519.SH` | `600519.SS` |
 * | `000001.SZ` | `000001.SZ` |
 *
 * @param {string} symbol 内部格式 `<code>.<MARKET>`
 * @returns {string | null} 无法转换时 null
 */
export function toYahooSymbol(symbol) {
  if (typeof symbol !== 'string') return null;
  const m = /^([0-9A-Za-z]+)\.([A-Z]+)$/.exec(symbol.trim());
  if (!m) return null;
  const [, code, market] = m;
  if (market === 'SH') return `${code}.SS`;
  if (market === 'SZ') return `${code}.SZ`;
  // v0 只做 A 股；港股/美股的前缀规则不同（见 SDD-market §5.2 的 v1+ 登记）
  return null;
}

/**
 * 构造 chart 端点 URL。
 *
 * @param {string} yahooSymbol
 * @param {{ range?: string, interval?: string }} [opts]
 * @returns {string}
 */
export function buildChartUrl(yahooSymbol, opts = {}) {
  const range = opts.range ?? '2y';
  const interval = opts.interval ?? '1d';
  const params = new URLSearchParams({
    range,
    interval,
    // 只要日线收盘价，不要盘中
    includePrePost: 'false',
    events: 'div,split',
  });
  return `https://${YAHOO_HOST}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?${params}`;
}

/**
 * 把 UTC 秒 + 交易所时区偏移 转成 `YYYY-MM-DD`。
 *
 * @param {number} tsSeconds
 * @param {number} gmtoffset 交易所相对 UTC 的秒偏移（如 A 股 = 28800）
 * @returns {string | null}
 */
export function toExchangeDate(tsSeconds, gmtoffset) {
  if (!Number.isFinite(tsSeconds) || !Number.isFinite(gmtoffset)) return null;
  const d = new Date((tsSeconds + gmtoffset) * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 解析 chart 响应。
 *
 * **只解析，不判断"数据够不够算指标"** —— 那是 `indicators.js` 的事。
 *
 * @param {unknown} json 已解析的响应 JSON
 * @returns {ParseResult}
 */
export function parseChartResponse(json) {
  const chart = /** @type {any} */ (json)?.chart;
  if (!chart) {
    return { ok: false, code: 'INTERNAL', message: 'Yahoo 响应缺少 chart 字段' };
  }
  if (chart.error) {
    const msg = chart.error?.description ?? chart.error?.code ?? '未知错误';
    return { ok: false, code: 'INTERNAL', message: `Yahoo 返回错误：${msg}` };
  }
  const result = chart.result?.[0];
  if (!result) {
    return { ok: false, code: 'NOT_FOUND', message: 'Yahoo 未返回该标的的数据' };
  }

  const timestamps = result.timestamp;
  const quote = result.indicators?.quote?.[0];
  if (!Array.isArray(timestamps) || !quote) {
    return { ok: false, code: 'INTERNAL', message: 'Yahoo 响应缺少 timestamp / quote' };
  }

  const adj = result.indicators?.adjclose?.[0]?.adjclose;
  const gmtoffset = Number.isFinite(result.meta?.gmtoffset)
    ? result.meta.gmtoffset
    : 0;

  /** @type {RawBar[]} */
  const bars = [];
  /** @type {(number|null)[]} */
  const adjclose = [];

  for (let i = 0; i < timestamps.length; i++) {
    const close = quote.close?.[i];
    const open = quote.open?.[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    // 成交量在某些标的/日期会是 null，那不影响价格指标
    const volume = quote.volume?.[i];

    // 价格缺失的根直接跳过（Yahoo 偶尔会给出 null 占位）
    if (
      !Number.isFinite(close) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low)
    ) {
      continue;
    }

    bars.push({
      time: timestamps[i],
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0,
    });
    adjclose.push(Number.isFinite(adj?.[i]) ? adj[i] : null);
  }

  if (bars.length === 0) {
    return { ok: false, code: 'NOT_FOUND', message: 'Yahoo 返回的 K 线为空' };
  }

  return {
    ok: true,
    symbol: result.meta?.symbol ?? '',
    currency: result.meta?.currency ?? null,
    exchange: result.meta?.exchangeName ?? null,
    timezone: result.meta?.timezone ?? null,
    gmtoffset,
    bars,
    adjclose,
    meta: {
      symbol: result.meta?.symbol ?? '',
      currency: result.meta?.currency ?? null,
      exchange: result.meta?.exchangeName ?? null,
      longName: result.meta?.longName ?? result.meta?.shortName ?? null,
    },
  };
}

/**
 * 取数据源（备源）的完整拉取流程：URL → safeFetch → 解析。
 *
 * `safeFetch` 必须由调用方注入（技能的 `ctx.safeFetch`），
 * 域名已在 `skill.json` 的 `networkHosts` 里声明。
 *
 * @param {string} symbol 内部符号 `<code>.<MARKET>`
 * @param {{ safeFetch: (url: string, opts?: any) => Promise<any>, range?: string, timeoutMs?: number }} deps
 * @returns {Promise<ParseResult>}
 */
export async function fetchYahooDaily(symbol, deps) {
  const yahooSymbol = toYahooSymbol(symbol);
  if (!yahooSymbol) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: `无法把 ${symbol} 转成 Yahoo 符号（v0 只支持 A 股）`,
    };
  }

  const url = buildChartUrl(yahooSymbol, { range: deps.range });
  let res;
  try {
    res = await deps.safeFetch(url, { timeoutMs: deps.timeoutMs ?? 10000 });
  } catch (err) {
    // 网络层失败统一成 NETWORK，交给上层决定是否降级
    return {
      ok: false,
      code: 'NETWORK',
      message: `Yahoo 请求失败：${/** @type {Error} */ (err)?.message ?? '未知'}`,
    };
  }

  if (!res || res.ok === false) {
    const status = res?.status ?? '?';
    return {
      ok: false,
      code: status === 429 ? 'RATE_LIMIT' : 'NETWORK',
      message: `Yahoo 返回 HTTP ${status}`,
    };
  }

  let json;
  try {
    json = typeof res.json === 'function' ? await res.json() : res.body;
  } catch (err) {
    return {
      ok: false,
      code: 'INTERNAL',
      message: `Yahoo 响应不是合法 JSON：${/** @type {Error} */ (err)?.message ?? ''}`,
    };
  }

  return parseChartResponse(json);
}
