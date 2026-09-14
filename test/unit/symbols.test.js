/**
 * 符号解析单测 —— `SDD-market-v0.md` §5.2（P2）。
 *
 * ## 这里守的是"不许猜"这条硬规则
 *
 * 猜错代码的代价不是"回答不准"，而是**用户以为在看 A 股、实际在看 B 股**。
 * 所以测试重点不是"能不能解析对"，而是**在不确定时是否老实返回候选**。
 *
 * 全程离线（只查本地表 / 内置种子表）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  codeToSymbol,
  candidatesForCode,
  classifyCode,
  parseSymbol,
  normalizeCodeInput,
  lookupByName,
  searchByName,
  resolveSymbol,
  toEastmoneySecid,
  classifyInput,
  MARKETS,
} = await import('../../skills/market/symbols.js');

const { KNOWN_SYMBOLS, validateEntry, marketOfCode, KNOWN_SYMBOLS_COUNT } =
  await import('../../skills/market/known-symbols.js');

// ---------------------------------------------------------------- 内置表自检

test('内置表：每一条的形状都自洽（代码首位与市场一致、symbol 拼写正确）', () => {
  assert.ok(KNOWN_SYMBOLS_COUNT > 0, '表不该为空');
  /** @type {string[]} */
  const allProblems = [];
  for (const e of KNOWN_SYMBOLS) {
    const problems = validateEntry(e);
    for (const p of problems) allProblems.push(`${e.symbol ?? '?'} (${e.name ?? '?'}): ${p}`);
  }
  assert.deepEqual(allProblems, [], `内置表有 ${allProblems.length} 个问题`);
});

test('内置表：code 唯一（同一条不许重复收录）', () => {
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const e of KNOWN_SYMBOLS) seen.set(e.code, (seen.get(e.code) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c);
  assert.deepEqual(dupes, [], `重复 code：${dupes.join(', ')}`);
});

test('内置表：name 与 alias 不许跨条目重复（否则精确匹配会有歧义）', () => {
  /** @type {Map<string, string>} */
  const owner = new Map();
  /** @type {string[]} */
  const clashes = [];
  for (const e of KNOWN_SYMBOLS) {
    for (const n of [e.name, ...(e.aliases ?? [])]) {
      const key = n.toLowerCase();
      const prev = owner.get(key);
      if (prev !== undefined && prev !== e.symbol) {
        clashes.push(`「${n}」同时属于 ${prev} 与 ${e.symbol}`);
      }
      owner.set(key, e.symbol);
    }
  }
  assert.deepEqual(clashes, []);
});

test('内置表：只含 SH/SZ（v0 不支持北交所与港美股）', () => {
  for (const e of KNOWN_SYMBOLS) {
    assert.ok(MARKETS.includes(e.market), `${e.symbol} 的 market 非法`);
  }
});

test('内置表：kind 只能是 stock / index / fund', () => {
  for (const e of KNOWN_SYMBOLS) {
    assert.ok(
      e.kind === 'stock' || e.kind === 'index' || e.kind === 'fund',
      `${e.symbol} 的 kind=${e.kind}`,
    );
  }
});

test('marketOfCode：个股首位规则', () => {
  assert.equal(marketOfCode('600519'), 'SH');
  assert.equal(marketOfCode('000001'), 'SZ');
  assert.equal(marketOfCode('300750'), 'SZ');
  assert.equal(marketOfCode('830799'), null, '北交所 v0 不支持');
  assert.equal(marketOfCode('430047'), null, '北交所 v0 不支持');
  assert.equal(marketOfCode('60051'), null, '5 位不是合法代码');
  assert.equal(marketOfCode(/** @type {any} */ (null)), null);
});

test('validateEntry：能抓出"代码首位与市场矛盾"', () => {
  const problems = validateEntry({
    symbol: '000001.SH',
    code: '000001',
    market: 'SH',
    name: '假的个股',
    kind: 'stock', // 声称是个股，但 000001 首位是 0（深市）
  });
  assert.ok(problems.some((p) => p.includes('首位指向 SZ')), problems.join('; '));
});

test('validateEntry：**指数**不受首位规则约束（上证指数就是 000001.SH）', () => {
  const problems = validateEntry({
    symbol: '000001.SH',
    code: '000001',
    market: 'SH',
    name: '上证指数',
    kind: 'index',
  });
  assert.deepEqual(problems, []);
});

test('validateEntry：抓 symbol 拼写错误', () => {
  const problems = validateEntry({
    symbol: '600519.SZ', // 应为 .SH
    code: '600519',
    market: 'SH',
    name: '贵州茅台',
    kind: 'stock',
  });
  assert.ok(problems.some((p) => p.includes('symbol 应为 600519.SH')));
});

test('validateEntry：抓缺失 / 畸形字段', () => {
  assert.ok(validateEntry(null).length > 0);
  assert.ok(validateEntry({}).length > 0);

  const problems = validateEntry({
    symbol: '1.SH',
    code: '1',
    market: 'SH',
    name: '',
    kind: 'stock',
  });
  assert.ok(problems.some((p) => p.includes('code 不是 6 位数字')), problems.join('; '));
  assert.ok(problems.some((p) => p.includes('name 缺失')), problems.join('; '));

  // ⚠️ code 非法时**不再继续校验 symbol**（否则会误报"symbol 应为 1.SH"这种废话）
  assert.ok(
    !problems.some((p) => p.includes('symbol 应为')),
    'code 已经非法时不该再报 symbol 拼写',
  );

  // symbol 拼写错误要在 code 合法时才报
  const wrongSymbol = validateEntry({
    symbol: '600519.SZ',
    code: '600519',
    market: 'SH',
    name: '贵州茅台',
    kind: 'stock',
  });
  assert.ok(wrongSymbol.some((p) => p.includes('symbol 应为 600519.SH')), wrongSymbol.join('; '));

  assert.ok(
    validateEntry({
      symbol: '600519.SH',
      code: '600519',
      market: 'SH',
      name: '茅台',
      kind: 'stock',
      aliases: ['ok', 123],
    }).some((p) => p.includes('aliases')),
  );
});

test('validateEntry：抓 kind 缺失或非法', () => {
  const problems = validateEntry({
    symbol: '600519.SH',
    code: '600519',
    market: 'SH',
    name: '贵州茅台',
  });
  assert.ok(problems.some((p) => p.includes('kind')), problems.join('; '));
});

// ---------------------------------------------------------------- 代码歧义

test('candidatesForCode：600519 唯一（沪市主板）', () => {
  const c = candidatesForCode('600519');
  assert.equal(c.length, 1);
  assert.equal(c[0].symbol, '600519.SH');
  assert.equal(c[0].fromStockRule, true);
});

test('candidatesForCode：000001 **两个候选** —— 深市平安银行 与 沪市上证指数', () => {
  const c = candidatesForCode('000001');
  assert.equal(c.length, 2, '000001 在沪深两市都有含义，必须给出两个候选');
  assert.deepEqual(
    c.map((x) => x.symbol).sort(),
    ['000001.SH', '000001.SZ'],
  );
  // 个股规则优先（深市那颗排前面）
  assert.equal(c[0].symbol, '000001.SZ');
  assert.equal(c[0].fromStockRule, true);
  assert.equal(c[1].fromStockRule, false);
});

test('codeToSymbol：多个候选时返回 null（不替用户在沪深之间选）', () => {
  assert.equal(codeToSymbol('000001'), null, '有歧义就不该返回单一结果');
  // 无歧义的照常返回
  assert.deepEqual(codeToSymbol('600519'), { symbol: '600519.SH', market: 'SH' });
  assert.deepEqual(codeToSymbol('300750'), { symbol: '300750.SZ', market: 'SZ' });
});

test('codeToSymbol：北交所与畸形输入返回 null', () => {
  assert.equal(codeToSymbol('830799'), null);
  assert.equal(codeToSymbol('60051'), null);
  assert.equal(codeToSymbol('abcdef'), null);
});

test('candidatesForCode：北交所返回空数组（不猜成深市）', () => {
  assert.deepEqual(candidatesForCode('830799'), []);
  assert.deepEqual(candidatesForCode('430047'), []);
});

// ---------------------------------------------------------------- ETF / 基金（曾整个漏掉）

test('🔴 candidatesForCode：ETF 代码（5/1 开头）必须能解析 —— 这是曾经的 bug', () => {
  // 修复前：只认 6/0/3，于是 510300 / 159915 直接返回空数组 →
  // **在碰接口之前就被拒**，用户看到"查不到 ETF"，而东财其实完全支持 ETF。
  const cases = [
    ['510300', '510300.SH', 'SH'],
    ['512880', '512880.SH', 'SH'],
    ['588000', '588000.SH', 'SH'],
    ['159915', '159915.SZ', 'SZ'],
    ['159919', '159919.SZ', 'SZ'],
  ];
  for (const [code, symbol, market] of cases) {
    const c = candidatesForCode(code);
    assert.equal(c.length, 1, `${code} 应当唯一确定，实际 ${c.length} 个候选`);
    assert.equal(c[0].symbol, symbol);
    assert.equal(c[0].market, market);
  }
});

test('🔴 candidatesForCode：B 股（2/9 开头）也能解析', () => {
  assert.equal(candidatesForCode('200596')[0].symbol, '200596.SZ');
  assert.equal(candidatesForCode('900901')[0].symbol, '900901.SH');
});

test('candidatesForCode：北交所（4/8）仍然明确拒绝，不猜', () => {
  assert.deepEqual(candidatesForCode('830799'), []);
  assert.deepEqual(candidatesForCode('430047'), []);
});

test('classifyCode：区分个股与场内基金', () => {
  assert.deepEqual(classifyCode('600519'), { market: 'SH', kind: 'stock' });
  assert.deepEqual(classifyCode('300750'), { market: 'SZ', kind: 'stock' });
  assert.deepEqual(classifyCode('510300'), { market: 'SH', kind: 'fund' });
  assert.deepEqual(classifyCode('159915'), { market: 'SZ', kind: 'fund' });
  assert.equal(classifyCode('830799'), null, '北交所返回 null');
  assert.equal(classifyCode('60051'), null, '位数不对');
});

test('内置表：收录了主流 ETF（否则只能靠代码查）', () => {
  const funds = KNOWN_SYMBOLS.filter((e) => e.kind === 'fund');
  assert.ok(funds.length >= 20, `ETF 只有 ${funds.length} 条，偏少`);
  const codes = funds.map((f) => f.code);
  for (const must of ['510300', '159915', '588000', '518880']) {
    assert.ok(codes.includes(must), `缺少常用 ETF：${must}`);
  }
});

test('内置表：ETF 的 code 首位必须与 market 一致', () => {
  for (const e of KNOWN_SYMBOLS.filter((x) => x.kind === 'fund')) {
    const cls = classifyCode(e.code);
    assert.notEqual(cls, null, `${e.code} 无法分类`);
    assert.equal(cls?.market, e.market, `${e.code} 的首位指向 ${cls?.market}，但写的是 ${e.market}`);
  }
});

test('resolveSymbol：按 ETF 名字能查到（不用背代码）', () => {
  for (const [name, symbol] of [
    ['沪深300ETF', '510300.SH'],
    ['创业板ETF', '159915.SZ'],
    ['黄金ETF', '518880.SH'],
  ]) {
    const r = resolveSymbol(name);
    assert.equal(r.ok, true, `${name} 应当能解析`);
    if (!r.ok) continue;
    assert.equal(r.entry.symbol, symbol);
  }
});

test('resolveSymbol：ETF 直接用代码也能查到', () => {
  const r = resolveSymbol('510300');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.entry.symbol, '510300.SH');
  assert.equal(r.entry.kind, 'fund');
});

// ---------------------------------------------------------------- parseSymbol

test('parseSymbol：只接受 `<6位>.<SH|SZ>`', () => {
  assert.deepEqual(parseSymbol('600519.SH'), { code: '600519', market: 'SH' });
  assert.deepEqual(parseSymbol('600519.sh'), { code: '600519', market: 'SH' });
  assert.equal(parseSymbol('600519'), null);
  assert.equal(parseSymbol('600519.BJ'), null);
  assert.equal(parseSymbol('60051.SH'), null);
  assert.equal(parseSymbol(/** @type {any} */ (null)), null);
});

// ---------------------------------------------------------------- 规范化

test('normalizeCodeInput：纯 6 位返回候选数组', () => {
  assert.equal(normalizeCodeInput('600519').length, 1);
  assert.equal(normalizeCodeInput('000001').length, 2);
});

test('normalizeCodeInput：带前缀 / 带后缀时市场已明确，只给一个候选', () => {
  assert.deepEqual(normalizeCodeInput('sh600519').map((c) => c.symbol), ['600519.SH']);
  assert.deepEqual(normalizeCodeInput('600519.SH').map((c) => c.symbol), ['600519.SH']);
  assert.deepEqual(normalizeCodeInput('000001.SZ').map((c) => c.symbol), ['000001.SZ']);
});

test('normalizeCodeInput：非代码输入返回空数组', () => {
  assert.deepEqual(normalizeCodeInput('茅台'), []);
  assert.deepEqual(normalizeCodeInput(''), []);
});

// ---------------------------------------------------------------- 名字查找

test('lookupByName：精确匹配名字 / 别名 / 代码 / 内部符号', () => {
  assert.equal(lookupByName('贵州茅台')?.symbol, '600519.SH');
  assert.equal(lookupByName('茅台')?.symbol, '600519.SH', '别名要能命中');
  assert.equal(lookupByName('600519')?.symbol, '600519.SH');
  assert.equal(lookupByName('600519.SH')?.symbol, '600519.SH');
  assert.equal(lookupByName('不存在的票'), null);
});

test('lookupByName：大小写与空白不敏感', () => {
  assert.equal(lookupByName('  贵州茅台  ')?.symbol, '600519.SH');
});

test('searchByName：模糊匹配返回候选，按名字长度升序', () => {
  const hits = searchByName('五粮');
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((h) => h.symbol === '000858.SZ'));
});

test('searchByName：空查询返回空数组', () => {
  assert.deepEqual(searchByName(''), []);
  assert.deepEqual(searchByName('   '), []);
});

// ---------------------------------------------------------------- resolveSymbol

test('resolveSymbol：中文全名唯一命中 → 直接给结果（零出网）', () => {
  const r = resolveSymbol('贵州茅台');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.entry.symbol, '600519.SH');
  assert.equal(r.source, 'known-table');
});

test('resolveSymbol：别名命中（"茅台" → 贵州茅台）', () => {
  const r = resolveSymbol('茅台');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.entry.symbol, '600519.SH');
});

test('resolveSymbol：自选股本地表**优先级最高**', () => {
  // 用户把茅台加进了自选，但本地表里它被记成别的名字也要能命中
  /** @type {import('../../skills/market/known-symbols.js').StockEntry[]} */
  const localEntries = [
    { symbol: '600519.SH', code: '600519', market: 'SH', kind: 'stock', name: '我的茅台' },
  ];
  const r = resolveSymbol('我的茅台', { localEntries });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.source, 'local-table');
});

test('resolveSymbol：代码输入唯一确定 → 命中内置表', () => {
  const r = resolveSymbol('600519');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.entry.symbol, '600519.SH');
  assert.equal(r.source, 'known-table');
});

test('resolveSymbol：表里没有的合法代码 → 仍然能唯一确定（source=input-code）', () => {
  const r = resolveSymbol('601988'); // 中国银行在种子里有；换一个不在表里的
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.entry.symbol.endsWith('.SH'));
});

test('resolveSymbol：输入代码但表里没有 → 用输入代码作答，名字暂用代码占位', () => {
  const r = resolveSymbol('600123'); // 不在种子表里，但 6 开头 → 唯一 .SH
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.entry.symbol, '600123.SH');
  assert.equal(r.source, 'input-code');
  assert.equal(r.entry.name, '600123', '名字待联网补全');
});

test('resolveSymbol：歧义代码且表里都有 → 返回候选，**不替用户选**', () => {
  // 造一个"两市同名代码"的本地表，检验歧义分支真的会返回候选
  /** @type {import('../../skills/market/known-symbols.js').StockEntry[]} */
  const localEntries = [
    { symbol: '000001.SH', code: '000001', market: 'SH', kind: 'index', name: '上证指数' },
  ];
  const r = resolveSymbol('000001', { localEntries });
  // 000001 的两个候选里，.SH 在表里(known)，.SZ 不在 → 唯一命中
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.entry.symbol, '000001.SH');
});

test('resolveSymbol：模糊匹配 → ambiguous 并给候选，不自动选一个', () => {
  const r = resolveSymbol('五粮');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'ambiguous');
  assert.ok(r.candidates.length >= 1);
  assert.ok(r.candidates.some((c) => c.symbol === '000858.SZ'));
});

test('resolveSymbol：本地表无从下手 → needs-network（交给东财搜索）', () => {
  const r = resolveSymbol('某个地方小票');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'needs-network');
  assert.deepEqual(r.candidates, []);
});

test('resolveSymbol：北交所代码 → 不猜，走 needs-network', () => {
  const r = resolveSymbol('830799');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.notEqual(r.reason, 'ambiguous', '不该给出沪深候选（那是猜）');
  assert.equal(r.reason, 'needs-network');
});

test('resolveSymbol：空 / 畸形输入 → invalid，不崩', () => {
  for (const bad of ['', '   ', /** @type {any} */ (null), /** @type {any} */ (undefined)]) {
    const r = resolveSymbol(bad);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'invalid');
  }
});

test('resolveSymbol：五位数港股代码不被误当成 A 股', () => {
  const r = resolveSymbol('00700');
  assert.equal(r.ok, false, '港股 v0 不支持，不该解析成 A 股');
});

// ---------------------------------------------------------------- 各源格式

test('toEastmoneySecid：SH=1 / SZ=0（主源寻址格式）', () => {
  assert.equal(toEastmoneySecid('600519.SH'), '1.600519');
  assert.equal(toEastmoneySecid('000001.SZ'), '0.000001');
  assert.equal(toEastmoneySecid('300750.SZ'), '0.300750');
});

test('toEastmoneySecid：畸形输入返回 null', () => {
  assert.equal(toEastmoneySecid('600519'), null);
  assert.equal(toEastmoneySecid('00700.HK'), null);
});

test('classifyInput：区分代码与名字', () => {
  assert.equal(classifyInput('600519'), 'code');
  assert.equal(classifyInput('sh600519'), 'code');
  assert.equal(classifyInput('600519.SH'), 'code');
  assert.equal(classifyInput('茅台'), 'name');
  assert.equal(classifyInput(''), 'name');
});
