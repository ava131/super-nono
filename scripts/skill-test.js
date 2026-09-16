#!/usr/bin/env node
/**
 * 单技能直调 CLI（SDD v0.1 §9 的交付物）。
 *
 * **绕过模型**直接执行技能，用来区分"技能坏了"和"模型没调对"。
 * 因为存储层/日志层都已经和 Electron 解耦，这个脚本在纯 Node 下就能跑。
 *
 * 用法：
 *   pnpm skill:list
 *   pnpm skill:test weather '{"city":"上海","action":"now"}'
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as egress from '../src/main/skills/egress.js';
import * as registry from '../src/main/skills/registry.js';
import * as runner from '../src/main/skills/runner.js';
import { initDb } from '../src/main/store/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.join(__dirname, '../skills');

const argv = process.argv.slice(2);

async function bootstrap() {
  // 不注入日志目录：日志只走内存缓冲 + 控制台，不落盘
  egress.initEgress();
  egress.setOfflineProbe(() => argv.includes('--offline'));

  // ★ 必须初始化存储层：技能声明了 `db:cache` 时，runner 会注入 `ctx.store`，
  //   而 `createSkillStore` 内部的 `getDb()` 在未初始化时会抛错。
  //   技能的缓存读写**按设计吞掉异常**（缓存是优化不是正确性），
  //   所以少了这一行不会报错 —— 只会让**缓存静默失效**，
  //   而 CLI 恰恰是"验证缓存有没有生效"最该能用的地方。
  //   用 `:memory:`：这个脚本是单次进程，不需要落盘，也不该污染 nono.db。
  initDb(':memory:');

  const res = await registry.loadSkills(skillsDir);
  return res;
}

function printList() {
  const skills = registry.list();
  if (skills.length === 0) {
    console.log('（没有加载到任何技能）');
  }
  for (const { manifest } of skills) {
    console.log(`\n● ${manifest.name}  v${manifest.version}  [${manifest.risk}]`);
    console.log(`  ${manifest.description}`);
    console.log(`  权限     : ${manifest.permissions.join(', ') || '（无）'}`);
    console.log(`  出网域名 : ${manifest.networkHosts.join(', ') || '（无）'}`);
    console.log(`  超时     : ${manifest.timeoutMs}ms`);
    console.log(`  需要确认 : ${manifest.requiresConfirmation ? '是' : '否'}`);
    const props = /** @type {Record<string, { type?: string, enum?: unknown[] }>} */ (
      manifest.parameters.properties ?? {}
    );
    for (const [k, v] of Object.entries(props)) {
      const allowed = Array.isArray(v.enum) ? ` (${v.enum.join('|')})` : '';
      console.log(`  参数 ${k.padEnd(8)}: ${v.type ?? 'any'}${allowed}`);
    }
  }

  console.log('\n── 权限并集 ──');
  console.log('  ' + (registry.allPermissions().join(', ') || '（无）'));
  console.log('── 出网白名单 ──');
  console.log('  ' + egress.listHosts().join(', '));

  const errs = registry.errors();
  if (errs.length > 0) {
    console.log('\n── 被禁用的技能 ──');
    for (const e of errs) console.log('  ✖ ' + e);
  }
  console.log();
}

async function main() {
  const { failed } = await bootstrap();

  if (argv.includes('--list') || argv.length === 0) {
    printList();
    process.exit(0);
  }

  const name = argv[0];
  const rawArgs = argv[1] ?? '{}';

  /** @type {unknown} */
  let args;
  try {
    args = JSON.parse(rawArgs);
  } catch (err) {
    console.error(`参数不是合法 JSON：${rawArgs}`);
    process.exit(2);
  }

  console.log(`▸ 直接调用技能 ${name}，参数 ${JSON.stringify(args)}\n`);

  /**
   * `--repeat N`：跑 N 次，用来看**缓存有没有生效**（评审 B9）。
   *
   * 为什么需要它：本脚本一个进程只调一次 `runner.run`，所以"同进程第二次命中"
   * 在 CLI 里**天然测不到** —— 而缓存是否生效恰恰是最容易静默失效的一环
   * （key 不合法会让缓存 100% 不工作，且失败被容错吞掉）。
   *
   * 判定方式：第 2 次起 `data.cached` 必须为 `true`；请求次数由技能自己记录在
   * `data.cached` 上，不靠耗时猜测（耗时差会被网络抖动淹没，我为此误报过一次）。
   */
  const repeatIdx = argv.indexOf('--repeat');
  const repeat = repeatIdx >= 0 ? Math.max(1, Number(argv[repeatIdx + 1]) || 1) : 1;

  const startedAt = Date.now();
  /** @type {any} */
  let result;
  /** @type {boolean[]} */
  const cachedFlags = [];

  for (let i = 0; i < repeat; i += 1) {
    const roundStart = Date.now();
    result = await runner.run(name, args, {
      // 直调时若遇到需要确认的技能，在终端里问
      requestConfirmation: async (/** @type {any} */ req) => {
        console.log(`⚠️  技能 ${req.skill} 需要确认（${req.level}）：${JSON.stringify(req.args)}`);
        console.log('   （直调模式默认批准；要拒绝请改用 --offline 或不跑它）');
        return true;
      },
    });
    const cached = result.ok && result.data !== undefined ? !!(/** @type {any} */ (result.data).cached) : null;
    cachedFlags.push(cached === true);
    if (repeat > 1) {
      console.log(
        `  第 ${i + 1}/${repeat} 次：${result.ok ? 'ok' : `fail(${result.code})`}` +
          `${cached === null ? '' : `  cached=${cached}`}  ${Date.now() - roundStart}ms`,
      );
    }
  }
  const ms = Date.now() - startedAt;

  if (repeat > 1) {
    const hits = cachedFlags.slice(1).filter(Boolean).length;
    console.log(
      `\n缓存判定：第 2 次起命中 ${hits}/${repeat - 1} 次 ` +
        `${hits === repeat - 1 ? '✅ 缓存生效' : '❌ 缓存没生效（key 不合法？CLI 没 initDb？）'}`,
    );
    console.log();
  }

  console.log(result.ok ? '✅ 成功' : `❌ 失败（${result.code}）`);
  console.log('─'.repeat(60));
  console.log(result.summary);
  console.log('─'.repeat(60));
  // `data` 不进模型上下文（agent.js 只回填 summary），所以这里是它**唯一的消费者**。
  // 之前这里只打 summary —— 而"绕过模型区分『技能坏了』和『模型没调用它』"
  // 恰恰需要看到技能的原始返回，所以那条规定其实一直没被满足。
  //
  // 注意 `RunResult` 的失败分支**没有** `data` 字段（runner.js 的 typedef），
  // 所以必须先靠 `result.ok` 收窄类型。
  if (result.ok && result.data !== undefined) {
    console.log('data（不进模型上下文，仅供调试）：');
    console.log(JSON.stringify(result.data, null, 2));
    console.log('─'.repeat(60));
  }
  console.log(`耗时 ${ms}ms`);

  if (failed.length > 0) {
    console.log(`\n（另有 ${failed.length} 个技能因清单非法被禁用，用 --list 查看）`);
  }

  process.exit(result.ok ? 0 : 1);
}

void main();
