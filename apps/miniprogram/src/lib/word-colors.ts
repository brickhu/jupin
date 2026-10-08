import { alignWordScores, plainWordsOf, wordLevel } from '@jushuo/shared'

/**
 * ⭐ **给逐词上色** —— 结果弹窗与评测详情页**共用这一份**（2026-10 抽出来）。
 *
 * ⚠️ 抽出来的理由不是"少写几行"：两处画的是**同一份分数**，
 *    颜色判据一旦各写一遍就会漂移（一处改了阈值、另一处没改），
 *    而用户会在弹窗和详情页上看到**同一个词两种颜色** ✗
 *
 * 判据在 @jushuo/shared 的 `wordLevel`（与挑战列表同一处）；
 * 对齐在 `alignWordScores` —— 引擎词表可能多一个插入词或漏一个词，
 * 按下标硬套会让从错位处往后**每个词的颜色都是别人的**。
 */
export interface ColoredWord {
  /** 稳定的 key（同一个词可能出现多次，不能用 text 当 key） */
  i: number
  text: string
  /** 'text-ok' / 'text-bad' / ''（空 = 继承 currentColor，不上色） */
  cls: string
}

export function renderWordColors(
  text: string,
  scored: { word?: string; score: number; dp?: string }[],
): ColoredWord[] {
  const plain = plainWordsOf(text)
  const align = alignWordScores(text, scored.map((w) => w.word ?? ''))
  return plain.map((t, i) => {
    const at = align[i]
    const w = at === null || at === undefined ? undefined : scored[at]
    // ⚠️ 对不上（插入 / 漏读，或老成绩没有逐词）→ 不上色，继承 currentColor，不猜
    // ⚠️ 正常词也继承 currentColor（不是固定墨色）：卡片换成主题底之后，
    //    固定墨色在深色主题上会看不见 —— 颜色一律跟着 currentColor 走。
    const lvl = w ? wordLevel(w.score, w.dp) : ''
    /**
     * ⚠️⚠️ `bad` 映射到 **warn（橙）**，不是 `text-bad`（红）—— 2026-10 按设计稿标定。
     *
     * 设计稿里"读得不够好的词"是**橙色**，而不是红色：
     *     Innovation is not merely the / introduction 黑 / willingness **橙**
     * 红在全站是"**判错**"的颜色（结果页那些红块、错误条），含义完全不同：
     * 一个词读得不够准是"**去练这个**"，不是"你错了" ✗
     * ⚠️ `wordLevel` 返回的仍是 'bad'（那是**语义**，在 shared 里），
     *    颜色是**界面**的事，所以这层映射在端侧。
     */
    if (!lvl || lvl === 'ink') return { i, text: t, cls: '' }
    return { i, text: t, cls: lvl === 'bad' ? 'text-warn' : 'text-ok' }
  })
}
