/**
 * 白と黒の面積比（11章 LIGHT_DARK_RATIO・ルール 4-6）。描画したページの画像で数える。
 * 「黒」の定義は先方の回答待ち（16章 #4）。明るさの閾値で白と黒に分ける仮の定義を、設定で変えられる形で持つ。
 */
import sharp from 'sharp';
import type { TemplateConfig } from '../catalog/config.js';
import { issue, type Issue } from './content.js';

/** 白÷黒 の比（黒が0なら Infinity） */
export async function lightDarkRatio(png: string, darkBelow: number): Promise<number> {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i] / 255 < darkBelow) dark++;
  const total = data.length / info.channels;
  return dark === 0 ? Infinity : (total - dark) / dark;
}

export async function checkLightDark(pngs: string[], cfg: TemplateConfig['lightDarkRatio']): Promise<Issue[]> {
  if (!cfg.enabled) return [];
  const out: Issue[] = [];
  for (const [i, png] of pngs.entries()) {
    const r = await lightDarkRatio(png, cfg.darkBelow);
    if (Math.abs(r - cfg.target) > cfg.tolerance)
      out.push(issue('LIGHT_DARK_RATIO', `白：黒＝${r === Infinity ? '黒なし' : `${r.toFixed(2)}：1`}（目安 ${cfg.target}±${cfg.tolerance}：1）`, { page: i + 1 }, `White to black = ${r === Infinity ? 'no black' : `${r.toFixed(2)} : 1`} (target ${cfg.target}±${cfg.tolerance} : 1)`));
  }
  return out;
}
