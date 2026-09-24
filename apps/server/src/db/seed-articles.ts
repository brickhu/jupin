import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { themeFromHash } from '@jushuo/shared'
import { resolveStaticRoot } from '../services/content'

/**
 * 开发用的种子句子 —— **索引**，不是正文。
 *
 * ⚠️ articles 只是索引：正文在 content/articles/<id>.json（路径由 id 推导）
 *    （仓库根 content/articles/*.json；云上由 Dockerfile COPY 到 /app/content）。
 *
 * ⭐ **内容寻址之后不再有硬编码清单**：
 *    文章 id = sha256(text) 前 16 位 = 正文文件名，所以这里直接扫内容目录、
 *    取每份 JSON 里的 `id`。加一句新内容 = 往 content/articles/ 丢一个文件。
 *
 * ⚠️ 为什么单独拆一个文件、且用**动态 import** 拿 db：
 *    服务启动时（db/index.ts）和命令行（db/seed.ts）都要用它。
 *    若在本文件顶部静态 import db，就会和 db/index.ts 形成循环依赖
 *    （index → seed-articles → index）。动态 import 把解析推迟到调用时，绕开这个环。
 *
 * ⚠️ 这里**不写排期** —— 种子只提供句子，排期是 schedules 表的事。
 */

export interface SeedArticle {
  id: string
}

/** 扫描 content/articles/*.json → 种子文章（id 取自正文 JSON 的 id） */
export async function loadSeedArticles(): Promise<SeedArticle[]> {
  const root = resolveStaticRoot()
  if (!root) return []
  const dir = join(root, 'content/articles')

  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return []
  }

  const out: SeedArticle[] = []
  for (const name of names) {
    try {
      const raw = JSON.parse(await readFile(join(dir, name), 'utf8')) as { id?: unknown }
      if (raw.id === undefined || raw.id === null) continue
      out.push({ id: String(raw.id) })
    } catch {
      // 坏 JSON 交给 content-files.test.ts 去报；这里跳过，不让服务起不来
    }
  }
  return out
}

/**
 * 幂等写入种子句子（靠主键 upsert，重复跑不会产生重复行）。
 * @returns 写入/更新的条数
 */
export async function seedArticles(): Promise<number> {
  const { db } = await import('./index')
  const { articles } = await import('./schema')
  const list = await loadSeedArticles()

  for (const a of list) {
    /**
     * ⚠️⚠️ 这几个派生字段必须**显式写**，而且要和「后台发布」（tools/admin 的
     *    upsertArticle）写的是**同一组**。
     *
     *    这里的教训：以前只写 id/contentJson，其余交给 DB 默认值 —— 而默认值之间
     *    是**互相矛盾**的（content_status 默认 'draft'，is_active 默认 true），
     *    于是灌出来的每一行都是「草稿但在线」；theme 则留 NULL，客户端只好退回
     *    品牌色，同一句话「后台发的」和「部署灌的」配**色不一样**。
     *    ⇒ 灌库就是上线，所以：isActive = true、theme 用与后台同一个确定性函数。
     *
     * ⚠️ 那个「两个默认值互相矛盾」的根已经拔掉了：content_status 那一列已删
     *    （迁移 0033），发布状态只剩 is_active 一个真相，不再有第二个字段可打架。
     *
     * ⚠️ 用 `ignore()`：**已存在的行一律不动** ——
     *    重复灌库不能覆盖运营已经改过的发布状态 / 主题 / 发布时间。
     *    （以前是 `onDuplicateKeyUpdate({ set: { contentJson } })`，
     *      而 content_json 这一列已经删掉了：正文路径现在由 id 推导。）
     */
    await db
      .insert(articles)
      // ⚠️ ignore() 必须挂在 insert(table) 之后、values() 之前 —— 这是 drizzle 的链式位置
      .ignore()
      .values({
        ...a,
        theme: themeFromHash(a.id),
        isActive: true,
        publishedAt: new Date(),
      })
  }

  // ⭐ 灌完正文顺手把难度 / 标签**物化**进索引（articles.difficulty + article_tags）。
  //    真相在正文 JSON 里，这两处只是能被 SQL 筛选的副本 —— 见 services/article-index.ts。
  //    ⚠️ 动态 import：本文件不能静态引 db（见文件头），而 article-index 引了 db。
  const { reindexArticles } = await import('../services/article-index')
  await reindexArticles(list.map((a) => a.id))

  return list.length
}
