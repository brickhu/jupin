import { WORD_GREEN_LINE, type WeakPoint, type WordScore } from '@jushuo/shared'

/**
 * ⭐⭐ **薄弱词汇 —— 结构化事实**（prd §7.2，用户 2026-10-15 定）。
 *
 * ## 它是什么、不是什么
 *
 * · 是**事实**：由 submissions 的逐词分算出来，确定性、可重算、可解释（哪个词、几次、最低多少）。
 * · **不是** AI 说的话 —— 那是另一个字段（`participations.ai_summary`，见 services/summary.ts）。
 *   两者分开存，才可能"只重算事实、不动文本"，也才看得出哪些结论是模型下的。
 *
 * ## 累计规则
 *
 * `新的档案 = 老的薄弱词 + 这份成绩单的薄弱词`（**合并，不是覆盖**，用户原话）。
 * ⚠️ 合并的语义是"**这个词在这句上被记过几次**" ⇒ count 累加、lowest 取更低的那个。
 *    ⇒ 反复读错的词会越浮越高，读好了的词也不会凭空消失（它的 count 留在那里）。
 */

/** 低于这条线才算"没读好" —— ⚠️ 复用结果页逐词高亮的那根线，不新增第二根 */
const WEAK_LINE = WORD_GREEN_LINE

/** 一份成绩单里的薄弱词（同词去重、计数） */
export function weakPointsOf(wordScores: WordScore[] | null | undefined): WeakPoint[] {
  if (!Array.isArray(wordScores)) return []
  const out = new Map<string, WeakPoint>()
  for (const w of wordScores) {
    const word = String(w.word ?? '')
    const score = Number(w.score)
    if (!word || !Number.isFinite(score) || score >= WEAK_LINE) continue
    const cur = out.get(word)
    if (!cur) {
      out.set(word, {
        word,
        count: 1,
        lowest: score,
        ...(w.dp && w.dp !== 'normal' ? { dp: w.dp } : {}),
      })
      continue
    }
    cur.count += 1
    cur.lowest = Math.min(cur.lowest, score)
    if (!cur.dp && w.dp && w.dp !== 'normal') cur.dp = w.dp
  }
  return [...out.values()]
}

/**
 * 累计合并：`老 + 新`（顺序无关，结果一样）。
 *
 * ⚠️ 同一个词以**词**为键 —— 不含标点的词与含标点的词是两个键（例如 `invent` 与 `invent.`）。
 *    这与端侧逐词高亮用的是同一套切法（`words[].text` 原样），所以对得上。
 */
export function mergeWeakPoints(old: WeakPoint[] | null | undefined, add: WeakPoint[]): WeakPoint[] {
  const out = new Map<string, WeakPoint>()
  for (const w of Array.isArray(old) ? old : []) out.set(w.word, { ...w })
  for (const w of add) {
    const cur = out.get(w.word)
    if (!cur) {
      out.set(w.word, { ...w })
      continue
    }
    cur.count += w.count
    cur.lowest = Math.min(cur.lowest, w.lowest)
    if (!cur.dp && w.dp) cur.dp = w.dp
  }
  /**
   * 排序：**先看次数、再看分数** —— 界面上要"最该练的排在前面"。
   * ⚠️ 不排的话，顺序取决于 Map 的插入顺序（= 老数据的顺序），
   *    换一次合并顺序界面就跳一下。
   */
  return [...out.values()].sort((a, b) => b.count - a.count || a.lowest - b.lowest || a.word.localeCompare(b.word))
}
