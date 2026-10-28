/**
 * テンプレートのうち、設定（mirror）で反転を許した型を、反転して描いて見比べる（D-042・TEMPLATE_GUIDE 7-2）。
 *   npx tsx scripts/mirror-preview.ts templates/provisional.pptx [出力先]
 * 出力先の orig/pages と mir/pages に、見本どおりと反転したページの画像ができる。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { mirrorPptx } from '../src/assemble/mirror.js';
import { buildCatalog } from '../src/catalog/build-catalog.js';
import { configPathFor, loadConfig } from '../src/catalog/config.js';
import { readTemplate } from '../src/catalog/read-template.js';
import { renderDeck } from '../src/render/render.js';

const [tpl, out = 'out/mirror-preview'] = process.argv.slice(2);
if (!tpl) throw new Error('使い方: npx tsx scripts/mirror-preview.ts <テンプレート.pptx> [出力先]');
const cfg = loadConfig(configPathFor(tpl));
const buf = readFileSync(tpl);
const { catalog } = buildCatalog(await readTemplate(buf), cfg, { file: tpl, sha256: 'preview', resolveFile: (p) => path.resolve(p) });
const types = catalog.types.filter((t) => cfg.mirror[t.key]);
if (!types.length) throw new Error('設定に mirror がありません（反転を許した型が無い）');
mkdirSync(out, { recursive: true });
const flipped = await mirrorPptx(buf, types.map((t) => ({ page: t.order, fixed: cfg.mirror[t.key].fixed })));
await renderDeck(buf, path.join(out, 'orig'), { dpi: 60 });
await renderDeck(flipped, path.join(out, 'mir'), { dpi: 60 });
console.log(`反転した型: ${types.map((t) => `${t.order}=${t.key}`).join(' ')}\n画像: ${out}/orig/pages と ${out}/mir/pages`);
