import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

import { db } from '../db'
import { users } from '../db/schema'
import { signToken } from '../lib/token'
import { getOrCreateUserByOpenid } from '../services/user'
import { WxLoginError, code2session, hasAppSecret, syntheticIdentity } from '../services/wx-login'

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

/**
 * ⭐ 顺带把 **session_key** 落库。
 *
 * ⚠️ 为什么登录接口要管这件事：虚拟支付的**用户态签名**要 session_key，
 *    而它只能从 code2Session 拿。线上主通道是 callContainer（openid 由网关注入），
 *    那条路上**永远拿不到它** —— 所以两条路都要各自把能拿到的顺手存下来：
 *      · 这条（login）：本来就在换，顺带存
 *      · 另一条（/session）：专门为它准备的一次性刷新，见下
 * ⚠️ 它是敏感凭证：只写库、绝不下发、也不要打进日志。
 */
async function saveSessionKey(userId: number, sessionKey: string): Promise<void> {
  if (!sessionKey) return
  await db
    .update(users)
    .set({ sessionKey, sessionKeyAt: new Date() })
    .where(eq(users.id, userId))
}

/**
 * ⭐ 解析身份 —— 两条路：真实 code2Session，或（仅本地）合成一个稳定身份。
 *
 * ⚠️⚠️ 「本地换不到真 openid，只能用假的」是个**误解**：
 *    开发者工具里的 wx.login 拿到的 code 是**真的**，
 *    换回来的就是**开发者本人微信账号的 openid**（跟真机上是同一个）。
 *    所以判据是「配没配 appid/secret」，**不是** NODE_ENV。
 *
 *    之前按 NODE_ENV 分流、本地用合成 openid，代价很大：
 *    code 每次 wx.login 都变，而小程序每次启动都登录一次（app.ts 的 onLaunch）
 *    ⇒ 每次重新加载都换一个 openid = 每次都变成「刚注册、还没起过名字的新用户」。
 *    症状就是那句让人抓狂的话：「我明明加入过了，怎么又让我加入」。
 *    ——身份本来就在，是我们自己把它丢了，不是本地拿不到。
 */
async function resolveIdentity(
  code: string,
  as?: string,
): Promise<{ openid: string; sessionKey: string }> {
  if (hasAppSecret()) {
    const s = await code2session(code)
    return { openid: s.openid, sessionKey: s.sessionKey }
  }

  /**
   * 兜底：连 appid/secret 都没配（只想跑个离线 mock）→ 合成一个**稳定**的假身份。
   * ⚠️ 绝不能是生产环境：线上没配密钥应该直接失败，而不是给每个人发一个共享账号
   *    —— 那等于把所有人的成绩混在一条记录里。
   */
  if (process.env.NODE_ENV === 'production') {
    throw new WxLoginError('服务端未配置 WX_APPID / WX_SECRET，无法登录')
  }
  const s = syntheticIdentity(as)
  console.warn('[auth] 未配置 WX_APPID/WX_SECRET，使用合成的本地身份 ' + s.openid)
  return s
}

authRoutes.post('/login', async (c) => {
  const { code, as } = await c.req.json<{ code?: string; as?: string }>().catch(() => ({}) as {
    code?: string
    as?: string
  })
  if (!code) return c.json({ ok: false, error: '缺少 code' }, 400)

  let identity: { openid: string; sessionKey: string }
  try {
    identity = await resolveIdentity(code, as)
  } catch (err) {
    const status = err instanceof WxLoginError ? 401 : 500
    return c.json({ ok: false, error: (err as Error).message }, status)
  }

  const user = await getOrCreateUserByOpenid(identity.openid)
  await saveSessionKey(user.id, identity.sessionKey)

  return c.json({
    ok: true,
    // ⚠️ openid 必须一起签进 token —— 见 lib/token.ts 的说明
    data: { token: signToken(user.id, identity.openid), user: { id: user.id, nickname: user.nickname } },
  })
})

/**
 * ⭐⭐ 专门刷新 session_key（**只为一个功能存在**：虚拟支付的用户态签名）。
 *
 * ⚠️ 为什么不能靠 /login：线上走 callContainer，用户**根本不会调 /login**
 *    （openid 由网关注入，天然已登录）。但没有 session_key 就下不了单，
 *    于是需要一个「我已经登录了，只是补一张票」的入口。
 *
 * ⚠️ 这个接口是公开的（在 /api/auth 下），但它**不能被用来冒充别人**：
 *    code 是微信发的、绑定这个用户的，换回来的 openid 就是他本人 ——
 *    所以它只能改**自己那一行**的 session_key。
 * ⚠️ 它不签发 token，也不回任何用户信息。
 */
authRoutes.post('/session', async (c) => {
  const { code } = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string })
  if (!code) return c.json({ ok: false, error: '缺少 code' }, 400)

  let identity: { openid: string; sessionKey: string }
  try {
    identity = await resolveIdentity(code)
  } catch (err) {
    const status = err instanceof WxLoginError ? 401 : 500
    return c.json({ ok: false, error: (err as Error).message }, status)
  }
  if (!identity.sessionKey) {
    return c.json({ ok: false, error: '微信没有返回 session_key，请重新进入小程序再试' }, 503)
  }

  const user = await getOrCreateUserByOpenid(identity.openid)
  await saveSessionKey(user.id, identity.sessionKey)
  return c.json({ ok: true, data: { refreshed: true } })
})
