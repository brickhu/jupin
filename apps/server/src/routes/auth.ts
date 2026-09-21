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

  let openid: string
  if (env.NODE_ENV !== 'production') {
    /**
     * 开发环境：伪 openid，免得必须配 WX_SECRET 才能联调。
     *
     * ⚠️⚠️ 它必须是**稳定的**，不能拿 code 现算（曾经是 `dev_${code}`）。
     *
     *    code 每次 wx.login 都不一样，而小程序**每次启动都会调一次 login()**
     *    （见 app.ts 的 onLaunch）—— 于是每次重新加载都换一个 openid，
     *    也就是每次都变成"一个刚注册、还没起过名字的新用户"。
     *    症状就是那句让人抓狂的话：「我明明加入过了，怎么又让我加入」。
     *
     *    ⚠️ 这个坑只在本地出现：线上身份由微信那侧的真实 openid 决定，
     *       跟 code 换不换没有关系。
     *
     * ⭐ 想开第二个测试账号：请求体里带 `as`（或改 .env.local 的 DEV_OPENID 后重启）。
     *    只放行 [A-Za-z0-9_]，且一律以 dev_ 开头 —— 本地那些"只动 dev_ 账号"的
     *    工具（tools/dev-unlock.mjs、services/user.ts 的自动会员）才会认它。
     */
    const name = typeof as === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(as) ? as : (process.env.DEV_OPENID ?? 'local')
    openid = `dev_${name}`
  } else {
    const appId = process.env.WX_APPID
    const secret = process.env.WX_SECRET
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
    url.searchParams.set('appid', appId ?? '')
    url.searchParams.set('secret', secret ?? '')
    url.searchParams.set('js_code', code)
    url.searchParams.set('grant_type', 'authorization_code')
    const res = await fetch(url)
    const data = (await res.json()) as { openid?: string; errmsg?: string }
    if (!data.openid) {
      return c.json({ ok: false, error: `微信登录失败: ${data.errmsg ?? 'unknown'}` }, 401)
    }
    openid = data.openid
  }

  const user = await getOrCreateUserByOpenid(openid)

  return c.json({
    ok: true,
    // ⚠️ openid 必须一起签进 token —— 见 lib/token.ts 的说明
    data: { token: signToken(user.id, openid), user: { id: user.id, nickname: user.nickname } },
  })
})
