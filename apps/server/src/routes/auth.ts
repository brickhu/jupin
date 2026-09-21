import { Hono } from 'hono'
import { env } from '../env'
import { signToken } from '../lib/token'
import { getOrCreateUserByOpenid } from '../services/user'

export const authRoutes = new Hono()

/**
 * 微信登录：wx.login 拿到的 code → openid → 签发 token。
 *
 * ⭐ 小程序用 openid 登录，**不需要注册、不需要密码、不需要验证码**——
 *    打开即已登录，注册转化损失归零。
 *
 * ⚠️ 部署到微信云托管后，走 callContainer 的请求**根本不需要走这个接口**：
 *    微信网关直接注入 x-wx-openid，见 middleware/auth.ts 路径①。
 *    本接口保留给「本地联调 / 公网访问」这条降级路径。
 */
authRoutes.post('/login', async (c) => {
  const { code, as } = await c.req.json<{ code?: string; as?: string }>()
  if (!code) return c.json({ ok: false, error: '缺少 code' }, 400)

  const appId = process.env.WX_APPID
  const secret = process.env.WX_SECRET

  let openid: string
  if (appId && secret) {
    /**
     * ⭐ 真实路径 —— **本地也走这条**。
     *
     * ⚠️⚠️ 「本地换不到真 openid，只能用假的」是个**误解**：
     *    开发者工具里的 wx.login 拿到的 code 是**真的**，
     *    换回来的就是**开发者本人微信账号的 openid**（跟真机上是同一个）。
     *    所以判据是"配没配 appid/secret"，**不是** NODE_ENV。
     *
     *    之前按 NODE_ENV 分流、本地用 `dev_${code}` 合成 openid，代价很大：
     *    code 每次 wx.login 都变，而小程序每次启动都登录一次（app.ts 的 onLaunch）
     *    ⇒ 每次重新加载都换一个 openid = 每次都变成"刚注册、还没起过名字的新用户"。
     *    症状就是那句让人抓狂的话：「我明明加入过了，怎么又让我加入」。
     *    ——身份本来就在，是我们自己把它丢了，不是"本地拿不到"。
     */
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
    url.searchParams.set('appid', appId)
    url.searchParams.set('secret', secret)
    url.searchParams.set('js_code', code)
    url.searchParams.set('grant_type', 'authorization_code')
    const res = await fetch(url)
    const data = (await res.json()) as { openid?: string; errmsg?: string }
    if (!data.openid) {
      return c.json({ ok: false, error: `微信登录失败: ${data.errmsg ?? 'unknown'}` }, 401)
    }
    openid = data.openid
  } else {
    /**
     * 兜底：连 appid/secret 都没配（只想跑个离线 mock）→ 合成一个**稳定**的假身份。
     *
     * ⚠️ 它必须是稳定的，不能拿 code 现算（理由同上）。
     * ⚠️ 而且**绝不能是生产环境**：线上没配密钥应该直接失败，而不是给每个人
     *    发一个共享的假账号 —— 那等于把所有人的成绩混在一条记录里。
     */
    if (env.NODE_ENV === 'production') {
      return c.json({ ok: false, error: '服务端未配置 WX_APPID / WX_SECRET，无法登录' }, 500)
    }
    const name = typeof as === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(as) ? as : (process.env.DEV_OPENID ?? 'local')
    console.warn(`[auth] 未配置 WX_APPID/WX_SECRET，使用合成的本地身份 dev_${name}`)
    openid = `dev_${name}`
  }

  const user = await getOrCreateUserByOpenid(openid)

  return c.json({
    ok: true,
    // ⚠️ openid 必须一起签进 token —— 见 lib/token.ts 的说明
    data: { token: signToken(user.id, openid), user: { id: user.id, nickname: user.nickname } },
  })
})
