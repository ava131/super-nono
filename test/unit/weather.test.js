/**
 * 天气技能（PRD-Skill v0.1 §6）。
 *
 * 用假的 safeFetch 跑，不真联网 —— 覆盖 AS9/AS11/AS14：
 *   - 数据来自接口、观测时间必须出现在 summary 里
 *   - 城市认不出来时明确报错，绝不编造
 *   - 10 分钟内同城不重复请求
 *   - 主源挂了自动降级备源
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { run, clearCache } = await import('../../skills/weather/index.js');
const { describeWeather } = await import('../../skills/weather/wmo-codes.js');
const { lookupCity } = await import('../../skills/weather/city-fallback.js');

test.beforeEach(() => clearCache());

/** Open-Meteo 的假响应 */
const forecastJson = {
  current: {
    time: '2026-09-11T15:00',
    temperature_2m: 26.3,
    relative_humidity_2m: 60,
    apparent_temperature: 27.1,
    precipitation: 0,
    weather_code: 3,
    wind_speed_10m: 8.5,
  },
  current_units: { temperature_2m: '°C', apparent_temperature: '°C', relative_humidity_2m: '%', wind_speed_10m: 'km/h', precipitation: 'mm' },
  daily: {
    time: ['2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14'],
    weather_code: [3, 61, 2, 0],
    temperature_2m_max: [29.3, 27.5, 30.1, 31.0],
    temperature_2m_min: [24.1, 23.0, 24.5, 25.2],
  },
};

const geocodeJson = {
  results: [{ name: 'Springfield', latitude: 39.78, longitude: -89.65, admin1: 'Illinois', country: 'United States' }],
};

/**
 * 造一个假的 safeFetch，并记录被请求的 URL。
 * @param {{ failHosts?: string[] }} [opts]
 */
function makeSafeFetch(opts = {}) {
  /** @type {string[]} */
  const urls = [];
  /**
   * @param {string} url
   */
  async function safeFetch(url) {
    urls.push(url);
    const host = new URL(url).hostname;
    if (opts.failHosts?.includes(host)) throw new Error(`模拟失败：${host}`);

    if (host === 'geocoding-api.open-meteo.com') {
      return /** @type {any} */ ({ ok: true, json: async () => geocodeJson });
    }
    if (host === 'api.open-meteo.com') {
      return /** @type {any} */ ({ ok: true, json: async () => forecastJson });
    }
    if (host === 'wttr.in') {
      return /** @type {any} */ ({
        ok: true,
        json: async () => ({
          current_condition: [
            {
              temp_C: '18',
              FeelsLikeC: '17',
              humidity: '72',
              windspeedKmph: '11',
              weatherCode: '116',
              weatherDesc: [{ value: 'Partly cloudy' }],
              localObsDateTime: '2026-09-11 03:00 PM',
            },
          ],
          weather: [
            { date: '2026-09-11', mintempC: '15', maxtempC: '21', hourly: [{ weatherDesc: [{ value: 'Partly cloudy' }] }] },
          ],
        }),
      });
    }
    return /** @type {any} */ ({ ok: false, status: 404, json: async () => ({}) });
  }
  return { safeFetch, urls };
}

// ── 纯函数部分 ──────────────────────────────────────────────────────

test('WMO 代码映射到中文', () => {
  assert.equal(describeWeather(0), '晴');
  assert.equal(describeWeather(3), '阴');
  assert.equal(describeWeather(61), '小雨');
  assert.equal(describeWeather(95), '雷阵雨');
});

test('未知的 WMO 代码不编造，明确标未知', () => {
  assert.equal(describeWeather(1234), '未知天气(1234)');
  assert.equal(describeWeather(undefined), '未知天气');
});

test('城市兜底表：带后缀也能命中', () => {
  assert.ok(lookupCity('上海'));
  assert.ok(lookupCity('上海市'));
  assert.ok(lookupCity('广东省') === null || lookupCity('广东省') !== null); // 不崩即可
  assert.equal(lookupCity(''), null);
  assert.equal(lookupCity('不存在的地名zzz'), null);
});

// ── 主流程 ──────────────────────────────────────────────────────────

test('now：summary 带温度、天气描述和**观测时间**（WX-2 / WX-3）', async () => {
  const { safeFetch, urls } = makeSafeFetch();
  const r = await run({ city: '上海', action: 'now' }, { safeFetch });

  assert.equal(r.ok, true);
  assert.match(r.summary, /26\.3/);
  assert.match(r.summary, /阴/);
  assert.match(r.summary, /2026-09-11T15:00/);
  assert.match(r.summary, /观测时间/);
  assert.equal(urls.length, 1, '上海命中兜底表，不该去查地理编码');
});

test('forecast：给出未来三天', async () => {
  const { safeFetch } = makeSafeFetch();
  const r = await run({ city: '上海', action: 'forecast' }, { safeFetch });

  assert.equal(r.ok, true);
  assert.match(r.summary, /未来三天/);
  assert.match(r.summary, /09-12/);
  assert.match(r.summary, /小雨/);
});

test('兜底表没收录的城市会去走地理编码', async () => {
  const { safeFetch, urls } = makeSafeFetch();
  const r = await run({ city: 'Springfield', action: 'now' }, { safeFetch });

  assert.equal(r.ok, true);
  assert.match(r.summary, /Springfield/);
  assert.ok(urls.some((u) => u.includes('geocoding-api')), '应该查过地理编码');
});

test('AS11：城市认不出来时明确报错，**不编造**', async () => {
  const { safeFetch } = makeSafeFetch();
  // 让地理编码返回空结果
  const empty = async (/** @type {string} */ url) => {
    if (url.includes('geocoding-api')) return /** @type {any} */ ({ ok: true, json: async () => ({ results: [] }) });
    return /** @type {any} */ ({ ok: true, json: async () => forecastJson });
  };

  const r = await run({ city: '这个地方不存在', action: 'now' }, { safeFetch: empty });

  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_FOUND');
  assert.match(r.message, /找不到/);
});

test('AS14：同一城市 10 分钟内不重复请求', async () => {
  const { safeFetch, urls } = makeSafeFetch();

  await run({ city: '上海', action: 'now' }, { safeFetch });
  const after1 = urls.length;
  await run({ city: '上海', action: 'now' }, { safeFetch });
  await run({ city: '上海', action: 'now' }, { safeFetch });

  assert.equal(urls.length, after1, '第二次、第三次都应该命中缓存');
});

test('同城不同 action 是两个缓存条目', async () => {
  const { safeFetch, urls } = makeSafeFetch();
  await run({ city: '上海', action: 'now' }, { safeFetch });
  const after1 = urls.length;
  await run({ city: '上海', action: 'forecast' }, { safeFetch });
  assert.ok(urls.length > after1, 'forecast 是另一次请求');
});

test('WX-5：主源挂了自动降级到备源', async () => {
  const { safeFetch, urls } = makeSafeFetch({ failHosts: ['api.open-meteo.com'] });
  const r = await run({ city: '上海', action: 'now' }, { safeFetch });

  assert.equal(r.ok, true);
  assert.match(r.summary, /wttr\.in/, 'summary 里应标明数据来源是备源');
  assert.ok(urls.some((u) => u.includes('wttr.in')));
});

test('主备都挂了 → 如实说查不到，不编数据', async () => {
  const { safeFetch } = makeSafeFetch({ failHosts: ['api.open-meteo.com', 'wttr.in'] });
  const r = await run({ city: '上海', action: 'now' }, { safeFetch });

  assert.equal(r.ok, false);
  assert.match(r.message, /查不到/);
});

test('没有拿到 safeFetch 时明确报错，而不是偷偷用裸 fetch', async () => {
  const r = await run({ city: '上海', action: 'now' }, {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INTERNAL');
  assert.match(r.message, /safeFetch/);
});

test('summary 里不出现 undefined / NaN', async () => {
  const { safeFetch } = makeSafeFetch();
  for (const action of ['now', 'forecast']) {
    const r = await run({ city: '上海', action }, { safeFetch });
    assert.equal(r.ok, true);
    assert.doesNotMatch(/** @type {any} */ (r).summary, /undefined|NaN/);
  }
});
