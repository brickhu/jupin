import { addDays } from '@jushuo/shared'
import type { StreakRecordResponse } from '@jushuo/shared'

import { fetchStreakRecord, makeUpStreak } from '../../../lib/api/client'
import { refreshMe } from '../../../lib/join'
import { getState } from '../../../lib/store'
import { NO_MAKEUP, makeupViewOf } from '../../../lib/makeup-view'
import { navPadTop, notifyNavScroll } from '../../../lib/nav'

/**
 * ⭐ 「连战记录」—— 一个月一张日历（哪天读了）+ **断档时的补签入口**。
 *
 * ⚠️⚠️ 这一页**不落任何表**：连战日从 submissions 现算（见 services/streak-record.ts）。
 *    所以它永远和真实的挑战记录一致 —— 存一份"日历"就是第二份真相，迟早对不上。
 *
 * ⚠️ 「能不能补签」也**不算在端侧**：缺口要看 lastReadDate，而那个字段不下发
 *    （发了就等于把"今天算哪天"交回给一台时钟可以被随便改的手机）。
 *    服务端算好用 `makeup` 随连战视图下发（见 services/streak.ts 的 streakView）。
 *
 * ⚠️ 日历排版要的「首日 / 天数 / 首日是周几」**全部来自服务端**：
 *    端侧拿 'YYYY-MM-01' 去 new Date() 会按 UTC 解析，星期几可能差一天 ——
 *    而那种错在界面上只表现为"整月的格子整体错位"，肉眼很难发现。
 */

/** 日历里的一格。空白格（每月开头对齐用）的 day 是空串 */
interface Cell {
  key: string
  day: string
  /** ''=普通日（含对齐用的空格）；'read'=那天读了 */
  kind: '' | 'read'
  isToday: boolean
}

/** 月份加减 —— 全部走 shared 的 addDays，不在端侧碰 Date 的时区 */
function shiftMonth(month: string, delta: number): string {
  const first = month + '-01'
  // ⚠️ +32 天必定落到下个月（任何月份都是 28–31 天）；-1 天则是上个月的最后一天
  return delta > 0 ? addDays(first, 32).slice(0, 7) : addDays(first, -1).slice(0, 7)
}

function monthText(month: string): string {
  return month.slice(0, 4) + ' 年 ' + Number(month.slice(5, 7)) + ' 月'
}

function buildCells(data: StreakRecordResponse): Cell[] {
  const kindOf = new Map<string, 'read'>()
  for (const d of data.days) kindOf.set(d.date, d.kind)

  const cells: Cell[] = []
  // 开头补空格，让 1 号落在正确的星期几上
  for (let i = 0; i < data.weekdayOfFirst; i++) {
    cells.push({ key: 'pad' + i, day: '', kind: '', isToday: false })
  }
  for (let i = 0; i < data.daysInMonth; i++) {
    const date = addDays(data.firstDay, i)
    cells.push({
      key: date,
      day: String(i + 1),
      kind: kindOf.get(date) ?? '',
      isToday: date === data.today,
    })
  }
  return cells
}

Page({
  data: {
    navTop: 0,
    loading: true,
    error: '',

    month: '',
    monthText: '',
    /** 能不能往前 / 往后翻（往后不能超过今天所在的月 —— 未来没有记录可看） */
    canPrev: true,
    canNext: false,

    streakDays: 0,
    streakBest: 0,
    cells: [] as Cell[],

    /** ⭐ 补签区（判断全在 makeupViewOf 里做，WXML 只画） */
    makeupView: NO_MAKEUP,
    /** 正在补签（按钮转圈 + 防连点） */
    makingUp: false,

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

  /** ⚠️ month 不给 = 服务端的这个月（端侧不自己算"今天"，手机时钟可以随便改） */
  async load(month?: string) {
    this.setData({ error: '' })
    try {
      const data = await fetchStreakRecord(month)
      this.setData({
        loading: false,
        month: data.month,
        monthText: monthText(data.month),
        // ⚠️ 「下一月」的上限是**今天所在的月**：翻到未来只会看到一屏空格子
        canNext: data.month < data.today.slice(0, 7),
        streakDays: data.streakDays,
        streakBest: data.streakBest,
        cells: buildCells(data),
        /**
         * ⚠️ 能量取全局 store 那份（补签要显示"还差几点"）。
         *    store 会在 refreshMe 之后广播，所以补签完这里会拿到新余额。
         */
        makeupView: makeupViewOf(data.makeup, getState().userInfo?.energy ?? 0),
      })
    } catch (err) {
      // ⚠️ 失败时保留已经画出来的日历 —— 拉不到新的不该把看到的也清掉
      this.setData({ loading: false, error: (err as Error).message || '加载失败' })
    }
  },

  /**
   * ⭐⭐ 补签。
   *
   * ⚠️⚠️ 服务端补不成**也返回 200**（`ok:false` 是业务结果）⇒ 这里**不会抛**，
   *    要自己看 reason 说人话。四个原因见 makeupViewOf 的说明。
   *
   * ⚠️ 成功之后**必须把"今天还得读一句"说出来**：补签只是把缺口填上、
   *    **本身不加天数**。说「连战已恢复」是错的 —— 他今天不读，今天就是新缺口。
   */
  async onMakeUp() {
    if (this.data.makingUp || !this.data.makeupView.canPress) return
    this.setData({ makingUp: true })
    try {
      const r = await makeUpStreak()
      if (r.ok) {
        wx.showToast({ title: '补上了！今天读一句就接上', icon: 'none' })
        // ⚠️ 余额变了（扣了能量）⇒ 刷新全局那份，导航栏/用户面板一起跟上
        await refreshMe()
      } else {
        wx.showToast({ title: this.makeupFailText(r), icon: 'none' })
      }
      await this.load(this.data.month)
    } catch (err) {
      wx.showToast({ title: (err as Error).message || '补签失败', icon: 'none' })
    } finally {
      this.setData({ makingUp: false })
    }
  },

  /**
   * 补签失败时说的那一句。
   *
   * ⚠️⚠️ 四种原因**各说各的**，尤其 `too-long` **不能说成失败** ——
   *    断太久不是他的操作错了，是那段连战已经结束了。
   * ⚠️ `not-enough-energy` 要带上**还差几点**：只说"不够"，用户没法决定要不要去吃饼干。
   */
  makeupFailText(r: { reason?: string; shortfall?: number }): string {
    switch (r.reason) {
      case 'already-read-today':
        return '今天已经读过了 —— 补签要在读之前做'
      case 'no-gap':
        return '现在没有断档，不用补'
      case 'too-long':
        return '断太久了，接不上 —— 从今天重新开始吧'
      case 'not-enough-energy':
        return '能量还差 ' + (r.shortfall ?? 0) + ' 点 —— 吃饼干或者充值'
      default:
        return '现在补不了'
    }
  },

  onPrev() {
    void this.load(shiftMonth(this.data.month, -1))
  },

  onNext() {
    if (!this.data.canNext) return
    void this.load(shiftMonth(this.data.month, 1))
  },

  onRetry() {
    void this.load(this.data.month || undefined)
  },

})
