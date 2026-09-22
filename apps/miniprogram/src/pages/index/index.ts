import { BRAND, difficultyLabel, formatScore, startButtonLabel } from '@jushuo/shared'
import type {
  GrowthRankResponse,
  GrowthRankRow,
  ScheduleEntry,
  SchedulesResponse,
  StreakView,
} from '@jushuo/shared'
import { fetchGrowthBoards, fetchSchedules } from '../../lib/api/client'
import { ensureLocalAudio } from '../../lib/audio/standard'
import { playAudioUrl, stopAudio } from '../../lib/audio/play'
import { openChallengesPage, openParticipationsPage, openStreakPage } from '../../lib/challenges'
import { refreshMe } from '../../lib/join'
import { navPadTop, notifyNavScroll } from '../../lib/nav'
import * as me from '../../lib/store'
import type { ArenaRecord } from '../../lib/store'

/** 列表里一张卡片的**展示视图** —— 文案在 TS 里拼好，WXML 只负责画。 */
/** 首页荣誉榜的一块（tab 上的短标签 + 它自己的前十） */
interface BoardView {
  key: string
  /** ⚠️ 短标签：三个 tab 要挤在一行里，写「📈 自我超越」就够，别带 TOP10 */
  label: string
  rows: GrowthRankRow[]
}

/**
 * 三个成长指标 → WXML 能直接渲染的数组。
 * ⚠️ 标签与顺序只在这里写一次：图标要与用户面板里那三个数一致
 *    （📈 自我超越 / 🔥 孜孜不倦 / 🏔️ 鹤立鸡群）。
 * ⚠️ 顺序固定为「自我超越 / 孜孜不倦 / 鹤立鸡群」—— 与用户面板那一排一致，
 *    换个顺序会让人以为漏了一个。
 */
function boardListOf(b: GrowthRankResponse): BoardView[] {
  return [
    { key: 'self', label: '📈 自我超越', rows: b.self },
    { key: 'diligence', label: '🔥 孜孜不倦', rows: b.diligence },
    { key: 'standout', label: '🏔️ 鹤立鸡群', rows: b.standout },
  ]
}

interface CardView {
  /** 只有今日那一张有（见 toView 的说明） */
  date: string
  articleId: number
  text: string
  translation: string
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
   * ⭐ 朗读难度徽标（'初' / '中' / '高'）；空串 = 这一句没有难度 ⇒ WXML 不渲染。
   *
   * ⚠️ 用空串而不是补一个默认档位：编出来的难度比没有难度更糟 ——
   *    用户会以为这一句真的被评过级（同 shared/difficulty.ts 的说明）。
   */
  difficultyText: string
  /**
   * ⭐ 标准音的可播引用（null = 这一句没有标准音 ⇒ 不渲染播放按钮）。
   * ⚠️ 端侧不拼地址：full 的形态由 kind 决定（云存储 fileID / 服务端路径），
   *    两条路的解释在 lib/audio/standard.ts 里统一处理。
   */
  audio: { full: string; kind: 'cloud' | 'http' } | null
  /** '0:03' —— 标准音时长；算不出来是空串 ⇒ 只显示按钮、不显示时长 */
  durationText: string
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
/** 状态卡上的三个数 */
interface StatsView {
  /**
   * ⭐ 参与场次：**拿到过分数**的去重句子数（一句 = 一个竞技场 = 一场）。
   *
   * ⚠️⚠️ 字段名还叫 conqueredCount（服务端的口径就是它），但**显示叫「参与场次」**：
   *    85 分那条攻克线废除之后，「攻克」就等于「参与并且拿到分」——
   *    两个说法指的是同一个数，那就用更直白的那个。
   *    ⛔ 不要为了「凑出两个不同的数」去改口径：这一格数句子、
   *       下一格（挑战回合）数提交次数，两个数天然就不一样，
   *       读十次才读完一句是很正常的事。
   */
  conqueredCount: number
  /** 挑战回合：一共打了几次分（**过程量**，读得多就大） */
  challengedRounds: number
  /** 连战天数 */
  streakDays: number
}

/**
 * ⭐ 拼出状态卡上的三个数。
 *
 * ⚠️ 三个数**要么一起出现，要么都不出现**：
 *    「参与场次」和「挑战回合」来自 profile（/me），「连战天数」来自 streak。
 *    只拿到一半就渲染，会出现「0 场 · 20 次 · 1 天」这种自相矛盾的一行 ——
 *    而用户看到的是「我的记录是不是坏了」。
 *    ⇒ 没有 profile 就整张卡不画（见 data.stats 的说明）。
 *
 * ⚠️⚠️ 这里的判据是**登录** —— 服务端认识我，也就是 users 里已经有我这一行。
 *    **不是**「我起名字了没有」。这两个判断曾经被合成一个（原来是 !profile?.nickname），
 *    代价很实在：
 *
 *      openid 是 wx.login 静默拿到的，但它只解决「你是谁」（授权层）；
 *      用户有没有进我们的业务库是另一回事 —— 那是服务端按 openid
 *      取或建出 users 那一行时才发生的（见 middleware/auth.ts）。
 *      于是「有账号、有成绩、只是没起名字」的人会被这条判成新人，
 *      状态卡直接消失 —— 而他明明有记录。
 *
 *    ⇒ profile 非空 = 服务端认过我 = 我有账号 → 该显示就显示。
 *      三个数都是 0 也是**真实的 0**（注册了但还没读过），不是记录丢了 ——
 *      那正是「先注册、再谈业务数据」的意义。
 *
 * ⚠️ 写成纯函数：输入只有两个对象，与页面实例无关，好单测。
 */
function statsOf(profile: me.Profile | null, streak: StreakView | null): StatsView | null {
  // ⚠️ 没有 profile = 还没跟服务端确认过身份（真正的「没登录」）→ 整张卡不画。
  if (!profile) return null
  return {
    conqueredCount: profile.conqueredCount,
    challengedRounds: profile.challengedRounds,
    streakDays: streak?.streakDays ?? 0,
  }
}

/**
 * 标准音时长 → '0:03'。
 *
 * ⚠️ 算不出来（null / 非正数）返回**空串**，端侧就只显示播放按钮、不显示时长 ——
 *    而不是显示一个 0:00（那会让人以为音频坏了）。
 * ⚠️ 只到「分:秒」：标准音最长也就十几秒，显示毫秒只会更吵。
 */
function durationText(ms: number | null): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return ''
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const sec = total % 60
  return m + ':' + String(sec).padStart(2, '0')
}

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
  // ⚠️ 分值全站统一一位小数（formatScore）
  return times + ' · 最高得分 ' + formatScore(mine.myBest)
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

    /**
     * ⭐ 状态卡上的三个数。
     *
     * ⚠️ 拿不到时是 null（整张卡不渲染），**不是**三个 0 ——
     *    对刚打开的老用户来说，「0 句 / 0 次」是**错的**，
     *    而错的数字比没有数字更糟：他会以为记录丢了。
     */
    stats: null as StatsView | null,
    today: null as CardView | null,
    history: [] as CardView[],
    /**
     * ⭐ 三块成长榜（自我超越 / 孜孜不倦 / 鹤立鸡群，各 TOP10）。
     * ⚠️ 与卡片分开存：它失败**不该**影响首页上半段（顶多这三块不出现）。
     * ⚠️ 只在 TS 里拼成数组、**不另存一份原始响应** —— 同一份数据两种表示迟早对不上。
     */
    boardList: [] as BoardView[],
    /**
     * ⭐ 当前选中的是第几块（0 = 自我超越）。
     * ⚠️ 用下标而不是 key：它同时是 wx:for 的 index，比较起来最直接。
     */
    activeBoard: 0,
    /**
     * 当前那一块的行。
     * ⚠️ 在 TS 里算好、而不是在 WXML 里写 `boardList[activeBoard].rows`：
     *    动态下标 + 点号连写在小程序模板里支持得很勉强，换个写法就白屏。
     */
    activeRows: [] as GrowthRankRow[],
    /** 榜拉回来了没有 —— 没回来时整块不渲染（别闪一个空框） */
    boardsLoaded: false,
    /**
     * ⭐ 正在播的是哪一句（articleId）。0 = 没在播。
     *
     * ⚠️ 用 **articleId** 而不是「第几张卡」：7 天里大概率好几天是同一句，
     *    按卡片记的话，点一张卡播的却是另一张卡的按钮亮着。
     */
    playingArticle: 0,
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

  /**
   * ⭐ 状态卡上的**三个**数字各自是一个入口：
   *    「参与场次」→ 参与场次列表（一句一张卡）
   *    「挑战回合」→ 我的挑战（一次提交一条）
   *    「连战天数」→ 连战记录（见下面的 onOpenStreak）
   *
   * ⚠️ 前两者是**不同粒度**：一个是「句子」，一个是「提交」——
   *    所以是两个页面，不是一个页面的两个筛选。
   * ⚠️ 这里不再判「登录了没有」：没登录（服务端不认识我）时整条状态卡根本不渲染，
   *    见 statsOf —— 点不到就没有可点的东西，判据只留一处，免得两处打架。
   */
  onOpenParticipations() {
    openParticipationsPage()
  },

  onOpenChallenges() {
    openChallengesPage()
  },

  /**
   * 连战记录（日历 + 领奖）。
   *
   * ⚠️ 首页上有**两处**指向它，同一个处理器：状态卡第三格「连战天数」、
   *    以及下面那张连战卡。它们回答的是同一个问题的两种问法 ——
   *    「我连了几天」—— 点哪一处去的地方当然该是同一个。
   */
  /**
   * ⭐ 卡片上的圆形播放按钮：播这一句的标准音。
   *
   * ⚠️⚠️ 它是**独立的一小块热区**，WXML 那边用 catchtap 吃掉事件 ——
   *    不 catch 的话会冒泡到整张卡片，变成「点播放却进了详情页」。
   *    （这正是这个入口当初没做的原因，见 ScheduleEntry.audio 的注释。）
   * ⚠️ 再点一次 = 停：同一句的按钮就是开关，不需要额外的停止控件。
   * ⚠️ 走**和朗读页同一条**取音路径（ensureLocalAudio 优先本地），
   *    所以同一句第二次点会是秒出声。
   */
  async onPlayAudio(e: WechatMiniprogram.BaseEvent) {
    const ds = e.currentTarget.dataset as { id?: number; full?: string; kind?: string }
    const articleId = Number(ds.id ?? 0)
    if (!articleId || !ds.full) return

    // 再点一次 → 停（stopAudio 是全局唯一那个播放器）
    if (this.data.playingArticle === articleId) {
      stopAudio()
      this.setData({ playingArticle: 0 })
      return
    }

    const kind = ds.kind === 'cloud' ? 'cloud' : 'http'
    // ⚠️ 先点亮按钮再取音：取音这一步在弱网下要等一下，
    //    不给反馈的话用户会以为没点上，然后连点好几下。
    this.setData({ playingArticle: articleId })
    try {
      const src = await ensureLocalAudio(ds.full, kind)
      if (!src) throw new Error('拿不到标准音')
      await playAudioUrl(src, '标准音', () => {
        // ⚠️ 只在「还是这一句在播」时清掉标记：用户可能在播放期间点了另一句
        if (this.data.playingArticle === articleId) this.setData({ playingArticle: 0 })
      })
    } catch (err) {
      if (this.data.playingArticle === articleId) this.setData({ playingArticle: 0 })
      wx.showToast({ title: (err as Error).message || '播放失败', icon: 'none' })
    }
  },

  onOpenStreak() {
    openStreakPage()
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
      /**
       * ⭐ 顺带刷一次「我是谁」—— 状态卡上那两个累计数（挑战几句 / 一共几回）
       *    只有 /me 有，而它们**刚在朗读页变过**。
       *
       * ⚠️ 不 await：列表该先出来。刷新回来后 store 会广播，卡片自己重画
       *    （见 lib/join.ts 的 refreshMe：失败只警告，不影响这一页的加载）。
       */
      void refreshMe()
      /**
       * ⭐ 顺带拉三块成长榜 —— **不 await**：它在页面最下方，
       *    而首页上半段没理由等它。回来了自己 setData。
       * ⚠️ 失败只警告：榜拉不到，首页照常能用（顶多那三块不出现）。
       */
      void fetchGrowthBoards()
        .then((b) => {
          const list = boardListOf(b)
          this.setData({ boardList: list, activeRows: list[0]?.rows ?? [], boardsLoaded: true })
        })
        .catch((err: Error) => console.warn('[index] 成长榜拉取失败：' + err.message))
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
    const st = me.getState()
    this.setData({
      stats: statsOf(st.profile, st.streak),
      today: this.toView(c.today),
      history: c.history.map((x) => this.toView(x)),
    })
  },

  /** 卡片 → 展示视图 */
  toView(card: ScheduleEntry): CardView {
    // ⭐ 「我」的部分一律来自 store
    const mine = me.arenaOf(card.articleId)
    return {
      /**
       * ⚠️ 只有今日那一张有日期（它的按钮要把它带给朗读页）；
       *    历史卡片来自句库、与日期无关，这里就是空串 —— 而它们也不需要它，
       *    点进去走的是按句子寻址的 arena（data-article）。
       */
      date: card.date ?? '',
      articleId: card.articleId,
      text: card.text,
      translation: card.translation,
      stat: statText(card.participantCount),
      difficultyText: difficultyLabel(card.difficulty) ?? '',
      audio: card.audio ? { full: card.audio.full, kind: card.audio.kind } : null,
      durationText: durationText(card.audio ? card.audio.durationMs : null),
      hint: hintText(mine),
      // ⚠️ 用 myBest 判断而不是 myAttempts：两者在正常流程里同进同退，
      //    但「参与过」的权威判据是**有没有成绩**。
      action: startButtonLabel(mine.myBest !== null),
    }
  },

  /**
   * ⭐ 切换荣誉榜的 tab。
   * ⚠️ 纯本地切换（数据已经全在手里）—— 点一下就该立刻换，不该再发请求。
   * ⚠️ 点当前这个直接返回：不返回的话会白 setData 一次（列表看着闪一下）。
   */
  onSwitchBoard(e: WechatMiniprogram.BaseEvent) {
    const index = Number((e.currentTarget.dataset as { i?: string }).i ?? -1)
    if (index < 0 || index === this.data.activeBoard) return
    this.setData({ activeBoard: index, activeRows: this.data.boardList[index]?.rows ?? [] })
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
    /**
     * ⚠️⚠️ 竞技场按**句子**寻址，不按日期：
     *    日期只是「编辑精选的容器」，同一句会被排到很多天 ——
     *    按日期进等于把「这一句的榜单」绑在某一天上，而那件事从来没成立过。
     */
    const articleId = Number((e.currentTarget.dataset as { article?: string }).article ?? 0)
    if (!articleId) return
    wx.navigateTo({ url: '/pages/arena/arena?article=' + articleId })
  },

  /** 开始/再次挑战 —— 必须把**这一天的日期**带过去 */
  onStart(e: WechatMiniprogram.BaseEvent) {
    const ds = e.currentTarget.dataset as { id?: number; date?: string }
    if (!ds.id || !ds.date) return
    /**
     * ⚠️ 这里**不再拦「加入过没有」**。身份（openid）是静默拿到的，而服务端在
     *    每个业务接口前按 openid 取用户、没有就建一行（middleware/auth.ts）——
     *    能不能挑战由服务端说了算。昵称 / 头像只是榜上显示成什么，
     *    可以随时补、也可以一直不补（见 pages/join），端侧不该拿它当门。
     */
    wx.navigateTo({
      url: '/pages/reading/reading?id=' + ds.id + '&date=' + ds.date,
    })
  },
})
