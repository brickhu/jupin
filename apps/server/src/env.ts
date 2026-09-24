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
/**
 * ⭐ 解析一行 KEY=VALUE。
 *
 * ⚠️⚠️ **必须剥掉行内注释**（`KEY=value  # 说明`）——
 *    值会**原样**进 process.env，尾部拖上一段 `# 现网` 之后，
 *    任何签名/校验都只会以「值不对」的形式失败，而看不出是因为注释。
 *    （真踩过：XPAY_APP_KEY 后面跟了 `# 现网`，虚拟支付的 paySig 直接报 -15006，
 *      而排查方向会先怀疑算法、再怀疑 AppKey 拿错环境。）
 *
 * ⚠️ 判据按 dotenv 的惯例：**`#` 前面有空白**才算注释 ——
 *    所以值内部不含空白的 `#`（比如密码里的）不会被切掉。
 * ⚠️ 与 tools/env.mjs 的 parseEnvFile 是**同一套规则**，改一处必须改另一处。
 */
export function parseEnvLine(line: string): [string, string] | null {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (!m) return null
  const key = m[1] as string
  const raw = m[2] as string
  return [key, raw.replace(/\s+#.*$/, '').trim()]
}

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
      const parsed = parseEnvLine(line)
      if (!parsed) continue
      const [key, value] = parsed
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
  ENGINE: z.enum(['mock', 'xfyun', 'youdao']).default('mock'),
  XFYUN_APP_ID: z.string().optional(),
  XFYUN_API_KEY: z.string().optional(),
  XFYUN_API_SECRET: z.string().optional(),
  /**
   * ⭐ 有道智云「实时语音评测」—— 应用 ID / 应用密钥（控制台 → 应用管理）。
   *
   * ⚠️ 它是选型调研里指定的**唯一备胎**：价格公开、可自助开通、含音素级
   *    （judge / calibration / prominence），用来跟讯飞做同音频 A/B
   *    （见 docs/research/speech-eval-vendor-comparison.md 的结论 1）。
   * ⚠️ 目前**只被探针脚本用到**（apps/server/scripts/dump-youdao.ts）——
   *    ENGINE=youdao 还没有对应的引擎实现，见 engines/index.ts 的说明。
   *    先留着这两个键，是为了让「先 dump 原始返回、再决定怎么写解析」这条路能走通。
   *
   * ⚠️ 签名是 sha256(appKey + salt + curtime + secret) —— **不是 HMAC**，
   *    就是把四段字符串拼起来再 sha256，顺序不能换。
   * ⚠️ 密钥只在服务端用：客户端拿不到也不该拿到（同讯飞的 APISecret）。
   */
  YDS_APP_KEY: z.string().optional(),
  YDS_APP_SECRET: z.string().optional(),

  /**
   * ⭐ AI 教练（出「点评 + 提升建议」）用的大模型。
   *
   * ⚠️ 三个全空 = **整个功能关掉**（不产生任何费用）—— 这是刻意的：
   *    它每次提交都要调一次模型，属于「每个用户每次都在烧钱」的那类能力，
   *    不该在没打算付钱的环境里悄悄跑起来。
   * ⚠️ 走到 OpenAI 兼容的 /chat/completions（DeepSeek、通义、Kimi 都是这套）。
   */
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),
  LLM_MODEL: z.string().optional(),

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
   * 静态资源**根目录** —— 正文路径相对它解析。
   * ⚠️ 不是「content 目录」：正文路径形如 `/content/articles/<id>.json`，
   *    本身就带 content/ 那一段（那是它将来在 CDN 上的 URL 路径）。
   *    ⚠️ 换 CDN 只改这个**根**，不改每条记录的路径。
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

  /* ------------------------------------------------------------------ */
  /* ⭐ 虚拟支付（见 docs/design/payment-and-purchase.md）              */
  /* ------------------------------------------------------------------ */

  /**
   * ⭐ 支付通道：mock = 本地假支付（下单即发货，只用于本地联调）；xpay = 真实虚拟支付。
   *
   * ⚠️⚠️ 默认值是 xpay（**fail closed**），不是 mock —— 两个默认值的代价完全不对称：
   *    · 该真付却走了 mock ⇒ 谁都能空手拿走能量（**真金白银的损失**）
   *    · 该 mock 却走了 xpay ⇒ 本地下单报错，一眼就能看出来，改一下 .env.local 即可
   * ⚠️ 而且 mock 分支**在 production 下一律拒绝**（见 services/order.ts），双保险。
   */
  PAY: z.enum(['mock', 'xpay']).default('xpay'),
  /**
   * ⭐ 虚拟支付的三件套 + 环境号（MP 后台 → 虚拟支付 → 基础配置）。
   * ⚠️ 全空 = 只能走 mock；真实支付会在下单时明确报错，而不是静默失败。
   * ⚠️ AppKey 分**沙箱**和**现网**两把，由 XPAY_ENV 决定用哪把。
   * ⚠️ 会员订阅**不支持沙箱**（env 只能为 0）—— 我们只做道具直购，暂不涉及。
   */
  XPAY_OFFER_ID: z.string().optional(),
  XPAY_APP_KEY: z.string().optional(),
  XPAY_SANDBOX_APP_KEY: z.string().optional(),
  /** 0 = 现网，1 = 沙箱 */
  XPAY_ENV: z.coerce.number().int().min(0).max(1).default(0),
  /**
   * ⭐ 微信侧「道具管理」里的**道具 ID**（按商品码一一对应）。
   * ⚠️ 它是**配置**不是运营数据：启动时会同步进 goods 表（有值才写）。
   *    这样开通虚拟支付之后只要填 .env，不用手工改库。
   */
  XPAY_PRODUCT_ENERGY_10: z.string().optional(),
  XPAY_PRODUCT_ENERGY_300: z.string().optional(),
  XPAY_PRODUCT_ENERGY_3000: z.string().optional(),
  /**
   * ⭐ 沙箱（开发版本）的**道具 ID**。
   *
   * ⚠️ 道具在微信侧有「开发版本」与「现网版本」两种状态，ID 未必相同；
   *    而 dev 环境固定走**沙箱**（见 deploy-cloud.mjs），所以它需要沙箱那一套 ID。
   * ⚠️ 可空：ID 相同时留空即可（会回退到上面那三个）。
   * ⚠️ 好在 dev / prod 是**两个独立的库**，所以两边可以各存各的道具 ID，
   *    不需要在 goods 表里再分环境。
   */
  XPAY_PRODUCT_ENERGY_10_SANDBOX: z.string().optional(),
  XPAY_PRODUCT_ENERGY_300_SANDBOX: z.string().optional(),
  XPAY_PRODUCT_ENERGY_3000_SANDBOX: z.string().optional(),
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
  // ⚠️ 兜底值同样 fail closed：配置坏掉时宁可付不了款，也不能白送
  PAY: 'xpay',
  XPAY_ENV: 0,
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
