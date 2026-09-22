import { Hono } from 'hono'
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { submissions } from '../db/schema'
import { readStaticFile } from '../services/content'
import { env } from '../env'
import { playableBytesOf } from '../services/recording'
import { getStorage } from '../storage'

export const mediaRoutes = new Hono()

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
mediaRoutes.get('/articles/:file', async (c) => {
  // 形如 1.mp3
  const m = /^(\d+)\.mp3$/.exec(c.req.param('file'))
  if (!m) return c.json({ ok: false, error: '音频不存在' }, 404)
  return serveAudio(c, `content/audio/${m[1]}.mp3`)
})

/**
 * ⚠️ 参数**不能写成 `w:index.mp3`** —— Hono 的路由按 `/` 切段，
 *    `:index.mp3` 会被当成一个叫 `index.mp3` 的参数名，
 *    `c.req.param('index')` 拿到 undefined → 静默 404。
 *    踩过一次：整句能播、单词全部 404。
 *    ⇒ 让每段就是一个干净的参数，后缀在代码里解析。
 */
mediaRoutes.get('/articles/:id/:file', async (c) => {
  const id = Number(c.req.param('id'))
  const m = /^w(\d+)\.mp3$/.exec(c.req.param('file'))
  const index = m ? Number(m[1]) : -1
  if (!Number.isInteger(id) || id <= 0 || index < 0) {
    return c.json({ ok: false, error: '音频不存在' }, 404)
  }
  return serveAudio(c, `content/audio/${id}/w${index}.mp3`)
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
mediaRoutes.get('/recording/:id', async (c) => {
  if (env.STORAGE !== 'local') {
    return c.json({ ok: false, error: '录音暂不支持这种取法' }, 404)
  }

  const id = c.req.param('id')
  // ⚠️ 先按形状挡一道：提交 id 是 24 位十六进制。
  //    这样任何手写的路径都到不了数据库查询那一步。
  if (!/^[0-9a-f]{24}$/.test(id)) {
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
