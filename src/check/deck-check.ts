/**
 * 出来上がった PPTX を読み直して検査する（REQUIREMENTS 11章。E段の測定の検査）。
 * 設計図ではなく **ファイルの中身** を測る。組み立てで文言が崩れても見逃さないため。
 * 欄の上限・検査の関数は B段と同じもの（check/slots.ts）を使う（原則7）。
 */
import { DOMParser, type Element } from '@xmldom/xmldom';
import JSZip from 'jszip';
import path from 'node:path/posix';
import type { Catalog } from '../catalog/build-catalog.js';
import type { DeckPlan } from '../plan/schema.js';
import { issue, type Issue } from './content.js';
import { checkPptxStructure } from './pptx-structure.js';
import { checkPage, checkTypeRuns, type SlotCheckContext } from './slots.js';

const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};
const parser = new DOMParser();
const all = (el: Element | ReturnType<DOMParser['parseFromString']>, ns: keyof typeof NS, tag: string) => Array.from(el.getElementsByTagNameNS(NS[ns], tag) as unknown as Iterable<Element>);

/** 図形の文言を、強調の run を [[ ]] に戻して取り出す（下線の付いた run を強調とみなす） */
function shapeText(sp: Element): string {
  const tx = all(sp, 'p', 'txBody')[0];
  if (!tx) return '';
  return all(tx, 'a', 'p')
    .map((p) => {
      let s = '';
      let inEm = false;
      for (const r of all(p, 'a', 'r')) {
        const rpr = all(r, 'a', 'rPr')[0];
        const u = rpr?.getAttribute('u');
        const em = !!u && u !== 'none';
        const t = all(r, 'a', 't').map((x) => x.textContent ?? '').join('');
        if (em && !inEm) s += '[[';
        if (!em && inEm) s += ']]';
        inEm = em;
        s += t;
      }
      if (inEm) s += ']]';
      return s;
    })
    .join('\n');
}

/** スライドごとに、名前の付いた図形の文言を読む */
export async function readDeckTexts(buf: Buffer | Uint8Array): Promise<Array<Record<string, string>>> {
  const zip = await JSZip.loadAsync(buf);
  const pres = parser.parseFromString(await zip.file('ppt/presentation.xml')!.async('string'), 'text/xml');
  const rels = parser.parseFromString(await zip.file('ppt/_rels/presentation.xml.rels')!.async('string'), 'text/xml');
  const target = new Map<string, string>();
  for (const r of Array.from(rels.getElementsByTagName('Relationship') as unknown as Iterable<Element>)) target.set(r.getAttribute('Id')!, path.join('ppt', r.getAttribute('Target')!));
  const out: Array<Record<string, string>> = [];
  for (const sid of all(pres, 'p', 'sldId')) {
    const part = target.get(sid.getAttributeNS(NS.r, 'id')!)!;
    const doc = parser.parseFromString(await zip.file(part)!.async('string'), 'text/xml');
    const texts: Record<string, string> = {};
    for (const sp of all(doc, 'p', 'sp')) {
      const name = all(sp, 'p', 'cNvPr')[0]?.getAttribute('name') ?? '';
      if (/^(txt|num)\./.test(name)) texts[name] = shapeText(sp);
    }
    out.push(texts);
  }
  return out;
}

export async function checkDeck(buf: Buffer, plan: DeckPlan, catalog: Catalog, ctx: SlotCheckContext, maxSameTypeInRow: number, minFaceVisible = 0.75): Promise<Issue[]> {
  const out: Issue[] = [];
  for (const s of await checkPptxStructure(buf)) out.push(issue('PPTX_REPAIR', `${s.code} ${s.part}: ${s.detail}`, {}, `File structure problem: ${s.code} ${s.part}`));
  const slides = await readDeckTexts(buf);
  if (slides.length !== plan.pages.length) out.push(issue('SLIDE_COUNT', `スライドが ${slides.length} 枚（設計図は ${plan.pages.length} 枚）`, {}, `The file has ${slides.length} slides (the plan has ${plan.pages.length})`));
  plan.pages.forEach((p, i) => {
    const t = catalog.types.find((x) => x.key === p.type);
    if (!t || !slides[i]) return;
    out.push(...checkPage(i + 1, t, slides[i], ctx));
    for (const name of p.trimmed) out.push(issue('TRIMMED', `${name} は欄に入らず、最後の手段で丸めた: 「${slides[i][name] ?? ''}」`, { page: i + 1, slot: name }, `${name} did not fit, so it was shortened: "${slides[i][name] ?? ''}"`));
    // 写真の切り抜きで、顔を見えている部分に入れきれなかった欄（C段・仕上げで写真を置いたときに記録）
    for (const [name, fit] of Object.entries(p.photoFit ?? {}))
      if (fit.faceVisible !== null && fit.faceVisible < minFaceVisible && p.photoFiles?.[name])
        out.push(
          issue('FACE_COVERED', `${name}: ${fit.faceVisible < 0.15 ? '人の顔がほとんど図形に隠れている' : `人の顔の約${Math.round((1 - fit.faceVisible) * 10)}割が図形に隠れている`}`, { page: i + 1, slot: name }, `${name}: ${fit.faceVisible < 0.15 ? "a person's face is almost fully covered by a shape" : `about ${Math.round((1 - fit.faceVisible) * 100)}% of a person's face is covered by a shape`}`)
        );
  });
  out.push(...checkTypeRuns(plan.pages.map((p) => p.type), maxSameTypeInRow));
  return out;
}
