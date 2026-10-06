import { OpenAPIHono } from '@hono/zod-openapi'
import type { Hook } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'

import type { Variables } from './middleware/auth'

/**
 * ⭐⭐ **OpenAPI 基础设施** —— 一份机器可读的接口定义，替代手写清单。
 *
 * ⭐⭐⭐ **接口的事实来源就是它**（用户 2026-09 定："后续 API 的事实来源与 api doc 为准"）。
 *    ⇒ 任何关于"某接口收什么/返回什么/什么状态码/要不要登录"的说法，
 *      与 `/api/docs`（= 这里的 `createRoute` 声明）冲突时，**一律以它为准**。
 *    ⇒ 也不许在别处另写一份接口表：手写的必然漂移（`/api/schedules` 那次就是活例子）。
 *
 * ⚠️⚠️ 为什么改成这条路线（用户 2026-09 定）：手动维护的接口清单**必然漂移**
 *    （`schedules` 表与 `/api/schedules` 都删了，文档里还留着它）。
 *    标准做法是让**代码自己产出**一份 OpenAPI：
 *      · 每个路由用 `createRoute()` 声明（方法 / 路径 / 参数 / 请求体 / 各状态响应）；
 *      · 响应 schema 与共享 TS 类型**双向比对**（见 openapi/schemas.ts 末尾）；
 *      · 产出 `/api/openapi.json`（机器可读）+ `/api/docs`（能点的 Swagger UI）。
 *
 * ⚠️ 迁移是**逐文件**的：`OpenAPIHono.route()` 会合并子应用的注册表（见包的实现），
 *    所以没迁完之前，普通 `new Hono()` 子应用照常工作、只是**不进文档**。
 *    ⇒ "接口工作的完成标准"= 所有路由都迁到 `createRoute()`，`/api/openapi.json` 覆盖全站。
 */

/**
 * 校验失败时的统一出口 —— 必须与全站的失败信封一致（`{ ok:false, error }`）。
 *
 * ⚠️⚠️ 不加它的话，`@hono/zod-openapi` 的默认行为是回 **400 + Zod 原始错误对象**：
 *    端侧的 `request()` 按信封解包（判 `'ok' in body`），拿到那个裸对象会当成
 *    "不是合法信封"，报出一句与真实原因无关的错（历史上踩过同类：404 的 text/plain）。
 */
export const defaultHook: Hook<unknown, { Variables: Variables }, string, unknown> = (result, c) => {
  if (result.success) return
  const first = result.error.issues[0]
  return c.json(
    {
      ok: false as const,
      error: first ? `${first.path.join('.') || '请求体'}：${first.message}` : '请求参数不合法',
      code: 'INVALID_REQUEST',
    },
    400,
  )
}

/** 服务端统一的 app 工厂 —— 所有路由挂到它上面（这样它们才进文档） */
export function createApp() {
  return new OpenAPIHono<{ Variables: Variables }>({ defaultHook })
}

/**
 * 挂上文档本身：`/api/openapi.json`（spec）+ `/api/docs`（Swagger UI）。
 *
 * ⚠️ 必须在**所有路由注册完之后**调（文档是请求时按注册表现算的，晚注册也能进；
 *    但先挂文档、后挂路由会让人误以为"没生效"，所以顺序固定在这里）。
 * ⚠️ 这两条路**公开**：`/api/openapi.json` 与 `/api/docs` 都不在 `/api/user/*` 下。
 */
export function mountOpenApiDocs(app: ReturnType<typeof createApp>): void {
  /**
   * ⚠️ 身份有两种，别混（对应 middleware/auth.ts 的两条路径）：
   *    · userToken  —— 小程序：微信网关注入 `x-wx-openid`（本地联调走 Bearer token）；
   *    · adminToken —— `tools/admin`：`Authorization: Bearer <ADMIN_TOKEN>`。
   */
  app.openAPIRegistry.registerComponent('securitySchemes', 'userToken', {
    type: 'http',
    scheme: 'bearer',
    description:
      '小程序走微信网关注入的 x-wx-openid（无需显式带头）；本地联调/公网走 Bearer token。',
  })
  app.openAPIRegistry.registerComponent('securitySchemes', 'cronToken', {
    type: 'http',
    scheme: 'bearer',
    description: '定时触发器：Authorization: Bearer <CRON_SECRET>（见 routes/cron.ts）',
  })
  app.openAPIRegistry.registerComponent('securitySchemes', 'adminToken', {
    type: 'http',
    scheme: 'bearer',
    description: '内容管理接口：Authorization: Bearer <ADMIN_TOKEN>',
  })

  app.doc('/api/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'jushuo API',
      version: '1.0.0',
      description:
        '句子朗读挑战的服务端接口。⚠️ 这份文档由代码生成（路由里的 createRoute 声明），' +
        '**不是**手写的 —— 改了接口就改了文档。',
    },
    tags: [
      // ⚠️ 这里原来有 `{ name: '今天挑战', description: '按人：24 小时窗口 + 我的难度档' }` ——
      //    2026-09 删除：today 已并入 /api/articles/today（tag 用「句库」），
      //    这个分组已经没有路由在用（留着只会在 Swagger UI 上挂一个空组）。
      { name: '句库', description: '公开：句库查询 / 最新上线 / 今日推荐 / 详情' },
      { name: '统计', description: '公开：按句批量聚合（参与统计 / 收藏总量）' },
      { name: '排行榜', description: '公开：成长榜（三块 TOP10，按需取）' },
      { name: '用户', description: '公开：用户目录（按加入时间 / 能量排序）' },
      { name: '挑战提交', description: '上传与提交检测' },
      { name: '我的', description: '鉴权：我的成绩 / 历史 / 收藏 / 商店 / 能量' },
      { name: '竞技场', description: '按句子寻址的场子与榜单' },
      { name: '内容管理', description: 'admin 工具用（ADMIN_TOKEN）' },
    ],
  })

  app.get('/api/docs', swaggerUI({ url: '/api/openapi.json' }))
}
