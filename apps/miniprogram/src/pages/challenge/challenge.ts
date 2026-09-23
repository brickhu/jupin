import {
  alignWordScores,
  formatScore,
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

import { fetchSubmissionShare } from '../../lib/api/client'
import { playAudioUrl, stopAudio } from '../../lib/audio/play'
import { ensureLocalAudio } from '../../lib/audio/standard'
import { navPadTop } from '../../lib/nav'
import { agoText } from '../../lib/time'

/**
 * ⭐ 「挑战结果」页 —— **一屏装下一次挑战的全部结果**。
 *
 * ⭐⭐ 它是**公开页面**（同个人主页 / 竞技场 / 首页）：`?sid=<提交 id>` 就是地址，
 *    谁来打开都走**同一个公开接口**取同一份数据 —— 不分「本人视角 / 访客视角」两条取数路径。
 *    「谁在看」只影响**哪些模块给**（由服务端在同一次请求里决定）：
 *      · 录音：公开的给所有人；**本人的不管公开没公开都给**
 *      · isOwner：导航栏标题与按钮文案据此显示（本人是「挑战结果 / 再次挑战」）
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
    /** '12.3 秒' —— 播放按钮右边那个时长 */
    durationText: '',

    // ⚠️ 按产品要求**去掉**了：公开录音开关（isPublic）、连战信息（streak）。
    //    可见性的默认值仍在服务端，只是不再在这一屏给开关。

    /** 这段录音能不能播（别人的分享链接里，非公开就是 false） */
    canPlay: false,
    playing: false,

    /** 分享卡片的标题（句子 + 分数，一眼能看懂） */
    shareTitle: '我在句拼读了一句，来比比？',
  },

  /** 这条提交的 id（URL 参数） */
  sid: '',
  /** 访客视角的音频地址（分享包里给的；本人是现取的，见 onPlay） */
  audioRef: null as SubmissionAudioRef | null,
  /** 这次挑战属于哪一天 —— 排名卡点进竞技场时带上（见 onOpenArena） */
  scheduleDate: '',

  onLoad(query: Record<string, string | undefined>) {
    this.sid = query.sid ?? ''
    this.setData({ navTop: navPadTop() })

    /**
     * ⭐ 打开右上角「转发 / 分享到朋友圈」菜单。
     * ⚠️ 菜单只是入口，真正决定分享内容的是 onShareAppMessage / onShareTimeline。
     */
    wx.showShareMenu?.({ menus: ['shareAppMessage', 'shareTimeline'] })

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
   * ⭐ 取结果 —— **一条路径**：公开接口按提交 id 取那一份。
   *
   * ⚠️ 无论是我自己打开的、还是别人转发来的，走的都是这个接口、同一条 URL；
   *    「我是不是这条挑战的主人」由服务端在**同一个响应**里给出（isOwner），
   *    录音也一样（公开的给所有人，本人的不管公开没公开都给）。
   * ⚠️ 未出分时只有**本人**能拿到状态（别人拿到的是 404）——
   *    所以「还在检测中」这句话只会出现在自己的屏幕上。
   */
  async load() {
    this.setData({ loading: true, error: '' })

    try {
      const share = await fetchSubmissionShare(this.sid)
      if (!share.result) {
        this.setData({
          loading: false,
          error: share.status === 'failed' ? '这次挑战没有成绩' : '这次挑战还在检测中，稍后再看',
        })
        return
      }
      this.applyShare(share, share.result)
    } catch (err) {
      this.setData({ loading: false, error: (err as Error).message })
    }
  },

  /**
   * 公开接口那一份 → 展示视图（**唯一的渲染入口**）。
   * ⚠️ 录音地址一并给了（本人不受 is_public 限制），所以不再有「本人现取一次」那条分支。
   */
  applyShare(share: ChallengeShareResponse, result: SubmitResponse) {
    this.audioRef = share.audio
    this.setData({
      isOwner: share.isOwner,
      owner: { nickname: share.owner.nickname, avatarSrc: share.owner.avatarUrl ?? '' },
      ago: agoText(share.at),
      isPublic: result.isPublic,
      canPlay: !!share.audio,
    })
    this.renderResult(result, { isOwner: share.isOwner })
  },

  /** 两种视角**共用**的渲染 —— 同一份结果，两屏长得一样 */
  renderResult(result: SubmitResponse, opts: { isOwner: boolean }) {
    this.scheduleDate = result.scheduleDate ?? ''
    this.setData({
      loading: false,
      error: '',
      result,
      scoreText: formatScore(result.score),
      gapText: result.gapToPrev === null ? '已是第一' : result.gapToPrev + ' 分',
      words: this.renderWords(result.text ?? '', result.words ?? []),
      dimensions: this.renderParts(result.parts),
      summary: this.buildSummary(result),
      leaderboard: result.leaderboard.map((r) => ({ ...r, scoreText: formatScore(r.score) })),
      // ⚠️ 时长缺失（老记录没写这一列）→ 空串，而不是显示「0.0 秒」
      durationText: result.durationMs ? (result.durationMs / 1000).toFixed(1) + ' 秒' : '',
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
    const plain = text.split(/\s+/).filter(Boolean)
    const align = alignWordScores(text, scored.map((w) => w.word ?? ''))
    return plain.map((t, i) => {
      const at = align[i]
      const w = at === null || at === undefined ? undefined : scored[at]
      // ⚠️ 对不上（插入 / 漏读，或老成绩没有逐词）→ 留墨色，不猜
      return { i, text: t, cls: w ? 'text-' + wordLevel(w.score, w.dp) : 'text-ink' }
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
   * ⚠️ 地址就来自**同一个公开响应**（本人不受 is_public 限制，见 routes/share.ts）——
   *    所以这里不再有「本人现取一次」那条分支。
   */
  async onPlay() {
    if (this.data.playing) {
      stopAudio()
      this.setData({ playing: false })
      return
    }
    this.setData({ playing: true })
    try {
      const ref = this.audioRef
      if (!ref) throw new Error('这段录音没有公开')
      const path = await ensureLocalAudio(ref.src, ref.kind)
      if (!path) throw new Error('取不到这段录音')
      await playAudioUrl(path, '录音', () => this.setData({ playing: false }))
    } catch (err) {
      this.setData({ playing: false })
      wx.showToast({ title: (err as Error).message, icon: 'none', duration: 2000 })
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
