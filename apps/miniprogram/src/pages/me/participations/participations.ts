import { formatScore } from '@jushuo/shared'
import type { ParticipationRecord } from '@jushuo/shared'

import { fetchParticipations } from '../../../lib/api/client'
import { navPadTop, notifyNavScroll } from '../../../lib/nav'
import { ROUTES, go } from '../../../lib/route'
import * as me from '../../../lib/store'

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
}

function toRow(r: ParticipationRecord): Row {
  return {
    articleId: r.articleId,
    /**
     * ⚠️⚠️ **原文由端侧从词表快照拼出来**（2026-09 改）：
     *    接口不再给 `text` 列 —— `words[].text` 含标点，用空格拼起来就是原句（只归一空白）。
     *    这样服务端只存一份（词表），历史仍然自足。
     * ⚠️ 例外：`text` 字段**存在时优先用它** —— 那是快照为空（内容缺口）时的兜底原文，
     *    此时 words 是空数组、拼出来会是空串。
     */
    text: r.text ?? r.words.map((w) => w.text).join(' '),
    attemptsText: r.attempts + ' 次',
    bestText: formatScore(r.bestScore),
    worstText: formatScore(r.worstScore),
    rankText: r.rank + ' / ' + r.participantCount,
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
      /**
       * ⭐⭐ **顺手把这一批参与记录回填进全局 store** —— 这一页拿到的 `items`
       *    本身就是 `ParticipationRecord`（与 `/api/user/participation/{id}` 同形），
       *    所以它是"所有句子列表都进 store"这条口径里**唯一不需要再逐句请求**的一页：
       *    一份数据，两处用（本页渲染 + 全站参与状态），不重复打接口。
       */
      me.applyParticipations(res.items.map((r) => ({ articleId: r.articleId, record: r })))
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
   * ⚠️⚠️ **不带 `date`**（2026-09 删）：以前这里要把服务端的 `lastScheduleDate` 传过去，
   *    让"再次挑战"归到那一天。现在**归哪一天由服务端受理时取它的今天**，
   *    端侧不传、也不拿本地时钟算 —— 所以这条链接只剩 `?id=`。
   * ⚠️ 朗读页是**受保护页**（要花能量、成绩要有归属）⇒ 走带守卫的 go，不是 goPublic。
   */
  onOpen(e: WechatMiniprogram.BaseEvent) {
    const i = Number((e.currentTarget.dataset as { i?: number }).i)
    const row = this.data.rows[i]
    if (!row) return

    void go(ROUTES.reading.url + '?id=' + encodeURIComponent(row.articleId))
  },
})
