/**
 * 型カタログを AI に渡す文章にする。欄の上限（字数・行数）はカタログの値だけを読む（2-3 原則7・17章）。
 * 色・位置・大きさ・字体は渡さない（AI に決めさせないものは、見せもしない）。
 */
import type { Catalog, CatalogSlot, CatalogType } from '../catalog/build-catalog.js';
import type { DeckLanguage } from './locale.js';

/** 欄の名前の意味（テンプレート契約 6-2 の名前の付け方の説明。型ごとの値ではない） */
export const SLOT_GLOSSARY = `欄の名前の意味:
- txt.headline: そのページの見出し（最初に見せる情報）
- txt.subtitle: 見出しを受ける副題
- txt.eyebrow: 見出しの脇に斜めに置く英字の小さなラベル（飾りに近い。英語で1〜3語。原稿の内容に沿った一般的な語）
- txt.body: 説明文（最後に読ませる情報）
- txt.point.N.lead / txt.point.N.main: 要点N の小見出しと要点
- txt.item.N / txt.item.N.title / txt.item.N.body / txt.item.N.caption: 並べる項目N（題・説明・写真の説明）
- txt.label.N / num.value.N / txt.unit.N / txt.note.N: 数値N のラベル・数値・単位・説明
- txt.footnote: 注記（出典・条件など）
- num.*: 数字だけを入れる欄（桁区切りや小数点・%・/ は可。原稿にある数字だけ）
- img.*: 写真の欄（文言は入れない。写真に求めるものを短く書く）`;

const slotLine = (s: CatalogSlot, language: DeckLanguage) => {
  if (s.kind === 'img') return `${s.name}: 写真（縦横比 ${s.aspect}）`;
  // 英語の資料では、英字の数で上限を伝える（全角の字数だと英文には短すぎる）
  if (language === 'en' && s.kind !== 'num' && s.maxCharsLatin && s.maxLines) {
    const perLine = Math.floor(s.maxCharsLatin / s.maxLines);
    return `${s.name}: 英字なら最大約${s.maxCharsLatin}字（1行約${perLine}字×${s.maxLines}行）`;
  }
  return `${s.name}: 最大${s.maxChars}字（1行${s.maxCharsPerLine}字×${s.maxLines}行${s.kind === 'num' ? `・英数字なら${s.maxCharsLatin}字` : ''}）`;
};

export function describeType(t: CatalogType, language: DeckLanguage = 'ja'): string {
  return `■ ${t.key}（${t.label}）役割: ${t.role.join(', ')}\n` + t.slots.map((s) => `  - ${slotLine(s, language)}`).join('\n');
}

export function describeCatalog(cat: Catalog, language: DeckLanguage = 'ja'): string {
  return `${SLOT_GLOSSARY}\n\n使える型（${cat.types.length}種）:\n` + cat.types.map((t) => describeType(t, language)).join('\n');
}

/** A段に渡す役割の一覧（どの役割に何件の項目を並べられるか） */
export function describeRoles(cat: Catalog): string {
  return cat.roles
    .map((r) => {
      const ts = cat.types.filter((t) => t.role.includes(r));
      return `- ${r}: ${ts.map((t) => t.label).join('／')}`;
    })
    .join('\n');
}

export const textSlots = (t: CatalogType) => t.slots.filter((s) => s.kind !== 'img');
export const imageSlots = (t: CatalogType) => t.slots.filter((s) => s.kind === 'img');
export const typeId = (key: string) => key.split('/')[0];
