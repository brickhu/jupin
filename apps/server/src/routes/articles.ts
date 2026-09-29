import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { normalizeLevel, normalizeTags, plainWordsOf, today } from '@jushuo/shared'
import type { ArticleCard, ArticleDetail, StandardAudio } from '@jushuo/shared'
import { db } from '../db'
import { articles } from '../db/schema'
import { loadArticleContent } from '../services/content'
import {
  clampLimit,
  MAX_ARTICLE_LIMIT,
  parseLevels,
  parseList,
  queryArticleCards,
} from '../services/article-list'
import { pickAnonymousArticle, recommendToday } from '../services/recommend'
import { fileIdOf } from '../services/standard-audio'
import { standardAudioOf } from '../services/standard-audio-meta'
import type { Variables } from '../middleware/auth'
import { defaultHook } from '../openapi'
import {
  ArticleDetailSchema,
  errorResponse,
  ArticleListResponseSchema,
  LatestCardsResponseSchema,
  TodayArticleResponseSchema,
} from '../openapi/schemas'

export const articlesRoutes = new OpenAPIHono<{ Variables: Variables }>({ defaultHook })

/** 通用句库查询的默认条数（用户 2026-09 定） */
const DEFAULT_ARTICLE_LIMIT = 50
/** 首页「最新上线」默认给几句、最多给几句 */
const DEFAULT_LATEST = 6
const MAX_LATEST = 50


/**
 * ⭐⭐ **句库查询**（通用）—— 按标签 / 难度筛选，按日期 / 参与人数排序。
 *
 * ⚠️ 公开接口，对所有人一样；「今天读哪一句」是**另一条**（`/api/articles/today`）。
 *
 * 参数口径（写进 OpenAPI，端侧照它拼）：
 *   · `tags`       逗号分隔，**任一命中**（OR）；空 = 不筛。例：`?tags=励志,旅行`
 *   · `difficulty` 逗号分隔的档位（0 初级 / 1 中级 / 2 高级 / 3 专家），**任一命中**；空 = 不筛
 *   · `sort`       `date`（默认，上线时间倒序）| `participants`（参与人数倒序）
 *   · `limit`      1..100，默认 **50**
 *
 * ⚠️ 与 `GET /api/articles/latest` 的关系：这条是**通用查询**，
 *    那条是首页那一段的**固定口径**（默认 6、只按上线时间）——
 *    两者共用 services/article-list.ts 的同一个实现，参数默认值不同而已。
 */
const listArticlesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['句库'],
  summary: '句库查询（标签 / 难度筛选，日期 / 参与人数排序）',
  description:
    '公开接口。筛选与排序口径：\n\n' +
    '· `tags`：逗号分隔，**任一命中**（OR）；不传 = 不筛。例 `?tags=励志,旅行`\n' +
    '· `difficulty`：逗号分隔的档位 0/1/2/3，**任一命中**；不传 = 不筛\n' +
    '· `sort`：`date`（默认，按上线时间倒序）或 `participants`（按参与人数倒序）\n' +
    '· `limit`：1..100，默认 50\n\n' +
    '⚠️ 内容读不到的句子会被剔除（宁可少一张卡，也不给一张点进去空白的）。',
  request: {
    query: z.object({
      tags: z.string().optional(),
      difficulty: z.string().optional(),
      sort: z.enum(['date', 'participants']).optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ArticleListResponseSchema } },
      description: '成功',
    },
  },
})

articlesRoutes.openapi(listArticlesRoute, async (c) => {
  const q = c.req.valid('query')
  const items = await queryArticleCards({
    tags: parseList(q.tags),
    levels: parseLevels(q.difficulty),
    sort: q.sort ?? 'date',
    limit: clampLimit(q.limit, DEFAULT_ARTICLE_LIMIT, MAX_ARTICLE_LIMIT),
  })
  // ⚠️ 不带 date（2026-09 统一「句子类响应不带日期」）—— 句库列表与"今天"无关
  return c.json({ ok: true, data: { items } }, 200)
})

/**
 * ⭐ **最新上线** —— 句库里按上线时间倒序的最新 N 句（首页下半段那一段）。
 *
 * ⚠️⚠️ 它和「今天挑战」（`GET /api/articles/today?uid=<id>`）是**两个接口**：
 *    · 这条：**公开**、对所有人一样，答「最近上线了哪几句」，按 `articles.published_at` 排；
 *    · today：**按 uid**（或不带 uid = 匿名随机），答「今天适合读哪一句」，
 *      带 uid 时按 24 小时窗口 + 那个人的难度档。
 *    两者原来是同一个 `/api/schedules` 返回的两段 —— 那条接口已整体删除
 *    （schedules 表/接口都不再有，别让那个名字回来）。
 *
 * ⚠️ 2026-09 从 `GET /api/articles?latest=N` **独立出来**：通用查询占用了
 *    `/api/articles` 这个地址，首页那一段有自己的语义（默认 6 条、只按上线时间），
 *    所以给它一个**自己的地址**，别再用查询参数在通用接口上开一扇后门。
 *    ⚠️ 注册顺序：它必须排在下面 `/{id}` **之前**（Hono 同前缀按注册顺序匹配）。
 *
 * ⚠️ 与 `GET /api/articles/:id` 的分工：这条**瘦**，只够画一张卡片；
 *    词级数据（音标 / 释义 / 逐词音频）只在详情里给。
 *
 * ⚠️ **带 `date`**（与通用 `/api/articles` 的唯一区别）：它是"今天的列表"，
 *    端侧拿这个日期判"首屏缓存是不是今天的"（跨天不能再画）。
 */
const latestCardsRoute = createRoute({
  method: 'get',
  path: '/latest',
  tags: ['句库'],
  summary: '最新上线（句库按上线时间倒序的最新 N 句；带 date 供端侧按天缓存）',
  request: { query: z.object({ limit: z.string().optional() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: LatestCardsResponseSchema } },
      description: '成功（含服务端的今天，供端侧按天缓存）',
    },
  },
})

articlesRoutes.openapi(latestCardsRoute, async (c) => {
  const limit = clampLimit(c.req.valid('query').limit, DEFAULT_LATEST, MAX_LATEST)
  const items = await queryArticleCards({ sort: 'date', limit })
  return c.json({ ok: true, data: { date: today(), items } }, 200)
})

/**
 * ⭐⭐ **今日推荐** —— 「今天适合读哪一句」。
 *
 * ⚠️⚠️ **它收 0 个或 1 个 uid**（`?uid=`，**可省略**），公开可读 ——
 *    `/api/articles/*` 本来就没有鉴权中间件。
 *      · **带了 uid**：走 recommendToday —— 24 小时窗口 + **这个人的难度档**，
 *        确定性、窗口内**原样返回**同一句（users.today_article_id），
 *        所以"读完回首页卡片变成另一句"那个 bug 不会再发生；
 *      · **没带 uid（匿名 / 未登录）**：走 pickAnonymousArticle —— **初级档**里
 *        **随机 + 按参与人数加权**挑一条（越热闹越容易被抽中），
 *        且**一个用户行都不写**（没有"这个人"，就没有窗口可谈）。
 *    用户 2026-09 定的口径：句子归谁由 uid 决定；「这个 uid 在这句上的战绩」是**另一件事**，
 *    拆到鉴权接口 `GET /api/user/participation/{articleId}`。
 *
 * ⚠️ 返回 `{ date, item }`：`item` 是**纯句子数据**（标准 ArticleCard）；`date` 是
 *    服务端的今天，**只用于端侧按天做缓存失效**（这张卡跨天就不能再当"今日挑战"画）。
 *    ⚠️ 它**不是**"这次挑战记哪一天"的依据 —— 归属由服务端在受理提交时决定
 *    （`POST /api/user/submissions`，缺省 = 它的今天）。
 *
 * ⚠️⚠️ **注册顺序要害**：它必须排在下面的 `/{id}` **之前**。Hono 对同前缀是**按注册顺序**
 *    匹配的（实测：先注册 `/{id}` 的话，`/today` 会被当成 id="today" 的详情请求）。
 *    ⇒ 别把这段挪到详情路由后面。
 *
 * ⚠️ 带 uid 时它会**写库**（首次分配时落 users.today_article_id）—— 公开接口也不例外。
 *    但分配是确定性的（按窗口起始日取模 + 窗口内固定），重复调用不会改变结果。
 *    匿名那一支是**纯只读**的。
 */
const todayArticleRoute = createRoute({
  method: 'get',
  path: '/today',
  tags: ['句库'],
  summary: '今天读哪一句（带 uid 按此人档位；不带 uid = 初级档随机偏热门）',
  description:
    '⚠️ 可以不传 uid（匿名/未登录）：**默认初级档**，在该档句子里**随机**挑一条，' +
    '参与人数多的更容易被抽中；**不写任何用户行**。\n\n' +
    '返回 `{ date, item }`：`item` 是标准 ArticleCard（纯句子数据），`date` 是服务端的今天（供端侧按天缓存）。\n\n' +
    '⚠️ 与「最新上线」是两个接口：这条按 uid（或匿名随机）、有 uid 时 24 小时换一次；' +
    '那条对所有人一样、按上线时间倒序。\n\n' +
    '⚠️ 「我今天在这句上的战绩」不在这里，走 GET /api/user/participation/{articleId}。',
  request: {
    query: z.object({
      /**
       * ⚠️ **可省略**：不传 = 匿名（uid 0）。
       * `.nonnegative()` 让显式的 `?uid=0` 也等价于匿名 —— 端侧在未登录时
       * 要么不带这个参数、要么带 0，两种写法都得能用。
       */
      uid: z.coerce.number().int().nonnegative().optional(),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: TodayArticleResponseSchema } },
      description: '今日推荐卡片（标准 ArticleCard）',
    },
    400: errorResponse('uid 存在但不是非负整数'),
    500: errorResponse('推荐的句子不存在（并发删库 —— 理论上不会发生）'),
    503: errorResponse('句库为空（部署问题：检查 SEED_ON_START 是否生效）'),
  },
})

articlesRoutes.openapi(todayArticleRoute, async (c) => {
  /**
   * ⚠️⚠️ **两种选法，别合并**（用户 2026-09 定）：
   *   · 有 uid：走 recommendToday —— 24 小时窗口 + **这个人的难度档**，确定性、窗口内固定；
   *   · 无 uid（或 uid=0）：走 pickAnonymousArticle —— **初级档**里**随机 + 按参与人数加权**
   *     挑一条，且**一个用户行都不写**（没有"这个人"，就没有窗口可谈）。
   *   早先的写法是把匿名也当成 recommendToday(0)，那是"按窗口起始日取模"的确定性选法，
   *   与口径要的"随机、偏热门"不是一回事 —— 已改掉。
   */
  const uid = c.req.valid('query').uid ?? 0
  // ⚠️ 日期一律取服务端的（客户端时钟可改，见 shared/day.ts）——
  //    而且"同档同句"的取模要所有人算出来一样，更不能让端侧传日期
  const date = today()

  const pickedId =
    uid > 0 ? (await recommendToday(uid, date))?.articleId : await pickAnonymousArticle()
  if (!pickedId) {
    // ⚠️ 与 /api/articles 同一条口径：句库为空是**部署问题**，
    //    报成"今天没有推荐"会让排查方向完全跑偏
    return c.json({ ok: false, error: '句库为空：没有可用的句子（检查 SEED_ON_START 是否生效）' }, 503)
  }

  const [article] = await db.select().from(articles).where(eq(articles.id, pickedId)).limit(1)
  if (!article) {
    // 选句是从 articles 里选的，查不到只可能是并发删库 —— 明确报错
    return c.json({ ok: false, error: '推荐的句子不存在：' + pickedId }, 500)
  }

  const content = await loadArticleContent(pickedId)
  const audio = await standardAudioOf(article)

  /** ⚠️ **纯句子数据** —— date / isToday 这类上下文不在卡片上（见 ArticleCard 的头注释） */
  const card: ArticleCard = {
    articleId: article.id,
    text: content?.text ?? '',
    translation: content?.translation ?? '',
    // ⚠️ 老内容可能没有难度 / 标签 ⇒ 一律过规范化，认不出就是 null / []
    difficulty: normalizeLevel(content?.difficulty),
    tags: normalizeTags(content?.tags),
    audio,
    theme: article.theme,
  }

  /**
   * ⚠️ 带 `date`（服务端的今天）—— 与 `/latest` 同一条口径：**只供端侧按天做缓存失效**。
   *    ⚠️ 它不是"这次挑战记哪一天"的依据：那个由服务端在**受理提交时**决定
   *    （`POST /api/user/submissions`，缺省就是它的今天）。
   */
  return c.json({ ok: true, data: { date, item: card } }, 200)
})


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

articlesRoutes.openapi(articleDetailRoute, async (c) => {
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
