/**
 * 频道契约自检。
 *
 * 只依赖 `src/shared/channels.cjs`（纯数据，不 require electron），
 * 保证：频道命名规范、无重复、三张白名单互不重叠且完整覆盖。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import channels from '../../src/shared/channels.cjs';

const { CH, SEND_CHANNELS, RECEIVE_CHANNELS, INVOKE_CHANNELS } = channels;

const ALL = Object.values(CH);
/** @type {[string, readonly string[]][]} */
const GROUPS = [
  ['SEND_CHANNELS', SEND_CHANNELS],
  ['RECEIVE_CHANNELS', RECEIVE_CHANNELS],
  ['INVOKE_CHANNELS', INVOKE_CHANNELS],
];

test('频道名格式统一为 域:动作', () => {
  for (const name of ALL) {
    assert.match(name, /^[a-z]+:[a-zA-Z]+$/, `频道名不合规：${name}`);
  }
});

test('频道值不重复', () => {
  assert.equal(new Set(ALL).size, ALL.length);
});

test('每个频道都被某一张白名单覆盖（否则渲染进程永远用不到它）', () => {
  const covered = new Set([...SEND_CHANNELS, ...RECEIVE_CHANNELS, ...INVOKE_CHANNELS]);
  const orphans = ALL.filter((name) => !covered.has(name));
  assert.deepEqual(orphans, [], `这些频道没有任何通路：${orphans.join(', ')}`);
});

test('三张白名单互不重叠', () => {
  for (let i = 0; i < GROUPS.length; i += 1) {
    for (let j = i + 1; j < GROUPS.length; j += 1) {
      const [nameA, listA] = GROUPS[i];
      const [nameB, listB] = GROUPS[j];
      const setB = new Set(listB);
      const overlap = listA.filter((c) => setB.has(c));
      assert.deepEqual(overlap, [], `${nameA} 与 ${nameB} 重叠：${overlap.join(', ')}`);
    }
  }
});

test('白名单里没有 channels.cjs 之外的野频道', () => {
  const known = new Set(ALL);
  for (const [name, list] of GROUPS) {
    const strays = list.filter((c) => !known.has(c));
    assert.deepEqual(strays, [], `${name} 里有未声明的频道：${strays.join(', ')}`);
  }
});

test('白名单自身不重复', () => {
  for (const [name, list] of GROUPS) {
    assert.equal(new Set(list).size, list.length, `${name} 内部有重复项`);
  }
});
