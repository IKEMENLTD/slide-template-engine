// ported from IKEMENLTD/airlog@105d8ed src/lib/ai/model-failover.ts
// 変えたところ: logger と recordAnthropicSpend（DB へ原価を記録）は持ち込まず、
// 使用量は呼び出し側が渡す記録先（UsageSink）へ書く（REQUIREMENTS 13-2・9-8）。
// AiFeature（AirLog の用途の列挙）は、本件の段の名前（文字列）に置き換えた。
import Anthropic from '@anthropic-ai/sdk'

/** 何に使った呼び出しか（A段・B段など）。★必須（元の実装と同じ理由: 渡し忘れを型で防ぐ） */
export type AiFeature = string

export type AiUsage = {
  feature: AiFeature
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheDeclared: boolean
  cacheHit: boolean
  cacheIneffective: boolean
}
export type UsageSink = (u: AiUsage) => void

const logger = {
  warn: (o: object, m: string) => console.warn(m, JSON.stringify(o)),
  error: (o: object, m: string) => console.error(m, JSON.stringify(o)),
}

/**
 * モデル自動フェイルオーバー (automatic failover)。
 *
 * Claude のモデルが廃止/変更され messages.create が 404 (not_found_error) で失敗した場合に、
 * Models API (GET /v1/models) から「同じ格(tier)の最新モデル」を自動取得して即リトライし、
 * 以後その格はキャッシュで自動追従する。 人手の介入・env 更新・SQL migration・デプロイ不要。
 *
 * 方針 (ユーザー指定):
 *  - ユーザーが選んだ格(haiku=fast / sonnet=balanced / opus=premium)は超えない・下げない。
 *    同格内の後継モデルにのみ自動移行する。
 *  - 同格の後継が見つからない (= 格ごと廃止) 場合のみ継続不能。 アラートを出して失敗させる
 *    (勝手に別の格へは行かない)。
 */

type Tier = 'fast' | 'balanced' | 'premium'

/** 格→キーワード。元は haiku/sonnet/opus の3つ（本件も同じ） */
const TIER_KEYWORD: Record<Tier, string> = {
  fast: 'haiku',
  balanced: 'sonnet',
  premium: 'opus',
}

/** モデルID文字列から格を推定する (id に haiku/sonnet/opus を含むか)。 */
function tierOf(model: string): Tier | null {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 'fast'
  if (m.includes('sonnet')) return 'balanced'
  if (m.includes('opus')) return 'premium'
  return null
}

// 廃止検知時に「格 → 現行 apiId」を記録し、以後その格の呼び出しを自動的に差し替える。
const healedByTier = new Map<Tier, string>()

// Models API の結果キャッシュ (毎回叩かない)。
let modelsCache: { at: number; models: { id: string; created: number }[] } | null = null
const MODELS_TTL_MS = 60 * 60 * 1000

/**
 * Models API のタイムアウト (ms)。
 * ★明示必須: 未指定だと SDK 既定の 600s (10分) が適用される。 この経路が走るのは
 * 「モデルが 404 = 全部壊れている」瞬間であり、 最も 10 分ハングさせたくない場面。
 * 旧実装は timeout 未指定で、 404 時に最悪 45s + 600s + 45s = 関数 SIGKILL (catch も
 * 走らず PROCESSING 固着) になりえた。
 */
const MODELS_LIST_TIMEOUT_MS = 5000

/** オートページネーションの上限 (無限ページを踏まないための backstop)。 */
const MODELS_LIST_MAX_PAGES = 5

async function listAvailableModels(
  client: Anthropic
): Promise<{ id: string; created: number }[]> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.models
  const models: { id: string; created: number }[] = []
  let page = await client.models.list({ limit: 100 }, { timeout: MODELS_LIST_TIMEOUT_MS })
  for (let i = 0; i < MODELS_LIST_MAX_PAGES; i++) {
    for (const m of page.data) {
      const created = m.created_at ? new Date(m.created_at).getTime() : 0
      models.push({ id: m.id, created: Number.isNaN(created) ? 0 : created })
    }
    if (!page.hasNextPage()) break
    page = await page.getNextPage()
  }
  modelsCache = { at: Date.now(), models }
  return models
}

/** 同格(tier)で利用可能な最新モデルの apiId を返す (新しい順の先頭)。 */
async function latestModelForTier(client: Anthropic, tier: Tier): Promise<string | null> {
  const keyword = TIER_KEYWORD[tier]
  const models = await listAvailableModels(client)
  const matches = models
    .filter((m) => m.id.toLowerCase().includes(keyword))
    .sort((a, b) => b.created - a.created)
  return matches[0]?.id ?? null
}

/**
 * 自動フェイルオーバー解決: その格が既に廃止検知済みなら現行 apiId に差し替える。
 * (廃止検知前は引数の apiId をそのまま返すので通常時は完全に無影響)
 */
export function resolveModelApiId(apiId: string): string {
  const tier = tierOf(apiId)
  if (tier && healedByTier.has(tier)) return healedByTier.get(tier)!
  return apiId
}

function isModelNotFound(err: unknown): boolean {
  // 404 not_found_error = モデルID無効/廃止。
  // SDK の NotFoundError に加え、 SDK バージョン差/転送経路で instanceof が効かない
  // ケースに備えて status===404 でも判定する (messages.create の 404 は実質モデル無効のみ)。
  if (err instanceof Anthropic.NotFoundError) return true
  const status = (err as { status?: number } | null | undefined)?.status
  return status === 404
}

/**
 * 【重要】必ずストリーミングで投げ、 完成した Message を返す。
 *
 * 非ストリーミング (messages.create) にしてはいけない。 SDK の `timeout` は
 * fetch の解決 = レスポンスヘッダ到着までしか計らない (client.js の fetchWithTimeout が
 * `finally { clearTimeout(timeout) }`)。 非ストリーミングだとヘッダは生成が全部終わるまで
 * 来ないため、 `timeout` が「生成時間そのもの」を縛ってしまい、 出力が上限に近い要約は
 * 毎回 "Request timed out." で丸ごと捨てられていた (2026-07 の再発ループの直接原因)。
 * ストリーミングならヘッダは即座に返るので、 `timeout` は TTFT の予算になり、 生成が
 * 何秒かかっても abort されない。 呼び出し側の戻り値の形は create と同じなので、
 * 呼び出し側は変更不要。
 */
async function streamToFinalMessage(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  feature: AiFeature,
  options: Anthropic.RequestOptions | undefined,
  sink: UsageSink
): Promise<Anthropic.Message> {
  // `stream: false` が入っていると messages.stream の型と衝突するので落とす。
  const { stream: _omitStream, ...body } = params
  const message = await client.messages.stream(body, options).finalMessage()
  logAiUsage(body, message, feature, sink)
  return message
}

/** system に cache_control を付けているか (配列で渡していないと付けようが無い)。 */
function hasCacheControl(params: Anthropic.MessageCreateParamsNonStreaming): boolean {
  const system = params.system
  if (!Array.isArray(system)) return false
  return system.some((b) => 'cache_control' in b && !!b.cache_control)
}

/**
 * AI 呼び出し 1 本ぶんの token 使用量を記録する。
 *
 * ★ここが**全 AI 呼び出しの唯一の出口**なので、 ここに置けば全経路を漏れなく測れる。
 *
 * 【なぜ要るか】 `pipeline.ts` の `cachedSystem` のコメントは「最小キャッシュ長に届かず
 * 既定モデルでは成立しない」と主張しているが、 **その裏を取る計測が一度も実装されて
 * いなかった** (実際、 閾値の数字自体が 2 モデルぶん間違っていた → 2026-08-15 に訂正)。
 * コメント自身が「効果を主張する前に必ず usage をログして確認しろ」と書いている。
 * 効く/効かないを議論する前に、 まず実測できる状態にする。
 *
 * 見るべきログ:
 *   cacheHit=true              → キャッシュが効いている (入力課金が下がっている)
 *   cacheDeclared && 読み書き0 → 宣言はしたが**成立していない** (プレフィックスが短い等)
 */
function logAiUsage(
  params: Anthropic.MessageCreateParamsNonStreaming,
  message: Anthropic.Message,
  feature: AiFeature,
  sink: UsageSink
): void {
  try {
    const u = message.usage as Anthropic.Usage & {
      cache_read_input_tokens?: number | null
      cache_creation_input_tokens?: number | null
    }
    const cacheReadTokens = u.cache_read_input_tokens ?? 0
    const cacheWriteTokens = u.cache_creation_input_tokens ?? 0
    const cacheDeclared = hasCacheControl(params)
    const cacheIneffective = cacheDeclared && cacheReadTokens === 0 && cacheWriteTokens === 0
    // 宣言したのに読み書きとも 0 = 無言で成立していない（プレフィックスがモデルの最小長に届いていない等）
    sink({
      feature,
      model: message.model,
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheDeclared,
      cacheHit: cacheReadTokens > 0,
      cacheIneffective,
    })
  } catch {
    // 計測はあくまで観測。 ここで失敗しても本処理を巻き込まない。
  }
}

/**
 * 自動フェイルオーバー付きのメッセージ生成 (ストリーミング)。
 * モデル廃止(404)時のみ、 同格の最新モデルへ自動切替して 1 回リトライする。
 */
export async function createMessageWithFailover(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  /**
   * 何に使った呼び出しか。★**必須**。
   *
   * 「渡し忘れを検査で見張る」形にすると、次に呼び出しを足した人が必ず忘れる。
   * ここを必須にしておけば、コンパイラが全部の経路で強制する。
   * これが無かった間、管理画面の Anthropic の支出は**全部「用途の記録なし」の
   * 1 行**に潰れていて、何にいくら使ったのか分からなかった。
   */
  feature: AiFeature,
  options: Anthropic.RequestOptions | undefined,
  sink: UsageSink
): Promise<Anthropic.Message> {
  const requested = resolveModelApiId(String(params.model))
  try {
    return await streamToFinalMessage(client, { ...params, model: requested }, feature, options, sink)
  } catch (err) {
    if (!isModelNotFound(err)) throw err
    const tier = tierOf(requested)
    if (!tier) throw err

    let replacement: string | null = null
    try {
      replacement = await latestModelForTier(client, tier)
    } catch (listErr) {
      logger.error({ err: listErr }, 'モデル自動フェイルオーバー: Models API 取得に失敗')
    }

    if (!replacement || replacement === requested) {
      // 同格の後継が見つからない = 格ごと廃止。 継続不能なのでアラートして失敗させる。
      logger.error(
        { requested, tier },
        'モデル自動フェイルオーバー: 同格の後継が見つからず継続不能 (要手動対応)'
      )
      throw err
    }

    healedByTier.set(tier, replacement)
    logger.warn(
      { from: requested, to: replacement, tier },
      'モデル廃止を検知 → 同格の最新モデルへ自動フェイルオーバー'
    )
    return await streamToFinalMessage(client, { ...params, model: replacement }, feature, options, sink)
  }
}
