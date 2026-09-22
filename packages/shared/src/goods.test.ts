import { describe, expect, it } from 'vitest'

import {
  ENERGY_PACKS,
  ENERGY_PER_CHALLENGE,
  ENERGY_PURCHASE_MIN,
  GOODS_KIND,
  PAY_MIN_PRICE_FEN,
} from './constants'

/**
 * 商品档位的**不变量** —— 这些错在界面上都看不出来，只有到支付那一步才炸。
 */
describe('商品档位', () => {
  it('商品码唯一', () => {
    const codes = ENERGY_PACKS.map((g) => g.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('都是整数点、且每档都在售', () => {
    for (const g of ENERGY_PACKS) {
      expect(g.kind).toBe(GOODS_KIND.energy)
      expect(Number.isInteger(g.amount)).toBe(true)
      expect(g.amount).toBeGreaterThan(0)
      expect(g.priceFen).toBeGreaterThan(0)
    }
  })

  /**
   * ⚠️⚠️ 这条是**iOS 的硬约束**，不是审美：
   *    Apple 支付最低 1 元，而道具价格安卓/iOS 双端通用 —— 定低了 iOS 端直接支付失败。
   */
  it('每档价格都不低于 iOS 的最低支付金额（1 元）', () => {
    for (const g of ENERGY_PACKS) {
      expect(g.priceFen, g.code + ' 低于 iOS 最低支付金额，iOS 用户会支付失败').toBeGreaterThanOrEqual(
        PAY_MIN_PRICE_FEN,
      )
    }
  })

  /** 购买有起步单位（发放没有）—— 10 点这个数是「能量刻度」的一部分，不能随手改成 7 */
  it('每档点数都是购买起步单位的整数倍', () => {
    for (const g of ENERGY_PACKS) {
      expect(g.amount % ENERGY_PURCHASE_MIN, g.code).toBe(0)
    }
  })

  /**
   * ⭐ 阶梯定价的意义就在这一条：买得越多**单价越便宜**。
   *    排错了（比如 3000 点比 300 点还贵）会让大额档位彻底没人买。
   */
  it('单价随档位单调下降', () => {
    const sorted = [...ENERGY_PACKS].sort((a, b) => a.amount - b.amount)
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]
      const cur = sorted[i]
      if (!prev || !cur) continue
      expect(
        cur.priceFen / cur.amount,
        cur.code + ' 的单价没有比上一档（' + prev.code + '）更低',
      ).toBeLessThan(prev.priceFen / prev.amount)
    }
  })

  /**
   * ⚠️⚠️ 价格必须是**整元** —— 这不是审美，是微信侧的硬约束：
   *    「道具管理」的批量导入模板明写「道具价格：需为整数，不超过 10000 元」，
   *    而道具价格是安卓 / iOS 双端通用的**唯一**价格。
   *    我们这边写 ¥19.90、微信侧只能填 20 ⇒ 发货时对账报 -15013。
   */
  it('每档价格都是整元（微信侧道具只能填整数元）', () => {
    for (const g of ENERGY_PACKS) {
      expect(g.priceFen % 100, g.code + ' 不是整元，微信侧道具填不了').toBe(0)
    }
  })

  /**
   * ⭐ 角标里写的「省 N%」必须与真实折扣一致。
   *
   * ⚠️ 这条是真的抓到过问题：¥19.90/¥169.90 那套价下，中档写着「最划算」，
   *    而最大档的单价更低 —— 界面上两个角标互相打架，改价之后只会更假。
   *    所以角标一律用**算出来的折扣**，改价时这里会先红。
   */
  it('角标里的折扣与真实折扣一致', () => {
    const sorted = [...ENERGY_PACKS].sort((a, b) => a.amount - b.amount)
    const base = sorted[0]
    if (!base) throw new Error('没有档位')
    const baseUnit = base.priceFen / base.amount
    for (const g of sorted.slice(1)) {
      const m = /省\s*(\d+)%/.exec(g.badge ?? '')
      if (!m) continue
      const actual = Math.round((1 - g.priceFen / g.amount / baseUnit) * 100)
      expect(Number(m[1]), g.code + ' 的角标写着省 ' + m[1] + '%，实际是 ' + actual + '%').toBe(
        actual,
      )
    }
  })

  /** 商品文案里的「够读 N 句」是算出来的，算错了没人会发现 —— 钉死它 */
  it('副标题里的句数与点数一致（一次挑战 = 一句 = 2 点）', () => {
    for (const g of ENERGY_PACKS) {
      const m = /够读\s*(\d+)\s*句/.exec(g.subtitle)
      expect(m, g.code + ' 的副标题没有写「够读 N 句」').not.toBeNull()
      expect(Number(m?.[1]), g.code).toBe(g.amount / ENERGY_PER_CHALLENGE)
    }
  })
})
