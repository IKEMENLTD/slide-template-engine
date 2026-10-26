/**
 * Phase 0 検証④：fontkit の予測と LibreOffice の実際の折り返しを比べる。
 * 使い方: npx tsx scripts/phase0/measure-wrap.ts out/phase0/wrap [actual.json] [compare.json]
 * PowerPoint で書き出した PDF と比べるときは extract_lines.py で actual-powerpoint.json を作って渡す。
 * autospace の幅を何通りか試し、一致数を出す。結果は <dir>/compare.json。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { wrapLines } from '../../src/fit/measure.js';

const dir = process.argv[2];
const ROOT = path.resolve(import.meta.dirname, '../..');
const cases = JSON.parse(readFileSync(path.join(dir, 'cases.json'), 'utf8'));
const actual: Record<string, string[]> = JSON.parse(readFileSync(path.join(dir, process.argv[3] ?? 'actual.json'), 'utf8'));
const strip = (l: string[]) => l.map((s) => s.replace(/ /g, ''));
const result: Record<string, unknown> = {};
for (const autospaceEm of [0, 0.25]) for (const hangingPunct of [false, true]) for (const slackPt of [0, 'pct3'] as const) for (const rounding of ['none', 'lo-100mm'] as const) {
  let lineCount = 0, exact = 0, unsafe = 0, conservative = 0;
  const misses = [];
  for (const c of cases) {
    const pred = wrapLines(c.text, { fontFile: path.join(ROOT, c.fontFile), sizePt: c.size, widthPt: c.width, autospaceEm, hangingPunct, slackPt: slackPt === 'pct3' ? c.width * 0.03 : slackPt, rounding });
    const act = strip(actual[c.name]);
    if (pred.length === act.length) lineCount++;
    if (act.length > pred.length) unsafe++; // 予測より実物の行が多い＝あふれを見逃す側（これが0であること）
    if (act.length < pred.length) conservative++;
    if (JSON.stringify(pred) === JSON.stringify(act)) exact++;
    else misses.push({ name: c.name, face: c.face, bold: c.bold, size: c.size, width: c.width, pred, act });
  }
  result[`autospace=${autospaceEm},hang=${hangingPunct},slack=${slackPt},round=${rounding}`] = { cases: cases.length, sameLineCount: lineCount, exactBreaks: exact, unsafe, conservative, misses };
  console.log(`autospace=${autospaceEm}em hang=${hangingPunct} slack=${slackPt} round=${rounding}: 行数一致 ${lineCount}/${cases.length}・改行位置まで一致 ${exact}/${cases.length}・見逃し側 ${unsafe}・安全側 ${conservative}`);
}
writeFileSync(path.join(dir, process.argv[4] ?? 'compare.json'), JSON.stringify(result, null, 1));
