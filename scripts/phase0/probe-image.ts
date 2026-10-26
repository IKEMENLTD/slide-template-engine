/**
 * Phase 0 検証③：gpt-image-2.5-flare で写真素材を作る。
 *   1枚目：生成API（見本なし）
 *   2枚目：編集API に 1枚目を見本として渡す
 *   3枚目：編集API に 1枚目と2枚目の2枚を見本として渡す（要件 10章「見本2枚以上」）
 * を順に呼び、所要時間・使用量・実費の概算を out/phase0/images/result.json に残す。
 * 文字が入っていないか・人物がそろっているかは、出力の一覧画像を人が見て判断する。
 *
 * 鍵は OPENAI_API_KEY か ~/.config/hp-autogen/.env（OPENAI_API_KEY=...）から読む。値は表示しない。
 * 使い方: npx tsx scripts/phase0/probe-image.ts [--quality medium]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'out/phase0/images');
mkdirSync(OUT, { recursive: true });

const MODEL = 'gpt-image-2.5-flare';
const SIZE = '1536x1024';
const quality = process.argv.includes('--quality') ? process.argv[process.argv.indexOf('--quality') + 1] : 'medium';

// 価格（USD / 100万トークン・標準）。https://developers.openai.com/api/docs/pricing 2026-10-26 取得
const PRICE = { imageIn: 8, textIn: 5, imageOut: 30 };

function apiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const f = path.join(os.homedir(), '.config/hp-autogen/.env');
  if (existsSync(f)) {
    const m = readFileSync(f, 'utf8').match(/^OPENAI_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  }
  throw new Error('OPENAI_API_KEY が見つからない');
}

// AirLog の写真の作法（10章の必須事項）を、写真生成にだけ使う
const COMMON = [
  'Photorealistic documentary photograph for a Japanese corporate presentation.',
  'Absolutely no text, letters, numbers, logos, signage, labels or writing anywhere in the image, including on screens, papers, walls and clothing.',
  'All people are Japanese. They are actually doing their work, not posing for the camera.',
  'Natural daylight. Keep the real background; do not blur it out or remove it.',
].join(' ');

const CAST = 'The same woman in her 30s with a short black bob haircut, wearing a plain navy work jacket over a white collarless blouse, in the same bright small office with white walls and light wooden desks.';

const SHOTS = [
  { id: '01', mode: 'generate', refs: [] as string[], prompt: `${COMMON} ${CAST} She is typing on a laptop at her desk, seen from a slight side angle.` },
  { id: '02', mode: 'edit', refs: ['01'], prompt: `${COMMON} Use the reference image only to keep the same person, the same clothing and the same office. New scene: ${CAST} She is explaining something to a male colleague in his 50s while pointing at a laptop screen that shows only abstract charts without any text.` },
  { id: '03', mode: 'edit', refs: ['01', '02'], prompt: `${COMMON} Use the reference images only to keep the same people, the same clothing and the same office. New scene: ${CAST} She and the same male colleague from the second reference are standing by a window holding a sheet of blank paper, discussing a plan.` },
];

type Usage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { text_tokens?: number; image_tokens?: number } };

async function call(shot: (typeof SHOTS)[number], key: string) {
  const t0 = Date.now();
  let res: Response;
  if (shot.mode === 'generate') {
    res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: shot.prompt, size: SIZE, quality, output_format: 'jpeg', n: 1 }),
    });
  } else {
    const fd = new FormData();
    fd.append('model', MODEL);
    fd.append('prompt', shot.prompt);
    fd.append('size', SIZE);
    fd.append('quality', quality);
    fd.append('output_format', 'jpeg');
    // input_fidelity は 2.5-flare では 400（invalid_input_fidelity_model）になるので送らない（D-007）
    for (const r of shot.refs) {
      const buf = readFileSync(path.join(OUT, `${r}.jpg`));
      fd.append('image[]', new Blob([buf], { type: 'image/jpeg' }), `${r}.jpg`);
    }
    res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd });
  }
  const ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) return { id: shot.id, ok: false, status: res.status, ms, error: text.slice(0, 600) };
  const json = JSON.parse(text);
  const b64 = json.data?.[0]?.b64_json as string;
  const buf = Buffer.from(b64, 'base64');
  // JPEG であることを確かめてから保存する（AirLog の openai-image.ts と同じ確認）
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  writeFileSync(path.join(OUT, `${shot.id}.jpg`), buf);
  const usage: Usage | undefined = json.usage;
  const cost = usage
    ? ((usage.input_tokens_details?.image_tokens ?? 0) * PRICE.imageIn + (usage.input_tokens_details?.text_tokens ?? 0) * PRICE.textIn + (usage.output_tokens ?? 0) * PRICE.imageOut) / 1e6
    : null;
  const meta = await sharp(buf).metadata();
  return { id: shot.id, ok: true, mode: shot.mode, refs: shot.refs, ms, isJpeg, width: meta.width, height: meta.height, usage, costUsd: cost, revisedPrompt: json.data?.[0]?.revised_prompt ?? null };
}

const key = apiKey();
const results = [];
for (const s of SHOTS) {
  const r = await call(s, key);
  results.push(r);
  console.log(JSON.stringify({ ...r, revisedPrompt: undefined }));
  if (!r.ok) break;
}
// 人が見る一覧（3枚を横に並べる）
const ok = results.filter((r) => r.ok);
if (ok.length) {
  const tiles = await Promise.all(ok.map((r) => sharp(path.join(OUT, `${r.id}.jpg`)).resize(768).toBuffer()));
  const h = Math.round((768 * 1024) / 1536);
  await sharp({ create: { width: 768 * tiles.length + 10 * (tiles.length - 1), height: h, channels: 3, background: '#fff' } })
    .composite(tiles.map((t, i) => ({ input: t, left: i * 778, top: 0 })))
    .jpeg({ quality: 85 })
    .toFile(path.join(OUT, 'contact-sheet.jpg'));
}
writeFileSync(
  path.join(OUT, 'result.json'),
  JSON.stringify({ model: MODEL, size: SIZE, quality, price: PRICE, results, totalUsd: results.reduce((s, r) => s + ((r as { costUsd?: number | null }).costUsd ?? 0), 0) }, null, 2),
);
