/**
 * 使う人に返す断りの文（AppError と、サーバーが直接返す文）。日本語と英語の2つを持つ。
 * 英語の表は日本語の表と同じ名前の Record にしてあるので、日本語に文を足して英語を書き忘れると型の検査で止まる。
 * 画面の言語は、画面が送る X-UI-Lang（ja / en）で決める（既定は日本語）。
 */
import type { UiLang } from './i18n.js';

export type ErrorParams = Record<string, string | number>;
type Msg = string | ((p: ErrorParams) => string);

const JA = {
  // 鍵・費用
  noAiKey: '文章を作る AI（Claude）の鍵がまだ入っていません。「設定」で入れてください。',
  budgetReached: (p) => `今月の費用が上限（$${p.cap}）に達しました。「設定」で上限を上げるか、来月までお待ちください。`,
  badAnthropicKey: 'Claude の鍵は「sk-ant-」で始まります。貼り付けた文字を確かめてください',
  badOpenaiKey: 'OpenAI の鍵は「sk-」で始まります。貼り付けた文字を確かめてください',
  // 資料
  badRunId: '資料の ID が正しくありません',
  runNotFound: 'その資料は見つかりません',
  emptyManuscript: '原稿が空です',
  notResumable: 'この資料は再開できる状態ではありません',
  cannotDeleteRunning: '作成中の資料は消せません。終わってから消してください',
  notFinished: 'この資料はまだ出来上がっていません',
  // テンプレート
  badTemplateName: 'テンプレートの名前が正しくありません',
  templateNotFound: (p) => `テンプレート「${p.id}」が見つかりません`,
  // 仕上げ
  pageMissing: (p) => `${p.n}ページ目はありません`,
  badPageNumber: 'ページの番号が正しくありません',
  typeMissing: (p) => `ページの形「${p.key}」はこのテンプレートにありません`,
  emptyInstruction: 'どう直してほしいかを書いてください',
  photoSlotMissing: 'その写真の欄はありません',
  photoFormat: '写真は JPEG・PNG・WebP のどれかにしてください',
  photoUnreadable: 'この写真は読み込めませんでした。別の写真を選んでください',
  cannotMirror: 'このページの形は、左右を入れ替えられません',
  nothingToUndo: '戻せる直しがありません',
  // ファイルの受け取り
  fileTooLarge25: 'ファイルが大きすぎます（25MB まで）',
  fileTooLarge: 'ファイルが大きすぎます',
  chooseFile: 'ファイルを選んでください',
  manuscriptFormat: '読み込めるのは Word（.docx）・テキスト（.txt）・マークダウン（.md）です',
  tooManyPhotos: (p) => `写真は1回に${p.max}枚までにしてください`,
  choosePhoto: '写真を選んでください',
  // サーバーの入口
  hostNotAllowed: 'この宛先からは開けません',
  crossSite: '別のサイトからの操作は受け付けません',
  apiNotFound: 'ありません',
  unexpected: (p) => `うまくいきませんでした：${p.message}`,
  webNotBuilt: '画面がまだ組まれていません。npm run app:build を実行してください',
  // 起動したときに作りかけだった資料に書く理由（status.json に残る）
  stoppedOnBoot: 'アプリが止まったため、作成が途中で止まりました。',
} satisfies Record<string, Msg>;

export type ErrorKey = keyof typeof JA;

const EN: Record<ErrorKey, Msg> = {
  noAiKey: 'The API key for the text AI (Claude) has not been set. Please add it in Settings.',
  budgetReached: (p) => `This month's spending has reached the limit ($${p.cap}). Raise the limit in Settings, or wait until next month.`,
  badAnthropicKey: 'A Claude key starts with "sk-ant-". Please check what you pasted.',
  badOpenaiKey: 'An OpenAI key starts with "sk-". Please check what you pasted.',
  badRunId: 'The deck ID is not valid.',
  runNotFound: 'That deck could not be found.',
  emptyManuscript: 'The manuscript is empty.',
  notResumable: 'This deck cannot be resumed in its current state.',
  cannotDeleteRunning: 'A deck that is being created cannot be deleted. Please wait until it finishes.',
  notFinished: 'This deck is not finished yet.',
  badTemplateName: 'The template name is not valid.',
  templateNotFound: (p) => `Template "${p.id}" could not be found.`,
  pageMissing: (p) => `There is no page ${p.n}.`,
  badPageNumber: 'The page number is not valid.',
  typeMissing: (p) => `The layout "${p.key}" is not in this template.`,
  emptyInstruction: 'Please describe how you want the page changed.',
  photoSlotMissing: 'That photo area does not exist.',
  photoFormat: 'Photos must be JPEG, PNG or WebP.',
  photoUnreadable: 'This photo could not be read. Please choose another photo.',
  cannotMirror: 'This layout cannot be flipped left to right.',
  nothingToUndo: 'There is nothing to undo.',
  fileTooLarge25: 'The file is too large (25 MB maximum).',
  fileTooLarge: 'The file is too large.',
  chooseFile: 'Please choose a file.',
  manuscriptFormat: 'Only Word (.docx), text (.txt) and Markdown (.md) files can be read.',
  tooManyPhotos: (p) => `Please add no more than ${p.max} photos at a time.`,
  choosePhoto: 'Please choose a photo.',
  hostNotAllowed: 'This app cannot be opened from this address.',
  crossSite: 'Requests from other sites are not accepted.',
  apiNotFound: 'Not found.',
  unexpected: (p) => `Something went wrong: ${p.message}`,
  webNotBuilt: 'The screens have not been built yet. Run npm run app:build.',
  stoppedOnBoot: 'Creation stopped partway because the app was shut down.',
};

const TABLE: Record<UiLang, Record<ErrorKey, Msg>> = { ja: JA, en: EN };

export function errorText(key: ErrorKey, lang: UiLang = 'ja', params: ErrorParams = {}): string {
  const m = TABLE[lang][key];
  return typeof m === 'function' ? m(params) : m;
}

/** 日本語の文から英語の文を引く（status.json に日本語で残った理由を、英語の画面で出すため） */
export function translateStored(text: string, lang: UiLang): string {
  if (lang === 'ja') return text;
  for (const k of Object.keys(JA) as ErrorKey[]) if (typeof JA[k] === 'string' && JA[k] === text) return errorText(k, lang);
  return text;
}

export const ERROR_KEYS = Object.keys(JA) as ErrorKey[];
