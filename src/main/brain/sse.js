/**
 * 极简 SSE（Server-Sent Events）解析器。
 *
 * 纯数据变换，不碰网络、不碰 Electron，因此可以直接单测
 * （见 test/unit/sse.test.js）——这也是整个 Brain 里最容易写错、
 * 最值得单测的一块。
 *
 * SSE 帧之间用**空行**分隔。一帧里可能有：
 *   data: {...}       ← 我们只关心这个
 *   event: message    ← 用不到
 *   : 注释             ← 忽略
 * 一帧里可以有多行 data，按规范要用 \n 连接。
 */

/** DeepSeek / OpenAI 兼容接口用这个哨兵表示流结束 */
export const DONE_SENTINEL = '[DONE]';

/**
 * @typedef {{ push: (chunk: string) => string[], flush: () => string[] }} SseDecoder
 */

/**
 * 创建一个流式解码器。网络分片是任意切的，可能把一帧切成两半，
 * 所以必须自己缓冲。
 *
 * @returns {SseDecoder}
 */
export function createSseDecoder() {
  let buffer = '';

  /**
   * @param {string} rawEvent
   * @returns {string | null} data 负载（多行用 \n 连接）；没有 data 行则返回 null
   */
  function parseEvent(rawEvent) {
    /** @type {string[]} */
    const dataLines = [];
    for (const rawLine of rawEvent.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line === '' || line.startsWith(':')) continue; // 空行 / 注释
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1); // 规范：冒号后可有一个空格
      if (field === 'data') dataLines.push(value);
    }
    return dataLines.length > 0 ? dataLines.join('\n') : null;
  }

  return {
    /**
     * 喂入一段网络分片，返回本次能完整解析出的所有 data 负载。
     * @param {string} chunk
     * @returns {string[]}
     */
    push(chunk) {
      buffer += chunk;
      /** @type {string[]} */
      const out = [];
      // 帧分隔符可能是 \n\n 或 \r\n\r\n；统一先归一化换行
      buffer = buffer.replace(/\r\n/g, '\n');

      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = parseEvent(rawEvent);
        if (data !== null) out.push(data);
        idx = buffer.indexOf('\n\n');
      }
      return out;
    },

    /**
     * 流结束时调用：处理没有以空行收尾的残留帧。
     * @returns {string[]}
     */
    flush() {
      const raw = buffer.trim();
      buffer = '';
      if (raw === '') return [];
      const data = parseEvent(raw);
      return data === null ? [] : [data];
    },
  };
}
