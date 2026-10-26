/**
 * Phase 5：全型の見本を、2つの配色（元の青×黄と、差し替えた緑×ピンク）で組み立てて描き、並べて比べる。
 * 配色はテーマ色だけを差し替える（slidegen theme）。文言と写真は同じ。AI は使わない。
 *   npx tsx scripts/phase5/palette-gallery.ts → out/phase5/palette/
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { buildCatalog, type Catalog } from '../../src/catalog/build-catalog.js';
import { loadConfig } from '../../src/catalog/config.js';
import { readTemplate } from '../../src/catalog/read-template.js';
import { assembleDeck } from '../../src/assemble/build-deck.js';
import { sourceNumbers } from '../../src/check/content.js';
import { checkPage, checkTypeRuns } from '../../src/check/slots.js';
import { loadPhotoLibrary, processPhoto, resolveColor } from '../../src/photos/prepare.js';
import { renderDeck, renderIssues } from '../../src/render/render.js';
import type { DeckPlan } from '../../src/plan/schema.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'out/phase5/palette');
const cfg = loadConfig(path.join(ROOT, 'templates/provisional.config.json'));
const resolveFile = (p: string) => path.join(ROOT, p);
const manuscript = readFileSync(path.join(ROOT, 'samples/manuscript-03-long.md'), 'utf8');
const gallery = JSON.parse(readFileSync(path.join(ROOT, 'samples/type-gallery.json'), 'utf8')) as { pages: Array<{ type: string; slots: Record<string, string> }> };
const lib = loadPhotoLibrary(path.join(ROOT, 'assets/photos'));

const palettes = [
  { name: 'blue-yellow', template: path.join(ROOT, 'templates/provisional.pptx') },
  { name: 'green-pink', template: path.join(ROOT, 'out/phase5/provisional-green.pptx') },
];

async function catalogOf(tpl: string): Promise<Catalog> {
  const buf = readFileSync(tpl);
  const { catalog, problems } = buildCatalog(await readTemplate(buf), cfg, { file: path.relative(ROOT, tpl), sha256: createHash('sha256').update(buf).digest('hex'), resolveFile });
  const errs = problems.filter((p) => p.level === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.message).join('\n'));
  return catalog;
}

const renders: Record<string, string[]> = {};
for (const pal of palettes) {
  const catalog = await catalogOf(pal.template);
  const missing = catalog.types.filter((t) => !gallery.pages.some((p) => p.type === t.key)).map((t) => t.key);
  if (missing.length) throw new Error(`見本に無い型: ${missing.join(', ')}`);
  // 文言は B段・E段と同じ検査を通す
  const ctx = { catalog, headlineMaxLines: cfg.headline.maxLines, manuscript, sourceNumbers: sourceNumbers(manuscript), nameIgnoreSlots: cfg.checks.nameIgnoreSlots, unitSlots: cfg.checks.unitSlots, resolveFile };
  const problems = gallery.pages.flatMap((p, i) => checkPage(i + 1, catalog.types.find((t) => t.key === p.type)!, p.slots, ctx)).filter((x) => x.level === 'error');
  if (problems.length) throw new Error(problems.map((x) => `p${x.page} ${x.slot}: ${x.message}`).join('\n'));
  const dir = path.join(OUT, pal.name);
  const photoDir = path.join(dir, 'photos');
  mkdirSync(photoDir, { recursive: true });
  let k = 0;
  const plan: DeckPlan = { version: 1, deckTitle: '全型の見本', template: { file: path.relative(ROOT, pal.template), sha256: catalog.template.sha256 }, pages: [] };
  for (const [i, p] of gallery.pages.entries()) {
    const t = catalog.types.find((x) => x.key === p.type)!;
    const photoFiles: Record<string, string> = {};
    for (const s of t.slots.filter((x) => x.kind === 'img')) {
      const name = `p${String(i + 1).padStart(2, '0')}-${s.name}.jpg`;
      const proc = s.process ?? { mono: true, multiply: null };
      // 乗算の色はテーマ色から取る（配色を差し替えると写真の色も変わる）
      await processPhoto(lib[k++ % lib.length].path, path.join(photoDir, name), s.aspect!, proc, resolveColor(proc.multiply, catalog.theme.colors));
      photoFiles[s.name] = name;
    }
    plan.pages.push({ type: p.type, slots: p.slots, photos: {}, outlinePage: i + 1, trimmed: [], phraseBroken: [], rewrites: 0, photoFiles });
  }
  const runs = checkTypeRuns(plan.pages.map((p) => p.type), cfg.deck.maxSameTypeInRow);
  const { buffer, structure } = await assembleDeck({ templatePath: pal.template, catalog, cfg, plan, photoDir, outFile: path.join(dir, 'gallery.pptx') });
  const r = await renderDeck(buffer, dir, { dpi: 96 });
  const ri = renderIssues(r, plan.pages.length);
  console.log(`${pal.name}: ${plan.pages.length}枚・構造の問題 ${structure.length}・描画の問題 ${ri.length}・同じ型の連続 ${runs.length}・フォント ${r.fonts.join(', ')}`);
  if (structure.length || ri.length) process.exitCode = 1;
  renders[pal.name] = r.pages;
}

// 左右に並べた比較画像（1型1枚）と、全体の一覧
const W = 960;
const H = 540;
const pairs: Buffer[] = [];
for (let i = 0; i < gallery.pages.length; i++) {
  const [a, b] = await Promise.all(palettes.map((p) => sharp(renders[p.name][i]).resize(W, H).toBuffer()));
  const pair = await sharp({ create: { width: W * 2 + 20, height: H, channels: 3, background: '#ffffff' } })
    .composite([{ input: a, left: 0, top: 0 }, { input: b, left: W + 20, top: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
  writeFileSync(path.join(OUT, `compare-${String(i + 1).padStart(2, '0')}-${gallery.pages[i].type.replace('/', '-')}.jpg`), pair);
  pairs.push(await sharp(pair).resize(980, Math.round(H * 980 / (W * 2 + 20))).toBuffer());
}
const rowH = Math.round(H * 980 / (W * 2 + 20));
await sharp({ create: { width: 980 * 3 + 20, height: rowH * 5 + 40, channels: 3, background: '#cccccc' } })
  .composite(pairs.map((p, i) => ({ input: p, left: (i % 3) * 990, top: Math.floor(i / 3) * (rowH + 10) })))
  .jpeg({ quality: 85 })
  .toFile(path.join(OUT, 'compare-all.jpg'));
console.log(`比較画像 → ${path.relative(ROOT, OUT)}/compare-*.jpg`);
