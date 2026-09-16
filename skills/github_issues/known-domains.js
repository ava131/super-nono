/**
 * 内置领域表 —— **领域名 → 种子仓库**（数据见 `known-domains.json`）。
 *
 * 这个文件做四件事：
 *   1. 把 `known-domains.json` 读进来（数据与代码分离，便于将来用脚本补全）
 *   2. **模块加载时就校验整张表**，坏了直接抛错
 *   3. 提供 `resolveDomain()`：把用户口中的领域名解析成一条表项
 *   4. 导出给模型看的领域清单（`NEED_DOMAIN` 与 description 共用）
 *
 * ## 为什么必须在加载时校验并抛错
 *
 * 领域解析的失败模式是**无声的**：表里 `repos` 写错一个仓库名，GitHub 不会报错，
 * 它只是开心地在那个不存在的仓库里搜出 0 条结果——用户看到的是"最近没有动态"。
 *
 * 所以这里宁可**让技能加载失败**：`registry.loadSkills()`（`registry.js:98`）会捕获
 * import 抛出的异常，把这个技能标记为 disabled 并记进 `loadErrors`，
 * `pnpm skill:list` 会显示原因，**其他技能不受影响**。
 * 用"技能没加载"换"绝不静默查错仓库"，这个交换是划算的（PRD R1 是最高优先级风险）。
 *
 * ## 为什么不做模糊匹配
 *
 * `"ai"` 是 `"ai infra"` 的子串。一旦允许包含/编辑距离匹配，用户说 "ai" 就会命中
 * infra —— 而猜错的代价是**看起来正常的错误答案**。所以这里只做**精确匹配**，
 * 未命中就走 `NEED_DOMAIN` 反问（0 次网络请求，比猜便宜）。
 *
 * @typedef {{ id: string, label: string, aliases: readonly string[], repos: readonly string[],
 *             repoAliases?: Readonly<Record<string, string>>, excludeLabels?: readonly string[] }} DomainEntry
 */

import raw from './known-domains.json' with { type: 'json' };

/** 领域 id 允许的字符（小写、数字、连字符） */
export const DOMAIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

/**
 * `owner/repo` 的形状。
 *
 * ⚠️ **它的首要目的是阻断查询注入，不是精确复刻 GitHub 的命名规则。**
 * `repos` 可以由模型直接传入，而这段字符串会被拼进 GitHub 的搜索查询里——
 * 如果允许空白和 `:`，模型（或被提示注入的内容）就能塞进
 * `owner/repo updated:>2000-01-01` 之类的额外限定符，**篡改查询语义**。
 * 这个字符集不含空白、`:`、`&`、`"`，从根上堵掉这条路。
 */
export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * 仓库**短名**（`repoAliases` 的键）—— 用户口语里怎么叫这个仓库。
 * 例如 "vllm" / "sglang"。只允许小写字母数字与连字符。
 */
export const REPO_SHORT_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

/**
 * 领域名的归一化 —— 解析前后**必须用同一个函数**。
 *
 * 表里的 `aliases` 也要求是**已归一化**的形式（校验器会检查），
 * 否则一条写成 `"AI Infra"` 的别名永远匹配不上，而且**不会有任何报错**。
 *
 * @param {unknown} input
 * @returns {string} 归一化后的字符串；非字符串返回空串
 */
export function normalizeDomainName(input) {
  if (typeof input !== 'string') return '';
  return input.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 校验单条表项的形状是否自洽。
 *
 * @param {any} e
 * @param {string} [where] 出错时指明位置（便于定位是哪一条）
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
export function validateEntry(e, where = '') {
  /** @type {string[]} */
  const problems = [];
  if (!e || typeof e !== 'object') return [`${where}条目不是对象`];

  const { id, label, aliases, repos, excludeLabels } = e;

  if (typeof id !== 'string' || !DOMAIN_ID_RE.test(id)) {
    problems.push(`${where}id 不合法（须为小写字母/数字/连字符）：${JSON.stringify(id)}`);
  }
  if (typeof label !== 'string' || label.trim() === '') {
    problems.push(`${where}label 缺失或为空`);
  }

  // aliases —— 非空、无重复、且**必须已归一化**（否则永远匹配不上）
  if (!Array.isArray(aliases) || aliases.length === 0) {
    problems.push(`${where}aliases 必须是非空数组`);
  } else {
    for (const a of aliases) {
      if (typeof a !== 'string' || a === '') {
        problems.push(`${where}aliases 里必须是非空字符串：${JSON.stringify(a)}`);
      } else if (normalizeDomainName(a) !== a) {
        // 这是最容易埋的坑：写成 "AI Infra" 不会报错，只是永远解析不到
        problems.push(`${where}alias 未归一化（应为 ${JSON.stringify(normalizeDomainName(a))}）：${JSON.stringify(a)}`);
      }
    }
  }

  // repos —— 非空、每项匹配 owner/repo
  if (!Array.isArray(repos) || repos.length === 0) {
    problems.push(`${where}repos 必须是非空数组`);
  } else {
    for (const r of repos) {
      if (typeof r !== 'string' || !REPO_RE.test(r)) {
        problems.push(`${where}repo 写法不合法（应为 owner/repo）：${JSON.stringify(r)}`);
      }
    }
  }

  // excludeLabels —— 可选，但给了就必须是非空字符串数组
  if (excludeLabels !== undefined) {
    if (!Array.isArray(excludeLabels)) {
      problems.push(`${where}excludeLabels 必须是数组`);
    } else if (excludeLabels.some((/** @type {unknown} */ l) => typeof l !== 'string' || l === '')) {
      problems.push(`${where}excludeLabels 里必须是非空字符串`);
    }
  }

  // repoAliases —— 可选：仓库短名 → 完整 owner/repo
  if (e.repoAliases !== undefined) {
    const ra = e.repoAliases;
    if (!ra || typeof ra !== 'object' || Array.isArray(ra)) {
      problems.push(`${where}repoAliases 必须是对象`);
    } else {
      for (const [short, full] of Object.entries(ra)) {
        if (!REPO_SHORT_RE.test(short)) {
          problems.push(`${where}repoAliases 的短名不合法：${JSON.stringify(short)}`);
        } else if (normalizeDomainName(short) !== short) {
          problems.push(`${where}repoAliases 短名未归一化（应为 ${JSON.stringify(normalizeDomainName(short))}）：${JSON.stringify(short)}`);
        }
        if (typeof full !== 'string' || !REPO_RE.test(full)) {
          problems.push(`${where}repoAliases["${short}"] 的值不是合法的 owner/repo：${JSON.stringify(full)}`);
        } else if (Array.isArray(repos) && !repos.includes(full)) {
          // 短名只能指向**本领域自己的**仓库——否则"vllm"可能被解析到别人的仓库去
          problems.push(`${where}repoAliases["${short}"] = ${full} 不在该领域的 repos 里`);
        }
      }
    }
  }

  return problems;
}

/**
 * 校验**整张表**：逐条形状 + 跨条目冲突。
 *
 * 冲突检测必须放在表级 —— 这正是 `market/known-symbols.js` 把整表拍平后统一校验的原因：
 * 单看一条表项，无法知道它的别名是否和别人的 id 撞了。
 *
 * @param {any} domains
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
export function validateTable(domains) {
  /** @type {string[]} */
  const problems = [];

  if (!Array.isArray(domains) || domains.length === 0) {
    return ['domains 必须是非空数组'];
  }

  /** @type {Map<string, string>} 归一化后的键 → 首次出现的 domain id */
  const seen = new Map();

  /** @type {Map<string, string>} 仓库短名 → 首次出现的 domain id（也要全局唯一） */
  const shortSeen = new Map();

  domains.forEach((/** @type {any} */ e, /** @type {number} */ i) => {
    const where = `domains[${i}](${e?.id ?? '?'})：`;
    problems.push(...validateEntry(e, where));

    // id 与每个 alias 都占一个"键"，互相不许撞
    /** @type {string[]} */
    const keys = [];
    if (typeof e?.id === 'string') keys.push(e.id);
    if (Array.isArray(e?.aliases)) {
      for (const a of e.aliases) if (typeof a === 'string' && a !== '') keys.push(a);
    }

    for (const k of keys) {
      const owner = seen.get(k);
      if (owner !== undefined && owner !== e.id) {
        problems.push(`${where}键 ${JSON.stringify(k)} 与领域 ${owner} 冲突（id 与 alias 必须全局唯一）`);
      } else if (owner === undefined) {
        seen.set(k, e.id);
      }
    }

    // repoAliases 的短名也必须在**全表**唯一：
    // 否则"vllm"可能被解析到另一个领域的仓库，而那是静默的错误答案
    if (e?.repoAliases && typeof e.repoAliases === 'object' && !Array.isArray(e.repoAliases)) {
      for (const short of Object.keys(e.repoAliases)) {
        const owner = shortSeen.get(short);
        if (owner !== undefined && owner !== e.id) {
          problems.push(`${where}仓库短名 ${JSON.stringify(short)} 与领域 ${owner} 冲突（repoAliases 键必须全局唯一）`);
        } else if (owner === undefined) {
          shortSeen.set(short, e.id);
        }
      }
    }
  });

  return problems;
}

// ── 模块加载即校验：表坏了就让 registry 把这个技能禁用掉，而不是静默查错仓库 ──
const tableProblems = validateTable(raw.domains);
if (tableProblems.length > 0) {
  throw new Error(`known-domains.json 校验失败：\n- ${tableProblems.join('\n- ')}`);
}

/**
 * 冻结过的领域表。
 *
 * 冻结是因为这张表会被**多个调用点共享**，而技能是常驻进程：
 * 一处不小心 `repos.push(...)` 会污染后续所有查询，且极难排查。
 *
 * @type {ReadonlyArray<Readonly<DomainEntry>>}
 */
export const DOMAINS = Object.freeze(
  /** @type {DomainEntry[]} */ (raw.domains).map((d) =>
    Object.freeze({
      ...d,
      aliases: Object.freeze([...d.aliases]),
      repos: Object.freeze([...d.repos]),
      repoAliases: Object.freeze({ ...(d.repoAliases ?? {}) }),
      excludeLabels: Object.freeze([...(d.excludeLabels ?? [])]),
    }),
  ),
);

/** 便于诊断：表里有多少个领域。 */
export const DOMAIN_COUNT = DOMAINS.length;

/**
 * 把用户/模型给的领域名解析成一条表项。
 *
 * 匹配顺序：**先精确匹配 id，再精确匹配 alias**。不做模糊匹配（理由见文件头）。
 *
 * @param {unknown} input
 * @returns {Readonly<DomainEntry> | null} 未命中返回 null（调用方必须走 NEED_DOMAIN，不许猜）
 */
export function resolveDomain(input) {
  const key = normalizeDomainName(input);
  if (key === '') return null;

  for (const d of DOMAINS) if (d.id === key) return d;
  for (const d of DOMAINS) if (d.aliases.includes(key)) return d;
  return null;
}

/**
 * 把用户/模型给的名字解析成**单个仓库**（走 `repoAliases`）。
 *
 * ## 为什么必须有这条路（评审 A6）
 *
 * 验收项 AS1 是「帮我找一下 **vllm** 最新的 issue」，期望 1 次请求返回 5 条。
 * 但 `"vllm"` 既不是领域 id 也不是领域别名——按 §4.4 的规则它只能走 `NEED_DOMAIN`，
 * **AS1 与 §4.4 直接冲突**。
 *
 * 唯一的替代方案是"让模型自己给出 `repos: ["vllm-project/vllm"]`"，
 * 但那正是 §4.1 否掉的**让模型猜**——猜错时用户会收到"最近没有更新"这句假话。
 *
 * 所以：**把"用户会怎么叫这个仓库"也放进本地表**，命中就走显式 repos 路径
 * （1 个仓库、1 次请求），"猜"被彻底消除。
 *
 * ⚠️ **不能**把 `"vllm"` 直接加进 `aliases`：那会把"vllm"解析成整个 ai-infra 领域，
 * 返回 3 个仓库混在一起的 5 条，与用户意图不符。
 *
 * @param {unknown} input
 * @returns {{ repo: string, domain: Readonly<DomainEntry> } | null}
 */
export function resolveRepoAlias(input) {
  const key = normalizeDomainName(input);
  if (key === '') return null;
  for (const d of DOMAINS) {
    const full = d.repoAliases?.[key];
    if (typeof full === 'string') return { repo: full, domain: d };
  }
  return null;
}

/**
 * 给模型看的领域清单（`NEED_DOMAIN` 的提示语与 `skill.json` 的 description 共用）。
 *
 * ⚠️ `test/unit/github-issues.test.js` 会断言**清单里的每个 id 都能被 `resolveDomain` 解析回来**——
 * 保证"告诉模型可选什么"与"实际能解析什么"永远一致。
 *
 * @returns {string} 形如 `ai-infra（AI Infra / 大模型推理基础设施）`
 */
export function domainListForModel() {
  return DOMAINS.map((d) => `${d.id}（${d.label}）`).join('、');
}

/**
 * 给模型看的**仓库短名**清单，按领域分组。
 *
 * 与 `domainListForModel` 同理：让模型知道"用户说 vllm 时该怎么传"，
 * 而不必自己拼 owner/repo。
 *
 * @returns {string} 形如 `vllm / sglang / vllm-ascend`
 */
export function repoNamesForModel() {
  /** @type {string[]} */
  const out = [];
  for (const d of DOMAINS) for (const k of Object.keys(d.repoAliases ?? {})) out.push(k);
  return out.join(' / ');
}
