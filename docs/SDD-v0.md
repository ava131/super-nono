# SDD · 技术方案设计（v0）

| 项 | 内容 |
|---|---|
| 文档版本 | **v0.6**（评审修订 + 实施期迭代） |
| 文档类型 | SDD（Software Design Document，技术方案 / 软件设计文档） |
| 对应需求 | `PRD-Body-v0.md`、`PRD-Brain-v0.md`、`PRD-Skill-v0.md` |
| 目标 | 把三份 PRD 落成**可执行的工程方案**：技术选型、架构设计、模块落点、实施顺序 |

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0 | — | 首版。覆盖 v0 范围（停靠 + 拖动 + 点击对话 + 天气技能） |
| v0.1 | — | **评审修订**：① 气泡改为**独立窗口**，进程模型 2 Renderer、内存预算重算；② 新增 §6.12 气泡窗口定位与生命周期；③ 拖动加 4px/250ms 阈值；④ IPC 补齐 4 类频道 + 全量 `turnId`，冻结时点改到 M2；⑤ `safeFetch` 修掉吞 signal 的 bug；⑥ `safeStorage` 加降级分支；⑦ **ESM/CJS 口径统一**；⑧ 新增 §6.13 mock provider；⑨ 里程碑重排（AS7/AS8 提到 M3）；⑩ token 记账单一来源 |
| **v0.2** | — | **实施期修正**：① `webPreferences.sandbox` 必须为 `false`——sandboxed preload 不能 `require` 本地文件，否则 `channels.cjs` 引不进来；② 滞回阈值改为**进入 30 / 退出 10**（评审原写法会让状态逐事件翻转）；③ 新增 §8.5 环境搭建踩坑表；④ 新增 §10.1 / §10.2 实施进度与实测证据 |
| **v0.3** | — | **实施期选型收敛**：① 存储改用 **`node:sqlite`**（Node 内置），淘汰 `better-sqlite3` 与 Plan B；② 模型客户端**手写**（fetch + SSE），不装 `openai` SDK；③ 结果：**运行时依赖降为 0**；④ M2 代码完成 |
| **v0.4** | — | **多会话 + 反馈修正**：① `memory.js` 解除写死会话，新增 `createSession` / `listSessions` / `switchSession` / `ensureStartupSession`；② 新增 4 个 invoke 频道（`history:recent`、`session:list/new/switch`）；③ 气泡新增 toast 浮层（修掉「保存了却看不见」的 bug）与打开时渲染历史；④ `settings:clearData` 语义改为只清当前会话 |
| **v0.5** | — | **作用域归位 + 存储层解耦**：① 破坏性操作从齿轮移到会话列表（删除 / 重命名，行内就地确认）；**删除 `settings:clearData` 频道**，新增 `session:delete` / `session:rename`；② **存储层（`db.js`）与日志层（`log.js`）不再 import electron**——路径由 `main.js` 注入，会话逻辑由此可在纯 Node 下用 `:memory:` 单测；③ 修掉两个被测试抓出的真实缺陷（`ensureStartupSession` 会返回悬空会话 id；`updated_at` 同毫秒并列时列表顺序不确定）；④ 新增 `test/unit/sessions.test.js`（17 个用例） |
| **v0.6** | — | **M3 工具调用闭环落地**：① 新增 `skills/schema.js`（**手写校验器，替代 zod**，保持零依赖）、`registry.js`、`runner.js` 与 `skills/weather/`；② agent 的**配置与 provider 改为注入**，整条循环可在纯 Node 下用 mock provider 单测；③ 工具调用的中间上下文**只活在本次请求**，不落库（不必为临时对话改 schema）；④ 新增 `test/mocks/provider.js` 与 4 个测试文件（总数 50 → 120）；⑤ 新增 `pnpm skill:list` / `pnpm skill:test`；⑥ 修掉三个被测试抓出的缺陷：ESM 模块缓存导致重载拿到旧技能、技能抛出的 AppError 被降级成 INTERNAL、记账只在有工具调用时发生 |

---

## 1. 与 PRD 的对应关系

| 本文档章节 | 对应 PRD |
|---|---|
| §4 目录结构 · §5 模块职责矩阵 · §6.1–6.4 · §6.12 | `PRD-Body-v0.md` |
| §6.5–6.7 · §6.9–6.11 · §6.13 | `PRD-Brain-v0.md` |
| §6.7 · §6.8 · §7 | `PRD-Skill-v0.md` |

> **产品侧成功指标**：评审提出"v0 缺少产品指标"，**PM 决定暂不写入**，v0 以三份 PRD 的工程验收为准。

---

## 2. 技术选型

### 2.1 选型结论

| 层次 | 选型 | 版本 | 理由 |
|---|---|---|---|
| 运行时 | **Electron** | 最新稳定版（锁定精确版本） | 透明置顶窗口方案成熟、坑少、出活快。体积代价已在 PRD-Body §6.4 认账 |
| 语言 | **JavaScript + JSDoc 类型标注** | — | v0 不引入构建步骤；类型检查用 `tsc --checkJs` 做静态校验（零运行时成本） |
| **模块制式** | **ESM**（`"type": "module"`） | — | 统一口径，见 §2.4 |
| 包管理 | **pnpm** | 11.x（已装） | 项目内隔离、硬链接省磁盘 |
| Node 版本 | 通过 `fnm` 锁定，写 `.node-version` | 22 LTS | 仅用于构建工具链；运行时用 Electron 自带 Node |
| 模型 SDK | **不用 SDK**：自研 `fetch` + SSE 客户端（`src/main/brain/provider.js` + `sse.js`） | — | 所有出网本来就必须走 `safeFetch`（白名单/飞行模式/signal 合并），用 SDK 也得注入自定义 fetch。手写反而**少一个依赖**，且 SSE 解析器可单测 |
| 数据库 | **`node:sqlite`（Node 内置）** | — | 实测 Electron 44 自带 Node 24 已内置。**淘汰 `better-sqlite3`**：它是 C++ 原生模块，需为 Electron ABI 重建，本是本项目最大工程风险（原 §6.10 Plan A/B 由此作废） |
| 参数校验 | **手写校验器** `src/main/skills/schema.js` | — | 要校验的结构很小（技能清单 + JSON Schema 子集）。**不引 zod**，保持「除 Electron 外零运行时依赖」，且校验器本身可单测（16 个用例） |
| 测试 | **`node:test`**（Node 内置） | — | 零依赖 |
| 打包 | `electron-builder` | — | **v0 不做**，v1+ 才需要 |
| 调度 / 长期记忆 / 向量库 | 无 | — | v1+ 再评 |

### 2.2 被否决的方案（决策记录）

| 否决项 | 否决理由 |
|---|---|
| **Tauri v2** | 常驻内存更优，但透明窗口在 WebView 上有坑、开发慢。**架构上已为它留路**（Body 保持"薄"），v1+ 若资源不可接受再迁移 |
| **LangChain / LlamaIndex** | 依赖树巨大、抽象难调试。本项目工具调用循环只需几十行，自己写更小更快更可控 |
| **PixiJS / Phaser / Lottie** | 像素帧动画 Canvas 2D 几十行搞定，引入引擎只增加体积和内存 |
| **keytar** | 已停止维护。Electron 内置 `safeStorage` 零依赖即可 |
| **winston / pino** | 自写 JSONL + 环形缓冲足够 |
| **Python 后端（含 AKShare 等）** | 多一个运行时（+80MB 起）、多一套打包与进程守护。v0 天气技能用公开 HTTP 接口即可 |
| **MCP SDK** | v0 只有 1 个技能，自研薄注册表更可控。**接口形状保持 MCP 兼容**，v1+ 可接 |
| **`openai` SDK** | 所有出网都必须经过 `safeFetch`（域名白名单 + 飞行模式 + signal 合并），用 SDK 也得注入自定义 fetch，收益被抵消。手写客户端约 150 行，还让 SSE 解析成为可单测的纯函数 |
| **`better-sqlite3`** | 原生模块，需为 Electron ABI 重建，且失败后还要 Plan B 兜底。实测 `node:sqlite` 在 Electron 44 里可直接用，**风险与依赖一起消失** |
| **`zod`** | 原计划用它校验技能清单与工具参数。实际需要的只是一个很小的 JSON Schema 子集，手写约 200 行且可单测，没必要为它破坏「零运行时依赖」 |
| **单窗口 + 扩窗装气泡（方案 A）** | 窗口一大，`setIgnoreMouseEvents` 是全窗口生效的，气泡区域也得靠「alpha ∪ 气泡矩形」两套逻辑判定穿透——**这是最容易出玄学 bug 的地方**。已改采方案 B（独立气泡窗），代价是内存上限放宽到 500MB（用户已接受） |
| **气泡"本次会话内记住"确认结果** | 安全相关的记忆，v1 的 email 技能才用得上；v0 做等于增加一条没人测的攻击面。**v0 全不记住** |
| **宠物 1x/2x 缩放** | PM 决定 **v0 不做**。将来若恢复，用**窗口 bounds 整数倍缩放**实现（像素画整数倍放大不会糊），**图集永远只需一套**，不需要按倍率再画图 |
| **全屏透明覆盖层接点击（飞行）** | 方案本身可行且无需鼠标权限，但**功能已移交 v1+**，见附录 A |

### 2.3 关键取舍（一句话）

> **用磁盘体积（Electron ~200MB）换开发速度；用"零运行时依赖"换内存与可维护性；用"自研薄框架"换可控性；用"气泡独立窗口 + 100MB 内存"换命中测试的纯净。**

### 2.4 ESM / CJS 口径【v0.1 统一 · 防第一个 commit 就打架】

评审指出原稿 §2.1 选 ESM，但 §6.7 写 `require(...)`、§9 全是 `node xxx.js`，`package.json` 又没有 `"type": "module"`。现定死：

| 位置 | 制式 | 说明 |
|---|---|---|
| `package.json` | `"type": "module"` | 全局默认 ESM |
| 主进程（`src/main/**`）、渲染进程、`skills/**` | **ESM** | 用 `import` / 动态 `import()`（技能是运行时动态加载的，必须用 `await import()`） |
| **`src/preload/preload.cjs`** | **CommonJS，扩展名必须是 `.cjs`** | ⚠️ Electron 的 sandboxed preload **既不支持 ESM、也不能 `require` 本地文件**。因此 `webPreferences.sandbox` 必须显式设为 **`false`**，preload 才能引到共享的 `channels.cjs`（保持"频道名只有一处"）。安全基线改由 `contextIsolation: true` + `nodeIntegration: false` + 页面只加载本地文件 + 严格 CSP 共同保证 |
| `scripts/*.js`、`test/*.js` | ESM | `node --test` 支持 ESM |

### 2.5 `tsc --checkJs` 的定位【C-6 修订】

原稿列了 TypeScript 开发依赖与 `pnpm check` 脚本，但**验收项里没有任何一条要求它通过**——等于留了个没人跑的脚本。

**决定：保留，并把它变成门槛。**

- `pnpm check`（`tsc --noEmit --checkJs`）**必须通过**才允许提交；每个里程碑的完成定义包含这一条。
- 它**不产出任何构建物**，只是静态检查，因此不违背"零构建步骤"。

---

## 3. 总体架构

### 3.1 分层图

```
┌──────────────────────────────────────────────────────────────┐
│                     Renderer 进程 ×2（Body）                  │
│  ┌───────────────────────────┐  ┌──────────────────────────┐ │
│  │ petWindow（160×160 透明）  │  │ bubbleWindow（普通窗口）  │ │
│  │  渲染/动画 · 命中测试 · 拖动 │  │  对话框 · 流式渲染 · 确认 │ │
│  │  pet.js / hit-test.js     │  │  bubble.js / settings    │ │
│  └───────────────────────────┘  └──────────────────────────┘ │
└───────────────────────────┬──────────────────────────────────┘
                            │ preload.cjs（contextBridge 受控 API）
                            │ IPC：src/shared/channels.cjs（M2 冻结）
┌───────────────────────────▼──────────────────────────────────┐
│                       Main 进程（Brain 宿主）                 │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ 应用层：main.js（生命周期/托盘/单实例）                │    │
│  │        window.js（petWindow + bubbleWindow 创建与定位）│    │
│  ├──────────────────────────────────────────────────────┤    │
│  │ Brain：agent.js（会话+工具循环） provider.js（DeepSeek）│    │
│  │        persona.js（稳定前缀）   usage.js（费用统计）   │    │
│  ├──────────────────────────────────────────────────────┤    │
│  │ Skill：registry.js（注册） runner.js（执行/权限/确认） │    │
│  │        egress.js（safeFetch 白名单）                  │    │
│  ├──────────────────────────────────────────────────────┤    │
│  │ 基础设施：store/（SQLite/配置/钥匙串） log.js（日志）  │    │
│  └──────────────────────────────────────────────────────┘    │
└───────────────────────────┬──────────────────────────────────┘
                            │ 唯一出网通道
                    ┌───────▼────────┐
                    │ safeFetch 白名单 │──→ DeepSeek API（对话）
                    └────────────────┘──→ Open-Meteo / wttr.in（天气）
```

### 3.2 进程模型

| 进程 | 数量 | 职责 | 备注 |
|---|---|---|---|
| Main | 1 | Brain + 窗口管理 + 托盘 | 常驻，不重启 |
| **Renderer** | **2** | 宠物窗（动画/命中/拖动）、气泡窗（对话/设置） | ⚠️ **v0.1 变更：原为 1 个**。两个窗口都**只创建一次**，隐藏/显示而非销毁（防泄漏第 1 条） |
| GPU / Utility | Electron 自动 | 合成、网络 | 不可控，计入预算 |

**内存影响**：双 Renderer 使常驻内存升至约 **280–520MB**，A9 上限因此放宽至 **500MB**（`PRD-Body-v0.md` §6.1 / §8 A9 已同步）。

**没有本地 HTTP 服务、没有额外端口、没有第三个业务进程。**

### 3.3 为什么不做前后端分离

Brain 跑在主进程 = 它本身就是"后端"；两个渲染窗口 = "前端"；两者走进程内 IPC。
唯一的例外场景（为用某个 Python 库而拆独立进程）在 v0 不成立。
**保留的退路**：IPC 载荷按 JSON-RPC 风格设计，将来要拆只需把"函数调用"换成"发消息"。

---

## 4. 仓库目录结构

```
super-nono/
├── package.json                "type": "module" + 依赖与脚本
├── .node-version               fnm 锁定的 Node 版本
├── .gitignore
├── NOTICE.md                   ⚠️ 新增：与淘米/《赛尔号》无关联的声明（见 §12）
├── config/
│   └── pricing.json            DeepSeek 价格表（手工维护，用于费用估算）
├── docs/
│   ├── PRD-Body-v0.md
│   ├── PRD-Brain-v0.md
│   ├── PRD-Skill-v0.md
│   ├── SDD-v0.md               （本文档）
│   └── v0-review-20260911-1130.md
├── src/
│   ├── main/                   ← 主进程（应用层 + Brain 宿主）
│   │   ├── main.js             入口：生命周期、单实例锁、托盘、菜单、快捷键
│   │   ├── window.js           ★ petWindow 与 bubbleWindow 的创建、显隐、定位、拖动
│   │   ├── ipc.js              IPC 契约的唯一注册处（把 channels 接到实现）
│   │   ├── brain/
│   │   │   ├── agent.js        会话循环 + 工具调用循环（核心）
│   │   │   ├── provider.js     DeepSeek / OpenAI 兼容适配层（流式 + tools）
│   │   │   ├── persona.js      装载人格文本，**提供稳定前缀**（不含时间，见 §6.6）
│   │   │   ├── memory.js       消息读写、上下文窗口裁剪、turnId 管理
│   │   │   ├── usage.js        token / **费用**统计、每日费用上限
│   │   │   └── errors.js       错误归一化（统一错误码）
│   │   ├── skills/
│   │   │   ├── registry.js     扫描 skills/、校验 skill.json、转成模型工具清单
│   │   │   ├── runner.js       执行技能：权限检查 → 确认闸门 → 超时 → 结果归一
│   │   │   └── egress.js       safeFetch：白名单 + 强制 HTTPS + 飞行模式 + **不吞 signal**
│   │   ├── store/
│   │   │   ├── db.js           SQLite 单例、建表、WAL、每月 VACUUM
│   │   │   ├── settings.js     配置读写 + safeStorage 存取 API Key（含降级分支）
│   │   │   └── files.js        Plan B：JSONL 文件存储（可选）
│   │   └── log.js              环形缓冲（内存 500 条）+ JSONL 按天落盘 + 脱敏
│   ├── preload/
│   │   └── preload.cjs         ★ CommonJS（sandbox 下不支持 ESM），唯一桥
│   ├── renderer/
│   │   ├── pet.html / pet.js       宠物窗：动画状态机 + canvas 渲染 + 命中测试 + 拖动阈值
│   │   ├── hit-test.js             alpha 采样与滞回判定（纯函数，可单测）
│   │   ├── bubble.html / bubble.js 气泡窗：对话框、流式合帧渲染、确认弹窗、设置面板、清理确认
│   │   └── placeholder-art.js      程序化生成占位像素帧（96×96）
│   └── shared/
│       └── channels.cjs         IPC 频道常量（**只放常量与纯类型，见 §6.5**）
├── skills/                     技能插件。⚠️ **新增技能需重启应用生效（v0 不支持热加载）**
│   └── weather/
│       ├── skill.json          声明：描述/参数 Schema/权限/风险/域名白名单
│       ├── index.js            执行器：地理编码 → 天气 → 组装 summary（含内存缓存）
│       ├── wmo-codes.js        WMO weather_code → 中文描述映射
│       └── city-fallback.js    常用城市经纬度兜底表（中文识别不准时用）
├── assets/
│   ├── persona.md              人格提示词（可编辑文本，不含时间）
│   └── sprites/                v0 为空（用程序化占位图）；v1 放真图集
├── scripts/
│   ├── skill-test.js           单技能直调 CLI + --list 审计权限/域名并集
│   └── soak.js                 ★ 新增：mock provider 长跑，测内存增长（A10/AB13）
└── test/
    ├── unit/                   hit-test / runner 闸门 / egress 白名单 / memory 裁剪 / WMO 映射
    ├── integration/            agent 循环 + mock provider + mock 技能
    ├── e2e/                    Playwright for Electron：透明窗、托盘、**键盘焦点**
    ├── mocks/                  ★ mock provider / mock 技能（见 §6.13）
    └── fixtures/persona-corpus.md   ★ 20 条人格回归语料（AB3）
```

**运行时数据目录**（不在仓库内）：
`~/Library/Application Support/super-nono/{nono.db, config.json, logs/}`

---

## 5. 模块职责矩阵（哪个位置实现什么功能）

> 这张表直接回答"哪个功能在哪实现"。PRD 编号与实现文件一一对应。

### 5.1 Body（对应 `PRD-Body-v0.md`）

| PRD 需求 | 实现文件 | 具体做什么 |
|---|---|---|
| W-1 透明置顶窗口 | `src/main/window.js` | 创建 `petWindow`（160×160、`transparent`、`frame:false`、`alwaysOnTop`、**`focusable:false`**）；`app.dock.hide()` 不占 Dock；位置按 **workArea 比例**存取 |
| W-2 点击穿透与命中测试 | `src/renderer/hit-test.js` + `pet.js` + `src/main/window.js` | 渲染进程按 alpha 判定"是否实体像素"，变化时经 **`pet:setIgnoreMouse`** 通知主进程切换。**方案 B 下只需考虑宠物窗**，无气泡矩形干扰 |
| W-3 拖动 | `src/renderer/pet.js`（阈值判定 + 起止） + `src/main/window.js`（跟随） | **4px / 250ms 阈值**决定是点击还是拖动；拖动由**主进程按 16ms 轮询光标**并 `setPosition`；`dragEnd` 时**必须清理定时器**并持久化比例 |
| W-3.1 点击判定 | `src/renderer/pet.js` | 未达阈值就 `mouseup` → 发 **`pet:click`** 切换气泡窗 |
| W-4 动画状态机 | `src/renderer/pet.js` | 状态机 + 10fps tick；**合并规则：本地交互态（drag）优先于 `brain:state`** |
| W-5 气泡窗 | `src/renderer/bubble.js` + `src/main/window.js` | **独立窗口**的创建/显隐/定位/翻转；流式**合帧渲染**；停止按钮；确认弹窗；设置面板 |
| W-6 托盘与生命周期 | `src/main/main.js` | 托盘菜单、单实例锁、开机自启、显示/隐藏、退出 |
| W-7 设置面板 | `src/renderer/bubble.js` + `src/main/store/settings.js` + `ipc.js` | 走 **`settings:get` / `settings:set`** 频道；含 API Key、模型、自启；**v0 无缩放项** |
| W-7.1 Key 存储 | `src/main/store/settings.js` | `safeStorage` 加密写 `config.json`；**`isEncryptionAvailable()===false` 时明确报错，禁止明文回退** |
| W-7.2 无 Key 提示 | `src/main/brain/errors.js` + `bubble.js` | 启动与请求两个时机**复用同一套提示**；不硬拦截，宠物保持 idle |
| W-7.3 清理数据 | `src/renderer/bubble.js` + `ipc.js` + `db.js` | **`settings:clearData`**；先弹 Minecraft 语气确认框并列出删除内容；**只清消息历史**，保留用量/日志/Key/位置 |
| W-8 调试面板 | `bubble.js` + `log.js` + `usage.js` + `ipc.js` | 状态、FPS、**内存曲线（主进程经 `debug:metrics` 推送）**、日志、最近 token/费用/延迟 |
| W-9 IPC 契约 | `src/shared/channels.cjs` + `src/main/ipc.js` + `src/preload/preload.cjs` | 频道名唯一来源；**M2 冻结**；全量 `turnId`；preload 只暴露白名单方法 |
| 占位像素图 | `src/renderer/placeholder-art.js` | 代码生成 **96×96** 的五组帧，接口与真图集一致 |

### 5.2 Brain（对应 `PRD-Brain-v0.md`）

| PRD 需求 | 实现文件 | 具体做什么 |
|---|---|---|
| B-1 模型适配层 | `src/main/brain/provider.js` + `sse.js` | **手写客户端（不用 `openai` SDK）**：`baseURL`→DeepSeek；`streamChat()` 返回事件流；`sse.js` 为可单测的纯函数式 SSE 解码；出网统一走 `safeFetch`；AbortSignal |
| B-2 会话循环 | `src/main/brain/agent.js` | 组装上下文 → 请求 → 解析工具调用 → 执行 → 回填 → 再请求；步数上限 5、超时、取消、失败熔断 |
| B-3 人格 | `persona.js` + `assets/persona.md` | 装载人格文本，**提供一字不变的稳定前缀** |
| **B-3.1 时间注入** | `src/main/brain/agent.js` | **时间不进 system message**，拼在本轮 user 消息前：`[现在是 ...] <原话>` |
| B-4 记忆（基础） | `memory.js` + `store/db.js` | 消息落 SQLite；窗口裁剪至最近 40 条；`turnId` 生成与传递 |
| B-5 密钥与隐私 | `store/settings.js`（唯一解密点） | 确保不进 config 明文 / 不进日志 / 不回显 |
| B-5 出网管控 | `src/main/skills/egress.js` | `safeFetch`：白名单 + 强制 HTTPS + 飞行模式短路 + **合并外部与超时 signal** |
| B-6 成本控制 | `usage.js` + `config/pricing.json` | **按费用**累计；每日费用上限判定；超限阻止请求并提示；**写入 `usage_log` 唯一记账点** |
| B-7 日志 | `src/main/log.js` | 内存环形缓冲 500 条 + JSONL 按天落盘 + **入口处脱敏** |
| B-8 错误处理 | `errors.js` + `agent.js` | 错误码归一（NETWORK/AUTH/RATE_LIMIT/SKILL_FAIL/LOOP_LIMIT/BUDGET），映射为 `brain:error` |

### 5.3 Skill（对应 `PRD-Skill-v0.md`）

| PRD 需求 | 实现文件 | 具体做什么 |
|---|---|---|
| §3 技能契约 | `skills/weather/skill.json` | 声明 description、参数 Schema、**仅 `network:weather` 一项权限**、risk、networkHosts |
| §3.3 执行器契约 | `skills/weather/index.js` | `run(args, ctx)`：**`validateArgs` 校验（手写校验器）** → **内存缓存** → 地理编码 → 查天气 → 组装 summary |
| §3.2/3.3 契约自检 | `src/main/skills/registry.js` + `schema.js` | 启动扫描 `skills/`、**`validateManifest` 校验声明（手写校验器，非 zod）**、生成工具清单、打印权限与域名并集 |
| §4.1 权限闸门 | `src/main/skills/runner.js` | **未声明即拒绝**（无"默认允许"项），返回结构化错误 |
| §4.2 三级风险 | `runner.js` + `bubble.js` | L1 直接执行；L2 经 `brain:confirmRequest` 弹窗等待确认（**v0 不记忆确认结果**）；L3 代码层硬拒绝 |
| §4.3 出网白名单 | `src/main/skills/egress.js` | 白名单由 registry 汇总注入；`safeFetch` 强制校验 |
| §6 天气技能 | `skills/weather/*` | 见上；WMO 码映射与城市兜底表独立成文件便于维护 |
| §7 调试支持 | `scripts/skill-test.js` | 绕过模型直调单个技能，打印入参出参；`--list` 审计权限/域名并集 |

---

## 6. 核心实现方案

### 6.1 窗口创建（`src/main/window.js`）

**宠物窗**

```js
const petWindow = new BrowserWindow({
  width: 160, height: 160,          // 精灵 96 + 四周各 32 留白（留白不参与命中测试）
  transparent: true,
  frame: false,
  hasShadow: false,
  resizable: false,
  movable: false,                   // ✅ 已实测：该设置下主进程 setPosition() 仍生效（§10.1）
  minimizable: false, maximizable: false, fullscreenable: false,
  focusable: false,                 // 宠物窗不需要键盘焦点
  skipTaskbar: true,
  show: false,
  webPreferences: {
    preload: path.join(__dirname, '../preload/preload.cjs'),   // .cjs！见 §2.4
    contextIsolation: true,         // 安全基线
    nodeIntegration: false,         // 安全基线
    sandbox: false,                 // ⚠️ 见 §2.4：sandboxed preload 既不能用 ESM
                                    //    也不能 require 本地文件，开了就引不到 channels.cjs
    backgroundThrottling: false,    // 动画不被后台降频
  },
});
petWindow.setAlwaysOnTop(true, 'screen-saver');
petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
app.dock?.hide();                   // accessory：不占 Dock
```

**气泡窗**

```js
const bubbleWindow = new BrowserWindow({
  width: 380, height: 420,          // 待实测微调
  frame: false, hasShadow: true, resizable: false,
  focusable: true,                  // ⚠️ 关键：键盘输入必须落在这里
  skipTaskbar: true, show: false,
  webPreferences: { preload: ..., contextIsolation: true, nodeIntegration: false },
});
```

- **两个窗口都只创建一次**，隐藏/显示复用（防泄漏第 1 条）。
- 位置从 `settings` 恢复（**workArea 比例** `{rx, ry}`）；首次启动落主显示器 `workArea` 右下角。

> ⚠️ **两项必须实测、推演不管用的事项（评审 D-3 / D-4）**
> 1. **accessory 模式（`app.dock.hide()`）下，气泡窗能否成为 key window 拿到键盘焦点？** 拿不到就打不了字。**这是 M2 第一个必须验证的东西。**
> 2. **`movable: false` 与主进程 `setPosition()` 的兼容性。** macOS 上历史上可用，但属未文档化行为；不行就开 `movable: true`。
> 3. 顺带实测：中文输入法下 Esc / Enter 的行为（拼音候选框会吃掉 Esc）。

### 6.2 点击穿透与命中测试（W-2）

原理：`setIgnoreMouseEvents(true, { forward: true })` 让鼠标事件穿透给下层，**但本窗口仍能收到 `mousemove`**，据此判断是否该关闭穿透。

```js
// src/renderer/hit-test.js（纯函数，可单测）
// ⚠️ 进入用高阈值、退出用低阈值。v0.1 原稿写成 ENTER=10 / EXIT=30 是反的：
//    那样 alpha 落在 10–30 之间时状态会每个事件翻转一次，变成振荡器。
const ENTER = 30, EXIT = 10;        // 滞回阈值，防止边缘抖动
export function nextSolid(prevSolid, alpha) {
  if (prevSolid) return alpha >= EXIT;   // 掉到退出阈值以下才恢复穿透
  return alpha > ENTER;                  // 超过进入阈值才关掉穿透
}
```

```js
// src/renderer/pet.js
function onMove(e) {
  const solid = nextSolid(state.solid, alphaAt(e.clientX, e.clientY));
  if (solid !== state.solid) {
    state.solid = solid;
    api.setIgnoreMouse(!solid);     // → 频道 pet:setIgnoreMouse
  }
}
```

- **只在状态变化时发 IPC**，避免高频消息。
- **方案 B 的收益**：气泡是独立窗口，穿透逻辑只需考虑宠物窗这一个 160×160 的区域，判定就是纯 alpha 测试。
- 命中测试用的 `ImageData` 在**切帧时**采样一次并缓存，**不在 `mousemove` 里反复 `getImageData`**（性能关键）。

### 6.3 拖动与点击判定（W-3 / W-3.1）

**问题**：宠物窗只有 160×160，快速拖动时鼠标瞬间跑出窗口，渲染进程收不到 `mousemove` → 宠物"跟不上"。
**并且**：若 `mousedown` 后立即进入拖动，用户手抖 2px 就会被判成拖动，气泡弹不出来。

**方案：先过阈值，再启动主进程轮询。**

```js
// src/renderer/pet.js（阈值判定）
const DRAG_PX = 4, DRAG_MS = 250;
let down = null;

onMouseDown(e => { down = { x: e.screenX, y: e.screenY, t: Date.now(), offsetX: e.clientX, offsetY: e.clientY }; });

onMouseMove(e => {
  if (!down || state.dragging) return;
  const moved = Math.hypot(e.screenX - down.x, e.screenY - down.y);
  if (moved > DRAG_PX || Date.now() - down.t > DRAG_MS) {
    state.dragging = true;
    api.dragStart(down.offsetX, down.offsetY);          // → pet:dragStart
  }
});

onMouseUp(() => {
  if (!down) return;
  if (state.dragging) { api.dragEnd(); state.dragging = false; }   // → pet:dragEnd
  else                { api.click(); }                             // → pet:click（切换气泡窗）
  down = null;
});
```

```js
// src/main/window.js（跟随）
let timer = null, off = null;
ipcMain.on(CH.PET_DRAG_START, (_e, { offsetX, offsetY }) => {
  off = { x: offsetX, y: offsetY };
  bubbleWindow.hide();                                  // 拖动时隐藏气泡，松手不自动弹回
  timer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    petWindow.setPosition(...clampToWorkArea(p.x - off.x, p.y - off.y));
  }, 16);
});
ipcMain.on(CH.PET_DRAG_END, () => {
  clearInterval(timer); timer = null;                   // ⚠️ 必须清理，防泄漏第 3 条
  settings.savePositionRatio(petWindow.getBounds());    // 存 workArea 比例
});
```

- `clampToWorkArea` 保证宠物中心不离开当前屏幕工作区。
- 阈值常量集中在 `pet.js` 顶部，便于调参。

### 6.4 动画状态机（W-4）

- 单一 `<canvas>`，按 10fps 用 `setInterval`（不用 rAF 空转，减少 CPU 与泄漏面）。
- 帧数据来源统一为"帧数组"：
  - v0：`placeholder-art.js` 生成 96×96 的 `HTMLCanvasElement[]`；
  - v1：换成 `assets/sprites/*.png` + JSON 切图。
  - **两者对 `pet.js` 暴露同一个接口**，这就是 PRD G7「换图不改代码」的落地点。
- **状态合并规则（评审澄清项）**：
  - `brain:state`（主进程下发）与本地交互态（`drag`）可能同时存在。
  - **优先级：本地交互态 > 主进程下发态。** 拖动期间无论主进程说什么都显示 `drag`；松手后回落到最近一次 `brain:state`。
  - 调试面板显示"合并后的最终状态"并标注来源，避免来回跳。
- 窗口不可见（`win.on('hide')`）或页面 `visibilitychange` 时**停掉 tick**。

### 6.5 IPC 契约落地（W-9）

> **冻结时点变更**：原稿标「冻结」，但它缺少 4 类必要频道，按它写不出可运行代码。**现降级为「v0 草案，M2 开始时冻结」**，M0/M1 期间允许自由增补。

三层结构，单一真相来源：

| 文件 | 职责 |
|---|---|
| `src/shared/channels.cjs` | 频道名常量。**约定：`shared/` 只放无副作用的常量与纯类型定义，不放业务逻辑**（C-4 修订） |
| `src/preload/preload.cjs` | `contextBridge` 暴露受控方法（如 `api.sendMessage(text)`），**不暴露 `ipcRenderer` 本体** |
| `src/main/ipc.js` | 集中注册，把频道接到具体实现；**所有入参在主进程侧再校验一次** |

**M2 冻结时必须存在的频道**（完整清单见 `PRD-Body-v0.md` W-9）：

- 原有：`pet:ready`、`pet:userMessage`、`pet:cancel`、`pet:toggleBubble`、`pet:dragStart`、`pet:dragEnd`、`pet:stateChanged`、`pet:confirmResponse`、`brain:state`、`brain:delta`、`brain:message`、`brain:notice`、`brain:error`、`brain:confirmRequest`
- **补齐 ①（设置面板读写）**：`settings:get`、`settings:set`、`settings:clearData`
- **补齐 ②（穿透开关）**：`pet:setIgnoreMouse`
- **补齐 ③（主进程内存）**：`debug:metrics`
- **补齐 ④（点击判定）**：`pet:click`（渲染进程只报告"这是一次点击"，**toggle 由主进程做**，避免两边各存一份显隐状态而不一致；`pet:toggleBubble` 只用于气泡窗自身与托盘的**显式**设置）
- **全量 `brain:*` 事件加 `turnId`**：解决"点停止后旧 delta 还在飞，飘进新气泡"的串台 bug（偶发、难复现）。

**流式合帧渲染**：`brain:delta` 不直接触发 DOM 更新，先进队列，按 **16–60ms 批量 flush**，避免长回答时每帧多次 reflow（同时改善 CPU 与观感）。

### 6.6 会话循环与工具调用（B-2 / B-3.1）

```js
// src/main/brain/agent.js（骨架）
async function runTurn(userText, emit, signal) {
  const turnId = memory.newTurnId();
  memory.append({ turn_id: turnId, role: 'user', content: userText });
  for (let step = 0; step < MAX_STEPS; step++) {          // MAX_STEPS = 5
    emit.state(turnId, 'think');
    const { text, toolCalls, usage } = await provider.chat({
      messages: [
        { role: 'system', content: persona.stablePrefix() },     // ★ 一字不变，命中缓存
        ...memory.window(40),
        { role: 'user', content: `[现在是 ${nowText()}] ${userText}` },  // ★ 时间在这里
      ],
      tools: registry.toolSpecs(),
      signal,
    });
    usage.record({ turnId, ...usage });                   // ★ 唯一记账点
    if (text) emit.delta(turnId, text);
    if (!toolCalls.length) { memory.append({ turn_id: turnId, role: 'assistant', content: text }); return; }

    for (const call of toolCalls) {
      const result = await runner.run(call.name, call.arguments, { turnId, signal });
      memory.append({ turn_id: turnId, role: 'tool', tool_call_id: call.id, content: result.summary });
    }
  }
  emit.notice(turnId, '我绕了太多圈，先停一下。');
}
```

- **时间注入位置（B-3.1）**：时间**不进 system message**，只在**本轮** user 消息前拼一段 `[现在是 2026-09-11 14:20 周四]`。system message 只含人格 + 技能清单 + 安全规则，**一个字都不随请求变化**，从而让 DeepSeek 的前缀缓存真正命中（对应 B-6e）。
- `emit` 是注入的回调，把事件映射到 `brain:state` / `brain:delta` / `brain:error`，**全部带 `turnId`**。
- **取消**：`AbortController` 的 signal 贯穿 provider 与 runner；`pet:cancel` 触发 `abort()`。
- **熔断**：`runner` 记录每个技能连续失败次数，达 2 次后直接返回"该技能已被禁用"。
- **预算闸门**：每次请求前检查当日累计费用是否已达上限（`usage.js`），达上限直接返回 BUDGET 错误并提示，不发请求。

### 6.7 技能注册与执行（Skill §3/§4）

```js
// registry.js：启动时扫描（ESM 动态导入）
for (const dir of await readdir(SKILLS_DIR)) {
  const decl = JSON.parse(await readFile(`${SKILLS_DIR}/${dir}/skill.json`));
  const parsed = validateManifest(decl, dir);      // 手写校验器，非法则禁用并告警
  const mod = await import(`${SKILLS_DIR}/${dir}/index.js`);   // ★ ESM 动态 import
  registry.set(parsed.name, { decl: parsed, run: mod.run });
  egress.addHosts(parsed.networkHosts ?? []);      // 白名单只会变宽，不会变窄
}
```

```js
// runner.js：执行闸门（顺序不可颠倒）
1. 技能是否存在？            → 否则 NOT_FOUND
2. 权限是否声明？            → 否则 Permission 拒绝（★ 未声明即拒绝，无默认放行）
3. risk === 'irreversible'   → 硬拒绝（L3 红线）
4. requiresConfirmation      → 发 brain:confirmRequest，等待用户（超时=拒绝）
                               ★ v0 不记忆确认结果，每次都问
5. 参数校验（`validateArgs`）  → 失败直接返回，不执行
6. 带超时执行 run(args, ctx)
7. 归一化结果：{ ok, summary(≤800), data }
```

### 6.8 出网白名单（Skill §4.3 · 本项目"不外流"的执行点）

```js
// egress.js
async function safeFetch(url, opts = {}) {
  if (settings.isOffline()) throw new AppError('EGRESS_DENIED', '飞行模式已开启');
  const u = new URL(url);
  if (u.protocol !== 'https:')    throw new AppError('EGRESS_DENIED', '仅允许 HTTPS');
  if (!whitelist.has(u.hostname)) throw new AppError('EGRESS_DENIED', `不在白名单: ${u.hostname}`);
  log.egress({ host: u.hostname, ts: Date.now() });        // 只记域名，不记响应体

  // ★ 修复：原稿用 AbortSignal.timeout(...) 直接覆盖了调用方的 signal，
  //   导致用户在技能执行中按「停止」时请求不会被中断（要等 10s 超时），
  //   违反 B-2c「立刻 abort」与防泄漏第 5 条。改为合并两个 signal。
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  return fetch(url, { ...opts, signal });
}
```

- **全项目禁止直接调用 `fetch`**（用 lint 规则或代码评审保证），必须走 `safeFetch`。
- v0 白名单最终只有 4 个域名：DeepSeek 的 API 域名 + 天气的 3 个。

### 6.9 API Key 存储（B-5 · 最高密级）

| 环节 | 做法 |
|---|---|
| 存储 | `safeStorage.encryptString()` 加密后写入 `config.json` 的密文字段；明文只存在于内存 |
| **降级分支（C-1 修订）** | **`safeStorage.isEncryptionAvailable() === false` 时，禁止明文回退**——明确报错告知用户"当前系统无法安全存储密钥"，由用户决定是否继续。**绝不静默写明文** |
| 读取 | **只在 `settings.js` 一个文件里解密**，以函数形式提供给 provider |
| 日志 | `log.js` 在**写入口**脱敏：任何 `Authorization` / `sk-` 前缀字符串一律替换为 `***` |
| 错误 | `errors.js` 归一化时剥离请求头，错误信息不回显 Key |
| 界面 | 设置面板只显示掩码；不回填明文 |
| 验收 | AB9：抓包 + 检索文件 + 检索日志，三处均不得出现明文 |

> **口径统一说明**：`PRD-Body-v0.md` W-7 原先写"写入系统钥匙串"，本文档写"加密后写 config.json"——**两者不矛盾**（`safeStorage` 底层就是 macOS Keychain），现统一为本文档的方案，并在 Body 侧同步。

### 6.10 存储层（B-4/B-6）

**SQLite（`node:sqlite`，Node 内置）**

> **v0.3 起已无 Plan A / Plan B 之分**：存储统一用 Node 内置 `node:sqlite`。
> 原 `better-sqlite3`（C++ 原生模块，需为 Electron ABI 重建）与 JSONL 降级预案**均已淘汰**，
> 该工程风险随之消失（见 §2.1 选型表、§2.2 被否决方案、changelog v0.3）。
> `node:sqlite` 支持 WAL —— 2026-09-14 实测 `journal_mode` 可由 `delete` 切换为 `wal`。
>
> 实现落点：`src/main/store/db.js`（`import { DatabaseSync } from 'node:sqlite'`）。

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL, turn_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT, created_at INTEGER
  -- ★ 不含 tokens_in/tokens_out：记账单一来源是 usage_log（C-2 修订）
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT, turn_id TEXT, model TEXT,
  tokens_in INTEGER, tokens_out INTEGER, cached_tokens INTEGER,
  latency_ms INTEGER, cost_est REAL,
  skill_names TEXT,        -- ★ 本轮调用了哪些技能（JSON 数组），原稿遗漏
  created_at INTEGER
);
```

- 单例连接 + WAL；prepared statement 复用。
- **归档**：每月 `VACUUM`；v0 数据量极小，可先只做 `VACUUM`，暂不做历史归档。
- **v1+ 预留但 v0 不建**：`memories`、`tasks`、`cache_market`（以注释形式保留位置）。
- **v0 天气缓存不落库**：走主进程内存 `Map` + TTL（C-3 修订），因此 weather 不需要 `db:cache` 权限。
- **技能的持久化**：走通用表 `skill_kv`（namespace 隔离），由 `ctx.store` 注入 —— 见 market 方案 `docs/market/SDD-market-v0.md` §3.1/§6.1。

### 6.11 日志与环形缓冲（B-7）

- 内存：固定长度数组（500 条），超长则 `shift`（或环形索引）。
- 落盘：`logs/YYYY-MM-DD.jsonl`，每行一个 JSON 对象。
- **脱敏在写入口做一次**，而不是在读取时做（避免遗漏路径）。

### 6.12 气泡窗口的定位与生命周期【v0.1 新增】

**创建**：启动时创建一次，`show: false`。**永不 `destroy()`。**

**显示/隐藏**

| 触发 | 动作 |
|---|---|
| `pet:click`（点击判定成立） | `show()` + 重新定位 |
| `pet:click`（再次） / 气泡内 Esc / 托盘 | `hide()` |
| `pet:dragStart` | `hide()`（拖动时隐藏，松手**不**自动弹回） |
| 应用退出 | `destroy()`（唯一允许的销毁时机） |

**定位（由主进程计算，渲染进程不掺和）**

```js
function placeBubble() {
  const pet = petWindow.getBounds();
  const { width: bw, height: bh } = bubbleWindow.getBounds();
  const wa = screen.getPrimaryDisplay().workArea;      // v0 只处理主显示器

  let x = pet.x + pet.width / 2 - bw / 2;
  let y = pet.y - bh - 8;                              // 默认放宠物上方

  if (y < wa.y) y = pet.y + pet.height + 8;            // 上方空间不足 → 翻转到下方
  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - bw);   // clamp 到工作区
  y = Math.min(Math.max(y, wa.y), wa.y + wa.height - bh);

  bubbleWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: bw, height: bh });
}
```

- 贴边时 `clamp`；上方空间不足时翻转。
- **`show()` 前先 `placeBubble()`**，避免窗口在错误位置闪一下。
- **拖动时用 `hide()` 而不是跟随**：实现简单，且避免高频 `setBounds`（呼应防泄漏第 9 条）。

**穿透**：气泡窗是普通窗口，**没有任何透明区域，因此不需要任何穿透处理**。Esc / 点别处关闭由气泡窗自己监听，**不需要跨窗口协作**。

**内容承载**：消息列表 + 输入框 + 停止按钮 + L2 确认弹窗 + 设置面板 + 清理数据的二次确认框。全部在一个窗口内，v0 不再开第三个窗口。

### 6.13 mock provider 与分层测试【v0.1 新增 · 性价比最高的内部工具】

**问题**：多条验收（AB7 死循环 5 步、AB12 费用上限触发、AB13 长跑泄漏、AB3 人格回归）如果靠真实 DeepSeek 调用去测，**要么烧钱，要么根本做不了**；A10/AB13 的"24h / 100 次问答"如果靠人工守夜，**一定会被跳过**。

**方案**：交付一个可注入的 mock provider。

| 交付物 | 位置 | 作用 |
|---|---|---|
| mock provider | `test/mocks/provider.js` | 按脚本返回流式文本 / 工具调用 / 错误 / 无限工具调用（造死循环） |
| mock 技能 | `test/mocks/skills/` | 恒失败 / 恒超时 / 越权 / L3 红线的桩 |
| 人格回归语料 | `test/fixtures/persona-corpus.md` | **20 条**（天气 / 时间 / 闲聊 / 越界请求各 5 条），每次改 `persona.md` 跑一遍人工打分 |
| soak 脚本 | `scripts/soak.js` | 用 mock provider 长跑 N 轮，周期性采样 RSS 并断言增长上限 |

**它一次性解锁**：AB3 人格回归、AB7 循环上限、AB12 预算闸门、AB13 长跑泄漏、`pnpm soak`。

---

## 7. 一次完整对话的时序（以天气为例）

```
用户点击宠物（判定为"点击"而非拖动）
   │
   ├─ renderer → main : pet:click
   ├─ main : bubbleWindow 定位 → show()
   │
用户输入"上海今天天气怎么样"
   │
   ├─ renderer → main : pet:userMessage { text }
   ├─ agent.runTurn()：生成 turnId
   │     ├─ memory.append(user, turn_id)
   │     ├─ emit brain:state { turnId, think }        → 宠物转圈
   │     ├─ provider.chat(system=稳定前缀, ..., user="[现在是 2026-09-11 14:20 周四] 上海…")
   │     │      └─→ safeFetch → api.deepseek.com        ★出网①（对话）
   │     ├─ 模型返回 tool_call: weather{ city:"上海", action:"now" }
   │     ├─ runner.run("weather", args, { turnId, signal })
   │     │     ├─ 权限检查：network:weather ✅
   │     │     ├─ risk=read_only → 不弹确认
   │     │     ├─ 参数校验（validateArgs）✅
   │     │     ├─ 内存缓存未命中 → safeFetch
   │     │     │     ├─→ geocoding-api.open-meteo.com   ★出网②（白名单）
   │     │     │     └─→ api.open-meteo.com             ★出网③（白名单）
   │     │     ├─ WMO code → 中文描述（本地映射，不问模型）
   │     │     └─ 返回 { ok:true, summary:"上海 18°C 多云…(观测时间 14:20)", data:{...} }
   │     ├─ memory.append(tool result)   ← 只回填 summary，不回填整个 JSON
   │     ├─ 再次 provider.chat(...)  → 流式产出最终回答
   │     │      └─→ safeFetch → api.deepseek.com        ★出网④（对话）
   │     ├─ emit brain:state { turnId, speak } + brain:delta（逐字，带 turnId，渲染端合帧）
   │     └─ memory.append(assistant) + usage.record(唯一记账) + 落盘
   │
   └─ renderer 逐字渲染 → 完毕 → brain:state { turnId, idle }
```

**关键点**
- 模型被调用两次（一次决策、一次叙述），这是工具调用范式的必然；`summary ≤ 800 字符`保证第二次请求的上下文不被撑爆。
- **每次出网都经过 `safeFetch`**，域名全部落在白名单内。
- **`turnId` 贯穿全过程**，用户中途点停止再发新消息时，旧 delta 会被渲染端按 `turnId` 丢弃。

---

## 8. 依赖清单与版本策略

### 8.1 运行时依赖（dependencies）

| 包 | 用途 |
|---|---|
| **（无）** | 🎉 **v0 的运行时依赖为零** —— 除 Electron 本身外不装任何包。存储用 Node 内置 `node:sqlite`，模型客户端手写（`fetch` + SSE），参数校验用**手写校验器 `src/main/skills/schema.js`**（M3 已落地，替代原计划的 zod） |

> 这提前达成了 `PRD-Skill-v0.md` AS15「零依赖」的验收目标。

### 8.2 开发依赖（devDependencies）

| 包 | 用途 |
|---|---|
| `electron` | 运行时本体 |
| `@electron/rebuild` | 为 Electron ABI 重建原生模块 |
| `typescript` | **仅用于** `tsc --checkJs` 静态检查（不产出构建物）。**必须通过才允许提交**，见 §2.5 |
| `playwright` | E2E 测试（Electron 支持），验透明窗/托盘/键盘焦点 |

### 8.3 版本策略

- **`electron` 锁定精确版本**（不用 `^`）——它是唯一的运行时本体，版本变更影响面最大。
- **已无原生模块需要关心**：存储用 Node 内置 `node:sqlite`（无 ABI 耦合），模型客户端手写。因此**不再需要 `@electron/rebuild` 与 `postinstall` 重建**。
- 其余用 `^` 即可。
- 用 `fnm` + `.node-version` 锁定 Node，防止未来的自己被 Node 升级搞坏。

### 8.4 v0 依赖目标

> **除 Electron 生态外，运行时依赖 ≤ 3 个**，且技能自身**零依赖**（`weather` 只用 Node 内置 `fetch`）。
> 这条直接对应 `PRD-Skill-v0.md` AS15 的验收。

### 8.5 本机环境搭建注意事项（实施期踩到的坑，记录以免重踩）

| 现象 | 原因 | 处理 |
|---|---|---|
| `pnpm install` 后 `node_modules/electron/path.txt` 缺失，一 `require('electron')` 就试图下载二进制 | **pnpm 10+ 默认拦截依赖的 postinstall 脚本**；且 pnpm 11 起 `package.json` 的 `"pnpm"` 字段已不再被读取 | 设置搬到了 **`pnpm-workspace.yaml`** 的 `onlyBuiltDependencies: [electron]` |
| 下载失败：`TypeError: fetch failed`（github.com 连接超时） | Electron 二进制默认从 GitHub Releases 下载，本机网络不可达 | 写入 **`.npmrc`** 的 `electron_mirror=https://registry.npmmirror.com/-/binary/electron/` |
| 下载成功但仍报 `EPERM: mkdir ~/Library/Caches/electron` | **`@electron/get@5` 已不再支持 `ELECTRON_CACHE`**，缓存目录写死为 `~/Library/Caches`（`env-paths` 决定），受限环境无法创建 | 提供 **`pnpm electron:install`**（`scripts/install-electron.sh`）：绕过 `@electron/get`，直接从镜像下载 → 用官方 `checksums.json` 校验 sha256 → 解压到 `node_modules/electron/dist` → 写 `path.txt` |
| `node --test test/unit` 报 `MODULE_NOT_FOUND` | Node 24 不再把目录参数当作测试集合 | 用 glob：`node --test "test/**/*.test.js"`（已写进 `package.json`） |
| 单元测试一 import `preload.cjs` 就触发 Electron 二进制下载 | `require('electron')` 在纯 Node 下不是无害的 | **把三张通路白名单下沉到 `channels.cjs`**，测试只 import 纯数据文件，完全不碰 electron |
| `path.txt` 写对了却仍报 "Electron failed to install correctly" | **Electron 44 改了 `path.txt` 的语义**：`index.js` 是 `path.join(__dirname, 'dist', pathTxt内容)`，所以内容**不能**带 `dist/` 前缀 | 写 `Electron.app/Contents/MacOS/Electron`（与官方 `getPlatformPath()` 一致），见 `scripts/install-electron.sh` |
| GUI 进程在 `app.whenReady()` 处 `SIGTRAP` 崩溃，日志只有 6 行 | Chromium 浏览器进程初始化被**外层进程沙箱**拦截（文件沙箱已先一步拒绝过写 `~/Library/Caches/electron`） | 在**普通终端**里跑 `pnpm start`；若在受限沙箱内执行，需要放宽权限。`pnpm smoke` 可用来快速判断环境是否允许启 GUI |

---

## 9. 开发脚本与测试分层（`package.json` scripts）

| 脚本 | 命令 | 用途 | 状态 |
|---|---|---|---|
| `start` | `electron .` | 开发态启动 | ✅ M0 |
| `dev` | `electron . --enable-logging` | 带日志启动 | ✅ M0 |
| `smoke` | `electron . --smoke` | **自检并退出**：窗口/置顶/焦点/尺寸/`setPosition`/穿透/托盘/Dock 一次性验证，输出 PASS/FAIL | ✅ M0 |
| `check` | `tsc --noEmit` | 类型静态检查（**里程碑门槛，必须通过**） | ✅ M0 |
| `test` | `node --test "test/**/*.test.js"` | 单元 + 集成测试（当前 120 个用例） | ✅ M3 |
| `test:e2e` | `playwright test` | E2E（透明窗、托盘、**键盘焦点**） | ⬜ M2 |
| `soak` | `node scripts/soak.js` | **mock provider 长跑，断言 RSS 增长**（A10 / AB13 的执行手段） | ⬜ M4 |
| `skill:test` | `node scripts/skill-test.js <name> '<json>'` | 单技能直调，绕过模型调试 | ✅ M3 |
| `skill:list` | `node scripts/skill-test.js --list` | 列出已注册技能与权限/域名并集（可审计） | ✅ M3 |
| `electron:install` | `bash scripts/install-electron.sh` | 受限网络/环境下手动装 Electron 二进制（见 §8.5） | ✅ M0 |

**测试分层清单（v0.1 明确化，原稿只有 3 个文件）**

| 层 | 位置 | 覆盖 |
|---|---|---|
| 单元 | `test/unit/` | `hit-test`（alpha 滞回）、`runner` 三道闸门（权限 / L3 / 参数）、`egress` 白名单与飞行模式、`memory` 窗口裁剪、WMO 映射、**`safeFetch` 的 signal 合并** |
| 集成 | `test/integration/` | agent 循环 + mock provider + mock 技能（含 5 步熔断、技能失败回填、预算闸门） |
| E2E | `test/e2e/` | Playwright for Electron：透明窗存在性、托盘、**气泡窗能否拿到键盘焦点**（D-3） |
| 长跑 | `scripts/soak.js` | mock provider 长跑，周期性采样 RSS，断言增长 ≤ 20MB |

---

## 10. 实施顺序（里程碑）

| 里程碑 | 交付物 | 关闭的验收项 | 状态 |
|---|---|---|---|
| **M0 能看见** | Electron 启动、`petWindow` 透明置顶、托盘、程序化占位像素图、idle 动画 | A1、A2、A6(部分)、A8(部分) | ✅ **已完成** |
| **M1 能摸** | alpha 命中测试 + `pet:setIgnoreMouse` 穿透 + **4px/250ms 阈值** + 主进程轮询拖动 + `pet:click` + 位置比例持久化 | A3、A4、A5 | ✅ **已完成** |
| **M2 能说** | **① 先实测气泡窗键盘焦点（D-3）**；② **冻结 IPC 契约**；③ `bubbleWindow` + 定位 + 合帧流式；④ provider + agent 循环 + SQLite + 时间前置注入 | A7、A13、AB1、AB2、AB3、AB4、AB8、AB14 | ✅ **代码已完成**，待你用真 Key 验收 |
| **M3 能干** | registry + runner + egress + weather 技能 + 工具调用闭环 + **mock provider 交付** + **AS7/AS8（权限闸门与 L3 红线）** | AB5、AB6、AB7、AB11、AB12、**AS1–AS8**、AS9–AS15 | ✅ **已完成**（原列的 A14 已随 v0.5 的作用域归位改为会话删除）|
| **M4 能扛** | 调试面板（含**内存曲线**）、费用统计与上限、防泄漏自查、**`pnpm soak` 跑测** | A9–A11、AB10、AB13 | ⬜ |

### 10.1 M0 / M1 已落地的证据

- `pnpm check` 通过（TypeScript 7.0.2 严格模式 + `checkJs`）。
- `pnpm test` 21/21 通过（geometry 7 · hit-test 8 · channels 6）。
- `pnpm smoke` **10/10 通过**：
  - 窗口创建 / 可见 / 160×160 / 置顶 / `focusable=false` / accessory（Dock 已隐藏）/ 托盘创建 / 主进程 RSS 可读（约 151MB）
  - ⭐ **`movable: false` 下 `setPosition()` 生效** —— 评审列为"必做实测（D-4）"的风险项，现已实测通过，拖动方案成立。
- **实测中发现并修正了一处规格错误**：评审给出的滞回阈值"进入 10 / 退出 30"是反的，会导致每个事件翻转一次（振荡）。已改为"进入 30 / 退出 10"，并由单测锁定（`反复喂同一个中间值不会导致状态振荡`）。

### 10.3 M3 已落地的证据

- `pnpm test` **120/120 通过**（M3 新增 70 个用例）：
  - `schema.test.js`（16）：清单字段逐项约束、非只读技能必须确认、出网权限与白名单必须配对、参数类型/枚举/范围/数组项
  - `skills.test.js`（19）：注册表"不带病加载"、域名进白名单、**四道闸门**（存在/权限/L3 红线/确认/参数/超时/归一化）、safeFetch 注入与飞行模式
  - `weather.test.js`（14）：WMO 中文映射、城市兜底表、观测时间必现、城市认不出时不编造、**10 分钟缓存**、主源失败降级备源、主备都挂如实报错
  - `agent.test.js`（21）：流式拼接、时间前缀位置、system 前缀逐字节稳定、**工具调用闭环**、参数非 JSON、技能失败不崩、**AB7 五步中止**、**AB12 预算闸门**、取消、每次往返都记账
- `pnpm skill:test weather '{"city":"上海","action":"now"}'` **真实联网成功**：

  > 上海现在 27.1°C，晴，体感 27.1°C，湿度 50%，风速 13.1km/h，降水 0mm。
  > 数据观测时间：2026-09-11T16:15（当地时间，来源 Open-Meteo）

- `pnpm skill:list` 输出权限并集与出网白名单，可人工审计。

### 10.4 M3 实施中被测试抓出的缺陷

| 缺陷 | 后果 |
|---|---|
| ESM 按 URL 缓存模块 | 同一个技能路径被加载两次时（重载 / 测试）拿到**上一次的代码**，改动看起来"没生效" |
| runner 把技能抛出的 `AppError` 降级成 `INTERNAL` | `EGRESS_DENIED`、`TIMEOUT` 等真实原因丢失，模型和用户都看不到 |
| 记账写在"有工具调用"的分支里 | **普通一问一答根本不产生用量记录**，成本统计直接失真 |

### 10.2 尚未验证（需要肉眼或换环境）

- 透明背景、像素画观感、拖动跟手程度 —— 需要人工运行 `pnpm start` 目视确认。
- 点击穿透在鼠标进出实体像素时的表现。
- **注意**：GUI 进程在**受限进程沙箱内**会于 `app.whenReady()` 处崩溃（见 §8.5），请在普通终端里启动。

---

## 11. 风险与备选方案

| 风险 | 触发信号 | 备选方案 |
|---|---|---|
| ~~accessory 模式下气泡窗拿不到键盘焦点~~ | — | ✅ **已实测通过**（M2；`PRD-Body` changelog v0.3）。**风险已闭环，从风险表移除** |
| ~~`movable: false` 与 `setPosition` 不兼容~~ | — | ✅ **已实测通过**（本文件 §10.1："⭐ `movable: false` 下 `setPosition()` 生效"）。**风险已闭环，从风险表移除** |
| ~~`better-sqlite3` ABI 重建失败~~ | **该风险已消失** | v0.3 改用 Node 内置 `node:sqlite`，无原生模块、无 ABI 耦合、无重建步骤（§6.10） |
| Electron 透明窗口在 macOS 更新后异常 | 窗口黑底 / 不置顶 | 调整置顶层级；必要时降级为"半透明圆角窗" |
| 命中测试抖动 | 边缘闪烁、拖不动 | 已内置滞回阈值；进一步加大阈值或引入 3 帧确认 |
| 中文城市地理编码识别差 | 查"上海"报找不到 | 启用 `city-fallback.js` 内置常用城市经纬度表前置匹配 |
| 内存缓慢增长 | 调试面板曲线单调上升 | 按 `PRD-Body-v0.md` §6.3 十条清单逐条排查；重点查 IPC 监听器与未 abort 的流；用 `pnpm soak` 复现 |
| DeepSeek 不可用 / 限流 | 请求失败 | 指数退避；provider 层预留切换其他 OpenAI 兼容服务的配置位 |
| 费用估算失真 | 与官方调价不符 | 价格表 `config/pricing.json` 手工维护；文档与界面均声明"估算仅供参考，不保证与账单一致" |
| Electron 体积/内存不可接受 | 用户明确反对 | v1+ 迁 Tauri：Body 层是薄壳，Brain/Skill 逻辑可平移 |
| ~~多显示器坐标错乱~~ | — | **v0 不涉及多显示器**（PM 明确：不再讨论、不再测试）。坐标已改为 workArea 比例存储，即使换屏也不会越界 |

---

## 12. NOTICE 与形象版权（评审决定 5）

**结论：实际风险≈0，继续使用 NONO 名称。**

- 「NONO」本身不是淘米的专有名词（意大利语 nonno = 爷爷，普通词）。真正可能被主张的是**具体角色形象**与**具体视觉/文本素材**。
- 本项目实现是原创的：v0 是程序化生成的像素图，v1 即使画真图也是自制图集。**没有复制淘米的任何美术、代码或文案**——借的只是「一个叫 NONO 的随身 AI 助手」这个概念。
- 「Super Nono」≠「超能 NONO」，名称不构成同一标识。
- 开源 toy、无商业化、无流量，维权动机（商誉损害 + 商业损失）均为 0。最坏情况是一封 DMCA 要求改名，而改名随时可做、零成本。

**执行要求**

1. 仓库根目录新增 **`NOTICE.md`**：声明本项目为个人作品，与淘米 /《赛尔号》无任何关联，未使用其任何素材；NONO 形象为原创像素设计。
2. **美术上坚决不"还原"淘米那只的具体造型**（配色、部件、比例）。可以画记忆里的感觉，**不要照着描**。
   - **这是唯一真正重要的一条：概念不受保护，具体表达受保护。**
3. 若未来商用（哪怕挂赞助），上述前提消失，届时再改名。

---

## 附录 A：飞行功能实现草案（v1+ 存档）

**已决定 v0 不做**，此处仅存档设计，避免将来重新讨论。

- 交互：快捷键 → 进入定位模式 → 鼠标左键点击桌面任意位置 → 宠物飞过去。
- **推荐方案：全屏透明覆盖层**
  - 触发后，铺一个全屏透明窗口接住下一次左键点击，拿到坐标后立即关闭。
  - **完全不需要鼠标权限**（快捷键走 Electron `globalShortcut`；点击由自己的窗口正常接收）。
  - 局限：盖不住 macOS 菜单栏与其他 App 的全屏空间，作为降级可接受。
- 备选（不推荐先用）：全局鼠标钩子 —— 需要"辅助功能"授权，风险与审核成本高一个量级。
- 飞行动画：二次贝塞尔轨迹 + 挤压拉伸，几百毫秒完成，落地回弹。
- 多显示器坐标换算（逻辑像素 vs 物理像素、macOS y 轴方向）属于该功能的配套工作，**v0 完全不涉及**。

---

*本文档为 **v0.1 待评审稿**，依据 `v0-review-20260911-1130.md` 修订，与三份 PRD 配套。评审通过后按 §10 里程碑开始搭建。*
