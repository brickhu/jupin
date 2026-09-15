import { CLOUD_ENV_ID } from './config'
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
    // ⭐ 初始化云能力 —— 对象存储直传（wx.cloud.uploadFile）依赖它。
    //    免域名、免备案，且不受云托管服务请求体大小限制。
    //
    // ⚠️ 用 touristappid（游客模式）或未开通云开发时，init 会抛异常。
    //    单独 try 住，不要让它连累后面的登录。
    try {
      if (wx.cloud) {
        wx.cloud.init({
          ...(CLOUD_ENV_ID ? { env: CLOUD_ENV_ID } : {}),
          traceUser: true,
        })
        console.log('[app] 云能力已初始化' + (CLOUD_ENV_ID ? ' env=' + CLOUD_ENV_ID : ' (默认环境)'))
      } else {
        console.warn('[app] 当前基础库不支持 wx.cloud，音频直传不可用')
      }
    } catch (err) {
      console.warn('[app] 云能力初始化失败（游客模式或未开通云开发）:', err)
      console.warn('[app] 音频直传不可用，但接口联调不受影响')
    }

    try {
      await login()
      this.globalData.ready = true
      console.log('[app] 登录完成')
    } catch (err) {
      // ⚠️ 刻意**不弹 toast**：当前阶段后端经常没起来（尤其真机上），
      //    弹「登录失败」会让人以为是账号问题，而其实是「后端未连接」。
      //    首页的自检卡片会把这个错误连同原始 errMsg 一起展示，信息量更大也更准。
      //
      //    另外：真机自检页（T1–T6）是**纯端侧**的，后端连不上完全不影响它。
      this.globalData.ready = false
      console.warn('[app] 登录失败（后端未连接？）', err)
    }
  },
})
