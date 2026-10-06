import { BRAND, formatScore, startButtonLabel } from '@jushuo/shared'
import type {
  ArticleTheme,
  MeResponse,
  ArticleCard,
  ParticipationRecord,
  StreakView,
} from '@jushuo/shared'
import { fetchLatestCards, fetchToday } from '../../lib/api/client'
import { attachAvatarSrc } from '../../lib/cloud-file'
import { ensureLocalAudio } from '../../lib/audio/standard'
import { playAudioUrl, stopAudio } from '../../lib/audio/play'
import { openChallengesPage, openParticipationsPage, openStreakPage } from '../../lib/challenges'
import { refreshMe } from '../../lib/join'
import { ensureStats } from '../../lib/stats'
import { ensureParticipation } from '../../lib/participation'
import { navPadTop, notifyNavScroll } from '../../lib/nav'
import { ROUTES, go, goPublic } from '../../lib/route'
import { AUTH_RETRY_HINT, ensureAuthed, isAuthed, retryAuth } from '../../lib/auth'
import type { SessionState } from '../../lib/store'
import * as me from '../../lib/store'

/**
 * ⭐ 分享卡片图 —— **代码包里**的一张固定图（5:4，微信分享卡的标准比例）。
 *
 * ⚠️ 必须显式给图，不能让微信自己截屏：不带 imageUrl 时它截的是**用户当时看到的**
 *    那一屏（滚到哪截到哪），同一张活动在不同人那里长得完全不一样。
 * ⚠️ 打包用的是 **JPEG**：源图 content/misc/share_picture_home.png 是 417KB 的 PNG，
 *    但它**完全不透明**（没必要用 PNG），而主包上限 2MB —— 转 JPEG 后 74KB，视觉无差。
 */
const SHARE_IMAGE = '/assets/share-home.jpg'

/** 列表里一张卡片的**展示视图** —— 文案在 TS 里拼好，WXML 只负责画。 */


interface CardView {
  articleId: string
  /** ⭐ 视觉主题（arena-card 用它上色；老内容为 null ⇒ 品牌色兜底） */
  theme: ArticleTheme | null
  /** 画不画卡片头（播放/人数/箭头）—— 今日与最新上线画，竞技场的句子卡不画 */
  header: boolean
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
   * ⭐ 我参与过这一句（拿到过分）—— 卡片加一圈品牌色描边。
   *
   * ⚠️ 最新上线卡片刻意**没有**「已参与」药丸（一串同构卡片每张挂个药丸会变成药丸墙），
   *    但「哪几句我读过」是这一页最有用的一条信息 ⇒ 用描边说：不占位、不跟句子抢眼。
   * ⚠️ 判据与 action 一致（myBest !== null）：参与过 = **拿到过分**，
   *    不用 myAttempts（打分失败那一次不算参与）。
   */
  joined: boolean
  /**
   * ⭐ 标准音的可播引用（null = 这一句没有标准音 ⇒ 不渲染播放按钮）。
   * ⚠️ 端侧不拼地址：full 的形态由 kind 决定（云存储 fileID / 服务端路径），
   *    两条路的解释在 lib/audio/standard.ts 里统一处理。
   */
  audio: { full: string; kind: 'cloud' | 'http' } | null
  /** 标准音时长（毫秒）—— null = 算不出来 ⇒ 只显示按钮、不显示时长（格式由 audio-button 统一） */
  durationMs: number | null
  /**
   * 按钮下方那行：'你已经参与 3 次挑战 · 最高得分 86' / '还未参与挑战'。
   *
   * ⚠️ **只有今天那一张卡片有按钮，所以也只有它有这行** —— 最新上线卡片整张就是入口。
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
 * ⭐ 整页只有一件事：把「今天读什么、最近上线了什么」列清楚。
 *    今天那一张在最上面、字号最大，下面那串是最近上线的句子。
 *
 * ⚠️ 两段列表各自有标题（「今日挑战」「最新上线」）：
 *    今天那一张虽然位置最上，用户仍需要一个词确认它是「今天」；
 *    下面是一串同构卡片，更需要一个词说明它们是什么。
 *
 * ⚠️ 入口也只有今天那一张有按钮。最新上线卡片整张可点 → 详情页，
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
function statsOf(userInfo: MeResponse | null, streak: StreakView | null): StatsView | null {
  // ⚠️ 没有 userInfo = 还没跟服务端确认过身份（真正的「没登录」）→ 整张卡不画。
  if (!userInfo) return null
  return {
    conqueredCount: userInfo.conqueredCount,
    challengedRounds: userInfo.challengedRounds,
    streakDays: streak?.streakDays ?? 0,
  }
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
 * ⚠️ 数据来自 `GET /api/user/participation/{articleId}`（存进 store，见 lib/participation）。
 *
 * ⚠️⚠️ **三种状态必须分开**（这正是 `loaded` 存在的理由）：
 *    · 还没拉到（!loaded）→ **什么都不说** —— 编一句"还未参与挑战"是在替服务端下结论；
 *    · 拉到了、确实没参与（record === null）→ 「还未参与挑战」；
 *    · 参与过 → 「你已经参与 N 次…」。
 *
 * ⚠️ 没参与时**绝不写「最高得分 0」** —— 那读起来像"我去读过、拿了 0 分"，
 *    而 0 分是合法成绩，两者不能混。有次数但没成绩（未出分那种）时只说次数。
 *
 * ⚠️ 写成**纯函数**：输入只有参与状态一个对象，与页面实例无关，好单测。
 */
function hintOf(mine: { loaded: boolean; record: ParticipationRecord | null }): string {
  if (!mine.loaded) return ''
  const record = mine.record
  if (!record) return '还未参与挑战'
  const times = '你已经参与 ' + record.attempts + ' 次挑战'
  const best = record.bestScore
  if (best === null || best === undefined) return times
  // ⚠️ 分值全站统一一位小数（formatScore）
  return times + ' · 最高得分 ' + formatScore(best)
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

    /**
     * ⭐⭐ 三块**数据区各自**的加载态（用户 2026-09 定：分块异步 + 共用骨架）。
     *
     * ⚠️⚠️ 不再用整页一个 loading：四块（状态卡 / 今日卡 / 最新卡片 / 排行榜）
     *    到达时间不同，整页白会让人以为整页坏了；分块骨架才能让
     *    **"还没到"**（骨架）与 **"到了就是空的"**（空态）看起来不一样。
     * ⚠️ 状态卡**没有自己的请求** —— 它读全局 store 的 userInfo，
     *    所以它的"加载中"由 `statusMode` 表达（见 render()）。
     */
    latestLoading: true,
    latestError: '',
    todayLoading: true,
    todayError: '',

    /**
     * ⭐ 状态卡的三种形态（用户 2026-09 定）：
     *    · 'loading'  —— 身份还没解析完（store.session === 'pending'）⇒ 骨架
     *    · 'data'     —— 有用户（store.userInfo 非空）⇒ 三格数字
     *    · 'unknown'  —— 问不到（断网 / 后端没起来）⇒ 「重新连接」，**不画「未加入」**
     *    · 'unjoined' —— 服务端明确说库里没有我这一行 ⇒ 「未加入」+ 加入按钮
     * ⚠️⚠️ 'unknown' 与 'unjoined' 绝不能合并：前者是"不知道"，后者是"确定没有" ——
     *    把断网画成"你还没加入"，有账号的老用户会以为账号没了。
     */
    statusMode: 'loading' as 'loading' | 'data' | 'unknown' | 'unjoined',

    /**
     * ⭐ 「开始挑战」正在确认身份（见 onStart）—— 那几秒里把按钮写成「确认中…」。
     * ⚠️ 必须有这个反馈：本机没身份时那一次静默登录可能等几秒，
     *    期间按钮毫无变化，用户只会以为点了没反应，然后连点。
     */
    starting: false,

    /**
     * ⭐ 状态卡上的三个数。
     *
     * ⚠️ 拿不到时是 null（整张卡不渲染），**不是**三个 0 ——
     *    对刚打开的老用户来说，「0 句 / 0 次」是**错的**，
     *    而错的数字比没有数字更糟：他会以为记录丢了。
     */
    stats: null as StatsView | null,
    today: null as CardView | null,
    /** ⭐ 最新上线：句库按上线时间倒序的最新几句（服务端给，端侧只剔掉今日重复的那句） */
    latest: [] as CardView[],
    /** 成长榜里没头像时用它（与 nav-bar / arena 榜同一张本地占位图） */
    avatarPlaceholder: '/assets/avatar-placeholder.png',
    /**
     * ⭐ 正在播的是哪一句（articleId）。空串 = 没在播。
     *
     * ⚠️ 用 **articleId** 而不是「第几张卡」：7 天里大概率好几天是同一句，
     *    按卡片记的话，点一张卡播的却是另一张卡的按钮亮着。
     */
    playingArticle: '',
    /**
     * ⭐ 正在**取音**的是哪一句（还没出声）。与 playingArticle 分开：
     *    取地址 + 落本地的那段窗口显示 spinner，而不是让它看起来已经在播。
     */
    loadingArticle: '',
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
  /**
   * ⚠️ `today` **可空**：公开列表接口（`/api/articles/latest`）**不返回它**
   *    （2026-09 随 `schedules` 表一起删）—— 今日那一句只由公开推荐接口
   *    `GET /api/articles/today` 给（可匿名调用）。首屏先只画 `latest`，今日卡等推荐回来再填。
   *
   * ⚠️ 卡片里**没有日期**：挑战归哪一天由服务端在受理提交时决定。
   *    响应信封上那个 `date` 只用来判"缓存是不是今天的"（见 store 的 cachedToday /
   *    cachedLatestCards），不往页面上带。
   */
  cards: null as { today: ArticleCard | null; latest: ArticleCard[] } | null,

  /** store 退订函数 */
  unsubStore: null as (() => void) | null,

  /**
   * 上一次见到的身份状态 —— 用来把"该补一次参与状态"钉在**状态跃迁**上，
   * 而不是"每次广播"（那会自激，见 onLoad 里订阅那段说明）。
   */
  lastSession: 'pending' as SessionState,

  /**
   * 页面已销毁 —— 「开始挑战」里那次确认身份是异步的（见 onStart），
   * 回来时页面可能已经没了（用户跳走 / 退出）。判活用，别往销毁的页面上写。
   */
  gone: false,

  onLoad() {
    // ⚠️ 在 onLoad 里取：它赶得上首帧渲染，不会先顶到状态栏再跳下来
    this.setData({ navTop: navPadTop() })

    /**
     * ⭐ 打开右上角「转发 / 分享到朋友圈」菜单（与 pages/profile 同一套）。
     * ⚠️ 菜单只是入口，真正决定分享内容的是 onShareAppMessage / onShareTimeline；
     *    不调它、也不开页面 json 的 enableShareAppMessage，右上角就没有「转发」。
     */
    wx.showShareMenu?.({ menus: ['shareAppMessage', 'shareTimeline'] })

    /**
     * ⭐ 订阅全局「我的记录」：朗读页打完分写进去，这里立刻重画。
     *    ⚠️ 这是「提交完返回首页不更新」的根治手段 ——
     *       它不依赖 onShow 的时机，也不要求首页还在页面栈里。
     *
     * ⚠️⚠️⚠️ **回调里绝不取数**（2026-09 真实踩过，无限请求 `/api/stats/*`）：
     *    这里原来还调了 `fillCardData()`，而它调的 `ensureStats` **每次都重新拉**、
     *    且写完 store 就 `commit` ⇒ 广播 → 回调 → 再拉 → 再广播 …… 一条自激风暴。
     *    （`ensureParticipation` 有 `loaded` 短路所以那一半没事，统计那一半没有。）
     *    ⇒ 订阅只负责**重画**；取数一律由明确的加载路径负责（onLoad / onShow / 卡片刷新）。
     *
     * ⚠️ 唯一需要的"补一次"是**身份刚解析出来**那一次：卡片与 `/me` 是两条并发线，
     *    卡片先回来时那次参与状态拉取会因为"还不知道我是谁"而空转（见 fillCardData）。
     *    ⇒ 判据是 **session 变了**，不是"广播了" —— 这样它一辈子只可能多跑一次。
     */
    this.unsubStore = me.subscribe((s) => {
      this.render()
      if (this.lastSession !== s.session) {
        this.lastSession = s.session
        if (s.session === 'ready') this.fillCardData()
      }
    })

    /**
     * ⭐ 先用**上次那一屏卡片**把首屏画出来，再照常去刷新。
     *
     * ⚠️ 为什么：云托管缩容到 0 之后，第一次请求要硬等 9~25 秒
     *    （见 client.ts 的 LAUNCH_BUDGET_MS）。那段时间不该是一片空白 ——
     *    卡片内容本身一天只变一次，把上次那一屏先画出来几乎总是对的。
     * ⚠️ 跨天的缓存会被 cachedLatestCards() 丢掉（见它的说明），
     *    所以这里拿到的要么是当天的、要么是 null。
     */
    const cached = me.cachedLatestCards()
    /** ⭐ 今日卡也有自己的缓存（按响应里的 `date` 判过期）——冷启动时它才是首屏主角 */
    const cachedToday = me.cachedToday()
    if (cached || cachedToday) {
      this.cards = { today: cachedToday?.item ?? null, latest: cached?.items ?? [] }
      /**
       * ⚠️ 有缓存的那几块**直接算已加载**（骨架不闪）：缓存是"上一次已经拿到的数据"，
       *    先把它画出来，再照常去刷新 —— 骨架只代表"从没有过数据"。
       */
      this.setData({ latestLoading: !cached, todayLoading: !cachedToday })
      this.render()
      // ⭐ 缓存里的这一屏也要补参与状态（身份可能还没解析完，见 fillCardData）
      this.fillCardData()
    }

    /**
     * ⚠️ 三块是**并发**写的，谁都可能先回来（`loadToday` 可能早于 `loadLatest`）——
     *    所以这个容器必须先存在，不能等某一块的响应去创建它。
     */
    if (!this.cards) this.cards = { today: null, latest: [] }

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
  /**
   * 状态条上那个「加入」—— 进补昵称 / 头像那一页。
   *
   * ⚠️ 它**不是登录**：账号（openid）是静默拿到的，不点也照样能读能存分，
   *    这一页只决定「榜上显示成什么」（同 lib/join.ts 的说明）。
   */
  onJoin() {
    /**
     * ⚠️ 这一颗是**用户明确要加入** ⇒ 用 retryAuth()：先再确认一次身份
     *    （可能只是启动那次没问到），确实还没加入就跳加入页 ——
     *    那时候跳是对的，因为他自己就是要去做这件事（见 lib/auth 的说明）。
     */
    void retryAuth()
  },

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
   *    （这正是这个入口当初没做的原因，见 ArticleCard.audio 的注释。）
   * ⚠️ 再点一次 = 停：同一句的按钮就是开关，不需要额外的停止控件。
   * ⚠️ 走**和朗读页同一条**取音路径（ensureLocalAudio 优先本地），
   *    所以同一句第二次点会是秒出声。
   */
  async onPlayAudio(e: WechatMiniprogram.CustomEvent<{
    articleId: string
    audio: { full: string; kind: 'cloud' | 'http' } | null
  }>) {
    const articleId = e.detail.articleId ?? ''
    const full = e.detail.audio?.full
    if (!articleId || !full) return

    // 再点一次 → 停（stopAudio 是全局唯一那个播放器）
    if (this.data.playingArticle === articleId) {
      stopAudio()
      this.setData({ playingArticle: '' })
      return
    }
    // ⚠️ 取音途中再点同一句 = 取消：还没出声，停不下来，只能别再播（见下面那道检查）
    if (this.data.loadingArticle === articleId) {
      this.setData({ loadingArticle: '' })
      return
    }

    const kind = e.detail.audio?.kind === 'cloud' ? 'cloud' : 'http'
    // ⚠️ 先点亮 loading 再取音：取音这一步在弱网下要等一下，
    //    不给反馈的话用户会以为没点上，然后连点好几下。
    this.setData({ loadingArticle: articleId, playingArticle: '' })
    try {
      const src = await ensureLocalAudio(full, kind)
      if (!src) throw new Error('拿不到标准音')
      // ⚠️ 等待期间用户可能取消了 / 点了另一句 —— 那就别再出声
      if (this.data.loadingArticle !== articleId) return
      this.setData({ loadingArticle: '', playingArticle: articleId })
      await playAudioUrl(src, '标准音', () => {
        // ⚠️ 只在「还是这一句在播」时清掉标记：用户可能在播放期间点了另一句
        if (this.data.playingArticle === articleId) this.setData({ playingArticle: '' })
      })
    } catch (err) {
      if (this.data.loadingArticle === articleId) this.setData({ loadingArticle: '' })
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

  /**
   * ⭐ 转发给好友 —— 卡片图是 SHARE_IMAGE（见文件头），落地页就是首页本身。
   * ⚠️ 文案只从 brand.ts 取（BRAND.pitch），不在这里另写一句 ——
   *    同一句定位散着写必然漂移，见 brand.ts 的说明。
   * ⚠️ 首页不带参数，所以 path 写死、也没有要带过去的状态。
   */
  onShareAppMessage() {
    return { title: BRAND.pitch, path: '/pages/index/index', imageUrl: SHARE_IMAGE }
  },

  /**
   * ⭐ 分享到朋友圈 —— 与转发同一张图、同一句文案。
   * ⚠️ 朋友圈这条**不能用 path**（永远是当前页），参数只能走 query；
   *    首页没有参数，所以连 query 都不用给。
   */
  onShareTimeline() {
    return { title: BRAND.pitch, imageUrl: SHARE_IMAGE }
  },

  onUnload() {
    // ⚠️ 必须退订：不退的话页面销毁后回调还在跑，里面一句 setData 就报错
    this.unsubStore?.()
    this.unsubStore = null
    // ⚠️ 还有一件异步的事在做：「开始挑战」里那次确认身份（见 onStart）——
    //    它回来时页面可能已经没了，那句 setData 会被拦在 gone 上
    this.gone = true
  },

  /**
   * ⭐⭐ 首屏加载 —— **三块各自独立**（用户 2026-09 定：分块异步 + 共用骨架）。
   *
   * ⚠️⚠️ 为什么不再是一个大 load()：四块的到达时间完全不同（当天推荐要现算、
   *    榜单最重、最新上线最快）。合成一个 try 的后果是**最慢的那块决定整页**，
   *    而且任何一块失败都会把整页打成错误页 —— 榜单挂了不该让人看不见今天读哪句。
   *    ⇒ 每块自己负责 loading / error，失败**只影响自己那一块**。
   *
   * ⚠️ 并发仍用一个 requesting 挡：onLoad 与 onShow 在启动时会前后脚触发，
   *    不挡就会把三块各打两遍。
   */
  async load() {
    if (this.requesting) return
    this.requesting = true
    try {
      // ⚠️ 三块**并发**跑、互不 await：谁先回来谁先画（各自 setData）
      await Promise.all([this.loadLatest(), this.loadToday()])
    } finally {
      this.requesting = false
    }
  },

  /**
   * 块 ③：最新上线（公开接口 `GET /api/articles/latest`）。
   *
   * ⚠️ 顺带刷一次「我是谁」：状态卡那两个累计数只有 `/me` 有，而它们刚在朗读页变过。
   *    不 await、失败只警告（它供的是状态卡，不该拖住列表这一块）。
   */
  async loadLatest() {
    if (this.gone) return
    this.setData({ latestError: '' })
    // ⚠️ 已经有内容时不回到骨架 —— 刷新是「就地换数字」，不是「整块白一下」
    if (!(this.cards && this.cards.latest.length > 0)) this.setData({ latestLoading: true })
    try {
      const d = await fetchLatestCards()
      // ⭐ 先把公开内容写进 store（广播给所有页面），再本地重画一次
      me.applyLatestCards(d)
      /**
       * ⚠️⚠️ **服务端可能比端侧旧** —— 这里必须容错，不能直接 `d.items.map()`。
       *
       *    真实事故（2026-09-28 真机预览）：服务端把那个列表字段改过名
       *    （`history` → `latest`，后来又并成 `items`），而 dev 云托管上
       *    还跑着旧版本 —— 旧包里根本没有端侧要读的那个字段。
       *    于是 `d.latest.map(...)` 当场抛 **「undefined is not an object」**：
       *      · 报错信息里一个字都没提字段名与版本，看着像我们自己的代码坏了；
       *      · 开发者工具里一切正常（它打的是本机 Docker，那份是当前代码），
       *        只有真机（打云托管 dev）才炸 —— 极易被误判成「真机特有问题」。
       *    ⇒ 端侧发版与服务端发版是**两条独立的节奏**，端侧对新增字段一律当**可选**，
       *      缺了就少一段列表，页面照常可用。
       */
      const latest = d.items ?? []
      this.cards = { today: this.cards?.today ?? null, latest }
      if (this.gone) return
      this.setData({ latestLoading: false })
      this.render()
      // ⭐ 列表出来之后再拉这一屏的参与状态（用户 2026-09 口径：所有列表都走这条）
      this.fillCardData()
    } catch (err) {
      if (this.gone) return
      this.setData({ latestLoading: false, latestError: this.explainError(err) })
    }
    // ⚠️ 资料只是让状态卡更新，不该拖住列表：不 await，回来自己重画
    void refreshMe().then(() => this.render())
  },

  /**
   * 块 ②：今日卡（公开接口 `GET /api/articles/today?uid=`）+ **这一句的参与状态**。
   *
   * ⚠️⚠️ 参与状态按用户 2026-09 的口径走 **`GET /api/user/participation/{articleId}`**
   *    （不再是列表接口 + arena-records 融合），拉到之后存进**全局 store**
   *    （见 lib/participation 与 store 的 applyParticipation），页面只负责拉完重画。
   */
  async loadToday() {
    if (this.gone) return
    this.setData({ todayError: '' })
    if (!this.cards?.today) this.setData({ todayLoading: true })
    try {
      const t = await fetchToday()
      // ⭐ 存进 store：它同时是**冷启动首屏缓存**（按 t.date 判过期，见 cachedToday）
      me.applyToday(t)
      if (this.gone) return
      this.cards = { today: t.item, latest: this.cards?.latest ?? [] }
      this.setData({ todayLoading: false })
      this.render()
      // ⭐ 再拉这一屏句子的参与状态；到了写 store 并重画（并发去重在 lib 里做）
      this.fillCardData()
    } catch (err) {
      if (this.gone) return
      this.setData({ todayLoading: false, todayError: this.explainError(err) })
    }
  },

  /**
   * ⭐⭐ 把**这一屏句子**的两份"我的/全场"数据补上 —— **幂等、可反复调**。
   *
   *   · 我的参与状态（`lib/participation` → `/api/user/participation/{id}`，写 store）
   *   · 全场参与统计（`lib/stats` → `/api/stats/participation` + `/api/stats/favorite-count`，写 store）
   *
   * ⚠️⚠️ 为什么需要它（真实竞态）：身份解析（`/me`）与卡片列表是两条并发网络线，
   *    **卡片可能先回来**。那一刻 `store.session` 还是 'pending'，`ensureParticipation`
   *    按规矩什么都不写（不知道我是谁，不能替我下"没参与"的结论）——
   *    于是卡片上的「已参与」描边 / 按钮文案会一直停在默认态，直到用户手动下拉刷新。
   *    ⇒ 每次 store 广播（身份解析完、打完分…）都补问一次。
   *
   * ⚠️ 两份**分开拉、各自写 store**：参与状态按用户（鉴权）、统计是公开聚合，
   *    失败互不影响。统计那边**每次都重新拉**（活数，不能缓存住）。
   */
  fillCardData() {
    const ids: string[] = []
    if (this.cards?.today) ids.push(this.cards.today.articleId)
    for (const x of this.cards?.latest ?? []) ids.push(x.articleId)
    if (ids.length === 0) return
    // ⚠️ 判活：这批请求可能在页面销毁之后才回来，别往销毁的页面上 setData
    void ensureParticipation(ids).then(() => {
      if (!this.gone) this.render()
    })
    // ⚠️ 一次拿齐这一屏的**全部统计**（参与 + 收藏）：两条接口都是按 ids 批量、
    //    形状一样，所以合成一次调用（见 lib/stats.ts）。读完靠 store 广播重画。
    void ensureStats(ids).then(() => {
      if (!this.gone) this.render()
    })
  },


  /**
   * 重画 —— 把「服务端卡片」与「store 里的我的参与状态」拼成展示视图。
   *
   * ⭐ 所有与「我」有关的字段（已参与 / 已挑战几次 / 按钮文案）**只从 store 取**，
   *    不再读卡片上那份 —— 否则同一个事实会有两个来源，
   *    而它们更新时机不同，必然出现「卡片说没参与、store 说有」。
   */
  render() {
    const c = this.cards ?? { today: null, latest: [] }
    const st = me.getState()
    /**
     * ⭐⭐ 状态卡的形态由**全局 store**决定（用户 2026-09 定：空用户 = 未加入，
     *    有用户 = 用户数据）。四态见 data.statusMode 的说明。
     * ⚠️ 与导航栏那一格用**同一个判据**（store 的 hasJoined / session）——
     *    两处各判一套必然出现「导航栏说没加入、状态卡却在显示 0 场」。
     */
    const statusMode: 'data' | 'unjoined' | 'loading' | 'unknown' = st.userInfo
      ? 'data'
      : st.session === 'ready'
        ? 'unjoined'
        : st.session === 'pending'
          ? 'loading'
          : 'unknown'
    /**
     * ⚠️ 最新上线里要剔掉**今日推荐命中**的那一句：推荐是从同一句库里选的，
     *    很可能正好是刚上线的最新那一句 —— 不剔首页就会出现两张一模一样的卡。
     *    ⚠️ `c.today` 可能还没有，过滤条件必须容忍它（否则读 `.articleId` 就抛）。
     */
    const today = c.today ? this.toView(c.today, true) : null
    this.setData({
      statusMode,
      stats: statusMode === 'data' ? statsOf(st.userInfo, st.userInfo?.streak ?? null) : null,
      today,
      /**
       * ⚠️ `?? []` 不是多余的：c 可能来自**上次启动落下的缓存**，
       *    而那份缓存是更早的端侧版本写的（那时这个字段还叫 history）——
       *    少了这层兜底，首页会在「读取缓存」这条路上白屏，且毫无线索。
       */
      latest: (c.latest ?? [])
        .filter((x) => !c.today || x.articleId !== c.today.articleId)
        .map((x) => this.toView(x, true)),
    })
  },

  /**
   * 卡片 → 展示视图。
   *
   * ⚠️ 这里**没有日期**（2026-09 统一）：挑战归哪一天由服务端在受理提交时决定，
   *    端侧不再把它从响应里搬运到朗读页。
   *
   * @param withParticipation 要不要带「我参没参与」。**今日卡与最新上线都带**
   *   （用户 2026-09 口径：所有句子列表都拉 `/api/user/participation/{id}`）——
   *   list 形态的 arena-card 用 `joined` 画那圈「读过」的描边（没有药丸、也不占位），
   *   所以列表卡片同样需要它，不能只给今日卡。
   */
  toView(card: ArticleCard, withParticipation: boolean): CardView {
    // ⭐ 「我」的部分一律来自全局 store（写入方是 lib/participation）
    const mine = withParticipation ? me.participationOf(card.articleId) : null
    /**
     * ⚠️ 参与过 = **这一句上有一条参与记录**（服务端按 (我, 这一句) 存的）。
     *    `mine.loaded === false`（还没拉到）时按"未参与"画 —— 但那只是默认值，
     *    拉回来会重画（见 hintOf 对"没拉到"的处理：不编结论性的文案）。
     */
    const joined = !!mine?.record
    /**
     * ⚠️⚠️ 「N 人参与」**不在卡片上**（用户 2026-09 定：L1 解耦）——
     *    它来自 `GET /api/stats/participation`，见 lib/stats 与 store 的 articleStats / articleFavoriteCounts。
     *    没拉到就按 0 画（= 那行字不出现），拉到之后 store 广播会重画。
     */
    const stats = me.getArticleStats(card.articleId)
    return {
      articleId: card.articleId,
      theme: card.theme,
      header: true,
      text: card.text,
      translation: card.translation,
      stat: statText(stats?.participantCount ?? 0),
      joined,
      audio: card.audio ? { full: card.audio.full, kind: card.audio.kind } : null,
      durationMs: card.audio ? card.audio.durationMs : null,
      hint: mine ? hintOf(mine) : '',
      // ⚠️ 正在确认身份（见 onStart）时按钮换一句 —— 那几秒不能毫无反馈
      action: this.data.starting ? '确认中…' : startButtonLabel(joined),
    }
  },


  /** 下拉刷新 / 整页重试：三块一起重来 */
  onRetry() {
    void this.load()
  },

  /** 块 ③ 自己的重试（最新上线的错误卡上那颗按钮） */
  /** ⭐ 去浏览句库（公开页）—— 「最新上线」那一段标题右边的入口 */
  onOpenBrowse() {
    goPublic(ROUTES.browse.url)
  },

  /** ⭐ 去看全部标签（公开页）—— 「最新上线」那串卡片底下的入口 */
  onOpenTags() {
    goPublic(ROUTES.tags.url)
  },

  onRetryLatest() {
    void this.loadLatest()
  },

  /** 块 ② 自己的重试 */
  onRetryToday() {
    void this.loadToday()
  },

  /**
   * 状态卡「重新连接」——**只再问一次「我是谁」**，问到"未加入"就画未加入。
   * ⚠️ 刻意**不跳加入页**：这一格表达的可能是"断网了再试一次"，
   *    而加入是用户自己的另一个动作（导航栏那一格才是明确要加入）。
   */
  onReconnect() {
    void refreshMe().then(() => this.render())
  },

  /**
   * 把底层错误翻译成**用户能动手**的一句话（带 code 的那层分流）。
   * ⚠️ 不展示技术细节（那些在服务端 /health 里）—— 页面上的技术细节只会让人更困惑。
   */
  explainError(err: unknown): string {
    const e = err as { code?: string; message?: string }
    /**
     * ⚠️⚠️ 冷启动（云托管缩容到 0）**不是网络故障**，不能说成「连不上服务器」——
     *    那会让人去查手机网络，而真正要做的是等平台把实例拉起来（或再点一次重试）。
     *    client 已经把这种情况标成 ApiError.code = 'COLD_START'。
     */
    if (e?.code === 'COLD_START') {
      return '服务正在唤醒（云托管缩容后首次打开约需 30 秒），点「重试」'
    }
    return this.explain(e?.message || String(err))
  },

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
  onOpenDetail(e: WechatMiniprogram.CustomEvent<{ articleId: string }>) {
    /**
     * ⚠️⚠️ 竞技场按**句子**寻址，不按日期：
     *    日期只是「编辑精选的容器」，同一句会被排到很多天 ——
     *    按日期进等于把「这一句的榜单」绑在某一天上，而那件事从来没成立过。
     */
    // ⭐ articleId 是内容 hash（字符串）—— 原样取，**不再 Number()**
    const articleId = e.detail.articleId ?? ''
    if (!articleId) return
    goPublic(ROUTES.arena.url + '?article=' + articleId)
  },

  /**
   * ⭐⭐ 开始 / 再次挑战 —— 先过**身份那一关**，再跳朗读页（用户 2026-09 定）。
   *
   * ⚠️⚠️ 为什么这里必须拦：
   *    本机没身份 = **服务端库里没有我这一行**（`userInfo === null`）。那时用户
   *    读得再认真，成绩也**没有归属** —— 分数、榜单、成长值全挂在 user_id 上：
   *      · 录音上传路径 `audio/{句子id}/{uid}/…` 里的 uid 非法，上传必失败；
   *      · 就算传上去了，那条提交也不属于任何人。
   *    ⇒ "让他先读、提交时再说"是错的：他会花 20 秒读一遍、再等上传，然后一无所获。
   *
   * ⚠️⚠️ **这里不再"顺手注册"**（2026-09 用户定：注册不能做成自动的）。
   *    以前 ensureAuthed() 会静默登录一次，而那一步在服务端会**建行** ——
   *    于是"点开始挑战"就等于"替你注册了"。现在没身份只会**跳加入页**，
   *    建行只发生在那一页按下「确认加入」时（见 profile-form 的 register 模式）。
   *
   * ⚠️ 拦的**不是**"起没起名字"（昵称/头像）：那件事随时能补、也不影响成绩归属
   *    （见 pages/join 与 lib/auth.ts 的说明）。
   */
  async onStart(e: WechatMiniprogram.CustomEvent<{ articleId: string }>) {
    const articleId = e.detail.articleId
    if (!articleId) return
    // ⚠️ 连点保护：确认身份的那几秒里按钮还在，重复点会打出好几次 /me
    if (this.data.starting) return

    // ⚠️ 已经有身份就不折腾界面：老用户点一下直接走（一次网络都不发）
    if (isAuthed()) {
      this.goReading(articleId)
      return
    }

    // ⚠️ 立刻重画一次：按钮要从「开始挑战」变成「确认中…」——
    //    toView 只在 render() 里跑，不重画的话这几秒界面上什么都没变
    this.setData({ starting: true })
    this.render()
    /**
     * ⭐ 走**通用的 auth 中间函数**（`lib/auth.ts`，用户 2026-09 定的用法）：
     *    · 'joined'     —— users 里有我这一行，放行；
     *    · 'not-joined' —— 服务端说库里没有我，它**已经跳了加入页**（注册在那一页）；
     *    · 'unknown'    —— 没问到（断网 / 后端没起来），**什么都没做**，给一句提示。
     */
    const auth = await ensureAuthed()
    // ⚠️ 页面可能已经被跳走了 —— 那 setData 会打在隐藏页上，无害但不必要
    //    ⚠️ 也要把按钮文案还原：失败后用户还停在这一页，卡在「确认中…」会像坏了
    if (!this.gone) {
      this.setData({ starting: false })
      this.render()
    }
    if (auth === 'joined') {
      this.goReading(articleId)
    } else if (auth === 'unknown') {
      // ⚠️ 没问到 —— 说一句能做什么（'not-joined' 那条路 auth 已经把人带去加入页了）
      wx.showToast({ title: AUTH_RETRY_HINT, icon: 'none', duration: 2500 })
    }
  },

  /**
   * 进朗读页（开始挑战的唯一出口）。
   * ⚠️ **不带日期**：挑战归哪一天由服务端在受理提交时决定（见 lib/api/client 的 submitReading）。
   *    只有「回到某一天再挑战」（参与记录进来的那条路）才由朗读页自己带上 `?date=`。
   */
  goReading(articleId: string) {
    void go(ROUTES.reading.url + '?id=' + articleId)
  },
})
