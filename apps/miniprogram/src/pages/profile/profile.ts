import type { GrowthView, UserProfileResponse } from '@jushuo/shared'

import { fetchUserProfile } from '../../lib/api/client'
import { resolveCloudFileUrl } from '../../lib/cloud-file'
import { openEnergyPage } from '../../lib/challenges'
import { openJoinPage, refreshMe } from '../../lib/join'
import { navPadTop, notifyNavScroll } from '../../lib/nav'
import * as me from '../../lib/store'

/**
 * ⭐ 「个人主页」—— **按用户 id 取一份数据**，一页一套渲染。
 *
 * ⚠️⚠️ 没有「本人视角 / 访客视角」之分：`?u=<id>` 就是这一页的地址，
 *    转发出去谁打开看到的都是同一个人的主页（包括我自己那份）：
 *      · 带 ?u=<id> → 看那一份
 *      · 不带       → 看自己的（我的 id 来自 store 里的 profile）
 * ⚠️ 数据只有**一个来源**：GET /api/profile/:id（服务端按 id 给一份快照），
 *    所以每次 onShow 都现取 —— 刚读完一句回到这一页，数字必然是新的。
 *    （之前这里是「自己读 store、别人走接口」两条路，那等于两套真相。）
 * ⚠️ 唯一的例外是**还没有我的 id**（服务端还不认识我）：没有主页可取，
 *    头部画「加入」（见 wxml），其余不画 —— 那不是错误，是还没加入。
 *
 * ⚠️ 这一页**不放**「连战记录 / 参与场次 / 我的挑战」入口：
 *    它们是**看的人的私有列表**，而这一页是给所有人看的。
 *    入口在用户面板的菜单里（那里本来就有这三项）。
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
    /** 正在取那一份主页 */
    loading: true,
    /** 取不到时的文案（id 不存在 / 账号被关 / 网络失败） */
    error: '',
    /** 有没有主页可画（false = 还没有我的 id ⇒ 还没加入） */
    hasProfile: true,
    nickname: '',
    avatarSrc: '',
    avatarPlaceholder: '/assets/avatar-placeholder.png',
    /** ⭐ 能量 / 解冻卡只有本人才有（别人的主页服务端返回 null）—— 决定那一行显不显示 */
    hasEnergy: false,
    energy: 0,
    unfreezeCards: 0,
    streakDays: 0,
    conqueredCount: 0,
    rounds: 0,
    growthRows: [] as GrowthRow[],
  },

  /** 这一页要看谁的：URL 里的 `u`；0 = 不带参数（看自己的） */
  targetId: 0,
  /** 这次真正取的是谁 —— 分享路径用它（targetId 或我自己的 id） */
  viewId: 0,

  onLoad(query: Record<string, string | undefined>) {
    this.setData({ navTop: navPadTop() })

    /**
     * ⭐ 打开右上角「转发 / 分享到朋友圈」菜单。
     * ⚠️ 菜单只是入口，真正决定分享内容的是 onShareAppMessage / onShareTimeline
     *    （与 pages/challenge 同一套）。
     */
    wx.showShareMenu?.({ menus: ['shareAppMessage', 'shareTimeline'] })

    this.targetId = Number(query.u ?? '') || 0
  },

  /**
   * ⚠️ 用 onShow 而不是 onLoad：从朗读页挑战完回来时，这一页的数字必须是新的。
   */
  onShow() {
    void this.load()
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    notifyNavScroll(this, e.scrollTop)
  },

  /** 取这一页要看的那一份（同一个 id 对所有人都返回同一份） */
  async load() {
    if (!this.targetId) {
      /**
       * 不带参数 = 看自己的：id 来自 store 里那份 /me。
       * ⚠️ 顺手让 store 刷一次（用户面板与导航栏都靠它）；刷到了 id 就补取一次 ——
       *    否则这一页会停在「加入」上，要等用户离开再进来才看得到自己的主页。
       */
      void refreshMe().then(() => {
        if (!this.viewId && me.getState().profile?.id) void this.load()
      })
    }

    const id = this.targetId || me.getState().profile?.id || 0
    this.viewId = id
    if (!id) {
      // ⚠️ 没有 id 不是「取不到」：那是「还没加入」，画「加入」，其余不画
      this.setData({ loading: false, hasProfile: false, error: '', nickname: '还没加入句拼' })
      return
    }

    this.setData({ loading: true, error: '' })
    try {
      this.render(await fetchUserProfile(id))
    } catch (err) {
      this.setData({ loading: false, error: (err as Error).message || String(err) })
    }
  },

  /** 服务端那一份 → 展示视图（**唯一的渲染入口**） */
  render(p: UserProfileResponse) {
    this.setData({
      loading: false,
      error: '',
      hasProfile: true,
      nickname: (p.nickname ?? '').trim() || '未设置昵称',
      /**
       * ⚠️ 能量 / 解冻卡是**账号余额**，不在公开主页那一条里（公开接口只给公开数据）。
       *    所以看自己主页时，这两个数从「我是谁」那一份取（store 里的 /api/user/me）；
       *    看别人的主页时没有这一份 —— 那一行不显示（hasEnergy=false）。
       */
      hasEnergy: me.getState().profile?.id === p.id,
      energy: me.getState().profile?.energy ?? 0,
      unfreezeCards: me.getState().streak?.unfreezeCards ?? 0,
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

  /** 头部那个「加入」—— 进补昵称 / 头像那一页（判据见 load()：还没有我的 id） */
  onJoin() {
    openJoinPage()
  },

  /** 能量那一行 —— 与用户面板同一个去处（解冻卡没有独立页面，入口在连战记录里） */
  onEnergy() {
    openEnergyPage()
  },

  /** ⭐ 转发给好友 —— 路径就是**这一页**（带 ?u=<id>） */
  onShareAppMessage() {
    return {
      title: this.data.nickname + ' 的句拼主页',
      path: '/pages/profile/profile?u=' + this.viewId,
    }
  },

  /** ⭐ 分享到朋友圈 —— 朋友圈只能用 query 带参数 */
  onShareTimeline() {
    return { title: this.data.nickname + ' 的句拼主页', query: 'u=' + this.viewId }
  },
})
