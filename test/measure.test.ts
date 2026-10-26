import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { wrapLines } from '../src/fit/measure.js';

const font = path.join(import.meta.dirname, '../fonts/NotoSansJP-Regular.otf');
const base = { fontFile: font, sizePt: 10, autospaceEm: 0, hangingPunct: false, slackPt: 0 };

describe('wrapLines', () => {
  it('全角10pt×5字＝50pt の枠にはちょうど5字ずつ入る', () => {
    expect(wrapLines('あいうえおかきくけこさし', { ...base, widthPt: 50 })).toEqual(['あいうえお', 'かきくけこ', 'さし']);
  });
  it('行頭禁則：句読点を行頭に置かず、前の字ごと送る', () => {
    expect(wrapLines('あいうえお。かき', { ...base, widthPt: 50 })).toEqual(['あいうえ', 'お。かき']);
  });
  it('ぶら下げを有効にすると、句読点だけは枠の外に置ける', () => {
    expect(wrapLines('あいうえお。かき', { ...base, widthPt: 50, hangingPunct: true })).toEqual(['あいうえお。', 'かき']);
  });
  it('英数字の語は途中で折り返さない', () => {
    const lines = wrapLines('あいう2,000万円', { ...base, widthPt: 50 });
    expect(lines.some((l) => l.includes('2,000'))).toBe(true);
  });
  it('余裕（slack）を取ると、ちょうどの幅でも次の行へ送る', () => {
    expect(wrapLines('あいうえおか', { ...base, widthPt: 50, slackPt: 0.5 })).toEqual(['あいうえ', 'おか']);
  });
});
