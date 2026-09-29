import { and, eq, inArray } from 'drizzle-orm'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { normalizeLevel, normalizeTags } from '@jushuo/shared'
import type { FavoriteItem, FavoritesResponse } from '@jushuo/shared'
import { db } from '../db'
import { articles, participations } from '../db/schema'
import type { Variables } from '../middleware/auth'
import { loadArticleContent } from '../services/content'
import { listFavorites, setFavorite } from '../services/favorites'

/**
 * ⭐⭐ **我的收藏** —— 收/取消一个句子 + 列出收藏。
 *
 * ⚠️ 挂 /api/user/favorites 下（需鉴权）—— "需鉴权的接口全在 /api/user/* 下"
 *    是这个仓库的铁律，也是 middleware/auth.test.ts 在钉的规则。
 * ⚠️ 收藏收的是**句子**（articleId），不是某一次挑战（submissionId）——
 *    用户想的是「以后还能找到这句话」，与他当时读了几分无关。
 * ⚠️ 开关的两头都**幂等**（重复收 / 取消没收藏过的都算成功），
 *    所以端侧可以乐观更新。
 */
export const favoritesRoutes = new OpenAPIHono<{ Variables: Variables }>({ defaultHook })
import { defaultHook } from '../openapi'
import {
  FavoriteListResponseSchema,
  FavoriteToggleResponseSchema,
  errorResponse,
} from '../openapi/schemas'


/** 收藏 / 取消 —— PUT 收，DELETE 取消（同一个路径，语义就是"这个开关的值"） */
const favoriteAddRoute = createRoute({
  method: 'put',
  path: '/:articleId',
  tags: ['句库'],
  summary: '收藏这一句',
  request: { params: z.object({ articleId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: FavoriteToggleResponseSchema } },
      description: '成功',
    },
    400: errorResponse('articleId 不合法'),
    404: errorResponse('句子不存在'),
  },
})

favoritesRoutes.openapi(favoriteAddRoute, async (c) => {
  const userId = c.get('userId')
  const articleId = c.req.param('articleId')
  if (!articleId) return c.json({ ok: false, error: 'articleId 不合法' }, 400)

  // ⚠️ 收藏前先确认这句**真的存在**：否则收藏表里会攒下一堆指向不存在句子的行，
  //    而列表页渲染时才发现读不到正文（症状是"收藏里有一条空白"）
  const [row] = await db.select({ id: articles.id }).from(articles).where(eq(articles.id, articleId)).limit(1)
  if (!row) return c.json({ ok: false, error: '这一句不存在' }, 404)

  await setFavorite(userId, articleId, true)
  return c.json({ ok: true, data: { articleId, favorited: true } }, 200)
})

const favoriteRemoveRoute = createRoute({
  method: 'delete',
  path: '/:articleId',
  tags: ['句库'],
  summary: '取消收藏',
  request: { params: z.object({ articleId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: FavoriteToggleResponseSchema } },
      description: '成功',
    },
    400: errorResponse('articleId 不合法'),
  },
})

favoritesRoutes.openapi(favoriteRemoveRoute, async (c) => {
  const userId = c.get('userId')
  const articleId = c.req.param('articleId')
  if (!articleId) return c.json({ ok: false, error: 'articleId 不合法' }, 400)

  await setFavorite(userId, articleId, false)
  return c.json({ ok: true, data: { articleId, favorited: false } }, 200)
})

/**
 * 收藏列表。
 * ⚠️ 正文按 id 读（真相在 content/articles/*.json），库里那行只给主题；
 *    难度 / 标签也是**正文的属性**（articles 表只是索引）。
 * ⚠️ 我的战绩从**参与记录**取（一人一句一行），与竞技场卡片同一口径。
 */
const favoriteListRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['句库'],
  summary: '我收藏的句子（只给 id）',
  responses: {
    200: {
      content: { 'application/json': { schema: FavoriteListResponseSchema } },
      description: '成功',
    },
  },
})

favoritesRoutes.openapi(favoriteListRoute, async (c) => {
  const userId = c.get('userId')
  const refs = await listFavorites(userId)
  if (refs.length === 0) return c.json({ ok: true, data: { items: [] } }, 200)

  const ids = refs.map((r) => r.articleId)
  const [metaRows, mineRows] = await Promise.all([
    db
      .select({ id: articles.id, theme: articles.theme })
      .from(articles)
      .where(inArray(articles.id, ids)),
    /**
     * ⚠️⚠️ `eq(participations.userId, userId)` **不能少**（2026-09 修）。
     *
     * 参与记录是「一人一句一行」⇒ 只按 articleId 查会把这句**所有人**的行都捞回来，
     * 而下面 `new Map(...)` 按 articleId 后写覆盖 ⇒ `mine.get(id)` 拿到的是**别人**的
     * 最高分与次数 —— 收藏列表于是把别人的成绩当我的显示，界面上完全看不出来。
     * （"我的战绩"这四个字是这段代码唯一的判据，注释说对没用，where 才是。）
     */
    db
      .select({
        articleId: participations.articleId,
        best: participations.bestScore,
        attempts: participations.attempts,
      })
      .from(participations)
      .where(and(eq(participations.userId, userId), inArray(participations.articleId, ids))),
  ])
  const meta = new Map(metaRows.map((r) => [r.id, r]))
  const mine = new Map(mineRows.map((r) => [r.articleId, r]))

  const items: FavoriteItem[] = []
  for (const ref of refs) {
    const content = await loadArticleContent(ref.articleId)
    const m = meta.get(ref.articleId)
    const my = mine.get(ref.articleId)
    items.push({
      articleId: ref.articleId,
      text: content?.text ?? '',
      translation: content?.translation ?? '',
      // ⚠️ 老内容可能没有难度 / 标签 ⇒ 规范化后就是 null / []，不补默认档位
      difficulty: normalizeLevel(content?.difficulty),
      tags: normalizeTags(content?.tags),
      theme: m?.theme ?? null,
      favoritedAt: ref.favoritedAt.toISOString(),
      bestScore: my ? Number(my.best) : null,
      attempts: my ? Number(my.attempts) : 0,
    })
  }

  const data: FavoritesResponse = { items }
  return c.json({ ok: true, data }, 200)
})
