import { resolveCloudFileUrl } from '../../lib/cloud-file'
import { refreshMe, retryAuth } from '../../lib/auth'
import { openJoinPage } from '../../lib/join'
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
 * ⚠️ 首页那一格有**两种形态**：还没加入（服务端还不认识我）是「加入」按钮
 *    （点了再确认一次身份），加入之后才是头像（点了拉用户面板）。
 *    判据见 store 的 hasJoined —— **与有没有起昵称无关**。
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
    /** 已加入 = 有账号（见 store 的 hasJoined）—— 还没加入时这一格画的是「加入」按钮 */
    joined: false,
    /**
     * ⭐ 身份还没解析完（启动登录中）—— 这时左侧画 spinner，而不是「加入」。
     * ⚠️ 「还没问到」和「问到了但没有账号」是两件事，见 store 的 SessionState。
     */
    sessionPending: true,
    /** ⭐ 问不到（断网）—— 这一格画「重新连接」而不是「加入」（见 store 的 SessionState） */
    sessionUnknown: false,
    /** 头像的**可显示地址**（库里存的是 cloud:// fileID，要先换一次） */
    avatarSrc: '',
    /**
     * 没配头像时画的那张图 —— 打包在本地，不走网络。
     * ⚠️ 不用「昵称首字」兜底：首字和头像回答的是同一个问题（"这是我吗"），
     *    而一个字母方块看起来更像"图挂了"；占位图至少明确表示这里该有张脸。
     *    （生成脚本：tools/make-avatar-placeholder.mjs）
     */
    avatarPlaceholder: '/assets/avatar-placeholder.png',

    /**
     * 导航栏落不落白底 —— 默认**透明**，只在页面内容滚到它底下时才变白。
     * 由页面通过 notifyNavScroll() 喂进来（见 methods.applyScrollTop）。
     */
    solid: false,

    /** 用户面板开着没有 */
    sheetOpen: false,

    /** 正在判定「已经加入过、还是新人」—— 只用来挡住连点，别让两次判定各弹一个层 */
    joinBusy: false,
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
     *    先定下"加入过没有 / 显示什么字"，地址到了再补上。
     */
    syncProfile() {
      const st = me.getState()
      const p = st.userInfo
      const joined = me.hasJoined()
      this.setData({
        joined,
        // ⚠️ pending = 还在问 ⇒ 画 spinner，别先画一个假的「加入」再闪掉
        sessionPending: st.session === 'pending',
        // ⚠️ unknown = 问不到（断网）⇒ 画「重新连接」，**不画「加入」**：
        //    库里有没有我这一行，这会儿谁都不知道（见 store 的 SessionState）
        sessionUnknown: st.session === 'unknown',
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
        // ⚠️ 身份还在解析中：这一格是 spinner，不接受点击（也避免误触重试）
        if (this.data.sessionPending) return
        /**
         * ⭐⭐ 这一格是「加入 / 重新连接」—— 两种状态的去处**不同**，别混：
         *
         *   · 「加入」（session ready + 库里没我）—— 用户明确要加入 ⇒ 去加入页。
         *     **注册就发生在那一页按下「确认加入」的那一下**（2026-09 定：
         *     注册不能是自动的）。这里绝不替他建号。
         *   · 「重新连接」（session unknown，问不到）—— 他想的是**再试一次**，
         *     不是"加入"：只重新问一次；问到"未加入"才去加入页，
         *     仍然问不到就提示一句，**不乱跳**（跳到加入页也提交不了，那一页同样要连服务端）。
         *
         * ⚠️ 判据 `hasJoined()`（= `userInfo !== null`）与 `lib/auth` 的 `isAuthed()`
         *    是**同一个**（两处必须一致，否则界面说"没记录"、按钮却说"能动手"）。
         */
        if (!this.data.joined) {
          if (this.data.joinBusy) return
          this.setData({ joinBusy: true })
          void this.onRetryIdentity().finally(() => this.setData({ joinBusy: false }))
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
     * ⭐ 左上一格是「加入 / 重新连接」时的处置（见 onLeftTap 的说明）。
     *
     * ⚠️ 两条路**不能合并**：`retryAuth()` 的语义是"用户明确要加入"——
     *    它在问不到时也会把人带去加入页。而「重新连接」那一格**不是**要加入，
     *    只是要再连一次；连不上就提示，别把人推进一个同样连不上的表单。
     */
    async onRetryIdentity() {
      if (!this.data.sessionUnknown) {
        // 已知"库里没我" + 用户点了「加入」⇒ 去加入页（注册发生在那一页）
        await retryAuth()
        return
      }
      const r = await refreshMe()
      if (r === 'unknown') {
        // 仍然连不上：说一句能做什么，别乱跳
        wx.showToast({ title: '连不上服务，稍后再试', icon: 'none' })
        return
      }
      if (r === 'unregistered') {
        openJoinPage()
        return
      }
      // r === 'joined'：store 广播已经让这一格画成头像，什么都不用做
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
