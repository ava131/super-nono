/**
 * IPC 契约的唯一注册处。
 *
 * 频道名来自 `src/shared/channels.cjs`（与 preload 共用同一份）。
 * **渲染进程传来的数据一律视为不可信**，这里再校验一次。
 */
import { ipcMain } from 'electron';
import channels from '../shared/channels.cjs';
import log from './log.js';
import * as agent from './brain/agent.js';
import { AppError, defaultMessage, normalize } from './brain/errors.js';
import * as memory from './brain/memory.js';
import { openHint } from './brain/status.js';
import * as usage from './brain/usage.js';
import * as registry from './skills/registry.js';
import * as runner from './skills/runner.js';
import { readNamespaceValue, writeNamespaceValue } from './skills/store.js';
import * as settings from './store/settings.js';
import { getBubbleWindow } from './window.js';
import * as pet from './window.js';

const { CH } = channels;

/** 本次运行里是否已经给过开场提示（避免每次打开气泡都念一遍） */
let hintedThisRun = false;

/**
 * @param {unknown} payload
 * @returns {Record<string, unknown>}
 */
function asObject(payload) {
  return payload && typeof payload === 'object' ? /** @type {Record<string, unknown>} */ (payload) : {};
}

/**
 * 把 agent 的事件映射到 IPC 频道。
 * 所有 `brain:*` 事件都带 turnId —— 用户点停止后立刻再发一条时，
 * 上一轮还在飞的 delta 会被渲染端按 turnId 丢掉（评审 §3.3 ④）。
 *
 * @param {agent.AgentEvent} event
 */
function emitToRenderer(event) {
  const win = getBubbleWindow();
  if (!win || win.isDestroyed()) return;

  switch (event.type) {
    case 'state':
      win.webContents.send(CH.BRAIN_STATE, { turnId: event.turnId, state: event.state });
      break;
    case 'delta':
      win.webContents.send(CH.BRAIN_DELTA, { turnId: event.turnId, text: event.text });
      break;
    case 'message':
      win.webContents.send(CH.BRAIN_MESSAGE, {
        turnId: event.turnId,
        role: event.role,
        text: event.text,
        done: event.done,
      });
      break;
    case 'notice':
      win.webContents.send(CH.BRAIN_NOTICE, { turnId: event.turnId, text: event.text });
      break;
    case 'error':
      win.webContents.send(CH.BRAIN_ERROR, {
        turnId: event.turnId,
        code: event.code,
        message: event.message,
      });
      break;
  }
}

/**
 * L2 确认：主进程 → 渲染进程 → 等用户点。
 *
 * 没有确认通道时 runner 会**直接拒绝执行**（宁可拒绝也不放行），
 * 所以这里即使超时也只是"没批准"，不会造成越权。
 *
 * @param {{ skill: string, args: Record<string, unknown>, level: string }} req
 * @returns {Promise<boolean>}
 */
function requestConfirmation(req) {
  const win = getBubbleWindow();
  if (!win || win.isDestroyed()) return Promise.resolve(false);

  const requestId = `cf${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  log.info('ipc.confirm.request', { requestId, skill: req.skill, level: req.level });

  return new Promise((resolve) => {
    /** @type {NodeJS.Timeout | null} */
    let timer = null;

    /** @param {import('electron').IpcMainEvent} event @param {unknown} payload */
    const onResponse = (event, payload) => {
      const p = asObject(payload);
      if (p.requestId !== requestId) return; // 不是这一单，别理
      cleanup();
      resolve(p.approved === true);
    };

    function cleanup() {
      if (timer) clearTimeout(timer);
      ipcMain.removeListener(CH.PET_CONFIRM_RESPONSE, onResponse);
    }

    ipcMain.on(CH.PET_CONFIRM_RESPONSE, onResponse);
    // runner 那边也有超时兜底，这里再设一个，避免监听器泄漏
    timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, runner.CONFIRM_TIMEOUT_MS);
    timer.unref?.();

    win.webContents.send(CH.BRAIN_CONFIRM_REQUEST, {
      requestId,
      skill: req.skill,
      level: req.level,
      args: req.args,
    });
  });
}

/**
 * @param {string} text
 */
async function handleUserMessage(text) {
  try {
    await agent.runTurn({
      text,
      emit: emitToRenderer,
      config: {
        apiKey: /** @type {string} */ (settings.getApiKey() ?? ''),
        model: settings.get('model'),
        dailyCostLimit: settings.get('dailyCostLimit'),
        overBudget: usage.isOverBudget(settings.get('dailyCostLimit')),
      },
      tools: {
        skills: registry.describeAll(),
        skillConstraints: () => registry.describeConstraints(registry.describeAll()),
        toolSpecs: registry.toolSpecs,
        runTool: (name, args, ctx) => runner.run(name, args, ctx),
      },
      requestConfirmation,
    });
  } catch (err) {
    // agent.runTurn 自己会把错误 emit 出去（带正确的 turnId）；
    // 这里是最后一道保险，防止它连 emit 都没走到就炸了。
    const appErr = err instanceof AppError ? err : normalize(err);
    log.error('agent.turn.crashed', { code: appErr.code, message: appErr.message });
    emitToRenderer({
      type: 'error',
      turnId: 'crash',
      code: appErr.code,
      message: appErr.message || defaultMessage(appErr.code),
    });
  }
}

export function registerIpc() {
  // ── 宠物窗 ──────────────────────────────────────────────────────
  ipcMain.on(CH.PET_READY, () => {
    log.info('ipc.pet.ready');
  });

  // 点击宠物 → 切换气泡窗显隐。判断权在主进程，避免两边状态不一致。
  ipcMain.on(CH.PET_CLICK, () => {
    const visible = pet.toggleBubble();
    log.info('ipc.pet.click', { bubbleVisible: visible });
    if (!visible) return;

    // 打开气泡时最多提示**一次**。
    // 提示语由 openHint() 从真实状态推导，不在代码里写死"当前有什么能力"
    // —— 之前那句"还没接技能"在技能接上之后变成了假话（用户实测发现）。
    const text = openHint({
      hasApiKey: settings.hasApiKey(),
      failedSkillCount: registry.errors().length,
      alreadyHinted: hintedThisRun,
    });
    if (text === null) return;

    hintedThisRun = true;
    getBubbleWindow()?.webContents.send(CH.BRAIN_NOTICE, { turnId: 'boot', text });
  });

  ipcMain.on(CH.PET_TOGGLE_BUBBLE, (_event, payload) => {
    const { open } = asObject(payload);
    if (open === false) pet.hideBubble();
    else pet.showBubble();
  });

  ipcMain.on(CH.PET_DRAG_START, (_event, payload) => {
    const { offsetX, offsetY } = asObject(payload);
    if (typeof offsetX !== 'number' || typeof offsetY !== 'number') {
      log.warn('ipc.pet.dragStart.badPayload', { payload });
      return;
    }
    pet.beginDrag(offsetX, offsetY);
  });

  ipcMain.on(CH.PET_DRAG_END, () => pet.endDrag());
  ipcMain.on(CH.PET_SET_IGNORE_MOUSE, (_event, payload) => pet.setIgnoreMouse(asObject(payload).ignore === true));
  ipcMain.on(CH.PET_STATE_CHANGED, (_event, payload) => log.debug('ipc.pet.stateChanged', asObject(payload)));

  // ── 对话 ────────────────────────────────────────────────────────
  ipcMain.on(CH.PET_USER_MESSAGE, (_event, payload) => {
    const { text } = asObject(payload);
    if (typeof text !== 'string' || text.trim() === '') {
      log.warn('ipc.pet.userMessage.badPayload', { payload });
      return;
    }
    log.info('ipc.pet.userMessage', { chars: text.length });
    void handleUserMessage(text.trim());
  });

  ipcMain.on(CH.PET_CANCEL, () => {
    const cancelled = agent.cancelCurrentTurn();
    log.info('ipc.pet.cancel', { cancelled });
  });

  // ── 设置（invoke）───────────────────────────────────────────────
  ipcMain.handle(CH.SETTINGS_GET, () => {
    const summary = settings.publicSummary();
    const totals = usage.todayTotals();
    return {
      ...summary,
      today: totals,
      // 技能自检：加载了哪些、权限并集、出网域名并集（可审计，PRD-Skill §7）
      skills: {
        loaded: registry.describeAll(),
        permissions: registry.allPermissions(),
        hosts: registry.allHosts(),
        errors: registry.errors(),
      },
    };
  });

  ipcMain.handle(CH.SETTINGS_SET, (_event, payload) => {
    const { key, value } = asObject(payload);
    switch (key) {
      case 'apiKey':
        settings.setApiKey(String(value ?? ''));
        return { ok: true, hasApiKey: settings.hasApiKey() };
      case 'model':
        settings.set('model', String(value ?? 'deepseek-chat'));
        return { ok: true };
      case 'dailyCostLimit': {
        const n = Number(value);
        settings.set('dailyCostLimit', Number.isFinite(n) && n >= 0 ? n : 10);
        return { ok: true };
      }
      case 'offlineMode':
        settings.set('offlineMode', value === true);
        return { ok: true };
      case 'launchAtLogin':
        settings.set('launchAtLogin', value === true);
        return { ok: true };
      default:
        log.warn('ipc.settings.set.unknownKey', { key });
        return { ok: false, error: `未知设置项：${String(key)}` };
    }
  });

  // 关闭再打开后，把历史渲染回气泡里 —— 否则消息虽然存着，
  // 用户看到的却是一片空白，只能靠"它还记得"来推断。
  ipcMain.handle(CH.HISTORY_RECENT, (_event, payload) => {
    const { limit } = asObject(payload);
    const n = typeof limit === 'number' && limit > 0 && limit <= 200 ? limit : 50;
    return { sessionId: memory.getCurrentSessionId(), messages: memory.recentMessages(n) };
  });

  // ── 多会话 ──────────────────────────────────────────────────────
  ipcMain.handle(CH.SESSION_LIST, () => ({
    currentId: memory.getCurrentSessionId(),
    sessions: memory.listSessions(),
  }));

  ipcMain.handle(CH.SESSION_NEW, () => {
    const id = memory.createSession();
    return { ok: true, sessionId: id, messages: [] };
  });

  ipcMain.handle(CH.SESSION_SWITCH, (_event, payload) => {
    const { id } = asObject(payload);
    if (typeof id !== 'string' || !memory.switchSession(id)) {
      return { ok: false, error: '会话不存在' };
    }
    return { ok: true, sessionId: id, messages: memory.recentMessages(50) };
  });

  // 删除会话：边界由 memory.deleteSession 兜住
  // （删当前会话 → 自动切到最近的；一个不剩 → 自动新建）
  ipcMain.handle(CH.SESSION_DELETE, (_event, payload) => {
    const { id } = asObject(payload);
    if (typeof id !== 'string') return { ok: false, error: '缺少会话 id' };

    const result = memory.deleteSession(id);
    if (!result.ok) return { ok: false, error: '这个对话已经不在了' };

    return {
      ...result,
      sessions: memory.listSessions(),
      messages: memory.recentMessages(50),
    };
  });

  ipcMain.handle(CH.SESSION_RENAME, (_event, payload) => {
    const { id, title } = asObject(payload);
    if (typeof id !== 'string' || typeof title !== 'string') {
      return { ok: false, error: '参数不对' };
    }
    const ok = memory.renameSession(id, title);
    return { ok, sessions: memory.listSessions(), error: ok ? undefined : '标题不能为空' };
  });

  // ── 自选股名单（PRD-market §8）────────────────────────────────────
  //
  // ⚠️ **零出网**：只读本地 `skill_kv`，不碰任何行情接口。
  // 所以数据源全挂、或用户开着飞行模式时，**自选名单照样能用**（MK18）。
  //
  // 这也是"结果可见 + 每行可删"这条安全网的落点 ——
  // 因为加自选是 L1.5（不弹确认框），用户只能靠**事后**看到并纠正（评审决定 3）。

  /**
   * 读自选股名单，只保留渲染进程需要的三个字段。
   *
   * 坏数据一律过滤掉 —— 库里可能有旧版本写下的畸形条目（或被人手改过），
   * 不该让它们进到界面。
   *
   * @returns {{ symbol: string, code: string, name: string }[]}
   */
  const readWatchlist = () => {
    const raw = readNamespaceValue('watchlist', 'items');
    if (!Array.isArray(raw)) return [];
    /** @type {{ symbol: string, code: string, name: string }[]} */
    const out = [];
    for (const e of /** @type {any[]} */ (raw)) {
      if (e && typeof e.symbol === 'string' && typeof e.code === 'string' && typeof e.name === 'string') {
        out.push({ symbol: e.symbol, code: e.code, name: e.name });
      }
    }
    return out;
  };

  ipcMain.handle(CH.WATCHLIST_LIST, () => ({ ok: true, items: readWatchlist() }));

  /**
   * 从名单里删一支 —— **由用户点按钮触发**，不是模型调用。
   *
   * 直接删 `skill_kv` 而不是绕 `runner.run('watchlist', {action:'remove'})`：
   * 这是**用户界面动作**，不该受模型工具链的超时/确认/归一化影响。
   * 风险也低 —— 它只是删一行，而且用户刚在界面上看着它。
   */
  ipcMain.handle(CH.WATCHLIST_REMOVE, (_event, payload) => {
    const { symbol } = asObject(payload);
    if (typeof symbol !== 'string' || symbol === '') {
      return { ok: false, error: '缺少股票代码' };
    }
    const items = readWatchlist();
    const next = items.filter((e) => e.symbol !== symbol);
    if (next.length === items.length) {
      return { ok: false, error: '这一支已经不在自选里了' };
    }
    try {
      // 这里是**主进程代用户操作**，用底层写入原语，并在日志里留痕便于审计
      // （为什么不让技能去删：见 store.js 的 writeNamespaceValue 说明）
      writeNamespaceValue('watchlist', 'items', next);
      log.info('watchlist.removed', { symbol, left: next.length });
      return { ok: true, items: next };
    } catch (err) {
      log.warn('watchlist.removeFailed', { symbol, message: String(err) });
      return { ok: false, error: '删除失败，过会儿再试' };
    }
  });

  log.info('ipc.registered');
}
