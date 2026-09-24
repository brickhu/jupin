import { and, eq, inArray } from 'drizzle-orm'
import { addDays, dayNumber, today } from '@jushuo/shared'
import { db } from '../db'
import { articles, schedules } from '../db/schema'
import { contentExists } from './content'

/**
 * ⭐ 每日挑战 —— 「哪一天读哪一句」。
 *
 * ⚠️⚠️ 这一层存在的全部理由，是把**内容**和**排期**分开（见 db/schema.ts 里 schedules 表的注释）：
 *
 *   · 句子是可复用的内容；挑战是一次排期。池子只有几句、按天轮转，
 *     同一个句子当然会被用在很多天 —— 把日期挂在句子上，这件事根本表达不了。
 *   · 统计与排行按天算，所以「某一天的挑战」必须是一个**实体**。
 *     不落行的话只能每次查询现算，而池子一增删句子，**历史那几天的题目会一起变**。
 *
 * ⚠️ 没有排期的日子**自动补一行**（source='rotation'），所以
 *    「今天没题」在数据上不可能发生 —— 那在这类产品里等同于产品挂了。
 */

export interface ScheduleRow {
  date: string
  article: typeof articles.$inferSelect
  /** scheduled = 运营明确排的；rotation = 按天号自动轮的 */
  source: string
}

/**
 * 取（必要时补上）这几天的挑战。
 *
 * ⚠️ 轮转是**纯函数式**的（只依赖天号和池子顺序），但结果会**落成行**：
 *    因为池子会变，而历史不该跟着变。第一次看到某一天时钉下来，之后就以行为准。
 *
 * ⚠️ 用 INSERT IGNORE：并发（首页 + 详情页同时首次访问同一天）时，
 *    后到的那次静默失败，随后统一回查 —— 不做「先查后插」，那会撞主键。
 */
export async function ensureSchedules(dates: string[]): Promise<Map<string, ScheduleRow>> {
  const out = new Map<string, ScheduleRow>()
  if (dates.length === 0) return out

  const found = await loadRows(dates)
  for (const r of found) out.set(r.date, r)

  const missing = dates.filter((d) => !out.has(d))
  if (missing.length === 0) return out

  // 候选池：顺序必须稳定（否则取模结果会随查询计划漂移）
  const pool = await db.select().from(articles).where(eq(articles.isActive, true)).orderBy(articles.id)
  if (pool.length === 0) return out

  for (const date of missing) {
    // ⚠️ 用「天号取模」而不是随机：同一天所有用户、以及同一天的任何一次刷新，
    //    都必须拿到同一句。随机数会让榜单失去可比性，也会让用户刷新一次就换题。
    const idx = ((dayNumber(date) % pool.length) + pool.length) % pool.length
    const article = pool[idx] as (typeof articles.$inferSelect)
    await db
      .insert(schedules)
      .ignore()
      .values({ date, articleId: article.id, source: 'rotation' })
  }

  // ⚠️ 回查而不是直接用刚算出来的：并发时可能是**别人**插进去的，
  //    那时以库里的行为准（它可能是一条运营排期，而不是我们算的轮转）。
  for (const r of await loadRows(missing)) out.set(r.date, r)
  return out
}

async function loadRows(dates: string[]): Promise<ScheduleRow[]> {
  const rows = await db
    .select({ date: schedules.date, source: schedules.source, article: articles })
    .from(schedules)
    .innerJoin(articles, eq(articles.id, schedules.articleId))
    .where(inArray(schedules.date, dates))
  return rows
}

/**
 * 最近 N 天的挑战日期，**今天在最前**。
 * ⚠️ 含今天：首页第一张卡片就是今天，不该由调用方拼。
 */
export function recentScheduleDates(days: number, from: string = today()): string[] {
  const out: string[] = []
  for (let i = 0; i < days; i++) out.push(addDays(from, -i))
  return out
}

/**
 * ⭐ 预排未来若干天的挑战 —— 把「哪一天读哪一句」从**每次现算**变成**已决定的数据**。
 *
 * ⚠️⚠️ 为什么必须有这一步：
 *
 *    没有它的话，某一天的句子是在**第一次有人读它时**才按「天号对池子取模」算出来
 *    并落行的。也就是说：
 *      · 那一天在被人读到之前，它读哪一句**还没有决定**
 *      · 这中间只要句子池增删过（上线新句、下架旧句），
 *        那一天就会算成另一句 —— 而用户看到的正是「首页列表又变了」
 *
 *    ⇒ 提前把未来 N 天排好，之后它就以**行**为准。池子怎么变都不影响已排的日子。
 *
 * ⚠️ 仍然幂等（INSERT IGNORE）：已经排过的日子一个字节都不动，
 *    所以运维排了期的日子不会被这里覆盖。
 *
 * ⚠️ 只在**读列表时**顺带跑，不额外上定时任务：
 *    这个产品每天至少有人打开一次，窗口自然就续上了。
 *    加个 cron 只会多一个会挂的东西。
 */
export async function scheduleAhead(days = 14, from: string = today()): Promise<number> {
  const dates = recentScheduleDates(days + 1, addDays(from, days))
  const active = await db.select().from(articles).where(eq(articles.isActive, true)).orderBy(articles.id)

  /**
   * ⚠️⚠️ 池子里只能有**这个部署读得到正文**的句子。
   *    isActive 是**库**的状态，正文在**镜像**里 —— 两者不一致时
   *    （内容刚发布进库、还没重新部署）被抽中的那一天，
   *    全站朗读页都是「正文加载失败」，而且看不出跟这次发布有关。
   *    宁可池子小一点（少排几天），也不要排出一天谁都打不开的题。
   * ⚠️ 只 stat 不读内容：这个函数在每次读列表时都会跑。
   */
  const pool = active.filter((a) => contentExists(a.id))
  if (pool.length !== active.length) {
    console.warn(
      '[schedules] ' + (active.length - pool.length) + ' 条句子的正文在这个部署里读不到，' +
        '已从轮转池剔除（镜像没重新部署？跑 /health?deep=1 看差集）',
    )
  }
  if (pool.length === 0) return 0

  const existing = new Set((await loadRows(dates)).map((r) => r.date))
  const missing = dates.filter((d) => !existing.has(d))
  if (missing.length === 0) return 0

  // ⚠️ 一条批量 INSERT，不是 N 条 —— 首页是最高频的页面，
  //    每次冷启都打 14 次库不值得
  await db
    .insert(schedules)
    .ignore()
    .values(
      missing.map((date) => ({
        date,
        // ⚠️ 池子非空（上面已判），下标取模必落在范围内 ⇒ 非空断言是安全的
        articleId: pool[((dayNumber(date) % pool.length) + pool.length) % pool.length]!.id,
        source: 'rotation',
      })),
    )
  return missing.length
}
/**
 * 给某一天**明确**排一句（运营用）。
 * ⚠️ 用 upsert：同一天重排是正常操作（换题），不该报主键冲突。
 */
export async function setSchedule(date: string, articleId: string): Promise<void> {
  await db
    .insert(schedules)
    .values({ date, articleId, source: 'scheduled' })
    .onDuplicateKeyUpdate({ set: { articleId, source: 'scheduled' } })
}

/** 这个句子被排在了哪些天（内容下线前的引用检查用） */
export async function datesOfArticle(articleId: string): Promise<string[]> {
  const rows = await db
    .select({ date: schedules.date })
    .from(schedules)
    .where(eq(schedules.articleId, articleId))
  return rows.map((r) => r.date)
}

/** 只保留「启用中」的句子进轮转池的辅助（供测试与排查用） */
export async function activeArticleIds(): Promise<string[]> {
  const rows = await db
    .select({ id: articles.id })
    .from(articles)
    .where(and(eq(articles.isActive, true)))
  return rows.map((r) => r.id)
}
