/**
 * 错误归一化（PRD-Brain v0.1 §B-8）。
 *
 * 所有对外抛出的错误都带一个稳定的 `code`，界面据此决定怎么说话，
 * 也保证**错误信息里不会回显 API Key 或请求头**。
 */

/** @typedef {'NETWORK'|'AUTH'|'RATE_LIMIT'|'BUDGET'|'CANCELLED'|'TIMEOUT'|'EGRESS_DENIED'|'SKILL_FAIL'|'LOOP_LIMIT'|'NOT_FOUND'|'INTERNAL'} ErrorCode */

export class AppError extends Error {
  /**
   * @param {ErrorCode} code
   * @param {string} message
   * @param {{ cause?: unknown, retryable?: boolean }} [meta]
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.retryable = meta.retryable ?? false;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

/** 每种错误码对应的默认措辞（NONO 的语气：先给结论，不啰嗦） */
const MESSAGES = /** @type {Record<ErrorCode, string>} */ ({
  NETWORK: '连不上网络，等会儿再试？',
  AUTH: 'API Key 好像不对，去设置里检查一下。',
  RATE_LIMIT: '请求太密了，歇一会儿再来。',
  BUDGET: '今天的额度用完了，明天再说吧。',
  CANCELLED: '好，停下了。',
  TIMEOUT: '等太久没回应，我先放弃了。',
  EGRESS_DENIED: '这个请求被安全规则拦住了。',
  SKILL_FAIL: '这个我暂时查不到。',
  LOOP_LIMIT: '我绕了太多圈，先停一下。',
  NOT_FOUND: '找不到这个东西。',
  INTERNAL: '我这出了点问题。',
});

/**
 * @param {ErrorCode} code
 * @returns {string}
 */
export function defaultMessage(code) {
  return MESSAGES[code] ?? MESSAGES.INTERNAL;
}

/**
 * 把任意异常收敛成 AppError。
 * @param {unknown} err
 * @returns {AppError}
 */
export function normalize(err) {
  if (err instanceof AppError) return err;

  if (err instanceof Error) {
    // AbortSignal 触发的取消
    if (err.name === 'AbortError') return new AppError('CANCELLED', defaultMessage('CANCELLED'), { cause: err });
    if (err.name === 'TimeoutError') return new AppError('TIMEOUT', defaultMessage('TIMEOUT'), { cause: err });
    return new AppError('INTERNAL', defaultMessage('INTERNAL'), { cause: err });
  }

  return new AppError('INTERNAL', defaultMessage('INTERNAL'), { cause: err });
}

/**
 * 把 HTTP 状态码翻译成错误码。
 * @param {number} status
 * @param {string} [body]
 * @returns {AppError}
 */
export function fromHttpStatus(status, body = '') {
  if (status === 401 || status === 403) return new AppError('AUTH', defaultMessage('AUTH'));
  if (status === 402) return new AppError('BUDGET', 'DeepSeek 账户余额不够了。');
  if (status === 429) return new AppError('RATE_LIMIT', defaultMessage('RATE_LIMIT'), { retryable: true });
  if (status >= 500) return new AppError('NETWORK', 'DeepSeek 那边好像出问题了。', { retryable: true });
  return new AppError('INTERNAL', `请求失败（HTTP ${status}）${body ? `：${body.slice(0, 200)}` : ''}`);
}
