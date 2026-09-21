import { startButtonLabel } from '@jushuo/shared'
import type { ScheduleDetail } from '@jushuo/shared'
import { fetchScheduleDetail } from '../../lib/api/client'
import { navPadTop, notifyNavScroll } from '../../lib/nav'
import * as me from '../../lib/store'

/**
 * 挑战详情页 —— 从首页卡片点进来。
 *
 * ⭐ 与首页卡片的分工：卡片是「一眼扫过去」，本页是「看进去」：
 *    完整的排行榜、我的名次、以及从这里进入朗读。
 *
 * ⚠️ 日期由首页原样带过来（/pages/arena/arena?date=2026-09-21）。
 *    不在本页自己算「今天」—— 手机时钟可以随便改，
 *    而这是一个**指着某一天**的页面，日期错了整页内容都是错的。
 */
Page({
  data: {
    /** 根节点要让开的上边距（px）—— 自定义导航栏是浮层，不占文档流（见 lib/nav.ts） */
    navTop: 0,

    loading: true,
    error: '',

    date: '',
    articleId: 0,
    text: '',
    translation: '',
    isToday: false,

    /** '23 人参与，最高得分 74' */
    stat: '',
    topScore: null as number | null,
    participantCount: 0,
    myBest: null as number | null,
    myRank: null as number | null,
    myBeatenCount: null as number | null,
    /** '立即朗读，参与挑战' / '重新朗读，再次冲榜' —— 来自 startButtonLabel，与首页共用 */
    action: '',

    leaderboard: [] as ScheduleDetail['leaderboard'],
  },

  /** 服务端给的详情；「我」的部分渲染时从 store 取 */
  detail: null as ScheduleDetail | null,

  /** store 退订函数 */
  unsubStore: null as (() => void) | null,

  onLoad(query: Record<string, string | undefined>) {
    const date = query.date ?? ''
    this.setData({ date, navTop: navPadTop() })
    // ⭐ 订阅全局「我的记录」：在朗读页打完分，回到这里名次与成绩立刻是新的
    this.unsubStore = me.subscribe(() => this.render())
    void this.load(date)
  },

  /** 从朗读页返回时刷新 —— 刚打完的分与名次必须立刻出现在榜单上 */
  onShow() {
    if (this.data.date && !this.data.loading) void this.load(this.data.date)
  },

  /**
   * 页面滚动 → 导航栏（白底什么时候出现，见 lib/nav.ts 的 navSolidFrom）。
   *
   * ⚠️ 必须由页面来转这一手：小程序里**只有页面**有 onPageScroll，
   *    组件没有这个生命周期，而 fixed 的导航栏自己不动、也观察不到页面在滚。
   */
  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    notifyNavScroll(this, e.scrollTop)
  },


  onUnload() {
    // ⚠️ 必须退订，否则页面销毁后回调还在跑，setData 会报错
    this.unsubStore?.()
    this.unsubStore = null
  },

  async load(date: string) {
    if (!date) {
      this.setData({ loading: false, error: '缺少挑战日期' })
      return
    }
    this.setData({ loading: true, error: '' })
    try {
      const d = await fetchScheduleDetail(date)
      // ⭐ 把「我的记录」广播出去（首页那份也跟着更新）
      me.applyScheduleDetail(d)
      this.detail = d
      this.setData({
        loading: false,
        articleId: d.articleId,
        text: d.text,
        translation: d.translation,
        isToday: d.isToday,
        stat: this.statText(d),
        topScore: d.topScore,
        participantCount: d.participantCount,
        leaderboard: d.leaderboard,
      })
      this.render()
    } catch (err) {
      this.setData({ loading: false, error: (err as Error).message || String(err) })
    }
  },

  /**
   * 重画「我」的那几个数字。
   * ⚠️ 只从 store 取 —— 详情响应里也有 myBest，但那是**拉取那一刻**的快照，
   *    朗读页刚打完的分不会出现在里面。两个来源留一个，取 store。
   */
  render() {
    if (!this.detail) return
    const mine = me.arenaOf(this.data.articleId)
    this.setData({
      myBest: mine.myBest,
      myRank: this.detail.myRank,
      myBeatenCount: this.detail.myBeatenCount,
      // ⚠️ 与首页共用同一份实现（@jushuo/shared 的 startButtonLabel）——
    //    同一个状态在两个页面上必须长成同一句话
    action: startButtonLabel(mine.myBest !== null),
    })
  },

  onRetry() {
    void this.load(this.data.date)
  },

  /**
   * ⚠️ 没人参与过时**不要**写「0 人参与，最高得分 0」——
   *    那读起来像「这题已经凉了」，而真相是「你是第一个」。
   */
  statText(d: ScheduleDetail): string {
    if (d.participantCount === 0) return ''
    const top = d.topScore === null ? '' : '，最高得分 ' + d.topScore
    return d.participantCount + ' 人参与' + top
  },

  /** 去朗读 —— 把这一天的日期原样带过去 */
  onStart() {
    const { articleId, date } = this.data
    if (!articleId || !date) return
    // 同上：先去登录，再进朗读页（见 pages/index/index.ts 的说明）
    if (!me.isLoggedIn()) {
      me.openLoginSheet()
      return
    }
    wx.navigateTo({ url: '/pages/reading/reading?id=' + articleId + '&date=' + date })
  },
})
