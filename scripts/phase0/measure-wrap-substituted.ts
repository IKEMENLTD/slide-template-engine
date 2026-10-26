/**
 * Phase 0 検証④の追加：ブラウザ版 PowerPoint は Noto を持たず、和文を MS ゴシック・英数字を Calibri に置き換えて描いた。
 * そこで「実際に使われた字体」の幅で予測し直し、PowerPoint の折り返しの規則（禁則・ぶら下げ・和欧間の空き）だけを確かめる。
 * MS ゴシックと Calibri は Windows の有償同梱フォントなのでリポジトリに入れない。場所を引数で渡す。
 *
 * 使い方: npx tsx scripts/phase0/measure-wrap-substituted.ts out/phase0/wrap actual-powerpoint.json <フォントのdir> [出力名]
 *   <フォントのdir> に msgothic.ttc・calibri.ttf・calibrib.ttf を置く
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { wrapLines } from '../../src/fit/measure.js';

const [dir, actualName, fontDir, outName = 'compare-powerpoint.json'] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(path.join(dir, 'cases.json'), 'utf8'));
const actual: Record<string, string[]> = JSON.parse(readFileSync(path.join(dir, actualName), 'utf8'));
const strip = (l: string[]) => l.map((s) => s.replace(/ /g, ''));
const result: Record<string, unknown> = { note: '和文=MS ゴシック・英数字=Calibri（PowerPoint for the web が置き換えた字体）' };
for (const autospaceEm of [0, 0.25]) for (const hangingPunct of [false, true]) for (const slack of [0, 'pct3'] as const) {
  let lineCount = 0, exact = 0, unsafe = 0, conservative = 0;
  const misses = [];
  for (const c of cases) {
    const pred = wrapLines(c.text, {
      fontFile: path.join(fontDir, 'msgothic.ttc#MS-Gothic'),
      latinFontFile: path.join(fontDir, c.bold ? 'calibrib.ttf' : 'calibri.ttf'),
      sizePt: c.size, widthPt: c.width, autospaceEm, hangingPunct,
      slackPt: slack === 'pct3' ? c.width * 0.03 : 0,
    });
    const act = strip(actual[c.name]);
    if (pred.length === act.length) lineCount++;
    if (act.length > pred.length) unsafe++;
    if (act.length < pred.length) conservative++;
    if (JSON.stringify(pred) === JSON.stringify(act)) exact++;
    else misses.push({ name: c.name, size: c.size, width: c.width, bold: c.bold, pred, act });
  }
  const key = `autospace=${autospaceEm},hang=${hangingPunct},slack=${slack}`;
  result[key] = { cases: cases.length, sameLineCount: lineCount, exactBreaks: exact, unsafe, conservative, misses };
  console.log(`${key}: 行数一致 ${lineCount}/${cases.length}・改行位置まで一致 ${exact}/${cases.length}・見逃し側 ${unsafe}・安全側 ${conservative}`);
}
writeFileSync(path.join(dir, outName), JSON.stringify(result, null, 1));
