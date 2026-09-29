import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { normalizeLevel, normalizeTags, plainWordsOf, today } from '@jushuo/shared'
import type { ArticleDetail, StandardAudio } from '@jushuo/shared'
import { db } from '../db'
import { articles } from '../db/schema'
import { loadArticleContent } from '../services/content'
import { latestArticleCards } from '../services/article-list'
import { fileIdOf } from '../services/standard-audio'
import { standardAudioOf } from '../services/standard-audio-meta'
import type { Variables } from '../middleware/auth'

export const articlesRoutes = new Hono<{ Variables: Variables }>()

/** 首页「最新上线」默认给几句、最多给几句 */
const DEFAULT_LATEST = 6
const MAX_LATEST = 50

/**
 * ⭐ **最新上线** —— 句库里按上线时间倒序的最新 N 句（首页下半段那一段）。
 *
 * ⚠️⚠️ 它和「今天挑战」（`GET /api/user/today`）是**两个接口**（用户 2026-09 明确）：
 *    · 这条：**公开**、对所有人一样，答「最近上线了哪几句」，按 `articles.published_at` 排；
 *    · today：**按人**，答「你今天适合读哪一句」，按 24 小时窗口 + 我的难度档。
 *    两者原来是同一个 `/api/schedules` 返回的两段 —— 那条接口已整体删除
 *    （schedules 表/接口都不再有，别让那个名字回来）。
 *
 * ⚠️ 与 `GET /api/articles/:id` 的分工：这条**瘦**，只够画一张卡片；
 *    词级数据（音标 / 释义 / 逐词音频）只在详情里给。
 */
articlesRoutes.get('/', async (c) => {
  const requested = Number(c.req.query('latest'))
  // ⚠️ NaN 也要兜住：`?latest=abc` 会让 Math.min 返回 NaN，随后一条都不返回，
  //    表现出来是「最新空空」，而真正的原因是一个畸形参数。
  const limit = Number.isFinite(requested)
    ? Math.min(MAX_LATEST, Math.max(1, Math.trunc(requested)))
    : DEFAULT_LATEST

  return c.json({ ok: true, data: { date: today(), items: await latestArticleCards(limit) } })
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
  const id = c.req.param('id')
  const [article] = await db.select().from(articles).where(eq(articles.id, id)).limit(1)
  if (!article) return c.json({ ok: false, error: '文章不存在' }, 404)

  /**
   * ⚠️ 正文现在住在**库里**（`articles.content`）—— 2026-09 内容改为以库为真相。
   *    所以这条错误信息不再指向一个文件路径（那句 `contentPathOf(...)` 已经过期了：
   *    它会把排查的人引去仓库里找文件，而真正的原因是"这一行的正文是空的"）。
   */
  const content = await loadArticleContent(article.id)
  if (!content) {
    return c.json({ ok: false, error: '这条句子的正文还没入库（在 admin 里补上）' }, 404)
  }

  /**
   * ⭐ 标准音的 **fileID**（cloud://环境ID.桶名/路径）——
   *    在服务端拼，因为只有它知道当前环境是 dev 还是 prod。
   *    写死在任何静态文件里都会让同一份内容指向某一个环境的桶。
   *
   * ⚠️ 每个词的 fileID 按下标拼，**下标必须与客户端切词一致**
   *    （客户端、流水线、这里**共用** shared 的 plainWordsOf —— 不再各抄一份规则）。
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
  /**
   * ⭐ 标准音引用 + **时长**（阅读页顶行那个 `00:23`）。
   * ⚠️ 走 standardAudioOf 这一个入口，不要在这里自己 audioRefOf + 算时长：
   *    列表接口用的就是它，两处各写一遍迟早出现"列表有 00:23、详情没有"。
   */
  /**
   * ⚠️ 没有标准音时 `standardAudioOf` 返回 **null**（不是 `{ full: null }`）：
   *    客户端据此隐藏播放入口。与 StandardAudio / SubmissionAudioResponse.audio
   *    同一个约定 —— 同一个事实（「这段音频存不存在」）在三个接口里必须是同一种表达。
   * ⚠️⚠️ 这里**以前还拼一份逐词音频地址数组**（audio.words），已删除（2026-09）：
   *    点词播放改走微信 TTS。逐词音频从来没有独立文件，是服务端从整句切出来的；
   *    现在正文里也没有时间戳了（见 types/content.ts 的 ArticleWordItem）。
   */
  const audio: StandardAudio | null = await standardAudioOf(article)

  /**
   * ⚠️⚠️ **逐个字段列出**，不再 `{ ...content }`。
   *
   *    展开正文 JSON 等于「正文里有什么就漏什么」—— 加一个内部字段（比如将来的
   *    审核备注、流水线指纹）就会**静默**发给所有客户端。公不公开必须是一个决定：
   *    决定写在 shared 的 ArticleDetail 里，这里照着它构造。
   */
  const detail: ArticleDetail = {
    id: content.id,
    text: content.text,
    translation: content.translation,
    words: Array.isArray(content.words) ? content.words : [],
    // ⭐ 词间连读标注：与 words 一一对应（老正文没有 ⇒ 空数组，客户端按"都没标"渲染）
    links: Array.isArray(content.links) ? content.links : [],
    // ⭐ 正文里没写难度（老 JSON）就是 null，不补默认值
    difficulty: normalizeLevel(content.difficulty),
    // ⭐ 给用户看的两句（也是正文属性，与难度同源）：挑战宣言（兼分享卡标题）+ 朗读建议
    challenge:
      typeof content.challenge === 'string' && content.challenge.trim() !== '' ? content.challenge.trim() : null,
    advice: typeof content.advice === 'string' && content.advice.trim() !== '' ? content.advice.trim() : null,
    tags: normalizeTags(content.tags),
    audio,
    theme: article.theme,
  }
  return c.json({ ok: true, data: detail })
})
