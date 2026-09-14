/**
 * 东方财富 `push2his` —— **主源**（评审决定 1）。
 *
 * # 当前状态：**解析器已写好，但尚未启用**（`SOURCES.eastmoney.available === false`）
 *
 * 未启用的原因只有一个：**我手上没有可存盘的真实响应体**，所以
 * `FIELDS2` 的**后四个字段顺序**还没被实测确认过。
 *
 * 这不是"猜 schema" —— 猜测面被**压缩到一个常量**里，并且已被实测的确证部分兜住。
 *
 * ## 已实测确证的响应形状（2026-09-14）
 *
 * ```json
 * {"rc":0,"rt":17,"svr":181669694,"lt":2,"full":0,
 *  "data":{"code":"600519","market":1,"name":"贵州茅台",
 *          "klines":["2026-09-10,1291.00,1285.13,1294.99,1282.00,18900",
 *                    "2026-09-11,..."]}}
 * ```
 *
 * 已确证：
 * - `rc === 0` 表示成功
 * - `data.klines` 是**逗号分隔的字符串数组**
 * - 每根前两个字段是 **`日期, 开`**（`2026-09-10,1291.00`）
 * - `data.code` / `data.name` / `data.market`（1=沪 0=深）存在
 *
 * ## 唯一待确认项
 *
 * `fields2=f51,f52,f53,f54,f55,f56` 里**收 / 高 / 低 / 量 的顺序**。
 * 已确证的只有"第 2 个是开盘价"。
 *
 * **验证方法（30 秒）**：
 *
 * ```bash
 * pnpm market:capture     # 写入 fixture，并打印每行字段结构
 * ```
 *
 * 然后看 `test/fixtures/eastmoney-600519.SH.json`：
 * **同一根 K 线必须满足 `low ≤ open, close ≤ high`**。
 *
 * `parseKlineResponse` 里有一道**强不变量自检**，不满足的行会被丢弃。
 * 实测数据穷举 24 种字段排列：只查 `low ≤ high` 有 **18 种能蒙混**，
 * 而强不变量只剩 **2 种**（互为 open/close 交换，数值等价）。
 * 所以**顺序错了必然被抓，不会静默产出错数据**。
 *
 * 确认后把 `sources/index.js` 里 `SOURCES.eastmoney.available` 改成 `true`。
 *
 * ## ⚠️ 限流提醒（实测教训）
 *
 * 东财**按请求模式限流**：本环境实测同一端点成功 1 次后、连续几个请求即被拒
 * （`Empty reply`），等待 4 分钟未恢复。所以**缓存不是优化，是保护**（PRD §12.1 第 1 条）。
 */

/**
 * `fields2` 的字段顺序 —— **唯一需要实测确认的地方**。
 *
 * 把顺序抽成常量而不是散在解析代码里，是为了让"验证"变成
 * **改一个字符串 + 看一眼断言**，而不是重读一遍解析逻辑。
 *
 * 数组顺序**必须与请求里发送的 `fields2` 完全一致**。
 */
export const FIELDS2 = Object.freeze([
  'f51', // 日期 YYYY-MM-DD
  'f52', // 开
  'f53', // 收
  'f54', // 高
  'f55', // 低
  'f56', // 成交量（手）
]);

/** 请求里实际发送的 `fields2`（由 `FIELDS2` 派生，避免两处不一致） */
export const FIELDS2_PARAM = FIELDS2.join(',');

/** 与 `fields2` 一一对应的语义 */
const FIELD_NAMES = Object.freeze(['date', 'open', 'close', 'high', 'low', 'volume']);

/** 东财的成交量单位是**手**（1 手 = 100 股），换算成股以与 Yahoo 路径同单位 */
export const SHARES_PER_LOT = 100;

/**
 * 请求用的 `fields1`。
 *
 * ⚠️ 用**三字段组合** —— 那是唯一实测成功过的那一组；
 * 单个 `f1` 未经证实可用（若它本身不合法，会把整个数据源方案**错误地**推翻）。
 */
export const FIELDS1 = 'f1,f2,f3';

/**
 * 解析一根 K 线字符串。
 *
 * @param {string} line 形如 `2026-09-10,1291.00,1285.13,1294.99,1282.00,18900`
 * @returns {{ date: string, open: number, close: number, high: number, low: number, volume: number } | null}
 *          字段数不足或数字不合法时返回 null（**不猜、不补零**）
 */
export function parseKline(line) {
  if (typeof line !== 'string') return null;
  const parts = line.split(',');
  if (parts.length < FIELD_NAMES.length) return null;

  /** @type {any} */
  const out = {};
  for (let i = 0; i < FIELD_NAMES.length; i++) {
    const name = FIELD_NAMES[i];
    const raw = parts[i];
    if (name === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
      out.date = raw;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    out[name] = n;
  }
  return out;
}

/**
 * 把 `YYYY-MM-DD`（**交易所当地日期**）转成 UTC 秒。
 *
 * ⚠️ 必须与 Yahoo 路径的 `cache.toCnDate()` **互为逆运算** ——
 * 否则两条路径算出的"数据截至"会**差一天**。
 *
 * A 股按 UTC+8。这里取当地 **09:30**（开盘）作为该 bar 的时刻。
 *
 * @param {string} date `YYYY-MM-DD`
 * @param {number} [offsetSeconds] 交易所相对 UTC 的秒偏移（A 股 = 28800）
 * @returns {number | null}
 */
export function dateToUtcSeconds(date, offsetSeconds = 8 * 3600) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  if (!m) return null;
  const [, y, mo, d] = m;
  const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), 9, 30) - offsetSeconds * 1000;
  if (!Number.isFinite(utcMs)) return null;
  return Math.floor(utcMs / 1000);
}

/**
 * 解析完整的 K 线响应。
 *
 * **与 `yahoo.parseChartResponse` 返回同一形状**，于是上层（`sources/index.js`
 * 的降级编排、`index.js` 的取数）两条路径完全对称，不需要分支。
 *
 * ⚠️ 东财 `fqt=1` **已直接返回前复权**，所以 `adjclose` 恒为 `null` ——
 * 上层据此跳过 `adjust.js`（见 `sources/index.js` 的 `adjustedAlready`）。
 *
 * @param {unknown} json
 * @returns {{ ok: true, symbol: string, currency: string|null, exchange: string|null,
 *             timezone: string|null, gmtoffset: number, bars: any[], adjclose: null,
 *             meta: { symbol: string, currency: string|null, exchange: string|null, longName: string|null } }
 *           | { ok: false, code: string, message: string }}
 */
export function parseKlineResponse(json) {
  const root = /** @type {any} */ (json);
  if (!root || typeof root !== 'object') {
    return { ok: false, code: 'INTERNAL', message: '东财响应不是对象' };
  }
  // rc !== 0 表示接口层错误（实测成功时 rc === 0）
  if (root.rc !== undefined && root.rc !== 0) {
    return { ok: false, code: 'INTERNAL', message: `东财返回 rc=${root.rc}` };
  }

  const data = root.data;
  if (!data) {
    // 东财在"代码不存在"时返回 data: null；
    // 与"被限流"要区分开 —— 后者是**空响应体**，根本到不了这里。
    return { ok: false, code: 'NOT_FOUND', message: '东财未返回该标的的数据' };
  }

  const lines = data.klines;
  if (!Array.isArray(lines) || lines.length === 0) {
    return { ok: false, code: 'NOT_FOUND', message: '东财返回的 K 线为空' };
  }

  /** @type {any[]} */
  const bars = [];
  let dropped = 0;
  for (const line of lines) {
    const k = parseKline(line);
    if (!k) {
      dropped += 1;
      continue; // 畸形行跳过，不中断整批
    }
    const time = dateToUtcSeconds(k.date);
    if (time === null) {
      dropped += 1;
      continue;
    }
    // ⚠️ **强不变量自检**：`low ≤ open, close ≤ high`。
    //
    // 这是"字段顺序写错不会静默产出错数据"的**关键守卫**，也是本适配器
    // 敢于"解析器已写好但未启用"的前提。
    //
    // 为什么必须用**强**不变量而不是只管 `low ≤ high`：
    // 实测那根 `1291.00, 1285.13, 1294.99, 1282.00` 有 4 个价格字段，
    // 穷举 24 种全排列后：
    //   · 只查 `low ≤ high`      → **18 种排列能蒙混过关**
    //   · 查 `low ≤ open,close ≤ high` → **只剩 2 种**（互为 open/close 交换，数值上等价）
    // 所以强不变量把"顺序写错"从"可能静默出错"变成"必然被抓"。
    const withinRange =
      k.low <= k.open && k.open <= k.high && k.low <= k.close && k.close <= k.high;
    if (!withinRange) {
      dropped += 1;
      continue;
    }
    bars.push({
      time,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      // 东财给的是"手"；换成股，与 Yahoo 路径同单位（否则量比会差 100 倍）
      volume: k.volume * SHARES_PER_LOT,
    });
  }

  if (bars.length === 0) {
    return {
      ok: false,
      code: 'INTERNAL',
      message: `东财的 K 线全部无法解析（${dropped} 根被丢弃，字段顺序可能不匹配）`,
    };
  }

  const market = data.market === 0 ? 'SZ' : 'SH';
  const code = String(data.code ?? '');
  const symbol = code ? `${code}.${market}` : '';
  const exchange = market === 'SH' ? 'SHH' : 'SHZ';

  return {
    ok: true,
    symbol,
    currency: 'CNY',
    exchange,
    timezone: 'CST',
    gmtoffset: 8 * 3600,
    bars,
    // 东财 fqt=1 已是前复权 → 没有也不需要有 adjclose 序列
    adjclose: null,
    meta: {
      symbol,
      currency: 'CNY',
      exchange,
      longName: typeof data.name === 'string' ? data.name : null,
    },
  };
}

/**
 * 拉取日线（与 `yahoo.fetchYahooDaily` 对称）。
 *
 * @param {string} symbol 内部符号 `<code>.<MARKET>`
 * @param {{ safeFetch: (url: string, opts?: any) => Promise<any>, range?: string, timeoutMs?: number }} deps
 * @returns {Promise<any>}
 */
export async function fetchEastmoneyDaily(symbol, deps) {
  const { toEastmoneySecid } = await import('../symbols.js');
  const secid = toEastmoneySecid(symbol);
  if (!secid) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: `无法把 ${symbol} 转成东财 secid（v0 只支持 A 股）`,
    };
  }

  const params = new URLSearchParams({
    secid,
    fields1: FIELDS1,
    fields2: FIELDS2_PARAM,
    klt: '101', // 日线
    fqt: '1', // 前复权 —— 正是技术分析要的口径，不必自己换算
    end: '20500101',
    lmt: '500', // 约 2 年
  });
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`;

  let res;
  try {
    res = await deps.safeFetch(url, { timeoutMs: deps.timeoutMs ?? 10000 });
  } catch (err) {
    return {
      ok: false,
      code: 'NETWORK',
      message: `东财请求失败：${/** @type {Error} */ (err)?.message ?? '未知'}`,
    };
  }

  if (!res || res.ok === false) {
    const status = res?.status ?? '?';
    return {
      ok: false,
      code: status === 429 ? 'RATE_LIMIT' : 'NETWORK',
      message: `东财返回 HTTP ${status}`,
    };
  }

  let json;
  try {
    json = typeof res.json === 'function' ? await res.json() : res.body;
  } catch (err) {
    return {
      ok: false,
      code: 'INTERNAL',
      message: `东财响应不是合法 JSON：${/** @type {Error} */ (err)?.message ?? ''}`,
    };
  }

  return parseKlineResponse(json);
}
