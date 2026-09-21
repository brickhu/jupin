import { CLOUD_ENV_ID } from '../../config'
import { fetchMe, getUserId, saveProfile } from '../../lib/api/client'
import * as me from '../../lib/store'

/**
 * ⭐ 「加入句拼」页 —— 用户从「一个打开小程序的人」变成「榜上有名字的人」的地方。
 *
 * ⚠️ 为什么叫**加入**而不是登录：身份（openid）是 wx.login 静默拿到的，
 *    用户从头到尾没有"没登录"过（见 lib/api/client.ts）。
 *    他真正做的那个动作是**加入**：认领一个名字、一个头像，从此成绩有主。
 *    界面上叫"登录"会让人以为"我有个账号要输密码"，而其实一个字段都不用填密码。
 *
 * ⚠️⚠️ 头像和昵称**没法自动读取**，这不是没做，是微信不允许：
 *    官方「头像昵称填写」能力只给了两个入口 ——
 *      · <button open-type="chooseAvatar"> 用户点了才会弹「用微信头像」
 *      · <input type="nickname"> 用户点进输入框时，键盘上方才出现微信昵称
 *    2022-10-25 起 wx.getUserProfile / wx.getUserInfo 一律返回匿名数据
 *    （灰头像 + "微信用户"），所以"静默读到头像昵称"这条路已经不存在了。
 *    ⇒ 我们能做的是把这两下点得尽量顺：一进来就把昵称框**自动聚焦**，
 *      微信昵称就悬在键盘上方等着一键填入；头像那一格写清楚点了会发生什么。
 *
 * ⚠️ 头像拿到的是**临时路径**（wxfile:// 或 http://tmp/…），必须先上传到
 *    云存储换成 fileID 再落库 —— 临时路径出了这台设备就不存在了，
 *    存进库里只会得到一张永远加载不出来的图。
 */

/** 滑出 / 收回的时长 —— 必须与 join-sheet.wxss 里的 transition 对齐 */
const SLIDE_MS = 220
/** 等一帧再翻转状态，过渡才有机会发生 */
const NEXT_FRAME_MS = 20
/**
 * 聚焦昵称框的时机：**等面板滑完**再聚焦。
 * ⚠️ 滑到一半就弹键盘，键盘会把面板顶上去，动画和键盘打架，看起来像卡住。
 */
const FOCUS_AFTER_MS = SLIDE_MS + 60

interface Internals {
  unsub: (() => void) | null
  openTimer: ReturnType<typeof setTimeout> | null
  closeTimer: ReturnType<typeof setTimeout> | null
  focusTimer: ReturnType<typeof setTimeout> | null
}

const priv = (ctx: unknown): Internals => {
  const p = ctx as Internals
  if (p.unsub === undefined) p.unsub = null
  if (p.openTimer === undefined) p.openTimer = null
  if (p.closeTimer === undefined) p.closeTimer = null
  if (p.focusTimer === undefined) p.focusTimer = null
  return p
}

Component({
  data: {
    mounted: false,
    entered: false,

    /** 用户选的头像（**临时路径**，仅用于本地预览） */
    avatarPath: '',
    nickname: '',
    saving: false,
    error: '',

    /**
     * 昵称框要不要聚焦。
     * ⚠️ 必须显式在 false / true 之间来回翻：小程序只在**值变化**时重新聚焦，
     *    一直挂着 true 的话第二次打开面板就不会再弹键盘了。
     */
    focusNickname: false,
  },

  lifetimes: {
    attached() {
      this.sync()
      priv(this).unsub = me.subscribe(() => this.sync())
    },
    detached() {
      const p = priv(this)
      p.unsub?.()
      p.unsub = null
      if (p.openTimer !== null) clearTimeout(p.openTimer)
      if (p.closeTimer !== null) clearTimeout(p.closeTimer)
      if (p.focusTimer !== null) clearTimeout(p.focusTimer)
    },
  },

  methods: {
    /** 跟着 store 的标志开合 */
    sync() {
      const open = me.getState().joinSheet
      if (open && !this.data.mounted) this.open()
      else if (!open && this.data.mounted) this.close()
    },

    open() {
      const p = priv(this)
      if (p.closeTimer !== null) {
        clearTimeout(p.closeTimer)
        p.closeTimer = null
      }
      // ⚠️ 已经加入过的人再打开这个层（比如换头像），昵称要预填上 —— 否则等于让他重打一遍
      const profile = me.getState().profile
      this.setData({
        mounted: true,
        error: '',
        // 先置 false，滑完再置 true：见 focusNickname 的说明（要有一个「变化」）
        focusNickname: false,
        nickname: this.data.nickname || profile?.nickname || '',
      })
      p.openTimer = setTimeout(() => {
        if (!this.data.mounted) return
        this.setData({ entered: true })
        /**
         * ⭐ 滑完就把昵称框点亮 —— 这一步是整页顺不顺的关键。
         *
         * ⚠️ 微信昵称**读不到**（见文件头），但它就悬在键盘上方：
         *    输入框一聚焦，用户抬手一点就填好了。不聚焦的话，
         *    他会以为"这里要我手打一个名字"，然后自己编一个。
         */
        p.focusTimer = setTimeout(() => {
          p.focusTimer = null
          if (this.data.mounted) this.setData({ focusNickname: true })
        }, FOCUS_AFTER_MS)
      }, NEXT_FRAME_MS)
    },

    close() {
      const p = priv(this)
      if (p.openTimer !== null) clearTimeout(p.openTimer)
      if (p.focusTimer !== null) clearTimeout(p.focusTimer)
      this.setData({ entered: false, focusNickname: false })
      p.closeTimer = setTimeout(() => {
        p.closeTimer = null
        this.setData({ mounted: false })
      }, SLIDE_MS)
    },

    onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>) {
      // ⚠️ 这只是**临时路径**，不是能落库的地址 —— 提交时才上传（见 uploadAvatar）
      this.setData({ avatarPath: e.detail?.avatarUrl ?? '', error: '' })
    },

    onNickname(e: WechatMiniprogram.Input) {
      this.setData({ nickname: e.detail?.value ?? '', error: '' })
    },

    async onConfirm() {
      if (this.data.saving) return
      const nickname = this.data.nickname.trim()
      if (!nickname) {
        this.setData({ error: '先起个名字吧 —— 榜单上要靠它认出你', focusNickname: true })
        return
      }

      this.setData({ saving: true, error: '' })
      try {
        // ① 头像先上传（没选就跳过 —— 头像是可选的）
        let fileId = ''
        if (this.data.avatarPath) {
          fileId = await this.uploadAvatar(this.data.avatarPath)
        }
        // ② 落库
        await saveProfile({ nickname, ...(fileId ? { avatarUrl: fileId } : {}) })
        // ③ 用**服务端返回的**资料刷新全局 store（昵称可能被净化过：长度、控制字符）
        //    ⚠️ applyProfile 会顺手把这一层收起来 ✔
        me.applyProfile(await fetchMe())
      } catch (err) {
        this.setData({ error: (err as Error).message || '加入失败，请重试' })
      } finally {
        this.setData({ saving: false })
      }
    },

    /**
     * 头像上传到**云开发对象存储**。
     *
     * ⚠️ 走 wx.cloud.uploadFile 而不是 wx.uploadFile：前者是云开发通道，
     *    **不需要配 uploadFile 合法域名**，和用户录音上传是同一条路。
     * ⚠️ 路径前缀必须是 avatars/ —— 服务端只接受这个前缀的 fileID
     *    （见 routes/user.ts 的 normalizeAvatarUrl），免得它变成任意文件的分布器。
     */
    async uploadAvatar(tempPath: string): Promise<string> {
      if (typeof wx.cloud?.uploadFile !== 'function') return ''
      const uid = getUserId()
      const ext = (tempPath.split('?')[0] ?? '').split('.').pop() ?? 'png'
      const safeExt = /^[A-Za-z0-9]{1,5}$/.test(ext) ? ext : 'png'
      const res = await wx.cloud.uploadFile({
        cloudPath: 'avatars/' + uid + '/' + Date.now() + '.' + safeExt,
        filePath: tempPath,
        config: { env: CLOUD_ENV_ID },
      })
      return res.fileID ?? ''
    },

    onClose() {
      me.closeJoinSheet()
    },

    /** 挡住冒泡 / 滚动穿透用的空处理器，不要删 */
    noop() {},
  },
})
