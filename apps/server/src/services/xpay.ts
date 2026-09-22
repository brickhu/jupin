import { createHmac } from 'node:crypto'

import { env } from '../env'

/**
 * ⭐ 小程序「虚拟支付」（道具直购）—— 签名与单据构造。
 *
 * ⚠️⚠️ 三条铁律（踩错任何一条都表现为「支付失败」，而报错离原因很远）：
 *
 * 1. **签名的原文必须与实际发出的内容逐字节一致**。
 *    所以 signData 只能由 buildSignData() 产出**一次**，然后同一份字符串
 *    既用于签名、又交给端侧 —— 绝不重新 JSON.stringify 一次
 *    （键顺序/空格任何差异都会让签名对不上）。
 *
 * 2. **uri 不同**：基础库 wx.requestVirtualPayment 固定填 'requestVirtualPayment'，
 *    服务器 API（/xpay/query_order 等）填接口路径本身。
 *
 * 3. **AppKey 分沙箱与现网两把**，由 env 决定用哪把；不匹配报 -15006。
 *
 * ⭐ 算法在 xpay.test.ts 里用**官方文档给的测试向量**钉死了：
 *    paySig = hex(hmac_sha256(appKey, uri + '&' + signData))
 *    signature = hex(hmac_sha256(sessionKey, signData))
 *
 * 文档：https://developers.weixin.qq.com/miniprogram/dev/api/payment/wx.requestVirtualPayment.html
 */

/** 支付类型 —— 我们是道具直购（现金直购道具），不是代币充值 */
export const XPAY_MODE = {
  goods: 'short_series_goods',
  coin: 'short_series_coin',
} as const

/** 签名用的 uri */
export const XPAY_URI = {
  /** ⚠️ 基础库接口的 uri 是个**固定字符串**，不是路径 */
  requestVirtualPayment: 'requestVirtualPayment',
  queryOrder: '/xpay/query_order',
  refundOrder: '/xpay/refund_order',
} as const

/**
 * 该用哪把 AppKey。
 * ⚠️ 现网版本的 env 只能是 0（填 1 会报 -15011）—— 沙箱只能在开发版/体验版里试。
 */
export function appKeyOf(payEnv: number): string | undefined {
  return payEnv === 1 ? env.XPAY_SANDBOX_APP_KEY : env.XPAY_APP_KEY
}

/** ⭐ 支付签名（我们 → 微信）：hex(hmac_sha256(appKey, uri + '&' + signData)) */
export function calcPaySig(uri: string, signData: string, appKey: string): string {
  return createHmac('sha256', appKey).update(uri + '&' + signData).digest('hex')
}

/** ⭐ 用户态签名：hex(hmac_sha256(sessionKey, signData)) —— 代表「这个用户同意这笔操作」 */
export function calcSignature(signData: string, sessionKey: string): string {
  return createHmac('sha256', sessionKey).update(signData).digest('hex')
}

export interface OrderSignInput {
  outTradeNo: string
  /** 微信侧「道具管理」里的道具 ID */
  productId: string
  /**
   * 道具单价（**分**）。
   * ⚠️ 微信会拿它和后台道具价格比对，对不上报 -15013 ——
   *    这正是「我们改价了但微信侧没改」被发现的地方（也是好事）。
   */
  goodsPriceFen: number
  /**
   * 透传数据，发货推送里原样回来。
   * ⚠️ 我们用它带 userId —— 收货时拿它校验「这笔钱是不是这个用户付的」
   *    （推送 URL 是公开的，任何人都能往里 POST）。
   */
  attach: string
  buyQuantity?: number
  payEnv?: number
}

/**
 * ⭐ 构造 signData（**唯一**的产出点）。
 *
 * ⚠️ 键的顺序即签名的顺序，别乱动；也**不要**在别处再拼一次。
 * ⚠️ 字段清单来自官方基础库文档（short_series_goods）：
 *    offerId / buyQuantity / env / currencyType / productId / goodsPrice / outTradeNo / attach
 */
export function buildSignData(input: OrderSignInput): string {
  const payEnv = input.payEnv ?? env.XPAY_ENV
  return JSON.stringify({
    offerId: env.XPAY_OFFER_ID,
    buyQuantity: input.buyQuantity ?? 1,
    env: payEnv,
    currencyType: 'CNY',
    productId: input.productId,
    goodsPrice: input.goodsPriceFen,
    outTradeNo: input.outTradeNo,
    attach: input.attach,
  })
}

/** 交给端侧 wx.requestVirtualPayment 的完整参数（端侧原样展开传进去） */
export interface PayData {
  mode: string
  /** ⚠️ 是**字符串**不是对象（基础库要求 string 形式） */
  signData: string
  paySig: string
  signature: string
}

/**
 * ⭐ 组装 payData。
 *
 * ⚠️ 缺 OfferID / AppKey 时**明确抛错**，绝不返回一个「看起来能付但一定失败」的对象 ——
 *    那种失败会以 -15006（签名错）的形式出现，排查方向完全跑偏。
 */
export function buildPayData(input: OrderSignInput, sessionKey: string): PayData {
  if (!env.XPAY_OFFER_ID) throw new Error('虚拟支付未配置 XPAY_OFFER_ID（虚拟支付-基础配置）')
  const appKey = appKeyOf(input.payEnv ?? env.XPAY_ENV)
  if (!appKey) throw new Error('虚拟支付未配置 AppKey（现网 XPAY_APP_KEY / 沙箱 XPAY_SANDBOX_APP_KEY）')
  if (!sessionKey) throw new Error('缺少登录态 session_key，无法生成用户态签名')

  const signData = buildSignData(input)
  return {
    mode: XPAY_MODE.goods,
    signData,
    paySig: calcPaySig(XPAY_URI.requestVirtualPayment, signData, appKey),
    signature: calcSignature(signData, sessionKey),
  }
}

/**
 * ⭐ 官方错误码 → 人话。
 *
 * ⚠️ 映射表在 **shared**（`@jushuo/shared` 的 xpay.ts）：
 *    端侧 wx.requestVirtualPayment 的 fail 回调同样会拿到 errCode，
 *    而用户看到的是端侧那一句 —— 两边各维护一份迟早变成「同一个码两种说法」。
 *    这里只是把它转出来，方便服务端 import。
 */
export { XPAY_ERROR, explainXpayError } from '@jushuo/shared'

