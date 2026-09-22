import type { StreakView } from '@jushuo/shared'

import { fetchMe } from '../../lib/api/client'
import { openJoinPage, openProfilePage } from '../../lib/join'
import { resolveCloudFileUrl } from '../../lib/cloud-file'
import {
  openChallengesPage,
  openParticipationsPage,
  openProfileHomePage,
  openStreakPage,
} from '../../lib/challenges'
import * as me from '../../lib/store'

/**
 * 组件实例上的**私有字段**（不参与渲染）。
 * ⚠️ 为什么不用 this.xxx / 为什么不放 data —— 见 nav-bar.ts 里同一段说明。
 */
interface Internals {
  unsub: (() => void) | null
  openTimer: ReturnType<typeof setTimeout> | null
  closeTimer: ReturnType<typeof setTimeout> | null
  /** 当前已换址的 fileID —— 用来丢弃"换到一半又被换掉"的旧结果 */
  avatarFileId: string
}

const priv = (ctx: unknown): Internals => {
  const p = ctx as Internals
  if (p.unsub === undefined) p.unsub = null
  if (p.openTimer === undefined) p.openTimer = null
  if (p.closeTimer === undefined) p.closeTimer = null
  if (p.avatarFileId === undefined) p.avatarFileId = ''
  return p
}

/** 滑出 / 收回的时长 —— 必须与 user-sheet.wxss 里的 transition 对齐 */
const SLIDE_MS = 220

/**
 * 抓手往下拖多少 px 就判定为「要收起」。
 * ⚠️ 用 px 不是 rpx：e.touches[].clientY 本身就是 px，换算一次只会多一个出错的地方。
 *    60px 大约是手机高度的十分之一 —— 比"手抖"大得多，又不用拖到底。
 */
const DRAG_CLOSE_PX = 60

/** 拖动过程中的临时状态（不参与渲染，所以不放 data） */
let dragStartY = 0
let dragOffset = 0
let dragActive = false
/** 等一帧再翻转状态，过渡才有机会发生（见 toggle 里的说明） */
const NEXT_FRAME_MS = 20

/**
 * 全局用户面板。
 *
 * ⚠️ 数据只有两个来源，都不在本组件里自己算：
 *    · 战绩 / 解冻卡 —— 全局 store 的 streak（服务端算好的视图）
 *    · 头像 / 昵称 / 已征服数 —— store 的 profile
 */
Component({
  properties: {
    show: {
      type: Boolean,
      value: false,
      observer(v: boolean) {
        this.toggle(v)
      },
    },
  },

  data: {
    /**
     * ⚠️ mounted 与 entered 是**两个**状态，不能合成一个：
     *    mounted 决定「在不在渲染树里」，entered 决定「滑到位没有」。
     *    合成一个的后果是**没有动画** —— 元素和它的最终样式在同一次渲染里生效，
     *    中间没有任何一帧可以过渡。
     */
    mounted: false,
    entered: false,
    /**
     * 拖动时给面板的内联 transform；平时是空串。
     * ⚠️ 只有拖动/回弹这几十毫秒里有值 —— 位置平时完全由 CSS 类决定，
     *    否则两个来源（类 + 内联）会打架，出现"滑出动画失效"这类怪事。
     */
    panelStyle: '',

    nickname: '未设置昵称',
    /** 有没有起过名字 —— 决定点进去的是「补资料」还是「修改资料」 */
    named: false,
    avatarUrl: '',
    /** 头像的**可显示地址** —— 库里存的是 cloud:// fileID，要先换一次 */
    avatarSrc: '',
    /** 没配头像时画的那张图 —— 与导航栏同一张（见 nav-bar.ts 的说明） */
    avatarPlaceholder: '/assets/avatar-placeholder.png',
    conqueredCount: 0,
    /** ⚡ 能量点数 */
    energy: 0,
    /** ⭐ 三个成长值（并排展示，**不合成总分**） */
    growth: { self: 0, diligence: 0, standout: 0 },
    streak: null as StreakView | null,
    /**
     * ⭐ 菜单项。
     * ⚠️ 「通知」暂时没有页面 —— 点了给一句「敬请期待」，
     *    而不是留一个点了没反应的死链接（那看起来就像坏了）。
     */
    menu: [
      { key: 'participations', icon: '🎯', label: '参与场次' },
      { key: 'challenges', icon: '📋', label: '我的挑战' },
      // ⭐ 连战记录排在这三个战绩入口的最后：它和它们是同一类 ——
      //    「我走到哪了」。⚠️ 别把它塞进「我的主页」里面当二级入口：
      //    那一页是**给别人看**的（对外展示），连战日历只给自己看。
      { key: 'streak', icon: '🔥', label: '连战记录' },
      { key: 'home', icon: '🏠', label: '我的主页' },
      { key: 'notice', icon: '🔔', label: '通知' },
    ],
  },

  lifetimes: {
    attached() {
      this.refreshView()
      priv(this).unsub = me.subscribe(() => {
        // 面板没开时不用白刷 —— 里面显示的是打开那一刻的数据
        if (this.data.mounted) this.refreshView()
      })
    },
    detached() {
      // ⚠️ 必须退订：不退的话组件销毁后回调还在跑，里面一句 setData 就报错
      const p = priv(this)
      p.unsub?.()
      p.unsub = null
      // ⚠️ 定时器也要撤：否则面板已经销毁，那个 setTimeout 还会去 setData
      if (p.openTimer !== null) clearTimeout(p.openTimer)
      if (p.closeTimer !== null) clearTimeout(p.closeTimer)
    },
  },

  methods: {
    toggle(open: boolean) {
      // ⚠️ 先撤掉上一轮的定时器：连点两下时，旧的那个会把刚拉开的面板又收回去
      const p = priv(this)
      if (p.openTimer !== null) {
        clearTimeout(p.openTimer)
        p.openTimer = null
      }
      if (p.closeTimer !== null) {
        clearTimeout(p.closeTimer)
        p.closeTimer = null
      }

      if (open) {
        // ⚠️ 先把**缓存里**的数据画出来（usually 上一次的 streak），再向服务端刷 ——
        //    否则每次拉开都会先看到一片空白，然后数字跳一下。
        this.refreshView()
        this.setData({ mounted: true })
        p.openTimer = setTimeout(() => {
          if (this.data.mounted) this.setData({ entered: true })
        }, NEXT_FRAME_MS)
        void this.refresh()
        return
      }

      this.setData({ entered: false })
      // ⚠️ 等动画放完再摘掉节点，否则面板会「啪」地消失而不是滑下去
      p.closeTimer = setTimeout(() => {
        p.closeTimer = null
        this.setData({ mounted: false })
      }, SLIDE_MS)
    },

    /**
     * 从 store 重画。store 里没有的就用兜底值 ——
     * 冷启动、还没拉到 profile 时也要能拉开，不能白屏。
     */
    refreshView() {
      const st = me.getState()
      const p = st.profile
      this.setData({
        nickname: (p?.nickname ?? '').trim() || '未设置昵称',
        named: !!p?.nickname,
        avatarUrl: p?.avatarUrl ?? '',
        conqueredCount: p?.conqueredCount ?? 0,
        energy: p?.energy ?? 0,
        growth: p?.growth ?? { self: 0, diligence: 0, standout: 0 },
        streak: st.streak,
      })

      // ⚠️ 库里存的是 cloud:// fileID，不能直接给 <image src> —— 先换成临时地址。
      //    换址期间用户可能又换了头像，回来的是旧地址就不覆盖（比 fileID）。
      const fileId = p?.avatarUrl ?? ''
      const self = priv(this)
      if (!fileId || fileId === self.avatarFileId) return
      self.avatarFileId = fileId
      void resolveCloudFileUrl(fileId).then((url) => {
        if (priv(this).avatarFileId === fileId) this.setData({ avatarSrc: url })
      })
    },

    /**
     * 每次拉开都向服务端要一次最新的「我是谁」。
     *
     * ⚠️ 失败只警告：面板里那几个数字取不到就用缓存里的，绝不能让面板打不开。
     *    写回 store 之后上面的订阅会重画，这里不用再 setData 一次。
     */
    async refresh() {
      try {
        me.applyProfile(await fetchMe())
      } catch (err) {
        console.warn('[user-sheet] 刷新用户资料失败：' + (err as Error).message)
      }
    },

    /**
     * ⭐ 补 / 改头像和昵称。
     *
     * ⚠️⚠️ 两个页面按**有没有起过名字**分流，不能合成一个：
     *    没起过名字的人看到的是「加入句拼 / 确认加入」—— 那是邀请；
     *    已经起过名字的人再看到一次，那一瞬间他会以为自己的账号没了。
     *    两页的表单是同一个组件，差别只在说法（见 pages/join 与 pages/profile-edit）。
     *
     * ⚠️ 它**不是登录**：账号（openid）早就有了，这里补的只是
     *    榜上显示成什么 —— **因此不点它也完全不影响使用**。
     * ⚠️ 先收面板再弹层：两层叠在一起，用户看到的是点了没反应。
     */
    onEditProfile() {
      this.triggerEvent('close')
      if (this.data.named) openProfilePage()
      else openJoinPage()
    },

    /**
     * ⭐ 菜单点击。
     * ⚠️ 先收面板再跳：面板盖在页面上，不收的话返回时它还开着。
     */
    onMenuTap(e: WechatMiniprogram.BaseEvent) {
      const key = (e.currentTarget.dataset as { key?: string }).key
      this.triggerEvent('close')

      if (key === 'challenges') {
        openChallengesPage()
        return
      }
      if (key === 'participations') {
        openParticipationsPage()
        return
      }
      if (key === 'streak') {
        openStreakPage()
        return
      }
      if (key === 'home') {
        openProfileHomePage()
        return
      }
      // ⚠️ 「通知」还没有页面 —— 说清楚，而不是点了没反应
      wx.showToast({ title: '通知 还在做，敬请期待', icon: 'none', duration: 1800 })
    },

    onClose() {
      this.triggerEvent('close')
    },

    /* ---------------------------------------------------------------- */
    /* 抓手的手势：按住往下拖，拖过阈值就收起                              */
    /* ---------------------------------------------------------------- */

    onGrabStart(e: WechatMiniprogram.TouchEvent) {
      const t = e.touches[0]
      if (!t) return
      dragStartY = t.clientY
      dragOffset = 0
      dragActive = true
    },

    /**
     * ⚠️ 这里**每帧一次 setData** —— 一般来说要避免（跨层通信很贵），
     *    但拖拽是唯一没有替代方案的地方：位置必须跟着手指走。
     *    （真嫌贵的做法是把这段挪进 WXS，代价是多一个文件、逻辑分两处。）
     * ⚠️ 只允许**往下**拖：面板本来就贴着底边，往上拖没有对应的语义，
     *    所以给 1/4 的阻尼，让"拖不动"这件事有反馈而不是完全僵住。
     */
    onGrabMove(e: WechatMiniprogram.TouchEvent) {
      if (!dragActive) return
      const t = e.touches[0]
      if (!t) return
      const dy = t.clientY - dragStartY
      dragOffset = dy > 0 ? dy : dy / 4
      this.setData({
        panelStyle: 'transform: translateY(' + dragOffset + 'px); transition: none',
      })
    },

    /**
     * ⚠️ 关闭有**两段**，顺序不能反：
     *    ① 先把面板顺着手指滑下去（内联样式 + 过渡）
     *    ② 动画结束再清掉内联样式、并通知父组件收起
     *    反过来（先清样式）面板会**先跳回原位**再往下滑 —— 看起来很怪。
     *    清掉之后位置由 .us-panel-on 是否还在决定，而这时 entered 已经是 false，
     *    所以不会二次跳动。
     */
    onGrabEnd() {
      if (!dragActive) return
      dragActive = false

      const settle = (to: string) =>
        this.setData({ panelStyle: 'transform: translateY(' + to + '); transition: transform ' + SLIDE_MS + 'ms ease-out' })

      if (dragOffset > DRAG_CLOSE_PX) {
        settle('100%')
        setTimeout(() => {
          this.setData({ panelStyle: '' })
          this.triggerEvent('close')
        }, SLIDE_MS)
        return
      }

      // 没拖够 → 弹回原位
      settle('0')
      setTimeout(() => this.setData({ panelStyle: '' }), SLIDE_MS)
    },

    /** 挡住冒泡 / 滚动穿透用的空处理器，不要删 */
    noop() {},
  },
})
