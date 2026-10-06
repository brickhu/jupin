import { createApp, mountOpenApiDocs } from './openapi'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serve } from '@hono/node-server'
import { env, envError } from './env'
import { dbState, initDatabase, maskDatabaseUrl, pingDatabase } from './db'
import { probeStorage } from './storage'
import { probeContent } from './services/content'
import { probeStandardAudio } from './services/standard-audio'
import { goodsPriceMap, productIdStatus } from './services/goods'
import { authMiddleware, optionalAuthMiddleware } from './middleware/auth'
import { authRoutes } from './routes/auth'
import { adminRoutes } from './routes/admin'
import { articlesRoutes } from './routes/articles'
import { submissionsRoutes } from './routes/submissions'
import { uploadsRoutes } from './routes/uploads'
import { userRoutes } from './routes/user'
import { mediaRoutes } from './routes/media'
import { challengeRoutes, profileRoutes } from './routes/public'
import { favoritesRoutes, favoritedRoutes } from './routes/favorites'
import { articleRoutes } from './routes/article'
import { statsRoutes } from './routes/stats'
import { tagsRoutes } from './routes/tags'
import { shopRoutes } from './routes/shop'
import { participationRoutes } from './routes/participation'
import { usersRoutes } from './routes/users'
import { payRoutes } from './routes/pay'

const app = createApp()

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
      /** ⭐ 标准音灌入的最后一条错误 —— 空字符串就是没失败过 */
      seedAudioError: dbState.seedAudioError || undefined,
      existingTables: dbState.existingTables.length ? dbState.existingTables : undefined,
      /** ⭐ 句库行数 —— 真机朗读页「正文加载失败」的头号原因就是它是 0 */
      articleCount: dbState.articleCount,
      /** ⭐ 商品目录行数 —— 它是 0 的话，购买页一张卡片都没有（静默故障） */
      goodsCount: dbState.goodsCount,
      /**
       * ⭐ 句库里可读的句子数 = 首页「最新上线」的卡片数 + 1（今日那一句）。
       * ⚠️ 受鉴权保护的接口从外面看不到，所以这个数必须在 /health 里 ——
       *    否则「最新上线那一栏是不是空的」只能靠真机点进去看。
       */
      activeArticles: dbState.activeArticles,
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
 * ⭐⭐ **公开页面** —— 首页 / 个人主页 / 挑战详情 / 竞技场。
 *
 * ⚠️⚠️ 这是全站页面模型的正中间：这些页面**人人（包括我自己）看到的数据都一样**，
 *    按 id 从公开接口取；「谁在看」只影响**哪些模块给** ——
 *    我的名次 / 我的能量 / 本人录音，由服务端在**同一次请求里**决定，
 *    而不是让客户端分「本人视角 / 访客视角」两条取数路径。
 *    （公开接口不带身份 —— 所以不需要「可选身份」这种东西。）
 *
 * ⚠️ 认不出身份 = **匿名**（userId 0），不是错误 —— 不拦、不报错，
 *    所有「我的」数据自然查不到。所以这里**绝不能**换成 authMiddleware：
 *    那会让没登录的人打不开首页。
 */
/**
 * ⭐⭐ **句子资源**（`/api/article/*`，公开，**单数 = 一条句子及其子资源**）：
 *    · `GET /api/article/{id}`                —— 句子详情（全量，含词级数据）
 *    · `GET /api/article/{id}/participations` —— 谁参与过这一句（榜单 / 最近来过）
 *
 * ⚠️ 与 `/api/articles`（**复数 = 句库的集合查询**：查询 / latest / today）是两个根。
 * ⚠️ 2026-09 用户改口径：原来参与数据**自立根路径**（`/api/participations`），
 *    理由是"不把可读性绑在内容行上"——但实现上从来没校验过句子是否存在，
 *    所以那条理由没成立；现在按**阅读视角**收进句子的子资源（见 routes/article.ts）。
 */
app.route('/api/article', articleRoutes)
/**
 * ⭐⭐ **统计资源**（`/api/stats/*`，公开）—— 按 ids 批量的聚合，与句子内容分开：
 *    · `GET /api/stats/participation?ids=`  —— 参与统计（人数 / 最高 / 最低）
 *    · `GET /api/stats/favorite-count?ids=` —— 收藏总量
 *
 * ⚠️ 两条形状一样、都零值补齐；加第三种就再来一条，
 *    别做成 `?type=` 分发器（响应类型会变成 oneOf，parity 检查失效）。
 */
app.route('/api/stats', statsRoutes)
/**
 * ⭐ **全部标签**（`/api/tags`，公开）—— tags 页的名录。
 * ⚠️ 放在 `/api/articles` 之外是**故意**的：`/api/articles/tags` 会和
 *    "`/api/articles/{id}` 将来可能回来"的歧义绑在一起；标签是句库的**目录**，不是某一篇的子资源。
 */
app.route('/api/tags', tagsRoutes)
// ⭐ 公开页面：个人主页 /api/profile/:id、挑战详情 /api/challenge/:sid
app.route('/api/challenge', challengeRoutes)
app.route('/api/profile', profileRoutes)

/**
 * ⭐⭐ 虚拟支付的**发货推送** —— 全站唯一一个公开的**写**接口。
 *
 * ⚠️ 它必须公开：推送来自微信平台，不带（也带不了）我们的 token。
 *    所以「这条推送是真的吗」在路由自己那一层解决（单号存在 + 金额相等 +
 *    归属匹配 + 状态机幂等），见 routes/pay.ts 开头。
 *    ⚠️ 别往这里加业务接口 —— 这个前缀是**免鉴权**的。
 */
app.route('/api/pay', payRoutes)

/**
 * ⭐⭐ 需要鉴权的接口 —— **全部在 /api/user/* 下**（一条铁律）。
 * ⚠️ 只有我自己能看的数据都在这里（明细列表 / 能量 / 提交 / 录音 / 上传 / 下单），
 *    公开接口绝不塞这些字段。
 */
app.use('/api/user/*', authMiddleware)

/**
 * ⭐ 兜底清扫的**惰性触发点**（见 services/sweep.ts）：
 *   带上节流（60 秒），跟在读自己的数据之后跑一次 —— 把"上次进程死在半路的
 *   scoring 行"判失败退能量、把"已出分但没结算"的补上。
 *
 * ⚠️ 为什么挂在中间件而不是各路由里：这是**横切**的运维兜底，不是业务逻辑；
 *    写进每个路由会让下一个人以为"这一步是那个接口的业务需要"。
 * ⚠️ 为什么可以放在响应之后：它不改变本次响应（用户这次拿到的仍是当前状态），
 *    下一次请求就会看到被修好的数据。
 * ⚠️ 绝不 await：兜底清扫慢一点无所谓，但不能让用户等它（更不能让它把请求搞失败）。
 */
app.use('/api/user/*', async (c, next) => {
  await next()
  void (async () => {
    try {
      const { sweepStaleSubmissions } = await import('./services/sweep')
      await sweepStaleSubmissions()
    } catch {
      /* 兜底清扫失败绝不影响请求（sweep 内部也已经 try 住，这里再兜一层） */
    }
  })()
})

/**
 * ⭐ 内容管理接口（只有 tools/admin 用）—— 走 **ADMIN_TOKEN** 鉴权，不在 /api/user/* 里。
 * ⚠️ 挂载顺序无所谓（前缀不同），但**必须**在 authMiddleware 的挂载之后读起来才顺：
 *    `/api/admin/*` 不受用户身份中间件影响（它自己校验令牌）。
 */
app.route('/api/admin', adminRoutes)

app.route('/api/articles', articlesRoutes)
/**
 * ⭐⭐ **用户目录**（`/api/users`，复数）—— 公开接口。
 *
 * ⚠️⚠️ 与 `/api/user/*`（单数、鉴权命名空间）**不是同一个前缀**：
 *    实测 Hono 的 `/api/user/*` **不会**兜住 `/api/users`，所以它必须
 *    自己在 auth.test.ts 的公开清单里登记（不是"忘了挂鉴权"）。
 * ⚠️ 它**含 energy**（用户 2026-09 明确要求公开）——
 *    `/api/profile/:id`「能量只给本人」那条边界没变，别当先例。
 */
app.route('/api/users', usersRoutes)
/**
 * ⭐⭐ 今日推荐 —— 首页那张"今日挑战"卡（`GET /api/articles/today?uid=<id>`）。
 * ⚠️ 2026-09 改口径：它**不再挂在 /api/user/* 下**，而是并入 `/api/articles` 前缀，
 *    只收一个 uid（公开可读）。「我今天在这句上的战绩」在
 *    `/api/user/participation/{articleId}`（那条仍然在鉴权前缀下）。
 *    ⇒ 路由本体在 routes/articles.ts（**必须排在 `/{id}` 之前**，见那里的说明）。
 */
// ⭐ 我的收藏：收/取消一个句子 + 列表（挂在 /api/user/* 下 ⇒ 自动受鉴权保护）
app.route('/api/user/favorites', favoritesRoutes)
/**
 * ⭐ **"这一句我收藏了吗"**（`GET /api/user/favorited?articleId=`）—— 独立一条查询。
 *
 * ⚠️ 为什么单独挂：它与 `/api/user/favorites/{id}`（PUT/DELETE 设开关）语义不同，
 *    也刻意不掺进 participation 的响应 —— 收藏与"参与"是两件事
 *    （没读过也能收藏，那时 participation 回 null，端侧判不出收藏状态）。
 */
app.route('/api/user', favoritedRoutes)
app.route('/api/user', userRoutes)
app.route('/api/user/submissions', submissionsRoutes)
app.route('/api/user/uploads', uploadsRoutes)
// ⭐ 商店：商品列表 + 下单（价格从服务端来，端侧不写死）—— 下单是我的行为
app.route('/api/user/shop', shopRoutes)
// ⭐ 成长榜：三个成长指标各 TOP10（首页那三块）
/**
 * ⚠️ 成长榜是**公开**的（谁都能看榜），但它想知道"看的人是谁"——
 *    所以挂**可选**身份解析（认不出按 0，绝不 401），而不是 authMiddleware：
 *    挂了它，未加入的人打开首页就会 401，而首页本来就该给所有人看。
 */
/**
 * ⭐ **参与详情**（`/api/participation/{userId}?articleId=`，公开）。
 *
 * ⚠️ 为什么是公开：它给的是**榜上那一行的详情**（分数 / 次数 / 时间 / 句子快照），
 *    而榜单本来就是公开的——
 *    从榜单点人进去看，却在门口要登录，是自相矛盾。
 */
app.route('/api/participation', participationRoutes)

// ⭐⭐ 先监听，再初始化数据库 —— 顺序不能反，理由见 db/index.ts 的 initDatabase 注释。
/**
 * ⭐⭐ **OpenAPI 文档**（`/api/openapi.json` + `/api/docs`）——
 *    必须在**所有路由注册完之后**挂（文档是按注册表现算的）。
 *    ⚠️ 迁移未完成的阶段：普通 `new Hono()` 子应用依然工作，只是**不进文档**。
 */
mountOpenApiDocs(app)

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[server] 监听 http://0.0.0.0:${info.port}  engine=${env.ENGINE}`)
  if (envError) console.error(`[server] ⚠️ 配置有问题，详情见 /health：${envError}`)
})

void initDatabase()

export { app }
