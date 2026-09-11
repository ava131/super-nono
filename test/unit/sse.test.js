import assert from 'node:assert/strict';
import test from 'node:test';
import { DONE_SENTINEL, createSseDecoder } from '../../src/main/brain/sse.js';

test('一个完整的帧', () => {
  const d = createSseDecoder();
  assert.deepEqual(d.push('data: {"a":1}\n\n'), ['{"a":1}']);
});

test('网络分片把一帧切成两半时必须自己缓冲', () => {
  const d = createSseDecoder();
  assert.deepEqual(d.push('data: {"a"'), []);
  assert.deepEqual(d.push(':1}\n\n'), ['{"a":1}']);
});

test('一次分片里含多个帧', () => {
  const d = createSseDecoder();
  assert.deepEqual(d.push('data: 1\n\ndata: 2\n\ndata: 3\n\n'), ['1', '2', '3']);
});

test('一帧里多行 data 用换行连接', () => {
  const d = createSseDecoder();
  assert.deepEqual(d.push('data: line1\ndata: line2\n\n'), ['line1\nline2']);
});

test('CRLF 换行也要能解析', () => {
  const d = createSseDecoder();
  assert.deepEqual(d.push('data: hello\r\n\r\n'), ['hello']);
});

test('注释行与 event 字段被忽略', () => {
  const d = createSseDecoder();
  assert.deepEqual(d.push(': keep-alive\nevent: message\ndata: payload\n\n'), ['payload']);
});

test('没有 data 行的帧返回空', () => {
  const d = createSseDecoder();
  assert.deepEqual(d.push(': ping\n\n'), []);
});

test('data 冒号后的单个空格按规范去掉，但不吃掉正文里的空格', () => {
  const d = createSseDecoder();
  assert.deepEqual(d.push('data:  two spaces\n\n'), [' two spaces']);
});

test('[DONE] 哨兵原样透出，由上层处理', () => {
  const d = createSseDecoder();
  assert.deepEqual(d.push(`data: ${DONE_SENTINEL}\n\n`), [DONE_SENTINEL]);
});

test('flush 能处理没有空行收尾的残留帧（真实流经常这样结束）', () => {
  const d = createSseDecoder();
  assert.deepEqual(d.push('data: tail'), []);
  assert.deepEqual(d.flush(), ['tail']);
});

test('flush 之后状态被清空', () => {
  const d = createSseDecoder();
  d.push('data: x\n\n');
  assert.deepEqual(d.flush(), []);
});

test('模拟一段真实的 OpenAI 兼容流', () => {
  const d = createSseDecoder();
  const raw = [
    'data: {"choices":[{"delta":{"content":"你"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"好"}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
    '',
    `data: ${DONE_SENTINEL}`,
    '',
  ].join('\n');

  // 故意按 7 个字符一段切碎，模拟真实网络分片
  const decoder = createSseDecoder();
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < raw.length; i += 7) {
    out.push(...decoder.push(raw.slice(i, i + 7)));
  }
  out.push(...decoder.flush());

  assert.equal(out.length, 4);
  assert.equal(out[0], '{"choices":[{"delta":{"content":"你"}}]}');
  assert.equal(out[3], DONE_SENTINEL);

  const texts = out
    .filter((s) => s !== DONE_SENTINEL)
    .map((s) => JSON.parse(s))
    .map((j) => j.choices?.[0]?.delta?.content ?? '')
    .join('');
  assert.equal(texts, '你好');
});
