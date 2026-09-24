import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { normalizeLevel, normalizeTags, today } from '@jushuo/shared'
import type { ArenaDetail } from '@jushuo/shared'

import { db } from '../db'
import { articles } from '../db/schema'
import type { Variables } from '../middleware/auth'
import { loadArticleContent } from '../services/content'
import { getArenaStatsBatch, getTopLeaderboard } from '../services/leaderboard'

/**
 * ⭐⭐ 竞技场详情 —— **按句子**寻址。
 *
 * ⚠️⚠️ 这才是竞技场的正经地址，理由写在 db/schema.ts 里：
 *    排期「**不是竞技单位，只是一个按日组织的展示层**」，
 *    而「日期只是一个编辑精选的容器，和竞技场无关」。
 *    排名 / 参与人数 / 最高分 / 我的最好成绩，全部按 article_id 查。
 *
 * ⚠️ 与 GET /api/schedules/:date 的分工：
 *    · 这个：`我看这一句的竞技场` —— 挑战它算**今天**
 *    · 那个：`回到某一天的挑战再读一次` —— 挑战它算**那一天**
 *      （历史挑战的「再次挑战」必须归到那一天，否则昨天那张卡片的数字会变）
 *
 * ⚠️ 不校验 isActive：下架只是「不再排进每日挑战」，它的竞技场与成绩还在，
 *    用户从自己的参与记录点进来仍应看得到。
 */
export const arenasRoutes = new Hono<{ Variables: Variables }>()

arenasRoutes.get('/:articleId', async (c) => {
  /** ⭐ 句子 id = 内容 hash（字符串），不再有「正整数」这一层校验 */
  const articleId = c.req.param('articleId')
  if (!articleId) {
    return c.json({ ok: false, error: 'articleId 不合法' }, 400)
  }

  const [article] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1)
  if (!article) return c.json({ ok: false, error: '这一句不存在' }, 404)

  const content = await loadArticleContent(article.id)
  // ⚠️ 公开接口：统计与榜单都传 0（匿名）—— 榜单里不标「你」
  const [stats, leaderboard] = await Promise.all([
    getArenaStatsBatch([articleId], 0).then((m) => m.get(articleId)),
    getTopLeaderboard(articleId, 0),
  ])

  /** ⚠️ 服务端的今天 —— 端侧手机时钟可以随便改（同 shared/day.ts 的口径） */
  const submissionDate = today()

  const detail: ArenaDetail = {
    articleId,
    text: content?.text ?? '',
    translation: content?.translation ?? '',
    // ⭐ 两个档位 / 标签都是正文的属性；内容里没写 ⇒ null / []（不补默认档位）
    pronLevel: normalizeLevel(content?.pronLevel),
    vocabLevel: normalizeLevel(content?.vocabLevel),
    tags: normalizeTags(content?.tags),
    // ⭐ 按句子进来的挑战算**今天**（用户在读，就是今天这一句）
    submissionDate,
    isToday: true,
    participantCount: stats?.participantCount ?? 0,
    topScore: stats?.topScore ?? null,
    theme: article.theme,
    leaderboard,
  }
  return c.json({ ok: true, data: detail })
})
