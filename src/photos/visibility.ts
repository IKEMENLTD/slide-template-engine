/**
 * 写真の欄のうち「実際に見えている部分」を測る。
 * 写真の上には、帯・三角・平行四辺形などの図形が重なっている型がある。ここに顔が来ると色ベタで潰れる。
 * 図形の形は型ごとに違い、回転・枠の形（平行四辺形の写真）・半透明も混ざるので、計算ではなく実際に描いて測る：
 *   テンプレートの写真をすべて単色（マゼンタ）に差し替えて描画 → 欄の中でマゼンタのまま残った画素が「見えている」。
 * 結果はテンプレートの中身（sha256）ごとに保存し、2回目からは描画しない。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DOMParser, type Element } from '@xmldom/xmldom';
import JSZip from 'jszip';
import sharp from 'sharp';
import type { Catalog } from '../catalog/build-catalog.js';
import { readTemplate } from '../catalog/read-template.js';
import { renderDeck } from '../render/render.js';

/** 欄を cols×rows に区切り、区画ごとの「見えている割合」（0〜1）。行ごとに上から */
export type VisGrid = { cols: number; rows: number; v: number[] };
/** 型 → 欄 → 見えている割合 */
export type VisibilityMap = Record<string, Record<string, VisGrid>>;

/** 測り方を変えたら上げる（古い保存を使わない） */
const VERSION = 1;
const PROBE = { r: 255, g: 0, b: 255 };
const COLS = 40;

const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** テンプレートの写真（欄の写真）をすべて単色に差し替えた .pptx を作る */
export async function probeTemplate(templatePath: string, catalog: Catalog): Promise<Buffer> {
  const zip = await JSZip.loadAsync(readFileSync(templatePath));
  const parser = new DOMParser();
  const targets = new Set<string>();
  for (const t of catalog.types) {
    const slotNames = new Set(t.slots.filter((s) => s.kind === 'img').map((s) => s.name));
    if (!slotNames.size) continue;
    const slidePath = `ppt/slides/slide${t.slideNumber}.xml`;
    const relsPath = `ppt/slides/_rels/slide${t.slideNumber}.xml.rels`;
    const doc = parser.parseFromString(await zip.file(slidePath)!.async('string'), 'text/xml');
    const rels = parser.parseFromString(await zip.file(relsPath)!.async('string'), 'text/xml');
    const relTarget = new Map<string, string>();
    for (const r of Array.from(rels.getElementsByTagName('Relationship') as unknown as Iterable<Element>)) relTarget.set(r.getAttribute('Id')!, r.getAttribute('Target')!);
    // 欄の名前を持つ図形（p:pic か、写真で塗った p:sp）の中の a:blip が指す画像
    for (const tag of ['pic', 'sp']) {
      for (const el of Array.from(doc.getElementsByTagNameNS(P_NS, tag) as unknown as Iterable<Element>)) {
        const cNvPr = el.getElementsByTagNameNS(P_NS, 'cNvPr').item(0);
        if (!cNvPr || !slotNames.has(cNvPr.getAttribute('name') ?? '')) continue;
        for (const blip of Array.from(el.getElementsByTagNameNS(A_NS, 'blip') as unknown as Iterable<Element>)) {
          const target = relTarget.get(blip.getAttributeNS(R_NS, 'embed') ?? '');
          if (target) targets.add(path.posix.normalize(path.posix.join('ppt/slides', target)));
        }
      }
    }
  }
  for (const t of targets) {
    const f = zip.file(t);
    if (!f) continue;
    const meta = await sharp(await f.async('nodebuffer')).metadata();
    const img = sharp({ create: { width: Math.min(meta.width ?? 64, 256), height: Math.min(meta.height ?? 64, 256), channels: 3, background: PROBE } });
    zip.file(t, /\.png$/i.test(t) ? await img.png().toBuffer() : await img.jpeg({ quality: 100 }).toBuffer());
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** 描いたページの画像から、欄ごとの見えている割合を数える */
export async function measure(pagePng: string, boxes: Array<{ name: string; box: { x: number; y: number; w: number; h: number } }>, slide: { w: number; h: number }): Promise<Record<string, VisGrid>> {
  const { data, info } = await sharp(pagePng).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const sx = info.width / slide.w;
  const sy = info.height / slide.h;
  const isProbe = (i: number) => Math.abs(data[i] - PROBE.r) < 70 && data[i + 1] < 90 && Math.abs(data[i + 2] - PROBE.b) < 70;
  const out: Record<string, VisGrid> = {};
  for (const { name, box } of boxes) {
    const rows = Math.max(4, Math.min(80, Math.round((COLS * box.h) / box.w)));
    const v: number[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < COLS; c++) {
        const x0 = Math.floor((box.x + (box.w * c) / COLS) * sx);
        const x1 = Math.max(x0 + 1, Math.floor((box.x + (box.w * (c + 1)) / COLS) * sx));
        const y0 = Math.floor((box.y + (box.h * r) / rows) * sy);
        const y1 = Math.max(y0 + 1, Math.floor((box.y + (box.h * (r + 1)) / rows) * sy));
        let n = 0;
        let hit = 0;
        for (let y = Math.max(0, y0); y < Math.min(info.height, y1); y++)
          for (let x = Math.max(0, x0); x < Math.min(info.width, x1); x++) {
            n++;
            if (isProbe((y * info.width + x) * 3)) hit++;
          }
        v.push(n ? Math.round((hit / n) * 100) / 100 : 0);
      }
    }
    out[name] = { cols: COLS, rows, v };
  }
  return out;
}

/** 型ごと・欄ごとの見えている割合。描画して測る（テンプレートの中身が同じなら保存したものを使う） */
export async function ensureVisibility(templatePath: string, catalog: Catalog, cacheDir: string, dpi = 48): Promise<VisibilityMap> {
  const file = path.join(cacheDir, `visibility-${catalog.template.sha256.slice(0, 16)}-v${VERSION}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as VisibilityMap;
  const raw = await readTemplate(readFileSync(templatePath));
  const pptx = await probeTemplate(templatePath, catalog);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'slidegen-vis-'));
  try {
    const r = await renderDeck(pptx, tmp, { dpi });
    const map: VisibilityMap = {};
    for (const t of catalog.types) {
      const boxes = t.slots.filter((s) => s.kind === 'img').map((s) => ({ name: s.name, box: s.box }));
      const png = r.pages[t.order - 1];
      if (!boxes.length || !png) continue;
      map[t.key] = await measure(png, boxes, raw.slideSize);
    }
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, JSON.stringify(map));
    return map;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 欄の中の、ある範囲（0〜1 の座標）の見えている割合の平均 */
export function visibleIn(g: VisGrid, u0: number, v0: number, u1: number, v1: number): number {
  const c0 = Math.max(0, Math.floor(u0 * g.cols));
  const c1 = Math.min(g.cols - 1, Math.ceil(u1 * g.cols) - 1);
  const r0 = Math.max(0, Math.floor(v0 * g.rows));
  const r1 = Math.min(g.rows - 1, Math.ceil(v1 * g.rows) - 1);
  if (c1 < c0 || r1 < r0) return 0;
  let s = 0;
  let n = 0;
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) {
      s += g.v[r * g.cols + c];
      n++;
    }
  return n ? s / n : 0;
}

/** 見えている部分がこれ未満の欄は、顔を1人にする */
export const NARROW = 0.5;

/** 欄の中で見えている部分の言い方（写真を生成するときに、人をどこに置くかを伝える）。ほぼ全部見えているなら null */
export function openAreaHint(g: VisGrid): string | null {
  if (visibleIn(g, 0, 0, 1, 1) > 0.9) return null;
  const V = ['upper', 'middle', 'lower'];
  const H = ['left', 'center', 'right'];
  let best = { r: 1, c: 1, v: -1 };
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const v = visibleIn(g, c / 3, r / 3, (c + 1) / 3, (r + 1) / 3);
    if (v > best.v + 0.02) best = { r, c, v };
  }
  const where = best.r === 1 && best.c === 1 ? 'center' : best.r === 1 ? H[best.c] : best.c === 1 ? V[best.r] : `${V[best.r]} ${H[best.c]}`;
  // 「図形で隠れる」と書くと、生成AIが写真の中に色ベタの図形を描き込む（2026-10-27 実測）。図形の話はせず、置き場所だけを言う
  const base = `Composition: put the main person's face in the ${where} part of the frame, and keep every other face out of the rest of the frame (show only background, machines or people's backs there). This must be one natural, unedited photograph filling the whole frame edge to edge: do not draw any graphic shapes, color blocks, panels, borders, overlays or empty areas.`;
  // 見えている部分が半分に満たない欄（斜めの帯の間だけ見える等）に、何人もの顔は収まらない（2026-10-27 実例：3人の場面で 0.35）
  if (visibleIn(g, 0, 0, 1, 1) < NARROW)
    return `${base} Only ONE person's face may appear in this photo, even if the scene mentions several people: any other people must be seen from behind or be far away with their faces not visible.`;
  return base;
}
