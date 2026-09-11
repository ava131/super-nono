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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.join(__dirname, '../skills');

const argv = process.argv.slice(2);

async function bootstrap() {
  // 不注入日志目录：日志只走内存缓冲 + 控制台，不落盘
  egress.initEgress();
  egress.setOfflineProbe(() => argv.includes('--offline'));
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

  const startedAt = Date.now();
  const result = await runner.run(name, args, {
    // 直调时若遇到需要确认的技能，在终端里问
    requestConfirmation: async (/** @type {any} */ req) => {
      console.log(`⚠️  技能 ${req.skill} 需要确认（${req.level}）：${JSON.stringify(req.args)}`);
      console.log('   （直调模式默认批准；要拒绝请改用 --offline 或不跑它）');
      return true;
    },
  });
  const ms = Date.now() - startedAt;

  console.log(result.ok ? '✅ 成功' : `❌ 失败（${result.code}）`);
  console.log('─'.repeat(60));
  console.log(result.summary);
  console.log('─'.repeat(60));
  console.log(`耗时 ${ms}ms`);

  if (failed.length > 0) {
    console.log(`\n（另有 ${failed.length} 个技能因清单非法被禁用，用 --list 查看）`);
  }

  process.exit(result.ok ? 0 : 1);
}

void main();
