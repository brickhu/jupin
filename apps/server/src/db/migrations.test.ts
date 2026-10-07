import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const DRIZZLE_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url))
const BREAKPOINT = '--> statement-breakpoint'

/**
 * 迁移文件里**每一对相邻语句之间必须有 `--> statement-breakpoint`**。
 *
 * ⚠️⚠️ 少一个的后果不是「迁移写得丑」，是**整个环境再也升不上去**：
 *    drizzle 按这个标记把文件切成一条条语句分别执行，
 *    少一个标记就把两条语句当成**一条**发出去 ——
 *    而连接上没开 multipleStatements，MySQL 直接抛语法错误。
 *
 * ⚠️ 这个错**本地看不出来**：本地 AUTO_MIGRATE 关着，迁移是手工敲进去的，
 *    drizzle 根本没跑过这个文件。于是它是这样暴露的：
 *    dev 环境连续几轮部署都卡在同一条迁移上，**表一直建不出来**，
 *    而连坐的还有跟在迁移后面的「灌句库」—— 于是真机上就是空句库。
 *    症状离原因隔了三层，只能靠 /health 的 migrateError 才看得出来。
 */
describe('迁移文件', () => {
  const files = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith('.sql'))

  it('确实找得到迁移文件（路径写错时这条会先炸，而不是静默通过）', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('每条语句后面都有 statement-breakpoint', () => {
    const problems: string[] = []

    for (const file of files.sort()) {
      const lines = readFileSync(`${DRIZZLE_DIR}/${file}`, 'utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] ?? '').trim()
        // 只关心「真的结束了这条语句」的行
        if (!line.endsWith(';') || line.includes(BREAKPOINT)) continue

        // 看下一条非空行
        let j = i + 1
        while (j < lines.length && !(lines[j] ?? '').trim()) j++
        if (j >= lines.length) continue // 文件里的最后一条，不需要
        if ((lines[j] ?? '').trim() === BREAKPOINT) continue

        problems.push(`${file} 第 ${i + 1} 行的语句后面没有 ${BREAKPOINT}`)
      }
    }

    expect(problems).toEqual([])
  })

  /**
   * ⚠️⚠️ **文件不能以 breakpoint 结尾** —— 2026-10 为此在 dev 上卡了一轮。
   *
   * drizzle 是按 `--> statement-breakpoint` **切块**执行的（切完逐块发出去）。
   * 结尾多一个标记 ⇒ 切出来的**最后一块是空的** ⇒ MySQL 报
   *
   *     Query was empty
   *
   * ⚠️ 这个错**本地看不出来**（和上面那条同一个道理）：本地那条迁移早就 applied 了，
   *    drizzle 按 `__drizzle_migrations.created_at` 直接跳过，**根本没读文件**。
   *    于是它只在云上第一次真正执行那份文件时才暴露。
   *
   * ⚠️ 上面那条检查抓不到它：它查的是"语句后面有没有标记"，而这个是"标记后面有没有语句"。
   */
  it('不以 statement-breakpoint 结尾（结尾会切出一个空语句）', () => {
    const problems: string[] = []

    for (const file of files.sort()) {
      const text = readFileSync(`${DRIZZLE_DIR}/${file}`, 'utf8')
      if (text.trimEnd().endsWith(BREAKPOINT)) {
        problems.push(`${file} 以 ${BREAKPOINT} 结尾 —— 末尾会切出一个空语句，MySQL 报 Query was empty`)
      }
      /**
       * ⚠️ 顺带查**中间**的空块：连续两个标记之间什么都没有，同样会发一条空语句。
       *    比只查结尾更彻底 —— 反正判据一样（切出来不能有空块）。
       */
      const chunks = text.split(BREAKPOINT)
      chunks.forEach((chunk, i) => {
        // 最后一块允许为空（正常文件本来就以换行结束）
        if (i === chunks.length - 1) return
        if (!chunk.trim()) problems.push(`${file} 第 ${i + 1} 块是空的（两个标记之间没有语句）`)
      })
    }

    expect(problems).toEqual([])
  })
})
