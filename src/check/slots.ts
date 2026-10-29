/**
 * 1ページ分の欄の文言を検査する。B段（書き直しの指示）と、出来上がった PPTX の検査（E段）が同じ関数を使う（原則7）。
 */
import type { Catalog, CatalogType } from '../catalog/build-catalog.js';
import { matchesAny } from '../catalog/config.js';
import { fitSlot } from '../fit/fit-slot.js';
import { missingGlyphs } from '../fit/measure.js';
import { emphasisCount, isDummy, issue, namesNotIn, numbersIn, numbersNotIn, type Issue } from './content.js';

export type SlotCheckContext = {
  catalog: Catalog;
  headlineMaxLines: number;
  manuscript: string;
  sourceNumbers: Set<string>;
  nameIgnoreSlots: string[];
  /** 単位の欄。単位だけを入れる（数字・文を入れない。数字は num.*、説明は txt.note.* へ） */
  unitSlots: string[];
  resolveFile: (p: string) => string;
  /** 資料の言語（D-043）。英語なら固有名詞の拾い方と文節の改行が変わる。無ければ日本語 */
  language?: 'ja' | 'en';
};

/** num.* の欄に入れてよい文字（数字・桁区切り・小数点・%・/・+・−） */
const NUM_ONLY = /^[0-9０-９.,，．%％/／+＋\-−~〜]+$/;

export function checkPage(page: number, type: CatalogType, slots: Record<string, string>, c: SlotCheckContext): Issue[] {
  const out: Issue[] = [];
  let emphasis = 0;
  for (const s of type.slots) {
    if (s.kind === 'img') continue;
    const text = slots[s.name];
    const where = { page, slot: s.name };
    if (text == null || text.replace(/\[\[|\]\]/g, '').trim() === '') {
      // 空の欄は見本の書式だけが残る。見本の文言を消して空にするので、見た目は「欠け」になる
      out.push(issue('DUMMY_LEFT', `${s.name} が空（見本の文言の代わりに入れる文言が無い）`, where, `${s.name} is empty`));
      continue;
    }
    if (isDummy(text, s.sample)) out.push(issue('DUMMY_LEFT', `${s.name} に見本のダミー文言が残っている: 「${text}」`, where, `${s.name} still has the template's sample text: "${text}"`));
    if (s.kind === 'num' && !NUM_ONLY.test(text.replace(/\[\[|\]\]/g, ''))) out.push(issue('NUMBER_NOT_IN_SOURCE', `${s.name} は数字だけの欄。「${text}」には数字以外が入っている`, where, `${s.name} is for a number only, but "${text}" contains other characters`));
    const bad = numbersNotIn(text, c.sourceNumbers);
    if (bad.length) out.push(issue('NUMBER_NOT_IN_SOURCE', `${s.name} に原稿に無い数字 ${bad.join(', ')} がある`, where, `${s.name} has a number that is not in the manuscript: ${bad.join(', ')}`));
    if (matchesAny(c.unitSlots, s.name)) {
      const plain = text.replace(/\[\[|\]\]/g, '');
      if (numbersIn(plain).length) out.push(issue('SLOT_RULE', `${s.name} は単位だけを入れる欄で、数字は入れない（数字は num.* と説明の欄へ）: 「${text}」`, where, `${s.name} is for the unit only, not numbers: "${text}"`));
      // 単位に平仮名は「か月」の「か」くらいしか使わない。それ以外の平仮名があれば文（「件に減少」）になっている
      else if (/[ぁ-ゖ]/.test(plain.replace(/か月|ヶ月|ヵ月/g, '')) || (c.language === 'en' && plain.trim().split(/\s+/).length > 2)) out.push(issue('SLOT_RULE', `${s.name} は単位だけを入れる欄で、文は入れない（変化や説明は txt.note.* へ）: 「${text}」`, where, `${s.name} is for the unit only, not a sentence (put changes or explanations in the note): "${text}"`));
    }
    if (!matchesAny(c.nameIgnoreSlots, s.name)) {
      const names = namesNotIn(text, c.manuscript, c.language);
      if (names.length) out.push(issue('NAME_NOT_IN_SOURCE', `${s.name} に原稿に無い語 ${names.join('・')} がある（固有名詞なら要確認）`, where, `${s.name} has a word that is not in the manuscript: ${names.join(', ')} (check it if it is a name)`));
    }
    if (s.style) {
      const miss = missingGlyphs(text, { fontFile: c.resolveFile(s.style.fontFile), latinFontFile: c.resolveFile(s.style.latinFontFile) });
      if (miss.length) out.push(issue('GLYPH_MISSING', `${s.name} の「${miss.join('」「')}」は欄の字体に無い文字。別の書き方にする（例：「→」は「から」「へ」）`, where, `${s.name}: the font cannot show "${miss.join('", "')}". Write it another way (for example "INR" instead of the rupee sign, "to" instead of an arrow)`));
    }
    emphasis += emphasisCount(text);
    let fit;
    try {
      fit = fitSlot(s, text, c.catalog.fit, c.resolveFile);
    } catch (e) {
      out.push(issue('OVERFLOW', `${s.name} を測れない: ${(e as Error).message}`, where));
      continue;
    }
    if (!fit.ok) out.push(issue('OVERFLOW', `${s.name}: ${fit.reason}`, where, `${s.name}: ${fit.reasonEn ?? fit.reason}`));
    if (s.name === 'txt.headline' && fit.lineCount > c.headlineMaxLines) out.push(issue('HEADLINE_LINES', `見出しが ${fit.lineCount} 行（${c.headlineMaxLines} 行まで）`, where, `The heading takes ${fit.lineCount} lines (up to ${c.headlineMaxLines})`));
  }
  out.push(...repeatedNumbers(page, type, slots));
  if (emphasis > c.catalog.emphasis.maxPerSlide) out.push(issue('EMPHASIS_TOO_MANY', `強調が ${emphasis} 個（1ページ ${c.catalog.emphasis.maxPerSlide} 個まで）`, { page }, `${emphasis} emphasized words (up to ${c.catalog.emphasis.maxPerSlide} per page)`));
  return out;
}

/**
 * 数字を並べる型で、同じ数字＋単位を繰り返していないか（NUMBER_REPEATED）。
 * 原稿に数字が1つしかないのに数字3つの型を選ぶと、原稿に無い数字は書けないので同じ数字が3回並ぶ（2026-10-27 実例）。
 */
export function repeatedNumbers(page: number, type: CatalogType, slots: Record<string, string>): Issue[] {
  const out: Issue[] = [];
  const seen = new Map<string, string>();
  for (const s of type.slots) {
    if (s.kind !== 'num') continue;
    const v = numbersIn((slots[s.name] ?? '').replace(/\[\[|\]\]/g, '')).join('/');
    if (!v) continue;
    const unit = (slots[s.name.replace(/^num\.value\./, 'txt.unit.')] ?? '').replace(/\[\[|\]\]/g, '').trim();
    const key = `${v}|${unit}`;
    const first = seen.get(key);
    if (first) out.push(issue('NUMBER_REPEATED', `${s.name} が ${first} と同じ数字「${slots[s.name]}${unit}」。並べる数字はそれぞれ別の数にする（原稿に別の数字が無ければ、数字を並べる型は使えない）`, { page, slot: s.name }, `${s.name} repeats the same figure as ${first}: "${slots[s.name]}${unit}". Each figure must be different`));
    else seen.set(key, s.name);
  }
  return out;
}

/** 同じ型ID の連続（11章 SAME_TYPE_IN_ROW） */
export function checkTypeRuns(typeKeys: string[], maxInRow: number): Issue[] {
  const out: Issue[] = [];
  let run = 1;
  for (let i = 1; i < typeKeys.length; i++) {
    run = typeKeys[i].split('/')[0] === typeKeys[i - 1].split('/')[0] ? run + 1 : 1;
    if (run === maxInRow + 1) out.push(issue('SAME_TYPE_IN_ROW', `型 ${typeKeys[i].split('/')[0]} が ${maxInRow} 枚より多く続いている（p${i + 2 - run}〜）`, { page: i + 1 }, `The same layout continues for more than ${maxInRow} pages (from p${i + 2 - run})`));
  }
  return out;
}
