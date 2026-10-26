// ported from IKEMENLTD/airlog@105d8ed src/lib/ai/doc-policy.ts
// 移植したのは trimTo と redactDevTools だけ（REQUIREMENTS 13-2）。会議の補完ポリシー（SOURCE_POLICY）は本件に無い。

// ============================================================
// 文字列の丸め
// ============================================================

/**
 * 改行・連続空白・制御文字を潰して 1 行にし、 指定文字数で丸める。
 *
 * ⚠️ **語の途中で切らないこと。** 旧実装は `slice(0, max)` そのままで、 本番の紙面に
 *    「…（面談履歴の蓄積と即」という **括弧が開きっぱなしの行**が焼き付いた
 *    (ちょうど上限 34 字目で切れていた)。 画像なので後から直せない。
 *    区切り文字の手前まで戻して丸め、 切ったことが分かるよう「…」を付ける。
 *
 * ⚠️ 戻しすぎないこと。 区切りが先頭付近にしか無いときにそこまで戻すと、 内容がほぼ消える。
 *    半分より手前へは戻さない。
 */
export function trimTo(value: string | undefined | null, max: number): string {
  let scrubbed = ''
  for (const ch of value ?? '') {
    const code = ch.codePointAt(0) ?? 0
    scrubbed += code < 0x20 || code === 0x7f ? ' ' : ch
  }
  const flat = scrubbed.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat

  // 「…」のぶん 1 字空ける。 max が極端に小さいときは素直に切る。
  const room = max - 1
  if (room <= 0) return flat.slice(0, max)

  const head = flat.slice(0, room)
  const breaks = ['、', '。', '・', '（', '(', '／', '/', '：', ':', '，', ' ']
  let cut = -1
  for (const b of breaks) {
    const i = head.lastIndexOf(b)
    if (i > cut) cut = i
  }
  const body = cut >= Math.floor(room / 2) ? head.slice(0, cut) : head
  return body.replace(/[、。・（(／/：:，\s]+$/, '') + '…'
}

// ============================================================
// 開発の道具の名前
// ============================================================

/**
 * 相手に渡る書類に出してはいけない**こちらの道具**の名前。
 *
 * ⚠️ **相手が話した製品名まで消さないこと。** 「ChatGPT で問い合わせに答えたい」は
 *    相手の要件そのものなので消したら書類が壊れる。 ここに並べるのは
 *    「誰がどうやって作るか」に属する名前だけ。
 */
const DEV_TOOLS_ANYCASE = /Claude\s*Code|GitHub\s*Copilot|Copilot|AIR\s*LOG|AirLog/i
/** 普通名詞と紛れるもの (DB の cursor 等) は綴りどおりのときだけ。 */
const DEV_TOOLS_EXACT = /Cursor|Devin/

function mentionsDevTool(text: string): boolean {
  return DEV_TOOLS_ANYCASE.test(text) || DEV_TOOLS_EXACT.test(text)
}

/**
 * 道具の名前が入っている**節ごと**落とす。
 *
 * 【なぜ機械で持つか】 利用者の指示は「Claude code とか AI は書かないで。人間がやる
 * 前提の見積もりで。」。 プロンプトにも書いてあるが、 **モデルは指示を無視する**ので、
 * 保証は機械が持つ (AGENTS.md「プロンプトで頼むだけに戻さない」)。
 *
 * ⚠️ **名前だけ抜かないこと。** 「Claude Code で自動生成するので 0.5 人日」から名前だけ
 *    消すと「自動生成するので 0.5 人日」が残り、 一番まずい部分 (道具で短縮した見積り)
 *    がそのまま書類に載る。
 */
export function redactDevTools(value: string | undefined | null): string {
  const text = value ?? ''
  if (!text || !mentionsDevTool(text)) return text
  const kept = text
    .split(/(?<=[。、\n])/)
    .filter((part) => !mentionsDevTool(part))
    .join('')
  // 落とした節の前後に句読点だけが残ると、 書類では書きかけに見える。
  return kept.replace(/^[、。\s]+/, '').replace(/[、\s]+$/, '').trim()
}
