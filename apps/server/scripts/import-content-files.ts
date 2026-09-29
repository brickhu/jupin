import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'

import { db } from '../src/db'
import { articles } from '../src/db/schema'

/**
 * ⭐ **一次性导入**：把 `content/articles/*.json` 的正文灌进 `articles.content`。
 *
 * ⚠️⚠️ 它存在的意义就是"把真相从文件搬到库"（2026-09 用户定的方向：内容只走 admin）。
 *    搬完之后**运行时不再读那些文件**（`loadArticleContent()` 读库），
 *    文件退回"导入源 / 备份"的角色。
 *
 * ⚠️ 幂等，且**默认不覆盖已有正文**：只填 `content` 还是空的行。
 *    覆盖库里已经改过的正文是数据事故（admin 改过的内容不在文件里）。
 *    真需要覆盖就显式 `--force`，它会先列出将被覆盖的 id。
 *
 * ⚠️ 环境由 APP_ENV 决定（与其它脚本一致）：`APP_ENV=prod pnpm content:import` 才是线上。
 */
async function main(): Promise<void> {
  const force = process.argv.includes('--force')
  const here = dirname(fileURLToPath(import.meta.url))
  const dir = resolve(here, '../../../content/articles')
  if (!existsSync(dir)) {
    console.error('找不到 content/articles：' + dir)
    process.exit(1)
  }

  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  console.log(`· 发现 ${files.length} 份正文文件`)

  // 一次读全表：行数很少（内容量级），比逐条查清楚得多
  const rows = await db.select({ id: articles.id, content: articles.content }).from(articles)
  const byId = new Map(rows.map((r) => [r.id, r]))

  if (force) {
    const willOverwrite = rows.filter((r) => r.content !== null).map((r) => r.id)
    if (willOverwrite.length) {
      console.log(`⚠️ --force 将覆盖 ${willOverwrite.length} 条已有正文：${willOverwrite.join(', ')}`)
    }
  }

  let filled = 0
  let skippedNoRow = 0
  let skippedHasContent = 0
  for (const f of files) {
    const raw = JSON.parse(await readFile(join(dir, f), 'utf8')) as { id?: string }
    const id = raw.id ?? f.replace(/\.json$/, '')
    const row = byId.get(id)
    if (!row) {
      console.log(`  ⚠️ ${f} 在库里没有对应的行 —— 跳过（先在 admin 里建这一条，或先灌库）`)
      skippedNoRow++
      continue
    }
    if (row.content !== null && !force) {
      skippedHasContent++
      continue
    }
    await db.update(articles).set({ content: raw as never }).where(eq(articles.id, id))
    filled++
  }

  /**
   * ⚠️ 必须**重新查一次**：上面那份 `rows` 是写之前的快照。
   *    第一版就是拿它算"仍为空"的，于是刚灌完 16 条却报"仍为空 16 条"——
   *    这种"数字自相矛盾"的日志比没有日志更坏（它会让人以为没灌上而重跑一次）。
   */
  const after = await db.select({ id: articles.id, content: articles.content }).from(articles)
  const stillEmpty = after.filter((r) => r.content === null).length
  console.log(
    `\n✅ 回填完成：写入 ${filled} 条 · 跳过 ${skippedHasContent} 条（库里已有正文）· ` +
      `${skippedNoRow} 条（库里没有对应行）`,
  )
  console.log(`· 回填后仍为空的行：${stillEmpty} 条`)
  process.exit(0)
}

void main()
