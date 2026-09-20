import { existsSync } from 'node:fs'
import { z } from 'zod'

// 加载 .env（Node 20.12+ 内置，零依赖）
// ⚠️ 必须在读取 process.env 之前执行
if (existsSync('.env')) {
  process.loadEnvFile('.env')
}

/**
 * 把微信云托管注入的 MySQL 变量拼成 DATABASE_URL。
 *
 * ⚠️ 云托管只定义了三个变量：MYSQL_ADDRESS / MYSQL_USERNAME / MYSQL_PASSWORD，
 *    而且**只有在控制台用官方模板一键部署时才会自动注入**。
 *    手动开通的 MySQL 必须在「服务设置 → 基本信息 → 环境变量」自己填。
 *
 * ⚠️ MYSQL_ADDRESS 是 "host:port" **一个字段**（官方模板源码里就是 MYSQL_ADDRESS.split(':')），
 *    不是一个 host 一个 port；端口缺省 3306。
 *
 * ⚠️ 没有 MYSQL_DATABASE —— 业务库要自己在控制台建，库名自己起。
 */
function deriveDatabaseUrlFromCloudEnv(): string | undefined {
  const { MYSQL_ADDRESS, MYSQL_USERNAME, MYSQL_PASSWORD } = process.env
  if (!MYSQL_ADDRESS || !MYSQL_USERNAME || !MYSQL_PASSWORD) return undefined
  const [host, port = '3306'] = MYSQL_ADDRESS.split(':')
  const database = process.env.MYSQL_DATABASE ?? 'jushuo'
  const auth = `${encodeURIComponent(MYSQL_USERNAME)}:${encodeURIComponent(MYSQL_PASSWORD)}`
  return `mysql://${auth}@${host}:${port}/${database}`
}

if (!process.env.DATABASE_URL) {
  const derived = deriveDatabaseUrlFromCloudEnv()
  if (derived) process.env.DATABASE_URL = derived
}

// ⚠️ 云托管 v1 时代的环境变量叫 APP_PORT，本项目用 PORT。两个都认。
if (!process.env.PORT && process.env.APP_PORT) {
  process.env.PORT = process.env.APP_PORT
}

/**
 * 环境变量校验。
 *
 * ⚠️⚠️ 校验失败**刻意不 process.exit(1)**。
 *    云托管的存活探针只能看到「端口没人监听 → connection refused → 部署失败」，
 *    而容器日志在 CLI 里拿不到 —— 直接退出会让排查变成盲猜。
 *    所以降级为「带错误继续启动」：服务照常监听，究竟哪个变量错了看 /health。
 */
/**
 * 布尔环境变量解析。
 *
 * ⚠️⚠️ 绝不要用 `z.coerce.boolean()` —— 它是 `Boolean(input)`，
 *    所以字符串 `'false'` 会被解析成 **true**（非空字符串都是真值）。
 *    环境变量永远是字符串，这个坑迟早会踩。
 */
const boolEnv = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'))

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  TOKEN_SECRET: z.string().min(8, 'TOKEN_SECRET 至少 8 位'),
  ENGINE: z.enum(['mock', 'xfyun']).default('mock'),
  XFYUN_APP_ID: z.string().optional(),
  XFYUN_API_KEY: z.string().optional(),
  XFYUN_API_SECRET: z.string().optional(),

  /**
   * 对象存储实现。
   * ⚠️ 音频必须走对象存储直传 —— 小程序→云托管服务的请求体上限是 100KiB
   *   （官方文档明写，超限报业务错误码 -606001），20 秒音频约 640KB 远超限制。
   */
  STORAGE: z.enum(['local', 'wxcloud']).default('local'),
  WX_CLOUD_ENV_ID: z.string().optional(),
  /**
   * 对象存储桶与地域（读音频要用）。
   * ⭐ 由 pnpm deploy:dev / deploy:prod 从云托管 API 自动读出并注入，
   *    不用去控制台抄 —— 见 tools/deploy-cloud.mjs。
   */
  COS_BUCKET: z.string().optional(),
  COS_REGION: z.string().optional(),
  /**
   * ⚠️ 已废弃：音频改为**永久保留**（用户要求），只在检测失败时删除。
   *    保留这个键只是为了让旧的服务环境变量不会导致启动失败。
   *    见 routes/submissions.ts 的注释。
   */
  DELETE_AUDIO_AFTER_SCORE: boolEnv(false),

  /** 迁移 SQL 目录，相对进程工作目录。容器里是 /app/drizzle */
  MIGRATIONS_DIR: z.string().default('drizzle'),
  /**
   * 静态资源**根目录** —— contentJson 相对它解析。
   * ⚠️ 不是「content 目录」：contentJson 形如 `/content/articles/1.json`，
   *    本身就带 content/ 那一段（那是它将来在 CDN 上的 URL 路径）。
   *    留空则自动探测（容器 /app、或本机仓库根）。
   */
  STATIC_ROOT: z.string().optional(),
  /**
   * 启动时自动跑迁移。
   * ⚠️ 多副本时不要开：会并发跑迁移。本项目副本数为 1。
   */
  AUTO_MIGRATE: boolEnv(false),
  /**
   * 启动时自动灌种子文章（幂等 upsert）。
   *
   * ⚠️ 为什么需要它：云上 **Dockerfile 的 CMD 只有 node index.mjs**，
   *    不像本地开发镜像会自动 seed。没有它的话，部署完 dev 环境是**空的句库**，
   *    真机上朗读页会直接「正文加载失败」。
   *    而手动跑 seed:cloud 要求先在控制台打开数据库「外网地址」——
   *    为一个 5 行的种子去开数据库公网入口，不值得。
   *
   * ⚠️ 只在开发环境开（deploy-cloud.mjs 只给 dev 带上）。
   */
  SEED_ON_START: boolEnv(false),
  /**
   * 是否开放深度自检（/health?deep=1）。
   * ⚠️ 默认关闭：深度自检会真的去调一次微信开放接口 + 一次对象存储，
   *    未鉴权的端点不该有这个能力。只在开发环境开。
   */
  DIAG_ENABLED: boolEnv(false),
  /**
   * ⚠️ 启动时**删库重建**（DROP DATABASE + CREATE）。
   *    仅用于发布前无数据环境下的 schema 重构 —— 生产环境**绝对不要开**。
   *    由 deploy-cloud.mjs 的 --reset 一次性带上。
   */
  SCHEMA_RESET: boolEnv(false),
})

export type Env = z.infer<typeof schema>

const parsed = schema.safeParse(process.env)

/** 校验失败的说明；null 表示配置正常。会原样出现在 /health 里 */
export const envError: string | null = parsed.success
  ? null
  : Object.entries(parsed.error.flatten().fieldErrors)
      .map(([k, v]) => `${k}: ${(v ?? []).join('; ')}`)
      .join(' | ')

/**
 * 配置坏掉时的兜底值：让进程能起来、能监听、能在 /health 里说清问题。
 * ⚠️ DATABASE_URL 故意指向一个不存在的地址 —— 连不上是预期的，不能被当成「配好了」。
 */
const FALLBACK: Env = {
  NODE_ENV: 'production',
  PORT: Number(process.env.PORT ?? 3000),
  DATABASE_URL: 'mysql://invalid:invalid@127.0.0.1:1/invalid',
  TOKEN_SECRET: 'invalid-config-placeholder',
  ENGINE: 'mock',
  STORAGE: 'local',
  DELETE_AUDIO_AFTER_SCORE: true,
  MIGRATIONS_DIR: 'drizzle',
  AUTO_MIGRATE: false,
  SEED_ON_START: false,
  DIAG_ENABLED: false,
  SCHEMA_RESET: false,
}

if (!parsed.success) {
  console.error('❌ 环境变量校验失败（服务仍会启动，详情见 /health）：', envError)
}

export const env: Env = parsed.success ? parsed.data : FALLBACK

// 选了真实引擎却没配密钥 —— 记下来，同样不退出
if (env.ENGINE === 'xfyun') {
  const missing = (['XFYUN_APP_ID', 'XFYUN_API_KEY', 'XFYUN_API_SECRET'] as const).filter(
    (k) => !env[k],
  )
  if (missing.length > 0) console.error(`❌ ENGINE=xfyun 但缺少：${missing.join(', ')}`)
}
