import { login } from './lib/api/client'

/**
 * 小程序入口。
 * ⭐ 打开即登录（wx.login → openid），无注册、无密码、无验证码。
 */
App({
  globalData: {
    ready: false,
    isMember: false,
    nextFreeAt: '',
  },

  async onLaunch() {
    try {
      await login()
      this.globalData.ready = true
      console.log('[app] 登录完成')
    } catch (err) {
      console.error('[app] 登录失败', err)
      wx.showToast({ title: '登录失败，请重试', icon: 'none' })
    }
  },
})
