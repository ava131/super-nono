/**
 * 跨模块共享的**契约常量**。
 *
 * ## 为什么单独一个文件
 *
 * 这些值被**宿主**（`src/main/`）和**技能**（`skills/`）同时消费，
 * 任何一处单独改都会造成"两边不一致"的隐蔽 bug：
 *
 * | 常量 | 谁用 | 不一致的后果 |
 * |---|---|---|
 * | `SUMMARY_LIMIT` | `runner.js` 截断 summary、`snapshot.js` 排版表格 | 表格以为能放 800、实际被截到 600 → 用户看到**残缺数据**且毫无提示 |
 * | `WATCHLIST_LIMIT` | `watchlist` 判上限、`market.scan` 判上限 | 能加 30 支但 `scan` 只接受 20 → 用户加了却扫不了 |
 *
 * 所以：**只在这里定义一次**，两边 `import`。`test/unit/contract.test.js`
 * 还会断言"引用关系没被改回硬编码"。
 *
 * 放根目录的 `shared/` 而不是 `src/shared/`，是因为技能在 `skills/` 下、
 * 宿主在 `src/main/` 下，两边到这里的相对深度都是固定的两层以内，
 * 而且技能的 `skill.json` 也必须能不受影响地被独立校验（本文件不 import 任何东西）。
 */

/**
 * 给模型看的 `summary` 长度上限。
 *
 * 判定基准是 **`String.length`（UTF-16 码元）**，**不是字节数** ——
 * 中文一字 3 字节，按字节算会超标 3 倍（评审 C-3）。
 */
export const SUMMARY_LIMIT = 800;

/** 自选股上限（PRD-market §5） */
export const WATCHLIST_LIMIT = 20;

/**
 * 单次 `scan` 的出网次数告警阈值。
 *
 * `scan` 最多 20 只，加上重试余量取 25。**超过就说明缓存没生效** ——
 * 这是发现缓存 bug 的唯一早期信号（PRD §12.1 第 5 条）。
 */
export const FETCH_WARN_THRESHOLD = 25;
