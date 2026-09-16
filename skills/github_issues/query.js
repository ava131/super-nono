/**
 * 查询拼装 —— **纯函数，可完全离线单测**（PRD-issues §3 / SDD-issues §5.2）。
 *
 * 拆成独立文件的理由和 `market/snapshot.js` 一样：这里是**最容易出错的一环**
 * （查询语法、日期窗口、注入防护、长度上限、操作符预算），而它不需要网络就能验证到底。
 *
 * ## 这一层要挡住的东西
 *
 * `repos` 是**模型直接给的不可信输入**，而它会被拼进 GitHub 的搜索查询串。
 * 搜索查询串是有语法的：`repo:a/b updated:>2000-01-01` 里的空白就是分隔符。
 * 所以一旦允许空白和 `:` 进到 `repos` 里，就等于把查询语法交给了模型
 * （或被提示注入的内容）去改写 —— 详见 `known-domains.js` 的 `REPO_RE`。
 */

import { REPO_RE } from './known-domains.js';

/**
 * 一次查询最多带几个仓库。超过**拒绝**而不是悄悄截断（理由见 `validateRepos`）。
 *
 * 实测：5 个仓库 + 2 个 `excludeLabels` 仍然返回 `200`（见 §操作符预算），
 * 所以这个上限不是被操作符卡住的。
 */
export const MAX_REPOS = 5;

/**
 * 一次查询最多带几个排除标签。
 *
 * 这个上限存在的理由是**操作符预算**，不是为了省字符（见文件末尾的实测记录）。
 */
export const MAX_EXCLUDE_LABELS = 2;

/**
 * 一次请求固定取多少条。
 *
 * ⚠️ **它不等于 `limit`。**（评审 Q7-3）
 *
 * - `per_page` = `DISPLAY_COUNT`：**固定 10**，同一次请求的配额不变
 * - `limit`（1–5）：只控制**模型可见的叙述条数**，在排版时生效
 *
 * 好处：缓存键里**不再有 `limit`** —— 否则同一个领域会因为"叙述 3 条还是 5 条"
 * 而重复出网，白白烧掉 10 次/分钟的配额。气泡展示的条数也由它决定。
 */
export const DISPLAY_COUNT = 10;

/** `limit` 的上下限，与 `skill.json` 的 `minimum`/`maximum` 必须一致 */
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 5;
export const DEFAULT_LIMIT = 5;

/** `windowDays` 的上下限，与 `skill.json` 必须一致 */
export const MIN_WINDOW_DAYS = 1;
export const MAX_WINDOW_DAYS = 30;
export const DEFAULT_WINDOW_DAYS = 7;

/**
 * 评论数下限（评审 Q6，PM 裁定）。
 *
 * 口径因此从「最近**有更新**」变成「最近**有人讨论**」——**所有文案必须同步改**，
 * 否则 summary 写着"最近有更新"而实际把 0 评论的更新全滤掉了，
 * 又是一个"看起来正常的错答案"。
 *
 * ⚠️ 它**不能替代** `-label:` 过滤：实测样本 `[Tracking] CI Test Failures and Fixes`
 * 有 **14 条评论**，会直接穿过这个下限。
 *
 * 代价（实测）：种子仓库 7 天窗下 `total_count` 从 **699 降到 508**（滤掉 27%）。
 * 被滤掉的包含"刚爆出来、还没人回"的真问题——这是 PM 明确接受过的取舍。
 */
export const COMMENTS_FILTER = 'comments:>0';

/**
 * 查询串长度上限。
 *
 * **官方明文**（不再是"未验证"）：GitHub 文档《Troubleshooting search queries》写明
 * "不支持长度超过 256 个字符的查询"。与我们的最坏情况相比很宽松
 * （5 个 repo ≈ 125 字符 + 过滤条件 ≈ 60）。
 *
 * 超限时 GitHub 会返回 422，所以这里**先挡住并如实报错**，绝不静默截断查询
 * ——截断查询 = 搜了别的东西还假装搜对了，而这正是本技能最危险的失败模式。
 */
export const MAX_QUERY_CHARS = 256;

/**
 * 查询里允许的 AND/OR/NOT 操作符估算上限。
 *
 * 官方明文说"无法使用超过五个 AND、OR 或 NOT 运算符"，但**实测重复的 `repo:` 限定符
 * 并不按预期计数**：
 *
 * ```
 * 3 repo + 1 label                → 200
 * 5 repo + 2 label                → 200   ← 估算 4 OR + 2 NOT = 6，官方上限是 5，但没失败
 * 5 repo + 0 label                → 200
 * 3 repo + 1 label + comments:>0  → 200
 * ```
 *
 * 所以保留一个**宽松的**断言（防止将来有人把 `repos` 上限调到很大），
 * 而不是按官方那句"5 个"去卡——那会误伤我们已经验证过可用的配方。
 */
export const MAX_OPERATOR_BUDGET = 6;

/**
 * 估算查询里的操作符个数：`repo:` 之间是隐式 OR，`-label:` 是 NOT。
 *
 * @param {number} repoCount
 * @param {number} excludeLabelCount
 * @returns {number}
 */
export function estimateOperators(repoCount, excludeLabelCount) {
  return Math.max(0, repoCount - 1) + excludeLabelCount;
}

/**
 * 校验模型给的 `repos`。
 *
 * **任何一项不合法就拒绝整次调用**，而不是丢掉落继续跑：
 * 丢掉会变成"搜了 5 个仓库"而用户以为搜了 8 个 —— 又一个静默降级。
 * 这跟 `skill.json` 里 `limit` 用 `maximum:5` 让校验器直接拒绝是同一个立场。
 *
 * @param {unknown} raw
 * @returns {{ ok: true, repos: string[] } | { ok: false, error: string }}
 */
export function validateRepos(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: 'repos 必须是数组' };

  /** @type {string[]} */
  const out = [];
  for (const r of raw) {
    if (typeof r !== 'string' || !REPO_RE.test(r)) {
      return { ok: false, error: `repos 里的写法不合法（应为 owner/repo）：${JSON.stringify(r)}` };
    }
    if (!out.includes(r)) out.push(r); // 去重：重复项只会浪费查询串长度预算
  }

  if (out.length === 0) return { ok: false, error: 'repos 不能是空数组' };
  if (out.length > MAX_REPOS) {
    return { ok: false, error: `repos 最多 ${MAX_REPOS} 个，收到 ${out.length} 个` };
  }
  return { ok: true, repos: out };
}

/**
 * 算出 `updated:>` 用的日期（UTC 日历日）。
 *
 * ⚠️ **已知误差**：`toISOString()` 是 UTC，与本地日历日最多差一天（跨时区时）。
 * 记录在案、不做修正 —— 修正要引入时区参数，而收益只是"边界日多/少一条"。
 *
 * @param {number} now
 * @param {number} windowDays
 * @returns {string} `YYYY-MM-DD`
 */
export function windowStartDate(now, windowDays) {
  return new Date(now - windowDays * 86400000).toISOString().slice(0, 10);
}

/**
 * 拼 GitHub 的搜索查询串。
 *
 * `now` 显式传入是为了**可测**（评审 B1/B8）：内部直接用 `Date.now()` 的话，
 * 断言查询串的测试会在跨零点/跨时区时偶发失败。
 *
 * @param {{ repos: string[], windowDays: number, excludeLabels?: string[], now?: number }} p
 * @returns {string}
 */
export function buildQuery({ repos, windowDays, excludeLabels = [], now = Date.now() }) {
  const since = windowStartDate(now, windowDays);
  const parts = [
    'is:issue', // ★ 必须：search/issues 端点默认**混入 PR**
    'state:open',
    ...repos.map((r) => `repo:${r}`),
    `updated:>${since}`,
    COMMENTS_FILTER, // ★ Q6：口径是"最近有人讨论"，不是"最近有更新"
    ...excludeLabels.slice(0, MAX_EXCLUDE_LABELS).map((l) => `-label:${l}`),
  ];
  return parts.join(' ');
}

/**
 * 拼完整请求 URL。
 *
 * @param {{ repos: string[], windowDays: number, excludeLabels?: string[], now?: number }} p
 * @returns {{ ok: true, url: string, query: string } | { ok: false, error: string }}
 */
export function buildSearchUrl({ repos, windowDays, excludeLabels = [], now = Date.now() }) {
  const trimmedLabels = excludeLabels.slice(0, MAX_EXCLUDE_LABELS);
  const query = buildQuery({ repos, windowDays, excludeLabels: trimmedLabels, now });

  // 长度守卫：如实报错，不截断（截断=搜了别的东西还假装搜对了）
  if (query.length > MAX_QUERY_CHARS) {
    return {
      ok: false,
      error: `查询串太长（${query.length} > ${MAX_QUERY_CHARS}），请减少仓库数量或缩短时间窗`,
    };
  }

  // 操作符预算守卫（见 MAX_OPERATOR_BUDGET 的实测记录）
  const ops = estimateOperators(repos.length, trimmedLabels.length);
  if (ops > MAX_OPERATOR_BUDGET) {
    return {
      ok: false,
      error: `查询的操作符太多（估算 ${ops} > ${MAX_OPERATOR_BUDGET}），请减少仓库或排除标签`,
    };
  }

  const params = new URLSearchParams({
    q: query,
    sort: 'updated',
    order: 'desc',
    // ★ 固定 10，与 limit 无关（评审 Q7-3）：一次请求的配额不变，
    //   叙述条数由 limit 在排版时决定，气泡展示条数由这个常量决定
    per_page: String(DISPLAY_COUNT),
  });

  return { ok: true, url: `https://api.github.com/search/issues?${params.toString()}`, query };
}
