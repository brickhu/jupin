import { HOME_PAGE } from '../../../lib/join'
import { navPadTop } from '../../../lib/nav'

/**
 * ⭐ 「修改资料」页 —— 改昵称 / 头像 / 性别 / 年龄 / 简介（**私有表单**）。
 *
 * ⚠️ 路由在 me/edit-user 下：它和「我的挑战 / 参与场次 / 连战」一样，
 *    都是「我自己的东西」，归到 me/ 这一组，别在页面栈里再散一个顶层名字。
 *
 * ⚠️ 与「加入句拼」页的区别：
 *    · 加入页只要**昵称 + 头像**（full=false），进来自动弹键盘、按钮写「确认加入」
 *    · 这一页要**全字段**（full=true），不弹键盘、按钮写「保存」
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
