import { formatScore, startButtonLabel } from '@jushuo/shared'
import type { ArticleTheme, StandardAudio } from '@jushuo/shared'

import {
  fetchArticleParticipations,
  fetchIsFavorite,
  setFavorite,
} from '../../lib/api/client'
import { attachAvatarSrc } from '../../lib/cloud-file'
import { ensureArticleStats } from '../../lib/article-stats'
import { isUnregistered } from '../../lib/auth'
import { loadParticipation } from '../../lib/participation'
import { fetchArticleContent } from '../../lib/content'
import { ensureLocalAudio } from '../../lib/audio/standard'
import { playAudioUrl, stopAudio } from '../../lib/audio/play'
import { navPadTop, notifyNavScroll } from '../../lib/nav'
import { ROUTES, go } from '../../lib/route'
import * as me from '../../lib/store'

/**
 * 朗读挑战页（竞技场）—— 从首页卡片 / 参与场次点进来。
 *
 * ⚠️ 页面构成（用户 2026-09 定的五条，别随手动）：
 *    ① 句子卡（播放 + 收藏）；② 这个句子的**参与概要**；③ **我的参与** + 再读一次；
 *    ④ **排行榜**；⑤ 邀请好友。
 *
 * ⚠️⚠️ **数据分四块、各自异步、各自骨架**（用户 2026-09 定）：
 *    · 句子卡   ← `GET /api/articles/{id}`（**纯句子内容**，全局会话缓存，见 lib/content）
 *    · 参与概要 ← `GET /api/participations/stats?ids=`（**统计不在句子上**，见 lib/article-stats）
 *    · 排行榜   ← `GET /api/participations?articleId=&sort=score&limit=20`
 *    · 我的参与 ← `GET /api/user/participation/{articleId}`（写全局 store，见 lib/participation）
 *    · 收藏     ← `GET /api/user/is-favorite?articleId=`
 *
 * ⚠️⚠️ 为什么不再是一条 `/api/arenas/{articleId}`（2026-09 拆掉）：
 *    那条把"句子内容 + 参与统计 + 榜单 + 我的"揉成一个响应 —— 生命周期完全不同
 *    （内容可缓存、统计每次现算、我的按用户），揉在一起后**任何一块慢/坏都拖住整页**，
 *    而且"句子一删，统计跟着没"。现在拆开之后：**句子打不开也不影响统计与榜单**
 *    （参与数据挂在 `/api/participations` 上，与句子行无关）。
 *
 * ⚠️ 只按句子寻址：`?article=<articleId>`；日期不属于竞技场（见文件头历史注释）。
 */
Page({
  data: {
    /** 根节点要让开的上边距（px）—— 自定义导航栏是浮层，不占文档流（见 lib/nav.ts） */
    navTop: 0,

    /** ⭐ 这一句的 id —— 竞技场的**地址** */
    articleId: '',

    // ── 块 ① 句子卡（纯内容，会话缓存） ──────────────────────
    articleLoading: true,
    articleError: '',
    sentence: null as {
      articleId: string
      header: boolean
      text: string
      translation: string
      theme: ArticleTheme | null
      audio: StandardAudio | null
      durationMs: number | null
    } | null,

    // ── 块 ② 参与概要（全场统计，现算） ──────────────────────
    statsLoading: true,
    statsError: '',
    participantCount: 0,
    topScoreText: '—',
    lowestScoreText: '—',

    // ── 块 ③ 我的参与（全局 store） ─────────────────────────
    mineLoading: true,
    myBest: null as number | null,
    myBestText: '—',
    myRank: null as number | null,
    /** 成品文本：`已挑战 3 回合，最高得分 74.6，位列 2`（WXML 不做计算） */
    mySummary: '',
    myAttempts: 0,
    /** '立即朗读，参与挑战' / '重新朗读，再次冲榜' —— 来自 startButtonLabel，与首页共用 */
    action: '',

    // ── 块 ④ 排行榜（参与资源，公开） ───────────────────────
    lbLoading: true,
    lbError: '',
    leaderboard: [] as {
      rank: number
      nickname: string
      avatarSrc: string
      scoreText: string
      isMe: boolean
    }[],
    /** 参与者总数（来自参与资源，用来显示"共 N 人参与"与分页提示） */
    lbTotal: 0,

    // ── 收藏（句子卡右上那颗星，不是一块数据区） ─────────────
    favLoading: true,
    isFavorite: false,

    /** ⭐ 标准音是不是正在播 / 正在取音（句子卡左上那颗播放钮的状态） */
    playingArticle: '',
    loadingArticle: '',
    /** 榜上没有头像时用它（与 nav-bar / user-sheet 同一张本地占位图） */
    avatarPlaceholder: '/assets/avatar-placeholder.png',
  },

  /** 这一页看的是哪一句（竞技场的地址） */
  entry: { articleId: '' },

  /** 整页并发挡板：onLoad 与 onShow 在启动时会前后脚触发，不挡就会把五块各打两遍 */
  requesting: false,

  /** store 退订函数 */
  unsubStore: null as (() => void) | null,

  onLoad(query: Record<string, string | undefined>) {
    // ⭐ articleId 是内容 hash（字符串）—— 原样取，**不再 Number()**
    this.entry = { articleId: query.article ?? '' }
    this.setData({ navTop: navPadTop(), articleId: this.entry.articleId })
    // ⭐ 订阅全局「我的记录」：朗读页打完分回来，我的成绩与按钮文案立刻是新的
    this.unsubStore = me.subscribe(() => this.render())
    void this.load()
  },

  /** 从朗读页返回时刷新 —— 刚打完的分必须立刻出现在「我的参与」与榜单上 */
  onShow() {
    if (!this.requesting) void this.load()
  },

  onUnload() {
    // ⚠️ 必须退订，否则页面销毁后回调还在跑，里面一句 setData 会报错
    this.unsubStore?.()
    this.unsubStore = null
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    notifyNavScroll(this, e.scrollTop)
  },

  /**
   * ⭐⭐ 五块**并发**加载、互不 await：谁先回来谁先画（各自 setData + 骨架）。
   * ⚠️ 任何一块失败**只影响自己那一块**。
   */
  async load() {
    const { articleId } = this.entry
    if (!articleId) {
      this.setData({ articleLoading: false, articleError: '缺少竞技场地址' })
      return
    }
    if (this.requesting) return
    this.requesting = true
    try {
      await Promise.all([
        this.loadArticle(),
        this.loadStats(),
        this.loadMine(),
        this.loadLeaderboard(),
        this.loadFavorite(),
      ])
    } finally {
      this.requesting = false
    }
  },

  /** 块 ①：句子内容（全局会话缓存；同一句在朗读页拉过就直接命中） */
  async loadArticle() {
    this.setData({ articleError: '' })
    if (!this.data.sentence) this.setData({ articleLoading: true })
    try {
      const d = await fetchArticleContent(this.entry.articleId)
      this.setData({
        articleLoading: false,
        articleId: d.id,
        sentence: {
          articleId: d.id,
          header: true,
          text: d.text,
          translation: d.translation,
          theme: d.theme,
          audio: d.audio,
          // ⚠️ durationMs 必须**单独**给：arena-card 的 audio-button 读的是 entry.durationMs
          durationMs: d.audio ? d.audio.durationMs : null,
        },
      })
    } catch (err) {
      // ⚠️ 句子打不开**不代表统计/榜单也打不开**（它们挂在参与资源上，见文件头）
      this.setData({ articleLoading: false, articleError: (err as Error).message || String(err) })
    }
  },

  /** 块 ②：参与概要（公开聚合，**不在句子上**、每次现算） */
  async loadStats() {
    this.setData({ statsError: '' })
    setIfChanged(this, 'statsLoading', true)
    const ok = await ensureArticleStats([this.entry.articleId])
    const st = me.getArticleStats(this.entry.articleId)
    if (!ok) {
      this.setData({ statsLoading: false, statsError: '取不到参与概要' })
      return
    }
    this.setData({
      statsLoading: false,
      participantCount: st?.participantCount ?? 0,
      topScoreText: formatScore(st?.topScore ?? null),
      lowestScoreText: formatScore(st?.lowestScore ?? null),
    })
  },

  /** 块 ③：我的参与 —— 写全局 store，再按 store 重画 */
  async loadMine() {
    await loadParticipation(this.entry.articleId)
    this.render()
    this.setData({ mineLoading: false })
  },

  /** 块 ④：排行榜 —— `sort=score` 就是榜单（前 20 名），`rank` 由服务端给 */
  async loadLeaderboard() {
    this.setData({ lbError: '' })
    setIfChanged(this, 'lbLoading', true)
    try {
      const res = await fetchArticleParticipations(this.entry.articleId, {
        sort: 'score',
        limit: 20,
      })
      const myId = me.getState().userInfo?.id ?? 0
      const rows = await attachAvatarSrc(
        res.items.map((r) => ({
          ...r,
          // ⚠️ 端侧自己比"是不是我"：公开接口认不出看的人是谁（见 ArticleParticipationRow）
          isMe: myId > 0 && r.userId === myId,
          scoreText: formatScore(r.bestScore),
        })),
      )
      this.setData({ lbLoading: false, leaderboard: rows, lbTotal: res.total })
    } catch (err) {
      this.setData({ lbLoading: false, lbError: (err as Error).message || '排行榜取不到' })
    }
  },

  /** 收藏状态（与"我读没读过"无关：没读过也能收藏） */
  async loadFavorite() {
    setIfChanged(this, 'favLoading', true)
    try {
      const favorited = await fetchIsFavorite(this.entry.articleId)
      this.setData({ favLoading: false, isFavorite: favorited })
    } catch (err) {
      // ⚠️ 未注册是正常情况（没有账号自然没有收藏）——静默按"未收藏"画
      if (!isUnregistered(err)) {
        console.warn('[arena] 收藏状态拉取失败（按未收藏画）：' + (err as Error).message)
      }
      this.setData({ favLoading: false, isFavorite: false })
    }
  },

  /**
   * 重画「我」的那几个数字 —— **只从全局 store 取**。
   * ⚠️ 详情响应里没有"我的"字段；store 是"我的"数据唯一的汇集处，
   *    所以朗读页刚打完的分能立刻反映到这里（不需要重新拉接口）。
   * ⚠️ `participationOf().loaded === false` 表示**还没拉到**（不是"没参与"）——
   *    这时按空画，拉到之后 store 广播会重画。
   */
  render() {
    const id = this.data.articleId || this.entry.articleId
    if (!id) return
    const p = me.participationOf(id)
    const record = p.record
    const attempts = record?.attempts ?? 0
    const best = record?.bestScore ?? null
    const rank = record?.rank ?? null

    /**
     * ⚠️ 「击败了多少人」= 参与人数 − 名次（名次从 1 开始）——端侧现推，
     *    服务端不再为它单独留字段。
     */
    this.setData({
      myBest: best,
      myBestText: formatScore(best),
      myAttempts: attempts,
      myRank: rank,
      mySummary:
        '已挑战 ' + attempts + ' 回合，最高得分 ' + formatScore(best) +
        '，位列 ' + (rank === null ? '—' : rank),
      // ⚠️ 与首页共用同一份实现（@jushuo/shared 的 startButtonLabel）
      action: startButtonLabel(best !== null),
    })
  },

  // ── 各块自己的重试（失败只影响本块） ──────────────────────
  onRetry() {
    void this.load()
  },
  onRetryArticle() {
    void this.loadArticle()
  },
  onRetryStats() {
    void this.loadStats()
  },
  onRetryLeaderboard() {
    void this.loadLeaderboard()
  },

  /**
   * ⭐ 收藏 / 取消收藏**这一句**。
   *
   * ⚠️ **乐观更新**：先翻界面再发请求 —— 服务端两头都幂等（见 routes/favorites.ts），
   *    所以最坏情况只是"翻错了再翻回来"，而用户不会看到按钮卡住。
   * ⚠️ 失败必须**翻回来**并说出来：静默失败会让用户以为收藏成功了。
   */
  async onToggleFavorite() {
    const articleId = this.data.articleId
    if (!articleId) return
    const next = !this.data.isFavorite
    this.setData({ isFavorite: next })
    try {
      const r = await setFavorite(articleId, next)
      // ⚠️ 以**服务端回的**为准（可能和本地相反：比如另一台设备刚改过）
      this.setData({ isFavorite: r.favorited })
      wx.showToast({ title: r.favorited ? '已收藏' : '已取消收藏', icon: 'none', duration: 1200 })
    } catch (err) {
      this.setData({ isFavorite: !next })
      wx.showToast({ title: (err as Error).message || '操作失败', icon: 'none', duration: 2000 })
    }
  },

  /**
   * ⭐ 句子卡左上那颗播放钮 —— 听**参考音频**（标准音）。
   *
   * ⚠️ 与首页 onPlayAudio 同一套手感：再点=停、取音中再点=取消 loading、
   *    先点亮 loading 再取音、播完清标记。
   */
  async onPlayAudio(e: WechatMiniprogram.CustomEvent<{
    articleId: string
    audio: { full: string; kind: 'cloud' | 'http' } | null
  }>) {
    const articleId = e.detail.articleId ?? ''
    const full = e.detail.audio?.full
    if (!articleId || !full) return

    if (this.data.playingArticle === articleId) {
      stopAudio()
      this.setData({ playingArticle: '' })
      return
    }
    if (this.data.loadingArticle === articleId) {
      this.setData({ loadingArticle: '' })
      return
    }

    const kind = e.detail.audio?.kind === 'cloud' ? 'cloud' : 'http'
    this.setData({ loadingArticle: articleId, playingArticle: '' })
    try {
      const src = await ensureLocalAudio(full, kind)
      if (!src) throw new Error('标准音取不到，请稍后再试')
      // ⚠️ 等待期间用户可能又点了别的（或取消）—— 那就别再出声
      if (this.data.loadingArticle !== articleId) return
      this.setData({ loadingArticle: '', playingArticle: articleId })
      await playAudioUrl(src, '标准音', () => {
        if (this.data.playingArticle === articleId) this.setData({ playingArticle: '' })
      })
    } catch (err) {
      this.setData({ loadingArticle: '', playingArticle: '' })
      wx.showToast({ title: (err as Error).message || '播放失败', icon: 'none', duration: 2000 })
    }
  },

  /**
   * ⭐ 邀请好友 —— 分享内容在这里决定（`<button open-type="share">` 只负责拉起面板）。
   * ⚠️ 路径 = **这一句的朗读挑战页**：对方点开看到的是同一句、同一个榜单。
   */
  onShareAppMessage() {
    return {
      title: '这句金句，你能读多少分？',
      path: '/pages/arena/arena?article=' + this.data.articleId,
    }
  },

  /** ⭐ 分享到朋友圈 —— 朋友圈只能带 query（不能带 path） */
  onShareTimeline() {
    return {
      query: 'article=' + this.data.articleId,
    }
  },

  /** 去朗读（受保护页：由 lib/route 统一过 auth，这里不自己判断身份） */
  onStart() {
    const { articleId } = this.data
    if (!articleId) return
    void go(ROUTES.reading.url + '?id=' + articleId)
  },
})

/** 只在真正变化时写 —— onShow 会重拉，避免同样的布尔值反复触发渲染 */
function setIfChanged(ctx: { data: Record<string, unknown>; setData: (d: Record<string, unknown>) => void }, key: string, value: unknown): void {
  if (ctx.data[key] !== value) ctx.setData({ [key]: value })
}
