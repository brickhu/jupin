import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { normalizeDifficulty, normalizeTags } from '@jushuo/shared'
import type { ArticleListItem } from '@jushuo/shared'
import { db } from '../db'
import { articles } from '../db/schema'
import { loadArticleContent } from '../services/content'
import { audioRefOf, fileIdOf, wordAudioKeyOf } from '../services/standard-audio'
import { scheduleAudioOf } from '../services/standard-audio-meta'
import type { Variables } from '../middleware/auth'

export const articlesRoutes = new Hono<{ Variables: Variables }>()

/**
 * ⭐⭐ 句库 —— **公开接口**：谁来都拿到同一份，不含任何「我的」数据。
 *
 * ⚠️⚠️ 两个概念**分清楚**，别混成一条：
 *    · GET /api/articles      → **列表**：瘦，只够画一张卡片
 * *（id / 正文 / 译文 / 难度 / 标签 / 标准音引用与时长）*
 *    · GET /api/articles/:id  → **详情**：全量，阅读页要的那一份（含词级数据）
 *    把词级数据塞进列表，首屏就要为全站句子付一遍音标/释义/逐词音频的代价。
 *
 * ⚠️ 只列 isActive 的（下架的句子仍能按 id 打开详情：成绩还在，见 arenas.ts）。
 */
articlesRoutes.get('/', async (c) => {
  const rows = await db
    .select({
      id: articles.id,
      contentJson: articles.contentJson,
      standardAudio: articles.standardAudio,
    })
    .from(articles)
    .where(eq(articles.isActive, true))
    .orderBy(desc(articles.id))

  const items = (
    await Promise.all(
      rows.map(async (a): Promise<ArticleListItem | null> => {
        const content = await loadArticleContent(a.contentJson)
        // ⚠️ 正文读不到就**丢掉这一条**（而不是给一张空卡片）：见 services/content.ts
        if (!content) return null
        return {
          id: a.id,
          text: content.text,
          translation: content.translation,
          difficulty: normalizeDifficulty(content.difficulty),
          tags: normalizeTags(content.tags),
          audio: await scheduleAudioOf({ id: a.id, standardAudio: a.standardAudio }),
        }
      }),
    )
  ).filter((x): x is ArticleListItem => x !== null)

  return c.json({ ok: true, data: { items } })
})

/**
 * ⭐ 详情（**全量**）—— 阅读页要的那一份。
 *
 * ⚠️ 为什么由服务端代取、而不是客户端直接去拉 contentJson：
 *    因为 contentJson 现在还可能是**相对路径**（内容流水线 + CDN 都还没建），
 *    而小程序没有 origin 概念，相对路径在 callContainer 通道下无从解析。
 *    等流水线把 contentJson 变成 CDN 绝对地址后，客户端可以直连、这条路由退化成透传甚至下线。
 */
articlesRoutes.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [article] = await db.select().from(articles).where(eq(articles.id, id)).limit(1)
  if (!article) return c.json({ ok: false, error: '文章不存在' }, 404)

  const content = await loadArticleContent(article.contentJson)
  if (!content) {
    return c.json({ ok: false, error: `正文加载失败：${article.contentJson}` }, 404)
  }

  /**
   * ⭐ 标准音的 **fileID**（cloud://环境ID.桶名/路径）——
   *    在服务端拼，因为只有它知道当前环境是 dev 还是 prod。
   *    写死在任何静态文件里都会让同一份内容指向某一个环境的桶。
   *
   * ⚠️ 每个词的 fileID 按下标拼，**下标必须与客户端切词一致**
   *    （客户端是 text.split(/\s+/).filter(Boolean)，生成脚本用的是同一条规则）。
   *
   * ⭐ 两种形态二选一，取决于这个环境有没有对象存储：
   *    · 云托管：音频在对象存储里 → 给 fileID，客户端用 getTempFileURL 换地址
   *    · 本机：没有云存储 → 给服务端路径，客户端加 BASE_URL 直接用
   *    ⚠️ 只留一种的话，另一种环境就永远测不到这个功能。
   *
   * ⚠️⚠️ 必须以 **standard_audio 这一列**为准，而不是「环境有没有对象存储」：
   *    列是空的 = 这篇还没灌过标准音（内容流水线没跑），
   *    此时必须老实返回 null，让客户端**隐藏播放入口**。
   *    否则会渲染一个能点、点了报 404 的喇叭 —— 那比没有按钮更难排查。
   */
  const words = content.text.split(/\s+/).filter(Boolean)
  const ref = audioRefOf(article)
  const audio = !ref
    ? { full: null, words: [], kind: 'cloud' as const }
    : {
        ...ref,
        words: words.map((_, i) =>
          ref.kind === 'cloud'
            ? fileIdOf(wordAudioKeyOf(id, i))
            : `/media/articles/${id}/w${i}.mp3`,
        ),
      }

  return c.json({ ok: true, data: { ...content, audio } })
})
