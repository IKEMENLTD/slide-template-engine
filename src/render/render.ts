/**
 * 描画（REQUIREMENTS 7章E・12章）：.pptx を LibreOffice で PDF にし、pdftoppm でページごとの PNG にする。
 * Docker のイメージ（docker/render。LibreOffice＋fonts/ の静的フォント＋poppler）の中で1回で行い、
 * 結果は tar にして標準出力で受け取る（検証機の docker は Windows 側のもので、WSL のパスを bind できない。D-011）。
 * あわせて PDF に入ったフォント（pdffonts）を受け取り、テンプレートの字体が代わりの字体で描かれていないかを確かめる。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { issue, type Issue } from '../check/content.js';

export const RENDER_IMAGE = process.env.SLIDEGEN_RENDER_IMAGE ?? 'slidegen-render:phase0';

export type RenderResult = {
  pdf: string;
  pages: string[];
  /** soffice --version */
  engine: string;
  /** PDF に入ったフォントの名前（サブセットの接頭辞は外す） */
  fonts: string[];
  ms: number;
};

/** tar（ustar）を読む。ファイル名 → 中身 */
export function untar(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, n: number) => h.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
    const name = (str(345, 155) ? `${str(345, 155)}/` : '') + str(0, 100);
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    off += 512;
    if (type === '0' || type === '\0') out.set(name.replace(/^\.\//, ''), Buffer.from(buf.subarray(off, off + size)));
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

const SCRIPT = (dpi: number) =>
  [
    'set -e',
    'mkdir -p /work/out',
    'cat > /work/in.pptx',
    'HOME=/tmp soffice --headless --convert-to pdf --outdir /work /work/in.pptx > /work/log 2>&1 || true',
    '[ -f /work/in.pdf ] || { cat /work/log >&2; exit 3; }',
    'cp /work/in.pdf /work/out/deck.pdf',
    `pdftoppm -r ${dpi} -png /work/in.pdf /work/out/page`,
    'pdffonts /work/in.pdf > /work/out/fonts.txt',
    'HOME=/tmp soffice --version > /work/out/version.txt 2>/dev/null || true',
    'cd /work/out && tar -cf - .',
  ].join(' && ');

export function renderDeck(pptx: Buffer, outDir: string, opts: { dpi?: number; image?: string } = {}): Promise<RenderResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['run', '-i', '--rm', opts.image ?? RENDER_IMAGE, 'sh', '-c', SCRIPT(opts.dpi ?? 96)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    const timer = setTimeout(() => child.kill('SIGKILL'), 600_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`描画に失敗した（終了 ${code}）: ${err.slice(0, 500)}`));
      const files = untar(Buffer.concat(chunks));
      const pdf = files.get('deck.pdf');
      if (!pdf || !pdf.subarray(0, 4).equals(Buffer.from('%PDF'))) return reject(new Error('描画の結果に PDF が無い'));
      mkdirSync(path.join(outDir, 'pages'), { recursive: true });
      writeFileSync(path.join(outDir, 'deck.pdf'), pdf);
      // pdftoppm は桁数をページ数に合わせて付ける（page-01.png / page-1.png）。番号で並べ直して 01.png にする
      const pngs = [...files.keys()]
        .filter((f) => /^page-\d+\.png$/.test(f))
        .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
      const pages = pngs.map((f, i) => {
        const p = path.join(outDir, 'pages', `${String(i + 1).padStart(2, '0')}.png`);
        writeFileSync(p, files.get(f)!);
        return p;
      });
      const fonts = [
        ...new Set(
          (files.get('fonts.txt')?.toString('utf8') ?? '')
            .split('\n')
            .slice(2)
            .map((l) => l.split(/\s+/)[0])
            .filter(Boolean)
            .map((n) => n.replace(/^[A-Z]{6}\+/, ''))
        ),
      ].sort();
      resolve({ pdf: path.join(outDir, 'deck.pdf'), pages, engine: (files.get('version.txt')?.toString('utf8') ?? '').trim(), fonts, ms: Date.now() - started });
    });
    child.stdin.end(pptx);
  });
}

/** テンプレートの字体の代わりに使われたらしいフォント（Docker のイメージに入っている代わりの字体） */
export const FALLBACK_FONTS = /^DejaVu/i;

/** 描画の結果の検査：代わりの字体で描かれた・ページ数が設計図と違う */
export function renderIssues(r: Pick<RenderResult, 'fonts' | 'pages'>, slides: number): Issue[] {
  const out: Issue[] = [];
  const fallback = r.fonts.filter((f) => FALLBACK_FONTS.test(f));
  if (fallback.length) out.push(issue('PPTX_REPAIR', `描画でテンプレートの字体が見つからず、代わりの字体 ${fallback.join(', ')} で描かれた（fonts/ と設定を確かめる）`));
  if (r.pages.length !== slides) out.push(issue('SLIDE_COUNT', `描画したページが ${r.pages.length} 枚（設計図は ${slides} 枚）`));
  return out;
}
