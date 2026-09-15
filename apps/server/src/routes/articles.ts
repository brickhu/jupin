import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { articles } from '../db/schema'
import { getLeaderboardAround, getRank } from '../services/leaderboard'
import type { Variables } from '../middleware/auth'

export const articlesRoutes = new Hono<{ Variables: Variables }>()

/**
 * 朗读单元索引。
 * ⚠️ 正文 / 词级数据 / 技巧**不从这里返回** —— 它们在 contentJson / tipsJson 指向的静态 JSON 里，
 *    客户端拿到索引后自己去 CDN 拉。这里只给库里的元数据（难度 / 分类 / 竞技统计）。
 */
articlesRoutes.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [article] = await db.select().from(articles).where(eq(articles.id, id)).limit(1)
  if (!article) return c.json({ ok: false, error: '文章不存在' }, 404)
  return c.json({ ok: true, data: article })
})

/** 榜单：榜心 5 条 + 我的排名，一次查询 */
articlesRoutes.get('/:id/leaderboard', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = c.get('userId')
  const rows = await getLeaderboardAround(id, userId)
  const me = rows.find((r) => r.isMe)
  const rankInfo = me ? await getRank(id, userId) : null
  return c.json({ ok: true, data: { rows, rankInfo } })
})
