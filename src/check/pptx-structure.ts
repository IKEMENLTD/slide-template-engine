/**
 * PPTX_REPAIR の構造検査（11章）。
 * PowerPoint が「修復」を出す典型の原因を、パッケージの中身から機械で数える。
 * これを通っても PowerPoint で開ける保証にはならない（最終確認は人が PowerPoint で行う）。
 */
import JSZip from 'jszip';
import path from 'node:path/posix';

export type StructureIssue = { code: string; part: string; detail: string };

const relsOf = (part: string) => path.join(path.dirname(part), '_rels', path.basename(part) + '.rels');

function relTargets(xml: string) {
  return [...xml.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => {
    const attr = (n: string) => m[1].match(new RegExp(`${n}="([^"]*)"`))?.[1] ?? '';
    return { id: attr('Id'), type: attr('Type'), target: attr('Target'), external: attr('TargetMode') === 'External' };
  });
}

export type Rel = { id: string; type: string; target: string };

/** 部品ごとの rels（外部リンクを除き、target はパッケージ内の絶対パスにそろえる）。キー '' はルート。 */
export async function relGraph(zip: JSZip, parts: Set<string>): Promise<Map<string, Rel[]>> {
  const g = new Map<string, Rel[]>();
  for (const r of [...parts].filter((p) => p.endsWith('.rels'))) {
    const owner = r === '_rels/.rels' ? '' : path.join(path.dirname(path.dirname(r)), path.basename(r, '.rels'));
    const base = owner === '' ? '' : path.dirname(owner);
    const xml = await zip.file(r)!.async('string');
    g.set(owner, relTargets(xml).filter((x) => !x.external).map((x) => ({
      id: x.id, type: x.type,
      target: x.target.startsWith('/') ? x.target.slice(1) : path.normalize(path.join(base, x.target)),
    })));
  }
  return g;
}

export function reachable(graph: Map<string, Rel[]>, parts: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = (graph.get('') ?? []).map((r) => r.target);
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p) || !parts.has(p)) continue;
    seen.add(p);
    for (const r of graph.get(p) ?? []) stack.push(r.target);
  }
  return seen;
}

export async function checkPptxStructure(buf: Buffer | Uint8Array): Promise<StructureIssue[]> {
  const zip = await JSZip.loadAsync(buf);
  const parts = new Set(Object.keys(zip.files).filter((n) => !zip.files[n].dir));
  const issues: StructureIssue[] = [];
  const ct = await zip.file('[Content_Types].xml')!.async('string');
  const overrides = new Set([...ct.matchAll(/PartName="\/([^"]+)"/g)].map((m) => m[1]));
  const defaults = new Set([...ct.matchAll(/Default Extension="([^"]+)"/g)].map((m) => m[1].toLowerCase()));

  // 1. 中身の無い Override／種類の分からない部品
  for (const o of overrides) if (!parts.has(o)) issues.push({ code: 'CT_OVERRIDE_MISSING_PART', part: o, detail: 'Content_Types に登録があるのに部品が無い' });
  for (const p of parts) {
    if (p === '[Content_Types].xml' || p.endsWith('.rels')) continue;
    const ext = p.split('.').pop()!.toLowerCase();
    if (!overrides.has(p) && !defaults.has(ext)) issues.push({ code: 'CT_UNKNOWN_PART', part: p, detail: `拡張子 ${ext} の種類が未登録` });
  }

  // 2. 参照先の無い関係（rels）
  const graph = await relGraph(zip, parts);
  for (const [owner, rels] of graph) {
    const relsPart = owner === '' ? '_rels/.rels' : relsOf(owner);
    if (owner && !parts.has(owner)) {
      issues.push({ code: 'RELS_WITHOUT_OWNER', part: relsPart, detail: `${owner} が無い` });
      continue;
    }
    for (const rel of rels) if (!parts.has(rel.target)) issues.push({ code: 'REL_TARGET_MISSING', part: relsPart, detail: `${rel.id} → ${rel.target}` });
    // 本文の r:id / r:embed が rels に存在するか
    if (owner.endsWith('.xml')) {
      const body = await zip.file(owner)!.async('string');
      const ids = new Set(rels.map((x) => x.id));
      for (const m of body.matchAll(/r:(?:id|embed|link|pict)="([^"]+)"/g)) {
        if (!ids.has(m[1])) issues.push({ code: 'REL_ID_UNDEFINED', part: owner, detail: m[1] });
      }
    }
  }
  // 孤立部品＝パッケージのルートからたどり着けない部品（互いに参照し合う輪も孤立とみなす）
  const reach = reachable(graph, parts);
  for (const p of parts) {
    if (p === '[Content_Types].xml' || p.endsWith('.rels')) continue;
    if (!reach.has(p)) issues.push({ code: 'ORPHAN_PART', part: p, detail: 'ルートからたどり着けない' });
  }

  // 3. スライドの中で図形IDが重複していないか／スライドIDが重複していないか
  for (const s of [...parts].filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))) {
    const xml = await zip.file(s)!.async('string');
    const ids = [...xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)].map((m) => m[1]);
    const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
    if (dup.length) issues.push({ code: 'SHAPE_ID_DUPLICATE', part: s, detail: [...new Set(dup)].join(',') });
  }
  const pres = await zip.file('ppt/presentation.xml')!.async('string');
  const sldIds = [...pres.matchAll(/<p:sldId\b[^>]*\bid="(\d+)"/g)].map((m) => m[1]);
  if (new Set(sldIds).size !== sldIds.length) issues.push({ code: 'SLIDE_ID_DUPLICATE', part: 'ppt/presentation.xml', detail: sldIds.join(',') });

  return issues;
}
