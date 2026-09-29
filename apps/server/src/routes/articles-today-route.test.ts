import { OpenAPIHono } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'

import { articlesRoutes } from './articles'

/**
 * ⭐⭐ **静态段路由（`/latest` / `/today`）不许被 `/{id}` 吃掉**。
 *
 * ⚠️⚠️ 为什么单独一条测试：Hono 对**同前缀**的路由是**按注册顺序**匹配的
 *    （实测：先注册 `/{id}` 的话，`/latest`、`/today` 会命中详情 handler，
 *    `id` 变成字面量 "latest" / "today" ⇒ 404 / 500）。
 *    routes/articles.ts 里这两条必须排在 `/{id}` 之前 —— 谁把它们挪下去，这里会红。
 *
 * ⚠️ 两条用例用了两种判据，各有理由：
 *    · `/today`：**功能性**判据（畸形 uid → 400 INVALID_REQUEST）。
 *      400 由 createRoute 的 query 校验在 handler 之前给出，**不连库**；
 *      若被详情路由吃掉，走的会是 db 查询（测试环境里报 500 或 404，反正不是 400）。
 *    · `/latest`：没有必填参数、handler 一定连库 ⇒ 只能用**注册顺序**判据
 *      （spec 的 paths 顺序就是注册顺序，上面那行实测输出为证）。
 */
describe('句库路由 —— 静态段优先于 /{id}', () => {
  it('畸形 uid 落到 /today 的校验（400），没有被详情路由当成 id="today"', async () => {
    const app = new OpenAPIHono()
    app.route('/api/articles', articlesRoutes)

    const res = await app.request('/api/articles/today?uid=abc')
    expect(res.status).toBe(400)

    const body = (await res.json()) as { ok?: boolean; code?: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('INVALID_REQUEST')
  })

  it('/latest 与 /today 都注册在 /{id} 之前（spec 的 paths 顺序 = 注册顺序）', () => {
    const app = new OpenAPIHono()
    app.route('/api/articles', articlesRoutes)
    const doc = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
    }) as { paths?: Record<string, unknown> }

    const keys = Object.keys(doc.paths ?? {})
    const detail = keys.indexOf('/api/articles/{id}')
    expect(detail, '详情路由不见了 —— 这条断言会变成空转').toBeGreaterThanOrEqual(0)
    expect(keys.indexOf('/api/articles/latest')).toBeLessThan(detail)
    expect(keys.indexOf('/api/articles/today')).toBeLessThan(detail)
  })
})
