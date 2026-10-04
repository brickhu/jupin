/**
 * ⭐ 给开发者工具的 beforeCompile 用：**先构建到临时目录，成功后再同步进 dist/**。
 *
 * ⚠️⚠️ 这里踩过两个坑，两次都很难查，别再改回去：
 *
 * **坑 1：直接 `rm -rf dist` 再重建 ⇒ dist 会停在半成品状态。**
 *    （用户 2026-09 报的「path ./uno.wxss not found from ./app.wxss」）
 *    工具在重建过程中就开始 wxss 编译，于是看到「有 app.wxss、没有 uno.wxss」，
 *    而它报的错**指向源码**（找不到 ./uno.wxss），看起来像源码缺文件 —— 极难往构建上想。
 *    ⇒ 所以先构建到 dist.tmp，**成功了才动 dist**；失败时 dist 原样保留（工具继续用上一版）。
 *
 * **坑 2：用「把整个 dist 目录改名换掉」来做到原子 ⇒ 开发者工具的监听从此失效。**
 *    工具的监听是绑在 dist 这个**目录 inode** 上的：
 *      renameSync(dist → dist.old) 把旧 inode 挪走，renameSync(dist.tmp → dist) 换上一个新 inode，
 *      再 rmSync(dist.old) 把旧 inode 删掉。
 *    结果工具盯的是一个**已被删除的目录** —— 收不到任何文件事件，
 *    于是「改了源码、重新编译，界面一模一样」；而它手里的旧文件清单还会让它去读
 *    早已删掉的文件（`dist/components/icon/icon.wxml` ENOENT）。
 *    ⇒ 现在**原地同步**：目录 inode 不变，逐文件替换。
 *
 * ⚠️ 顺序是 **新增 → 更新 → 删除**：新文件先落地，引它的文件才更新；
 *    被删的文件最后才删 —— 这样任何一个瞬间，`@import` / `usingComponents` 都能解析到。
 * ⚠️ 逐个文件也是**原子**的：先写同目录的临时文件再 rename，
 *    所以永远不存在"写了一半"的文件（坑 1 要防的就是这个）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const PKG = import.meta.dirname
const DIST = resolve(PKG, 'dist')
const TMP = resolve(PKG, 'dist.tmp')

/** 递归列出目录下所有文件的相对路径 */
function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, base, out)
    else out.push(relative(base, p))
  }
  return out
}

const digest = (file) => createHash('sha1').update(readFileSync(file)).digest('hex')

/** 同目录内「写临时文件 + rename」= 原子替换，不会出现写了一半的文件 */
function replaceFile(src, dst) {
  mkdirSync(dirname(dst), { recursive: true })
  const tmp = `${dst}.${process.pid}.tmp`
  copyFileSync(src, tmp)
  renameSync(tmp, dst)
}

/** 删掉空的子目录（文件删完后留一堆空壳目录会让人以为还有东西） */
function pruneEmptyDirs(dir) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      pruneEmptyDirs(p)
      if (readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true })
    }
  }
}

// ── 1) 构建到 dist.tmp（只清临时目录，绝不碰 dist）───────────────
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

// ── 2) 原地同步 dist.tmp → dist ──────────────────────────────────
const want = walk(TMP)
const have = new Set(walk(DIST))
const wantSet = new Set(want)

const added = want.filter((f) => !have.has(f))
const changed = want.filter((f) => have.has(f) && digest(join(TMP, f)) !== digest(join(DIST, f)))
const removed = [...have].filter((f) => !wantSet.has(f))

for (const f of added) replaceFile(join(TMP, f), join(DIST, f))
for (const f of changed) replaceFile(join(TMP, f), join(DIST, f))
for (const f of removed) rmSync(join(DIST, f), { force: true })
pruneEmptyDirs(DIST)

rmSync(TMP, { recursive: true, force: true })

const n = (files) => (files.length === 0 ? '—' : files.slice(0, 6).join(' ') + (files.length > 6 ? ` …(+${files.length - 6})` : ''))
console.log(`[build] ✅ dist/ 已原地同步：新增 ${added.length} / 更新 ${changed.length} / 删除 ${removed.length}`)
if (added.length) console.log(`        新增 ${n(added)}`)
if (removed.length) console.log(`        删除 ${n(removed)}`)
console.log('[build] ⚠️ 原地同步是**故意**的：目录 inode 不变，开发者工具的监听才不会失效')
