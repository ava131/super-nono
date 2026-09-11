/**
 * 气泡打开时该不该给用户一句提示。
 *
 * 为什么要抽成独立模块：这里原来写的是
 *     settings.hasApiKey() ? '（还没接技能，我暂时只能聊天。）' : '还没填 API Key…'
 * —— 那是 M2 还没有技能时写的**硬编码状态文案**。M3 技能接上之后，
 * 那句话就变成了假话，而且是用户实测发现的。
 *
 * 教训：**"当前能力"这类会随版本变化的东西，不能写死在提示语里**，
 * 要么从真实状态推导，要么就别说。抽成纯函数还顺带能单测。
 */

/**
 * @param {object} state
 * @param {boolean} state.hasApiKey 有没有配 API Key
 * @param {number} state.failedSkillCount 清单非法、被禁用的技能数量
 * @param {boolean} state.alreadyHinted 本次运行里是否已经提示过
 * @returns {string | null} null 表示"什么都别说"
 */
export function openHint({ hasApiKey, failedSkillCount, alreadyHinted }) {
  // 没有 Key 就真的用不了，值得主动说一次
  if (!hasApiKey) {
    return alreadyHinted ? null : '还没填 API Key。点右上角 ⚙ 填一下，我就能说话了。';
  }

  // 有 Key 就能聊 —— **技能有几个都不影响"能不能用"**，所以不打扰。
  // 唯一的例外是有技能因为清单写错被禁用了，那是可修的、值得说一句的。
  if (failedSkillCount > 0) {
    return alreadyHinted
      ? null
      : `有 ${failedSkillCount} 个技能没加载成功（清单写错了）。跑 pnpm skill:list 看原因。`;
  }

  return null;
}
