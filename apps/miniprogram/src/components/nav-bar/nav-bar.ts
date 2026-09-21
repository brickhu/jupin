import { resolveCloudFileUrl } from '../../lib/cloud-file'
import { getNavMetrics, navSolidFrom } from '../../lib/nav'
import * as me from '../../lib/store'

/** 首页路径 —— 回首页 / 返回失败时的兜底，只在这里写一次 */
const HOME_URL = '/pages/index/index'

/**
 * 组件实例上的**私有字段**（不参与渲染）。
 *
 * ⚠️ 为什么不用 `this.unsub`：miniprogram-api-typings 的 Component.Options 里
 *    没有给自定义实例属性留位置，直接写会编译不过。
 * ⚠️ 更不能塞进 data：data 是**要整份同步给渲染层**的，里面放函数和定时器
 *    是自找麻烦（小程序的 data 只保证可 JSON 化的值）。
 */
interface Internals {
  unsub: (() => void) | null
}

/** 组件实例上另外那个私有字段：当前已换址的 fileID（避免换址回来覆盖了新头像） */
interface AvatarHolder {
  avatarFileId?: string
}

/** 取私有字段（第一次访问时补上默认值，省掉满地的 ?. 与 !） */
const priv = (ctx: unknown): Internals & AvatarHolder => {
  const p = ctx as Internals & AvatarHolder
  if (p.unsub === undefined) p.unsub = null
  if (p.avatarFileId === undefined) p.avatarFileId = ''
  return p
}

/**
 * 统一的自定义导航栏。
 *
 * ⚠️ 为什么是组件而不是每页抄一段 WXML：
 *    三个页面的头条必须**长得一模一样**，包括状态栏高度、胶囊避让、
 *    标题基线。抄三份的结果是改一处漏两处，而漏掉的那一页会顶到状态栏上。
 *
 * ⚠️⚠️ 左侧显示什么由**页面栈深度**决定，不是由页面自己声明：
 *    同一个页面既可能是「从首页上来的」（能返回），
 *    也可能就是**栈底**（开发者工具直接编译到这一页、分享卡片 / 扫码直达）。
 *    栈底画一个「返回」点了没反应，比不画更糟 —— 那时要画「回首页」。
 *
 * ⚠️ 首页那一格有**两种形态**：没登录是「登录」按钮（点了拉授权层），
 *    登录后才是头像（点了拉用户面板）。判据见 store 的 isLoggedIn。
 */
Component({
  properties: {
    /** 中间标题 */
    title: { type: String, value: '' },
    /**
     * 左侧显示什么：
     *   'avatar' —— 首页：点头像拉开用户面板
     *   'auto'   —— 其余页面：按页面栈深度自动决定（回首页 / 返回）
     */
    left: { type: String, value: 'auto' },
  },

  data: {
    // 下面四个由 getNavMetrics() 在 attached 里填，初值只是为了让首帧有个形状
    statusBarHeight: 20,
    barHeight: 44,
    totalHeight: 64,
    sideWidth: 87,

    /** 'avatar' | 'home' | 'back' */
    leftMode: 'back' as 'avatar' | 'home' | 'back',
    /** 已登录 = 有昵称（见 store 的 isLoggedIn）—— 没登录时这一格画的是「登录」按钮 */
    loggedIn: false,
    /** 头像的**可显示地址**（库里存的是 cloud:// fileID，要先换一次） */
    avatarSrc: '',
    initial: '朗',

    /**
     * 导航栏落不落白底 —— 默认**透明**，只在页面内容滚到它底下时才变白。
     * 由页面通过 notifyNavScroll() 喂进来（见 methods.applyScrollTop）。
     */
    solid: false,

    /** 用户面板开着没有 */
    sheetOpen: false,
  },

  lifetimes: {
    attached() {
      const m = getNavMetrics()
      this.setData({
        statusBarHeight: m.statusBarHeight,
        barHeight: m.navBarHeight,
        totalHeight: m.totalHeight,
        sideWidth: m.sideWidth,
      })
      this.syncLeft()
      this.syncProfile()
      priv(this).unsub = me.subscribe(() => this.syncProfile())
    },
    detached() {
      // ⚠️ 必须退订：不退的话组件销毁后回调还在跑，里面一句 setData 就报错
      priv(this).unsub?.()
      priv(this).unsub = null
    },
  },

  pageLifetimes: {
    /**
     * ⚠️ 每次 show 都要重算左侧 —— resolveLeft 依赖**当时**的页面栈深度，
     *    而同一个组件实例会经历进栈 / 出栈。
     */
    show() {
      this.syncLeft()
      this.syncProfile()
    },
  },

  methods: {
    /** 左侧该显示什么 */
    resolveLeft(): 'avatar' | 'home' | 'back' {
      if (this.data.left === 'avatar') return 'avatar'
      // 深度 = 我在页面栈里**下面还压着几页**。0 表示回不去（见组件头的说明）。
      const depth = getCurrentPages().length - 1
      return depth < 1 ? 'home' : 'back'
    },

    syncLeft() {
      const leftMode = this.resolveLeft()
      if (leftMode !== this.data.leftMode) this.setData({ leftMode })
    },

    /**
     * 头像 / 昵称变了就重画左侧那一格（store 广播过来）。
     *
     * ⚠️ 库里存的是 cloud:// fileID，不能直接塞给 <image src> ——
     *    要先换成临时地址。换址是异步的，所以分两步 setData：
     *    先定下"登录了没有 / 显示什么字"，地址到了再补上。
     */
    syncProfile() {
      const p = me.getState().profile
      const loggedIn = me.isLoggedIn()
      this.setData({
        loggedIn,
        // ⚠️ 没有头像时用**昵称首字**兜底：一个空圆圈传达不了任何信息，
        //    而一个字就够 —— 它回答的是「这是我吗」。
        initial: (p?.nickname ?? '').trim().slice(0, 1) || '朗',
      })

      const fileId = p?.avatarUrl ?? ''
      const self = priv(this)
      if (!fileId || fileId === self.avatarFileId) return
      self.avatarFileId = fileId
      void resolveCloudFileUrl(fileId).then((url) => {
        // ⚠️ 换址期间用户可能又换了头像，回来的是旧地址就别覆盖了
        if (priv(this).avatarFileId === fileId) this.setData({ avatarSrc: url })
      })
    },

    onLeftTap() {
      if (this.data.leftMode === 'avatar') {
        // ⭐ 没登录时这一格是「登录」按钮：点它拉授权层，而不是开用户面板
        if (!this.data.loggedIn) {
          me.openLoginSheet()
          return
        }
        this.setData({ sheetOpen: true })
        return
      }
      // ⚠️ navigateBack 也可能失败（页面栈被别处清过），失败时不能什么都不做 ——
      //    那看起来就是「返回按钮坏了」。所以一律兜底成回首页。
      if (getCurrentPages().length > 1) {
        wx.navigateBack({ delta: 1, fail: () => wx.reLaunch({ url: HOME_URL }) })
        return
      }
      wx.reLaunch({ url: HOME_URL })
    },

    /**
     * 页面滚动到哪了 —— 由页面的 onPageScroll 调过来（见 lib/nav.ts 的 notifyNavScroll）。
     *
     * ⚠️ 只在**翻面时**才 setData：onPageScroll 每帧都触发，
     *    每帧写一次 data 就是每帧一次跨层通信，滚动会立刻掉帧。
     *    而这里要的本来也只是一个布尔。
     */
    applyScrollTop(scrollTop: number) {
      const solid = scrollTop >= navSolidFrom()
      if (solid !== this.data.solid) this.setData({ solid })
    },

    onSheetClose() {
      this.setData({ sheetOpen: false })
    },
  },
})
