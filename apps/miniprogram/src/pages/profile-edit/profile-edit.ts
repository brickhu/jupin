import { HOME_PAGE } from '../../lib/join'
import { navPadTop } from '../../lib/nav'

/**
 * ⭐ 「修改资料」页 —— 换头像 / 改昵称（**私有表单**）。
 *
 * ⚠️ 它原来叫 pages/profile，为了给**对外展示**的用户主页让出那个名字，
 *    改成了 pages/profile-edit —— 两个 profile 页面靠猜太费劲。
 *
 * ⚠️ 与「加入句拼」页的区别只有三处：标题、按钮文案、不自动弹键盘
 *    （来改头像的人不需要键盘，弹出来只会挡住头像那一行）。
 *    表单与保存逻辑共用 components/profile-form —— 一份实现。
 */
Page({
  data: {
    /** 导航栏让出的高度（见 lib/nav.ts） */
    navTop: 0,
  },

  onLoad() {
    this.setData({ navTop: navPadTop() })
  },

  /**
   * 保存成功 → 回上一页（通常是用户面板下面的那页）。
   * ⚠️ 头像传失败不拦着保存，但要**说出来**：用户明明选了张图，
   *    一声不吭地存成"没有头像"，看起来就是这个功能坏了。
   */
  onSaved(e: WechatMiniprogram.CustomEvent<{ avatarFailed?: boolean }>) {
    if (e.detail?.avatarFailed) {
      wx.showToast({ title: '头像没传上去，请再试一次', icon: 'none', duration: 2500 })
    }
    if (getCurrentPages().length > 1) {
      wx.navigateBack({ delta: 1, fail: () => wx.reLaunch({ url: HOME_PAGE }) })
      return
    }
    wx.reLaunch({ url: HOME_PAGE })
  },
})
