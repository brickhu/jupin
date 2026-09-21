import { CLOUD_ENV_ID } from '../../config'
import { getUserId, saveProfile } from '../../lib/api/client'
import { HOME_PAGE, refreshMe } from '../../lib/join'
import { navPadTop } from '../../lib/nav'
import * as me from '../../lib/store'

/**
 * ⭐ 「加入句拼」页 —— 用户从「一个打开小程序的人」变成「榜上有名字的人」。
 *
 * ⚠️ 为什么是**一整页**而不是弹层：弹层那版有两个具体问题 ——
 *    ① 点头像授权时，微信自己的浮层盖在我们的 mask 上，两层灰叠在一起很难看
 *    ② 键盘一弹，半屏面板被顶得七零八落
 *    页面没有这两个问题：系统浮层盖的是页面，键盘把页面整体上推，各归各的。
 *
 * ⚠️ 为什么叫**加入**而不是登录：身份（openid）是 wx.login 静默拿到的，
 *    用户从头到尾没有"没登录"过（见 lib/api/client.ts）。他真正做的动作
 *    是认领一个名字 —— 从此成绩有主。叫"登录"会让人以为有个账号要输密码。
 *
 * ⚠️⚠️ 头像和昵称**没法自动读取**，这不是没做，是微信不允许：
 *    官方「头像昵称填写」能力只给了两个入口 ——
 *      · <button open-type="chooseAvatar"> 用户点了才弹「用微信头像」
 *      · <input type="nickname"> 用户点进输入框，键盘上方才出现微信昵称
 *    2022-10-25 起 wx.getUserProfile / wx.getUserInfo 一律返回匿名数据
 *    （灰头像 + "微信用户"），"静默读进来"这条路已经不存在了。
 *    ⇒ 于是这一页把"那两下"做得尽量顺：进来就**自动聚焦昵称框**，
 *      微信昵称悬在键盘上方等他一键填入；头像那格把"点了会怎样"写在脸上。
 *
 * ⚠️ 头像拿到的是**临时路径**（wxfile:// 或 http://tmp/…），必须先上传到
 *    云存储换成 fileID 再落库 —— 临时路径出了这台设备就不存在了，
 *    存进库里只会得到一张永远加载不出来的图。
 */

/**
 * 自动聚焦昵称框的时机。
 * ⚠️ 等页面转场结束再聚焦：转场还没完就弹键盘，两者抢位置，看起来像卡住。
 */
const FOCUS_AFTER_MS = 320

Page({
  data: {
    /** 导航栏让出的高度（见 lib/nav.ts） */
    navTop: 0,
    /** 用户选的头像（**临时路径**，仅用于本地预览） */
    avatarPath: '',
    nickname: '',
    /**
     * 昵称框要不要聚焦。
     * ⚠️ 只在"还没填过"时聚焦：已经填好的（改资料那条路）再弹一次键盘是打扰。
     */
    focusNickname: false,
    saving: false,
    error: '',
  },

  onLoad() {
    this.setData({ navTop: navPadTop() })
    // ⚠️ 已经加入过的人走到这一页是「改资料」：昵称预填上，别让他重打一遍
    const p = me.getState().profile
    if (p?.nickname) this.setData({ nickname: p.nickname })
  },

  onReady() {
    if (this.data.nickname) return
    // ⭐ 这一下是整个流程顺不顺的关键，理由见文件头
    setTimeout(() => {
      if (!this.data.nickname) this.setData({ focusNickname: true })
    }, FOCUS_AFTER_MS)
  },

  onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>) {
    // ⚠️ 这只是**临时路径**，不是能落库的地址 —— 提交时才上传（见 uploadAvatar）
    this.setData({ avatarPath: e.detail?.avatarUrl ?? '', error: '' })
  },

  onNickname(e: WechatMiniprogram.Input) {
    this.setData({ nickname: e.detail?.value ?? '', error: '' })
  },

  /**
   * 确认加入 —— 写用户资料，然后回上一页。
   *
   * ⚠️ 没填昵称时**什么都不做**（按钮也是置灰的，见 WXML 的说明）：
   *    这里是"静止"，不是"报错"。点一个看起来不能点的按钮却弹出提示，
   *    等于把没填东西这件事说成了一次事故。
   */
  async onConfirm() {
    if (this.data.saving) return
    const nickname = this.data.nickname.trim()
    if (!nickname) return

    this.setData({ saving: true, error: '' })
    try {
      // ① 头像先上传（没选就跳过 —— 头像是可选的）
      let fileId = ''
      if (this.data.avatarPath) {
        try {
          fileId = await this.uploadAvatar(this.data.avatarPath)
        } catch (err) {
          /**
           * ⚠️⚠️ 头像传不上去**不该拖住"加入"**。
           *    它是个装饰，昵称才是这张表的主角；为了一个头像让人加不进来，
           *    是本末倒置。传失败就当作"这次没换头像"，昵称照常落库。
           */
          console.warn('[join] 头像上传失败，本次不带头像：' + (err as Error).message)
        }
      }
      // ② 落库，并**用它的返回值**更新全局 state（见 store 的 applyProfilePatch）
      const saved = await saveProfile({ nickname, ...(fileId ? { avatarUrl: fileId } : {}) })
      me.applyProfilePatch(saved)
      /**
       * ③ 再顺手拉一次完整的 /me（已征服数 / streak 在保存接口的返回值里没有）。
       *
       * ⚠️ 不 await、也不管失败：**"已加入"这件事在第 ② 步就已经定死了**，
       *    这一步只是补数据。等它，等于让"加入成功"这个结论再赌一次网络。
       */
      void refreshMe()
      // ④ 回进来时那一页
      this.back()
    } catch (err) {
      this.setData({ error: (err as Error).message || '加入失败，请重试' })
    } finally {
      this.setData({ saving: false })
    }
  },

  /**
   * 回到进来时的那一页。
   * ⚠️ navigateBack 也可能失败（页面栈被别处清过），失败时不能什么都不做 ——
   *    那看起来就是"按钮坏了"。所以一律兜底成回首页。
   */
  back() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack({ delta: 1, fail: () => wx.reLaunch({ url: HOME_PAGE }) })
      return
    }
    wx.reLaunch({ url: HOME_PAGE })
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
})
