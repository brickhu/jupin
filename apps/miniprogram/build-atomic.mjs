/**
 * ⭐ 给开发者工具的 beforeCompile 用：**先构建到临时目录，成功后再整体替换 dist/**。
 *
 * ⚠️⚠️ 为什么必须这样（用户 2026-09 报的「path ./uno.wxss not found from ./app.wxss」）：
 *    build.mjs 原来是「先 rm -rf dist，再重建」—— 只要中途失败，
 *    或者工具在重建过程中就开始了 wxss 编译，dist/ 就会停在
 *    「有 app.wxss、没有 uno.wxss」的半成品状态。
 *    而工具报出来的那条错**指向源码**（找不到 ./uno.wxss），
 *    看起来像源码里少了文件，实际是构建产物缺了一块 —— 极难往构建上想。
 *
 *    ⇒ 改成：构建到 dist.tmp → 成功才把 dist 换掉；
 *      失败时 **dist 原样保留**（工具继续编译上一版，不会白屏），并把错误大声打出来。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const PKG = import.meta.dirname
const DIST = resolve(PKG, 'dist')
const TMP = resolve(PKG, 'dist.tmp')
const OLD = resolve(PKG, 'dist.old')

// 只清临时目录，绝不碰 dist
rmSync(TMP, { recursive: true, force: true })

const r = spawnSync(process.execPath, [resolve(PKG, 'build.mjs'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, BUILD_DIST: TMP },
})

if (r.status !== 0) {
  console.error('')
  console.error('❌ 构建失败 —— dist/ **保持原样**（工具会用上一版产物，不会白屏）')
  console.error('   上面那条错误才是真正原因。')
  rmSync(TMP, { recursive: true, force: true })
  process.exit(r.status ?? 1)
}

// ⭐ 成功才替换：先把旧 dist 挪开，再把 tmp 改名过去（同一分区，rename 是原子的）
rmSync(OLD, { recursive: true, force: true })
if (existsSync(DIST)) renameSync(DIST, OLD)
renameSync(TMP, DIST)
rmSync(OLD, { recursive: true, force: true })
console.log('[build] ✅ dist/ 已整体替换（先构建到 dist.tmp，成功才换）')
