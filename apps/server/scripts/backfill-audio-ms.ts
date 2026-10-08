/**
 * ⭐ **回填标准音时长**（`articles.standard_audio_ms`）—— 一次性，跑完就不需要了。
 *
 * ## 为什么要有它
 *
 * 0063 之前入库的内容没有这一列的值 ✗ ⇒ 阅读页那个 `00:23` 会空着 ✓
 * （读不到就**退回读文件** ✓ 而那个目录**已经不在生产镜像里** ✓）
 *
 * ## ⚠️⚠️ 它**从对象存储读音频**，不是从 content/
 *
 * 那是有意的 ✓：`content/` 是遗留目录 ✓ 而这个脚本要能在**任何环境**跑
 * （本机 / dev / prod ✓）—— 从 storage 读就完全不需要它 ✓
 * ⭐ 顺带证明了「音频只有一个住址」：**对象存储** ✓
 *
 * ## 用法
 *
 *     pnpm --filter @jushuo/server audio:backfill          # 只补空的
 *     pnpm --filter @jushuo/server audio:backfill --force  # 全部重量
 */
import { eq, isNull, or, sql } from 'drizzle-orm'
import { db } from '../src/db'
import { articles } from '../src/db/schema'
import { getStorage } from '../src/storage'
import { audioKeyOf } from '../src/services/standard-audio'
import { mp3DurationMs } from '../src/services/mp3-duration'

const force = process.argv.includes('--force')

/** ⚠️ 只处理"有标准音但那列还空着"的行 —— 没标准音的本来就该空 ✓ */
const rows = await db
  .select({ id: articles.id, standardAudio: articles.standardAudio, ms: articles.standardAudioMs })
  .from(articles)
  .where(force ? sql`${articles.standardAudio} is not null` : or(isNull(articles.standardAudioMs), eq(articles.standardAudioMs, 0)))

console.log(`[backfill] 待处理 ${rows.length} 条${force ? '（--force：全部重量）' : ''}`)

const storage = getStorage()
let ok = 0
let missing = 0
let unparsable = 0

for (const row of rows) {
  const key = row.standardAudio ?? audioKeyOf(row.id)
  let bytes: Uint8Array
  try {
    bytes = await storage.get(key)
  } catch {
    // ⚠️ 音频不在存储里 —— 这是**数据问题**（不是脚本问题）⇒ 明确报出来 ✓
    console.warn(`  ✗ ${row.id}：存储里没有 ${key}`)
    missing++
    continue
  }
  const ms = mp3DurationMs(Buffer.from(bytes))
  if (ms === null) {
    console.warn(`  ✗ ${row.id}：解析不出时长（编码不认？）`)
    unparsable++
    continue
  }
  await db.update(articles).set({ standardAudioMs: ms }).where(eq(articles.id, row.id))
  ok++
  console.log(`  ✓ ${row.id} → ${ms}ms`)
}

console.log(`[backfill] 完成：成功 ${ok} · 存储里没有 ${missing} · 解析不出 ${unparsable}`)
process.exit(0)
