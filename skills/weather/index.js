/**
 * 天气技能（PRD-Skill v0.1 §6）。
 *
 * 数据源全部**免费且无需 API Key**（这一点是刻意的：v0 的秘密只有 DeepSeek 一个）：
 *   主源 Open-Meteo：先地理编码拿经纬度，再查天气
 *   备源 wttr.in   ：主源挂了才用
 *
 * 出网一律走 `ctx.safeFetch`（主进程注入），域名必须在 skill.json 声明的
 * 白名单里 —— 技能自己碰不到裸 fetch。
 *
 * 硬性规则（§6.4）：
 *   WX-1 同一城市 10 分钟内不重复请求
 *   WX-2 所有数值来自接口，模型不得编造
 *   WX-3 summary 必须带观测时间
 *   WX-4 城市认不出来就明确报错并列候选，不许猜
 *   WX-5 主源失败降级备源；都失败就如实说查不到
 */
import { lookupCity } from './city-fallback.js';
import { describeWeather } from './wmo-codes.js';

/**
 * 主源返回 { json }，备源返回 { simplified }；buildSummary 两种都能吃。
 * @typedef {{ source: string, action: string, json?: any, simplified?: any }} WeatherPayload
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const WTTR_URL = 'https://wttr.in';

/** @type {Map<string, { at: number, value: unknown }>} */
const cache = new Map();

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} factory
 * @returns {Promise<T>}
 */
async function cached(key, factory) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return /** @type {T} */ (hit.value);

  const value = await factory();
  cache.set(key, { at: Date.now(), value });
  // 简单的容量控制，别让它无限长大
  if (cache.size > 100) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return value;
}

/** 便于单测：清空缓存 */
export function clearCache() {
  cache.clear();
}

/**
 * 地理编码：城市名 → 经纬度。
 * @param {string} city
 * @param {(url: string, opts?: object) => Promise<Response>} safeFetch
 * @returns {Promise<{ ok: true, place: { name: string, latitude: number, longitude: number, admin?: string, country?: string } }
 *   | { ok: false, code: string, message: string, candidates?: string[] }>}
 */
async function geocode(city, safeFetch) {
  // 兜底表优先：命中就直接用，连网络都不用走
  const local = lookupCity(city);
  if (local) {
    return { ok: true, place: { name: local.label, latitude: local.latitude, longitude: local.longitude } };
  }

  const url = `${GEOCODE_URL}?name=${encodeURIComponent(city)}&count=5&language=zh&format=json`;
  const res = await safeFetch(url, { timeoutMs: 8000 });
  if (!res.ok) {
    return { ok: false, code: 'INTERNAL', message: `地理编码接口返回 HTTP ${res.status}` };
  }

  const json = /** @type {{ results?: { name: string, latitude: number, longitude: number, admin1?: string, country?: string }[] }} */ (
    await res.json()
  );
  const results = json.results ?? [];

  if (results.length === 0) {
    // WX-4：认不出来就明说，不许猜
    return { ok: false, code: 'NOT_FOUND', message: `找不到叫「${city}」的地方。换个大一点的城市名试试？` };
  }

  const first = results[0];
  if (!first) {
    return { ok: false, code: 'NOT_FOUND', message: `找不到叫「${city}」的地方。` };
  }

  return {
    ok: true,
    place: {
      name: first.name,
      latitude: first.latitude,
      longitude: first.longitude,
      admin: first.admin1,
      country: first.country,
    },
  };
}

/**
 * 主源：Open-Meteo
 * @param {{ latitude: number, longitude: number }} place
 * @param {'now'|'forecast'} action
 * @param {(url: string, opts?: object) => Promise<Response>} safeFetch
 */
async function fetchFromOpenMeteo(place, action, safeFetch) {
  const current = [
    'temperature_2m',
    'relative_humidity_2m',
    'apparent_temperature',
    'precipitation',
    'weather_code',
    'wind_speed_10m',
  ].join(',');

  const url =
    `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&current=${current}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
    `&timezone=auto&forecast_days=4`;

  const res = await safeFetch(url, { timeoutMs: 8000 });
  if (!res.ok) throw new Error(`天气接口返回 HTTP ${res.status}`);

  const json = /** @type {any} */ (await res.json());
  if (!json.current || !json.daily) throw new Error('天气接口返回的数据不完整');

  return { source: 'Open-Meteo', action, json };
}

/**
 * 备源：wttr.in（主源失败才走这里）
 * @param {string} city
 * @param {(url: string, opts?: object) => Promise<Response>} safeFetch
 */
async function fetchFromWttr(city, safeFetch) {
  const res = await safeFetch(`${WTTR_URL}/${encodeURIComponent(city)}?format=j1`, { timeoutMs: 8000 });
  if (!res.ok) throw new Error(`备源返回 HTTP ${res.status}`);

  const json = /** @type {any} */ (await res.json());
  const cur = json.current_condition?.[0];
  if (!cur) throw new Error('备源返回的数据不完整');

  // 归一成 Open-Meteo 的形状，让组装 summary 的逻辑只有一份
  const days = (json.weather ?? []).slice(0, 3).map((/** @type {any} */ d) => ({
    date: d.date,
    min: Number(d.mintempC),
    max: Number(d.maxtempC),
    desc: d.hourly?.[4]?.weatherDesc?.[0]?.value ?? '未知',
  }));

  return {
    source: 'wttr.in',
    action: 'now',
    simplified: {
      temp: Number(cur.temp_C),
      feels: Number(cur.FeelsLikeC),
      humidity: Number(cur.humidity),
      wind: Number(cur.windspeedKmph),
      code: Number(cur.weatherCode),
      desc: cur.weatherDesc?.[0]?.value ?? describeWeather(Number(cur.weatherCode)),
      observedAt: cur.localObsDateTime ?? '',
      days,
    },
  };
}

/**
 * @param {WeatherPayload} payload
 * @param {{ name: string, admin?: string }} place
 * @param {'now'|'forecast'} action
 * @returns {string}
 */
function buildSummary(payload, place, action) {
  const where = place.admin && place.admin !== place.name ? `${place.name}（${place.admin}）` : place.name;

  // 备源的简化结构
  if (/** @type {any} */ (payload).simplified) {
    const s = /** @type {any} */ (payload).simplified;
    const lines = [
      `${where}现在 ${s.temp}°C，${s.desc}，体感 ${s.feels}°C，湿度 ${s.humidity}%，风速 ${s.wind} km/h。`,
      `数据观测时间：${s.observedAt}（当地时间，来源 ${payload.source}）`,
    ];
    if (action === 'forecast' && s.days?.length) {
      lines.push('', '未来几天：');
      for (const d of s.days) lines.push(`· ${d.date} ${d.desc} ${d.min}~${d.max}°C`);
    }
    return lines.join('\n');
  }

  const json = /** @type {any} */ (payload).json;

  if (action === 'now') {
    const c = json.current;
    const unit = json.current_units ?? {};
    return [
      `${where}现在 ${c.temperature_2m}${unit.temperature_2m ?? '°C'}，${describeWeather(c.weather_code)}，` +
        `体感 ${c.apparent_temperature}${unit.apparent_temperature ?? '°C'}，` +
        `湿度 ${c.relative_humidity_2m}${unit.relative_humidity_2m ?? '%'}，` +
        `风速 ${c.wind_speed_10m}${unit.wind_speed_10m ?? ' km/h'}，` +
        `降水 ${c.precipitation}${unit.precipitation ?? ' mm'}。`,
      // WX-3：必须带观测时间，避免把过期数据当实时
      `数据观测时间：${c.time}（当地时间，来源 ${payload.source}）`,
    ].join('\n');
  }

  const d = json.daily;
  const lines = [`${where}未来三天：`];
  for (let i = 0; i < Math.min(3, (d.time ?? []).length); i += 1) {
    lines.push(`· ${d.time[i]} ${describeWeather(d.weather_code?.[i])} ${d.temperature_2m_min?.[i]}~${d.temperature_2m_max?.[i]}°C`);
  }
  lines.push(`（来源 ${payload.source}，预报会变，仅供参考）`);
  return lines.join('\n');
}

/**
 * 技能入口（PRD-Skill §3.3 的执行器契约）。
 *
 * @param {Record<string, unknown>} args 已经过 runner 的参数校验
 * @param {{ safeFetch?: (url: string, opts?: object) => Promise<Response> }} ctx
 * @returns {Promise<{ ok: true, summary: string, data?: unknown } | { ok: false, code: string, message: string }>}
 */
export async function run(args, ctx) {
  const city = String(args.city ?? '').trim();
  const action = /** @type {'now'|'forecast'} */ (args.action === 'forecast' ? 'forecast' : 'now');

  if (!ctx || typeof ctx.safeFetch !== 'function') {
    return { ok: false, code: 'INTERNAL', message: '技能没有拿到出网通道（safeFetch）' };
  }
  const { safeFetch } = ctx;

  // ① 地理编码（带缓存）
  let place;
  try {
    const geo = await cached(`geo:${city}`, () => geocode(city, safeFetch));
    if (!geo.ok) return { ok: false, code: geo.code, message: geo.message };
    place = geo.place;
  } catch (err) {
    return { ok: false, code: 'INTERNAL', message: `查城市的时候出错了：${String(err)}` };
  }

  // ② 天气（带缓存）
  const cacheKey = `wx:${place.latitude},${place.longitude}:${action}`;
  /** @type {WeatherPayload} */
  let payload;
  try {
    payload = await cached(cacheKey, () => fetchFromOpenMeteo(place, action, safeFetch));
  } catch (primaryErr) {
    // WX-5：主源失败 → 降级备源
    try {
      payload = await cached(`wttr:${city}:${action}`, () => fetchFromWttr(place.name, safeFetch));
    } catch (backupErr) {
      return {
        ok: false,
        code: 'INTERNAL',
        message: `天气源都连不上（主源：${String(primaryErr)}；备源：${String(backupErr)}），这次查不到。`,
      };
    }
  }

  const summary = buildSummary(payload, place, action);

  return {
    ok: true,
    summary,
    // 原始数据不进上下文，交给上层决定要不要留
    data: { place, source: payload.source, action },
  };
}
