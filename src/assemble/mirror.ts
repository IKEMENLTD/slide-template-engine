/**
 * ページの左右反転（D-042）。先方のデザインルール「一定のルールで統一感をつくり、その中で意図的に変化をつける」（はじめに・5-4）を、
 * AI に位置を決めさせずに（17章）実現する。先方の見本 PDF（0925_資料.pdf）では、
 *   統一＝左上の角の英字ラベル・右下の黄色い三角は毎ページ同じ場所
 *   変化＝写真と図形のかたまりは、ページごとに左・右・中央と置き方が変わる
 * なので、反転するのは「写真と図形のかたまり」だけにし、次を守る：
 *   - fixed（テンプレートの設定で型ごとに決める）の部品は動かさない（角のラベル・右下の三角など）
 *   - 番号の付いた欄（txt.item.1… / img.item.1… など）とその中の飾りは、ひとかたまりとして平行に動かす。
 *     中の並び（写真が左・文字が右）と順番（1→2→3 を左から）は変えない
 *   - 文字に添えた細い線（見出しの下線など）は、その文字の左端に付いたまま動かす
 *   - それ以外の図形・写真の枠は、縦の中心線で位置と形を写す（flipH は使わず座標を写す＝写真そのものは鏡写しにしない）
 *   - 文字の欄は位置だけを写し、左揃えのまま。斜めの文字は角度と揃えを逆にする（ラベルが同じ端に寄るように）
 * 反転してよい型は templates/<名前>.config.json の mirror で決める。
 */
import path from 'node:path';
import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import JSZip from 'jszip';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

const kids = (el: Element, ns: string, name: string): Element[] =>
  Array.from(el.childNodes as unknown as Iterable<Element>).filter((n) => n.nodeType === 1 && n.namespaceURI === ns && n.localName === name);
const all = (el: Element, ns: string, name: string): Element[] => Array.from(el.getElementsByTagNameNS(ns, name) as unknown as Iterable<Element>);

type Shape = { el: Element; name: string; xfrm: Element; off: Element; x: number; y: number; w: number; h: number; rot: number; text: boolean };

/** 番号の付いた欄（項目のかたまりの一部）：txt.item.1.title / img.item.2 / num.value.3 / txt.point.1.lead など */
export const isItemSlot = (name: string) => /^(txt|img|num)\.[^.]+\.\d+(\.|$)/.test(name);

function readShape(el: Element): Shape | null {
  const spPr = kids(el, P, 'spPr')[0];
  const xfrm = spPr && kids(spPr, A, 'xfrm')[0];
  const off = xfrm && kids(xfrm, A, 'off')[0];
  const ext = xfrm && kids(xfrm, A, 'ext')[0];
  if (!xfrm || !off || !ext) return null;
  const name = all(el, P, 'cNvPr')[0]?.getAttribute('name') ?? '';
  return {
    el, name, xfrm, off,
    x: Number(off.getAttribute('x')), y: Number(off.getAttribute('y')),
    w: Number(ext.getAttribute('cx')), h: Number(ext.getAttribute('cy')),
    rot: Number(xfrm.getAttribute('rot') ?? 0),
    text: kids(el, P, 'txBody').length > 0 && all(el, A, 't').some((t) => (t.textContent ?? '').length > 0),
  };
}

const setX = (s: Shape, x: number) => s.off.setAttribute('x', String(Math.round(x)));

/** 形（座標で描いた形・既定の形）を左右に写す。写真の塗りは写さない */
function mirrorGeometry(s: Shape): void {
  const spPr = kids(s.el, P, 'spPr')[0];
  const cust = kids(spPr, A, 'custGeom')[0];
  if (cust) {
    for (const path of all(cust, A, 'path')) {
      const w = Number(path.getAttribute('w') ?? 0);
      for (const pt of all(path, A, 'pt')) pt.setAttribute('x', String(w - Number(pt.getAttribute('x'))));
    }
    return;
  }
  const prst = kids(spPr, A, 'prstGeom')[0]?.getAttribute('prst');
  if (prst && prst !== 'rect' && !s.text && s.el.localName !== 'pic') {
    if (s.xfrm.getAttribute('flipH') === '1') s.xfrm.removeAttribute('flipH');
    else s.xfrm.setAttribute('flipH', '1');
  }
}

/** 斜めの文字：角度を逆にし、左揃え⇔右揃えを入れ替える（ラベルが元と同じ端＝角の側に寄る） */
function mirrorRotatedText(s: Shape): void {
  s.xfrm.setAttribute('rot', String((21600000 - s.rot) % 21600000));
  const body = kids(s.el, P, 'txBody')[0];
  if (!body) return;
  for (const p of all(body, A, 'p')) {
    let pPr = kids(p, A, 'pPr')[0];
    if (!pPr) {
      pPr = p.ownerDocument!.createElementNS(A, 'a:pPr');
      p.insertBefore(pPr, p.firstChild);
    }
    const algn = pPr.getAttribute('algn') ?? 'l';
    pPr.setAttribute('algn', algn === 'r' ? 'l' : algn === 'l' ? 'r' : algn);
  }
}

type Box = { x0: number; x1: number; y0: number; y1: number };
const boxOf = (ss: Shape[]): Box => ({ x0: Math.min(...ss.map((s) => s.x)), x1: Math.max(...ss.map((s) => s.x + s.w)), y0: Math.min(...ss.map((s) => s.y)), y1: Math.max(...ss.map((s) => s.y + s.h)) });
const inside = (a: Shape, b: Box, tol: number) => a.x >= b.x0 - tol && a.x + a.w <= b.x1 + tol && a.y >= b.y0 - tol && a.y + a.h <= b.y1 + tol;
const overlaps = (a: Shape, b: Shape) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** 名前の番号（txt.item.2.title → 2、deco.value-2-rule → 2） */
const indexOf = (name: string) => Number(name.match(/[.-](\d+)(?=[.-]|$)/)?.[1] ?? NaN);

/** 端からこれより内側に文字を置く（横幅に対する割合）。グリッド7列の半列ほど */
export const TEXT_MARGIN = 0.045;

/**
 * スライドの XML を左右反転したものを返す。fixed は動かさない部品の名前
 * （ただし反転した写真の上に乗ってしまうものは、写真と一緒に写す）。
 */
export function mirrorSlideXml(xml: string, slideW: number, slideH: number, fixed: ReadonlySet<string> = new Set()): string {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const tree = all(doc.documentElement as unknown as Element, P, 'spTree')[0];
  if (!tree) return xml;
  const every = ['sp', 'pic', 'cxnSp'].flatMap((t) => kids(tree, P, t)).map(readShape).filter((s): s is Shape => !!s);
  const anchors = every.filter((s) => fixed.has(s.name));
  const shapes = every.filter((s) => !fixed.has(s.name));
  const used = new Set<Shape>();
  /** 外枠を写す位置へ、かたまりのまま平行に動かす（端に近すぎれば内側へ） */
  const blocks: Shape[][] = [];

  // 1. 番号の付いた欄：番号ごとのかたまり（同じ番号の飾りで、そばにあるものを含む）
  const items = shapes.filter((s) => isItemSlot(s.name));
  const byIndex = new Map<number, Shape[]>();
  for (const s of items) byIndex.set(indexOf(s.name), [...(byIndex.get(indexOf(s.name)) ?? []), s]);
  for (const [n, ss] of byIndex) {
    const b = boxOf(ss);
    for (const d of shapes) if (d.name.startsWith('deco.') && indexOf(d.name) === n && inside(d, { x0: b.x0 - slideW * 0.05, x1: b.x1 + slideW * 0.05, y0: b.y0 - slideH * 0.06, y1: b.y1 + slideH * 0.06 }, 0)) ss.push(d);
  }
  if (byIndex.size) {
    const list = [...byIndex.values()];
    const cx = list.map((ss) => { const b = boxOf(ss); return (b.x0 + b.x1) / 2; });
    const cy = list.map((ss) => { const b = boxOf(ss); return (b.y0 + b.y1) / 2; });
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    // 横に並ぶ項目は順番（1→2→3 を左から）を保つため全体で1つ、縦に並ぶ項目は1つずつ
    if (spread(cx) >= spread(cy)) {
      const g = list.flat();
      const b = boxOf(g);
      for (const d of shapes) if (d.name.startsWith('deco.') && !g.includes(d) && inside(d, b, slideW * 0.01)) g.push(d);
      blocks.push(g);
    } else blocks.push(...list);
  }
  for (const g of blocks) for (const s of g) used.add(s);

  // 2. 文字の列：左端のそろった横書きの欄（見出し・本文・注記）と、その範囲の中の細い線
  const texts = shapes.filter((s) => s.text && !s.rot && !used.has(s)).sort((a, b) => a.y - b.y);
  for (const t of texts) {
    if (used.has(t)) continue;
    const col = texts.filter((u) => !used.has(u) && Math.abs(u.x - t.x) <= slideW * 0.03);
    col.forEach((u) => used.add(u));
    const b = boxOf(col);
    for (const d of shapes) if (!used.has(d) && d.name.startsWith('deco.') && d.h <= slideH * 0.02 && inside(d, b, slideW * 0.005)) { col.push(d); used.add(d); }
    blocks.push(col);
  }

  for (const g of blocks) {
    const b = boxOf(g);
    let dx = slideW - b.x1 - b.x0;
    const m = slideW * TEXT_MARGIN;
    if (b.x0 + dx < m && b.x1 + (m - b.x0) <= slideW) dx = m - b.x0;
    for (const s of g) setX(s, s.x + dx);
  }

  // 3. のこり（写真の枠・飾りの図形・斜めの文字）：位置と形を写す
  const rest = shapes.filter((s) => !used.has(s));
  for (const s of rest) {
    s.x = slideW - s.x - s.w;
    setX(s, s.x);
    if (s.text && s.rot) mirrorRotatedText(s);
    else if (!s.text) mirrorGeometry(s);
  }
  // 4. 動かさない部品のうち、写した写真の上に乗るものは写真と一緒に写す
  const photos = rest.filter((s) => s.el.localName === 'pic' || s.name.startsWith('img.'));
  for (const a of anchors) {
    if (!photos.some((p) => overlaps(a, p))) continue;
    setX(a, slideW - a.x - a.w);
    if (a.text && a.rot) mirrorRotatedText(a);
    else if (!a.text) mirrorGeometry(a);
  }
  return new XMLSerializer().serializeToString(doc);
}

/** スライドの XML から、名前の付いた図形の位置（pt）を読む。反転した版の写真の欄を測るのに使う */
export function shapeBoxes(xml: string): Record<string, { x: number; y: number; w: number; h: number }> {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const tree = all(doc.documentElement as unknown as Element, P, 'spTree')[0];
  const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
  if (!tree) return out;
  for (const s of ['sp', 'pic', 'cxnSp'].flatMap((t) => kids(tree, P, t)).map(readShape)) if (s?.name) out[s.name] = { x: s.x / 12700, y: s.y / 12700, w: s.w / 12700, h: s.h / 12700 };
  return out;
}

/** pptx の中のスライドの場所を、並び順（presentation.xml の順）で返す */
export async function orderedSlideParts(zip: JSZip): Promise<string[]> {
  const pres = await zip.file('ppt/presentation.xml')!.async('string');
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
  const target = new Map([...rels.matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  return [...pres.matchAll(/<p:sldId [^>]*r:id="([^"]+)"/g)].map((m) => path.posix.join('ppt', target.get(m[1])!.replace(/^\/?ppt\//, '')));
}

/** pptx のうち、指定したページ（1始まり）を左右反転する。fixed はページごとの動かさない部品 */
export async function mirrorPptx(buf: Buffer, pages: Array<{ page: number; fixed: string[] }>): Promise<Buffer> {
  if (!pages.length) return buf;
  const zip = await JSZip.loadAsync(buf);
  const pres = await zip.file('ppt/presentation.xml')!.async('string');
  const [, w, h] = pres.match(/<p:sldSz cx="(\d+)" cy="(\d+)"/)!.map(Number);
  const parts = await orderedSlideParts(zip);
  for (const { page, fixed } of pages) {
    const part = parts[page - 1];
    if (!part) continue;
    zip.file(part, mirrorSlideXml(await zip.file(part)!.async('string'), w, h, new Set(fixed)));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
