import { Hono } from 'hono'
import { desc, eq, inArray, lt } from 'drizzle-orm'
import { today } from '@jushuo/shared'
import type { ScheduleAudio, ScheduleEntry, ScheduleDetail } from '@jushuo/shared'
import { db } from '../db'
import { articles, schedules } from '../db/schema'
import { loadArticleContent } from '../services/content'
import { ensureSchedules, scheduleAhead } from '../services/schedules'
import { scheduleAudioOf } from '../services/standard-audio-meta'
import { pickHistoryArenas } from '../services/schedule-shape'
import { getArenaStatsBatch, getRank, getTopLeaderboard } from '../services/leaderboard'
import { readStreakView } from '../services/streak'
import { MAX_BACKFILL_DAYS, resolveScheduleDate } from '../services/schedule-date'
import type { Variables } from '../middleware/auth'

export const schedulesRoutes = new Hono<{ Variables: Variables }>()

/** 历史挑战默认列几条（**竞技场数**，不是天数） */
const DEFAULT_HISTORY = 20
/** 上限 —— 别让一个查询参数把整张表捞出来 */
const MAX_HISTORY = 50

/*
 * ⭐ 每日挑战列表 —— 首页那**一次**请求就够了。
 *
 * ⚠️ 刻意把「今天 + 历史 + streak」打成一个包：
 *    做减法之后首页就是这一页列表，拆成多个请求只会让首屏出现几段先后到达的空白。
 *
 * ⚠️ 日期一律取服务端的（见 @jushuo/shared/day.ts）——
 *    客户端时钟可改，让本地算「今天」必然出现「本地显示已打卡、服务端不认」。
 *
 * ⚠️⚠️ **两段数据来自两个不同的地方**，别再合起来当成一个列表：
 *    · `today`  —— 走**排期**：今天那一条（没有排期会自动补一行 rotation）
 *    · `history`—— 走**全库**：直接查 schedules 表里今天之前的排期，
 *                  按日期倒序、同一句只留最近一次、并剔除与今日重复的那一句
 *    以前这里是用「最近 N 天窗口」同时算两段，于是池子（5 句）比窗口（7 天）小时，
 *    -5 号会轮回到今天那一句 —— 历史里必然出现一张和上面一模一样的卡。
 */
schedulesRoutes.get('/', async (c) => {
  const userId = c.get('userId')
  const date = today()

  const requested = Number(c.req.query('history'))
  // ⚠️ NaN 也要兜住：?history=abc 会让 Math.min 返回 NaN，随后一条都不返回，
  //    表现出来是「历史空空」，而真正的原因是一个畸形参数。
  const limit = Number.isFinite(requested)
    ? Math.min(MAX_HISTORY, Math.max(1, Math.trunc(requested)))
    : DEFAULT_HISTORY

  // ⭐ 顺带把未来两周排上 —— 让「哪一天读哪一句」成为**已决定的数据**。
  //    ⚠️ 失败不阻断：今天那一条还能按轮转现算。
  await scheduleAhead().catch((err: Error) =>
    console.warn('[schedules] 预排未来失败（不影响本次列表）：' + err.message),
  )

  /** ① 今日那一张：走排期 */
  const picks = await ensureSchedules([date])
  const todayPick = picks.get(date)
  if (!todayPick) {
    // ⚠️ 明确的 503 而不是空对象：句库为空是**部署问题**，
    //    报成「今天没有内容」会让排查方向完全跑偏（见 db/seed-articles.ts）。
    return c.json(
      { ok: false, error: '句库为空：没有可用的句子（检查 SEED_ON_START 是否生效）' },
      503,
    )
  }

  /**
   * ② 历史：走**全库**。
   * ⚠️ 排序与去重的规则在 services/schedule-shape.ts（有单测）——
   *    这里只负责把**全库**的行取出来，不在这里写「窗口」。
   */
  const rows = await db
    .select({ date: schedules.date, articleId: schedules.articleId, source: schedules.source })
    .from(schedules)
    .where(lt(schedules.date, date))
    .orderBy(desc(schedules.date))
  const historyRows = pickHistoryArenas(rows, todayPick.article.id, limit)

  // ⚠️ 正文 / 音频 / 统计**都按句子算一次** —— 今日那一条和历史里的可能是同一句
  const articleIds = [...new Set([todayPick.article.id, ...historyRows.map((r) => r.articleId)])]
  const [articleRows, stats, streak] = await Promise.all([
    db.select().from(articles).where(inArray(articles.id, articleIds)),
    getArenaStatsBatch(articleIds, userId),
    readStreakView(userId, date),
  ])
  const articleById = new Map(articleRows.map((a) => [a.id, a]))

  // ⚠️ 正文按 contentJson 去重后一次性读：轮转池只有几句，反复出现同一条内容
  const byContentJson = new Map<string, { text: string; translation: string }>()
  for (const id of articleIds) {
    const a = articleById.get(id)
    if (a) byContentJson.set(a.contentJson, { text: '', translation: '' })
  }
  await Promise.all(
    [...byContentJson.keys()].map(async (key) => {
      const content = await loadArticleContent(key)
      byContentJson.set(key, { text: content?.text ?? '', translation: content?.translation ?? '' })
    }),
  )

  /**
   * ⭐ 标准音（含时长）按**句子**算一次。
   * ⚠️ 时长是读 content/audio/*.mp3 现算的（容器里没有 ffprobe），
   *    进程内缓存；算不出来是 null ⇒ 端侧只显示按钮、不显示时长。
   */
  const audioOf = new Map<number, ScheduleAudio | null>()
  await Promise.all(
    articleIds.map(async (id) => {
      const a = articleById.get(id)
      if (!a) return
      audioOf.set(id, await scheduleAudioOf({ id: a.id, standardAudio: a.standardAudio }))
    }),
  )

  /** 一行排期 → 一张卡片。⚠️ 文章查不到（被删/被归档）时返回 null，由调用方丢掉 */
  const toEntry = (d: string, articleId: number, source: string): ScheduleEntry | null => {
    const a = articleById.get(articleId)
    if (!a) return null
    const st = stats.get(articleId)
    return {
      date: d,
      articleId,
      text: byContentJson.get(a.contentJson)?.text ?? '',
      translation: byContentJson.get(a.contentJson)?.translation ?? '',
      isScheduled: source === 'scheduled',
      isToday: d === date,
      participantCount: st?.participantCount ?? 0,
      topScore: st?.topScore ?? null,
      myBest: st?.myBest ?? null,
      myAttempts: st?.myAttempts ?? 0,
      audio: audioOf.get(articleId) ?? null,
    }
  }

  const todayCard = toEntry(date, todayPick.article.id, todayPick.source)
  if (!todayCard) {
    return c.json({ ok: false, error: '今天的排期指向了不存在的句子' }, 503)
  }
  const history = historyRows
    .map((r) => toEntry(r.date, r.articleId, r.source))
    .filter((x): x is ScheduleEntry => x !== null)

  return c.json({ ok: true, data: { date, today: todayCard, history, streak } })
})

/**
 * ⭐ 单个挑战的详情 —— 从首页卡片点进来。
 *
 * ⚠️ 与列表的分工：列表给「一眼扫过去」，详情给「看进去」：
 *    · 列表只有统计数字，详情有**完整榜单**（谁在前、谁是自己）
 *    · 列表不带「我的名次」（7 天各算一次名次太贵），详情只算一天，随便算
 */
schedulesRoutes.get('/:date', async (c) => {
  const userId = c.get('userId')
  const date = resolveScheduleDate(c.req.param('date'))
  if (!date) {
    return c.json(
      { ok: false, error: `挑战日期不合法：只能看最近 ${MAX_BACKFILL_DAYS} 天内的挑战` },
      400,
    )
  }

  const now = today()
  const pick = (await ensureSchedules([date])).get(date)
  if (!pick) {
    return c.json({ ok: false, error: '句库为空：没有可用的句子' }, 503)
  }

  // ⚠️ 统计、榜单、名次全部按**句子**（句子 = 竞技场），日期只决定进哪一个
  const articleId = pick.article.id
  const content = await loadArticleContent(pick.article.contentJson)
  const [stats, leaderboard, rankInfo] = await Promise.all([
    getArenaStatsBatch([articleId], userId).then((m) => m.get(articleId)),
    getTopLeaderboard(articleId, userId),
    getRank(articleId, userId),
  ])

  const detail: ScheduleDetail = {
    date,
    articleId: pick.article.id,
    text: content?.text ?? '',
    translation: content?.translation ?? '',
    isScheduled: pick.source === 'scheduled',
    isToday: date === now,
    participantCount: stats?.participantCount ?? 0,
    topScore: stats?.topScore ?? null,
    myBest: stats?.myBest ?? null,
    myAttempts: stats?.myAttempts ?? 0,
    // getRank 在「没参与过」时返回 rank 0 —— 转成 null，让「没读」和「第 0 名」不混为一谈
    myRank: rankInfo.rank > 0 ? rankInfo.rank : null,
    myBeatenCount: rankInfo.rank > 0 ? rankInfo.beatenCount : null,
    leaderboard,
  }
  return c.json({ ok: true, data: detail })
})
