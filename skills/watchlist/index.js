/**
 * 自选股技能（PRD-market §5 / §8，评审决定 3 与 5）。
 *
 * ## 为什么它是 L1.5（`local_reversible`）而不是 L2
 *
 * "加一支自选股"是**写操作**，按老规则该标 `local_write`（L2，每次弹确认框）。
 * 但那会**训练用户闭眼点"允许"**，等真正危险的操作（发邮件）出现时已经不会看了
 * —— 所以逐次确认反而**降低**安全性。
 *
 * 于是新增 L1.5：**只写本技能 `ctx.store` + 存在反向操作 + 不外发写入 → 直接执行，不弹框**。
 * 它的安全网是「**结果可见 + 每行可删**」（见 PRD §8 的自选名单）。
 *
 * ## ⚠️ 本技能**不出网**
 *
 * 这是刻意的，也是 L1.5 判定条件③的体现：
 * 符号解析**只查本地表 + 用户已加过的自选**，解析不到就**返回候选让人确认**，
 * 而不是静默联网。理由有两层：
 *
 * 1. **架构上自洽**：`watchlist` 的 networkHosts 是空的，它根本没有出网权限。
 * 2. **体验上更好**：加自选是"我自己知道要加什么"的操作，
 *    连不上网也该能用（数据源挂掉时自选列表仍然可用 —— MK18）。
 */
import * as LIMITS from '../../shared/limits.js';
import { resolveSymbol } from '../market/symbols.js';

/**
 * 自选股上限（PRD §5）—— 与 `market.scan` **共用同一个定义**（`shared/limits.js`）。
 */
export const WATCHLIST_LIMIT = LIMITS.WATCHLIST_LIMIT;

/** 存储 key：整存一个数组（见 SDD-market §6.2 的取舍说明） */
const ITEMS_KEY = 'items';

/**
 * @typedef {{ symbol: string, code: string, market: 'SH'|'SZ', kind: 'stock'|'index'|'fund',
 *             name: string, addedAt: number }} WatchItem
 */

/**
 * 读出自选列表。
 * @param {any} store
 * @returns {WatchItem[]}
 */
function readItems(store) {
  const raw = store.get(ITEMS_KEY);
  if (!Array.isArray(raw)) return [];
  // 防御：库里可能有旧版本写下的畸形数据
  return raw.filter(
    (/** @type {any} */ e) =>
      e && typeof e.symbol === 'string' && typeof e.code === 'string',
  );
}

/**
 * 写回自选列表。
 * @param {any} store
 * @param {WatchItem[]} items
 */
function writeItems(store, items) {
  store.set(ITEMS_KEY, items);
}

/**
 * 渲染成给模型看的 summary（必须简短，≤800）。
 *
 * ⚠️ 模型**只能从这里拿到名单**，所以它必须包含足够信息让模型回答
 * "我自选里有什么"，但**不含任何行情数值**（那要另外查，且要出网）。
 *
 * @param {WatchItem[]} items
 * @returns {string}
 */
function renderList(items) {
  if (items.length === 0) {
    return '自选股是空的。可以说「把茅台加进自选」来添加。';
  }
  const lines = items.map((it, i) => `${i + 1}. ${it.name}（${it.code}）`);
  return `自选股共 ${items.length} 支（上限 ${WATCHLIST_LIMIT}）：\n${lines.join('\n')}`;
}

/**
 * 解析用户给的 symbol，**只查本地**（自选表 + 内置种子表）。
 *
 * @param {string} raw
 * @param {WatchItem[]} items
 * @returns {{ ok: true, entry: { symbol: string, code: string, market: 'SH'|'SZ', kind: 'stock'|'index'|'fund', name: string } }
 *          | { ok: false, message: string, candidates: Array<{ name: string, code: string }> }}
 */
function resolveLocal(raw, items) {
  // 把已加过的自选也当作"本地表"传给解析器（优先级最高）
  const localEntries = items.map((it) => ({
    symbol: it.symbol,
    code: it.code,
    market: it.market,
    kind: it.kind,
    name: it.name,
  }));

  const r = resolveSymbol(raw, { localEntries });
  if (r.ok) {
    return {
      ok: true,
      entry: {
        symbol: r.entry.symbol,
        code: r.entry.code,
        market: r.entry.market,
        kind: r.entry.kind ?? 'stock',
        name: r.entry.name,
      },
    };
  }
  return {
    ok: false,
    message: r.message,
    candidates: r.candidates.map((c) => ({ name: c.name, code: c.code })),
  };
}

/**
 * 技能入口。
 *
 * @param {{ action: 'add'|'remove'|'list', symbol?: string }} args
 * @param {{ store: any }} ctx
 * @returns {Promise<{ ok: true, summary: string, data?: unknown } | { ok: false, code: string, message: string }>}
 */
export async function run(args, ctx) {
  const store = ctx?.store;
  if (!store) {
    // 结构上的失败：runner 一定会注入 store，没注入说明调用方式错了
    return { ok: false, code: 'INTERNAL', message: '缺少 ctx.store，无法读写自选股。' };
  }

  const items = readItems(store);

  // ---------------------------------------------------------------- list
  if (args.action === 'list') {
    return {
      ok: true,
      summary: renderList(items),
      // 名单也走 data —— PRD §8 的自选名单视图读它，**不需要重新出网**
      data: { items },
    };
  }

  const rawSymbol = typeof args.symbol === 'string' ? args.symbol.trim() : '';
  if (rawSymbol === '') {
    return {
      ok: false,
      code: 'BAD_ARGS',
      message: `action=${args.action} 需要告诉我要操作哪支股票。`,
    };
  }

  const resolved = resolveLocal(rawSymbol, items);
  if (!resolved.ok) {
    const hint =
      resolved.candidates.length > 0
        ? `你是说：${resolved.candidates.map((c) => `${c.name}(${c.code})`).join('、')}？`
        : '本地表里找不到这支。';
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: `${resolved.message}${hint ? ` ${hint}` : ''}`,
    };
  }
  const entry = resolved.entry;

  // ---------------------------------------------------------------- add
  if (args.action === 'add') {
    // 去重幂等：已存在不算错（PRD §5「同一支重复添加视为幂等」）
    const existing = items.find((it) => it.symbol === entry.symbol);
    if (existing) {
      return {
        ok: true,
        summary: `${existing.name}（${existing.code}）已经在自选里了，共 ${items.length} 支。`,
        data: { items },
      };
    }

    if (items.length >= WATCHLIST_LIMIT) {
      return {
        ok: false,
        code: 'BAD_ARGS',
        message: `自选股最多 ${WATCHLIST_LIMIT} 支，已经满了。先删掉一支再加吧。`,
      };
    }

    const next = [
      ...items,
      {
        symbol: entry.symbol,
        code: entry.code,
        market: entry.market,
        kind: entry.kind,
        name: entry.name,
        addedAt: Date.now(),
      },
    ];
    writeItems(store, next);
    return {
      ok: true,
      // 措辞要让用户**立刻确认加对了哪一支**（这是 L1.5 "结果可见" 的落点）
      summary: `已把 ${entry.name}（${entry.code}）加入自选，现在共 ${next.length} 支。`,
      data: { items: next },
    };
  }

  // ---------------------------------------------------------------- remove
  if (args.action === 'remove') {
    const idx = items.findIndex((it) => it.symbol === entry.symbol);
    if (idx === -1) {
      return {
        ok: true,
        // 删一个本来就不在的 —— 幂等，不算错
        summary: `${entry.name}（${entry.code}）本来就不在自选里，共 ${items.length} 支。`,
        data: { items },
      };
    }
    const next = items.filter((_, i) => i !== idx);
    writeItems(store, next);
    return {
      ok: true,
      summary: `已把 ${entry.name}（${entry.code}）移出自选，现在共 ${next.length} 支。`,
      data: { items: next },
    };
  }

  return {
    ok: false,
    code: 'BAD_ARGS',
    message: `不认识的 action：${String(args.action)}`,
  };
}
