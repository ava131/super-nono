/**
 * 程序化生成托盘图标。
 *
 * macOS 菜单栏用**模板图像**（template image）：只取 alpha 通道，系统自动
 * 适配浅色/深色菜单栏。所以这里只需要画"不透明在哪"。
 *
 * 形象是一个 16×16 像素网格的小机器人脑袋（与渲染进程里的占位精灵同一套设计语言）：
 *
 *      ···##··········      # = 不透明
 *      ···##··········
 *      ··##########····
 *      ··#········#····
 *      ··#·##··##·#····      ## = 眼睛（挖空 → 透明）
 *      ··#········#····
 *      ··#········#····
 *      ··#···##···#····
 *      ··##########····
 *      ····##··##······
 */
import { nativeImage } from 'electron';
import { encodePng } from './png.js';

const GRID = 16;
const SCALE = 2; // @2x，菜单栏里显示为 16pt

/**
 * 在 16×16 的网格上点亮像素。
 * @param {Uint8Array} alpha 长度 GRID*GRID
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 */
function paint(alpha, x, y, w, h) {
  for (let gy = y; gy < y + h; gy += 1) {
    for (let gx = x; gx < x + w; gx += 1) {
      if (gx < 0 || gy < 0 || gx >= GRID || gy >= GRID) continue;
      alpha[gy * GRID + gx] = 1;
    }
  }
}

/**
 * @param {Uint8Array} alpha
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 */
function punch(alpha, x, y, w, h) {
  for (let gy = y; gy < y + h; gy += 1) {
    for (let gx = x; gx < x + w; gx += 1) {
      if (gx < 0 || gy < 0 || gx >= GRID || gy >= GRID) continue;
      alpha[gy * GRID + gx] = 0;
    }
  }
}

/** @returns {Uint8Array} 16×16 的 alpha 掩码 */
function buildMask() {
  const alpha = new Uint8Array(GRID * GRID);

  paint(alpha, 7, 1, 2, 2); // 天线杆
  paint(alpha, 7, 0, 2, 1); // 天线顶端的点
  paint(alpha, 2, 3, 12, 9); // 头
  punch(alpha, 2, 3, 1, 1); // 削圆角
  punch(alpha, 13, 3, 1, 1);
  punch(alpha, 2, 11, 1, 1);
  punch(alpha, 13, 11, 1, 1);
  punch(alpha, 5, 6, 2, 2); // 左眼
  punch(alpha, 9, 6, 2, 2); // 右眼
  punch(alpha, 7, 9, 2, 1); // 嘴
  paint(alpha, 4, 12, 3, 1); // 左脚
  paint(alpha, 9, 12, 3, 1); // 右脚

  return alpha;
}

/**
 * @param {Uint8Array} mask
 * @returns {Buffer} PNG
 */
function maskToPng(mask) {
  const size = GRID * SCALE;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const on = mask[Math.floor(y / SCALE) * GRID + Math.floor(x / SCALE)] === 1;
      const i = (y * size + x) * 4;
      // 模板图像只看 alpha；RGB 用黑色即可。
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = on ? 255 : 0;
    }
  }
  return encodePng(size, size, rgba);
}

/**
 * 生成托盘图标。
 * @returns {Electron.NativeImage}
 */
export function createTrayIcon() {
  const png = maskToPng(buildMask());
  // 32×32 的位图，声明 scaleFactor=2 → 逻辑尺寸 16×16，Retina 下清晰。
  const image = nativeImage.createFromBuffer(png, { scaleFactor: SCALE });
  image.setTemplateImage(true);
  return image;
}
