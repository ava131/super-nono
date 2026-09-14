/**
 * 东财行情接口探针。
 *
 * 用途：**验证"数据源还活着且够快"**，不是验证功能。
 * 数据源哪天失效或变慢，先跑这个，用数字判断是接口变了还是网络抖动。
 *
 * 用法：
 *   node scripts/probe-eastmoney.mjs
 *
 * ⚠️ 方法论（第一版探针在这里栽过）：
 *   **单次采样会被网络抖动彻底污染**。第一版在第一轮采样里量到中位数 3464ms，
 *   于是得出"20 只 scan 要 69 秒"的结论；而同一 URL 连续 20 次实测中位数是
 *   **137ms**、前后段无衰减。
 *   所以这个脚本：**先预热、再重复采样、只报中位数与 P95，从不报单次值**。
 */

const KLINE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const SEARCH = 'https://searchapi.eastmoney.com/api/suggest/get';
const SEARCH_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8'; // 公开的 suggest 端点 token

const FIELDS_FULL = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
const FIELDS_LEAN = 'f51,f52,f53,f54,f55,f56';

const klineUrl = (secid, { fqt = 1, lmt = 250, fields = FIELDS_LEAN } = {}) =>
  `${KLINE}?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=${fields}&klt=101&fqt=${fqt}&end=20500101&lmt=${lmt}`;

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

/**
 * @param {string} url
 * @returns {Promise<{ ms: number, ok: boolean, bytes: number, text: string }>}
 */
async function once(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url);
    const text = await res.text();
    return { ms: Date.now() - t0, ok: res.status === 200, bytes: text.length, text };
  } catch (err) {
    return { ms: Date.now() - t0, ok: false, bytes: 0, text: `ERROR ${err.message}` };
  }
}

/** @param {number[]} xs */
function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0],
    median: s[Math.floor(s.length / 2)],
    p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
    max: s.at(-1),
  };
}

console.log('══ 东财行情接口探针 ══\n');

// ── 0. 预热（第一次请求含 DNS + TLS，必须丢弃）──────────────────
console.log('0. 预热连接…');
const warm = await once(klineUrl('1.600519'));
console.log(`   （预热请求 ${warm.ms}ms，不计入统计）\n`);

// ── 1. 可用性 ───────────────────────────────────────────────────
console.log('1. 可用性（不带任何自定义请求头，与 safeFetch 的发法一致）');
const probe = await once(klineUrl('1.600519', { fields: FIELDS_FULL }));
let name = '?', rows = 0, first = '?', last = '?';
try {
  const j = JSON.parse(probe.text);
  name = j?.data?.name ?? '?';
  const kl = j?.data?.klines ?? [];
  rows = kl.length;
  first = kl[0]?.split(',')[0] ?? '?';
  last = kl.at(-1)?.split(',')[0] ?? '?';
} catch { /* 保持默认 */ }
const available = probe.ok && rows > 0;
console.log(`   HTTP ${probe.ok ? 200 : '非 200'}   ${available ? '✅ 可用' : '❌ 不可用'}`);
console.log(`   ${name}  ${rows} 根  ${first} → ${last}\n`);

// ── 2. 真实场景耗时：20 只不同标的 @200ms（这才是 scan 的真实成本）──
console.log('2. 模拟真实 scan：20 只不同标的，间隔 200ms');
const SECIDS = [
  '1.600519', '0.300750', '1.600900', '1.601398', '0.000001',
  '1.601318', '0.002594', '1.600036', '1.601888', '0.000858',
  '1.600030', '0.300059', '1.601166', '0.002415', '1.600276',
  '1.601012', '0.000333', '1.600887', '1.601288', '0.002304',
];
{
  const lat = [];
  let bad = 0;
  const t0 = Date.now();
  for (const secid of SECIDS) {
    const r = await once(klineUrl(secid));
    lat.push(r.ms);
    if (!r.ok || !r.text.includes('klines')) bad += 1;
    await sleep(200);
  }
  const total = (Date.now() - t0) / 1000;
  const s = stats(lat);
  console.log(`   总耗时 ${total.toFixed(1)}s   失败 ${bad}/20`);
  console.log(`   单次延迟 中位 ${s.median}ms  P95 ${s.p95}ms  最慢 ${s.max}ms`);
  console.log(`   → scan 设计预算应 ≥ ${Math.ceil(total / 5) * 5}s，当前 SDD 定的 30s ${total < 30 ? '✅ 够用' : '❌ 不够'}\n`);
}

// ── 3. 中文名解析 ───────────────────────────────────────────────
console.log('3. 中文名 → 代码');
for (const q of ['茅台', '宁德时代', '长江电力', '不存在的公司zzz']) {
  const r = await once(`${SEARCH}?input=${encodeURIComponent(q)}&type=14&token=${SEARCH_TOKEN}&count=5`);
  /** @type {string[]} */
  let hits = [];
  try {
    hits = (JSON.parse(r.text)?.QuotationCodeTable?.Data ?? []).map((d) => `${d.Name}(${d.Code}.${d.MktNum})`);
  } catch { /* ignore */ }
  console.log(`   ${q.padEnd(16)} ${hits.length ? hits.join(' , ') : '无结果'}`);
  await sleep(300);
}
console.log('   （MktNum: 1=沪  0=深  116=港股  156=美股）\n');

// ── 4. fqt=1 是否真的前复权 ─────────────────────────────────────
console.log('4. fqt=1 前复权有效性（构造：fqt=0 与 fqt=1 对比，找被抹平的跳空）');
{
  const secid = '1.600900'; // 长江电力，长期稳定分红
  const raw = JSON.parse((await once(klineUrl(secid, { fqt: 0, lmt: 650, fields: FIELDS_FULL }))).text)?.data;
  await sleep(300);
  const adj = JSON.parse((await once(klineUrl(secid, { fqt: 1, lmt: 650, fields: FIELDS_FULL }))).text)?.data;

  const closes = (d) => (d?.klines ?? []).map((l) => Number(l.split(',')[2]));
  const dates = (d) => (d?.klines ?? []).map((l) => l.split(',')[0]);
  const rc = closes(raw);
  const ac = closes(adj);

  if (rc.length && ac.length) {
    const rets = (c) => c.slice(1).map((v, i) => (v - c[i]) / c[i]);
    const rr = rets(rc);
    const ar = rets(ac);
    const dd = dates(adj).slice(1);
    let maxDiv = 0, divDay = '';
    for (let i = 0; i < Math.min(rr.length, ar.length); i += 1) {
      const div = Math.abs(rr[i] - ar[i]);
      if (div > maxDiv) { maxDiv = div; divDay = dd[i]; }
    }
    console.log(`   ${raw?.name}  ${rc.length} 根`);
    console.log(`   最早一根比值 ${(ac[0] / rc[0]).toFixed(4)}  最新一根比值 ${(ac.at(-1) / rc.at(-1)).toFixed(6)}`);
    console.log(`   两序列最大收益率差异 ${(maxDiv * 100).toFixed(2)}%（${divDay}）`);
    console.log(`   → ${maxDiv > 0.005 ? '✅ 确有复权效果，可直接用' : '⚠️ 差异极小，需换一只近期除权的票再测'}`);
  } else {
    console.log('   ❌ 取数为空，无法判断');
  }
}

console.log('\n══ 结论 ══');
console.log(`可用性        : ${available ? '✅' : '❌'}`);
console.log('接口          : push2his（历史 K 线）足够；push2（实时报价）更慢且 v0 用不上');
console.log('scan 成本     : 见第 2 节实测');
console.log('复权          : 见第 4 节');
