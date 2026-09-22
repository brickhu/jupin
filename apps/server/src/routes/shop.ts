import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

import { db } from '../db'
import { users } from '../db/schema'
import { env } from '../env'
import type { Variables } from '../middleware/auth'
import { listGoods, sellableIssue } from '../services/goods'
import { OrderError, createOrder } from '../services/order'
import { code2session } from '../services/wx-login'

/**
 * ⭐ 商店：商品列表 + 下单。
 *
 * ⚠️ 价格**不在端侧写死**，一律从 /goods 拿：小程序审核要 1–3 天，
 *    把价格绑在发版上，促销/调价就废了（见 docs/design/payment-and-purchase.md §2.4）。
 */
export const shopRoutes = new Hono<{ Variables: Variables }>()

shopRoutes.get('/goods', async (c) => {
  const items = await listGoods()
  return c.json({
    ok: true,
    data: {
      items: items.map((i) => ({
        code: i.code,
        amount: i.amount,
        priceFen: i.priceFen,
        title: i.title,
        subtitle: i.subtitle,
        badge: i.badge ?? null,
        /** ⭐ 端侧据此置灰「暂时买不了」，而不是让用户点了才失败 */
        sellable: sellableIssue(i) === null,
      })),
      /** 沙箱还是现网 —— 端侧在界面上标一下，免得测试时以为是真的 */
      payEnv: env.XPAY_ENV,
    },
  })
})

/**
 * ⭐ 下单。
 *
 * ⚠️⚠️ 下单需要**用户态签名**，而那要用 session_key —— 线上主通道（callContainer）拿不到它。
 *    所以：
 *      · 端侧可以直接带一个 wx.login 的 code 上来（推荐，一次搞定）
 *      · 不带且库里也没有 ⇒ 回 409 NEED_SESSION，端侧补一次 wx.login 再重试
 *    不这么做的话，用户会看到「支付失败」而原因其实是「我们没有他的 session_key」。
 */
shopRoutes.post('/order', async (c) => {
  const userId = c.get('userId')
  const body = await c
    .req.json<{ goodsCode?: string; code?: string }>()
    .catch(() => ({}) as { goodsCode?: string; code?: string })
  const goodsCode = typeof body.goodsCode === 'string' ? body.goodsCode : ''
  if (!goodsCode) return c.json({ ok: false, error: '缺少 goodsCode' }, 400)

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user) return c.json({ ok: false, error: '用户不存在' }, 401)

  let sessionKey = user.sessionKey ?? ''

  /** 端侧补上来的 code：换一次 session_key 并落库（下次就不用再传了） */
  if (typeof body.code === 'string' && body.code) {
    try {
      const s = await code2session(body.code)
      /** ⚠️ 只接受「换回来的 openid 就是他本人」的那一次 —— 否则这等于让 A 给 B 写 session_key */
      if (s.openid === user.openid && s.sessionKey) {
        sessionKey = s.sessionKey
        await db
          .update(users)
          .set({ sessionKey: s.sessionKey, sessionKeyAt: new Date() })
          .where(eq(users.id, userId))
      }
    } catch (err) {
      console.warn('[shop] 刷新 session_key 失败：' + (err as Error).message)
    }
  }

  if (!sessionKey && env.PAY !== 'mock') {
    return c.json(
      { ok: false, code: 'NEED_SESSION', error: '需要重新获取登录态（wx.login）后再下单' },
      409,
    )
  }

  try {
    const order = await createOrder({ userId, goodsCode, sessionKey: sessionKey || 'mock' })
    return c.json({
      ok: true,
      data: {
        outTradeNo: order.outTradeNo,
        amountFen: order.amountFen,
        points: order.goods.amount,
        mockPaid: order.mockPaid,
        payData: order.payData,
      },
    })
  } catch (err) {
    /** ⚠️ 可预期失败（商品下架 / 没配道具 / 签名缺配置）回 400 + 人话，不要 500 */
    const message = err instanceof OrderError ? err.message : (err as Error).message
    console.warn('[shop] 下单失败：' + message)
    return c.json({ ok: false, error: message }, 400)
  }
})
