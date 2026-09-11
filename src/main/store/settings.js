/**
 * 设置存储。
 *
 * 分两类：
 *   - **非敏感项**：模型、位置比例、开机自启、每日费用上限、飞行模式 → 明文 JSON
 *   - **API Key**：用 Electron 内置 `safeStorage` 加密后以密文存进同一个 JSON。
 *     `safeStorage` 底层就是 macOS 钥匙串。**明文只存在于内存**。
 *
 * C-1 修订：读取/写入密钥只在这一个文件里发生；且当
 * `isEncryptionAvailable() === false` 时**明确报错，绝不静默降级成明文**
 * （PRD-Body v0.1 §W-7.1）。
 */
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import log from '../log.js';

/**
 * @typedef {object} SettingsShape
 * @property {{ rx: number, ry: number } | null} positionRatio
 * @property {string} model
 * @property {boolean} launchAtLogin
 * @property {number} dailyCostLimit 人民币元；0 表示不限制
 * @property {boolean} offlineMode 飞行模式：一切出网被拒
 * @property {string | null} apiKeyEnc safeStorage 加密后的 base64 密文
 */

/** @type {SettingsShape} */
const DEFAULTS = {
  positionRatio: null, // null = 首次启动，落右下角
  model: 'deepseek-chat',
  launchAtLogin: false,
  dailyCostLimit: 10, // ¥10/天（B-6c：按费用卡，不按 token）
  offlineMode: false,
  apiKeyEnc: null,
};

/** @type {SettingsShape | null} */
let cache = null;

/** @type {string | null} */
let filePath = null;

function init() {
  if (cache) return;
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  filePath = path.join(dir, 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    cache = { ...DEFAULTS, ...raw };
  } catch {
    cache = { ...DEFAULTS };
  }
}

function persist() {
  if (!filePath || !cache) return;
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  } catch (err) {
    log.error('settings.persist.failed', { message: String(err) });
  }
}

/**
 * @template {keyof SettingsShape} K
 * @param {K} key
 * @returns {SettingsShape[K]}
 */
export function get(key) {
  init();
  return /** @type {SettingsShape} */ (cache)[key];
}

/**
 * @template {keyof SettingsShape} K
 * @param {K} key
 * @param {SettingsShape[K]} value
 */
export function set(key, value) {
  init();
  /** @type {SettingsShape} */ (cache)[key] = value;
  persist();
}

/** @returns {SettingsShape} */
export function all() {
  init();
  return { .../** @type {SettingsShape} */ (cache) };
}

// ── API Key（最高密级）──────────────────────────────────────────────

/**
 * 保存 API Key（加密）。
 * @param {string} plain
 */
export function setApiKey(plain) {
  const key = plain.trim();
  if (key === '') {
    set('apiKeyEnc', null);
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    // 不允许明文回退：宁可报错，也不能把密钥裸奔写进磁盘
    throw new Error('当前系统无法安全存储密钥（safeStorage 不可用），已拒绝保存。');
  }
  set('apiKeyEnc', safeStorage.encryptString(key).toString('base64'));
}

/**
 * 读取 API Key 明文。**只有这里会解密。**
 * @returns {string | null}
 */
export function getApiKey() {
  const enc = get('apiKeyEnc');
  if (!enc) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch (err) {
    log.warn('settings.apiKey.decryptFailed', { message: String(err) });
    return null;
  }
}

/** @returns {boolean} */
export function hasApiKey() {
  return !!get('apiKeyEnc');
}

/**
 * 给界面看的脱敏摘要 —— **永远不返回密钥本身**。
 * @returns {Record<string, unknown>}
 */
export function publicSummary() {
  return {
    model: get('model'),
    hasApiKey: hasApiKey(),
    dailyCostLimit: get('dailyCostLimit'),
    offlineMode: get('offlineMode'),
    launchAtLogin: get('launchAtLogin'),
  };
}

/** @returns {string} */
export function getDataDir() {
  return app.getPath('userData');
}

/** @returns {string} */
export function getConfigPath() {
  init();
  return filePath ?? '';
}
