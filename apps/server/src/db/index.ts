import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/mysql2'
import { migrate } from 'drizzle-orm/mysql2/migrator'
import mysql from 'mysql2/promise'
import { env, envError } from '../env'
import * as schema from './schema'

/**
 * MySQL 连接池。
 *
 * ⚠️ timezone: 'Z' 不是可选优化 —— MySQL 的 DATETIME 不存时区，
 *    若按本地时区解释，「上次提交 + 24h」的滚动冷却会整体偏移。
 *    这里把读写两侧都钉死成 UTC；容器内也统一 TZ=UTC。
 *
 * ⚠️ 连接池必须复用：云托管容器是无状态的，每请求新建连接会打满 MySQL 的 max_connections。
 */
const pool = mysql.createPool({
  uri: env.DATABASE_URL,
  connectionLimit: 10,
  timezone: 'Z',
  // MySQL 8 默认把 bigint 返回成字符串，转成 number 才能和 drizzle 的 mode:'number' 对齐
  supportBigNumbers: true,
  bigNumberStrings: false,
})

export const db = drizzle(pool, { schema, mode: 'default' })
export { schema }

/**
 * 数据库状态 —— 会原样出现在 /health 里。
 * ⭐ 这不是调试残留：云托管 CLI **没有看容器日志的命令**，
 *    部署失败时只能看到「探针 connection refused」。
 *    把状态暴露到 HTTP 上，是唯一能自查的通道。
 */
export const dbState = {
  status: 'connecting' as 'connecting' | 'ready' | 'error',
  error: '' as string,
  attempts: 0,
  migrated: false,
  migrateError: '' as string,
  existingTables: [] as string[],
  /**
   * articles 表里有多少行。
   *
   * ⚠️ 为什么值得暴露到 /health：云托管 **CLI 没有看容器日志的命令**，
   *    而「句库是空的」恰恰是真机朗读页「正文加载失败」的头号原因。
   *    没有这个数就只能靠猜 —— 有它就能一眼确认 SEED_ON_START 到底生效没有。
   *    null 表示还没查（迁移失败等）。
   */
  articleCount: null as number | null,
}

/** 把连接串里的密码打码，方便核对环境变量解析结果 */
export function maskDatabaseUrl(url: string): string {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@')
}

/**
 * 等数据库就绪。
 *
 * ⚠️ 云托管 MySQL **默认开启「自动暂停」**：连续 10 分钟无连接即暂停，
 *    恢复中的第一个连接会报
 *      "CynosDB serverless instance is resuming, please try connecting again."
 *    不重试的话容器一连库就崩；而服务缩容到 0 之后，每次冷启动都会撞上这一幕。
 */
export async function waitForDatabase(maxDelayMs = 60_000): Promise<void> {
  for (;;) {
    dbState.attempts += 1
    try {
      await pool.query('SELECT 1')
      if (dbState.attempts > 1) {
        console.log(`[db] 第 ${dbState.attempts} 次尝试连接成功`)
      }
      return
    } catch (err) {
      dbState.error = (err as Error).message
      // ⭐ 退避但不放弃：云托管 MySQL 默认「自动暂停」，恢复可能要几分钟；
      //    无限重试意味着数据库醒过来之后**不需要重新部署**就能自愈。
      const delay = Math.min(2000 * dbState.attempts, maxDelayMs)
      console.warn(
        `[db] 连接失败（第 ${dbState.attempts} 次），${Math.round(delay / 1000)}s 后重试：${dbState.error}`,
      )
      await new Promise((r) => setTimeout(r, delay))
    }
  }
}

/**
 * 找到迁移 SQL 所在目录。
 *
 * ⚠️ 不能只按 process.cwd() 找一个位置：同一个 bundle 会在三种 cwd 下运行 ——
 *    · 云托管容器：WORKDIR=/app，SQL 在 /app/drizzle
 *    · pnpm --filter 启动：cwd=apps/server，SQL 在 apps/server/drizzle
 *    · 从仓库根直接 node dist/index.mjs：SQL 在 apps/server/drizzle（cwd 里没有）
 *    所以按候选列表逐个探测，取第一个真实存在的。
 */
function resolveMigrationsFolder(): string {
  const candidates = [
    resolve(process.cwd(), env.MIGRATIONS_DIR),
    resolve(process.cwd(), 'apps/server', env.MIGRATIONS_DIR),
    fileURLToPath(new URL('./drizzle', import.meta.url)),
    fileURLToPath(new URL('../drizzle', import.meta.url)),
  ]
  const found = candidates.find((p) => existsSync(resolve(p, 'meta', '_journal.json')))
  if (!found) {
    throw new Error(`找不到迁移目录，已尝试：\n  ${candidates.join('\n  ')}`)
  }
  return found
}

/**
 * 确保业务库存在，不存在就建。
 *
 * ⚠️ 为什么需要它：云托管开通 MySQL 后**只创建 3 个系统数据库**，
 *    业务库要自己建。而实例重建后又是一张白纸 —— 本项目已经因此踩了两次：
 *    容器连得上服务器，却报 `Unknown database 'jushuo'`，
 *    而外网地址默认关闭，本机没法连进去手动建库。
 *
 * ⭐ 所以让容器自举：AUTO_MIGRATE 开启时，「建库 + 建表」都算启动的一部分。
 *    这样「销毁重建」就是完全自愈的，不需要人工去控制台补 SQL。
 *
 * ⚠️ 连的是**服务器**不是某个库（所以要把 URL 里的库名去掉）。
 * ⚠️ 字符集必须显式 utf8mb4：云托管 MySQL 的 character_set_server 默认是 utf8（三字节），
 *    直接 CREATE DATABASE 会让昵称里的 emoji 存不进去。
 */
export async function ensureDatabaseExists(): Promise<void> {
  const url = new URL(env.DATABASE_URL)
  const database = url.pathname.replace(/^\//, '')
  if (!database) return

  // 库名来自我们自己的环境变量，不是用户输入；仍然做一次白名单校验，避免拼 SQL 出事
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    console.warn(`[db] 库名 ${database} 含非法字符，跳过自动建库`)
    return
  }

  url.pathname = '/'
  const conn = await mysql.createConnection({
    uri: url.toString(),
    timezone: 'Z',
    connectTimeout: 15000,
  })
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
    )
    console.log(`[db] 已确保库存在：${database}（utf8mb4）`)
  } finally {
    await conn.end().catch(() => {})
  }
}

/**
 * 删库重建（DROP DATABASE + CREATE）。
 * ⚠️⚠️ 只在无数据环境（发布前 schema 重构）用，生产环境绝不。
 *    由 SCHEMA_RESET=true 触发，deploy-cloud.mjs 的 --reset 会带上它。
 * ⚠️ 必须**不带库名**连接服务器（和 ensureDatabaseExists 同理）。
 */
export async function resetDatabase(): Promise<void> {
  const url = new URL(env.DATABASE_URL)
  const database = url.pathname.replace(/^\//, '')
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error(`非法库名：${database}`)
  url.pathname = '/'

  const conn = await mysql.createConnection({ uri: url.toString(), timezone: 'Z', connectTimeout: 15000 })
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${database}\``)
    await conn.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
    console.log(`[db] 已重建数据库：${database}`)
  } finally {
    await conn.end().catch(() => {})
  }
}

/**
 * 实时探一次数据库。
 *
 * ⚠️ 为什么需要它：dbState 是**启动时**的连接结果，之后就不再更新。
 *    数据库后来挂了（比如被销毁重建），/health 仍会报 ready —— 这是误导。
 *
 * ⚠️ 必须带短超时：云托管 MySQL 自动暂停后，恢复可能要几十秒；
 *    存活探针不能等那么久，否则 Pod 会被判定不健康。
 */
export async function pingDatabase(timeoutMs = 2500): Promise<'ok' | 'error' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      pool.query('SELECT 1').then(() => 'ok' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
      }),
    ])
    return result
  } catch {
    return 'error'
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 读一次库里的表清单，写进 dbState（会出现在 /health 的 existingTables 里）。
 *
 * ⚠️⚠️ 迁移**前**和**后**各读一次，是因为它们回答的是两个不同的问题：
 *    · 迁移前 = 「这个库原来长什么样」（诊断 v1 遗留库）
 *    · 迁移后 = 「现在到底有哪些表」（核对这次发版到底建没建出来）
 *    只留迁移前那一份的话，一次 --reset 部署之后 /health 会一直显示「空库」，
 *    而按 AGENT.md 的说法那正是「schema 不是新版」的判据 —— 于是一次成功
 *    的重建反而看起来像失败。（这个坑真实发生过：清库重建后 articleCount=null、
 *    existingTables 消失，排查时差点当成迁移没跑。）
 *
 * ⚠️ 只读、不抛：读不到就保持旧值，/health 不该因为一次 SHOW TABLES 失败而 500。
 */
async function refreshTableList(label: string): Promise<void> {
  try {
    const [rows] = await pool.query<mysql.RowDataPacket[]>('SHOW TABLES')
    dbState.existingTables = rows.map((r) => String(Object.values(r)[0]))
    console.log(
      '[db] ' + label + '已有表（' + dbState.existingTables.length + '）：' +
        (dbState.existingTables.join(', ') || '空库'),
    )
  } catch (err) {
    console.warn('[db] 读取表清单失败（不阻断）:', (err as Error).message)
  }
}

/**
 * 跑迁移。
 *
 * ⚠️ 多副本同时启动会并发跑迁移。本项目实例副本数为 1，可以接受；
 *    副本数调大后必须改成独立的迁移任务（或只在发布流水线里跑一次）。
 */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = resolveMigrationsFolder()

  // ⭐ 先列出已有表：线上库是 v1 遗留的，表名相同但结构不同会让迁移中途失败 ——
  //    有这份清单才能在 /health 里一眼定位。
  await refreshTableList('迁移前')

  console.log(`[db] 应用迁移：${migrationsFolder}`)
  await migrate(db, { migrationsFolder })
  console.log('[db] 迁移完成')
}

/**
 * ⭐ 数据库初始化 —— 在 serve() **之后**异步执行，绝不阻塞监听。
 *
 * ⚠️ 顺序很要命：云托管存活探针的 initialDelaySeconds 只有 2 秒，
 *    而 MySQL 冷启动恢复可能要几十秒。
 *    如果把 await waitForDatabase() 放在 serve() 之前，
 *    探针会在监听之前狂敲端口 → connection refused → 判定部署失败 → 反复重启。
 *    （这不是假设，是本项目真实踩过的部署失败原因。）
 */
/**
 * 统计句库行数并写进 dbState（会出现在 /health 里）。
 *
 * ⚠️ 必须**独立于 AUTO_MIGRATE**：本地开发容器的 AUTO_MIGRATE 是关的，
 *    曾经把统计写在迁移块里，于是本地永远显示 articleCount: null ——
 *    诊断信息自己不可靠，比没有还糟。
 */
async function refreshArticleCount(): Promise<void> {
  try {
    const { count } = await import('drizzle-orm')
    const { articles } = await import('./schema')
    const [row] = await db.select({ n: count() }).from(articles)
    dbState.articleCount = Number(row?.n ?? 0)
  } catch (err) {
    // 表还不存在（没跑过迁移）是正常情况，不该刷错误日志
    dbState.articleCount = null
  }
}

export async function initDatabase(): Promise<void> {
  if (envError) {
    dbState.status = 'error'
    dbState.error = `环境变量校验失败：${envError}`
    return
  }

  // ⭐ 先自举建库（幂等）。失败不阻断 —— 让后面 waitForDatabase 报出真正的原因。
  if (env.AUTO_MIGRATE) {
    if (env.SCHEMA_RESET) {
      try {
        await resetDatabase()
      } catch (err) {
        console.error('[db] 删库重建失败：', (err as Error).message)
      }
    }
    try {
      await ensureDatabaseExists()
    } catch (err) {
      console.warn('[db] 自动建库失败（继续尝试连接）：', (err as Error).message)
    }
  }

  // ⚠️ 这里会一直重试下去（见 waitForDatabase），所以永远走得到 ready —— 除非配置本身就是错的。
  await waitForDatabase()
  dbState.status = 'ready'
  await refreshArticleCount()
  dbState.error = ''

  if (!env.AUTO_MIGRATE) {
    console.log('[db] AUTO_MIGRATE 未开启，跳过迁移')
    return
  }

  try {
    await runMigrations()
    dbState.migrated = true
  } catch (err) {
    dbState.migrateError = (err as Error).message
    console.error('[db] 迁移失败：', dbState.migrateError)
  }

  /**
   * ⭐ 灌种子**独立于迁移**，不是「反正都在启动时干」就塞进同一个 try。
   *
   * ⚠️⚠️ 这两件事没有依赖关系，但曾经共用一次 try/catch ——
   *    后果是**一条迁移写错，句库就跟着空**：
   *    dev 环境连续几轮部署都卡在同一条语法错误的迁移上，
   *    而灌种子排在它后面、被一起跳过，真机上打开就是空句库。
   *    报错只落在 migrateError 里，而那句「已灌种子 N 篇」的日志压根没打印过。
   *    ⇒ 失败要分开、要互相不连坐：迁移坏了句子还能用，句子坏了也不必回滚迁移。
   */
  /**
   * ⭐ 奖励规则：**每次启动都补一次**（幂等，只在缺的时候插）。
   *
   * ⚠️ 刻意**不放在 SEED_ON_START 里面**：规则表不是「种子数据」，是**配置** ——
   *    空表的后果是「什么都不发」，而那是**静默**的（没有任何东西会报错，
   *    用户只是永远拿不到奖励，谁也不知道）。所以它跟迁移一样属于"服务能正常工作的前提"。
   * ⚠️ 只在**缺**的时候插：运营改过的阈值不会被启动覆盖（改配置不追溯）。
   */
  try {
    const { ensureDefaultRules } = await import('../services/rewards')
    await ensureDefaultRules()
  } catch (err) {
    console.error('[db] 奖励规则初始化失败（不影响服务启动）：', (err as Error).message)
  }

  if (env.SEED_ON_START) {
    try {
      try {
        const { seedArticles } = await import('./seed-articles')
        const n = await seedArticles()
        console.log(`[db] 已灌种子文章 ${n} 篇`)
      } catch (err) {
        // 灌种子失败不该让服务起不来 —— 服务活着 + /health 能看到问题，比直接崩好排查
        console.error('[db] 灌种子失败：', (err as Error).message)
      }

      // ⭐ 标准音进对象存储（幂等）。
      // ⚠️ 必须在**文章灌完之后**：它要按 contentJson 找到正文才能算出有几个词。
      // ⚠️ 失败同样不阻断启动 —— 音频没了只是「听不到标准音」，
      //    而句库是空的会让整个产品没法用。
      try {
        const { seedStandardAudio } = await import('../services/standard-audio')
        const r = await seedStandardAudio()
        console.log(`[db] 标准音：新灌 ${r.uploaded} 个文件，跳过 ${r.skipped} 篇`)
      } catch (err) {
        console.error('[db] 标准音灌入失败：', (err as Error).message)
      }
    } catch (err) {
      console.error('[db] 灌种子失败（不影响服务启动）：', (err as Error).message)
    }
  }

  /**
   * ⭐ 全部初始化动作跑完，**再照一次镜子**。
   *
   * ⚠️ 上面那两次 refreshArticleCount / refreshTableList 都在**迁移之前** ——
   *    首次部署、SCHEMA_RESET 清库重建这两种情况下，那时库里还什么都没有，
   *    于是 /health 会一直停在「空库 + articleCount: null」，
   *    而 AGENT.md 的排查表恰恰把这两个值当成「没灌上 / schema 不是新版」的判据，
   *    ⇒ 一次成功的初始化看起来像失败。
   * ⚠️ 放在最后而不是插在中间：seed 会插文章，articles 的行数要等它跑完才算得准。
   */
  await refreshTableList('当前')
  await refreshArticleCount()
}

/**
 * ⭐ 数据库执行体的两种形态：连接池本身，或一个事务。
 *
 * ⚠️ 为什么要这个类型：余额、流水、发放记录这些**必须在同一个事务里写**，
 *    于是很多 service 函数既要能被直接调用、也要能塞进别人的事务里。
 *    参数统一写成 Executor 就不会出现"某个 helper 偷偷开了第二个事务"。
 */
export type Db = typeof db
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export type Executor = Db | Tx
