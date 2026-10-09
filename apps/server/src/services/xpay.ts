import type { VirtualPayData } from '@jushuo/shared'
import { createHmac } from 'node:crypto'

import { env } from '../env'
import { type WxError, callWxApi } from './wx-access-token'

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
  /**
   * ⭐ 支付平台 —— ⭐ **必须由端侧按真实设备传** ✓
   * ⚠️ 取值：`android` / `ios` / `windows` 等（⭐ 官方："platform 与应用 id 有关"✓）
   * ⚠️⚠️ **不能写死** ✗ —— ⚠️ 写错就是"钱扣了但查不到单" ✓
   */
  platform: string
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
    /**
     * ⚠️⚠️ **平台必须传，而且必须是对的** ✗（⭐ 2026-10-09 实测踩到 ✓）
     *
     *    官方 SDK 的原文：⭐「platform 与应用 id 有关
     *      ⚠️ **默认值：android 安卓平台**」✓
     *    ⚠️ 而 iOS 走的是 **Apple 支付** ✗（⭐ 官方设备路由表：
     *      Android/鸿蒙/Windows ⇒ 微信支付；⭐ iOS ⇒ Apple 支付 ✓）
     *    ⇒ ⚠️ 不传的话 iOS 的单被建在**安卓渠道**下 ✗✓
     *      ⇒ ⭐ **钱扣了、但按安卓渠道查永远"参数错误"** ✓
     *      （⭐ 用户的 ¥1 就是这么扣掉又不到账的 ✓）
     */
    platform: input.platform,
    productId: input.productId,
    goodsPrice: input.goodsPriceFen,
    outTradeNo: input.outTradeNo,
    attach: input.attach,
  })
}

/** 交给端侧 wx.requestVirtualPayment 的完整参数（端侧原样展开传进去） */
/**
 * ⭐ payData —— **直接用 shared 的那一份类型**（`VirtualPayData`）。
 *
 * ⚠️⚠️ 这里原来是本地复制的 interface，`mode` 写的是宽泛的 `string`，
 *    而 shared 里是 `'short_series_goods' | 'short_series_coin'` 的联合 ——
 *    **同一个事实两份定义**，于是响应 schema 与 handler 的返回类型对不上
 *    （OpenAPI 迁移时当场暴露）。现在只留一处真相：shared 的类型。
 */
export type PayData = VirtualPayData

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


/* ------------------------------------------------------------------ */
/* ⭐ 服务器 API：查单 / 通知发货                                        */
/* ------------------------------------------------------------------ */

/** 微信服务端 API 的根 */
const WX_API_BASE = 'https://api.weixin.qq.com'

/**
 * ⭐ **订单状态码**（⭐ 官方定义 ✓）
 *
 * ⚠️ 只列出我们**真的会判**的那一个 ✗ —— ⚠️ 其余的（关单 / 退款中 / 已退款…）
 *    我们现在不处理 ✓ ⇒ ⭐ 不预先铺一张表 ✓（⭐ 铺了也没人维护 ✓）
 */
export const XPAY_ORDER_STATUS = {
  /** ⭐ **2 = 已支付待发货** ✓ —— 这就是发货的触发点 ✓ */
  paidWaitingDeliver: 2,
} as const

/**
 * ⭐⭐ **`query_order` —— 主动查单**（⭐ 用户 2026-10-09 要的 ✓）
 *
 * ## 为什么必须有它
 *
 * ⚠️ 发货原本只有**一条路**：等微信推 `xpay_goods_deliver_notify` ✗
 *    ⇒ ⚠️ 推送**一丢就永远不到账** ✗ —— 而它丢得一点都不罕见 ✓
 *      （⭐ 官方原话：「由 success 回调触发，**可能会丢失**，比如微信异常退出」✓）
 *    ⚠️ 而且推送地址**只有一个** ✗ ⇒ 本机、dev、prod **只能有一个收得到** ✓
 *    ⇒ ⭐ 官方文档 §2.1 的注意事项也写着：
 *      「⭐【发货推送分支】与【发货轮询分支】**至少实现一个**」✓✓
 *
 * ⭐ 有了它：⭐ **谁都能自己查单发货** ✓ ⇒ ⚠️ 推送地址指哪儿都不再要紧 ✓
 *
 * ## ⚠️⚠️ 签名（⭐ 这里极易踩错 ✓）
 *
 *    官方 §2.5 说得很清楚：⭐ **服务器 API 的 `signData` 就是 POST body 本身** ✓
 *    即：`paySig = hmac_sha256(appKey, uri + '&' + postBody)` ✓
 *
 *    ⇒ ⚠️ **body 只能序列化一次** ✗：签的就是这一份字符串，
 *      发出去也必须**逐字节**是它 ✓
 *      （⭐ 所以下面先 `JSON.stringify` 存成 `body`，再同时拿它去签名和请求 ✓）
 *    ⚠️ 踩错的症状是 **-15006（支付签名错）** ✗ —— 而报错离原因很远 ✓
 *
 * ⚠️ 算法已用**官方给的测试向量**钉死（⭐ 见 xpay.test.ts ✓）：
 *    uri=/xpay/query_user_balance · appkey=12345
 *    body='{"openid": "xxx", "user_ip": "127.0.0.1", "env": 0}'
 *    ⇒ c37809f27c6d7fd1837ad2500a04512b66b34fd793a39a385fade56dca89a4b5 ✓
 */
export interface XpayOrder {
  /** ⭐ 订单状态：**2 = 已支付待发货** ✓（⭐ 官方定义 ✓） */
  status?: number
  /** 微信侧订单号 */
  wx_order_id?: string
  /** 已发货（⭐ 幂等判断用 ✓） */
  provide_status?: number
  [k: string]: unknown
}

export async function queryXpayOrder(
  outTradeNo: string,
  /**
   * ⚠️⚠️ **付款人的 openid —— 必须有** ✗（⭐ 2026-10-09 实测踩到 ✓）
   *
   *    第一版只传了 `{order_id, env}` ✗ ⇒ ⚠️ 微信一律回：
   *      ⭐ `268490001 **openid错误**` ✓
   *    ⇒ ⚠️ 而那个错误**看起来像"用户身份不对"** ✗
   *      ⇒ ⭐ 实际是"**你压根没传 openid**"✓ —— ⚠️ 排查方向会被带偏 ✓
   */
  openid: string,
  payEnv: number = env.XPAY_ENV,
): Promise<XpayOrder | null> {
  const appKey = appKeyOf(payEnv)
  if (!appKey) {
    throw new Error(
      `查单缺少 AppKey（env=${payEnv}）—— ` +
        (payEnv === 1 ? '要 XPAY_SANDBOX_APP_KEY' : '要 XPAY_APP_KEY'),
    )
  }
  // ⚠️ 只序列化一次 —— 签名的就是它，发出去的也必须逐字节是它 ✓
  const body = JSON.stringify({ openid, order_id: outTradeNo, env: payEnv })
  const paySig = calcPaySig(XPAY_URI.queryOrder, body, appKey)

  const data = await callWxApi<{ order?: XpayOrder } & WxError>(
    WX_API_BASE + XPAY_URI.queryOrder,
    body,
    { pay_sig: paySig },
  )
  return data.order ?? null
}

/**
 * ⭐ **`notify_provide_goods` —— 告诉微信我们发货了**。
 *
 * ⚠️ 官方原话：⭐「正常通过 `xpay_goods_deliver_notify` 消息推送**返回成功**就不需要
 *    调用这个 API」✓ —— ⭐ 所以它只用于**补单** ✓：
 *      · 推送丢了、我们主动查单发的货 ⇒ 微信侧不知道，得回告一声 ✓
 *      · 否则用户在"交易订单"里会一直看到**待发货** ✓
 *
 * ⚠️ 签名规则与 `query_order` 完全相同 ✓（⭐ body 也只序列化一次 ✓）
 */
export async function notifyProvideGoods(
  outTradeNo: string,
  /** ⚠️ 同样要 openid ✗ —— 理由见 queryXpayOrder ✓ */
  openid: string,
  payEnv: number = env.XPAY_ENV,
): Promise<void> {
  const appKey = appKeyOf(payEnv)
  if (!appKey) {
    throw new Error(
      `通知发货缺少 AppKey（env=${payEnv}）—— ` +
        (payEnv === 1 ? '要 XPAY_SANDBOX_APP_KEY' : '要 XPAY_APP_KEY'),
    )
  }
  const body = JSON.stringify({ openid, order_id: outTradeNo, env: payEnv })
  const paySig = calcPaySig('/xpay/notify_provide_goods', body, appKey)
  await callWxApi<WxError>(WX_API_BASE + '/xpay/notify_provide_goods', body, { pay_sig: paySig })
}
