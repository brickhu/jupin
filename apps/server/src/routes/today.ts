import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { normalizeLevel, normalizeTags, today } from '@jushuo/shared'
import type { ArticleCard, TodayResponse } from '@jushuo/shared'
import { db } from '../db'
import { articles } from '../db/schema'
import type { Variables } from '../middleware/auth'
import { defaultHook } from '../openapi'
import { errorResponse, TodayResponseSchema } from '../openapi/schemas'
import { loadArticleContent } from '../services/content'
import { getArenaStatsBatch } from '../services/leaderboard'
import { recommendToday } from '../services/recommend'
import { standardAudioOf } from '../services/standard-audio-meta'

/**
 * ⭐⭐ **今日推荐** —— 首页那张"今日挑战"卡唯一的数据源。
 *
 * ⚠️⚠️ 它只回答**一件事**：「**你今天适合读哪一句**」—— 按我的参与记录分场
 *    （见 services/recommend.ts），以 24 小时为单位（`users.today_article_id`）。
 *
 * ⚠️ **「最新上线」是另一个接口**（`GET /api/articles?latest=N`，公开、对所有人一样）——
 *    用户 2026-09 明确："最新上线 和 今天挑战是两个接口"。
 *    别把两者合成一个包：一个按人、一个对所有人；一个 24 小时窗口、一个按上线时间。
 *    （它们原来是同一个 `/api/schedules` 返回的两段 —— 那条接口已整体删除。）
 *
 * ⚠️ 鉴权接口（要 userId 才能画像）⇒ 不在 middleware/auth 的公开前缀里。
 * ⚠️ 只查**一句**：正文、统计、音频各一次 —— 卡片要什么就给什么，不给榜单
 *    （榜单在竞技场详情页里，首屏不需要）。
 */
export const todayRoutes = new OpenAPIHono<{ Variables: Variables }>({ defaultHook })

/**
 * ⭐ 路由声明 —— **它就是文档的来源**（见 openapi.ts 的说明）。
 * ⚠️ 摘要写在这里：`/api/docs` 上显示的那句话就是它。
 */
const todayRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['今天挑战'],
  summary: '你今天适合读哪一句（24 小时窗口 + 按我的难度档）',
  description:
    '⚠️ 与「最新上线」（GET /api/articles）是**两个接口**：这条按人、24 小时换一次；' +
    '那条对所有人一样、按上线时间倒序。\n\n' +
    '⚠️ 窗口内**原样返回**同一句（users.today_article_id + today_assigned_at 上），' +
    '所以「读完返回首页卡片变成另一句」那个 bug 不会再发生。',
  security: [{ userToken: [] }],
  responses: {
    200: {
      content: { 'application/json': { schema: TodayResponseSchema } },
      description: '今日推荐（含我在这句上的最好成绩与挑战次数）',
    },
    500: errorResponse('推荐的句子不存在（并发删库 —— 理论上不会发生）'),
    503: errorResponse('句库为空（部署问题：检查 SEED_ON_START 是否生效）'),
  },
})

todayRoutes.openapi(todayRoute, async (c) => {
  const userId = c.get('userId')
  // ⚠️ 日期一律取服务端的（客户端时钟可改，见 shared/day.ts）——
  //    而且"同档同句"的取模要所有人算出来一样，更不能让端侧传日期
  const date = today()

  const pick = await recommendToday(userId, date)
  if (!pick) {
    // ⚠️ 与 /api/articles 同一条口径：句库为空是**部署问题**，
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
  const audio = await standardAudioOf({ id: article.id, standardAudio: article.standardAudio })

  const entry: ArticleCard = {
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

    /** ⚠️ 类型**从 schema 推**（schema 是这条接口的契约真相；shared 的 TS 类型由 schemas.ts 的双向比对盯着）*/
    const data: z.infer<typeof TodayResponseSchema>['data'] = {
    entry,
    myLevel: pick.myLevel,
    level: pick.level,
    levelBasis: pick.levelBasis,
    myBest: stats?.myBest ?? null,
    myAttempts: stats?.myAttempts ?? 0,
  }
    return c.json({ ok: true, data }, 200)
})
