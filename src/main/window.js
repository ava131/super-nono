/**
 * 宠物窗口的生命周期、定位、拖动、点击穿透。
 *
 * 对应 PRD-Body v0.1 的 W-1 / W-2 / W-3 / W-3.1。
 *
 * 关键决策（见 SDD v0.1 §6.1 / §6.3）：
 *   - 窗口 160×160，精灵 96×96 居中，四周 32px 留白不参与命中测试；
 *   - `movable: false` —— 拖动完全自己实现，这样才能边拖边播动画、能限制范围；
 *   - 拖动跟随**由主进程轮询光标**，不依赖渲染进程的 mousemove
 *     （窗口太小，快速拖动时鼠标会跑出窗口导致丢事件）。
 */
import { BrowserWindow, app, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clampToWorkArea, fromRatio, toRatio } from '../shared/geometry.js';
import log from './log.js';
import * as settings from './store/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 与 Electron 的 `Rectangle` 结构一致。
 * 不用 `Electron.Rect`：Electron 44 的类型里没有导出这个名字。
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 */

export const PET_WINDOW_SIZE = 160;
export const SPRITE_SIZE = 96;

/** 气泡窗尺寸（SDD v0.1 §6.1 / §6.12） */
export const BUBBLE_WIDTH = 380;
export const BUBBLE_HEIGHT = 440;

/** 气泡与宠物之间的间距 */
const BUBBLE_GAP = 8;

/** 拖动跟随的轮询间隔（约 60fps） */
const DRAG_POLL_MS = 16;

/** @type {BrowserWindow | null} */
let petWindow = null;

/** @type {NodeJS.Timeout | null} */
let dragTimer = null;

/** @type {{ x: number, y: number } | null} */
let dragOffset = null;

/** @type {BrowserWindow | null} */
let bubbleWindow = null;

/** @returns {BrowserWindow | null} */
export function getPetWindow() {
  return petWindow;
}

/** @returns {BrowserWindow | null} */
export function getBubbleWindow() {
  return bubbleWindow;
}

/**
 * @param {{ width: number, height: number }} size
 * @returns {Rect}
 */
function workAreaOf(size) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  void size;
  return display.workArea;
}

/** 创建宠物窗口（只创建一次；隐藏/显示复用，永不 destroy） */
export function createPetWindow() {
  const size = { width: PET_WINDOW_SIZE, height: PET_WINDOW_SIZE };
  const workArea = screen.getPrimaryDisplay().workArea;
  const pos = fromRatio(settings.get('positionRatio'), size, workArea);

  petWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false, // 拖动自行实现；若 macOS 上 setPosition 失效，改为 true（见 SDD §11）
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false, // 宠物窗不需要键盘焦点（气泡窗才需要）
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 需要 require 共享的 channels.cjs，sandboxed preload 不支持，
      // 故关闭 sandbox。页面内容全部来自本地且 contextIsolation 开启。
      sandbox: false,
      backgroundThrottling: false, // 动画不被后台降频
    },
  });

  petWindow.setAlwaysOnTop(true, 'screen-saver');
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  petWindow.loadFile(path.join(__dirname, '../renderer/pet.html'));

  petWindow.once('ready-to-show', () => {
    petWindow?.showInactive(); // 不抢焦点
    log.info('petWindow.shown', { bounds: petWindow?.getBounds() });
  });

  petWindow.on('closed', () => {
    petWindow = null;
  });

  log.info('petWindow.created', { x: pos.x, y: pos.y, workArea });
  return petWindow;
}

/**
 * 让宠物跟随光标 —— 由主进程轮询，不依赖渲染进程事件。
 * @param {number} offsetX 按下时鼠标相对窗口左上角的偏移
 * @param {number} offsetY
 */
export function beginDrag(offsetX, offsetY) {
  if (!petWindow) return;
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return;

  endDrag(); // 幂等：重复 dragStart 不会泄漏定时器
  hideBubble(); // 拖动时直接隐藏气泡，松手不自动弹回（SDD §6.12）

  dragOffset = { x: offsetX, y: offsetY };
  log.debug('petWindow.dragStart', dragOffset);

  dragTimer = setInterval(() => {
    if (!petWindow || !dragOffset) return;
    const cursor = screen.getCursorScreenPoint();
    const workArea = workAreaOf({ width: petWindow.getBounds().width, height: petWindow.getBounds().height });
    const next = clampToWorkArea(
      {
        x: cursor.x - dragOffset.x,
        y: cursor.y - dragOffset.y,
        width: PET_WINDOW_SIZE,
        height: PET_WINDOW_SIZE,
      },
      workArea,
    );
    petWindow.setPosition(next.x, next.y);
  }, DRAG_POLL_MS);
}

/** 结束拖动：清理定时器并持久化位置比例 */
export function endDrag() {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  dragOffset = null;
  if (!petWindow) return;

  const bounds = petWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const ratio = toRatio(bounds, display.workArea);
  settings.set('positionRatio', ratio);
  log.debug('petWindow.dragEnd', { bounds, ratio });
}

/**
 * 切换点击穿透。
 * @param {boolean} ignore
 */
export function setIgnoreMouse(ignore) {
  if (!petWindow) return;
  petWindow.setIgnoreMouseEvents(ignore, { forward: true });
}

/** 把窗口移回它自己保存的位置（用于「显示宠物」菜单项） */
export function restorePosition() {
  if (!petWindow) return;
  const size = { width: PET_WINDOW_SIZE, height: PET_WINDOW_SIZE };
  const workArea = screen.getPrimaryDisplay().workArea;
  const pos = fromRatio(settings.get('positionRatio'), size, workArea);
  petWindow.setPosition(pos.x, pos.y);
}

/**
 * 供 smoke 自检使用：把窗口挪到一个位置并读回来，验证
 * `movable: false` 下 `setPosition` 是否真的生效。
 * @returns {{ moved: boolean, before: Rect, after: Rect }}
 */
export function probeSetPosition() {
  if (!petWindow) throw new Error('petWindow 不存在');
  const before = petWindow.getBounds();
  const target = clampToWorkArea(
    { x: before.x + 20, y: before.y + 20, width: before.width, height: before.height },
    screen.getDisplayMatching(before).workArea,
  );
  petWindow.setPosition(target.x, target.y);
  const after = petWindow.getBounds();
  return { moved: after.x === target.x && after.y === target.y, before, after };
}

// ── 气泡窗（SDD v0.1 §6.12）─────────────────────────────────────────

/**
 * 创建气泡窗。**只创建一次**，之后靠 show/hide 复用（防泄漏第 1 条）。
 *
 * 关键：`focusable: true`（宠物窗是 false）。键盘输入必须落在这个窗口上。
 * ⚠️ 应用处于 accessory 模式（Dock 已隐藏），这个窗口能否拿到键盘焦点
 *    是 M2 的第一个必做实测项（评审 D-3 / SDD §11）。
 */
export function createBubbleWindow() {
  bubbleWindow = new BrowserWindow({
    width: BUBBLE_WIDTH,
    height: BUBBLE_HEIGHT,
    transparent: true, // 配合 CSS border-radius 做圆角
    frame: false,
    hasShadow: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true, // ★ 与宠物窗相反
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  bubbleWindow.loadFile(path.join(__dirname, '../renderer/bubble.html'));

  bubbleWindow.on('closed', () => {
    bubbleWindow = null;
  });

  log.info('bubbleWindow.created', { width: BUBBLE_WIDTH, height: BUBBLE_HEIGHT });
  return bubbleWindow;
}

/**
 * 计算并设置气泡窗位置：默认在宠物上方居中，空间不够就翻到下方，贴边则 clamp。
 * 定位完全由主进程负责，渲染进程不掺和。
 */
export function placeBubble() {
  if (!petWindow || !bubbleWindow) return;

  const pet = petWindow.getBounds();
  const wa = screen.getDisplayMatching(pet).workArea; // v0 只处理单显示器

  let x = pet.x + pet.width / 2 - BUBBLE_WIDTH / 2;
  let y = pet.y - BUBBLE_HEIGHT - BUBBLE_GAP; // 默认：宠物上方

  if (y < wa.y) {
    y = pet.y + pet.height + BUBBLE_GAP; // 上方放不下 → 翻到下方
  }

  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - BUBBLE_WIDTH);
  y = Math.min(Math.max(y, wa.y), wa.y + wa.height - BUBBLE_HEIGHT);

  bubbleWindow.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: BUBBLE_WIDTH,
    height: BUBBLE_HEIGHT,
  });
}

/** 显示气泡并把键盘焦点交给它 */
export function showBubble() {
  if (!bubbleWindow) return null;
  placeBubble();
  // accessory 模式下应用不在前台，窗口默认拿不到 key window；
  // 显式抢一次焦点（这正是要实测的那件事）。
  if (process.platform === 'darwin') app.focus({ steal: true });
  bubbleWindow.show();
  bubbleWindow.focus();
  return bubbleWindow;
}

/** 隐藏气泡（不销毁） */
export function hideBubble() {
  if (!bubbleWindow) return;
  if (bubbleWindow.isVisible()) {
    bubbleWindow.hide();
    log.debug('bubbleWindow.hidden');
  }
}

/** @returns {boolean} */
export function isBubbleVisible() {
  return !!bubbleWindow?.isVisible();
}

/** 切换气泡显隐；返回切换后的状态 */
export function toggleBubble() {
  if (isBubbleVisible()) {
    hideBubble();
    return false;
  }
  showBubble();
  return true;
}
