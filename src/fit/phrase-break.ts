/**
 * 文節の切れ目で改行を入れる（REQUIREMENTS 7章B-4・ルール文書 8-4「折り返しを減らす」）。
 * PowerPoint は語の途中でも折り返すので、見出しなどは budoux で分けた文節を行に詰め、明示の改行を入れる。
 *
 * - 1行に収まる文言はそのまま（改行を入れない）
 * - 文節で詰めた結果が欄の行数を超え、ふつうの折り返しなら収まるときは、ふつうの折り返しに任せる
 *   （字を削らせるより、語の途中で折り返すほうを選ぶ。どちらに倒したかは戻り値で分かる）
 * - 強調の印 [[ ]] の内側では切らない
 */
import { loadDefaultJapaneseParser } from 'budoux';
import type { Catalog, CatalogSlot } from '../catalog/build-catalog.js';
import { fitSlot } from './fit-slot.js';
import { lineWidth, wrapLines, type WrapOptions } from './measure.js';

const parser = loadDefaultJapaneseParser();

/** 印つきの文言を、印を壊さない文節のかたまりに分ける */
export function phrases(marked: string): string[] {
  // 印つきの文言の各文字が、印を外した文言の何文字目か
  const plain: string[] = [];
  const pieces: Array<{ s: string; plainIdx: number; inEm: boolean }> = [];
  for (const part of marked.split(/(\[\[[^[\]]*\]\])/)) {
    if (!part) continue;
    const m = part.match(/^\[\[([^[\]]*)\]\]$/);
    if (m) {
      pieces.push({ s: '[[', plainIdx: plain.length, inEm: true });
      for (const c of m[1]) {
        pieces.push({ s: c, plainIdx: plain.length, inEm: true });
        plain.push(c);
      }
      pieces.push({ s: ']]', plainIdx: plain.length, inEm: true });
    } else
      for (const c of part) {
        pieces.push({ s: c, plainIdx: plain.length, inEm: false });
        plain.push(c);
      }
  }
  const bounds = new Set<number>();
  let n = 0;
  for (const ph of parser.parse(plain.join(''))) {
    n += [...ph].length;
    bounds.add(n);
  }
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    // 文節の切れ目は「この文字の前」。強調の内側（[[ の直後〜]] の直前）では切らない
    const startsPhrase = bounds.has(p.plainIdx) && p.s !== ']]' && !(p.inEm && p.s !== '[[');
    if (startsPhrase && cur && p.plainIdx > 0 && !(pieces[i - 1]?.s === '[[')) {
      out.push(cur);
      cur = '';
    }
    cur += p.s;
  }
  if (cur) out.push(cur);
  return mergeBadSplits(out);
}

/** 語の後ろに付いて1語になる漢字（「見える化」「効率的」など）。この字で文節を始めない */
const SUFFIX = new Set([...'化的性率型式用']);

/**
 * budoux が数字や接尾の字の前後で切ることがあるので、つなぎ直す（D-031）。
 * 「全2｜0台」（数字の途中）・「平均45｜分から」（数字と単位）・「見える｜化」（接尾の字）
 */
function mergeBadSplits(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (prev !== undefined) {
      const a = prev.replace(/\]\]$/, '').slice(-1);
      const b = p.replace(/^\[\[/, '').charAt(0);
      const digitA = /[0-9０-９]/.test(a);
      const joinNumber = digitA && /[0-9０-９,，.．]/.test(b);
      const joinUnit = digitA && b !== '' && !/[ぁ-ゖ、。・\s（(「]/.test(b);
      if (joinNumber || joinUnit || SUFFIX.has(b)) {
        out[out.length - 1] = prev + p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

export type PhraseBreakResult = { text: string; applied: boolean };

export function breakByPhrase(slot: CatalogSlot, text: string, fit: Catalog['fit'], resolveFile: (p: string) => string): PhraseBreakResult {
  const st = slot.style;
  if (!st || !st.wrap) return { text, applied: false };
  const opts: WrapOptions = {
    fontFile: resolveFile(st.fontFile),
    latinFontFile: resolveFile(st.latinFontFile),
    sizePt: st.sizePt,
    widthPt: st.innerWidthPt,
    autospaceEm: fit.autospaceEm,
    hangingPunct: fit.hangingPunct,
    slackPt: st.innerWidthPt * fit.slackRatio,
    spacingPt: st.spacingPt,
    emphasis: { fontFile: resolveFile(st.emphasisFontFile), latinFontFile: resolveFile(st.emphasisLatinFontFile) },
  };
  const oneLine = (s: string) => wrapLines(s, opts).length <= 1;
  const out: string[] = [];
  let changed = false;
  for (const para of text.split('\n')) {
    if (para === '' || oneLine(para)) {
      out.push(para);
      continue;
    }
    const ph = phrases(para);
    if (ph.some((x) => !oneLine(x))) {
      // 1つの文節が1行に入らない。この段落はふつうの折り返しに任せる
      out.push(para);
      continue;
    }
    // 文節を貪欲に詰めたときの行数を基準に、同じ行数で「いちばん長い行」が最も短くなる切り方を選ぶ
    // （貪欲に詰めると「集計は／自動」のように最後の行だけが極端に短くなるため）
    const greedy: string[] = [];
    let cur = '';
    for (const x of ph) {
      if (cur && !oneLine(cur + x)) {
        greedy.push(cur);
        cur = x;
      } else cur += x;
    }
    greedy.push(cur);
    const lines = balance(ph, greedy.length, oneLine, (t) => lineWidth(t, opts)) ?? greedy;
    // 行頭の空白は落とす（文節の切れ目に空白があると、次の行の頭に残る）
    out.push(lines.map((l, i) => (i === 0 ? l : l.replace(/^[ \u3000]+/, ''))).join('\n'));
    changed = true;
  }
  const broken = out.join('\n');
  if (!changed) return { text, applied: false };
  // 文節で詰めて欄に入らず、ふつうの折り返しなら入るときは、ふつうの折り返しに任せる
  const withBreaks = fitSlot(slot, broken, fit, resolveFile);
  if (!withBreaks.ok && fitSlot(slot, text, fit, resolveFile).ok) return { text, applied: false };
  return { text: broken, applied: true };
}

/** 文節の並びを k 行に分ける切り方のうち、各行が1行に収まり、いちばん長い行が最も短いもの */
function balance(ph: string[], k: number, fits: (s: string) => boolean, width: (s: string) => number): string[] | null {
  const n = ph.length;
  if (k <= 1 || k > n) return null;
  const join = (i: number, j: number) => ph.slice(i, j).join('');
  // best[i][r]：先頭 i 個の文節を r 行に分けたときの「いちばん長い行」の最小値
  const best: number[][] = Array.from({ length: n + 1 }, () => Array(k + 1).fill(Infinity));
  const from: number[][] = Array.from({ length: n + 1 }, () => Array(k + 1).fill(-1));
  best[0][0] = 0;
  for (let r = 1; r <= k; r++)
    for (let i = 1; i <= n; i++)
      for (let j = r - 1; j < i; j++) {
        if (best[j][r - 1] === Infinity) continue;
        const line = join(j, i);
        if (!fits(line)) continue;
        const v = Math.max(best[j][r - 1], width(line.replace(/^[ \u3000]+/, '')));
        if (v < best[i][r]) {
          best[i][r] = v;
          from[i][r] = j;
        }
      }
  if (best[n][k] === Infinity) return null;
  const lines: string[] = [];
  for (let i = n, r = k; r > 0; r--) {
    const j = from[i][r];
    lines.unshift(join(j, i));
    i = j;
  }
  return lines;
}
