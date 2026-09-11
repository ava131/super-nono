/**
 * 纯几何计算：窗口位置 ↔ 屏幕工作区。
 *
 * 无副作用、不依赖 Electron，可直接单测（见 test/unit/geometry.test.js）。
 *
 * 位置以「宠物窗口中心占 workArea 的比例」存储（`{ rx, ry }`），
 * 这样换电脑 / 改分辨率后永远不可能越界，连"坐标是否在屏内"的判断都不用写。
 * （PRD-Body v0.1 §W-1）
 */

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 * @typedef {{ rx: number, ry: number }} PositionRatio
 */

/** 首次启动的落点：右下角 */
export const DEFAULT_RATIO = Object.freeze({ rx: 0.9, ry: 0.9 });

/**
 * @param {number} n
 * @returns {number}
 */
function clamp01(n) {
  if (!Number.isFinite(n)) return 0.5;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * 把一个矩形约束在工作区内。
 *
 * 若矩形比工作区还大，优先保住左上角（即 max 与 min 交换顺序后仍取边界）。
 *
 * @param {Rect} rect
 * @param {Rect} workArea
 * @returns {{ x: number, y: number }}
 */
export function clampToWorkArea(rect, workArea) {
  const maxX = workArea.x + workArea.width - rect.width;
  const maxY = workArea.y + workArea.height - rect.height;
  const x = Math.min(Math.max(rect.x, workArea.x), Math.max(workArea.x, maxX));
  const y = Math.min(Math.max(rect.y, workArea.y), Math.max(workArea.y, maxY));
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * 由窗口位置反算比例（以窗口中心为基准）。
 *
 * @param {Rect} bounds
 * @param {Rect} workArea
 * @returns {PositionRatio}
 */
export function toRatio(bounds, workArea) {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const rx = workArea.width > 0 ? (cx - workArea.x) / workArea.width : DEFAULT_RATIO.rx;
  const ry = workArea.height > 0 ? (cy - workArea.y) / workArea.height : DEFAULT_RATIO.ry;
  return { rx: clamp01(rx), ry: clamp01(ry) };
}

/**
 * 由比例还原窗口左上角坐标，并保证整个窗口落在工作区内。
 *
 * @param {PositionRatio | null | undefined} ratio
 * @param {{ width: number, height: number }} size
 * @param {Rect} workArea
 * @returns {{ x: number, y: number }}
 */
export function fromRatio(ratio, size, workArea) {
  const r = ratio ?? DEFAULT_RATIO;
  const cx = workArea.x + clamp01(r.rx) * workArea.width;
  const cy = workArea.y + clamp01(r.ry) * workArea.height;
  return clampToWorkArea(
    { x: cx - size.width / 2, y: cy - size.height / 2, width: size.width, height: size.height },
    workArea,
  );
}
