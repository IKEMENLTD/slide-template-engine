/**
 * C段：写真の用意（REQUIREMENTS 7章C）。
 * 支給の写真（assets/photos/ と説明の photos.json）を写真の欄に割り当て、
 * 枠の縦横比に切り抜く → モノクロにする → 設定に応じて乗算する（色はテンプレートのテーマ色から取る）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { detectFaces, type Face } from './faces.js';
import { visibleIn, type VisGrid } from './visibility.js';

export const PhotoLibrarySchema = z.array(
  z.object({
    /** photos.json からの相対パス */
    file: z.string(),
    /** 何が写っているか（割り当てに使う） */
    description: z.string().default(''),
    /** 生成した写真なら true（レポートに出す） */
    generated: z.boolean().default(false),
  })
);
export type PhotoEntry = z.infer<typeof PhotoLibrarySchema>[number] & { path: string };

const IMG = /\.(jpe?g|png|webp)$/i;

/** 写真の置き場所を読む。photos.json が無ければ、置いてある画像をすべて使う */
export function loadPhotoLibrary(dir: string): PhotoEntry[] {
  if (!existsSync(dir)) return [];
  const json = path.join(dir, 'photos.json');
  if (existsSync(json)) {
    return PhotoLibrarySchema.parse(JSON.parse(readFileSync(json, 'utf8'))).map((e) => ({ ...e, path: path.resolve(dir, e.file) }));
  }
  return readdirSync(dir)
    .filter((f) => IMG.test(f))
    .sort()
    .map((f) => ({ file: f, description: '', generated: false, path: path.join(dir, f) }));
}

export type PhotoProcess = { mono: boolean; multiply: string | null };

/** 切り抜きを決めた結果（設計図に残し、検査と画面で使う） */
export type PhotoFit = {
  /** 見つかった顔の数 */
  faces: number;
  /** 大きな顔のうち、いちばん見えていない顔の「見えている割合」（0〜1）。顔が無ければ null */
  faceVisible: number | null;
  /** 左右を反転したか */
  flipped: boolean;
  /** 切り抜きの拡大率（1 = 写真の短い辺いっぱい） */
  zoom: number;
  /** 切り抜いた範囲（元の写真の画素） */
  crop: { left: number; top: number; width: number; height: number } | null;
};

export type FitOptions = {
  /** 欄の見えている割合（visibility.ts）。無ければ顔を枠の中に残すことだけを考える */
  grid?: VisGrid | null;
  /** 左右の反転を許すか（生成した写真だけ。支給の写真は文字や向きが変わるので反転しない） */
  allowFlip?: boolean;
  /** 顔の検出を渡す（試験用）。省くと写真から探す */
  faces?: Face[];
  /** 切り抜く幅の下限（元の写真の画素）。拡大しすぎて粗くならないように */
  minCropWidth?: number;
};

const ZOOMS = [1, 1.15, 1.3, 1.5];
const STEPS = 24;

/**
 * 顔が「見えている部分」に入る切り抜きを選ぶ。
 * 点数＝顔ごとに（枠に入っている割合 × その位置の見えている割合）を、大きな顔ほど重く足したもの。
 * 顔が枠の端で切れるときは減点、拡大と反転は同点ならしない側を選ぶ（わずかに減点）。
 */
export function chooseCrop(w: number, h: number, aspect: number, faces: Face[], opts: FitOptions): { left: number; top: number; width: number; height: number; zoom: number; flipped: boolean; score: number; faceVisible: number } {
  const maxArea = Math.max(...faces.map((f) => f.w * f.h));
  const major = faces.filter((f) => f.w * f.h >= maxArea * 0.25);
  const [cw0, ch0] = w / h > aspect ? [h * aspect, h] : [w, w / aspect];
  let best = { left: 0, top: 0, width: cw0, height: ch0, zoom: 1, flipped: false, score: -Infinity, faceVisible: 0 };
  for (const zoom of ZOOMS) {
    const cw = cw0 / zoom;
    const ch = ch0 / zoom;
    if (zoom > 1 && cw < (opts.minCropWidth ?? 0)) continue;
    for (let i = 0; i <= STEPS; i++)
      for (let j = 0; j <= STEPS; j++) {
        const left = ((w - cw) * i) / STEPS;
        const top = ((h - ch) * j) / STEPS;
        for (const flipped of opts.allowFlip ? [false, true] : [false]) {
          let score = 0;
          let worst = 1;
          for (const f of faces) {
            const ix0 = Math.max(f.x, left);
            const iy0 = Math.max(f.y, top);
            const ix1 = Math.min(f.x + f.w, left + cw);
            const iy1 = Math.min(f.y + f.h, top + ch);
            const inside = ix1 > ix0 && iy1 > iy0 ? ((ix1 - ix0) * (iy1 - iy0)) / (f.w * f.h) : 0;
            let vis = 1;
            if (inside > 0 && opts.grid) {
              let u0 = (ix0 - left) / cw;
              let u1 = (ix1 - left) / cw;
              if (flipped) [u0, u1] = [1 - u1, 1 - u0];
              vis = visibleIn(opts.grid, u0, (iy0 - top) / ch, u1, (iy1 - top) / ch);
            }
            const seen = inside * vis;
            const weight = (f.w * f.h) / maxArea;
            score += weight * seen;
            // 枠の端で顔が半分だけ切れるのは、全部入るより・全部外れるより悪い
            if (inside > 0.05 && inside < 0.9) score -= weight * 0.6;
            if (major.includes(f)) worst = Math.min(worst, seen);
          }
          score -= (zoom - 1) * 0.08 + (flipped ? 0.03 : 0);
          if (score > best.score + 1e-9) best = { left, top, width: cw, height: ch, zoom, flipped, score, faceVisible: worst };
        }
      }
  }
  return { ...best, left: Math.round(best.left), top: Math.round(best.top), width: Math.round(best.width), height: Math.round(best.height) };
}

/**
 * 写真を枠に合わせて加工する。
 * @param aspect 枠の縦横比（幅÷高さ）
 * @param multiplyHex 乗算する色（#なしの16進）。テーマ色の名前は呼び出し側で色に直す
 * 顔が写っていれば、顔が図形に隠れない切り抜きを選ぶ（chooseCrop）。顔が無ければ sharp の attention（目立つところを残す）。
 */
export async function processPhoto(src: string, out: string, aspect: number, proc: PhotoProcess, multiplyHex: string | null, maxWidth = 1600, opts: FitOptions = {}): Promise<{ out: string; fit: PhotoFit }> {
  mkdirSync(path.dirname(out), { recursive: true });
  const upright = await sharp(src).rotate().toBuffer();
  const meta = await sharp(upright).metadata();
  const w = meta.width!;
  const h = meta.height!;
  const faces = opts.faces ?? (await detectFaces(upright));
  let img: ReturnType<typeof sharp>;
  let fit: PhotoFit;
  if (faces.length) {
    const c = chooseCrop(w, h, aspect, faces, opts);
    const outW = Math.min(maxWidth, c.width);
    img = sharp(upright).extract({ left: c.left, top: c.top, width: Math.min(c.width, w - c.left), height: Math.min(c.height, h - c.top) });
    if (c.flipped) img = img.flop();
    img = img.resize({ width: outW, height: Math.round(outW / aspect), fit: 'fill' });
    fit = { faces: faces.length, faceVisible: Math.round(c.faceVisible * 100) / 100, flipped: c.flipped, zoom: c.zoom, crop: { left: c.left, top: c.top, width: c.width, height: c.height } };
  } else {
    const [cw] = w / h > aspect ? [Math.round(h * aspect), h] : [w, Math.round(w / aspect)];
    const outW = Math.min(maxWidth, cw);
    // 顔が無い写真は、目立つところを残す（sharp の attention。中央で切ると主役が切れることがある）
    img = sharp(upright).resize({ width: outW, height: Math.round(outW / aspect), fit: 'cover', position: sharp.strategy.attention, withoutEnlargement: true });
    fit = { faces: 0, faceVisible: null, flipped: false, zoom: 1, crop: null };
  }
  if (proc.mono) img = img.grayscale();
  if (multiplyHex) {
    const buf = await img.toColourspace('srgb').png().toBuffer();
    const m = await sharp(buf).metadata();
    const color = { r: parseInt(multiplyHex.slice(0, 2), 16), g: parseInt(multiplyHex.slice(2, 4), 16), b: parseInt(multiplyHex.slice(4, 6), 16) };
    img = sharp(buf).composite([{ input: { create: { width: m.width!, height: m.height!, channels: 3, background: color } }, blend: 'multiply' }]);
  }
  await img.jpeg({ quality: 85, mozjpeg: true }).toFile(out);
  return { out, fit };
}

/** 乗算の色：テーマ色の名前（accent1 など）か、16進の色。テーマ色の名前ならテンプレートの値に直す */
export function resolveColor(name: string | null, themeColors: Record<string, string>): string | null {
  if (!name) return null;
  if (/^[0-9a-f]{6}$/i.test(name)) return name.toUpperCase();
  const c = themeColors[name];
  if (!c) throw new Error(`乗算の色「${name}」はテンプレートのテーマ色に無い`);
  return c;
}
