/**
 * 记忆与会话（PRD-Brain v0.1 §B-4 + 多会话扩展）。
 *
 * 上下文窗口**必须有上限**（防泄漏第 6 条）：请求里只带最近 N 条，
 * 更早的留在 SQLite 里，不无脑塞给模型（又贵又慢还降智）。
 *
 * 存进库的是**用户原话**，不带时间前缀；时间前缀只在本次请求里拼，
 * 这样历史上下文保持干净（PRD-Brain §B-3.1）。
 *
 * 会话策略：
 *   - 启动时**开一个新会话**（PM 决定），但若最近的会话还是空的就复用它，
 *     避免反复开关应用堆出一串空会话。
 *   - 标题取首条用户消息的前 20 字。
 */
import { getDb } from '../store/db.js';
import log from '../log.js';

/** 上下文窗口：最多带最近多少条消息 */
export const WINDOW_SIZE = 40;

/** 会话的默认标题（用户没改过、也还没有首条消息时） */
export const DEFAULT_TITLE = '新对话';

let turnSeq = 0;

/** @type {string | null} */
let currentSessionId = null;

/** @returns {string} */
export function newTurnId() {
  turnSeq += 1;
  return `t${Date.now().toString(36)}-${turnSeq}`;
}

/** @returns {string} */
function makeSessionId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** @returns {string} */
export function getCurrentSessionId() {
  if (!currentSessionId) ensureStartupSession();
  return /** @type {string} */ (currentSessionId);
}

/**
 * 新建一个会话并切过去。
 * @param {string} [title]
 * @returns {string} 新会话 id
 */
export function createSession(title = DEFAULT_TITLE) {
  const id = makeSessionId();
  const now = Date.now();
  getDb().prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, title, now, now);
  currentSessionId = id;
  log.info('session.created', { id });
  return id;
}

/**
 * 切到指定会话。
 * @param {string} id
 * @returns {boolean}
 */
export function switchSession(id) {
  const row = getDb().prepare('SELECT id FROM sessions WHERE id = ?').get(id);
  if (!row) return false;
  currentSessionId = id;
  log.info('session.switched', { id });
  return true;
}

/**
 * 启动时的会话策略：开新会话；若最近的会话还是空的则复用它。
 *
 * 注意这里会**校验缓存的 id 在库里是否真的存在**——否则一旦当前会话
 * 被别处删掉，进程内就会留着一个悬空引用，后续消息会写进一个不存在的会话。
 *
 * @returns {string}
 */
export function ensureStartupSession() {
  if (currentSessionId) {
    const still = getDb().prepare('SELECT id FROM sessions WHERE id = ?').get(currentSessionId);
    if (still) return currentSessionId;
    log.warn('session.dangling', { id: currentSessionId });
    currentSessionId = null; // 悬空引用，重新选
  }

  const db = getDb();
  const last = /** @type {{ id: string } | undefined} */ (
    db.prepare('SELECT id FROM sessions ORDER BY updated_at DESC, rowid DESC LIMIT 1').get()
  );

  if (last) {
    const cnt = /** @type {{ n: number } | undefined} */ (
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(last.id)
    );
    if ((cnt?.n ?? 0) === 0) {
      // 复用它，别堆空会话
      currentSessionId = last.id;
      return last.id;
    }
  }
  return createSession();
}

/**
 * 清空进程内的会话缓存，但**不动数据库**。
 *
 * 供单测使用（每个用例一个干净的内存库）；将来若支持"切换数据目录"也会用到。
 */
export function resetSessionState() {
  currentSessionId = null;
}

/**
 * @typedef {{ id: string, title: string, updatedAt: number, messageCount: number, preview: string | null }} SessionRow
 */

/** @returns {SessionRow[]} */
export function listSessions() {
  return /** @type {SessionRow[]} */ (
    getDb()
      .prepare(
        `SELECT s.id,
                COALESCE(s.title, '新对话') AS title,
                s.updated_at AS updatedAt,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messageCount,
                (SELECT substr(m2.content, 1, 40) FROM messages m2
                  WHERE m2.session_id = s.id AND m2.role = 'user' ORDER BY m2.id LIMIT 1) AS preview
           FROM sessions s
          -- updated_at 是毫秒；同一毫秒内建的会话会并列，
          -- 必须给一个确定性 tiebreaker，否则列表顺序会随机跳动
          ORDER BY s.updated_at DESC, s.rowid DESC`,
      )
      .all()
  );
}

/**
 * 重命名会话。
 * @param {string} id
 * @param {string} title
 * @returns {boolean}
 */
export function renameSession(id, title) {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (clean === '') return false;
  const info = getDb().prepare('UPDATE sessions SET title = ? WHERE id = ?').run(clean, id);
  log.info('session.renamed', { id, changes: info.changes });
  return info.changes > 0;
}

/**
 * 删除一个会话及其全部消息。
 *
 * 边界处理（不允许出现"零会话"状态）：
 *   - 删的是当前会话 → 自动切到最近的一个；
 *   - 一个都不剩了 → 自动新建一个空对话。
 *
 * @param {string} id
 * @returns {{ ok: boolean, currentId: string, switched: boolean, created: boolean }}
 */
export function deleteSession(id) {
  const db = getDb();
  const exists = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
  if (!exists) return { ok: false, currentId: getCurrentSessionId(), switched: false, created: false };

  db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  log.info('session.deleted', { id });

  if (currentSessionId !== id) {
    return { ok: true, currentId: getCurrentSessionId(), switched: false, created: false };
  }

  // 删掉的正是当前会话
  const next = /** @type {{ id: string } | undefined} */ (
    db.prepare('SELECT id FROM sessions ORDER BY updated_at DESC, rowid DESC LIMIT 1').get()
  );
  if (next) {
    currentSessionId = next.id;
    log.info('session.autoSwitched', { to: next.id });
    return { ok: true, currentId: next.id, switched: true, created: false };
  }

  const fresh = createSession();
  return { ok: true, currentId: fresh, switched: true, created: true };
}

/**
 * @param {object} params
 * @param {string} params.turnId
 * @param {'user'|'assistant'|'tool'|'system'} params.role
 * @param {string} params.content
 * @param {string} [params.sessionId]
 */
export function appendMessage({ turnId, role, content, sessionId }) {
  const db = getDb();
  const sid = sessionId ?? getCurrentSessionId();

  db.prepare(
    `INSERT INTO messages (session_id, turn_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sid, turnId, role, content, Date.now());
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sid);

  // 首条用户消息 → 自动起标题。
  // 只在标题还是默认值时生效，这样用户手动改过的名字不会被覆盖。
  if (role === 'user') {
    const row = /** @type {{ n: number, title: string } | undefined} */ (
      db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM messages WHERE session_id = ? AND role = 'user') AS n,
                  (SELECT title FROM sessions WHERE id = ?) AS title`,
        )
        .get(sid, sid)
    );
    if ((row?.n ?? 0) === 1 && (row?.title ?? '') === DEFAULT_TITLE) {
      const title = content.replace(/\s+/g, ' ').trim().slice(0, 20) || DEFAULT_TITLE;
      db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, sid);
    }
  }
}

/**
 * 取当前会话最近 N 条，返回可直接喂给模型的 `{role, content}` 数组。
 * @param {number} [limit]
 * @returns {{ role: string, content: string }[]}
 */
export function recentMessages(limit = WINDOW_SIZE) {
  const rows = getDb()
    .prepare(
      `SELECT role, content FROM messages
       WHERE session_id = ? AND content IS NOT NULL
       ORDER BY id DESC LIMIT ?`,
    )
    .all(getCurrentSessionId(), limit);

  return /** @type {{ role: string, content: string }[]} */ (rows)
    .reverse()
    .map((r) => ({ role: r.role, content: r.content }));
}

/** @returns {number} */
export function countMessages() {
  const row = /** @type {{ n: number } | undefined} */ (
    getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(getCurrentSessionId())
  );
  return row?.n ?? 0;
}

