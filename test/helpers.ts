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

