import { formatScore } from '@jushuo/shared'
import type { ParticipationRecord } from '@jushuo/shared'

import { fetchParticipations } from '../../../lib/api/client'
import { navPadTop, notifyNavScroll } from '../../../lib/nav'

/**
 * ⭐ 「参与场次」—— 我在哪些句子上参与过，最近参与的排前面。
 *
 * ⚠️⚠️ 一条 = **一句**（= 一个竞技场 = 一场），不是一次提交：
 *    同一句读十次也只有一张卡，「挑战几次 / 最高 / 最低」是卡里的数字。
 *    想看每一次的明细，去「我的挑战」—— 那一页才是提交粒度。
 *
 * ⚠️ 点卡片进的是**竞技场**（那一场的完整榜单），不是结果页：
 *    这张卡讲的是「我在这场里的位置」，落点自然就是那一场。
 */

/** 列表里一行（显示形态与接口字段分开：WXML 里没法算） */
interface Row {
  articleId: number
  text: string
  /** '5 次' */
  attemptsText: string
  /** '88.0' / '64.0' */
  bestText: string
  worstText: string
  /** '9 / 32' —— 名次带参与人数：只写「第 9」在 9 人的场和 900 人的场是两件事 */
  rankText: string
  /** 那一场是哪一天 —— 点卡片跳竞技场要用（空串 = 不给跳） */
  scheduleDate: string
}

function toRow(r: ParticipationRecord): Row {
  return {
    articleId: r.articleId,
    text: r.text,
    attemptsText: r.attempts + ' 次',
    bestText: formatScore(r.bestScore),
    worstText: formatScore(r.worstScore),
    rankText: r.rank + ' / ' + r.participantCount,
    scheduleDate: r.lastScheduleDate ?? '',
  }
}

Page({
  data: {
    navTop: 0,
    loading: true,
    error: '',
    rows: [] as Row[],
    empty: false,
  },

  onLoad() {
    this.setData({ navTop: navPadTop() })
    void this.load()
  },

  /** ⚠️ 每次回到这一页都重拉：刚挑战完返回时，这一句的卡片必须是新的 */
  onShow() {
    if (!this.data.loading) void this.load()
  },

  onPullDownRefresh() {
    void this.load().finally(() => wx.stopPullDownRefresh())
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    notifyNavScroll(this, e.scrollTop)
  },

  async load() {
    this.setData({ error: '' })
    try {
      const res = await fetchParticipations()
      const rows = res.items.map(toRow)
      this.setData({ loading: false, rows, empty: rows.length === 0 })
    } catch (err) {
      // ⚠️ 失败时保留已有列表 —— 拉不到新的不该把已经看到的内容也清掉
      this.setData({ loading: false, error: (err as Error).message || '加载失败' })
    }
  },

  onRetry() {
    void this.load()
  },

  /** 点一张卡 → **竞技场**（那一场，不是今天那一场） */
  onOpen(e: WechatMiniprogram.BaseEvent) {
    const i = Number((e.currentTarget.dataset as { i?: number }).i)
    const row = this.data.rows[i]
    if (!row) return

    /**
     * ⚠️ 日期必须来自**服务端**（那次提交属于哪一天）。
     *    拿端侧的今天去凑，用户看到的是另一场的榜单 —— 而那一场里可能根本没有他。
     * ⚠️ 老成绩没有 schedule_date → 空串，这时明说一句，别跳到一个空页面。
     */
    if (!row.scheduleDate) {
      wx.showToast({ title: '这一场太久远了，看不到榜单', icon: 'none', duration: 2000 })
      return
    }
    const url = '/pages/arena/arena?date=' + encodeURIComponent(row.scheduleDate)
    wx.navigateTo({ url, fail: () => wx.reLaunch({ url }) })
  },
})
