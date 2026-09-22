import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { GOODS_KIND } from '@jushuo/shared'

import { db } from '../db'
import { payments, users } from '../db/schema'
import { env } from '../env'
import { ENERGY_REASON, addEnergy } from './energy'
import { findGoods, sellableIssue, type ShopItem } from './goods'
import { grantUnfreezeCard } from './unfreeze'
import { buildPayData, type PayData } from './xpay'

/**
 * ⭐ 订单与发货。
 *
 * ⚠️⚠️ 两条不变量，整个支付模块就靠它们：
 *
 * 1. **发货只认平台的发货推送（或主动查单），绝不认端侧的 success 回调。**
 *    官方明确写了端侧回调「可能会丢失」，而且「前端支付回调不作为发货依据」。
 *
 * 2. **发货必须幂等。** 推送会按 2/4/8/16… 的间隔**最多重推 15 次**，
 *    所以「重复收到同一笔」是常态而不是异常。幂等由两把锁保证：
 *      · payments.status === 'paid' ⇒ 直接返回成功，不重复发货
 *      · energy_ledger 的唯一键 (reason, ref_type, ref_id, user) 兜底
 *        —— 就算状态位因为任何原因没翻过来，能量也只会加一次
 */

/** 下单/发货过程中的**可预期失败**（配置没配好、商品下架…）—— 调用方按 400 回 */
export class OrderError extends Error {}

/**
 * ⭐ 商户单号。
 *
 * ⚠️ 官方要求：8–32 个字符，只能是**数字、大小写字母、-|*@**，且不能以下划线开头。
 *    这里用「JP + 毫秒时间戳(36 进制) + 6 位随机」，长度 16 —— 天然满足。
 * ⚠️ 官方还特意提醒 outTradeNo **极端情况不保证唯一**、不要强依赖 ——
 *    所以我们自己加上数据库唯一索引（payments.out_trade_no unique）兜底：
 *    真撞了就是一次插入失败，而不是两个人共用一笔订单。
 */
export function newOutTradeNo(now: Date = new Date()): string {
  const rand = randomBytes(4).toString('hex').toUpperCase().slice(0, 6)
  return 'JP' + now.getTime().toString(36).toUpperCase() + rand
}

export interface CreateOrderResult {
  outTradeNo: string
  amountFen: number
  goods: ShopItem
  /** 端侧原样展开传给 wx.requestVirtualPayment */
  payData: PayData
  /** ⭐ true = mock 通道已经「付掉了」，端侧不要再拉起支付 */
  mockPaid: boolean
}

/** mock 通道下给端侧一个占位 payData —— 端侧拿到 mockPaid 就不会用它 */
const MOCK_PAY_DATA: PayData = {
  mode: 'short_series_goods',
  signData: '{}',
  paySig: 'mock',
  signature: 'mock',
}

/**
 * ⭐ 下单：落一行 pending 订单 + 返回 payData。
 *
 * ⚠️ 商品信息（码 / 点数 / 金额）全部**快照**进订单：商品以后改价改名，
 *    这笔历史订单必须还是当时那个商品（改配置不追溯）。
 * ⚠️ 钱只认服务端算出来的金额 —— 端侧传什么价格都不看。
 */
export async function createOrder(input: {
  userId: number
  goodsCode: string
  /** 用户态签名要用（来自 users.session_key） */
  sessionKey: string
  now?: Date
}): Promise<CreateOrderResult> {
  const now = input.now ?? new Date()
  const goods = await findGoods(input.goodsCode)
  if (!goods) throw new OrderError('商品不存在')
  const issue = sellableIssue(goods)
  if (issue) throw new OrderError(issue)

  const outTradeNo = newOutTradeNo(now)
  const mock = env.PAY === 'mock'
  const payEnv = env.XPAY_ENV

  await db.insert(payments).values({
    userId: input.userId,
    outTradeNo,
    goodsCode: goods.code,
    goodsKind: goods.kind,
    goodsAmount: goods.amount,
    amount: goods.priceFen,
    status: 'pending',
    payEnv,
  })

  /**
   * ⚠️ mock 只在**非生产**可用。这是第二道保险：
   *    PAY 的默认值已经 fail closed 成 xpay，但万一有人把它配错到生产上，
   *    这里也绝不允许「不花钱就拿到能量」。
   */
  if (!mock) {
    const payData = buildPayData(
      {
        outTradeNo,
        productId: goods.xpayProductId as string,
        goodsPriceFen: goods.priceFen,
        /** ⚠️ attach 用来在发货时校验「这笔钱是不是这个用户付的」 */
        attach: 'u:' + input.userId,
        payEnv,
      },
      input.sessionKey,
    )
    return { outTradeNo, amountFen: goods.priceFen, goods, payData, mockPaid: false }
  }

  if (env.NODE_ENV === 'production') {
    throw new OrderError('mock 支付通道不能用于生产环境（PAY 配错了）')
  }
  const delivered = await deliverOrder({
    outTradeNo,
    actualPriceFen: goods.priceFen,
    raw: 'mock:' + now.toISOString(),
  })
  if (!delivered.ok) throw new OrderError('mock 发货失败：' + delivered.reason)

  return { outTradeNo, amountFen: goods.priceFen, goods, payData: MOCK_PAY_DATA, mockPaid: true }
}

export interface DeliverInput {
  outTradeNo: string
  /** 付款人的 openid（推送里带）—— 用来校验归属 */
  openid?: string
  /** 微信支付交易单号 */
  transactionId?: string
  /** 虚拟支付平台单号（wx_order_id） */
  xpayOrderId?: string
  /** 实付金额（分）—— 与订单金额对账 */
  actualPriceFen?: number
  paidAt?: Date
  /** 原始报文 —— 对账出问题时这是唯一的救命稻草 */
  raw?: string
}

export type DeliverResult =
  | { ok: true; delivered: boolean; amount: number }
  | { ok: false; reason: 'unknown' | 'amount' | 'owner' | 'kind' }

/**
 * ⭐⭐ 发货 —— **唯一**给订单发货的地方（推送与查单都走它）。
 *
 * 幂等、对账、归属校验全部在这一个事务里，顺序不能换：
 *   未知单号 → 已发货 → 金额对不上 → 不是这个人付的 → 发货
 */
export async function deliverOrder(input: DeliverInput): Promise<DeliverResult> {
  return db.transaction(async (tx) => {
    /**
     * ⚠️ for('update') 行锁：同一笔订单的「推送」和「用户点查单」可能**同时**到达，
     *    没有行锁的话两边都会读到一个还没翻状态的 pending，于是发两次货。
     */
    const [pay] = await tx
      .select()
      .from(payments)
      .where(eq(payments.outTradeNo, input.outTradeNo))
      .for('update')
    if (!pay) return { ok: false as const, reason: 'unknown' as const }

    const raw = input.raw ?? pay.rawNotify ?? null

    /** ⭐ 幂等命中：已经发过了，直接把原报文更新掉就返回成功（让平台别再推） */
    if (pay.status === 'paid') {
      if (input.raw) {
        await tx.update(payments).set({ rawNotify: raw }).where(eq(payments.id, pay.id))
      }
      return { ok: true as const, delivered: false, amount: pay.goodsAmount }
    }

    /**
     * ⭐ 金额对账：实付必须与订单金额**完全相等**。
     *    ⚠️ 对不上就**不发货**（宁可人工介入，也不能按错的数发）。
     */
    if (input.actualPriceFen !== undefined && input.actualPriceFen !== pay.amount) {
      console.error(
        '[order] 金额对不上，拒绝发货：' + input.outTradeNo +
          ' 订单 ' + pay.amount + ' 分 / 实付 ' + input.actualPriceFen + ' 分',
      )
      return { ok: false as const, reason: 'amount' as const }
    }

    /** ⭐ 归属校验：推送 URL 是公开的，必须确认这笔钱是这个用户付的 */
    if (input.openid) {
      const [u] = await tx
        .select({ openid: users.openid })
        .from(users)
        .where(eq(users.id, pay.userId))
        .limit(1)
      if (u?.openid && u.openid !== input.openid) {
        console.error('[order] openid 与订单归属不符，拒绝发货：' + input.outTradeNo)
        return { ok: false as const, reason: 'owner' as const }
      }
    }

    /** ⭐ 按商品种类发货 —— 加新种类只需要在这里加一个分支 */
    if (pay.goodsKind === GOODS_KIND.energy) {
      await addEnergy(tx, {
        userId: pay.userId,
        amount: pay.goodsAmount,
        reason: ENERGY_REASON.purchase,
        refType: 'purchase',
        refId: pay.outTradeNo,
      })
    } else if (pay.goodsKind === GOODS_KIND.unfreeze) {
      await grantUnfreezeCard({ userId: pay.userId, ruleCode: 'purchase:' + pay.goodsCode }, tx)
    } else {
      console.error('[order] 未知商品种类，拒绝发货：' + pay.goodsKind)
      return { ok: false as const, reason: 'kind' as const }
    }

    const at = input.paidAt ?? new Date()
    await tx
      .update(payments)
      .set({
        status: 'paid',
        transactionId: input.transactionId ?? pay.transactionId,
        xpayOrderId: input.xpayOrderId ?? pay.xpayOrderId,
        paidAt: at,
        deliveredAt: new Date(),
        rawNotify: raw,
      })
      .where(eq(payments.id, pay.id))

    return { ok: true as const, delivered: true, amount: pay.goodsAmount }
  })
}
