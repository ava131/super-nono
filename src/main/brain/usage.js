/**
 * 成本统计（PRD-Brain v0.1 §B-6）。
 *
 * v0.1 修订后按**费用**卡每日上限，而不是 token ——
 * 用户对钱敏感、对 token 没概念。
 *
 * ⚠️ 价格来自 `config/pricing.json`，**手工维护**。官方调价后估算会失真，
 * 所以文档与界面都必须写明：估算仅供参考，不保证与账单一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import log from '../log.js';
import { getDb } from '../store/db.js';
import { getCurrentSessionId } from './memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {{ inputPerM: number, cacheHitPerM: number, outputPerM: number }} ModelRate
 * @typedef {{ currency: string, models: Record<string, ModelRate> }} Pricing
 */

/** @type {Pricing | null} */
let pricing = null;

/** @returns {Pricing} */
function loadPricing() {
  if (pricing) return pricing;

  /** @type {Pricing} */
  let loaded = { currency: 'CNY', models: {} };
  const file = path.join(__dirname, '../../../config/pricing.json');
  try {
    loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log.warn('usage.pricing.missing', { file, message: String(err) });
  }

  pricing = loaded;
  return loaded;
}

/**
 * 估算一次调用的费用（单位：元）。
 * @param {string} model
 * @param {{ prompt_tokens?: number, completion_tokens?: number, prompt_cache_hit_tokens?: number }} usage
 * @returns {number}
 */
export function estimateCost(model, usage) {
  const p = loadPricing();
  const rate = p.models[model];
  if (!rate) return 0; // 价格表里没有的模型：不猜，记 0

  const billed = usage.prompt_tokens ?? 0;
  const cached = Math.min(usage.prompt_cache_hit_tokens ?? 0, billed);
  const fresh = Math.max(billed - cached, 0);
  const out = usage.completion_tokens ?? 0;

  const cost = (fresh / 1e6) * rate.inputPerM + (cached / 1e6) * rate.cacheHitPerM + (out / 1e6) * rate.outputPerM;
  // 保留 6 位小数，够精确又不至于浮点噪声
  return Math.round(cost * 1e6) / 1e6;
}

/**
 * 写一条用量记录 —— **这是 token 与费用的唯一记账点**（C-2 修订）。
 *
 * @param {object} params
 * @param {string} params.turnId
 * @param {string} params.model
 * @param {{ prompt_tokens?: number, completion_tokens?: number, prompt_cache_hit_tokens?: number }} params.usage
 * @param {number} params.latencyMs
 * @param {string[]} [params.skillNames]
 */
export function record({ turnId, model, usage, latencyMs, skillNames = [] }) {
  const cost = estimateCost(model, usage);
  getDb()
    .prepare(
      `INSERT INTO usage_log
         (session_id, turn_id, model, tokens_in, tokens_out, cached_tokens, latency_ms, cost_est, skill_names, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      getCurrentSessionId(),
      turnId,
      model,
      usage.prompt_tokens ?? 0,
      usage.completion_tokens ?? 0,
      usage.prompt_cache_hit_tokens ?? 0,
      Math.round(latencyMs),
      cost,
      JSON.stringify(skillNames),
      Date.now(),
    );
  log.debug('usage.recorded', { turnId, model, cost, usage });
  return cost;
}

/** @returns {{ tokensIn: number, tokensOut: number, cachedTokens: number, cost: number, calls: number }} */
export function todayTotals() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const row = /** @type {any} */ (
    getDb()
      .prepare(
        `SELECT
           COALESCE(SUM(tokens_in), 0)     AS tokensIn,
           COALESCE(SUM(tokens_out), 0)    AS tokensOut,
           COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
           COALESCE(SUM(cost_est), 0)      AS cost,
           COUNT(*)                        AS calls
         FROM usage_log WHERE created_at >= ?`,
      )
      .get(start.getTime())
  );

  return {
    tokensIn: row?.tokensIn ?? 0,
    tokensOut: row?.tokensOut ?? 0,
    cachedTokens: row?.cachedTokens ?? 0,
    cost: Math.round((row?.cost ?? 0) * 1e4) / 1e4,
    calls: row?.calls ?? 0,
  };
}

/**
 * 是否已超出今日费用上限。
 * @param {number} limitYuan 0 或负数表示不限制
 * @returns {boolean}
 */
export function isOverBudget(limitYuan) {
  if (!limitYuan || limitYuan <= 0) return false;
  return todayTotals().cost >= limitYuan;
}

/** 供调试面板/设置页显示 */
export function pricingInfo() {
  const p = loadPricing();
  return { currency: p.currency, models: Object.keys(p.models) };
}
