/**
 * 极简 PNG 编码器（无第三方依赖）。
 *
 * 为什么需要它：托盘图标必须是一个 nativeImage，而原生图像来自位图/Buffer。
 * 与其往仓库里塞一个二进制 png 资源，不如在代码里画出来 —— 这也和
 * 「v0 美术资源全部程序化生成」的策略一致（PRD-Body v0.1 §5.1）。
 *
 * 只支持 8bit RGBA、无隔行、filter=0，足够画图标。
 */
import zlib from 'node:zlib';

/** @type {Uint32Array | null} */
let crcTable = null;

/** @returns {Uint32Array} */
function getCrcTable() {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/**
 * @param {Buffer} buf
 * @returns {number}
 */
function crc32(buf) {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type
 * @param {Buffer} data
 * @returns {Buffer}
 */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 把 RGBA 像素编码成 PNG。
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba 长度必须为 width * height * 4
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`encodePng: 像素数据长度应为 ${expected}，实际 ${rgba.length}`);
  }

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type: None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
