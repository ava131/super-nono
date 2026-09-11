/**
 * 极简校验器：技能清单 + 工具参数。
 *
 * **手写而不是引 zod**：本项目保持"除 Electron 外零运行时依赖"，
 * 而这里要校验的结构很小（技能声明 + JSON Schema 的一个子集）。
 * 纯函数、无副作用，可直接单测（见 test/unit/schema.test.js）。
 */

/** 风险等级 → 三级闸门（PRD-Skill v0.1 §4.2） */
export const RISK_TO_LEVEL = Object.freeze({
  read_only: 'L1',
  local_write: 'L2',
  external_send: 'L2',
  irreversible: 'L3',
});

export const RISK_VALUES = Object.freeze(Object.keys(RISK_TO_LEVEL));

/** 允许的权限前缀 */
const PERMISSION_PREFIXES = ['network:', 'fs:read:', 'fs:write:', 'db:', 'notify', 'credential:'];

const NAME_RE = /^[a-z][a-z0-9_]{1,31}$/;

/**
 * @typedef {object} SkillManifest
 * @property {string} name
 * @property {string} description
 * @property {Record<string, unknown>} parameters
 * @property {string[]} permissions
 * @property {'read_only'|'local_write'|'external_send'|'irreversible'} risk
 * @property {boolean} requiresConfirmation
 * @property {number} timeoutMs
 * @property {string[]} networkHosts
 * @property {string} version
 */

/**
 * 校验并归一化一份 skill.json。
 *
 * @param {unknown} raw
 * @param {string} [source] 出错时用来指明是哪个技能（目录名/文件路径）
 * @returns {{ ok: true, value: SkillManifest, errors: string[] } | { ok: false, value: null, errors: string[] }}
 */
export function validateManifest(raw, source = '') {
  /** @type {string[]} */
  const errors = [];
  const where = source ? `${source}: ` : '';

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, value: null, errors: [`${where}清单必须是一个 JSON 对象`] };
  }
  const m = /** @type {Record<string, unknown>} */ (raw);

  // name
  if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) {
    errors.push(`${where}name 必须是 2–32 位小写字母/数字/下划线，且以字母开头`);
  }

  // description —— 这是给模型看的，写不好模型就不会调用
  if (typeof m.description !== 'string' || m.description.trim() === '') {
    errors.push(`${where}description 必填（模型靠它判断何时调用）`);
  } else if (m.description.length > 200) {
    errors.push(`${where}description 太长了（${m.description.length} > 200 字），模型看不完`);
  }

  // parameters
  const params = m.parameters;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    errors.push(`${where}parameters 必填，且必须是 JSON Schema 对象`);
  } else if (/** @type {Record<string, unknown>} */ (params).type !== 'object') {
    errors.push(`${where}parameters.type 必须是 "object"`);
  }

  // permissions
  const perms = m.permissions;
  if (!Array.isArray(perms)) {
    errors.push(`${where}permissions 必填，且必须是数组（未声明的权限一律拒绝）`);
  } else {
    for (const p of perms) {
      if (typeof p !== 'string' || !PERMISSION_PREFIXES.some((pre) => p === pre || p.startsWith(pre))) {
        errors.push(`${where}权限写法不合法：${JSON.stringify(p)}`);
      }
    }
  }

  // risk
  const risk = m.risk;
  if (typeof risk !== 'string' || !RISK_VALUES.includes(risk)) {
    errors.push(`${where}risk 必须是 ${RISK_VALUES.join(' / ')} 之一`);
  }

  // requiresConfirmation
  const needsConfirm = m.requiresConfirmation;
  if (typeof needsConfirm !== 'boolean') {
    errors.push(`${where}requiresConfirmation 必填，且必须是布尔值`);
  } else if (risk !== 'read_only' && needsConfirm !== true) {
    // 非只读操作必须确认，这是硬约束（PRD-Skill §3.2）
    errors.push(`${where}risk=${String(risk)} 的技能必须 requiresConfirmation: true`);
  }

  // timeoutMs
  let timeoutMs = 15000;
  if (m.timeoutMs !== undefined) {
    if (typeof m.timeoutMs !== 'number' || !Number.isFinite(m.timeoutMs) || m.timeoutMs < 100 || m.timeoutMs > 60000) {
      errors.push(`${where}timeoutMs 必须是 100–60000 之间的数字`);
    } else {
      timeoutMs = m.timeoutMs;
    }
  }

  // networkHosts —— 声明了出网权限就必须给白名单，否则等于没闸门
  /** @type {string[]} */
  let networkHosts = [];
  if (m.networkHosts !== undefined) {
    if (!Array.isArray(m.networkHosts) || m.networkHosts.some((h) => typeof h !== 'string' || h === '')) {
      errors.push(`${where}networkHosts 必须是字符串数组`);
    } else {
      networkHosts = /** @type {string[]} */ (m.networkHosts);
    }
  }
  const wantsNetwork = Array.isArray(perms) && perms.some((p) => typeof p === 'string' && p.startsWith('network:'));
  if (wantsNetwork && networkHosts.length === 0) {
    errors.push(`${where}声明了 network 权限，却没有 networkHosts —— 出网闸门会失效`);
  }
  if (!wantsNetwork && networkHosts.length > 0) {
    errors.push(`${where}写了 networkHosts，却没有声明对应的 network 权限`);
  }

  // version
  if (typeof m.version !== 'string' || m.version.trim() === '') {
    errors.push(`${where}version 必填`);
  }

  if (errors.length > 0) return { ok: false, value: null, errors };

  return {
    ok: true,
    errors: [],
    value: {
      name: /** @type {string} */ (m.name),
      description: /** @type {string} */ (m.description).trim(),
      parameters: /** @type {Record<string, unknown>} */ (params),
      permissions: /** @type {string[]} */ (perms),
      risk: /** @type {SkillManifest['risk']} */ (risk),
      requiresConfirmation: /** @type {boolean} */ (needsConfirm),
      timeoutMs,
      networkHosts,
      version: /** @type {string} */ (m.version),
    },
  };
}

/**
 * 校验工具参数（JSON Schema 的一个子集）。
 *
 * 支持：type / properties / required / enum / items / minimum / maximum。
 * **多出来的字段会被忽略而不是报错** —— 模型偶尔会多塞一个字段，
 * 为这个让它重试一整轮不值得；但类型、必填、枚举这些错了必须拦。
 *
 * @param {Record<string, unknown>} schema
 * @param {unknown} args
 * @returns {{ ok: boolean, errors: string[], value: Record<string, unknown> }}
 */
export function validateArgs(schema, args) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Record<string, unknown>} */
  const value = {};

  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, errors: ['参数必须是一个对象'], value: {} };
  }
  const input = /** @type {Record<string, unknown>} */ (args);

  const props = /** @type {Record<string, Record<string, unknown>> | undefined} */ (schema.properties);
  const required = Array.isArray(schema.required) ? /** @type {string[]} */ (schema.required) : [];

  for (const key of required) {
    if (input[key] === undefined || input[key] === null) {
      errors.push(`缺少必填参数：${key}`);
    }
  }

  if (props) {
    for (const [key, raw] of Object.entries(input)) {
      const rule = props[key];
      if (!rule) continue; // 未声明的字段：忽略
      const check = checkValue(rule, raw, key);
      if (check.ok) value[key] = check.value;
      else errors.push(check.error);
    }
  } else {
    Object.assign(value, input);
  }

  return { ok: errors.length === 0, errors, value };
}

/**
 * @param {Record<string, unknown>} rule
 * @param {unknown} raw
 * @param {string} key
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
function checkValue(rule, raw, key) {
  const type = rule.type;

  if (type === 'string') {
    if (typeof raw !== 'string') return { ok: false, error: `参数 ${key} 应该是字符串` };
    if (Array.isArray(rule.enum) && !rule.enum.includes(raw)) {
      return { ok: false, error: `参数 ${key} 只能是 ${rule.enum.map(String).join(' / ')} 之一，收到 ${JSON.stringify(raw)}` };
    }
    return { ok: true, value: raw };
  }

  if (type === 'number' || type === 'integer') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return { ok: false, error: `参数 ${key} 应该是数字` };
    if (type === 'integer' && !Number.isInteger(raw)) return { ok: false, error: `参数 ${key} 应该是整数` };
    if (typeof rule.minimum === 'number' && raw < rule.minimum) return { ok: false, error: `参数 ${key} 不能小于 ${rule.minimum}` };
    if (typeof rule.maximum === 'number' && raw > rule.maximum) return { ok: false, error: `参数 ${key} 不能大于 ${rule.maximum}` };
    return { ok: true, value: raw };
  }

  if (type === 'boolean') {
    if (typeof raw !== 'boolean') return { ok: false, error: `参数 ${key} 应该是布尔值` };
    return { ok: true, value: raw };
  }

  if (type === 'array') {
    if (!Array.isArray(raw)) return { ok: false, error: `参数 ${key} 应该是数组` };
    if (rule.items && typeof rule.items === 'object') {
      const itemRule = /** @type {Record<string, unknown>} */ (rule.items);
      const out = [];
      for (let i = 0; i < raw.length; i += 1) {
        const r = checkValue(itemRule, raw[i], `${key}[${i}]`);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return { ok: true, value: out };
    }
    return { ok: true, value: raw };
  }

  if (type === 'object') {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `参数 ${key} 应该是对象` };
    return { ok: true, value: raw };
  }

  // 没写 type：原样放行
  return { ok: true, value: raw };
}
