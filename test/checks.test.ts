/**
 * 自動検査（REQUIREMENTS 11章）。どの検査も「違反を入れると落ちる／正しいものは通る」の両側を持つ。
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Catalog } from '../src/catalog/build-catalog.js';
import { emphasisCount, isDummy, namesNotIn, numbersIn, numbersNotIn, restoreNumberNotation, sourceNumbers } from '../src/check/content.js';
import { checkPage, checkTypeRuns, type SlotCheckContext } from '../src/check/slots.js';
import { breakByPhrase, phrases } from '../src/fit/phrase-break.js';
import { lineWidth, wrapLines } from '../src/fit/measure.js';
import { buildFixtureCatalog, CONFIG, ROOT } from './helpers.js';
import { numbersNeeded, outlineProblems } from '../src/plan/outline.js';

const cat: Catalog = await buildFixtureCatalog();
const resolveFile = (p: string) => path.join(ROOT, p);
const manuscript = '請求書づくりの時間が月40時間から月8時間に減りました。導入は平均2週間。開発費は2,000万円。業務の属人化が課題です。';
const ctx: SlotCheckContext = { catalog: cat, headlineMaxLines: 2, manuscript, sourceNumbers: sourceNumbers(manuscript), nameIgnoreSlots: ['txt.eyebrow'], unitSlots: ['txt.unit.*'], resolveFile };
const T = (key: string) => cat.types.find((t) => t.key === key)!;

/** 型の文言の欄を、正しい短い文言で埋めた1ページ */
function goodPage(key: string): Record<string, string> {
  const out: Record<string, string> = {};
  const nums = ['8', '40', '2'];
  let k = 0;
  for (const s of T(key).slots) if (s.kind !== 'img') out[s.name] = s.kind === 'num' ? nums[k++ % nums.length] : s.name === 'txt.eyebrow' ? 'Results' : s.name.startsWith('txt.unit.') ? '時間' : '時間が減る';
  return out;
}
const codes = (key: string, slots: Record<string, string>) => checkPage(1, T(key), slots, ctx).map((i) => i.code);

describe('文言の中身の検査', () => {
  it('数字：桁区切り・全角も同じ数として扱い、原稿に無い数字だけを返す', () => {
    expect(numbersIn('２，０００万円と3.5%')).toEqual(['2000', '3.5']);
    const src = sourceNumbers(manuscript);
    expect(numbersNotIn('開発費は2,000万円', src)).toEqual([]);
    expect(numbersNotIn('開発費は3,000万円・期間は2週間', src)).toEqual(['3000']);
  });
  it('数字：丸数字（①②③）で並べた原稿なら「3つの施策」の 3 は原稿にある数字（2026-10-27 実例：これを弾いて作成が止まった）', () => {
    const src = sourceNumbers('施策は\n①TPSを学ぶ\n②IoTを導入する\n③標準作業を定める\n支援は半年300万円');
    expect(numbersNotIn('3つの施策で300万円', src)).toEqual([]);
    expect(numbersNotIn('4つの施策', src)).toEqual(['4']);
  });
  it('固有名詞らしき語：原稿にある語は通し、無い英字・カタカナ・会社名は返す', () => {
    expect(namesNotIn('業務の属人化', manuscript)).toEqual([]);
    expect(namesNotIn('株式会社ミライ製作所のAcmeCloud', manuscript).sort()).toEqual(['AcmeCloud', '株式会社ミライ製作所']);
  });
  it('数字の表記を原稿に合わせる（値は変えない）', () => {
    expect(restoreNumberNotation('投資額 4800 万円', '投資額は4,800万円')).toBe('投資額 4,800 万円');
    expect(restoreNumberNotation('2026年', '2026年の計画。予算は2,026円')).toBe('2026年');
    expect(restoreNumberNotation('4801', '4,800万円')).toBe('4801');
  });
  it('強調の数・ダミーの判定', () => {
    expect(emphasisCount('[[a]]と[[b]]')).toBe(2);
    expect(isDummy('ダミー見出し', undefined)).toBe(true);
    expect(isDummy('Dummy Label', 'Dummy Label')).toBe(true);
    expect(isDummy('導入の流れ', 'ダミー見出し')).toBe(false);
  });
});

describe('1ページの検査（B段と E段が同じものを使う）', () => {
  it('正しいページは何も出ない', () => {
    for (const t of cat.types) expect(codes(t.key, goodPage(t.key)), t.key).toEqual([]);
  });
  it('NUMBER_REPEATED：数字を並べる型で同じ数字＋単位を繰り返すと止める（2026-10-27「300万円」が3回並んだ実例）', () => {
    const s = { ...goodPage('numbers/3'), 'num.value.1': '2,000', 'txt.unit.1': '万円', 'num.value.2': '2000', 'txt.unit.2': '万円', 'num.value.3': '2,000', 'txt.unit.3': '万円' };
    const r = checkPage(1, T('numbers/3'), s, ctx).filter((i) => i.code === 'NUMBER_REPEATED');
    expect(r.map((i) => i.slot)).toEqual(['num.value.2', 'num.value.3']);
    expect(r[0].level).toBe('error');
    // 数字が同じでも単位が違えば別の数（40時間と40人）
    expect(codes('numbers/3', { ...goodPage('numbers/3'), 'num.value.2': '8', 'txt.unit.2': '週' })).not.toContain('NUMBER_REPEATED');
  });
  it('OVERFLOW：欄の行数を超えると落ちる', () => {
    const s = { ...goodPage('issues/3'), 'txt.item.1.body': 'あ'.repeat(60) };
    expect(codes('issues/3', s)).toContain('OVERFLOW');
  });
  it('OVERFLOW：折り返せない数字が欄の幅より広いと落ちる（1行と予測されても）', () => {
    const s = { ...goodPage('numbers/3'), 'num.value.1': '2,000' };
    expect(codes('numbers/3', s)).toContain('OVERFLOW');
    expect(codes('numbers/3', { ...goodPage('numbers/3'), 'num.value.2': '2,000' })).not.toContain('OVERFLOW');
  });
  it('HEADLINE_LINES：見出しが設定の行数を超えると落ちる（欄の行数とは別に）', () => {
    const s = { ...goodPage('cover'), 'txt.headline': '一行目\n二行目\n三行目' };
    const c = codes('cover', s);
    expect(c).toContain('HEADLINE_LINES');
  });
  it('DUMMY_LEFT：見本の文言のまま・空の欄は落ちる', () => {
    expect(codes('section', { 'txt.headline': 'ダミー中扉' })).toContain('DUMMY_LEFT');
    expect(codes('section', { 'txt.headline': '' })).toContain('DUMMY_LEFT');
    expect(codes('section', {})).toContain('DUMMY_LEFT');
  });
  it('NUMBER_NOT_IN_SOURCE：原稿に無い数字・数字の欄の数字以外は落ちる', () => {
    expect(codes('numbers/3', { ...goodPage('numbers/3'), 'num.value.1': '95' })).toContain('NUMBER_NOT_IN_SOURCE');
    expect(codes('numbers/3', { ...goodPage('numbers/3'), 'num.value.1': '約8' })).toContain('NUMBER_NOT_IN_SOURCE');
    expect(codes('numbers/3', { ...goodPage('numbers/3'), 'num.value.1': '2,000' })).not.toContain('NUMBER_NOT_IN_SOURCE');
  });
  it('EMPHASIS_TOO_MANY：1ページの強調が上限を超えると落ちる', () => {
    const s = goodPage('issues/3');
    s['txt.item.1.title'] = '[[a]]';
    s['txt.item.2.title'] = '[[b]]';
    expect(codes('issues/3', s)).not.toContain('EMPHASIS_TOO_MANY');
    s['txt.item.3.title'] = '[[c]]';
    expect(codes('issues/3', s)).toContain('EMPHASIS_TOO_MANY');
  });
  it('SLOT_RULE：単位の欄に数字や文を入れると指摘する', () => {
    expect(codes('numbers/3', { ...goodPage('numbers/3'), 'txt.unit.1': '件→8件' })).toContain('SLOT_RULE');
    expect(codes('numbers/3', { ...goodPage('numbers/3'), 'txt.unit.1': '日が半日に' })).toContain('SLOT_RULE');
    expect(codes('numbers/3', { ...goodPage('numbers/3'), 'txt.unit.1': '時間/月' })).not.toContain('SLOT_RULE');
    expect(codes('numbers/3', { ...goodPage('numbers/3'), 'txt.unit.1': 'か月' })).not.toContain('SLOT_RULE');
  });
  it('GLYPH_MISSING：欄の字体に無い文字（英数字の字体に無い「→」など）は止める', () => {
    expect(codes('cover', { ...goodPage('cover'), 'txt.point.1.main': '月40時間→月8時間' })).toContain('GLYPH_MISSING');
    expect(codes('cover', { ...goodPage('cover'), 'txt.point.1.main': '月40時間から月8時間' })).not.toContain('GLYPH_MISSING');
  });
  it('NAME_NOT_IN_SOURCE は注意。飾りの英字（eyebrow）は調べない', () => {
    const s = { ...goodPage('issues/3'), 'txt.item.1.title': 'AcmeCloud' };
    const r = checkPage(1, T('issues/3'), s, ctx).filter((i) => i.code === 'NAME_NOT_IN_SOURCE');
    expect(r.map((i) => i.level)).toEqual(['warning']);
    expect(codes('issues/3', { ...goodPage('issues/3'), 'txt.eyebrow': 'Company Issues' })).toEqual([]);
  });
  it('SAME_TYPE_IN_ROW：型ID が上限より多く続くと注意（変種の違いは同じ型）', () => {
    expect(checkTypeRuns(['cover', 'issues/2', 'issues/3', 'numbers/3'], 2)).toEqual([]);
    const r = checkTypeRuns(['cover', 'issues/2', 'issues/3', 'issues/4'], 2);
    expect(r.map((i) => [i.code, i.level, i.page])).toEqual([['SAME_TYPE_IN_ROW', 'warning', 4]]);
  });
});

describe('強調語は太字の実フォントで測る（D-009）', () => {
  const st = T('issues/3').slots.find((s) => s.name === 'txt.item.1.body')!.style!;
  const o = { fontFile: resolveFile(st.fontFile), latinFontFile: resolveFile(st.latinFontFile), sizePt: 20, autospaceEm: 0.25 };
  const em = { fontFile: resolveFile('fonts/NotoSansJP-Bold.otf'), latinFontFile: resolveFile('fonts/Barlow-Bold.ttf') };
  it('印は幅に数えず、強調した部分だけ太字の幅になる', () => {
    const plain = lineWidth('業務の属人化', { ...o, fontFile: resolveFile('fonts/NotoSansJP-Regular.otf') });
    const marked = lineWidth('業務の[[属人化]]', { ...o, fontFile: resolveFile('fonts/NotoSansJP-Regular.otf'), emphasis: em });
    expect(marked).toBeGreaterThanOrEqual(plain);
    expect(marked - plain).toBeLessThan(plain * 0.2);
  });
  it('英字の強調語は太字の分だけ広く測る（和文は全角で太字でも幅が同じ）', () => {
    const lat = { ...o, fontFile: resolveFile('fonts/NotoSansJP-Regular.otf'), latinFontFile: resolveFile('fonts/Barlow-Regular.ttf') };
    expect(lineWidth('AI [[Cloud]]', { ...lat, emphasis: em })).toBeGreaterThan(lineWidth('AI Cloud', lat) + 0.5);
  });
  it('折り返しの判定でも、強調語の太字の幅で1行に入るかを決める', () => {
    const lat = { ...o, fontFile: resolveFile('fonts/NotoSansJP-Regular.otf'), latinFontFile: resolveFile('fonts/Barlow-Regular.ttf') };
    const widthPt = lineWidth('業務をCloudで管理', lat) + 0.3;
    const w = { ...lat, widthPt, hangingPunct: true, slackPt: 0 };
    expect(wrapLines('業務をCloudで管理', w)).toHaveLength(1);
    expect(wrapLines('業務を[[Cloud]]で管理', { ...w, emphasis: em })).toHaveLength(2);
  });
});

describe('文節の改行（7章B-4）', () => {
  it('強調の内側では切らない', () => {
    expect(phrases('業務が[[属人化]]しており、自分がいないと回らない')).toEqual(['業務が', '[[属人化]]しており、', '自分が', 'いないと', '回らない']);
  });
  it('数字の途中・数字と単位の間・接尾の字（化・的など）の前では切らない', () => {
    expect(phrases('2年目：稼働の見える化。全20台にセンサー')).toEqual(['2年目：稼働の', '見える化。', '全20台に', 'センサー']);
    expect(phrases('段取り替えを平均45分から20分へ短縮します')).toEqual(['段取り替えを', '平均45分から', '20分へ', '短縮します']);
  });
  it('1行に入るならそのまま。入らないなら文節の切れ目で改行する', () => {
    const s = T('cover').slots.find((x) => x.name === 'txt.headline')!;
    expect(breakByPhrase(s, '短い見出し', cat.fit, resolveFile)).toEqual({ text: '短い見出し', applied: false });
    expect(breakByPhrase(s, '中小企業のための業務改善ガイドブック', cat.fit, resolveFile)).toEqual({ text: '中小企業のための\n業務改善ガイドブック', applied: true });
  });
  it('行の長さをそろえる（最後の行だけ極端に短くしない）', () => {
    const s = T('photo-text/a').slots.find((x) => x.name === 'txt.headline')!;
    const r = breakByPhrase(s, 'アプリで打刻、集計は自動', cat.fit, resolveFile);
    expect(r.applied).toBe(true);
    const lines = r.text.split('\n');
    expect(lines).toHaveLength(2);
    expect(Math.min(...lines.map((l) => [...l].length))).toBeGreaterThanOrEqual(4);
  });
});



describe('A段：数字を並べる役割に、並べるだけの数字があるか', () => {
  const page = (numbers: { value: string; label: string }[]) => ({ purpose: '費用', role: 'number', catch: '支援プラン', body: '半年の伴走支援', details: [], numbers, emphasis: [], sourceQuotes: [] });
  const src = '支援プランは半年300万円（仮）。導入は平均2週間で、月40時間が月8時間に。';
  it('数字の型が並べる数（3）より少なければ、別の役割にするよう返す（2026-10-27 実例）', () => {
    expect(numbersNeeded(cat, 'number')).toBe(3);
    expect(numbersNeeded(cat, 'emphasis')).toBe(0);
    const one = outlineProblems({ deckTitle: 't', pages: [page([{ value: '300万円', label: '費用' }])] } as never, cat, CONFIG, src) ?? '';
    expect(one).toMatch(/p1: role "number" の型は数字を 3 つ並べるが、このページの数字は 1 つ/);
    // 同じ数字を3回書いても 1 つと数える
    const same = outlineProblems({ deckTitle: 't', pages: [page([1, 2, 3].map(() => ({ value: '300万円', label: '費用' })))] } as never, cat, CONFIG, src) ?? '';
    expect(same).toMatch(/このページの数字は 1 つ/);
    const three = outlineProblems({ deckTitle: 't', pages: [page([{ value: '300万円', label: '費用' }, { value: '2週間', label: '期間' }, { value: '月8時間', label: '時間' }])] } as never, cat, CONFIG, src) ?? '';
    expect(three).not.toMatch(/数字を 3 つ並べる/);
  });
});
