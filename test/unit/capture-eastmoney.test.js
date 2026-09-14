/**
 * 东财抓取探针单测（`scripts/capture-eastmoney-kline.mjs`）。
 *
 * ## 为什么一个"抓数据的脚本"也要测
 *
 * 这个脚本的**唯一职责**就是解封主源解析器 —— 它需要在 PM 的机器上
 * **一次跑通**（东财按请求模式限流，没有"跑几次试试"的余量）。
 *
 * 如果它自己有 bug（解析写错、落盘路径错、自检误判），
 * 用户会得到"抓取失败"的错误结论，**而去怀疑数据源或网络**——
 * 那正好会把整个数据源方案**错误地**推翻。
 *
 * 所以这里用**本地桩服务**喂它一份真实形状的响应，验证整条链路。
 * **完全不碰真实接口。**
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const SCRIPT = path.join(ROOT, 'scripts/capture-eastmoney-kline.mjs');

/**
 * 一份**照实测形状**造的响应。
 *
 * ⚠️ 这不是我猜的 schema —— 它是 2026-09-14 唯一那次成功抓取的**真实形状**：
 * `{rc, rt, svr, lt, full, data: {code, market, name, klines: ["日期,o,c,h,l,v", ...]}}`
 * （完整响应体当时没存下来，所以数值是示意用的，**形状是真的**）。
 */
function stubBody() {
  return JSON.stringify({
    rc: 0,
    rt: 17,
    svr: 181669694,
    lt: 2,
    full: 0,
    data: {
      code: '600519',
      market: 1,
      name: '贵州茅台',
      klines: [
        '2026-09-10,1291.00,1285.13,1294.99,1282.00,18900',
        '2026-09-11,1285.00,1278.50,1290.00,1276.00,1051130',
      ],
    },
  });
}

/**
 * 起一个桩服务，返回给定 body。
 * @param {string} body
 * @param {number} [status]
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
async function startStub(body, status = 200) {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${addr.port}/kline`,
    close: () => new Promise((r) => server.close(() => r(undefined))),
  };
}

/**
 * 跑探针脚本，返回 { code, stdout, stderr, outFile }。
 * @param {{ url?: string, out: string }} opts
 */
async function runProbe({ url, out }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, NONO_EM_URL: url ?? '', NONO_EM_OUT: out },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** 每个用例一个临时输出路径 */
function tmpOut() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'em-probe-')), 'fixture.json');
}

// ---------------------------------------------------------------- 正常路径

test('探针：对真实形状的响应 → 成功落盘，且 fixture 结构正确', async () => {
  const stub = await startStub(stubBody());
  const out = tmpOut();
  try {
    const r = await runProbe({ url: stub.url, out });
    assert.equal(r.code, 0, `脚本应当成功。stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout, /抓取成功/);
    assert.match(r.stdout, /贵州茅台/);
    assert.match(r.stdout, /K 线根数\s*:\s*2/);

    const fixture = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(Array.isArray(fixture._comment) && fixture._comment.length > 0, '要带出处说明');
    assert.equal(fixture.request.secid, '1.600519');
    assert.equal(fixture.request.fqt, 1, '必须是前复权');
    assert.equal(fixture.request.klt, 101, '必须是日线');
    assert.equal(fixture.response.data.klines.length, 2);
    assert.equal(fixture.response.data.name, '贵州茅台');
  } finally {
    await stub.close();
  }
});

test('探针：会打印实测到的字段数，供人工确认 fields2 顺序', async () => {
  const stub = await startStub(stubBody());
  const out = tmpOut();
  try {
    const r = await runProbe({ url: stub.url, out });
    assert.match(r.stdout, /每行字段数\s*:\s*6/);
    assert.match(r.stdout, /最早一根/);
    assert.match(r.stdout, /最新一根/);
  } finally {
    await stub.close();
  }
});

test('探针：字段数不一致时会显式警告（避免解析器照着错的写）', async () => {
  const bad = JSON.stringify({
    rc: 0,
    data: {
      code: '600519',
      market: 1,
      name: '贵州茅台',
      klines: ['2026-09-10,1,2,3,4,5', '2026-09-11,1,2,3,4,5,6'],
    },
  });
  const stub = await startStub(bad);
  const out = tmpOut();
  try {
    const r = await runProbe({ url: stub.url, out });
    assert.match(r.stdout, /不一致/);
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------- 失败路径

test('探针：HTTP 非 200 → 明确失败，且**不写出** fixture', async () => {
  const stub = await startStub('rate limited', 429);
  const out = tmpOut();
  try {
    const r = await runProbe({ url: stub.url, out });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /HTTP 429/);
    assert.match(r.stderr, /限流/);
    assert.equal(fs.existsSync(out), false, '失败时不该留下半成品 fixture');
  } finally {
    await stub.close();
  }
});

test('探针：响应体为空（Empty reply 的变体）→ 判定为被限流', async () => {
  const stub = await startStub('');
  const out = tmpOut();
  try {
    const r = await runProbe({ url: stub.url, out });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /为空|限流/);
    assert.equal(fs.existsSync(out), false);
  } finally {
    await stub.close();
  }
});

test('探针：响应不是合法 JSON → 贴出前 300 字符便于排查', async () => {
  const stub = await startStub('<html>502 Bad Gateway</html>');
  const out = tmpOut();
  try {
    const r = await runProbe({ url: stub.url, out });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /不是合法 JSON/);
    assert.match(r.stderr, /502 Bad Gateway/);
  } finally {
    await stub.close();
  }
});

test('探针：HTTP 200 但没有 data.klines → 失败并打印实际结构', async () => {
  const stub = await startStub(JSON.stringify({ rc: 0, data: null }));
  const out = tmpOut();
  try {
    const r = await runProbe({ url: stub.url, out });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /没有 data\.klines/);
    assert.equal(fs.existsSync(out), false);
  } finally {
    await stub.close();
  }
});

test('探针：连接失败（端口没人听）→ 提示当前 IP 可能被限流', async () => {
  const r = await runProbe({ url: 'http://127.0.0.1:1/kline', out: tmpOut() });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /请求失败|限流/);
});

// ---------------------------------------------------------------- 安全约束

test('探针：只发一次请求，不做重试（东财按请求模式限流）', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(500);
    res.end('boom');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  try {
    await runProbe({ url: `http://127.0.0.1:${addr.port}/kline`, out: tmpOut() });
    assert.equal(hits, 1, `失败时也只能发 1 次请求，实际发了 ${hits} 次`);
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
  }
});

test('探针：默认 URL 指向东财，且默认参数是前复权 / 日线（防止有人改坏）', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /push2his\.eastmoney\.com/);
  assert.match(src, /fqt=1/, '必须请求前复权');
  assert.match(src, /klt=101/, '必须请求日线');
  // 唯一一次成功抓取用的是三字段组合，单字段未经证实
  assert.match(src, /f1,f2,f3/);
});
