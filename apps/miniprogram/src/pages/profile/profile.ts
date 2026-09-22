import type { GrowthView } from '@jushuo/shared'

import { resolveCloudFileUrl } from '../../lib/cloud-file'
import { openChallengesPage, openParticipationsPage } from '../../lib/challenges'
import { refreshMe } from '../../lib/join'
import { navPadTop, notifyNavScroll } from '../../lib/nav'
import * as me from '../../lib/store'

/**
 * ⭐ 「用户主页」—— 只读的展示页。
 *
 * ⚠️⚠️ 它**放在 pages 根目录、而不是 pages/me/ 下**：这一页是**对外展示**的
 *    （以后要能被别人打开、能分享），和挑战结果页同一个理由。
 *    「修改资料」是私有表单，它让出了 profile 这个名字、改叫 pages/profile-edit。
 * ⚠️ 两页是两件事，别混：一个是成绩墙（只读），一个是表单（改头像昵称）。
 * ⚠️ 数据全部来自全局 store —— 这一页**不自己发请求取数**，
 *    只在 onShow 时让 store 去刷一次（见 lib/join.ts 的 refreshMe）。
 *    自己请求的话，用户面板、导航栏、这一页会各拿一份数据，迟早对不上。
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
      name: '孜孜不倦',
      value: String(g.diligence),
      blurb: '坚持的里程碑：连续 7 / 30 / 180 天各给一次，之后每满 360 天再给一次（越久越多）',
    },
    {
      key: 'standout',
      icon: '🏔️',
      name: '鹤立鸡群',
      value: String(g.standout),
      blurb: '比这个竞技场的榜单中位数高多少 —— 场上人越多，同样的分越值钱',
    },
  ]
}

Page({
  data: {
    navTop: 0,
    nickname: '未设置昵称',
    avatarSrc: '',
    avatarPlaceholder: '/assets/avatar-placeholder.png',
    streakDays: 0,
    streakBest: 0,
    unfreezeCards: 0,
    unfreezeExpiresOn: '' as string,
    energy: 0,
    conqueredCount: 0,
    participated: 0,
    rounds: 0,
    growthRows: [] as GrowthRow[],
  },

  onLoad() {
    this.setData({ navTop: navPadTop() })
  },

  /**
   * ⚠️ 用 onShow 而不是 onLoad：从朗读页挑战完回来时，这一页的数字必须是新的。
   * ⚠️ 先用缓存画一遍（store 里有上次的值），再向服务端刷 —— 否则每次进来先白一下。
   */
  onShow() {
    this.render()
    void refreshMe().then(() => this.render())
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    notifyNavScroll(this, e.scrollTop)
  },

  render() {
    const st = me.getState()
    const p = st.profile
    this.setData({
      nickname: (p?.nickname ?? '').trim() || '未设置昵称',
      streakDays: st.streak?.streakDays ?? 0,
      streakBest: st.streak?.streakBest ?? 0,
      unfreezeCards: st.streak?.unfreezeCards ?? 0,
      unfreezeExpiresOn: st.streak?.unfreezeExpiresOn ?? '',
      energy: p?.energy ?? 0,
      conqueredCount: p?.conqueredCount ?? 0,
      participated: p?.challengedCount ?? 0,
      rounds: p?.challengedRounds ?? 0,
      growthRows: toGrowthRows(p?.growth),
    })

    /**
     * ⚠️ 库里存的是 cloud:// fileID，不能直接给 <image src> —— 先换成临时地址。
     *    换址期间用户可能又换了头像，回来的是旧地址就不覆盖（比 fileID）。
     */
    const fileId = p?.avatarUrl ?? ''
    if (!fileId || fileId === avatarFileId) return
    avatarFileId = fileId
    void resolveCloudFileUrl(fileId).then((url) => {
      if (avatarFileId === fileId) this.setData({ avatarSrc: url })
    })
  },

  onParticipations() {
    openParticipationsPage()
  },

  onChallenges() {
    openChallengesPage()
  },
})
