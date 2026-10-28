/**
 * 文言の中身の検査（REQUIREMENTS 11章）。B段の書き直し指示と、出来上がった PPTX の検査の両方がこれを使う（原則7）。
 */

export type IssueLevel = 'error' | 'warning';
export type IssueCode =
  | 'OVERFLOW'
  | 'HEADLINE_LINES'
  | 'DUMMY_LEFT'
  | 'NUMBER_NOT_IN_SOURCE'
  | 'NAME_NOT_IN_SOURCE'
  | 'EMPHASIS_TOO_MANY'
  | 'SAME_TYPE_IN_ROW'
  | 'TRIMMED'
  | 'LIGHT_DARK_RATIO'
  | 'VISUAL_REVIEW'
  | 'PPTX_REPAIR'
  | 'SLIDE_COUNT'
  /** 欄の使い方の決まり（単位の欄に数字を入れない など）。B段で書き直させ、残れば注意 */
  | 'SLOT_RULE'
  /** 欄の字体に無い文字（描画で別の字体に置き換わる） */
  | 'GLYPH_MISSING'
  /** 写真の人の顔が、上に重なる図形（色ベタ）に隠れている */
  | 'FACE_COVERED'
  /** 数字を並べる型で、同じ数字（と単位）を繰り返している。原稿に数字が足りないのに数字の型を選んだとき */
  | 'NUMBER_REPEATED'
  /** 写真を生成できなかった（残高切れなど）。その欄は見本の写真のまま */
  | 'PHOTO_NOT_GENERATED';

export type Issue = { code: IssueCode; level: IssueLevel; page?: number; slot?: string; message: string };

/** 11章の「止める／注意」。コードごとに1か所で決める */
export const LEVEL: Record<IssueCode, IssueLevel> = {
  OVERFLOW: 'error',
  HEADLINE_LINES: 'error',
  DUMMY_LEFT: 'error',
  NUMBER_NOT_IN_SOURCE: 'error',
  NAME_NOT_IN_SOURCE: 'warning',
  EMPHASIS_TOO_MANY: 'error',
  SAME_TYPE_IN_ROW: 'warning',
  TRIMMED: 'warning',
  LIGHT_DARK_RATIO: 'warning',
  VISUAL_REVIEW: 'warning',
  PPTX_REPAIR: 'error',
  SLIDE_COUNT: 'warning',
  SLOT_RULE: 'warning',
  FACE_COVERED: 'warning',
  GLYPH_MISSING: 'error',
  NUMBER_REPEATED: 'error',
  PHOTO_NOT_GENERATED: 'warning',
};

export const issue = (code: IssueCode, message: string, where: { page?: number; slot?: string } = {}): Issue => ({ code, level: LEVEL[code], ...where, message });

const toHalf = (s: string) => s.replace(/[０-９，．％]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** 文言の中の数字（「2,000」「3.5」「10」）を、桁区切りを外した形で取り出す */
export function numbersIn(text: string): string[] {
  const t = toHalf(text);
  const out: string[] = [];
  for (const m of t.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)) out.push(m[0].replace(/,/g, ''));
  return out;
}

/** 原稿に無い数字 */
export function numbersNotIn(text: string, source: Set<string>): string[] {
  return [...new Set(numbersIn(text).filter((n) => !source.has(n)))];
}

/**
 * 原稿にある数字。丸数字（①〜⑳）もその数として数える：「①②③」と並べた原稿から「3つの施策」と書くのは原稿どおり
 * （2026-10-27 実例：丸数字を数えず「3」を原稿に無い数字として3回とも弾き、作成が止まった）
 */
export const sourceNumbers = (manuscript: string) => {
  const s = new Set(numbersIn(manuscript));
  for (const m of manuscript.matchAll(/[①-⑳]/g)) s.add(String(m[0].charCodeAt(0) - 0x2460 + 1));
  return s;
};

/**
 * 固有名詞らしき語（英字の語・3字以上のカタカナ語・会社の表記）のうち、原稿に無いもの。
 * 「らしき」なので注意どまり（11章）。一般のカタカナ語も拾うので、レポートで人が見る。
 */
export function namesNotIn(text: string, manuscript: string): string[] {
  const plain = text.replace(/\[\[|\]\]/g, '');
  const src = manuscript.toLowerCase();
  const found = new Set<string>();
  for (const m of plain.matchAll(/[A-Za-z][A-Za-z0-9&'.\-]*[A-Za-z0-9]|[A-Za-z]{2,}/g)) found.add(m[0]);
  for (const m of plain.matchAll(/[ァ-ヴ][ァ-ヴー・]{2,}/g)) found.add(m[0]);
  // 会社の表記（名前の部分は漢字・カタカナ・英数字。ひらがなで止める＝「の」「が」などの助詞を含めない）
  for (const m of plain.matchAll(/(?:株式会社|有限会社|合同会社)[一-龥ァ-ヴーA-Za-z0-9&]{1,12}|[一-龥ァ-ヴーA-Za-z0-9&]{1,12}(?:株式会社|有限会社|合同会社)/g)) found.add(m[0]);
  const missing = [...found].filter((w) => !src.includes(w.toLowerCase()));
  // 長い語に含まれる短い語（会社名の中のカタカナなど）は重ねて出さない
  return missing.filter((w) => !missing.some((o) => o !== w && o.includes(w)));
}

/** 強調の印の数 */
export const emphasisCount = (text: string) => (text.match(/\[\[[^[\]]*\]\]/g) ?? []).length;

/** 見本のダミー文言が残っているか（見本と同じ文言・「ダミー」「Dummy」を含む） */
export function isDummy(text: string, sample: string | undefined): boolean {
  const t = text.replace(/\[\[|\]\]/g, '').trim();
  if (!t) return false;
  if (sample && t === sample.trim()) return true;
  return /ダミー|dummy/i.test(t);
}

/**
 * 数字の表記を原稿に合わせる（「4800」→ 原稿の「4,800」）。値は変えず、桁区切りの付け方だけを戻す。
 * 原稿に同じ値が桁区切り付きでしか無いときだけ直す。
 */
export function restoreNumberNotation(text: string, manuscript: string): string {
  const forms = new Map<string, string>();
  for (const m of toHalf(manuscript).matchAll(/\d+(?:,\d{3})+(?:\.\d+)?/g)) forms.set(m[0].replace(/,/g, ''), m[0]);
  const bare = new Set([...toHalf(manuscript).matchAll(/(?<![\d,])\d{4,}(?![\d,])/g)].map((m) => m[0]));
  return text.replace(/(?<![\d,.])\d{4,}(?![\d,])/g, (n) => (forms.has(n) && !bare.has(n) ? forms.get(n)! : n));
}
