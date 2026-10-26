/**
 * 型カタログ（catalog.json）を作る（REQUIREMENTS 6-4）。
 * 欄ごとの最大字数・最大行数は、実フォントの文字幅と、欄の幅・高さ・行間から計算する。
 * 字数の上限はここで1回だけ決め、AI への指示（B段）と検査（OVERFLOW）の両方がこの値を読む（2-3 原則7）。
 */
import { loadFont } from '../fit/measure.js';
import { slotPattern, type TemplateConfig } from './config.js';
import type { RawSlot, RawTemplate, RawType } from './read-template.js';

export type CatalogSlot = {
  name: string;
  kind: RawSlot['kind'];
  box: RawSlot['box'];
  /** txt/num のみ */
  style?: {
    sizePt: number;
    bold: boolean;
    latin: string;
    ea: string;
    /** 文字幅を測るフォントファイル（和文用・英数字用。リポジトリからの相対パス） */
    fontFile: string;
    latinFontFile: string;
    /** 強調語（太字）を測る実フォント（D-009。強調が太字でないなら上と同じ） */
    emphasisFontFile: string;
    emphasisLatinFontFile: string;
    spacingPt: number;
    align: string;
    wrap: boolean;
    /** 文字を並べられる幅（枠の幅から内側の余白を引いたもの。余裕はまだ引いていない） */
    innerWidthPt: number;
    lineHeightPt: number;
    /** 行の高さが固定値か（pt 指定）、推定か */
    lineHeightSource: 'template' | 'estimated';
  };
  maxLines?: number;
  maxCharsPerLine?: number;
  /** 全角で数えた字数の上限（AI に伝える目安。最終判定は実フォントで測る） */
  maxChars?: number;
  /** 英数字だけで書いたときの字数の目安（「0」の幅で数える）。英字の欄・数字の欄向け */
  maxCharsLatin?: number;
  /** 上書きされる前の測定値 */
  measured?: { maxLines: number; maxChars: number };
  override?: { from: string; maxChars?: number; maxLines?: number };
  /** 見本のダミー文言（DUMMY_LEFT の検査用） */
  sample?: string;
  /** img のみ：枠の縦横比と加工 */
  aspect?: number;
  geometry?: string;
  process?: { mono: boolean; multiply: string | null };
};

export type CatalogType = {
  key: string; // 型ID か 型ID/変種
  type: string;
  variant: string | null;
  role: string[];
  label: string;
  slideNumber: number;
  order: number;
  slots: CatalogSlot[];
  decorations: number;
};

export type Catalog = {
  version: 1;
  template: { file: string; sha256: string; slideSize: RawTemplate['slideSize'] };
  theme: RawTemplate['theme'];
  fit: TemplateConfig['fit'];
  emphasis: TemplateConfig['emphasis'];
  roles: string[];
  types: CatalogType[];
};

export type CatalogProblem = { level: 'error' | 'warning'; where: string; message: string };

const globToRe = slotPattern;

function overrideFor(cfg: TemplateConfig, t: CatalogType, slotName: string) {
  // 「型ID/変種」を「型ID」より優先する
  for (const key of [t.key, t.type]) {
    const table = cfg.slots[key];
    if (!table) continue;
    for (const [pat, o] of Object.entries(table)) if (globToRe(pat).test(slotName)) return { from: `${key} › ${pat}`, ...o };
  }
  return undefined;
}

export function buildCatalog(raw: RawTemplate, cfg: TemplateConfig, ctx: { file: string; sha256: string; resolveFile: (p: string) => string }) {
  const problems: CatalogProblem[] = [];
  const types: CatalogType[] = [];
  const seen = new Set<string>();

  const fontFor = (name: string, bold: boolean, where: string) => {
    if (bold && !cfg.fonts[`${name}:bold`] && cfg.fonts[name] && !/bold/i.test(cfg.fonts[name])) {
      // 太字の実フォントが無いと、PowerPoint は太字を合成して幅が広がる（D-006：約0.75%）
      problems.push({ level: 'warning', where, message: `字体「${name}」の太字の実フォントが無いので、通常の太さで測る（実物は少し広がる）` });
    }
    const f = (bold && cfg.fonts[`${name}:bold`]) || cfg.fonts[name];
    if (!f) {
      problems.push({ level: 'error', where, message: `字体「${name}${bold ? '（太字）' : ''}」の実フォントが設定 fonts に無い` });
      return null;
    }
    return f;
  };

  for (const rt of raw.types) {
    const where = `スライド${rt.order}`;
    if (rt.notesError || !rt.meta.type) {
      problems.push({ level: 'error', where, message: rt.notesError ?? 'ノートに type が無い' });
      continue;
    }
    const type = String(rt.meta.type);
    const variant = rt.meta.variant == null ? null : String(rt.meta.variant);
    if (!/^[a-z][a-z0-9-]*$/.test(type)) problems.push({ level: 'error', where, message: `型ID「${type}」は英小文字・数字・ハイフンだけにする` });
    const key = variant ? `${type}/${variant}` : type;
    if (seen.has(key)) problems.push({ level: 'error', where, message: `型「${key}」が重複している` });
    seen.add(key);
    const role = Array.isArray(rt.meta.role) ? rt.meta.role.map(String) : rt.meta.role ? [String(rt.meta.role)] : [];
    if (role.length === 0) problems.push({ level: 'error', where, message: 'role が無い' });

    const t: CatalogType = { key, type, variant, role, label: String(rt.meta.label ?? key), slideNumber: rt.slideNumber, order: rt.order, slots: [], decorations: rt.decorations };
    const names = new Set<string>();
    for (const s of rt.slots) {
      const sw = `${where}（${key}）の ${s.name}`;
      if (names.has(s.name)) problems.push({ level: 'error', where: sw, message: '同じ名前の欄が2つある' });
      names.add(s.name);
      const slot: CatalogSlot = { name: s.name, kind: s.kind, box: s.box };

      if (s.kind === 'img') {
        slot.aspect = Math.round((s.box.w / s.box.h) * 10000) / 10000;
        slot.geometry = s.image?.geometry;
        const proc = cfg.images[s.name];
        if (!proc) problems.push({ level: 'warning', where: sw, message: '設定 images に無い。モノクロ・乗算なしで扱う' });
        slot.process = proc ?? { mono: true, multiply: null };
        t.slots.push(slot);
        continue;
      }

      // 設定 headline.mincho が false なら、大見出しはテーマの本文用の字体（ゴシック）で組む（D段で差し替える。16章 #3）
      const tx = s.text && s.name === 'txt.headline' && !cfg.headline.mincho ? { ...s.text, ea: raw.theme.fonts.minorEa, latin: raw.theme.fonts.minorLatin } : s.text;
      if (!tx) {
        problems.push({ level: 'error', where: sw, message: '文字の欄なのに文字枠が無い' });
        continue;
      }
      if (tx.autofit === 'shrink') problems.push({ level: 'error', where: sw, message: '自動縮小（文字を縮めて収める）が有効。原則4に反するので「自動調整しない」にする' });
      const fontFile = fontFor(tx.ea, tx.bold, sw);
      const latinFontFile = fontFor(tx.latin, tx.bold, sw);
      const emBold = tx.bold || cfg.emphasis.bold;
      const emphasisFontFile = emBold ? fontFor(tx.ea, true, `${sw}（強調）`) : fontFile;
      const emphasisLatinFontFile = emBold ? fontFor(tx.latin, true, `${sw}（強調）`) : latinFontFile;
      if (!fontFile || !latinFontFile || !emphasisFontFile || !emphasisLatinFontFile) continue;

      const lineHeightPt =
        tx.lineSpacing.kind === 'pt' ? tx.lineSpacing.value : tx.lineSpacing.kind === 'pct' ? tx.sizePt * tx.lineSpacing.value * cfg.fit.defaultLineHeight : tx.sizePt * cfg.fit.defaultLineHeight;
      const lineHeightSource = tx.lineSpacing.kind === 'pt' ? 'template' : 'estimated';
      if (lineHeightSource === 'estimated') problems.push({ level: 'warning', where: sw, message: '行間が固定値（pt）ではないので、行数は推定値' });

      const innerW = s.box.w - tx.insetsPt.l - tx.insetsPt.r;
      const innerH = s.box.h - tx.insetsPt.t - tx.insetsPt.b;
      const usableW = innerW * (1 - cfg.fit.slackRatio);
      // 1字の幅：num は英数字（0 の幅）、txt は全角（「国」の幅）で数える
      const width = (file: string, ch: string) => {
        const f = loadFont(ctx.resolveFile(file));
        return (f.layout(ch).advanceWidth * tx.sizePt) / f.unitsPerEm + tx.spacingPt;
      };
      const latinPerLine = Math.max(1, Math.floor(usableW / width(latinFontFile, '0')));
      const measuredLines = Math.max(1, Math.floor((innerH + 0.5) / lineHeightPt));
      const perLine = s.kind === 'num' ? latinPerLine : Math.max(1, Math.floor(usableW / width(fontFile, '国')));
      let maxLines = measuredLines;
      if (s.name === 'txt.headline') maxLines = Math.min(maxLines, cfg.headline.maxLines);
      let maxChars = perLine * maxLines;
      slot.measured = { maxLines: measuredLines, maxChars: perLine * measuredLines };

      const o = overrideFor(cfg, t, s.name);
      if (o) {
        if (o.maxLines) maxLines = o.maxLines;
        maxChars = o.maxChars ?? perLine * maxLines;
        slot.override = o;
      }
      slot.style = {
        sizePt: tx.sizePt, bold: tx.bold, latin: tx.latin, ea: tx.ea, fontFile, latinFontFile, emphasisFontFile, emphasisLatinFontFile,
        spacingPt: tx.spacingPt, align: tx.align, wrap: tx.wrap, innerWidthPt: Math.round(innerW * 100) / 100,
        lineHeightPt: Math.round(lineHeightPt * 100) / 100, lineHeightSource,
      };
      slot.maxLines = maxLines;
      slot.maxCharsPerLine = perLine;
      slot.maxChars = maxChars;
      slot.maxCharsLatin = latinPerLine * maxLines;
      slot.sample = tx.sample;
      t.slots.push(slot);
    }
    if (t.slots.length === 0) problems.push({ level: 'warning', where, message: '名前の付いた欄が1つも無い' });
    if (rt.hardColors) problems.push({ level: 'warning', where, message: `色を直書きしている箇所が ${rt.hardColors} 個ある。テーマ色（配色）を差し替えても、そこだけ色が変わらない` });
    types.push(t);
  }

  // 設定の上書きが、どの欄にも当たらなかったら知らせる（書き間違いに気づくため）
  for (const [key, table] of Object.entries(cfg.slots)) {
    for (const pat of Object.keys(table)) {
      const hit = types.some((t) => (t.key === key || t.type === key) && t.slots.some((s) => globToRe(pat).test(s.name)));
      if (!hit) problems.push({ level: 'error', where: `設定 slots["${key}"]["${pat}"]`, message: 'どの型・欄にも当たらない' });
    }
  }

  const catalog: Catalog = {
    version: 1,
    template: { file: ctx.file, sha256: ctx.sha256, slideSize: raw.slideSize },
    theme: raw.theme,
    fit: cfg.fit,
    emphasis: cfg.emphasis,
    roles: [...new Set(types.flatMap((t) => t.role))].sort(),
    types,
  };
  return { catalog, problems };
}
