/**
 * 技能执行闸门（PRD-Skill v0.1 §4.2 / SDD §6.7）。
 *
 * **顺序不可颠倒**：
 *   1. 技能是否存在          → NOT_FOUND
 *   2. 权限是否声明          → PERMISSION（未声明即拒绝，没有"默认允许"）
 *   3. risk === irreversible → FORBIDDEN（L3 红线，代码层硬拒绝，模型说什么都不执行）
 *   4. requiresConfirmation  → 向用户确认，**超时即视为拒绝**
 *   5. 参数校验              → BAD_ARGS（不合法就不执行任何副作用）
 *   6. 带超时执行
 *   7. 结果归一化：{ ok, summary(≤800), data }
 *
 * 所有失败都返回**结构化结果**而不是抛异常 —— 这样 agent 能把错误原样回填给
 * 模型，让它自己决定换个说法还是如实说"查不到"（B-2d）。
 */
import { AppError } from '../brain/errors.js';
import log from '../log.js';
import * as egress from './egress.js';
import * as registry from './registry.js';
import { RISK_TO_LEVEL, validateArgs } from './schema.js';

/** summary 的上限：给模型看的文本必须短，否则第二次请求会被撑爆（B-6d） */
export const SUMMARY_LIMIT = 800;

/** 确认请求的超时：超时按"拒绝"处理，绝不放行 */
export const CONFIRM_TIMEOUT_MS = 30000;

/**
 * @typedef {{ ok: true, summary: string, data?: unknown, ms: number }
 *   | { ok: false, code: string, summary: string, ms: number }} RunResult
 */

/**
 * @param {string} code
 * @param {string} summary
 * @param {number} startedAt
 * @returns {RunResult}
 */
function fail(code, summary, startedAt) {
  return { ok: false, code, summary, ms: Date.now() - startedAt };
}

/**
 * 权限闸门。
 *
 * 注：**真正的强制点在结构上**——技能拿不到裸 `fetch`，只能用我们注入的
 * `ctx.safeFetch`，而它只放行白名单里的域名。这里做的是"声明自洽性"检查：
 * 声明了出网权限就必须给白名单（校验器已保证），反之亦然。
 *
 * @param {import('./schema.js').SkillManifest} manifest
 * @returns {string[]} 缺失/不自洽的权限说明
 */
export function checkPermissions(manifest) {
  /** @type {string[]} */
  const problems = [];

  const wantsNetwork = manifest.permissions.some((p) => p.startsWith('network:'));
  if (wantsNetwork && manifest.networkHosts.length === 0) {
    problems.push('声明了 network 权限但没有 networkHosts');
  }
  if (!wantsNetwork && manifest.networkHosts.length > 0) {
    problems.push('有 networkHosts 但没声明 network 权限');
  }

  return problems;
}

/**
 * 执行一个技能。
 *
 * @param {string} name
 * @param {unknown} rawArgs 模型给的参数（不可信）
 * @param {object} [ctx]
 * @param {AbortSignal} [ctx.signal]
 * @param {(req: { skill: string, args: Record<string, unknown>, level: string }) => Promise<boolean>} [ctx.requestConfirmation]
 * @returns {Promise<RunResult>}
 */
export async function run(name, rawArgs, ctx = {}) {
  const startedAt = Date.now();

  // ① 存在？
  const skill = registry.get(name);
  if (!skill) {
    log.warn('skill.notFound', { name });
    return fail('NOT_FOUND', `没有这个技能：${name}`, startedAt);
  }
  const { manifest, run: execute } = skill;
  const level = RISK_TO_LEVEL[manifest.risk];

  // ② 权限闸门
  const problems = checkPermissions(manifest);
  if (problems.length > 0) {
    log.warn('skill.permission', { name, problems });
    return fail('PERMISSION', `技能 ${name} 的权限声明不自洽：${problems.join('；')}`, startedAt);
  }

  // ③ L3 红线 —— 硬拒绝，永远不给模型开口子的机会
  if (manifest.risk === 'irreversible') {
    log.warn('skill.forbidden', { name });
    return fail('FORBIDDEN', `技能 ${name} 属于不可逆操作，已被硬性禁止，无论谁说都不执行。`, startedAt);
  }

  // ⑤ 参数校验放这里，是为了在确认之前先把畸形参数挡掉
  const checked = validateArgs(manifest.parameters, rawArgs);
  if (!checked.ok) {
    log.warn('skill.badArgs', { name, errors: checked.errors });
    return fail('BAD_ARGS', `参数不对：${checked.errors.join('；')}`, startedAt);
  }

  // ④ L2 确认（超时即拒绝）
  if (manifest.requiresConfirmation) {
    if (typeof ctx.requestConfirmation !== 'function') {
      return fail('DENIED', `技能 ${name} 需要用户确认，但当前没有确认通道，已拒绝执行。`, startedAt);
    }
    let approved = false;
    try {
      approved = await withTimeout(
        ctx.requestConfirmation({ skill: name, args: checked.value, level }),
        CONFIRM_TIMEOUT_MS,
        '确认超时',
      );
    } catch (err) {
      log.warn('skill.confirmFailed', { name, message: String(err) });
      approved = false;
    }
    if (!approved) {
      log.info('skill.denied', { name });
      return fail('DENIED', '用户拒绝了这次操作。', startedAt);
    }
  }

  // ⑥ 执行 + 超时
  // 技能只能通过注入的 safeFetch 出网 —— 白名单与飞行模式在那一层强制，
  // 技能自己碰不到裸 fetch（结构上的保证，不靠技能自觉）。
  const fullCtx = { ...ctx, safeFetch: egress.safeFetch, skillName: name };

  let result;
  try {
    result = await withTimeout(
      Promise.resolve(execute(checked.value, fullCtx)),
      manifest.timeoutMs,
      `技能 ${name} 执行超时（${manifest.timeoutMs}ms）`,
    );
  } catch (err) {
    // 技能内部抛出的 AppError 要**保留原始错误码**（例如 EGRESS_DENIED），
    // 否则会被降级成 INTERNAL，模型和用户都看不到真正的原因。
    const appErr = err instanceof AppError ? err : null;
    const message = err instanceof Error ? err.message : String(err);
    const code = appErr?.code ?? (message.includes('超时') ? 'TIMEOUT' : 'INTERNAL');
    log.warn('skill.executeFailed', { name, code, message });
    return fail(code, `技能 ${name} 执行失败：${message}`, startedAt);
  }

  // ⑦ 归一化
  const normalized = normalizeResult(result, startedAt);
  log.info('skill.ran', { name, ok: normalized.ok, ms: normalized.ms });
  return normalized;
}

/**
 * @param {unknown} result
 * @param {number} startedAt
 * @returns {RunResult}
 */
function normalizeResult(result, startedAt) {
  const ms = Date.now() - startedAt;

  if (!result || typeof result !== 'object') {
    return { ok: false, code: 'INTERNAL', summary: '技能没有返回结构化结果。', ms };
  }
  const r = /** @type {{ ok?: boolean, summary?: string, data?: unknown, code?: string, message?: string }} */ (result);

  if (r.ok === false) {
    return {
      ok: false,
      code: typeof r.code === 'string' ? r.code : 'INTERNAL',
      summary: String(r.message ?? r.summary ?? '技能执行失败。').slice(0, SUMMARY_LIMIT),
      ms,
    };
  }

  const summary = String(r.summary ?? '').trim();
  if (summary === '') {
    return { ok: false, code: 'INTERNAL', summary: '技能返回了空结果。', ms };
  }

  return {
    ok: true,
    summary: summary.slice(0, SUMMARY_LIMIT),
    data: r.data,
    ms,
  };
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, message) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
