/**
 * `github_issues` 技能执行器（PRD-issues / SDD-issues §5，评审修订见 v0-review-20260916）。
 *
 * ## 这个技能只做一件事：把"领域"翻译成一个 GitHub 搜索请求，然后如实呈现结果
 *
 * **它不做分析、不做摘要、不做趋势判断**（PRD §2）。这不是偷懒，是信息量的诚实：
 * 模型能看到的只有 `summary`（≤800 字符），5 条 issue 的标题+元数据就吃掉 728，
 * 剩下的装不下任何可信的推断。
 *
 * ## 四条不变式
 *
 * 1. **猜错的领域一次请求都不发**（`NEED_DOMAIN`）——猜错的失败模式是"看起来正常的
 *    错误答案"，而 `topic:` 搜索实测就会这样（PRD §4.1）
 * 2. **仓库名不存在时必须明说**（评审 B1）——GitHub 搜索对不存在的 `repo:` **不报错**，
 *    只返回 0 条；不说清楚就会退化成"最近没有更新"这句假话
 * 3. **非 200 绝不表述成"没找到"**，而且没有可信恢复时间时**不许编秒数**（评审 B4）
 * 4. **`data` 是给气泡与调试看的无损通道**——summary 是对模型的摘要（有损），
 *    data 保留全量 `DISPLAY_COUNT` 条（评审 Q7）
 */

import { createHash } from 'node:crypto';

import {
  DOMAINS,
  domainListForModel,
  repoNamesForModel,
  resolveDomain,
  resolveRepoAlias,
} from './known-domains.js';
import {
  DEFAULT_LIMIT,
  DEFAULT_WINDOW_DAYS,
  DISPLAY_COUNT,
  MAX_LIMIT,
  MAX_WINDOW_DAYS,
  MIN_LIMIT,
  MIN_WINDOW_DAYS,
  buildSearchUrl,
  validateRepos,
} from './query.js';
import { formatDomainList, formatSummary } from './format.js';
import { FAILURE_WORDING } from './prompts.js';

/** 缓存有效期。GitHub 的配额按出口 IP 计、**重启 app 不重置**，所以缓存要持久（PRD §7.3）。 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** GitHub 要求带 User-Agent，不带可能被直接拒绝 */
const USER_AGENT = 'super-nono/0.1.0';

/**
 * 固定 API 版本（评审 B5b）。
 *
 * GitHub 明确建议带上，否则上游的默认行为可能**静默变更**——
 * 对一个靠返回字段名（`repository_url` / `incomplete_results`）工作的技能来说，
 * 静默变更就是静默出错。
 */
const API_VERSION = '2022-11-28';

/**
 * 技能自己的单请求超时。
 *
 * **必须小于** `skill.json` 的 `timeoutMs`（15000）——否则会先被 runner 硬杀成
 * `TIMEOUT`，用户拿到一句没有上下文的"执行超时"，而不是我们精心写的结构化错误（评审 B5d）。
 */
const REQUEST_TIMEOUT_MS = 12000;

/** 核心 API 的单请求超时（只用于仓库存在性校验，请求很小） */
const CORE_TIMEOUT_MS = 5000;

/**
 * 未收录领域 / 没给领域时的提示语。
 *
 * 这条路径**不发任何请求** —— 既是省配额，也是因为"猜一个仓库去搜"是错的。
 * 清单排版走 `formatDomainList`，它**自己保证 ≤800**（评审 B3，runner 的 slice 是静默的）。
 *
 * @returns {{ ok: false, code: string, message: string }}
 */
function needDomainMessage() {
  return {
    ok: false,
    code: 'NEED_DOMAIN',
    message: formatDomainList(DOMAINS, repoNamesForModel()),
  };
}

/**
 * 缓存 key 的前缀。带版本号是为了将来**改 key 语义时能整体失效旧缓存**。
 */
const CACHE_KEY_PREFIX = 'gh:v2';

/**
 * 构造缓存 key。
 *
 * ⚠️ **这必须是「按构造就合法」的**——`ctx.store` 会拿 `checkKey()` 校验：
 *
 * ```
 * KEY_PATTERN = /^[A-Za-z0-9_:.-]{1,64}$/     ← 只允许 字母 数字 _ : . - ，且 ≤64 字符
 * ```
 *
 * 而仓库名里带 `/`、逗号、竖线，**全都非法**。踩过这个坑：最初直接
 * `[domainId, repos.join(','), …].join('|')`，结果**每一次缓存读写都被拒**，
 * 而缓存失败按设计是被吞掉的 —— 于是缓存 **100% 静默失效**
 * （实测 SDD 原键长 **93 字符**，远超 64）。
 *
 * ⚠️ **键里没有 `limit`**（评审 Q7-3）：一次请求固定取 `DISPLAY_COUNT` 条，
 * `limit` 只在排版时生效；把 `limit` 放进键会让同一个领域因为"叙述 3 条还是 5 条"
 * 而重复出网，白白烧掉 10 次/分钟的配额。
 *
 * @param {string} domainId
 * @param {string[]} repos
 * @param {string[]} excludeLabels
 * @param {number} windowDays
 * @returns {string}
 */
export function cacheKey(domainId, repos, excludeLabels, windowDays) {
  const variant = createHash('sha256')
    .update(`${repos.join(',')}|${excludeLabels.join(',')}`)
    .digest('hex')
    .slice(0, 12);
  return [CACHE_KEY_PREFIX, domainId, windowDays, variant].join(':');
}

/**
 * 把参数夹到合法范围。
 *
 * 必须自己做：校验器**不支持 `default`**（`schema.js:180` 只支持 7 个关键字），
 * 模型不传 `limit` 时 `checked.value.limit` 是 `undefined` → `per_page=undefined`（评审 A4）。
 *
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampInt(raw, fallback, min, max) {
  const n = Number.isFinite(raw) ? /** @type {number} */ (raw) : fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * @param {{ store?: { cache?: { get: (k: string) => any, put: (k: string, v: unknown) => void } } }} ctx
 * @param {string} key
 * @returns {any | null}
 */
function readCache(ctx, key) {
  try {
    const hit = ctx.store?.cache?.get(key);
    if (!hit || typeof hit !== 'object') return null;
    if (typeof hit.at !== 'number' || Date.now() - hit.at >= CACHE_TTL_MS) return null;
    return hit;
  } catch {
    return null; // 缓存读失败不能影响正确性
  }
}

/**
 * 写缓存 —— **失败必须被吞掉**。缓存是优化，不是正确性。
 *
 * > ⚠️ 这个"吞掉"曾经掩盖过一个让缓存 **100% 失效**的 bug（key 不合法）。
 * > 所以配套要求：**必须有一条穿过真实 `checkKey()` 的测试**（见 T21）。
 *
 * @param {any} ctx
 * @param {string} key
 * @param {any} value
 */
function writeCache(ctx, key, value) {
  try {
    ctx.store?.cache?.put(key, value);
  } catch {
    // 有意吞掉：写不进缓存不该让一次成功的查询变成失败
  }
}

/**
 * 校验仓库是否**真实存在**（评审 B1）。
 *
 * ## 为什么非做不可
 *
 * GitHub 的**搜索**对不存在的 `repo:` **不报错**，只是安静地返回 `total_count: 0`。
 * 于是用户把仓库名打错一个字母，得到的回答是「这 3 个仓库最近 7 天没有更新」——
 * **一句彻头彻尾的假话**，而且正是 PRD 自己列为最高优先级的 R1
 *（"静默返回错误答案"）在 repos 路径上的原样复发。
 *
 * ## 为什么用 core 配额
 *
 * `GET /repos/{owner}/{repo}` 走的是 **core 资源，与 search 相互独立**
 * （响应头 `x-ratelimit-resource` 可区分），**不抢那 10 次/分钟**。
 * 未认证的 core 是 60 次/小时，而 `repos` 最多 5 个 → 一次最多 5 次。
 *
 * ## 三条状态，绝不能混
 *
 * - `exists: true` / `false` —— 已确认
 * - `exists: null` —— **校验不了**（core 也限流了）。这时**不许**说"仓库不存在"，
 *   要把"校验不了"和"不存在"分开措辞
 *
 * @param {string[]} repos
 * @param {any} ctx
 * @returns {Promise<{ full: string, exists: boolean | null, status: number | null }[]>}
 */
async function checkReposExist(repos, ctx) {
  /** @type {{ full: string, exists: boolean | null, status: number | null }[]} */
  const out = [];
  for (const full of repos) {
    try {
      const res = await ctx.safeFetch(`https://api.github.com/repos/${full}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': USER_AGENT,
          'X-GitHub-Api-Version': API_VERSION,
        },
        signal: ctx.signal,
        timeoutMs: CORE_TIMEOUT_MS,
      });
      out.push({ full, exists: res.status === 200, status: res.status });
    } catch {
      // 网络/限流导致校验失败 —— 这是"不知道"，不是"不存在"
      out.push({ full, exists: null, status: null });
    }
  }
  return out;
}

/**
 * 把 GitHub 的 issue 对象映射成本技能的形状。
 *
 * @param {any} it
 * @returns {{ repo: string, number: number, title: string, url: string,
 *             comments: number, updatedAt: string, labels: string[] } | null}
 */
function mapItem(it) {
  if (!it || typeof it !== 'object') return null;
  const repo =
    typeof it.repository_url === 'string'
      ? it.repository_url.replace('https://api.github.com/repos/', '')
      : '';
  if (repo === '' || !Number.isFinite(it.number) || typeof it.html_url !== 'string') return null;
  return {
    repo,
    number: it.number,
    title: typeof it.title === 'string' ? it.title : '',
    url: it.html_url,
    comments: Number.isFinite(it.comments) ? it.comments : 0,
    updatedAt: typeof it.updated_at === 'string' ? it.updated_at : '',
    labels: Array.isArray(it.labels)
      ? it.labels
          .map((/** @type {any} */ l) => (typeof l === 'string' ? l : l?.name))
          .filter((/** @type {unknown} */ n) => typeof n === 'string')
      : [],
  };
}

/**
 * 把 HTTP 状态翻译成结构化错误 —— **不许把任何非 200 说成"没找到"**。
 *
 * 403 分三种（评审 B4）：只有**主限流**（`remaining === 0` 且 `reset` 有效）
 * 才有资格报秒数；次级限流与风控**没有可信数字，不许编**。
 *
 * @param {Response} res
 * @param {string} query
 * @returns {{ ok: false, code: string, message: string }}
 */
function httpError(res, query) {
  if (res.status === 403 || res.status === 429) {
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const nowSec = Math.floor(Date.now() / 1000);

    // ① 主限流：remaining 明确为 0 且 reset 在未来 —— 这个秒数可信
    if (remaining === 0 && Number.isFinite(reset) && reset > nowSec) {
      return { ok: false, code: 'RATE_LIMITED', message: FAILURE_WORDING.rate_limited(reset - nowSec) };
    }
    // ② 次级限流：带 retry-after —— 用它，但这是"建议等待"，措辞保持中性
    const retryAfter = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return { ok: false, code: 'RATE_LIMITED', message: FAILURE_WORDING.rate_limited(retryAfter) };
    }
    // ③ 风控 / abuse：没有可信时间 —— **绝不编一个秒数**
    return { ok: false, code: 'RATE_LIMITED', message: FAILURE_WORDING.rejected };
  }
  if (res.status === 422) {
    // 422 = 查询串本身有问题。这是**我们的 bug**，绝不能报成"没找到"
    return { ok: false, code: 'INTERNAL', message: FAILURE_WORDING.bad_query(query) };
  }
  return {
    ok: false,
    code: 'INTERNAL',
    message: `GitHub 返回了 HTTP ${res.status}。`,
  };
}

/**
 * 0 结果时的说明。
 *
 * ⚠️ 口径必须是「最近**有人讨论**」而不是「最近有更新」——查询带了 `comments:>0`
 * （评审 Q6），所以**完全可能有更新但无人评论**，只字不提就是新的"看起来正常的错答案"。
 *
 * @param {string[]} repos
 * @param {number} windowDays
 * @returns {string}
 */
function emptyNote(repos, windowDays) {
  return (
    `这 ${repos.length} 个仓库最近 ${windowDays} 天没有「有人讨论」的 issue` +
    `（注意：可能有更新但无人评论，这部分已被过滤掉）。` +
    `可以把 windowDays 调大一点再试。`
  );
}

/**
 * 执行一次查询。
 *
 * @param {Record<string, any>} args 模型给的参数（已过 `validateArgs`，但仍当不可信输入处理）
 * @param {{ safeFetch: Function, signal?: AbortSignal, store?: any }} ctx
 * @returns {Promise<{ ok: true, summary: string, data?: unknown } | { ok: false, code: string, message: string }>}
 */
export async function run(args, ctx) {
  // ── ① 夹紧参数（校验器不支持 default，必须自己兜底 —— 评审 A4）──
  const limit = clampInt(args?.limit, DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
  const windowDays = clampInt(args?.windowDays, DEFAULT_WINDOW_DAYS, MIN_WINDOW_DAYS, MAX_WINDOW_DAYS);

  // ── ② 决定查哪些仓库 ──
  /** @type {string[]} */
  let repos;
  /** @type {string[]} */
  let excludeLabels;
  let domainId;
  /** 显式 repos 路径才做存在性校验（领域路径的仓库由本地表保证，且验收时已核实） */
  let explicitRepos = false;

  if (args?.repos !== undefined) {
    const checked = validateRepos(args.repos);
    if (!checked.ok) return { ok: false, code: 'BAD_ARGS', message: checked.error };
    repos = checked.repos;
    excludeLabels = []; // 显式给仓库时，不知道对方仓库的 label 约定，不做排除
    domainId = '_explicit';
    explicitRepos = true;
  } else {
    // ⚠️ 先试**仓库短名**（评审 A6）：「帮我找一下 vllm 最新的 issue」里 "vllm"
    //    既不是领域 id 也不是领域别名，不认它就只能 NEED_DOMAIN —— 那会让 AS1 直接失败。
    const byRepo = resolveRepoAlias(args?.domain);
    if (byRepo) {
      repos = [byRepo.repo]; // 1 个仓库 → 1 次请求，最精确
      excludeLabels = [...(byRepo.domain.excludeLabels ?? [])];
      domainId = byRepo.domain.id;
    } else {
      const entry = resolveDomain(args?.domain);
      if (!entry) return needDomainMessage(); // ★ 0 次请求
      repos = [...entry.repos];
      excludeLabels = [...(entry.excludeLabels ?? [])];
      domainId = entry.id;
    }
  }

  // ── ③ 缓存（key 里没有 limit —— 评审 Q7-3）──
  const key = cacheKey(domainId, repos, excludeLabels, windowDays);
  const hit = readCache(ctx, key);
  if (hit) {
    return {
      ok: true,
      summary: formatSummary({
        items: hit.items ?? [],
        total: hit.total ?? 0,
        windowDays,
        limit,
        incomplete: hit.incomplete === true,
        emptyNote: emptyNote(repos, windowDays),
      }),
      data: { ...hit, cached: true },
    };
  }

  // ── ④ 显式仓库先校验存在性（评审 B1）──
  /** @type {{ full: string, exists: boolean | null, status: number | null }[]} */
  let repoChecks = repos.map((full) => ({ full, exists: true, status: 200 }));
  if (explicitRepos) {
    repoChecks = await checkReposExist(repos, ctx);
    const missing = repoChecks.filter((r) => r.exists === false).map((r) => r.full);
    if (missing.length > 0) {
      return {
        ok: false,
        code: 'BAD_ARGS',
        message: `这些仓库名在 GitHub 上找不到，请核对：${missing.join('、')}。`,
      };
    }
  }

  // ── ⑤ 拼查询 ──
  const built = buildSearchUrl({ repos, windowDays, excludeLabels });
  if (!built.ok) return { ok: false, code: 'BAD_ARGS', message: built.error };

  // ── ⑥ 请求 ──
  const res = await ctx.safeFetch(built.url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': API_VERSION, // 评审 B5b：固定 API 版本
    },
    // ★ 必须透传 ctx.signal：否则用户按「停止」要干等到超时才断（评审 B5c / B-2c）
    signal: ctx.signal,
    timeoutMs: REQUEST_TIMEOUT_MS, // ★ 分层超时（评审 B5d）
  });

  if (!res.ok) return httpError(res, built.query);

  /** @type {any} */
  let body;
  try {
    body = await res.json();
  } catch {
    // 评审 B5a：200 但响应体不是 JSON（维护页 / 代理拦截 / 截断）
    // **绝不能落进"0 结果"**
    return { ok: false, code: 'INTERNAL', message: 'GitHub 的返回不是合法 JSON。' };
  }

  const rawItems = Array.isArray(body?.items) ? body.items : [];
  const items = rawItems.map(mapItem).filter(Boolean);
  const total = Number.isFinite(body?.total_count) ? body.total_count : items.length;
  const incomplete = body?.incomplete_results === true;

  // ── ⑦ 写缓存（结构化 items，不是排版结果 —— 评审 A2）──
  const cacheValue = {
    at: Date.now(),
    domainId,
    repos: repoChecks,
    total,
    incomplete,
    items, // 全量 DISPLAY_COUNT 条，气泡要用（评审 Q7）
  };
  if (items.length > 0) writeCache(ctx, key, cacheValue);

  // ── ⑧ 返回 ──
  return {
    ok: true,
    summary: formatSummary({
      items,
      total,
      windowDays,
      limit, // ★ limit 只在排版时生效（评审 Q7-3）
      incomplete,
      emptyNote: emptyNote(repos, windowDays),
    }),
    data: { ...cacheValue, query: built.query, cached: false },
  };
}

/** 供测试使用：暴露领域表条数与展示常量，便于断言表被真正加载 */
export const __domainCount = DOMAINS.length;
export const __displayCount = DISPLAY_COUNT;
