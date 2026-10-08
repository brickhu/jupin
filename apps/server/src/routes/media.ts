import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { submissions } from '../db/schema'
import { SUBMISSION_ID_LENGTH } from '@jushuo/shared'
import { readStaticFile } from '../services/content'

/**
 * 提交 id 的形状 —— 从**唯一的长度常量**拼，不要写死位数
 * （它同时决定列的宽度和派生函数，三处各写一个数就会漂）。
 */
const RE_SUBMISSION_ID = new RegExp('^[0-9a-f]{' + SUBMISSION_ID_LENGTH + '}$')
import { env } from '../env'
import { playableBytesOf } from '../services/recording'
import { getStorage } from '../storage'
import { ensureKwsModel } from '../services/kws-model'

export const mediaRoutes = new OpenAPIHono({ defaultHook })
import { defaultHook } from '../openapi'
import { errorResponse } from '../openapi/schemas'


/**
 * ⭐ 标准音 —— **公开路由，刻意不在 /api 下面。**
 *
 * ⚠️⚠️ 这一条是踩出来的，不是设计出来的：
 *
 *    原来这两个端点挂在 /api/articles/* 下，那里有鉴权中间件。
 *    结果在开发者工具里点喇叭 **必得 401** —— 因为
 *
 *      **InnerAudioContext 不会带上我们的 Authorization 头。**
 *
 *    它不是一个 wx.request 调用，没有 header 可配；容器通道下更是连
 *    x-wx-openid 都没有（那套注入只发生在 callContainer 这条路上，
 *    而音频是客户端**直接**去拉 URL 的）。
 *
 *    ⇒ 凡是「客户端自己按 URL 去取」的资源，就**不能要求鉴权**。
 *      要么公开，要么走签名地址 —— 我们选了公开，因为标准音本来就是
 *      任何人都可以听的内容，不涉及任何用户数据。
 *
 * ⚠️ 用户录音**不在此列**：那是私人数据，地址只能从「校验过归属的接口」发出来。
 *    云上它走对象存储（fileID）；本机那条回吐在下面 /recording/:id，
 *    而那条**只在 STORAGE=local 时存在**。两者别混 ——
 *    把录音挂成一条无条件的公开路由会是一次真实的隐私事故（见那条路由的说明）。
 */
const mediaArticleAudioRoute = createRoute({
  method: 'get',
  path: '/articles/{file}',
  tags: ['媒体'],
  summary: '句子标准音（音频字节）',
  description:
    '⚠️ 这条**不返回 JSON 信封**，直接给音频字节（`Content-Type: audio/mpeg`）——' +
    'InnerAudioContext 播的就是它（缺 Content-Type 时真机上直接不播、且不报错）。',
  request: { params: z.object({ file: z.string() }) },
  responses: {
    200: {
      content: { 'audio/mpeg': { schema: z.any().openapi({ type: 'string', format: 'binary' }) } },
      description: '音频字节流',
    },
    404: errorResponse('音频不存在'),
  },
})

mediaRoutes.openapi(mediaArticleAudioRoute, async (c) => {
  // 形如 <articleId>.mp3 —— articleId 是内容 hash（sha256 十六进制）
  const m = /^([0-9a-f]+)\.mp3$/.exec(c.req.param('file'))
  if (!m) return c.json({ ok: false, error: '音频不存在' }, 404)
  return serveAudio(c, `content/audio/${m[1]}.mp3`)
})

/**
 * ⭐⭐ **KWS 模型在哪**（端侧逐词标注用）—— 只回一个 fileID，**不回吐 4.4MB 字节** ✓
 *
 * ⚠️⚠️ 为什么这么分：算过账（微信云托管官方价）——
 *    容器**公网流量 0.8 元/GB** ✗，对象存储 **CDN 流量 0.18 元/GB** ✓（还有免费额度 ✓），
 *    而**只通过 callContainer 访问不产生流量用量** ✓
 *  ⇒ 字节走**对象存储**（客户端自己去 CDN 下 ✓），服务端只回一个 hundred-byte 的 fileID ✓
 *  ⇒ 这一条的流量**完全免费** ✓
 *
 * ⚠️ 放在 `/media` 下（不在 `/api` 下）是沿用本文件的既有理由：
 *    客户端**按地址直接取**的资源不能要求鉴权 ✗ —— 引擎/下载器不会带 Authorization 头 ✓
 *    模型本身是公开的第三方产物（Apache-2.0 ✓）⇒ 公开它没有风险 ✓
 */
const mediaKwsModelRoute = createRoute({
  method: 'get',
  path: '/kws-model',
  tags: ['媒体'],
  summary: 'KWS 模型的位置（只给 fileID，字节由客户端自己去 CDN 下）',
  description:
    '⚠️ 这条**返回 JSON**（不是字节）—— 因为字节要从**对象存储**取，' +
    '服务端的公网流量贵 4 倍（0.8 vs 0.18 元/GB）✗。',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ fileId: z.string(), key: z.string(), bytes: z.number() }),
          }),
        },
      },
      description: '模型的地址与大小',
    },
    404: errorResponse('模型未就绪（构建时没抓到 content/kws/）'),
  },
})

mediaRoutes.openapi(mediaKwsModelRoute, async (c) => {
  const info = await ensureKwsModel()
  if (!info) return c.json({ ok: false, error: '模型未就绪' }, 404)
  return c.json({ ok: true, data: info }, 200)
})

/**
 * ⭐ 回吐**用户自己的一段录音**（可播的 WAV）—— 列表里那个播放按钮。
 *
 * ⚠️⚠️ 为什么这条路由是**无鉴权**的、以及为什么这样是可以的：
 *    InnerAudioContext **不带 Authorization 头**（它不是一个 wx.request 调用），
 *    所以「客户端自己按 URL 去取」这件事**没法**用请求头鉴权 ——
 *    要么公开，要么签名地址，要么换成客户端先把字节下下来（多一层）。
 *
 *    而这条路由**只在 STORAGE=local 时存在**（下面第一行就是那道门）：
 *    那意味着它只可能跑在开发者自己的机器上（模拟器直连 localhost），
 *    服务端也不必为此多写一套签名 / 过期逻辑。
 *    云端根本不走这条路由 —— 那边客户端没有本服务的域名，
 *    播放走的是云存储 fileID（见 services/recording.ts）。
 *
 *    ⛔ 如果哪天要在云端也用它（比如给服务配了域名、进了白名单），
 *       **必须先把鉴权加回来**：那时它是一条任何人都能按 id 读录音的公开地址。
 */
const mediaRecordingRoute = createRoute({
  method: 'get',
  path: '/recording/{id}',
  tags: ['媒体'],
  summary: '用户录音（音频字节）',
  description:
    '⚠️ 这条**不返回 JSON 信封**，直接给音频字节（`Content-Type: audio/mpeg`）——' +
    'InnerAudioContext 播的就是它（缺 Content-Type 时真机上直接不播、且不报错）。',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: { 'audio/mpeg': { schema: z.any().openapi({ type: 'string', format: 'binary' }) } },
      description: '音频字节流',
    },
    404: errorResponse('录音不存在 / 这种取法不支持'),
  },
})

mediaRoutes.openapi(mediaRecordingRoute, async (c) => {
  if (env.STORAGE !== 'local') {
    return c.json({ ok: false, error: '录音暂不支持这种取法' }, 404)
  }

  const id = c.req.param('id')
  // ⚠️ 先按形状挡一道：提交 id 是 SUBMISSION_ID_LENGTH 位十六进制。
  //    这样任何手写的路径都到不了数据库查询那一步。
  if (!RE_SUBMISSION_ID.test(id)) {
    return c.json({ ok: false, error: '录音不存在' }, 404)
  }

  const [row] = await db
    .select({ audioKey: submissions.audioKey })
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1)
  if (!row?.audioKey) return c.json({ ok: false, error: '这段录音已经不在了' }, 404)

  const storage = getStorage()
  /**
   * ⚠️ 先问一句「还在不在」，不要直接读：
   *    失败的提交会被清掉音频（见 services/scoring.ts），
   *    直接读会抛 ENOENT 变成 500 —— 而那不是「服务坏了」，是「这条没有录音」。
   */
  if (!(await storage.exists(row.audioKey))) {
    return c.json({ ok: false, error: '这段录音已经不在了' }, 404)
  }

  try {
    // ⚠️ 新记录存的就是 mp3，这里**一字节都不动**地交出去；
    //    老记录（裸 PCM / WebM）才会被转一次码（见 services/recording.ts）。
    const { bytes, mime } = await playableBytesOf(storage, row.audioKey)
    // ⚠️ 与 serveAudio 同一个理由：复制成一份**独占的 ArrayBuffer** 再交出去。
    //    playableBytesOf 给的是 Uint8Array<ArrayBufferLike>，而 Hono 的 Data
    //    要的是 Uint8Array<ArrayBuffer> —— TS 分得比运行时细。
    const body = new Uint8Array(bytes.byteLength)
    body.set(bytes)
    return c.newResponse(body, 200, {
      // ⚠️ Content-Type 不能少：缺了它 InnerAudioContext 在真机上直接不播，且不报错
      'Content-Type': mime,
      'Content-Length': String(body.byteLength),
      // ⚠️ private：这是某个人的录音，不能被任何中间层缓存下来
      'Cache-Control': 'private, max-age=600',
    })
  } catch (err) {
    console.error('[media] 录音转可播格式失败 id=' + id + '：' + (err as Error).message)
    return c.json({ ok: false, error: '这段录音暂时放不出来' }, 500)
  }
})

/**
 * 回吐 content/ 下的一个音频文件。
 *
 * ⚠️ 路径由**调用方拼死**（id / index 都已校验是整数），不接受任何来自请求的字符串，
 *    所以不存在路径穿越 —— readStaticFile 内部另有一道越界防护，是第二层。
 *
 * ⚠️ 找不到时返回 **404 而不是 500**：内容流水线还没跑过的时候，
 *    这只是「这篇还没有标准音」，不是「服务坏了」。
 *    返 500 会让客户端把「功能没做」误判成「后端挂了」。
 */
async function serveAudio(c: Context, relPath: string) {
  const bytes = await readStaticFile(relPath)
  if (!bytes) {
    console.warn('[media] 标准音缺失：' + relPath)
    return c.json({ ok: false, error: '这篇还没有标准音' }, 404)
  }
  // ⚠️ 复制成一个**独占的 ArrayBuffer** 再回吐：
  //    readStaticFile 给的是 Uint8Array<ArrayBufferLike>，Hono 的 Data 类型要的是
  //    Uint8Array<ArrayBuffer> —— TS 分得比运行时细，而这里真的需要一份能安全交出去的 buffer。
  const body = new Uint8Array(bytes.byteLength)
  body.set(bytes)
  return c.newResponse(body, 200, {
    // ⚠️ Content-Type 不能少：缺了它 InnerAudioContext 在真机上直接不播，且不报错
    'Content-Type': 'audio/mpeg',
    'Content-Length': String(body.byteLength),
    // ⭐ 内容不可变（换文本才会重新生成）→ 长缓存。没有它每次进朗读页都要重下几十 KB
    'Cache-Control': 'public, max-age=86400',
  })
}
