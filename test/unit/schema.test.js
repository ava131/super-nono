import assert from 'node:assert/strict';
import test from 'node:test';
import { RISK_TO_LEVEL, validateArgs, validateManifest } from '../../src/main/skills/schema.js';

// ── 清单校验 ────────────────────────────────────────────────────────

/** 一份合法清单，各用例在它的基础上改坏某处 */
function base(/** @type {Record<string, unknown>} */ over = {}) {
  return {
    name: 'demo',
    description: '一个用来测试的技能。',
    parameters: { type: 'object', properties: {}, required: [] },
    permissions: ['db:cache'],
    risk: 'read_only',
    requiresConfirmation: false,
    version: '0.1.0',
    ...over,
  };
}

test('合法清单通过，并补上 timeoutMs 默认值', () => {
  const r = validateManifest(base());
  assert.equal(r.ok, true);
  assert.equal(r.value?.timeoutMs, 15000);
  assert.deepEqual(r.value?.networkHosts, []);
});

test('name 不合规会被拒', () => {
  assert.equal(validateManifest(base({ name: 'A' })).ok, false);
  assert.equal(validateManifest(base({ name: 'has-dash' })).ok, false);
  assert.equal(validateManifest(base({ name: 123 })).ok, false);
});

test('description 必填，且不能太长', () => {
  assert.equal(validateManifest(base({ description: '' })).ok, false);
  assert.equal(validateManifest(base({ description: '一'.repeat(201) })).ok, false);
});

test('parameters 必须是 object 型 schema', () => {
  assert.equal(validateManifest(base({ parameters: undefined })).ok, false);
  assert.equal(validateManifest(base({ parameters: { type: 'string' } })).ok, false);
});

test('risk 取值受限', () => {
  assert.equal(validateManifest(base({ risk: 'whatever' })).ok, false);
  for (const risk of Object.keys(RISK_TO_LEVEL)) {
    // L1.5 是唯一"不得要求确认"的非只读档位（评审决定 3）
    const needsConfirm = risk !== 'read_only' && risk !== 'local_reversible';
    assert.equal(validateManifest(base({ risk, requiresConfirmation: needsConfirm })).ok, true, risk);
  }
});

test('L1.5（local_reversible）不得要求确认 —— 否则会训练用户盲点"允许"', () => {
  const r = validateManifest(base({ risk: 'local_reversible', requiresConfirmation: true }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /不得要求确认/);
});

test('L1.5 不要求确认时通过，且档位是 L1.5', () => {
  const r = validateManifest(base({ risk: 'local_reversible', requiresConfirmation: false }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(RISK_TO_LEVEL[r.value.risk], 'L1.5');
});

test('非只读技能必须 requiresConfirmation: true（硬约束）', () => {
  const r = validateManifest(base({ risk: 'external_send', requiresConfirmation: false }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /requiresConfirmation/);
});

test('声明了 network 权限却没有 networkHosts → 拒绝（否则闸门失效）', () => {
  const r = validateManifest(base({ permissions: ['network:weather'] }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /networkHosts/);
});

test('有 networkHosts 却没声明 network 权限 → 也拒绝', () => {
  const r = validateManifest(base({ networkHosts: ['example.com'] }));
  assert.equal(r.ok, false);
});

test('permissions 写法受限', () => {
  assert.equal(validateManifest(base({ permissions: ['随便写'] })).ok, false);
  assert.equal(validateManifest(base({ permissions: 'not-an-array' })).ok, false);
  assert.equal(validateManifest(base({ permissions: ['notify', 'db:cache'] })).ok, true);
});

test('timeoutMs 越界会被拒', () => {
  assert.equal(validateManifest(base({ timeoutMs: 10 })).ok, false);
  assert.equal(validateManifest(base({ timeoutMs: 999999 })).ok, false);
  assert.equal(validateManifest(base({ timeoutMs: 5000 })).value?.timeoutMs, 5000);
});

test('非对象输入不会崩，而是返回错误', () => {
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest([]).ok, false);
  assert.equal(validateManifest('nope').ok, false);
});

test('错误信息里带上来源，方便定位是哪个技能', () => {
  const r = validateManifest(base({ name: 'BAD' }), 'weather');
  assert.match(r.errors.join(' '), /weather/);
});

// ── 参数校验 ────────────────────────────────────────────────────────

const schema = {
  type: 'object',
  properties: {
    city: { type: 'string' },
    action: { type: 'string', enum: ['now', 'forecast'] },
    days: { type: 'integer', minimum: 1, maximum: 7 },
    flag: { type: 'boolean' },
  },
  required: ['city', 'action'],
};

test('合法参数通过', () => {
  const r = validateArgs(schema, { city: '上海', action: 'now' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { city: '上海', action: 'now' });
});

test('缺必填参数会被指出', () => {
  const r = validateArgs(schema, { city: '上海' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /action/);
});

test('类型不对会被拒', () => {
  assert.equal(validateArgs(schema, { city: 123, action: 'now' }).ok, false);
  assert.equal(validateArgs(schema, { city: '上海', action: 'now', days: 'x' }).ok, false);
  assert.equal(validateArgs(schema, { city: '上海', action: 'now', flag: 'yes' }).ok, false);
});

test('enum 之外的取值会被拒，并说明允许什么', () => {
  const r = validateArgs(schema, { city: '上海', action: 'tomorrow' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /now/);
});

test('数值范围会被检查', () => {
  assert.equal(validateArgs(schema, { city: '上海', action: 'now', days: 0 }).ok, false);
  assert.equal(validateArgs(schema, { city: '上海', action: 'now', days: 99 }).ok, false);
  assert.equal(validateArgs(schema, { city: '上海', action: 'now', days: 3 }).ok, true);
});

test('整数型拒绝小数', () => {
  assert.equal(validateArgs(schema, { city: '上海', action: 'now', days: 2.5 }).ok, false);
});

test('多出来的字段被忽略而不是报错（模型偶尔会多塞字段，不值得让它重试一整轮）', () => {
  const r = validateArgs(schema, { city: '上海', action: 'now', extra: 'ignored' });
  assert.equal(r.ok, true);
  assert.equal('extra' in r.value, false);
});

test('数组项会被逐项校验', () => {
  const s = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } }, required: [] };
  assert.equal(validateArgs(s, { tags: ['a', 'b'] }).ok, true);
  assert.equal(validateArgs(s, { tags: ['a', 1] }).ok, false);
});

test('参数不是对象直接拒', () => {
  assert.equal(validateArgs(schema, null).ok, false);
  assert.equal(validateArgs(schema, 'nope').ok, false);
  assert.equal(validateArgs(schema, []).ok, false);
});
