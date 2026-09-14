/**
 * 内置常用股票表 —— **种子表**（完整表见 `known-symbols.json` 头部的补全说明）。
 *
 * 这个文件只做三件事：
 *   1. 把 `known-symbols.json` 读进来（数据与代码分离，便于将来用脚本批量补全）
 *   2. 拍平成统一的 `KNOWN_SYMBOLS` 数组（索引 + 个股）
 *   3. 提供一个**运行时形状校验**，让表里的错误尽早暴露
 *
 * ## 为什么要有运行时校验
 *
 * 股票代码是**从字面上看不出对错**的那类数据：`600519` 和 `600519` 抄错一位
 * 仍然是"看起来合法"的 6 位数字，但会指向完全不同的标的。
 *
 * 所以这里强制检查**可由规则判定**的那部分：
 * 代码首位与市场必须一致（`6`→SH，`0`/`3`→SZ）—— 这条规则能抓住
 * "把深市代码写成上交所"这类错误。**至于代码本身是否真实存在，本地校验不了**，
 * 那需要联网核对（见 `known-symbols.json` 的补全说明）。
 *
 * @typedef {{ symbol: string, code: string, market: 'SH'|'SZ', name: string, kind: 'stock'|'index'|'fund', aliases?: string[] }} StockEntry
 */

import raw from './known-symbols.json' with { type: 'json' };

/**
 * 个股的交易所归属由代码首位唯一决定（硬规则，不是猜测）。
 *
 * ⚠️ **这条规则只适用于个股，不适用于指数**：
 * 上证指数是 `000001.SH` —— 首位是 `0` 却在上交所。
 * 指数用的是另一套代码分配，所以校验时必须先看 `kind`。
 *
 * @param {string} code
 * @returns {'SH' | 'SZ' | null} 北交所（4/8）返回 null —— v0 不支持
 */
export function marketOfCode(code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const first = code[0];
  if (first === '6') return 'SH';
  if (first === '0' || first === '3') return 'SZ';
  return null;
}

/**
 * 校验一条表项的形状是否自洽。
 *
 * @param {any} e
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
export function validateEntry(e) {
  /** @type {string[]} */
  const problems = [];
  if (!e || typeof e !== 'object') return ['条目不是对象'];

  const { symbol, code, market, name, kind } = e;
  if (kind !== 'stock' && kind !== 'index' && kind !== 'fund') {
    problems.push(`kind 必须是 stock/index/fund：${String(kind)}`);
  }
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    problems.push(`code 不是 6 位数字：${String(code)}`);
  }
  if (typeof name !== 'string' || name.trim() === '') {
    problems.push('name 缺失或为空');
  }
  if (market !== 'SH' && market !== 'SZ') {
    problems.push(`market 必须是 SH/SZ（v0 不支持北交所与港美股）：${String(market)}`);
  }

  // ⚠️ 代码首位规则**只校验个股**：指数用另一套代码分配
  // （上证指数就是 000001.SH —— 首位是 0 却在上交所）
  if (kind === 'stock' && typeof code === 'string' && /^\d{6}$/.test(code)) {
    const derived = marketOfCode(code);
    if (derived === null) {
      problems.push(`code ${code} 属于北交所，v0 不支持`);
    } else if (derived !== market) {
      problems.push(
        `code ${code} 的首位指向 ${derived}，但 market 写的是 ${String(market)}`,
      );
    }
  }

  if (typeof code === 'string' && typeof market === 'string') {
    const expected = `${code}.${market}`;
    if (symbol !== expected) {
      problems.push(`symbol 应为 ${expected}，实际 ${String(symbol)}`);
    }
  }

  if (e.aliases !== undefined) {
    if (!Array.isArray(e.aliases)) problems.push('aliases 必须是数组');
    else if (e.aliases.some((/** @type {unknown} */ a) => typeof a !== 'string' || a === '')) {
      problems.push('aliases 里必须有非空字符串');
    }
  }

  return problems;
}

/**
 * 拍平后的内置表（索引 + 个股）。
 *
 * 类型断言的理由：JSON 导入的类型是推断出来的宽类型，而 `validateEntry`
 * 已经在 `test/unit/symbols.test.js` 里对**每一条**做了断言。
 * 这里的断言是"把测试保证过的形状告诉 TS"。
 *
 * @type {ReadonlyArray<StockEntry>}
 */
export const KNOWN_SYMBOLS = /** @type {StockEntry[]} */ ([
  ...(raw.indices ?? []),
  ...(raw.funds ?? []),
  ...(raw.stocks ?? []),
]);

/** 便于诊断：表里有多少条。 */
export const KNOWN_SYMBOLS_COUNT = KNOWN_SYMBOLS.length;
