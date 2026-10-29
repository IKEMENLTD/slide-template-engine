/**
 * 英語の資料とインドの人物の写真（D-043）。インドの営業先に向けて、英語の原稿（または日本語の原稿）から英語の資料を作る。
 * 日本語の資料は、これまでと1文字も変わらないことも確かめる。
 */
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { setTextLanguage } from '../src/assemble/build-deck.js';
import { namesNotIn, numbersNotIn, sourceNumbers } from '../src/check/content.js';
import { photoPrompt } from '../src/photos/openai-image.js';
import { isFaceProblem } from '../src/photos/plan-photos.js';
import { describeType } from '../src/plan/describe.js';
import { detectLanguage, localeOf } from '../src/plan/locale.js';
import { trimWords } from '../src/plan/plan.js';
import { outlineInstruction, planRules } from '../src/plan/prompts.js';
import { reviewInstruction } from '../src/review/visual.js';
import { buildFixtureCatalog, CONFIG, TEMPLATE } from './helpers.js';

describe('どちらの言葉で作るか', () => {
  it('原稿の言葉を見分ける（画面の初期値）', () => {
    expect(detectLanguage('Reduce invoice work from 40 hours to 8 hours a month.')).toBe('en');
    expect(detectLanguage('請求書づくりの時間を、月40時間から月8時間に減らします。')).toBe('ja');
    expect(detectLanguage('TaskMate で請求書を自動化')).toBe('ja');
    expect(detectLanguage('')).toBe('ja');
  });
  it('記録の無い古い実行は日本語・日本人。知らない値も既定に戻す', () => {
    expect(localeOf(undefined)).toEqual({ language: 'ja', people: 'japanese' });
    expect(localeOf({ language: 'fr', people: 'martian' })).toEqual({ language: 'ja', people: 'japanese' });
    expect(localeOf({ language: 'en', people: 'indian' })).toEqual({ language: 'en', people: 'indian' });
  });
});

describe('AI への指示', () => {
  it('日本語の資料の指示は、これまでと同じ（英語の決まりが混ざらない）', async () => {
    const cat = await buildFixtureCatalog();
    const ja = planRules(cat, CONFIG);
    expect(ja).toBe(planRules(cat, CONFIG, 'ja'));
    expect(ja).toContain('資料として自然な日本語にする');
    expect(ja).not.toMatch(/英語で書く/);
    expect(outlineInstruction(cat, CONFIG)).not.toMatch(/英語で作る/);
  });
  it('英語の資料では、文言を英語で書き、万・億は桁を数字で書くよう伝える', async () => {
    const cat = await buildFixtureCatalog();
    const en = planRules(cat, CONFIG, 'en');
    expect(en).toMatch(/すべて英語で書く/);
    expect(en).toMatch(/3,000,000/);
    expect(en).not.toContain('資料として自然な日本語にする');
    expect(outlineInstruction(cat, CONFIG, undefined, 'en')).toMatch(/資料は英語で作る/);
  });
  it('英語の資料では、欄の上限を英字の数で伝える（全角の字数だと英文には短すぎる）', async () => {
    const cat = await buildFixtureCatalog();
    const t = cat.types.find((x) => x.slots.some((s) => s.name === 'txt.headline'))!;
    const h = t.slots.find((s) => s.name === 'txt.headline')!;
    expect(describeType(t, 'en')).toContain(`txt.headline: 英字なら最大約${h.maxCharsLatin}字`);
    expect(describeType(t, 'ja')).toContain(`txt.headline: 最大${h.maxChars}字`);
    expect(h.maxCharsLatin!).toBeGreaterThan(h.maxChars!);
  });
  it('採点は資料の言語で読み、指摘も同じ言語で書かせる', () => {
    expect(reviewInstruction('en')).toMatch(/message は英語で書く/);
    expect(reviewInstruction('ja')).toMatch(/message は日本語で書く/);
  });
});

describe('原稿と照らす検査', () => {
  it('日本語の原稿の「300万円」を、英語の資料で 3,000,000 と書いても原稿どおり', () => {
    const src = sourceNumbers('初期費用は300万円、年間で1.5億円の削減。月40時間から月8時間に。');
    expect(numbersNotIn('Initial cost: 3,000,000 yen', src)).toEqual([]);
    expect(numbersNotIn('Annual savings of 150,000,000 yen', src)).toEqual([]);
    expect(numbersNotIn('From 40 hours to 8 hours', src)).toEqual([]);
    expect(numbersNotIn('3 million yen', src)).toEqual(['3']); // 桁の言い換えは原稿に無い数字として止める
  });
  it('英語の資料では、普通の英単語を「原稿に無い語」として拾わない。略語・社名らしい形だけ拾う', () => {
    const ms = '請求書の作業を自動化します。TaskMate を使います。';
    expect(namesNotIn('Automate your invoice work with TaskMate', ms, 'en')).toEqual([]);
    expect(namesNotIn('Certified under ISO9001 by ABC', ms, 'en').sort()).toEqual(['ABC', 'ISO9001']);
    // 日本語の資料の拾い方はこれまでどおり（英字の語はすべて拾う）
    expect(namesNotIn('Invoice を自動化', ms)).toEqual(['Invoice']);
  });
});

describe('英文の丸め・写真・ファイル', () => {
  it('入りきらない英文は、単語の途中で切らずに丸める', () => {
    expect(trimWords('Reduce invoice work from forty hours', 20)).toBe('Reduce invoice work…');
    expect(trimWords('Short text', 20)).toBe('Short text');
    expect(trimWords('Supercalifragilistic', 6)).toBe('Super…');
  });
  it('写真の人物は選んだ相手に合わせる（既定は日本人のまま）', () => {
    expect(photoPrompt('cast', 'scene', false)).toContain('All people are Japanese.');
    const indian = photoPrompt('cast', 'scene', false, null, 'indian');
    expect(indian).toContain('All people are Indian');
    expect(indian).toContain('Indian corporate presentation');
    expect(indian).not.toContain('Japanese');
  });
  it('英語で書かれた採点の「顔が隠れている」も、写真の作り直しに回す', () => {
    expect(isFaceProblem("The man's face is covered by the triangle")).toBe(true);
    expect(isFaceProblem('Headline wraps mid-word')).toBe(false);
    expect(isFaceProblem('人の顔が帯に隠れている')).toBe(true);
  });
  it('英語の資料の文字は、言語を英語にする（東アジアの字の言語は残す）', async () => {
    const out = await setTextLanguage(readFileSync(TEMPLATE), 'en-US');
    const zip = await JSZip.loadAsync(out);
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).not.toMatch(/\slang="ja-JP"/);
    expect(xml).toMatch(/altLang="en-US"|lang="en-US"/);
  });
});
