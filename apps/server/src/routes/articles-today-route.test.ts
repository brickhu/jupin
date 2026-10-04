import { OpenAPIHono } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'

import { articleRoutes } from './article'
import { articlesRoutes } from './articles'

/**
 * ⭐⭐ **静态段路由（`/latest` / `/today`）不许被 `/{id}` 吃掉**。
 *
 * ⚠️⚠️ 为什么单独一条测试：Hono 对**同前缀**的路由是**按注册顺序**匹配的
 *    （实测：先注册 `/{id}` 的话，`/latest`、`/today` 会命中详情 handler，
 *    `id` 变成字面量 "latest" / "today" ⇒ 404 / 500）。
 *
 * ⚠️⚠️ 2026-09 结构变了：句子**详情**从 `/api/articles/{id}` 搬到了单数根
 *    `/api/article/{id}`（见 routes/article.ts）。于是 `/api/articles`（复数 = 集合查询）
 *    这个路由器里**不再有 `/{id}`** —— 上面那种风险在那里整条消失。
 *    ⇒ 第一条用例（功能性判据）仍然有意义：谁把 `/{id}` 挪回复数根，它会立刻红。
 *      但它**只有在有人挪回来时才会失败**，所以第二条用例改成**结构判据**，
 *      把"详情到底住在哪个根"钉死，免得改动悄悄漂走。
 *
 * ⚠️ 两条用例用了两种判据，各有理由：
 *    · `/today`：**功能性**判据（畸形 uid → 400 INVALID_REQUEST）。
 *      400 由 createRoute 的 query 校验在 handler 之前给出，**不连库**；
 *      若被详情路由吃掉，走的会是 db 查询（测试环境里报 500 或 404，反正不是 400）。
 *    · 结构：spec 的 paths 就是注册结果，直接看两个根各有哪些路径。
 */
describe('句库路由 —— 静态段优先于 /{id}', () => {
  it('畸形 uid 落到 /today 的校验（400），没有被详情路由当成 id="today"', async () => {
    const app = new OpenAPIHono()
    app.route('/api/articles', articlesRoutes)
    app.route('/api/article', articleRoutes)

    const res = await app.request('/api/articles/today?uid=abc')
    expect(res.status).toBe(400)

    const body = (await res.json()) as { ok?: boolean; code?: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('INVALID_REQUEST')
  })

  it('详情只住在单数根 /api/article/{id}；复数根 /api/articles 下没有 /{id}', () => {
    const app = new OpenAPIHono()
    app.route('/api/articles', articlesRoutes)
    app.route('/api/article', articleRoutes)
    const doc = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
    }) as { paths?: Record<string, unknown> }

    const keys = Object.keys(doc.paths ?? {})

    // ⚠️ 复数根 = 集合查询（查询 / latest / today），**没有** `/{id}`
    expect(keys, '复数根下又出现了 /{id} —— 详情应该住在 /api/article/{id}').not.toContain(
      '/api/articles/{id}',
    )
    expect(keys).toContain('/api/articles/latest')
    expect(keys).toContain('/api/articles/today')

    // ⚠️ 单数根 = 一条句子及其子资源
    expect(keys).toContain('/api/article/{id}')
    expect(keys).toContain('/api/article/{id}/participations')
  })
})
