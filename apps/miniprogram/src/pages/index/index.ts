import { BRAND, startButtonLabel } from '@jushuo/shared'
import type { ScheduleEntry, SchedulesResponse, StreakView } from '@jushuo/shared'
import { fetchSchedules } from '../../lib/api/client'
import { ensureLogin } from '../../lib/login'
import { navPadTop, notifyNavScroll } from '../../lib/nav'
import * as me from '../../lib/store'
import type { ArenaRecord } from '../../lib/store'

/** 列表里一张卡片的**展示视图** —— 文案在 TS 里拼好，WXML 只负责画。 */
interface CardView {
  date: string
  /** '2026.11.24' —— 直接用点分隔，和中文排版更搭 */
  dateText: string
  articleId: number
  text: string
  translation: string
  isToday: boolean
  /**
   * '23 人参与' —— 空场次留空（见 statText）。
   *
   * ⚠️ 只剩「有多少人」了，**不再带我的成绩**：
   *    · 我的参与状态由按钮下方那行说（今天那张卡），
   *    · 我的最好成绩属于榜单，在详情页。
   *    卡片头这行只回答一个问题：这个竞技场有多大。
   */
  stat: string
  /**
   * 按钮下方那行：'你已经参与 3 次挑战 · 最高得分 86' / '还未参与挑战'。
   *
   * ⚠️ **只有今天那一张卡片有按钮，所以也只有它有这行** —— 往日卡片整张就是入口。
   * ⚠️ 它和按钮文案不算重复：按钮说的是「点下去会发生什么」（重新朗读），
   *    这一行说的是「你已经来过几次、最好多少分」—— 这两件事按钮都表达不了。
   */
  hint: string
  /**
   * 主按钮文案：'立即朗读，参与挑战' / '重新朗读，再次冲榜'。
   * ⚠️ 来自 @jushuo/shared 的 startButtonLabel —— 和竞技场页共用同一份，
   *    两处各写一份字符串必然漂移。
   */
  action: string
}

/**
 * 首页 = 每日挑战列表。
 *
 * ⭐ 整页只有一件事：把「今天读什么、以前读过什么」列清楚。
 *    今天那一张在最上面、字号最大，其余按天倒序排在下面。
 *
 * ⚠️ 分组标题只有「往日挑战」一个：今天那一张位置最上、字号最大、日期最新，
 *    本来就认不错；而往日是一串同构卡片，需要一个词说明它们是什么。
 *
 * ⚠️ 入口也只有今天那一张有按钮。往日卡片整张可点 → 详情页，
 *    榜单和重读都在那里 —— 每张都挂按钮会让整页变成一片按钮墙。
 *
 * ⚠️ 按钮文案随「参与过没有」变（立即朗读，参与挑战 / 重新朗读，再次冲榜），
 *    且**与竞技场页共用同一份实现**（@jushuo/shared 的 startButtonLabel）——
 *    同一个状态在两个页面上必须长成同一句话。
 *
 * ⚠️ **首页不放标准音的播放按钮**：这一页是「扫一眼今天读什么」的地方，
 *    要听句子去朗读页（那里有喇叭和逐词发音）。
 *    而且卡片上的音频控件和「点卡片进详情」是同一片区域，两个 tap 目标必然互相误触。
 *
 * ⚠️ 日期一律由**服务端**给（见 @jushuo/shared/day.ts）。
 *    手机时钟可以随便改；让本地算今天，必然出现「本地显示已打卡、服务端不认」。
 *
 * ⚠️ 这一页曾经是脚手架自检页（后端连接面板 + Worker 音频算法自检 + 真机自检入口）。
 *    它们作为**产品**是错的：用户打开小程序看到的应该是今天要读的句子，
 *    而不是一张给开发者看的诊断表。诊断能力留在服务端 /health（部署工具用它），
 *    页面这里只在真的连不上时给一句人话 + 重试。
 */
/**
 * 「23 人参与，你已挑战 2 次」。
 *
 * ⚠️ 只回答一个问题：**这个竞技场有多大**。
 *    最高分不显示（那是别人的成绩，扫列表时改变不了你的决定，还会把目光
 *    从「我读没读」上引开）；我的成绩也不显示（那是榜单的事，在详情页）。
 *
 * ⚠️ 没人参与时**什么都不说**，不要替它找话：
 *    「还没有人挑战，来做第一个」看着像鼓励，其实是在**替用户操心**。
 *
 * ⚠️ 写成**纯函数**而不是页面方法：它的输入只有一个数字，
 *    与页面实例无关，这样才好单独测。
 */
function statText(participantCount: number): string {
  return participantCount === 0 ? '' : participantCount + ' 人参与'
}

/**
 * 按钮下方那行：「你已经参与 N 次挑战 · 最高得分 M」。
 *
 * ⚠️⚠️ 这里的「最高得分」是**我自己的最好成绩**，不是全场最高分。
 *    它紧跟在「你已参与 N 次」后面，两句话的主语必须是同一个（我）——
 *    换成全场最高分就成了「别人的成绩」，而那是榜单的事，在详情页里。
 *
 * ⚠️ 是**这一句**上的最好成绩（按 articleId 取，见 lib/store）。
 *    竞技数据跟着句子走，同一句排在多天就是同一份战绩。
 *
 * ⚠️ 没参与时整段都不说，**绝不写「最高得分 0」** ——
 *    那读起来像「我去读过、拿了 0 分」，而真相是「还没去过」。
 *    同理，有次数但没成绩（数据不完整的中间态）时只说次数，不编一个 0 出来。
 *
 * ⚠️ 同样写成**纯函数**：输入只有「我的战绩」一个对象，与页面实例无关，好单测。
 */
function hintText(mine: ArenaRecord): string {
  if (mine.myAttempts <= 0) return '还未参与挑战'
  const times = '你已经参与 ' + mine.myAttempts + ' 次挑战'
  if (mine.myBest === null) return times
  return times + ' · 最高得分 ' + mine.myBest
}

Page({
  data: {
    /** ⭐ 定位文案来自 @jushuo/shared/brand.ts —— 不要在页面里另抄一份 */
    brand: BRAND,

    /**
     * 根节点要让开的上边距（px）—— 自定义导航栏是浮层，不占文档流。
     * ⚠️ 值只能来自 lib/nav.ts：改一个数就三页一起改，不会有一页漏掉。
     */
    navTop: 0,

    loading: true,
    /** 连不上时的**可操作**提示（不是「请求失败」四个字） */
    error: '',

    streak: null as StreakView | null,
    today: null as CardView | null,
    history: [] as CardView[],
  },

  /** 请求是否在途 —— 只用来挡并发，不参与任何业务判断 */
  requesting: false,

  /**
   * 服务端给的**卡片原始数据**（句子、人数…）。
   * ⚠️ 与 store 里的「我的参与记录」分开存：
   *    卡片内容来自接口、只有拉到才有；参与记录来自 store、随时都在。
   *    渲染 = 这两份拼起来（见 render()），所以**参与状态一变就能立刻重画**，
   *    不需要先把整张列表重新拉一遍。
   */
  cards: null as { today: ScheduleEntry; history: ScheduleEntry[] } | null,

  /** store 退订函数 */
  unsubStore: null as (() => void) | null,

  onLoad() {
    // ⚠️ 在 onLoad 里取：它赶得上首帧渲染，不会先顶到状态栏再跳下来
    this.setData({ navTop: navPadTop() })

    // ⭐ 订阅全局「我的记录」：朗读页打完分写进去，这里立刻重画。
    //    ⚠️ 这是「提交完返回首页不更新」的根治手段 ——
    //       它不依赖 onShow 的时机，也不要求首页还在页面栈里。
    this.unsubStore = me.subscribe(() => this.render())
    void this.load()
  },

  /**
   * 回到这一页时**无条件**重拉一次。
   *
   * ⚠️ 两条路都要有，它们互相兜底：
   *    · 订阅（store）—— 负责「不用发请求就立刻更新」，但它依赖回调真的跑通；
   *    · onShow + 重拉 —— 负责「无论如何，回到这一页时数据是服务端的」，
   *      它不依赖任何本地状态。
   *    只留前者的话，订阅一旦出问题（异常被吞、页面实例错位），
   *    页面就**永远不更新**且毫无痕迹 —— 这个坑本项目已经踩过。
   */
  onShow() {
    void this.load()
  },

  /** 下拉刷新 —— 万一还有没覆盖到的时机，用户至少有个手动出口 */
  onPullDownRefresh() {
    void this.load().finally(() => wx.stopPullDownRefresh())
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
    // ⚠️ 必须退订：不退的话页面销毁后回调还在跑，里面一句 setData 就报错
    this.unsubStore?.()
    this.unsubStore = null
  },

  async load() {
    // ⚠️ 并发用独立的 requesting 挡，**不要**用 loading：
    //    loading 还兼任「首屏骨架」的开关，用它挡并发就会顺带吞掉真正的刷新。
    if (this.requesting) return
    this.requesting = true
    // ⚠️ 已经有卡片时不再回到骨架屏 —— 刷新是「就地换数字」，不是「整页白一下」
    if (!this.cards) this.setData({ loading: true })
    this.setData({ error: '' })
    try {
      const d = await fetchSchedules()
      // ⭐ 先把「我的记录」写进 store（广播给所有页面），再本地重画一次
      me.applySchedules(d)
      this.cards = { today: d.today, history: d.history }
      this.setData({ loading: false })
      this.render()
    } catch (err) {
      this.setData({ loading: false, error: this.explain((err as Error).message || String(err)) })
    } finally {
      this.requesting = false
    }
  },

  /**
   * 重画 —— 把「服务端卡片」与「store 里的我的记录」拼成展示视图。
   *
   * ⭐ 所有与「我」有关的字段（已参与 / 已挑战几次 / 按钮文案）**只从 store 取**，
   *    不再读卡片上那份 —— 否则同一个事实会有两个来源，
   *    而它们更新时机不同，必然出现「卡片说没参与、store 说有」。
   */
  render() {
    const c = this.cards
    if (!c) return
    this.setData({
      streak: me.getState().streak,
      today: this.toView(c.today),
      history: c.history.map((x) => this.toView(x)),
    })
  },

  /** 卡片 → 展示视图 */
  toView(card: ScheduleEntry): CardView {
    // ⭐ 「我」的部分一律来自 store
    const mine = me.arenaOf(card.articleId)
    return {
      date: card.date,
      dateText: card.date.replace(/-/g, '.'),
      articleId: card.articleId,
      text: card.text,
      translation: card.translation,
      isToday: card.isToday,
      stat: statText(card.participantCount),
      hint: hintText(mine),
      // ⚠️ 用 myBest 判断而不是 myAttempts：两者在正常流程里同进同退，
      //    但「参与过」的权威判据是**有没有成绩**。
      action: startButtonLabel(mine.myBest !== null),
    }
  },

  onRetry() {
    void this.load()
  },

  /**
   * 把底层错误翻译成**用户能动手**的一句话。
   * ⚠️ 不展示技术细节（那些在服务端 /health 里）—— 页面上的技术细节只会让人更困惑。
   */
  explain(msg: string): string {
    if (msg.includes('COLD_START')) {
      return '服务正在启动（云托管冷启动约 6 秒），再点一次「重试」就好。'
    }
    if (/fail|timeout|超时/i.test(msg)) {
      return '连不上服务器。检查网络后再重试。'
    }
    return msg
  },

/**
   * 点卡片 → 挑战详情。
   *
   * ⚠️ 与卡片上那个按钮刻意分工：
   *    · 按钮 = 直接开读（老用户的高频路径，少一次跳转）
   *    · 卡片主体 = 看详情（榜单、名次、再决定读不读）
   *    两个入口指向不同页面，所以卡片右侧放了一个「›」提示可点开，
   *    否则「点哪儿都一样」的错觉会让人以为自己点错了。
   */
  onOpenDetail(e: WechatMiniprogram.BaseEvent) {
    const date = (e.currentTarget.dataset as { date?: string }).date
    if (!date) return
    wx.navigateTo({ url: '/pages/arena/arena?date=' + date })
  },

  /** 开始/再次挑战 —— 必须把**这一天的日期**带过去 */
  async onStart(e: WechatMiniprogram.BaseEvent) {
    const ds = e.currentTarget.dataset as { id?: number; date?: string }
    if (!ds.id || !ds.date) return
    // ⚠️ 挑战要记成绩、要占额度，先确认这是「有人」在挑战。
    //    拦在**进门之前**：让他录完 1 分钟再告诉他没登录，比不让进更气人。
    //    ⚠️ 但**不要**直接弹授权层：账号已经在服务端的（换设备 / 清了缓存）直接放行，
    //       该不该问用户由 ensureLogin 先问完服务端再决定（见 lib/login.ts）。
    if (!(await ensureLogin())) return
    wx.navigateTo({
      url: '/pages/reading/reading?id=' + ds.id + '&date=' + ds.date,
    })
  },
})
