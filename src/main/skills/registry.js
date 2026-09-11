/**
 * 技能注册表（PRD-Skill v0.1 §3.2 / §7）。
 *
 * 启动时扫一遍 `skills/`，逐个校验清单，合法的才进注册表；
 * **非法的技能直接禁用并报错，不带病加载**。
 *
 * 同时汇总两样东西供审计与闸门使用：
 *   - 权限并集
 *   - 出网域名并集 → 注入 egress 白名单
 *
 * 目录由调用方传入（而不是在这里 import electron 去猜路径），
 * 因此可以在单测里指到一个临时目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import log from '../log.js';
import * as egress from './egress.js';
import { validateManifest } from './schema.js';

/**
 * @typedef {import('./schema.js').SkillManifest} SkillManifest
 * @typedef {{ manifest: SkillManifest, run: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown> }} LoadedSkill
 */

/** @type {Map<string, LoadedSkill>} */
const registry = new Map();

/** @type {string[]} */
let loadErrors = [];

/**
 * 加载代数，用于给动态 import 加 cache-buster。
 *
 * 为什么需要：ESM 按 URL 缓存模块。如果同一个路径被加载两次（重载技能、
 * 或者单测里反复往同一个临时目录写夹具），第二次会拿到**上一次的模块**，
 * 改动看起来"没生效"。加上递增查询串就能强制重新求值。
 */
let loadGeneration = 0;

/**
 * 扫描并加载技能。可重复调用（会先清空）。
 *
 * @param {string} dir 技能目录（每个子目录一个技能）
 * @returns {Promise<{ loaded: string[], failed: { name: string, errors: string[] }[] }>}
 */
export async function loadSkills(dir) {
  registry.clear();
  loadErrors = [];

  /** @type {{ name: string, errors: string[] }[]} */
  const failed = [];

  if (!fs.existsSync(dir)) {
    log.warn('registry.dirMissing', { dir });
    return { loaded: [], failed };
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());

  for (const entry of entries) {
    const skillDir = path.join(dir, entry.name);
    const manifestPath = path.join(skillDir, 'skill.json');

    if (!fs.existsSync(manifestPath)) {
      failed.push({ name: entry.name, errors: ['缺少 skill.json'] });
      continue;
    }

    /** @type {unknown} */
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      failed.push({ name: entry.name, errors: [`skill.json 不是合法 JSON：${String(err)}`] });
      continue;
    }

    const checked = validateManifest(raw, entry.name);
    if (!checked.ok) {
      failed.push({ name: entry.name, errors: checked.errors });
      continue;
    }
    const manifest = checked.value;

    if (registry.has(manifest.name)) {
      failed.push({ name: entry.name, errors: [`技能名重复：${manifest.name} 已被占用`] });
      continue;
    }

    const entryFile = path.join(skillDir, 'index.js');
    if (!fs.existsSync(entryFile)) {
      failed.push({ name: entry.name, errors: ['缺少 index.js'] });
      continue;
    }

    try {
      // 技能是运行时动态加载的，必须用动态 import（ESM）；
      // 带 cache-buster，避免重复加载时拿到上一次缓存的模块
      loadGeneration += 1;
      const url = `${pathToFileURL(entryFile).href}?v=${loadGeneration}`;
      const mod = await import(url);
      if (typeof mod.run !== 'function') {
        failed.push({ name: entry.name, errors: ['index.js 必须导出 run(args, ctx) 函数'] });
        continue;
      }
      registry.set(manifest.name, { manifest, run: mod.run });
      log.info('registry.loaded', { name: manifest.name, risk: manifest.risk, version: manifest.version });
    } catch (err) {
      failed.push({ name: entry.name, errors: [`加载 index.js 失败：${String(err)}`] });
    }
  }

  // 出网域名并集 → 白名单（技能声明的域名是白名单的来源）
  const hosts = allHosts();
  egress.addHosts(hosts);

  for (const f of failed) {
    loadErrors.push(`${f.name}: ${f.errors.join('; ')}`);
    log.error('registry.skillDisabled', { name: f.name, errors: f.errors });
  }

  log.info('registry.ready', {
    loaded: [...registry.keys()],
    failed: failed.map((f) => f.name),
    permissions: allPermissions(),
    hosts,
  });

  return { loaded: [...registry.keys()], failed };
}

/** @param {string} name @returns {LoadedSkill | undefined} */
export function get(name) {
  return registry.get(name);
}

/** @returns {LoadedSkill[]} */
export function list() {
  return [...registry.values()];
}

/** 加载失败的技能（供设置页/审计显示） */
export function errors() {
  return [...loadErrors];
}

/**
 * 转成模型能看懂的工具清单（形状向 MCP 的 tool 定义靠拢）。
 * @returns {{ type: 'function', function: { name: string, description: string, parameters: unknown } }[]}
 */
export function toolSpecs() {
  return list().map(({ manifest }) => ({
    type: /** @type {const} */ ('function'),
    function: {
      name: manifest.name,
      description: manifest.description,
      parameters: manifest.parameters,
    },
  }));
}

/** 给 persona 用的精简版（只有名字和描述） */
export function describeAll() {
  return list().map(({ manifest }) => ({ name: manifest.name, description: manifest.description }));
}

/** @returns {string[]} */
export function allPermissions() {
  const set = new Set();
  for (const { manifest } of registry.values()) for (const p of manifest.permissions) set.add(p);
  return [...set].sort();
}

/** @returns {string[]} */
export function allHosts() {
  const set = new Set();
  for (const { manifest } of registry.values()) for (const h of manifest.networkHosts) set.add(h);
  return [...set].sort();
}
