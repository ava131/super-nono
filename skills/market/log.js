/**
 * 日志：**通过注入拿，不 import 宿主内部模块**。
 *
 * ## 为什么不直接 `import log from '../../../src/main/log.js'`
 *
 * 技能是**插件**，它的契约是"由宿主注入能力"（`ctx.safeFetch` / `ctx.store`）。
 * 直接 import 宿主内部路径有两个问题：
 *
 * 1. **路径耦合**：`skills/market/` 到 `src/main/` 的相对深度依赖目录结构，
 *    改一次目录就得改所有技能（本项目已因此踩过一次）。
 * 2. **破坏契约**：插件一旦能 import 宿主内部，就能绕过注入的能力
 *    （比如绕过 `safeFetch` 的白名单）—— 那正是 `PRD-Skill` §4.3 想避免的。
 *
 * 所以这里只接受**注入进来的** logger；没有就退化成 no-op（单测里正是如此，
 * 于是测试输出保持干净）。
 *
 * @param {any} ctx 技能上下文
 * @returns {{ warn: (e: string, d?: unknown) => void, info: (e: string, d?: unknown) => void }}
 */
export function createLogger(ctx) {
  const injected = ctx?.log;
  if (injected && typeof injected.warn === 'function') {
    return {
      warn: (event, data) => injected.warn(`market.${event}`, data),
      info: (event, data) => injected.info?.(`market.${event}`, data),
    };
  }
  return { warn() {}, info() {} };
}

/** no-op logger（模块级逻辑用不到 ctx 时） */
export const silentLogger = Object.freeze({ warn() {}, info() {} });
