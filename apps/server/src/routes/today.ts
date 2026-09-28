import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { normalizeLevel, normalizeTags, today } from '@jushuo/shared'
import type { ScheduleEntry, TodayResponse } from '@jushuo/shared'
import { db } from '../db'
import { articles } from '../db/schema'
import type { Variables } from '../middleware/auth'
import { loadArticleContent } from '../services/content'
import { getArenaStatsBatch } from '../services/leaderboard'
import { recommendToday } from '../services/recommend'
import { scheduleAudioOf } from '../services/standard-audio-meta'

/**
 * ⭐⭐ **今日推荐** —— 首页那张"今日挑战"卡唯一的数据源。
 *
 * ⚠️ 它**取代**了原来"拿排期里今天那一条当今日挑战"的做法（用户 2026-09：
 *    按天轮转对所有人推同一句"很鸡肋"）。分工现在是：
 *      · 这里       —— 「**你今天适合读哪一句**」，按我的参与记录分场（见 services/recommend.ts）
 *      · /api/schedules —— 「最新上线」（按上线时间倒序）+「这次提交记到哪一天」；
 *        它那个 today 只是端侧兜底，首页随后会用下面这个推荐替换掉
 *
 * ⚠️ 鉴权接口（要 userId 才能画像）⇒ 不在 middleware/auth 的公开前缀里。
 * ⚠️ 只查**一句**：正文、统计、音频各一次 —— 卡片要什么就给什么，不给榜单
 *    （榜单在竞技场详情页里，首屏不需要）。
 */
export const todayRoutes = new Hono<{ Variables: Variables }>()

todayRoutes.get('/', async (c) => {
  const userId = c.get('userId')
  // ⚠️ 日期一律取服务端的（客户端时钟可改，见 shared/day.ts）——
  //    而且"同档同句"的取模要所有人算出来一样，更不能让端侧传日期
  const date = today()

  const pick = await recommendToday(userId, date)
  if (!pick) {
    // ⚠️ 与 /api/schedules 同一条口径：句库为空是**部署问题**，
    //    报成"今天没有推荐"会让排查方向完全跑偏
    return c.json(
      { ok: false, error: '句库为空：没有可用的句子（检查 SEED_ON_START 是否生效）' },
      503,
    )
  }

  const [article] = await db.select().from(articles).where(eq(articles.id, pick.articleId)).limit(1)
  if (!article) {
    // recommend 是从 articles 里选的，查不到只可能是并发删库 —— 明确报错
    return c.json({ ok: false, error: '推荐的句子不存在：' + pick.articleId }, 500)
  }

  const content = await loadArticleContent(pick.articleId)
  const stats = (await getArenaStatsBatch([pick.articleId], userId)).get(pick.articleId)
  const audio = await scheduleAudioOf({ id: article.id, standardAudio: article.standardAudio })

  const entry: ScheduleEntry = {
    // ⭐ date 仍然带今天：朗读页要用它把这次提交记到哪一天
    date,
    articleId: article.id,
    text: content?.text ?? '',
    translation: content?.translation ?? '',
    // ⚠️ 老内容可能没有难度 / 标签 ⇒ 一律过规范化，认不出就是 null / []
    difficulty: normalizeLevel(content?.difficulty),
    tags: normalizeTags(content?.tags),
    audio,
    isToday: true,
    participantCount: stats?.participantCount ?? 0,
    topScore: stats?.topScore ?? null,
    lowestScore: stats?.lowestScore ?? null,
    theme: article.theme,
  }

  const data: TodayResponse = {
    entry,
    myLevel: pick.myLevel,
    level: pick.level,
    levelBasis: pick.levelBasis,
    myBest: stats?.myBest ?? null,
    myAttempts: stats?.myAttempts ?? 0,
  }
  return c.json({ ok: true, data })
})
