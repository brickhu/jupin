/**
 * 小程序构建脚本。
 *
 * ⚠️ 小程序 + monorepo 有三个特有摩擦点（详见 AGENT.md 第一节）：
 *   1. 小程序不解析 node_modules 依赖树 → workspace symlink 会让「构建 npm」失灵
 *   2. Worker 必须是单文件 → 不能 require 外部包，必须独立打包
 *   3. 无打包器 → WXML/WXSS/JSON 需单独拷贝
 *
 * 解法就是本文件：esbuild 打包（把 @jushuo/shared 打进去）+ 拷贝静态资源。
 *
 * ⭐ 另外它还负责**构建时注入配置**（见下面的 define）。
 *    小程序没有运行时环境变量（没有 process.env），
 *    部署坐标必须在构建时烘进包里 —— 但绝不能硬编码在源码里。
 */
import { build, context } from 'esbuild'
import { cp, rm, mkdir, readdir } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const WATCH = process.argv.includes('--watch')

// ⚠️ 所有路径都从**本文件位置**推导，不用相对 cwd 的写法。
//    因为这个脚本也会被 project.config.json 的 scripts.beforeCompile
//    钩子调用，而那个钩子的 cwd 不保证是本包目录。
const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(PKG_DIR, '../..')
const SRC = resolve(PKG_DIR, 'src')
const DIST = resolve(PKG_DIR, 'dist')

// ----------------------------------------------------------------
// 读配置：根目录 .env（本地）或 CI 环境变量（已有值不会被覆盖）
// ----------------------------------------------------------------
const envPath = resolve(ROOT, '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

/**
 * 需要注入小程序的配置项。
 * ⚠️ 都是**部署坐标**（环境 ID / 服务名 / 地址），不是密钥 ——
 *    但依然属于配置：改环境不该改源码。
 */
const INJECT = {
  __MP_LOCAL_API_URL__: 'MP_LOCAL_API_URL',
  __MP_LAN_API_URL__: 'MP_LAN_API_URL',
  __MP_DEV_ENV_ID__: 'MP_DEV_ENV_ID',
  __MP_PROD_ENV_ID__: 'MP_PROD_ENV_ID',
  __MP_CLOUD_SERVICE__: 'MP_CLOUD_SERVICE',
}

/** 这几项缺失会让某个环境静默不可用，所以直接让构建失败而不是产出坏包 */
const REQUIRED = ['__MP_LOCAL_API_URL__', '__MP_DEV_ENV_ID__', '__MP_PROD_ENV_ID__', '__MP_CLOUD_SERVICE__']

const define = {}
const missing = []
for (const [token, envKey] of Object.entries(INJECT)) {
  const value = process.env[envKey] ?? ''
  if (!value && REQUIRED.includes(token)) missing.push(envKey)
  define[token] = JSON.stringify(value)
}

/**
 * ⭐ 构建时间戳 —— 会出现在真机自检报告里。
 *
 * 为什么需要它：真机报告和本地最后一次改动之间隔着「构建 → 打包 → 推到手机」好几步。
 * 报告里不带构建时间，就分不清跑的是哪一版代码。
 * 本项目已经因此困惑过一次：dist 修改时间 01:20:01、报告时间 01:20:09，差 8 秒，
 * 完全无法判断新增的微基准是没编进去、还是没跑到。
 */
define.__MP_BUILD_TIME__ = JSON.stringify(new Date().toISOString())

if (missing.length > 0) {
  console.error('❌ 缺少小程序构建配置：' + missing.join(', '))
  console.error('')
  console.error('   来源：根目录 .env（参考 .env.example 的「小程序端构建配置」一节）')
  console.error('   或 CI 里以同名环境变量注入。')
  console.error('')
  console.error('   ⚠️ 刻意让构建失败：这些值缺失会让对应环境静默连不上，比报错难查得多。')
  process.exit(1)
}

const common = {
  bundle: true,                 // ⭐ 把 @jushuo/shared 打进去
  platform: 'neutral',
  /**
   * ⚠️⚠️ 绝不能调到 es2020 及以上。
   *
   * 本项目的 Worker（workers/audio-analysis）是**独立 JS 上下文**，
   * **不走开发者工具的 es6→es5 转译**（我们 project.config.json 里 es6/enhance 都是 false）。
   * 而 `??`（空值合并）与 `?.`（可选链）都是 ES2020 语法，
   * 真机引擎解析 Worker 时会直接抛 `SyntaxError: Unexpected token ?`。
   *
   * 这个坑只在**真机**上炸，模拟器不报 —— 已经真实踩过一次。
   *
   * 为什么是 es2017 而不是更低：esbuild 无法把 async/await 降级到 ES5，
   * 而 es2017 原生就有 async/await，同时会把 ?? / ?. 降级掉。
   *
   * 下面 assertNoModernSyntax() 会在构建后复查，别绕过它。
   */
  target: 'es2017',
  format: 'cjs',                // 小程序用 CommonJS
  sourcemap: WATCH,
  logLevel: 'warning',
  define,                       // ⭐ 构建时注入配置
  // ⚠️ alias 的值也必须是**绝对路径** —— esbuild 是按 cwd 解析 alias 的，
  //    写成相对路径时，换个 cwd 调用就会「Could not resolve」。
  alias: {
    '@jushuo/shared': resolve(ROOT, 'packages/shared/src/index.ts'),
  },
}

/**
 * 递归收集 .ts 入口。
 * ⚠️ 必须排除 .d.ts —— 否则会被编译成一堆空的 .d.js。
 *    这里用手写遍历而不是 fs.glob，避免依赖 Node 版本。
 */
async function collectEntries(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await collectEntries(p)))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(p)
    }
  }
  return out
}

/**
 * 复核产物里没有残留 ES2020+ 语法。
 *
 * ⚠️ 为什么值得单独做一道检查：这类问题**只在真机上炸、模拟器完全正常**，
 *    而且报错信息是 `invalid file: xxx.js` 这种离根因很远的形式，
 *    排查成本极高。宁可构建期就拦下来。
 */
function assertNoModernSyntax() {
  const BANNED = [
    [/\?\?/, '?? 空值合并（ES2020）'],
    [/\?\./, '?. 可选链（ES2020）'],
    [/\bglobalThis\b/, 'globalThis（ES2020）'],
    [/\?\?=/, '??= 空值赋值（ES2021）'],
    [/\|\|=/, '||= 逻辑或赋值（ES2021）'],
    [/&&=/, '&&= 逻辑与赋值（ES2021）'],
  ]
  const hits = []
  for (const entry of walkDist(DIST)) {
    if (!entry.endsWith('.js')) continue
    const code = stripLiterals(readFileSync(entry, 'utf8'))
    for (const [re, label] of BANNED) {
      if (re.test(code)) hits.push(`${relative(DIST, entry)} 含 ${label}`)
    }
  }
  if (hits.length > 0) {
    console.error('❌ 产物里残留了 ES2020+ 语法（真机引擎会解析失败）：')
    for (const h of hits) console.error('   · ' + h)
    console.error('')
    console.error('   Worker 是独立 JS 上下文，不走开发者工具转译 —— 见 build.mjs 里 target 的注释。')
    process.exit(1)
  }
}

/** 粗略剥掉字符串字面量与注释，避免扫描误报 */
function stripLiterals(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/** 递归列出目录下所有文件 */
function walkDist(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkDist(p))
    else out.push(p)
  }
  return out
}

/** 拷贝 WXML / WXSS / JSON / 图片等静态资源 */
async function copyAssets() {
  await cp(SRC, DIST, {
    recursive: true,
    filter: (p) => !p.endsWith('.ts'),
  })
}

async function run() {
  await rm(DIST, { recursive: true, force: true })
  await mkdir(DIST, { recursive: true })

  const env = Object.fromEntries(Object.entries(INJECT).map(([t, k]) => [k, process.env[k] ?? '']))
  console.log('[build] 注入配置：' + JSON.stringify(env))

  const entryPoints = await collectEntries(SRC)
  if (entryPoints.length === 0) throw new Error('未找到任何 .ts 入口')
  console.log(`[build] ${entryPoints.length} 个入口`)

  if (WATCH) {
    const ctx = await context({ ...common, entryPoints, outdir: DIST, outbase: SRC })
    await ctx.watch()
    console.log('[build] watching…')
  } else {
    await build({ ...common, entryPoints, outdir: DIST, outbase: SRC })
  }

  // ⭐ Worker 单独打包成单文件（小程序硬要求）
  await build({
    ...common,
    entryPoints: [resolve(SRC, 'workers/audio-analysis/index.ts')],
    outfile: resolve(DIST, 'workers/audio-analysis/index.js'),
  })

  await copyAssets()
  assertNoModernSyntax()
  console.log(WATCH ? '[build] 初始构建完成，等待变更…' : '[build] ✅ 完成 → dist/')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
