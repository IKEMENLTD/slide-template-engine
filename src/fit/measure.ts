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
};
const HANG = new Set([...'、。，．,.」』）】'])

/** 折り返しの単位（英数字の語はひとかたまり）に分ける */
function tokens(text: string): string[] {
  const out: string[] = [];
  for (const c of text) {
    const last = out[out.length - 1];
    if (last && isWesternWordChar(c) && isWesternWordChar(last[last.length - 1])) out[out.length - 1] += c;
    else out.push(c);
  }
  return out;
}

export function wrapLines(text: string, o: WrapOptions): string[] {
  const cjkFont = loadFont(o.fontFile);
  const latinFont = loadFont(o.latinFontFile ?? o.fontFile);
  const PT_PER_100MM = 72 / 2540;
  const w = (s: string) => {
    const font = isWestern(s[0]) ? latinFont : cjkFont;
    const scale = o.sizePt / font.unitsPerEm;
    const tracking = (o.spacingPt ?? 0) * [...s].length;
    if (o.rounding !== 'lo-100mm') return font.layout(s).advanceWidth * scale + tracking;
    let sum = 0;
    for (const ch of s) sum += Math.round((font.layout(ch).advanceWidth * scale) / PT_PER_100MM);
    return sum * PT_PER_100MM + tracking;
  };
  const toks = tokens(text);
  const lines: string[][] = [[]];
  let cur = 0;
  let prev = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    let add = w(t);
    if (prev && isWestern(prev.slice(-1)) !== isWestern(t[0])) add += o.autospaceEm * o.sizePt;
    const line = lines[lines.length - 1];
    const limit = o.widthPt - o.slackPt;
    const hangs = o.hangingPunct && t.length === 1 && HANG.has(t) && cur <= limit;
    if (cur + add > limit && line.length > 0 && !hangs) {
      // 行頭禁則：送る文字が行頭に来てはいけないなら、前の単位も一緒に送る
      const carry: string[] = [];
      if (NO_START.has(t[0]) && line.length > 1) carry.unshift(line.pop()!);
      // 行末禁則：行末が開き括弧なら、それも送る
      while (line.length > 1 && NO_END.has(line[line.length - 1].slice(-1))) carry.unshift(line.pop()!);
      lines.push([...carry]);
      cur = carry.reduce((s, x) => s + w(x), 0);
      prev = carry.length ? carry[carry.length - 1] : '';
      add = w(t) + (prev && isWestern(prev.slice(-1)) !== isWestern(t[0]) ? o.autospaceEm * o.sizePt : 0);
    }
    lines[lines.length - 1].push(t);
    cur += add;
    prev = t;
  }
  return lines.map((l) => l.join(''));
}

/** 1行の幅（折り返さずに並べたとき）。折り返さない欄（wrap=none）の判定に使う */
export function lineWidth(text: string, o: Pick<WrapOptions, 'fontFile' | 'latinFontFile' | 'sizePt' | 'autospaceEm'> & { spacingPt?: number }): number {
  const cjk = loadFont(o.fontFile);
  const latin = loadFont(o.latinFontFile ?? o.fontFile);
  let sum = 0;
  let prev = '';
  for (const t of tokens(text)) {
    const f = isWestern(t[0]) ? latin : cjk;
    sum += (f.layout(t).advanceWidth * o.sizePt) / f.unitsPerEm + (o.spacingPt ?? 0) * [...t].length;
    if (prev && isWestern(prev.slice(-1)) !== isWestern(t[0])) sum += o.autospaceEm * o.sizePt;
    prev = t;
  }
  return sum;
}
