/**
 * 画面に出す言葉。仕組みの中の名前（欄の名前・指摘の記号・段）を、使う人が読める日本語に直す。
 * 指摘の記号は IssueCode の Record にしてあるので、記号を足したのにここを書き忘れると型の検査で止まる。
 */
import type { IssueCode, IssueLevel } from '../check/content.js';
import type { BuildStep } from '../run/build.js';

const N = (s: string) => s.replace(/\d+/g, (d) => String(Number(d)));

/** 欄の名前 → 画面の名前（txt.item.2.title → 項目2の題） */
export function slotLabel(name: string): string {
  let m: RegExpMatchArray | null;
  const fixed: Record<string, string> = {
    'txt.headline': '大見出し',
    'txt.subtitle': '副題',
    'txt.eyebrow': '英字の小さなラベル',
    'txt.body': '本文',
    'txt.footnote': '注記',
    'img.hero': 'メインの写真',
    'img.left': '左の写真',
    'img.right': '右の写真',
    'img.side': '横の写真',
  };
  if (fixed[name]) return fixed[name];
  if ((m = name.match(/^txt\.point\.(\d+)\.lead$/))) return `要点${N(m[1])}の小見出し`;
  if ((m = name.match(/^txt\.point\.(\d+)\.main$/))) return `要点${N(m[1])}`;
  if ((m = name.match(/^txt\.item\.(\d+)$/))) return `項目${N(m[1])}`;
  if ((m = name.match(/^txt\.item\.(\d+)\.title$/))) return `項目${N(m[1])}の題`;
  if ((m = name.match(/^txt\.item\.(\d+)\.body$/))) return `項目${N(m[1])}の説明`;
  if ((m = name.match(/^txt\.item\.(\d+)\.caption$/))) return `項目${N(m[1])}の説明`;
  if ((m = name.match(/^txt\.label\.(\d+)$/))) return `数字${N(m[1])}の見出し`;
  if ((m = name.match(/^num\.value\.(\d+)$/))) return `数字${N(m[1])}`;
  if ((m = name.match(/^txt\.unit\.(\d+)$/))) return `数字${N(m[1])}の単位`;
  if ((m = name.match(/^txt\.note\.(\d+)$/))) return `数字${N(m[1])}の補足`;
  if ((m = name.match(/^img\.item\.(\d+)$/))) return `項目${N(m[1])}の写真`;
  return name;
}

/** 文の中に出てくる欄の名前（txt.item.1.title など）を画面の名前に置き換える */
export function plainText(s: string): string {
  return s
    .replace(/\b(?:txt|num|img)\.[a-z]+(?:\.\d+)?(?:\.[a-z]+)?\b/g, (m) => `「${slotLabel(m)}」`)
    .replace(/num\.\* と説明の欄/g, '数字の欄と補足の欄')
    .replace(/txt\.note\.\* /g, '補足の欄')
    .replace(/「「/g, '「')
    .replace(/」」/g, '」');
}

export type IssueWords = {
  /** 何が起きたか（一言） */
  title: string;
  /** どうすればよいか */
  action: string;
};

export const ISSUE_WORDS: Record<IssueCode, IssueWords> = {
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

export const LEVEL_WORDS: Record<IssueLevel, string> = {
  error: '直してください',
  warning: '確認してください',
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
