import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { Variables } from '../middleware/auth'
import { defaultHook } from '../openapi'
import { UserListResponseSchema, errorResponse } from '../openapi/schemas'
import { clampLimit } from '../services/article-list'
import { DEFAULT_USER_LIMIT, listUsers, MAX_USER_LIMIT } from '../services/user-list'

/**
 * ⭐⭐ **用户目录**（`GET /api/users`）—— 通用查询接口。
 *
 * ⚠️⚠️ 注意前缀：这是 **`/api/users`（复数）**，与鉴权命名空间
 *    `/api/user/*`（单数，`app.use('/api/user/*', authMiddleware)`）**不是同一个**。
 *    实测 Hono 的 `/api/user/*` 不会兜住 `/api/users` —— 所以这条**必须自己说明**
 *    它是不是公开的（这里：公开，见下），否则就是"以为守住了，其实没有"。
 *
 * ⚠️⚠️ 它**公开、且返回 energy**：用户 2026-09 明确要求。
 *    这**不改变** `/api/profile/:id`「能量只给本人」那条边界（见 shared 的 UserSummary）。
 *
 * 参数：
 *   · `sort`  `joined`（默认，加入时间倒序）| `energy`（能量倒序）
 *   · `limit` 1..100，默认 50
 */
export const usersRoutes = new OpenAPIHono<{ Variables: Variables }>({ defaultHook })

const listUsersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['用户'],
  summary: '用户目录（按加入时间 / 能量排序）',
  description:
    '⚠️ 公开接口，**含 energy**（用户 2026-09 明确要求）。\n\n' +
    '· `sort`：`joined`（默认，加入时间倒序）| `energy`（能量倒序）\n' +
    '· `limit`：1..100，默认 50\n\n' +
    '每一项除了身份（id / 昵称 / 头像 / 加入时间）与 energy，还带四个战绩：\n' +
    '`conqueredCount`（参与次数 = 参与场次，一句一场）、`challengedRounds`（挑战回合）、\n' +
    '`streakDays`（连战天数）、`growth`（成长值三项，不合成总分）。\n\n' +
    '⚠️ 只列正常账号（banned / deleted 不出现）。\n' +
    '⚠️ 「能量只给本人」那条边界没有变：`/api/profile/{id}` 仍不给别人的能量。',
  request: {
    query: z.object({
      sort: z.enum(['joined', 'energy']).optional().openapi({
        description: 'joined（默认，加入时间倒序）| energy（能量倒序）',
      }),
      limit: z.string().optional().openapi({ description: '1..100，默认 50' }),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: UserListResponseSchema } },
      description: '成功',
    },
    400: errorResponse('sort / limit 不合法'),
  },
})

usersRoutes.openapi(listUsersRoute, async (c) => {
  const q = c.req.valid('query')
  const items = await listUsers({
    sort: q.sort ?? 'joined',
    // ⚠️ 与句库查询共用同一个收窄实现：`?limit=abc` 兜到默认值，而不是 NaN 让查询返回空
    limit: clampLimit(q.limit, DEFAULT_USER_LIMIT, MAX_USER_LIMIT),
  })
  return c.json({ ok: true, data: { items } }, 200)
})
