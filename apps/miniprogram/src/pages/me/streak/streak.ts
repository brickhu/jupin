import { addDays } from '@jushuo/shared'
import type { StreakRecordResponse } from '@jushuo/shared'

import { claimRewards, fetchStreakRecord } from '../../../lib/api/client'
import { refreshMe } from '../../../lib/join'
import { navPadTop, notifyNavScroll } from '../../../lib/nav'

/**
 * ⭐ 「连战记录」—— 一个月一张日历：哪天读了（连战）、哪天的缺口是解冻卡补的。
 *
 * ⚠️⚠️ 这一页**不落任何表**：连战日从 submissions 现算、解冻日从卡的 used_at 反推
 *    （见 services/streak-record.ts）。所以它永远和真实的挑战记录一致 ——
 *    存一份"日历"就是第二份真相，迟早对不上。
 *
 * ⚠️ 日历排版要的「首日 / 天数 / 首日是周几」**全部来自服务端**：
 *    端侧拿 'YYYY-MM-01' 去 new Date() 会按 UTC 解析，星期几可能差一天 ——
 *    而那种错在界面上只表现为"整月的格子整体错位"，肉眼很难发现。
 */

/** 日历里的一格。空白格（每月开头对齐用）的 day 是空串 */
interface Cell {
  key: string
  day: string
  /** ''=普通日；'read'=那天读了；'unfreeze'=那天的缺口是解冻卡补的 */
  kind: '' | 'read' | 'unfreeze'
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
  const kindOf = new Map<string, 'read' | 'unfreeze'>()
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

    unfreezeCards: 0,
    unfreezePending: 0,
    unfreezeExpiresOn: '' as string,
    claiming: false,
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
        unfreezeCards: data.unfreezeCards,
        unfreezePending: data.unfreezePending,
        unfreezeExpiresOn: data.unfreezeExpiresOn ?? '',
      })
    } catch (err) {
      // ⚠️ 失败时保留已经画出来的日历 —— 拉不到新的不该把看到的也清掉
      this.setData({ loading: false, error: (err as Error).message || '加载失败' })
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

  /**
   * ⭐ 领取待领取的解冻卡。
   *
   * ⚠️ 领完之后要**同时**刷新两处：本页的卡数、以及全局 store 里的那份
   *    （导航栏/用户面板/首页都读它）—— 只刷一处会出现"这页说 2 张、面板说 0 张"。
   */
  async onClaim() {
    if (this.data.claiming || this.data.unfreezePending <= 0) return
    this.setData({ claiming: true })
    try {
      const res = await claimRewards()
      await refreshMe()
      wx.showToast({ title: '领到 ' + res.claimed + ' 张解冻卡', icon: 'none' })
      await this.load(this.data.month)
    } catch (err) {
      wx.showToast({ title: (err as Error).message || '领取失败', icon: 'none' })
    } finally {
      this.setData({ claiming: false })
    }
  },
})
