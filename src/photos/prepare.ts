/**
 * C段：写真の用意（REQUIREMENTS 7章C）。
 * 支給の写真（assets/photos/ と説明の photos.json）を写真の欄に割り当て、
 * 枠の縦横比に切り抜く → モノクロにする → 設定に応じて乗算する（色はテンプレートのテーマ色から取る）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';

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

/**
 * 写真を枠に合わせて加工する。
 * @param aspect 枠の縦横比（幅÷高さ）
 * @param multiplyHex 乗算する色（#なしの16進）。テーマ色の名前は呼び出し側で色に直す
 */
export async function processPhoto(src: string, out: string, aspect: number, proc: PhotoProcess, multiplyHex: string | null, maxWidth = 1600) {
  mkdirSync(path.dirname(out), { recursive: true });
  const meta = await sharp(src).rotate().metadata();
  const w = meta.autoOrient?.width ?? meta.width!;
  const h = meta.autoOrient?.height ?? meta.height!;
  const [cw, ch] = w / h > aspect ? [Math.round(h * aspect), h] : [w, Math.round(w / aspect)];
  let img = sharp(src)
    .rotate()
    .extract({ left: Math.round((w - cw) / 2), top: Math.round((h - ch) / 2), width: cw, height: ch })
    .resize({ width: Math.min(maxWidth, cw), withoutEnlargement: true });
  if (proc.mono) img = img.grayscale();
  if (multiplyHex) {
    const buf = await img.toColourspace('srgb').png().toBuffer();
    const m = await sharp(buf).metadata();
    const color = { r: parseInt(multiplyHex.slice(0, 2), 16), g: parseInt(multiplyHex.slice(2, 4), 16), b: parseInt(multiplyHex.slice(4, 6), 16) };
    img = sharp(buf).composite([{ input: { create: { width: m.width!, height: m.height!, channels: 3, background: color } }, blend: 'multiply' }]);
  }
  await img.jpeg({ quality: 85, mozjpeg: true }).toFile(out);
  return out;
}

/** 乗算の色：テーマ色の名前（accent1 など）か、16進の色。テーマ色の名前ならテンプレートの値に直す */
export function resolveColor(name: string | null, themeColors: Record<string, string>): string | null {
  if (!name) return null;
  if (/^[0-9a-f]{6}$/i.test(name)) return name.toUpperCase();
  const c = themeColors[name];
  if (!c) throw new Error(`乗算の色「${name}」はテンプレートのテーマ色に無い`);
  return c;
}
