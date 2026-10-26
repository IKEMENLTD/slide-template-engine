/**
 * pptx-automizer の出力を、PowerPoint が「修復」を出さない形に整える（D段の最後に必ず通す）。
 *
 * Phase 0 の実測で、automizer 0.9.4 の出力には次の2つが残ることが分かった（docs/DECISIONS.md D-004）。
 *   - removeExistingSlides で外した見本スライドとそのノートが、部品として残る（ルートから届かない）
 *   - 差し替えた写真の元画像への関係が残る。cleanup:true だと画像だけ消えて関係が宙に浮く
 * さらに、見本スライドのノート（型の情報の YAML）が成果物に写る。
 *
 * ここでは次を行う。どれも「何かを足す」ことはせず、使われていないものを外すだけ。
 *   1. スライドからノートへの関係を外す（型の YAML を成果物に残さない）
 *   2. 本文から使われていない画像の関係を外す
 *   3. ルートから届かない部品と、その rels・Content_Types の登録を消す
 */
import JSZip from 'jszip';
import path from 'node:path/posix';
import { reachable, relGraph } from '../check/pptx-structure.js';

const NOTES = '/relationships/notesSlide';
const IMAGE = '/relationships/image';

const relsOf = (part: string) => path.join(path.dirname(part), '_rels', path.basename(part) + '.rels');

function dropRels(xml: string, drop: (id: string, type: string) => boolean): string {
  return xml.replace(/<Relationship\b[^>]*\/>/g, (m) => {
    const id = m.match(/Id="([^"]*)"/)?.[1] ?? '';
    const type = m.match(/Type="([^"]*)"/)?.[1] ?? '';
    return drop(id, type) ? '' : m;
  });
}

export async function sanitizePptx(buf: Buffer | Uint8Array): Promise<{ buffer: Buffer; removed: string[] }> {
  const zip = await JSZip.loadAsync(buf);
  const removed: string[] = [];
  const files = () => new Set(Object.keys(zip.files).filter((n) => !zip.files[n].dir));

  // 1・2. スライドの rels を整理
  for (const s of [...files()].filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))) {
    const rp = relsOf(s);
    const relsXml = await zip.file(rp)?.async('string');
    if (!relsXml) continue;
    const body = await zip.file(s)!.async('string');
    const used = new Set([...body.matchAll(/r:(?:id|embed|link|pict)="([^"]+)"/g)].map((m) => m[1]));
    const next = dropRels(relsXml, (id, type) => type.endsWith(NOTES) || (type.endsWith(IMAGE) && !used.has(id)));
    if (next !== relsXml) zip.file(rp, next);
  }

  // 3. ルートから届かない部品を消す（消すと届かなくなるものが出るので、変化が無くなるまで繰り返す）
  for (;;) {
    const parts = files();
    const reach = reachable(await relGraph(zip, parts), parts);
    const dead = [...parts].filter((p) => p !== '[Content_Types].xml' && !p.endsWith('.rels') && !reach.has(p));
    // 持ち主のいない rels も消す
    const deadRels = [...parts].filter((p) => p.endsWith('.rels') && p !== '_rels/.rels' && !parts.has(path.join(path.dirname(path.dirname(p)), path.basename(p, '.rels'))));
    if (dead.length === 0 && deadRels.length === 0) break;
    for (const p of dead) {
      zip.remove(p);
      zip.remove(relsOf(p));
      removed.push(p);
    }
    for (const p of deadRels) {
      zip.remove(p);
      removed.push(p);
    }
  }

  // Content_Types から、消した部品の Override を外す
  const ctPath = '[Content_Types].xml';
  const parts = files();
  const ct = await zip.file(ctPath)!.async('string');
  zip.file(ctPath, ct.replace(/<Override\b[^>]*PartName="\/([^"]+)"[^>]*\/>/g, (m, name) => (parts.has(name) ? m : '')));

  // 注意：JSZip の remove(フォルダ) は中身ごと消すので、ディレクトリ項目には触らない

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
  return { buffer, removed };
}
