import {
  difficultyFromScores,
  normalizeScores,
  normalizeTags,
  type ArticleContent,
  type ArticleLevel,
  type ArticleWordItem,
  type DifficultyScores,
} from '@jushuo/shared'

import { db } from '../db'
import { articles } from '../db/schema'
import { eq } from 'drizzle-orm'

/**
 * ⭐⭐ **"内容 → articles 各列"的映射与写入** —— 全站唯一一处。
 *
 * ⚠️⚠️ 为什么必须收成一处（这是 `domain-write-guard` 把我拦下来之后改的，它是对的）：
 *    写入方有**三个**（管理接口 / 部署灌库 / 测试数据），而"哪几个字段一起写、
 *    difficulty 由谁算、tags 要不要保序"这些规矩只能有一份。
 *    三份一旦分叉，症状是"后台加进去的句子没有难度"或"标签顺序变了"这类**静默**缺失。
 *
 * ⚠️ 两条硬规矩写在这里：
 *    ① **难度永远由判据分算**（`difficultyFromScores(scores)`），不接受调用方传进来 ——
 *       这样"库里的 difficulty"与"scores"永远自洽（老注释把它们的关系写反过，已改）。
 *    ② `id` **不在列里重复存**（行主键就是它）。
 */

export interface ArticleContentColumns {
  text: string
  translation: string
  words: ArticleWordItem[]
  links: string[]
  scores: DifficultyScores | null
  challenge: string | null
  advice: string | null
  tags: string[]
  difficulty: ArticleLevel | null
}

/** 把内容形状（或表单字段）**规范化**成各列的值 —— 纯函数，好测 */
export function contentColumnsOf(c: {
  text: string
  translation?: string
  words?: unknown
  links?: unknown
  scores?: unknown
  challenge?: string | null
  advice?: string | null
  tags?: unknown
}): ArticleContentColumns {
  const scores = normalizeScores(c.scores) ?? null
  return {
    text: c.text.trim(),
    translation: (c.translation ?? '').trim(),
    words: (Array.isArray(c.words) ? c.words : []) as ArticleWordItem[],
    links: (Array.isArray(c.links) ? c.links : []) as string[],
    scores,
    challenge: (c.challenge ?? '')?.toString().trim() || null,
    advice: (c.advice ?? '')?.toString().trim() || null,
    tags: normalizeTags(c.tags),
    // ⚠️ 规矩①：难度由判据分算。没有判据分就是 null —— **绝不补默认档位**
    difficulty: scores ? difficultyFromScores(scores) : null,
  }
}

/** 从 `ArticleContent`（内容文件的形状）取列 */
export function columnsFromArticleContent(c: ArticleContent): ArticleContentColumns {
  return contentColumnsOf({
    text: c.text,
    translation: c.translation,
    words: c.words,
    links: c.links,
    scores: c.scores,
    challenge: c.challenge ?? null,
    advice: c.advice ?? null,
    tags: c.tags,
  })
}

/**
 * 写入一条句子的内容列（更新已有行；不存在则建行）。
 *
 * @param isActive 新建时的上线状态。⚠️ 缺省 **false（草稿）**：
 *                 生成出来的东西要先过运营的眼，不能一存就在首页出现。
 */
export async function saveArticleContent(
  id: string,
  cols: ArticleContentColumns,
  opts: { isActive?: boolean } = {},
): Promise<{ created: boolean }> {
  const [existing] = await db.select({ id: articles.id }).from(articles).where(eq(articles.id, id)).limit(1)
  if (existing) {
    // ⚠️ 更新时**不碰 is_active**：发布/下线是另一个动作（管理接口的 isActive 字段），
    //    改一句译文不该顺手把它上线
    await db.update(articles).set(cols).where(eq(articles.id, id))
    return { created: false }
  }
  await db.insert(articles).values({ id, ...cols, isActive: opts.isActive ?? false })
  return { created: true }
}
