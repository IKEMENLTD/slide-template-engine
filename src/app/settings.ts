/**
 * アプリの置き場所と設定（APIの鍵・月の上限）。
 * 鍵は data/settings.json にだけ置く（権限 600）。画面には末尾4文字しか返さない。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicTransport, ClaudeCliTransport, type AiTransport } from '../ai/transport.js';
import { openAiImageGenerator, openAiKey, type ImageGenerator } from '../photos/openai-image.js';
import type { TemplateConfig } from '../catalog/config.js';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const DATA = path.resolve(process.env.SLIDEGEN_DATA ?? path.join(ROOT, 'data'));
export const RUNS = path.join(DATA, 'runs');
export const CACHE = path.join(DATA, 'cache');

/**
 * 開発の間だけの抜け道（SLIDEGEN_DEV_AI=claude-cli）。鍵が無くても、この PC の claude -p で文章を作り、
 * 写真はこの PC の OpenAI の鍵ファイルを使う。先方の環境では設定しない（設定画面の鍵だけを使う）。
 */
export const DEV_AI = process.env.SLIDEGEN_DEV_AI === 'claude-cli';

export type Settings = {
  anthropicKey?: string;
  openaiKey?: string;
  /** 月の上限（ドル）。超えたら新しい作成と AI の直しを止める。0 か未設定なら上限なし */
  monthlyBudgetUsd?: number;
  /** 円の目安を出すときのレート */
  usdJpy: number;
};

const FILE = () => path.join(DATA, 'settings.json');

export function readSettings(): Settings {
  const base: Settings = { usdJpy: 150 };
  if (!existsSync(FILE())) return base;
  return { ...base, ...(JSON.parse(readFileSync(FILE(), 'utf8')) as Partial<Settings>) };
}

export function writeSettings(patch: Partial<Settings>): Settings {
  mkdirSync(DATA, { recursive: true });
  const next = { ...readSettings(), ...patch };
  for (const k of ['anthropicKey', 'openaiKey'] as const) if (next[k] === '') delete next[k];
  const tmp = `${FILE()}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, FILE());
  chmodSync(FILE(), 0o600);
  return next;
}

const mask = (k?: string) => (k ? `…${k.slice(-4)}` : null);

/** 画面に返す設定（鍵そのものは返さない） */
export function publicSettings() {
  const s = readSettings();
  return {
    anthropicKey: mask(s.anthropicKey),
    openaiKey: mask(s.openaiKey),
    monthlyBudgetUsd: s.monthlyBudgetUsd ?? 0,
    usdJpy: s.usdJpy,
    aiReady: Boolean(s.anthropicKey) || DEV_AI,
    imagesReady: Boolean(s.openaiKey) || (DEV_AI && Boolean(openAiKey())),
    devMode: DEV_AI && !s.anthropicKey,
  };
}

export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

/** 文章の AI の口。鍵が無ければ止める（開発の抜け道があればそれを使う） */
export function aiTransport(): AiTransport {
  const s = readSettings();
  if (s.anthropicKey) return new AnthropicTransport({ refusalFallback: true }, new Anthropic({ apiKey: s.anthropicKey }));
  if (DEV_AI) return new ClaudeCliTransport();
  throw new AppError('文章を作る AI（Claude）の鍵がまだ入っていません。「設定」で入れてください。', 409);
}

/** 写真を作る口。鍵が無ければ null（足りない写真はテンプレートの見本のまま） */
export function imageGenerator(cfg: TemplateConfig): ImageGenerator | null {
  const s = readSettings();
  const key = s.openaiKey ?? (DEV_AI ? openAiKey() : null);
  if (!key) return null;
  return openAiImageGenerator({ model: cfg.photos.model, quality: cfg.photos.quality, apiKey: key });
}
