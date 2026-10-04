import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { Variables } from '../middleware/auth'
import { defaultHook } from '../openapi'
import { errorResponse, ParticipationRecordResponseSchema } from '../openapi/schemas'
import { participationRecordById } from '../services/participations'

/**
 * ⭐⭐ **参与详情（公开）** —— `GET /api/participation/{id}`
 *
 * ⚠️ `{id}` 就是 **`participations.id`** —— 一个**派生**的对外地址：
 *    `sha256(userId + ':' + articleId)` 的前 24 位十六进制（见 db/schema.ts 与迁移 0057）。
 *
 * ⚠️⚠️ 为什么不是自增 id：这张表是**重算式**派生索引（rebuildParticipations 会整表重建）——
 *    自增 id 一重建就换号，已经发出去的链接会指到别人身上。
 *    哈希出来的值**重建前后逐行相等**，这正是"重建前后必须一模一样"那条验收判据要的。
 *
 * ⚠️ **公开**，理由与榜单一致：分数 / 次数 / 名次本来就公开（见 routes/leaderboards.ts）；
 *    这里多给的 `words` / `links` 是**句子本身的快照**，不是这个人的隐私。
 *
 * ⚠️ 取数只走 `participationRecordById`（与 `/api/user/participation/{articleId}` 共用
 *    `toParticipationRecord` + `getRank`）—— 保证"从榜单点进来"看到的数就是榜上那一行的数。
 */
export const participationRoutes = new OpenAPIHono<{ Variables: Variables }>({ defaultHook })

const detailRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['参与'],
  summary: '某位用户在某一句上的参与详情（公开）',
  description:
    '⚠️ `{id}` = **`participations.id`**（派生地址：`sha256(userId + \':\' + articleId)` 前 24 位）。\n' +
    '它是**稳定的** —— 整表重建后不变，所以链接可以放心发出去。\n\n' +
    '⚠️ 没参与过 ⇒ `data` 为 **null**（不是 404、也不是一条全 0 的假记录）——\n' +
    '与 `GET /api/user/participation/{articleId}` 同一套语义：0 分是合法成绩，\n' +
    '把「没挑战过」显示成「最高 0 分」是错的。\n' +
    '⚠️ 用户 id 不是正整数 ⇒ 404。',
  request: {
    params: z.object({
      id: z.string().openapi({ description: '参与记录的地址 = participations.id（24 位十六进制）' }),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ParticipationRecordResponseSchema } },
      description: '成功（这一句没参与过时 `data` 为 null）',
    },
    404: errorResponse('地址形状不对（不是 24 位十六进制）'),
  },
})

participationRoutes.openapi(detailRoute, async (c) => {
  const id = c.req.param('id')

  // ⚠️ 先按形状挡一道（24 位十六进制）就别去查库 —— 顺手也挡住"拿别人的东西当 id 试"的杂音
  if (!/^[0-9a-f]{24}$/.test(id)) {
    return c.json({ ok: false as const, error: '这个参与记录不存在' }, 404)
  }

  const record = await participationRecordById(id)
  return c.json({ ok: true as const, data: record }, 200)
})
