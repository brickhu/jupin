import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { timingSafeEqual } from 'node:crypto'

import { env } from '../env'
import { defaultHook } from '../openapi'
import { errorResponse } from '../openapi/schemas'
import { sweepStaleSubmissions } from '../services/sweep'

/**
 * ⭐⭐ **定时触发器打进来的运维接口**（微信云托管的「定时触发器」）。
 *
 * ## 它解决的是「兜底清扫兜不住」这件事
 *
 * `services/sweep.ts` 要修的两个洞，它自己的注释里写得很清楚 ——
 * **都不在"某次请求出错"，而在"没人来问"**：
 *
 *   ① 悬空的 `scoring` 行：心跳判死与接管只在**有入站轮询**时发生。
 *      用户提交完就退出小程序、容器又被缩容回收 ⇒ 这条行永远停在 scoring，
 *      那 2 点能量从此**既不全扣也不退回**。
 *   ② 已出分但没结算：`settle` 只跑一次（守卫是 `cookies_earned IS NULL`），
 *      进程死在写分数与 settle 之间 ⇒ 分数看得见、能量扣了，
 *      但连战与饼干**全漏发，且永不补**。
 *
 * ⚠️⚠️ 而它原来的触发方式是**惰性**的（进程启动一次 + 用户读数据时按节流跑一次）——
 *    **恰恰在"没人来问"的时候不跑**，也就是它要修的那两个场景 ✗
 *    ⇒ 定时触发器不是"加一个提醒功能"，是**让这个兜底真的兜住**。
 *
 * ## 为什么平台触发器不算"常驻定时器"
 *
 * `sweep.ts` 里写着「不引入定时器 —— 云托管上进程随时会被回收，**常驻定时器**
 * 本来就不可靠」。⚠️ 那句反对的是 `setInterval` 那种**进程内的**定时器；
 * 而云托管定时触发器是**平台级**的：到点起一个新实例、打一次这个接口 ✓
 * ⇒ 那条理由**不适用于它**。
 *
 * ## 安全
 *
 * ⚠️ 与 ADMIN_TOKEN 同一条规矩：**没配 = 503、配错 = 401**，绝不"没配就放行"。
 * ⚠️ 用**专用**的 `CRON_SECRET` 而不是复用 ADMIN_TOKEN —— 见 env.ts 里的说明
 *    （控制台里的口令更容易被看到，而两件事的爆炸半径差很远）。
 */
export const cronRoutes = new OpenAPIHono({ defaultHook })

/** 定长比较，避免用时间侧信道猜口令（与 routes/admin.ts 同一实现） */
function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

cronRoutes.use('*', async (c, next) => {
  const configured = env.CRON_SECRET
  if (!configured) {
    return c.json({ ok: false, error: '服务端没有配置 CRON_SECRET（定时接口未启用）' }, 503)
  }
  const header = c.req.header('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token || !sameSecret(token, configured)) {
    return c.json({ ok: false, error: 'CRON_SECRET 不正确' }, 401)
  }
  await next()
})

const sweepRoute = createRoute({
  method: 'post',
  path: '/sweep',
  tags: ['运维'],
  summary: '兜底清扫（定时触发器用）—— 判失败退能量 + 补跑漏掉的结算',
  /**
   * ⚠️ 这一条**不进 OpenAPI 文档的公开面**也可以接受，但留着更好：
   *    ops 要能查"这个接口到底干什么"。
   * ⚠️ 用 POST 而不是 GET：它会改数据，不该被浏览器预取或者被当成幂等的读。
   */
  security: [{ cronToken: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              /** 判失败并退回能量的条数 */
              failed: z.number().int(),
              /** 补跑结算的条数 */
              resettled: z.number().int(),
            }),
          }),
        },
      },
      description: '成功（两个计数都是这次真的处理了几条）',
    },
    401: errorResponse('CRON_SECRET 不正确'),
    503: errorResponse('服务端没有配置 CRON_SECRET'),
  },
})

cronRoutes.openapi(sweepRoute, async (c) => {
  /**
   * ⚠️⚠️ 传 `force = true`：默认那次 60 秒节流是给"每个请求都可能来一下"设计的，
   *    而定时触发器**一天只来几次** —— 被节流掉就等于这一次白跑。
   */
  const r = await sweepStaleSubmissions(true)
  return c.json({ ok: true as const, data: r }, 200)
})
