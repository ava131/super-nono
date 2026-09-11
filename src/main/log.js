/**
 * 日志（PRD-Brain v0.1 §B-7 / SDD v0.1 §6.11）
 *
 *   - 内存里只留最近 500 条（环形缓冲），供调试面板读取；
 *   - 同时按天追加写入 JSONL 文件；
 *   - **脱敏在写入口做一次**，而不是在读取时做（避免遗漏路径）。
 *
 * 注意：默认只记录事件元数据，不记录消息正文。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_MEMORY = 500;
const LEVELS = /** @type {const} */ (['debug', 'info', 'warn', 'error']);

/** @type {{ ts: number, level: string, event: string, data: unknown }[]} */
const buffer = [];

/** @type {string | null} */
let logsDir = null;

/** @type {NodeJS.Timeout | null} */
let flushTimer = null;

/** @type {string[]} */
let pending = [];

/** @param {number} n @param {number} width */
function pad(n, width) {
  return String(n).padStart(width, '0');
}

/** @returns {string} */
function todayFile() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}.jsonl`;
}

/**
 * 注入日志目录（由 main.js 在启动时调用）。
 *
 * 刻意不在这里 import electron：这样存储层与日志层都不再耦合 Electron，
 * 单测就能直接在纯 Node 下跑（见 test/unit/sessions.test.js）。
 * @param {string} dir
 */
export function initLog(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    logsDir = dir;
  } catch {
    logsDir = null; // 落盘失败不应让应用崩掉
  }
}

function ensureDir() {
  /* 目录由 initLog 注入；未注入时只写内存缓冲 */
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!logsDir || pending.length === 0) return;
    const lines = pending.join('');
    pending = [];
    try {
      fs.appendFileSync(path.join(/** @type {string} */ (logsDir), todayFile()), lines, 'utf8');
    } catch {
      /* 忽略：日志落盘失败不应影响主流程 */
    }
  }, 250);
  flushTimer.unref?.();
}

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g, // DeepSeek / OpenAI 风格的 key
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
];

const SECRET_KEYS = new Set(['apikey', 'api_key', 'authorization', 'password', 'token', 'secret']);

/**
 * 递归脱敏：把疑似密钥的字符串替换掉，把敏感字段名整体打码。
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redact(value, depth = 0) {
  if (depth > 6) return '«too deep»';
  if (typeof value === 'string') {
    return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, '***'), value);
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) ? '***' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * @param {string} level
 * @param {string} event
 * @param {unknown} [data]
 */
function write(level, event, data) {
  const entry = { ts: Date.now(), level, event, data: redact(data ?? null) };
  buffer.push(entry);
  if (buffer.length > MAX_MEMORY) buffer.splice(0, buffer.length - MAX_MEMORY);

  ensureDir();
  if (logsDir) {
    pending.push(`${JSON.stringify(entry)}\n`);
    scheduleFlush();
  }

  const label = `[nono:${level}] ${event}`;
  if (level === 'error') console.error(label, entry.data);
  else if (level === 'warn') console.warn(label, entry.data);
  else console.log(label, entry.data);
}

const log = {
  /** @param {string} event @param {unknown} [data] */
  debug: (event, data) => {
    if (process.env.NONO_DEBUG) write('debug', event, data);
  },
  /** @param {string} event @param {unknown} [data] */
  info: (event, data) => write('info', event, data),
  /** @param {string} event @param {unknown} [data] */
  warn: (event, data) => write('warn', event, data),
  /** @param {string} event @param {unknown} [data] */
  error: (event, data) => write('error', event, data),
  /** @returns {readonly { ts: number, level: string, event: string, data: unknown }[]} */
  recent: () => buffer.slice(),
  levels: LEVELS,
};

export default log;
