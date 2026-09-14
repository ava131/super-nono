/**
 * 技能持久化契约 `ctx.store`（SDD-market §3.1 / 评审决定 9）。
 *
 * ## 为什么需要它
 *
 * 天气技能是无状态的（只有内存缓存），但 **自选股是用户数据**，必须跨重启保留。
 * 这里给技能注入一个**命名空间隔离**的 KV 存储，底层是 `skill_kv` 表。
 *
 * ## ⚠️ 命名空间隔离 ≠ 权限隔离（这是本模块最容易被忽略的地方）
 *
 * 只做命名空间隔离的话，一个声明 `read_only` 的技能**照样能往自己的命名空间里写**。
 * 它写不进别人的，但**它自己的数据正是别的技能会当作可信来源读的东西**
 * （例如 `market` 读 `watchlist` 的自选股）。
 *
 * 所以这里有一个**运行时写闸门**：按技能的 `risk` 决定是否允许写。
 * 光靠"声明层面写死判定条件"解决不了越权调用 —— 那是两个问题。
 *
 * ## 三道约束
 *
 * | 约束 | 值 | 为什么 |
 * |---|---|---|
 * | key 白名单 | `^[a-z0-9_:.-]{1,64}$` | 防越界字符与超长 key |
 * | 单值上限 | 64KB（序列化后） | 防把数据库当垃圾场 |
 * | 单命名空间上限 | 1MB | 单值上限挡不住"写很多个小值" |
 */
import { AppError } from '../brain/errors.js';
import { getDb } from '../store/db.js';
import log from '../log.js';

/**
 * key 允许的形状。
 *
 * ⚠️ **必须允许大写**：SDD-market §5.4 规定的缓存键是
 * `kline:{source}:{symbol}:{range}`，而内部符号是**大写**的（`600519.SH`）。
 * 只允许小写会让**按文档写的键被自己的校验拒掉**。
 *
 * 真正的边界是"不能被 SQL 或路径当成特殊字符"——`^[A-Za-z0-9_:.-]+$` 已经排除了
 * 引号、空白、斜杠等一切危险字符。
 */
export const KEY_PATTERN = /^[A-Za-z0-9_:.-]{1,64}$/;

/** 单个 value（序列化后）的上限 */
export const MAX_VALUE_BYTES = 64 * 1024;

/** 单个命名空间的**总**上限 */
export const MAX_NAMESPACE_BYTES = 1024 * 1024;

/** 可写的风险等级。`read_only` 不在其中 —— 这就是写闸门的依据。 */
const WRITABLE_RISKS = Object.freeze(['local_write', 'local_reversible', 'external_send']);

/**
 * @typedef {object} SkillStore
 * @property {(key: string) => unknown | null} get
 * @property {(key: string, value: unknown) => void} set
 * @property {(key: string) => boolean} delete
 * @property {(prefix?: string) => Array<{ key: string, value: unknown }>} list
 * @property {() => void} clear
 * @property {() => number} usedBytes 本命名空间已用字节数（便于自检）
 * @property {boolean} writable 该技能是否被允许写**用户数据**
 * @property {boolean} cacheWritable 该技能是否被允许写**自己的缓存**（需声明 db:cache）
 * @property {{ get: (k: string) => unknown|null, put: (k: string, v: unknown) => void, drop: (k: string) => boolean, clear: () => void }} cache 私有缓存子 API
 */

/**
 * 校验 key 形状。
 * @param {unknown} key
 * @returns {string} 规范化后的 key
 */
export function checkKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new AppError(
      'BAD_ARGS',
      `store 的 key 不合法：${JSON.stringify(key)}（需匹配 ${KEY_PATTERN}）`,
    );
  }
  return key;
}

/**
 * 序列化 value 并检查单值上限。
 * @param {unknown} value
 * @returns {string}
 */
function serialize(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    throw new AppError('BAD_ARGS', `store 的值无法序列化成 JSON：${String(err)}`);
  }
  if (text === undefined) {
    throw new AppError('BAD_ARGS', 'store 的值无法序列化（undefined / 函数 / Symbol）');
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_VALUE_BYTES) {
    throw new AppError(
      'BAD_ARGS',
      `store 的单个值过大：${bytes} 字节 > 上限 ${MAX_VALUE_BYTES}`,
    );
  }
  return text;
}

/**
 * @param {unknown} text
 * @returns {unknown}
 */
function deserialize(text) {
  try {
    return JSON.parse(/** @type {string} */ (text));
  } catch {
    // 存进去的一定是合法 JSON；解析不了说明库被外部改过
    log.warn('store.corruptValue', {});
    return null;
  }
}

/**
 * 计算某命名空间已占用的字节数。
 * @param {string} namespace
 * @returns {number}
 */
function namespaceBytes(namespace) {
  const row = /** @type {{ n?: number } | undefined} */ (
    getDb()
      .prepare('SELECT COALESCE(SUM(LENGTH(value)), 0) AS n FROM skill_kv WHERE namespace = ?')
      .get(namespace)
  );
  return Number(row?.n ?? 0);
}

/**
 * 跨技能**只读**读取的底层原语。
 *
 * ## 为什么需要它（以及为什么它必须与 `ctx.store` 分开）
 *
 * `ctx.store` 的核心保证是**命名空间隔离**：技能只能看到自己的数据。
 * 但有一个真实的跨技能需求：
 *
 * > `market.scan` 要扫"我的自选股"，而自选股是 `watchlist` 技能的数据。
 *
 * 三种做法里，只有一种是对的：
 *
 * | 做法 | 评价 |
 * |---|---|
 * | 给 `ctx.store` 加个 `readOther(ns)` | ❌ 破坏隔离保证，技能可以随便读别人 |
 * | 把自选股复制一份到 market 的命名空间 | ❌ 两份数据会不同步 |
 * | **由编排层（runner）用本函数读出来，再作为数据传给 market** | ✅ 隔离保证不变，跨技能读取是**显式的、可审计的** |
 *
 * 所以本函数**不注入给技能**，只在 `runner.js` 组装 `ctx` 时使用。
 * 它故意起得很"底层"的名字，免得被当成随手可用的 API。
 *
 * @param {string} namespace
 * @param {string} key
 * @returns {unknown | null}
 */
export function readNamespaceValue(namespace, key) {
  if (typeof namespace !== 'string' || namespace === '') {
    throw new AppError('INTERNAL', 'readNamespaceValue 需要 namespace');
  }
  const k = checkKey(key);
  const row = /** @type {{ value: string } | undefined} */ (
    getDb()
      .prepare('SELECT value FROM skill_kv WHERE namespace = ? AND key = ?')
      .get(namespace, k)
  );
  return row ? deserialize(row.value) : null;
}

/**
 * 跨技能**写入**的底层原语 —— 仅供**宿主代用户操作**使用。
 *
 * ## ⚠️ 它比 `readNamespaceValue` 更危险，所以用途被严格限定
 *
 * 写闸门（`createSkillStore`）防的是"**技能**越权改数据"。
 * 但有一类写入不是技能发起的，而是**用户直接操作界面**产生的，例如：
 *
 * > 用户在气泡的自选名单里点「删除」某一支（PRD-market §8）。
 *
 * 这是**用户的意图**，不是技能的行为 —— 让技能去执行反而绕远路
 * （要过模型的工具链、超时、确认、结果归一化，任何一环出问题用户就删不掉）。
 * 所以由主进程直接写，并**在日志里留痕**便于审计。
 *
 * **不允许**用本函数实现技能内部的存储需求 —— 那必须走 `ctx.store` / `ctx.store.cache`。
 *
 * @param {string} namespace
 * @param {string} key
 * @param {unknown} value
 */
export function writeNamespaceValue(namespace, key, value) {
  if (typeof namespace !== 'string' || namespace === '') {
    throw new AppError('INTERNAL', 'writeNamespaceValue 需要 namespace');
  }
  const k = checkKey(key);
  const text = serialize(value);
  getDb()
    .prepare(
      `INSERT INTO skill_kv (namespace, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(namespace, k, text, Date.now());
}

/**
 * 为一个技能创建 store。
 *
 * @param {string} namespace 技能名（自动隔离）
 * @param {{ risk: string, permissions?: string[] }} manifest 技能声明 —— **写闸门依据**
 * @returns {SkillStore}
 */
export function createSkillStore(namespace, manifest) {
  if (typeof namespace !== 'string' || namespace === '') {
    throw new AppError('INTERNAL', 'createSkillStore 需要 namespace');
  }
  const writable = WRITABLE_RISKS.includes(manifest?.risk);

  /**
   * 缓存写权限：**与用户数据写权限分开**。
   *
   * ## 为什么必须分开（一个真实的规则冲突）
   *
   * `market` 是 `read_only`（它只读行情，完全正确），但 PRD §12.1 又要求它
   * **必须缓存**——因为实测 ~160 次请求就能把东财打硬封，而 `market.scan`
   * 一次要发 20 个请求。于是：
   *
   * - "只读技能不许写 store" → `market` 的缓存静默失效
   * - "缓存失效" → 每次查询都出网 → **用户当天被限流封掉**
   *
   * 两条规则单独看都对，撞在一起就出事。
   *
   * ## 判据：读写这个 namespace 的作者是不是同一个技能
   *
   * 写闸门要保护的是**别的技能会当作可信来源读的数据**（如 `watchlist` 的自选股，
   * 会被 `market` 读）。而一个技能的私有缓存**只有它自己读写**，
   * 污染自己的缓存影响不了任何人 —— 那不是权限问题。
   *
   * 所以：**声明了 `db:cache` 权限的技能，即使 `read_only` 也能写自己的缓存。**
   * 这不是给 `read_only` 开口子，而是承认"用户数据"与"私有缓存"是两种东西。
   */
  const declaredPermissions = Array.isArray(manifest?.permissions) ? manifest.permissions : [];
  const cacheWritable = declaredPermissions.includes('db:cache');

  /**
   * 写闸门：只读技能一旦调用写方法就在这里被拦下。
   *
   * 这里**抛错而不是静默忽略** —— 静默忽略会让"技能以为自己写成功了"
   * 这种 bug 拖到很晚才暴露。
   * @param {string} op
   */
  const guardWrite = (op) => {
    if (!writable) {
      log.warn('store.denied', { namespace, op, risk: manifest?.risk });
      throw new AppError(
        'PERMISSION',
        `技能 ${namespace} 声明为 ${manifest?.risk}，不允许写入 ctx.store（${op}）`,
      );
    }
  };

  /**
   * 缓存闸门：只读技能若声明了 `db:cache`，允许写**自己的**缓存。
   * @param {string} op
   */
  const guardCacheWrite = (op) => {
    if (!cacheWritable) {
      log.warn('store.cacheDenied', { namespace, op, risk: manifest?.risk });
      throw new AppError(
        'PERMISSION',
        `技能 ${namespace} 未声明 db:cache 权限，不允许写缓存（${op}）`,
      );
    }
  };

  return {
    writable,
    cacheWritable,

    get(key) {
      const k = checkKey(key);
      const row = /** @type {{ value: string } | undefined} */ (
        getDb()
          .prepare('SELECT value FROM skill_kv WHERE namespace = ? AND key = ?')
          .get(namespace, k)
      );
      return row ? deserialize(row.value) : null;
    },

    set(key, value) {
      guardWrite('set');
      const k = checkKey(key);
      const text = serialize(value);

      // 单命名空间总上限：先算"替换掉旧值之后"的净增量，避免误伤"改小一个值"
      const existing = /** @type {{ value: string } | undefined} */ (
        getDb()
          .prepare('SELECT value FROM skill_kv WHERE namespace = ? AND key = ?')
          .get(namespace, k)
      );
      const oldBytes = existing ? Buffer.byteLength(existing.value, 'utf8') : 0;
      const newTotal = namespaceBytes(namespace) - oldBytes + Buffer.byteLength(text, 'utf8');
      if (newTotal > MAX_NAMESPACE_BYTES) {
        throw new AppError(
          'BAD_ARGS',
          `技能 ${namespace} 的存储超出上限：${newTotal} > ${MAX_NAMESPACE_BYTES} 字节`,
        );
      }

      getDb()
        .prepare(
          `INSERT INTO skill_kv (namespace, key, value, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(namespace, k, text, Date.now());
    },

    delete(key) {
      guardWrite('delete');
      const k = checkKey(key);
      const info = getDb()
        .prepare('DELETE FROM skill_kv WHERE namespace = ? AND key = ?')
        .run(namespace, k);
      return Number(info.changes ?? 0) > 0;
    },

    list(prefix) {
      const p = prefix === undefined ? '' : checkKey(prefix);
      const rows = /** @type {Array<{ key: string, value: string }>} */ (
        getDb()
          .prepare(
            'SELECT key, value FROM skill_kv WHERE namespace = ? AND key LIKE ? ORDER BY key',
          )
          .all(namespace, `${p}%`)
      );
      return rows.map((r) => ({ key: r.key, value: deserialize(r.value) }));
    },

    clear() {
      guardWrite('clear');
      getDb().prepare('DELETE FROM skill_kv WHERE namespace = ?').run(namespace);
    },

    usedBytes() {
      return namespaceBytes(namespace);
    },

    /**
     * 私有缓存子 API —— **与用户数据分开的写权限**。
     *
     * 只读技能（如 `market`）声明了 `db:cache` 就用它；
     * 走 `set` 仍然会被写闸门拦下（那才是用户数据）。
     */
    cache: {
      get(key) {
        const k = checkKey(key);
        const row = /** @type {{ value: string } | undefined} */ (
          getDb()
            .prepare('SELECT value FROM skill_kv WHERE namespace = ? AND key = ?')
            .get(namespace, k)
        );
        return row ? deserialize(row.value) : null;
      },

      /** `set` 的别名，语义清楚一点：这是"写缓存"，不是"存用户数据" */
      put(key, value) {
        guardCacheWrite('cache.put');
        const k = checkKey(key);
        const text = serialize(value);
        const existing = /** @type {{ value: string } | undefined} */ (
          getDb()
            .prepare('SELECT value FROM skill_kv WHERE namespace = ? AND key = ?')
            .get(namespace, k)
        );
        const oldBytes = existing ? Buffer.byteLength(existing.value, 'utf8') : 0;
        const newTotal = namespaceBytes(namespace) - oldBytes + Buffer.byteLength(text, 'utf8');
        if (newTotal > MAX_NAMESPACE_BYTES) {
          throw new AppError(
            'BAD_ARGS',
            `技能 ${namespace} 的缓存超出上限：${newTotal} > ${MAX_NAMESPACE_BYTES} 字节`,
          );
        }
        getDb()
          .prepare(
            `INSERT INTO skill_kv (namespace, key, value, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(namespace, k, text, Date.now());
      },

      drop(key) {
        guardCacheWrite('cache.drop');
        const k = checkKey(key);
        const info = getDb()
          .prepare('DELETE FROM skill_kv WHERE namespace = ? AND key = ?')
          .run(namespace, k);
        return Number(info.changes ?? 0) > 0;
      },

      clear() {
        guardCacheWrite('cache.clear');
        getDb().prepare('DELETE FROM skill_kv WHERE namespace = ?').run(namespace);
      },
    },
  };
}
