/**
 * 「数字溯源」检查（评审 T-3）。
 *
 * ## 为什么需要它
 *
 * PRD-market §2.1 与 §12 反复强调：**数字只能来自工具**，模型不得编造或"估算"。
 * 这是本功能最容易幻觉的地方 —— LLM 看到 `RSI 28` 就爱顺手补一句
 * "28 附近有支撑"，那个"支撑"没有任何数据来源。
 *
 * 关键词黑名单（`prompts.js` 的 `scanResponse`）抓的是**措辞**；
 * 本模块抓的是**数字**。两者互补，都必要。
 *
 * ## 判定规则
 *
 * 答案里出现的每个数字，必须在**工具返回的事实文本**里找得到出处。
 * 为了不误报，允许三类"可由事实推出"的数字：
 *
 * 1. **原样出现**（含千分位差异）
 * 2. **四舍五入 / 截断**的变体（`1680.0` ↔ `1680`、`1680.00`）
 * 3. **由事实中的两个数算出的比率**（涨跌幅 = (现价−昨收)/昨收）
 *
 * 超出这三类的数字就是**可疑的** —— 需要人工看一眼。
 *
 * ⚠️ 它**不是**证明"没幻觉"，而是"把可疑点缩小到可人工复核的范围"。
 *
 * ## 已排除的噪声
 *
 * 日期（`2026-09-11`）整体作为一个 token，不拆成年/月/日去比对，
 * 否则 `2026` 会被当成一个需要溯源的独立数字。
 */

/** 从文本里抽取数字 token；日期作为一个整体 */
const TOKEN_RE = /\d{4}-\d{2}-\d{2}|\d+(?:\.\d+)?/g;

/**
 * @param {string} text
 * @returns {string[]} 数字 token（保持出现顺序，去重）
 */
export function extractNumbers(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const m of text.match(TOKEN_RE) ?? []) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

/**
 * 判断 `token` 是否能由 `allowed` 里的某个数字"合理得出"。
 *
 * @param {string} token
 * @param {number[]} allowedValues
 * @param {Set<string>} allowedRaw 事实文本里原样出现的字符串形式
 * @returns {boolean}
 */
function isDerivable(token, allowedValues, allowedRaw) {
  if (allowedRaw.has(token)) return true;

  const n = Number(token);
  if (!Number.isFinite(n)) return false;

  for (const a of allowedValues) {
    // 四舍五入到 0–3 位小数的变体
    for (let d = 0; d <= 3; d++) {
      if (Math.abs(n - Number(a.toFixed(d))) < 1e-9) return true;
    }
    // 百分比形式：事实是 0.0123，答案写 1.23%
    if (Math.abs(n - a * 100) < 1e-6) return true;
    // 反向：事实是 1.23，答案写 1.23%（同一个数）
    if (Math.abs(n - a) < 1e-9) return true;
  }

  // 由两个事实数算出的比率（涨跌幅是最常见的）
  for (let i = 0; i < allowedValues.length; i++) {
    for (let j = 0; j < allowedValues.length; j++) {
      if (i === j) continue;
      const base = allowedValues[i];
      const cur = allowedValues[j];
      if (base === 0) continue;
      const pct = ((cur - base) / base) * 100;
      if (Math.abs(n - Number(pct.toFixed(2))) < 1e-6) return true;
      if (Math.abs(n - Number(pct.toFixed(1))) < 1e-6) return true;
    }
  }

  return false;
}

/**
 * 检查答案里的数字是否都能溯源。
 *
 * @param {string} answer 模型输出
 * @param {string} facts 工具返回的事实文本（`summary`）
 * @returns {{ ok: boolean, untraceable: string[], checked: number }}
 */
export function checkProvenance(answer, facts) {
  const factTokens = extractNumbers(facts ?? '');
  const allowedRaw = new Set(factTokens);
  const allowedValues = factTokens
    .filter((t) => !t.includes('-') || !/^\d{4}-\d{2}-\d{2}$/.test(t))
    .map(Number)
    .filter((n) => Number.isFinite(n));

  const answerTokens = extractNumbers(answer ?? '');
  const untraceable = answerTokens.filter((t) => {
    // 日期：只要事实里有同一天就算溯源（年/月/日不单独比对）
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return !allowedRaw.has(t);
    return !isDerivable(t, allowedValues, allowedRaw);
  });

  return { ok: untraceable.length === 0, untraceable, checked: answerTokens.length };
}
