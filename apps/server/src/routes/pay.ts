import { Hono } from 'hono'

import { deliverOrder } from '../services/order'

/**
 * ⭐⭐ 虚拟支付的**发货推送**落点。
 *
 * ⚠️⚠️ 这是全站**唯一一个公开的写接口** —— 它故意不在 authMiddleware 后面：
 *    推送来自微信平台，不带（也带不了）我们的 token。
 *    所以「这条推送是真的吗」必须在这里自己解决，三道防线：
 *
 *    ① **单号必须在我们库里存在**，且属于这个 openid（伪造/串环境的典型特征是不存在）
 *    ② **实付金额必须与订单金额完全相等**（对不上不发货，宁可人工介入）
 *    ③ **状态机 + 行锁**：只有 pending 能变 paid，重复推送直接返回成功（幂等）
 *
 * ⚠️ 还差的第 ④ 道（**主动查单反查**）见 docs/design/payment-and-purchase.md §5.3：
 *    收到推送后向平台回查一次最稳。那是下一步（要先有凭证才能按沙箱实测接口形状）。
 *
 * ⚠️ 响应格式**必须是** { ErrCode: 0 }（或 success / 空），否则平台按 2/4/8/16… 的间隔
 *    **最多重推 15 次**。所以这里的原则是：**只在我们自己写库失败时才返回非 0**。
 */
export const payRoutes = new Hono()

/** 从推送报文里取字段 —— 官方明确「部分字段名称有转译，请以例子的 key 为准」 */
function pick(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k] ?? obj[k.toLowerCase()] ?? obj[k.toUpperCase()]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return undefined
}

function num(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  const v = pick(obj, ...keys)
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 解析推送 —— 两种格式都认。
 * ⚠️ XML 只做**极简**解析：我们只取几个字段，不值得为此背一个 XML 库。
 *    取不到就返回空对象，由调用方按「未知单号」丢弃并告警。
 */
export function parseNotify(raw: string): Record<string, unknown> {
  const text = raw.trim()
  if (!text) return {}
  if (text.startsWith('<')) {
    const out: Record<string, unknown> = {}
    const re = /<([A-Za-z_][\w]*)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/\1>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const key = m[1]
      const value = m[2]
      if (key && value !== undefined) out[key] = value
    }
    return out
  }
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

payRoutes.all('/notify', async (c) => {
  const raw = await c.req.text()
  const isXml = raw.trim().startsWith('<')
  const ok = () =>
    isXml
      ? c.text('<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>')
      : c.json({ ErrCode: 0, ErrMsg: 'success' })

  let data: Record<string, unknown> = {}
  try {
    data = parseNotify(raw)
  } catch (err) {
    console.error('[pay] 推送解析失败：' + (err as Error).message)
  }

  const event = pick(data, 'Event', 'event')
  const outTradeNo = pick(data, 'OutTradeNo', 'outTradeNo', 'out_trade_no')

  /**
   * ⚠️ 我们只处理**道具发货**这一种推送。其它事件（退款、投诉、风控）先记日志，
   *    但**同样返回成功** —— 否则微信会一直重推，而重推解决不了「我们没处理」这件事。
   *    （真正的处理见 docs/design/payment-and-purchase.md §6.2 / §6.3。）
   */
  if (event && event !== 'xpay_goods_deliver_notify') {
    console.warn('[pay] 收到未处理的推送事件：' + event)
    return ok()
  }
  if (!outTradeNo) {
    console.error('[pay] 推送里没有 outTradeNo，丢弃。原文：' + raw.slice(0, 500))
    return ok()
  }

  /** 金额既可能在顶层（totalFee），也可能在 GoodsInfo 里（ActualPrice） */
  const goodsInfo = (data.GoodsInfo ?? data.goodsInfo ?? {}) as Record<string, unknown>
  const actualPriceFen = num(goodsInfo, 'ActualPrice', 'actualPrice') ?? num(data, 'TotalFee', 'totalFee')
  const paidAtSec = num(data, 'PaidTime', 'paidTime')

  try {
    const res = await deliverOrder({
      outTradeNo,
      openid: pick(data, 'OpenId', 'openid'),
      transactionId: pick(data, 'TransactionId', 'transactionId'),
      xpayOrderId: pick(data, 'MchOrderNo', 'mchOrderNo'),
      actualPriceFen,
      paidAt: paidAtSec ? new Date(paidAtSec * 1000) : undefined,
      raw,
    })

    if (!res.ok) {
      /**
       * ⚠️ 未知单号 / 金额不符 / 归属不符 —— 都**返回成功**（不重推）。
       *    理由：重推解决不了这三种问题，只会把日志刷满；而它们都需要人看一眼。
       */
      console.error('[pay] 发货被拒（' + res.reason + '）：' + outTradeNo)
      return ok()
    }
    console.log(
      '[pay] ' + (res.delivered ? '已发货' : '重复推送（幂等）') + '：' + outTradeNo +
        ' +' + res.amount,
    )
    return ok()
  } catch (err) {
    /** ⭐ 只有「我们自己写库失败」才返回非 0 —— 那正是希望平台重推的情况 */
    console.error('[pay] 发货写入失败，让平台重推：' + (err as Error).message)
    return isXml
      ? c.text('<xml><ErrCode>1</ErrCode><ErrMsg><![CDATA[failed]]></ErrMsg></xml>')
      : c.json({ ErrCode: 1, ErrMsg: 'failed' })
  }
})
