/**
 * 画面に出す言葉。仕組みの中の名前（欄の名前・指摘の記号・段）を、使う人が読める言葉に直す（日本語と英語）。
 * 指摘の記号は IssueCode の Record にしてあるので、記号を足したのにここを書き忘れると型の検査で止まる。
 * 英語の表も同じ型の Record（書き忘れると型の検査で止まる）。どちらの言語で返すかは画面の X-UI-Lang で決まる。
 */
import type { IssueCode, IssueLevel } from '../check/content.js';
import type { BuildStep } from '../run/build.js';
import { currentLang, type UiLang } from './i18n.js';

const N = (s: string) => s.replace(/\d+/g, (d) => String(Number(d)));

type FixedSlot = 'txt.headline' | 'txt.subtitle' | 'txt.eyebrow' | 'txt.body' | 'txt.footnote' | 'img.hero' | 'img.left' | 'img.right' | 'img.side';
type SlotPatterns = {
  fixed: Record<FixedSlot, string>;
  pointLead: (n: string) => string;
  point: (n: string) => string;
  item: (n: string) => string;
  itemTitle: (n: string) => string;
  itemBody: (n: string) => string;
  label: (n: string) => string;
  value: (n: string) => string;
  unit: (n: string) => string;
  note: (n: string) => string;
  itemPhoto: (n: string) => string;
};

const SLOT_WORDS: Record<UiLang, SlotPatterns> = {
  ja: {
    fixed: {
      'txt.headline': '大見出し',
      'txt.subtitle': '副題',
      'txt.eyebrow': '英字の小さなラベル',
      'txt.body': '本文',
      'txt.footnote': '注記',
      'img.hero': 'メインの写真',
      'img.left': '左の写真',
      'img.right': '右の写真',
      'img.side': '横の写真',
    },
    pointLead: (n) => `要点${n}の小見出し`,
    point: (n) => `要点${n}`,
    item: (n) => `項目${n}`,
    itemTitle: (n) => `項目${n}の題`,
    itemBody: (n) => `項目${n}の説明`,
    label: (n) => `数字${n}の見出し`,
    value: (n) => `数字${n}`,
    unit: (n) => `数字${n}の単位`,
    note: (n) => `数字${n}の補足`,
    itemPhoto: (n) => `項目${n}の写真`,
  },
  en: {
    fixed: {
      'txt.headline': 'Headline',
      'txt.subtitle': 'Subtitle',
      'txt.eyebrow': 'Small label',
      'txt.body': 'Body text',
      'txt.footnote': 'Footnote',
      'img.hero': 'Main photo',
      'img.left': 'Left photo',
      'img.right': 'Right photo',
      'img.side': 'Side photo',
    },
    pointLead: (n) => `Point ${n} heading`,
    point: (n) => `Point ${n}`,
    item: (n) => `Item ${n}`,
    itemTitle: (n) => `Item ${n} title`,
    itemBody: (n) => `Item ${n} description`,
    label: (n) => `Figure ${n} heading`,
    value: (n) => `Figure ${n}`,
    unit: (n) => `Figure ${n} unit`,
    note: (n) => `Figure ${n} note`,
    itemPhoto: (n) => `Item ${n} photo`,
  },
};

/** 欄の名前 → 画面の名前（txt.item.2.title → 項目2の題／Item 2 title） */
export function slotLabel(name: string, lang: UiLang = currentLang()): string {
  const w = SLOT_WORDS[lang];
  let m: RegExpMatchArray | null;
  if (name in w.fixed) return w.fixed[name as FixedSlot];
  if ((m = name.match(/^txt\.point\.(\d+)\.lead$/))) return w.pointLead(N(m[1]));
  if ((m = name.match(/^txt\.point\.(\d+)\.main$/))) return w.point(N(m[1]));
  if ((m = name.match(/^txt\.item\.(\d+)$/))) return w.item(N(m[1]));
  if ((m = name.match(/^txt\.item\.(\d+)\.title$/))) return w.itemTitle(N(m[1]));
  if ((m = name.match(/^txt\.item\.(\d+)\.body$/))) return w.itemBody(N(m[1]));
  if ((m = name.match(/^txt\.item\.(\d+)\.caption$/))) return w.itemBody(N(m[1]));
  if ((m = name.match(/^txt\.label\.(\d+)$/))) return w.label(N(m[1]));
  if ((m = name.match(/^num\.value\.(\d+)$/))) return w.value(N(m[1]));
  if ((m = name.match(/^txt\.unit\.(\d+)$/))) return w.unit(N(m[1]));
  if ((m = name.match(/^txt\.note\.(\d+)$/))) return w.note(N(m[1]));
  if ((m = name.match(/^img\.item\.(\d+)$/))) return w.itemPhoto(N(m[1]));
  return name;
}

/** 文の中に出てくる欄の名前（txt.item.1.title など）を画面の名前に置き換える */
export function plainText(s: string, lang: UiLang = currentLang()): string {
  if (lang === 'en')
    return s
      .replace(/「?\b((?:txt|num|img)\.[a-z]+(?:\.\d+)?(?:\.[a-z]+)?)\b」?/g, (_, m: string) => `"${slotLabel(m, 'en')}"`)
      .replace(/num\.\* と説明の欄/g, 'the figure and note fields')
      .replace(/txt\.note\.\* /g, 'the note field ');
  const [figures, notes] = ['数字の欄と補足の欄', '補足の欄'];
  return s
    .replace(/\b(?:txt|num|img)\.[a-z]+(?:\.\d+)?(?:\.[a-z]+)?\b/g, (m) => `「${slotLabel(m, lang)}」`)
    .replace(/num\.\* と説明の欄/g, figures)
    .replace(/txt\.note\.\* /g, notes)
    .replace(/「「/g, '「')
    .replace(/」」/g, '」');
}

export type IssueWords = {
  /** 何が起きたか（一言） */
  title: string;
  /** どうすればよいか */
  action: string;
};

const ISSUE_WORDS_JA: Record<IssueCode, IssueWords> = {
  OVERFLOW: { title: '文字が枠に収まっていません', action: '文字を短くするか、「AIに直してもらう」で「短く」と頼んでください。' },
  HEADLINE_LINES: { title: '見出しが長すぎます', action: '見出しを短くしてください（2行まで）。' },
  DUMMY_LEFT: { title: '空の欄か、見本の文言が残っています', action: 'その欄に入れる文言を書いてください。' },
  NUMBER_NOT_IN_SOURCE: { title: '原稿に無い数字が入っています', action: '原稿を見て、正しい数字に直してください。数字は原稿にあるものだけを使います。' },
  NAME_NOT_IN_SOURCE: { title: '原稿に無い言葉が入っています', action: '社名・製品名・人名なら、正しいかを確かめてください。問題なければそのままで構いません。' },
  EMPHASIS_TOO_MANY: { title: '強調が多すぎます', action: '強調（下線）は1ページ2か所までです。いちばん見てほしい語だけに減らしてください。' },
  SAME_TYPE_IN_ROW: { title: '同じ形のページが続いています', action: '単調に見えるので、「ページの形を替える」で別の形にするとよくなります。' },
  TRIMMED: { title: '入りきらなかったので文を切り詰めました', action: '意味が通るかを読んで確かめてください。' },
  LIGHT_DARK_RATIO: { title: '白と黒の割合がデザインルールと違います', action: '気になる場合は、写真や形を替えてください。' },
  VISUAL_REVIEW: { title: 'AIが見た目で気になった点です', action: '画像を見て、気になるようなら直してください。' },
  PPTX_REPAIR: { title: 'ファイルの作りか字体に問題があります', action: '管理者に連絡してください（テンプレートか字体の設定の問題です）。' },
  SLIDE_COUNT: { title: 'ページ数が想定と違います', action: '管理者に連絡してください。' },
  NUMBER_REPEATED: { title: '同じ数字が並んでいます', action: '数字を並べるページには、それぞれ別の数字を入れます。原稿に数字が足りなければ、形を替えてください（「形を替える」）。' },
  SLOT_RULE: { title: '欄の使い方が決まりと違います', action: '単位の欄には単位だけ（例：%・万円）を入れ、説明は補足の欄に書いてください。' },
  PHOTO_NOT_GENERATED: { title: '写真を作れなかった欄があります', action: '見本の写真のままです。「写真」で手元の写真に替えるか、管理者に連絡してください（写真を作るサービスの残高や鍵の問題です）。' },
  FACE_COVERED: { title: '人の顔が図形に隠れています', action: '「写真」で顔の位置が違う写真に替えるか、「形を替える」で写真の見え方が違う形を選んでください。' },
  GLYPH_MISSING: { title: 'この字体では表示できない記号があります', action: '別の書き方にしてください（例：「→」は「から」「へ」）。' },
};

const ISSUE_WORDS_EN: Record<IssueCode, IssueWords> = {
  OVERFLOW: { title: 'Text does not fit in its box', action: 'Shorten the text, or use "Ask AI" and ask it to make the text shorter.' },
  HEADLINE_LINES: { title: 'The headline is too long', action: 'Shorten the headline (two lines at most).' },
  DUMMY_LEFT: { title: 'A field is empty or still has sample text', action: 'Write the text that belongs in that field.' },
  NUMBER_NOT_IN_SOURCE: { title: 'A number that is not in the manuscript', action: 'Check the manuscript and correct the number. Only numbers from the manuscript are used.' },
  NAME_NOT_IN_SOURCE: { title: 'A word that is not in the manuscript', action: 'If it is a company, product or person name, check that it is correct. If it is fine, you can leave it.' },
  EMPHASIS_TOO_MANY: { title: 'Too much emphasis', action: 'Use emphasis (underline) in at most two places per page. Keep only the words that matter most.' },
  SAME_TYPE_IN_ROW: { title: 'Several pages in a row use the same layout', action: 'It may look repetitive. Use "Change layout" to pick a different layout.' },
  TRIMMED: { title: 'Text was shortened to fit', action: 'Read it and check that it still makes sense.' },
  LIGHT_DARK_RATIO: { title: 'The balance of light and dark pages differs from the design rules', action: 'If it bothers you, change the photos or layouts.' },
  VISUAL_REVIEW: { title: 'A point the AI noticed when checking the look', action: 'Look at the page image and fix it if needed.' },
  PPTX_REPAIR: { title: 'There is a problem with the file structure or fonts', action: 'Contact your administrator (this is a template or font setting problem).' },
  SLIDE_COUNT: { title: 'The number of pages is not as expected', action: 'Contact your administrator.' },
  NUMBER_REPEATED: { title: 'The same number appears more than once', action: 'Pages that list figures need a different number in each place. If the manuscript does not have enough numbers, change the layout ("Change layout").' },
  SLOT_RULE: { title: 'A field is not used as intended', action: 'Put only the unit (for example %, million) in the unit field, and write explanations in the note field.' },
  PHOTO_NOT_GENERATED: { title: 'Some photos could not be created', action: 'The template sample photo is still there. Replace it with your own photo in "Photos", or contact your administrator (a balance or key problem with the photo service).' },
  FACE_COVERED: { title: 'A face is covered by a shape', action: 'In "Photos", choose a photo with the face in a different place, or use "Change layout" to pick a layout that shows the photo differently.' },
  GLYPH_MISSING: { title: 'A symbol cannot be shown in this font', action: 'Write it another way (for example "to" instead of an arrow).' },
};

export const ISSUE_WORDS: Record<UiLang, Record<IssueCode, IssueWords>> = { ja: ISSUE_WORDS_JA, en: ISSUE_WORDS_EN };

export const LEVEL_WORDS: Record<UiLang, Record<IssueLevel, string>> = {
  ja: { error: '直してください', warning: '確認してください' },
  en: { error: 'Fix', warning: 'Check' },
};

/** 作成の段（画面の進み具合）。weight は実測（20枚・10枚の実行）のおおよその時間の割合 */
export const STEP_WORDS: Record<Exclude<BuildStep, 'done'>, { label: string; weight: number }> = {
  outline: { label: '原稿を読んで、ページ割りを考えています', weight: 6 },
  plan: { label: 'ページごとに文章を書き、枠に収まるかを測っています', weight: 14 },
  photos: { label: '写真を用意しています', weight: 33 },
  assemble: { label: 'PowerPoint に組み立てています', weight: 2 },
  render: { label: 'ページの画像を作っています', weight: 11 },
  review: { label: 'AIが見た目を確かめています', weight: 18 },
  redo: { label: '気になったページを直しています', weight: 14 },
  check: { label: '最後の検査をしています', weight: 2 },
};

export const STEP_ORDER = Object.keys(STEP_WORDS) as Array<keyof typeof STEP_WORDS>;

const STEP_LABELS_EN: Record<keyof typeof STEP_WORDS, string> = {
  outline: 'Reading the manuscript and planning the pages',
  plan: 'Writing the text for each page and checking it fits',
  photos: 'Preparing photos',
  assemble: 'Building the PowerPoint file',
  render: 'Creating page images',
  review: 'The AI is checking the look',
  redo: 'Fixing pages that need attention',
  check: 'Running final checks',
};

export function stepLabel(step: keyof typeof STEP_WORDS, lang: UiLang = currentLang()): string {
  return lang === 'en' ? STEP_LABELS_EN[step] : STEP_WORDS[step].label;
}

/** 段の補足（build が書く「2回目・3ページ」「3ページ」）を画面の言語に */
export function stepDetail(detail: string, lang: UiLang = currentLang()): string {
  if (lang === 'ja') return detail;
  return detail
    .replace(/(\d+)回目・(\d+)ページ/g, (_, r, p) => `round ${r}, ${p} page${p === '1' ? '' : 's'}`)
    .replace(/(\d+)ページ/g, (_, p) => `${p} page${p === '1' ? '' : 's'}`);
}

/**
 * ページの形（型）の英語の名前。型の名前はテンプレートが持つ日本語なので、型の記号（key）で英語を引く。
 * 知らない型（新しいテンプレート）は日本語の名前のまま出す（英語を足すのはここ）。
 */
export const TYPE_LABELS_EN: Record<string, string> = {
  cover: 'Cover (photo + 3 key points)',
  'issues/2': 'Issues (2 items)',
  'issues/3': 'Issues (3 items)',
  'issues/4': 'Issues (4 items)',
  'numbers/3': 'Key figures (3 numbers)',
  attention: 'Highlight (restate an important point)',
  section: 'Section divider (chapter title)',
  'steps/3': 'Photo row (3 steps)',
  'steps/4': 'Photo row (4 steps)',
  collage: 'Photo collage (closing / alternative cover)',
  'toc/3': 'Contents (3 items)',
  'toc/4': 'Contents (4 items)',
  'toc/5': 'Contents (5 items)',
  'photo-text/a': 'Photo + text A (heading and paragraph)',
  'photo-text/b': 'Photo + text B (heading and 3 points)',
};

export function typeLabel(key: string, jaLabel: string, lang: UiLang = currentLang()): string {
  return lang === 'en' ? (TYPE_LABELS_EN[key] ?? jaLabel) : jaLabel;
}

/** テンプレートの英語の名前（templates/labels.json の id ごと）。無ければ日本語の名前のまま */
export const TEMPLATE_NAMES_EN: Record<string, string> = {
  provisional: 'Provisional template (blue)',
  'provisional-green': 'Provisional template (green)',
};

export function templateName(id: string, jaName: string, lang: UiLang = currentLang()): string {
  return lang === 'en' ? (TEMPLATE_NAMES_EN[id] ?? jaName) : jaName;
}

/** 仕上げの記録（元に戻すときに出す「何を直したか」）。版のファイルには種類と値を残し、出すときに言語を選ぶ */
export type HistoryEvent =
  | { kind: 'text'; page: number }
  | { kind: 'ai'; page: number; instruction: string }
  | { kind: 'type'; page: number; typeKey: string; typeLabel: string }
  | { kind: 'photo'; page: number; slot: string }
  | { kind: 'mirror'; page: number };

const HISTORY_WORDS: Record<UiLang, { [K in HistoryEvent['kind']]: (e: Extract<HistoryEvent, { kind: K }>) => string }> = {
  ja: {
    text: (e) => `${e.page}ページ目の文字を直した`,
    ai: (e) => `${e.page}ページ目をAIに直してもらった（${e.instruction.slice(0, 30)}）`,
    type: (e) => `${e.page}ページ目の形を「${e.typeLabel}」に替えた`,
    photo: (e) => `${e.page}ページ目の写真（${slotLabel(e.slot, 'ja')}）を替えた`,
    mirror: (e) => `${e.page}ページ目の左右を入れ替えた`,
  },
  en: {
    text: (e) => `Edited the text on page ${e.page}`,
    ai: (e) => `AI revised page ${e.page} (${e.instruction.slice(0, 30)})`,
    type: (e) => `Changed page ${e.page} to the "${typeLabel(e.typeKey, e.typeLabel, 'en')}" layout`,
    photo: (e) => `Replaced the photo (${slotLabel(e.slot, 'en')}) on page ${e.page}`,
    mirror: (e) => `Flipped page ${e.page} left to right`,
  },
};

export function historyLabel(e: HistoryEvent, lang: UiLang = currentLang()): string {
  const f = HISTORY_WORDS[lang][e.kind] as (x: HistoryEvent) => string;
  return f(e);
}

/** 打ちながらの検査で、枠に収まらない理由（英語は数から作り直す。日本語は測る道具の文のまま） */
export function fitReason(reason: string | null, f: { chars: number; lines: number; maxLines: number | null; perLine: number | null }, lang: UiLang = currentLang()): string | null {
  if (!reason || lang === 'ja') return reason;
  if (reason === '空です') return 'Empty';
  if (reason.startsWith('「')) {
    const word = reason.match(/^「([^」]*)」/)?.[1] ?? '';
    return `"${word}" does not fit on one line (numbers and words cannot be broken across lines)`;
  }
  const ln = (n: number | null) => `${n ?? '?'} line${n === 1 ? '' : 's'}`;
  return `Up to ${f.perLine ?? '?'} characters × ${ln(f.maxLines)}. Now ${f.chars} characters in ${ln(f.lines)}`;
}

/** 名前が無いときの資料の名前 */
export const UNTITLED: Record<UiLang, string> = { ja: '無題の資料', en: 'Untitled deck' };
