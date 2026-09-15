import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serve } from '@hono/node-server'
import { env, envError } from './env'
import { dbState, initDatabase, maskDatabaseUrl, pingDatabase } from './db'
import { probeStorage } from './storage'
import { authMiddleware } from './middleware/auth'
import { authRoutes } from './routes/auth'
import { articlesRoutes } from './routes/articles'
import { submissionsRoutes } from './routes/submissions'
import { userRoutes } from './routes/user'

const app = new Hono()

app.use('*', logger())
app.use('*', cors({
  origin: (origin) => origin ?? '*',
  credentials: true,
}))

/**
 * 健康检查 / 自检端点。
 *
 * ⭐ 刻意始终返回 200 —— 它是**存活探针**，不是就绪探针。
 *    数据库没连上时如果返回 5xx，云托管会判定 Pod 不健康并反复重启，
 *    而 CLI 又看不到容器日志，排查会卡死。
 *    所以：探针只管「进程活着」，问题细节放在 body 里给人看。
 *
 * ⚠️⚠️ 必须和其他接口用**同一个信封** { ok: true, data: ... }。
 *     这里曾经直接返回扁平的 { status, engine, ... }，而小程序的 request()
 *     统一按信封解包（'ok' in body && body.ok），于是**每次健康检查都被自己判成失败**，
 *     报「请求失败」—— 服务端明明返回了 200。
 *     前端看到的「连不上后端」和真实网络状况完全无关，排查被带偏了很久。
 *     教训：信封只有一种，不要为任何端点破例。
 */
app.get('/health', async (c) => {
  // ⭐ 实时探一次库：dbState 只是启动时的结果，数据库后来挂了它不会变。
  //    带 2.5s 超时，保证探针本身够快。
  const live = dbState.status === 'error' ? 'error' : await pingDatabase()

  // ⚠️ 深度自检会真的调一次微信开放接口 + 一次对象存储，所以默认关闭。
  //    未鉴权的 /health 不该具备这个能力（会变成廉价的 DoS 放大面）。
  const deep = env.DIAG_ENABLED && c.req.query('deep') === '1'
  const storage = deep ? await probeStorage() : undefined

  return c.json({
    ok: true,
    data: {
      status: 'ok',
      engine: env.ENGINE,
      node: process.version,
      // 连接串打码后回显，用来核对 MYSQL_* 有没有解析对
      database: maskDatabaseUrl(env.DATABASE_URL),
      /** 启动时建立的连接状态 */
      db: dbState.status,
      /** ⭐ 本次请求实时探测的结果：ok / error / timeout */
      dbLive: live,
      dbError: dbState.error || undefined,
      dbAttempts: dbState.attempts,
      migrated: dbState.migrated,
      migrateError: dbState.migrateError || undefined,
      existingTables: dbState.existingTables.length ? dbState.existingTables : undefined,
      envError: envError ?? undefined,
      storage,
    },
  })
})

// 公开路由
app.route('/api/auth', authRoutes)

// 需鉴权路由
app.use('/api/articles/*', authMiddleware)
app.use('/api/submissions/*', authMiddleware)
app.use('/api/user/*', authMiddleware)

app.route('/api/articles', articlesRoutes)
app.route('/api/submissions', submissionsRoutes)
app.route('/api/user', userRoutes)

// ⭐⭐ 先监听，再初始化数据库 —— 顺序不能反，理由见 db/index.ts 的 initDatabase 注释。
serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[server] 监听 http://0.0.0.0:${info.port}  engine=${env.ENGINE}`)
  if (envError) console.error(`[server] ⚠️ 配置有问题，详情见 /health：${envError}`)
})

void initDatabase()

export { app }
