/**
 * 写真素材を作る OpenAI Images API の呼び出し（REQUIREMENTS 10章）。
 * 考え方は IKEMENLTD/airlog@105d8ed src/lib/ai/slides/openai-image.ts から移植した:
 *   - SDK を入れず fetch で直に叩く（使うのは2つの口だけ）
 *   - 応答が JPEG であることをバイト列で確かめる（Content-Type を当てにしない）
 *   - 応答の使用量（トークン）を捨てずに残し、実費を出す
 *   - multipart の Content-Type は自分で書かない（boundary が落ちて 400）
 * 本件で変えたもの:
 *   - モデルは gpt-image-2.5-flare（10章）。見本の画像を複数（image[]）渡す（Phase 0 で実 API 確認済み。D-007）
 *   - input_fidelity は送らない（2.5-flare では 400。D-007）
 *   - 紙面ではなく「文字の無い写真」だけを作る
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GENERATIONS_URL = 'https://api.openai.com/v1/images/generations';
const EDITS_URL = 'https://api.openai.com/v1/images/edits';

/** 単価（米ドル／100万トークン・標準）。https://developers.openai.com/api/docs/pricing 2026-10-26 取得（D-007） */
export const IMAGE_PRICES: Record<string, { imageIn: number; textIn: number; imageOut: number }> = {
  'gpt-image-2.5-flare': { imageIn: 8, textIn: 5, imageOut: 30 },
};

/** 1枚あたりの待ち時間の上限。Phase 0 の実測は 7〜11 秒（medium） */
export const IMAGE_TIMEOUT_MS = 180_000;

export type ImageUsage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { text_tokens?: number; image_tokens?: number } };
export type GeneratedImage = { jpeg: Buffer; usage: ImageUsage; costUsd: number; ms: number; withReferences: number };

export type ImageGenerator = (req: { prompt: string; size: string; references: Buffer[] }) => Promise<GeneratedImage>;

export const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** 鍵は環境変数か ~/.config/hp-autogen/.env から読む。値は表示しない */
export function openAiKey(): string | null {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const f = path.join(os.homedir(), '.config/hp-autogen/.env');
  if (existsSync(f)) {
    const m = readFileSync(f, 'utf8').match(/^OPENAI_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  }
  return null;
}

export function costOf(model: string, u: ImageUsage): number {
  const p = IMAGE_PRICES[model];
  if (!p) return 0;
  return ((u.input_tokens_details?.image_tokens ?? 0) * p.imageIn + (u.input_tokens_details?.text_tokens ?? 0) * p.textIn + (u.output_tokens ?? 0) * p.imageOut) / 1e6;
}

export function openAiImageGenerator(opts: { model: string; quality: string; apiKey: string }): ImageGenerator {
  return async ({ prompt, size, references }) => {
    const started = Date.now();
    const call = async (): Promise<Response> => {
      const signal = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
      if (!references.length) {
        return fetch(GENERATIONS_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: opts.model, prompt, size, quality: opts.quality, output_format: 'jpeg', n: 1 }),
          signal,
        });
      }
      const fd = new FormData();
      fd.append('model', opts.model);
      fd.append('prompt', prompt);
      fd.append('size', size);
      fd.append('quality', opts.quality);
      fd.append('output_format', 'jpeg');
      references.forEach((buf, i) => fd.append('image[]', new Blob([new Uint8Array(buf)], { type: 'image/jpeg' }), `ref${i + 1}.jpg`));
      return fetch(EDITS_URL, { method: 'POST', headers: { Authorization: `Bearer ${opts.apiKey}` }, body: fd, signal });
    };
    let res = await call();
    // 混み合い（429）と相手側の失敗（5xx）は1回だけやり直す
    if (res.status === 429 || res.status >= 500) res = await call();
    if (!res.ok) {
      // 本文にはプロンプトが反射されることがあるので短く切る
      const body = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`写真の生成に失敗した（HTTP ${res.status}）: ${body}`);
    }
    const json = (await res.json()) as { data?: Array<{ b64_json?: string }>; usage?: ImageUsage };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error('写真の生成の応答に画像が無い');
    const jpeg = Buffer.from(b64, 'base64');
    if (!isJpeg(jpeg)) throw new Error('写真の生成の応答が JPEG ではない');
    const usage = json.usage ?? {};
    return { jpeg, usage, costUsd: costOf(opts.model, usage), ms: Date.now() - started, withReferences: references.length };
  };
}

/**
 * 写真のプロンプトの決まり（10章の必須事項。AirLog の design-system.ts の写真の作法から移植）。
 * 文字を入れない・人物は日本人・業務を実際にしている場面・服装と場所を資料全体でそろえる・自然光・背景を消さない。
 */
export function photoPrompt(cast: string, scene: string, withReferences: boolean, composition?: string | null): string {
  return [
    'Photorealistic documentary photograph for a Japanese corporate presentation.',
    'Absolutely no text, letters, numbers, logos, signage, labels or writing anywhere in the image, including on screens, papers, walls, machines and clothing.',
    'All people are Japanese. They are actually doing their work, not posing for the camera.',
    'Natural daylight. Keep the real background; do not blur it out or remove it.',
    `Cast and place, identical in every photo of this deck: ${cast}`,
    withReferences ? 'Use the reference images only to keep the same people, the same clothing and the same place. Make a new scene with a different camera angle and composition; do not copy the reference composition.' : '',
    `Scene: ${scene}`,
    composition ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** 枠の縦横比に近い生成サイズ（2.5 系は 16 の倍数。縦長・正方形・横長の3つから選ぶ） */
export function sizeFor(aspect: number): string {
  if (aspect < 0.8) return '1024x1536';
  if (aspect > 1.25) return '1536x1024';
  return '1024x1024';
}
