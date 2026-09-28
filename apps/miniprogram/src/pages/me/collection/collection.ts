import { LEVEL_LABEL, formatScore, normalizeLevel } from '@jushuo/shared'
import type { FavoriteItem } from '@jushuo/shared'

import { listFavorites, setFavorite } from '../../../lib/api/client'
import { navPadTop, notifyNavScroll } from '../../../lib/nav'
import { ROUTES, goPublic } from '../../../lib/route'

/**
 * ⭐ 「我的收藏」—— 我收过的句子，最近收的排前面。
 *
 * ⚠️ 一条 = **一句**（收的是这句话本身，与读没读过无关）——
 *    所以卡片上「我的战绩」那一块**可能什么都没有**（还没读过也允许收藏），
 *    这时显示一句「还没读过」而不是 0 分：0 分和没读过是两件事。
 * ⚠️ 点卡片进**竞技场**（按句子寻址 `/pages/arena/arena?article=...`），
 *    不是「今天那一场」—— 收藏与日期无关。
 */

/** 列表里一行（显示形态与接口字段分开：WXML 里没法算） */
interface Row {
  articleId: string
  text: string
  /** '高级' / '中级' / …；老内容没有难度就是空串（不补默认档位） */
  levelText: string
  /** '名言 · 哲理' */
  tagsText: string
  /** '09-25 收藏' */
  favoritedText: string
  /** '已读 3 次 · 最高 88.0' / '还没读过' */
  mineText: string
  attempts: number
  bestScore: number | null
}

/** '2026-09-25T…' → '09-25'（列表里年份是噪声，当年的收藏一眼就懂） */
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? m[2] + '-' + m[3] : ''
}

function toRow(r: FavoriteItem): Row {
  const lv = normalizeLevel(r.difficulty)
  return {
    articleId: r.articleId,
    text: r.text,
    levelText: lv === null ? '' : LEVEL_LABEL[lv],
    tagsText: (r.tags ?? []).join(' · '),
    favoritedText: shortDate(r.favoritedAt) + ' 收藏',
    mineText:
      r.bestScore === null
        ? '还没读过'
        : '已读 ' + r.attempts + ' 次 · 最高 ' + formatScore(r.bestScore),
    attempts: r.attempts,
    bestScore: r.bestScore,
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

  /** ⚠️ 每次回到这一页都重拉：刚在竞技场页取消/新增收藏，回来必须是新的 */
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
      const res = await listFavorites()
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
   * ⚠️ 空方法：只用来 `catchtap` 截住冒泡。
   *    整张卡是「点进竞技场」，而「取消收藏」按钮在卡片**里面** ——
   *    不截的话点按钮会连带把卡片也点了（跳走 + 取消收藏同时发生）。
   */
  noop() {},

  /** 点一张卡 → 按**句子**寻址的竞技场（收藏与日期无关） */
  onOpen(e: WechatMiniprogram.BaseEvent) {
    const i = Number((e.currentTarget.dataset as { i?: number }).i)
    const row = this.data.rows[i]
    if (!row) return
    // ⚠️ 竞技场是**公开页**（陌生人也能看榜），所以走 goPublic 而不是带守卫的 go
    goPublic(ROUTES.arena.url + '?article=' + encodeURIComponent(row.articleId))
  },

  /**
   * ⭐ 取消收藏（卡片右下角那个按钮）。
   *
   * ⚠️ 收的句子**直接从列表里拿掉**（这一页就是收藏列表，留着它没有意义）；
   *    失败则**整页重拉**—— 本页的真相是服务端那一份，不在这里自己猜。
   * ⚠️ 事件名是 press（ui-button 的约定，见那个组件），不是 tap。
   */
  async onRemove(e: WechatMiniprogram.BaseEvent) {
    const i = Number((e.currentTarget.dataset as { i?: number }).i)
    const row = this.data.rows[i]
    if (!row) return
    const prev = this.data.rows
    this.setData({ rows: prev.filter((r) => r.articleId !== row.articleId) })
    try {
      await setFavorite(row.articleId, false)
      wx.showToast({ title: '已取消收藏', icon: 'none', duration: 1200 })
      if (this.data.rows.length === 0) this.setData({ empty: true })
    } catch (err) {
      this.setData({ rows: prev })
      wx.showToast({ title: (err as Error).message || '操作失败', icon: 'none', duration: 2000 })
    }
  },
})