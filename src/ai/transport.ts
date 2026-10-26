/**
 * AI を呼ぶ口（REQUIREMENTS 9章）。段（A・B）はこの形だけを知る。
 *
 * - anthropic：本番。@anthropic-ai/sdk をストリーミングで呼ぶ（model-failover.ts。9-1）。
 *   材料は system 側の cache_control ブロックに置き、段ごとの指示を最後に置く（9-6）。
 * - claude-cli：検証用。Claude Code の `claude -p` を子プロセスで呼ぶ。この案件用の API の鍵が
 *   無い間に、段の作りと検査を実物の AI で通すために使う（D-019）。出力上限は環境変数で渡す。
 * - 試験では、決まった応答を返す偽物（test/ の中）を使う。
 */
import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMessageWithFailover, type AiUsage, type UsageSink } from './model-failover.js';
import { getModelApiId } from './models.js';
import { buildCallOptions } from './time-budget.js';

export type SystemBlock = { text: string; cache: boolean };

export type CompleteRequest = {
  /** 何の段の呼び出しか（使用量の記録に使う） */
  feature: string;
  modelId: string;
  /** 材料（cache: true）→ 段ごとの指示（cache: false）の順に並べる */
  system: SystemBlock[];
  user: string;
  maxTokens: number;
  /** この呼び出しに使える壁時計の残り（ms） */
  remainingMs: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 見せる画像（PNG のパス）。user の文より前に置く */
  images?: string[];
};

export type CompleteResult = {
  text: string;
  /** end_turn / max_tokens / refusal など */
  stopReason: string;
  model: string;
  usage: AiUsage;
  ms: number;
};

export interface AiTransport {
  readonly name: string;
  complete(req: CompleteRequest): Promise<CompleteResult>;
}

export type AnthropicTransportOptions = {
  /** 安全の判定で断られたとき、サーバー側で別のモデルにやり直させる（server-side fallback） */
  refusalFallback: boolean;
};

export class AnthropicTransport implements AiTransport {
  readonly name = 'anthropic';
  private client: Anthropic;
  constructor(private opts: AnthropicTransportOptions, client?: Anthropic) {
    // 鍵は環境変数（ANTHROPIC_API_KEY）か `ant auth login` のプロファイルから SDK が読む。コードに持たない
    this.client = client ?? new Anthropic();
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const started = Date.now();
    let usage: AiUsage | undefined;
    const sink: UsageSink = (u) => (usage = u);
    const inputChars = req.system.reduce((n, b) => n + b.text.length, 0) + req.user.length;
    const params = {
      model: getModelApiId(req.modelId),
      max_tokens: req.maxTokens,
      system: req.system.map((b) => (b.cache ? { type: 'text' as const, text: b.text, cache_control: { type: 'ephemeral' as const } } : { type: 'text' as const, text: b.text })),
      messages: [
        {
          role: 'user' as const,
          content: req.images?.length
            ? [
                ...req.images.map((f) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: readFileSync(f).toString('base64') } })),
                { type: 'text' as const, text: req.user },
              ]
            : req.user,
        },
      ],
      ...(req.effort ? { output_config: { effort: req.effort } } : {}),
      // 型に無い欄は SDK がそのまま送る。ヘッダーと対で付ける（片方だけだと 400）
      ...(this.opts.refusalFallback ? { fallbacks: 'default' } : {}),
    } as unknown as Anthropic.MessageCreateParamsNonStreaming;
    const call = buildCallOptions({ modelId: req.modelId, maxTokens: req.maxTokens, inputChars, remainingMs: req.remainingMs });
    const options: Anthropic.RequestOptions = {
      timeout: call.timeout,
      signal: call.signal,
      ...(this.opts.refusalFallback ? { headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } } : {}),
    };
    const msg = await createMessageWithFailover(this.client, params, req.feature, options, sink);
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return {
      text,
      stopReason: String(msg.stop_reason),
      model: msg.model,
      usage: usage ?? { feature: req.feature, model: msg.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheDeclared: false, cacheHit: false, cacheIneffective: false },
      ms: Date.now() - started,
    };
  }
}

/** claude -p の出力（--output-format json）のうち使う欄 */
type CliOutput = {
  result?: string;
  stop_reason?: string;
  is_error?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, unknown>;
};

export class ClaudeCliTransport implements AiTransport {
  readonly name = 'claude-cli';
  constructor(private bin = 'claude') {}

  complete(req: CompleteRequest): Promise<CompleteResult> {
    const started = Date.now();
    // 作業場所をリポジトリの外にする（CLAUDE.md などを読み込ませない）。画像を見せるときは、その呼び出しだけの場所に写す
    const base = path.join(os.tmpdir(), 'slidegen-claude-cli');
    mkdirSync(base, { recursive: true });
    const cwd = req.images?.length ? mkdtempSync(path.join(base, 'img-')) : base;
    const names = (req.images ?? []).map((f, i) => {
      const n = `image-${String(i + 1).padStart(2, '0')}.png`;
      copyFileSync(f, path.join(cwd, n));
      return n;
    });
    const user = names.length ? `次の画像ファイルを Read で開いて見てから答えてください（この順に1枚目、2枚目…）: ${names.join(', ')}\n\n${req.user}` : req.user;
    const system = req.system.map((b) => b.text).join('\n\n');
    const args = [
      '-p', '--output-format', 'json', '--model', getModelApiId(req.modelId),
      '--system-prompt', system, '--tools', names.length ? 'Read' : '', ...(names.length ? ['--allowedTools', 'Read'] : []),
      '--setting-sources', '', '--no-session-persistence',
      '--disable-slash-commands', '--strict-mcp-config',
      ...(req.effort ? ['--effort', req.effort] : []),
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        cwd,
        env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(req.maxTokens) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), Math.max(1000, req.remainingMs));
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (cwd !== base) rmSync(cwd, { recursive: true, force: true });
        let parsed: CliOutput;
        try {
          parsed = JSON.parse(out) as CliOutput;
        } catch {
          return reject(new Error(`claude -p の出力を読めない（終了 ${code ?? signal}）: ${(err || out).slice(0, 300)}`));
        }
        if (parsed.is_error && parsed.stop_reason !== 'max_tokens') return reject(new Error(`claude -p が失敗した: ${String(parsed.result).slice(0, 300)}`));
        const u = parsed.usage ?? {};
        const model = Object.keys(parsed.modelUsage ?? {})[0] ?? req.modelId;
        const cacheReadTokens = u.cache_read_input_tokens ?? 0;
        const cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
        resolve({
          text: parsed.result ?? '',
          stopReason: parsed.stop_reason ?? 'unknown',
          model,
          usage: {
            feature: req.feature,
            model,
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens,
            cacheWriteTokens,
            // claude -p では cache_control を指定できない（Claude Code が自分で付ける）
            cacheDeclared: false,
            cacheHit: cacheReadTokens > 0,
            cacheIneffective: false,
          },
          ms: Date.now() - started,
        });
      });
      child.stdin.end(user);
    });
  }
}
