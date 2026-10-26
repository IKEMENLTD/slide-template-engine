/**
 * slidegen の入口（REQUIREMENTS 12章）。
 *   slidegen catalog --template templates/provisional.pptx [--out <catalog.json>] [--config <config.json>]
 *   slidegen build   --template templates/provisional.pptx --input samples/manuscript-01.md [--photos assets/photos] [--out out/] [--slides 10] [--ai anthropic|claude-cli] [--model <id>]
 *   slidegen build   --resume out/<実行ID> [--ai ...]
 *   slidegen check   out/<実行ID>
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as fontkit from 'fontkit';
import { buildCatalog } from './catalog/build-catalog.js';
import { ConfigSchema, configExists, configPathFor, loadConfig, scaffoldConfig } from './catalog/config.js';
import { readTemplate } from './catalog/read-template.js';
import { fitSlot } from './fit/fit-slot.js';
import { AnthropicTransport, ClaudeCliTransport, type AiTransport } from './ai/transport.js';
import { build, recheck } from './run/build.js';
import { openAiImageGenerator, openAiKey, type ImageGenerator } from './photos/openai-image.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function fontFiles() {
  const dir = path.join(ROOT, 'fonts');
  return readdirSync(dir)
    .filter((f) => /\.(otf|ttf)$/i.test(f))
    .map((f) => {
      const font = fontkit.openSync(path.join(dir, f)) as unknown as { familyName: string; subfamilyName: string; name: { records: { preferredFamily?: { en?: string }; preferredSubfamily?: { en?: string } } } };
      const pf = font.name.records.preferredFamily?.en;
      return { file: `fonts/${f}`, legacyFamily: font.familyName, family: pf ?? font.familyName, subfamily: font.name.records.preferredSubfamily?.en ?? font.subfamilyName };
    });
}

async function catalog(args: string[]) {
  const { values } = parseArgs({ args, options: { template: { type: 'string' }, out: { type: 'string' }, config: { type: 'string' } } });
  if (!values.template) throw new Error('--template が要る');
  const tpl = path.resolve(values.template);
  const buf = readFileSync(tpl);
  const raw = await readTemplate(buf);
  const cfgPath = path.resolve(values.config ?? configPathFor(tpl));
  if (!configExists(cfgPath)) {
    const typefaces = raw.types.flatMap((t) => t.slots.flatMap((s) => (s.text ? [{ name: s.text.ea, bold: s.text.bold }, { name: s.text.latin, bold: s.text.bold }] : [])));
    const imageSlots = [...new Set(raw.types.flatMap((t) => t.slots.filter((s) => s.kind === 'img').map((s) => s.name)))].sort();
    const { config, unresolved } = scaffoldConfig({ typefaces, imageSlots, fontFiles: fontFiles() });
    writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n');
    console.log(`設定の雛形を作った: ${path.relative(ROOT, cfgPath)}（中身を確認して直してください）`);
    if (unresolved.length) console.log(`  実フォントが見つからない字体: ${unresolved.join(', ')}`);
  }
  const cfg = loadConfig(cfgPath);
  const { catalog: cat, problems } = buildCatalog(raw, cfg, {
    file: path.relative(ROOT, tpl),
    sha256: createHash('sha256').update(buf).digest('hex'),
    resolveFile: (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p)),
  });
  // 自己点検：テンプレートの見本の文言が、自分の欄に収まるか（収まらないなら欄の作りか測り方がおかしい）
  const resolveFile = (p: string) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
  for (const t of cat.types)
    for (const s of t.slots)
      if (s.style && s.sample) {
        const r = fitSlot(s, s.sample, cat.fit, resolveFile);
        if (!r.ok) problems.push({ level: 'error', where: `${t.key} の ${s.name}`, message: `見本の文言が欄に収まらない：${r.reason}` });
      }
  const out = path.resolve(values.out ?? path.join(ROOT, 'out/catalog', path.basename(tpl).replace(/\.pptx$/i, '.catalog.json')));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(cat, null, 2) + '\n');
  for (const p of problems) console.log(`${p.level === 'error' ? '止める' : '注意'}: ${p.where}: ${p.message}`);
  const errors = problems.filter((p) => p.level === 'error').length;
  console.log(`型 ${cat.types.length}・欄 ${cat.types.reduce((n, t) => n + t.slots.length, 0)}・止める ${errors}・注意 ${problems.length - errors} → ${path.relative(ROOT, out)}`);
  if (errors) process.exitCode = 1;
}

function transportFor(name: string | undefined): AiTransport {
  const n = name ?? process.env.SLIDEGEN_AI ?? 'anthropic';
  if (n === 'anthropic') {
    return new AnthropicTransport({ refusalFallback: true });
  }
  if (n === 'claude-cli') return new ClaudeCliTransport();
  throw new Error(`--ai は anthropic か claude-cli（いま: ${n}）`);
}

/** 写真を生成する口。鍵が無ければ生成しない（警告を出す） */
function imageGenerator(configPath: string | undefined, resume: string | undefined): ImageGenerator | null {
  const key = openAiKey();
  if (!key) {
    console.warn('注意: OPENAI_API_KEY が無いので写真を生成しない（生成を割り当てた欄は見本の写真のまま）');
    return null;
  }
  const cfgFile = resume ? path.join(path.resolve(resume), 'config.json') : configPath && path.resolve(configPath);
  const cfg = cfgFile ? ConfigSchema.parse(JSON.parse(readFileSync(cfgFile, 'utf8'))) : ConfigSchema.parse({});
  return openAiImageGenerator({ model: cfg.photos.model, quality: cfg.photos.quality, apiKey: key });
}

async function buildCmd(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      template: { type: 'string' }, input: { type: 'string' }, photos: { type: 'string' }, 'no-photos': { type: 'boolean' },
      out: { type: 'string' }, config: { type: 'string' }, slides: { type: 'string' }, resume: { type: 'string' },
      ai: { type: 'string' }, model: { type: 'string' }, 'stop-after': { type: 'string' }, 'no-generate': { type: 'boolean' },
    },
  });
  const res = await build({
    root: ROOT,
    outDir: path.resolve(values.out ?? path.join(ROOT, 'out')),
    input: values.input && path.resolve(values.input),
    template: values.template && path.resolve(values.template),
    config: values.config && path.resolve(values.config),
    photos: values['no-photos'] ? null : values.photos && path.resolve(values.photos),
    targetSlides: values.slides ? Number(values.slides) : undefined,
    resume: values.resume,
    transport: transportFor(values.ai),
    model: values.model,
    imageGenerator: values['no-generate'] ? null : imageGenerator(values.config ?? (values.template ? values.template.replace(/\.pptx$/i, '.config.json') : undefined), values.resume),
    stopAfter: values['stop-after'] as never,
  });
  report(res);
}

function report(res: { dir: string; errors: number; warnings: number; stoppedAfter?: string }) {
  if (res.stoppedAfter) return console.log(`${res.stoppedAfter} の段で止めた: ${path.relative(ROOT, res.dir)}`);
  console.log(`止める ${res.errors}・注意 ${res.warnings} → ${path.relative(ROOT, res.dir)}/report.md`);
  if (res.errors) process.exitCode = 1;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'catalog') await catalog(rest);
else if (cmd === 'build') await buildCmd(rest);
else if (cmd === 'check') report(await recheck(rest[0], ROOT));
else {
  console.error('使い方: slidegen catalog|build|check（src/cli.ts の先頭を見る）');
  process.exitCode = 2;
}
