import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { eq, and, sql } from 'drizzle-orm'
import { db } from '../db'
import { articles, users } from '../db/schema'

export const articlesRoutes = new Hono()

// 获取今日推荐文章（按用户能力分推荐）
articlesRoutes.get('/today', async (c) => {
  const userId = c.get('userId') as number

  // 查询用户的能力分
  const [user] = await db
    .select({ proficiencyScore: users.proficiencyScore })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!user) {
    return c.json({ error: '用户不存在' }, 404)
  }

  const p = parseFloat(String(user.proficiencyScore))

  // 根据能力分确定推荐难度范围
  let minD: number, maxD: number
  if (p === 0) {
    minD = 1.0
    maxD = 1.5
  } else if (p < 40) {
    minD = 1.0
    maxD = 1.5
  } else if (p < 55) {
    minD = 1.0
    maxD = 2.0
  } else if (p < 70) {
    minD = 1.5
    maxD = 2.5
  } else if (p < 85) {
    minD = 2.0
    maxD = 3.5
  } else {
    minD = 2.5
    maxD = 5.0
  }

  // 查询推荐范围的文章，随机排序取 5 篇
  const result = await db
    .select()
    .from(articles)
    .where(
      and(
        eq(articles.isActive, true),
        sql`${articles.difficulty} >= ${minD}`,
        sql`${articles.difficulty} <= ${maxD}`,
      )
    )
    .orderBy(sql`RANDOM()`)
    .limit(5)

  return c.json({ articles: result })
})

// 文章列表（分页+按难度筛选）
articlesRoutes.get('/list', async (c) => {
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '10')
  const minDifficulty = c.req.query('minD')
  const maxDifficulty = c.req.query('maxD')
  const offset = (page - 1) * limit

  const conditions = [eq(articles.isActive, true)]

  if (minDifficulty) {
    conditions.push(sql`${articles.difficulty} >= ${parseFloat(minDifficulty)}`)
  }
  if (maxDifficulty) {
    conditions.push(sql`${articles.difficulty} <= ${parseFloat(maxDifficulty)}`)
  }

  const result = await db
    .select()
    .from(articles)
    .where(and(...conditions))
    .orderBy(sql`${articles.difficulty} ASC`)
    .limit(limit)
    .offset(offset)

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(articles)
    .where(and(...conditions))

  return c.json({ articles: result, total: count, page, limit })
})

// 文章详情
articlesRoutes.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'))
  if (isNaN(id)) {
    return c.json({ error: '无效的文章 ID' }, 400)
  }

  const [article] = await db
    .select()
    .from(articles)
    .where(and(eq(articles.id, id), eq(articles.isActive, true)))
    .limit(1)

  if (!article) {
    return c.json({ error: '文章不存在' }, 404)
  }

  return c.json({ article })
})