import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RATIO, clampToWorkArea, fromRatio, toRatio } from '../../src/shared/geometry.js';

/** 一个 1920×1080 的屏幕，顶部有 25px 菜单栏 */
const SCREEN = { x: 0, y: 25, width: 1920, height: 1055 };
const SIZE = { width: 160, height: 160 };

test('clampToWorkArea: 把越界的矩形拉回工作区内', () => {
  assert.deepEqual(clampToWorkArea({ x: -100, y: -100, ...SIZE }, SCREEN), { x: 0, y: 25 });
  assert.deepEqual(clampToWorkArea({ x: 99999, y: 99999, ...SIZE }, SCREEN), {
    x: SCREEN.width - SIZE.width,
    y: SCREEN.y + SCREEN.height - SIZE.height,
  });
});

test('clampToWorkArea: 工作区比窗口还小时优先保住左上角', () => {
  const tiny = { x: 0, y: 0, width: 80, height: 80 };
  assert.deepEqual(clampToWorkArea({ x: 500, y: 500, ...SIZE }, tiny), { x: 0, y: 0 });
});

test('clampToWorkArea: 已经在界内时不做任何移动', () => {
  const rect = { x: 500, y: 300, ...SIZE };
  assert.deepEqual(clampToWorkArea(rect, SCREEN), { x: 500, y: 300 });
});

test('toRatio / fromRatio: 往返后位置基本不变', () => {
  const bounds = { x: 800, y: 600, ...SIZE };
  const ratio = toRatio(bounds, SCREEN);
  assert.deepEqual(fromRatio(ratio, SIZE, SCREEN), { x: 800, y: 600 });
});

test('fromRatio: 比例始终被夹在 0–1，越界比例不会把宠物丢到屏幕外', () => {
  const wayOff = fromRatio({ rx: 5, ry: -3 }, SIZE, SCREEN);
  const legal = {
    x: [SCREEN.x, SCREEN.x + SCREEN.width - SIZE.width],
    y: [SCREEN.y, SCREEN.y + SCREEN.height - SIZE.height],
  };
  assert.ok(wayOff.x >= legal.x[0] && wayOff.x <= legal.x[1], `x=${wayOff.x}`);
  assert.ok(wayOff.y >= legal.y[0] && wayOff.y <= legal.y[1], `y=${wayOff.y}`);
});

test('fromRatio: 没有存过位置时落在右下角', () => {
  const pos = fromRatio(null, SIZE, SCREEN);
  const expectedCx = SCREEN.x + DEFAULT_RATIO.rx * SCREEN.width;
  const expectedCy = SCREEN.y + DEFAULT_RATIO.ry * SCREEN.height;
  assert.equal(pos.x, Math.round(expectedCx - SIZE.width / 2));
  assert.equal(pos.y, Math.round(expectedCy - SIZE.height / 2));
});

test('toRatio: 换到更小的屏幕后仍能还原到屏幕内', () => {
  const ratio = toRatio({ x: 1700, y: 1000, ...SIZE }, SCREEN);
  const small = { x: 0, y: 25, width: 1280, height: 695 };
  const pos = fromRatio(ratio, SIZE, small);
  assert.ok(pos.x <= small.width - SIZE.width, `x=${pos.x}`);
  assert.ok(pos.y <= small.y + small.height - SIZE.height, `y=${pos.y}`);
});
