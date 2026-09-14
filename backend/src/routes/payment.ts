import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { payments } from '../db/schema'
import { createOrder, handlePaymentNotify } from '../services/payment'

export const paymentRoutes = new Hono()

// 单篇解锁
paymentRoutes.post('/unlock', zValidator('json', z.object({
  articleId: z.number(),
})), async (c) => {
  const userId = c.get('userId') as number
  const { articleId } = c.req.valid('json')

  const { payment, outTradeNo } = await createOrder({
    userId,
    type: 'single',
    amount: 0.99,
    articleId,
  })

  return c.json({
    orderId: payment.id,
    outTradeNo,
    amount: 0.99,
    message: '请使用支付宝扫码支付',
    qrCode: `https://qr.alipay.com/${outTradeNo}`,
  })
})

// Pro 订阅
paymentRoutes.post('/subscribe', zValidator('json', z.object({
  plan: z.enum(['monthly', 'yearly']),
})), async (c) => {
  const userId = c.get('userId') as number
  const { plan } = c.req.valid('json')

  const amount = plan === 'yearly' ? 199.00 : 29.00

  const { payment, outTradeNo } = await createOrder({
    userId,
    type: plan,
    amount,
  })

  return c.json({
    orderId: payment.id,
    outTradeNo,
    amount,
    plan,
    message: '请使用支付宝扫码签约',
    qrCode: `https://qr.alipay.com/${outTradeNo}`,
  })
})

// 支付宝异步通知
paymentRoutes.post('/notify', async (c) => {
  const body = await c.req.json()

  try {
    await handlePaymentNotify(
      body.trade_no || '',
      body.out_trade_no || '',
      body.trade_status || '',
    )

    return c.json({ code: 'SUCCESS', message: 'ok' })
  } catch (err: any) {
    console.error('Payment notify error:', err)
    return c.json({ code: 'FAIL', message: err.message }, 500)
  }
})

// 查询订单状态
paymentRoutes.get('/status/:id', async (c) => {
  const userId = c.get('userId') as number
  const orderId = parseInt(c.req.param('id'))

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.id, orderId))
    .limit(1)

  if (!payment || payment.userId !== userId) {
    return c.json({ error: '订单不存在' }, 404)
  }

  return c.json({
    id: payment.id,
    type: payment.type,
    amount: payment.amount,
    status: payment.status,
    outTradeNo: payment.outTradeNo,
    createdAt: payment.createdAt,
    paidAt: payment.paidAt,
  })
})