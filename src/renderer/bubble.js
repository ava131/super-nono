/**
 * 气泡窗的渲染进程。
 *
 * 职责：
 *   - 输入 / 发送 / 停止
 *   - **流式**渲染（按 turnId 丢弃串台事件）
 *   - 多会话：新建 / 历史列表 / 切换
 *   - 设置面板（API Key 只显示掩码，永不回填明文）
 *   - 清空当前对话的二次确认（W-7.3）
 *
 * 与宠物窗一样，这里**不认识任何 IPC 频道名**，只用 window.api。
 */

const api = window.api;

/** @param {string} id @returns {HTMLElement} */
function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`bubble.js: 找不到 #${id}`);
  return node;
}

const messagesEl = el('messages');
const inputEl = /** @type {HTMLTextAreaElement} */ (el('input'));
const sendEl = /** @type {HTMLButtonElement} */ (el('send'));
const stopEl = /** @type {HTMLButtonElement} */ (el('stop'));
const closeEl = /** @type {HTMLButtonElement} */ (el('close'));
const gearEl = /** @type {HTMLButtonElement} */ (el('gear'));
const historyBtn = /** @type {HTMLButtonElement} */ (el('history'));
const newSessionBtn = /** @type {HTMLButtonElement} */ (el('new-session'));
const titleEl = el('title');
const dotEl = el('dot');
const toastEl = el('toast');

const viewChat = el('view-chat');
const viewSettings = el('view-settings');
const viewHistory = el('view-history');
const viewWatchlist = el('view-watchlist');
const watchlistList = el('watchlist-list');
const watchlistBtn = /** @type {HTMLButtonElement} */ (el('watchlist-btn'));
const watchlistRefresh = /** @type {HTMLButtonElement} */ (el('watchlist-refresh'));

const setApiKey = /** @type {HTMLInputElement} */ (el('set-apikey'));
const setModel = /** @type {HTMLSelectElement} */ (el('set-model'));
const setLimit = /** @type {HTMLInputElement} */ (el('set-limit'));
const setOffline = /** @type {HTMLInputElement} */ (el('set-offline'));
const keyHint = el('key-hint');
const statToday = el('stat-today');
const saveSettings = /** @type {HTMLButtonElement} */ (el('save-settings'));

const crEl = el('confirm-request');
const crBody = el('cr-body');
const crAllow = /** @type {HTMLButtonElement} */ (el('cr-allow'));
const crDeny = /** @type {HTMLButtonElement} */ (el('cr-deny'));

const sessionListEl = el('session-list');
const historyNewBtn = /** @type {HTMLButtonElement} */ (el('history-new'));

const GREETING = '嗯，我在。';

// ── 浮层提示 ────────────────────────────────────────────────────────

/** @type {number | null} */
let toastTimer = null;

/**
 * 浮层提示。**必须浮在面板层**——之前把"设置已保存"追加进聊天消息列表，
 * 而那时聊天视图是隐藏的，用户什么都看不到（这是个真 bug）。
 *
 * @param {string} text
 * @param {'ok'|'warn'|'error'} [kind]
 */
function showToast(text, kind = 'ok') {
  toastEl.textContent = text;
  toastEl.className = `toast${kind === 'ok' ? '' : ` ${kind}`}`;
  toastEl.hidden = false;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
    toastTimer = null;
  }, 2600);
}

// ── 消息渲染 ────────────────────────────────────────────────────────

/** 当前正在流式接收的那一轮 */
let activeTurnId = /** @type {string | null} */ (null);
/** 用户刚发出消息、还没收到这一轮的第一个事件 */
let expectNewTurn = false;
/** @type {HTMLElement | null} */
let streamBubble = null;
let streamText = '';

/**
 * @param {'user'|'assistant'|'system'} role
 * @param {string} text
 * @returns {HTMLElement} 气泡元素
 */
function appendMessage(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
  return bubble;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/**
 * 渲染技能的结构化结果（评审 Q7）。
 *
 * ## 为什么这条路和 `appendMessage` 不一样
 *
 * `summary` 只有 800 字符（模型可见），而 `data.items` 是**全量**（最多 `DISPLAY_COUNT` 条）。
 * 所以气泡能列出模型**没叙述到**的那些条 —— 这是"模型说 5 条、气泡给 10 条"的落点。
 *
 * ## 两条硬纪律
 *
 * 1. **一律 `textContent`，绝不 `innerHTML`**（评审 Q7-2 / B6）。
 *    `it.title` 是**任何人可以改的 GitHub issue 标题**——用 `innerHTML` 就是
 *    把一个 XSS/注入面直接装进应用。文件里有断言测试盯着这一点。
 * 2. **外链走 `api.openExternal`，绝不 `<a href>`**（评审 Q7-1）。
 *    气泡是 `frame: false` 的 BrowserWindow，直接跳转会把整个界面导航走且回不来。
 *
 * @param {unknown} payload
 */
function renderSkillResult(payload) {
  const p = /** @type {{ turnId?: string, skill?: string, data?: any }} */ (payload ?? {});
  // 目前只有 github_issues 产出的 data 是"可点击列表"这个形状
  if (p.skill !== 'github_issues') return;

  const items = Array.isArray(p.data?.items) ? p.data.items : [];
  if (items.length === 0) return;

  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';

  const card = document.createElement('div');
  card.className = 'bubble skill-list';

  const total = Number.isFinite(p.data?.total) ? p.data.total : items.length;
  const head = document.createElement('div');
  head.className = 'skill-list-head';
  head.textContent =
    total > items.length
      ? `共 ${total} 条匹配，这里展示最新的 ${items.length} 条`
      : `共 ${items.length} 条`;
  card.appendChild(head);

  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'issue-row';

    const num = document.createElement('span');
    num.className = 'issue-num';
    num.textContent = `${it?.repo ?? ''}#${it?.number ?? '?'}`;
    row.appendChild(num);

    const title = document.createElement('span');
    title.className = 'issue-title';
    // ★ textContent：标题是外部不可信文本，绝不能当 HTML 解析
    title.textContent = String(it?.title ?? '');
    row.appendChild(title);

    const meta = document.createElement('span');
    meta.className = 'issue-meta';
    const comments = Number.isFinite(it?.comments) ? it.comments : 0;
    meta.textContent = `c:${comments}`;
    row.appendChild(meta);

    const url = typeof it?.url === 'string' ? it.url : '';
    // 只让**明确是 github.com 的 https 链接**可点（主进程还会再校验一次）
    if (/^https:\/\/github\.com\//.test(url)) {
      row.classList.add('clickable');
      row.title = url;
      row.addEventListener('click', () => {
        void window.api.openExternal(url);
      });
    }
    card.appendChild(row);
  }

  wrap.appendChild(card);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

function resetStreamState() {
  activeTurnId = null;
  expectNewTurn = false;
  streamBubble = null;
  streamText = '';
}

/** @param {boolean} on */
function setStreaming(on) {
  stopEl.hidden = !on;
  sendEl.hidden = on;
  dotEl.classList.toggle('busy', on);
}

/** @param {{ role: string, content: string }[]} list */
function renderMessages(list) {
  messagesEl.innerHTML = '';
  const shown = list.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (shown.length === 0) {
    appendMessage('assistant', GREETING);
    return;
  }
  for (const m of shown) appendMessage(m.role === 'user' ? 'user' : 'assistant', m.content);
}

/**
 * 判断这个事件属不属于"当前这一轮"。
 *
 * 规则（评审 §3.3 ④ 的串台问题）：
 *   - 还没绑定 turnId 时，只接受 `state: think`——因为 agent 每轮
 *     发出的第一个事件一定是它，这样就不会误收上一轮的尾巴。
 *   - 绑定之后，turnId 不一致的一律丢弃。
 *
 * @param {{ turnId?: string, state?: string }} payload
 * @returns {boolean}
 */
function acceptEvent(payload) {
  const turnId = payload.turnId ?? '';
  if (activeTurnId === null) {
    if (expectNewTurn && payload.state === 'think') {
      activeTurnId = turnId;
      expectNewTurn = false;
      return true;
    }
    return false;
  }
  return turnId === activeTurnId;
}

// ── 视图切换 ────────────────────────────────────────────────────────

/** @param {'chat'|'settings'|'history'|'watchlist'} which */
function showView(which) {
  viewChat.hidden = which !== 'chat';
  viewSettings.hidden = which !== 'settings';
  viewHistory.hidden = which !== 'history';
  viewWatchlist.hidden = which !== 'watchlist';
  gearEl.classList.toggle('active', which === 'settings');
  historyBtn.classList.toggle('active', which === 'history');
  watchlistBtn.classList.toggle('active', which === 'watchlist');

  if (which === 'settings') void loadSettings();
  if (which === 'watchlist') void renderWatchlist();
  else if (which === 'history') void renderSessions();
  else inputEl.focus();
}

// ── 发送 ────────────────────────────────────────────────────────────

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 96)}px`;
}

function send() {
  const text = inputEl.value.trim();
  if (!text) return;

  // 首条消息把问候语清掉，保持界面干净
  if (messagesEl.childElementCount === 1 && messagesEl.textContent === GREETING) {
    messagesEl.innerHTML = '';
  }
  appendMessage('user', text);
  inputEl.value = '';
  autoGrow();

  resetStreamState();
  expectNewTurn = true;
  setStreaming(true);

  api.sendMessage(text);
}

// ── 多会话 ──────────────────────────────────────────────────────────

/**
 * @typedef {{ id: string, title: string, updatedAt: number, messageCount: number, preview: string | null }} SessionRow
 */

/** 列表数据与两个"就地编辑"状态 */
/** @type {SessionRow[]} */
let sessionsCache = [];
let currentSessionId = '';
/** @type {string | null} 正在改名的会话 */
let editingId = null;
/** @type {string | null} 正在等删除确认的会话 */
let confirmingId = null;

/** @param {number} ts */
function formatWhen(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return sameDay ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
}

// ── 自选股名单（零出网）─────────────────────────────────────────────

/**
 * 渲染自选名单。
 *
 * ⚠️ **只显示代码 + 名称**，不请求任何行情数据：
 *   · 数据源挂掉 / 飞行模式下这个页面照样能用（MK18）
 *   · 符合 PRD §8 收窄后的范围
 *
 * @typedef {{ symbol: string, code: string, name: string }} WatchItem
 */
async function renderWatchlist() {
  const res = /** @type {{ ok?: boolean, items?: WatchItem[], error?: string }} */ (
    /** @type {unknown} */ (await api.watchlistList())
  );
  watchlistList.replaceChildren();

  const items = res.items ?? [];
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'footnote';
    empty.textContent = '还没有自选。在对话里说「把茅台加进自选」就行。';
    watchlistList.append(empty);
    return;
  }

  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'session-row';

    const main = document.createElement('div');
    main.className = 'session-main';
    const name = document.createElement('div');
    name.className = 'session-title';
    name.textContent = it.name;
    const code = document.createElement('div');
    code.className = 'session-sub';
    code.textContent = it.code;
    main.append(name, code);

    // 每行一个删除按钮 —— 这就是 L1.5「不弹确认框」的**事后纠正**手段
    const del = makeButton('🗑', 'icon', `从自选里删掉 ${it.name}`, () => {
      void removeFromWatchlist(it);
    });

    row.append(main, del);
    watchlistList.append(row);
  }
}

/**
 * 从自选里删一支，然后就地重绘。
 * @param {WatchItem} it
 */
async function removeFromWatchlist(it) {
  const res = /** @type {{ ok?: boolean, items?: WatchItem[], error?: string }} */ (
    /** @type {unknown} */ (await api.watchlistRemove(it.symbol))
  );
  if (res.ok === false) {
    showToast(res.error ?? '删除失败', 'error');
    return;
  }
  showToast(`已移除 ${it.name}`);
  await renderWatchlist();
}

async function renderSessions() {
  const res = /** @type {{ currentId?: string, sessions?: SessionRow[] }} */ (
    /** @type {unknown} */ (await api.sessionList())
  );
  sessionsCache = res.sessions ?? [];
  currentSessionId = res.currentId ?? '';
  editingId = null;
  confirmingId = null;
  paintSessions();
}

/**
 * 小工具：建一个按钮
 * @param {string} label
 * @param {string} className
 * @param {string} title
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function makeButton(label, className, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation(); // 别触发整行的"切换会话"
    onClick();
  });
  return b;
}

function paintSessions() {
  sessionListEl.innerHTML = '';

  if (sessionsCache.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = '还没有历史对话。';
    sessionListEl.appendChild(empty);
    return;
  }

  for (const s of sessionsCache) {
    if (s.id === confirmingId) {
      sessionListEl.appendChild(confirmRow(s));
    } else {
      sessionListEl.appendChild(sessionRow(s));
    }
  }
}

/**
 * 删除确认 —— 就地展开，报出**是哪一个对话**。
 * 「（世界名）」那个位置终于有东西可填了。
 * @param {SessionRow} s
 */
function confirmRow(s) {
  const row = document.createElement('div');
  row.className = 'session confirm-row';

  const q = document.createElement('div');
  q.className = 'confirm-q';
  q.textContent = '确定要删除这个对话吗？';

  const name = document.createElement('div');
  name.className = 'confirm-name';
  name.textContent = `「${s.title || '新对话'}」`;

  const warn = document.createElement('div');
  warn.className = 'confirm-sub';
  warn.textContent = '将会永久失去！（真的很久！）';

  const actions = document.createElement('div');
  actions.className = 'confirm-actions';
  actions.append(
    makeButton('算了', 'btn ghost small', '取消删除', () => {
      confirmingId = null;
      paintSessions();
    }),
    makeButton('删掉吧', 'btn danger small', '确认删除', () => void doDeleteSession(s.id, s.title)),
  );

  row.append(q, name, warn, actions);
  return row;
}

/** @param {SessionRow} s */
function sessionRow(s) {
  const row = document.createElement('div');
  row.className = `session${s.id === currentSessionId ? ' current' : ''}`;
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  row.addEventListener('click', () => void doSwitchSession(s.id));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') void doSwitchSession(s.id);
  });

  const top = document.createElement('div');
  top.className = 'session-top';

  if (s.id === editingId) {
    const input = document.createElement('input');
    input.className = 'session-rename';
    input.value = s.title || '新对话';
    input.maxLength = 40;
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') void doRenameSession(s.id, input.value);
      else if (e.key === 'Escape') {
        editingId = null;
        paintSessions();
      }
    });
    // 失焦即保存：少一个"确认"按钮
    input.addEventListener('blur', () => {
      if (editingId === s.id) void doRenameSession(s.id, input.value);
    });
    top.appendChild(input);
    row.appendChild(top);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return row;
  }

  const title = document.createElement('div');
  title.className = 'session-title';
  title.textContent = s.title || '新对话';

  const actions = document.createElement('div');
  actions.className = 'session-actions';
  actions.append(
    makeButton('✎', 'icon tiny', '重命名', () => {
      editingId = s.id;
      confirmingId = null;
      paintSessions();
    }),
    makeButton('🗑', 'icon tiny danger', '删除', () => {
      confirmingId = s.id;
      editingId = null;
      paintSessions();
    }),
  );

  top.append(title, actions);

  const preview = document.createElement('div');
  preview.className = 'session-preview';
  preview.textContent = s.preview ?? '（空对话）';

  const meta = document.createElement('div');
  meta.className = 'session-meta';
  const count = document.createElement('span');
  count.textContent = `${s.messageCount} 条`;
  const when = document.createElement('span');
  when.textContent = formatWhen(s.updatedAt);
  meta.append(count, when);

  row.append(top, preview, meta);
  return row;
}

async function doNewSession() {
  await api.sessionNew();
  resetStreamState();
  setStreaming(false);
  renderMessages([]);
  showView('chat');
  showToast('开了一个新对话');
}

/** @param {string} id */
async function doSwitchSession(id) {
  const res = /** @type {{ ok?: boolean, messages?: { role: string, content: string }[] }} */ (
    /** @type {unknown} */ (await api.sessionSwitch(id))
  );
  if (!res.ok) {
    showToast('切不过去：这个对话不见了', 'error');
    return;
  }
  currentSessionId = id;
  resetStreamState();
  setStreaming(false);
  renderMessages(res.messages ?? []);
  showView('chat');
  showToast('已切换对话');
}

/**
 * @param {string} id
 * @param {string} title
 */
async function doRenameSession(id, title) {
  editingId = null;
  const res = /** @type {{ ok?: boolean, error?: string, sessions?: SessionRow[] }} */ (
    /** @type {unknown} */ (await api.sessionRename(id, title))
  );
  if (!res.ok) {
    showToast(res.error ?? '改名失败', 'error');
  } else {
    sessionsCache = res.sessions ?? sessionsCache;
    showToast('已改名');
  }
  paintSessions();
}

/**
 * @param {string} id
 * @param {string} title
 */
async function doDeleteSession(id, title) {
  confirmingId = null;
  const res = /** @type {{ ok?: boolean, error?: string, currentId?: string, sessions?: SessionRow[], messages?: { role: string, content: string }[], switched?: boolean, created?: boolean }} */ (
    /** @type {unknown} */ (await api.sessionDelete(id))
  );

  if (!res.ok) {
    showToast(res.error ?? '删除失败', 'error');
    void renderSessions();
    return;
  }

  sessionsCache = res.sessions ?? [];
  currentSessionId = res.currentId ?? '';

  // 删的是当前会话 → 后端已经自动切换/新建，界面跟着换
  if (res.switched) {
    resetStreamState();
    setStreaming(false);
    renderMessages(res.messages ?? []);
    showToast(res.created ? '删掉了，给你开了个新对话' : '删掉了，已切到最近的对话');
  } else {
    showToast(`已删除「${title || '新对话'}」`);
  }

  paintSessions();
}

newSessionBtn.addEventListener('click', () => void doNewSession());
historyNewBtn.addEventListener('click', () => void doNewSession());
historyBtn.addEventListener('click', () => showView(viewHistory.hidden === true ? 'history' : 'chat'));
gearEl.addEventListener('click', () => showView(viewSettings.hidden === true ? 'settings' : 'chat'));
watchlistBtn.addEventListener('click', () => showView(viewWatchlist.hidden === true ? 'watchlist' : 'chat'));
watchlistRefresh.addEventListener('click', () => { void renderWatchlist(); });
closeEl.addEventListener('click', () => api.toggleBubble(false));

// ── 其它事件 ────────────────────────────────────────────────────────

sendEl.addEventListener('click', send);
stopEl.addEventListener('click', () => api.cancel());
inputEl.addEventListener('input', autoGrow);
inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (editingId !== null) {
    editingId = null;
    paintSessions();
    return;
  }
  if (confirmingId !== null) {
    confirmingId = null;
    paintSessions();
    return;
  }
  if (viewSettings.hidden !== true || viewHistory.hidden !== true || viewWatchlist.hidden !== true) {
    showView('chat');
  }
  else api.toggleBubble(false);
});
window.addEventListener('focus', () => {
  if (viewChat.hidden !== true) inputEl.focus();
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ── 主进程下行 ──────────────────────────────────────────────────────

api.onState((payload) => {
  const p = /** @type {{ turnId?: string, state?: string }} */ (payload ?? {});
  if (!acceptEvent(p)) return;
  setStreaming(p.state === 'think' || p.state === 'speak');
});

api.onDelta((payload) => {
  const p = /** @type {{ turnId?: string, text?: string }} */ (payload ?? {});
  if (!acceptEvent(p)) return;

  streamText += p.text ?? '';
  if (!streamBubble) {
    streamBubble = appendMessage('assistant', '');
    setStreaming(true);
  }
  streamBubble.textContent = streamText;
  scrollToBottom();
});

api.onMessage((payload) => {
  const p = /** @type {{ turnId?: string, role?: string, text?: string }} */ (payload ?? {});
  if (!acceptEvent(p)) return;

  if (streamBubble) streamBubble.textContent = p.text ?? '';
  else if ((p.text ?? '') !== '') appendMessage('assistant', p.text ?? '');

  streamBubble = null;
  streamText = '';
  setStreaming(false);
});

api.onNotice((payload) => {
  const p = /** @type {{ text?: string }} */ (payload ?? {});
  appendMessage('system', p.text ?? '');
  setStreaming(false);
});

api.onConfirmRequest((payload) => {
  showConfirmRequest(payload);
});

api.onSkillResult((payload) => {
  renderSkillResult(payload);
});

api.onError((payload) => {
  const p = /** @type {{ turnId?: string, message?: string }} */ (payload ?? {});
  if (p.turnId !== 'crash' && !acceptEvent(p)) return;
  appendMessage('system', `⚠️ ${p.message ?? '出了点问题'}`);
  resetStreamState();
  setStreaming(false);
});

// ── L2 确认 ─────────────────────────────────────────────────────────

/** 当前待确认的请求 id */
let pendingConfirmId = /** @type {string | null} */ (null);

/**
 * 技能要动真格之前弹的确认条。
 * **必须把"要做什么"完整说出来** —— 不允许盲确认（PRD-Skill §4.2）。
 * @param {unknown} payload
 */
function showConfirmRequest(payload) {
  const p = /** @type {{ requestId?: string, skill?: string, level?: string, args?: Record<string, unknown> }} */ (
    payload ?? {}
  );
  if (!p.requestId) return;

  pendingConfirmId = p.requestId;
  crBody.innerHTML = '';

  const what = document.createElement('div');
  what.append('技能：');
  const code = document.createElement('code');
  code.textContent = p.skill ?? '未知';
  what.append(code, ` （风险等级 ${p.level ?? '?'}）`);

  const detail = document.createElement('div');
  detail.style.marginTop = '4px';
  detail.append('参数：');
  const argsCode = document.createElement('code');
  argsCode.textContent = JSON.stringify(p.args ?? {});
  detail.append(argsCode);

  crBody.append(what, detail);
  crEl.hidden = false;
  showView('chat');
}

/** @param {boolean} approved */
function answerConfirm(approved) {
  if (pendingConfirmId === null) return;
  api.confirmResponse(pendingConfirmId, approved);
  pendingConfirmId = null;
  crEl.hidden = true;
}

crAllow.addEventListener('click', () => answerConfirm(true));
crDeny.addEventListener('click', () => answerConfirm(false));

// ── 设置面板 ────────────────────────────────────────────────────────

async function loadSettings() {
  const s = /** @type {{ model?: string, hasApiKey?: boolean, dailyCostLimit?: number, offlineMode?: boolean, today?: { cost?: number, calls?: number, tokensIn?: number, tokensOut?: number } }} */ (
    await api.settingsGet([])
  );
  setModel.value = s.model ?? 'deepseek-chat';
  setLimit.value = String(s.dailyCostLimit ?? 10);
  setOffline.checked = s.offlineMode === true;
  setApiKey.value = '';
  keyHint.textContent = s.hasApiKey ? '已配置（留空则保持不变，输入新值可覆盖）' : '尚未配置，填一个才能对话。';
  keyHint.classList.toggle('warn', !s.hasApiKey);

  const t = s.today ?? {};
  statToday.textContent = `今天：${t.calls ?? 0} 次调用 · 输入 ${t.tokensIn ?? 0} / 输出 ${t.tokensOut ?? 0} tokens · 约 ¥${t.cost ?? 0}`;
}

saveSettings.addEventListener('click', async () => {
  const key = setApiKey.value.trim();
  if (key !== '') await api.settingsSet('apiKey', key);
  await api.settingsSet('model', setModel.value);
  await api.settingsSet('dailyCostLimit', Number(setLimit.value));
  await api.settingsSet('offlineMode', setOffline.checked);
  setApiKey.value = '';
  await loadSettings();

  const parts = [];
  if (key !== '') parts.push('API Key');
  parts.push('模型', '费用上限');
  if (setOffline.checked) parts.push('飞行模式');
  showToast(`✅ 已保存（${parts.join(' · ')}）`);
});

// ── 启动 ────────────────────────────────────────────────────────────

/**
 * 把历史消息渲染回气泡。
 * 不做这一步的话：消息虽然存在库里、Agent 也记得上下文，
 * 但用户重启后看到的是空白面板，只能靠"它还记得"来推断。
 */
async function loadHistory() {
  try {
    const res = /** @type {{ sessionId?: string, messages?: { role: string, content: string }[] }} */ (
      /** @type {unknown} */ (await api.historyRecent(50))
    );
    renderMessages(res.messages ?? []);
  } catch {
    /* 读不到就保持问候语 */
  }
}

inputEl.focus();
autoGrow();
setStreaming(false);
void loadHistory();
