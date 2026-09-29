import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { and, eq, isNull } from 'drizzle-orm'
import { themeFromHash } from '@jushuo/shared'
import type { ArticleContent } from '@jushuo/shared'

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
  /**
   * ⭐ **整份正文**（文件里的原样内容）—— 过渡期回填用（见 backfillMissingContent）。
   * ⚠️ 它只是"文件里有什么"，不是真相；真相是 `articles.content`。
   * ⚠️ 类型用 `ArticleContent`（与 `loadArticleContent` 的返回同型）而不是
   *    `Record<string, unknown>`：后者会让这条记录塞不进 `insert(articles)`（列有精确类型），
   *    而"文件里的形状"本来就该与 `ArticleContent` 一致（content-files.test.ts 在 CI 上查）。
   */
  content: ArticleContent
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
      const raw = JSON.parse(await readFile(join(dir, name), 'utf8')) as Record<string, unknown> & {
        id?: unknown
      }
      if (raw.id === undefined || raw.id === null) continue
      out.push({ id: String(raw.id), content: raw as unknown as ArticleContent })
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
/**
 * ⭐⭐ **把正文补齐，再把派生列（difficulty / tags）物化一遍** —— 顺序不能反。
 *
 * ⚠️⚠️ 为什么必须有这个入口（差一点造成静默错误）：
 *    原先是 `seedArticles()` 灌完种子**立刻**物化索引（`reindexArticles(ids)`），
 *    而正文是**之后**才回填进 `articles.content` 的 ⇒ 物化那一刻正文还是空
 *    ⇒ `difficulty` / `tags` 被写成 **null / 空**，而"灌库成功"的日志一切正常。
 *    这类错误没有报错、没有红字，只有"标签空了、难度没了"。
 *    ⇒ 把两件事收进一个函数、按正确顺序写死，两条初始化路径都调它。
 *
 * ⚠️ 物化走**全表**（不传 ids）：这样"正文早就填了、只是派生列为空"的存量行
 *    也会被顺手修好，而不是只照顾这次导入的那几篇。
 */
export async function reindexFromContent(): Promise<{ reindexed: number; stillEmpty: number }> {
  const { reindexArticles } = await import('../services/article-index')
  const backfilled = await backfillMissingContent()
  const results = await reindexArticles()
  return { reindexed: results.length, stillEmpty: backfilled.stillEmpty }
}

/**
 * ⭐⭐ **把已有行缺失的正文补上**（一次性，过渡期自愈用）。
 *
 * ⚠️⚠️ 为什么必须有它（差一点造成事故）：
 *    2026-09 正文搬进了 `articles.content`（库为真相），而 `seedArticles()` 用的是
 *    `insert().ignore()` —— **已存在的行一律不动**。于是：
 *      迁移 0042 给所有老行加了 `content` 列（全 NULL）→ 灌库跳过它们（已存在）
 *      → `loadArticleContent()` 读库拿到 NULL → **朗读页在每一个环境同时打不开**。
 *    这不是"可能出错"，是"只要部署就必错"，而且症状（正文加载失败）完全指不出真因。
 *
 * ⚠️ 它只填 `content IS NULL` 的行，所以幂等、也不会覆盖 admin 改过的正文。
 * ⚠️ 依赖 `content/articles/*.json` 这些文件**还在** ⇒ 它是**过渡措施**：
 *    等所有环境的库都填满之后，这个函数和那些文件一起删
 *    （见 plan C12 的 C3/C4）。
 */
export async function backfillMissingContent(): Promise<{ filled: number; stillEmpty: number }> {
  const { db } = await import('./index')
  const { articles } = await import('./schema')
  const { isNull, eq } = await import('drizzle-orm')

  const list = await loadSeedArticles()
  let filled = 0
  for (const a of list) {
    const [row] = await db
      .select({ content: articles.content })
      .from(articles)
      .where(eq(articles.id, a.id))
      .limit(1)
    if (!row || row.content !== null) continue
    await db.update(articles).set({ content: a.content as never }).where(eq(articles.id, a.id))
    filled++
  }
  const empty = await db.select({ id: articles.id }).from(articles).where(isNull(articles.content))
  return { filled, stillEmpty: empty.length }
}

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

  /**
   * ⭐ **本机模式下**顺手把 `standard_audio` 这一列写上。
   *
   * ⚠️⚠️ 为什么必须有这一步（踩过）：`audioRefOf` 是**以这一列为准**的 ——
   *    它是空，接口就**不给 audio**，客户端连播放钮都不渲染
   *    （见 services/standard-audio.ts 的说明）。
   *    而往 content/articles/ 丢文件 + 灌库，并不会写这一列 ⇒ 新内容的卡片
   *    「正文在、播放钮没有」，看起来就像"音频被搞掉了"。
   *
   * ⚠️⚠️ 只在 **STORAGE=local** 时写：
   *    这一列的含义是「音频**分发得出去**」，不是「盘上有文件」。
   *    云端由 seedStandardAudio 把它**上传到对象存储成功之后**才写
   *    （见 standard-audio.ts:203）—— 提前写，客户端会拿到一个指向空桶的 fileID
   *    ⇒ 「按钮在、点了没声音」，比没有按钮更难查。
   *
   * ⚠️ 两个动作都要：
   *    ① 新行 —— 上面 insert 时就带上（ignore() 不会碰已有的行）；
   *    ② 老行 —— 上一轮灌过、当时这一列还是 NULL 的（比如这次新增的 7 篇），
   *       只在它还是 NULL 时才补，绝不覆盖运营/部署写过的值。
   */
  const root = resolveStaticRoot()
  if (process.env.STORAGE === 'local' && root) {
    const { audioKeyOf } = await import('../services/standard-audio')
    for (const a of list) {
      const key = audioKeyOf(a.id)
      if (!existsSync(resolve(root, key))) continue
      await db
        .update(articles)
        .set({ standardAudio: key })
        .where(and(eq(articles.id, a.id), isNull(articles.standardAudio)))
    }
  }

  return list.length
}
