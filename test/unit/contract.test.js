/**
 * 跨模块**契约常量**的一致性检查（`shared/limits.js`）。
 *
 * ## 为什么需要这个测试
 *
 * 这几个常量被**宿主**和**技能**同时消费，两边各写一份字面量的话，
 * 任何一处单独改动都会造成隐蔽 bug：
 *
 * | 常量 | 不一致的后果 |
 * |---|---|
 * | `SUMMARY_LIMIT` | `snapshot.js` 以为能放 800、`runner.js` 截到别的数 → **用户看到残缺数据且无提示** |
 * | `WATCHLIST_LIMIT` | 能加 30 支但 `scan` 只接受 20 → **用户加了却扫不了** |
 *
 * 本测试做两件事：
 *   1. 断言所有引用方拿到的值**确实相同**（防止有人偷偷写回字面量）
 *   2. 断言 `shared/limits.js` 是**唯一定义处**（扫源码，防止绕过）
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');

const LIMITS = await import('../../shared/limits.js');
const runner = await import('../../src/main/skills/runner.js');
const snapshot = await import('../../skills/market/snapshot.js');
const market = await import('../../skills/market/index.js');
const watchlist = await import('../../skills/watchlist/index.js');
const cache = await import('../../skills/market/cache.js');

// ---------------------------------------------------------------- 值一致

test('SUMMARY_LIMIT：runner（截断方）与 snapshot（排版方）拿到的是同一个值', () => {
  assert.equal(runner.SUMMARY_LIMIT, LIMITS.SUMMARY_LIMIT);
  assert.equal(snapshot.SUMMARY_LIMIT, LIMITS.SUMMARY_LIMIT);
  assert.equal(runner.SUMMARY_LIMIT, snapshot.SUMMARY_LIMIT);
});

test('WATCHLIST_LIMIT：watchlist（写入方）与 market.scan（读取方）拿到的是同一个值', () => {
  assert.equal(watchlist.WATCHLIST_LIMIT, LIMITS.WATCHLIST_LIMIT);
  assert.equal(market.WATCHLIST_LIMIT, LIMITS.WATCHLIST_LIMIT);
  assert.equal(watchlist.WATCHLIST_LIMIT, market.WATCHLIST_LIMIT);
});

test('FETCH_WARN_THRESHOLD：与自选上限的关系合理（要留重试余量）', () => {
  assert.equal(cache.FETCH_WARN_THRESHOLD, LIMITS.FETCH_WARN_THRESHOLD);
  assert.ok(
    LIMITS.FETCH_WARN_THRESHOLD > LIMITS.WATCHLIST_LIMIT,
    '告警阈值必须大于自选上限，否则正常的一次 scan 就会误报缓存 bug',
  );
});

test('常量取值符合文档冻结的数值（改了要同步改文档）', () => {
  assert.equal(LIMITS.SUMMARY_LIMIT, 800);
  assert.equal(LIMITS.WATCHLIST_LIMIT, 20);
  assert.equal(LIMITS.FETCH_WARN_THRESHOLD, 25);
});

// ---------------------------------------------------------------- 唯一定义处

/**
 * 扫源码，确认某常量只在一处被"赋值成字面量"。
 *
 * 这是防"有人绕过 shared/limits.js 直接写死"的那道闸门 ——
 * 只比较运行时值是不够的：两份字面量当前恰好相等时测试会通过，隐患仍在。
 *
 * @param {string} name 常量名
 * @param {string} allowedFile 唯一允许出现字面量定义的文件（相对仓库根）
 */
function assertSingleLiteralDefinition(name, allowedFile) {
  /** @type {string[]} */
  const offenders = [];
  const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\d`);

  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
      const rel = path.relative(ROOT, full);
      if (rel === allowedFile) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (re.test(text)) offenders.push(rel);
    }
  };

  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'skills'));
  assert.deepEqual(offenders, [], `${name} 在这些文件里被字面量定义（应改为从 shared/limits.js 引入）`);
}

test('SUMMARY_LIMIT 只在 shared/limits.js 里定义字面量', () => {
  assertSingleLiteralDefinition('SUMMARY_LIMIT', 'shared/limits.js');
});

test('WATCHLIST_LIMIT 只在 shared/limits.js 里定义字面量', () => {
  assertSingleLiteralDefinition('WATCHLIST_LIMIT', 'shared/limits.js');
});

test('FETCH_WARN_THRESHOLD 只在 shared/limits.js 里定义字面量', () => {
  assertSingleLiteralDefinition('FETCH_WARN_THRESHOLD', 'shared/limits.js');
});

// ---------------------------------------------------------------- 契约文件本身

test('shared/limits.js 不 import 任何东西（技能与宿主都要能安全引入）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/limits.js'), 'utf8');
  assert.doesNotMatch(src, /^import\s/m, '它必须是无依赖的纯常量模块');
  assert.doesNotMatch(src, /require\(/, '它必须是无依赖的纯常量模块');
});

test('技能目录里没有任何跨技能 import 宿主内部模块（插件契约）', () => {
  // 技能只应依赖：自己被注入的能力、同技能内的相对模块、以及 shared/
  //
  // ⚠️ 必须**先去掉注释**再扫：`log.js` 的文档里就写着一个
  // `import '../../../src/main/log.js'` 的反例（用来解释"为什么不该这么写"），
  // 不剥注释会把它当成真的违规。
  /** @type {string[]} */
  const bad = [];

  /**
   * 粗略剥掉块注释与行注释（够用即可：我们只需要排除文档里的示例）
   * @param {string} s
   * @returns {string}
   */
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const text = stripComments(fs.readFileSync(full, 'utf8'));
      for (const m of text.matchAll(/(?:^|\n)\s*import[\s\S]*?from\s+'([^']+)'/g)) {
        const spec = m[1];
        // 允许：同技能内的相对路径（不以 .. 开头）
        if (!spec.startsWith('..')) continue;
        // 允许：shared/（纯常量，无依赖）
        if (spec.includes('/shared/')) continue;
        if (spec.includes('src/main/')) {
          bad.push(`${path.relative(ROOT, full)} → ${spec}`);
        }
      }
    }
  };
  walk(path.join(ROOT, 'skills'));
  assert.deepEqual(
    bad,
    [],
    '技能不该 import 宿主内部模块（那会绕过 ctx 注入的能力，如 safeFetch 白名单）',
  );
});
