/**
 * 写真の割り当て（C段）。Phase 2 は支給の写真を順に割り当てる（同じページで同じ写真を使わない）。
 * 写真は枠の縦横比に切り抜き、設定どおりモノクロ・乗算にしてから差し込む（7章C・D-003）。
 */
import path from 'node:path';
import type { Catalog } from '../catalog/build-catalog.js';
import type { TemplateConfig } from '../catalog/config.js';
import type { DeckPlan } from '../plan/schema.js';
import { loadPhotoLibrary, processPhoto, resolveColor } from './prepare.js';

export async function assignPhotos(a: { plan: DeckPlan; catalog: Catalog; cfg: TemplateConfig; library: string | null; outDir: string }) {
  const lib = a.library ? loadPhotoLibrary(a.library) : [];
  if (!lib.length) return; // 写真が無ければ見本の写真のまま（Phase 3 で生成して埋める）
  let k = 0;
  for (const [i, page] of a.plan.pages.entries()) {
    const t = a.catalog.types.find((x) => x.key === page.type)!;
    page.photoFiles = {};
    const used = new Set<string>();
    for (const s of t.slots.filter((x) => x.kind === 'img')) {
      let pick = lib[k % lib.length];
      for (let tries = 0; tries < lib.length && used.has(pick.path); tries++) pick = lib[++k % lib.length];
      k++;
      used.add(pick.path);
      const proc = s.process ?? { mono: true, multiply: null };
      const name = `p${String(i + 1).padStart(2, '0')}-${s.name.replace(/[^\w.-]/g, '_')}.jpg`;
      await processPhoto(pick.path, path.join(a.outDir, name), s.aspect!, proc, resolveColor(proc.multiply, a.catalog.theme.colors));
      page.photoFiles[s.name] = name;
    }
  }
}
