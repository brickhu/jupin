import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { articles } from '../db/schema'
import { env } from '../env'
import { contentColumnsOf, saveArticleContent } from '../services/article-content'
import { articleRefsOf, deleteArticle } from '../services/article-delete'
import { storeStandardAudio } from '../services/standard-audio'

/**
 * ⭐⭐ **内容管理接口**（只有 `tools/admin` 用）—— 2026-09 用户定的分工：
 *
 *     admin 把活干完（LLM 出内容字段 + fish 出音频 + 转码），
 *     然后**调这组接口**上传音频并写入 `articles`。
 *
 * ⚠️⚠️ 为什么不让 admin 直连数据库（它原来就是那样）：
 *    ① **连不上** —— dev/prod 的库没开外网地址（实测 `IsOpenPubNetAccess = false`），
 *       本机只有 local 能连；而"这个库在不在公网"是运维决定，不该成为管理台的前置条件。
 *    ② **两套写入逻辑** —— admin 自己写过 `insert(articles)` / `update(articles)`，
 *       服务端也写；两份必然分叉（真实案例：标签顺序，admin 读关联表拿了字母序，
 *       保存时把正文里的顺序改掉了）。
 *    ⇒ 写入只有这一条路：**服务端**。admin 只是它的一个客户端。
 *
 * ⚠️ 鉴权用 `ADMIN_TOKEN`（Bearer），**不是**用户身份那一套：
 *    这是运营侧接口，不做管理员账号体系（谁审批/轮换/审计是另一个工程）。
 *    **没配 = 503；配了但对不上 = 401** —— 绝不"没配就放行"。
 */
export const adminRoutes = new Hono()

/** 常数时间的字符串比较（长度不同直接 false —— 长度本身不是秘密） */
function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

adminRoutes.use('*', async (c, next) => {
  const configured = env.ADMIN_TOKEN
  if (!configured) {
    /**
     * ⚠️ 没配口令时**拒绝服务**而不是放行：这组接口能改全站内容，
     *    "忘了配"绝不能等价于"谁都能写"。
     */
    return c.json({ ok: false, error: '服务端没有配置 ADMIN_TOKEN（内容管理接口未启用）' }, 503)
  }
  const header = c.req.header('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token || !sameSecret(token, configured)) {
    return c.json({ ok: false, error: 'ADMIN_TOKEN 不正确' }, 401)
  }
  await next()
})

/** 列表：给 admin 的表格用（只给必要字段，正文不整篇回传） */
adminRoutes.get('/articles', async (c) => {
  /**
   * ⭐ 参数都是**可选**的，因为这个接口现在同时服务两件事：
   *    · admin 的列表（带搜索 / 只看上线）；
   *    · admin 拆句时的"这句库里有没有"（一次问一批 id，见 `ids` 参数）。
   * ⚠️ 一次最多回 200 条：这是管理台，不是数据导出接口。
   */
  const q = (c.req.query('q') ?? '').trim()
  const activeOnly = c.req.query('active') === '1'
  const idsParam = (c.req.query('ids') ?? '').trim()

  const where = []
  if (activeOnly) where.push(eq(articles.isActive, true))
  if (idsParam) {
    const ids = idsParam.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 200)
    if (ids.length === 0) return c.json({ ok: true, data: { items: [] } })
    where.push(inArray(articles.id, ids))
  }

  const rows = await db
    .select({
      id: articles.id,
      text: articles.text,
      translation: articles.translation,
      difficulty: articles.difficulty,
      scores: articles.scores,
      challenge: articles.challenge,
      advice: articles.advice,
      tags: articles.tags,
      words: articles.words,
      links: articles.links,
      isActive: articles.isActive,
      publishedAt: articles.publishedAt,
      standardAudio: articles.standardAudio,
      theme: articles.theme,
      createdAt: articles.createdAt,
    })
    .from(articles)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(articles.createdAt))
    .limit(200)

  /**
   * ⚠️ 搜索在**服务端**做（而不是让 admin 自己筛）：admin 只拿到最近 200 条，
   *    前端筛的话就会"搜不到明明存在的老句子"，而那种错看起来像"数据丢了"。
   */
  const items = q
    ? rows.filter(
        (r) =>
          (r.text ?? '').toLowerCase().includes(q.toLowerCase()) ||
          (r.translation ?? '').includes(q) ||
          (r.tags ?? []).some((t) => t.includes(q)),
      )
    : rows

  return c.json({ ok: true, data: { items } })
})

/** 详情：整条（admin 的编辑表单要全部字段） */
adminRoutes.get('/articles/:id', async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(articles).where(eq(articles.id, id)).limit(1)
  if (!row) return c.json({ ok: false, error: '句子不存在' }, 404)
  /**
   * ⚠️ 刻意**抹掉 `content`**：那是拆列之前的过渡列（即将删除），
   *    任何客户端去读它都会把"真相在哪"重新搞混。响应里只给拆开之后的列。
   */
  const { content: _legacyContent, ...rest } = row
  return c.json({ ok: true, data: rest })
})

/**
 * ⭐ 写入一条句子（新建或更新）—— **按列写**（2026-09 拆列之后，不再有 content 那整份 JSON）。
 *
 * ⚠️ 难度**由判据分算**，不接受客户端传来的 difficulty（与 admin 里的口径一致）：
 *    这样"正文里的 scores"与"库里的 difficulty"永远自洽。
 * ⚠️ `id` 由客户端给：它是内容 hash（`sha256(text)` 前 16 位），
 *    生成那一刻就该定下来，服务端不重新算（换算法会让老 id 全失效）。
 */
adminRoutes.put('/articles/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{
    text?: string
    translation?: string
    scores?: unknown
    challenge?: string
    advice?: string
    words?: unknown
    links?: unknown
    tags?: unknown
    isActive?: boolean
  }>()

  const text = (body.text ?? '').trim()
  if (!text) return c.json({ ok: false, error: 'text（原文）不能为空' }, 400)

  /**
   * ⚠️ 列的拼装走 `services/article-content.ts`（**唯一一处**）——
   *    路由不自己算 difficulty、不自己整 tags（那正是"两套写入逻辑"的开始，
   *    也是 domain-write-guard 会拦下来的事情）。
   */
  const cols = contentColumnsOf({
    text,
    translation: body.translation,
    scores: body.scores,
    challenge: body.challenge,
    advice: body.advice,
    words: body.words,
    links: body.links,
    tags: body.tags,
  })

  const { created } = await saveArticleContent(id, cols, { isActive: body.isActive })
  console.log(`[admin] 写入句子 id=${id}（${created ? '新建' : '更新'}）`)
  return c.json({ ok: true, data: { id, created } })
})

/**
 * ⭐ **删除一条句子**（管理台的功能）。
 *
 * ⚠️⚠️ **有历史就拒绝**（409 + 引用数）—— 详见 `services/article-delete.ts` 顶部的理由：
 *    participations 要自足（存 text 快照）而快照取自 articles ⇒ 硬删会让新记录取不到内容；
 *    更要紧的是用户的"已挑战"历史会指向不存在的东西。
 *    ⇒ 日常用**下架**（`PUT` 带 `isActive:false`）；删除只用于"刚建错、还没人碰过"的句子。
 */
adminRoutes.delete('/articles/:id', async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select({ id: articles.id }).from(articles).where(eq(articles.id, id)).limit(1)
  if (!row) return c.json({ ok: false, error: '句子不存在' }, 404)

  const { deleted, refs } = await deleteArticle(id)
  if (!deleted) {
    /**
     * ⚠️ 409 而不是 400：这不是"请求写错了"，是"当前状态不允许" ——
     *    带上引用数，界面才能说清"这句有 11 条成绩，删不得，要下线请用下架"。
     */
    return c.json(
      {
        ok: false,
        error: '这条句子已经有用户数据（成绩 / 参与 / 收藏），不能删除。要让它不再出现请用「下架」。',
        data: { refs },
      },
      409,
    )
  }
  console.log(`[admin] 删除句子 id=${id}（无任何用户数据）`)
  return c.json({ ok: true, data: { id, refs } })
})

/**
 * ⭐⭐ 上传**标准音** → 写对象存储 → 把 `standard_audio` 记到那一行。
 *
 * ⚠️ 这是"音频只有一个住址"关键的一步：mp3 由 admin 在本机生成，
 *    然后经这里进对象存储；服务端读音频只认 `standard_audio` 这一列
 *    （`fileIdOf(audioKeyOf(id))`），不再依赖仓库里的 `content/audio/`。
 * ⚠️ 语音格式由客户端保证（24kHz 单声道 mp3，与原来 pipeline 转码后的产物一致）——
 *    服务端**不做转码**（那需要 ffmpeg，而运行镜像里虽然有，但转码是内容生产的事，
 *    不该塞进一条接收接口）。
 */
adminRoutes.post('/articles/:id/audio', async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select({ id: articles.id }).from(articles).where(eq(articles.id, id)).limit(1)
  if (!row) return c.json({ ok: false, error: '句子不存在（先写入句子再传音频）' }, 404)

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ ok: false, error: '请求体不是 multipart/form-data' }, 400)
  }
  const file = form.get('file')
  if (!(file instanceof File)) return c.json({ ok: false, error: '缺少 file 字段' }, 400)

  const bytes = new Uint8Array(await file.arrayBuffer())
  /**
   * ⚠️ 格式由客户端保证（24kHz 单声道 mp3，与原来 pipeline 转码后的产物一致）——
   *    服务端**不做转码**：转码是内容生产的事，不该塞进一条接收接口。
   *    这里只挡"空文件"和"明显误传"（一条标准音正常是几十 KB）。
   */
  if (bytes.byteLength === 0) return c.json({ ok: false, error: '音频是空的' }, 400)
  const MAX_BYTES = 5 * 1024 * 1024
  if (bytes.byteLength > MAX_BYTES) {
    return c.json({ ok: false, error: `音频太大（${bytes.byteLength} 字节，上限 ${MAX_BYTES}）` }, 413)
  }

  try {
    // ⚠️ 写对象存储 + 记 standard_audio 都归 services/standard-audio.ts（唯一写入方）
    const { audioKey } = await storeStandardAudio(id, bytes)
    console.log(`[admin] 标准音已上传 id=${id}（${bytes.byteLength} 字节 → ${audioKey}）`)
    return c.json({ ok: true, data: { id, audioKey, bytes: bytes.byteLength } })
  } catch (err) {
    console.error('[admin] 标准音写入失败：' + (err as Error).message)
    return c.json({ ok: false, error: '标准音写入失败：' + (err as Error).message }, 500)
  }
})
