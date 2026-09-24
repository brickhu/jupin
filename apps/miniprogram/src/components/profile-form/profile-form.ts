import type { Gender } from '@jushuo/shared'

import { CLOUD_ENV_ID } from '../../config'
import { getUserId, saveProfile } from '../../lib/api/client'
import { resolveCloudFileUrl } from '../../lib/cloud-file'
import { refreshMe } from '../../lib/join'
import * as me from '../../lib/store'

/**
 * ⭐ 资料表单 —— 「加入句拼」和「修改资料」**共用同一个**。
 *
 * ⚠️⚠️ 为什么是组件而不是两个页面各写一份：
 *    真正要紧的不是那几行排版，是**保存那一步**：头像先上传换 fileID、
 *    其余字段落库、用保存接口的返回值更新全局 state（见 store 的 applyProfilePatch）。
 *    抄第二份的那一刻，两边就开始各自演化 —— 而这类分叉不会报错，
 *    只会表现为"改资料那条路和加入那条路的行为不一样"，极难查。
 *
 * ⚠️ 两个页面的差别用**属性**传进来：
 *    · submitLabel —— 按钮说「确认加入」还是「保存」
 *    · autoFocus   —— 新人要自动聚焦昵称框，来改资料的人不要
 *    · full        —— 要不要显示 性别 / 年龄 / 简介
 *      加入页只要**昵称 + 头像**（full=false）；资料页要全字段（full=true）。
 *
 * ⚠️⚠️ 头像有两个字段，别合并：
 *    · avatarSrc  —— **显示用**。进来时先把已有的 fileID 换成临时地址填进去，
 *                    否则「修改资料」看到的是一个「＋」，等于逼用户重新选一次。
 *    · avatarPath —— **仅当用户重新选了头像**时才有的本地临时文件。
 *                    提交时只有它非空才上传；否则不传 avatarUrl，服务端保持原样。
 *
 * ⚠️⚠️ profile-form.json 里那句 "styleIsolation": "apply-shared" **不能删**。
 *
 *    小程序自定义组件默认样式隔离（isolated），而**app.wxss 里的类样式进不了组件** ——
 *    我们的 UnoCSS 工具类全部产在 app.wxss 里（见 build.mjs 的 uno 产物）。
 *    于是这个组件里写的 bg-brand / text-30rpx 会**一条都不生效**，
 *    而且不报错：按钮没有底色、字全是默认大小，看起来像"样式丢了"。
 *    apply-shared 让页面（含 app.wxss）的样式作用到组件内部，正好补上这一环。
 */

/** 等页面转场结束再聚焦：转场还没完就弹键盘，两者抢位置，看起来像卡住 */
const FOCUS_AFTER_MS = 320

/** 性别选择器的展示值 —— 下标与 GENDER_VALUES 一一对应 */
const GENDER_OPTIONS = ['不填', '男', '女']
const GENDER_VALUES: (Gender | null)[] = [null, 'male', 'female']

const AGE_MIN = 6
const AGE_MAX = 120

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
    /**
     * ⭐ 要不要显示 性别 / 年龄 / 简介。
     *   加入页只要昵称+头像（false），资料页要全字段（true）。
     */
    full: { type: Boolean, value: false },
  },

  data: {
    /** 显示中的头像地址（新选的本地路径，或已有头像换出来的临时地址） */
    avatarSrc: '',
    /** ⚠️ 只有**重新选过**头像时才有值 —— 空 = 不动库里那张 */
    avatarPath: '',
    nickname: '',
    genderOptions: GENDER_OPTIONS,
    genderIndex: 0,
    genderLabel: GENDER_OPTIONS[0] ?? '不填',
    /** 年龄输入框的原始文本；'' = 未填 */
    ageText: '',
    bio: '',
    focusNickname: false,
    saving: false,
    error: '',
  },

  lifetimes: {
    attached() {
      // ⚠️ 已有的资料全部**预填**，别让用户重打 / 重选一遍
      const p = me.getState().userInfo
      const nickname = p?.nickname ?? ''
      const genderIndex = p?.gender === 'male' ? 1 : p?.gender === 'female' ? 2 : 0
      this.setData({
        nickname,
        genderIndex,
        genderLabel: GENDER_OPTIONS[genderIndex] ?? GENDER_OPTIONS[0],
        ageText: p?.age != null ? String(p.age) : '',
        bio: p?.bio ?? '',
      })

      /**
       * ⭐⭐ 已有头像**先显示出来** —— 这就是那个「修改 ≠ 重新提交」的修复点。
       * ⚠️ 换址是异步的：回来时用户可能已经选了新头像，那就别用旧的把它盖掉。
       */
      const fileId = p?.avatarUrl ?? ''
      if (fileId) {
        void resolveCloudFileUrl(fileId).then((url) => {
          if (url && !this.data.avatarPath) this.setData({ avatarSrc: url })
        })
      }

      if (nickname) return
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
      const avatarPath = e.detail?.avatarUrl ?? ''
      this.setData({ avatarPath, avatarSrc: avatarPath, error: '' })
    },

    onNickname(e: WechatMiniprogram.Input) {
      this.setData({ nickname: e.detail?.value ?? '', error: '' })
    },

    onGender(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
      const idx = Number(e.detail?.value)
      const genderIndex = Number.isInteger(idx) && idx >= 0 && idx < GENDER_OPTIONS.length ? idx : 0
      this.setData({
        genderIndex,
        genderLabel: GENDER_OPTIONS[genderIndex] ?? GENDER_OPTIONS[0],
        error: '',
      })
    },

    onAge(e: WechatMiniprogram.Input) {
      this.setData({ ageText: e.detail?.value ?? '', error: '' })
    },

    onBio(e: WechatMiniprogram.Input) {
      this.setData({ bio: e.detail?.value ?? '', error: '' })
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

      /**
       * 资料页才处理这三个字段；加入页（full=false）**根本不发**它们，
       * 服务端「键不存在 = 不改」的语义会保持原值。
       */
      let gender: Gender | null = null
      let age: number | null = null
      let bio: string | null = null
      if (this.data.full) {
        const ageRaw = this.data.ageText.trim()
        if (ageRaw) {
          const n = Number(ageRaw)
          if (!Number.isInteger(n) || n < AGE_MIN || n > AGE_MAX) {
            this.setData({ error: '年龄请填 ' + AGE_MIN + '–' + AGE_MAX + ' 之间的整数' })
            return
          }
          age = n
        }
        gender = GENDER_VALUES[this.data.genderIndex] ?? null
        bio = this.data.bio.trim() || null
      }

      this.setData({ saving: true, error: '' })
      try {
        // ① 头像先上传（只有**重新选过**才传 —— 否则保持库里那张）
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
        const saved = await saveProfile({
          nickname,
          ...(fileId ? { avatarUrl: fileId } : {}),
          ...(this.data.full ? { gender, age, bio } : {}),
        })
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
