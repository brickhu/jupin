import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'

/**
 * ⭐ 加载根目录那四份 .env 里**属于本次运行**的两份。
 *
 *   .env         公用
 *   .env.<mode>  mode 由 APP_ENV 决定（默认 local），可选 local / dev / prod
 *
 * 优先级：真实环境变量 > .env.<mode> > .env。
 *
 * ⚠️ 规则与 tools/env.mjs 是**同一套**（那边给 node 工具用）。这里没法直接复用：
 *    容器镜像里没有 tools/（Dockerfile 只 COPY apps/server、packages/shared、content、drizzle），
 *    import 会在构建期就解析不到。改动其中一处时，另一处必须一起改。
 *
 * ⚠️⚠️ 为什么不用 process.loadEnvFile()：它**不覆盖已有键**，
 *    所以"先 .env 再 .env.dev"这种叠法会让第二层的同名键被第一层顶住，
 *    分层静默失效（改了 .env.dev 却不生效）。所以这里自己解析、自己按顺序写。
 *
 * ⚠️ 真实环境变量优先这一条**必须保留**：
 *    ① docker-compose 会给容器注入 DATABASE_URL=…@db:3306（容器内地址），
 *       而 .env.local 里的那份是给宿主机用的（127.0.0.1:5544）——顺序反了就连不上库；
 *    ② 云上根本没有这些文件（.dockerignore 把 .env* 全排除了），
 *       环境变量全部来自服务配置 —— 找不到文件时静默跳过即可。
 *
 * ⚠️ 从**仓库根**加载，而不是 cwd：同一个 bundle 会在三种 cwd 下跑
 *    （apps/server / 仓库根 / 容器里的 /app），按 cwd 找必然漏。
 */
function loadLayeredEnv(): void {
  /** 向上找到带 pnpm-workspace.yaml 的那一层 —— 那就是仓库根 */
  function findRoot(): string | null {
    let dir = process.cwd()
    for (let i = 0; i < 6; i++) {
      if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return null
  }

  const root = findRoot()
  if (!root) return // 容器里就是这样：没有仓库根，全靠环境变量

  const mode = process.env.APP_ENV ?? 'local'
  const fromProcess = new Set(Object.keys(process.env))

  for (const file of ['.env', `.env.${mode}`]) {
    const path = resolve(root, file)
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (!m) continue
      const [, key, value] = m as unknown as [string, string, string]
      // ⚠️ 进程里原本就有的键优先级最高，任何文件都不能覆盖
      if (fromProcess.has(key)) continue
      process.env[key] = value
    }
  }
}

// ⚠️ 必须在读取 process.env 之前执行
loadLayeredEnv()

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
   * ⭐ 小程序 AppID / AppSecret —— **服务端专用**。
   *
   * 用途两条：
   *   ① 对象存储：换 access_token 调 /tcb/uploadfile 等经典 HTTPS 接口
   *      （⚠️ 那三个接口官方明写「不支持云调用」，所以**不依赖开放接口服务**
   *        —— 这正是它和 /_/cos/getauth 那条旁加载路线的本质区别）
   *   ② 登录降级路径的 code2session（见 routes/auth.ts）
   *
   * ⚠️ 刻意 optional：本地 STORAGE=local 时用不到它们，
   *    强制必填会让「只想跑本机」的人卡在启动上；
   *    真要用到时由存储实现自己报错，报得更具体。
   */
  WX_APPID: z.string().optional(),
  WX_SECRET: z.string().optional(),
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
