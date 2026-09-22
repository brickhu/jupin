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
 * ⚠️ 这些码值得**逐条翻译**：它们几乎都指向「配置/发布流程没走完」，
 *    而不是代码 bug —— 直接甩一个 -15013 给用户，等于什么也没说。
 */
export const XPAY_ERROR: Record<string, string> = {
  '-1': '支付失败，请重试',
  '-2': '你取消了支付',
  '-4': '支付被风控拦截',
  '-15002': '这笔订单号已经用过了，请重新发起',
  '-15005': '登录态签名失效，请重新进入小程序再试',
  '-15006': '支付签名不对（检查 AppKey 与签名算法）',
  '-15007': '登录态已过期，请重新进入小程序再试',
  '-15008': '虚拟支付二级商户进件还没完成',
  '-15009': '代币还没发布',
  '-15010': '这个道具还没发布（去「道具管理」发布到现网）',
  '-15011': '现网版本不能用沙箱环境（env 必须为 0）',
  '-15012': '微信侧关单了，请重新发起',
  '-15013': '订单金额与微信侧道具价格不一致（改价后两边要对齐）',
  '-15014': '道具刚发布，大约 10 分钟后才能下单',
  '-15016': 'signData 格式有问题',
  '-15017': '商户收款功能被限制（去微信支付商户平台看原因）',
  '-15018': '道具审核没通过',
  '-15019': '商户受限，去微信支付商户平台看原因',
  '-15020': '操作过快，稍后再试',
  '-15021': '小程序交易被限频',
}

/** 把错误码翻成人话；认不出来就原样带上，别丢信息 */
export function explainXpayError(errCode: number | undefined, errMsg?: string): string {
  if (errCode === undefined) return errMsg ?? '支付失败'
  const known = XPAY_ERROR[String(errCode)]
  return known ? known + '（' + errCode + '）' : (errMsg ?? '支付失败') + '（' + errCode + '）'
}
