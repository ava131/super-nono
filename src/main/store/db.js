/**
 * SQLite 单例 + 建表（SDD v0.1 §6.10）。
 *
 * 用 **`node:sqlite`（Node 内置）**，不用 `better-sqlite3`：
 * 后者是 C++ 原生模块，需要为 Electron 的 ABI 重建，是本项目最大的一处
 * 工程风险（SDD 里为此写了 Plan A / Plan B）。实测 Electron 44 自带的
 * Node 24 已内置 `node:sqlite`，于是**风险与依赖一起消失**。
 *
 * 记账口径（C-2 修订）：`usage_log` 是 token 与费用的**唯一**来源，
 * `messages` 表不存 token。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import log from '../log.js';

/** @type {DatabaseSync | null} */
let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  turn_id     TEXT NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS usage_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT,
  turn_id       TEXT,
  model         TEXT,
  tokens_in     INTEGER DEFAULT 0,
  tokens_out    INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  latency_ms    INTEGER DEFAULT 0,
  cost_est      REAL    DEFAULT 0,
  skill_names   TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);

-- 技能持久化（SDD-market §6.1）：命名空间隔离的通用 KV。
-- 技能通过 ctx.store 访问（见 src/main/skills/store.js），拿不到裸 SQL。
-- 写权限由 createSkillStore 的运行时闸门控制（read_only 技能不许写）。
CREATE TABLE IF NOT EXISTS skill_kv (
  namespace  TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, key)
);

-- v1+ 预留（v0 不创建）：memories / tasks / cache_market
`;

/**
 * 初始化数据库。由 main.js 在启动时注入路径；
 * 单测可以直接 `initDb(':memory:')`。
 *
 * 刻意不在这里 import electron —— 存储层与 Electron 解耦后，
 * 会话/消息这类核心逻辑就能在纯 Node 下单测。
 *
 * @param {string} file 数据库文件路径，或 ':memory:'
 * @returns {DatabaseSync}
 */
export function initDb(file) {
  if (db) return db;

  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  // 会话由 memory.js 按需创建（启动时会开新会话或复用空会话），
  // 这里不再预置固定的 'default' 行。

  log.info('db.ready', { file });
  return db;
}

/**
 * 取已初始化的连接。
 * @returns {DatabaseSync}
 */
export function getDb() {
  if (!db) throw new Error('数据库尚未初始化：请先在启动时调用 initDb(path)');
  return db;
}

/** 关连接（退出时调用） */
export function closeDb() {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* 忽略 */
  }
  db = null;
}
