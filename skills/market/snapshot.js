/**
 * 组装「状况说明书」的结构与 summary 渲染（SDD-market §4.3、§5.5）。
 *
 * ## 本模块的边界
 *
 * **不做判断、不写建议** —— 只把数字摆出来（PRD §2.1 的事实层）。
 * 任何"偏高/偏低/该不该买"都是**禁止输出**（PRD §2.3）。
 *
 * ## summary 预算（§5.5 + 评审 C-3 / D-4）
 *
 * - `SUMMARY_LIMIT`（800，定义在 `shared/limits.js`），判定基准是 **`String.length`（UTF-16 码元）**，
 *   **不是字节数**。中文一字 3 字节，按字节算会超标 3 倍。
 * - **列必须固定**：原稿"先去掉量比列、再去掉区间位置列"会让列数变化，
 *   模型可能把第 5 列当成第 4 列读错。所以降级**只减行、不减列**。
 * - **绝不**把某一行截成半句。
 */
import * as LIMITS from '../../shared/limits.js';

/**
 * summary 上限 —— 与 `runner.js` 的**截断值共用同一个定义**（`shared/limits.js`）。
 *
 * ⚠️ 不要在这里写字面量：本模块负责**排版**，runner 负责**截断**；
 * 两边不一致就会出现"表格以为放得下、实际被截掉"。
 */
export const SUMMARY_LIMIT = LIMITS.SUMMARY_LIMIT;

/** `scan` 表格的固定列（顺序即语义，**不许按需删列**） */
export const SCAN_COLUMNS = Object.freeze(['name', 'price', 'changePct', 'rsi', 'rangePos', 'volRatio']);

/**
 * 修剪小数位，避免 `1680.0000000001` 这种噪声进入 summary。
 * @param {number | null | undefined} v
 * @param {number} digits
 * @returns {string}
 */
function fmt(v, digits) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-';
  return v.toFixed(digits);
}

/**
 * 带符号的百分比。
 * @param {number | null | undefined} v
 * @returns {string}
 */
function fmtPct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/**
 * 按显示宽度补齐（中文按 2 计），让表格在等宽字体下大致对齐。
 *
 * ⚠️ 这里**只影响观感**，不影响预算判定 —— 预算一律用 `String.length`。
 * @param {string} s
 * @param {number} width
 * @returns {string}
 */
function pad(s, width) {
  let w = 0;
  for (const ch of s) w += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, width - w));
}

/**
 * 把一组 cell 按列对齐渲染成表格。
 *
 * 列宽**按本批数据的实际宽度自适应** —— 固定列宽会在"名字都很短"时浪费预算
 * （20 只小名字本该放得下，固定 8 宽只放下 17 只）。
 *
 * \u26a0\ufe0f 自适应只影响**排版权宽**，不影响"列固定"这条规则：列数与列序永远不变。
 *
 * @param {Array<Array<string>>} rows 第一行视为表头
 * @param {readonly number[]} minWidths 每列的最小显示宽度
 * @returns {string[]}
 */
function renderTable(rows, minWidths) {
  if (rows.length === 0) return [];
  const cols = rows[0].length;
  /** @type {number[]} */
  const widths = [];
  for (let c = 0; c < cols; c++) {
    let w = minWidths[c] ?? 0;
    for (const r of rows) w = Math.max(w, displayWidth(r[c] ?? ''));
    widths.push(w);
  }
  return rows.map((r) =>
    r
      .map((cell, c) => (c === cols - 1 ? cell : pad(cell ?? '', widths[c])))
      .join(' ')
      .trimEnd(),
  );
}

/**
 * 字符串的显示宽度（CJK 记 2）
 * @param {string} s
 * @returns {number}
 */
function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return w;
}

/**
 * 单只股票的一行（`scan` 表格）。
 *
 * \u26a0\ufe0f **列序固定**：名称、现价、涨跌、RSI、年位置、量比。
 * 降级时**只减行，不减列**（评审 D-4）——否则模型会把第 5 列当成第 4 列读。
 *
 * @param {ScanRow} row
 * @returns {string[]} 六个 cell（未对齐）
 */
export function scanRowCells(row) {
  return [
    String(row.name ?? '-'),
    fmt(row.price, 2),
    fmtPct(row.changePct),
    fmt(row.rsi, 0),
    row.rangePos === null || row.rangePos === undefined ? '-' : `${fmt(row.rangePos, 0)}%`,
    fmt(row.volRatio, 2),
  ];
}

/**
 * 单只股票的一行（已按默认最小宽度对齐）。
 * @param {ScanRow} row
 * @returns {string}
 */
export function renderScanRow(row) {
  return renderTable([scanRowCells(row)], SCAN_MIN_WIDTHS)[0];
}

/** `scan` 表格各列的最小显示宽度（顺序与 `scanRowCells` 一致） */
export const SCAN_MIN_WIDTHS = Object.freeze([8, 7, 7, 4, 5, 4]);

/**
 * @typedef {{ name: string, code?: string, price: number | null, changePct: number | null,
 *             rsi: number | null, rangePos: number | null, volRatio: number | null,
 *             insufficient?: string[] }} ScanRow
 */

/**
 * 省略说明的行（长度会随数字变化，所以计算时用当前准确值）
 * @param {number} n
 * @returns {string}
 */
function omittedNote(n) {
  return `（另有 ${n} 只未显示，用 overview 单查）`;
}

/**
 * 渲染 `scan` 的紧凑表格。
 *
 * ## 降级策略：**只减行，不减列**
 *
 * 1. 列固定（表头固定输出）
 * 2. 超限时按**涨跌幅绝对值从大到小**保留前 N 行（信息量最大的优先）
 * 3. 末尾加一行说明省略了几只，并指向 `overview`
 *
 * ## 打包逻辑（这里修过一个 bug）
 *
 * 第一版在循环里用"当前省略数"预留尾部空间，导致**预留量随行数变化**，
 * 结果 769/800 的预算下只放下了 14 行。改成**两遍法**：
 *
 * 1. 假设全部放得下 → 得到 `n0`
 * 2. 用 `n0` 算出真实的尾部长度 → 重新算能放几行
 *
 * 由于尾部长度只随省略数**变小**（省略越少尾巴越短），最多两轮就稳定。
 *
 * @param {ScanRow[]} rows
 * @param {{ limit?: number, dataDate?: string | null }} [opts]
 * @returns {{ summary: string, shown: number, omitted: number, truncated: boolean }}
 */
export function renderScanSummary(rows, opts = {}) {
  const limit = opts.limit ?? SUMMARY_LIMIT;
  const HEADER_CELLS = ['名称', '现价', '涨跌', 'RSI', '年位置', '量比'];

  const dateLine = opts.dataDate ? `数据截至 ${opts.dataDate} 收盘` : '';

  if (rows.length === 0) {
    return {
      summary: `${dateLine}\n自选股是空的。`.trim(),
      shown: 0,
      omitted: 0,
      truncated: false,
    };
  }

  // 按 |涨跌幅| 降序 —— 降级时优先保住"动得最厉害"的几只
  const ordered = [...rows].sort(
    (a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0),
  );

  /**
   * 用**前 n 行**渲染整张表（这样列宽只取决于真正展示的那几行，不浪费预算）。
   * @param {number} n
   * @returns {{ text: string, lines: number }}
   */
  const renderFirst = (n) => {
    const body = ordered.slice(0, n).map(scanRowCells);
    const table = renderTable([HEADER_CELLS, ...body], SCAN_MIN_WIDTHS);
    const head = dateLine ? `${dateLine}\n${table[0]}` : table[0];
    const rest = table.slice(1).join('\n');
    return { text: rest ? `${head}\n${rest}` : head, lines: n };
  };

  // 两遍法：先假设全放得下，再按真实省略数留尾巴（尾巴只会变短，两轮即稳定）
  let shown = rows.length;
  for (let pass = 0; pass < 3; pass++) {
    const { text } = renderFirst(shown);
    const omitted = rows.length - shown;
    const tail = omitted > 0 ? `\n${omittedNote(omitted)}` : '';
    if (text.length + tail.length <= limit) break;
    // 还超 → 按平均行宽估算该减几行（至少减 1，避免死循环）
    const avg = text.length / Math.max(1, shown + 1);
    const excess = text.length + tail.length - limit;
    const cut = Math.max(1, Math.ceil(excess / Math.max(1, avg)));
    shown = Math.max(1, shown - cut);
  }

  // 用最终 shown 重新渲染一次，保证列宽与内容一致
  const final = renderFirst(shown);
  const omitted = rows.length - shown;
  const summary = final.text + (omitted > 0 ? `\n${omittedNote(omitted)}` : '');

  return { summary, shown, omitted, truncated: omitted > 0 };
}

/**
 * 分位的中文读法（评审 B-2 硬性要求）。
 *
 * `count(close ≤ P)/N` 表达的是"**近 N 日里有多少比例的日子收盘价低于当前价**"。
 * 返回 12 意味着当前价**偏低**；返回 87 意味着**偏高**。
 *
 * ⚠️ **不允许只把百分数丢给用户** —— 必须带这句中文。
 *
 * @param {number | null} pct
 * @param {number} [window]
 * @returns {string}
 */
export function describePercentile(pct, window = 250) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '-';
  return `近 ${window} 个交易日只有 ${pct.toFixed(0)}% 的收盘价低于当前价`;
}

/**
 * 区间位置的中文读法。
 * @param {number | null} pos
 * @param {{ min?: number, max?: number } | null} [range]
 * @returns {string}
 */
export function describeRangePosition(pos, range) {
  if (typeof pos !== 'number' || !Number.isFinite(pos)) return '-';
  const base = `处于近 250 个交易日的 ${pos.toFixed(0)}% 区间位置`;
  if (range && typeof range.min === 'number' && typeof range.max === 'number') {
    return `${base}（区间 ${range.min.toFixed(2)}–${range.max.toFixed(2)}）`;
  }
  return base;
}

/**
 * 渲染单只股票的「状况说明书」（`overview`）。
 *
 * ⚠️ 只输出**事实层**：数字 + 客观分位/位置。**不写任何买卖建议**（PRD §2.3）。
 *
 * @param {{
 *   name?: string, code?: string, dataDate?: string | null, source?: string,
 *   price: number | null, prevClose?: number | null,
 *   ma: Record<string, number | null>,
 *   rsi: number | null,
 *   macd: { dif: number, dea: number, histogram: number } | null,
 *   volumeRatio: number | null,
 *   rangePosition: number | null,
 *   percentile: number | null,
 *   volatility: number | null,
 *   samples: number,
 *   insufficient: string[],
 *   unreliable?: string[],
 * }} s
 * @returns {{ summary: string, truncated: boolean }}
 */
export function renderOverview(s) {
  const limit = SUMMARY_LIMIT;
  /** @type {string[]} */
  const lines = [];

  lines.push(`${s.name}（${s.code}）`);
  if (s.dataDate) lines.push(`数据截至 ${s.dataDate} 收盘`);

  // 价与涨跌
  const prevClose = s.prevClose ?? null;
  const change =
    s.price !== null && prevClose !== null && prevClose !== 0
      ? (s.price / prevClose - 1) * 100
      : null;
  lines.push(`现价 ${fmt(s.price, 2)}　涨跌 ${fmtPct(change)}`);

  // 均线关系
  const maParts = Object.entries(s.ma)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
    .map(([k, v]) => `${k.toUpperCase()} ${fmt(/** @type {number} */ (v), 2)}`);
  if (maParts.length > 0) lines.push(`均线 ${maParts.join('　')}`);

  if (typeof s.rsi === 'number') {
    lines.push(`RSI(14) ${fmt(s.rsi, 1)}`);
  }
  if (s.macd) {
    lines.push(
      `MACD DIF ${fmt(s.macd.dif, 3)}　DEA ${fmt(s.macd.dea, 3)}　柱 ${fmt(s.macd.histogram, 3)}`,
    );
  }
  if (s.rangePosition !== null) {
    lines.push(describeRangePosition(s.rangePosition, null));
  }
  if (s.percentile !== null) {
    lines.push(describePercentile(s.percentile));
  }
  if (s.volumeRatio !== null) {
    lines.push(`量比 ${fmt(s.volumeRatio, 2)}（对前 20 日均量）`);
  }
  if (s.volatility !== null) {
    lines.push(`年化波动率 ${(s.volatility * 100).toFixed(1)}%`);
  }

  if (s.insufficient.length > 0) {
    lines.push(`样本不足：${s.insufficient.join('；')}`);
  }
  // 第二档：算得出来但样本偏短 —— 必须提示，否则用户会以为这些数值同样可信
  if (Array.isArray(s.unreliable) && s.unreliable.length > 0) {
    lines.push(`样本偏短、数值相对不可靠：${s.unreliable.join('；')}`);
  }

  let summary = lines.join('\n');
  let truncated = false;
  if (summary.length > limit) {
    // 逐行丢（保留前面更重要的行），绝不在行中间切断
    while (lines.length > 1 && lines.join('\n').length > limit) lines.pop();
    summary = lines.join('\n');
    truncated = true;
  }

  return { summary, truncated };
}
