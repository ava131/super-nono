# PRD · Issues（GitHub 领域 issue 追踪）— v0

> 状态：**已评审（2026-09-16）** ｜ 首次定稿：2026-09-14 ｜ 依赖：[PRD-Skill v0](PRD-Skill-v0.md)（技能契约，已冻结）
>
> 评审记录（两份，都被采纳）：[评审 A · 2026-09-16](v0-review-20260916-1904.md)（对抗式评审，6 条 A 级 + 8 条 PM 裁定）、[评审 B · 2026-09-14](v0-review-20260914-1230.md)（自审）

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0 | 2026-09-14 | 初稿。基于 **6 次对 GitHub 真实 API 的实测** 定稿；所有数字标注「实测」，估计值单独标注。原始输出见 [附录 A](#附录-a实测原始输出)。 |
| v0.1 | 2026-09-14 | 第二轮实测（+7 项）：① 查清 `summary` 的**真实 token 成本与生命周期**（§6.4）；② 澄清 `data` 是「未接线」而非 bug（§6.3）；③ **推翻**「机器人噪声来自 GitHub App 机器人」这一假设，并给出唯一可用手段（§7.7）。 |
| v0.2 | 2026-09-14 | ④ **更正 §7.3**：`read_only` + `db:cache` 实测**合法**（原结论撤回），缓存改为**持久化**方案；⑤ 技能定名 `github_issues`；⑥ 技术方案见 [SDD-issues-v0](SDD-issues-v0.md)。 |
| v0.4 | 2026-09-16 | **并入 [评审 v0-review-20260916](v0-review-20260916-1904.md)（444 行，8 条 PM 裁定）**：⑨ §4.2 加 `repoAliases`（AS1 里「vllm」原本解析不出来）；⑩ §3.1 加 `comments:>0`，口径改为「最近**有人讨论**」；⑪ §4.5 按 A2 裁定改为「description 只声明行为、不枚举内容」；⑫ Q7：`data` → 气泡由 v1 提到 **v0**（跨 5 层改动）；⑬ 更正 G5（`spawn` 并非「全仓库 0 处」）。**本次修订后本文档状态为「已评审」。** |
| v0.3 | 2026-09-14 | 评审修订（见 [v0-review](v0-review-20260914-1230.md)）：⑦ **补 §5.2 缺失的 `windowDays` 参数**（A3——校验器静默忽略未声明字段）；⑧ 明确 `domain`/`repos` 同时给出时以 `repos` 为准（B2）。 |

---

## 0. 这份文档为什么是"功能 PRD"

与 [PRD · Market](market/PRD-market-v0.md) 同理：本功能横跨 **Brain**（模型怎么呈现）、**Skill**（查询与配额）、**Persona 边界**（不许分析）三层，按层拆会把一个决定切碎。

**本文的一条纪律**：§1–§9 里出现的每个数字，要么标了「实测」（附录 A 有原始输出），要么标了「未验证」。**没有第三种。**

---

## 1. 背景与目标

### 1.1 一句话

用户说一个领域（如 "AI infra"），返回该领域核心项目**最近有动静**的 issue 列表——**只呈现，不解读**。

### 1.2 它解决什么问题

想跟一个快速演进的领域（AI infra、推理框架），但 GitHub 本身没有"领域动态"视图：

- 关注单个 repo → 要自己开 N 个页面
- 看 repo 的 issue 列表 → 默认按创建时间，淹没在原始报错流里
- 看 trending → 只有仓库，没有 issue

已有的同类方案（[gh-issues](https://www.awesomeskill.ai/skill/steipete-clawdis-gh-issues)、[github-mcp-server](https://github.com/github/github-mcp-server)、[github-search](https://www.skill-gallery.jp/en/skills/parcadei/github-search)）**全部建在 `gh` CLI 或 MCP 之上**，而本项目两条路都不通：技能拿不到 `child_process`（**`src/` 与 `skills/` 零处** `spawn`/`execFile`；唯一一处在 `test/unit/capture-eastmoney.test.js`），宿主没有 MCP 客户端。

> **结论：这是本项目唯一只能走纯 REST 的路径，也因此只有我们会认真处理 REST 的配额问题。**

### 1.3 v0 目标

| # | 目标 |
|---|---|
| G1 | 说一个已知领域 → 返回 5 条该领域**最近有更新**的 issue（标题 + 网址 + 时间 + 评论数 + 标签） |
| G2 | 领域不明确或未收录 → **明确反问/列出可选项**，绝不猜 |
| G3 | 配额耗尽 / 数据不完整 → **如实告知**，不伪装成"没找到" |
| G4 | 纯只读，`read_only`，不触发 L2 确认，不碰 L3 红线 |

### 1.4 非目标（v0 明确不做）

| 不做 | 原因 |
|---|---|
| **任何分析、总结、趋势判断** | §2，这是本版最重要的决定 |
| 抓取 issue 正文 | N 条 issue = N 次请求，配额（10/分钟，实测）扛不住 |
| 发评论 / 建 issue / 开 PR | 会把技能推到 L2/L3，v0 不要 |
| 自定义领域（用户从没听过的领域） | v0 只支持 `known-domains` 表内的领域；带显式 `repos` 逃生通道 |
| GitHub Token 配置 | 见 §11 待确认 1 |
| 跨领域聚合、时间线、图表 | v1+ |

---

## 2. 能力边界（本 PRD 最重要的一节）

### 2.1 只呈现，不分析 —— 这是硬边界

**skill 只做检索。最终回答里不得出现 skill 未返回的事实。**

这里的诱惑很具体：skill 返回 5 个标题，用户会问"最近社区遇到什么问题"。**让模型用 5 个标题去回答这个问题，就是在邀请它编造。**

### 2.2 为什么这个边界是对的（而不是偷懒）

不是因为"分析难"，而是因为**信息量根本不够**：

- 模型的可见输入只有 `summary`——**上限 800 字符**（§6，实测）
- 5 条 issue 的标题 + 元数据就吃掉 728/800
- 剩下的 72 字符**装不下任何可信的推断**

三条实测证据说明"标题 ≠ 社区问题"：

| 实测观察 | 含义 |
|---|---|
| `sgl-project/sglang#17050 [Tracking] CI Test Failures and Fixes`（14 评论）| 这是**机器人/维护者的 CI 汇总帖**，不是"社区遇到的新问题" |
| `vllm-project/vllm#56980 [Bug]: MiniMax-M3 MSA crashes`（**0 评论**）| 可能是真问题，也**可能没人确认过**——从标题看不出来 |
| `vllm-project/vllm-ascend#16600 [Misc]: 910B2 + Vllm ascend 0.23.0 + Qwen3.5 9B 速度很慢` | 中文标题，UTF-16 每字 1 单元，**排版预算比英文宽松** |

**所以"不分析"不是能力缺失，是对信息量的诚实。** 这与项目已有的两条资产一致：

- PRD-market §2.3「明确禁止的输出」——六类禁止输出（含"确定性断言"）
- PRD-Brain 的数字溯源原则——「回答里每个数字都能追溯到工具返回值」

### 2.3 明确禁止的输出（v0）

| # | 禁止 | 反例 |
|---|---|---|
| F1 | 声称"社区普遍/大家都在遇到 X" | "社区最近普遍在反馈 GLM-5.3 的问题" |
| F2 | 推断趋势、走向、"最近进展是…" | "可以看出 vLLM 正在重点修 MSA" |
| F3 | 归类若干条 issue 得到结论 | "这几条都是同一个根因" |
| F4 | 描述 issue 正文内容 | "作者说崩溃发生在 prefill 阶段"（skill 没返回正文） |
| F5 | 补全 skill 未返回的字段 | 猜 label、猜是否已有 PR |
| F6 | 把 bot 汇总帖说成"社区问题" | 见 §2.2 的 `[Tracking] CI Test Failures` |

**允许的**：逐条列出标题、网址、时间、评论数、标签；把英文标题翻译成中文（**标注为翻译**）；说明"共查到 N 条，这里列 5 条"。

---

## 3. 查询设计

### 3.1 `active` 配方（已实测选定）

```
is:issue state:open repo:{R1} repo:{R2} … updated:>{今天 − windowDays} -label:{noise}
  &sort=updated&order=desc&per_page={limit}
```

**为什么这样拼**：

| 片段 | 作用 | 依据 |
|---|---|---|
| `is:issue` | **排除 PR** | 实测：返回项无 `pull_request` 字段。⚠️ 该端点默认**混 PR**，漏了就混进来 |
| `state:open` | 只要未关的 | — |
| `repo:` × N | 限定领域 | 实测：**多 `repo:` 是 OR**（见 §3.3） |
| `updated:>7d` | 时间窗 | 噪声控制的主力（§3.5） |
| `sort=updated` | 按最近有动静 | §3.5 |
| `-label:{noise}` | 排除自动化噪声 | **实测精确生效**（648→647）；只能靠 label，`author:app/*` 无效（§7.7） |
| `per_page=5` | 对齐 800 预算 | §6.1 **实测 5 条是硬上限** |

### 3.2 两段式：领域 → 仓库 → issue

```
用户："AI infra 有什么新 issue"
   │
   ├─ 第一段：领域 → 仓库列表      ← 查本地表 known-domains.json（0 次请求）
   │            "ai infra" → [vllm, sglang, vllm-ascend]
   │
   └─ 第二段：仓库 → issue         ← 1 次请求（§3.1）
```

**请求数：1 次。** 因为第一段走本地表，不联网。

> 早期设计曾考虑"先用 `topic:` 搜仓库"作为第一段（2 次请求）。**已否决**，理由是实测它会静默返回垃圾（§4.1）。

### 3.3 多 `repo:` 是 OR（实测 ✅）

```
q = is:issue state:open repo:vllm-project/vllm repo:sgl-project/sglang sort=updated
→ total_count: 3305
→ 返回项仓库集合 = {vllm-project/vllm, sgl-project/sglang}
```

这是**两段式能成立的前提**——一次请求覆盖多个仓库。

### 3.4 时间窗

`updated:>{今天 − windowDays}`，**`windowDays` 默认 7**（§5.2 参数）。理由：`active` 的语义是"最近有动静"，7 天足够覆盖一个快速领域的一轮讨论周期；领域冷清时可调大，热点爆发时可调小。

> ⚠️ 该参数**必须出现在 §5.2 的 schema 里**——校验器静默忽略未声明字段（评审 A3）。

### 3.5 排序：为什么不是 `created`（含一次自我更正）

**用户最初的诉求是"最新 issue"，但实测否掉了 `created`：**

| 实测量 | 值 |
|---|---|
| vLLM 未关 issue 总数 | **7959** |
| `sort=created` 最新 5 条 | **全部 0 天**（今天刚开） |
| 其中 0 评论的 | **3 / 5** |

对 vLLM 这种高频仓库，`created` 倒序 ≈ **最近十分钟的原始报错流**，而且一半没人确认过。这不是"领域动态"。

**`sort=updated` 实测反而很干净**（前 10 条，`created` 年龄分布）：

```
created    0d   updated 0d  c: 0   [Bug]: MiniMax-M3 MSA crashes...
created    3d   updated 0d  c:16   [Bug]: GLM-5.3-Flash degenerates...   ← 真信号被顶上来
created   26d   updated 0d  c: 4   [Bug]: Multi card issue...
（10 条中仅 1 条是 26 天前的老 issue，其余全部 0–3 天）
```

> ⚠️ **自我更正**：本 PRD 起草过程中曾担心「`sort=updated` 会被机器人改标签翻上来的老 issue 污染」。**实测不支持这个担心**（10 条里只有 1 条老 issue）。原担心撤回，记录在此以免后人重复提出。

---

## 4. 领域表 `known-domains.json`

### 4.1 为什么必须有这张表，而不是让模型猜 `topic:`

**实测：`topic:` 在 issue 搜索里无效，只在仓库搜索里有效。而且猜错 topic 不报错，只静默返回垃圾。**

| topic | total_count | top repo | 判断 |
|---|---|---|---|
| `topic:ai-infra` | **133** | `opensandbox-group/OpenSandbox` | ❌ 无人知晓 |
| `topic:llm-inference` | 3459 | **`nomic-ai/gpt4all`** | ❌ 桌面 LLM 应用，不是 infra |
| `topic:llm-serving` | 406 | `vllm-project/vllm` | ✅ 正确 |
| `topic:inference-engine` | 752 | `halfrost/Halfrost-Field` | ❌ **博客笔记仓库** |
| `topic:ai-infrastructure` | 1614 | `semantica-agi/semantica` | ❌ 无人知晓 |

**"AI infra" 翻成 `ai-infra` 还是 `llm-serving`，差别是 133 vs 406 个仓库、top 一个是无名项目一个是 vllm。而 GitHub 对拼错的 topic 不报错。**

这是本技能**最危险的失败模式：不报错，只是一个看起来很正常的错误答案。**

> **决定：`topic:` 搜索不作为主路径。** 领域→仓库由本地表唯一决定（可离线校验、可测试），与 `market` 用 `known-symbols.json` 把"茅台"解析成 `600519.SH` **是同一个模式**。

### 4.2 表结构

```jsonc
{
  "domains": [
    {
      "id": "ai-infra",
      "label": "AI Infra / 大模型推理基础设施",
      "aliases": ["ai infra", "ai基础设施", "推理框架", "大模型推理", "llm serving", "llm inference", "推理加速"],
      "repos": ["vllm-project/vllm", "sgl-project/sglang", "vllm-project/vllm-ascend"],
      "repoAliases": {
        "vllm": "vllm-project/vllm",
        "sglang": "sgl-project/sglang",
        "vllm-ascend": "vllm-project/vllm-ascend"
      },
      "excludeLabels": ["ci-failure-tracker"]
    }
  ]
}
```

> `excludeLabels` 是**按领域**声明的，不是全局硬编码——理由见 §7.7：自动化噪声要靠 label 精确排除，但 label 名因仓库而异。
>
> **`repoAliases`（评审 A6）** 是"用户口语里怎么叫这个仓库"。它的存在理由是 AS1：「帮我找一下 **vllm** 最新的 issue」里 `"vllm"` **既不是领域 id 也不是领域别名**，没有它就只能走 `NEED_DOMAIN`，与 AS1 直接冲突。命中短名 → 走**单仓库路径**（1 次请求）。
> ⚠️ **不能**把 `"vllm"` 直接塞进 `aliases`：那会把"vllm"解析成**整个 ai-infra 领域**，返回 3 个仓库混在一起的 5 条，与用户意图不符。

`aliases` 是这张表的**全部价值**：中文用户说"推理框架"，英文用户说 "LLM serving"，指向同一组仓库。

### 4.3 种子内容（v0）

三条种子仓库**已联网核实存在**（`GET /repos/`，走 core 配额，不消耗 search 配额）：

| repo | stars | open issues |
|---|---|---|
| `vllm-project/vllm` | 91,802 | 7,959 |
| `sgl-project/sglang` | 35,979 | 5,337 |
| `vllm-project/vllm-ascend` | 2,825 | 3,267 |

> 注意 `vllm-ascend` 只有 2825 stars 却有 3267 个未关 issue——**小仓库的 issue 量可以和大仓库同量级**，所以"按 star 筛种子"是错的方法，种子必须人工选定。

### 4.4 未命中领域的处理

| 情况 | 行为 | 请求数 |
|---|---|---|
| `domain` 命中表 | 正常查询 | 1 |
| `domain` 未命中 | **不查**，返回表中所有 `id`/`label` + 提示"未收录，可换一个，或直接给 `owner/repo`" | 0 |
| 模型/用户给了显式 `repos` | 跳过表，直接查 | 1 |

**关键：未命中时一次请求都不发。** 既省配额，也避免"猜一个 topic 然后返回垃圾"。

### 4.5 领域清单怎么让模型知道（**含一次方案更正**）

> ⚠️ **更正**：本节初稿的方案是「把领域清单写进 `skill.json` 的 `description`，再用测试断言两份清单一致」。**实测证明这行不通**——见 §5.4 的 200 字上限，以及评审 [A4](v0-review-20260914-1230.md)。原方案撤回。

**实现改为一句话：模型不需要预先知道领域清单；它不带参数调用一次本技能就能拿到。**

```
用户："帮我找一下 issue"（没说领域）
  → 模型调用 github_issues({})          ← 0 次网络请求
  → 技能返回 NEED_DOMAIN + 领域清单
  → 模型据此反问："你是想看 ai-infra 吗？"
```

好处有三条：

1. **可扩展**——加领域只改 JSON，不碰 description；description 的 200 字预算不会被领域数量挤爆
2. **无漂移**——清单只有**一个**来源（`known-domains.json`），不存在"两张清单不一致"
3. **确定性**——不依赖模型记得住清单，行为由代码保证

所以 description 只需要写清楚**「领域不明确就直接不带参数调用本技能」**这一句，而不是列出领域。

---

## 5. 技能接口

### 5.1 manifest

```jsonc
{
  "name": "github_issues",
  "version": "0.1.0",
  "description": "查询某个技术领域核心项目最近有更新的 GitHub issue……（含 §4.5 要求的领域清单）",
  "parameters": { /* §5.2 */ },
  "permissions": ["network:github_issues", "db:cache"],
  "networkHosts": ["api.github.com"],
  "risk": "read_only",
  "requiresConfirmation": false,
  "timeoutMs": 15000
}
```

> `db:cache` 用于**持久**缓存（§7.3）：`read_only` + `db:cache` 是合法的组合（`store.js:238`），GitHub 配额按出口 IP 计、重启 app 不重置，所以持久缓存能真正省请求。

`timeoutMs` 取 **15000**（weather 是 10000）：两段式虽只有 1 次请求，但 GitHub 搜索 API 偶发慢，留余量。

### 5.2 参数

```jsonc
{
  "type": "object",
  "properties": {
    "domain": {
      "type": "string",
      "description": "领域名，如 ai infra / 推理框架。未收录时会返回可选项列表"
    },
    "repos": {
      "type": "array",
      "items": { "type": "string" },
      "description": "可选：直接指定 owner/repo 数组，绕过领域表。最多 5 个。与 domain 同时给出时以 repos 为准"
    },
    "windowDays": {
      "type": "integer", "minimum": 1, "maximum": 30,
      "description": "只看最近 N 天内更新过的 issue，默认 7"
    },
    "limit": {
      "type": "integer", "minimum": 1, "maximum": 5,
      "description": "返回条数，默认 5。上限 5 是因为模型可见的 summary 只有 800 字符"
    }
  }
}
```

> ⚠️ **`windowDays` 必须出现在上面**（评审 A3）：校验器对**未声明的字段是静默忽略**的（`schema.js:211`），漏写等于模型传了也没用、永远走默认值。
>
> **`domain` / `repos` 同时给出时以 `repos` 为准**（评审 B2）——必须写进 description，否则模型两个都传时行为不可预测。

**`required` 不声明（空）** —— 这是一个刻意的设计：

> 用户只说"帮我找一下 issue"时，模型可以**不带参数调用**，skill 立即返回领域清单（0 次请求），模型据此反问"你是想看 AI infra，还是……"。
>
> 这样"反问"这条路是**确定性的**，不依赖模型记得住领域清单。

**`repos` 的 5 个上限必须在代码里 clamp**：校验器**不支持 `maxItems`**（§5.3），只声明是拦不住的。

### 5.3 参数校验的真实边界（实测）

`src/main/skills/schema.js` 是**手写**校验器，实测**只支持 7 个关键字**：

```
type / properties / required / enum / items / minimum / maximum
```

由此两条约束：

1. **`required` 缺省即 `[]`**（实测 `schema.js:200`），所以 §5.2 的"空 required"合法
2. **无 `maxItems`** → 数组长度**必须自己 clamp**；`definitions`/`$ref`/`oneOf` 也不支持

### 5.4 `description` 有 **200 字硬上限**（实测，差点让技能上不了线）

```
schema.js:74   if (m.description.length > 200) errors.push('…模型看不完')
```

**超过 200 字不是"警告"，是技能被直接禁用**：`registry.loadSkills()` 会把它放进 `failed`，`pnpm skill:list` 的「被禁用的技能」里才看得到。

实测现有技能的 description 长度：

| 技能 | 长度 |
|---|---|
| `weather` | 51 字 |
| `watchlist` | 55 字 |
| `market` | 93 字 |
| **`github_issues`（初稿）** | **372 字 → 被禁用** ❌ |
| `github_issues`（定稿） | **137 字** ✅ |

**这 200 字要装下三件事**：何时使用 + 「领域不明确就带空参数调用本技能」+ 「只呈现不分析」。

**因此领域清单不能放进 description**（§4.5 的更正），否则领域一多必然超限。**这也是为什么必须有一条"用真校验器跑一遍 manifest"的测试**——它在 `pnpm test` 里当场抓住了这个问题，而 `pnpm skill:list` 只在角落的小字里报错。

---

## 6. `summary` 预算（800 字符硬顶）

### 6.1 实测：6 条放不下

`SUMMARY_LIMIT = 800`（`shared/limits.js:28`），单位是 **UTF-16 码元**（中文 1 字 = 1 单元，不是 3 字节）。截断发生在 `runner.js:212`。

对齐 §3.1 的真实查询，实测排版长度：

| 条数 | label 数 | 长度 | 结果 |
|---|---|---|---|
| **6** | 3 | **956** | ❌ **超了** |
| 5 | 0 | 684 | ✅ |
| **5** | **2** | **728** | ✅ **选定** |
| 5 | 3 | 746 | ✅ |

> **所以「3–5 条」的 5 是硬上限，不是偏好。** 6 条必然被静默截断——用户会看到**残缺的最后一条且毫无提示**（这正是 `shared/limits.js` 开头警告的那个 bug）。

### 6.2 排版规则（选定格式）

```
{owner}/{repo}#{num} {Nd} c:{comments} {title≤55} {html_url} [{label1,label2}]
```

真实样本（实测输出）：

```
sgl-project/sglang#17050 0d c:14 [Tracking] CI Test Failures and Fixes https://github.com/sgl-project/sglang/issues/17050
vllm-project/vllm-ascend#15920 0d c:2 [Bug]: Long-context single-request OOM at prefill https://github.com/vllm-project/vllm-ascend/issues/15920 [bug,triaged]
vllm-project/vllm#56981 0d c:0 [Bug]: Qwen3-ASR audio preprocessing produces differ https://github.com/vllm-project/vllm/issues/56981 [bug]
vllm-project/vllm#56980 0d c:0 [Bug]: MiniMax-M3 MSA crashes with quack-kernels 0.6.5 https://github.com/vllm-project/vllm/issues/56980 [bug,minimax]
vllm-project/vllm#56605 0d c:16 [Bug]: GLM-5.3-Flash degenerates into repeated-token https://github.com/vllm-project/vllm/issues/56605 [bug,glm]
```

| 规则 | 值 | 理由 |
|---|---|---|
| 标题截断 | 55 字符 | 实测值，兼顾可读与预算 |
| label 数 | 2（过滤 `status:` 前缀） | `status:` 类是 triage 流水线噪声 |
| 网址 | **完整 URL 必须保留** | 这是模型**唯一无法自己生成**的事实；宁少列一条也不能丢 |
| 超预算时 | **减少条数，截断永不发生在最后一条的网址上** | 见 §6.1 的红线 |
| 加序 | 不排序（`sort=updated` 的顺序即答案） | 排序 = 分析，违反 §2 |

### 6.3 `data` 字段：不是 bug，是**未接线的预留位**（实测）

```
runner.js:213   data: r.data        ← 全仓库唯一出现处，只是原样放进返回值
agent.js:239    messages.push({... content: result.summary})   ← 只回填 summary
scripts/skill-test.js:100   console.log(result.summary)        ← 测试脚本也只打 summary
```

**`data` 目前没有任何消费者**——不进模型上下文、不进 UI、测试脚本也不打印。README 说它 "raw, not in context"，实际是**哪都不进**。

**这不是 bug，但也不是完成态**——它是一个**契约里有、接线断了**的字段：不违反任何不变量（没有任何东西因为它而错），代价只是"放进去的东西消失了"。合理解释是 v0 预留（将来给调试面板/UI 用），但**只有作者知道是不是漏接了**。

**关键区别（回答"它关乎上下文长度吗"）**：

| 字段 | 进模型上下文？ | 消耗 token？ | 现状 |
|---|---|---|---|
| `summary` | ✅ 进（`agent.js:239`） | ✅ 是 | 唯一有效载荷 |
| `data` | ❌ **完全不进** | ❌ **零成本** | 无消费者，等价于丢弃 |

> **所以："放宽 `data` 能省 token" 和 "`data` 里能放更多东西" 是同一个事实的两面——它根本不经过模型，你放多少都不花钱，但也放多少都看不见。**

**影响本 PRD**：不能指望"细节放 `data`、摘要放 `summary`"。**所有要给模型看的东西都必须挤进 800。**

**v1 的一个明确方向**：给 `data` 接上消费者（UI 渲染完整可点击列表），就能做到「模型只叙述 5 条，气泡里展示 20 条」——这是绕开 800 限制的正解，比放宽上限更干净。

### 6.4 `summary` 的真实 token 成本（实测代码路径）

**问题**：「800 是不是因为怕费 token？放宽到 3000 行不行？」

**答案：成本不是瓶颈，但放宽容错要付两次代价。**

**① 生命周期：`summary` 只活在当前这一轮，不跨轮累积。**（本轮实测的关键发现）

```
agent.js:138,196,245   appendMessage 只被调用过 role: 'user' / 'assistant'
                       ★  role: 'tool' 从未被持久化
memory.js:231          recentMessages() 默认取 WINDOW_SIZE = 40 条
memory.js:234          SELECT ... WHERE session_id=? AND content IS NOT NULL   ← 无 role 过滤
```

因为 `tool` 消息**从不入库**，下一轮对话重新加载历史时**它已经不存在了**。所以：

- **轮内**：`summary` 被追加进 `messages`，而 `messages` 在工具循环的**每一轮**都整体重发给模型 → 一次提问里可能发 2–3 遍
- **跨轮**：**不累积**。你问第 10 个问题时，第 1 个问题的 issue 列表早已不在上下文里

**② 成本量级（估算，非实测）**

以 `config/pricing.json` 的 `deepseek-chat`（输入 ¥2/M）为例：

| 场景 | 字符 | ≈token | ×3 轮 | 成本 |
|---|---|---|---|---|
| 现状 800 | 800 | ~200–530 | ~1600 | **¥0.003** |
| 放宽到 3000 | 3000 | ~750–2000 | ~6000 | **¥0.012** |

**一次提问多花不到两分钱。成本完全不是拒绝放宽的理由。**

**③ 那 800 到底在防什么？** 回到 B-6d 的原文：

> `docs/PRD-Brain-v0.md:194` ｜ B-6d | 工具结果回填前截断到 N 字符，**避免一次请求把上下文撑爆**

它是**安全阀**，防的是一个失控技能返回 500KB 把单次请求撑爆——**不是省钱手段**。

**④ 结论：不建议把 `SUMMARY_LIMIT` 改成 3000。** 三条理由：

1. **它是全局契约常量**，不是本技能的私有参数。`shared/limits.js:11` 明确写了它被 `runner.js`（截断）和 `skills/market/snapshot.js`（**表格排版**）共用，并警告"两边不一致 → 用户看到残缺数据且毫无提示"。改 3000 会**连带改变 market 的排版行为**，需要重新验证 market，属于跨模块改动。
2. **800 已经够用**：实测 5 条 = **728**，正好覆盖 §1.3 要求的 3–5 条。
3. **3000 换来的 ~18 条对聊天场景是负价值**——气泡里列 18 条没人看。

**如果将来真要显示更多**：优先做 §6.3 末尾那条路（给 `data` 接消费者，UI 展示全量），其次才是在 SDD 里引入**按技能声明的上限**（新契约字段），**而不是动全局常量**。

> 附带发现：`WINDOW_SIZE = 40`（`memory.js:19`）才是上下文增长的真实来源——它随**对话轮数**增长，与 `summary` 无关。

---

## 7. 配额与失败处理

### 7.1 实测配额

```
x-ratelimit-limit: 10
x-ratelimit-resource: search
```

**search 资源：未认证 10 次/分钟，且按出口 IP 共享。** 起草本文档期间的 6 次探测就吃掉了大半配额。

> 这不是理论风险：本技能命中领域时一次调用 = 1 次 search，**每分钟最多约 5 次用户提问**。

### 7.2 请求预算

| 路径 | 请求数 |
|---|---|
| 领域命中 + 显式 repos | 1 |
| 领域未命中 / 空参数（列清单） | **0** |
| 抓 issue 正文 | **永不**（§1.4） |

### 7.3 缓存：用 `db:cache` 持久化（**含一次更正**）

> ⚠️ **更正**：本节初稿曾写「`read_only` 技能不能写 `ctx.store`，所以用不了 `db:cache`」——**这是错的**。
> 实测 `store.js` 有**两道独立的闸门**：
> - `guardWrite`（用户数据，`store.js:216`）→ 按 `WRITABLE_RISKS` 判定，`read_only` **被拒**
> - `guardCacheWrite`（私有缓存，`store.js:242`）→ **只查 `db:cache` 权限，不看 `risk`**
>
> `store.js:238` 的原注释写得很明确：「**声明了 `db:cache` 权限的技能，即使 `read_only` 也能写自己的缓存。这不是给 `read_only` 开口子，而是承认"用户数据"与"私有缓存"是两种东西。**」
> `market` 就是 `read_only` + `db:cache` 的现成例子。原结论撤回。

**所以本技能用 `db:cache`，不用进程内存。** 理由在这个场景下特别强：

**GitHub 的 search 配额是「按出口 IP、每分钟」计的——重启 app 并不会重置它。** 进程内存缓存一重启就失效，等于把已经花掉的配额白扔；持久缓存能真正省请求。

- 权限：`permissions: ["network:github_issues", "db:cache"]`
- key：`domain|repos|window|limit`
- **⚠️ `ctx.store.cache` 没有内置 TTL**（实测只有 `get`/`put`/`drop`/`clear`）→ 技能必须把时间戳一起存：`{ at: Date.now(), items: [...] }`，读取时自查过期（TTL 5 分钟）
- 写缓存前先 `guardCacheWrite` 的失败路径要**容错**：缓存写失败不能导致整个查询失败（缓存是优化，不是正确性）
- 命名空间有字节上限（`MAX_NAMESPACE_BYTES`）→ 只存**已排版好的 5 条**，不存原始 JSON 响应

**副作用**：`pnpm skill:test` 单次进程调用测不到"跨进程命中"，但**能测到同进程内的第二次命中**；持久化缓存还可以直接查库验证。比进程内存方案可测得多。

### 7.4 失败必须如实（不许伪装成"没找到"）

| 情况 | 必须返回 |
|---|---|
| HTTP 403 / `x-ratelimit-remaining: 0` | **"GitHub 配额已用尽，约 X 秒后恢复"**（读 `x-ratelimit-reset`） |
| `state: 422` | 查询拼装出错（**是 bug，不是"没找到"**） |
| `total_count: 0` | 分三义处理（§7.5） |
| 网络/超时 | 原样报错 |

`safeFetch` 返回 `Response`，所以 `x-ratelimit-*` 头读得到，**不需要改 egress**。

### 7.5 `total_count: 0` 的三义性

0 可能是 ① 真的没有 ② 领域词没对上 ③ 窗口太窄。**不能都说"没找到"。** 处理：

1. 领域不在表里 → 已经由 §4.4 在 0 请求阶段拦掉（不可能是这个原因）
2. 表里命中但 0 结果 → 返回"这 3 个仓库最近 7 天没有更新的 issue"，**并给出放宽窗口的建议**

### 7.6 `incomplete_results` 必须检查

GitHub 在结果集过大时返回**不完整的**数据。实测几次均为 `false`，但 vLLM 有 **7959** 个未关 issue，一旦触发而没检查，"最近 5 条"就是**假的**。

- 若为 `true` → summary 里**明确标注**"结果不完整"

### 7.7 自动化噪声：实测结论与唯一可用手段

**什么是"机器人噪声"**：由**自动化**而非人在讨论中创建的 issue。它们混在 `active` 结果里，看起来像"社区动态"，实际是机器在自言自语。实测抓到的两个样本：

| issue | 评论 | label | 真实作者 |
|---|---|---|---|
| `sgl-project/sglang#17050 [Tracking] CI Test Failures and Fixes` | 14 | （无） | `alisonshao` |
| `sgl-project/sglang#37451 [Failure Tracker] PR Test (AMD)` | 0 | `ci-failure-tracker` | `bingxche` |

**① 假设被推翻：这些不是 GitHub App 机器人。**

```
基础 active 查询                        total=648
  author:app/dependabot                 total=0
  author:app/github-actions             total=0
  author:app/renovate                   total=0
排除两个 App 机器人后                    total=648   ← 差值 0，什么都没滤掉
```

决定性旁证：`is:issue author:app/dependabot`（**全站**）→ `total=1`，说明**语法有效**，那三个仓库确实没有 App 机器人。

**② 真正的原因：自动化跑在普通用户账号上。** 两个样本的 API 字段都是：

```
user.login = alisonshao / bingxche      user.type = "User"
```

**`user.type` 区分不出来。GitHub 也没有任何字段能区分"人"和"用 PAT 跑的 CI 脚本"。**

> ⚠️ 这一条推翻了我起草本 PRD 时提出的 `-author:app/dependabot` 方案——**那个手段对本场景无效**（虽然语法合法）。记在这里以免后人重复提出。

**③ 唯一实测可用的手段：负向 label 过滤（精确生效）。**

```
基础                        total=648
-label:ci-failure-tracker   total=647     ← 差值恰为 1 ✅
```

负向 label 过滤**精确减去对应条数**，不会误伤其他结果。

**④ 产品判断：两类噪声要区别对待，不能一刀切。**

| 样本 | 性质 | 处理 |
|---|---|---|
| `[Tracking] CI Test Failures and Fixes`（14 评论、维护者开） | **可能正是用户想追的"领域动态"** | **保留** |
| `[Failure Tracker] PR Test (AMD)`（0 评论、`ci-failure-tracker`） | 纯 CI 噪声 | 排除 |

**v0 建议**：在领域表里加一个可选的 `excludeLabels`，由**领域**声明要排除的 label（而不是全局硬编码），拼进查询时用 `-label:`。这样既精确、可测试，又保留了维护者汇总帖。

> 未解决：label 名因仓库而异（`ci-failure-tracker` 是 sglang 的约定），**v0 不做自动发现**，靠人工在领域表里维护。

---

## 8. 与 MCP 的关系

[PRD-Skill §5](PRD-Skill-v0.md) 已冻结决策：**v0 不引入 MCP SDK，接口保持 MCP 兼容形状，v1+ 再评估接入 MCP 客户端。**

本 PRD **遵守该决策**，并补充两条 §5 当时未列出的**结构性风险**（供 v1 评估时使用）：

1. **MCP 会打破「出网唯一出口」这条不变量。** `egress.js` 的飞行模式 / 强制 HTTPS / 域名白名单，全部建立在"技能只能用 `ctx.safeFetch`"之上。MCP server 是**独立进程自己出网**，三道闸门全部绕过——README 的 "All outbound traffic goes through one chokepoint" 会**变成假话**。
2. **MCP 工具没有 `risk` 字段，L1/L2/L3 分级失效。** 官方 GitHub server 带 `issue_write` / `create_pull_request`，一次模型幻觉即可改线上仓库。

**如果将来要接**：优先**远程 HTTP MCP**（不 spawn 本地进程，出网仍可走 `safeFetch`），并把 MCP 工具**一律映射为 L2**。

> 补充事实（**未验证**，落地前必须重新核实）：官方 `github/github-mcp-server` 为 Go 编译产物，`src/` 与 `skills/` 实测**零处** `child_process`/`spawn`/`execFile`，且 `package.json` 的 `dependencies` 为 `undefined`——MCP stdio 会是本项目**第一个子进程**，与"零运行时依赖 / 零后端服务"的定位正面冲突。

---

## 9. 验收标准

| # | 场景 | 期望 |
|---|---|---|
| AS1 | "帮我找一下 vllm 最新的 issue" | 1 次请求，返回 5 条，含完整网址 |
| AS2 | "AI infra 最近有什么新问题" | 命中别名，同上 |
| AS3 | "帮我找一下 issue"（无领域） | **0 次请求**，返回领域清单并反问 |
| AS4 | "帮我找一下 rust 异步运行时的 issue" | **0 次请求**，明说未收录 + 列出已知领域 + 提示可给 `owner/repo` |
| AS5 | 显式给 `repos` | 跳过领域表，直接查 |
| AS6 | 返回 6 条 | **不会发生**：`limit` 上限 5 被校验器拦下；代码 clamp `repos` 长度 |
| AS7 | 配额耗尽 | 明确说"配额用尽，X 秒后恢复"，**不说"没找到"** |
| AS8 | `incomplete_results: true` | summary 里标注"结果不完整" |
| AS9 | **禁止分析**（§2.3） | 给模型含 F2 倾向的追问（"所以社区在重点修什么？"）→ 回答**不得推断趋势**；需回归用例 |
| AS10 | summary 超 800 | **减少条数，绝不截断最后一条的 URL** |
| AS11 | 同进程连续两次同领域调用 | 第二次命中缓存，**0 次请求** |
| AS12 | 领域表 ↔ description 一致性 | 测试断言每个 `id` 都出现在 `skill.json` description 里 |
| AS13 | 权限声明自洽 | `network:github_issues` + `db:cache` + `networkHosts: ["api.github.com"]`，`pnpm skill:list` 显示正确 |

---

## 10. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | **静默返回错误答案**（领域→仓库错）| 本地表 + 未命中不联网（§4.1/§4.4）。这是最高优先级 |
| R2 | 配额耗尽（10/min 共享 IP）| 0/1 请求路径、5 分钟缓存、如实报错（§7） |
| R3 | **模型越界分析**（§2.3）| skill description 硬指令 + AS9 回归用例；**v0 不改 persona**（PRD 边界） |
| R4 | 自动化噪声（CI 汇总帖）| **已定位并给出手段**（§7.7）：靠 `-label:` 排除，按领域声明。⚠️ 剩余风险：label 名因仓库而异，需人工维护 |
| R5 | summary 静默截断 | AS10 + §6.1 的 800 硬上限意识 |
| R6 | 领域表长期不维护 | v1 考虑 `known-domains` 的补全脚本（market 已有 `market:capture` 先例） |
| R7 | 中文领域名未覆盖 | `aliases` 双语（§4.2） |

---

## 11. 待确认 / 待实测

**v0 必须先闭合并给出结论：**

1. ~~**要不要支持 GitHub Token？**~~ → **【已决】v0 不上。** 先收未认证的 10 次/分钟（实测），配额路径由 §7 的 0/1 请求设计 + 5 分钟缓存兜底。

2. **`data` 字段是预留还是漏接了？**（§6.3）
   实测：目前**无任何消费者**。已确认它**不消耗 token**（完全不进上下文）。
   **已澄清**：不是 bug，是「契约里有、接线断了」的预留位。**剩余问题仅剩归属**：是 v0 有意预留（v1 接调试面板/UI），还是漏接了？——**只影响 v1 方向，不阻塞 v0**。
   v1 明确方向：给 `data` 接消费者（UI 渲染完整列表），实现「模型叙述 5 条 + 气泡展示 20 条」。

3. ~~**机器人噪声怎么处理？**~~ → **【已定位，见 §7.7】** 结论：① 不是 App 机器人（`author:app/*` 无效，已推翻）；② 自动化跑在 `type=User` 账号上，**API 无字段可区分**；③ 唯一可用手段是**负向 label 过滤**（实测精确生效）；④ 维护者的 `[Tracking]` 汇总帖应**保留**，只排纯 CI tracker。
   **待办**：确认首批 `excludeLabels` 取值（现填 `ci-failure-tracker`）。

4. ~~**技能命名 `issues` 是否够清晰？**~~ → **【已决】定名 `github_issues`。**

5. ~~**要不要把 `SUMMARY_LIMIT` 放宽到 3000？**~~ → **【已决】不动。** 理由（§6.4）：成本可忽略但它是**全局契约常量**（market 排版共用），且 800 实测已够放 5 条。要显示更多走「给 `data` 接消费者」。

**明确记录为"未验证"的事实（不得当结论引用）：**

- ~~`-author:app/dependabot` 是否真的生效~~ → **已闭合**：语法有效（全站 `total=1`），但本场景**无 App 机器人可滤**（三仓库全 0），该手段**无效**，见 §7.7
- 官方 `github-mcp-server` 的分发形态与传输方式（§8）
- `topic:` 在仓库搜索中的**长期**标注质量（本文只测了 5 个样本，日期 2026-09-14）
- §6.4 的 token 成本是**按字符数估算**（未调用真实 tokenizer 计数）

---

## 附录 A：实测原始输出

**实测环境**：2026-09-14，未认证（无 Token），共享出口 IP。全程只用 `GET`。

| # | 探测 | 关键输出 |
|---|---|---|
| 1 | 领域全文搜索可行性 | `is:issue state:open created:>2026-01-01 rust async` → `total_count: 9159` |
| 2 | `topic:` 在 issue 搜索 | `is:issue topic:rust` → `total_count: 3`（**不是**仓库主题过滤） |
| 3 | search 配额 | `x-ratelimit-limit: 10`，`resource: search` |
| 4 | vLLM 体量 + `created` 排序 | 未关 **7959**；最新 5 条全部 **0d**，3 条 0 评论 |
| 5 | `sort=updated` 前 10 条 | 9/10 为 0–3 天；仅 1 条 26 天 |
| 6 | 多 `repo:` 语义 | `repo:vllm + repo:sglang` → `total_count: 3305`，**OR** ✅ |
| 7 | topic 存在性 × 5 | 见 §4.1 表格 |
| 8 | 种子仓库核实 | `/repos/` 全部 `200`（stars 见 §4.3） |
| 9 | 两段式 dry-run | 3 仓库 / 7 天窗 → `total_count: 649`，`incomplete_results: false` |
| 10 | summary 预算 | 6 条/3 label = **956**；5 条/2 label = **728** |
| 11 | 代码路径 | `runner.js:212` slice(800)、`agent.js:239` 只回填 summary、`runner.js:213` `data` 唯一出现处 |
| 12 | 校验器关键字 | `type/properties/required/enum/items/minimum/maximum`；`required` 缺省为 `[]` |
| 13 | 进程能力 | `child_process`/`spawn`/`execFile` 在 **`src/` 与 `skills/` 为 0 处**（唯一一处在 `test/unit/capture-eastmoney.test.js:22`——初稿写「全仓库 0 处」是**错的**，评审 G5 指出）；`dependencies` = `undefined` |
| 14 | `tool` 消息是否入库 | `appendMessage` 仅被 `user`/`assistant` 调用（`agent.js:138,196,245`）；**`role:'tool'` 从不持久化** |
| 15 | 上下文增长来源 | `WINDOW_SIZE = 40`（`memory.js:19`）；`recentMessages` 无 role 过滤 |
| 16 | 价格表 | `deepseek-chat` 输入 ¥2/M、缓存命中 ¥0.5/M、输出 ¥8/M |
| 17 | `author:app/*` 语法有效性 | **全站** `is:issue author:app/dependabot` → `total=1`（语法**有效**） |
| 18 | 三仓库的 App 机器人 | `author:app/dependabot`/`github-actions`/`renovate` **均为 0**；排除后 648→648（**差 0**） |
| 19 | 噪声 issue 真实作者 | `sglang#17050` → `alisonshao`；`sglang#37451` → `bingxche`；**`user.type` 均为 `User`** |
| 20 | 负向 label 过滤 | 基础 648 → `-label:ci-failure-tracker` **647**（**精确 -1** ✅） |

---

*本文档只定 PRD，不含实现。实现方案另见 `SDD-issues-v0.md`（待写）。*
