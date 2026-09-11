/**
 * 宠物窗的渲染进程。
 *
 * 负责（PRD-Body v0.1）：
 *   - W-4 动画状态机（10fps，不用 rAF 空转）
 *   - W-2 命中测试 → 切换点击穿透
 *   - W-3.1 点击 vs 拖动的阈值判定
 *   - W-9 通过 window.api 与主进程通信（**不认识任何频道名**）
 *
 * 唯一的对外依赖是 preload 暴露的 `window.api`（见 types/global.d.ts）。
 */
import { alphaAtPixel, nextSolid } from './hit-test.js';
import { createFrames } from './placeholder-art.js';

const CANVAS_SIZE = 160;
const SPRITE_SIZE = 96;
const PAD = (CANVAS_SIZE - SPRITE_SIZE) / 2;
const TICK_MS = 100;

/** 拖动判定阈值 —— 必须是一个具体数字，否则测试没法写用例（PRD-Body v0.1 §W-3.1） */
const DRAG_PX = 4;
const DRAG_MS = 250;

/** 指针离开窗口后，多久判定"这次拖动已经结束"（防止 mouseup 丢失导致卡在 drag 态） */
const DRAG_LOST_MS = 600;

/** @typedef {ReturnType<typeof createFrames>} Animations */
/** @typedef {keyof Animations} StateName */

const api = window.api;

// 断言成非 null（下面有运行时保护）：这样闭包里的 canvas 也不会被推断成 nullable。
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('stage'));
if (!canvas) throw new Error('pet.js: 找不到 #stage');

const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
if (!ctx) throw new Error('pet.js: 拿不到 2d 上下文');

const dpr = window.devicePixelRatio || 1;
canvas.width = Math.round(CANVAS_SIZE * dpr);
canvas.height = Math.round(CANVAS_SIZE * dpr);
canvas.style.width = `${CANVAS_SIZE}px`;
canvas.style.height = `${CANVAS_SIZE}px`;
ctx.imageSmoothingEnabled = false;

const animations = createFrames(dpr, SPRITE_SIZE);

/** @type {StateName} */
let stateName = 'idle';
let tickCount = 0;

/** 当前是否判定为"鼠标在实体像素上"（true = 不穿透） */
let solid = false;
let dragging = false;

/** @type {{ x: number, y: number, t: number, offsetX: number, offsetY: number } | null} */
let down = null;

/** @type {ImageData | null} */
let alphaCache = null;

/** @type {number | null} */
let timer = null;

/** @type {number | null} */
let lostTimer = null;

// ── 渲染 ────────────────────────────────────────────────────────────

function draw() {
  const anim = animations[stateName] ?? animations.idle;
  const index = Math.floor(tickCount / anim.hold) % anim.frames.length;
  const frame = anim.frames[index];

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (frame) {
    ctx.drawImage(frame, PAD * dpr, PAD * dpr, SPRITE_SIZE * dpr, SPRITE_SIZE * dpr);
  }

  // 命中测试用 alpha 在**切帧时**采样一次并缓存，不在 mousemove 里反复 getImageData。
  alphaCache = ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function startTicking() {
  if (timer !== null) return;
  draw();
  timer = window.setInterval(() => {
    tickCount += 1;
    draw();
  }, TICK_MS);
}

function stopTicking() {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
}

/**
 * @param {StateName} name
 */
function setState(name) {
  if (stateName === name) return;
  stateName = name;
  tickCount = 0;
  api.stateChanged(name);
  draw();
}

// ── 命中测试 ────────────────────────────────────────────────────────

/**
 * @param {number} clientX
 * @param {number} clientY
 * @returns {number} alpha 0–255
 */
function alphaAt(clientX, clientY) {
  if (!alphaCache) return 0;
  return alphaAtPixel(alphaCache, clientX * dpr, clientY * dpr);
}

/**
 * @param {boolean} next
 */
function applySolid(next) {
  if (next === solid) return;
  solid = next;
  api.setIgnoreMouse(!next);
}

// ── 拖动 / 点击 ─────────────────────────────────────────────────────

function cancelLostTimer() {
  if (lostTimer !== null) {
    window.clearTimeout(lostTimer);
    lostTimer = null;
  }
}

/**
 * @param {MouseEvent} event
 */
function finishDrag(event) {
  cancelLostTimer();
  dragging = false;
  down = null;
  api.dragEnd();
  setState('idle');
  applySolid(nextSolid(true, alphaAt(event.clientX, event.clientY)));
}

/**
 * @param {MouseEvent} event
 */
function onMouseDown(event) {
  if (event.button !== 0) return;
  down = {
    x: event.screenX,
    y: event.screenY,
    t: Date.now(),
    offsetX: event.clientX,
    offsetY: event.clientY,
  };
}

/**
 * @param {MouseEvent} event
 */
function onMouseMove(event) {
  // 拖动中：如果按键已经松开（例如 mouseup 落在窗口外），就地结束
  if (dragging) {
    if ((event.buttons & 1) === 0) finishDrag(event);
    return;
  }

  // 拖动升级判定
  if (down) {
    const moved = Math.hypot(event.screenX - down.x, event.screenY - down.y);
    if (moved > DRAG_PX || Date.now() - down.t > DRAG_MS) {
      dragging = true;
      cancelLostTimer();
      api.setIgnoreMouse(false); // 拖动期间必须收得到 mouseup
      setState('drag');
      api.dragStart(down.offsetX, down.offsetY);
      return;
    }
  }

  applySolid(nextSolid(solid, alphaAt(event.clientX, event.clientY)));
}

/**
 * @param {MouseEvent} event
 */
function onMouseUp(event) {
  if (event.button !== 0 || !down) return;

  if (dragging) {
    finishDrag(event);
    return;
  }

  down = null;
  // 只报告"这是一次点击"；怎么处理由主进程决定（M2 会在这里开气泡窗）
  api.click();
}

function onMouseLeave() {
  if (dragging) {
    // 窗口被拖到屏幕边缘时会被 clamp 住，指针可能离开窗口。
    // 给一个宽限期：指针回到窗口内就取消，否则判定拖动已结束。
    cancelLostTimer();
    lostTimer = window.setTimeout(() => {
      lostTimer = null;
      if (dragging) {
        dragging = false;
        down = null;
        api.dragEnd();
        setState('idle');
      }
    }, DRAG_LOST_MS);
    return;
  }
  if (solid) applySolid(false);
}

function onMouseEnter() {
  cancelLostTimer();
}

function onWindowBlur() {
  if (!dragging) return;
  dragging = false;
  down = null;
  api.dragEnd();
  setState('idle');
}

// ── 启动 ────────────────────────────────────────────────────────────

window.addEventListener('mousemove', onMouseMove);
window.addEventListener('mousedown', onMouseDown);
window.addEventListener('mouseup', onMouseUp);
window.addEventListener('mouseleave', onMouseLeave);
window.addEventListener('mouseenter', onMouseEnter);
window.addEventListener('blur', onWindowBlur);
window.addEventListener('contextmenu', (event) => event.preventDefault());

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopTicking();
  else startTicking();
});

// 主进程下发的状态（M2 之后由 Brain 驱动）。
// 优先级规则：本地交互态（drag）优先于主进程下发态（PRD-Body v0.1 §W-4）。
api.onState((payload) => {
  if (dragging) return;
  const next = payload.state;
  if (next in animations) setState(/** @type {StateName} */ (next));
});

draw();
startTicking();

// 初始全局穿透：不能一上来就用 160×160 的透明矩形挡住桌面。
// 鼠标移到实体像素上时，mousemove（forward: true）会把穿透关掉。
api.setIgnoreMouse(true);
api.ready();
