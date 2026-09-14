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
      // ⭐ 初始化云能力 —— 对象存储直传（wx.cloud.uploadFile）依赖它。
      //    免域名、免备案，且不受云托管服务请求体大小限制。
      if (wx.cloud) {
        wx.cloud.init({ traceUser: true })
      } else {
        console.warn('[app] 当前基础库不支持 wx.cloud，音频直传不可用')
      }

      await login()
      this.globalData.ready = true
      console.log('[app] 登录完成')
    } catch (err) {
      console.error('[app] 登录失败', err)
      wx.showToast({ title: '登录失败，请重试', icon: 'none' })
    }
  },
})
