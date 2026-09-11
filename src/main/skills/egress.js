/**
 * 出网唯一出口（PRD-Skill v0.1 §4.3 / SDD v0.1 §6.8）。
 *
 * **全项目禁止直接调用 `fetch`**，一律走 `safeFetch`，它负责：
 *   1. 飞行模式短路（一切出网被拒）
 *   2. 强制 HTTPS
 *   3. 域名白名单校验
 *   4. 记录出网日志（只记域名与状态码，**不记响应体**）
 *   5. 合并「调用方 signal」与「超时 signal」——
 *      ⚠️ 这一条是修过的 bug：原设计用 `AbortSignal.timeout()` 直接覆盖调用方 signal，
 *      导致用户按「停止」时请求不会被中断（要干等到超时），违反 B-2c。
 */
import log from '../log.js';
import { AppError } from '../brain/errors.js';

/** @type {Set<string>} */
const allowedHosts = new Set();

/**
 * 默认白名单：v0 只有 DeepSeek 一个出口。
 * @param {string[]} [hosts] 技能声明的额外域名（M3 起由 registry 汇总注入）
 */
export function initEgress(hosts = []) {
  allowedHosts.clear();
  for (const h of ['api.deepseek.com', ...hosts]) allowedHosts.add(h);
  log.info('egress.whitelist', { hosts: [...allowedHosts] });
}

/**
 * 往白名单里追加域名 —— 技能声明的 `networkHosts` 就是从这条路进来的。
 * 启动时先 initEgress()（含 DeepSeek），再由 registry 逐个 addHosts()。
 * @param {string[]} [hosts]
 */
export function addHosts(hosts = []) {
  for (const h of hosts) if (typeof h === 'string' && h !== '') allowedHosts.add(h);
}

/** @returns {string[]} */
export function listHosts() {
  return [...allowedHosts];
}

/** @type {() => boolean} */
let offlineProbe = () => false;

/**
 * 注入"飞行模式"的判定函数（设置面板里那个开关）。
 * @param {() => boolean} fn
 */
export function setOfflineProbe(fn) {
  offlineProbe = fn;
}

/**
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [options]
 * @returns {Promise<Response>}
 */
export async function safeFetch(url, options = {}) {
  if (offlineProbe()) {
    throw new AppError('EGRESS_DENIED', '飞行模式已开启，所有出网请求都被拒绝');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError('EGRESS_DENIED', `不是合法的 URL：${url}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new AppError('EGRESS_DENIED', `仅允许 HTTPS，收到 ${parsed.protocol}`);
  }

  if (!allowedHosts.has(parsed.hostname)) {
    log.warn('egress.denied', { host: parsed.hostname });
    throw new AppError('EGRESS_DENIED', `域名不在白名单内：${parsed.hostname}`);
  }

  const { timeoutMs = 60000, signal: outer, ...rest } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  // 关键：两个 signal 都要生效——调用方取消要立刻断，超时也要断
  const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;

  const startedAt = Date.now();
  try {
    const res = await fetch(url, { ...rest, signal });
    log.debug('egress.request', { host: parsed.hostname, status: res.status, ms: Date.now() - startedAt });
    return res;
  } catch (err) {
    if (outer?.aborted) throw new AppError('CANCELLED', '请求已取消');
    if (timeout.aborted) throw new AppError('TIMEOUT', `请求超时（${timeoutMs}ms）`);
    log.warn('egress.failed', { host: parsed.hostname, ms: Date.now() - startedAt });
    throw new AppError('NETWORK', '网络请求失败，检查一下网络连接？');
  }
}
