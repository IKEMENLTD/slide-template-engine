/**
 * 実フォントで文字幅を測り、枠の幅で何行になるか・どこで折り返すかを予測する（B段・検査 OVERFLOW の土台）。
 *
 * 折り返しの規則（Phase 0 で LibreOffice 7.4 の描画と突き合わせて決めた。docs/DECISIONS.md D-006）
 *   - 和文は文字の間ならどこでも折り返せる
 *   - 行頭禁則：句読点・閉じ括弧・小書きの仮名・長音などは行頭に来ない（前の文字ごと次の行へ送る）
 *   - 行末禁則：開き括弧は行末に来ない
 *   - 英数字の連続（2,000 や BackOffice）は途中で折り返さない
 *   - 和文と英数字の境目に、描画側が自動で空き（autospace）を入れる。その幅は設定で持つ
 */
import * as fontkit from 'fontkit';

const NO_START = new Set([...'、。，．,.・：；:;？！?!ー－ゝゞ々」』）】〉》〕］｝)]}ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ〜…‥%％']);
const NO_END = new Set([...'「『（【〈《〔［｛([{']);
const isWesternWordChar = (c: string) => /[A-Za-z0-9.,/%'&+\-]/.test(c);
const isWestern = (c: string) => c.charCodeAt(0) < 0x2e80;

type FontLike = { unitsPerEm: number; layout: (s: string) => { advanceWidth: number } };
const cache = new Map<string, FontLike>();
/** file は「パス」か、フォント集（.ttc）なら「パス#PostScript名」 */
export function loadFont(file: string): FontLike {
  let f = cache.get(file);
  if (!f) {
    const [p, ps] = file.split('#');
    const opened = fontkit.openSync(p, ps) as unknown as FontLike;
    f = opened;
    cache.set(file, f);
  }
  return f;
}

export type WrapOptions = {
  fontFile: string;
  sizePt: number;
  widthPt: number;
  /** 和文と英数字の境目に足す空き（em 単位）。0 なら足さない */
  autospaceEm: number;
  /** 句読点・閉じ括弧を行末にぶら下げる（枠からはみ出して置く）か */
  hangingPunct: boolean;
  /** 枠の幅からこれだけ引いた幅を使える幅とみなす（ちょうどの幅は描画側で次の行に送られる） */
  slackPt: number;
  /**
   * 1文字ごとの幅の丸め。'lo-100mm' は LibreOffice が内部で 1/100mm に丸めて足し合わせる挙動の再現。
   * PowerPoint の丸めは未確認なので、本番の判定では使わず、検証の再現用に限る。
   */
  rounding?: 'none' | 'lo-100mm';
  /** 英数字に別の字体が当たる場合（PowerPoint は latin と ea に別の字体を使う）。無ければ fontFile */
  latinFontFile?: string;
  /** 字間（pt）。1字ごとに足す */
  spacingPt?: number;
  /**
   * 強調語（[[語]]）を太字の実フォントで測る（D-009：強調は太字になって幅が広がる）。
   * 指定したときは、文言の中の [[ ]] を印として読み、印そのものは幅に数えない。
   */
  emphasis?: { fontFile: string; latinFontFile: string };
};
const HANG = new Set([...'、。，．,.」』）】'])

type Tok = { s: string; em: boolean };

/** 文言を1字ずつに分け、強調の印（[[ ]]）の内側かを付ける。印が無効なら全部ふつうの字 */
function chars(text: string, withEmphasis: boolean): Tok[] {
  if (!withEmphasis) return [...text].map((c) => ({ s: c, em: false }));
  const out: Tok[] = [];
  for (const part of text.split(/(\[\[[^[\]]*\]\])/)) {
    const m = part.match(/^\[\[([^[\]]*)\]\]$/);
    for (const c of m ? m[1] : part) out.push({ s: c, em: !!m });
  }
  return out;
}

/** 折り返しの単位（英数字の語はひとかたまり）に分ける。強調の内と外はまたがない */
function tokens(text: string, withEmphasis = false): Tok[] {
  const out: Tok[] = [];
  for (const c of chars(text, withEmphasis)) {
    const last = out[out.length - 1];
    if (last && last.em === c.em && isWesternWordChar(c.s) && isWesternWordChar(last.s[last.s.length - 1])) last.s += c.s;
    else out.push({ ...c });
  }
  return out;
}

export function wrapLines(text: string, o: WrapOptions): string[] {
  const cjkFont = loadFont(o.fontFile);
  const latinFont = loadFont(o.latinFontFile ?? o.fontFile);
  const emCjk = o.emphasis ? loadFont(o.emphasis.fontFile) : cjkFont;
  const emLatin = o.emphasis ? loadFont(o.emphasis.latinFontFile) : latinFont;
  const PT_PER_100MM = 72 / 2540;
  const w = (t: Tok) => {
    const s = t.s;
    const font = isWestern(s[0]) ? (t.em ? emLatin : latinFont) : t.em ? emCjk : cjkFont;
    const scale = o.sizePt / font.unitsPerEm;
    const tracking = (o.spacingPt ?? 0) * [...s].length;
    if (o.rounding !== 'lo-100mm') return font.layout(s).advanceWidth * scale + tracking;
    let sum = 0;
    for (const ch of s) sum += Math.round((font.layout(ch).advanceWidth * scale) / PT_PER_100MM);
    return sum * PT_PER_100MM + tracking;
  };
  const gap = (prev: Tok | undefined, t: Tok) => (prev && isWestern(prev.s.slice(-1)) !== isWestern(t.s[0]) ? o.autospaceEm * o.sizePt : 0);
  const toks = tokens(text, !!o.emphasis);
  const lines: Tok[][] = [[]];
  let cur = 0;
  let prev: Tok | undefined;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    let add = w(t) + gap(prev, t);
    const line = lines[lines.length - 1];
    const limit = o.widthPt - o.slackPt;
    const hangs = o.hangingPunct && t.s.length === 1 && HANG.has(t.s) && cur <= limit;
    if (cur + add > limit && line.length > 0 && !hangs) {
      // 行頭禁則：送る文字が行頭に来てはいけないなら、前の単位も一緒に送る
      const carry: Tok[] = [];
      if (NO_START.has(t.s[0]) && line.length > 1) carry.unshift(line.pop()!);
      // 行末禁則：行末が開き括弧なら、それも送る
      while (line.length > 1 && NO_END.has(line[line.length - 1].s.slice(-1))) carry.unshift(line.pop()!);
      lines.push([...carry]);
      cur = carry.reduce((s, x) => s + w(x), 0);
      prev = carry.length ? carry[carry.length - 1] : undefined;
      add = w(t) + gap(prev, t);
    }
    lines[lines.length - 1].push(t);
    cur += add;
    prev = t;
  }
  return lines.map((l) => l.map((t) => t.s).join(''));
}

/** 1行の幅（折り返さずに並べたとき）。折り返さない欄（wrap=none）の判定に使う */
export function lineWidth(
  text: string,
  o: Pick<WrapOptions, 'fontFile' | 'latinFontFile' | 'sizePt' | 'autospaceEm' | 'emphasis'> & { spacingPt?: number }
): number {
  const cjk = loadFont(o.fontFile);
  const latin = loadFont(o.latinFontFile ?? o.fontFile);
  const emCjk = o.emphasis ? loadFont(o.emphasis.fontFile) : cjk;
  const emLatin = o.emphasis ? loadFont(o.emphasis.latinFontFile) : latin;
  let sum = 0;
  let prev = '';
  for (const t of tokens(text, !!o.emphasis)) {
    const f = isWestern(t.s[0]) ? (t.em ? emLatin : latin) : t.em ? emCjk : cjk;
    sum += (f.layout(t.s).advanceWidth * o.sizePt) / f.unitsPerEm + (o.spacingPt ?? 0) * [...t.s].length;
    if (prev && isWestern(prev.slice(-1)) !== isWestern(t.s[0])) sum += o.autospaceEm * o.sizePt;
    prev = t.s;
  }
  return sum;
}
