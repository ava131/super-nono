#!/usr/bin/env node
/**
 * 东财 K 线响应抓取器 —— 用来解锁 `skills/market/sources/eastmoney.js`。
 *
 * ## 为什么需要这个脚本
 *
 * 东财（主源）的解析器**故意留成占位**，因为我没有它的真实响应样本，
 * 而**猜 schema 会让代码在真实数据上静默出错**（本项目已因此吃过两次亏：
 * `node:sqlite` 的 WAL、Yahoo 搜索的中文支持）。
 *
 * 这个脚本把你**已经在跑**的那条命令变成一个可复现的抓取动作：
 * 成功后直接把响应写成项目里的 fixture，并顺手做一份结构自检。
 *
 * ## 用法
 *
 * ```bash
 * pnpm market:capture
 * ```
 *
 * 成功后：
 *   1. 写入 `test/fixtures/eastmoney-600519.SH.json`
 *   2. 打印实测到的字段结构（`data.klines` 每行几个字段、首尾各是什么）
 *   3. 提示下一步（把 `SOURCES.eastmoney.available` 改成 `true` 并补解析器）
 *
 * ## ⚠️ 限流提醒（实测教训）
 *
 * 东财会**按请求模式限流**：约 160 次/10 分钟即硬封（TLS 通、HTTP 层 `Empty reply`）。
 * 本环境实测**同一端点成功 1 次后、连续几个请求即被拒**，等待 4 分钟未恢复。
 *
 * 所以：**这个脚本只发一次请求**，失败就退出，不重试。
 * 如果你想再试，请自己隔一段时间再跑 —— 不要用循环去撞它。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT =
  process.env.NONO_EM_OUT ?? path.join(ROOT, 'test/fixtures/eastmoney-600519.SH.json');

/**
 * 请求参数。
 *
 * ⚠️ `fields1` 用 **`f1,f2,f3`**（三字段）而不是单个 `f1`：
 * 唯一一次成功抓取用的是三字段组合；单字段组合**未经证实可用**，
 * 若它本身不合法，在国内也会报错，会把整个数据源方案**错误地**推翻。
 */
const SECID = '1.600519'; // 1 = 沪市，0 = 深市
const FIELDS1 = 'f1,f2,f3';
const FIELDS2 = 'f51,f52,f53,f54,f55,f56';
const DEFAULT_URL =
  `https://push2his.eastmoney.com/api/qt/stock/kline/get` +
  `?secid=${SECID}&fields1=${FIELDS1}&fields2=${FIELDS2}` +
  `&klt=101&fqt=1&end=20500101&lmt=30`;

/**
 * 允许用 `NONO_EM_URL` 覆盖目标地址。
 *
 * **主要是为了能测这个脚本本身**：拿一个本地桩服务喂它一份真实形状的响应，
 * 就能验证"解析 + 落盘 + 自检"整条路是通的，而不必去撞真实接口的限流。
 */
const URL_ = process.env.NONO_EM_URL ?? DEFAULT_URL;

/** 只发一次，不重试 —— 见文件头的限流说明 */
const res = await fetch(URL_, { signal: AbortSignal.timeout(20000) }).catch((err) => {
  console.error(`\n❌ 请求失败：${err.message}`);
  console.error('   若为 Empty reply / 超时，说明当前 IP 正被限流。过一段时间再试。\n');
  process.exit(1);
});

if (!res.ok) {
  console.error(`\n❌ HTTP ${res.status}`);
  console.error('   429 = 限流；其它状态码请把完整响应贴出来。\n');
  process.exit(1);
}

const text = await res.text();
if (text.trim() === '') {
  console.error('\n❌ 响应体为空（Empty reply 的变体）—— 当前 IP 被限流。过一段时间再试。\n');
  process.exit(1);
}

/** @type {any} */
let json;
try {
  json = JSON.parse(text);
} catch (err) {
  console.error(`\n❌ 响应不是合法 JSON：${err.message}`);
  console.error('   前 300 字符：', text.slice(0, 300), '\n');
  process.exit(1);
}

// ---------------------------------------------------------------- 结构自检

const data = json?.data;
if (!data || !Array.isArray(data.klines) || data.klines.length === 0) {
  console.error('\n❌ 响应里没有 data.klines（可能 secid 不对，或被限流返回了空壳）');
  console.error('   实际结构：', JSON.stringify(json).slice(0, 300), '\n');
  process.exit(1);
}

const lines = data.klines;
const widths = [...new Set(lines.map((/** @type {string} */ k) => k.split(',').length))];

console.log('\n✅ 抓取成功\n');
console.log(`  标的        : ${data.name}（${data.code}）`);
console.log(`  market 字段 : ${data.market}   ← 1=沪市 0=深市`);
console.log(`  K 线根数    : ${lines.length}`);
console.log(`  每行字段数  : ${widths.join(' / ')}${widths.length > 1 ? '  ⚠️ 不一致！请人工确认' : ''}`);
console.log(`  最早一根    : ${lines[0]}`);
console.log(`  最新一根    : ${lines[lines.length - 1]}`);
console.log(`\n  data 顶层键 : ${Object.keys(data).join(', ')}`);

// ---------------------------------------------------------------- 落盘

const slim = {
  _comment: [
    '东财 push2his 的真实响应存档 —— 供 eastmoney 适配器的离线单测使用。',
    `抓取时间：${new Date().toISOString()}`,
    `请求 URL：${URL_}`,
    '',
    '⚠️ fields2 的顺序决定 klines 每行的字段顺序。当前为：',
    `  ${FIELDS2}`,
    '即（按本项目 grep 到的那次成功响应推断，**需以解析实现时的实测为准**）：',
    '  date, open, close, high, low, volume',
    '',
    '启用适配器前请核对：open/close/high/low 的顺序与 volume 的单位。',
  ],
  request: { secid: SECID, fields1: FIELDS1, fields2: FIELDS2, klt: 101, fqt: 1, lmt: 30 },
  response: json,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(slim, null, 2) + '\n');

console.log(`\n📄 已写入 ${path.relative(ROOT, OUT)}`);
console.log('\n下一步：');
console.log('  1. 按实测的字段顺序补 skills/market/sources/eastmoney.js 的解析器');
console.log('  2. 把 sources/index.js 里 SOURCES.eastmoney.available 改成 true');
console.log('  3. 跑 pnpm test 确认新解析器的单测通过\n');
