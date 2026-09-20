import { Hono } from 'hono'
import type { Context } from 'hono'
import { readStaticFile } from '../services/content'

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
 * ⚠️ 用户录音**不在此列**：那是隐私，走对象存储的签名地址，每条单独授权。
 *    两者别混 —— 把录音也搬到这条公开路由上会是一次真实的隐私事故。
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
