import { startButtonLabel } from '@jushuo/shared'
import type { ArenaDetail, ArticleTheme, ScheduleAudio, ScheduleDetail } from '@jushuo/shared'
import { fetchArenaDetail, fetchArenaRecords, fetchScheduleDetail, setFavorite } from '../../lib/api/client'
import { formatScore } from '@jushuo/shared'

import { attachAvatarSrc } from '../../lib/cloud-file'
import { ensureLocalAudio } from '../../lib/audio/standard'
import { playAudioUrl, stopAudio } from '../../lib/audio/play'
import { navPadTop, notifyNavScroll } from '../../lib/nav'
import { ROUTES, go } from '../../lib/route'
import * as me from '../../lib/store'

/**
 * 朗读挑战页 —— 从首页卡片点进来。
 *
 * ⭐ 与首页卡片的分工：卡片是「一眼扫过去」，本页是「看进去」：
 *    这一句的参与概要（人数 / 最高 / 最低）、我的参与概要（回合 / 最好成绩 / 名次）、
 *    完整排行榜，以及从这里进入朗读。
 *
 * ⚠️ 页面构成（用户 2026-09 定的五条，别随手动）：
 *    ① 标题「朗读挑战」；② 句子卡左上播放（参考音频）、右上收藏；
 *    ③ 单独一张卡放**这个句子的参与概要**；④ 我的参与概要 + 「重新朗读，再次挑战」；
 *    ⑤ 底部「邀请好友参与挑战」（button open-type=share）。
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
    /**
     * ⭐ 句子卡的展示对象（arena-card 的 entry）。
     * ⚠️ header=true（要卡片头：左上播放、右上收藏）、action 不给（本页 CTA 在下面两张卡里）。
     * ⚠️ audio 为 null = 这句没灌标准音 ⇒ 卡片头那颗播放钮**整颗不渲染**。
     */
    sentence: null as {
      articleId: string
      header: boolean
      text: string
      translation: string
      theme: ArticleTheme | null
      audio: ScheduleAudio | null
      /** ⚠️ 卡片头的播放钮要用它把时长格式化成 00:05（见 arena-card 的 Entry） */
      durationMs: number | null
    } | null,

    topScore: null as number | null,
    /** ⭐ 全场最低分（与最高分同一口径：一人只算最好那次）；没人参与是 null */
    lowestScore: null as number | null,
    /** 上面三个数的成品文本（WXML 里不做 toFixed） */
    topScoreText: '—',
    lowestScoreText: '—',
    participantCount: 0,
    /** ⭐ 标准音是不是正在播 / 正在取音（句子卡左上那颗播放钮的状态） */
    playingArticle: '',
    loadingArticle: '',
    myBest: null as number | null,
    /** myBest 的展示形态（一位小数）—— WXML 里没法调 toFixed */
    myBestText: '—',
    myRank: null as number | null,
    myBeatenCount: null as number | null,
    /**
     * ⭐ 我在这句上**出过分**几次（= participations.attempts，只数 status='scored'）。
     * ⚠️ 用它而不是 submissions.seq：seq 含失败/进行中，会出现「挑战 3 回合」却只有一条成绩。
     */
    myAttempts: 0,
    /**
     * ⭐ 我收藏了这一句吗 —— 竞技场页那个收藏按钮的状态。
     * ⚠️ 它来自**鉴权接口** /api/user/arena-records（公开的竞技场详情不含"我的"字段），
     *    而且**与"我参与过没有"无关**：没读过也能收藏。
     */
    isFavorite: false,
    /** '立即朗读，参与挑战' / '重新朗读，再次冲榜' —— 来自 startButtonLabel，与首页共用 */
    action: '',

    leaderboard: [] as ScheduleDetail['leaderboard'],
    /** 榜上没有头像时用它（与 nav-bar / user-sheet 同一张本地占位图） */
    avatarPlaceholder: '/assets/avatar-placeholder.png',
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
        /**
         * ⚠️ 卡片头开着（header: true）：播放（参考音频）在左上、收藏在右上。
         *    audio 必须带过来 —— 那句话没灌标准音时它是 null，
         *    arena-card 会**整颗播放钮都不渲染**（而不是给个点了 404 的按钮）。
         */
        sentence: {
          articleId: d.articleId,
          header: true,
          text: d.text,
          translation: d.translation,
          theme: d.theme,
          audio: d.audio,
          // ⚠️ durationMs 必须**单独**给：arena-card 的 audio-button 读的是 entry.durationMs
          //    （不是 entry.audio.durationMs）——见 arena-card.ts 的 Entry
          durationMs: d.audio ? d.audio.durationMs : null,
        },
        topScore: d.topScore,
        lowestScore: d.lowestScore,
        topScoreText: formatScore(d.topScore),
        lowestScoreText: formatScore(d.lowestScore),
        participantCount: d.participantCount,
        // ⚠️ 名次/击败来自**个人接口**（见上面），不是公开详情
        myRank: mine?.rank ?? null,
        myBeatenCount: mine?.beatenCount ?? null,
        myAttempts: mine?.attempts ?? 0,
        // ⚠️ 收藏与"参与过没有"无关，所以取的是 isFavorite 本身，不看 myBest
        isFavorite: mine?.isFavorite ?? false,
        /**
         * ⚠️ 分值统一一位小数（formatScore）—— 与结果页、首页同一口径。
         * ⚠️ 头像：服务端给的是**云存储 fileID**，这里先换成可渲染的临时地址再画
         *    （榜单只有前 20，换址并发去重后最多 20 个；见 lib/cloud-file.ts）。
         */
        leaderboard: await attachAvatarSrc(
          d.leaderboard.map((r) => ({ ...r, scoreText: formatScore(r.score) })),
        ),
      })
      this.render()
    } catch (err) {
      this.setData({ loading: false, error: (err as Error).message || String(err) })
    }
  },

  /**
   * ⭐ 收藏 / 取消收藏**这一句**。
   *
   * ⚠️ **乐观更新**：先翻界面再发请求 —— 服务端两头都幂等（见 routes/favorites.ts），
   *    所以最坏情况只是"翻错了再翻回来"，而用户不会看到按钮卡住。
   * ⚠️ 失败必须**翻回来**并说出来：静默失败会让用户以为收藏成功了，
   *    等他在收藏列表里找不到时，问题已经查不出来了。
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
   * ⚠️ 这里原来有一个 statText（拼「23 人参与，最高得分 74」给卡片头显示）——
   *    2026-09 按用户要求改成**下方单独一张「参与概要」卡**（人数 / 最高 / 最低），
   *    所以那行字与这个函数一起删了。别只删卡片上的引用、把它留成死代码。
   */

  /**
   * ⭐ 句子卡左上那颗播放钮 —— 听**参考音频**（标准音）。
   *
   * ⚠️ 与首页 onPlayAudio 同一套手感（那里也走 ensureLocalAudio + 全局播放器）：
   *    · 再点一次 = 停；取音途中再点 = 取消那次的 loading（还没出声，停不下来）
   *    · 先点亮 loading 再取音：弱网下取音要等一下，没有反馈用户会以为没点上
   *    · 播完把标记清掉（onEnded 回调），否则会永远亮着
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
        // ⚠️ 播完只清"还是这一句"的标记，别把新点的那一句带掉
        if (this.data.playingArticle === articleId) this.setData({ playingArticle: '' })
      })
    } catch (err) {
      this.setData({ loadingArticle: '', playingArticle: '' })
      wx.showToast({ title: (err as Error).message || '播放失败', icon: 'none', duration: 2000 })
    }
  },

  /**
   * ⭐ 邀请好友 —— 分享内容在这里决定（`<button open-type="share">` 只负责拉起面板）。
   *
   * ⚠️ 路径 = **这一句的朗读挑战页**（按句子寻址）：对方点开看到的是同一句、
   *    同一个榜单，可以直接挑战 —— 这才叫"邀请参与挑战"。
   *    ⚠️ 不要带 date：那是"回到那一天再读一次"的口径，与邀请无关（见文件头两种进法）。
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
      title: '这句金句，你能读多少分？',
      query: 'article=' + this.data.articleId,
    }
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
    /**
     * ⚠️⚠️ 去**朗读页**= 去花能量做一件要归属的事 —— 必须过统一的 auth
     *    （见 lib/route：受保护页的守卫只在那一个地方）。
     *    不认得身份时 auth 会把用户送到加入页，这里**不再自己判断**。
     */
    void go(ROUTES.reading.url + '?id=' + articleId + '&date=' + submissionDate)
  },
})
