import { BRAND } from '@jushuo/shared'

import { HOME_PAGE } from '../../lib/join'
import { navPadTop } from '../../lib/nav'

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
 * ⚠️ 表单和保存逻辑都在 components/profile-form 里，与「修改资料」页共用 ——
 *    这一页只负责文案与"保存完回哪儿去"。
 */
Page({
  data: {
    /** ⭐ 定位文案来自 @jushuo/shared/brand.ts —— 不要在页面里另抄一份 */
    brand: BRAND,
    /** 导航栏让出的高度（见 lib/nav.ts） */
    navTop: 0,
  },

  onLoad() {
    this.setData({ navTop: navPadTop() })
  },

  /**
   * 保存成功 → 回来时那一页。
   * ⚠️ 头像是可选的，传失败不拦着加入，但**要告诉他**：他明明选了张图，
   *    一声不吭地存成"没有头像"，看起来就是这个功能坏了。
   */
  onSaved(e: WechatMiniprogram.CustomEvent<{ avatarFailed?: boolean }>) {
    if (e.detail?.avatarFailed) {
      wx.showToast({ title: '头像没传上去，可以稍后再换一张', icon: 'none', duration: 2500 })
    }
    this.back()
  },

  /**
   * 「以后再说」—— **略过补资料**。
   *
   * ⚠️ 它与保存成功后的去处完全一样（都是返回），但必须是一个**明写的出口**：
   *    没有它，用户只能靠系统返回键去猜自己能不能走。
   *    这一页本来就不是任何功能的前置条件。
   */
  onSkip() {
    this.back()
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
})
