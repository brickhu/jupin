/**
 * ⭐ 首页「历史挑战」那一段怎么挑 —— 纯函数，规则单独放这里（有单测）。
 *
 * ⚠️⚠️ 三条规则，每条都能独立写错，而写错了在界面上只表现为「多了/少了一张卡」
 *    或者「顺序有点怪」：不报错、不崩，只能靠人盯着看。
 *
 *  ① **剔除与今日重复的那一句**：今日那张卡就在它上面，
 *     再列一次等于同一个榜单看两遍（池子小的时候必然发生）。
 *  ② **同一句只留最近的那一次**：同一个竞技场在历史里也只该出现一次，
 *     位置取它最新排过的那一天。
 *  ③ **按日期倒序**（新的在前）。
 *     ⚠️ 显式排序，不依赖调用方给的顺序：这个顺序是产品语义，不该由上游的 SQL 决定。
 *
 * ⚠️ 它**不负责取数据**：调用方查的是「全库今天之前的排期」，
 *    窗口/条数由调用方决定（见 routes/schedules.ts）。
 */

export interface ArenaRow {
  date: string
  articleId: number
}

/**
 * 从排期行里挑出历史竞技场。
 *
 * @param rows          候选排期（顺序无所谓，内部会排）
 * @param todayArticleId 今日那一句的 id（null = 不剔除）
 * @param limit         最多几条（竞技场数，不是天数）
 */
export function pickHistoryArenas<T extends ArenaRow>(
  rows: T[],
  todayArticleId: number | null,
  limit: number,
): T[] {
  /** ③ 'YYYY-MM-DD' 字符串天然可排序，新的在前 */
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  const seen = new Set<number>()
  const out: T[] = []
  for (const r of sorted) {
    if (todayArticleId !== null && r.articleId === todayArticleId) continue // ①
    if (seen.has(r.articleId)) continue // ②
    seen.add(r.articleId)
    out.push(r)
    if (out.length >= limit) break
  }
  return out
}
