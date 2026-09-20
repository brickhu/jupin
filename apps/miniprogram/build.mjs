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
import { cp, rm, mkdir, readdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, watch, writeFileSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGenerator } from 'unocss'

import unoConfig, {
  assertWxssSafe,
  collectWxmlClasses,
  collectWxssClasses,
  downgradeColorSyntax,
  escapeWxml,
  makeEscapeMap,
} from './uno.config.mjs'

const WATCH = process.argv.includes('--watch')

// ⚠️ 所有路径都从**本文件位置**推导，不用相对 cwd 的写法。
//    因为这个脚本也会被 project.config.json 的 scripts.beforeCompile
//    钩子调用，而那个钩子的 cwd 不保证是本包目录。
const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(PKG_DIR, '../..')
const SRC = resolve(PKG_DIR, 'src')
const DIST = resolve(PKG_DIR, 'dist')
/** UnoCSS 产物落点 —— src/app.wxss 里 @import "./uno.wxss" 指的就是它 */
const UNO_OUT = resolve(DIST, 'uno.wxss')

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


/**
 * ⚠️⚠️ 有状态的模块必须**外置**，不能被内联进每个页面。
 *
 *    小程序里每个页面的 JS 是**独立的模块作用域**：同一份源码被内联进
 *    index.js / reading.js / arena.js 之后，就有三份互不相干的 module state。
 *    于是「全局 store」根本不全局 ——
 *      朗读页写的是它自己那份，首页读的是另外一份，谁也看不见谁。
 *
 *    ⚠️ 症状极具误导性：**参与人数会更新，个人状态永远不动**。
 *      因为参与人数来自服务端卡片数据（各页面自己拉的），
 *      而个人状态来自那个「共享」store。看起来像「一半功能坏了」，其实是模块不共享。
 *
 *    dist/lib/store.js 本来就会单独产出（src 下每个 .ts 都是入口），
 *    所以只要让页面的 import 改走 require('../../lib/store.js') 即可：
 *    小程序按**解析后的路径**缓存模块，同一个文件只会被求值一次 —— 那才叫共享。
 *
 *    ⚠️ 只外置**有状态**的模块。@jushuo/shared 那些纯函数、常量、文本
 *      复制几份无所谓；有状态的复制几份就是几个世界。
 */
/** 有状态、必须全局唯一的那几个模块（源码路径，不带扩展名） */
const SHARED_STATEFUL = [resolve(SRC, 'lib/store'), resolve(SRC, 'lib/api/client')]

/** 递归列出目录下所有 .js 产物 */
function walkJs(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkJs(p))
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

/**
 * 外置模块在产物里的占位写法，真正的相对路径由 onEnd 按**产物文件的真实位置**回填。
 * 加前后双下划线是为了它绝不可能和真实 import 写法撞上。
 */
const STATEFUL_MARK = '__jushuo_stateful__/'

const externalStateful = {
  name: 'external-stateful',
  setup(build) {
    /**
     * ⚠️ lib/api/client 也在这里：它持有 token / userId 两个模块级变量。
     *    现在它**碰巧能用** —— 因为那两个变量都有 wx.getStorageSync 兜底，
     *    每个页面的副本都能自己从 storage 里读回来。
     *    但那是运气，不是设计：哪天加一个有状态又没存盘的字段，
     *    就会出现和 store 一模一样的「一半更新一半不更新」，而且更难查。
     */
    // ⚠️ 必须按**解析后的文件**判断，不能按导入写法匹配：
    //    reading.ts 写的是 '../../lib/api/client'，而 upload.ts 写的是 './client'
    //    —— 同一个文件两种写法。按写法匹配必然漏掉一种，
    //    而漏掉的那次会把它重新内联进来，于是「共享」又变成了一份副本。
    //    （这不是假设：第一版就是这么漏掉 upload.ts 那条路的。）
    build.onResolve({ filter: /.*/ }, (args) => {
      // 入口本身没有 importer，不用处理（否则会把 lib/store.ts 这个入口也外置掉）
      if (!args.importer) return null
      if (!args.path.startsWith('.')) return null

      const abs = resolve(dirname(args.importer), args.path)
      const hit = SHARED_STATEFUL.find((p) => abs === p || abs === p + '.ts')
      if (!hit) return null

      // ⚠️⚠️ 这里**不能**直接按 importer 的位置算相对路径。
      //
      //    require 最终落在哪个文件里，取决于 importer 是「自己作为一个入口产出」
      //    还是「被内联进某个页面」—— 同一个 importer 两种都可能。
      //    真实踩过：lib/api/upload.ts 按自己的位置算出 './client.js'，
      //    但它被内联进了 pages/reading/reading.js，
      //    于是那条 require 去 pages/reading/ 找一个不存在的文件，
      //    **朗读页直接白屏打不开**（构建成功、类型检查通过、测试全绿）。
      //    lib/content/index.ts 同理发出 '../api/client.js'。
      //
      //    所以这里只打占位符，产物写完后由 onEnd 按每个文件的真实位置回填。
      return { path: STATEFUL_MARK + relative(SRC, hit).replace(/\\/g, '/'), external: true }
    })

    build.onEnd(() => {
      if (!existsSync(DIST)) return
      for (const file of walkJs(DIST)) {
        const src = readFileSync(file, 'utf8')
        if (!src.includes(STATEFUL_MARK)) continue
        const fixed = src.replace(
          new RegExp('require\\("' + STATEFUL_MARK + '([^"]+)"\\)', 'g'),
          (_all, key) => {
            let rel = relative(dirname(file), resolve(DIST, key + '.js')).replace(/\\/g, '/')
            if (!rel.startsWith('.')) rel = './' + rel
            return 'require("' + rel + '")'
          },
        )
        if (fixed !== src) writeFileSync(file, fixed)
      }
    })
  },
}
const common = {
  bundle: true,                 // ⭐ 把 @jushuo/shared 打进去
  platform: 'neutral',
  /**
   * ⚠️⚠️ 绝不能调到 es2020 及以上。
   *
   * 小程序真机引擎对 ES2020 语法的支持**不保证**（我们 project.config.json 里
   * es6/enhance 都是 false，等于放弃了开发者工具的降级兜底）。
   * `??`（空值合并）与 `?.`（可选链）一旦漏进产物，
   * 真机解析时直接抛 `SyntaxError: Unexpected token ?`，而模拟器不报 —— 已经真实踩过。
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
/**
 * ⚠️ ⚠️ 必须排除测试文件。
 *
 * 原因不是「多打一个文件」这么轻 —— 测试文件会**被当成页面入口**打进小程序：
 *   · 它们 import vitest，而 vitest 会拉进 expect-type 等一堆 Node 依赖，
 *     构建直接报 "Could not resolve"
 *   · 即便侥幸打进去，包里也会多出一份测试代码 —— 小程序包是有体积上限的
 *   · 它们常用顶层 await，而我们的 target 是 es2017，写到一半就炸
 * 这个坑本项目的 store.test.ts 真实踩过一次，别再放开。
 */
function isTestFile(name) {
  return /\.(test|spec)\.[cm]?[jt]s$/.test(name)
}

async function collectByExt(dir, exts) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await collectByExt(p, exts)))
    } else if (
      exts.some((e) => entry.name.endsWith(e)) &&
      !entry.name.endsWith('.d.ts') &&
      !isTestFile(entry.name)
    ) {
      out.push(p)
    }
  }
  return out
}

const collectEntries = (dir) => collectByExt(dir, ['.ts'])

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

// ----------------------------------------------------------------
// UnoCSS → dist/uno.wxss
// ----------------------------------------------------------------
let unoGen = null

/**
 * 生成原子类 WXSS。
 *
 * ⚠️ 为什么是「构建期扫源码 → 生成静态 WXSS」而不是运行时方案：
 *    **WXML 不能调用 JS**，所以 stylex.props() 这类必须先在 JS 里算出类名
 *    再塞进模板的方案，在小程序里都得额外搭一层 data 桥接。
 *    UnoCSS 全程在构建期跑，产物就是一份普通 WXSS，运行时零开销。
 *
 * ⚠️ 同时扫 .wxml 和 .ts，不能只扫 wxml：
 *    类名写在模板里是主流用法，但 class="{{ok ? 'text-ok' : 'text-bad'}}"
 *    这种**条件类名只会出现在 .ts 里**，只扫 wxml 会让它们静默失效
 *    （表现是「这个类怎么写都不生效」，没有任何报错）。
 */
async function buildUnoCss() {
  unoGen ??= await createGenerator(unoConfig)

  const files = await collectByExt(SRC, ['.wxml', '.ts'])
  const source = files.map((f) => readFileSync(f, 'utf8')).join('\n')

  const { css, matched } = await unoGen.generate(source, { preflights: true })
  // ⚠️ 必须降级颜色语法，否则老 WebView 会把整条颜色声明丢掉（见 uno.config.mjs）
  const out = downgradeColorSyntax(css)
  assertWxssSafe(out) // ⚠️ 产物不合规直接让构建失败，别留到真机上才发现
  await writeFile(UNO_OUT, out, 'utf8')

  console.log(
    `[uno] ${files.length} 个源文件 → ${matched.size} 个候选 → uno.wxss ${(out.length / 1024).toFixed(1)} KiB`,
  )
  return makeEscapeMap(matched)
}

/**
 * ⭐ 把 dist 里 WXML 的类名改写成与 WXSS 选择器一致的形式。
 *
 * ⚠️ 漏掉这一步的后果是**静默失效**：UnoCSS 生成的是 .pb-_lfl_60rpx_lfr_，
 *    而 WXML 里写的是 class="pb-[60rpx]" —— 类名对不上，样式不生效，
 *    构建不报错、开发者工具也不报错。详见 uno.config.mjs 的 makeEscapeMap()。
 *
 * ⚠️ 改写的是 **dist 里的副本**，src 始终保持自然写法（class="pb-[60rpx]"）。
 */
async function escapeWxmlClasses(map) {
  if (map.size === 0) return 0
  let total = 0
  for (const file of await collectByExt(DIST, ['.wxml'])) {
    const { code, hits } = escapeWxml(readFileSync(file, 'utf8'), map)
    if (hits > 0) {
      await writeFile(file, code, 'utf8')
      total += hits
    }
  }
  if (total > 0) console.log(`[uno] 改写 WXML 类名 ${total} 处（与 WXSS 选择器对齐）`)
  return total
}

/**
 * ⭐ 复查：WXML 里用到的**每一个**类名，都能在某份 WXSS 里找到定义。
 *
 * ⚠️ 为什么值得单独做一道：类名写错一个字母（`flx` / `flxe`）、
 *    或者转义漏了一处，表现都是**那条样式静默不生效** ——
 *    不报错、不警告，只能靠肉眼在真机上看出来。这类 bug 排查成本极高。
 *
 * 比较对象是 **dist 里所有 .wxss**（含手写的 app.wxss），
 * 所以它查的是「有没有死类」，**不是**强制你必须用工具类。
 */
async function assertClassesResolve() {
  const defined = new Set()
  for (const file of await collectByExt(DIST, ['.wxss'])) {
    for (const cls of collectWxssClasses(readFileSync(file, 'utf8'))) defined.add(cls)
  }

  const missing = []
  for (const file of await collectByExt(DIST, ['.wxml'])) {
    for (const cls of collectWxmlClasses(readFileSync(file, 'utf8'))) {
      if (!defined.has(cls)) missing.push(`${relative(DIST, file)}  →  ${cls}`)
    }
  }

  if (missing.length > 0) {
    console.error('❌ WXML 里用了以下类名，但没有任何 WXSS 定义它们（样式会静默失效）：')
    for (const m of missing) console.error('   · ' + m)
    console.error('')
    console.error('   常见原因：类名拼错 / 该工具类没被 UnoCSS 扫到 / 转义映射漏了。')
    process.exit(1)
  }
  console.log(`[wxss] ${defined.size} 个类名定义，WXML 引用全部有对应样式`)
}

/** 静态资源全套：拷贝 → 生成 WXSS → 改写 WXML 类名 → 复查类名 */
async function syncStaticAssets() {
  await copyAssets()
  const map = await buildUnoCss()
  await escapeWxmlClasses(map)
  await assertClassesResolve()
}

/**
 * watch 模式下静态资源变更要重新同步。
 * esbuild 的 watch 只管 .ts → .js，WXML/WXSS 完全不碰，所以这里得自己盯。
 */
function watchStaticAssets() {
  let timer = null
  watch(SRC, { recursive: true }, (_evt, file) => {
    if (!file || !/\.(wxml|wxss|json|ts)$/.test(file)) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      syncStaticAssets().catch((err) => console.error('[uno] 重新生成失败：' + err.message))
    }, 50)
  })
  console.log('[uno] 监听 wxml/wxss/json/ts 变更…')
}

/**
 * ⚠️⚠️ 构建后复查：有状态模块**没有被内联进页面**。
 *
 *    这类回归**不报错、不崩**，只会让「全局 store」悄悄变回每页一份 ——
 *    症状是「参与人数更新了，个人状态不动」这种一半好一半坏的样子，
 *    极难从现象倒推。所以必须在构建期钉死。
 *
 *    判据：页面里**用了**共享模块的导出，就必须**require 了它**。
 *    只有页面自己持有一份副本时，才会出现「用了但没有 require」。
 */
function assertSharedModulesExternal() {
  // [模块名, 它的若干导出标识符]
  // ⚠️ 每个模块给**多个**标识符，是因为不同引用方用到的导出不一样：
  //    页面用 arenaOf，而 nav-bar 只用 getState —— 只认一个的话，
  //    组件那一份被内联时这条断言根本不会触发。
  const shared = [
    ['store', ['arenaOf', 'applyProfile', 'getState']],
    ['api/client', ['submitReading', 'fetchMe']],
  ]
  const problems = []

  // ⚠️ **组件也要查**：nav-bar 的头像、user-sheet 的战绩都读着同一个 store。
  //    只查 pages 的话，组件那份被内联进来时这条断言完全看不见 ——
  //    而症状和页面那份一模一样（跨页面状态又变成各存各的），一样难查。
  const roots = [resolve(DIST, 'pages'), resolve(DIST, 'components')].filter((d) => existsSync(d))

  for (const file of roots.flatMap((d) => walkJs(d))) {
    const src = readFileSync(file, 'utf8')
    for (const [name, markers] of shared) {
      if (!markers.some((m) => src.includes(m))) continue
      if (src.includes('lib/' + name + '.js')) continue
      problems.push(
        relative(DIST, file) +
          ' 用了 ' + name + ' 却没 require 它 —— 被内联了' +
          '\n     后果：「全局」state 会变成每个页面一份，跨页面共享静默失效' +
          '\n     修法：见 build.mjs 里 externalStateful 插件的说明',
      )
    }
  }

  if (problems.length > 0) {
    console.error('')
    console.error('❌ 有状态模块被内联进了页面 / 组件：')
    for (const p of problems) console.error('   · ' + p)
    console.error('')
    process.exit(1)
  }
}

/**
 * 产物里**每一条相对 require 都必须指向真实存在的文件**。
 *
 * ⚠️ 小程序的 require 不做扩展名补全，也不做目录索引：
 *    路径写错的后果不是「功能降级」，而是**页面直接打不开**。
 *    而这类错误 esbuild 不会报（外置路径是原样写进产物的），
 *    tsc 更不会报（源码里的写法是对的），测试也全绿。
 *
 *    真实踩过：externalStateful 按 importer 自己的位置算相对路径，
 *    而 importer 被内联进了页面 —— 于是朗读页 require 了一个不存在的文件，
 *    构建成功、测试全绿、页面白屏。这条断言就是为它加的。
 */
function assertRequiresResolve() {
  const problems = []

  for (const file of walkJs(DIST)) {
    const src = readFileSync(file, 'utf8')

    // 占位符没被回填 → 说明 onEnd 没跑到，产物里留着一条谁也解析不了的 require
    if (src.includes(STATEFUL_MARK)) {
      problems.push(relative(DIST, file) + ' 里还留着未回填的外置模块占位符 ' + STATEFUL_MARK)
      continue
    }

    for (const m of src.matchAll(/require\("(\.[^"]*)"\)/g)) {
      if (!existsSync(resolve(dirname(file), m[1]))) {
        problems.push(relative(DIST, file) + ' require("' + m[1] + '") → 文件不存在')
      }
    }
  }

  if (problems.length > 0) {
    console.error('')
    console.error('❌ 产物里有解析不了的 require（页面会直接打不开）：')
    for (const p of problems) console.error('   · ' + p)
    console.error('')
    process.exit(1)
  }
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
    const ctx = await context({
      ...common,
      plugins: [externalStateful],
      entryPoints,
      outdir: DIST,
      outbase: SRC,
    })
    await ctx.watch()
    console.log('[build] watching…')
  } else {
    await build({ ...common, plugins: [externalStateful], entryPoints, outdir: DIST, outbase: SRC })
  }

  await syncStaticAssets()
  assertNoModernSyntax()
  assertSharedModulesExternal()
  assertRequiresResolve()

  if (WATCH) watchStaticAssets()
  console.log(WATCH ? '[build] 初始构建完成，等待变更…' : '[build] ✅ 完成 → dist/')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
