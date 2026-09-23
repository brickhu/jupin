import type { GrowthView, PublicProfileResponse } from '@jushuo/shared'

import { fetchPublicProfile } from '../../lib/api/client'
import { resolveCloudFileUrl } from '../../lib/cloud-file'
import {
  openChallengesPage,
  openEnergyPage,
  openParticipationsPage,
  openStreakPage,
} from '../../lib/challenges'
import { openJoinPage, refreshMe } from '../../lib/join'
import { navPadTop, notifyNavScroll } from '../../lib/nav'
import * as me from '../../lib/store'

/**
 * ⭐ 「用户主页」—— 只读的展示页。
 *
 * ⚠️⚠️ 它**放在 pages 根目录、而不是 pages/me/ 下**：这一页是**对外展示**的
 *    （能被分享、被陌生人打开），和挑战结果页同一个理由。
 *    「修改资料」是私有表单，它让出了 profile 这个名字、改叫 pages/profile-edit。
 * ⚠️ 两页是两件事，别混：一个是成绩墙（只读），一个是表单（改头像昵称）。
 *
 * ⭐⭐ **两种视角**，靠 URL 上的 `?u=<shareKey>` 区分：
 *    · 没有 u → **我自己的**主页：数据全部来自全局 store（这一页不自己发请求，
 *      只在 onShow 时让 store 去刷一次，见 lib/join.ts 的 refreshMe）。
 *    · 有 u   → **别人分享出来的**主页：走公开接口取一份只读快照（不需要登录），
 *      并且**不碰 store** —— store 里那些数字是「我」的，画上去就把别人的主页
 *      变成了我的。能量 / 解冻卡同理：那是账号余额，不对外（见服务端 share.ts）。
 */

/** 当前已换址的 fileID —— 用来丢弃「换到一半又被换掉」的旧结果 */
let avatarFileId = ''

interface GrowthRow {
  key: string
  icon: string
  name: string
  value: string
  /** 一句话说明这个数是什么 —— 三个指标各自回答一个问题，不解释没人看得懂 */
  blurb: string
}

/**
 * ⚠️ 三个数**分开展示、不合成总分**：相加之后没人解释得清那个数是怎么来的。
 */
function toGrowthRows(growth: GrowthView | undefined): GrowthRow[] {
  const g = growth ?? { self: 0, diligence: 0, standout: 0 }
  return [
    {
      key: 'self',
      icon: '📈',
      name: '自我超越',
      value: String(g.self),
      blurb: '比过去的自己读得更好：跟「我在这句的最高分」和「我的个人最高分」比，两边取平均',
    },
    {
      key: 'diligence',
      icon: '🔥',
      name: '坚持不懈',
      value: String(g.diligence),
      blurb: '坚持的里程碑：连续 7 / 30 / 180 天各给一次，之后每满 360 天再给一次（越久越多）',
    },
    {
      key: 'standout',
      icon: '🏔️',
      name: '人中翘楚',
      value: String(g.standout),
      blurb: '比这个竞技场的榜单中位数高多少 —— 场上人越多，同样的分越值钱',
    },
  ]
}

Page({
  data: {
    navTop: 0,
    /** ⭐ 看的是**别人**分享出来的主页（见文件头）—— 决定隐藏什么、哪几格能点 */
    visitor: false,
    /**
     * ⭐ 服务端认识我吗（store 的 hasJoined）—— 头部头像那一格的判据。
     * ⚠️ 与**导航栏那一格完全相同**：不认识我时它画的是「加入」按钮。
     *    两处各判一套，就会出现「导航栏让我加入、主页却已经给我画了头像」。
     */
    joined: false,
    /** 访客视角：正在取那份公开快照 */
    loadingPublic: false,
    /** 访客视角取不到时的文案（链接失效 / 账号被关 —— 服务端一律 404） */
    error: '',
    /** 拼分享路径用的标识（自己的或正在看的那个主页的）；空 ⇒ 不显示分享按钮 */
    shareKey: '',
    nickname: '未设置昵称',
    avatarSrc: '',
    avatarPlaceholder: '/assets/avatar-placeholder.png',
    streakDays: 0,
    unfreezeCards: 0,
    energy: 0,
    conqueredCount: 0,
    rounds: 0,
    growthRows: [] as GrowthRow[],
  },

  /** URL 里的 `u`：正在看的**别人**的主页标识；空 = 看自己的 */
  viewedKey: '',

  /** 访客视角取到的那份公开数据（重画时用它，不再发请求） */
  publicProfile: null as PublicProfileResponse | null,

  onLoad(query: Record<string, string | undefined>) {
    this.setData({ navTop: navPadTop() })

    /**
     * ⭐ 打开右上角「转发 / 分享到朋友圈」菜单。
     * ⚠️ 菜单只是入口，真正决定分享内容的是 onShareAppMessage / onShareTimeline
     *    （与 pages/challenge 同一套）。
     */
    wx.showShareMenu?.({ menus: ['shareAppMessage', 'shareTimeline'] })

    const key = query.u ?? ''
    if (!key) return
    this.viewedKey = key
    this.setData({ visitor: true, shareKey: key })
    void this.loadPublic()
  },

  /**
   * 取**别人**分享出来的主页 —— 公开接口，不需要登录。
   * ⚠️ 服务端只认 24 位标识、且账号必须 normal，取不到就是**这一页不存在**。
   */
  async loadPublic() {
    this.setData({ loadingPublic: true, error: '' })
    try {
      const p = await fetchPublicProfile(this.viewedKey)
      this.publicProfile = p
      this.renderPublic()
    } catch (err) {
      this.setData({ error: (err as Error).message || String(err) })
    } finally {
      this.setData({ loadingPublic: false })
    }
  },

  /**
   * ⚠️ 用 onShow 而不是 onLoad：从朗读页挑战完回来时，这一页的数字必须是新的。
   * ⚠️ 先用缓存画一遍（store 里有上次的值），再向服务端刷 —— 否则每次进来先白一下。
   * ⚠️ 访客视角**不碰 store**，只重画手里那份公开快照。
   */
  onShow() {
    if (this.viewedKey) {
      this.renderPublic()
      return
    }
    this.render()
    void refreshMe().then(() => this.render())
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    notifyNavScroll(this, e.scrollTop)
  },

  render() {
    const st = me.getState()
    const p = st.profile
    /**
     * ⚠️ 没有 profile = **服务端还不认识我**（大多是后端没答上来）——
     *    这一态下「未设置昵称 / 能量 0 点」都是**有账号**的口吻，会把人带偏：
     *    它其实还没有账号，而账号是点「加入」那次请求顺手建出来的。
     */
    const joined = me.hasJoined()
    this.setData({
      joined,
      // ⭐ 我自己的分享标识（store 里落着上次 /me 的结果）—— 没有就不显示分享按钮
      shareKey: p?.shareKey ?? '',
      nickname: joined ? (p?.nickname ?? '').trim() || '未设置昵称' : '还没加入句拼',
      streakDays: st.streak?.streakDays ?? 0,
      unfreezeCards: st.streak?.unfreezeCards ?? 0,
      energy: p?.energy ?? 0,
      /**
       * ⚠️ 参与场次数的是 conqueredCount（**拿到过分数的句子数**），与首页状态卡同口径 ——
       *    参与场次页筛的正是「拿到过分」那条，用它才对得上点进去看到的条数。
       *    原来用的是 challengedCount（挑战过几句，含打分失败那次），两个页面会差数。
       */
      conqueredCount: p?.conqueredCount ?? 0,
      rounds: p?.challengedRounds ?? 0,
      growthRows: toGrowthRows(p?.growth),
    })
    this.loadAvatar(p?.avatarUrl ?? '')
  },

  /**
   * 访客视角：只画公开的那几格（字段清单见 shared 的 PublicProfileResponse）。
   * ⚠️ 能量 / 解冻卡**不在**那份数据里，所以这里根本不写它们 ——
   *    而不是「写了再藏起来」：藏起来那版，下一个人加字段时会顺手带上去。
   */
  renderPublic() {
    const p = this.publicProfile
    if (!p) return
    this.setData({
      nickname: (p.nickname ?? '').trim() || '未设置昵称',
      streakDays: p.streakDays,
      conqueredCount: p.conqueredCount,
      rounds: p.challengedRounds,
      growthRows: toGrowthRows(p.growth),
    })
    this.loadAvatar(p.avatarUrl ?? '')
  },

  /**
   * ⚠️ 库里存的是 cloud:// fileID，不能直接给 <image src> —— 先换成临时地址。
   *    换址期间头像可能又被换掉，回来的是旧地址就不覆盖（比 fileID）。
   */
  loadAvatar(fileId: string) {
    if (!fileId || fileId === avatarFileId) return
    avatarFileId = fileId
    void resolveCloudFileUrl(fileId).then((url) => {
      if (avatarFileId === fileId) this.setData({ avatarSrc: url })
    })
  },

  /**
   * 头部那个「加入」—— 进补昵称 / 头像那一页（同导航栏那一格的说法）。
   * ⚠️ 判据是 hasJoined（服务端认不认识我），**不是**「有没有昵称」。
   */
  onJoin() {
    openJoinPage()
  },

  /**
   * 昵称下面那行小字里的「⚡ 能量」—— 与用户面板同一个去处。
   * ⚠️ 解冻卡没有独立页面，所以整行点下去也只去能量页（入口在连战记录里）。
   */
  onEnergy() {
    openEnergyPage()
  },

  /**
   * ⭐ 下面三格在**访客视角下只做展示**（见文件头）：点进去打开的是「我」的私有列表，
   *    那不是这一页的主语 —— 所以这三个方法都先看这一步。
   */
  onStreak() {
    if (this.data.visitor) return
    openStreakPage()
  },

  onParticipations() {
    if (this.data.visitor) return
    openParticipationsPage()
  },

  onChallenges() {
    if (this.data.visitor) return
    openChallengesPage()
  },

  /** 分享用的标识：正在看的那个主页优先，否则是我自己的 */
  shareTarget(): string {
    return this.viewedKey || this.data.shareKey
  },

  shareTitle(): string {
    return this.data.visitor ? this.data.nickname + ' 的句拼主页' : '来看看我的句拼主页'
  },

  /**
   * ⭐ 转发给好友 —— 路径指向**当前正在看的这个主页**。
   *
   * ⚠️⚠️ 标识为空时不能就这么发出去：不带参数的分享路径会让对方打开后看到
   *    **他自己的**主页。所以那种情况下分享按钮不显示（见 wxml 的 wx:if），
   *    标题也退化成一句不带指代的话。
   */
  onShareAppMessage() {
    const key = this.shareTarget()
    return {
      title: this.shareTitle(),
      path: '/pages/profile/profile' + (key ? '?u=' + key : ''),
    }
  },

  /** ⭐ 分享到朋友圈 —— 朋友圈只能用 query 带参数 */
  onShareTimeline() {
    const key = this.shareTarget()
    return { title: this.shareTitle(), query: key ? 'u=' + key : '' }
  },
})
