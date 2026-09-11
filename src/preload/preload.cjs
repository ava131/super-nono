/**
 * preload —— 渲染进程与主进程之间**唯一**的桥。
 *
 * 设计要点（SDD v0.1 §6.5）：
 *   - 只暴露语义化方法（`api.click()`），**不暴露 `ipcRenderer` 本体**；
 *   - 渲染进程因此不需要知道任何频道名，频道只在 channels.cjs 里出现一次；
 *   - 每次 send/subscribe/invoke 都先过白名单，防止渲染进程被注入后乱发消息；
 *   - 这是 `.cjs`：Electron 的 sandboxed preload 不支持 ESM。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const {
  CH,
  SEND_CHANNELS,
  RECEIVE_CHANNELS,
  INVOKE_CHANNELS,
} = require('../shared/channels.cjs');

const SENDABLE = new Set(SEND_CHANNELS);
const RECEIVABLE = new Set(RECEIVE_CHANNELS);
const INVOKABLE = new Set(INVOKE_CHANNELS);

/**
 * @param {Set<string>} allow
 * @param {string} channel
 */
function assertAllowed(allow, channel) {
  if (!allow.has(channel)) {
    throw new Error(`preload: 频道不在白名单内 -> ${channel}`);
  }
}

/**
 * @param {string} channel
 * @param {unknown[]} args
 */
function send(channel, ...args) {
  assertAllowed(SENDABLE, channel);
  ipcRenderer.send(channel, ...args);
}

/**
 * @param {string} channel
 * @param {unknown} payload
 * @returns {Promise<unknown>}
 */
function invoke(channel, payload) {
  assertAllowed(INVOKABLE, channel);
  return ipcRenderer.invoke(channel, payload);
}

/**
 * @template T
 * @param {string} channel
 * @param {(payload: any) => T} handler
 * @returns {() => void} 取消订阅
 */
function subscribe(channel, handler) {
  assertAllowed(RECEIVABLE, channel);
  /** @type {(event: unknown, payload: any) => void} */
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/**
 * 暴露给渲染进程的 API 契约（与 types/global.d.ts 里的 NonoApi 保持一致）。
 * 先声明 typedef，下面的对象字面量就能被推断出参数类型。
 *
 * @typedef {object} NonoApi
 * @property {() => void} ready
 * @property {() => void} click
 * @property {(offsetX: number, offsetY: number) => void} dragStart
 * @property {() => void} dragEnd
 * @property {(ignore: boolean) => void} setIgnoreMouse
 * @property {(open: boolean) => void} toggleBubble
 * @property {(state: string) => void} stateChanged
 * @property {() => void} cancel
 * @property {(text: string) => void} sendMessage
 * @property {(requestId: string, approved: boolean) => void} confirmResponse
 * @property {(keys: string[]) => Promise<unknown>} settingsGet
 * @property {(key: string, value: unknown) => Promise<unknown>} settingsSet
 * @property {(limit?: number) => Promise<unknown>} historyRecent
 * @property {() => Promise<unknown>} sessionList
 * @property {() => Promise<unknown>} sessionNew
 * @property {(id: string) => Promise<unknown>} sessionSwitch
 * @property {(id: string) => Promise<unknown>} sessionDelete
 * @property {(id: string, title: string) => Promise<unknown>} sessionRename
 * @property {(fn: (payload: any) => void) => () => void} onState
 * @property {(fn: (payload: any) => void) => () => void} onDelta
 * @property {(fn: (payload: any) => void) => () => void} onMessage
 * @property {(fn: (payload: any) => void) => () => void} onNotice
 * @property {(fn: (payload: any) => void) => () => void} onError
 * @property {(fn: (payload: any) => void) => () => void} onConfirmRequest
 * @property {(fn: (payload: any) => void) => () => void} onMetrics
 */

/** @type {NonoApi} */
const api = {
  // ── 发往主进程 ────────────────────────────────────────────────
  ready: () => send(CH.PET_READY),
  click: () => send(CH.PET_CLICK),
  dragStart: (offsetX, offsetY) => send(CH.PET_DRAG_START, { offsetX, offsetY }),
  dragEnd: () => send(CH.PET_DRAG_END),
  setIgnoreMouse: (ignore) => send(CH.PET_SET_IGNORE_MOUSE, { ignore: !!ignore }),
  toggleBubble: (open) => send(CH.PET_TOGGLE_BUBBLE, { open: !!open }),
  stateChanged: (state) => send(CH.PET_STATE_CHANGED, { state: String(state) }),
  cancel: () => send(CH.PET_CANCEL),
  sendMessage: (text) => send(CH.PET_USER_MESSAGE, { text: String(text) }),
  confirmResponse: (requestId, approved) =>
    send(CH.PET_CONFIRM_RESPONSE, { requestId, approved: !!approved }),

  // ── invoke ───────────────────────────────────────────────────
  settingsGet: (keys) => invoke(CH.SETTINGS_GET, { keys }),
  settingsSet: (key, value) => invoke(CH.SETTINGS_SET, { key, value }),
  historyRecent: (limit) => invoke(CH.HISTORY_RECENT, { limit }),
  sessionList: () => invoke(CH.SESSION_LIST, {}),
  sessionNew: () => invoke(CH.SESSION_NEW, {}),
  sessionSwitch: (id) => invoke(CH.SESSION_SWITCH, { id }),
  sessionDelete: (id) => invoke(CH.SESSION_DELETE, { id }),
  sessionRename: (id, title) => invoke(CH.SESSION_RENAME, { id, title }),

  // ── 订阅主进程 ────────────────────────────────────────────────
  onState: (fn) => subscribe(CH.BRAIN_STATE, fn),
  onDelta: (fn) => subscribe(CH.BRAIN_DELTA, fn),
  onMessage: (fn) => subscribe(CH.BRAIN_MESSAGE, fn),
  onNotice: (fn) => subscribe(CH.BRAIN_NOTICE, fn),
  onError: (fn) => subscribe(CH.BRAIN_ERROR, fn),
  onConfirmRequest: (fn) => subscribe(CH.BRAIN_CONFIRM_REQUEST, fn),
  onMetrics: (fn) => subscribe(CH.DEBUG_METRICS, fn),
};

contextBridge.exposeInMainWorld('api', api);
