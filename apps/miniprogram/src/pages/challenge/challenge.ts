import {
  alignWordScores,
  formatScore,
  plainWordsOf,
  resolveTheme,
  today,
  wordLevel,
  WORD_GREEN_LINE,
  WORD_RED_LINE,
} from '@jushuo/shared'
import type {
  ChallengeShareResponse,
  LeaderboardRow,
  ScoreParts,
  StreakDelta,
  SubmissionAudioRef,
  SubmitResponse,
} from '@jushuo/shared'

import {
  fetchSubmissionAudio,
  fetchSubmissionShare,
  fetchSubmissionStatus,
  setSubmissionVisibility,
} from '../../lib/api/client'
import { refreshMe } from '../../lib/join'
import * as me from '../../lib/store'
import { playAudioUrl, stopAudio } from '../../lib/audio/play'
import { ensureLocalAudio } from '../../lib/audio/standard'
import { navPadTop } from '../../lib/nav'
import { agoText } from '../../lib/time'

/**
 * ⭐ 「挑战结果」页 —— **一屏装下一次挑战的全部结果**。
 *
 * ⭐⭐ 它是**公开页面**（同个人主页 / 竞技场 / 首页）：`?sid=<提交 id>` 就是地址，
 *    谁来打开都走**同一个公开接口**取同一份数据 —— 不分「本人视角 / 访客视角」两条取数路径。
 *    「谁在看」只在**端侧**决定播放按钮能不能点（服务端只把地址统一给出来）：
 *      · 录音地址：服务端**无条件**给 —— 分享卡片即凭据（见 isShareCardEntry）
 *      · canPlay：isOwner || isPublic || 从分享卡片进来（见 computeCanPlay）
 *      · isOwner：owner.id 跟本地 userInfo.id 比出来（标题 / 开关 / 按钮文案）
 *      · 未出分的状态**只有本人**拿得到（别人拿到 404）
 *
 * ⚠️⚠️ 为什么单独一页，而不是塞在朗读页里：
 *    朗读页是「录音 → 提交」的状态机（麦克风、波形、上传进度、轮询）；
 *    这一页是「一次已完成的挑战」，而且要能被**陌生人打开**。
 *    混在一起时，回看与分享都得在录音状态机里绕开一半分支 ——
 *    而分享页最不能出的问题就是「点进来发现是个录音页」。
 */

/** 五个分项 —— 顺序对应总分公式里的权重（由大到小） */
type PartKey = 'prosody' | 'weakness' | 'accuracy' | 'fluency' | 'completeness'
const PART_META: { key: PartKey; label: string }[] = [
  { key: 'prosody', label: '语调' },
  { key: 'weakness', label: '咬字' },
  { key: 'accuracy', label: '发音' },
  { key: 'fluency', label: '流利' },
  { key: 'completeness', label: '完整' },
]

interface WordView {
  i: number
  text: string
  cls: string
}

interface DimensionView {
  key: string
  label: string
  value: string
  pct: number
  textCls: string
  barCls: string
}

/**
 * ⭐ 「从挑战详情的分享卡片进来」的场景值 —— 分享卡片就等同于用户明确的分享动作，
 *    所以从这几条路进来的人都能听，不看 isPublic（链接即凭据）。
 *
 * ⚠️ 为什么判 scene 而不是只看 shareTicket：
 *    shareTicket 只在「群聊 + withShareTicket」时才有；
 *    **单人聊天**用的是 scene=1007，根本不带 shareTicket。
 *    场景值见微信官方「场景值列表」。
 *      · 1007 单人聊天会话中的小程序消息卡片
 *      · 1008 群聊会话中的小程序消息卡片
 *      · 1044 带 shareTicket 的小程序消息卡片
 *      · 1014 模板消息（通知卡片）
 */
const SHARE_CARD_SCENES = new Set([1007, 1008, 1044, 1014])

function isShareCardEntry(query: Record<string, string | undefined>): boolean {
  if (query.shareTicket) return true
  const scene = Number(query.scene)
  return Number.isFinite(scene) && SHARE_CARD_SCENES.has(scene)
}

Page({
  data: {
    navTop: 0,
    loading: true,
    error: '',

    /** 这次挑战是谁读的、什么时候 —— 分享出去时这两条很重要 */
    owner: { nickname: '', avatarSrc: '' },
    ago: '',
    /** 看的人就是这条记录的拥有者吗（决定显示哪些操作） */
    isOwner: true,

    result: null as SubmitResponse | null,
    scoreText: '',
    gapText: '—',
    words: [] as WordView[],
    dimensions: [] as DimensionView[],
    /** 成绩详情上面那句总结（最拖后腿的那一项 / 或按逐词说的实话） */
    summary: '',
    leaderboard: [] as (LeaderboardRow & { scoreText: string })[],

    /**
     * ⭐ 这段录音是否公开（「允许公众收听」）。
     * ⚠️ 取服务端回传的权威值；本人可以用下面那个开关改。
     */
    isPublic: false,

    /**
     * ⭐ 播放按钮能不能点 —— **纯前端 OR 判断**（服务端只管把地址统一给出来）：
     *      isOwner  ||  isPublic  ||  从挑战详情的分享卡片进来
     *    全不命中就置灰、点了不播（见 computeCanPlay）。
     */
    canPlay: false,
    playing: false,
    /** 正在取音（还没出声）—— 播放钮显示 loading。⚠️ 与页面级的 loading 区分开 */
    audioLoading: false,

    /** 分享卡片的标题（句子 + 分数，一眼能看懂） */
    shareTitle: '我在句拼读了一句，来比比？',
    /** ⭐ 主题卡的底色 —— 反色按钮的文字色用它（resolveTheme 已处理 theme 缺失的兜底） */
    cardBg: '#4f46e5',
    /** ⭐ 主题卡的前景色 —— switch 这类原生态控件要用它上色 */
    cardFg: '#ffffff',
  },

  /** 这条提交的 id（URL 参数） */
  sid: '',
  /**
   * ⭐ 这段录音的可播地址 —— 直接来自**开放接口**（/:sid 响应里那一份）。
   *    本人和访客同一条路，不再分「本人现取 / 访客用分享包」。
   */
  audioRef: null as SubmissionAudioRef | null,
  /** 这次挑战属于哪一天 —— 排名卡点进竞技场时带上（见 onOpenArena） */
  scheduleDate: '',
  /** ⭐ 这一页是不是从「挑战详情分享卡片」进来的（入口 scene / shareTicket） */
  fromShareCard: false,

  onLoad(query: Record<string, string | undefined>) {
    this.sid = query.sid ?? ''
    this.fromShareCard = isShareCardEntry(query)
    this.setData({ navTop: navPadTop() })

    /**
     * ⭐ 打开右上角「转发 / 分享到朋友圈」菜单。
     * ⚠️ 菜单只是入口，真正决定分享内容的是 onShareAppMessage / onShareTimeline。
     * ⚠️ withShareTicket: true —— 群聊里的分享卡片会带 shareTicket，
     *    它是「这一页是从分享卡片进来的」的判据之一（见 isShareCardEntry）。
     */
    wx.showShareMenu?.({ withShareTicket: true, menus: ['shareAppMessage', 'shareTimeline'] })

    if (!this.sid) {
      this.setData({ loading: false, error: '这条挑战不存在' })
      return
    }
    void this.load()
  },

  onUnload() {
    stopAudio()
  },

  /**
   * ⭐ 取结果 —— **一条主路径**：开放接口按提交 id 取那一份。
   *
   * ⚠️ 无论是我自己打开的、还是别人转发来的，走的都是这个接口、同一条 URL；
   *    「我是不是这条挑战的主人」由响应里的 owner.id 在**端侧**比出来。
   * ⚠️ 未出分时只有**本人**能拿到状态（别人拿到的是 404）——
   *    所以「还在检测中」这句话只会出现在自己的屏幕上。
   */
  async load() {
    this.setData({ loading: true, error: '' })

    /**
     * ⭐ 并行确保「我是谁」拿到 —— owner 判断要用自己的 userInfo.id。
     *    冷启动、缓存为空时它可能还没回来（app.ts 里的 refreshMe 是异步的），
     *    不先拿就直接算会把本人误判成访客（开关不显示、播放被置灰）。
     *    ⚠️ refreshMe 自己吞失败并返回 null，所以拿不到也只是退化成访客视图。
     */
    const identityReady = me.getState().userInfo ? Promise.resolve() : refreshMe()

    /**
     * ⭐ **一条主路径**：开放接口按提交 id 取那一份 —— 结果 + 录音 + owner.id。
     *    本人和访客取的是同一个接口、同一份数据（服务端不再分两条取数路径）。
     */
    try {
      const share = await fetchSubmissionShare(this.sid)
      await identityReady
      this.applyShare(share)
      return
    } catch (err) {
      /**
       * ⚠️ 公开拿不到，多半是「还没出分」。只有**本人**该看到那句「还在检测中」；
       *    别人一律按不存在处理，不暴露「这个 id 存在、但还没成绩」。
       */
      const publicError = err as Error
      try {
        const status = await fetchSubmissionStatus(this.sid)
        if (status.status === 'failed') {
          this.setData({ loading: false, error: status.error ?? '这次挑战没有成绩' })
          return
        }
        if (status.status === 'scored' && status.result) {
          // 极小概率的竞态（两次请求之间刚好出分）：状态接口更权威，用它兜底
          this.applyOwnerResult(status.result)
          return
        }
        this.setData({ loading: false, error: '这次挑战还在检测中，稍后再看' })
      } catch {
        // 状态接口也拿不到（不是本人 / 没登录）⇒ 报公开接口那条错
        this.setData({ loading: false, error: publicError.message })
      }
    }
  },

/**
 * ⭐ 开放接口的结果 → 展示视图（本人 / 访客**共用这一套**）。
 *
 * ⚠️ 「是不是本人」由 owner.id 跟本地 userInfo.id 比出来 ——
 *    服务端不再分两条取数路径，只有「你恰好是主人」这一个事实。
 */
  applyShare(share: ChallengeShareResponse) {
    const result = share.result
    const myId = me.getState().userInfo?.id ?? 0
    const isOwner = myId > 0 && share.owner.id === myId
    this.audioRef = share.audio
    this.setData({
      isOwner,
      owner: { nickname: share.owner.nickname, avatarSrc: share.owner.avatarUrl ?? '' },
      ago: agoText(share.at),
      isPublic: result.isPublic,
      canPlay: this.computeCanPlay(isOwner, result.isPublic, !!share.audio),
    })
    this.renderResult(result, { isOwner })
  },

/**
 * ⚠️ 兜底（极小概率的竞态）：开放接口说没出分、状态接口说出分了。
 *    这时只有本人拿得到状态，所以按本人视图渲染；地址走 onPlay 按需再取。
 */
  applyOwnerResult(result: SubmitResponse) {
    this.audioRef = null
    this.setData({
      isOwner: true,
      isPublic: result.isPublic,
      canPlay: this.computeCanPlay(true, result.isPublic, true),
    })
    this.renderResult(result, { isOwner: true })
  },

/**
 * ⭐ 播放按钮唯一那条规则 —— 纯前端 OR 判断：
 *      isOwner  ||  isPublic  ||  从挑战详情的分享卡片进来
 *    （没有地址时一律不能播：失败的提交会被服务端连录音一起删掉。）
 */
  computeCanPlay(isOwner: boolean, isPublic: boolean, hasAudio: boolean): boolean {
    if (!hasAudio) return false
    return isOwner || isPublic || this.fromShareCard
  },

  /** 两种视角**共用**的渲染 —— 同一份结果，两屏长得一样 */
  renderResult(result: SubmitResponse, opts: { isOwner: boolean }) {
    this.scheduleDate = result.scheduleDate ?? ''
    // ⭐ theme 缺失时按 articleId 复算（见 shared/theme.ts 的 resolveTheme）——
    //    与后台详情页同一个结论，不再各自兜一个品牌色
    const card = resolveTheme(result.theme, result.articleId)
    this.setData({
      loading: false,
      error: '',
      result,
      cardBg: card.background,
      cardFg: card.foreground,
      scoreText: formatScore(result.score),
      gapText: result.gapToPrev === null ? '已是第一' : result.gapToPrev + ' 分',
      words: this.renderWords(result.text ?? '', result.words ?? []),
      dimensions: this.renderParts(result.parts),
      summary: this.buildSummary(result),
      leaderboard: result.leaderboard.map((r) => ({ ...r, scoreText: formatScore(r.score) })),
      isOwner: opts.isOwner,
      shareTitle: this.buildShareTitle(result),
    })
  },

  /**
   * ⭐ 成绩详情上面那句总结。
   * ⚠️ 优先用「最拖后腿的那一项」那句话（它直接说明该练什么）；
   *    五项都够好时，退回一句按**逐词结果**说的实话 ——
    总比留一句空洞的「表现不错」强。
   */
  buildSummary(result: SubmitResponse): string {
    const weak = this.partHint(result.parts)
    if (weak) return weak
    const scored = result.words ?? []
    if (scored.length === 0) return ''
    const bad = scored.filter((w) => w.dp !== 'normal').length
    if (bad > 0) return bad + ' 个词读错或漏读'
    const green = scored.filter((w) => w.score >= WORD_GREEN_LINE).length
    return green === scored.length ? '每个词都读准了' : '部分单词发音还不够准'
  },

  buildShareTitle(result: SubmitResponse): string {
    const s = formatScore(result.score)
    const text = (result.text ?? '').trim()
    return text
      ? '我在句拼读「' + text + '」拿了 ' + s + ' 分，你来试试？'
      : '我在句拼拿了 ' + s + ' 分，你来试试？'
  },

  /**
   * 逐词上色。
   * ⚠️ 颜色判据在 @jushuo/shared 的 wordLevel（与挑战列表同一处）；
   *    对齐在 alignWordScores —— 引擎词表可能多一个插入词或漏一个词，
   *    按下标硬套会让从错位处往后**每个词的颜色都是别人的**（见那个函数的说明）。
   */
  renderWords(text: string, scored: { word?: string; score: number; dp?: string }[]): WordView[] {
    const plain = plainWordsOf(text)
    const align = alignWordScores(text, scored.map((w) => w.word ?? ''))
    return plain.map((t, i) => {
      const at = align[i]
      const w = at === null || at === undefined ? undefined : scored[at]
      // ⚠️ 对不上（插入 / 漏读，或老成绩没有逐词）→ 不上色，继承 currentColor，不猜
      // ⚠️ 正常词也继承 currentColor（原来是 text-ink）：卡片换成主题底之后，
      //    固定墨色在深色主题上会看不见 —— 颜色一律跟着 currentColor 走。
      const lvl = w ? wordLevel(w.score, w.dp) : ''
      return { i, text: t, cls: lvl && lvl !== 'ink' ? 'text-' + lvl : '' }
    })
  },

  /**
   * 分项明细 → 展示视图。
   * ⚠️ 拿不到时必须返回空数组让整块不渲染 —— 绝不能补 0：
   *    界面上出现「完整 0」会被理解成「我一个词都没读」（老成绩没有这个字段）。
   */
  renderParts(p?: ScoreParts): DimensionView[] {
    if (!p) return []
    return PART_META.map(({ key, label }) => {
      const v = p[key]
      const level = v < WORD_RED_LINE ? 'bad' : v < WORD_GREEN_LINE ? 'warn' : 'ok'
      return {
        key,
        label,
        value: formatScore(v),
        pct: Math.max(0, Math.min(100, v)),
        textCls: 'text-' + level,
        barCls: 'bg-' + level,
      }
    })
  },

  /** 给五个数字配一句「所以呢」—— 说出最拖后腿的那一项（完整度优先） */
  partHint(p?: ScoreParts): string {
    if (!p) return ''
    if (p.completeness < 90) return '这次有漏读或读成了别的词 —— 先把整句读完，再谈发音'
    const items = [
      { v: p.prosody, text: '语调偏平：重音和升降调还没出来，听着像在念字' },
      { v: p.weakness, text: '咬字不匀：大部分词清楚，但有几个词明显没读准' },
      { v: p.accuracy, text: '发音有硬伤：有几个音素不对，跟着音标单独纠' },
      { v: p.fluency, text: '流利度偏低：词与词之间卡顿多，先顺下来再求准' },
    ]
    const worst = items.reduce((a, b) => (b.v < a.v ? b : a))
    return worst.v < WORD_GREEN_LINE ? worst.text : ''
  },

  /**
   * ⭐ 试听。
   *
   * ⚠️ 播的是**服务端那份录音**，不是本机文件 —— 分享给别人的那一屏也要能听，
   *    而对方的手机里根本没有这段录音。
   * ⚠️ 地址来自**开放接口**那一份（applyShare 已经拿到），不再分本人 / 访客；
   *    只有竞态兜底那条路手上没有地址时，才按需去 /:sid/audio 取一次。
   * ⚠️ 能不能点由 computeCanPlay 说了算 —— 置灰时这里直接 return，不播。
   */
  async onPlay() {
    if (this.data.playing) {
      stopAudio()
      this.setData({ playing: false })
      return
    }
    if (!this.data.canPlay) return
    // ⚠️ 取音途中再点 = 什么都不做：还没出声，停了也得等请求回来，叠两个请求更糟
    if (this.data.audioLoading) return

    this.setData({ audioLoading: true })
    try {
      const ref = this.audioRef ?? (await fetchSubmissionAudio(this.sid)).audio
      if (!ref) throw new Error('这段录音已经没有了')
      const path = await ensureLocalAudio(ref.src, ref.kind)
      if (!path) throw new Error('取不到这段录音')
      // ⚠️ loading 一路亮到**真的能出声**为止：取地址 + 落本地都在这一段里，
      //    先亮 stop 再卡住的话，用户会以为「按了停止却没停」
      this.setData({ audioLoading: false, playing: true })
      await playAudioUrl(path, '录音', () => this.setData({ playing: false }))
    } catch (err) {
      this.setData({ audioLoading: false, playing: false })
      wx.showToast({ title: (err as Error).message, icon: 'none', duration: 2000 })
    }
  },

  /**
   * ⭐ 「允许公众收听」开关 —— 只有本人看得到（WXML 里 wx:if="{{isOwner}}"）。
   *
   * ⚠️ 打开 = isPublic=true：**卡片之外的入口**（以后出现的发现类入口）才听得到；
   *    从挑战详情分享卡片进来的本来就能听，不受这个开关影响。
   * ⚠️ 乐观更新 + 失败回滚：开关要立刻跟手；但服务端不认时必须弹回去 ——
   *    否则界面说「已公开」而库里还是私密，用户会以为别人能听，其实不能。
   */
  async onTogglePublic(e: WechatMiniprogram.CustomEvent<{ value: boolean }>) {
    const next = Boolean(e.detail.value)
    const prev = this.data.isPublic
    this.setData({ isPublic: next })
    try {
      const r = await setSubmissionVisibility(this.sid, next)
      this.setData({ isPublic: r.isPublic })
    } catch (err) {
      this.setData({ isPublic: prev })
      wx.showToast({ title: (err as Error).message || '设置失败，请重试', icon: 'none', duration: 2000 })
    }
  },

  /**
   * ⭐ 点赞 —— 产品要求先**预留**在朗读结果卡右侧。
   * ⚠️ 现在给一句实话，而不是让它点了没反应：一个死按钮看起来就是坏了。
   */
  onLike() {
    wx.showToast({ title: '点赞还在做，先记下你的喜欢', icon: 'none', duration: 1800 })
  },

  /**
   * 排名卡**整卡可点** → 竞技场（看这一句的完整榜单）。
   * ⚠️ 竞技场按**日期**取当天的场次（见 pages/arena 的 onLoad），而这一次挑战属于哪一天
   *    只有服务端知道（scheduleDate）—— 客户端不拿本地时钟凑，拿不到就退回今天。
   */
  onOpenArena() {
    const url = '/pages/arena/arena?date=' + encodeURIComponent(this.scheduleDate || today())
    wx.navigateTo({ url, fail: () => wx.reLaunch({ url }) })
  },

  /**
   * 挑战按钮：本人是「再次挑战」，从分享链接进来的人是「我要挑战」——
   * 走的是同一条路（去朗读页读**同一句**），只是文案不同。
   */
  onAgain() {
    const articleId = this.data.result?.articleId
    if (!articleId) return
    const url = '/pages/reading/reading?id=' + articleId + '&date=' + today()
    wx.redirectTo({ url, fail: () => wx.reLaunch({ url }) })
  },

  onRetry() {
    void this.load()
  },

  /** ⭐ 转发给好友 —— 路径就是这一页（带 sid），对方打开看到同一屏 */
  onShareAppMessage() {
    return {
      title: this.data.shareTitle,
      path: '/pages/challenge/challenge?sid=' + this.sid,
    }
  },

  /** ⭐ 分享到朋友圈 —— 朋友圈只能用 query 带参数 */
  onShareTimeline() {
    return {
      title: this.data.shareTitle,
      query: 'sid=' + this.sid,
    }
  },
})
