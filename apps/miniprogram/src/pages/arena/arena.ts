import { formatScore, startButtonLabel } from '@jushuo/shared'
import type { ArticleTheme, StandardAudio } from '@jushuo/shared'

import {
  fetchArticleParticipations,
  fetchFavorited,
  setFavorite,
} from '../../lib/api/client'
import { attachAvatarSrc } from '../../lib/cloud-file'
import { ensureStats, noteMyFavoriteToggle, statsOf } from '../../lib/stats'
import { isUnregistered } from '../../lib/auth'
import { loadParticipation } from '../../lib/participation'
import { fetchArticleContent } from '../../lib/content'
import { ensureLocalAudio } from '../../lib/audio/standard'
import { playAudioUrl, stopAudio } from '../../lib/audio/play'
import { navPadTop, notifyNavScroll } from '../../lib/nav'
import { ROUTES, go, goPublic } from '../../lib/route'
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
 *    · 参与概要 ← `GET /api/stats/participation?ids=`（**统计不在句子上**，见 lib/stats）
 *    · 排行榜   ← `GET /api/article/{id}/participations?sort=score&limit=20`
 *    · 我的参与 ← `GET /api/user/participation/{articleId}`（写全局 store，见 lib/participation）
 *    · 收藏     ← `GET /api/user/favorited?articleId=`
 *
 * ⚠️⚠️ 为什么不再是一条 `/api/arenas/{articleId}`（2026-09 拆掉）：
 *    那条把"句子内容 + 参与统计 + 榜单 + 我的"揉成一个响应 —— 生命周期完全不同
 *    （内容可缓存、统计每次现算、我的按用户），揉在一起后**任何一块慢/坏都拖住整页**，
 *    而且"句子一删，统计跟着没"。现在拆开之后：**句子打不开也不影响统计与榜单**
 *    （参与数据挂在 `/api/article/{id}/participations` 上，与句子行无关）。
 *
 * ⚠️ 只按句子寻址：`?article=<articleId>`；日期不属于竞技场（见文件头历史注释）。
 */
Page({
  data: {
    /** 根节点要让开的上边距（px）—— 自定义导航栏是浮层，不占文档流（见 lib/nav.ts） */
    navTop: 0,

    /** ⭐ 这一句的 id —— 竞技场的**地址** */
    articleId: '',

    // ── 块 ① 句子卡（纯内容，会话缓存）──────────────────────
    //    ⚠️⚠️ 与首页「今日挑战」那张卡**同一个用法**（`arena-card mode="featured"`）：
    //        CTA（action）+ 我的参与信息（hint）都**在卡里**，不再另开一张卡。
    //        本页只是比 today 多一颗收藏星（showFavorite）。
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
      /** ⭐ 「立即朗读，参与挑战」/「重新朗读，再次冲榜」——来自 startButtonLabel，与 today 卡同一份 */
      action: string
      /** ⭐ 我的参与信息（已挑战几回合 · 最高 · 位列）——与 today 卡的 hint 同一个位置 */
      hint: string
      /** 我在这句上拿过分 ⇒ 卡片加一圈品牌色描边（与 today 卡同一条判据） */
      joined: boolean
    } | null,

    // ── 块 ② 参与概要（全场统计，现算） ──────────────────────
    statsLoading: true,
    statsError: '',
    participantCount: 0,
    /** 多少人收藏了这一句（`/api/stats/favorite-count`）—— 与参与人数同一排显示 */
    favoriteCount: 0,
    topScoreText: '—',
    lowestScoreText: '—',
    /**
     * ⭐ 句子内容里的**挑战宣言 + 朗读建议**（`ArticleDetail.challenge / .advice`）——
     *    显示在「参与概要」卡顶部（用户 2026-09：把那行分组标题换成这两句）。
     *    ⚠️ 两者都可能为 null（老内容没写）⇒ 各判各的，**不补默认话术**。
     */
    challenge: '',
    advice: '',

    // ── 块 ④ 排行榜（参与资源，公开） ───────────────────────
    lbLoading: true,
    lbError: '',
    leaderboard: [] as {
      rank: number
      /** ⭐ 点这一行看 TA 的参与详情要用（`GET /api/participation/{participationId}`） */
      participationId: string
      userId: number
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

  /**
   * ⭐ 句子卡的**内容部分**（来自 `/api/articles/{id}`）。
   * ⚠️ 单独存一份：`render()` 每次要把它和「我的参与」拼成完整的 entry
   *    （action / hint / joined 来自 store，随广播变），不能把内容也一起丢。
   */
  baseSentence: null as {
    articleId: string
    header: boolean
    text: string
    translation: string
    theme: ArticleTheme | null
    audio: StandardAudio | null
    durationMs: number | null
  } | null,

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
      this.baseSentence = {
        articleId: d.id,
        header: true,
        text: d.text,
        translation: d.translation,
        theme: d.theme,
        audio: d.audio,
        // ⚠️ durationMs 必须**单独**给：arena-card 的 audio-button 读的是 entry.durationMs
        durationMs: d.audio ? d.audio.durationMs : null,
      }
      this.setData({
        articleLoading: false,
        articleId: d.id,
        // ⭐ 挑战宣言 / 朗读建议 —— 参与概要卡顶部那两句（与句子同一份内容，同一批到）
        challenge: d.challenge ?? '',
        advice: d.advice ?? '',
      })
      // ⭐ 内容到手 → 立刻与「我的参与」拼成完整的卡（CTA / 参与信息都在卡里）
      this.render()
    } catch (err) {
      // ⚠️ 句子打不开**不代表统计/榜单也打不开**（它们挂在参与资源上，见文件头）
      this.setData({ articleLoading: false, articleError: (err as Error).message || String(err) })
    }
  },

  /**
   * 块 ②：参与概要（公开聚合，**不在句子上**、每次现算）。
   *
   * ⚠️⚠️ 这里**只负责取数**（`ensureStats` 把这一句的参与统计与收藏总量一起拉回来、
   *    写进全局 store）；**数字由 `render()` 从 store 读**——
   *    于是 store 一广播（别处也拉了同一句 / 重新拉到新值），这一块自己就更新了。
   *    ⇒ 别把数字写回 `data` 存一份：那是"两份真相"的起点。
   */
  async loadStats() {
    this.setData({ statsError: '' })
    setIfChanged(this, 'statsLoading', true)
    const r = await ensureStats([this.entry.articleId])
    if (!r.participation) {
      this.setData({ statsLoading: false, statsError: '取不到参与概要' })
      return
    }
    this.setData({ statsLoading: false })
    this.render()
  },

  /**
   * 「我的参与」—— 写全局 store，再按 store 重画。
   * ⚠️ 它没有自己的卡片：CTA 与参与信息都在**句子卡**里（与 today 卡同一处位置），
   *    所以这里只负责"拉到 → 让 render 把卡重拼一遍"。
   */
  async loadMine() {
    await loadParticipation(this.entry.articleId)
    this.render()
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
      const favorited = await fetchFavorited(this.entry.articleId)
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
   * 把卡片重拼一遍 —— **内容来自 baseSentence，CTA 与参与信息来自全局 store**。
   *
   * ⚠️ 与首页「今日挑战」那张卡**完全同一个位置、同一套字段**（`arena-card` 的
   *    featured 用法）：
   *      · `action` —— startButtonLabel(参与过没有)，两页共用同一份实现；
   *      · `hint`   —— **我的参与信息**（回合 / 最高 / 名次）;
   *      · `joined` —— 拿到过分 ⇒ 卡片加一圈品牌色描边。
   * ⚠️⚠️ `loaded === false`（还没拉到）时 hint 留空，**不写"还未参与挑战"** ——
   *    那是替服务端下结论；拉到之后 store 广播会重画这一句。
   */
  render() {
    const base = this.baseSentence
    if (!base) return
    const p = me.participationOf(base.articleId)
    const record = p.record
    const attempts = record?.attempts ?? 0
    const best = record?.bestScore ?? null
    const rank = record?.rank ?? null
    /**
     * ⭐⭐ **统计也从 store 读**（不在本地存一份）——`statsOf` 一次给出这一句的
     *    参与统计与收藏总量（都由 `lib/stats.ts` 写进全局 store）。
     * ⚠️ 于是 store 一广播（这一句的统计被任何一处重新拉到），这一块就跟着刷新。
     * ⚠️ 还没拉到（null）时按 0 画 —— 与"确实 0 人"在**这一页**看起来一样，
     *    但那只是默认值；错误态由 `statsError` 单独表达（见 loadStats）。
     */
    const stats = statsOf(base.articleId)

    this.setData({
      sentence: {
        ...base,
        joined: !!record,
        action: startButtonLabel(!!record),
        hint: !p.loaded
          ? ''
          : record
            ? '已挑战 ' + attempts + ' 回合 · 最高 ' + formatScore(best) +
              ' · 位列 ' + (rank === null ? '—' : rank)
            : '还未参与挑战',
      },
      // ⭐ 参与概要那一排数字（与排行榜、与首页卡片**同源**：都是 store 里的统计）
      participantCount: stats.participation?.participantCount ?? 0,
      topScoreText: formatScore(stats.participation?.topScore ?? null),
      lowestScoreText: formatScore(stats.participation?.lowestScore ?? null),
      /**
       * ⚠️ 收藏数**不在参与概要那排**，它传给 `arena-card` 画在右上角那颗心**旁边**
       *    （用户 2026-09 定）—— 与参与统计同源（都来自 store 的 stats），只是落点不同。
       * ⚠️ `?? 0` 只影响"画不画"：组件在 `favoriteCount > 0` 时才渲染，
       *    所以"还没拉到"与"确实 0 人收藏"在这一处看起来一样（都是不画）。
       */
      favoriteCount: stats.favoriteCount ?? 0,
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
      // ⭐ 收藏总量跟着动（星左边那个数字）—— 否则要点出去再进来才会变
      noteMyFavoriteToggle(articleId, r.favorited)
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
      title: this.shareTitle(),
      path: '/pages/arena/arena?article=' + this.data.articleId,
    }
  },

  /** ⭐ 分享到朋友圈 —— 朋友圈只能带 query（不能带 path） */
  onShareTimeline() {
    return {
      // ⚠️ 朋友圈也必须显式给 title：不给的话它用的是小程序名，和转发那条不一样
      title: this.shareTitle(),
      query: 'article=' + this.data.articleId,
    }
  },

  /**
   * ⭐⭐ 分享标题 = **「朗读挑战：」+ challenge**（用户 2026-09 定）。
   *
   * ⚠️ `challenge` 是句子内容里的「挑战宣言」（判决 + 依据，如"这句是真硬，母语者都读不顺"）——
   *    它天然就是一句分享理由，比通用文案有信息量。
   * ⚠️⚠️ 它**可能为空**：老内容没写、或文章还没加载完。那时退回原来那句通用文案 ——
   *    绝不能拼出一个"朗读挑战："后面什么都没有的标题。
   */
  shareTitle(): string {
    const c = (this.data.challenge ?? '').trim()
    return c ? '朗读挑战：' + c : '这句金句，你能读多少分？'
  },

  /** 去朗读（受保护页：由 lib/route 统一过 auth，这里不自己判断身份） */
  onStart() {
    const { articleId } = this.data
    if (!articleId) return
    void go(ROUTES.reading.url + '?id=' + articleId)
  },

  /**
   * ⭐ 点榜单上的某一行 —— 去**参与详情页**看这一行（`pages/participation?id=`）。
   *
   * ⚠️ 只带一个标识：`participationId`（= `participations.id`，服务端按「谁 + 哪一句」派生）。
   *    它自带句子与分数，落点页不用再传 articleId / userId。
   * ⚠️ `goPublic` 而不是 `go`：那一页是公开的（匿名也能看榜 → 也能看榜上这一行）。
   * ⚠️⚠️ **自己那一行也跳**（2026-09 用户要求"链接加到榜单上"时就发现了）：
   *    曾经写过"自己那行不跳，反正下面有我的参与"—— 结果 dev 库里榜单只有我一个人，
   *    唯一那行被挡住 ⇒ 点了没反应，看起来就像**根本没加链接**。
   *    榜单上每一行都是"一条参与记录"，点谁都该能看到那条记录。
   */
  onOpenParticipant(e: WechatMiniprogram.BaseEvent) {
    const pid = String((e.currentTarget.dataset as { pid?: string }).pid ?? '')
    if (!pid) return
    goPublic(ROUTES.participationDetail.url + '?id=' + pid)
  },
})

/** 只在真正变化时写 —— onShow 会重拉，避免同样的布尔值反复触发渲染 */
function setIfChanged(ctx: { data: Record<string, unknown>; setData: (d: Record<string, unknown>) => void }, key: string, value: unknown): void {
  if (ctx.data[key] !== value) ctx.setData({ [key]: value })
}
