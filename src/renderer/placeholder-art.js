/**
 * 程序化占位像素图（PRD-Body v0.1 §5.1）。
 *
 * v0 **不画任何图**：用代码把一个 16×16 的像素机器人在离屏 canvas 上画出来，
 * 再按整数倍放大到 96×96 逻辑像素。这样整条链路（窗口 → 动画 → 拖动 →
 * 命中测试 → 对话）可以先跑通，美术随时可换。
 *
 * 对外只暴露 `createFrames(dpr)`，返回的帧数组与将来"读 PNG 图集 + JSON"
 * 的产物**接口完全一致** —— 这就是 PRD 里 G7「换图不改代码」的落地点。
 */

/** 精灵的像素网格尺寸（设计分辨率） */
const GRID = 16;

/** 每个状态一帧持续几个 tick（tick = 100ms，见 pet.js） */
const HOLD = { idle: 6, drag: 3, think: 3, speak: 2, error: 4 };

const PALETTE = {
  outline: '#12314a',
  body: '#79d6f7',
  bodyDark: '#3ea8d6',
  face: '#0f2a3d',
  eye: '#eafaff',
  accent: '#ffc45e',
  error: '#ff7b6b',
  errorBody: '#f6a08e',
};

/**
 * @typedef {object} FrameOptions
 * @property {number} [dy] 整体上下偏移（网格单位），用于呼吸/被拎起
 * @property {'open'|'blink'|'happy'|'error'} [eye]
 * @property {'closed'|'open'|'flat'} [mouth]
 * @property {string} [bodyColor]
 * @property {number} [dot] 头顶思考指示点的位置索引（0-3），不传则不画
 */

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cell 一个网格单元的设备像素大小
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {string} color
 * @param {number} dy
 */
function px(ctx, cell, x, y, w, h, color, dy) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x * cell), Math.round((y + dy) * cell), Math.round(w * cell), Math.round(h * cell));
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cell
 * @param {FrameOptions} o
 */
function drawRobot(ctx, cell, o) {
  const dy = o.dy ?? 0;
  const body = o.bodyColor ?? PALETTE.body;
  const eye = o.eye ?? 'open';
  const mouth = o.mouth ?? 'closed';
  const accent = eye === 'error' ? PALETTE.error : PALETTE.accent;

  // 天线
  px(ctx, cell, 7, 1, 2, 2, PALETTE.outline, dy);
  px(ctx, cell, 7, 0, 2, 1, accent, dy);

  // 手臂（被拎起时抬高）
  px(ctx, cell, 0, 7, 2, 3, PALETTE.bodyDark, dy);
  px(ctx, cell, 14, 7, 2, 3, PALETTE.bodyDark, dy);

  // 头
  px(ctx, cell, 2, 3, 12, 10, PALETTE.outline, dy);
  px(ctx, cell, 3, 4, 10, 8, body, dy);

  // 面罩
  px(ctx, cell, 4, 6, 8, 5, PALETTE.face, dy);

  // 眼睛
  if (eye === 'blink') {
    px(ctx, cell, 5, 8, 2, 1, PALETTE.eye, dy);
    px(ctx, cell, 9, 8, 2, 1, PALETTE.eye, dy);
  } else if (eye === 'happy') {
    px(ctx, cell, 5, 8, 1, 1, PALETTE.eye, dy);
    px(ctx, cell, 6, 7, 1, 1, PALETTE.eye, dy);
    px(ctx, cell, 7, 8, 1, 1, PALETTE.eye, dy);
    px(ctx, cell, 9, 8, 1, 1, PALETTE.eye, dy);
    px(ctx, cell, 10, 7, 1, 1, PALETTE.eye, dy);
    px(ctx, cell, 11, 8, 1, 1, PALETTE.eye, dy);
  } else if (eye === 'error') {
    px(ctx, cell, 5, 7, 2, 2, PALETTE.error, dy);
    px(ctx, cell, 9, 7, 2, 2, PALETTE.error, dy);
  } else {
    px(ctx, cell, 5, 7, 2, 2, PALETTE.eye, dy);
    px(ctx, cell, 9, 7, 2, 2, PALETTE.eye, dy);
  }

  // 嘴
  if (mouth === 'open') px(ctx, cell, 6, 10, 4, 2, PALETTE.eye, dy);
  else if (mouth === 'flat') px(ctx, cell, 6, 10, 4, 1, PALETTE.eye, dy);
  else px(ctx, cell, 7, 10, 2, 1, PALETTE.eye, dy);

  // 脚
  px(ctx, cell, 4, 13, 3, 1, PALETTE.outline, dy);
  px(ctx, cell, 9, 13, 3, 1, PALETTE.outline, dy);

  // 头顶思考指示点
  if (typeof o.dot === 'number') {
    const spots = /** @type {const} */ ([
      [10, 1],
      [12, 3],
      [10, 5],
      [4, 3],
    ]);
    const spot = spots[o.dot % spots.length];
    if (spot) px(ctx, cell, spot[0], spot[1], 1, 1, PALETTE.accent, dy);
  }
}

/**
 * 画一帧。
 * @param {number} dpr
 * @param {number} size 逻辑尺寸（96）
 * @param {FrameOptions} options
 * @returns {HTMLCanvasElement}
 */
function makeFrame(dpr, size, options) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.imageSmoothingEnabled = false;
  drawRobot(ctx, canvas.width / GRID, options);
  return canvas;
}

/**
 * @typedef {object} Animation
 * @property {number} hold 每帧持续几个 tick
 * @property {HTMLCanvasElement[]} frames
 */

/**
 * 生成全部状态的帧。
 *
 * @param {number} [dpr] 设备像素比（Retina 上传 2，保证像素锐利）
 * @param {number} [size] 精灵逻辑尺寸
 * @returns {Record<'idle'|'drag'|'think'|'speak'|'error', Animation>}
 */
export function createFrames(dpr = 1, size = 96) {
  const f = (/** @type {FrameOptions} */ o) => makeFrame(dpr, size, o);

  return {
    // 缓慢的呼吸 + 偶尔眨眼
    idle: {
      hold: HOLD.idle,
      frames: [
        f({ dy: 0, eye: 'open' }),
        f({ dy: 0, eye: 'open' }),
        f({ dy: 1, eye: 'open' }),
        f({ dy: 1, eye: 'blink' }),
      ],
    },

    // 被拎起来：上下浮动 + 眯眼
    drag: {
      hold: HOLD.drag,
      frames: [f({ dy: -1, eye: 'happy', mouth: 'flat' }), f({ dy: 0, eye: 'happy', mouth: 'flat' })],
    },

    // 思考：头顶一个绕圈的点
    think: {
      hold: HOLD.think,
      frames: [f({ dot: 0 }), f({ dot: 1 }), f({ dot: 2 }), f({ dot: 3 })],
    },

    // 说话：嘴开合
    speak: {
      hold: HOLD.speak,
      frames: [f({ mouth: 'open' }), f({ mouth: 'closed' }), f({ mouth: 'open' }), f({ mouth: 'flat' })],
    },

    // 出错
    error: {
      hold: HOLD.error,
      frames: [
        f({ eye: 'error', mouth: 'flat', bodyColor: PALETTE.errorBody }),
        f({ eye: 'error', mouth: 'open', bodyColor: PALETTE.errorBody, dy: 1 }),
      ],
    },
  };
}
