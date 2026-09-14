/**
 * 符号解析的网络兜底（东财搜索）单测。
 *
 * ## 为什么这个模块必须有测试
 *
 * 内置表只收龙头，所以**新上市的票永远查不到**（用户实测报的"宇树查不到"就是它）。
 * 这条兜底路径是用户唯一能靠名字查到新股的方式 —— 它一旦坏了，
 * 用户又会回到"只能背代码"的处境。
 *
 * ## 形状来自真实实测（2026-09-14）
 *
 * `GET https://searchapi.eastmoney.com/api/suggest/get?input=宇树&type=14&token=…`
 * 返回的**真实结构**（不是猜的）：
 *
 * ```json
 * {"QuotationCodeTable":{"Status":0,"Message":"成功","TotalCount":1,"Data":[
 *   {"Code":"688836","Name":"宇树科技-W","PinYin":"YSKJW","JYS":"23",
 *    "SecurityTypeName":"科创板","QuoteID":"1.688836","UnifiedCode":"688836", ...}]}}
 * ```
 *
 * 关键点：**`QuoteID` 就是 `<market>.<code>`**（1=沪 0=深），
 * 与项目自己的 `toEastmoneySecid()` 格式一致，所以**市场归属不必猜**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { searchSymbol, parseSuggestResponse, quoteIdToSymbol, SEARCH_HOST, SEARCH_TOKEN } =
  await import('../../skills/market/search.js');
const { toEastmoneySecid } = await import('../../skills/market/symbols.js');

/**
 * 照真实实测结构造一条命中
 * @param {string} code
 * @param {string} name
 * @param {string} marketNum
 * @param {string} [typeName]
 */
function hit(code, name, marketNum, typeName = '科创板') {
  return {
    Code: code,
    Name: name,
    PinYin: 'X',
    MarketType: marketNum,
    SecurityTypeName: typeName,
    QuoteID: `${marketNum}.${code}`,
    UnifiedCode: code,
    InnerCode: '1',
    JYS: '23',
    Classify: '23',
  };
}

/**
 * @param {unknown[]} data
 */
function suggestBody(data) {
  return { QuotationCodeTable: { Status: 0, Message: '成功', TotalCount: data.length, Data: data } };
}

// ---------------------------------------------------------------- quoteIdToSymbol

test('quoteIdToSymbol：1=沪 / 0=深，且与 toEastmoneySecid() 互逆', () => {
  assert.deepEqual(quoteIdToSymbol('1.688836'), { symbol: '688836.SH', market: 'SH' });
  assert.deepEqual(quoteIdToSymbol('0.159915'), { symbol: '159915.SZ', market: 'SZ' });

  // 互逆性：本项目的 secid 生成器与这里的反解必须对得上
  for (const sym of ['600519.SH', '300750.SZ', '510300.SH', '159915.SZ']) {
    const secid = toEastmoneySecid(sym);
    assert.equal(quoteIdToSymbol(/** @type {string} */ (secid))?.symbol, sym);
  }
});

test('quoteIdToSymbol：畸形输入返回 null', () => {
  for (const bad of ['', '688836', '1.68883', '2.688836', 'x.y', null, undefined]) {
    assert.equal(quoteIdToSymbol(/** @type {any} */ (bad)), null);
  }
});

// ---------------------------------------------------------------- 解析

test('parseSuggestResponse：解析真实形状（宇树科技）', () => {
  const hits = parseSuggestResponse(suggestBody([hit('688836', '宇树科技-W', '1')]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].code, '688836');
  assert.equal(hits[0].name, '宇树科技-W');
  assert.equal(hits[0].market, 'SH');
  assert.equal(hits[0].securityType, '科创板');
});

test('parseSuggestResponse：ETF 也认（东财把品种写在 SecurityTypeName）', () => {
  const hits = parseSuggestResponse(suggestBody([hit('510300', '沪深300ETF', '1', '基金')]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].code, '510300');
  assert.equal(hits[0].market, 'SH');
});

test('🔴 parseSuggestResponse：**北交所必须挡掉**（内部符号表达不了）', () => {
  // 北交所的 QuoteID 是 `0.8xxxxx`，若不挡，会被当成深市 →
  // 给出一个**查不到数据**的假代码，比直接说"不支持"更糟。
  const hits = parseSuggestResponse(
    suggestBody([hit('830799', '艾融软件', '0'), hit('430047', '诺思兰德', '0')]),
  );
  assert.deepEqual(hits, [], '4/8 开头的北交所代码不该出现在候选里');
});

test('parseSuggestResponse：混合结果里只留沪深', () => {
  const hits = parseSuggestResponse(
    suggestBody([hit('688836', '宇树科技-W', '1'), hit('830799', '艾融软件', '0')]),
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].code, '688836');
});

test('parseSuggestResponse：畸形输入一律空数组，不崩', () => {
  for (const bad of [null, undefined, {}, { QuotationCodeTable: {} }, { QuotationCodeTable: { Data: null } }, 'x', 1]) {
    assert.deepEqual(parseSuggestResponse(bad), []);
  }
});

test('parseSuggestResponse：缺 Code / Name 的条目被跳过', () => {
  const hits = parseSuggestResponse(
    suggestBody([
      { QuoteID: '1.600519', Code: '600519' }, // 缺 Name
      { QuoteID: '1.600519', Name: 'x' }, // 缺 Code
      { Code: '600519', Name: '贵州茅台', QuoteID: 'bad' }, // QuoteID 畸形
      hit('688836', '宇树科技-W', '1'),
    ]),
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].code, '688836');
});

// ---------------------------------------------------------------- 搜索流程

test('searchSymbol：请求 URL 带齐参数，且域名与白名单一致', async () => {
  /** @type {string} */
  let seen = '';
  await searchSymbol('宇树', {
    safeFetch: async (url) => {
      seen = url;
      return { ok: true, json: async () => suggestBody([hit('688836', '宇树科技-W', '1')]) };
    },
  });
  const u = new URL(seen);
  assert.equal(u.hostname, SEARCH_HOST, '域名必须与 skill.json 的 networkHosts 一致');
  assert.equal(u.searchParams.get('input'), '宇树');
  assert.equal(u.searchParams.get('type'), '14', 'type=14 才是"全部证券"');
  assert.equal(u.searchParams.get('token'), SEARCH_TOKEN);
});

test('searchSymbol：空关键词直接返回空，**不发请求**', async () => {
  let called = 0;
  const r = await searchSymbol('   ', {
    safeFetch: async () => {
      called += 1;
      return { ok: true, json: async () => suggestBody([]) };
    },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.hits, []);
  assert.equal(called, 0);
});

test('searchSymbol：正常命中', async () => {
  const r = await searchSymbol('宇树', {
    safeFetch: async () => ({
      ok: true,
      json: async () => suggestBody([hit('688836', '宇树科技-W', '1')]),
    }),
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].code, '688836');
});

test('searchSymbol：safeFetch 抛异常 → NETWORK，不冒泡', async () => {
  const r = await searchSymbol('宇树', {
    safeFetch: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'NETWORK');
});

test('searchSymbol：HTTP 429 → RATE_LIMIT（供上层退避）', async () => {
  const r = await searchSymbol('宇树', { safeFetch: async () => ({ ok: false, status: 429 }) });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'RATE_LIMIT');
});

test('searchSymbol：响应不是合法 JSON → INTERNAL，不冒泡', async () => {
  const r = await searchSymbol('宇树', {
    safeFetch: async () => ({
      ok: true,
      json: async () => {
        throw new Error('Unexpected token');
      },
    }),
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'INTERNAL');
});

test('searchSymbol：搜不到时返回空 hits（不是失败）', async () => {
  const r = await searchSymbol('不存在的票', {
    safeFetch: async () => ({ ok: true, json: async () => suggestBody([]) }),
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.hits, []);
});
