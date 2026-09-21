import { CLOUD_ENV_ID } from '../../config'
import { getUserId, saveProfile } from '../../lib/api/client'
import { refreshMe } from '../../lib/join'
import * as me from '../../lib/store'

/**
 * ⭐ 头像 + 昵称表单 —— 「加入句拼」和「修改资料」**共用同一个**。
 *
 * ⚠️⚠️ 为什么是组件而不是两个页面各写一份：
 *    真正要紧的不是那两行排版，是**保存那一步**：头像先上传换 fileID、
 *    昵称落库、用保存接口的返回值更新全局 state（见 store 的 applyProfilePatch）。
 *    抄第二份的那一刻，两边就开始各自演化 —— 而这类分叉不会报错，
 *    只会表现为"改资料那条路和加入那条路的行为不一样"，极难查。
 *
 * ⚠️ 两个页面的差别只有**文案**（按钮说「确认加入」还是「保存」）
 *    和**要不要自动聚焦昵称框**（新人需要，来改头像的人不需要），
 *    都用属性传进来。
 *
 * ⚠️⚠️ profile-form.json 里那句 "styleIsolation": "apply-shared" **不能删**。
 *
 *    小程序自定义组件默认样式隔离（isolated），而**app.wxss 里的类样式进不了组件** ——
 *    我们的 UnoCSS 工具类全部产在 app.wxss 里（见 build.mjs 的 uno 产物）。
 *    于是这个组件里写的 bg-brand / text-30rpx 会**一条都不生效**，
 *    而且不报错：按钮没有底色、字全是默认大小，看起来像"样式丢了"。
 *    apply-shared 让页面（含 app.wxss）的样式作用到组件内部，正好补上这一环。
 *
 *    ⚠️ 反过来说：导航栏和用户面板里的类名全是手写的 nv-* / us-*（在各自的 wxss 里），
 *       所以它们不需要这一句。**在这个组件里加 Uno 类名，就必须留着 apply-shared。**
 */

/** 等页面转场结束再聚焦：转场还没完就弹键盘，两者抢位置，看起来像卡住 */
const FOCUS_AFTER_MS = 320

Component({
  properties: {
    /** 提交按钮文案 */
    submitLabel: { type: String, value: '保存' },
    /**
     * 要不要自动聚焦昵称框。
     * ⚠️ 只在**还没起过名字**时才真的聚焦（新人进来，微信昵称悬在键盘上方等他一键填入）；
     *    已经填好的别弹键盘打扰他 —— 那种情况多半是来换头像的。
     */
    autoFocus: { type: Boolean, value: false },
  },

  data: {
    /** 用户选的头像（**临时路径**，仅用于本地预览） */
    avatarPath: '',
    nickname: '',
    focusNickname: false,
    saving: false,
    error: '',
  },

  lifetimes: {
    attached() {
      // ⚠️ 已经起过名字的：预填上，别让他重打一遍
      const p = me.getState().profile
      const nickname = p?.nickname ?? ''
      if (nickname) {
        this.setData({ nickname })
        return
      }
      if (!this.data.autoFocus) return
      // ⭐ 新人这条路才是关键：不聚焦，用户会以为"这里要我手打一个名字"，然后自己编一个
      setTimeout(() => {
        if (!this.data.nickname) this.setData({ focusNickname: true })
      }, FOCUS_AFTER_MS)
    },
  },

  methods: {
    onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>) {
      // ⚠️ 这只是**临时路径**，不是能落库的地址 —— 提交时才上传（见 uploadAvatar）
      this.setData({ avatarPath: e.detail?.avatarUrl ?? '', error: '' })
    },

    onNickname(e: WechatMiniprogram.Input) {
      this.setData({ nickname: e.detail?.value ?? '', error: '' })
    },

    /**
     * 提交。没填昵称时**什么都不做**（按钮也是置灰的，见 WXML 的说明）：
     * 这里是"静止"，不是"报错"——点一个看起来不能点的按钮却弹出提示，
     * 等于把没填东西这件事说成了一次事故。
     */
    async onSubmit() {
      if (this.data.saving) return
      const nickname = this.data.nickname.trim()
      if (!nickname) return

      this.setData({ saving: true, error: '' })
      try {
        // ① 头像先上传（没选就跳过 —— 头像是可选的）
        let fileId = ''
        let avatarFailed = false
        if (this.data.avatarPath) {
          try {
            fileId = await this.uploadAvatar(this.data.avatarPath)
            avatarFailed = !fileId
          } catch (err) {
            /**
             * ⚠️⚠️ 头像传不上去**不该拖住保存**：它是个装饰，昵称才是主角。
             *    但也**不能一声不吭** —— 用户明明选了张图，结果是"没有头像"，
             *    他会以为是这个功能坏了（本项目真踩过：本地少配了云存储，
             *    服务端把头像全拒了，客户端却一点提示都没有）。
             */
            avatarFailed = true
            console.warn('[profile-form] 头像上传失败，本次不带头像：' + (err as Error).message)
          }
        }
        // ② 落库，并**用它的返回值**更新全局 state（见 store 的 applyProfilePatch）
        const saved = await saveProfile({ nickname, ...(fileId ? { avatarUrl: fileId } : {}) })
        me.applyProfilePatch(saved)
        /**
         * ③ 再顺手拉一次完整的 /me（已征服数 / streak 在保存接口的返回值里没有）。
         * ⚠️ 不 await、也不管失败：**"已保存"这件事在第 ② 步就已经定死了**，
         *    这一步只是补数据。等它，等于让结论再赌一次网络。
         */
        void refreshMe()
        // ④ 告诉页面：成了，你自己决定去哪儿
        this.triggerEvent('saved', { avatarFailed })
      } catch (err) {
        this.setData({ error: (err as Error).message || '保存失败，请重试' })
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
  },
})
