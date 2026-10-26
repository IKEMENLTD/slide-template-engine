/**
 * 本番の呼び出し口（AnthropicTransport・@anthropic-ai/sdk）を、ローカルに立てた偽の Anthropic API に向けて確かめる。
 * この案件用の API の鍵がまだ無いので（D-019）、実際の SDK が「何を送るか」と「応答をどう読むか」を固定しておく。
 * 送る中身：ストリーミング（9-1）・材料にだけキャッシュの印・段の指示は最後（9-6）・出力の上限・effort・
 * 断られたときのサーバー側の切り替え（fallbacks と beta ヘッダーは対）・画像は内容のブロック（道具を使わない。D-032）。
 */
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicTransport } from '../src/ai/transport.js';

type Seen = { headers: http.IncomingHttpHeaders; body: Record<string, unknown> };
const seen: Seen[] = [];
let stopReason = 'end_turn';
let server: http.Server;
let baseURL = '';

function sse(events: Array<[string, unknown]>) {
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        sse([
          ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 } } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"ok":' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'true}' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 42 } }],
          ['message_stop', { type: 'message_stop' }],
        ])
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const req = {
  feature: 'B段 下書き p1-6',
  modelId: 'claude-sonnet-5-5',
  system: [
    { text: '原稿の材料', cache: true },
    { text: 'カタログの材料', cache: true },
    { text: '段の指示', cache: false },
  ],
  user: '依頼',
  maxTokens: 9000,
  remainingMs: 600_000,
  effort: 'medium' as const,
};

describe('AnthropicTransport（本番の口）を偽の API で確かめる', () => {
  it('ストリーミングで送り、材料にだけキャッシュの印・指示は最後・上限・effort・断られたときの切り替え', async () => {
    const t = new AnthropicTransport({ refusalFallback: true }, new Anthropic({ apiKey: 'test-key', baseURL, maxRetries: 0 }));
    const res = await t.complete(req);
    const { body, headers } = seen[seen.length - 1];
    expect(body.stream).toBe(true);
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.max_tokens).toBe(9000);
    expect(body.system).toEqual([
      { type: 'text', text: '原稿の材料', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'カタログの材料', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '段の指示' },
    ]);
    expect(body.messages).toEqual([{ role: 'user', content: '依頼' }]);
    expect(body.output_config).toEqual({ effort: 'medium' });
    // fallbacks と beta ヘッダーは対（片方だけだと 400）
    expect(body.fallbacks).toBe('default');
    expect(String(headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    // 応答の読み取り：本文・止まった理由・使用量（キャッシュの読み出しを含む）
    expect(res.text).toBe('{"ok":true}');
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage).toMatchObject({ feature: 'B段 下書き p1-6', inputTokens: 120, outputTokens: 42, cacheReadTokens: 3000, cacheDeclared: true, cacheHit: true, cacheIneffective: false });
  });

  it('切り替えを切ると、fallbacks もヘッダーも送らない', async () => {
    const t = new AnthropicTransport({ refusalFallback: false }, new Anthropic({ apiKey: 'test-key', baseURL, maxRetries: 0 }));
    await t.complete(req);
    const { body, headers } = seen[seen.length - 1];
    expect(body.fallbacks).toBeUndefined();
    expect(String(headers['anthropic-beta'] ?? '')).not.toContain('server-side-fallback');
  });

  it('画像は道具を使わず、内容のブロック（base64）として文の前に置く', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'anth-img-'));
    const png = path.join(dir, 'p.png');
    writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
    const t = new AnthropicTransport({ refusalFallback: true }, new Anthropic({ apiKey: 'test-key', baseURL, maxRetries: 0 }));
    await t.complete({ ...req, images: [png] });
    const { body } = seen[seen.length - 1];
    const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') } });
    expect(content[1]).toEqual({ type: 'text', text: '依頼' });
    expect(body.tools).toBeUndefined();
  });

  it('上限で切れた応答は、止まった理由を max_tokens のまま返す（呼び出し側が保存せずやり直す）', async () => {
    stopReason = 'max_tokens';
    const t = new AnthropicTransport({ refusalFallback: true }, new Anthropic({ apiKey: 'test-key', baseURL, maxRetries: 0 }));
    expect((await t.complete(req)).stopReason).toBe('max_tokens');
    stopReason = 'end_turn';
  });
});
