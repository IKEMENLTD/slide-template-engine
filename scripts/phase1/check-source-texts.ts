/**
 * 先方 PDF の実際の文言が、仮テンプレートの欄に収まるかを実フォントで測る（Phase 1）。
 * 使い方: npx tsx scripts/phase1/check-source-texts.ts [catalog.json] [texts.json]
 * 結果は out/phase1/source-fit.json。収まらない欄があれば exit 1。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Catalog } from '../../src/catalog/build-catalog.js';
import { fitSlot } from '../../src/fit/fit-slot.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const cat: Catalog = JSON.parse(readFileSync(process.argv[2] ?? path.join(ROOT, 'out/catalog/provisional.catalog.json'), 'utf8'));
const texts: Record<string, Record<string, string>> = JSON.parse(readFileSync(process.argv[3] ?? path.join(ROOT, 'samples/source-texts-p1-p3.json'), 'utf8'));
const resolveFile = (p: string) => path.join(ROOT, p);
const rows = [];
let bad = 0;
for (const [key, slots] of Object.entries(texts)) {
  if (key.startsWith('_')) continue;
  const t = cat.types.find((x) => x.key === key);
  if (!t) throw new Error(`型 ${key} がカタログに無い`);
  for (const s of t.slots.filter((x) => x.kind !== 'img')) {
    if (!(s.name in slots)) {
      rows.push({ type: key, slot: s.name, ok: false, reason: '文言が用意されていない' });
      bad++;
      continue;
    }
  }
  for (const [name, text] of Object.entries(slots)) {
    const s = t.slots.find((x) => x.name === name);
    if (!s) throw new Error(`${key} に欄 ${name} が無い`);
    const r = fitSlot(s, text, cat.fit, resolveFile);
    rows.push({ type: key, slot: name, ok: r.ok, lines: r.lineCount, maxLines: r.maxLines, chars: r.chars, maxChars: r.maxChars, wrapped: r.lines, reason: r.reason });
    if (!r.ok) bad++;
    console.log(`${r.ok ? '○' : '×'} ${key} ${name}: ${r.lineCount}/${r.maxLines}行 ${r.chars}/${r.maxChars}字 ${r.ok ? '' : r.reason}`);
  }
}
mkdirSync(path.join(ROOT, 'out/phase1'), { recursive: true });
writeFileSync(path.join(ROOT, 'out/phase1/source-fit.json'), JSON.stringify({ catalog: cat.template, rows }, null, 1));
console.log(`収まらない欄 ${bad}`);
if (bad) process.exitCode = 1;
