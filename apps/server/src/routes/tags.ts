import { createRoute, OpenAPIHono } from '@hono/zod-openapi'

import type { Variables } from '../middleware/auth'
import { defaultHook } from '../openapi'
import { TagsResponseSchema } from '../openapi/schemas'
import { listTagCounts } from '../services/article-list'

/**
 * ⭐⭐ **全部标签**（`GET /api/tags`，公开）—— tags 页要的那一份。
 *
 * ⚠️ **公开**：它只是句库的目录信息（有哪些标签、各有几篇），
 *    与句库查询（`GET /api/articles`）同一类，本来就不需要身份。
 *
 * ⚠️ 排序与计数口径都在服务端定死（`services/article-list.ts` 的 listTagCounts）：
 *    · 排序：**文章数降序 → 标签升序**（少了第二键，同数量的标签顺序会漂）；
 *    · 计数：只算**已上线且正文读得到**的文章 —— 与列表接口逐条对齐，
 *      否则会出现"标签上写 3 篇、点进去只看到 1 篇"。
 *
 * ⚠️ **搜索不在这里做**：标签总量是几十个，端侧本地过滤更快，
 *    也不用为每个输入字符发一次请求（tags 页就是这么实现的）。
 */
export const tagsRoutes = new OpenAPIHono<{ Variables: Variables }>({ defaultHook })

const listTagsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['句库'],
  summary: '全部标签 + 各自的文章数（公开）',
  description:
    '⚠️ 排序：**文章数降序 → 标签升序**（服务端定死，端侧不要再排）。\n' +
    '⚠️ `count` 只算**已上线且正文读得到**的文章 —— 与 `GET /api/articles` 同一口径，\n' +
    '点一个标签进去看到的就是 `count` 篇。\n' +
    '⚠️ 搜索在端侧做（标签总量是几十个），所以这条没有查询参数。',
  responses: {
    200: {
      content: { 'application/json': { schema: TagsResponseSchema } },
      description: '成功（空句库时 items 为空数组）',
    },
  },
})

tagsRoutes.openapi(listTagsRoute, async (c) => {
  return c.json({ ok: true as const, data: { items: await listTagCounts() } }, 200)
})
