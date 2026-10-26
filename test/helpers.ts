import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildCatalog } from '../src/catalog/build-catalog.js';
import { loadConfig } from '../src/catalog/config.js';
import { readTemplate } from '../src/catalog/read-template.js';
import type { AiTransport, CompleteRequest, CompleteResult } from '../src/ai/transport.js';

export const ROOT = path.join(import.meta.dirname, '..');
export const TEMPLATE = path.join(ROOT, 'templates/provisional.pptx');
export const CONFIG = loadConfig(path.join(ROOT, 'templates/provisional.config.json'));

/** 仮テンプレートと設定から型カタログを作る（試験用） */
export async function buildFixtureCatalog() {
  const { catalog, problems } = buildCatalog(await readTemplate(readFileSync(TEMPLATE)), CONFIG, {
    file: 'templates/provisional.pptx',
    sha256: 'test',
    resolveFile: (p) => path.join(ROOT, p),
  });
  const errs = problems.filter((p) => p.level === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.message).join('\n'));
  return catalog;
}

/** 決まった応答を順に返す偽物の呼び出し口。受け取った依頼も残す */
export function fakeTransport(replies: Array<string | { text: string; stopReason?: string }>): AiTransport & { requests: CompleteRequest[] } {
  const requests: CompleteRequest[] = [];
  return {
    name: 'fake',
    requests,
    async complete(req: CompleteRequest): Promise<CompleteResult> {
      requests.push(req);
      const r = replies.shift();
      if (r === undefined) throw new Error('偽物の応答が尽きた');
      const { text, stopReason = 'end_turn' } = typeof r === 'string' ? { text: r } : r;
      return {
        text,
        stopReason,
        model: req.modelId,
        ms: 1,
        usage: { feature: req.feature, model: req.modelId, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, cacheDeclared: true, cacheHit: false, cacheIneffective: false },
      };
    },
  };
}


/**
 * C段（写真の割り当て）の呼び出しにだけ、決まりに合う割り当てを組み立てて返す偽物。
 * それ以外の段は replies を順に返す。支給の写真（01〜03.jpg）を1枚2回まで使い、足りなければ生成を割り当てる。
 */
export function photoAwareFake(replies: Array<string | { text: string; stopReason?: string }>) {
  const t = fakeTransport(replies);
  const orig = t.complete.bind(t);
  t.complete = async (req) => {
    if (!req.feature.startsWith('C段')) return orig(req);
    t.requests.push(req);
    const ids = [...req.user.matchAll(/id=(p\d+)\/(\S+)/g)].map((m) => ({ id: `${m[1]}/${m[2]}`, page: m[1] }));
    const uses = new Map<string, number>();
    const pages = new Map<string, Set<string>>();
    let gen = 0;
    const assignments = ids.map(({ id, page }) => {
      const onPage = pages.get(page) ?? new Set<string>();
      pages.set(page, onPage);
      const file = ['01.jpg', '02.jpg', '03.jpg'].find((f) => (uses.get(f) ?? 0) < 2 && !onPage.has(f));
      if (file) {
        uses.set(file, (uses.get(file) ?? 0) + 1);
        onPage.add(file);
        return { id, use: file };
      }
      return { id, use: `gen:${++gen}`, scene: `A person working, shot ${gen}.` };
    });
    return {
      text: JSON.stringify({ cast: 'A Japanese woman in a navy jacket in a bright office.', assignments }),
      stopReason: 'end_turn',
      model: req.modelId,
      ms: 1,
      usage: { feature: req.feature, model: req.modelId, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, cacheDeclared: true, cacheHit: false, cacheIneffective: false },
    };
  };
  return t;
}

/** 写真の生成の偽物。灰色の JPEG を返し、受け取った依頼を残す */
export function fakeGenerator() {
  const calls: Array<{ prompt: string; size: string; references: number }> = [];
  const gen = async (req: { prompt: string; size: string; references: Buffer[] }) => {
    calls.push({ prompt: req.prompt, size: req.size, references: req.references.length });
    const [w, h] = req.size.split('x').map(Number);
    const jpeg = await sharp({ create: { width: w / 8, height: h / 8, channels: 3, background: { r: 120 + calls.length * 10, g: 160, b: 200 } } }).jpeg().toBuffer();
    return { jpeg, usage: { input_tokens: 100, output_tokens: 300 }, costUsd: 0.01, ms: 5, withReferences: req.references.length };
  };
  return Object.assign(gen, { calls });
}
