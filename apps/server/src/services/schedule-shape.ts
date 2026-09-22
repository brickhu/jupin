/**
 * ⭐ 首页那两张卡的数据形态：今日一张 + 历史一串。
 *
 * ⚠️⚠️ 这里有三条**容易各写各的**规则，所以单独抽出来做纯函数 + 单测：
 *
 *  ① **今日那张卡不参与历史**：它就是今日挑战本身。
 *  ② **同一句（同一个竞技场）在历史里只出现一次**。
 *     池子小的时候这条是必须的：池子 5 句、窗口 7 天时，
 *     `dayNumber % 5` 让 -5 号正好又轮回到今天那一句、-6 号回到昨天那一句 ——
 *     不折叠的话历史里会有两张卡和上面那张一模一样（同一个榜单看三遍）。
 *  ③ **按日期倒序**（新的在前）。
 *     ⚠️ 显式排序而不是「相信调用方给的顺序」：
 *        这个顺序是产品语义（越上面越近），不该由上游的循环方向决定。
 *
 * ⚠️ 折叠时保留**最近的那一天**：同一句连着几天都能读，
 *    但历史列表里它该站在自己最新的一次位置上。
 */

export interface ShapedCard {
  date: string
  articleId: number
}

export interface Shaped<T> {
  today: T | null
  history: T[]
}

export function shapeScheduleCards<T extends ShapedCard>(
  cards: T[],
  todayDate: string,
): Shaped<T> {
  /** ① 按日期倒序（新的在前）—— 字符串比较即可，'YYYY-MM-DD' 天然可排序 */
  const sorted = [...cards].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  const today = sorted.find((c) => c.date === todayDate) ?? null
  const todayArticle = today ? today.articleId : -1

  const seen = new Set<number>()
  const history: T[] = []
  for (const c of sorted) {
    if (c.date === todayDate) continue // ① 今日那张不进历史
    if (c.articleId === todayArticle) continue // ② 今日那一句也不进历史
    if (seen.has(c.articleId)) continue // ② 其余同一句只留最近的一次
    seen.add(c.articleId)
    history.push(c)
  }
  return { today, history }
}
