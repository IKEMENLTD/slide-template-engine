/**
 * 写真の中の人の顔を探す（写真の切り抜き位置を決めるため）。
 * 使うのは UltraFace（version-RFB-640・MIT・1.6MB。models/ に同梱）を onnxruntime で動かすだけ。外へは何も送らない。
 * 顔が見つからない写真（後ろ姿・手元）は空を返す。その場合の切り抜きは従来どおり sharp の attention に任せる。
 */
import path from 'node:path';
import sharp from 'sharp';
import type { InferenceSession } from 'onnxruntime-node';

const MODEL = path.resolve(import.meta.dirname, '../../models/ultraface-RFB-640.onnx');
const IN_W = 640;
const IN_H = 480;

/** 顔の枠（元の写真の画素）。score は 0〜1 */
export type Face = { x: number; y: number; w: number; h: number; score: number };

let session: Promise<InferenceSession> | null = null;
async function getSession() {
  if (!session) {
    session = (async () => {
      // onnxruntime は使用状況を外へ送る機能を持つ。読み込む前に切る（写真は送らないが、外へは何も出さない）
      process.env.ORT_DISABLE_TELEMETRY ??= '1';
      const ort = await import('onnxruntime-node');
      // モデルの書き出し方の都合で毎回出る警告（重みが入力に見える）を黙らせる
      // 1枚 0.3 秒ほどの小さなモデルなので、CPU を取り合わないよう少ないスレッドで回す（並べて動かすと全コアの奪い合いで遅くなる）
      return ort.InferenceSession.create(MODEL, { logSeverityLevel: 3, intraOpNumThreads: 2, interOpNumThreads: 1 });
    })();
  }
  return session;
}

const iou = (a: Face, b: Face) => {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter);
};

/**
 * @param input 写真（ファイルのパスか中身）。EXIF の向きは直してから探す
 * @param minScore これ未満は顔と見なさない
 */
export async function detectFaces(input: string | Buffer, minScore = 0.75): Promise<Face[]> {
  const base = sharp(input).rotate();
  const meta = await sharp(await base.clone().toBuffer()).metadata();
  const W = meta.width!;
  const H = meta.height!;
  // 縦横比を保ったまま 640x480 に収め、余りは灰色で埋める（引き伸ばすと顔の形が崩れて見逃す）
  const scale = Math.min(IN_W / W, IN_H / H);
  const rw = Math.round(W * scale);
  const rh = Math.round(H * scale);
  const padX = Math.floor((IN_W - rw) / 2);
  const padY = Math.floor((IN_H - rh) / 2);
  const raw = await base
    .clone()
    .resize(rw, rh)
    .removeAlpha()
    .extend({ left: padX, right: IN_W - rw - padX, top: padY, bottom: IN_H - rh - padY, background: { r: 127, g: 127, b: 127 } })
    .raw()
    .toBuffer();
  const chw = new Float32Array(3 * IN_W * IN_H);
  for (let i = 0; i < IN_W * IN_H; i++) for (let c = 0; c < 3; c++) chw[c * IN_W * IN_H + i] = (raw[i * 3 + c] - 127) / 128;
  const ort = await import('onnxruntime-node');
  const s = await getSession();
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', chw, [1, 3, IN_H, IN_W]) });
  const scores = out.scores.data as Float32Array;
  const boxes = out.boxes.data as Float32Array;
  const cand: Face[] = [];
  for (let i = 0; i < scores.length / 2; i++) {
    const sc = scores[i * 2 + 1];
    if (sc < minScore) continue;
    // 出力は 640x480 の中の 0〜1。余白を引いて元の写真の画素に戻す
    const x1 = (boxes[i * 4] * IN_W - padX) / scale;
    const y1 = (boxes[i * 4 + 1] * IN_H - padY) / scale;
    const x2 = (boxes[i * 4 + 2] * IN_W - padX) / scale;
    const y2 = (boxes[i * 4 + 3] * IN_H - padY) / scale;
    const x = Math.max(0, x1);
    const y = Math.max(0, y1);
    const w = Math.min(W, x2) - x;
    const h = Math.min(H, y2) - y;
    if (w > 4 && h > 4) cand.push({ x, y, w, h, score: sc });
  }
  // 重なった枠は、点の高いものだけ残す
  cand.sort((a, b) => b.score - a.score);
  const keep: Face[] = [];
  for (const f of cand) if (keep.every((k) => iou(k, f) < 0.3)) keep.push(f);
  return keep.map((f) => ({ x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h), score: Math.round(f.score * 1000) / 1000 }));
}
