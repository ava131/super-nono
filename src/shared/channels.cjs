/**
 * IPC 频道常量 —— 主进程与 preload 的唯一真相来源。
 *
 * 为什么这个文件是 `.cjs`（而不是 `.js`）：
 *   - preload 要 `require` 它，而 Electron 的 sandboxed preload 不支持 ESM；
 *   - 主进程是 ESM，但 ESM 可以 `import` 一个 CommonJS 模块（默认导入）。
 *   放在 `.cjs` 里，两端才能共用同一份常量，而不必手抄字符串。
 *
 * 渲染进程不直接使用本文件：它只调用 preload 通过 contextBridge 暴露的
 * 语义化方法（`window.api.*`），因此不需要知道任何频道名。
 */
'use strict';

/**
 * @typedef {object} Channels
 * @property {string} PET_READY
 * @property {string} PET_CLICK
 * @property {string} PET_DRAG_START
 * @property {string} PET_DRAG_END
 * @property {string} PET_SET_IGNORE_MOUSE
 * @property {string} PET_TOGGLE_BUBBLE
 * @property {string} PET_STATE_CHANGED
 * @property {string} PET_CANCEL
 * @property {string} PET_USER_MESSAGE
 * @property {string} PET_CONFIRM_RESPONSE
 * @property {string} BRAIN_STATE
 * @property {string} BRAIN_DELTA
 * @property {string} BRAIN_MESSAGE
 * @property {string} BRAIN_NOTICE
 * @property {string} BRAIN_ERROR
 * @property {string} BRAIN_CONFIRM_REQUEST
 * @property {string} DEBUG_METRICS
 * @property {string} SETTINGS_GET
 * @property {string} SETTINGS_SET
 * @property {string} HISTORY_RECENT
 * @property {string} SESSION_LIST
 * @property {string} SESSION_NEW
 * @property {string} SESSION_SWITCH
 * @property {string} SESSION_DELETE
 * @property {string} SESSION_RENAME
 */

/** @type {Readonly<Channels>} */
const CH = Object.freeze({
  // ── 渲染进程 → 主进程 ──────────────────────────────────────────
  PET_READY: 'pet:ready',
  PET_CLICK: 'pet:click',
  PET_DRAG_START: 'pet:dragStart',
  PET_DRAG_END: 'pet:dragEnd',
  PET_SET_IGNORE_MOUSE: 'pet:setIgnoreMouse',
  PET_TOGGLE_BUBBLE: 'pet:toggleBubble',
  PET_STATE_CHANGED: 'pet:stateChanged',
  PET_CANCEL: 'pet:cancel',
  PET_USER_MESSAGE: 'pet:userMessage',
  PET_CONFIRM_RESPONSE: 'pet:confirmResponse',

  // ── 主进程 → 渲染进程 ──────────────────────────────────────────
  BRAIN_STATE: 'brain:state',
  BRAIN_DELTA: 'brain:delta',
  BRAIN_MESSAGE: 'brain:message',
  BRAIN_NOTICE: 'brain:notice',
  BRAIN_ERROR: 'brain:error',
  BRAIN_CONFIRM_REQUEST: 'brain:confirmRequest',
  DEBUG_METRICS: 'debug:metrics',

  // ── invoke（请求/响应）─────────────────────────────────────────
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  HISTORY_RECENT: 'history:recent',
  SESSION_LIST: 'session:list',
  SESSION_NEW: 'session:new',
  SESSION_SWITCH: 'session:switch',
  SESSION_DELETE: 'session:delete',
  SESSION_RENAME: 'session:rename',
});

/**
 * 三张通路白名单。放在这里（而不是 preload 里）有两个原因：
 *   1. 它们是"契约"的一部分，应该和频道名待在一起；
 *   2. preload 的 `require('electron')` 在纯 Node 环境里会尝试下载 Electron
 *      二进制，测试只 import 本文件就能校验契约，完全不用碰 electron。
 */
const SEND_CHANNELS = Object.freeze([
  CH.PET_READY,
  CH.PET_CLICK,
  CH.PET_DRAG_START,
  CH.PET_DRAG_END,
  CH.PET_SET_IGNORE_MOUSE,
  CH.PET_TOGGLE_BUBBLE,
  CH.PET_STATE_CHANGED,
  CH.PET_CANCEL,
  CH.PET_USER_MESSAGE,
  CH.PET_CONFIRM_RESPONSE,
]);

const RECEIVE_CHANNELS = Object.freeze([
  CH.BRAIN_STATE,
  CH.BRAIN_DELTA,
  CH.BRAIN_MESSAGE,
  CH.BRAIN_NOTICE,
  CH.BRAIN_ERROR,
  CH.BRAIN_CONFIRM_REQUEST,
  CH.DEBUG_METRICS,
]);

const INVOKE_CHANNELS = Object.freeze([
  CH.SETTINGS_GET,
  CH.SETTINGS_SET,
  CH.HISTORY_RECENT,
  CH.SESSION_LIST,
  CH.SESSION_NEW,
  CH.SESSION_SWITCH,
  CH.SESSION_DELETE,
  CH.SESSION_RENAME,
]);

module.exports = { CH, SEND_CHANNELS, RECEIVE_CHANNELS, INVOKE_CHANNELS };
