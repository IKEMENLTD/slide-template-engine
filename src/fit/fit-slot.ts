/**
 * 文言が欄に収まるかを実フォントで判定する（B段の書き直し指示と、検査 OVERFLOW・HEADLINE_LINES が使う）。
 * 欄の上限（行数）はカタログの値だけを読む。ここで別の上限を持たない（2-3 原則7）。
 */
import type { Catalog, CatalogSlot } from '../catalog/build-catalog.js';
import { lineWidth, wrapLines } from './measure.js';

export type FitResult = {
  ok: boolean;
  lines: string[];
  lineCount: number;
  maxLines: number;
  /** 文字数（全角・半角を区別せず数えた字数） */
  chars: number;
  maxChars: number;
  /** 収まらないときの理由（AI への書き直し指示にそのまま使える日本語） */
  reason?: string;
};

export function fitSlot(slot: CatalogSlot, text: string, fit: Catalog['fit'], resolveFile: (p: string) => string): FitResult {
  const st = slot.style;
  if (!st || slot.maxLines == null || slot.maxChars == null) throw new Error(`${slot.name} は文字の欄ではない`);
  const opts = {
    fontFile: resolveFile(st.fontFile),
    latinFontFile: resolveFile(st.latinFontFile),
    sizePt: st.sizePt,
    widthPt: st.innerWidthPt,
    autospaceEm: fit.autospaceEm,
    hangingPunct: fit.hangingPunct,
    slackPt: st.innerWidthPt * fit.slackRatio,
    spacingPt: st.spacingPt,
    // 強調語は太字の実フォントで測り、[[ ]] の印は幅に数えない（D-009）
    emphasis: { fontFile: resolveFile(st.emphasisFontFile), latinFontFile: resolveFile(st.emphasisLatinFontFile) },
  };
  const paras = text.split('\n');
  let lines: string[];
  let widthProblem: string | undefined;
  if (st.wrap) {
    lines = paras.flatMap((p) => (p === '' ? [''] : wrapLines(p, opts)));
    // 折り返せないひとかたまり（「4,800」のような数字・英単語）は、行に入らなくても1行と予測される。
    // 実物の描画はそこで無理に折り返す（「4,80／0」）ので、行ごとの幅も測る。行末にぶら下げる句読点は数えない
    const limit = st.innerWidthPt * (1 - fit.slackRatio);
    const over = lines.find((l) => lineWidth(l.replace(/[、。，．,.」』）】]$/, ''), opts) > limit);
    if (over) widthProblem = `「${over.replace(/\[\[|\]\]/g, '')}」が1行に入らない（数字や英単語は途中で折り返せない）`;
  } else {
    lines = paras;
    const limit = st.innerWidthPt * (1 - fit.slackRatio);
    const over = paras.find((p) => lineWidth(p, opts) > limit);
    if (over) widthProblem = `「${over}」が1行に入らない（この欄は折り返さない）`;
  }
  const chars = [...text.replace(/\n/g, '').replace(/\[\[|\]\]/g, '')].length;
  const res: FitResult = { ok: true, lines, lineCount: lines.length, maxLines: slot.maxLines, chars, maxChars: slot.maxChars };
  if (widthProblem) res.reason = widthProblem;
  else if (lines.length > slot.maxLines) res.reason = `この欄は最大${slot.maxCharsPerLine}字×${slot.maxLines}行。いまは${chars}字で${lines.length}行になる`;
  res.ok = !res.reason;
  return res;
}
