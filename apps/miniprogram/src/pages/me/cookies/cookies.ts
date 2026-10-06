import { COOKIES_PER_ENERGY } from '@jushuo/shared'
import type { CookieLedgerItem } from '@jushuo/shared'

import { fetchCookies } from '../../../lib/api/client'
import { navPadTop, notifyNavScroll } from '../../../lib/nav'
import { agoText } from '../../../lib/time'

/**
 * ⭐ 「我的饼干」—— **余额卡 + 流水**。
 *
 * ## 为什么这一页存在
 *
 * 🍪 是**全站唯一的累计值**（三维成长值 2026-10 整体废除，见 prd §7.6）。
 * 用户要能回答两个问题，这一页就是答案：
 *   · 「我一共攒了多少」→ 余额卡（**两个位置**：可用 + 累计获得）
 *   · 「这些是哪来的」  → 流水
 *
 * ⚠️⚠️ **两个数缺一不可**：只给"可用"的话，换过一次能量就会看起来像**退步**
 *    （损失厌恶）；而「累计获得」是那条**只增**的进步线 —— 它才是"我在变好"的证据。
 *
 * ## 口径
 *
 * ⚠️ 这一页**不自己算余额**：全部来自服务端（`GET /api/user/cookies`）——
 *    本地维护一份必然漂移，而"余额对不上"是最难查的一类问题。
 * ⚠️ 换完能量之后回到这一页要看到新数：`onShow` 会重新拉一次（见那里的说明）。
 */

/**
 * reason → 文案。
 *
 * ⚠️ 只映射**固定的几个**；认不出来的一律叫「奖励」——
 *    加一种 reason 不该逼着端侧发版（与能量页那条规矩一样）。
 */
const REASON_TEXT: Record<string, string> = {
  conquer: '攻克句子',
  exchange: '换能量',
  admin: '运营调整',
}

interface LedgerRow {
  id: number
  label: string
  deltaText: string
  timeText: string
  /** 入账（绿）还是出账（灰）—— 颜色由它决定，不由 delta 正负现算 */
  income: boolean
}

function toRow(item: CookieLedgerItem): LedgerRow {
  const income = item.delta > 0
  return {
    id: item.id,
    label: REASON_TEXT[item.reason] ?? '奖励',
    // ⚠️ 出账用**减号**（−，U+2212）而不是连字符：它和数字同宽，右对齐时才不歪
    deltaText: (income ? '+' : '−') + Math.abs(item.delta),
    timeText: agoText(item.createdAt),
    income,
  }
}

Page({
  data: {
    navTop: 0,
    loading: true,
    error: '',

    /** 可用（可花）—— 卡上那个大数字 */
    balance: 0,
    /** 累计获得（只增）—— 卡上那行小字。⚠️ 它永远不会变小 */
    total: 0,
    /** 40 块换 1 点 —— 从 shared 拿，端侧不写死 */
    cookiesPerEnergy: COOKIES_PER_ENERGY,

    rows: [] as LedgerRow[],
    /** 还有没有更早的流水 */
    hasMore: false,
    loadingMore: false,
  },

  onLoad() {
    this.setData({ navTop: navPadTop() })
    void this.load()
  },

  /**
   * ⚠️ `onShow` 要重新拉一次：用户可能是去能量页换完能量**再返回**这一页的，
   *    而那时余额已经变了。不重拉的话他会看到换之前的数字，
   *    而"余额对不上"比"慢一点"糟糕得多。
   * ⚠️ `onLoad` 已经拉过一次，这里再拉是**有意的重复**（第二次通常命中网络缓存）。
   */
  onShow() {
    if (!this.data.loading) void this.load()
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    notifyNavScroll(this, e.scrollTop)
  },

  onPullDownRefresh() {
    void this.load().finally(() => wx.stopPullDownRefresh())
  },

  /** 余额 + 第一页流水。品牌页面的「一次拉完」——不要拆成两个先后到达的空白 */
  async load() {
    this.setData({ error: '' })
    try {
      const res = await fetchCookies()
      this.setData({
        loading: false,
        balance: res.cookies.balance,
        total: res.cookies.total,
        rows: res.items.map(toRow),
        hasMore: res.nextBefore !== null,
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
      const res = await fetchCookies(last.id)
      this.setData({
        rows: this.data.rows.concat(res.items.map(toRow)),
        hasMore: res.nextBefore !== null,
        loadingMore: false,
      })
    } catch (err) {
      this.setData({ loadingMore: false })
      wx.showToast({ title: (err as Error).message || '加载失败', icon: 'none' })
    }
  },

  onRetry() {
    void this.load()
  },

  /**
   * ⭐ 去能量页 —— 「吃饼干补充能量」那句隐喻的落脚点。
   * ⚠️ 只在**够换 1 点**时才给这个入口：不够就是白跑一趟。
   */
  onOpenEnergy() {
    void wx.navigateTo({ url: '/pages/me/energy/energy' })
  },
})
