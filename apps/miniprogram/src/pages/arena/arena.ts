import { startButtonLabel } from '@jushuo/shared'
import type { ArenaDetail, ArticleTheme, ScheduleDetail } from '@jushuo/shared'
import { fetchArenaDetail, fetchArenaRecords, fetchScheduleDetail } from '../../lib/api/client'
import { formatScore } from '@jushuo/shared'

import { navPadTop, notifyNavScroll } from '../../lib/nav'
import * as me from '../../lib/store'

/**
 * 挑战详情页 —— 从首页卡片点进来。
 *
 * ⭐ 与首页卡片的分工：卡片是「一眼扫过去」，本页是「看进去」：
 *    完整的排行榜、我的名次、以及从这里进入朗读。
 *
 * ⚠️⚠️ **两种进法，两个地址**：
 *    · `?article=<articleId>` —— ⭐ 正路：**按句子**看一个竞技场（首页卡片点进来）
 *      日期只是「编辑精选的容器」，和竞技场无关；挑战它算**今天**
 *    · `?date=2026-09-21` —— 「回到那一天再读一次」（参与场次 / 挑战结果页点进来），
 *      挑战它算**那一天**（否则昨天那张卡片的数字会变）
 *
 * ⚠️⚠️ 页面必须记住**是从哪条路进来的**（见 this.entry）：
 *    比如按日期进来的，重新加载时必须仍然按日期 —— 只按「已经拿到的 articleId」
 *    重新请求的话，submissionDate 会被服务端算成**今天**，
 *    于是「回到那一天的挑战」被悄悄记成了今天，而昨天那张卡的数字跟着变。
 *    这种错在界面上完全看不出来（分数、榜单都对），所以只能靠这条约定守住。
 */
Page({
  data: {
    /** 根节点要让开的上边距（px）—— 自定义导航栏是浮层，不占文档流（见 lib/nav.ts） */
    navTop: 0,

    loading: true,
    error: '',

    /** ⭐ 这一句的 id —— 竞技场的**地址** */
    articleId: '',
    /** ⭐ 从这里发起的挑战该记到哪一天（服务端给的，端侧不自己算） */
    submissionDate: '',
    text: '',
    translation: '',
    isToday: false,
    /** ⭐ 句子卡的展示对象（arena-card 的 entry；不带卡片头/CTA） */
    sentence: null as {
      articleId: string
      header: boolean
      text: string
      translation: string
      theme: ArticleTheme | null
    } | null,

    /** '23 人参与，最高得分 74' */
    stat: '',
    topScore: null as number | null,
    participantCount: 0,
    myBest: null as number | null,
    /** myBest 的展示形态（一位小数）—— WXML 里没法调 toFixed */
    myBestText: '—',
    myRank: null as number | null,
    myBeatenCount: null as number | null,
    /** '立即朗读，参与挑战' / '重新朗读，再次冲榜' —— 来自 startButtonLabel，与首页共用 */
    action: '',

    leaderboard: [] as ScheduleDetail['leaderboard'],
  },

  /** 服务端给的详情；「我」的部分渲染时从 store 取 */
  detail: null as ScheduleDetail | ArenaDetail | null,

  /**
   * ⭐ 页面是**从哪条路进来的**（见文件头那段）：
   *    重新加载必须沿同一条路，否则 submissionDate 会被算错。
   */
  entry: { articleId: '', date: '' },

  /** store 退订函数 */
  unsubStore: null as (() => void) | null,

  onLoad(query: Record<string, string | undefined>) {
    /** ⭐ 优先按句子（正路）；没有 article 才退回按日期（老入口） */
    // ⭐ articleId 是内容 hash（字符串）—— 原样取，**不再 Number()**
    const articleId = query.article ?? ''
    const date = query.date ?? ''
    this.entry = articleId ? { articleId, date: '' } : { articleId: '', date }
    this.setData({ navTop: navPadTop() })
    // ⭐ 订阅全局「我的记录」：在朗读页打完分，回到这里名次与成绩立刻是新的
    this.unsubStore = me.subscribe(() => this.render())
    void this.load()
  },

  /** 从朗读页返回时刷新 —— 刚打完的分与名次必须立刻出现在榜单上 */
  onShow() {
    if (!this.data.loading) void this.load()
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

  /**
   * 拉详情。⚠️ 用 `this.entry` 决定走哪条路 —— 不传参，免得调用方漏掉（见文件头）。
   */
  async load() {
    const { articleId, date } = this.entry
    if (!articleId && !date) {
      this.setData({ loading: false, error: '缺少竞技场地址' })
      return
    }
    this.setData({ loading: true, error: '' })
    try {
      const d = articleId ? await fetchArenaDetail(articleId) : await fetchScheduleDetail(date)
      /**
       * ⭐⭐ 「我的」那一份**单独取**（个人接口 /api/user/arena-records）：
       *    公开详情里**不含**我的成绩与名次。
       * ⚠️ ranks=1 —— 名次是**跨用户**算的，只有服务端算得出来（公开榜单只给前 20）。
       * ⚠️ 同一次响应既喂 store（首页卡片跟着更新），也喂本页「我的战绩」那一卡。
       */
      const recs = await fetchArenaRecords([d.articleId], true)
      me.applyArenaRecords(recs.items)
      const mine = recs.items.find((r) => r.articleId === d.articleId)
      this.detail = d
      this.setData({
        loading: false,
        articleId: d.articleId,
        submissionDate: d.submissionDate,
        text: d.text,
        translation: d.translation,
        isToday: d.isToday,
        sentence: {
          articleId: d.articleId,
          header: false,
          text: d.text,
          translation: d.translation,
          theme: d.theme,
        },
        stat: this.statText(d),
        topScore: d.topScore,
        participantCount: d.participantCount,
        // ⚠️ 名次/击败来自**个人接口**（见上面），不是公开详情
        myRank: mine?.rank ?? null,
        myBeatenCount: mine?.beatenCount ?? null,
        // ⚠️ 分值统一一位小数（formatScore）—— 与结果页、首页同一口径
        leaderboard: d.leaderboard.map((r) => ({ ...r, scoreText: formatScore(r.score) })),
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
      myBestText: formatScore(mine.myBest),
      // ⚠️ myRank / myBeatenCount 不在这里：它们来自个人接口那次响应（见 load），
      //    这里只管「刚打完分」后跟着 store 变的那两个数（成绩与按钮文案）
      // ⚠️ 与首页共用同一份实现（@jushuo/shared 的 startButtonLabel）——
    //    同一个状态在两个页面上必须长成同一句话
    action: startButtonLabel(mine.myBest !== null),
    })
  },

  onRetry() {
    void this.load()
  },

  /**
   * ⚠️ 没人参与过时**不要**写「0 人参与，最高得分 0」——
   *    那读起来像「这题已经凉了」，而真相是「你是第一个」。
   */
  statText(d: ScheduleDetail | ArenaDetail): string {
    if (d.participantCount === 0) return ''
    const top = d.topScore === null ? '' : '，最高得分 ' + formatScore(d.topScore)
    return d.participantCount + ' 人参与' + top
  },

  /**
   * 去朗读。
   * ⚠️ `date` 传的是 **submissionDate**（服务端给的「这次挑战算哪天」）——
   *    按句子进来就是今天、按日期进来就是那一天。端侧**不自己算**：
   *    手机时钟可以随便改，而这个日期决定成绩归到哪一天。
   */
  onStart() {
    const { articleId, submissionDate } = this.data
    if (!articleId || !submissionDate) return
    // ⚠️ 不拦「加入过没有」：能不能挑战由服务端说了算，
    //    昵称/头像只是展示字段（见 pages/index/index.ts 的 onStart）。
    wx.navigateTo({ url: '/pages/reading/reading?id=' + articleId + '&date=' + submissionDate })
  },
})
