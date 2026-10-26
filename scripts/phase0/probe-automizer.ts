/**
 * Phase 0 検証①②④：pptx-automizer で
 *   ① 見本スライドを複製する（同じ見本を2回使う＋別の見本を1回）
 *   ② 日本語の文字を差し替え、見本の書式（フォント・大きさ・色・太さ）が残るか
 *      強調語 [[語]] だけ別の書式（テーマ色 accent2 の下線＋太字）にできるか
 *   ③ 平行四辺形に切り抜かれた写真を、別の写真に差し替えて形が残るか
 *   ④ テーマ色の参照（schemeClr）が出力に残るか／テーマを差し替えると全体の色が変わるか
 * を確かめる。結果の XML 断面を out/phase0/automizer/evidence.json に書く。
 *
 * 使い方: npx tsx scripts/phase0/probe-automizer.ts <写真1> <写真2>
 */
import { Automizer, ModifyImageHelper, type XmlElement } from 'pptx-automizer';
import JSZip from 'jszip';
import sharp from 'sharp';
import { sanitizePptx } from '../../src/assemble/sanitize.js';
import { checkPptxStructure } from '../../src/check/pptx-structure.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'out/phase0/automizer');
mkdirSync(OUT, { recursive: true });

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

/**
 * 見本の文字の書式（最初の a:rPr）を引き継いで、文言を差し替える。
 * [[語]] の部分だけ、同じ書式に「太字＋accent2 の下線」を足した別の run にする。
 * 書式の値（色名・太さ）はここでは決めず、引数で受ける（本番は設定ファイルから読む）。
 */
function replaceKeepingFormat(text: string, emphasis: { underlineScheme: string; bold: boolean }) {
  return (el: XmlElement) => {
    const doc = el.ownerDocument!;
    const paras = el.getElementsByTagNameNS(A, 'p');
    const p0 = paras.item(0)!;
    const r0 = p0.getElementsByTagNameNS(A, 'r').item(0)!;
    const baseRpr = r0.getElementsByTagNameNS(A, 'rPr').item(0)!;
    const pPr = p0.getElementsByTagNameNS(A, 'pPr').item(0);
    const endRpr = p0.getElementsByTagNameNS(A, 'endParaRPr').item(0);
    const txBody = p0.parentNode!;
    // 見本の段落をすべて消す（ダミー文言を残さない）
    for (const p of Array.from({ length: paras.length }, (_, i) => paras.item(i)!)) txBody.removeChild(p);

    for (const line of text.split('\n')) {
      const p = doc.createElementNS(A, 'a:p');
      if (pPr) p.appendChild(pPr.cloneNode(true));
      for (const [i, part] of line.split(/\[\[|\]\]/).entries()) {
        if (part === '') continue;
        const r = doc.createElementNS(A, 'a:r');
        const rpr = baseRpr.cloneNode(true) as XmlElement;
        if (i % 2 === 1) {
          if (emphasis.bold) rpr.setAttribute('b', '1');
          rpr.setAttribute('u', 'heavy');
          // a:uFill は CT_TextCharacterProperties の順序上、latin/ea の前・solidFill の後に置く
          const uFill = doc.createElementNS(A, 'a:uFill');
          const sf = doc.createElementNS(A, 'a:solidFill');
          const sc = doc.createElementNS(A, 'a:schemeClr');
          sc.setAttribute('val', emphasis.underlineScheme);
          sf.appendChild(sc);
          uFill.appendChild(sf);
          const latin = rpr.getElementsByTagNameNS(A, 'latin').item(0);
          rpr.insertBefore(uFill, latin);
        }
        r.appendChild(rpr);
        const t = doc.createElementNS(A, 'a:t');
        t.textContent = part;
        r.appendChild(t);
        p.appendChild(r);
      }
      if (endRpr) p.appendChild(endRpr.cloneNode(true));
      txBody.appendChild(p);
    }
  };
}

async function build(photo1: string, photo2: string, outName: string) {
  const automizer = new Automizer({
    templateDir: path.join(ROOT, 'templates/probe'),
    outputDir: OUT,
    removeExistingSlides: true,
    autoImportSlideMasters: false,
    cleanup: process.env.PROBE_CLEANUP !== '0',
    compression: 6,
    verbosity: 1,
  });
  const pres = automizer
    .loadRoot('probe.pptx')
    .load('probe.pptx', 'tpl')
    .loadMedia([path.basename(photo1), path.basename(photo2)], path.dirname(photo1));

  const emphasis = { underlineScheme: 'accent2', bold: true };

  pres.addSlide('tpl', 1, (slide) => {
    slide.modifyElement('txt.headline', replaceKeepingFormat('経営の現場で、こんな[[限界]]を感じていませんか？', emphasis));
    slide.modifyElement('txt.item.1', replaceKeepingFormat('社長が現場から\n離れられない', emphasis));
    slide.modifyElement('txt.item.2', replaceKeepingFormat('人件費が厳しい', emphasis));
    slide.modifyElement('txt.body', replaceKeepingFormat('業務が属人化しており、自分がいないと回らない。採用コストも教育コストも高騰している。', emphasis));
    slide.modifyElement('num.rate', replaceKeepingFormat('70', emphasis));
    slide.modifyElement('img.hero', [ModifyImageHelper.setRelationTarget(path.basename(photo1))]);
  });
  pres.addSlide('tpl', 1, (slide) => {
    slide.modifyElement('txt.headline', replaceKeepingFormat('同じ見本の2枚目（複製の確認）', emphasis));
    slide.modifyElement('txt.item.1', replaceKeepingFormat('開発費が高すぎる', emphasis));
    slide.modifyElement('txt.item.2', replaceKeepingFormat('補助金は[[難しそう]]', emphasis));
    slide.modifyElement('txt.body', replaceKeepingFormat('見積もりを取ったら数百万〜数千万と言われた。', emphasis));
    slide.modifyElement('num.rate', replaceKeepingFormat('2/3', emphasis));
    slide.modifyElement('img.hero', [ModifyImageHelper.setRelationTarget(path.basename(photo2))]);
  });
  pres.addSlide('tpl', 2, (slide) => {
    slide.modifyElement('txt.headline', replaceKeepingFormat('制度の核心', emphasis));
  });
  await pres.write(outName);
  return path.join(OUT, outName);
}

/** 出力 .pptx の中身を読み、確かめたい点を機械で数える。 */
async function inspect(file: string) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const names = Object.keys(zip.files);
  const slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort();
  const result: Record<string, unknown> = { file: path.relative(ROOT, file), slides: slides.length };
  const perSlide = [];
  for (const s of slides) {
    const xml = await zip.file(s)!.async('string');
    const rels = await zip.file(s.replace('slides/', 'slides/_rels/') + '.rels')?.async('string');
    perSlide.push({
      slide: s,
      dummyLeft: /ダミー/.test(xml),
      srgbClr: (xml.match(/<a:srgbClr/g) ?? []).length,
      schemeClr: [...new Set((xml.match(/<a:schemeClr val="[^"]+"/g) ?? []).map((m) => m.split('"')[1]))],
      parallelogramPictures: (xml.match(/<p:pic>[\s\S]*?<\/p:pic>/g) ?? []).filter((p) => /prst="parallelogram"/.test(p)).length,
      srcRect: (xml.match(/<a:srcRect[^>]*\/>/g) ?? []),
      emphasisRuns: (xml.match(/u="heavy"/g) ?? []).length,
      fontsInRuns: [...new Set((xml.match(/<a:(?:latin|ea) typeface="[^"]+"/g) ?? []).map((m) => m.split('"')[1]))],
      sizes: [...new Set((xml.match(/ sz="\d+"/g) ?? []).map((m) => Number(m.split('"')[1]) / 100))],
      imageTargets: (rels?.match(/Target="\.\.\/media\/[^"]+"/g) ?? []),
      shapeNames: (xml.match(/<p:cNvPr id="\d+" name="[^"]+"/g) ?? []).map((m) => m.split('name="')[1].slice(0, -1)),
    });
  }
  result.perSlide = perSlide;
  result.media = names.filter((n) => n.startsWith('ppt/media/'));
  result.notes = names.filter((n) => /notesSlide\d+\.xml$/.test(n)).length;
  return result;
}

/** テーマ色だけを差し替えた写しを作る（Phase 5 の配色差し替えの先取り確認）。 */
async function retheme(file: string, map: Record<string, string>, outName: string) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  for (const n of Object.keys(zip.files).filter((n) => /^ppt\/theme\/theme\d+\.xml$/.test(n))) {
    let xml = await zip.file(n)!.async('string');
    for (const [slot, hex] of Object.entries(map)) {
      xml = xml.replace(new RegExp(`(<a:${slot}>\\s*<a:srgbClr val=")[0-9A-Fa-f]{6}`), `$1${hex}`);
    }
    zip.file(n, xml);
  }
  const out = path.join(OUT, outName);
  writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return out;
}

/** テンプレートの写真枠の縦横比を読む（本番では型カタログが持つ値）。 */
async function frameAspect(templateFile: string, slideNo: number, shapeName: string) {
  const zip = await JSZip.loadAsync(readFileSync(templateFile));
  const xml = await zip.file(`ppt/slides/slide${slideNo}.xml`)!.async('string');
  const pic = (xml.match(/<p:pic>[\s\S]*?<\/p:pic>/g) ?? []).find((p) => p.includes(`name="${shapeName}"`))!;
  const [, cx, cy] = pic.match(/<a:ext cx="(\d+)" cy="(\d+)"/)!;
  return Number(cx) / Number(cy);
}

/**
 * C段の先取り：枠の縦横比に中央で切り抜き、モノクロにする。
 * automizer の setRelationTargetCover は 0.9.4 で失敗した（D-003）ので、切り抜きは sharp で先に済ませる。
 */
async function preparePhoto(src: string, aspect: number, outDir: string) {
  mkdirSync(outDir, { recursive: true });
  const meta = await sharp(src).metadata();
  const w = meta.width!, h = meta.height!;
  const [cw, ch] = w / h > aspect ? [Math.round(h * aspect), h] : [w, Math.round(w / aspect)];
  const out = path.join(outDir, path.basename(src, path.extname(src)) + '.jpg');
  await sharp(src)
    .extract({ left: Math.round((w - cw) / 2), top: Math.round((h - ch) / 2), width: cw, height: ch })
    .grayscale()
    .jpeg({ quality: 85 })
    .toFile(out);
  return out;
}

const args = process.argv.slice(2);
if (args.length < 2) throw new Error('写真を2枚渡してください');
const aspect = await frameAspect(path.join(ROOT, 'templates/probe/probe.pptx'), 1, 'img.hero');
const photos = await Promise.all(args.map((a) => preparePhoto(a, aspect, path.join(OUT, 'photos'))));
const raw = await build(photos[0], photos[1], 'probe-out.raw.pptx');
const rawIssues = await checkPptxStructure(readFileSync(raw));
const { buffer, removed } = await sanitizePptx(readFileSync(raw));
const final = path.join(OUT, 'probe-out.pptx');
writeFileSync(final, buffer);
const finalIssues = await checkPptxStructure(buffer);
const evidence = await inspect(final);
const green = await retheme(final, { accent1: '1E8A4C', accent2: 'F2A33A' }, 'probe-out-green.pptx');
writeFileSync(
  path.join(OUT, 'evidence.json'),
  JSON.stringify({ frameAspect: aspect, photos: photos.map((p) => path.relative(ROOT, p)), raw: { file: path.relative(ROOT, raw), issues: rawIssues }, sanitize: { removed }, final: { issues: finalIssues, ...evidence }, green: path.relative(ROOT, green) }, null, 2),
);
console.log(JSON.stringify({ rawIssues: rawIssues.length, removed, finalIssues }, null, 2));
if (finalIssues.length) process.exitCode = 1;
