/**
 * スライド自動生成のアプリ（ブラウザで使う画面）のサーバー。
 *   npm run app        → http://127.0.0.1:8787
 * 画面は web/ を Vite で組んだもの（web/dist）を配る。API は /api/*。
 * SLIDEGEN_PASSWORD を入れると、画面と API にパスワード（Basic 認証）をかける（社外に出すときは必須）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import mammoth from 'mammoth';
import { aiRevise, changeType, checkDraft, ensurePdf, pagesView, replacePhoto, saveText, toggleMirror, typeChoices, undo, versions } from './edit.js';
import { createRun, deleteRun, estimateSeconds, estimateUsd, listRuns, monthCostUsd, recommendedSlides, recoverOnBoot, resumeRun, runDir, runView } from './runs.js';
import { AppError, publicSettings, readSettings, ROOT, writeSettings } from './settings.js';
import { ensureThumbs, getTemplate, listTemplates, typeThumb } from './templates.js';

const app = new Hono();
const WEB = path.join(ROOT, 'web', 'dist');

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? '127.0.0.1';
// この PC の中（127.0.0.1）以外に開くときは、パスワード無しでは起動しない（鍵の設定画面まで誰でも開けてしまうため）
if (!process.env.SLIDEGEN_PASSWORD && !['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
  console.error(`HOST=${hostname} で開くときは SLIDEGEN_PASSWORD が必要です（パスワード無しでは起動しません）`);
  process.exit(1);
}
// 開いてよい宛先（Host）。この PC の名前と、公開するときに SLIDEGEN_HOSTS（カンマ区切り）で足した名前だけ。
// ほかのサイトの画面から、この API を勝手に呼ばせない（DNS リバインディングと、別のサイトからの書き換えを断る）
const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', ...(process.env.SLIDEGEN_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]);
app.use('*', async (c, next) => {
  const host = (c.req.header('host') ?? '').toLowerCase();
  const name = host.replace(/:\d+$/, '');
  if (!allowedHosts.has(name)) return c.json({ error: 'この宛先からは開けません' }, 421);
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const site = c.req.header('sec-fetch-site');
    const origin = c.req.header('origin');
    if (site && site !== 'same-origin' && site !== 'none') return c.json({ error: '別のサイトからの操作は受け付けません' }, 403);
    if (origin && new URL(origin).host.toLowerCase() !== host) return c.json({ error: '別のサイトからの操作は受け付けません' }, 403);
  }
  await next();
});

if (process.env.SLIDEGEN_PASSWORD) {
  app.use('*', basicAuth({ username: process.env.SLIDEGEN_USER ?? 'slidegen', password: process.env.SLIDEGEN_PASSWORD }));
}

app.onError((e, c) => {
  // パスワードの確認で断ったとき（401）は、そのまま返す
  if (e instanceof HTTPException) return e.getResponse();
  if (e instanceof AppError) return c.json({ error: e.message }, e.status as 400);
  console.error(e);
  return c.json({ error: `うまくいきませんでした：${e.message}` }, 500);
});

const num = (c: Context, k: string) => {
  const v = Number(c.req.param(k));
  if (!Number.isInteger(v) || v < 1) throw new AppError('ページの番号が正しくありません');
  return v;
};
const MAX_UPLOAD = 25 * 1024 * 1024;
async function fileBuf(f: unknown): Promise<{ name: string; data: Buffer } | null> {
  if (!(f instanceof File) || !f.size) return null;
  if (f.size > MAX_UPLOAD) throw new AppError('ファイルが大きすぎます（25MB まで）');
  return { name: f.name, data: Buffer.from(await f.arrayBuffer()) };
}

// 読み込む前に大きさで断る（全部を読み込んでから断ると、その間にメモリを使い切る）
const tooLarge = (c: Context) => c.json({ error: 'ファイルが大きすぎます' }, 413);
app.use('/api/runs', bodyLimit({ maxSize: 200 * 1024 * 1024, onError: tooLarge }));
app.use('/api/manuscript', bodyLimit({ maxSize: MAX_UPLOAD + 1024 * 1024, onError: tooLarge }));
app.use('/api/runs/:id/pages/:n/photo', bodyLimit({ maxSize: MAX_UPLOAD + 1024 * 1024, onError: tooLarge }));
const smallBody = bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge });
app.use('/api/*', (c, next) => (/^\/api\/(runs|manuscript|runs\/[^/]+\/pages\/\d+\/photo)$/.test(c.req.path) ? next() : smallBody(c, next)));
const MAX_PHOTOS = 30;

// ---------------------------------------------------------------- 状態・設定

app.get('/api/state', (c) => {
  const s = readSettings();
  return c.json({ settings: publicSettings(), monthCostUsd: monthCostUsd(), usdJpy: s.usdJpy });
});

app.put('/api/settings', async (c) => {
  const b = await c.req.json<{ anthropicKey?: string; openaiKey?: string; monthlyBudgetUsd?: number; clear?: string[] }>();
  const patch: Record<string, unknown> = {};
  if (typeof b.anthropicKey === 'string' && b.anthropicKey.trim()) {
    if (!b.anthropicKey.trim().startsWith('sk-ant-')) throw new AppError('Claude の鍵は「sk-ant-」で始まります。貼り付けた文字を確かめてください');
    patch.anthropicKey = b.anthropicKey.trim();
  }
  if (typeof b.openaiKey === 'string' && b.openaiKey.trim()) {
    if (!b.openaiKey.trim().startsWith('sk-')) throw new AppError('OpenAI の鍵は「sk-」で始まります。貼り付けた文字を確かめてください');
    patch.openaiKey = b.openaiKey.trim();
  }
  if (typeof b.monthlyBudgetUsd === 'number' && b.monthlyBudgetUsd >= 0) patch.monthlyBudgetUsd = b.monthlyBudgetUsd;
  for (const k of b.clear ?? []) if (k === 'anthropicKey' || k === 'openaiKey') patch[k] = '';
  writeSettings(patch);
  return c.json({ settings: publicSettings() });
});

// ---------------------------------------------------------------- テンプレート

app.get('/api/templates', async (c) => {
  const list = await listTemplates();
  for (const t of list) void ensureThumbs(t).catch((e) => console.error(`見本の描画に失敗: ${t.id}`, e));
  return c.json(
    list.map((t) => ({
      id: t.id,
      name: t.name,
      ready: !!t.thumbs,
      cover: t.thumbs ? `/api/templates/${t.id}/types/${encodeURIComponent(t.catalog.types[0].key)}.png` : null,
      minSlides: t.cfg.deck.minSlides,
      maxSlides: t.cfg.deck.maxSlides,
      types: t.catalog.types.map((x) => ({ key: x.key, label: x.label, image: t.thumbs ? `/api/templates/${t.id}/types/${encodeURIComponent(x.key)}.png` : null })),
    }))
  );
});

app.get('/api/templates/:id/types/:key{.+\\.png}', async (c) => {
  const t = await getTemplate(c.req.param('id'));
  const f = typeThumb(t, decodeURIComponent(c.req.param('key').replace(/\.png$/, '')));
  if (!f || !existsSync(f)) return c.notFound();
  return png(c, f);
});

// ---------------------------------------------------------------- 原稿の読み込み・目安

app.post('/api/manuscript', async (c) => {
  const form = await c.req.formData();
  const f = await fileBuf(form.get('file'));
  if (!f) throw new AppError('ファイルを選んでください');
  const ext = path.extname(f.name).toLowerCase();
  let text: string;
  if (ext === '.docx') text = (await mammoth.extractRawText({ buffer: f.data })).value;
  else if (ext === '.md' || ext === '.txt') text = f.data.toString('utf8').replace(/^﻿/, '');
  else throw new AppError('読み込めるのは Word（.docx）・テキスト（.txt）・マークダウン（.md）です');
  text = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return c.json({ text, title: path.basename(f.name, ext) });
});

app.post('/api/estimate', async (c) => {
  const b = await c.req.json<{ text: string; slides: number | null; generatePhotos: boolean }>();
  const rec = recommendedSlides(b.text ?? '');
  const slides = b.slides ?? rec;
  const usd = estimateUsd(slides, b.generatePhotos);
  return c.json({ recommended: rec, slides, seconds: estimateSeconds(slides), usd, jpy: Math.round(usd * readSettings().usdJpy), chars: [...(b.text ?? '').replace(/\s/g, '')].length });
});

// ---------------------------------------------------------------- 資料

app.get('/api/runs', (c) => c.json(listRuns()));

app.post('/api/runs', async (c) => {
  const form = await c.req.formData();
  const photos: Array<{ name: string; data: Buffer; description: string }> = [];
  const files = form.getAll('photos');
  if (files.length > MAX_PHOTOS) throw new AppError(`写真は1回に${MAX_PHOTOS}枚までにしてください`);
  const notes = form.getAll('photoNotes').map(String);
  for (const [i, f] of files.entries()) {
    const b = await fileBuf(f);
    if (b) photos.push({ ...b, description: notes[i] ?? '' });
  }
  const slides = Number(form.get('slides'));
  const id = await createRun({
    title: String(form.get('title') ?? ''),
    manuscript: String(form.get('manuscript') ?? ''),
    template: String(form.get('template') ?? ''),
    targetSlides: Number.isInteger(slides) && slides > 0 ? slides : null,
    generatePhotos: form.get('generatePhotos') === '1',
    photos,
  });
  return c.json({ id });
});

app.get('/api/runs/:id', (c) => c.json(runView(c.req.param('id'))));
app.post('/api/runs/:id/resume', (c) => {
  resumeRun(c.req.param('id'));
  return c.json({ ok: true });
});
app.delete('/api/runs/:id', (c) => {
  deleteRun(c.req.param('id'));
  return c.json({ ok: true });
});
app.get('/api/runs/:id/log', (c) => {
  const f = path.join(runDir(c.req.param('id')), 'log.txt');
  return c.text(existsSync(f) ? readFileSync(f, 'utf8').split('\n').slice(-80).join('\n') : '');
});

// ---------------------------------------------------------------- 仕上げ

app.get('/api/runs/:id/pages', (c) => c.json(pagesView(c.req.param('id'))));
app.get('/api/runs/:id/pages/:n{\\d+\\.png}', (c) => {
  const n = Number(c.req.param('n').replace('.png', ''));
  const f = path.join(runDir(c.req.param('id')), 'pages', `${String(n).padStart(2, '0')}.png`);
  return existsSync(f) ? png(c, f) : c.notFound();
});
app.get('/api/runs/:id/photos/:name', (c) => {
  const name = c.req.param('name');
  if (!/^[\w.-]+\.jpg$/.test(name)) return c.notFound();
  const f = path.join(runDir(c.req.param('id')), 'photos', name);
  if (!existsSync(f)) return c.notFound();
  return c.body(readFileSync(f), 200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' });
});
app.get('/api/runs/:id/pages/:n/types', (c) => c.json(typeChoices(c.req.param('id'), num(c, 'n'))));
app.post('/api/runs/:id/pages/:n/check', async (c) => c.json(checkDraft(c.req.param('id'), num(c, 'n'), (await c.req.json<{ slots: Record<string, string> }>()).slots)));
app.post('/api/runs/:id/pages/:n/text', async (c) => c.json(await saveText(c.req.param('id'), num(c, 'n'), (await c.req.json<{ slots: Record<string, string> }>()).slots)));
app.post('/api/runs/:id/pages/:n/ai', async (c) => c.json(await aiRevise(c.req.param('id'), num(c, 'n'), (await c.req.json<{ instruction: string }>()).instruction ?? '')));
app.post('/api/runs/:id/pages/:n/type', async (c) => c.json(await changeType(c.req.param('id'), num(c, 'n'), (await c.req.json<{ type: string }>()).type)));
app.post('/api/runs/:id/pages/:n/mirror', async (c) => c.json(await toggleMirror(c.req.param('id'), num(c, 'n'))));
app.post('/api/runs/:id/pages/:n/photo', async (c) => {
  const form = await c.req.formData();
  const f = await fileBuf(form.get('file'));
  if (!f) throw new AppError('写真を選んでください');
  return c.json(await replacePhoto(c.req.param('id'), num(c, 'n'), String(form.get('slot') ?? ''), f));
});
app.get('/api/runs/:id/versions', (c) => c.json(versions(c.req.param('id'))));
app.post('/api/runs/:id/undo', async (c) => c.json(await undo(c.req.param('id'))));

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\n\r]+/g, '_').slice(0, 60) || 'slides';
const disposition = (name: string) => `attachment; filename="slides${path.extname(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`;

app.get('/api/runs/:id/download.pptx', (c) => {
  const id = c.req.param('id');
  const v = runView(id);
  const f = path.join(runDir(id), 'deck.pptx');
  if (!existsSync(f)) return c.notFound();
  return c.body(readFileSync(f), 200, { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'content-disposition': disposition(`${safeName(v.title)}.pptx`) });
});
app.get('/api/runs/:id/download.pdf', async (c) => {
  const id = c.req.param('id');
  const v = runView(id);
  const f = await ensurePdf(id);
  return c.body(readFileSync(f), 200, { 'content-type': 'application/pdf', 'content-disposition': disposition(`${safeName(v.title)}.pdf`) });
});

// ---------------------------------------------------------------- 画面

function png(c: Context, f: string) {
  return c.body(readFileSync(f), 200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=31536000, immutable' });
}

const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
app.get('*', (c) => {
  const p = decodeURIComponent(new URL(c.req.url).pathname);
  if (p.startsWith('/api/')) return c.json({ error: 'ありません' }, 404);
  const f = path.join(WEB, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (f.startsWith(WEB) && existsSync(f) && TYPES[path.extname(f)]) return c.body(readFileSync(f), 200, { 'content-type': TYPES[path.extname(f)], 'cache-control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
  const index = path.join(WEB, 'index.html');
  if (!existsSync(index)) return c.text('画面がまだ組まれていません。npm run app:build を実行してください', 500);
  return c.html(readFileSync(index, 'utf8'));
});

recoverOnBoot();
serve({ fetch: app.fetch, port, hostname }, () => console.log(`スライド自動生成: http://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${port}`));
void listTemplates().then((ts) => Promise.all(ts.map((t) => ensureThumbs(t).catch((e) => console.error(`見本の描画に失敗: ${t.id}`, e)))));

export { app };
