import { eq } from 'drizzle-orm'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import { db } from '../db'
import { users } from '../db/schema'
import { env } from '../env'
import type { Variables } from '../middleware/auth'
import { listGoods, sellableIssue } from '../services/goods'
import {
  OrderError,
  createOrder,
  findOrderOwner,
  syncOrderFromWx,
} from '../services/order'
import { code2session } from '../services/wx-login'

/**
 * ⭐ 商店：商品列表 + 下单。
 *
 * ⚠️ 价格**不在端侧写死**，一律从 /goods 拿：小程序审核要 1–3 天，
 *    把价格绑在发版上，促销/调价就废了（见 docs/design/payment-and-purchase.md §2.4）。
 */
export const shopRoutes = new OpenAPIHono<{ Variables: Variables }>({ defaultHook })
import { defaultHook } from '../openapi'
import {
  ShopGoodsResponseSchema,
  ShopOrderResponseSchema,
  errorResponse,
} from '../openapi/schemas'


const shopGoodsRoute = createRoute({
  method: 'get',
  path: '/goods',
  tags: ['我的'],
  summary: '商品列表（价格从服务端来）',
  // ⚠️ 与 /api/user/* 下其它接口统一：文档必须写明要带身份（运行时有 authMiddleware 兜底）
  security: [{ userToken: [] }],
  responses: {
    200: {
      content: { 'application/json': { schema: ShopGoodsResponseSchema } },
      description: '成功',
    },
  },
})

shopRoutes.openapi(shopGoodsRoute, async (c) => {
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
  }, 200)
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
const shopOrderRoute = createRoute({
  method: 'post',
  path: '/order',
  tags: ['我的'],
  summary: '下单（返回虚拟支付签名数据）',
  // ⚠️ 与 /api/user/* 下其它接口统一：文档必须写明要带身份（409 那些分支都建立在"这是我"上）
  security: [{ userToken: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            code: z.string(),
            /**
             * ⭐ **支付平台**（⭐ `android` / `ios` / `windows` ✓）—— ⚠️ **端侧必传** ✗
             *
             * ⚠️⚠️ 官方 SDK 明写：⭐「platform 与应用 id 有关，
             *    ⚠️ **默认值：android 安卓平台**」✓
             *    ⇒ ⚠️ 而 iOS 走的是 **Apple 支付** ✗
             *    ⇒ ⭐ 不传的话 iOS 的单建在安卓渠道下：**钱扣了、查不到、不到账** ✓✓
             *      （⭐ 2026-10-09 实际踩到 ✓）
             * ⚠️ 所以这里**不设默认值** ✗ —— ⭐ 缺了就报错，
             *    总比默默按安卓建单、用户花了钱拿不到货强 ✓
             */
            platform: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ShopOrderResponseSchema } },
      description: '成功',
    },
    400: errorResponse('商品不可售 / 参数不合法'),
    401: errorResponse('未登录'),
    409: errorResponse('订单已存在 / 状态冲突（带 code）'),
  },
})

shopRoutes.openapi(shopOrderRoute, async (c) => {
  const userId = c.get('userId')
  const body = await c
    .req.json<{ goodsCode?: string; code?: string; platform?: string }>()
    .catch(() => ({}) as { goodsCode?: string; code?: string; platform?: string })
  const goodsCode = typeof body.goodsCode === 'string' ? body.goodsCode : ''
  if (!goodsCode) return c.json({ ok: false, error: '缺少 goodsCode' }, 400)
  /**
   * ⚠️⚠️ **platform 必传，且不能猜** ✗（⭐ 2026-10-09 实测踩到 ✓）
   *
   *    ⭐ 官方 SDK：⭐「platform 与应用 id 有关，⚠️ **默认值：android 安卓平台**」✓
   *    ⚠️ 而 iOS 走的是 **Apple 支付** ✗ ⇒ ⚠️ 端侧不传就等于按安卓建单 ✓
   *      ⇒ ⭐ **用户钱扣了、单却在另一个渠道 ⇒ 查不到、不到账** ✓✓
   *    ⚠️ 所以缺了就**明确报错** ✗ —— ⭐ 宁可下单失败，
   *      也不能让用户付了钱拿不到能量 ✓
   */
  const platform = typeof body.platform === 'string' ? body.platform.trim() : ''
  if (!platform) {
    return c.json({ ok: false, error: '缺少 platform（端侧要按真实设备传：android / ios / windows）' }, 400)
  }

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
    const order = await createOrder({
      userId,
      goodsCode,
      sessionKey: sessionKey || 'mock',
      platform,
    })
    return c.json({
      ok: true,
      data: {
        outTradeNo: order.outTradeNo,
        amountFen: order.amountFen,
        points: order.goods.amount,
        mockPaid: order.mockPaid,
        payData: order.payData,
      },
    }, 200)
  } catch (err) {
    /** ⚠️ 可预期失败（商品下架 / 没配道具 / 签名缺配置）回 400 + 人话，不要 500 */
    const message = err instanceof OrderError ? err.message : (err as Error).message
    console.warn('[shop] 下单失败：' + message)
    return c.json({ ok: false, error: message }, 400)
  }
})

/* ------------------------------------------------------------------ */
/* ⭐ 主动查单 —— 推送丢了也能自己发货                                    */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ **主动查单**（`POST /api/user/shop/orders/{outTradeNo}/check`）
 *
 * ⚠️ 为什么要有这条（⭐ 用户 2026-10-09 报的"支付了一笔，毫无反应"✓）：
 *    发货原本只等【微信推送】✗ —— 而**本机根本收不到推送** ✓
 *    （⭐ 推送地址填的是云托管域名 ✓ 只有一个 ✓），线上也会丢 ✓
 *    ⇒ ⚠️ 订单永远停在 pending ⇒ ⭐ **能量不到账** ✓
 *    ⇒ ⭐ 官方 §2.1 也要求：「【发货推送分支】与【发货轮询分支】**
 *      **至少实现一个**」✓
 *
 * ⭐ 端侧在"等货到账"的那几秒里调它 ✓ ⇒ ⭐ 服务端替我们去微信问一趟 ✓
 *    ⇒ ⭐ 付了就自己发货 ✓✓
 *
 * ⚠️ 幂等安全：⭐ 它内部走 `deliverOrder`（⭐ 行锁 + 幂等 ✓），
 *    和推送那条路**并发到达也只会发一次货** ✓
 * ⚠️ 不返回"没付"这种错误 ✗ —— ⚠️ 用户刚拉起支付、微信还没落账是正常的 ✓
 *    ⇒ ⭐ 一律 200 + `delivered: false` ✓ 由端侧继续轮询 ✓
 */
const shopCheckOrderRoute = createRoute({
  method: 'post',
  path: '/orders/{outTradeNo}/check',
  tags: ['我的'],
  summary: '主动查单：向微信问这单付了没，付了就发货',
  security: [{ userToken: [] }],
  request: { params: z.object({ outTradeNo: z.string() }) },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.boolean(),
            data: z.object({ delivered: z.boolean(), amount: z.number().int() }),
          }),
        },
      },
      description: '成功（⭐ delivered=false 表示还没到账，继续等 ✓）',
    },
  },
})
shopRoutes.openapi(shopCheckOrderRoute, async (c) => {
  const userId = c.get('userId')
  const { outTradeNo } = c.req.valid('param')
  /**
   * ⚠️ 必须先确认这一单**属于这个人** ✗ ——
   *    否则随便编一个单号就能查别人付没付款 ✓（⭐ 虽然不会发货，但那也是信息泄露 ✓）
   * ⚠️ 单号不存在和"不是我的"**同一种返回** ✓（⭐ 分开处理等于告诉对方"这单存在"✓）
   */
  const own = await findOrderOwner(outTradeNo)
  if (own !== userId) return c.json({ ok: true, data: { delivered: false, amount: 0 } }, 200)

  try {
    const res = await syncOrderFromWx(outTradeNo)
    if (!res.ok) return c.json({ ok: true, data: { delivered: false, amount: 0 } }, 200)
    return c.json({ ok: true, data: { delivered: res.delivered, amount: res.amount } }, 200)
  } catch (err) {
    /** ⚠️ 查不动（⭐ 网络 / 没配 AppKey ✓）不能让端侧以为失败了 ✗ ⇒ 照旧 200 ✓ */
    console.warn('[shop] 查单失败：' + (err as Error).message)
    return c.json({ ok: true, data: { delivered: false, amount: 0 } }, 200)
  }
})
