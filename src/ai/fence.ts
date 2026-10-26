// ported from IKEMENLTD/airlog@105d8ed src/lib/ai/slides/brief.ts（promptFenceTagPattern と、タグを潰す処理）
// 本件の囲いタグに差し替えた。★タグの一覧はここ1か所で持つ（元の実装で、一覧が2か所に分かれて片方だけ古く、
// 注入できる穴が開いていた教訓）。

/** プロンプトで材料を囲っているタグ。増やしたらここだけ直す */
export const PROMPT_FENCE_TAGS = ['manuscript', 'catalog', 'outline', 'page', 'instruction'] as const

/** 囲いのタグを見つける正規表現（開き・閉じ・大文字小文字を問わない。属性つきも拾う） */
export const promptFenceTagPattern = (): RegExp => new RegExp(`</?\\s*(${PROMPT_FENCE_TAGS.join('|')})(\\s[^>]*)?>`, 'gi')

/**
 * 原稿など、信用できない入力に入っている囲いのタグを潰す（< と > を外す）。
 * 原稿に `</manuscript>` と書かれると、その後ろが「こちらの指示」として読まれてしまうため（REQUIREMENTS 9-7）。
 */
export function neutralizeFenceTags(text: string): string {
  return text.replace(promptFenceTagPattern(), (m) => m.replace(/[<>]/g, ''))
}
