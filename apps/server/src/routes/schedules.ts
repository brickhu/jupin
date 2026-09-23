import { Hono } from 'hono'
import { desc, eq, lt } from 'drizzle-orm'
import { normalizeDifficulty, normalizeTags, today } from '@jushuo/shared'
import type { ArticleDifficulty, ScheduleAudio, ScheduleEntry, ScheduleDetail } from '@jushuo/shared'
import { db } from '../db'
import { articles, schedules } from '../db/schema'
import { loadArticleContent } from '../services/content'
import { ensureSchedules, scheduleAhead } from '../services/schedules'
import { scheduleAudioOf } from '../services/standard-audio-meta'
import { pickHistoryArticles } from '../services/schedule-shape'
import { getArenaStatsBatch, getTopLeaderboard } from '../services/leaderboard'
import { MAX_BACKFILL_DAYS, resolveScheduleDate } from '../services/schedule-date'
import type { Variables } from '../middleware/auth'

export const schedulesRoutes = new Hono<{ Variables: Variables }>()

/** ⭐ 历史挑战默认列几条（**竞技场数**，不是天数）—— 首页只放 5 条，够了 */
const DEFAULT_HISTORY = 5
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
   * ② 历史：走**句库**（articles 表），不是排期表。
   *
   * ⚠️⚠️ 理由在 db/schema.ts 里写着：排期「**不是竞技单位，只是一个按日组织的
   *    展示层**」，竞技数据的单位永远是**句子**（排名/人数/最高分全按 article_id 查）。
   *    ⇒ 首页下半段要列的是「句库里还有哪些竞技场」，不是「过去哪几天排过」。
   *
   * ⚠️ 每个句子点进去走的是**按句子寻址**的 arena 路由（/api/arenas/:articleId），
   *    所以这里既不需要「它最近排在哪天」，也不需要「必须排过期的才列」。
   *    挑选规则在 services/schedule-shape.ts（有单测）。
   */
  const candidateRows = await db
    .select({
      articleId: articles.id,
      contentJson: articles.contentJson,
      standardAudio: articles.standardAudio,
    })
    .from(articles)
    .where(eq(articles.isActive, true))
    .orderBy(desc(articles.id))
  /**
   * ⚠️ **不再要求「排过期」**：arena 页现在按句子寻址（/api/arenas/:articleId），
   *    所以刚上线、还没轮到过的新句也能直接点进去看它的竞技场（当时是空的）。
   *    （这一条以前是个真实限制：新句要等第一次排期过去才出现。）
   */
  const historyRows = pickHistoryArticles(candidateRows, todayPick.article.id, limit)

  /** 今日 + 历史涉及的全部句子 —— 统计/正文/音频都按句子算一次 */
  const articleById = new Map<
    number,
    { id: number; contentJson: string; standardAudio: string | null }
  >()
  articleById.set(todayPick.article.id, {
    id: todayPick.article.id,
    contentJson: todayPick.article.contentJson,
    standardAudio: todayPick.article.standardAudio,
  })
  for (const c of historyRows) {
    articleById.set(c.articleId, {
      id: c.articleId,
      contentJson: c.contentJson,
      standardAudio: c.standardAudio,
    })
  }
  const articleIds = [...articleById.keys()]
  // ⚠️ 公开接口：只取公开统计（参与人数 / 最高分）。第二个参数 0 = 匿名，
  //    不会去查「我的最好成绩」—— 那走鉴权接口 /api/user/arena-records。
  const stats = await getArenaStatsBatch(articleIds, 0)

  // ⚠️ 正文按 contentJson 去重后一次性读：轮转池只有几句，反复出现同一条内容
  // ⚠️ 这里的 type 必须与 loadArticleContent 的解析口径一致：
  //    难度 / 标签是**正文的属性**，跟正文一起读、一起缓存，不再单独查库
  //    （articles 表只是索引，见 db/schema.ts）。
  const byContentJson = new Map<
    string,
    { text: string; translation: string; difficulty: ArticleDifficulty | null; tags: string[] }
  >()
  for (const id of articleIds) {
    const a = articleById.get(id)
    if (a) byContentJson.set(a.contentJson, { text: '', translation: '', difficulty: null, tags: [] })
  }
  await Promise.all(
    [...byContentJson.keys()].map(async (key) => {
      const content = await loadArticleContent(key)
      byContentJson.set(key, {
        text: content?.text ?? '',
        translation: content?.translation ?? '',
        // ⚠️ 内容可能比代码旧（CDN 上的老 JSON 没有这两个字段）⇒ 一律过规范化，
        //    认不出就是 null / []，**不补默认档位**（见 shared/difficulty.ts）
        difficulty: normalizeDifficulty(content?.difficulty),
        tags: normalizeTags(content?.tags),
      })
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

  /** 卡片里与「哪一天」无关的那部分 —— 今日和历史共用 */
  const commonOf = (articleId: number, contentJson: string): Omit<ScheduleEntry, 'articleId'> | null => {
    const st = stats.get(articleId)
    const c = byContentJson.get(contentJson)
    return {
      text: c?.text ?? '',
      translation: c?.translation ?? '',
      // ⭐ 难度 / 标签跟正文一起走，卡片与详情页共用同一份口径
      difficulty: c?.difficulty ?? null,
      tags: c?.tags ?? [],
      participantCount: st?.participantCount ?? 0,
      topScore: st?.topScore ?? null,
      audio: audioOf.get(articleId) ?? null,
    }
  }

  /**
   * ⭐ 今日那一张：**只有它有**日期 / 是不是运营排的 / 是不是今天
   *    （「日期只是编辑精选的容器」，这三个字段描述的正是那个容器）。
   */
  const todayArticle = todayPick.article
  const common = commonOf(todayArticle.id, todayArticle.contentJson)
  if (!common) {
    return c.json({ ok: false, error: '今天的排期指向了不存在的句子' }, 503)
  }
  const todayCard: ScheduleEntry = {
    date,
    articleId: todayArticle.id,
    isScheduled: todayPick.source === 'scheduled',
    isToday: true,
    ...common,
  }

  /**
   * ⭐ 历史卡片：来自**句库**，与「哪一天」无关 —— 所以一个日期字段都不带。
   *    点进去走按句子寻址的 arena（/api/arenas/:articleId）。
   *    ⚠️ 内容查不到的句子直接丢掉（理论上不会，取数时已经带了 contentJson）。
   */
  const history: ScheduleEntry[] = []
  for (const row of historyRows) {
    const c = commonOf(row.articleId, row.contentJson)
    if (!c) continue
    history.push({ articleId: row.articleId, ...c })
  }

  return c.json({ ok: true, data: { date, today: todayCard, history } })
})

/**
 * ⭐ 单个挑战的详情 —— 从首页卡片点进来。
 *
 * ⚠️ 与列表的分工：列表给「一眼扫过去」，详情给「看进去」：
 *    · 列表只有统计数字，详情有**完整榜单**（谁在前、谁是自己）
 *    · 列表不带「我的名次」（7 天各算一次名次太贵），详情只算一天，随便算
 */
schedulesRoutes.get('/:date', async (c) => {
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
  // ⚠️ 公开接口：统计与榜单都传 0（匿名）
  const [stats, leaderboard] = await Promise.all([
    getArenaStatsBatch([articleId], 0).then((m) => m.get(articleId)),
    getTopLeaderboard(articleId, 0),
  ])

  const detail: ScheduleDetail = {
    date,
    // ⚠️ 按日期进来 = 「回到那一天再挑战一次」⇒ 归到那一天
    submissionDate: date,
    articleId: pick.article.id,
    text: content?.text ?? '',
    translation: content?.translation ?? '',
    difficulty: normalizeDifficulty(content?.difficulty),
    tags: normalizeTags(content?.tags),
    isScheduled: pick.source === 'scheduled',
    isToday: date === now,
    participantCount: stats?.participantCount ?? 0,
    topScore: stats?.topScore ?? null,
    leaderboard,
  }
  return c.json({ ok: true, data: detail })
})
