import { Hono } from 'hono'
import { today } from '@jushuo/shared'
import type { ScheduleAudio, ScheduleEntry, ScheduleDetail } from '@jushuo/shared'
import { loadArticleContent } from '../services/content'
import { ensureSchedules, recentScheduleDates, scheduleAhead } from '../services/schedules'
import { scheduleAudioOf } from '../services/standard-audio-meta'
import { getArenaStatsBatch, getRank, getTopLeaderboard } from '../services/leaderboard'
import { readStreakView } from '../services/streak'
import { MAX_BACKFILL_DAYS, resolveScheduleDate } from '../services/schedule-date'
import type { Variables } from '../middleware/auth'

export const schedulesRoutes = new Hono<{ Variables: Variables }>()

/** 首页默认列出的天数（含今天） */
const DEFAULT_DAYS = 7
/** 上限 —— 别让一个查询参数把整张表捞出来 */
const MAX_DAYS = 30

/*
 * ⭐ 每日挑战列表 —— 首页那**一次**请求就够了。
 *
 * ⚠️ 刻意把「今天 + 历史 + streak」打成一个包：
 *    做减法之后首页就是这一页列表，拆成多个请求只会让首屏出现几段先后到达的空白。
 *
 * ⚠️ 日期一律取服务端的（见 @jushuo/shared/day.ts）——
 *    客户端时钟可改，让本地算「今天」必然出现「本地显示已打卡、服务端不认」。
 *
 * ⚠️ 历史挑战**不查库生成行**，而是按天号轮转**算**出来的：
 *    选句是纯函数（只依赖天号和池子顺序），所以任意一天都能稳定复现，
 *    不需要为每一天预写一行数据，也不会出现「那天忘了录就没有那天的挑战」。
 */
schedulesRoutes.get('/', async (c) => {
  const userId = c.get('userId')
  const date = today()

  const requested = Number(c.req.query('days'))
  // ⚠️ NaN 也要兜住：?days=abc 会让 Math.min 返回 NaN，随后循环一次都不跑，
  //    表现出来是「首页空白」，而真正的原因是一个畸形参数。
  const days = Number.isFinite(requested)
    ? Math.min(MAX_DAYS, Math.max(2, Math.trunc(requested)))
    : DEFAULT_DAYS

  const dates = recentScheduleDates(days, date)

  // ⭐ 顺带把未来两周排上 —— 让「哪一天读哪一句」成为**已决定的数据**。
  //    ⚠️ 失败不阻断：列表本身还能按轮转现算，只是那几天还没被钉住。
  await scheduleAhead().catch((err: Error) =>
    console.warn('[schedules] 预排未来失败（不影响本次列表）：' + err.message),
  )

  const picks = await ensureSchedules(dates)

  // ⚠️ 统计按**句子**查，所以先去重 —— 7 天里可能有好几天指向同一句，
  //    它们本来就该显示同一份竞技数据。
  const articleIds = [...new Set([...picks.values()].map((p) => p.article.id))]
  const [stats, streak] = await Promise.all([
    getArenaStatsBatch(articleIds, userId),
    readStreakView(userId, date),
  ])

  // ⚠️ 正文按 contentJson 去重后一次性读：轮转池只有几句，
  //    7 天里大概率反复出现同一条内容，没必要读 7 次。
  const byContentJson = new Map<string, { text: string; translation: string }>()
  for (const p of picks.values()) byContentJson.set(p.article.contentJson, { text: '', translation: '' })
  await Promise.all(
    [...byContentJson.keys()].map(async (key) => {
      const content = await loadArticleContent(key)
      byContentJson.set(key, { text: content?.text ?? '', translation: content?.translation ?? '' })
    }),
  )

  /**
   * ⭐ 标准音（含时长）按**句子**算一次 —— 7 天里大概率有好几天是同一句。
   * ⚠️ 时长是读 content/audio/*.mp3 现算的（容器里没有 ffprobe），
   *    进程内缓存；算不出来是 null ⇒ 端侧只显示按钮、不显示时长。
   */
  const articleOf = new Map<number, { id: number; standardAudio: string | null }>()
  for (const pick of picks.values()) {
    articleOf.set(pick.article.id, { id: pick.article.id, standardAudio: pick.article.standardAudio })
  }
  const audioOf = new Map<number, ScheduleAudio | null>()
  await Promise.all(
    [...articleOf.values()].map(async (a) => {
      audioOf.set(a.id, await scheduleAudioOf(a))
    }),
  )

  const cards: ScheduleEntry[] = []
  for (const d of dates) {
    const pick = picks.get(d)
    if (!pick) continue
    const st = stats.get(pick.article.id)
    cards.push({
      date: d,
      articleId: pick.article.id,
      text: byContentJson.get(pick.article.contentJson)?.text ?? '',
      translation: byContentJson.get(pick.article.contentJson)?.translation ?? '',
      isScheduled: pick.source === 'scheduled',
      isToday: d === date,
      participantCount: st?.participantCount ?? 0,
      topScore: st?.topScore ?? null,
      myBest: st?.myBest ?? null,
      myAttempts: st?.myAttempts ?? 0,
      audio: audioOf.get(pick.article.id) ?? null,
    })
  }

  const [first, ...rest] = cards
  if (!first) {
    // ⚠️ 明确的 503 而不是空对象：句库为空是**部署问题**，
    //    报成「今天没有内容」会让排查方向完全跑偏（见 db/seed-articles.ts）。
    return c.json(
      { ok: false, error: '句库为空：没有可用的句子（检查 SEED_ON_START 是否生效）' },
      503,
    )
  }

  return c.json({ ok: true, data: { date, today: first, history: rest, streak } })
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
