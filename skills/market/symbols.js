/**
 * 符号解析：用户输入 → 统一内部符号。
 *
 * 统一内部格式 **`<code>.<MARKET>`**，如 `600519.SH` / `000001.SZ`。
 *
 * ## 解析顺序（越靠前越省事，SDD-market §5.2）
 *
 * 1. **自选股本地表**（`ctx.store`）—— 用户最常问自己加过的票，本地命中就不出网
 * 2. **内置常用表**（`known-symbols.json`）—— 零出网
 * 3. **网络搜索** → 东财搜索优先，Yahoo search 兜底（由调用方编排，本模块只出"需要联网"的信号）
 * 4. 都不中 → **返回候选列表，不猜**（复用天气技能 WX-4 的原则）
 *
 * ## 为什么"不许猜"是硬规则
 *
 * 猜错的代价不是"回答不准"，而是**用户以为自己在看 A 股票，实际在看 B 股票**。
 * 所以本模块**只在能唯一确定时才返回单一结果**；有歧义就返回候选。
 *
 * ## ⚠️ `known-symbols.json` 是**种子表**，不是完整表
 *
 * 它刻意只收"高置信度"条目（主要指数 + 各行业龙头）。**宁可少，不可错。**
 * 完整表应当在网络可用时用东财搜索批量生成，见 `known-symbols.json` 头部的说明。
 */

import { KNOWN_SYMBOLS } from './known-symbols.js';

/**
 * @typedef {import('./known-symbols.js').StockEntry} StockEntry
 * @typedef {object} ResolveOk
 * @property {true} ok
 * @property {StockEntry} entry
 * @property {'input-code'|'local-table'|'known-table'} source
 * @typedef {object} ResolveFail
 * @property {false} ok
 * @property {'needs-network'|'ambiguous'|'not-found'|'invalid'} reason
 * @property {string} message
 * @property {StockEntry[]} candidates
 * @typedef {ResolveOk | ResolveFail} ResolveResult
 */

/** 市场枚举。v0 只做 A 股（沪深）。 */
export const MARKETS = Object.freeze(['SH', 'SZ']);

/**
 * A 股代码**首位数字 → 交易所**的映射表。
 *
 * 这张表是实证出来的（2026-09-14 用东财逐个核对），**不是猜的**：
 *
 * | 首位 | 交易所 | 是什么 | 实例 |
 * |---|---|---|---|
 * | `6` | 沪 SH | 主板 / 科创板个股 | `600519` 茅台、`688981` 中芯国际 |
 * | `0` | 深 SZ | 主板 / 中小板个股 | `000001` 平安银行 |
 * | `3` | 深 SZ | 创业板个股 | `300750` 宁德时代 |
 * | `5` | 沪 SH | **ETF / 场内基金** | `510300` 沪深300ETF、`588000` 科创50ETF |
 * | `1` | 深 SZ | **ETF / 场内基金** | `159915` 创业板ETF、`159919` 沪深300ETF |
 * | `2` | 深 SZ | B 股 / 特殊基金 | `200596` 古井贡Ｂ |
 * | `9` | 沪 SH | B 股 | `900901` 云赛Ｂ股 |
 * | `4` / `8` | 北交所 BJ | ⚠️ **v0 不支持**（内部符号格式无法表达 BJ） |
 *
 * ## ⚠️ 这张表曾经漏了 `5` / `1` / `2` / `9`，后果是"ETF 完全查不到"
 *
 * 东财**本来就支持 ETF**（实测 `510300` / `159915` / `588000` 都能返回数据），
 * 但本函数遇到 `5` 开头的代码会返回空数组 → 解析在**碰接口之前**就被拒了。
 * 用户看到的是"查不到"，而真实原因是**我们自己的映射表不全**。
 */
const MARKET_BY_FIRST_DIGIT = Object.freeze({
  6: 'SH',
  5: 'SH',
  9: 'SH',
  0: 'SZ',
  1: 'SZ',
  2: 'SZ',
  3: 'SZ',
});

/** 首位数字 → 品种（用于给用户更准确的提示，也便于将来区分处理） */
const KIND_BY_FIRST_DIGIT = Object.freeze({
  6: 'stock',
  0: 'stock',
  3: 'stock',
  5: 'fund',
  1: 'fund',
  2: 'fund',
  9: 'stock', // B 股仍算股票
});

/**
 * 判断某个 6 位代码属于哪个市场与品种。
 *
 * @param {string} code
 * @returns {{ market: 'SH'|'SZ', kind: 'stock'|'fund' } | null}
 *          北交所（4/8）与畸形输入返回 null
 */
export function classifyCode(code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const m = /** @type {Record<string, 'SH'|'SZ'>} */ (MARKET_BY_FIRST_DIGIT)[code[0]];
  if (!m) return null;
  const k = /** @type {Record<string, 'stock'|'fund'>} */ (KIND_BY_FIRST_DIGIT)[code[0]];
  return { market: m, kind: k ?? 'stock' };
}

/**
 * 列出某个 6 位代码**在规则上可能属于**的全部市场。
 *
 * ## 为什么返回数组而不是单一结果
 *
 * 因为 **`000001` 在沪深两市各自都有含义**：
 * - `000001.SZ` = 平安银行（个股）
 * - `000001.SH` = 上证指数（指数）
 *
 * 纯 6 位输入**无法区分**这两种。这时正确的做法不是猜，而是**交给上层查表**
 * （表里可能只有其中一个）或**返回候选让用户选**。
 *
 * ## 只有 `0` 开头有跨市场歧义
 *
 * 其余首位都是单市场（见 `MARKET_BY_FIRST_DIGIT`）。
 * ⚠️ 不要为了"保险"给其他首位也加一个 `.SH` 备选 —— 那只会制造**假歧义**
 * （例如 `30xxxx` 两边都在深市），让本该唯一确定的结果变成"请你选一个"。
 *
 * @param {string} code 6 位数字
 * @returns {Array<{ symbol: string, market: 'SH'|'SZ', fromStockRule: boolean }>}
 *          按"个股规则优先"排序；北交所（4/8 开头）返回空数组 —— v0 不支持
 */
export function candidatesForCode(code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return [];
  const c = code;
  const first = c[0];

  if (first === '0') {
    return [
      { symbol: `${c}.SZ`, market: /** @type {'SZ'} */ ('SZ'), fromStockRule: true },
      // 指数特例：上交所的 000xxx 指数（上证指数、沪深300、中证500、上证50）
      { symbol: `${c}.SH`, market: /** @type {'SH'} */ ('SH'), fromStockRule: false },
    ];
  }

  const market = /** @type {Record<string, 'SH'|'SZ'>} */ (MARKET_BY_FIRST_DIGIT)[first];
  if (!market) {
    // 4 / 8 = 北交所；v0 不支持，明确给空数组而不是猜
    return [];
  }
  return [{ symbol: `${c}.${market}`, market, fromStockRule: true }];
}

/**
 * 把 6 位代码转成内部符号 —— **仅当能唯一确定时**。
 *
 * ⚠️ 对 `000001` 这类"两市都可能"的代码返回 `null`
 * （`.SZ` 与 `.SH` 都存在）。需要处理歧义的调用方请用 `candidatesForCode`。
 *
 * @param {string} code 6 位数字
 * @returns {{ symbol: string, market: 'SH'|'SZ' } | null}
 */
export function codeToSymbol(code) {
  const cands = candidatesForCode(code);
  if (cands.length !== 1) return null;
  return { symbol: cands[0].symbol, market: cands[0].market };
}

/**
 * 解析内部符号 `<code>.<MARKET>`。
 *
 * @param {string} symbol
 * @returns {{ code: string, market: 'SH'|'SZ' } | null}
 */
export function parseSymbol(symbol) {
  if (typeof symbol !== 'string') return null;
  const m = /^(\d{6})\.(SH|SZ)$/.exec(symbol.trim().toUpperCase());
  if (!m) return null;
  return { code: m[1], market: /** @type {'SH'|'SZ'} */ (m[2]) };
}

/**
 * 规范化用户的代码类输入。
 *
 * 支持的形式：
 * - `600519`（6 位纯数字）—— 可能返回多个候选（见 `candidatesForCode`）
 * - `sh600519` / `SH600519`（带市场前缀）—— **明确指定市场，返回单个候选**
 * - `600519.SH` / `600519.sh`（内部格式）—— 同上
 *
 * @param {string} raw
 * @returns {Array<{ symbol: string, market: 'SH'|'SZ', fromStockRule: boolean }>}
 */
export function normalizeCodeInput(raw) {
  if (typeof raw !== 'string') return [];
  const s = raw.trim();

  // 600519.SH —— 市场已明确写出
  const dotted = parseSymbol(s);
  if (dotted) {
    return [{ symbol: `${dotted.code}.${dotted.market}`, market: dotted.market, fromStockRule: true }];
  }

  // sh600519 / sz000001 —— 市场已明确写出
  const prefixed = /^(sh|sz)(\d{6})$/i.exec(s);
  if (prefixed) {
    const market = /** @type {'SH'|'SZ'} */ (prefixed[1].toUpperCase());
    const code = prefixed[2];
    // 前缀与个股首位规则矛盾时**不猜**：
    // 例 `sh000001` —— 它其实指向上证指数（合法的指数代码），
    // 但"用户是不是想说上证指数"无从判断，所以交给上层查表决定，
    // 这里只把候选限定在"前缀指定的市场"。
    return [{ symbol: `${code}.${market}`, market, fromStockRule: false }];
  }

  // 纯 6 位 —— 可能有歧义
  if (/^\d{6}$/.test(s)) return candidatesForCode(s);

  return [];
}

/**
 * 一条表项的**全部可匹配名字**（正式名 + 别名 + 代码 + 内部符号），全部小写。
 *
 * 抽成 helper 是为了让"精确匹配"只有一处实现 —— 否则 `lookupByName`
 * 与 `resolveSymbol` 很容易各写一份、然后慢慢长歪。
 *
 * @param {StockEntry} e
 * @returns {string[]}
 */
export function matchableNames(e) {
  return [e.name, ...(e.aliases ?? []), e.code, e.symbol].map((n) => n.toLowerCase());
}

/**
 * 判断一条表项是否**精确匹配**用户的输入。
 * @param {StockEntry} e
 * @param {string} lowerInput 已 trim + toLowerCase 的输入
 * @returns {boolean}
 */
export function matchesExactly(e, lowerInput) {
  return matchableNames(e).includes(lowerInput);
}

/**
 * 在内置表里按名字精确 / 别名匹配（含代码与内部符号）。
 *
 * **只做全等**匹配；模糊匹配交给 `searchByName`。
 * 同名多条时返回**第一条** —— 需要处理歧义的调用方请用 `resolveSymbol`
 * （它会把这些情况报成 `ambiguous` 并给候选）。
 *
 * @param {string} name
 * @returns {StockEntry | null}
 */
export function lookupByName(name) {
  if (typeof name !== 'string') return null;
  const key = name.trim().toLowerCase();
  if (key === '') return null;
  return KNOWN_SYMBOLS.find((e) => matchesExactly(e, key)) ?? null;
}

/**
 * 按名字**模糊搜索**内置表（用于"解析不了时给出候选"）。
 *
 * 匹配规则：名字或别名**包含**关键词，或关键词**包含**名字。
 * 结果按"名字长度升序"排（越短越可能是用户想说的那个）。
 *
 * @param {string} query
 * @param {number} [limit]
 * @returns {StockEntry[]}
 */
export function searchByName(query, limit = 10) {
  if (typeof query !== 'string') return [];
  const q = query.trim().toLowerCase();
  if (q === '') return [];

  /** @type {StockEntry[]} */
  const hits = [];
  for (const e of KNOWN_SYMBOLS) {
    const names = [e.name, ...(e.aliases ?? [])].map((n) => n.toLowerCase());
    if (names.some((n) => n.includes(q) || q.includes(n))) hits.push(e);
  }
  hits.sort((a, b) => a.name.length - b.name.length);
  return hits.slice(0, limit);
}

/**
 * 主解析入口：把用户输入变成统一内部符号。
 *
 * **绝不猜**：不能唯一确定时返回 `needs-network`（交给上层联网搜）
 * 或 `ambiguous`（返回候选让人选）。
 *
 * @param {string} raw 用户输入（中文名 / 代码 / 内部符号 / 带前缀代码）
 * @param {{ localEntries?: StockEntry[] }} [opts] `localEntries` = 自选股（优先级最高）
 * @returns {ResolveResult}
 */
export function resolveSymbol(raw, opts = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'invalid', message: '没有给出股票名称或代码', candidates: [] };
  }
  const input = raw.trim();
  const lower = input.toLowerCase();

  // ① 自选股本地表（最高优先级：用户加过的票，他一定是在说它）
  const local = opts.localEntries ?? [];
  for (const e of local) {
    if (
      e.name.toLowerCase() === lower ||
      e.code === lower ||
      e.symbol.toLowerCase() === lower ||
      e.aliases?.some((a) => a.toLowerCase() === lower)
    ) {
      return { ok: true, entry: e, source: 'local-table' };
    }
  }

  // ② 代码类输入
  const codeCands = normalizeCodeInput(input);
  if (codeCands.length > 0) {
    // ⚠️ 先看**表里是否确切存在这个符号**。
    // 因为规则候选只是"可能属于哪些市场"，而表里的条目是**确定的**。
    // 例：`000001` 规则上有 .SZ/.SH 两个候选，但表里只收了上证指数 → 就是它，无歧义。
    if (codeCands.length === 1) {
      const exact = KNOWN_SYMBOLS.find((e) => e.symbol === codeCands[0].symbol);
      if (exact) return { ok: true, entry: exact, source: 'known-table' };
    }

    const inTable = codeCands
      .map((c) => KNOWN_SYMBOLS.find((e) => e.symbol === c.symbol))
      .filter((e) => e !== undefined);

    if (inTable.length === 1) {
      return { ok: true, entry: inTable[0], source: 'known-table' };
    }
    if (inTable.length > 1) {
      // 真实歧义：如 `000001` 同时是平安银行(.SZ) 与 上证指数(.SH)
      return {
        ok: false,
        reason: 'ambiguous',
        message: `代码 ${input} 在沪深两市都有含义，请确认是哪一个`,
        candidates: inTable,
      };
    }

    // 表里没有 → 只有在"唯一确定"时才据此作答，否则仍然让人选
    if (codeCands.length === 1) {
      const only = codeCands[0];
      return {
        ok: true,
        entry: {
          symbol: only.symbol,
          code: only.symbol.split('.')[0],
          market: only.market,
          // 品种按首位推断（'5'/'1'/'2' 是场内基金），不要一律当个股
          kind: /** @type {'stock'|'fund'} */ (
            only.symbol[0] === '5' || only.symbol[0] === '1' || only.symbol[0] === '2'
              ? 'fund'
              : 'stock'
          ),
          // ⚠️ 名字暂时用代码占位 —— 调用方在取回数据后应当用接口给的真名覆盖它
          // （东财 K 线响应的 `data.name` 就是真名，见 market/index.js 的 refreshName）
          name: only.symbol.split('.')[0],
        },
        source: 'input-code',
      };
    }

    // 多个候选且表里都没有 → 不猜
    return {
      ok: false,
      reason: 'ambiguous',
      message: `代码 ${input} 未收录，且沪市/深市都可能，请指明（如 ${codeCands
        .map((c) => c.symbol)
        .join(' 或 ')}）`,
      candidates: [],
    };
  }

  // ③ 内置表：名字精确匹配（**名字、别名、代码、内部符号都算**）
  const exactHits = KNOWN_SYMBOLS.filter((e) => matchesExactly(e, lower));
  if (exactHits.length === 1) {
    return { ok: true, entry: exactHits[0], source: 'known-table' };
  }
  if (exactHits.length > 1) {
    // 精确匹配到多条（表本身有问题，或确实同名）→ 让用户选，不替其决定
    return {
      ok: false,
      reason: 'ambiguous',
      message: `「${input}」在本地表里有多个匹配`,
      candidates: exactHits,
    };
  }

  // ④ 模糊匹配：有候选就让人选，**不自动选一个**
  const fuzzy = searchByName(input);
  if (fuzzy.length > 0) {
    return {
      ok: false,
      reason: 'ambiguous',
      message: `没有精确匹配「${input}」，请确认是下面哪一个`,
      candidates: fuzzy,
    };
  }

  // ⑤ 本地表无从下手 → 交给上层联网搜（东财搜索优先）
  return {
    ok: false,
    reason: 'needs-network',
    message: `本地表里没有「${input}」，需要联网搜索`,
    candidates: [],
  };
}

// ---------------------------------------------------------------- 各源符号转换

/**
 * 内部符号 → 东财 `secid`（**主源**用的格式）。
 *
 * 东财内部寻址 `<market>.<code>`：**SH = 1，SZ = 0**。
 *
 * ⚠️ v1+ 做美股时前缀**不是固定的 105**（105=NASDAQ / 106=NYSE / 107=AMEX），
 * 且要先请求 suggest 端点才能确定。v0 只做 A 股，不涉及。
 *
 * @param {string} symbol 内部符号
 * @returns {string | null}
 */
export function toEastmoneySecid(symbol) {
  const p = parseSymbol(symbol);
  if (!p) return null;
  return p.market === 'SH' ? `1.${p.code}` : `0.${p.code}`;
}

/**
 * 判断用户输入看起来是**代码**还是**名字**。
 *
 * 用途：决定要不要直接走"代码直通"，跳过内置表。
 *
 * @param {string} raw
 * @returns {'code' | 'name'}
 */
export function classifyInput(raw) {
  if (typeof raw !== 'string') return 'name';
  const s = raw.trim();
  if (/^\d{6}$/.test(s)) return 'code';
  if (/^(sh|sz)\d{6}$/i.test(s)) return 'code';
  if (/^\d{6}\.(sh|sz)$/i.test(s)) return 'code';
  return 'name';
}
