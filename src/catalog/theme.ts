/**
 * 配色の差し替え（REQUIREMENTS 15章 Phase 5「テーマ色の差し替えだけで成立するか」）。
 * テンプレートのテーマ（theme1.xml の配色）だけを書き換える。スライド・図形・文字には触らない。
 * 図形と文字がテーマ色を参照していれば（直書きの色が無ければ。カタログで確かめる）、資料全体の色が変わる。
 */
import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import JSZip from 'jszip';
import path from 'node:path/posix';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const THEME_COLOR_NAMES = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'] as const;

async function themePart(zip: JSZip): Promise<string> {
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
  const m = rels.match(/Type="[^"]*\/theme"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Type="[^"]*\/theme"/);
  const t = m?.[1] ?? m?.[2];
  if (!t) throw new Error('テーマが見つからない');
  return path.join('ppt', t);
}

/** テーマの配色を読む（名前 → 6桁の16進） */
export async function readThemeColors(buf: Buffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buf);
  const doc = new DOMParser().parseFromString(await zip.file(await themePart(zip))!.async('string'), 'text/xml');
  const scheme = doc.getElementsByTagNameNS(A, 'clrScheme').item(0)!;
  const out: Record<string, string> = {};
  for (let n = scheme.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    const el = n as Element;
    const c = el.getElementsByTagNameNS(A, 'srgbClr').item(0)?.getAttribute('val') ?? el.getElementsByTagNameNS(A, 'sysClr').item(0)?.getAttribute('lastClr');
    if (c) out[el.localName!] = c.toUpperCase();
  }
  return out;
}

/** 配色を差し替えた .pptx を返す。colors は 名前 → 6桁の16進（# なし） */
export async function retheme(buf: Buffer, colors: Record<string, string>, schemeName?: string): Promise<Buffer> {
  for (const [k, v] of Object.entries(colors)) {
    if (!(THEME_COLOR_NAMES as readonly string[]).includes(k)) throw new Error(`テーマ色の名前「${k}」は無い（${THEME_COLOR_NAMES.join(', ')}）`);
    if (!/^[0-9a-f]{6}$/i.test(v)) throw new Error(`色「${v}」は6桁の16進で書く（例 1E8C4E）`);
  }
  const zip = await JSZip.loadAsync(buf);
  const part = await themePart(zip);
  const doc = new DOMParser().parseFromString(await zip.file(part)!.async('string'), 'text/xml');
  const scheme = doc.getElementsByTagNameNS(A, 'clrScheme').item(0)!;
  if (schemeName) scheme.setAttribute('name', schemeName);
  for (const [name, hex] of Object.entries(colors)) {
    const el = scheme.getElementsByTagNameNS(A, name).item(0)!;
    while (el.firstChild) el.removeChild(el.firstChild);
    const c = doc.createElementNS(A, 'a:srgbClr');
    c.setAttribute('val', hex.toUpperCase());
    el.appendChild(c);
  }
  zip.file(part, new XMLSerializer().serializeToString(doc));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
