import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { today } from '@jushuo/shared'
import { db } from '../db'
import { articles } from '../db/schema'
import { getLeaderboardAround, getRank } from '../services/leaderboard'
import { loadArticleContent } from '../services/content'
import { audioRefOf, fileIdOf, wordAudioKeyOf } from '../services/standard-audio'
import type { Variables } from '../middleware/auth'

export const articlesRoutes = new Hono<{ Variables: Variables }>()

/**
 * 正文。
 *
 * ⚠️ 为什么由服务端代取、而不是客户端直接去拉 contentJson：
 *    因为 contentJson 现在还可能是**相对路径**（内容流水线 + CDN 都还没建），
 *    而小程序没有 origin 概念，相对路径在 callContainer 通道下无从解析。
 *    等流水线把 contentJson 变成 CDN 绝对地址后，客户端可以直连、这条路由退化成透传甚至下线。
 *
 * ⚠️ 必须注册在 '/:id' **之前**（路径段数不同，本不会冲突，但顺序显式更清楚）。
 */
articlesRoutes.get('/:id/content', async (c) => {
  const id = Number(c.req.param('id'))
  const [article] = await db.select().from(articles).where(eq(articles.id, id)).limit(1)
  if (!article) return c.json({ ok: false, error: '文章不存在' }, 404)

  const content = await loadArticleContent(article.contentJson)
  if (!content) {
    return c.json({ ok: false, error: `正文加载失败：${article.contentJson}` }, 404)
  }

  // ⭐ 标准音的 **fileID**（cloud://环境ID.桶名/路径）——
  //    在服务端拼，因为只有它知道当前环境是 dev 还是 prod。
  //    写死在任何静态文件里都会让同一份内容指向某一个环境的桶。
  //
  // ⚠️ 每个词的 fileID 按下标拼，**下标必须与客户端切词一致**
  //    （客户端是 text.split(/\s+/).filter(Boolean)，生成脚本用的是同一条规则）。
  const words = content.text.split(/\s+/).filter(Boolean)
  // ⭐ 两种形态二选一，取决于这个环境有没有对象存储：
  //    · 云托管：音频在对象存储里 → 给 fileID，客户端用 getTempFileURL 换地址
  //    · 本机：没有云存储 → 给服务端路径，客户端加 BASE_URL 直接用
  //    ⚠️ 只留一种的话，另一种环境就永远测不到这个功能。
  //
  // ⚠️⚠️ 必须以 **standard_audio 这一列**为准，而不是「环境有没有对象存储」：
  //    列是空的 = 这篇还没灌过标准音（内容流水线没跑），
  //    此时必须老实返回 null，让客户端**隐藏播放入口**。
  //    否则会渲染一个能点、点了报 404 的喇叭 —— 那比没有按钮更难排查。
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

/**
 * 朗读单元索引。
 * ⚠️ 正文 / 词级数据 / 技巧**不从这里返回** —— 它们在 contentJson / tipsJson 指向的静态 JSON 里。
 *    这里只给库里的元数据（排期 / 竞技统计）。
 */
articlesRoutes.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [article] = await db.select().from(articles).where(eq(articles.id, id)).limit(1)
  if (!article) return c.json({ ok: false, error: '文章不存在' }, 404)
  return c.json({ ok: true, data: article })
})

/**
 * 榜单：榜心 5 条 + 我的排名，一次查询。
 *
 * ⚠️ 榜单是**按句子**算的（句子 = 竞技场）—— 见 services/leaderboard.ts。
 *    这条路由不再需要日期参数。
 */
articlesRoutes.get('/:id/leaderboard', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = c.get('userId')
  const rows = await getLeaderboardAround(id, userId)
  const me = rows.find((r) => r.isMe)
  const rankInfo = me ? await getRank(id, userId) : null
  return c.json({ ok: true, data: { articleId: id, rows, rankInfo } })
})