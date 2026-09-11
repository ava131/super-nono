/**
 * 命中测试（PRD-Body v0.1 §W-2）。
 *
 * 整个模块是纯函数，不碰 DOM、不碰 Electron，因此可以直接单测
 * （见 test/unit/hit-test.test.js）。
 *
 * 判定依据是当前帧的 **alpha 通道**：alpha 足够大就认为鼠标落在
 * "实体像素"上，此时关闭点击穿透；否则穿透给下层。
 *
 * 关键点是**滞回**：鼠标停在像素边缘时 alpha 会在阈值附近抖动，
 * 如果只用单个阈值，穿透开关会高频翻转，表现为边缘闪烁 / 拖不动。
 * 因此进入用较高的 ENTER，退出用较低的 EXIT，两者之间保持原状态。
 */

/**
 * 进入"实体"的阈值：alpha 必须**高于**它才认定鼠标压在像素上。
 *
 * ⚠️ 这两个常量的大小关系不能反。
 * 评审文档最初写的是"进入阈值 10、退出阈值 30"，那是错的：那样写的话
 * alpha 落在 10–30 之间时，prev=false 会进、prev=true 会出，每个事件都翻转
 * ——正是滞回想要消除的抖动，反而变成了振荡器。
 * 正确的滞回永远是"进入用高阈值、退出用低阈值"。
 */
export const ENTER_ALPHA = 30;

/** 退出"实体"的阈值：alpha 必须**低于**它才恢复穿透。必须 < ENTER_ALPHA。 */
export const EXIT_ALPHA = 10;

/**
 * 由上一帧的判定结果和当前像素 alpha，得出新的判定结果。
 *
 * @param {boolean} prevSolid 上一状态：true = 实体像素（不穿透）
 * @param {number} alpha 当前像素 alpha（0–255）
 * @returns {boolean} 新状态
 */
export function nextSolid(prevSolid, alpha) {
  if (prevSolid) return alpha >= EXIT_ALPHA; // 只有掉到退出阈值以下才恢复穿透
  return alpha > ENTER_ALPHA; // 只有超过进入阈值才关掉穿透
}

/**
 * 从 ImageData 里取某点的 alpha。
 *
 * 越界一律返回 0（视作透明），这样鼠标跑到窗口外时不会误判为实体。
 *
 * @param {{ data: Uint8ClampedArray, width: number, height: number }} image
 * @param {number} x 设备像素坐标（0 起）
 * @param {number} y
 * @returns {number} 0–255
 */
export function alphaAtPixel(image, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= image.width || py >= image.height) return 0;
  return image.data[(py * image.width + px) * 4 + 3] ?? 0;
}
