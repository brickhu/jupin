import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { normalizeLevel, normalizeTags, today } from '@jushuo/shared'
import type { ArticleLevel, ArticleTheme, ScheduleAudio, ScheduleEntry, ScheduleDetail } from '@jushuo/shared'
import { db } from '../db'
import { articles, schedules } from '../db/schema'
import { loadArticleContent } from '../services/content'
import { ensureSchedules, scheduleAhead } from '../services/schedules'
import { scheduleAudioOf } from '../services/standard-audio-meta'
import { pickLatestArticles } from '../services/schedule-shape'
import { getArenaStatsBatch, getTopLeaderboard } from '../services/leaderboard'
import { MAX_BACKFILL_DAYS, resolveScheduleDate } from '../services/schedule-date'
import type { Variables } from '../middleware/auth'

export const schedulesRoutes = new Hono<{ Variables: Variables }>()

/** ⭐ 最新上线默认列几条 —— 首页只放 6 条，够了（2026-09 定的 N 取 6 左右） */
const DEFAULT_LATEST = 6
/** 上限 —— 别让一个查询参数把整张表捞出来 */
const MAX_LATEST = 50

/*
 * ⭐ 每日挑战列表 —— 首页那**一次**请求就够了。
 *
 * ⚠️ 刻意把「今天 + 最新上线 + streak」打成一个包：
 *    做减法之后首页就是这一页列表，拆成多个请求只会让首屏出现几段先后到达的空白。
 *
 * ⚠️ 日期一律取服务端的（见 @jushuo/shared/day.ts）——
 *    客户端时钟可改，让本地算「今天」必然出现「本地显示已打卡、服务端不认」。
 *
 * ⚠️⚠️ **两段数据来自两个不同的地方**，别再合起来当成一个列表：
 *    · today  —— 走**排期**：今天那一条（没有排期会自动补一行 rotation）。
 *                ⚠️ 它只是端侧的**兜底**：首页拿到 /api/user/today 之后会用
 *                「按我个人 24 小时窗口推荐的那一句」把它换掉（鉴权接口）。
 *    · latest —— 走**句库**：按 articles.published_at（上线时间）倒序的最新 N 句，
 *                并剔除与今日那张卡重复的那一句。
 *    以前这里叫 history / 按排期日期倒序 —— 那是**上一版口径**，
 *    用户 2026-09 改成了「最新上线的句子」，所以字段名一并改成 latest
 *    （旧名字留着只会让人以为它还是按日期取的历史）。
 */
schedulesRoutes.get('/', async (c) => {
  const date = today()

  const requested = Number(c.req.query('latest'))
  // ⚠️ NaN 也要兜住：?latest=abc 会让 Math.min 返回 NaN，随后一条都不返回，
  //    表现出来是「最新空空」，而真正的原因是一个畸形参数。
  const limit = Number.isFinite(requested)
    ? Math.min(MAX_LATEST, Math.max(1, Math.trunc(requested)))
    : DEFAULT_LATEST

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
   * ② 最新上线：走**句库**（articles 表），不是排期表。
   *
   * ⚠️⚠️ 理由在 db/schema.ts 里写着：排期「**不是竞技单位，只是一个按日组织的
   *    展示层**」，竞技数据的单位永远是**句子**（排名/人数/最高分全按 article_id 查）。
   *    ⇒ 首页下半段要列的是「句库里**最新上线**的句子」，不是「过去哪几天排过」。
   *
   * ⚠️⚠️ **排序键是 articles.published_at（上线时间），不是 id、也不是排期日期。**
   *    用户 2026-09 定的口径：这一段要回答「最近有什么新句子可以读」。
   *    id 是内容 hash、不编码新旧；排期日期答的是「运营曾把它排给哪天」。
   *    两者都不是「什么时候上的线」，所以都换了。
   *    ⚠️ published_at 可能为 null（老数据）→ 由 pickLatestArticles 用 createdAt 兜底，
   *       理由写在那里。
   *
   * ⚠️ 每个句子点进去走的是**按句子寻址**的 arena 路由（/api/arenas/:articleId），
   *    所以这里既不需要「它最近排在哪天」，也不需要「必须排过期的才列」。
   *    挑选规则在 services/schedule-shape.ts（有单测）。
   */
  const candidateRows = await db
    .select({
      articleId: articles.id,
      standardAudio: articles.standardAudio,
      theme: articles.theme,
      // ⚠️ 排序键的两列：publishedAt 优先，为空时用 createdAt 兜底（见 pickLatestArticles）
      publishedAt: articles.publishedAt,
      createdAt: articles.createdAt,
    })
    .from(articles)
    .where(eq(articles.isActive, true))
  /**
   * ⚠️ 排序**不放在 SQL 的 order by 里**：published_at 为 null 时 MySQL 的 NULL 排序
   *    与「用 createdAt 兜底」的业务语义对不上。统一交给纯函数排，规则可单测。
   */
  const latestRows = pickLatestArticles(candidateRows, todayPick.article.id, limit)

  /** 今日 + 历史涉及的全部句子 —— 统计/正文/音频都按句子算一次 */
  const articleById = new Map<
    string,
    { id: string; standardAudio: string | null; theme: ArticleTheme | null }
  >()
  articleById.set(todayPick.article.id, {
    id: todayPick.article.id,
    standardAudio: todayPick.article.standardAudio,
    theme: todayPick.article.theme,
  })
  for (const c of latestRows) {
    articleById.set(c.articleId, {
      id: c.articleId,
      standardAudio: c.standardAudio,
      theme: c.theme,
    })
  }
  const articleIds = [...articleById.keys()]
  // ⚠️ 公开接口：只取公开统计（参与人数 / 最高分）。第二个参数 0 = 匿名，
  //    不会去查「我的最好成绩」—— 那走鉴权接口 /api/user/arena-records。
  const stats = await getArenaStatsBatch(articleIds, 0)

  // ⚠️ 正文按**文章 id**去重后一次性读（id 就是内容 hash，同内容必然同 id）
  // ⚠️ 这里的 type 必须与 loadArticleContent 的解析口径一致：
  //    难度 / 标签是**正文的属性**，跟正文一起读、一起缓存，不再单独查库
  //    （articles 表只是索引，见 db/schema.ts）。
  const byArticleId = new Map<
    string,
    { text: string; translation: string; difficulty: ArticleLevel | null; tags: string[] }
  >()
  for (const id of articleIds) {
    const a = articleById.get(id)
    if (a) byArticleId.set(a.id, { text: '', translation: '', difficulty: null, tags: [] })
  }
  await Promise.all(
    [...byArticleId.keys()].map(async (articleId) => {
      const content = await loadArticleContent(articleId)
      byArticleId.set(articleId, {
        text: content?.text ?? '',
        translation: content?.translation ?? '',
        // ⚠️ 内容可能比代码旧（CDN 上的老 JSON 没有这些字段）⇒ 一律过规范化，
        //    认不出就是 null / []，**不补默认档位**（见 shared/level.ts）
        difficulty: normalizeLevel(content?.difficulty),
        tags: normalizeTags(content?.tags),
      })
    }),
  )

  /**
   * ⭐ 标准音（含时长）按**句子**算一次。
   * ⚠️ 时长是读 content/audio/*.mp3 现算的（容器里没有 ffprobe），
   *    进程内缓存；算不出来是 null ⇒ 端侧只显示按钮、不显示时长。
   */
  const audioOf = new Map<string, ScheduleAudio | null>()
  await Promise.all(
    articleIds.map(async (id) => {
      const a = articleById.get(id)
      if (!a) return
      audioOf.set(id, await scheduleAudioOf({ id: a.id, standardAudio: a.standardAudio }))
    }),
  )

  /** 卡片里与「哪一天」无关的那部分 —— 今日和历史共用 */
  const commonOf = (articleId: string): Omit<ScheduleEntry, 'articleId'> | null => {
    const st = stats.get(articleId)
    const c = byArticleId.get(articleId)
    return {
      text: c?.text ?? '',
      translation: c?.translation ?? '',
      // ⭐ 难度 / 标签跟正文一起走，卡片与详情页共用同一份口径
      difficulty: c?.difficulty ?? null,
      tags: c?.tags ?? [],
      participantCount: st?.participantCount ?? 0,
      topScore: st?.topScore ?? null,
      audio: audioOf.get(articleId) ?? null,
      theme: articleById.get(articleId)?.theme ?? null,
    }
  }

  /**
   * ⭐ 今日那一张：**只有它有**日期 / 是不是运营排的 / 是不是今天
   *    （「日期只是编辑精选的容器」，这三个字段描述的正是那个容器）。
   */
  const todayArticle = todayPick.article
  const common = commonOf(todayArticle.id)
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
   * ⭐ 最新上线卡片：来自**句库**，与「哪一天」无关 —— 所以一个日期字段都不带。
   *    点进去走按句子寻址的 arena（/api/arenas/:articleId）。
   *    ⚠️ 内容查不到的句子直接丢掉（理论上不会，取数时正文一定能按 id 读到）。
   */
  const latest: ScheduleEntry[] = []
  for (const row of latestRows) {
    const c = commonOf(row.articleId)
    if (!c) continue
    latest.push({ articleId: row.articleId, ...c })
  }

  return c.json({ ok: true, data: { date, today: todayCard, latest } })
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
  const content = await loadArticleContent(articleId)
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
    difficulty: normalizeLevel(content?.difficulty),
    tags: normalizeTags(content?.tags),
    isScheduled: pick.source === 'scheduled',
    isToday: date === now,
    participantCount: stats?.participantCount ?? 0,
    topScore: stats?.topScore ?? null,
    theme: pick.article.theme,
    leaderboard,
  }
  return c.json({ ok: true, data: detail })
})
