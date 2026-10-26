// ported from IKEMENLTD/airlog@105d8ed src/lib/ai/time-budget.ts
// 変えたところ: import の書き方（NodeEsm）。式と定数は元のまま。
import { getModelById } from './models.js'

/**
 * AI 呼び出しの時間予算を **モデルの関数として導出する** 唯一の場所。
 *
 * 【この module が存在する理由】
 * 2026-07-10〜07-13、 「議事録がタイムアウトする」の修正 commit が 7 本積まれた:
 *   07/10 単一チャンク timeout 45→50s        07/13 map 出力上限 5000→3000
 *   07/10 分割しきい値 60000→12000           07/13 チャンク6000字+出力4000
 *   07/13 maxDuration 60→300 (「根本対策」)   07/13 チャンク4000字+出力5000
 *   07/13 分割しきい値 12000→60000 (07/10 を打ち消し)  07/13 単一出力上限→8192
 * それでも落ち続けた。 理由は「支配変数がモデルのスループットなのに、 コード全体が
 * 単一の定数 (≒130 tok/s = 実際には Haiku の値) で時間を見積もっていた」こと。
 * Haiku と Opus は約 5 倍違うので、 どの定数に合わせても片方が必ず壊れる。 実際、 旧実装の
 * 破綻境界は「高精度 × Opus = 11 分の会議」「高精度 × Sonnet = 21 分」だった。
 *
 * したがって:
 *   - 時間の見積りは必ず estimateCallMs() を通すこと。 定数を直接いじって直そうとしないこと。
 *   - 新しいモデルを足すときは models.ts の outputTokensPerSec を必ず埋めること。
 *
 * 【もう一つの前提: ストリーミング】
 * Anthropic SDK の `timeout` は fetch の解決 (= レスポンスヘッダ到着) までしか計らない
 * (node_modules/@anthropic-ai/sdk/client.js の fetchWithTimeout が finally で clearTimeout)。
 * 非ストリーミングだとヘッダは生成完了まで来ないので `timeout` が生成時間そのものを縛り、
 * 「あと数秒で終わる要約」が毎回 abort されて "Request timed out." になっていた。
 * ストリーミングならヘッダは即座に来るので `timeout` は TTFT だけの予算になる。
 * → model-failover.ts の createMessageWithFailover は必ずストリーミングで呼ぶこと。
 */

/**
 * 日本語 1 文字 ≈ 1 トークン。 transcript-processor.ts の chunkTranscript と同じ保守的前提。
 * 話者ラベル/英数字が混ざると実トークンは下振れするので、 見積りとしては安全側 (過大)。
 */
const CHARS_PER_TOKEN = 1

/** 入力 prefill の保守的な下限スループット (tok/s)。 */
const PREFILL_TOKENS_PER_SEC = 2000

/** TTFT + ネットワーク往復 + JSON パース等の固定オーバーヘッド (ms)。 */
const CALL_OVERHEAD_MS = 5000

/** 見積りの安全係数 (負荷変動の吸収)。 */
const SAFETY_FACTOR = 1.3

/**
 * ストリーミング呼び出しの TTFT (最初のバイトが返るまで) 予算 (ms)。
 * 生成時間は含まない (上記のとおり timeout はヘッダ到着までしか計らないため)。
 * モデルに依らず「詰まっていないか」を見るだけの値なので固定でよい。
 */
export const STREAM_TTFT_TIMEOUT_MS = 60_000

/**
 * maxDuration=60 の route (chat / profile / requirements / landing-page 等) で 1 コールに
 * 許す壁時計の上限 (ms)。
 *
 * ★これが要る理由: ストリーミング化により `timeout` は TTFT しか縛らなくなったため、
 *   `timeout` だけを指定した呼び出しは **生成時間が無制限** になる。 60s の route で
 *   それをやると Vercel の SIGKILL に先を越され、 catch が走らない (失敗記録も返金も通知も
 *   出ない) 。 旧実装の 45s は非ストリーミングゆえに偶然この役割を果たしていたので、
 *   ストリーミング化と同時に `signal` で明示的に張り直す必要がある。
 *   50s = maxDuration(60s) の内側で、 abort 後の catch 処理に 10s 残す。
 */
export const SHORT_ROUTE_WALL_CLOCK_MS = 50_000

/**
 * 「TTFT 予算 + 固定の壁時計上限」の RequestOptions。
 * 単発・対話系 (残り時間の概念が無く、 route の maxDuration だけが制約) 用。
 *
 * @param wallClockMs 総壁時計の上限。 呼び出し元 route の maxDuration より必ず小さくすること
 *                    (SIGKILL より先に abort させ、 catch を走らせるため)。
 * @param ttftMs      TTFT の予算。 ★省略しないほうがよい場面がある: SDK は request options の
 *                    timeout を client の timeout より優先する (messages.js の
 *                    `{ timeout: timeout ?? 600000, ...options }` で ...options が後勝ち)。
 *                    つまりここで timeout を渡した時点で `new Anthropic({ timeout })` の値は
 *                    **無効化される**。 client 側に TTFT を設定してある呼び出し元は、
 *                    同じ値をここにも明示すること (でないと client の設定が黙って死ぬ)。
 */
export function fixedWallClockOptions(
  wallClockMs: number = SHORT_ROUTE_WALL_CLOCK_MS,
  ttftMs: number = STREAM_TTFT_TIMEOUT_MS
): { timeout: number; signal: AbortSignal } {
  return {
    // TTFT 予算が壁時計を超えても意味が無いので、 小さい方を採る。
    timeout: Math.min(ttftMs, wallClockMs),
    signal: AbortSignal.timeout(wallClockMs),
  }
}

/**
 * 1 コールに必要な壁時計を見積もる (ms)。
 *
 * @param modelId    ユーザーの preferredModel (AI_MODELS の id)
 * @param maxTokens  そのコールの max_tokens
 * @param inputChars そのコールに渡す入力の文字数 (transcript + prompt)
 * @param passes     高精度モードのように 1 論理ステップが複数コールになる場合の本数
 */
export function estimateCallMs({
  modelId,
  maxTokens,
  inputChars,
  passes = 1,
}: {
  modelId: string
  maxTokens: number
  inputChars: number
  passes?: number
}): number {
  const model = getModelById(modelId)
  const generateMs = (maxTokens / model.outputTokensPerSec) * 1000
  const prefillMs = (inputChars / CHARS_PER_TOKEN / PREFILL_TOKENS_PER_SEC) * 1000
  const oneCall = (generateMs + prefillMs + CALL_OVERHEAD_MS) * SAFETY_FACTOR
  return Math.ceil(oneCall * passes)
}

/**
 * estimateCallMs の逆算: 与えられた壁時計に収まる **最大の maxTokens**。
 *
 * 【なぜ要るか】 出力上限を「全モデル共通の定数」で決めると、 速いモデルでは短すぎ、
 * 遅いモデルでは予算を超える。 超えた側は 1 コールも着手できず **画面が「作成中」の
 * まま永久に進まない** (トークスクリプトの本文はこの形で止まりうる)。 上限を
 * 「モデルの速度の関数」にすれば、 速いモデルは長く書け、 遅いモデルでも必ず 1 コール入る。
 *
 * ⚠️ estimateCallMs と同じ式から導くこと。 別々に書くと片方だけ直して食い違う
 *    (要約で 7 本の修正 commit を積んだ原因そのもの)。
 *
 * @returns 0 以上の整数。 予算が固定費 (TTFT + prefill) にすら足りなければ 0
 */
export function maxTokensWithin({
  modelId,
  budgetMs,
  inputChars,
}: {
  modelId: string
  budgetMs: number
  inputChars: number
}): number {
  const model = getModelById(modelId)
  const prefillMs = (inputChars / CHARS_PER_TOKEN / PREFILL_TOKENS_PER_SEC) * 1000
  const generateMs = budgetMs / SAFETY_FACTOR - prefillMs - CALL_OVERHEAD_MS
  if (generateMs <= 0) return 0
  return Math.floor((generateMs / 1000) * model.outputTokensPerSec)
}

/**
 * backstop の下限 (ms)。 AbortSignal.timeout(0) は即発火してしまうので 0 は避ける。
 *
 * ★これを「意味のある最小予算」(例 15s) にしてはいけない。 Math.max(..., 15_000) にすると
 *   残り時間が 15s 未満のときに **backstop が締切を超える** ため、 abort が
 *   maxDuration(300s) の SIGKILL と競合し、 backstop の存在意義 (SIGKILL より先に abort して
 *   catch を走らせる) が消える。 残りが少ないなら短い予算のまま abort させ、 次の invocation
 *   (hardDeadline がリセットされて 285s 使える) にやり直させるのが正しい。
 */
const MIN_CALL_WALL_CLOCK_MS = 1_000

/**
 * 1 コールの RequestOptions を組み立てる。 AI コールはすべてこれを通すこと。
 *
 * - `timeout`: ストリーミングなので **TTFT (最初のバイトまで) の予算**。 生成時間は縛らない。
 *   旧実装はここに「生成時間ぶんの秒数」を入れていたため、 出力が上限に近い要約が
 *   完成間際に毎回 abort され "Request timed out." になっていた。
 * - `signal`: 総壁時計の backstop。 ストリームがストールしたときの唯一の脱出路。
 *
 * ★`remainingMs` を必ず渡すこと (この関数の肝)。
 *   backstop を「見積りの 2 倍」だけで決めてはいけない。 `estimateCallMs` は `max_tokens`
 *   (=キャップ) 基準なので実出力 (通常 数百〜2000 tok) に対して数倍過大になる。 例えば
 *   Opus × 単一チャンク(8192tok/60,000字) の見積りは約 472s で、 その 2 倍 = 944s は
 *   lambda 寿命 (maxDuration 300s) の 3 倍。 つまり backstop は **原理的に発火せず**、
 *   ハングすると必ず SIGKILL が先に来る (= catch が走らない = 失敗記録も通知も出ない)。
 *   invocation の残り時間でクランプして初めて「ハング検知」として機能する。
 */
export function buildCallOptions(opts: {
  modelId: string
  maxTokens: number
  inputChars: number
  /** この呼び出しに使える壁時計の残り (ms)。 route の maxDuration / hardDeadline の内側の値。 */
  remainingMs: number
}): { timeout: number; signal: AbortSignal; wallClockMs: number } {
  const estimated = estimateCallMs({
    modelId: opts.modelId,
    maxTokens: opts.maxTokens,
    inputChars: opts.inputChars,
  })
  // 見積りの 2 倍を許容しつつ (正常なコールは絶対に当たらない)、 invocation の残り時間は
  // **絶対に超えない** (超えると SIGKILL に先を越されて backstop の意味が無くなる)。
  // 下限は「即発火しない」ための 1s だけ (詳細は MIN_CALL_WALL_CLOCK_MS)。
  const budget = Math.max(
    Math.min(estimated * 2, opts.remainingMs),
    MIN_CALL_WALL_CLOCK_MS
  )
  return {
    timeout: Math.min(STREAM_TTFT_TIMEOUT_MS, budget),
    signal: AbortSignal.timeout(budget),
    // AbortSignal からは発火時刻を読み出せないので、 実際に採用した予算を返して
    // テストが backstop そのものを検証できるようにする (timeout を見て backstop を
    // 検証したつもりになる、 という穴を塞ぐため)。
    wallClockMs: budget,
  }
}
