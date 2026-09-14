/**
 * 小程序构建脚本。
 *
 * ⚠️ 小程序 + monorepo 有三个特有摩擦点（详见 AGENT.md 第一节）：
 *   1. 小程序不解析 node_modules 依赖树 → workspace symlink 会让「构建 npm」失灵
 *   2. Worker 必须是单文件 → 不能 require 外部包，必须独立打包
 *   3. 无打包器 → WXML/WXSS/JSON 需单独拷贝
 *
 * 解法就是本文件：esbuild 打包（把 @jushuo/shared 打进去）+ 拷贝静态资源。
 */
import { build, context } from 'esbuild'
import { cp, rm, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const WATCH = process.argv.includes('--watch')
const SRC = 'src'

const common = {
  bundle: true,                 // ⭐ 把 @jushuo/shared 打进去
  platform: 'neutral',
  target: 'es2020',
  format: 'cjs',                // 小程序用 CommonJS
  sourcemap: WATCH,
  logLevel: 'warning',
  alias: {
    '@jushuo/shared': '../../packages/shared/src/index.ts',
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

/** 拷贝 WXML / WXSS / JSON / 图片等静态资源 */
async function copyAssets() {
  await cp(SRC, 'dist', {
    recursive: true,
    filter: (p) => !p.endsWith('.ts'),
  })
}

async function run() {
  await rm('dist', { recursive: true, force: true })
  await mkdir('dist', { recursive: true })

  const entryPoints = await collectEntries(SRC)
  if (entryPoints.length === 0) throw new Error('未找到任何 .ts 入口')
  console.log(`[build] ${entryPoints.length} 个入口`)

  if (WATCH) {
    const ctx = await context({ ...common, entryPoints, outdir: 'dist', outbase: SRC })
    await ctx.watch()
    console.log('[build] watching…')
  } else {
    await build({ ...common, entryPoints, outdir: 'dist', outbase: SRC })
  }

  // ⭐ Worker 单独打包成单文件（小程序硬要求）
  await build({
    ...common,
    entryPoints: ['src/workers/audio-analysis/index.ts'],
    outfile: 'dist/workers/audio-analysis/index.js',
  })

  await copyAssets()
  console.log(WATCH ? '[build] 初始构建完成，等待变更…' : '[build] ✅ 完成 → dist/')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
