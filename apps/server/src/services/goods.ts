import { asc, eq } from 'drizzle-orm'
import { ENERGY_PACKS, type GoodsItem, type GoodsKind } from '@jushuo/shared'

import { db, type Executor } from '../db'
import { goods } from '../db/schema'
import { env } from '../env'

/**
 * ⭐ 商品目录。
 *
 * ⚠️⚠️ 运行时**以库为准**，shared 里的 ENERGY_PACKS 只是**首次启动的种子**：
 *    价格要能改而不发版（小程序审核 1–3 天，把价格绑在发版上，促销/调价就废了）。
 *    与 reward_rules 同一套模式（种子 + 只在缺的时候插）。
 *
 * ⚠️ 下单时**必须快照**到 payments（见 services/order.ts）：
 *    商品以后改价改名，历史订单必须还是当时那个商品。
 */

export interface ShopItem extends GoodsItem {
  /** 微信侧「道具管理」里的道具 ID；开通虚拟支付前是 null（那时不能真下单） */
  xpayProductId: string | null
  enabled: boolean
}

type GoodsRow = typeof goods.$inferSelect

function toItem(row: GoodsRow): ShopItem {
  return {
    code: row.code,
    // ⚠️ 库里是 varchar，类型收窄在这里做一次；非法值当成 energy（不会静默丢商品）
    kind: (row.kind === 'unfreeze' ? 'unfreeze' : 'energy') as GoodsKind,
    amount: row.amount,
    priceFen: row.priceFen,
    title: row.title,
    subtitle: row.subtitle,
    badge: row.badge ?? undefined,
    sort: row.sort,
    xpayProductId: row.xpayProductId,
    enabled: row.enabled,
  }
}

/**
 * 在售商品（按 sort 升序）—— me/energy 页的充值卡片就是它。
 * ⚠️ 只返回 enabled 的：下架的商品不该出现在购买页，但**历史订单照样能查**（见 findGoods）。
 */
export async function listGoods(ex: Executor = db): Promise<ShopItem[]> {
  const rows = await ex
    .select()
    .from(goods)
    .where(eq(goods.enabled, true))
    .orderBy(asc(goods.sort), asc(goods.amount))
  return rows.map(toItem)
}

/**
 * 按商品码取（下单 / 对账用）。
 * ⚠️ **刻意不过滤 enabled**：一个商品下架之后，它已经产生的订单还要能查到它、算得清该发多少。
 */
export async function findGoods(code: string, ex: Executor = db): Promise<ShopItem | null> {
  const [row] = await ex.select().from(goods).where(eq(goods.code, code)).limit(1)
  return row ? toItem(row) : null
}

/**
 * ⭐ 能不能卖：在售 + 已配道具 ID。
 *
 * ⚠️ 没有道具 ID 就**不能**放出去下单 —— 那不是「下单后失败」，
 *    而是会在微信侧报一个我们看不懂的错（道具不存在）。宁可在自己这边先拦住，
 *    并把「还没配道具」这件事明确告诉用户/我们自己。
 */
export function sellableIssue(item: ShopItem): string | null {
  if (!item.enabled) return '商品已下架'
  if (!item.xpayProductId) return '商品还没配置微信侧道具 ID（等虚拟支付开通后填 XPAY_PRODUCT_*）'
  return null
}

/**
 * 商品码 → 微信道具 ID 的**环境变量**（见 env.ts）。
 * ⚠️ 它是**配置**不是运营数据：改了 .env 重启就生效，不用手工改库。
 */
function productIdFromEnv(code: string): string | undefined {
  if (code === 'energy_10') return env.XPAY_PRODUCT_ENERGY_10
  if (code === 'energy_300') return env.XPAY_PRODUCT_ENERGY_300
  if (code === 'energy_3000') return env.XPAY_PRODUCT_ENERGY_3000
  return undefined
}

/**
 * ⭐ 把默认商品写进库（**幂等**，只在缺的时候插）+ 同步道具 ID。
 *
 * ⚠️ 为什么必须有个种子：商品表空 = 购买页一张卡片都没有 ——
 *    而那是**静默**的（没有报错，只是没人能买）。
 * ⚠️ 只在**缺**的时候插：运营改过的价格/文案不会被启动覆盖（同 reward_rules）。
 * ⚠️ 道具 ID 例外：它是配置，有值就同步（开通虚拟支付后只填 .env 即可）。
 */
export async function ensureDefaultGoods(): Promise<void> {
  await db
    .insert(goods)
    .ignore()
    .values(
      ENERGY_PACKS.map((g) => ({
        code: g.code,
        kind: g.kind,
        amount: g.amount,
        priceFen: g.priceFen,
        title: g.title,
        subtitle: g.subtitle,
        badge: g.badge ?? null,
        sort: g.sort,
      })),
    )

  for (const g of ENERGY_PACKS) {
    const productId = productIdFromEnv(g.code)
    if (!productId) continue
    await db.update(goods).set({ xpayProductId: productId }).where(eq(goods.code, g.code))
  }
}
