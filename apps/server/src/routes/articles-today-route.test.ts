import { OpenAPIHono } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'

import { articlesRoutes } from './articles'

/**
 * ⭐⭐ **`/api/articles/today` 不许被 `/{id}` 吃掉**。
 *
 * ⚠️⚠️ 为什么单独一条测试：Hono 对**同前缀**的路由是**按注册顺序**匹配的
 *    （实测：先注册 `/{id}` 的话，`/today` 会命中详情 handler，`id` 变成字面量
 *    "today" ⇒ 404 / 500，而**不是** 400）。
 *    routes/articles.ts 里 today 路由必须排在详情之前 —— 谁把它挪下去，这条会红。
 *
 * ⚠️ 判据选「畸形 uid → 400 INVALID_REQUEST」而不是"匿名 200"，是为了**不连库**：
 *    400 由 createRoute 的 query 校验在 handler 之前给出；
 *    若被详情路由吃掉，走的会是 db 查询（测试环境里报 500 或 404，反正不是 400）。
 */
describe('句库路由 —— /today 静态段优先于 /{id}', () => {
  it('畸形 uid 落到 today 的校验（400），没有被详情路由当成 id="today"', async () => {
    const app = new OpenAPIHono()
    app.route('/api/articles', articlesRoutes)

    const res = await app.request('/api/articles/today?uid=abc')
    expect(res.status).toBe(400)

    const body = (await res.json()) as { ok?: boolean; code?: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('INVALID_REQUEST')
  })
})
