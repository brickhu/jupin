import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { GOODS_KIND } from '@jushuo/shared'

import { db } from '../db'
import { payments, users } from '../db/schema'
import { env } from '../env'
import { ENERGY_REASON, addEnergy } from './energy'
import { findGoods, sellableIssue, type ShopItem } from './goods'
import {
  XPAY_ORDER_STATUS,
  buildPayData,
  notifyProvideGoods,
  type PayData,
  queryXpayOrder,
} from './xpay'
import { errText } from './wx-access-token'

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
  /**
   * ⭐ 支付平台（⭐ `android` / `ios` / `windows` ✓）—— ⚠️ **必传** ✗
   * ⚠️ 理由见 xpay.ts 的 buildSignData：⭐ 不传就等于按安卓建单，
   *    而 iOS 走 Apple 支付 ⇒ ⭐ 钱扣了但查不到 ✓
   */
  platform: string
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
      platform: input.platform,
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
    } else {
      /**
       * ⚠️ 走到这里说明订单的商品种类我们不认识 —— 包括**历史订单里的 'unfreeze'**
       *    （解冻卡 2026-10 已作废，那种商品不再发货）。
       *    拒绝发货而不是静默成功：钱收了东西没给，必须留下一条明确的日志。
       */
      console.error('[order] 未知/已下架的商品种类，拒绝发货：' + pay.goodsKind)
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

/* ------------------------------------------------------------------ */
/* ⭐ 主动查单 —— 推送丢了也能自己发货                                    */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ **主动查单**：向微信问一趟"这单付了没"，付了就发货。
 *
 * ## 它解决什么
 *
 * ⚠️ 发货原本只有【推送】一条路 ✗ —— 而推送**会丢** ✓
 *    （⭐ 官方原话：「由 success 回调触发，**可能会丢失**，比如微信异常退出」✓）
 *    而且推送地址**只有一个** ✗ ⇒ ⭐ 本机 / dev / prod 只能有一个收得到 ✓
 *    ⇒ ⭐ 官方 §2.1 的要求是：⭐「【发货推送分支】与【发货轮询分支】**
 *      **至少实现一个**」✓✓
 *
 * ⭐ 有了它：⭐ **谁都能自己查单发货** ✓ ⇒ ⚠️ 推送地址指哪儿都不再要紧 ✓
 *
 * ## ⚠️ 两条路必须走同一个发货口
 *
 *    ⭐ `deliverOrder` 是**唯一**给订单发货的地方 ✓（⭐ 它自带行锁 + 幂等 + 对账 ✓）
 *    ⇒ ⚠️ 别在这里另写一套加能量的逻辑 ✗ ——
 *      推送和查单可能**同时**到达 ✓（⭐ 用户一边等一边刷新 ✓）
 *      没有那个行锁就会发两次货 ✓
 *
 * ## ⚠️ 顺序有意
 *
 *    ① ⭐ **先看本地**：已经是 paid 就直接返回 ✓（⭐ 省一次外部调用 ✓）
 *    ② ⭐ 查微信 ⇒ ⚠️ 只有 `status === 2`（已支付待发货）才发 ✓
 *    ③ ⭐ 走 `deliverOrder` 发货 ✓
 *    ④ ⭐ **回告微信**（`notify_provide_goods`）✓ ——
 *       ⚠️ 走查单这条路发的货，微信侧**不知道** ✗
 *       ⇒ ⭐ 不回告的话，用户在"交易订单"里会一直看到**待发货** ✓
 *       ⚠️ 回告失败**不能让整件事失败** ✗（⭐ 货已经发了 ✓）⇒ 只记日志 ✓
 */
/**
 * ⭐ **这一单是谁的** —— 查单接口必须先问这一句。
 *
 * ⚠️ 为什么不能省：⭐ 不校验的话，随便编一个单号就能查别人付没付款 ✓
 *    （⭐ 虽然不会发货，但那也是信息泄露 ✓）
 * ⚠️ 单号不存在时返回 `null` ✓ —— ⚠️ 调用方把它和"不是我的"**同等对待** ✓
 *    （⭐ 分开处理等于告诉对方"这个单号存在"✓）
 */
export async function findOrderOwner(outTradeNo: string): Promise<number | null> {
  const [row] = await db
    .select({ userId: payments.userId })
    .from(payments)
    .where(eq(payments.outTradeNo, outTradeNo))
  return row?.userId ?? null
}

export async function syncOrderFromWx(outTradeNo: string): Promise<DeliverResult> {
  const [pay] = await db.select().from(payments).where(eq(payments.outTradeNo, outTradeNo))
  if (!pay) return { ok: false as const, reason: 'unknown' as const }
  // ⭐ 已经发过了 ⇒ 什么都不用做（⭐ deliverOrder 也幂等，但这样省一次外部调用 ✓）
  if (pay.status === 'paid') {
    return { ok: true as const, delivered: false, amount: pay.goodsAmount }
  }

  /**
   * ⚠️⚠️ **必须带上付款人的 openid** ✗（⭐ 2026-10-09 实测踩到 ✓）
   *    ⚠️ 不带的话微信一律回 `268490001 openid错误` ✓ ——
   *    ⭐ 而那个措辞会让人以为是"用户身份不对"✗，⚠️ 实际是"你没传" ✓
   */
  const [owner] = await db
    .select({ openid: users.openid })
    .from(users)
    .where(eq(users.id, pay.userId))
  if (!owner?.openid) return { ok: false as const, reason: 'owner' as const }

  /**
   * ⚠️⚠️ **下单时的 env 和"钱实际扣在哪个环境"可能对不上** ✗
   *
   *    实测（⭐ 2026-10-09）：⭐ 订单创建时 `pay_env=1`（沙箱）✓，
   *    ⚠️ 但用户那笔**真的扣了钱**（⭐ 现网）✗
   *    ⇒ ⚠️ 拿 `pay_env=1` 去沙箱查 ⇒ ⭐ 微信回 `268490002 数据不存在` ✗✓
   *
   *    ⇒ ⭐ 所以**两个环境都查一遍** ✓ ——
   *      先按订单自己的 `pay_env`（⭐ 正常情况✓），
   *      ⚠️ 查不到再试另一个环境 ✓
   *    ⚠️ 这不会误发货 ✗：⭐ `deliverOrder` 还会核对**金额**和**归属** ✓
   *      （⭐ 查单只是"问一句付没付"，⭐ 不是发货的依据本身 ✓）
   */
  /**
   * ⚠️⚠️ **查单失败是【抛异常】，不是返回 null** ✗（⭐ `callWxApi` 的行为 ✓）
   *    ⇒ ⚠️ "数据不存在"会被抛出来 ⇒ ⭐ 不 catch 的话第二个环境根本轮不到 ✓
   */
  let lastError = ''
  const tryQuery = async (which: number) => {
    try {
      return await queryXpayOrder(outTradeNo, owner.openid, which)
    } catch (err) {
      lastError = `env=${which} ${errText(err).slice(0, 140)}`
      console.warn('[order] 查单失败（' + outTradeNo + '）：' + lastError)
      return null
    }
  }
  let order = await tryQuery(pay.payEnv)
  if (!order) {
    const other = pay.payEnv === 1 ? 0 : 1
    order = await tryQuery(other)
  }
  /**
   * ⚠️ **两个环境都查不动 ⇒ 把原因抛出去** ✗
   *    ⭐ 不是返回 `ok: false` —— ⚠️ 那样错误就消失在返回值里了 ✓
   *    （⭐ 2026-10-09 的教训：⭐ 兜底逻辑必须能自证为什么没兜住 ✓）
   */
  if (!order && lastError) throw new Error('两个环境都查不到：' + lastError)
  /**
   * ⚠️ 没查到、或者还没付 ⇒ ⭐ 都返回"没发货"而不是报错 ✓
   *    （⭐ 用户刚拉起支付、微信那边还没落账，这是正常的中间态 ✓）
   * ⚠️ 注意：**查单接口自己是会抛错的** ✗（⭐ 比如"数据不存在"✓）——
   *    那个错由调用方（sweep / 路由）catch ✓，⭐ 这里只判"有没有拿到订单" ✓
   */
  if (!order || order.status !== XPAY_ORDER_STATUS.paidWaitingDeliver) {
    return { ok: false as const, reason: 'unknown' as const }
  }

  const res = await deliverOrder({
    outTradeNo,
    xpayOrderId: typeof order.wx_order_id === 'string' ? order.wx_order_id : undefined,
    // ⚠️ 原始报文留档 —— 对账出问题时它是唯一的救命稻草 ✓
    raw: JSON.stringify(order),
  })

  if (res.ok) {
    try {
      await notifyProvideGoods(outTradeNo, owner.openid, pay.payEnv)
    } catch (err) {
      // ⚠️ 货已经发了 ⇒ 回告失败只记日志，绝不能让调用方以为发货失败 ✓
      console.warn('[order] 通知微信已发货失败（货已发）：' + errText(err))
    }
  }
  return res
}

/* ------------------------------------------------------------------ */
/* ⭐ 支付订单的定时兜底 —— 端侧关了页面也要能到账                        */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ **扫"卡住的支付订单"，逐笔查单发货**（⭐ 定时触发器调 ✓）
 *
 * ## ⚠️ 为什么必须有它（⭐ 用户 2026-10-09 报的"支付成功但半天不到账"✓）
 *
 *    发货有两条路，**但两条都不够** ✗：
 *      · ⭐ **推送** —— ⚠️ 会丢，而且推送地址只有一个环境收得到 ✓
 *      · ⭐ **端侧查单**（`waitArrival` ✓）—— ⚠️ **只等 3.6 秒** ✗
 *        ⇒ ⚠️ 微信侧还没落账 ⇒ ⚠️ 查不到"已支付" ⇒ ⭐ **之后再也没有人管这一单** ✗✗
 *        ⇒ ⚠️ 用户关掉页面 / 等久一点，这一单就**永远停在 pending** ✓
 *
 *    ⇒ ⭐ 所以**服务端必须自己兜底** ✓ ——
 *      ⚠️ 这一点**跟用户还在不在页面上无关** ✗ ✓
 *
 * ## ⚠️ 参数为什么是 3 分钟
 *
 *    ⭐ 比端侧那 3.6 秒宽得多 ✓（⭐ 微信落账通常几秒，但慢的时候能到几分钟 ✓）
 *    ⚠️ 又不能太长 ✗ —— ⭐ 用户已经去干别的了，越早到账体验越好 ✓
 *    ⚠️ 而查单本身**幂等**（⭐ 走 `deliverOrder` ✓），
 *      重复扫到同一笔也只会发一次货 ✓
 */
export async function sweepStaleOrders(
  minAgeMs = 3 * 60_000,
  /**
   * ⚠️⚠️ **别用 20 这种小数字** ✗（⭐ 2026-10-09 实测踩到 ✓）
   *
   *    第一版 `limit = 20` ✗ ⇒ ⚠️ 用户试了很多次下单（⭐ 每次落一行 pending ✓）
   *    ⇒ ⚠️ **真正付了的那一笔被挤在 limit 之外** ✗ ⇒ ⭐ 怎么扫都扫不到它 ✓✓
   *    ⚠️ 而表面现象是"扫了 20 笔、一笔没发"✗ —— ⭐ 看起来像"全都没付" ✓
   *    ⇒ ⭐ 给一个够大的数 ✓（⭐ 它是按 createdAt 升序 ✓ 老的先扫 ✓）
   */
  limit = 200,
): Promise<{
  checked: number
  delivered: number
  /**
   * ⚠️⚠️ **每一笔的结果都带出来**（⭐ 2026-10-09 加的 ✓）
   *
   *    第一版只回 `{checked, delivered}` ✗ —— ⚠️ 而 `delivered: 0` 时
   *    **完全看不出为什么** ✓（⭐ 错误被 catch 吞了 ✓）
   *    ⇒ ⭐ 排查只能靠猜 ✗ ⇒ ⚠️ 那就等于没有诊断 ✓
   *    ⭐ 所以这里把"每一笔查到什么"原样带出去 ✓✓
   */
  details: { outTradeNo: string; result: string }[]
}> {
  const { and, eq, lt } = await import('drizzle-orm')
  const rows = await db
    .select({ outTradeNo: payments.outTradeNo })
    .from(payments)
    .where(
      and(
        eq(payments.status, 'pending'),
        lt(payments.createdAt, new Date(Date.now() - minAgeMs)),
      ),
    )
    .orderBy(payments.createdAt)
    .limit(limit)

  let delivered = 0
  const details: { outTradeNo: string; result: string }[] = []
  for (const row of rows) {
    try {
      const res = await syncOrderFromWx(row.outTradeNo)
      if (res.ok && res.delivered) delivered++
      details.push({
        outTradeNo: row.outTradeNo,
        result: res.ok ? (res.delivered ? 'delivered' : 'ok-not-delivered') : 'rejected:' + res.reason,
      })
    } catch (err) {
      /** ⚠️ 单笔查不动不能让整轮挂掉 ✗ —— ⭐ 下一轮还会再扫到它 ✓ */
      const msg = errText(err)
      console.warn('[order] 兜底查单失败（' + row.outTradeNo + '）：' + msg)
      details.push({ outTradeNo: row.outTradeNo, result: 'error:' + msg.slice(0, 200) })
    }
  }
  return { checked: rows.length, delivered, details }
}
