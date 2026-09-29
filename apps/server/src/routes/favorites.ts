import { and, eq, inArray } from 'drizzle-orm'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { normalizeLevel, normalizeTags } from '@jushuo/shared'
import type { FavoriteItem, FavoritesResponse } from '@jushuo/shared'
import { db } from '../db'
import { articles, participations } from '../db/schema'
import type { Variables } from '../middleware/auth'
import { loadArticleContent } from '../services/content'
import { favoriteIdsOf, listFavorites, setFavorite } from '../services/favorites'

/**
 * ⭐⭐ **我的收藏** —— 收/取消一个句子 + 列出收藏。
 *
 * ⚠️ 挂 /api/user/favorites 下（需鉴权）—— "需鉴权的接口全在 /api/user/* 下"
 *    是这个仓库的铁律，也是 middleware/auth.test.ts 在钉的规则。
 * ⚠️ 收藏收的是**句子**（articleId），不是某一次挑战（submissionId）——
 *    用户想的是「以后还能找到这句话」，与他当时读了几分无关。
 * ⚠️ 开关的两头都**幂等**（重复收 / 取消没收藏过的都算成功），
 *    所以端侧可以乐观更新。
 *
 * ⚠️⚠️ **OpenAPI 分组与鉴权声明**（2026-09 修）：
 *    · `tags` 是「我的」——它是**我的私有数据**，不是句库的公开内容
 *      （原来挂在「句库」下，文档上看起来像公开接口）；
 *    · 每条都写 `security: [{ userToken: [] }]` —— 与 /api/user/* 下其它接口**统一**。
 *      运行时鉴权由 index.ts 的 authMiddleware 兜住，但**文档必须自己说清楚**：
 *      漏写会让 Swagger UI 把"要带身份"的接口标成公开的（`api-contract-guard` 在钉这条）。
 */
export const favoritesRoutes = new OpenAPIHono<{ Variables: Variables }>({ defaultHook })
import { defaultHook } from '../openapi'
import {
  FavoriteListResponseSchema,
  FavoriteToggleResponseSchema,
  IsFavoriteResponseSchema,
  errorResponse,
} from '../openapi/schemas'


/** 收藏 / 取消 —— PUT 收，DELETE 取消（同一个路径，语义就是"这个开关的值"） */
const favoriteAddRoute = createRoute({
  method: 'put',
  path: '/:articleId',
  tags: ['我的'],
  summary: '收藏这一句',
  security: [{ userToken: [] }],
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
  tags: ['我的'],
  summary: '取消收藏',
  security: [{ userToken: [] }],
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
  tags: ['我的'],
  summary: '我收藏的句子（只给 id）',
  security: [{ userToken: [] }],
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

/**
 * ⭐⭐ **"这一句我收藏了吗"** —— `GET /api/user/is-favorite?articleId=`。
 *
 * ⚠️⚠️ 它**只回答这一个问题**（用户 2026-09 定），刻意**不掺进别的响应**：
 *    · 塞进 `/api/user/participation/{articleId}` 不行 —— 收藏与"参与"是两件事：
 *      **没读过也能收藏**，那时那个接口回 `data: null`，端侧只能当"没收藏"，
 *      竞技场页的按钮就会变空心（用户以为收藏丢了 —— 这是修过的 bug）；
 *    · 依附 `/api/user/arena-records` 也不行 —— 那条接口 2026-09 已经删掉，
 *      而且"我的战绩"与"收藏开关"本来就不是一份数据。
 *    ⇒ 独立一条、独立一个模块导出，谁也不欠谁。
 *
 * ⚠️ 路径为什么不是 `/api/user/favorites/{articleId}`：那是 PUT/DELETE 的**设开关**，
 *    而这里是一次**查询**；两者语义不同，混在一条路径上会让"GET 回什么"变得含糊。
 */
export const isFavoriteRoutes = new OpenAPIHono<{ Variables: Variables }>({ defaultHook })

const isFavoriteRoute = createRoute({
  method: 'get',
  path: '/is-favorite',
  tags: ['我的'],
  summary: '这一句我收藏了吗',
  security: [{ userToken: [] }],
  request: {
    query: z.object({ articleId: z.string().openapi({ description: '句子 id' }) }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: IsFavoriteResponseSchema } },
      description: '成功',
    },
    400: errorResponse('缺 articleId 参数'),
  },
})

isFavoriteRoutes.openapi(isFavoriteRoute, async (c) => {
  const userId = c.get('userId')
  const articleId = (c.req.query('articleId') ?? '').trim()
  if (!articleId) return c.json({ ok: false, error: '缺 articleId 参数' }, 400)

  /**
   * ⚠️ 复用 `favoriteIdsOf`（收藏列表也用它）—— 判据只有一处：
   *    别在这里另写一条 `select from favorites`，那种"看起来一样"的第二份实现
   *    迟早和列表口径分叉。
   */
  const ids = await favoriteIdsOf(userId, [articleId])
  return c.json({ ok: true, data: { favorited: ids.has(articleId) } }, 200)
})
