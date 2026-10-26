/**
 * 仮テンプレートに先方 PDF の文言を流し込み、PDF と見比べるための .pptx を作る（Phase 1 の確認用）。
 * 写真は差し替えない（テンプレートの見本写真のまま）。
 * 使い方: npx tsx scripts/phase1/fill-source-texts.ts → out/phase1/filled.pptx
 */
import { Automizer } from 'pptx-automizer';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Catalog } from '../../src/catalog/build-catalog.js';
import { replaceText } from '../../src/assemble/replace-text.js';
import { sanitizePptx } from '../../src/assemble/sanitize.js';
import { checkPptxStructure } from '../../src/check/pptx-structure.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'out/phase1');
mkdirSync(OUT, { recursive: true });
const cat: Catalog = JSON.parse(readFileSync(path.join(ROOT, 'out/catalog/provisional.catalog.json'), 'utf8'));
const texts: Record<string, Record<string, string>> = JSON.parse(readFileSync(path.join(ROOT, 'samples/source-texts-p1-p3.json'), 'utf8'));

const automizer = new Automizer({
  templateDir: path.join(ROOT, 'templates'),
  outputDir: OUT,
  removeExistingSlides: true,
  autoImportSlideMasters: false,
  cleanup: true,
  compression: 6,
  verbosity: 1,
});
const pres = automizer.loadRoot('provisional.pptx').load('provisional.pptx', 'tpl');
for (const [key, slots] of Object.entries(texts)) {
  if (key.startsWith('_')) continue;
  const t = cat.types.find((x) => x.key === key)!;
  pres.addSlide('tpl', t.slideNumber, (slide) => {
    for (const [name, text] of Object.entries(slots)) slide.modifyElement(name, replaceText(text, { underline: cat.emphasis.underline, bold: cat.emphasis.bold }));
  });
}
await pres.write('filled.raw.pptx');
const { buffer } = await sanitizePptx(readFileSync(path.join(OUT, 'filled.raw.pptx')));
writeFileSync(path.join(OUT, 'filled.pptx'), buffer);
const issues = await checkPptxStructure(buffer);
console.log('構造の問題', issues.length);
if (issues.length) process.exitCode = 1;
