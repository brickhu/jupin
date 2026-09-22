import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serve } from '@hono/node-server'
import { env, envError } from './env'
import { dbState, initDatabase, maskDatabaseUrl, pingDatabase } from './db'
import { probeStorage } from './storage'
import { probeContent } from './services/content'
import { probeStandardAudio } from './services/standard-audio'
import { goodsPriceMap, productIdStatus } from './services/goods'
import { authMiddleware } from './middleware/auth'
import { authRoutes } from './routes/auth'
import { articlesRoutes } from './routes/articles'
import { submissionsRoutes } from './routes/submissions'
import { uploadsRoutes } from './routes/uploads'
import { userRoutes } from './routes/user'
import { mediaRoutes } from './routes/media'
import { shareRoutes } from './routes/share'
import { schedulesRoutes } from './routes/schedules'
import { shopRoutes } from './routes/shop'
import { payRoutes } from './routes/pay'

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
  const [storage, content, audio] = deep
    ? await Promise.all([probeStorage(), probeContent(), probeStandardAudio()])
    : [undefined, undefined, undefined]

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
      /** ⭐ 句库行数 —— 真机朗读页「正文加载失败」的头号原因就是它是 0 */
      articleCount: dbState.articleCount,
      /** ⭐ 商品目录行数 —— 它是 0 的话，购买页一张卡片都没有（静默故障） */
      goodsCount: dbState.goodsCount,
      /**
       * ⭐ 今天之前去重后还剩几个竞技场 = 首页「历史挑战」会有几张卡。
       * ⚠️ 受鉴权保护的接口从外面看不到，所以这个数必须在 /health 里。
       */
      historyArenas: dbState.historyArenas,
      /**
       * ⭐ 支付环境的**自述** —— 必须能一眼看出「现在扣的是真钱还是沙箱」。
       *
       * ⚠️ 这是整个支付模块里最容易搞错、而且**错了不会报错**的一件事：
       *    env 配成现网（0）时，测试支付会**真的扣钱**，而且一切看起来都正常。
       *    所以它和 database / migrated 一样属于「必须能自查」的状态。
       * ⚠️ appKey 只看「这个环境该用的那一把」有没有值 —— 沙箱环境配了现网 key 也白搭。
       */
      pay: {
        /** mock = 本地假支付；xpay = 真实虚拟支付 */
        mode: env.PAY,
        /** 0 = 现网（真钱）／1 = 沙箱 */
        env: env.XPAY_ENV,
        envName: env.XPAY_ENV === 1 ? '沙箱' : '现网',
        offerId: Boolean(env.XPAY_OFFER_ID),
        appKey: Boolean(env.XPAY_ENV === 1 ? env.XPAY_SANDBOX_APP_KEY : env.XPAY_APP_KEY),
        /** 这一环境下三个商品各配没配**有效的**道具 ID */
        productIds: productIdStatus(),
        /**
         * ⭐ **库里实际存的价格**（分）—— 用来核对「代码 / 库 / 微信侧」三方是不是同一个数。
         * ⚠️ 三方不一致的表现是支付时报 -15013，而那时人不会想到「库里还是旧价」。
         */
        prices: await goodsPriceMap(),
      },
      envError: envError ?? undefined,
      storage,
      content,
      /** ⭐ 标准音三层各查一遍：库里有没有值 / 桶里有没有文件 / 客户端会拿到什么引用 */
      audio,
    },
  })
})

// 公开路由
app.route('/api/auth', authRoutes)

/**
 * ⭐ 标准音等静态媒体 —— **刻意放在 /api 之外，不做鉴权**。
 *
 * ⚠️ 理由见 routes/media.ts 开头：InnerAudioContext 不会带 Authorization 头，
 *    也不会带 x-wx-* 头（那不是 callContainer），所以凡是「客户端按 URL 直接取」
 *    的资源都不能要求鉴权 —— 否则在开发者工具和真机上都是 401。
 */
app.route('/media', mediaRoutes)

/**
 * ⭐ 分享出去的链接 —— 同样**不做鉴权**（拿到链接的人可能没有账号）。
 *    ⚠️ 它的隐私边界在路由自己那一层（录音只在这条提交 is_public 时给地址），
 *       见 routes/share.ts 开头。
 */
app.route('/share', shareRoutes)

/**
 * ⭐⭐ 虚拟支付的**发货推送** —— 全站唯一一个公开的**写**接口。
 *
 * ⚠️ 它必须公开：推送来自微信平台，不带（也带不了）我们的 token。
 *    所以「这条推送是真的吗」在路由自己那一层解决（单号存在 + 金额相等 +
 *    归属匹配 + 状态机幂等），见 routes/pay.ts 开头。
 *    ⚠️ 别往这里加业务接口 —— 这个前缀是**免鉴权**的。
 */
app.route('/api/pay', payRoutes)

// 需鉴权路由
app.use('/api/articles/*', authMiddleware)
app.use('/api/submissions/*', authMiddleware)
app.use('/api/uploads/*', authMiddleware)
app.use('/api/user/*', authMiddleware)
app.use('/api/schedules/*', authMiddleware)
app.use('/api/shop/*', authMiddleware)

app.route('/api/articles', articlesRoutes)
app.route('/api/submissions', submissionsRoutes)
app.route('/api/uploads', uploadsRoutes)
app.route('/api/user', userRoutes)
// ⭐ 首页那一次请求：今日挑战 + 历史挑战 + streak
app.route('/api/schedules', schedulesRoutes)
// ⭐ 商店：商品列表 + 下单（价格从服务端来，端侧不写死）
app.route('/api/shop', shopRoutes)

// ⭐⭐ 先监听，再初始化数据库 —— 顺序不能反，理由见 db/index.ts 的 initDatabase 注释。
serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[server] 监听 http://0.0.0.0:${info.port}  engine=${env.ENGINE}`)
  if (envError) console.error(`[server] ⚠️ 配置有问题，详情见 /health：${envError}`)
})

void initDatabase()

export { app }
