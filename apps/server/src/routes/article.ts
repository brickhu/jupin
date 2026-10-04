import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { normalizeLevel, normalizeTags } from '@jushuo/shared'
import type { ArticleDetail, StandardAudio } from '@jushuo/shared'
import { db } from '../db'
import { articles } from '../db/schema'
import { loadArticleContent } from '../services/content'
import { listArticleParticipations } from '../services/article-participations'
import { clampLimit, MAX_ARTICLE_LIMIT } from '../services/article-list'
import { standardAudioOf } from '../services/standard-audio-meta'
import type { Variables } from '../middleware/auth'
import { defaultHook } from '../openapi'
import {
  ArticleDetailSchema,
  ArticleParticipationsResponseSchema,
  errorResponse,
} from '../openapi/schemas'

/**
 * ⭐⭐ **句子资源**（`/api/article/*`，公开）—— 一个句子的**子资源**都挂在这里。
 *
 * 用户 2026-09 定的结构（这一版**推翻了**上一版的"参与自立根路径"）：
 *   · `GET /api/article/{id}`                     —— 句子详情（全量，含词级数据）
 *   · `GET /api/article/{id}/participations`      —— 谁参与过这一句（sort=time|score + 分页）
 *
 * ⚠️⚠️ **为什么改回来**（旧注释见 git 历史：曾写着"参与不挂在 article 下，因为 id 是内容哈希、
 *    句子会下架，参与记录必须照样读得到"）：
 *    那条理由**在实现上并没有成立** —— 这两个接口从来不校验句子是否存在，
 *    都是**直接查 participations**（`article_id` 那一列不挂外键，见 db/schema.ts）。
 *    所以"挂在 article 下"并没有真的把可读性绑在内容行上，只是路径形状变了。
 *    ⇒ 现在的判据是**阅读视角**：一个句子的详情 / 榜单 / 参与者是它的子集，
 *      统一收在 `/api/article/{id}` 下，端侧一眼看清"这一页要的数据属于谁"。
 *    ⚠️ 与句子无关的**聚合统计**不放这里 —— 那些在 `/api/stats/*`
 *      （参与统计 / 收藏总量：按 ids 批量、零值补齐）。
 *
 * ⚠️ 与 `/api/articles`（复数，**列表**：查询 / latest / today）是两个根：
 *    单数 = 一条句子及其子资源；复数 = 句库的集合查询。这一个文件只放单数那半边。
 */
export const articleRoutes = new OpenAPIHono<{ Variables: Variables }>({ defaultHook })


/** offset 只接受非负整数；非法值按 0 处理（只读接口，为它报错没有意义） */
function clampOffset(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '0', 10)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(n, 10_000)
}

/**
 * ⭐ 详情（**全量**）—— 阅读页要的那一份。
 *
 * ⚠️ 为什么由服务端代取、而不是客户端直接去拉 contentJson：
 *    因为 contentJson 现在还可能是**相对路径**（内容流水线 + CDN 都还没建），
 *    而小程序没有 origin 概念，相对路径在 callContainer 通道下无从解析。
 *    等流水线把 contentJson 变成 CDN 绝对地址后，客户端可以直连、这条路由退化成透传甚至下线。
 */
const articleDetailRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['句库'],
  summary: '句子详情（全量，含词级数据）',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: ArticleDetailSchema } },
      description: '成功',
    },
    404: errorResponse('句子不存在'),
  },
})

 articleRoutes.openapi(articleDetailRoute, async (c) => {
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
  return c.json({ ok: true, data: detail }, 200)
})

/**
 * ⭐ **参与者 / 榜单**（`GET /api/article/{id}/participations`）。
 *
 * `sort=score` 就是榜单（按最高分倒序，竞技场页 limit=20）；
 * `sort=time` 是"最近谁来过"。每行都带全局 `rank`（与 sort 无关）。
 *
 * ⚠️ 句子**不存在也算正常**：这条只查 `participations`（不校验句子行），
 *    下架 / 换版之后有记录就照常返回，没有就是空数组 + total=0。
 */
const articleParticipationsRoute = createRoute({
  method: 'get',
  path: '/{id}/participations',
  tags: ['句库'],
  summary: '某一句的参与记录（sort=time|score，limit/offset 分页）',
  description:
    '公开接口。按句子查"谁参与过这一句"，一行 = 一个用户。\n\n' +
    '· `sort`：`time`（默认，按最新参与时间倒序）或 `score`（按最高分倒序 = 榜单）\n' +
    '· `limit`：1..100，默认 20\n' +
    '· `offset`：非负整数，默认 0\n\n' +
    '⚠️ 每一行都带 `rank`（按最高分算的**全局**名次，与 `sort` 无关）。\n' +
    '⚠️ 句子不存在（已下架 / 内容换版）**不是错误**：有参与记录就照常返回，没有就是空数组。',
  request: {
    params: z.object({ id: z.string().openapi({ description: '句子 id' }) }),
    query: z.object({
      sort: z.enum(['time', 'score']).optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ArticleParticipationsResponseSchema } },
      description: '成功（没人参与就是空数组 + total=0）',
    },
  },
})

articleRoutes.openapi(articleParticipationsRoute, async (c) => {
  const articleId = c.req.param('id')
  const q = c.req.valid('query')

  const data = await listArticleParticipations(articleId, {
    sort: q.sort ?? 'time',
    limit: clampLimit(q.limit, 20, MAX_ARTICLE_LIMIT),
    offset: clampOffset(q.offset),
  })
  return c.json({ ok: true, data }, 200)
})
