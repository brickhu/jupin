import { formatScore } from '@jushuo/shared'
import type { ParticipationRecord } from '@jushuo/shared'

import { fetchParticipations } from '../../../lib/api/client'
import { navPadTop, notifyNavScroll } from '../../../lib/nav'
import { ROUTES, go } from '../../../lib/route'

/**
 * ⭐ 「参与场次」—— 我在哪些句子上参与过，最近参与的排前面。
 *
 * ⚠️⚠️ 一条 = **一句**（= 一个竞技场 = 一场），不是一次提交：
 *    同一句读十次也只有一张卡，「挑战几次 / 最高 / 最低」是卡里的数字。
 *    想看每一次的明细，去「我的挑战」—— 那一页才是提交粒度。
 *
 * ⚠️ 点卡片**直接进朗读页**（用户 2026-09 定）：这一页是"我读过哪些句子"的清单，
 *    点进去的自然动作是**再读一遍这一句**（卡片上的数字是"我在这一句上的战绩"）。
 *    ⚠️ 原来点的是竞技场（看那一场的榜单）—— 想看榜从那句的挑战页/朗读页都能到，
 *      而"再读一遍"在竞技场里还要多点一次。

/** 列表里一行（显示形态与接口字段分开：WXML 里没法算） */
interface Row {
  articleId: string
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

  /**
   * ⭐ 点一张卡 → **直接进朗读页**（用户 2026-09 定）。
   *
   * ⚠️⚠️ `date` 必须带**服务端给的** `lastScheduleDate`（我上一次挑战这一句算哪一天）——
   *    朗读页用它决定"这一次提交记到哪一天"：不带的话就是今天，
   *    而那会把昨天那张卡的数字改掉（见朗读页与 routes/arenas 的说明）。
   *    拿端侧的今天去凑是同一个错，所以这里一律用服务端字段。
   * ⚠️ 老记录可能没有 schedule_date（空串）⇒ 这时**照跳**，让它退回今天：
   *    为了"再读一遍"这件事，日期不准也比点不动强（原来那条"看不到榜单"的拦截
   *    是给竞技场用的 —— 竞技场按日期寻址，没日期就是空页面；朗读页不是）。
   * ⚠️ 朗读页是**受保护页**（要花能量、成绩要有归属）⇒ 走带守卫的 go，不是 goPublic。
   */
  onOpen(e: WechatMiniprogram.BaseEvent) {
    const i = Number((e.currentTarget.dataset as { i?: number }).i)
    const row = this.data.rows[i]
    if (!row) return

    const q = '?id=' + encodeURIComponent(row.articleId) +
      (row.scheduleDate ? '&date=' + encodeURIComponent(row.scheduleDate) : '')
    void go(ROUTES.reading.url + q)
  },
})
