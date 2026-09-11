/**
 * 技能注册表 + 执行闸门（PRD-Skill v0.1 §3/§4）。
 *
 * 用临时目录造技能夹具，因此不动仓库里的真实技能，
 * 也能覆盖"非法技能不带病加载"这类路径。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const registry = await import('../../src/main/skills/registry.js');
const runner = await import('../../src/main/skills/runner.js');
const egress = await import('../../src/main/skills/egress.js');
const { AppError } = await import('../../src/main/brain/errors.js');

/** @type {string} */
let tmpDir;

/**
 * 造一个技能目录。
 * @param {string} dirName
 * @param {Record<string, unknown>} manifest
 * @param {string} body index.js 的内容
 */
function makeSkill(dirName, manifest, body) {
  const dir = path.join(tmpDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), body);
}

/** 一份合法清单的底子 */
function manifest(/** @type {Record<string, unknown>} */ over = {}) {
  return {
    name: 'demo',
    version: '0.1.0',
    description: '测试用技能。',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    permissions: ['db:cache'],
    risk: 'read_only',
    requiresConfirmation: false,
    ...over,
  };
}

test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nono-skills-'));
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 注册表 ──────────────────────────────────────────────────────────

test('加载技能：合法的进注册表，非法的被禁用并报错（不带病加载）', async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  makeSkill('good', manifest({ name: 'good' }), 'export async function run(a){ return { ok:true, summary:"ok" }; }');
  // description 缺失 → 非法
  makeSkill('bad', manifest({ name: 'bad', description: '' }), 'export async function run(){ return { ok:true, summary:"x" }; }');
  // 没有 run 导出 → 非法
  makeSkill('norun', manifest({ name: 'norun' }), 'export const nothing = 1;');
  // skill.json 不是合法 JSON → 非法
  fs.mkdirSync(path.join(tmpDir, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'broken', 'skill.json'), '{ not json');
  // 缺 index.js → 非法
  fs.mkdirSync(path.join(tmpDir, 'noindex'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'noindex', 'skill.json'), JSON.stringify(manifest({ name: 'noindex' })));

  egress.initEgress();
  const res = await registry.loadSkills(tmpDir);

  assert.deepEqual(res.loaded, ['good']);
  assert.deepEqual(res.failed.map((f) => f.name).sort(), ['bad', 'broken', 'noindex', 'norun']);
  assert.equal(registry.get('bad'), undefined);
  assert.equal(registry.errors().length, 4);
});

test('技能声明的域名会进入出网白名单', async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  makeSkill(
    'net',
    manifest({
      name: 'net',
      permissions: ['network:test'],
      networkHosts: ['api.example.com'],
    }),
    'export async function run(){ return { ok:true, summary:"x" }; }',
  );

  egress.initEgress();
  await registry.loadSkills(tmpDir);

  assert.deepEqual(registry.allHosts(), ['api.example.com']);
  assert.ok(egress.listHosts().includes('api.example.com'));
  assert.ok(egress.listHosts().includes('api.deepseek.com'), 'DeepSeek 出口不能被技能挤掉');
});

test('toolSpecs 的形状符合 OpenAI 工具调用格式', async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  makeSkill('good', manifest({ name: 'good' }), 'export async function run(){ return { ok:true, summary:"x" }; }');
  await registry.loadSkills(tmpDir);

  const specs = registry.toolSpecs();
  assert.equal(specs.length, 1);
  assert.equal(specs[0].type, 'function');
  assert.equal(specs[0].function.name, 'good');
  assert.equal(typeof specs[0].function.description, 'string');
  assert.equal(/** @type {any} */ (specs[0].function.parameters).type, 'object');
});

test('目录不存在时不崩，只是没加载到东西', async () => {
  const res = await registry.loadSkills(path.join(tmpDir, 'nope'));
  assert.deepEqual(res.loaded, []);
});

// ── 执行闸门 ────────────────────────────────────────────────────────

async function loadForRun(/** @type {Record<string, unknown>} */ over, /** @type {string} */ body) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  makeSkill('demo', manifest(over), body);
  egress.initEgress();
  await registry.loadSkills(tmpDir);
}

test('闸门①：不存在的技能 → NOT_FOUND', async () => {
  const r = await runner.run('nope', {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_FOUND');
});

test('闸门⑤：参数不合法 → BAD_ARGS，且**不执行**', async () => {
  // 夹具一旦被执行就会抛错 → 若拿到 BAD_ARGS 而不是 INTERNAL，就证明它没被执行
  await loadForRun({}, 'export async function run(){ throw new Error("不该被执行"); }');

  const r = await runner.run('demo', { wrong: 1 });

  assert.equal(r.ok, false);
  assert.equal(r.code, 'BAD_ARGS');
});

test('闸门③：L3（不可逆）→ FORBIDDEN，就算用户想批准也不行', async () => {
  await loadForRun(
    { risk: 'irreversible', requiresConfirmation: true },
    'export async function run(){ return { ok:true, summary:"不该跑到这里" }; }',
  );

  let confirmCalled = false;
  const r = await runner.run('demo', { q: 'x' }, {
    requestConfirmation: async () => {
      confirmCalled = true;
      return true;
    },
  });

  assert.equal(r.ok, false);
  assert.equal(r.code, 'FORBIDDEN');
  assert.equal(confirmCalled, false, 'L3 连确认都不该发起');
});

test('闸门④：L2 且没有确认通道 → DENIED（宁可拒绝也不放行）', async () => {
  await loadForRun(
    { risk: 'local_write', requiresConfirmation: true },
    'export async function run(){ return { ok:true, summary:"不该跑到这里" }; }',
  );
  const r = await runner.run('demo', { q: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DENIED');
});

test('闸门④：L2 且用户拒绝 → DENIED，技能不执行', async () => {
  let ran = false;
  await loadForRun(
    { risk: 'external_send', requiresConfirmation: true },
    'export async function run(){ return { ok:true, summary:"跑了" }; }',
  );
  const r = await runner.run('demo', { q: 'x' }, { requestConfirmation: async () => false });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DENIED');
  assert.equal(ran, false);
});

test('闸门④：L2 且用户批准 → 正常执行', async () => {
  await loadForRun(
    { risk: 'local_write', requiresConfirmation: true },
    'export async function run(a){ return { ok:true, summary:"执行了 " + a.q }; }',
  );
  const r = await runner.run('demo', { q: 'x' }, { requestConfirmation: async () => true });
  assert.equal(r.ok, true);
  assert.equal(r.summary, '执行了 x');
});

test('闸门④：确认超时 → 按拒绝处理', async () => {
  await loadForRun(
    { risk: 'local_write', requiresConfirmation: true, timeoutMs: 300 },
    'export async function run(){ return { ok:true, summary:"不该跑到这里" }; }',
  );
  const r = await runner.run('demo', { q: 'x' }, { requestConfirmation: () => new Promise(() => {}) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DENIED');
});

test('闸门⑥：技能超时 → TIMEOUT，不会挂死对话', async () => {
  await loadForRun({ timeoutMs: 200 }, 'export async function run(){ await new Promise(()=>{}); }');
  const r = await runner.run('demo', { q: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TIMEOUT');
});

test('闸门⑥：技能抛异常 → INTERNAL，把原因带上', async () => {
  await loadForRun({}, 'export async function run(){ throw new Error("底层炸了"); }');
  const r = await runner.run('demo', { q: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INTERNAL');
  assert.match(r.summary, /底层炸了/);
});

test('闸门⑦：summary 被截到 800 字以内（防止第二次请求被撑爆）', async () => {
  await loadForRun({}, 'export async function run(){ return { ok:true, summary:"字".repeat(5000) }; }');
  const r = await runner.run('demo', { q: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.summary.length, 800);
});

test('闸门⑦：技能返回 {ok:false} 会被归一化成失败结果（而不是抛异常）', async () => {
  await loadForRun({}, 'export async function run(){ return { ok:false, code:"NOT_FOUND", message:"查不到" }; }');
  const r = await runner.run('demo', { q: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_FOUND');
  assert.equal(r.summary, '查不到');
});

test('闸门⑦：技能返回空 summary 视为失败', async () => {
  await loadForRun({}, 'export async function run(){ return { ok:true, summary:"  " }; }');
  const r = await runner.run('demo', { q: 'x' });
  assert.equal(r.ok, false);
});

test('技能能拿到注入的 safeFetch（且它受白名单约束）', async () => {
  await loadForRun(
    { permissions: ['network:test'], networkHosts: ['api.example.com'] },
    `export async function run(a, ctx) {
       try { await ctx.safeFetch('https://evil.example.net/x'); return { ok:true, summary:'居然放行了' }; }
       catch (e) { return { ok:false, code: e.code ?? 'X', message: e.message }; }
     }`,
  );
  const r = await runner.run('demo', { q: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EGRESS_DENIED');
});

test('飞行模式下一切技能出网被拒', async () => {
  await loadForRun({}, 'export async function run(a, ctx){ await ctx.safeFetch("https://api.deepseek.com/x"); return {ok:true,summary:"y"}; }');
  egress.setOfflineProbe(() => true);
  try {
    const r = await runner.run('demo', { q: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'EGRESS_DENIED');
  } finally {
    egress.setOfflineProbe(() => false);
  }
});

test('safeFetch 对非 HTTPS 也会拒绝', async () => {
  await assert.rejects(() => egress.safeFetch('http://api.deepseek.com/x'), (/** @type {any} */ e) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, 'EGRESS_DENIED');
    return true;
  });
});
