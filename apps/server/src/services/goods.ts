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
 * ⭐ 道具 ID 的**格式校验**。
 *
 * ⚠️⚠️ 为什么需要它：`.env` 里把值留成占位符（比如三个点）是很自然的做法，
 *    而「有值」和「值是有效的道具 ID」是两件事 —— 只看有没有值的话，
 *    我们会带着一个垃圾 ID 去微信，报回来的是 -15010（道具未发布）或者 -15013（价格错），
 *    排查方向完全跑偏。宁可在这里判定「没配」，让前端显示「暂时买不了」。
 */
function looksLikeProductId(v: string | undefined): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(v)
}

/**
 * 商品码 → 微信道具 ID 的**环境变量**（见 env.ts）。
 *
 * ⚠️ 它是**配置**不是运营数据：改了 .env 重启就生效，不用手工改库。
 * ⚠️ **沙箱优先按 XPAY_ENV 选**：dev 走沙箱（env=1），prod 走现网（env=0）——
 *    由 deploy-cloud.mjs 结构性决定，不靠人记。
 */
function productIdFromEnv(code: string): string | undefined {
  const sandbox = env.XPAY_ENV === 1
  const table: Record<string, [string | undefined, string | undefined]> = {
    energy_10: [env.XPAY_PRODUCT_ENERGY_10, env.XPAY_PRODUCT_ENERGY_10_SANDBOX],
    energy_300: [env.XPAY_PRODUCT_ENERGY_300, env.XPAY_PRODUCT_ENERGY_300_SANDBOX],
    energy_3000: [env.XPAY_PRODUCT_ENERGY_3000, env.XPAY_PRODUCT_ENERGY_3000_SANDBOX],
  }
  const pair = table[code]
  if (!pair) return undefined
  const [prod, sandboxId] = pair
  /** ⚠️ 沙箱那一份没填就回退到现网的（道具 ID 两边相同时不用重复填） */
  const picked = sandbox ? (sandboxId || prod) : prod
  return looksLikeProductId(picked) ? picked : undefined
}

/**
 * ⭐ 当前环境下，三个商品各配没配**有效的**道具 ID。
 *
 * ⚠️ 它是给 /health 用的：光看「我填了 .env」不等于「服务真的读到了」，
 *    而这两件事的区别只有在用户点购买时才暴露。
 * ⚠️ 复用上面那套选择逻辑（含沙箱优先与格式守卫），别再实现一遍。
 */
export function productIdStatus(): Record<string, boolean> {
  return {
    energy_10: Boolean(productIdFromEnv('energy_10')),
    energy_300: Boolean(productIdFromEnv('energy_300')),
    energy_3000: Boolean(productIdFromEnv('energy_3000')),
  }
}

/**
 * ⭐ 把默认商品写进库（**幂等**）+ 每次启动**校正**配置字段 + 同步道具 ID。
 *
 * ⚠️ 为什么必须有个种子：商品表空 = 购买页一张卡片都没有 ——
 *    而那是**静默**的（没有报错，只是没人能买）。
 *
 * ⚠️⚠️ 配置字段（点数 / 价格 / 文案 / 角标 / 排序）**每次都按代码校正**，
 *    这与 reward_rules 的「只在缺的时候插」**故意不同** —— 因为它们的约束不一样：
 *
 *    · reward_rules 的阈值是**我们自己的**业务参数：运营改了就是改了，不该被启动抹掉
 *    · goods 的价格必须与**微信侧道具价格**三方一致（我们库里 / 微信侧 / 用户看到的），
 *      而用户在支付页看到的是微信侧那个价 —— 一旦两边不一致，
 *      微信会拿 signData 里的 goodsPrice 去比，直接报 **-15013（道具价格错误）**
 *
 *    ⇒ 只改库里的价是**结构性坏掉**的（改完反而付不了款），所以它必须以代码为准。
 *      改价的正规路径是：改 ENERGY_PACKS → 重新生成导入文件 → 微信侧重新导入 → 部署。
 *
 * ⚠️ 两样东西**不校正**：
 *    · `enabled`（运营可以临时下架一个档位，不该被启动重新上架）
 *    · `xpay_product_id`（它来自环境变量，见下面的分支）
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
    await db
      .update(goods)
      .set({
        kind: g.kind,
        amount: g.amount,
        priceFen: g.priceFen,
        title: g.title,
        subtitle: g.subtitle,
        badge: g.badge ?? null,
        sort: g.sort,
      })
      .where(eq(goods.code, g.code))

    /** 道具 ID 是配置：环境变量里有就同步（开通虚拟支付后只填 .env 即可） */
    const productId = productIdFromEnv(g.code)
    if (productId) {
      await db.update(goods).set({ xpayProductId: productId }).where(eq(goods.code, g.code))
    }
  }
}

/**
 * ⭐ 当前**库里**的商品价格（分）—— 给 /health 用。
 *
 * ⚠️ 为什么值得暴露：价格有三个副本（我们库里 / 微信侧道具 / 用户看到的），
 *    而不一致的表现是支付时报 -15013 —— 到那时再回头查，
 *    会先怀疑签名、怀疑 AppKey，不会想到「库里还留着上一次的价格」。
 *    ⚠️ 读库失败返回 null（/health 不该因为一次查询就 500）。
 */
export async function goodsPriceMap(): Promise<Record<string, number> | null> {
  try {
    const rows = await db.select({ code: goods.code, priceFen: goods.priceFen }).from(goods)
    return Object.fromEntries(rows.map((r) => [r.code, r.priceFen]))
  } catch {
    return null
  }
}
