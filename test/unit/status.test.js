/**
 * 开场提示的推导逻辑。
 *
 * 这个模块的存在本身就是一条教训：原来它在 ipc.js 里是写死的一句话
 *     hasApiKey ? '（还没接技能，我暂时只能聊天。）' : '还没填 API Key…'
 * M3 技能接上之后前半句变成了假话，而且是用户先发现的。
 * 所以现在改成"从真实状态推导"，并且专门测它**不会谎报能力**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { openHint } from '../../src/main/brain/status.js';

test('没配 Key：提示去填，且只提示一次', () => {
  const first = openHint({ hasApiKey: false, failedSkillCount: 0, alreadyHinted: false });
  assert.match(String(first), /API Key/);

  const second = openHint({ hasApiKey: false, failedSkillCount: 0, alreadyHinted: true });
  assert.equal(second, null, '第二次打开不该再念一遍');
});

test('配了 Key 就闭嘴 —— 不管有没有技能（这条防的就是"谎报能力"那个 bug）', () => {
  assert.equal(openHint({ hasApiKey: true, failedSkillCount: 0, alreadyHinted: false }), null);
});

test('提示语里不得出现任何"当前能力"的断言', () => {
  const cases = [
    { hasApiKey: false, failedSkillCount: 0, alreadyHinted: false },
    { hasApiKey: false, failedSkillCount: 2, alreadyHinted: false },
    { hasApiKey: true, failedSkillCount: 0, alreadyHinted: false },
    { hasApiKey: true, failedSkillCount: 2, alreadyHinted: false },
  ];

  // 这些词一旦出现在开场提示里，就意味着又把"当前有什么能力"写死了
  const forbidden = [/暂时只能/, /还没接/, /没有技能/, /不能查/];

  for (const c of cases) {
    const text = openHint(c);
    if (text === null) continue;
    for (const re of forbidden) {
      assert.doesNotMatch(text, re, `开场提示里不该出现「${re}」这类能力断言：${text}`);
    }
  }
});

test('有技能因为清单写错被禁用时，用 Key 也会说一句（可修的、值得说的）', () => {
  const text = openHint({ hasApiKey: true, failedSkillCount: 2, alreadyHinted: false });
  assert.match(String(text), /2 个技能/);
  assert.match(String(text), /skill:list/);

  assert.equal(openHint({ hasApiKey: true, failedSkillCount: 2, alreadyHinted: true }), null);
});

test('没 Key 时优先说 Key 的事，不让技能错误抢戏', () => {
  const text = openHint({ hasApiKey: false, failedSkillCount: 3, alreadyHinted: false });
  assert.match(String(text), /API Key/);
  assert.doesNotMatch(String(text), /技能/);
});
