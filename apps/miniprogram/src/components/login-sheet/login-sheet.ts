import { CLOUD_ENV_ID } from '../../config'
import { fetchMe, getUserId, saveProfile } from '../../lib/api/client'
import * as me from '../../lib/store'

/**
 * ⭐ 授权登录层 —— 小程序「头像昵称填写能力」的落地处。
 *
 * ⚠️ 它由全局 store 的 loginSheet 标志驱动（见 store.ts 那段说明）：
 *    要弹它的人和渲染它的人是不同页面，各自是独立模块作用域，
 *    只有放在**外置的共享 store** 里才传得过去。
 *
 * ⚠️ 头像拿到的是**临时路径**（wxfile:// 或 http://tmp/…），必须先上传到
 *    云存储换成 fileID 再落库 —— 临时路径出了这台设备就不存在了，
 *    存进库里只会得到一张永远加载不出来的图。
 */

/** 滑出 / 收回的时长 —— 必须与 login-sheet.wxss 里的 transition 对齐 */
const SLIDE_MS = 220
/** 等一帧再翻转状态，过渡才有机会发生 */
const NEXT_FRAME_MS = 20

interface Internals {
  unsub: (() => void) | null
  openTimer: ReturnType<typeof setTimeout> | null
  closeTimer: ReturnType<typeof setTimeout> | null
}

const priv = (ctx: unknown): Internals => {
  const p = ctx as Internals
  if (p.unsub === undefined) p.unsub = null
  if (p.openTimer === undefined) p.openTimer = null
  if (p.closeTimer === undefined) p.closeTimer = null
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
    },
  },

  methods: {
    /** 跟着 store 的标志开合 */
    sync() {
      const open = me.getState().loginSheet
      if (open && !this.data.mounted) this.open()
      else if (!open && this.data.mounted) this.close()
    },

    open() {
      const p = priv(this)
      if (p.closeTimer !== null) {
        clearTimeout(p.closeTimer)
        p.closeTimer = null
      }
      // ⚠️ 已经登录过的人再打开这个层（比如换头像），昵称要预填上 —— 否则等于让他重打一遍
      const profile = me.getState().profile
      this.setData({
        mounted: true,
        error: '',
        nickname: this.data.nickname || profile?.nickname || '',
      })
      p.openTimer = setTimeout(() => {
        if (this.data.mounted) this.setData({ entered: true })
      }, NEXT_FRAME_MS)
    },

    close() {
      const p = priv(this)
      if (p.openTimer !== null) {
        clearTimeout(p.openTimer)
        p.openTimer = null
      }
      this.setData({ entered: false })
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
        this.setData({ error: '请先填写昵称 —— 榜单上要靠它认出你' })
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
        this.setData({ error: (err as Error).message || '登录失败，请重试' })
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
      me.closeLoginSheet()
    },

    /** 挡住冒泡 / 滚动穿透用的空处理器，不要删 */
    noop() {},
  },
})
