/**
 * どのページを左右反転するか（D-042）。AI ではなく、決まりでコードが決める（17章）。
 * 先方のデザインルール「一定のルールによって統一感をつくり、そのルールの中で意図的に変化をつける」（はじめに）と
 * 「偏り・余白・大小差を意図的につくることで、画面に動きとリズムを生み出す」（5-4）に沿って：
 *   1. 表紙（1ページ目）は見本どおり（資料の顔を毎回そろえる）
 *   2. 写真が左右どちらかに寄る型は、前に写真が寄っていた側と反対側に来るように向きを選ぶ（左・右・左…と交互）
 *   3. 写真の寄らない型（中扉など）は、同じ型が前に出たときと向きを変える
 * 反転してよい型はテンプレートの設定（mirror）で決める。人が仕上げの画面で替えた向きはこの決まりより優先する。
 */
import type { Catalog, CatalogType } from '../catalog/build-catalog.js';
import type { TemplateConfig } from '../catalog/config.js';
import type { DeckPlan } from './schema.js';

/** 写真の重心が中心からこの割合より寄っていれば「左右どちらかに寄る」 */
const SIDE_THRESHOLD = 0.08;

/** 型の写真が寄っている側（見本どおりの向きで）：-1＝左、1＝右、0＝寄らない */
export function photoSide(t: CatalogType, slideW: number): -1 | 0 | 1 {
  const imgs = t.slots.filter((s) => s.kind === 'img');
  const area = imgs.reduce((a, s) => a + s.box.w * s.box.h, 0);
  if (!area) return 0;
  const cx = imgs.reduce((a, s) => a + (s.box.x + s.box.w / 2) * s.box.w * s.box.h, 0) / area;
  const off = cx / slideW - 0.5;
  return Math.abs(off) < SIDE_THRESHOLD ? 0 : off < 0 ? -1 : 1;
}

export const canMirror = (cfg: Pick<TemplateConfig, 'mirror'>, type: string) => Object.prototype.hasOwnProperty.call(cfg.mirror, type);

/** 設計図の各ページの mirrored を決める（人が決めたページ＝keep に入っているページは変えない） */
export function chooseMirrors(plan: DeckPlan, catalog: Catalog, cfg: Pick<TemplateConfig, 'mirror'>, keep: ReadonlySet<number> = new Set()): void {
  const W = catalog.template.slideSize.w;
  let prevSide = 0;
  const lastOfType = new Map<string, boolean>();
  plan.pages.forEach((p, i) => {
    const t = catalog.types.find((x) => x.key === p.type);
    const allowed = !!t && i > 0 && canMirror(cfg, p.type);
    if (!keep.has(i + 1)) {
      if (!allowed) p.mirrored = false;
      else {
        const side = photoSide(t!, W);
        p.mirrored = side !== 0 ? side === prevSide : lastOfType.has(p.type) ? !lastOfType.get(p.type) : false;
      }
    }
    if (t) {
      const side = photoSide(t, W) * (p.mirrored ? -1 : 1);
      if (side !== 0) prevSide = side;
      lastOfType.set(p.type, !!p.mirrored);
    }
  });
}
