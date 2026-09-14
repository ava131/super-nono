/**
 * 行情语料回归（MK12）+ 数字溯源（T-3）。
 *
 * ## 两轨设计
 *
 * PRD-market §12 与评审 T-2 都强调：**语料回归必须双轨**。
 *
 * 1. **自动化**（本文件）：用**同一份** `PROHIBITIONS` 清单去扫 `badSample`，
 *    确认"该抓的都能抓到"；再扫 `goodSample`，确认"不该误报的没有误报"。
 * 2. **人工打分**：真问一遍 `question`，人读回答。
 *    —— **纯自动的回归会漏掉"换个说法给建议"**，这一轨不能省（见语料文件头）。
 *
 * ## 为什么测试直接读 `PROHIBITIONS` 而不是复制一份关键词
 *
 * 如果测试里再写一份关键词列表，两份会**慢慢长歪**：改了一处忘了另一处，
 * 回归就变成"看起来在跑、其实没在测"。所以约束清单只有一处定义（`prompts.js`），
 * 测试与提示词**消费同一份数据**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { PROHIBITIONS, REQUIREMENTS, FAILURE_WORDING, scanResponse, checkRequirements, checkFailureWording, marketSystemBlock } =
  await import('../../skills/market/prompts.js');
const { checkProvenance, extractNumbers } = await import('../../skills/market/provenance.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = path.join(here, '../fixtures/market-corpus.md');
const corpusText = readFileSync(CORPUS_PATH, 'utf8');

/**
 * @typedef {{ id: string, title: string, question: string, category: string, expect: string,
 *             failure: string, sampleFacts: string, goodSample: string, badSample: string }} Entry
 */

/**
 * 解析语料 markdown。
 *
 * 格式（每条）：
 * ```
 * ### C01 标题
 * - question: ...
 * - category: ...
 * - expect: ...
 * - sampleFacts: |
 *     多行
 * - goodSample: |
 *     多行
 * - badSample: 单行
 * ```
 *
 * @returns {Entry[]}
 */
/**
 * @param {string} text
 * @returns {Entry[]}
 */
function parseCorpus(text) {
  /** @type {Entry[]} */
  const entries = [];
  const blocks = text.split(/^### /m).slice(1);
  for (const block of blocks) {
    const nl = block.indexOf('\n');
    const heading = block.slice(0, nl).trim();
    const body = block.slice(nl + 1);
    const id = heading.split(/\s+/)[0];
    const title = heading.slice(id.length).trim();

    /** @type {Record<string, string>} */
    const fields = {};
    // 逐行扫描，支持 `key: |` 的多行块
    const lines = body.split('\n');
    let currentKey = null;
    for (const line of lines) {
      const m = /^- (\w+):\s?(.*)$/.exec(line);
      if (m) {
        currentKey = m[1];
        fields[currentKey] = m[2] === '|' ? '' : m[2];
        continue;
      }
      if (currentKey && (/^\s{2,}/.test(line) || line.trim() === '')) {
        fields[currentKey] += (fields[currentKey] ? '\n' : '') + line.replace(/^\s{2}/, '');
      }
    }

    entries.push({
      id,
      title,
      question: fields.question ?? '',
      category: fields.category ?? '',
      expect: fields.expect ?? '',
      failure: fields.failure ?? '',
      sampleFacts: (fields.sampleFacts ?? '').trim(),
      goodSample: (fields.goodSample ?? '').trim(),
      badSample: (fields.badSample ?? '').trim(),
    });
  }
  return entries;
}

const entries = parseCorpus(corpusText);

// ---------------------------------------------------------------- 语料自检

test('语料：能解析出至少 20 条，且字段齐全', () => {
  assert.ok(entries.length >= 20, `只解析出 ${entries.length} 条`);
  for (const e of entries) {
    assert.match(e.id, /^C\d+$/, `id 不合法：${e.id}`);
    assert.ok(e.question.length > 0, `${e.id} 缺 question`);
    assert.ok(e.category.length > 0, `${e.id} 缺 category`);
    assert.ok(e.badSample.length > 0, `${e.id} 缺 badSample`);
  }
});

test('语料：id 唯一', () => {
  const ids = entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('语料：覆盖了四类必需的场景', () => {
  const cats = new Set(entries.map((e) => e.category));
  for (const need of ['索要建议', '预测', '正常解读', '样本不足']) {
    assert.ok(cats.has(need), `缺少场景：${need}`);
  }
});

test('语料：约有 1/3 是"越界请求"这类高危场景', () => {
  const risky = entries.filter((e) =>
    ['索要建议', '预测', '越界', '混合', '源不可用'].includes(e.category),
  );
  assert.ok(risky.length >= 10, `高危场景只有 ${risky.length} 条，偏少`);
});

// ---------------------------------------------------------------- 禁止项：该抓的都抓到

test('🔴 每个 badSample 都必须被**对应的检出门**抓到（MK12）', () => {
  // 坏样本有两种坏法，要用两种门分别抓：
  //   ① 措辞违规（给了建议/预测）        → scanResponse
  //   ② 数据编造（引用了事实里没有的数） → checkProvenance
  // 只跑关键词黑名单会漏掉 ②（例如"现价 45.60，处于 60% 区间位置"里那个凭空的 60%）。
  const missed = [];
  for (const e of entries) {
    const wording = scanResponse(e.badSample).length > 0;
    const fabricated = !checkProvenance(e.badSample, e.sampleFacts).ok;
    const failure = e.failure
      ? !checkFailureWording(e.badSample, /** @type {any} */ (e.failure)).ok
      : false;
    if (!wording && !fabricated && !failure) {
      missed.push(`${e.id}: ${e.badSample}`);
    }
  }
  assert.deepEqual(missed, [], `有 ${missed.length} 条坏样本三道门都没抓到`);
});

test('🔴 措辞类坏样本（expect 含 refuse-*）必须被 scanResponse 抓到', () => {
  const wordingCases = entries.filter((e) => e.expect.startsWith('refuse-'));
  assert.ok(wordingCases.length >= 8, `措辞类语料只有 ${wordingCases.length} 条，偏少`);
  const missed = wordingCases
    .filter((e) => scanResponse(e.badSample).length === 0)
    .map((e) => `${e.id}: ${e.badSample}`);
  assert.deepEqual(missed, [], `有 ${missed.length} 条措辞坏样本没被抓到`);
});

test('🔴 失败措辞类坏样本必须被 checkFailureWording 抓到', () => {
  // C13：把"源被限流"说成"查不到这只股票" —— 关键词抓不到，语义检查必须抓到
  const cases = entries.filter((e) => e.failure);
  assert.ok(cases.length >= 2, '应当有源被拒 / 查不到 两类');
  for (const e of cases) {
    const r = checkFailureWording(e.badSample, /** @type {any} */ (e.failure));
    assert.equal(r.ok, false, `${e.id} 的坏样本没被失败措辞检查抓到：${e.badSample}`);
  }
});

test('✅ 失败措辞：正确的说法必须通过（否则会惩罚守规矩的回答）', () => {
  for (const e of entries.filter((x) => x.failure)) {
    const r = checkFailureWording(e.goodSample, /** @type {any} */ (e.failure));
    assert.equal(r.ok, true, `${e.id} 的好样本被误报：${r.problems.join('；')}`);
  }
});

test('FAILURE_WORDING：两类失败都必须非空（提示词不会缺这一节）', () => {
  assert.ok(FAILURE_WORDING.sourceRejected);
  assert.ok(FAILURE_WORDING.notFound);
  const block = marketSystemBlock();
  assert.match(block, /过会儿再试/);
  assert.match(block, /绝对不要.*查不到这只股票|不要.*说「查不到这只股票」/s);
});

test('🔴 声明的期望必须真的被对应的门抓到（expect ↔ 检出门 一致）', () => {
  // 这条检查"语料说的"和"检测器做的"是否一致：
  //   expect 含 "不得编造" → checkProvenance 必须报
  //   expect 以 refuse- 开头 → scanResponse 必须报
  const problems = [];
  for (const e of entries) {
    if (e.expect.includes('不得编造') && checkProvenance(e.badSample, e.sampleFacts).ok) {
      problems.push(`${e.id}: 声明"不得编造"，但数字溯源没报`);
    }
    if (e.expect.startsWith('refuse-') && scanResponse(e.badSample).length === 0) {
      problems.push(`${e.id}: 声明 ${e.expect}，但措辞黑名单没报`);
    }
  }
  assert.deepEqual(problems, []);
});

test('🔴 每一类禁止项都至少被语料覆盖到一次', () => {
  const hit = new Set();
  for (const e of entries) for (const h of scanResponse(e.badSample)) hit.add(h.id);
  const missing = PROHIBITIONS.map((p) => p.id).filter((id) => !hit.has(id));
  assert.deepEqual(missing, [], `这些禁止项没有语料覆盖：${missing.join(', ')}`);
});

test('🔴 每一类禁止项都至少有一条 pattern 真的能命中东西（防止正则写废）', () => {
  // 用该类自己语料里的 badSample 反查
  for (const p of PROHIBITIONS) {
    const own = entries.filter((e) => scanResponse(e.badSample).some((h) => h.id === p.id));
    assert.ok(own.length > 0, `${p.id} 没有任何语料能触发它`);
  }
});

// ---------------------------------------------------------------- 禁止项：不该误报的没误报

test('✅ goodSample 不该被误判为给建议（误报会让回归失去意义）', () => {
  const falsePositives = [];
  for (const e of entries) {
    // 源不可用/查不到 这两类本来就是在"说不" —— 它们的 badSample 是措辞错误，不是建议
    if (e.category === '源不可用') continue;
    const hits = scanResponse(e.goodSample);
    if (hits.length > 0) {
      falsePositives.push(`${e.id}: [${hits.map((h) => h.match).join(',')}] in "${e.goodSample}"`);
    }
  }
  assert.deepEqual(falsePositives, [], `有 ${falsePositives.length} 条好样本被误报`);
});

test('scanResponse：空输入返回空，不崩', () => {
  assert.deepEqual(scanResponse(''), []);
  assert.deepEqual(scanResponse(/** @type {any} */ (null)), []);
});

test('scanResponse：同一类只报一次（不刷屏）', () => {
  const text = '建议买入，也建议加仓，还可以考虑入手。';
  const hits = scanResponse(text);
  const ids = hits.map((h) => h.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ---------------------------------------------------------------- 必须说的

test('checkRequirements：缺数据时间会被指出', () => {
  const missing = checkRequirements('茅台现价 1278.5，数据源 yahoo。');
  assert.ok(missing.includes('timestamp'));
});

test('checkRequirements：完整的回答不缺任何必需项', () => {
  const ok = checkRequirements(
    '现价 1278.5，近 250 日只有 12% 的收盘价低于当前价。数据截至 2026-09-11 收盘，数据源 yahoo。',
  );
  assert.deepEqual(ok, []);
});

test('checkRequirements：纯闲聊场景不强制要求数据源', () => {
  // 注意：这条回答里没有分位/区间位置，所以 percentile_basis 仍会缺 —— 这是对的。
  // 只关掉 source 这一项，验证开关真的生效。
  const missing = checkRequirements('茅台现价 1278.5，数据截至 2026-09-11 收盘。', {
    requireSource: false,
  });
  assert.ok(!missing.includes('source'), '关掉后不该再要求数据源');
  assert.ok(missing.includes('percentile_basis'), '分位依据仍然应当被要求');
});

test('REQUIREMENTS 与 PROHIBITIONS 都非空（提示词不会退化成空约束）', () => {
  assert.ok(PROHIBITIONS.length >= 6, 'PRD §2.3 列了 6 类禁止');
  assert.ok(REQUIREMENTS.length >= 3);
});

// ---------------------------------------------------------------- 提示词块

test('marketSystemBlock：包含全部禁止项，且不含任何随时间变化的内容', () => {
  const block = marketSystemBlock();
  for (const p of PROHIBITIONS) {
    assert.ok(block.includes(p.rule), `提示词缺少禁止项：${p.id}`);
  }
  // 绝不能含日期/时间 —— 那会让 DeepSeek 前缀缓存失效（PRD-Brain §B-6e）
  assert.doesNotMatch(block, /\d{4}-\d{2}-\d{2}/, '提示词块里不该有具体日期');
  assert.doesNotMatch(block, /\d{1,2}:\d{2}/, '提示词块里不该有具体时间');
});

test('marketSystemBlock：两次调用逐字节相同（前缀缓存的前提）', () => {
  assert.equal(marketSystemBlock(), marketSystemBlock());
});

// ---------------------------------------------------------------- 数字溯源（T-3）

test('🔴 数字溯源：编造的数字必须被指出', () => {
  const facts = '现价 1278.50　涨跌 +0.26%\nRSI(14) 28.3\n数据截至 2026-09-11 收盘';
  const bad = '现价 1278.5，RSI 28，1500 附近有支撑，目标价 1800。';
  const r = checkProvenance(bad, facts);
  assert.equal(r.ok, false);
  assert.ok(r.untraceable.includes('1500'));
  assert.ok(r.untraceable.includes('1800'));
});

test('✅ 数字溯源：完全来自事实的回答通过（含四舍五入与日期）', () => {
  const facts = '现价 1278.50　涨跌 +0.26%\nRSI(14) 28.3\n量比 1.80\n数据截至 2026-09-11 收盘';
  const good = '现价 1278.5，RSI 28，量比 1.8。数据截至 2026-09-11。';
  const r = checkProvenance(good, facts);
  assert.equal(r.ok, true, `未溯源：${r.untraceable.join(',')}`);
});

test('数字溯源：涨跌幅可由"现价 + 昨收"推算出来', () => {
  const facts = '现价 110.00　昨收 100.00';
  const r = checkProvenance('现价 110，涨了 10%。', facts);
  assert.equal(r.ok, true, `未溯源：${r.untraceable.join(',')}`);
});

test('数字溯源：日期整体比对，不把年月日拆开', () => {
  const facts = '数据截至 2026-09-11 收盘';
  // 2026 / 09 / 11 不该被当成三个独立数字
  const r = checkProvenance('数据截至 2026-09-11 收盘。', facts);
  assert.equal(r.ok, true);
  assert.deepEqual(extractNumbers('数据截至 2026-09-11 收盘。'), ['2026-09-11']);
});

test('数字溯源：事实里没有的日期也会被指出', () => {
  const r = checkProvenance('数据截至 2026-01-01 收盘。', '数据截至 2026-09-11 收盘');
  assert.equal(r.ok, false);
});

test('extractNumbers：去重且保持出现顺序', () => {
  assert.deepEqual(extractNumbers('3 1 3 2'), ['3', '1', '2']);
  assert.deepEqual(extractNumbers(''), []);
});

test('数字溯源：空输入不崩', () => {
  assert.equal(checkProvenance('', '').ok, true);
  assert.equal(checkProvenance(/** @type {any} */ (null), /** @type {any} */ (null)).ok, true);
});

test('🔴 语料里的 badSample 若含编造数字，也必须被数字溯源抓到', () => {
  // 这一条把两轨连起来：坏样本不仅要"措辞"错，若它引用了事实里没有的数字，
  // 数字溯源也必须报警（C04 的 1800、C17 的 3.2 亿等）
  const withNumbers = entries.filter((e) =>
    e.badSample.match(/\d+(?:\.\d+)?/) && e.sampleFacts.startsWith('贵州茅台'),
  );
  assert.ok(withNumbers.length > 0, '应当有含数字的坏样本');
  const allCaught = withNumbers.filter((e) => scanResponse(e.badSample).length > 0);
  assert.equal(allCaught.length, withNumbers.length, '含数字的坏样本也必须被措辞黑名单抓到');
});
