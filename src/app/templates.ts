/**
 * 選べるテンプレート（templates/*.pptx のうち設定ファイルがあるもの）と、型の見本の画像。
 * 見本の画像はテンプレートそのものを1回描画して作り、テンプレートの中身（sha256）ごとに残す。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildCatalog, type Catalog } from '../catalog/build-catalog.js';
import { configExists, configPathFor, loadConfig, type TemplateConfig } from '../catalog/config.js';
import { readTemplate } from '../catalog/read-template.js';
import { renderDeck } from '../render/render.js';
import { CACHE, ROOT } from './settings.js';

export const TEMPLATES = path.resolve(process.env.SLIDEGEN_TEMPLATES ?? path.join(ROOT, 'templates'));

export type TemplateEntry = {
  id: string;
  name: string;
  file: string;
  sha256: string;
  catalog: Catalog;
  cfg: TemplateConfig;
  /** 見本の画像（型の slideNumber 番目）。まだ描画していなければ null */
  thumbs: string[] | null;
};

const cache = new Map<string, TemplateEntry>();
const rendering = new Map<string, Promise<void>>();

/** 表示名（templates/labels.json があればそこから） */
function labels(): Record<string, string> {
  const f = path.join(TEMPLATES, 'labels.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Record<string, string>) : {};
}

const thumbDir = (sha: string) => path.join(CACHE, 'templates', sha.slice(0, 16));

async function load(file: string): Promise<TemplateEntry> {
  const buf = readFileSync(file);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const id = path.basename(file, '.pptx');
  const hit = cache.get(id);
  if (hit && hit.sha256 === sha256) return hit;
  const cfg = loadConfig(configPathFor(file));
  const { catalog } = buildCatalog(await readTemplate(buf), cfg, {
    file: path.relative(ROOT, file),
    sha256,
    resolveFile: (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p)),
  });
  const pagesDir = path.join(thumbDir(sha256), 'pages');
  const thumbs = existsSync(pagesDir) ? readdirSync(pagesDir).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(pagesDir, f)) : null;
  const entry: TemplateEntry = { id, name: labels()[id] ?? id, file, sha256, catalog, cfg, thumbs: thumbs?.length ? thumbs : null };
  cache.set(id, entry);
  return entry;
}

export async function listTemplates(): Promise<TemplateEntry[]> {
  if (!existsSync(TEMPLATES)) return [];
  const files = readdirSync(TEMPLATES)
    .filter((f) => f.endsWith('.pptx') && configExists(configPathFor(path.join(TEMPLATES, f))))
    .sort();
  // 並びは labels.json に書いた順（書いていないものは後ろに名前の順）
  const order = Object.keys(labels());
  const rank = (f: string) => (order.indexOf(path.basename(f, '.pptx')) + order.length + 1) % (order.length + 1);
  files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return Promise.all(files.map((f) => load(path.join(TEMPLATES, f))));
}

export async function getTemplate(id: string): Promise<TemplateEntry> {
  if (!/^[\w.-]+$/.test(id)) throw new Error('テンプレートの名前が正しくない');
  const file = path.join(TEMPLATES, `${id}.pptx`);
  if (!existsSync(file)) throw new Error(`テンプレート ${id} が無い`);
  return load(file);
}

/** 見本の画像を作る（まだなら）。何度呼んでも描画は1回 */
export function ensureThumbs(t: TemplateEntry): Promise<void> {
  if (t.thumbs) return Promise.resolve();
  const running = rendering.get(t.sha256);
  if (running) return running;
  const p = (async () => {
    const dir = thumbDir(t.sha256);
    mkdirSync(dir, { recursive: true });
    const r = await renderDeck(readFileSync(t.file), dir, { dpi: 60 });
    writeFileSync(path.join(dir, 'render.json'), JSON.stringify({ engine: r.engine, pages: r.pages.length }) + '\n');
    t.thumbs = r.pages;
  })().finally(() => rendering.delete(t.sha256));
  rendering.set(t.sha256, p);
  return p;
}

/** 型の見本の画像のパス */
export function typeThumb(t: TemplateEntry, typeKey: string): string | null {
  const type = t.catalog.types.find((x) => x.key === typeKey);
  if (!type || !t.thumbs) return null;
  return t.thumbs[type.slideNumber - 1] ?? null;
}
