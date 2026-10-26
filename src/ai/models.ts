// ported from IKEMENLTD/airlog@105d8ed src/lib/ai/models.ts
// 移植したのは「モデル定義の形」（outputTokensPerSec を必須にする）だけ。
// モデル一覧・価格は 2026-10-26 に claude-api の資料（cached 2026-10-06）で引き直した現行のもの。
// コイン・要約品質の定義は本件に無いので持ち込まない。

export interface AIModelDefinition {
  readonly id: string
  /** API に送る ID。日付の接尾辞は付けない（付けると 404） */
  readonly apiId: string
  readonly name: string
  /** 1M トークンあたりの米ドル */
  readonly inputCostPer1M: number
  readonly outputCostPer1M: number
  /** キャッシュの読み出し（1M トークンあたり） */
  readonly cacheReadCostPer1M: number
  /** キャッシュへの書き込み（5分）。入力単価の 1.25 倍 */
  readonly cacheWriteCostPer1M: number
  /**
   * 出力トークン生成スループットの **保守的な下限** (tok/s)。
   *
   * 【この項目が存在する理由（元のコメントの要約）】
   * AirLog では時間予算を単一のスループット定数で組んでいたため、Haiku と Opus（約5倍違う）の
   * 片方が必ず壊れ、「タイムアウトの修正」が7回往復した。時間の見積りは必ずモデルの関数にする
   * （time-budget.ts）。平均ではなく下限を入れる。長く見積もる分には安全側に倒れる。
   */
  readonly outputTokensPerSec: number
  /** 速度が実測か（false は保守的な仮置き。実測が取れたら差し替える） */
  readonly measured: boolean
  readonly default?: true
}

export const AI_MODELS: readonly AIModelDefinition[] = [
  {
    id: 'claude-sonnet-5-5',
    apiId: 'claude-sonnet-5-5',
    name: 'Sonnet 5.5',
    inputCostPer1M: 2.0,
    outputCostPer1M: 10.0,
    cacheReadCostPer1M: 0.2,
    cacheWriteCostPer1M: 2.5,
    // 未実測。AirLog の本番で Sonnet 4.6 が 54.8 tok/s だったので、それより低い 45 を仮置き
    outputTokensPerSec: 45,
    measured: false,
    // REQUIREMENTS 9-9 の既定
    default: true,
  },
  {
    id: 'claude-opus-5-5',
    apiId: 'claude-opus-5-5',
    name: 'Opus 5.5',
    inputCostPer1M: 4.0,
    outputCostPer1M: 20.0,
    cacheReadCostPer1M: 0.2,
    cacheWriteCostPer1M: 5.0,
    // 未実測（保守的な下限）
    outputTokensPerSec: 25,
    measured: false,
  },
  {
    id: 'claude-haiku-5-5',
    apiId: 'claude-haiku-5-5',
    name: 'Haiku 5.5',
    inputCostPer1M: 0.1,
    outputCostPer1M: 0.5,
    cacheReadCostPer1M: 0.01,
    cacheWriteCostPer1M: 0.125,
    // 未実測（保守的な下限）
    outputTokensPerSec: 100,
    measured: false,
  },
] as const

export const DEFAULT_MODEL = AI_MODELS.find((m) => m.default)!

/** 見つからないモデルIDは既定に倒さず、例外にする（本件は設定で選ぶので、書き間違いを黙って通さない） */
export function getModelById(id: string): AIModelDefinition {
  const m = AI_MODELS.find((x) => x.id === id)
  if (!m) throw new Error(`モデル「${id}」は models.ts に無い。足すときは outputTokensPerSec を必ず埋めること`)
  return m
}

export function getModelApiId(id: string): string {
  return getModelById(id).apiId
}

/** 使用量から実費（米ドル）を出す */
export function costUsd(
  modelId: string,
  u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
): number {
  const m = getModelById(modelId)
  return (
    (u.inputTokens * m.inputCostPer1M +
      u.outputTokens * m.outputCostPer1M +
      u.cacheReadTokens * m.cacheReadCostPer1M +
      u.cacheWriteTokens * m.cacheWriteCostPer1M) /
    1_000_000
  )
}
