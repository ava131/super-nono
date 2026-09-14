/**
 * 人格提示词（PRD-Brain v0.1 §B-3）。
 *
 * **关键约束：系统提示词里绝对不能有随时间变化的内容。**
 * 时间由 agent 拼在本轮 user 消息前面（§B-3.1），这样 system 前缀
 * 一字不变，DeepSeek 的前缀缓存才能真正命中（§B-6e）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import log from '../log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSONA_FILE = path.join(__dirname, '../../../assets/persona.md');

/** @type {string | null} */
let cached = null;

/**
 * 读取人格文本（进程内缓存一次）。可以随时改 assets/persona.md 后重启生效。
 * @returns {string}
 */
export function loadPersona() {
  if (cached !== null) return cached;
  try {
    cached = fs.readFileSync(PERSONA_FILE, 'utf8').trim();
  } catch (err) {
    log.warn('persona.load.failed', { file: PERSONA_FILE, message: String(err) });
    cached = '你是 NONO，一只住在用户桌面上的小型 AI 助手。中文回答，先给结论，简短，不编造实时数据。';
  }
  return cached;
}

/**
 * 组装系统提示词 —— **这个字符串必须逐字节稳定**。
 *
 * ## 为什么约束块是**参数**而不是在这里查表
 *
 * 本文件在 `src/main/brain/` 下（Brain 层），而技能提示词块属于 `skills/`。
 * 如果这里直接 `import '../../../skills/market/prompts.js'`：
 *
 * - 目录深度一改就要跟着改（本轮已经因为相对路径写错两次）
 * - **层与层糊在一起** —— 新增技能要改 Brain 的代码，违反"加技能只加目录"
 *
 * 所以由**注册表**（唯一知道"有哪些技能"的地方）把各技能的提示词块准备好，
 * 经 `agent.js` 传进来。
 *
 * @param {{ name: string, description: string }[]} [skills] 已注册技能
 * @param {string[]} [skillConstraints] 各技能的追加约束块（顺序与 skills 一致）
 * @returns {string}
 */
export function stablePrefix(skills = [], skillConstraints = []) {
  const persona = loadPersona();

  const skillsBlock =
    skills.length > 0
      ? ['## 可用技能', '', ...skills.map((s) => `- \`${s.name}\`：${s.description}`)].join('\n')
      : [
          '## 可用技能',
          '',
          '目前没有接任何技能。所以：**你拿不到任何实时信息**（天气、股价、新闻、当前时间都由用户消息前缀提供）。',
          '被问到实时数据时，直接说查不到，不要猜、不要圆。',
        ].join('\n');

  // 追加技能专用约束：只保留非空块，顺序即 skills 的顺序（保证稳定）
  const extras = skillConstraints.filter((x) => typeof x === 'string' && x !== '');

  return [persona, skillsBlock, ...extras].join('\n\n') + '\n';
}
