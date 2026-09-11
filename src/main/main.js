/**
 * 应用入口：生命周期、单实例锁、accessory 模式、托盘。
 *
 * 对应 PRD-Body v0.1 的 W-6。
 *
 * `--smoke` 参数会跑一遍自检然后退出（不需要人工肉眼验证），
 * 用来覆盖 SDD v0.1 §11 里那几条"必须实测、推演不管用"的事项。
 */
import { app, Menu, Tray, shell } from 'electron';
import path from 'node:path';
import { countMessages, ensureStartupSession, getCurrentSessionId } from './brain/memory.js';
import log, { initLog } from './log.js';
import { registerIpc } from './ipc.js';
import { initEgress, listHosts, setOfflineProbe } from './skills/egress.js';
import * as registry from './skills/registry.js';
import { closeDb, initDb } from './store/db.js';
import * as settings from './store/settings.js';
import { createTrayIcon } from './tray-icon.js';
import {
  createBubbleWindow,
  createPetWindow,
  getBubbleWindow,
  getPetWindow,
  hideBubble,
  probeSetPosition,
  restorePosition,
  setIgnoreMouse,
  showBubble,
} from './window.js';

const SMOKE = process.argv.includes('--smoke');

/** @type {Tray | null} */
let tray = null;

/** 单实例锁：重复启动只唤起已有实例 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getPetWindow();
    if (win) {
      restorePosition();
      win.showInactive();
    }
  });
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: '显示 / 隐藏宠物',
      click: () => {
        const win = getPetWindow();
        if (!win) return;
        if (win.isVisible()) win.hide();
        else win.showInactive();
      },
    },
    { type: 'separator' },
    { label: '设置…', enabled: false }, // M2 接入气泡窗后启用
    {
      label: '打开数据目录',
      click: () => {
        void shell.openPath(settings.getDataDir());
      },
    },
    { type: 'separator' },
    { label: '退出 Super Nono', role: 'quit' },
  ]);
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Super Nono');
  tray.setContextMenu(buildTrayMenu());
  log.info('tray.created');
  return tray;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 实测气泡窗能否拿到键盘焦点。
 *
 * 分两步，因为 `isFocused()` 只说明 OS 层面的焦点状态，
 * 而真正要证明的是"用户敲的字能进到输入框"：
 *   ① isFocused() —— 窗口是不是 key window
 *   ② 往输入框注入字符，读回它的 value —— 端到端的键盘链路
 *
 * @returns {Promise<{ focused: boolean, typed: string, expected: string }>}
 */
async function probeBubbleFocus() {
  const expected = 'nono';
  const win = getBubbleWindow();
  if (!win) return { focused: false, typed: '', expected };

  showBubble();
  await delay(600); // 等窗口真正成为 key window

  const focused = win.isFocused();

  try {
    await win.webContents.executeJavaScript(
      `(() => { const el = document.getElementById('input'); el.focus(); el.value = ''; return document.activeElement === el; })()`,
    );
    for (const ch of expected) {
      win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
    }
    await delay(300);
    const typed = /** @type {string} */ (
      await win.webContents.executeJavaScript(`document.getElementById('input').value`)
    );
    return { focused, typed, expected };
  } catch (err) {
    log.warn('smoke.bubbleProbe.failed', { message: String(err) });
    return { focused, typed: `«${String(err)}»`, expected };
  }
}

/**
 * 自检：把"推演不管用、必须实测"的事项跑一遍。
 * 结果打印成一行行 PASS/FAIL，便于用眼睛或脚本判断。
 */
async function runSmoke() {
  /** @type {{ name: string, ok: boolean, detail?: unknown }[]} */
  const results = [];
  /**
   * @param {string} name
   * @param {boolean} ok
   * @param {unknown} [detail]
   */
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
  };

  const win = getPetWindow();
  check('petWindow 已创建', !!win);

  if (win) {
    check('petWindow 可见', win.isVisible());
    check('petWindow 尺寸 160×160', win.getBounds().width === 160 && win.getBounds().height === 160, win.getBounds());
    check('petWindow 置顶', win.isAlwaysOnTop());
    check('petWindow 不抢焦点 (focusable=false)', !win.isFocusable());

    // ★ SDD §11「必做实测」：movable:false 下 setPosition 是否生效
    const probe = probeSetPosition();
    check('movable:false 下 setPosition 生效', probe.moved, probe);

    // ★ 穿透接口不应抛错
    let ignoreOk = true;
    try {
      setIgnoreMouse(true);
      setIgnoreMouse(false);
    } catch (err) {
      ignoreOk = false;
      check('setIgnoreMouseEvents 可用', false, String(err));
    }
    if (ignoreOk) check('setIgnoreMouseEvents 可用', true);
  }

  check('托盘已创建', !!tray);
  check('accessory 模式（Dock 已隐藏）', process.platform !== 'darwin' || !app.dock?.isVisible());

  // ★★ M2 最大的风险项（评审 D-3 / SDD §11）：
  //    accessory 模式下气泡窗能不能成为 key window 拿到键盘焦点？
  //    拿不到就打不了字，方案 B 就得重来。推演不管用，只能实测。
  const bubble = await probeBubbleFocus();
  check('气泡窗已创建', !!getBubbleWindow());
  check('气泡窗能拿到键盘焦点', bubble.focused, { focused: bubble.focused });
  check('气泡窗能收到键盘输入', bubble.typed === bubble.expected, {
    expected: bubble.expected,
    typed: bubble.typed,
  });
  hideBubble();

  const mem = process.memoryUsage();
  check('主进程 RSS 可读', mem.rss > 0, { rssMB: Math.round(mem.rss / 1024 / 1024) });

  const failed = results.filter((r) => !r.ok);
  console.log('\n──── Super Nono smoke ────');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  ${JSON.stringify(r.detail)}` : ''}`);
  }
  console.log(`──────────────────────────\n${results.length - failed.length}/${results.length} 通过\n`);

  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(() => {
  // accessory：不占 Dock、不出现在 ⌘Tab（PRD-Body v0.1 §W-1）
  if (process.platform === 'darwin') {
    app.setActivationPolicy?.('accessory');
    app.dock?.hide();
  }

  // 存储层与日志层的路径由这里注入（它们自己不 import electron，便于单测）
  const userData = app.getPath('userData');
  initLog(path.join(userData, 'logs'));
  initDb(path.join(userData, 'nono.db'));

  log.info('app.ready', {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    userData,
  });

  // 出网唯一出口：白名单 + 飞行模式（v0 出口只有 DeepSeek 一个）
  initEgress();
  setOfflineProbe(() => settings.get('offlineMode') === true);
  log.info('egress.ready', { hosts: listHosts(), offline: settings.get('offlineMode') });

  // 启动时就把数据库建好（跑一遍 schema）。
  // 好处：万一 node:sqlite 在这个环境不可用，问题在启动阶段就暴露，
  // 而不是等用户发第一条消息时才炸。
  try {
    // 会话策略：每次启动开一个新会话；若最近那个还是空的就复用它。
    const sessionId = ensureStartupSession();
    log.info('db.ready', { sessionId, messages: countMessages(), current: getCurrentSessionId() });
  } catch (err) {
    log.error('db.init.failed', { message: String(err) });
  }

  registerIpc();
  createPetWindow();
  const bubble = createBubbleWindow();
  createTray();

  // 加载技能：必须在 initEgress 之后（先有 DeepSeek 白名单，再由技能追加）
  const skillsDir = path.join(app.getAppPath(), 'skills');
  void registry.loadSkills(skillsDir).then(({ loaded, failed }) => {
    log.info('app.skillsReady', {
      dir: skillsDir,
      loaded,
      failed: failed.map((f) => f.name),
      hosts: listHosts(),
    });
  });

  // 点击气泡外部 → 收起。accessory 模式下窗口失焦是个可靠信号。
  // smoke 期间跳过，否则会打断焦点探针。
  if (!SMOKE) {
    bubble?.on('blur', () => {
      hideBubble();
    });
  }

  if (SMOKE) {
    // 给窗口一点时间完成 ready-to-show
    setTimeout(() => {
      void runSmoke();
    }, 1200);
  }
});

app.on('window-all-closed', () => {
  // 托盘常驻应用：关闭窗口不退出（实际上宠物窗永不关闭）
});

app.on('before-quit', () => {
  log.info('app.before-quit');
  tray?.destroy();
  tray = null;
  closeDb();
});

app.on('activate', () => {
  const win = getPetWindow();
  if (win) win.showInactive();
  else createPetWindow();
});
