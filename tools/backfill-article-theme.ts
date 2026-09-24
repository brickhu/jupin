/**
 * ⭐ 把 articles.id 从「数字字符串」重映射成「内容 hash」，并回填 theme。
 *
 *   1. 读每篇正文 → articleId = sha256(text.trim()) 前 16 位（content-addressed）
 *   2. 重映射 articles.id 与 3 张外键表（schedules / submissions / article_tags）
 *   3. articles.theme = themeFromHash(newId)
 *   4. submissions.theme = 对应 articles.theme（按 article_id 拷）
 *
 * ⚠️ 幂等：已经映射过的（id 已是 hash）再跑，newId === oldId，是空操作。
 * ⚠️ 走**单连接**并在其上关外键检查：父 PK 改了、子表引用还没跟上。
 * ⚠️ 目标库由 DATABASE_URL 决定；dev/prod 地址解析在 tools/backfill-article-theme.mjs。
 *
 *   node tools/backfill-article-theme.mjs        # 本地
 *   node tools/backfill-article-theme.mjs dev    # dev 云库
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { themeFromHash } from '../packages/shared/src/theme'
import type { ArticleTheme } from '../packages/shared/src/types/content'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const require = createRequire(resolve(ROOT, 'apps/server/package.json'))
const mysql = require('mysql2/promise') as {
  createConnection: (url: string) => Promise<any>
}

/** ⚠️ 口径的唯一定义在 tools/pipeline/src/lib/article-id.ts —— 这里只是转出去，别复制 */
export { articleIdOf } from './pipeline/src/lib/article-id'

interface Mapping {
  oldId: string
  newId: string
  theme: ArticleTheme
}

/**
 * 按**文章 id**读正文。
 * ⚠️ 这个脚本跑在「id 还是数字」的那一刻 —— 那时文件名就是那个数字，
 *    所以用旧 id 推导出的路径正好指向旧文件。（以前是从 articles.content_json
 *    读路径，那一列已删除：路径由 id 推导，见 services/content.ts。）
 */
function readTextOfId(articleId: string): string | null {
  const abs = resolve(ROOT, 'content/articles', articleId + '.json')
  if (!existsSync(abs)) return null
  const parsed = JSON.parse(readFileSync(abs, 'utf8')) as { text?: string }
  return String(parsed.text ?? '')
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('缺少 DATABASE_URL')

  const conn = await mysql.createConnection(url)
  try {
    // ⚠️ 只取 id：正文路径由 id 推导（content_json 那一列已删）
    const [rows] = (await conn.query('SELECT id FROM articles ORDER BY id')) as [
      { id: string }[],
      unknown,
    ]
    console.log('[backfill] 文章数：' + rows.length)

    const mapping: Mapping[] = []
    for (const r of rows) {
      const text = readTextOfId(r.id)
      if (text === null) {
        console.warn('[backfill] 正文读不到，回退用旧 id 作为 hash 输入：' + r.id)
      }
      const newId = articleIdOf(text ?? r.id)
      mapping.push({ oldId: r.id, newId, theme: themeFromHash(newId) })
    }

    // 同文本 ⇒ 同 hash ⇒ 同一篇；真冲突说明库里本就有重复内容，必须人工处理
    const seen = new Map<string, string>()
    for (const m of mapping) {
      const prev = seen.get(m.newId)
      if (prev && prev !== m.oldId) {
        throw new Error('内容 hash 冲突：' + prev + ' 与 ' + m.oldId + ' 文本相同（content-addressed 不允许重复）')
      }
      seen.set(m.newId, m.oldId)
    }

    await conn.query('SET FOREIGN_KEY_CHECKS=0')
    await conn.beginTransaction()
    try {
      for (const m of mapping) {
        const themeJson = JSON.stringify(m.theme)
        await conn.execute('UPDATE articles SET id = ?, theme = ? WHERE id = ?', [m.newId, themeJson, m.oldId])
        await conn.execute('UPDATE schedules SET article_id = ? WHERE article_id = ?', [m.newId, m.oldId])
        await conn.execute('UPDATE submissions SET article_id = ? WHERE article_id = ?', [m.newId, m.oldId])
        await conn.execute('UPDATE article_tags SET article_id = ? WHERE article_id = ?', [m.newId, m.oldId])
      }
      await conn.commit()
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      await conn.query('SET FOREIGN_KEY_CHECKS=1')
    }

    // submissions.theme 从对应文章拷
    await conn.query('UPDATE submissions s JOIN articles a ON s.article_id = a.id SET s.theme = a.theme')

    const [after] = (await conn.query('SELECT id, theme FROM articles ORDER BY id')) as [
      { id: string; theme: ArticleTheme | null }[],
      unknown,
    ]
    for (const a of after) {
      console.log('  ' + a.id.slice(0, 12) + '…  ' + (a.theme ? a.theme.background + ' / ' + a.theme.foreground : '无 theme'))
    }
    console.log('[backfill] 完成')
  } finally {
    await conn.end()
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill] 失败：', err)
    process.exit(1)
  })
