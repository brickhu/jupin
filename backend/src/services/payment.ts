import { db } from '../db'
import { payments, users, userArticleStatus } from '../db/schema'
import { eq, and } from 'drizzle-orm'

interface CreateOrderParams {
  userId: number
  type: 'single' | 'monthly' | 'yearly'
  amount: number
  articleId?: number
}

const amountMap: Record<string, number> = {
  single: 0.99,
  monthly: 29.00,
  yearly: 199.00,
}

export async function createOrder(params: CreateOrderParams) {
  const outTradeNo = `JUSHOU_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const paymentId = Date.now() * 1000 + Math.floor(Math.random() * 1000)

  const [payment] = await db
    .insert(payments)
    .values({
      id: paymentId,
      userId: params.userId,
      type: params.type,
      channel: 'alipay',
      amount: String(params.amount || amountMap[params.type]),
      articleId: params.articleId || null,
      outTradeNo,
      status: 'pending',
    })
    .returning()

  return { payment, outTradeNo }
}

export async function handlePaymentNotify(tradeNo: string, outTradeNo: string, status: string) {
  // 查找订单
  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.outTradeNo, outTradeNo))
    .limit(1)

  if (!payment) {
    throw new Error('订单不存在')
  }

  if (payment.status === 'success') {
    return { alreadyProcessed: true }
  }

  // 更新订单状态
  const newStatus = status === 'TRADE_SUCCESS' ? 'success' : status === 'TRADE_CLOSED' ? 'refunded' : 'failed'

  await db
    .update(payments)
    .set({
      tradeNo,
      status: newStatus as typeof payment.status,
      paidAt: newStatus === 'success' ? new Date() : null,
    })
    .where(eq(payments.id, payment.id))

  // 支付成功后更新用户权益
  if (newStatus === 'success') {
    const userId = payment.userId

    if (payment.type === 'single' && payment.articleId) {
      // 单篇解锁：更新 user_article_status
      const [statusRecord] = await db
        .select()
        .from(userArticleStatus)
        .where(
          and(
            eq(userArticleStatus.userId, userId),
            eq(userArticleStatus.articleId, payment.articleId),
          )
        )
        .limit(1)

      if (statusRecord) {
        await db
          .update(userArticleStatus)
          .set({ isUnlocked: true })
          .where(eq(userArticleStatus.id, statusRecord.id))
      }
    } else if (payment.type === 'monthly' || payment.type === 'yearly') {
      // 订阅：更新用户 subscription_end
      const now = new Date()
      const duration = payment.type === 'yearly' ? 365 : 30
      const subscriptionEnd = new Date(now)
      subscriptionEnd.setDate(subscriptionEnd.getDate() + duration)

      await db
        .update(users)
        .set({
          subscriptionEnd,
          dailySubmissionsLeft: 500,
        })
        .where(eq(users.id, userId))
    }
  }

  return { processed: true }
}