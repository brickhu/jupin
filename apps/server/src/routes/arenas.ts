import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { arenas } from '../db/schema'
import { getLeaderboardAround, getRank } from '../services/leaderboard'
import type { Variables } from '../middleware/auth'

export const arenasRoutes = new Hono<{ Variables: Variables }>()

/**
 * ⚠️ 竞技场正文与词级数据**不从这里返回**，走 CDN 静态资源。
 *    这里只返回库里的元数据（星级、人数、预期时长）。
 */
arenasRoutes.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [arena] = await db.select().from(arenas).where(eq(arenas.id, id)).limit(1)
  if (!arena) return c.json({ ok: false, error: '竞技场不存在' }, 404)
  return c.json({ ok: true, data: arena })
})

/** 榜单：只返回「榜心 5 条 + 人数 + 我的排名」，一次查询，数据量极小 */
arenasRoutes.get('/:id/leaderboard', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = c.get('userId')
  const rows = await getLeaderboardAround(id, userId)
  const me = rows.find((r) => r.isMe)
  const rankInfo = me ? await getRank(id, me.score) : null
  return c.json({ ok: true, data: { rows, rankInfo } })
})
