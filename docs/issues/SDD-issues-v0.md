# SDD · GitHub Issues（领域 issue 追踪）技术方案 — v0

> 状态：**已评审（2026-09-16）** ｜ 首次定稿：2026-09-14 ｜ 上游：[PRD-issues-v0](PRD-issues-v0.md)（已评审）
>
> ⚠️ **本文档的 §4.2「只改 2 个文件 / `src/main/**` 一律不改」已作废**——Q7 把气泡展示提到 v0 之后，真实改动面是 **5 层 8+ 个文件**。以 [评审 §7.3-Q7-0](v0-review-20260916-1904.md) 为准。

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0 | 2026-09-14 | 初稿。技术选型、模块落点、对现有结构的改动、测试策略。 |
| v0.1 | 2026-09-14 | 评审修订（见 [v0-review](v0-review-20260914-1230.md)）：**A1** 补 `signal: ctx.signal` 透传（原稿遗漏会让"停止"失效）；**A2** 统一缓存存结构化 items（§5.4 与 §6.2 原来自相矛盾）；**B1** `buildQuery` 增加 `now` 显式参数；**B2** 定义 `domain`/`repos` 优先级；**B3** 裁剪时必须如实告知条数；**C1/C2** repos 去重、缓存 key 占位符；§8.3 补 T16–T20。 |

---

## 1. 与 PRD 的对应

| PRD 章节 | 本 SDD 落点 |
|---|---|
| §2 只呈现不分析 | §3.4（description 硬指令）、§5.5（排版即答案）、§8.3 T9 |
| §3.1 `active` 配方 | §5.2 查询拼装 |
| §4 领域表 | §5.1、§6.1 |
| §5 技能接口 | §4.1 `skill.json` |
| §6 summary 预算 | §5.5 |
| §7 配额与失败 | §5.3、§5.4、§5.6 |
| §8 与 MCP 关系 | §2.2（被否决方案） |
| §11 待确认 | §11 |

---

## 2. 技术选型

### 2.1 结论

| 决策点 | 选择 | 理由 |
|---|---|---|
| 出网方式 | `ctx.safeFetch` 打 `api.github.com` | 唯一可用通道（技能无 shell、宿主无 MCP 客户端） |
| 认证 | **无 Token**（PRD §11.1 已决） | 10 次/分钟够用；免去 settings + safeStorage 改动 |
| 领域解析 | **本地表**，不联网 | PRD §4.1：`topic:` 会静默返回垃圾 |
| 请求数 | 命中 1 次；未命中/空参 **0 次** | PRD §7.2 |
| 缓存 | `ctx.store.cache`（**持久**） | PRD §7.3（含更正） |
| 参数校验 | 复用 `src/main/skills/schema.js` | 不引依赖 |
| 数据源数量 | **1 个**（不做主备） | 无可信的 GitHub 备源；见 §2.2 |

### 2.2 被否决的方案

| 方案 | 否决理由 |
|---|---|
| `gh` CLI / `gh search issues` | 技能没有 `child_process`（全仓库实测 0 处） |
| GitHub 官方 MCP server | 宿主无 MCP 客户端；且会打破出网唯一出口与 L3 红线（PRD §8） |
| `topic:` 搜仓库做第一段 | 实测静默返回垃圾：`topic:ai-infra` → top 是无人知晓的项目（PRD §4.1） |
| 全站 issue 全文搜索 | 实测 `rust async` 返回 9159 条，混入无关仓库；且 issue 结果**不含 star 数**，无法判断重要性 |
| 抓 issue 正文 | N 条 = N 次请求，10/分钟配额扛不住 |
| 多数据源主备 | 无第二个可信源；且本项目 market 的教训是"多源要统一口径"，这里没有对应的等价物 |
| 进程内存缓存 | 配额按**出口 IP** 计，重启 app 不重置 → 内存缓存把已花的配额白扔（PRD §7.3） |

### 2.3 关键取舍（一句话）

> **宁可 0 请求反问，也不猜一个领域的仓库——因为猜错的失败模式是"看起来正常的错误答案"，而不是报错。**

---

## 3. 对现有结构的改动

> 本节回应 PRD 评审时提出的「整个结构还是有点问题」。以下三条都是**代码实证**，不是感觉。

### 3.1 `data` 字段：从"只进不出"接上第一个消费者

**现状（实测）**：

```
runner.js:213   data: r.data                                    ← 全仓库唯一出现处
agent.js:239    messages.push({ content: result.summary })       ← 只回填 summary
scripts/skill-test.js:100   console.log(result.summary)          ← 只打 summary
```

**这不是"预留"，是一个只进不出的黑洞。** 它比"没有这个字段"更糟：契约文档鼓励技能把原始结果放进去，而结果是**被静默丢弃**。

**最讽刺的一处**：README 说 `skill:test` 的用途是

> *Debug it directly (**bypassing the model**), to tell "the skill is broken" apart from "the model didn't call it"*

但要区分这两种情况，**恰恰需要看到技能的原始返回**——而这条命令把它扔了。

**v0 改动（最小、1 处）**：`scripts/skill-test.js` 在有 `data` 时打印它。

```js
console.log(result.summary);
if (result.data !== undefined) {
  console.log('─'.repeat(60));
  console.log('data（不进模型上下文，仅供调试）:');
  console.log(JSON.stringify(result.data, null, 2));
}
```

**为什么这就够了**：它让字段**立刻挣到自己的位置**（开发者能看见原始返回），零架构改动，不碰 `runner.js`/`agent.js`。

**明确不在 v0 做**：UI 渲染 `data`（气泡里展示可点击完整列表，实现「模型叙述 5 条 + 气泡展示 20 条」）。这是 v1 方向，见 PRD §6.3。

**如果 v1 仍不做** → **建议把 `data` 从契约里删掉**。一个文档化但不被消费的字段是陷阱。

### 3.2 不动 `SUMMARY_LIMIT`（PRD §6.4 已决）

`shared/limits.js` 的 800 被 `runner.js`（截断）和 `skills/market/snapshot.js`（表格排版）共用，注释明确警告两边不一致会导致"用户看到残缺数据且毫无提示"。

**本技能必须自己保证 `summary` ≤ 800**（§5.5），因为 `runner.js:212` 的 `slice` 是**静默**的。

### 3.3 清单校验 + `description` 预算（**方案已按实测更正**）

> ⚠️ 本节初稿的方案（领域清单写进 description + 断言两份清单一致）**实测行不通**：`schema.js:74` 的 description 上限是 **200 字**，初稿写了 372 字，结果**技能被静默禁用**。详见评审 [A4](v0-review-20260914-1230.md)。

**实现改为**：

| 关注点 | 做法 |
|---|---|
| 领域清单怎么让模型知道 | **不带参数调用一次**本技能，`NEED_DOMAIN` 返回清单（0 请求）。清单只有 `known-domains.json` 一个来源，**不存在漂移** |
| description 预算 | 硬性 ≤200 字；定稿 **137 字** |
| 回归防护 | **用真校验器 `validateManifest()` 跑一遍 `skill.json`** —— 这条测试当场抓住了上面那个禁用问题 |

`description` 必须装下的三件事（合计 137 字）：

1. 何时使用
2. **领域不明确就带空参数调用本技能**（而不是列出领域）
3. **只转述、不推断趋势、不描述正文**

---

## 4. 模块落点

### 4.1 新增文件

```
skills/github_issues/
├── skill.json            ← manifest（§4.2）
├── index.js              ← 执行器：编排 + 三态处理 + 缓存
├── known-domains.json    ← 领域表数据（种子，§6.1）
├── known-domains.js      ← 读表 + 解析 + 运行时形状校验（仿 market/known-symbols.js）
├── query.js              ← 查询拼装与参数归一化（纯函数，可离线测）
└── format.js             ← summary 排版与预算裁剪（纯函数，可离线测）
```

**为什么把 `query.js` / `format.js` 拆出来**：它们是**纯函数**，可以完全离线单测——包括"800 预算裁剪"这种最容易出错的逻辑。`market` 把 `snapshot.js` 拆出来是同一个理由。

### 4.2 需要修改的现有文件

| 文件 | 改动 | 风险 |
|---|---|---|
| `scripts/skill-test.js` | 打印 `data`（§3.1） | 低（仅调试输出） |
| `test/unit/contract.test.js` | 加领域表 ↔ description 一致性断言（§3.3） | 低 |

> **`shared/limits.js`、`src/main/skills/*`、`src/main/brain/*` 一律不改。** 本技能完全落在既有契约内。

### 4.3 职责边界

| 模块 | 负责 | **不负责** |
|---|---|---|
| `query.js` | 领域→查询串、窗口日期、clamp | 不发请求 |
| `format.js` | 逐条排版、去 label 噪声、800 裁剪 | 不做任何**分析/排序/归类**（PRD §2） |
| `known-domains.js` | 解析领域名、校验表项 | 不做模糊纠错（§5.1） |
| `index.js` | 编排、缓存、错误映射 | 不解析 HTML、不抓正文 |
| 模型 | 把 summary 转述成中文 | **不得推断趋势/结论**（PRD §2.3） |

---

## 5. 关键实现

### 5.1 领域表与解析

**解析规则（刻意保守）**：

```js
normalize(s) = s.trim().toLowerCase().replace(/\s+/g, ' ')
```

1. `normalize` 后**先精确匹配 `id`**，再精确匹配任一 `alias`
2. **不做模糊匹配、不做编辑距离、不做子串包含**

**为什么不做模糊匹配**：`"ai"` 是 `"ai infra"` 的子串——一旦允许包含关系，用户说 "ai" 就会命中 infra。**猜错的代价是静默返回错误答案（PRD R1），所以宁可不命中。**

> 未命中时返回 `NEED_DOMAIN` 并列出全部 `id` + `label`，用户改个说法即可——这条路径 **0 请求**，比猜便宜。

**运行时形状校验**（仿 `market/known-symbols.js`，在 `test/unit/` 里对每一条断言）：

| 字段 | 规则 |
|---|---|
| `id` | 非空字符串，**全局唯一**，匹配 `/^[a-z0-9-]+$/` |
| `label` | 非空字符串（给人看） |
| `aliases` | `string[]`，非空、无重复、**不允许与其他 domain 的 id/alias 冲突** |
| `repos` | `string[]`，非空，每项匹配 `/^[\w.-]+\/[\w.-]+$/` |
| `excludeLabels` | 可选 `string[]`，非空字符串 |

> `aliases` 冲突检测是**表级**校验（不是条目级）——这正是 `known-symbols.js` 用"整个表拍平后统一校验"的原因，同一个模式。

### 5.2 查询拼装（`query.js`）

```js
/**
 * @param {{ repos: string[], windowDays: number, excludeLabels: string[], now?: number }} p
 *   now 显式传入是为了**可测**（评审 B1）：不传则用 Date.now()，测试传固定值使断言确定
 */
export function buildQuery({ repos, windowDays, excludeLabels, now = Date.now() }) {
  const since = new Date(now - windowDays * 86400000).toISOString().slice(0, 10);
  const uniq = [...new Set(repos)];                       // 评审 C1：去重，省 256 预算
  const parts = [
    'is:issue', 'state:open',
    ...uniq.map((r) => `repo:${r}`),
    `updated:>${since}`,
    ...excludeLabels.map((l) => `-label:${l}`),
  ];
  return parts.join(' ');
}
```

拼出的请求：

```
GET https://api.github.com/search/issues
      ?q={buildQuery}&sort=updated&order=desc&per_page={limit}
Headers: Accept: application/vnd.github+json
         User-Agent: super-nono/0.1.0
```

**实际调用（★ 是评审 A1，必须照做）**：

```js
const res = await ctx.safeFetch(url, {
  headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA },
  signal: ctx.signal,   // ★ 必须透传：否则用户按「停止」要干等到 15s 超时才断（B-2c）
});
```

> ⚠️ **A1 是真缺陷，不是洁癖**：`egress.js` 的注释明确写着"原设计用 `AbortSignal.timeout()` 直接覆盖调用方 signal，导致用户按「停止」时请求不会被中断"——**那是修过的 bug**。不传 `ctx.signal` 等于把它重新引入，而且**静默**：查询照常出结果，只是"停止"失效。

**约束与陷阱**：

| 项 | 处理 |
|---|---|
| `repos` 上限 | **代码 clamp 到 5**——校验器**不支持 `maxItems`**（PRD §5.3） |
| 查询串长度 | 防御性检查 ≤ **256 字符**（⚠️ 该上限**未验证**，取保守值；超了返回结构化错误，不静默截断） |
| 日期 | `toISOString()` 即 **UTC 日历日**。已实测生效；跨时区边界最多差一天，**记录为已知误差**，不修正 |
| URL 编码 | `encodeURIComponent(q)` 整体编码 |
| `User-Agent` | **必须带**——GitHub 对无 UA 的请求可能直接拒绝 |
| `per_page` | = `limit`（≤5），与 summary 预算对齐 |

### 5.3 错误映射（`index.js`）

**原则：任何非 200 都不得被表述为"没有找到"（PRD §7.4）。**

| HTTP | 处理 | 返回 |
|---|---|---|
| 200 | 正常 | §5.6 |
| 403 / 429 | 读 `x-ratelimit-reset`（Unix 秒），算 `Math.max(0, reset - now)` | `ok:false, code:'RATE_LIMITED'`，message 含"约 N 秒后恢复" |
| 422 | **查询拼装 bug**，不是"没找到" | `ok:false, code:'INTERNAL'`，message 带原始查询串便于定位 |
| 5xx | 不重试（省配额） | `ok:false, code:'INTERNAL'` |
| 网络失败/超时 | 由 `safeFetch` 抛 `AppError`，`runner` 保留原错误码 | 透传 |

> `safeFetch` 返回的是 `Response`，所以 `x-ratelimit-*` 头**读得到**，不需要改 `egress.js`。

### 5.4 缓存（`db:cache` + 自管 TTL）

```js
// 权限: ["network:github_issues", "db:cache"]
const key = `${domainId}|${repos.join(',')}|${windowDays}|${limit}`;
const hit = ctx.store.cache.get(key);
if (hit && Date.now() - hit.at < TTL_MS) return render(hit);
```

| 项 | 值/说明 |
|---|---|
| TTL | **300000 ms（5 分钟）**，技能自己判断——`ctx.store.cache` **没有内置 TTL**（实测只有 `get`/`put`/`drop`/`clear`） |
| key 用 `domainId` 而非用户原话 | 让同一领域的别名变体（"AI infra" / "推理框架"）**共享缓存**；显式传 `repos` 时 `domainId` 用占位符 `_explicit`（评审 C2） |
| 存什么 | **结构化 items + 元数据**（形状见 §6.2），**不是**排版结果（评审 A2） |
| 写失败 | **必须容错**：`put` 抛错只记日志，不影响本次返回（缓存是优化，不是正确性） |
| 缓存命中时 | **`incomplete_results` 等元数据也要一起缓存**，否则命中时丢失警告 |

**为什么必须存结构化 items 而不是排版结果（评审 A2）**：

1. **排版规则会改**——标题截断 55、label 取 2 个都是可调参数。存排版结果的话，改了 `format.js` 之后**旧缓存还会吐旧格式**，且 TTL 内无法察觉。
2. **缓存命中时要能重建 `data`**（PRD §6.3 的"无损通道"）——存排版结果就重建不出来。

> 补充：命名空间上限实测 `MAX_NAMESPACE_BYTES = 1MB`（`store.js:46`），存原始响应都绰绰有余——**它不是选结构化还是排版结果的理由**。

### 5.5 `summary` 排版与预算（`format.js`）

**格式**（PRD §6.2 选定，实测 5 条 = 728/800）：

```
{owner}/{repo}#{num} {N}d c:{comments} {title≤55} {html_url} [{l1,l2}]
```

**裁剪算法（硬要求）**：

```js
const lines = items.map(renderLine);
// 宁可少一条，也绝不让最后一条的 URL 被截断
while (lines.length > 0 && lines.join('\n').length + footerLen > 800) lines.pop();
// ★ 评审 B3：只要发生了裁剪，就必须如实写出总数——静默降级是 market 踩过的坑
const footer = lines.length < total ? `共 ${total} 条，这里列了 ${lines.length} 条` : '';
```

> **B3 的依据**：`skills/market/snapshot.js` 的注释记着这条教训——「**列必须固定**：原稿"先去掉量比列、再去掉区间位置列"会让列数变化」。本技能"删整行"比"删列"轻，但**同样是静默降级**：用户看到 4 条不会知道本该有 5 条。

| 规则 | 说明 |
|---|---|
| **永不截断 URL** | URL 是模型**唯一无法自己生成**的事实。宁可少列一条 |
| label 过滤 | 去掉 `status:` 前缀（triage 流水线噪声），取前 2 个 |
| 标题截断 | 55 字符（实测值） |
| **不排序** | `sort=updated` 的顺序**就是答案**；重排 = 分析（PRD §2.3 F2） |
| **裁剪必须告知** | 发生裁剪时写出"共 N 条，这里列了 M 条"（评审 B3） |
| 空结果 | 不是空串——必须给出可读说明（§5.6），否则 `runner` 会判 `INTERNAL`（空 summary 被当失败） |

### 5.6 三态处理（`index.js` 返回形状）

**入参优先级（评审 B2，必须先判定）**：

```
repos 非空            → 用它（去重 + clamp 5），domain 被忽略
否则 domain 命中表     → 用表里的 repos / excludeLabels
否则                  → NEED_DOMAIN（0 请求）
```

| 态 | 触发 | 返回 | 请求数 |
|---|---|---|---|
| **NEED_DOMAIN** | `domain` 未命中表，且未给 `repos` | `ok:false, code:'NEED_DOMAIN'`，summary 列出全部 `id` + `label` + "或直接给 owner/repo" | **0** |
| **无结果** | 200 且 `total_count === 0` | `ok:true`，summary 说明"这 N 个仓库最近 {window} 天没有更新"+ 建议放宽窗口 | 1 |
| **正常** | 200 且有结果 | `ok:true`，summary = §5.5 | 1 |

**`NEED_DOMAIN` 用 `ok:false` + 自定义 code**：`runner.js:199` 的 `normalizeResult` 原样透传 `r.code`（非字符串才降级为 `INTERNAL`），所以自定义码安全。语义上也对——**没有执行业务逻辑**。

**`data` 的形状**（§3.1 起有了消费者）：

```js
data: {
  query,            // 实际发出的查询串（调试关键）
  repos,            // 解析后的仓库列表
  total,            // total_count
  incomplete,       // incomplete_results
  fetchedAt,        // 时间戳
  cached: boolean,  // 本次是否命中缓存
  items: [{ repo, number, title, url, comments, updatedAt, labels }],  // 未截断的全量
}
```

> `data.items` 是**未截断**的全量——这正是"无损通道"的意义（PRD §6.3）。

---

## 6. 数据模型

### 6.1 `skills/github_issues/known-domains.json`

```jsonc
{
  "_note": "领域 → 种子仓库。repos 必须人工选定：实测 vllm-ascend 仅 2825 stars 却有 3267 个未关 issue，按 star 筛是错的方法。",
  "_updatedAt": "2026-09-14",
  "domains": [
    {
      "id": "ai-infra",
      "label": "AI Infra / 大模型推理基础设施",
      "aliases": [
        "ai infra", "ai基础设施", "推理框架", "大模型推理",
        "llm serving", "llm serving 框架", "llm inference", "推理加速"
      ],
      "repos": [
        "vllm-project/vllm",
        "sgl-project/sglang",
        "vllm-project/vllm-ascend"
      ],
      "excludeLabels": ["ci-failure-tracker"]
    }
  ]
}
```

**种子来源已核实**（`GET /repos/`，走 core 配额）：

| repo | stars | open issues |
|---|---|---|
| `vllm-project/vllm` | 91,802 | 7,959 |
| `sgl-project/sglang` | 35,979 | 5,337 |
| `vllm-project/vllm-ascend` | 2,825 | 3,267 |

`excludeLabels` 的依据见 PRD §7.7（自动化噪声只能靠 label 精确排除；`author:app/*` 已实测无效）。

### 6.2 缓存条目形状

```jsonc
{
  "at": 1789462049000,
  "domainId": "ai-infra",
  "total": 648,
  "incomplete": false,
  "items": [ /* data.items 的形状 */ ]
}
```

---

## 7. 一次「帮我找一下 ai infra 的 issue」的时序

```
用户: "帮我找一下 ai infra 的 issue"
  │
  ├─ 模型 → tool_call: github_issues({ domain: "ai infra" })
  │
  ├─ runner.run()  闸门：存在 ✅ 权限自洽 ✅ 非 L3 ✅ 参数校验 ✅ 无需确认 ✅
  │
  ├─ index.js
  │   ├─ normalize("ai infra") → 命中 alias → id="ai-infra"
  │   ├─ repos = [vllm, sglang, vllm-ascend], excludeLabels = [ci-failure-tracker]
  │   ├─ cache.get("ai-infra|vllm-project/vllm,...|7|5") → miss
  │   ├─ query.js → "is:issue state:open repo:... repo:... repo:... updated:>2026-09-08 -label:ci-failure-tracker"
  │   ├─ ctx.safeFetch(GET api.github.com/search/issues?q=...&sort=updated&order=desc&per_page=5)
  │   ├─ 200, total=648, incomplete=false
  │   ├─ format.js → 5 行, 728 字符 ✅ (≤800)
  │   ├─ cache.put(...)   ← 失败也不影响返回
  │   └─ return { ok:true, summary, data:{query, total, items:[...5]} }
  │
  ├─ agent.js:239 → messages.push({ role:'tool', content: summary })   ← 只有 summary 进上下文
  │
  └─ 模型第 2 轮 → 把 5 条转述成中文（只呈现，不分析）
        finalText → memory.appendMessage({ role:'assistant' })          ← tool 消息不入库
```

**请求数：1。** 第二轮模型调用是 DeepSeek，不消耗 GitHub 配额。

---

## 8. 测试策略

### 8.1 分层

| 层 | 对象 | 是否需要网络 |
|---|---|---|
| L1 纯函数 | `query.js`、`format.js`、`known-domains.js` | ❌ 完全离线 |
| L2 技能级 | `index.js`，注入 mock `safeFetch` + mock `store.cache` | ❌ |
| L3 契约 | 领域表 ↔ description 一致性（§3.3） | ❌ |
| L4 真实 | **不放进 `pnpm test`**；手动用 `pnpm skill:test` 验证 | ✅ |

**开发期永不打真实 API**（项目既有纪律）。真实响应**捕获一次**进 `test/fixtures/github-issues/`，并记录 provenance。

### 8.2 fixtures 与 provenance

沿用项目既有做法（`test/fixtures/README.md` 的 provenance 记录约定）：

| fixture | 内容 |
|---|---|
| `search-issues-ai-infra.json` | 本次实测的真实响应（3 仓库 / 7 天窗 / 5 条） |
| `search-empty.json` | 合成的 `total_count: 0` |
| `rate-limited-403.json` + headers | **合成**的 403（真实 403 会把配额打光，不实测） |
| `incomplete.json` | 合成的 `incomplete_results: true` |

> ⚠️ 真实响应里含真实用户名与标题——**照原样存**，但**不要把响应体写进日志**（`egress.js` 只记 host + status，这条纪律本技能不破）。

### 8.3 必须覆盖的边界

| # | 用例 |
|---|---|
| T1 | 别名命中：`"AI infra"` / `"推理框架"` / `"LLM Serving"` → 同一 `id` |
| T2 | **未命中 → `NEED_DOMAIN`，且 `safeFetch` 调用次数为 0**（`repos` 也不发请求） |
| T3 | **参数缺失（空 `{}`）→ `NEED_DOMAIN`，0 请求** |
| T4 | `total_count: 0` → `ok:true`，summary 是可读说明**非空** |
| T5 | 403 → `RATE_LIMITED`，message 含恢复秒数；**不得**说"没找到" |
| T6 | 422 → `INTERNAL`（区分于"没找到"） |
| T7 | `incomplete_results: true` → summary 标注不完整 |
| T8 | **800 预算**：构造 6 条超长标题 → 输出**减条数**，且**每条 URL 完整**（正则断言无被截断的 URL） |
| T9 | **不分析**：给定标题含 `[Tracking]` 的输入，输出**只有**逐条事实，无趋势/结论词（对应 PRD AS9） |
| T10 | `repos` 传 8 个 → clamp 到 5；查询串长度防御触发时返回结构化错误 |
| T11 | 缓存命中：同进程第二次调用 → `safeFetch` 调用次数仍为 1，`cached:true` |
| T12 | **缓存写失败不影响返回**（mock `cache.put` 抛错 → 仍 `ok:true`） |
| T13 | 表项形状校验：对 `known-domains.json` **每一条**断言（含 `aliases` 跨条冲突） |
| T14 | 领域表 ↔ `skill.json` description 一致性（§3.3） |
| T15 | `excludeLabels` 出现在查询串里，形如 `-label:ci-failure-tracker` |
| T16 | **`ctx.signal` 被透传给 `safeFetch`**（mock 捕获 `options.signal`，断言非 undefined）——评审 A1 |
| T17 | **裁剪告知**：构造超预算输入 → summary 里出现"共 N 条，这里列了 M 条"——评审 B3 |
| T18 | **优先级**：`domain` 与 `repos` 同时给出 → 用 `repos`，不查领域表——评审 B2 |
| T19 | **`buildQuery` 确定性**：传固定 `now` → 断言查询串里的日期是固定值（评审 B1） |
| T20 | 缓存 key：显式 `repos` 时不含 `undefined`（评审 C2） |

---

## 9. 实施顺序

| 步 | 内容 | 可独立验证 |
|---|---|---|
| 1 | `known-domains.json` + `known-domains.js` + T13 | ✅ 纯离线 |
| 2 | `query.js` + T1/T10/T15 | ✅ 纯离线 |
| 3 | `format.js` + T8/T9 | ✅ 纯离线（**最易错，先做**） |
| 4 | `skill.json` + T14 + `pnpm skill:list` | ✅ |
| 5 | `index.js` 骨架（注入 mock）+ T2/T3/T4/T11/T12 | ✅ 无网络 |
| 6 | 真实抓取一次 → 存 fixture | ✅ 用掉 1 次配额 |
| 7 | 错误路径 T5/T6/T7（合成 fixture） | ✅ |
| 8 | `scripts/skill-test.js` 打印 `data`（§3.1） | 手动 |
| 9 | 真实环境 `pnpm skill:test github_issues '{"domain":"ai infra"}'` | ✅ 用掉 1 次配额 |

**1–5 步完全不联网、不花配额**，可以先并行推进。

---

## 10. 风险与备选

| # | 风险 | 缓解 |
|---|---|---|
| S1 | 领域表漏了用户想查的领域 | `NEED_DOMAIN` 会**列出全部已知领域**，用户立刻知道自己该说什么（0 请求） |
| S2 | 配额（10/min，共享 IP） | 0/1 请求路径 + `db:cache` 5 分钟 + 如实报错 |
| S3 | `excludeLabels` 覆盖面不足（label 名因仓库而异） | v0 人工维护，记入 PRD §11.3 待办 |
| S4 | `format.js` 的 800 裁剪写错 → 静默截断 URL | T8 正则断言 + §3.2 明确"技能自己保证 ≤800" |
| S5 | 领域表 ↔ description 漂移 | T14 契约测试（§3.3） |
| S6 | UTC 日期跨时区差一天 | 记录为已知误差（§5.2），不修正 |
| S7 | 256 字符查询长度上限**未验证** | 防御性检查；若实测更严，调小 `repos` 上限 |

---

## 11. 待确认

1. **`excludeLabels` 首批取值** —— 现填 `ci-failure-tracker`（仅 sglang 约定）。vllm / vllm-ascend 是否有同类 label？需人工确认后补齐。
2. **256 字符查询长度上限** —— 未验证。落地前用一个长查询串实测一次。
3. **`data` 的 v1 归属** —— v0 只接上 `skill:test`；UI 渲染是 v1。**若 v1 仍不做，应把 `data` 从契约删除**（§3.1）。
4. **技能名** —— 已定 `github_issues`（PRD §11.4 闭合）。

---

*本文档只定技术方案。实现前请先闭合 §11 的 1、2 两项。*
