/**
 * D段：組み立て（REQUIREMENTS 7章D）。見本スライドを複製し、名前の付いた図形の文字・写真だけを差し替える。
 * 飾りの図形には触らない（左右反転するページは、テンプレートの形をそのまま写す＝D-042）。出力は必ず掃除（sanitize）と構造検査を通す（D-004）。
 */
import JSZip from 'jszip';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Automizer } from 'pptx-automizer';
import type { Catalog } from '../catalog/build-catalog.js';
import type { TemplateConfig } from '../catalog/config.js';
import type { DeckPlan } from '../plan/schema.js';
import { checkPptxStructure, type StructureIssue } from '../check/pptx-structure.js';
import { mirrorPptx } from './mirror.js';
import { replaceImage } from './replace-image.js';
import { replaceText } from './replace-text.js';
import { sanitizePptx } from './sanitize.js';

/**
 * スライドの文字の言語（lang）を替える。altLang（東アジアの字の言語）は残す。
 * keepTracking を渡すと、それ以外の欄の字間（spc）を外す：日本語の見出し用の広い字間は、英語の小文字にかかると
 * 「L a t e  q u a l i t y」と間延びして読みにくい（2026-10-29 英語の見本で確認）。飾りの英字ラベルの字間は残す
 */
export async function setTextLanguage(buf: Buffer, lang: string, opts: { keepTracking?: string[] } = {}): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf);
  for (const name of Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
    let xml = await zip.file(name)!.async('string');
    xml = xml.replace(/(<a:(?:rPr|endParaRPr|defRPr)\b[^>]*?\s)lang="[^"]*"/g, `$1lang="${lang}"`);
    if (opts.keepTracking)
      xml = xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (sp) => {
        const shape = sp.match(/<p:cNvPr\b[^>]*\sname="([^"]*)"/)?.[1] ?? '';
        if (!shape.startsWith('txt.') || opts.keepTracking!.includes(shape)) return sp;
        return sp.replace(/(<a:(?:rPr|endParaRPr|defRPr)\b[^>]*?)\sspc="-?\d+"/g, '$1');
      });
    zip.file(name, xml);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export async function assembleDeck(args: {
  templatePath: string;
  catalog: Catalog;
  cfg: TemplateConfig;
  plan: DeckPlan;
  /** 加工済みの写真の置き場所（plan.pages[].photoFiles はここからの名前） */
  photoDir: string;
  outFile: string;
}): Promise<{ buffer: Buffer; structure: StructureIssue[] }> {
  const { catalog, cfg, plan } = args;
  const workDir = path.join(path.dirname(args.outFile), '.assemble');
  mkdirSync(workDir, { recursive: true });
  const automizer = new Automizer({
    templateDir: path.dirname(args.templatePath),
    outputDir: workDir,
    removeExistingSlides: true,
    autoImportSlideMasters: false,
    cleanup: true,
    compression: 6,
    verbosity: 0,
  });
  const tplName = path.basename(args.templatePath);
  const media = [...new Set(plan.pages.flatMap((p) => Object.values(p.photoFiles ?? {})))];
  let pres = automizer.loadRoot(tplName).load(tplName, 'tpl');
  if (media.length) pres = pres.loadMedia(media, args.photoDir);
  const emphasis = { underline: catalog.emphasis.underline, bold: catalog.emphasis.bold };
  // 大見出しを明朝にしない設定なら、テーマの本文用の字体（+mn）に差し替える（16章 #3）
  const headlineFont = cfg.headline.mincho ? undefined : { ea: '+mn-ea', latin: '+mn-lt' };

  for (const page of plan.pages) {
    const t = catalog.types.find((x) => x.key === page.type);
    if (!t) throw new Error(`設計図の型「${page.type}」がカタログに無い`);
    pres.addSlide('tpl', t.slideNumber, (slide) => {
      for (const s of t.slots) {
        if (s.kind === 'img') {
          const file = page.photoFiles?.[s.name];
          // 写真が無い欄は見本の写真のまま（写真の用意は C段。Phase 3 で必ず埋める）
          if (file) slide.modifyElement(s.name, [replaceImage(file)]);
          continue;
        }
        const text = page.slots[s.name] ?? '';
        slide.modifyElement(s.name, replaceText(text, emphasis, s.name === 'txt.headline' ? headlineFont : undefined));
      }
    });
  }
  const rawName = 'deck.raw.pptx';
  await pres.write(rawName);
  const clean = (await sanitizePptx(readFileSync(path.join(workDir, rawName)))).buffer;
  // 左右反転するページ（D-042）。飾りの図形の位置はテンプレートの形を写すだけで、新しく決めない
  const buffer = await mirrorPptx(clean, plan.pages.flatMap((p, i) => (p.mirrored && cfg.mirror[p.type] ? [{ page: i + 1, fixed: cfg.mirror[p.type].fixed }] : [])));
  // 英語の資料は、文字の言語を英語にする（PowerPoint の校正・字体の選び方が日本語扱いにならないように。D-043）
  const final = plan.language === 'en' ? await setTextLanguage(buffer, 'en-US', { keepTracking: ['txt.eyebrow'] }) : buffer;
  writeFileSync(args.outFile, final);
  rmSync(workDir, { recursive: true, force: true });
  const structure = await checkPptxStructure(final);
  return { buffer: final, structure };
}
