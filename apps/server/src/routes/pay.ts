import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

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
export const payRoutes = new OpenAPIHono({ defaultHook })
import { defaultHook } from '../openapi'


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

const payNotifyRoute = createRoute({
  method: 'post',
  path: '/notify',
  tags: ['支付'],
  summary: '虚拟支付发货推送（支付平台回调）',
  description:
    '⚠️ 这是全站**唯一一个公开的写接口**（故意不在 authMiddleware 后面）：' +
    '支付平台要能直接打进来。身份靠推送内容里的签名，不靠登录态。\n\n' +
    '⚠️ 响应形状由平台决定，**不是**本站的 { ok, data } 信封：' +
    'XML 请求回 XML，JSON 请求回 { ErrCode, ErrMsg }。',
  request: { body: { content: { 'application/json': { schema: z.any() }, 'text/xml': { schema: z.any() }, 'application/xml': { schema: z.any() } } } },
  responses: {
    200: {
      description: '处理完成（平台只认 200 + 这个响应体）',
      content: {
        'application/json': { schema: z.object({ ErrCode: z.number(), ErrMsg: z.string() }) },
        'text/xml': { schema: z.any().openapi({ type: 'string' }) },
      },
    },
  },
})

payRoutes.openapi(payNotifyRoute, async (c) => {
  const raw = await c.req.text()
  const isXml = raw.trim().startsWith('<')
  const ok = () =>
    isXml
      ? c.text('<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>')
      : c.json({ ErrCode: 0, ErrMsg: 'success' })

  /**
   * ⭐⭐ **云托管消息推送的【路径检测请求】**（⭐ 官方规格 ✓）
   *
   *    ⚠️ 配推送时微信会先 POST 一个检测请求过来 ✓：
   *      ⭐ JSON：`{ "action": "CheckContainerPath" }`
   *      ⭐ XML ：`<xml><action>CheckContainerPath</action></xml>`
   *    ⭐ 官方原话：⭐「开发者回复 **success** 或回复**空**即可完成测试」✓
   *    ⚠️ 且「⭐ **路径返回的 Status 需要为 200**，非 200 会导致配置检查失败」✓
   *
   *    ⚠️ 不显式认它的话，它会掉进下面"没有 outTradeNo ⇒ 丢弃"那条 ✓
   *    ⇒ ⭐ 虽然也回 200 ✗，⚠️ 但**回的是 `{"ErrCode":0,...}` 而不是 `success`** ✓
   *      ⇒ ⚠️ 官方只承诺认 `success`/空 ⇒ ⭐ **别赌** ✓✓
   */
  if (/CheckContainerPath/i.test(raw)) {
    console.log('[pay] 云托管推送路径检测 ✓')
    return c.text('success')
  }

  /**
   * ⚠️⚠️ **我们开了公网访问 ⇒ 业务推送必须验来源** ✗（⭐ 官方规格 ✓）
   *
   *    ⭐「若云托管**未开启公网访问**，则该信任所有消息推送」✓
   *    ⭐「若开启了公网访问，⭐ 需要验证请求头带 **`x-wx-source`**
   *      的才是微信侧发起的推送」✓
   *
   *    ⚠️ 我们的域名（`*.sh.run.tcloudbase.com`）**公网可达** ✗
   *    ⇒ ⚠️ 不验的话，⭐ **任何人都能伪造一条发货推送** ✓
   *
   *    ⚠️⚠️ **为什么放在检测请求之后** ✗：
   *       ⚠️ **我无法确认检测请求带不带 `x-wx-source`** ✓
   *       ⇒ ⭐ 而检测请求**完全无害**（⭐ 只记一行日志 + 回 `success` ✓）
   *       ⇒ ⭐ **为它放行，把校验留给真正会改数据的业务推送** ✓✓
   *       （⭐ 若将来确认检测也带这个头，再挪前面也不迟 ✓）
   */
  if (!c.req.header('x-wx-source')) {
    console.warn('[pay] 拒收：请求头没有 x-wx-source（不是微信侧发起的）')
    return c.json({ ErrCode: -1, ErrMsg: 'forbidden' }, 403)
  }

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
