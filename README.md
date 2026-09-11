# Super Nono

> 一只住在 macOS 桌面上的**像素桌宠**，同时是一个**能调用技能的 AI Agent**。

它会呼吸、会眨眼、可以被你拖着到处放；点一下会弹出对话框，背后接的是 DeepSeek，
还带着一套带权限闸门的技能系统（v0 有一个天气技能）。
它记得你聊过什么，也会老实说"这个我查不到"。

**个人项目，与淘米 /《赛尔号》无任何关联，未使用其任何素材。** 详见 [NOTICE.md](NOTICE.md)。

---

## 目录

- [它长什么样](#它长什么样)
- [快速开始](#快速开始)
- [功能](#功能)
- [隐私与安全](#隐私与安全)
- [写一个技能](#写一个技能)
- [项目结构](#项目结构)
- [开发](#开发)
- [设计文档](#设计文档)
- [路线图](#路线图)

---

## 它长什么样

> 📷 *（截图 / 动图位，欢迎补充）*

一只 96×96 的像素小机器人，透明背景、始终置顶、不占 Dock。
鼠标移到它身上才能拖它；周围的透明区域点击会穿透到桌面，不会挡你干活。

---

## 快速开始

### 环境要求

| 项 | 要求 |
|---|---|
| 系统 | macOS（Apple Silicon；v0 未适配 Windows / Linux） |
| Node.js | ≥ 22（开发用 24.19 验证） |
| 包管理 | pnpm ≥ 10（开发用 11.22 验证） |

### 安装

```bash
git clone https://github.com/ava131/super-nono.git
cd super-nono
pnpm install
```

**如果 Electron 二进制没装成功**（`node_modules/electron/path.txt` 不存在），跑：

```bash
pnpm electron:install
```

这个脚本会绕过 `@electron/get`，直接从镜像下载 → 用官方 `checksums.json` 校验 sha256 →
解压到 `node_modules/electron/dist` → 写好 `path.txt`。国内网络环境下基本是必需的。

<details>
<summary>为什么需要这个脚本？（踩坑记录）</summary>

装这个项目时踩到的四个坑，都记在 [SDD §8.5](docs/SDD-v0.md)：

1. **pnpm 10+ 默认拦截依赖的 postinstall 脚本** → 结果 Electron 二进制根本没下载。
   解法：`pnpm-workspace.yaml` 里声明 `onlyBuiltDependencies: [electron]`（仓库里已配好）。
2. **GitHub Releases 直连超时** → `.npmrc` 里把 `electron_mirror` 指到 npmmirror（已配好）。
3. **`@electron/get@5` 不再支持 `ELECTRON_CACHE`**，缓存目录写死 `~/Library/Caches`，
   在受限环境里会 `EPERM` → 所以有了 `pnpm electron:install` 这个绕开它的脚本。
4. **Electron 44 改了 `path.txt` 的语义**：`index.js` 会拼 `dist/`，
   所以 `path.txt` 的内容**不能**带 `dist/` 前缀。

</details>

### 运行

```bash
pnpm start
```

### 第一次配置

1. 点一下桌宠 → 弹出对话框
2. 点右上角 **⚙**
3. 填 **DeepSeek API Key** → 保存

Key 会用 Electron 内置的 `safeStorage`（底层就是 macOS 钥匙串）**加密后**存进
`~/Library/Application Support/Super Nono/config.json`，明文只在内存里。
如果系统不支持安全加密，它会**明确报错并拒绝保存**——绝不静默退回明文。

### 试试这些

| 说什么 | 会发生什么 |
|---|---|
| 你好，介绍一下你自己 | 流式逐字回答 |
| 上海今天天气怎么样 | 自动调用 `weather` 技能，给真实数据 |
| 北京明后天下雨吗 | 同上，走预报分支 |
| 帮我查一下火星的天气 | 明确说找不到，**不会编** |
| 今天几号 | 答对日期和星期 |
| （生成到一半点「停止」） | 立刻断开，不是等超时 |

---

## 功能

### 桌宠（Body）

- 透明、无边框、始终置顶、不占 Dock 的悬浮窗
- **10 fps** 像素动画：待机呼吸 / 被拖动 / 思考 / 说话 / 出错
- **精确命中测试**：按 alpha 通道判断鼠标是不是压在不透明像素上，
  透明区域自动穿透给下层；边缘带滞回阈值，不会闪
- **拖动**由主进程轮询光标位置实现（小窗口里鼠标一快就出界，靠渲染进程的
  `mousemove` 会丢事件）
- **点击 vs 拖动**用 4px / 250ms 阈值区分，手抖不会误判
- 位置按**屏幕工作区比例**存储，换电脑 / 改分辨率后不会跑到屏幕外

### 大脑（Brain）

- DeepSeek 流式对话，**可中断**
- **工具调用闭环**：模型决定调技能 → 执行 → 结果回填 → 再叙述
- **会话管理**：新建 / 历史列表 / 切换 / 改名 / 删除，标题自动取首条消息
- **记忆**：会话持久化到本地 SQLite
- **成本可见**：每次调用记录 token 与费用估算，可设每日费用上限
- 人格写在 [assets/persona.md](assets/persona.md) 里，改完重开就生效

### 技能（Skill）

v0 带一个 **`weather`**：Open-Meteo（主）+ wttr.in（备），**都不需要 API Key**。

每个技能是一个自包含目录，声明式定义：

```
skills/weather/
├── skill.json   ← 给模型看的描述、参数 Schema、权限、风险等级、域名白名单
├── index.js     ← 执行器：export async function run(args, ctx)
└── ...
```

四道执行闸门（顺序不可颠倒）：

| 闸门 | 行为 |
|---|---|
| 存在性 | 不存在的技能直接拒绝 |
| 权限 | 声明了 network 权限却没给白名单 → **加载时就不让它进注册表** |
| **L3 红线** | `irreversible` 的技能**硬拒绝，连确认都不发起** |
| L2 确认 | 非只读操作必须经用户点头；**超时即拒绝**；没有确认通道也拒绝 |
| 参数 | 不合法就不执行任何副作用 |
| 超时 | 技能卡住不会挂死对话 |

---

## 隐私与安全

这个项目的隐私模型很明确：

- **唯一的云端出口是 DeepSeek**（对话内容会发给它，这是用云 API 的必然代价）
- **API Key 是本项目最高密级的秘密**：加密存本机钥匙串，不进配置文件明文、不进日志、界面不回显
- **所有出网必须经过一个统一出口**（`src/main/skills/egress.js`），它强制 HTTPS、
  校验域名白名单、并记录每一次出网（只记域名和状态码，不记响应体）
- **技能拿不到裸 `fetch`**，只能用 runner 注入的 `ctx.safeFetch` —— 白名单是结构性保证，不靠技能自觉
- 提供**飞行模式**开关：一键彻底断网，只保留本地能力
- 所有数据在本地：`~/Library/Application Support/Super Nono/`

`pnpm skill:list` 可以随时审计"这个桌宠会跟哪些域名说话"。

---

## 写一个技能

1. 建目录 `skills/<name>/`
2. 写 `skill.json`：

```json
{
  "name": "demo",
  "version": "0.1.0",
  "description": "给模型看的说明：什么时候该用它。写得好坏直接决定调用准确率。",
  "parameters": {
    "type": "object",
    "properties": {
      "city": { "type": "string", "description": "城市名" }
    },
    "required": ["city"]
  },
  "permissions": ["network:demo"],
  "networkHosts": ["api.example.com"],
  "risk": "read_only",
  "requiresConfirmation": false,
  "timeoutMs": 10000
}
```

3. 写 `index.js`：

```js
export async function run(args, ctx) {
  const res = await ctx.safeFetch('https://api.example.com/x');
  if (!res.ok) return { ok: false, code: 'INTERNAL', message: `HTTP ${res.status}` };
  return { ok: true, summary: '给模型看的简短结果（≤800 字）', data: { /* 原始数据，不进上下文 */ } };
}
```

4. 直调调试（**绕过模型**，用来区分"技能坏了"和"模型没调对"）：

```bash
pnpm skill:test demo '{"city":"上海"}'
pnpm skill:list          # 看权限并集、出网白名单、被禁用的技能
```

5. 重启应用，模型会自动看到新技能。

> 约定：`summary` 是给模型读的，必须短（上限 800 字）；原始大数据放 `data`，
> 由上层决定要不要落盘，**不进上下文**。

---

## 项目结构

```
super-nono/
├── src/
│   ├── main/                Electron 主进程 —— 同时是 Agent 的宿主
│   │   ├── main.js          生命周期、托盘、单实例锁、smoke 自检
│   │   ├── window.js        宠物窗 + 气泡窗的创建/定位/拖动/穿透
│   │   ├── ipc.js           IPC 契约的唯一注册处
│   │   ├── brain/           模型调用、会话循环、记忆、人格、成本、开场提示
│   │   ├── skills/          技能注册表、执行闸门、出网白名单、校验器
│   │   └── store/           SQLite 与设置
│   ├── preload/preload.cjs  唯一的桥（只暴露语义化方法，不暴露 ipcRenderer）
│   ├── renderer/            宠物窗与气泡窗界面
│   └── shared/              两端共用的频道常量与纯几何函数
├── skills/weather/          天气技能
├── assets/persona.md        人格提示词（可改）
├── config/pricing.json      DeepSeek 价格表（用于费用估算）
├── test/                    单元 10 个文件 + 集成 1 个 + mock provider
├── scripts/                 手动装 Electron、单技能直调 CLI
└── docs/                    PRD / SDD / 评审记录
```

**一个应用、两个窗口、零后端服务**：Brain 跑在主进程里，
它本身就是"后端"；两个渲染窗口是"前端"；两者走进程内 IPC，没有端口、没有额外进程。

### 运行时依赖

```json
"dependencies": {}
```

除了 Electron 本身，**一个包都没装**。存储用 Node 内置的 `node:sqlite`，
模型客户端是手写的（fetch + SSE），参数校验也是手写的，托盘图标和像素画是程序化生成的。

---

## 开发

### 脚本

| 命令 | 作用 |
|---|---|
| `pnpm start` | 开发态启动 |
| `pnpm dev` | 带 Chromium 日志启动 |
| `pnpm smoke` | **自检并退出**：窗口/置顶/焦点/`setPosition`/穿透/托盘/Dock，输出 PASS/FAIL |
| `pnpm check` | TypeScript 静态检查（`checkJs`，不产出构建物） |
| `pnpm test` | 单元 + 集成测试（125 个用例） |
| `pnpm skill:list` | 列出技能、权限并集、出网白名单（可审计） |
| `pnpm skill:test` | 单技能直调，绕过模型 |
| `pnpm electron:install` | 手动安装 Electron 二进制（见上） |

### 测试

```bash
pnpm test
```

覆盖的不只是"顺利路径"，更多是在测**边界和失败**：

- alpha 滞回的振荡问题、拖动阈值、位置比例换算
- SSE 解析器（按 7 字符切碎模拟真实网络分片）
- 会话删除的四个边界（删当前 / 删最后一个 / 删不存在 / 不串会话）
- 技能的四道闸门、`summary` 截断、超时、参数非法时不执行
- **用 mock provider 测 agent 循环**：死循环 5 步中止、预算闸门、取消、
  每次模型往返都记账 —— 这些都不需要花真钱

---

## 设计文档

这个项目的文档写得比较细，因为**决策的理由比决策本身更容易丢**：

| 文档 | 内容 |
|---|---|
| [PRD-Body](docs/PRD-Body-v0.md) | 窗口、动画、交互、性能预算、防内存泄漏清单 |
| [PRD-Brain](docs/PRD-Brain-v0.md) | 模型调用、会话循环、记忆、隐私边界、成本控制 |
| [PRD-Skill](docs/PRD-Skill-v0.md) | 技能契约、三级权限、出网白名单、天气技能 |
| [SDD](docs/SDD-v0.md) | 技术选型、架构、**哪个功能在哪个文件实现**、实施顺序 |
| [评审记录](docs/v0-review-20260911-1130.md) | 一次完整的文档评审：发现的矛盾、被推翻的写法、待拍板的决定 |

其中几条被实测推翻、最后写进文档的教训：

- 透明度滞回阈值写反了 → 变成振荡器（被单测抓出）
- 「保存成功」的提示被放进了一个当时隐藏的视图 → 用户以为没保存
- 「清空对话」被放进了应用级设置里 →**操作放在了错误的作用域层级**
- 开场提示硬编码了「还没接技能」→ 技能接上后变成假话

---

## 路线图

- [x] **M0 能看见** — 透明置顶窗口、托盘、程序化像素画、待机动画
- [x] **M1 能摸** — 命中测试、点击穿透、拖动、点击/拖动阈值
- [x] **M2 能说** — 气泡窗、DeepSeek 流式对话、可中断、记忆、多会话
- [x] **M3 能干** — 技能注册表、四道闸门、天气技能、工具调用闭环
- [ ] **M4 能扛** — 调试面板（内存曲线）、费用上限实拦、`pnpm soak` 长跑测泄漏

v1+ 想法：更多技能（提醒、行情、邮箱）、多显示器、跨平台、宠物缩放、语音。

---

## 授权

MIT，见 [LICENSE](LICENSE)。

本项目是个人作品，与淘米 /《赛尔号》无任何关联，未使用其任何美术、代码或文案；
NONO 形象为原创像素设计。详见 [NOTICE.md](NOTICE.md)。
