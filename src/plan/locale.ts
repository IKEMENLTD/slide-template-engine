/**
 * 資料の言語と、写真に写る人物（D-043 英語対応）。
 * 作るときに使う人が選ぶ。選ばなかった古い実行は日本語・日本人（これまでどおり）。
 * プロンプトの指示文は日本語のまま（AI は読める）で、「資料の文言を何語で書くか」だけをここから差し込む。
 */
import { z } from 'zod';

export const DeckLanguageSchema = z.enum(['ja', 'en']);
export type DeckLanguage = z.infer<typeof DeckLanguageSchema>;
export const PhotoPeopleSchema = z.enum(['japanese', 'indian', 'mixed']);
export type PhotoPeople = z.infer<typeof PhotoPeopleSchema>;

export type DeckLocale = { language: DeckLanguage; people: PhotoPeople };
export const DEFAULT_LOCALE: DeckLocale = { language: 'ja', people: 'japanese' };

/** 古い実行（言語の記録が無い）でも読めるように、欠けていれば既定で埋める */
export function localeOf(x: { language?: string; people?: string } | undefined | null): DeckLocale {
  const language = DeckLanguageSchema.safeParse(x?.language);
  const people = PhotoPeopleSchema.safeParse(x?.people);
  return { language: language.success ? language.data : DEFAULT_LOCALE.language, people: people.success ? people.data : DEFAULT_LOCALE.people };
}

/** 原稿がどちらの言葉で書かれているか（画面の初期値に使う）。仮名・漢字が1割を超えれば日本語 */
export function detectLanguage(text: string): DeckLanguage {
  const letters = [...text].filter((c) => /[A-Za-z぀-ヿ一-鿿]/.test(c));
  if (!letters.length) return 'ja';
  const cjk = letters.filter((c) => /[぀-ヿ一-鿿]/.test(c)).length;
  return cjk / letters.length > 0.1 ? 'ja' : 'en';
}

/** 写真の生成プロンプトに入れる、人物の決まり（英語） */
export const PEOPLE_PROMPT: Record<PhotoPeople, { audience: string; people: string }> = {
  japanese: { audience: 'a Japanese corporate presentation', people: 'All people are Japanese.' },
  indian: { audience: 'an Indian corporate presentation', people: 'All people are Indian, dressed as is usual in Indian workplaces.' },
  mixed: { audience: 'an international corporate presentation', people: 'The people are a natural mix of nationalities, as in an international workplace.' },
};

/** 写真の割り当て（AI）に伝える、人物の決まり */
export const PEOPLE_RULE: Record<PhotoPeople, string> = {
  japanese: '人物は日本人。',
  indian: '人物はインド人（インドの職場での自然な服装）。',
  mixed: '人物はさまざまな国籍（国際的な職場）。',
};

/**
 * B段の決まりのうち、言語で変わるもの。数字の扱いは「原稿に無い数字は書かない」の検査に合わせる：
 * 英語の資料でも「300万円」を「3 million」と書くと、原稿に無い数字「3」になってしまう。桁をそのまま数字で書かせる。
 */
export function languageRules(language: DeckLanguage): string {
  if (language === 'ja') return '- 原稿の言葉づかいを生かし、資料として自然な日本語にする。体言止めや短い句でよい。';
  return [
    '- ★資料の文言（txt.* と num.* の欄、deckTitle）は、すべて英語で書く。原稿が日本語なら英語に訳す。ビジネスの資料として自然で簡潔な英語にする（見出しは短い句でよい。インドの読み手にも自然な、平易なビジネス英語）。',
    '- 欄の最大字数は、英語では「英字なら◯字」の数を目安にする（英字は全角の約半分の幅）。単語の途中では折り返さないので、長い単語を避けて短く言い換える。',
    '- 数字は原稿の数字をそのまま使う。「万」「億」は桁を数字で書く（300万円 → 3,000,000 yen。million や lakh などの語で桁を言い換えない）。円は yen（または JPY）と書く。',
    '- txt.unit.* には英語の単位だけ（"%" "hours" "cases" "yen" など）を入れる。',
    '- 写真の欄（photos）の説明は、日本語でよい（写真を選ぶためのメモ）。',
  ].join('\n');
}

/** A段（ページ割り）に足す一文 */
export function outlineLanguageRule(language: DeckLanguage): string {
  return language === 'ja' ? '' : '\n- ★資料は英語で作る。catch・body・details・emphasis・deckTitle は英語で書く（原稿が日本語なら英語に訳す）。数字は原稿の数字をそのまま使い、「万」「億」は桁を数字で書く（300万 → 3,000,000）。sourceQuotes だけは原稿の文をそのまま写す。';
}
