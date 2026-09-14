/**
 * 会话循环（PRD-Brain v0.1 §B-2 / §B-3.1）。
 *
 * 一次「提问 → 回答」的完整流程：
 *   组装上下文 → 请求（流式）→ 若有工具调用则执行并回填 → 再请求 → 落盘
 *
 * 两个刻意的设计：
 *   ① **配置与 provider 都是注入的**，agent 自己不 import settings ——
 *      这样整条循环可以在纯 Node 下用 mock provider 单测（AB7 死循环、
 *      AB12 预算闸门都靠它验证，不用真烧 token）。
 *   ② **工具调用的中间上下文只活在本次请求里**（局部 messages 数组），
 *      只有最终的 user / assistant 文本落库。否则要在数据库里存
 *      tool_calls 结构，为一个"临时对话"付出长期 schema 成本。
 */
import log from '../log.js';
import { AppError, normalize } from './errors.js';
import * as memory from './memory.js';
import { stablePrefix } from './persona.js';
import { DEFAULT_MODEL, streamChat } from './provider.js';
import { record } from './usage.js';

/** 工具调用循环的最大步数（B-2a） */
export const MAX_STEPS = 5;

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 本轮 user 消息的时间前缀。
 *
 * 刻意放在 user 消息里而不是 system 里：时间是每分钟都在变的信息，
 * 放进 system 会让前缀缓存彻底失效（PRD-Brain §B-3.1）。
 *
 * @param {Date} [date]
 * @returns {string} 形如 `[现在是 2026-09-11 14:20 周四]`
 */
export function formatTimePrefix(date = new Date()) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = p(date.getMonth() + 1);
  const d = p(date.getDate());
  const hh = p(date.getHours());
  const mm = p(date.getMinutes());
  return `[现在是 ${y}-${m}-${d} ${hh}:${mm} ${WEEKDAYS[date.getDay()]}]`;
}

/** @type {AbortController | null} */
let currentTurnController = null;

/** 取消当前这一轮（用户点了「停止」） */
export function cancelCurrentTurn() {
  if (currentTurnController) {
    currentTurnController.abort();
    currentTurnController = null;
    return true;
  }
  return false;
}

/** @returns {boolean} */
export function isTurnRunning() {
  return currentTurnController !== null;
}

/**
 * @typedef {{ type: 'state', turnId: string, state: string }
 *   | { type: 'delta', turnId: string, text: string }
 *   | { type: 'message', turnId: string, role: string, text: string, done: boolean }
 *   | { type: 'notice', turnId: string, text: string }
 *   | { type: 'error', turnId: string, code: string, message: string }} AgentEvent
 *
 * @typedef {{ apiKey: string, model?: string, dailyCostLimit?: number, overBudget?: boolean }} AgentConfig
 * @typedef {{ toolSpecs?: () => unknown[], runTool?: (name: string, args: unknown, ctx: object) => Promise<{ ok: boolean, summary: string }>, skills?: { name: string, description: string }[], skillConstraints?: () => string[] }} AgentTools
 */

/**
 * 跑一轮。
 *
 * @param {object} params
 * @param {string} params.text 用户原话（不含时间前缀）
 * @param {(event: AgentEvent) => void} params.emit
 * @param {AgentConfig} params.config
 * @param {AgentTools} [params.tools]
 * @param {(req: { skill: string, args: Record<string, unknown>, level: string }) => Promise<boolean>} [params.requestConfirmation]
 * @param {typeof streamChat} [params.provider] 便于测试注入 mock
 * @returns {Promise<{ turnId: string, text: string }>}
 */
export async function runTurn({ text, emit, config, tools = {}, requestConfirmation, provider = streamChat }) {
  const turnId = memory.newTurnId();

  // 一次只允许跑一轮：新的一轮先掐掉旧的
  cancelCurrentTurn();
  currentTurnController = new AbortController();
  const signal = currentTurnController.signal;

  try {
    return await runRounds({ turnId, text, emit, config, tools, signal, requestConfirmation, provider });
  } catch (err) {
    const appErr = err instanceof AppError ? err : normalize(err);

    if (appErr.code === 'CANCELLED') {
      emit({ type: 'state', turnId, state: 'idle' });
      emit({ type: 'notice', turnId, text: '（已停止）' });
      return { turnId, text: '' };
    }

    // ★ 错误事件必须带**真实的 turnId**。渲染端会丢弃不属于当前轮的事件，
    //   用占位 id 的话这条错误提示会被当成串台扔掉，用户什么都看不到。
    log.warn('agent.turn.failed', { turnId, code: appErr.code });
    emit({ type: 'state', turnId, state: 'error' });
    emit({ type: 'error', turnId, code: appErr.code, message: appErr.message });
    return { turnId, text: '' };
  } finally {
    currentTurnController = null;
  }
}

/**
 * @param {object} params
 * @param {string} params.turnId
 * @param {string} params.text
 * @param {(event: AgentEvent) => void} params.emit
 * @param {AgentConfig} params.config
 * @param {AgentTools} params.tools
 * @param {AbortSignal} params.signal
 * @param {((req: { skill: string, args: Record<string, unknown>, level: string }) => Promise<boolean>) | undefined} params.requestConfirmation
 * @param {typeof streamChat} params.provider
 * @returns {Promise<{ turnId: string, text: string }>}
 */
async function runRounds({ turnId, text, emit, config, tools, signal, requestConfirmation, provider }) {
  if (!config?.apiKey) {
    throw new AppError('AUTH', '还没填 API Key。点右上角 ⚙ 填一下就能聊了。');
  }
  if (config.overBudget) {
    throw new AppError('BUDGET', `今天的额度（¥${config.dailyCostLimit}）用完了，明天再聊吧。`);
  }

  const model = config.model || DEFAULT_MODEL;
  memory.appendMessage({ turnId, role: 'user', content: text });

  const skillList = tools.skills ?? [];
  // 技能专用的提示词约束块（如行情技能的"禁止给买卖建议"），
  // 由注册表按技能名提供 —— 两者都在每次请求里逐字节相同，前缀缓存不受影响
  const skillConstraints = tools.skillConstraints ? tools.skillConstraints() : [];
  const toolSpecs = tools.toolSpecs ? tools.toolSpecs() : [];
  const usedSkills = new Set();

  // ★ 工具调用的中间上下文只活在**本次请求**里，不落库
  /** @type {{ role: string, content: string | null, tool_call_id?: string, tool_calls?: unknown[] }[]} */
  const messages = [
    { role: 'system', content: stablePrefix(skillList, skillConstraints) },
    ...memory.recentMessages(),
  ];

  // 只给**本轮**那条 user 消息加时间前缀，历史保持干净
  const lastUser = messages[messages.length - 1];
  if (lastUser && lastUser.role === 'user') {
    lastUser.content = `${formatTimePrefix()} ${lastUser.content}`;
  }

  for (let step = 0; step < MAX_STEPS; step += 1) {
    emit({ type: 'state', turnId, state: 'think' });

    const startedAt = Date.now();
    let assistantText = '';
    /** @type {{ id: string, name: string, arguments: string }[]} */
    const toolCalls = [];
    /** @type {any} */
    let usageInfo = null;

    for await (const ev of provider({ apiKey: config.apiKey, model, messages, tools: toolSpecs, signal })) {
      if (ev.type === 'text') {
        assistantText += ev.text;
        emit({ type: 'delta', turnId, text: ev.text });
      } else if (ev.type === 'tool_call') {
        toolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
      } else if (ev.type === 'usage') {
        usageInfo = ev.usage;
      }
    }

    // ★ 记账必须放在**每一次模型往返**之后，不能只在"有工具调用"的分支里 ——
    //   否则普通的一问一答根本不会产生用量记录（成本统计直接失真）。
    if (usageInfo) {
      record({
        turnId,
        model,
        usage: usageInfo,
        latencyMs: Date.now() - startedAt,
        skillNames: [...usedSkills],
      });
    }

    // 没有工具调用 → 这就是最终回答
    if (toolCalls.length === 0) {
      const finalText = assistantText.trim() === '' ? '（这次没想出说什么）' : assistantText;
      memory.appendMessage({ turnId, role: 'assistant', content: finalText });
      emit({ type: 'message', turnId, role: 'assistant', text: finalText, done: true });
      emit({ type: 'state', turnId, state: 'idle' });
      return { turnId, text: finalText };
    }

    // 有工具调用：如果模型先说了点什么，先把那段收尾（界面另起一个气泡）
    if (assistantText.trim() !== '') {
      emit({ type: 'message', turnId, role: 'assistant', text: assistantText, done: true });
    }

    // 把 assistant 的 tool_calls 与执行结果追加进**本次请求的上下文**
    messages.push({
      role: 'assistant',
      content: assistantText || null,
      tool_calls: toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      })),
    });

    for (const call of toolCalls) {
      usedSkills.add(call.name);
      emit({ type: 'notice', turnId, text: `（正在用 ${call.name}…）` });

      /** @type {{ ok: boolean, summary: string }} */
      let result;
      if (!tools.runTool) {
        result = { ok: false, summary: `技能系统还没接上，无法执行 ${call.name}。` };
      } else {
        let parsedArgs = {};
        try {
          parsedArgs = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          result = { ok: false, summary: `模型给的参数不是合法 JSON，我执行不了。` };
          messages.push({ role: 'tool', tool_call_id: call.id, content: result.summary });
          continue;
        }
        result = await tools.runTool(call.name, parsedArgs, { signal, requestConfirmation });
      }

      // ★ 只把 summary 回填给模型，不回填整个 data（B-6d：防止上下文被撑爆）
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.summary });
    }
  }

  // 步数用尽
  const giveUp = '我绕了太多圈，先停一下。你换个说法再问我一次？';
  memory.appendMessage({ turnId, role: 'assistant', content: giveUp });
  emit({ type: 'message', turnId, role: 'assistant', text: giveUp, done: true });
  emit({ type: 'state', turnId, state: 'idle' });
  return { turnId, text: giveUp };
}
