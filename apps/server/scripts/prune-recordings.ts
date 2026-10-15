import { readdir, stat, unlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import mysql from 'mysql2/promise'

/**
 * ⭐ **清对象存储里的孤儿录音**（plan B86）。
 *
 * ## 为什么需要它
 *
 * `tools/wipe-history.mjs` **只清库** ⇒ 库清了、盘上那些用户录音还在：
 * 它们成了**没人引用**的文件（白占存储，而且里面是用户的语音）。
 *
 * ## 判据只有一条：**盘上有、但库里没人引用**
 *
 * 引用来源两处（`submissions.audio_key` 与 `participations.audio_key` —— 后者是被采纳那条）。
 *
 * ⚠️⚠️ **只碰 `audio/` 前缀**（用户录音 = `audio/{句子}/{用户}/{attemptId}.mp3`）。
 *    标准音在 `content/audio/` 下，**碰它就是把全站的标准音删了** ——
 *    所以这里对前缀做**硬断言**，不靠"我记得"。
 *
 * ⚠️⚠️ **云端暂时清不了**：云托管对象存储那三个接口（`/tcb/uploadfile`、
 *    `/tcb/batchdownloadfile`、`/tcb/batchdeletefile`）**没有列举**，
 *    而孤儿之所以是孤儿，正是"库里已经没有它们的 key 了" ⇒ **没有枚举就无解**
 *    （key 里带客户端生成的 attemptId，猜不出来）。
 *    ⇒ 云端要么在**控制台按前缀删**，要么等哪天开通"开放接口服务"用 COS 的列举接口。
 *      本脚本遇到 `STORAGE != local` 会**直接说清楚**，而不是假装清了一遍。
 *
 * ⚠️ 默认**只看不改**；真的删加 `--yes`（或 `WIPE_APPLY=1`）。
 */

const url = process.env.DATABASE_URL
if (!url) {
  console.error('❌ 没有 DATABASE_URL')
  process.exit(1)
}
/**
 * ⚠️⚠️ **两个开关都要认**：`WIPE_APPLY=1`（给壳脚本用）与命令行 `--yes`（给人用）。
 *    只认前者的话，`pnpm recordings:prune --yes` 会**被忽略、还打印"只看不改"** ——
 *    看起来跑过了、其实没删（最坏的一种失败）。
 */
const apply = process.env.WIPE_APPLY === '1' || process.argv.includes('--yes')
const RECORDING_PREFIX = 'audio/'

const storage = process.env.STORAGE ?? 'local'
if (storage !== 'local') {
  console.error('⚠️  当前 STORAGE=' + storage + '（不是 local）—— **这个脚本清不了云端**。')
  console.error('   云托管对象存储只有 upload / download / delete 三个接口，**没有列举**；')
  console.error('   而孤儿之所以是孤儿，就是"库里已经查不到它们的 key 了" ⇒ 无法枚举、也就无法清理。')
  console.error('   ⇒ 云端请在**控制台按前缀删除**（前缀 audio/），不要用本脚本。')
  process.exit(2)
}

/**
 * ⚠️ 默认根必须与 `storage/local.ts` 的 `DEFAULT_ROOT` **一致**（`<仓库根>/.uploads`）——
 *    本脚本在 `apps/server/scripts/` 下，往上三级才是仓库根（多一级会算到别的目录去，
 *    而算错的**表现是"盘上一个文件都没有"**，看起来像"已经清干净了"）
 */
const root = process.env.STORAGE_LOCAL_DIR ?? join(import.meta.dirname, '../../../.uploads')
const conn = await mysql.createConnection(url)

/** 库里还引用着的 key（两处：成绩单 + 被采纳那条档案） */
async function referencedKeys(): Promise<Set<string>> {
  const out = new Set<string>()
  for (const sql of [
    'SELECT audio_key AS k FROM submissions WHERE audio_key IS NOT NULL',
    'SELECT audio_key AS k FROM participations WHERE audio_key IS NOT NULL',
  ]) {
    const [rows] = await conn.query(sql)
    for (const r of rows as { k: string }[]) if (r.k) out.add(r.k)
  }
  return out
}

/** 盘上 `audio/` 下的所有 key（相对 root，带前缀） */
async function onDisk(): Promise<{ key: string; path: string; bytes: number }[]> {
  const base = join(root, 'audio')
  const out: { key: string; path: string; bytes: number }[] = []
  const walk = async (dir: string): Promise<void> => {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(dir, n)
      const st = await stat(p)
      if (st.isDirectory()) await walk(p)
      else out.push({ key: relative(root, p), path: p, bytes: st.size })
    }
  }
  await walk(base)
  return out
}

const referenced = await referencedKeys()
const disk = await onDisk()
const orphans = disk.filter((f) => !referenced.has(f.key))

/** ⚠️ 硬断言：这一批的每一个 key 都必须在录音前缀下（防手抖把标准音卷进来） */
const wrong = orphans.filter((o) => !o.key.startsWith(RECORDING_PREFIX))
if (wrong.length > 0) {
  console.error('❌ 有文件不在 ' + RECORDING_PREFIX + ' 前缀下，拒绝执行：')
  for (const w of wrong.slice(0, 5)) console.error('   ' + w.key)
  await conn.end()
  process.exit(1)
}

const bytes = orphans.reduce((s, o) => s + o.bytes, 0)
console.log('')
console.log('目标目录：' + root + '（STORAGE=local）')
console.log('  盘上录音：' + disk.length + ' 个')
console.log('  库里还引用着：' + referenced.size + ' 个')
console.log('  ⇒ 孤儿：' + orphans.length + ' 个 / ' + (bytes / 1024 / 1024).toFixed(1) + ' MB')
console.log('')
console.log('⚠️ 只删 ' + RECORDING_PREFIX + ' 前缀下的孤儿；标准音（content/audio/）一个字都不碰。')

if (!apply) {
  console.log('（只看不改）要真的删，加 --yes。')
  await conn.end()
  process.exit(0)
}
if (orphans.length === 0) {
  console.log('✅ 没有孤儿，什么都没做。')
  await conn.end()
  process.exit(0)
}

let deleted = 0
for (const o of orphans) {
  try {
    await unlink(o.path)
    deleted++
  } catch (err) {
    console.warn('  ⚠️ 删不掉（跳过）：' + o.key + ' —— ' + (err as Error).message)
  }
}
console.log('')
console.log('✅ 删掉 ' + deleted + ' 个孤儿录音（' + (bytes / 1024 / 1024).toFixed(1) + ' MB）')
const left = (await onDisk()).filter((f) => !referenced.has(f.key)).length
console.log('复核：仍是孤儿的还有 ' + left + ' 个' + (left === 0 ? ' ✅' : ' ⚠️'))
await conn.end()
