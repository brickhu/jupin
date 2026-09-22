import type { EnergyLedgerItem, ShopGoodsItem } from '@jushuo/shared'
import { explainXpayError } from '@jushuo/shared'

import { createShopOrder, fetchEnergy, fetchShopGoods } from '../../../lib/api/client'
import { refreshMe } from '../../../lib/join'
import { navPadTop, notifyNavScroll } from '../../../lib/nav'
import { agoText } from '../../../lib/time'

/**
 * ⭐ 「能量」—— 余额 + 充值 + 流水。
 *
 * ⚠️⚠️ 三条不变量（都来自 docs/design/payment-and-purchase.md）：
 *
 * 1. **价格只从服务端拿**，端侧一份都不写死 —— 小程序审核 1–3 天，
 *    价格绑在发版上就等于不能调价。
 * 2. **发货不认这里的 success 回调**：支付成功后余额是靠**平台推送**到账的，
 *    端侧只负责「提示 + 刷新」。所以这里要**等一会儿**再看余额，而不是直接 +N。
 * 3. **文案由 reason 映射**（服务端只给原文）—— 加一个 reason 不用改接口。
 */

/**
 * reason → 文案。
 * ⚠️ 只映射**固定的几个**；奖励规则的 code 不在这里硬编码（那会随规则表变），
 *    统一落到「奖励」—— 用户关心的是「多了点数」，不是哪条规则发的。
 */
const REASON_TEXT: Record<string, string> = {
  purchase: '充值',
  daily_topup: '每日补足',
  challenge_hold: '挑战消耗',
  challenge_release: '挑战失败退回',
  admin: '运营调整',
}

/** 一位小数都不留的角标数：价格统一用「元」显示，整数元就不带小数点 */
function yuanText(fen: number): string {
  const yuan = fen / 100
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2)
}

/**
 * ⭐ 商品码 → 道具图（**打包在小程序里**的静态资源）。
 *
 * ⚠️ 为什么图片可以写死在端侧、而价格不行：
 *    图片是随版本发布的资源，改它本来就要发版；
 *    价格是运营要随时能调的东西（见 docs/design/payment-and-purchase.md §2.4）。
 * ⚠️ 认不出来的商品码**不给图**（留空即可），绝不让它把整张卡片搞坏 ——
 *    以后加一档商品时，服务端先上、端侧图后补，中间这段时间是能用的。
 */
const GOODS_IMAGE: Record<string, string> = {
  energy_10: '/assets/energy/e10.png',
  energy_300: '/assets/energy/e300.png',
  energy_3000: '/assets/energy/e3000.png',
}

/** 单价（元 / 点）—— 阶梯定价的说服力全在这个数上，所以固定三位小数 */
function unitText(item: ShopGoodsItem): string {
  return '¥' + (item.priceFen / item.amount / 100).toFixed(3) + ' / 点'
}

interface LedgerRow {
  id: number
  label: string
  deltaText: string
  timeText: string
  /** 入账（绿）还是出账（灰）—— 颜色由它决定，不由 delta 正负现算 */
  income: boolean
}

function toRow(item: EnergyLedgerItem): LedgerRow {
  const income = item.delta > 0
  return {
    id: item.id,
    /** ⚠️ 认不出来的一律叫「奖励」：奖励规则的 code 会变，不该硬编码在端侧 */
    label: REASON_TEXT[item.reason] ?? '奖励',
    deltaText: (income ? '+' : '−') + Math.abs(item.delta),
    timeText: agoText(item.createdAt),
    income,
  }
}

/** 支付成功后等余额「涨上来」—— 最多试 3 次。⚠️ 推送可能有几秒延迟，不是失败 */
async function waitArrival(prevEnergy: number): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    try {
      const res = await fetchEnergy()
      if (res.energy > prevEnergy) return true
    } catch {
      /* 拉不到就再试一次；真的拉不到由调用方兜底提示 */
    }
  }
  return false
}

Page({
  data: {
    navTop: 0,
    loading: true,
    error: '',

    energy: 0,
    perChallenge: 2,
    dailyFloor: 3,

    goods: [] as (ShopGoodsItem & { priceText: string; unitText: string; image: string })[],
    /** 0 现网 / 1 沙箱 —— 沙箱时页面上要标出来，免得测试时以为花的是真钱 */
    payEnv: 0,

    rows: [] as LedgerRow[],
    /** 还有没有更早的流水 */
    hasMore: false,
    loadingMore: false,

    paying: false,
    /** 正在买的商品码 —— 只让那一张卡片转圈 */
    payingCode: '',
  },

  onLoad() {
    this.setData({ navTop: navPadTop() })
    void this.load()
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    notifyNavScroll(this, e.scrollTop)
  },

  onPullDownRefresh() {
    void this.load().finally(() => wx.stopPullDownRefresh())
  },

  /** 商品 + 余额 + 第一页流水。品牌页面的「一次拉完」——不要拆成三个先后到达的空白 */
  async load() {
    this.setData({ error: '' })
    try {
      const [energy, shop] = await Promise.all([fetchEnergy(), fetchShopGoods()])
      this.setData({
        loading: false,
        energy: energy.energy,
        perChallenge: energy.perChallenge,
        dailyFloor: energy.dailyFloor,
        rows: energy.items.map(toRow),
        hasMore: energy.nextBefore !== null,
        goods: shop.items.map((g) => ({
          ...g,
          priceText: '¥' + yuanText(g.priceFen),
          unitText: unitText(g),
          image: GOODS_IMAGE[g.code] ?? '',
        })),
        payEnv: shop.payEnv,
      })
    } catch (err) {
      // ⚠️ 失败时保留已经画出来的内容 —— 拉不到新的不该把看到的也清掉
      this.setData({ loading: false, error: (err as Error).message || '加载失败' })
    }
  },

  /** 翻更早的流水（游标：拿最后一条的 id 当 before） */
  async onMore() {
    if (this.data.loadingMore || !this.data.hasMore) return
    const last = this.data.rows[this.data.rows.length - 1]
    if (!last) return
    this.setData({ loadingMore: true })
    try {
      const res = await fetchEnergy(last.id)
      this.setData({
        rows: this.data.rows.concat(res.items.map(toRow)),
        hasMore: res.nextBefore !== null,
      })
    } catch (err) {
      wx.showToast({ title: (err as Error).message || '加载失败', icon: 'none' })
    } finally {
      this.setData({ loadingMore: false })
    }
  },

  /**
   * ⭐ 充值：下单 → 拉起虚拟支付 → 刷新。
   *
   * ⚠️ 支付成功后**不能直接给余额加 N** —— 到账是平台推送驱动的，
   *    端侧只是「等它到账，然后显示」。直接加会造出第二份真相：
   *    推送失败时用户以为到账了，刷新一下就没了。
   */
  async onBuy(e: WechatMiniprogram.BaseEvent) {
    const code = (e.currentTarget.dataset as { code?: string }).code
    if (!code || this.data.paying) return
    const item = this.data.goods.find((g) => g.code === code)
    if (!item) return
    if (!item.sellable) {
      wx.showToast({ title: '这个档位暂时买不了', icon: 'none' })
      return
    }

    this.setData({ paying: true, payingCode: code })
    const before = this.data.energy
    try {
      const order = await createShopOrder(code)

      /** mock 通道（本地）：服务端已经替我们把货发了，不用拉起支付 */
      if (!order.mockPaid) {
        await new Promise<void>((resolve, reject) => {
          /**
           * ⚠️⚠️ 必须**原样传服务端签好的 signData 字符串**，而且要绕过 typings：
           *
           *    基础库的 d.ts 把 signData 标成了对象（SignData 接口），
           *    但官方文档写得很清楚「该参数需以 **string** 形式传递」。
           *
           *    ⚠️ 千万别为了迁就类型去 JSON.parse 成对象 —— 那等于让平台**重新序列化**一次，
           *       键顺序或空格一变，签名就对不上，报 -15006（支付签名错），
           *       而排查方向会先去怀疑算法和 AppKey。
           *       服务端签的就是这个字符串，必须逐字节一致。
           */
          const payOption = order.payData as unknown as WechatMiniprogram.RequestVirtualPaymentOption
          wx.requestVirtualPayment({
            ...payOption,
            success: () => resolve(),
            fail: (err) =>
              reject(new Error(explainXpayError((err as { errCode?: number }).errCode, err.errMsg))),
          })
        })
      }

      const arrived = await waitArrival(before)
      await this.load()
      void refreshMe()
      if (!arrived) {
        /** ⚠️ 支付成功但余额还没动：说清是「到账延迟」，而不是「失败」 */
        wx.showToast({ title: '支付成功，到账可能要几秒 —— 下拉刷新看看', icon: 'none', duration: 2600 })
      } else {
        wx.showToast({ title: '已到账 +' + order.points + ' 点', icon: 'none' })
      }
    } catch (err) {
      wx.showToast({ title: (err as Error).message || '支付失败', icon: 'none', duration: 2600 })
    } finally {
      this.setData({ paying: false, payingCode: '' })
    }
  },

  onRetry() {
    void this.load()
  },
})
