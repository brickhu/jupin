import { BADGES } from '@jushuo/shared'
import type { StreakView } from '@jushuo/shared'

import { fetchMe } from '../../lib/api/client'
import { resolveCloudFileUrl } from '../../lib/cloud-file'
import * as me from '../../lib/store'

/** 徽章阶梯里的一行 */
interface LadderRow {
  code: string
  emoji: string
  name: string
  /** 达成所需的历史最长连续天数 */
  days: number
  earned: boolean
  note: string
}

/**
 * 徽章阶梯 → 展示行。
 *
 * ⚠️ 徽章**不落库**，它只是 f(历史最长连续天数)（见 @jushuo/shared/badges）——
 *    所以这里也不需要向服务端要一份「我有哪些徽章」，那是第二份真相。
 *
 * ⚠️ 已得的写「它是什么」，未得的写「还差几天」：
 *    两行都写「还差 N 天」的话，手里那个徽章反而没有任何说明。
 */
function ladderOf(streak: StreakView | null): LadderRow[] {
  const best = streak?.streakBest ?? 0
  return BADGES.map((b) => ({
    code: b.code,
    emoji: b.emoji,
    name: b.name,
    days: b.days,
    earned: best >= b.days,
    note: best >= b.days ? b.blurb : '还差 ' + (b.days - best) + ' 天',
  }))
}

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
/** 等一帧再翻转状态，过渡才有机会发生（见 toggle 里的说明） */
const NEXT_FRAME_MS = 20

/**
 * 全局用户面板。
 *
 * ⚠️ 数据只有两个来源，都不在本组件里自己算：
 *    · 战绩 / 徽章 —— 全局 store 的 streak（服务端算好的视图）
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

    nickname: '挑战者',
    avatarUrl: '',
    /** 头像的**可显示地址** —— 库里存的是 cloud:// fileID，要先换一次 */
    avatarSrc: '',
    initial: '朗',
    conqueredCount: 0,
    streak: null as StreakView | null,
    ladder: [] as LadderRow[],
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
        nickname: (p?.nickname ?? '').trim() || '挑战者',
        avatarUrl: p?.avatarUrl ?? '',
        initial: (p?.nickname ?? '').trim().slice(0, 1) || '朗',
        conqueredCount: p?.conqueredCount ?? 0,
        streak: st.streak,
        ladder: ladderOf(st.streak),
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
     * ⭐ 改头像 / 改昵称。
     *
     * ⚠️ 复用**加入页**（它本来就会把现有昵称预填上），而不是再写一个编辑弹层：
     *    两处的字段完全一样，多一份就多一份会走样。
     * ⚠️ 先收面板再弹层：两层叠在一起，用户看到的是"点了没反应"。
     */
    onEditProfile() {
      this.triggerEvent('close')
      me.openJoinSheet()
    },

    onClose() {
      this.triggerEvent('close')
    },

    /** 挡住冒泡 / 滚动穿透用的空处理器，不要删 */
    noop() {},
  },
})
