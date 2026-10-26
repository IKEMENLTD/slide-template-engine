/**
 * テンプレート（.pptx）を読み、型と欄の「生の情報」を取り出す（REQUIREMENTS 6章）。
 * 字数の計算はここでは行わない（build-catalog.ts）。
 */
import { DOMParser, type Document, type Element } from '@xmldom/xmldom';
import JSZip from 'jszip';
import path from 'node:path/posix';
import { parse as parseYaml } from 'yaml';

const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};
const EMU_PER_PT = 12700;

export type SlotKind = 'txt' | 'num' | 'img';

export type RawTextStyle = {
  /** 字の大きさ（pt） */
  sizePt: number;
  bold: boolean;
  /** 字体の名前（テーマ参照は解決済み） */
  latin: string;
  ea: string;
  /** 字間（pt）。0 なら詰めも空けもしない */
  spacingPt: number;
  /** 行間。pt 固定か、倍率か、指定なし */
  lineSpacing: { kind: 'pt'; value: number } | { kind: 'pct'; value: number } | { kind: 'none' };
  align: string;
  anchor: string;
  wrap: boolean;
  autofit: 'none' | 'shrink' | 'resize' | 'unspecified';
  insetsPt: { l: number; t: number; r: number; b: number };
  /** 見本に入っている文言（ダミー）。DUMMY_LEFT の検査に使う */
  sample: string;
};

export type RawSlot = {
  name: string;
  kind: SlotKind;
  box: { x: number; y: number; w: number; h: number; rotDeg: number };
  text?: RawTextStyle;
  image?: { geometry: string };
};

export type RawType = {
  /** テンプレートの中のスライドファイルの番号（automizer の addSlide に渡す） */
  slideNumber: number;
  /** 表示順（1始まり） */
  order: number;
  meta: { type?: string; variant?: string; role?: string[]; label?: string; [k: string]: unknown };
  notesError?: string;
  slots: RawSlot[];
  /** 名前の付いていない／契約外の名前の図形（飾り）の数 */
  decorations: number;
  /** 色を直書き（srgbClr／sysClr）している箇所の数。テーマ色を差し替えても変わらない */
  hardColors: number;
};

export type RawTemplate = {
  slideSize: { w: number; h: number };
  theme: { colors: Record<string, string>; fonts: { majorLatin: string; majorEa: string; minorLatin: string; minorEa: string } };
  types: RawType[];
};

const parser = new DOMParser();
const xml = async (zip: JSZip, p: string) => parser.parseFromString(await zip.file(p)!.async('string'), 'text/xml');
const first = (el: Element | Document, ns: keyof typeof NS, tag: string) => el.getElementsByTagNameNS(NS[ns], tag).item(0) as Element | null;
const all = (el: Element | Document, ns: keyof typeof NS, tag: string) => Array.from(el.getElementsByTagNameNS(NS[ns], tag) as unknown as Iterable<Element>);
const num = (v: string | null | undefined, d = 0) => (v == null || v === '' ? d : Number(v));

async function relsMap(zip: JSZip, part: string) {
  const relPath = path.join(path.dirname(part), '_rels', path.basename(part) + '.rels');
  const f = zip.file(relPath);
  const map = new Map<string, { type: string; target: string }>();
  if (!f) return map;
  const doc = parser.parseFromString(await f.async('string'), 'text/xml');
  for (const r of Array.from(doc.getElementsByTagName('Relationship') as unknown as Iterable<Element>)) {
    const t = r.getAttribute('Target')!;
    map.set(r.getAttribute('Id')!, { type: r.getAttribute('Type')!, target: t.startsWith('/') ? t.slice(1) : path.normalize(path.join(path.dirname(part), t)) });
  }
  return map;
}

function paragraphsText(txBody: Element) {
  return all(txBody, 'a', 'p')
    .map((p) => all(p, 'a', 't').map((t) => t.textContent ?? '').join(''))
    .join('\n');
}

export function slotKind(name: string): SlotKind | null {
  const m = name.match(/^(txt|num|img)\./);
  return m ? (m[1] as SlotKind) : null;
}

export async function readTemplate(buf: Buffer | Uint8Array): Promise<RawTemplate> {
  const zip = await JSZip.loadAsync(buf);
  const pres = await xml(zip, 'ppt/presentation.xml');
  const sz = first(pres, 'p', 'sldSz')!;
  const presRels = await relsMap(zip, 'ppt/presentation.xml');

  // テーマ（マスターのテーマ）
  const themePart = [...presRels.values()].find((r) => r.type.endsWith('/theme'))?.target ?? 'ppt/theme/theme1.xml';
  const theme = await xml(zip, themePart);
  const colors: Record<string, string> = {};
  const scheme = first(theme, 'a', 'clrScheme')!;
  for (let n = scheme.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    const el = n as Element;
    const c = first(el, 'a', 'srgbClr')?.getAttribute('val') ?? first(el, 'a', 'sysClr')?.getAttribute('lastClr');
    if (c) colors[el.localName!] = c.toUpperCase();
  }
  const major = first(theme, 'a', 'majorFont')!;
  const minor = first(theme, 'a', 'minorFont')!;
  const fonts = {
    majorLatin: first(major, 'a', 'latin')!.getAttribute('typeface')!,
    majorEa: first(major, 'a', 'ea')!.getAttribute('typeface')!,
    minorLatin: first(minor, 'a', 'latin')!.getAttribute('typeface')!,
    minorEa: first(minor, 'a', 'ea')!.getAttribute('typeface')!,
  };
  const resolveFont = (tf: string | null | undefined, kind: 'latin' | 'ea') => {
    if (!tf) return kind === 'latin' ? fonts.minorLatin : fonts.minorEa;
    if (tf === '+mj-lt') return fonts.majorLatin;
    if (tf === '+mn-lt') return fonts.minorLatin;
    if (tf === '+mj-ea') return fonts.majorEa;
    if (tf === '+mn-ea') return fonts.minorEa;
    return tf;
  };

  const types: RawType[] = [];
  const sldIds = all(pres, 'p', 'sldId');
  for (const [i, sid] of sldIds.entries()) {
    const rid = sid.getAttributeNS(NS.r, 'id')!;
    const part = presRels.get(rid)!.target;
    const slideNumber = Number(part.match(/slide(\d+)\.xml$/)![1]);
    const doc = await xml(zip, part);
    const rels = await relsMap(zip, part);

    // ノートの先頭の YAML
    let meta: RawType['meta'] = {};
    let notesError: string | undefined;
    const notesRel = [...rels.values()].find((r) => r.type.endsWith('/notesSlide'));
    if (!notesRel) notesError = 'ノートが無い';
    else {
      const nd = await xml(zip, notesRel.target);
      const body = all(nd, 'p', 'sp').find((sp) => first(sp, 'p', 'ph')?.getAttribute('type') === 'body');
      const txt = body ? paragraphsText(first(body, 'p', 'txBody')!) : '';
      try {
        const y = parseYaml(txt);
        if (y && typeof y === 'object') meta = y as RawType['meta'];
        else notesError = 'ノートの先頭が YAML ではない';
      } catch (e) {
        notesError = `ノートの YAML を読めない: ${(e as Error).message.split('\n')[0]}`;
      }
    }

    const slots: RawSlot[] = [];
    let decorations = 0;
    for (const shape of [...all(doc, 'p', 'sp'), ...all(doc, 'p', 'pic')]) {
      const cNvPr = first(shape, 'p', 'cNvPr')!;
      const name = cNvPr.getAttribute('name') ?? '';
      const kind = slotKind(name);
      if (!kind) {
        decorations++;
        continue;
      }
      const xfrm = first(shape, 'a', 'xfrm')!;
      const off = first(xfrm, 'a', 'off')!;
      const ext = first(xfrm, 'a', 'ext')!;
      const box = {
        x: num(off.getAttribute('x')) / EMU_PER_PT,
        y: num(off.getAttribute('y')) / EMU_PER_PT,
        w: num(ext.getAttribute('cx')) / EMU_PER_PT,
        h: num(ext.getAttribute('cy')) / EMU_PER_PT,
        rotDeg: num(xfrm.getAttribute('rot')) / 60000,
      };
      const slot: RawSlot = { name, kind, box };
      if (kind === 'img') {
        const g = first(shape, 'a', 'prstGeom')?.getAttribute('prst') ?? (first(shape, 'a', 'custGeom') ? 'custom' : 'rect');
        slot.image = { geometry: g };
      } else {
        const tx = first(shape, 'p', 'txBody');
        if (tx) {
          const bp = first(tx, 'a', 'bodyPr')!;
          const p0 = first(tx, 'a', 'p')!;
          const ppr = first(p0, 'a', 'pPr');
          const rpr = first(p0, 'a', 'rPr') ?? first(p0, 'a', 'endParaRPr');
          const lnSpc = ppr ? first(ppr, 'a', 'lnSpc') : null;
          const spcPts = lnSpc ? first(lnSpc, 'a', 'spcPts') : null;
          const spcPct = lnSpc ? first(lnSpc, 'a', 'spcPct') : null;
          const autofit = first(bp, 'a', 'noAutofit') ? 'none' : first(bp, 'a', 'normAutofit') ? 'shrink' : first(bp, 'a', 'spAutoFit') ? 'resize' : 'unspecified';
          slot.text = {
            sizePt: num(rpr?.getAttribute('sz'), 1800) / 100,
            bold: rpr?.getAttribute('b') === '1',
            latin: resolveFont(rpr ? first(rpr, 'a', 'latin')?.getAttribute('typeface') : null, 'latin'),
            ea: resolveFont(rpr ? first(rpr, 'a', 'ea')?.getAttribute('typeface') : null, 'ea'),
            spacingPt: num(rpr?.getAttribute('spc')) / 100,
            lineSpacing: spcPts ? { kind: 'pt', value: num(spcPts.getAttribute('val')) / 100 } : spcPct ? { kind: 'pct', value: num(spcPct.getAttribute('val')) / 100000 } : { kind: 'none' },
            align: ppr?.getAttribute('algn') ?? 'l',
            anchor: bp.getAttribute('anchor') ?? 't',
            wrap: bp.getAttribute('wrap') !== 'none',
            autofit,
            insetsPt: {
              l: num(bp.getAttribute('lIns'), 91440) / EMU_PER_PT,
              t: num(bp.getAttribute('tIns'), 45720) / EMU_PER_PT,
              r: num(bp.getAttribute('rIns'), 91440) / EMU_PER_PT,
              b: num(bp.getAttribute('bIns'), 45720) / EMU_PER_PT,
            },
            sample: paragraphsText(tx),
          };
        }
      }
      slots.push(slot);
    }
    const hardColors = all(doc, 'a', 'srgbClr').length + all(doc, 'a', 'sysClr').length;
    types.push({ slideNumber, order: i + 1, meta, notesError, slots, decorations, hardColors });
  }
  return {
    slideSize: { w: num(sz.getAttribute('cx')) / EMU_PER_PT, h: num(sz.getAttribute('cy')) / EMU_PER_PT },
    theme: { colors, fonts },
    types,
  };
}
