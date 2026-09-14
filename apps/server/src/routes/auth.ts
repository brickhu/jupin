import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { users } from '../db/schema'
import { signToken } from '../lib/token'
import { env } from '../env'

export const authRoutes = new Hono()

/**
 * 微信登录：wx.login 拿到的 code → openid → 签发 token。
 *
 * ⭐ 小程序用 openid 登录，**不需要注册、不需要密码、不需要验证码**——
 *    打开即已登录，注册转化损失归零。
 */
authRoutes.post('/login', async (c) => {
  const { code } = await c.req.json<{ code?: string }>()
  if (!code) return c.json({ ok: false, error: '缺少 code' }, 400)

  let openid: string
  if (env.NODE_ENV !== 'production') {
    // 开发环境：用 code 当伪 openid，避免必须配 WX_SECRET 才能联调
    openid = `dev_${code}`
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

  let [user] = await db.select().from(users).where(eq(users.openid, openid)).limit(1)
  if (!user) {
    const inserted = await db.insert(users).values({ openid, nextFreeAt: new Date(0) }).returning()
    user = inserted[0]!
  }

  return c.json({
    ok: true,
    data: { token: signToken(user.id), user: { id: user.id, nickname: user.nickname } },
  })
})
