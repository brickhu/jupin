/**
 * ⭐ 首页「历史挑战」那一段怎么挑 —— 纯函数，规则单独放这里（有单测）。
 *
 * ⚠️⚠️ 数据源是 **articles（句库）**，不是 schedules（排期）。
 *    db/schema.ts 里写得很清楚：排期「不是竞技单位，只是一个按日组织的展示层」，
 *    竞技数据的单位永远是**句子**（排名/人数/最高分全部按 article_id 查）。
 *    ⇒ 首页下半段要列的是「句库里还有哪些竞技场」，不是「过去哪几天排过」。
 *
 * ⚠️ 两条规则，都能独立写错，而写错了只表现为「多了/少了一张卡」或「顺序怪」：
 *
 *  ① **剔除今日那一句**：今日那张卡就在它上面，再列一次等于同一个榜单看两遍。
 *     ⚠️ 池子小的时候必然发生（池子 5 句时，隔 5 天就轮回到同一句）。
 *  ② **按句子 id 倒序**（一个稳定顺序）。
 *     ⚠️ 显式排序，不依赖调用方 SQL 的 order by：这个顺序是产品语义。
 *     ⚠️ id 已是**内容 hash**（sha256(text) 前 16 位，见 db/schema.ts）—— 它**不编码新旧**，
 *        所以这里的倒序只是一个确定的稳定顺序，不再意味着「id 越大 = 内容越新」。
 */

/**
 * 从**句库**里挑出历史挑战（调用方按 id 倒序取了一批候选）。
 *
 * @param rows           候选句子（顺序无所谓，内部会按 id 倒序排）
 * @param todayArticleId 今日那一句的 id（null = 不剔除）
 * @param limit          最多几条
 */
export function pickHistoryArticles<T extends { articleId: string }>(
  rows: T[],
  todayArticleId: string | null,
  limit: number,
): T[] {
  /** ② 按 id 倒序（字符串比较，稳定顺序） */
  const sorted = [...rows].sort((a, b) =>
    a.articleId < b.articleId ? 1 : a.articleId > b.articleId ? -1 : 0,
  )

  const out: T[] = []
  for (const r of sorted) {
    if (todayArticleId !== null && r.articleId === todayArticleId) continue // ①
    out.push(r)
    if (out.length >= limit) break
  }
  return out
}
