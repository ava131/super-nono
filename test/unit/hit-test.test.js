import assert from 'node:assert/strict';
import test from 'node:test';
import { ENTER_ALPHA, EXIT_ALPHA, alphaAtPixel, nextSolid } from '../../src/renderer/hit-test.js';

test('阈值本身必须满足滞回关系（进入 > 退出）', () => {
  assert.ok(ENTER_ALPHA > EXIT_ALPHA, `ENTER=${ENTER_ALPHA} 必须大于 EXIT=${EXIT_ALPHA}`);
});

test('透明像素 → 保持穿透', () => {
  assert.equal(nextSolid(false, 0), false);
});

test('实体像素 → 关闭穿透', () => {
  assert.equal(nextSolid(false, 255), true);
});

test('已经是实体时，alpha 掉到退出阈值以下才恢复穿透', () => {
  assert.equal(nextSolid(true, 100), true);
  assert.equal(nextSolid(true, EXIT_ALPHA), true);
  assert.equal(nextSolid(true, EXIT_ALPHA - 1), false);
  assert.equal(nextSolid(true, 0), false);
});

test('滞回区间内不发生翻转（这是防边缘抖动的关键）', () => {
  // alpha 夹在 EXIT 与 ENTER 之间时，无论之前是什么状态都保持原样
  const mid = (ENTER_ALPHA + EXIT_ALPHA) / 2;
  assert.equal(nextSolid(true, mid), true);
  assert.equal(nextSolid(false, mid), false);
});

test('反复喂同一个中间值不会导致状态振荡', () => {
  const mid = (ENTER_ALPHA + EXIT_ALPHA) / 2;
  let solid = false;
  for (let i = 0; i < 50; i += 1) solid = nextSolid(solid, mid);
  assert.equal(solid, false, '中间值不应把状态推到实体');
  solid = true;
  for (let i = 0; i < 50; i += 1) solid = nextSolid(solid, mid);
  assert.equal(solid, true, '中间值不应把状态推出实体');
});

test('alphaAtPixel: 取得到正确的通道值', () => {
  const image = {
    width: 2,
    height: 2,
    // prettier-ignore
    data: new Uint8ClampedArray([
      0, 0, 0, 0, 0, 0, 0, 255,
      0, 0, 0, 128, 0, 0, 0, 7,
    ]),
  };
  assert.equal(alphaAtPixel(image, 0, 0), 0);
  assert.equal(alphaAtPixel(image, 1, 0), 255);
  assert.equal(alphaAtPixel(image, 0, 1), 128);
  assert.equal(alphaAtPixel(image, 1, 1), 7);
});

test('alphaAtPixel: 越界一律视作透明', () => {
  const image = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) };
  assert.equal(alphaAtPixel(image, -1, 0), 0);
  assert.equal(alphaAtPixel(image, 0, -1), 0);
  assert.equal(alphaAtPixel(image, 2, 0), 0);
  assert.equal(alphaAtPixel(image, 0, 2), 0);
});
