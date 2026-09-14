/**
 * 符号解析的**网络兜底**：东财搜索（SDD-market §5.2 解析顺序第 3 步）。
 *
 * ## 为什么需要它
 *
 * 内置表（`known-symbols.json`）只收录主要指数与各行业龙头 —— **刻意不追求完整**，
 * 因为手写上千个股票代码，错一位仍然是"看起来合法"的 6 位数字，但会指向完全不同的标的。
 *
 * 于是必然有一批标的查不到：**新上市的**（如宇树科技）、**ETF**、**小众个股**。
 * 对它们，用户要么报代码、要么**联网搜一下名字** —— 本模块做后者。
 *
 * ## 接口形状（2026-09-14 实测）
 *
 * ```
 * GET https://searchapi.eastmoney.com/api/suggest/get
 *   ?input=<关键词>&type=14&token=<公开 token>&count=10
 * ```
 *
 * 返回：
 * ```json
 * {"QuotationCodeTable":{"Status":0,"Message":"成功","TotalCount":1,"Data":[
 *   {"Code":"688836","Name":"宇树科技-W","MarketType":"1","SecurityTypeName":"科创板",
 *    "QuoteID":"1.688836","UnifiedCode":"688836", ...}]}}
 * ```
 *
 * 其中 **`QuoteID` 就是 `<market>.<code>`**（`1` = 沪、`0` = 深），
 * 与我们 `toEastmoneySecid()` 的输出格式**完全一致** —— 所以市场归属不必猜。
 *
 * ## ⚠️ 只做"解析成代码"，不做"自动选中"
 *
 * 搜索可能返回多条（如"华夏"会命中一堆基金）。本模块**只返回候选列表**，
 * 由调用方决定：唯一命中才直接用，多条就**让用户选**（不许猜）。
 * 这与天气技能 WX-4 的原则一致。
 */

/** 搜索域名（必须与 `skill.json` 的 `networkHosts` 一致） */
export const SEARCH_HOST = 'searchapi.eastmoney.com';

/**
 * 公开的 suggest token。
 *
 * 它不是"密钥"—— 东财前端页面里就这么明文写着，任何人可见。
 * 所以它不违反「API Key 不出本机」那条（PRD-Brain §2.1），
 * 但它确实是个**会变的**东西，所以放在一处常量里便于替换。
 */
export const SEARCH_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';

/** `type=14` 是"全部证券"（含个股 / ETF / 指数 / B 股） */
const SEARCH_TYPE = '14';

/**
 * @typedef {{ code: string, name: string, market: 'SH'|'SZ', secid: string,
 *             securityType: string }} SearchHit
 */

/**
 * 把 `QuoteID`（`1.688836`）转成内部符号（`688836.SH`）。
 *
 * 东财的 market 数字：**1 = 沪，0 = 深** —— 与 `toEastmoneySecid()` 互逆。
 *
 * @param {string} quoteId
 * @returns {{ symbol: string, market: 'SH'|'SZ' } | null}
 */
export function quoteIdToSymbol(quoteId) {
  const m = /^([01])\.(\d{6})$/.exec(String(quoteId));
  if (!m) return null;
  const market = m[1] === '1' ? 'SH' : 'SZ';
  return { symbol: `${m[2]}.${market}`, market };
}

/**
 * 解析 suggest 响应。
 *
 * @param {unknown} json
 * @returns {SearchHit[]} 候选（可能为空）
 */
export function parseSuggestResponse(json) {
  const table = /** @type {any} */ (json)?.QuotationCodeTable;
  if (!table || !Array.isArray(table.Data)) return [];

  /** @type {SearchHit[]} */
  const out = [];
  for (const d of table.Data) {
    if (!d || typeof d.Code !== 'string' || typeof d.Name !== 'string') continue;
    const sym = quoteIdToSymbol(d.QuoteID);
    if (!sym) continue;
    // ⚠️ 内部符号只表达沪深。北交所的 QuoteID 形如 `0.8xxxxx`，
    // 会被 quoteIdToSymbol 当成深市放进来 —— 那会给出一个**查不到数据**的符号，
    // 所以按首位把北交所挡掉（宁可说"不支持"，也不要给个假代码）。
    if (d.Code[0] === '4' || d.Code[0] === '8') continue;
    out.push({
      code: d.Code,
      name: d.Name,
      market: sym.market,
      secid: d.QuoteID,
      securityType: typeof d.SecurityTypeName === 'string' ? d.SecurityTypeName : '',
    });
  }
  return out;
}

/**
 * 用东财搜索把**名字**解析成候选代码。
 *
 * `safeFetch` 由调用方注入（技能的 `ctx.safeFetch`），域名必须在白名单里。
 *
 * @param {string} keyword 用户输入（中文名 / 拼音首字母 / 代码片段）
 * @param {{ safeFetch: (url: string, opts?: any) => Promise<any>, count?: number, timeoutMs?: number }} deps
 * @returns {Promise<{ ok: true, hits: SearchHit[] } | { ok: false, code: string, message: string }>}
 */
export async function searchSymbol(keyword, deps) {
  const input = String(keyword ?? '').trim();
  if (input === '') return { ok: true, hits: [] };

  const params = new URLSearchParams({
    input,
    type: SEARCH_TYPE,
    token: SEARCH_TOKEN,
    count: String(deps.count ?? 10),
  });
  const url = `https://${SEARCH_HOST}/api/suggest/get?${params}`;

  let res;
  try {
    res = await deps.safeFetch(url, { timeoutMs: deps.timeoutMs ?? 8000 });
  } catch (err) {
    return {
      ok: false,
      code: 'NETWORK',
      message: `搜索失败：${/** @type {Error} */ (err)?.message ?? '未知'}`,
    };
  }
  if (!res || res.ok === false) {
    const status = res?.status ?? '?';
    return {
      ok: false,
      code: status === 429 ? 'RATE_LIMIT' : 'NETWORK',
      message: `搜索返回 HTTP ${status}`,
    };
  }

  let json;
  try {
    json = typeof res.json === 'function' ? await res.json() : res.body;
  } catch (err) {
    return {
      ok: false,
      code: 'INTERNAL',
      message: `搜索结果不是合法 JSON：${/** @type {Error} */ (err)?.message ?? ''}`,
    };
  }

  return { ok: true, hits: parseSuggestResponse(json) };
}
