/**
 * アプリの英語の画面（X-UI-Lang: en）。サーバーが返す言葉に英語が漏れなくあるかを確かめる。
 *   - 使う人に返す断り（AppError とサーバーが直接返す文）は、すべて errors.ts の表の名前で書かれ、英語がある
 *   - 指摘・段・欄の名前・ページの形・テンプレートの名前・仕上げの記録に英語がある（日本語の文字が混ざらない）
 *   - 言語を付けない呼び出しは、これまでどおり日本語
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.SLIDEGEN_DATA = `${process.env.TMPDIR ?? '/tmp'}/slidegen-i18n-${process.pid}-${Date.now()}`;
});

import { buildCatalog } from '../src/catalog/build-catalog.js';
import { loadConfig } from '../src/catalog/config.js';
import { readTemplate } from '../src/catalog/read-template.js';
import { issue, type IssueCode } from '../src/check/content.js';
import { ERROR_KEYS, errorText, translateStored, type ErrorKey } from '../src/app/errors.js';
import { langFromHeader, runWithLang } from '../src/app/i18n.js';
import { presentIssues } from '../src/app/runs.js';
import { AppError } from '../src/app/settings.js';
import { fitReason, historyLabel, ISSUE_WORDS, LEVEL_WORDS, plainText, slotLabel, STEP_ORDER, stepDetail, stepLabel, TEMPLATE_NAMES_EN, TYPE_LABELS_EN, typeLabel } from '../src/app/words.js';
import { ROOT } from './helpers.js';

const APP = path.join(ROOT, 'src', 'app');
const JAPANESE = /[぀-ヿ一-鿿＀-￯「」、。]/;
const sources = readdirSync(APP)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ f, s: readFileSync(path.join(APP, f), 'utf8') }));
const PARAMS = { cap: 10, id: 'x', n: 3, key: 'cover', max: 30, message: 'boom' };

describe('断りの文（AppError）', () => {
  it('src/app の AppError は、すべて表の名前で作る（日本語の文をじかに書かない）。名前には英語の文がある', () => {
    let count = 0;
    for (const { f, s } of sources) {
      for (const m of s.matchAll(/new AppError\(\s*([^,)]+)/g)) {
        count++;
        const arg = m[1].trim();
        const key = arg.match(/^'([A-Za-z0-9]+)'$/)?.[1];
        expect(key, `${f}: new AppError(${arg}`).toBeTruthy();
        expect(ERROR_KEYS, `${f}: ${key}`).toContain(key);
        const en = errorText(key as ErrorKey, 'en', PARAMS);
        expect(en, `${f}: ${key}`).toBeTruthy();
        expect(en, `${f}: ${key} の英語に日本語が混ざっている`).not.toMatch(JAPANESE);
      }
    }
    expect(count).toBeGreaterThan(25);
  });

  it('サーバーが直接返す文（c.json の error・c.text）も、日本語をじかに書かない', () => {
    for (const { f, s } of sources) {
      for (const m of s.matchAll(/c\.json\(\s*\{\s*error:\s*(['`][^'`]*['`])/g)) expect(m[1], f).not.toMatch(JAPANESE);
      for (const m of s.matchAll(/c\.text\(\s*(['`][^'`]*['`])/g)) expect(m[1], f).not.toMatch(JAPANESE);
    }
  });

  it('表のすべての名前に、日本語と英語の両方がある（英語に日本語が混ざらない）', () => {
    for (const k of ERROR_KEYS) {
      expect(errorText(k, 'ja', PARAMS), k).toMatch(JAPANESE);
      expect(errorText(k, 'en', PARAMS), k).not.toMatch(JAPANESE);
    }
  });

  it('AppError の message は日本語のまま、text(言語) で英語になる', () => {
    const e = new AppError('budgetReached', 409, { cap: 25 });
    expect(e.message).toContain('$25');
    expect(e.message).toMatch(JAPANESE);
    expect(e.text('en')).toBe("This month's spending has reached the limit ($25). Raise the limit in Settings, or wait until next month.");
    expect(e.text('ja')).toBe(e.message);
  });

  it('status.json に日本語で残った理由は、英語の画面では英語にする', () => {
    expect(translateStored(errorText('stoppedOnBoot'), 'en')).toBe(errorText('stoppedOnBoot', 'en'));
    expect(translateStored('エンジンの理由', 'en')).toBe('エンジンの理由');
    expect(translateStored(errorText('stoppedOnBoot'), 'ja')).toBe(errorText('stoppedOnBoot'));
  });
});

describe('画面に出す言葉の英語', () => {
  it('X-UI-Lang の読み取り（無い・知らない値は日本語）', () => {
    expect(langFromHeader('en')).toBe('en');
    expect(langFromHeader('en-US')).toBe('en');
    expect(langFromHeader('ja')).toBe('ja');
    expect(langFromHeader(undefined)).toBe('ja');
    expect(langFromHeader('fr')).toBe('ja');
  });

  it('指摘・段・重さの英語に日本語が混ざらない', () => {
    for (const [code, w] of Object.entries(ISSUE_WORDS.en) as Array<[IssueCode, { title: string; action: string }]>) {
      expect(w.title, code).not.toMatch(JAPANESE);
      expect(w.action, code).not.toMatch(JAPANESE);
      expect(w.title).not.toBe(ISSUE_WORDS.ja[code].title);
    }
    for (const l of Object.values(LEVEL_WORDS.en)) expect(l).not.toMatch(JAPANESE);
    for (const s of STEP_ORDER) expect(stepLabel(s, 'en'), s).not.toMatch(JAPANESE);
    expect(stepDetail('2回目・3ページ', 'en')).toBe('round 2, 3 pages');
    expect(stepDetail('1ページ', 'en')).toBe('1 page');
    expect(stepDetail('2回目・3ページ', 'ja')).toBe('2回目・3ページ');
  });

  it('同梱のテンプレートの欄の名前・ページの形・テンプレートの名前に、すべて英語がある', async () => {
    const labels = JSON.parse(readFileSync(path.join(ROOT, 'templates', 'labels.json'), 'utf8')) as Record<string, string>;
    for (const id of Object.keys(labels)) {
      expect(TEMPLATE_NAMES_EN[id], id).toBeTruthy();
      const file = path.join(ROOT, 'templates', `${id}.pptx`);
      const { catalog } = buildCatalog(await readTemplate(readFileSync(file)), loadConfig(file.replace(/\.pptx$/, '.config.json')), { file: 't', sha256: 'x', resolveFile: (p) => path.join(ROOT, p) });
      for (const t of catalog.types) {
        expect(TYPE_LABELS_EN[t.key], `${id}: ${t.key}`).toBeTruthy();
        expect(typeLabel(t.key, t.label, 'en')).not.toMatch(JAPANESE);
        expect(typeLabel(t.key, t.label, 'ja')).toBe(t.label);
        for (const s of t.slots) {
          expect(slotLabel(s.name, 'en'), s.name).not.toBe(s.name);
          expect(slotLabel(s.name, 'en'), s.name).not.toMatch(JAPANESE);
        }
      }
    }
    expect(slotLabel('txt.item.02.title', 'en')).toBe('Item 2 title');
    expect(slotLabel('txt.item.2.title', 'ja')).toBe('項目2の題');
  });

  it('指摘の画面の形：言語を付けなければ日本語、英語の要求の中では英語', () => {
    const list = [issue('OVERFLOW', 'txt.headline: この欄は最大22字×1行。いまは40字で2行になる', { page: 2, slot: 'txt.headline' })];
    const [ja] = presentIssues(list, []);
    expect(ja.title).toBe('文字が枠に収まっていません');
    expect(ja.levelText).toBe('直してください');
    const [en] = runWithLang('en', () => presentIssues(list, []));
    expect(en.title).toBe('Text does not fit in its box');
    expect(en.levelText).toBe('Fix');
    expect(en.slotLabel).toBe('Headline');
    // エンジンが書く詳しい文は日本語のまま（頭の欄の名前だけ外す）
    expect(en.detail).toBe('この欄は最大22字×1行。いまは40字で2行になる');
    expect(plainText('txt.unit.1 は単位だけを入れる欄', 'en')).toBe('"Figure 1 unit" は単位だけを入れる欄');
  });

  it('枠に収まらない理由と、仕上げの記録の英語', () => {
    expect(fitReason('この欄は最大22字×1行。いまは40字で2行になる', { chars: 40, lines: 2, maxLines: 1, perLine: 22 }, 'en')).toBe('Up to 22 characters × 1 line. Now 40 characters in 2 lines');
    expect(fitReason('「4,800」が1行に入らない（数字や英単語は途中で折り返せない）', { chars: 5, lines: 1, maxLines: 1, perLine: 3 }, 'en')).toMatch(/^"4,800" does not fit/);
    expect(fitReason('空です', { chars: 0, lines: 0, maxLines: null, perLine: null }, 'en')).toBe('Empty');
    expect(fitReason('空です', { chars: 0, lines: 0, maxLines: null, perLine: null }, 'ja')).toBe('空です');
    expect(historyLabel({ kind: 'text', page: 3 }, 'ja')).toBe('3ページ目の文字を直した');
    expect(historyLabel({ kind: 'type', page: 2, typeKey: 'cover', typeLabel: '表紙（写真＋要点3つ）' }, 'en')).toBe('Changed page 2 to the "Cover (photo + 3 key points)" layout');
    expect(historyLabel({ kind: 'photo', page: 4, slot: 'img.hero' }, 'en')).toBe('Replaced the photo (Main photo) on page 4');
  });
});
