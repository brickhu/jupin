import { CLOUD_ENV_ID } from './config'
import { fetchMe, login } from './lib/api/client'
import { applyProfile, hydrate } from './lib/store'

/**
 * ⭐ 拉一次「我是谁」（头像 / 昵称 / 已征服数）并写进全局 store。
 *
 * ⚠️ 失败**只警告、不冒泡**：它供的是导航栏上那个头像和用户面板，
 *    取不到就显示兜底头像，不该让任何主流程受影响。
 */
async function loadProfile(): Promise<void> {
  try {
    applyProfile(await fetchMe())
  } catch (err) {
    console.warn('[app] 取用户资料失败（不影响使用）：' + (err as Error).message)
  }
}

/**
 * 小程序入口。
 * ⭐ 打开即登录（wx.login → openid），无注册、无密码、无验证码。
 */
App({
  globalData: {
    ready: false,
    isMember: false,
    // ⚠️ 这里原来有 nextFreeAt（冷却时间戳）—— 冷却已下线，见 services/quota.ts
  },

  async onLaunch() {
    // ⭐ 先把上次的「我的参与记录 / streak」读回来 —— 首页首帧就有数据，不必先白一下。
    //    ⚠️ 它只是缓存：各页面照常会向服务端刷一遍，以服务端为准。
    hydrate()

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

    // ⚠️⚠️ iOS 上 InnerAudioContext **默认遵守静音键**（obeyMuteSwitch 默认 true）。
    //    手机拨到静音/震动档时，播放会**完全无声、且不报任何错** ——
    //    真机试听「点了没反应也没报错」的头号原因就是这个，模拟器/开发工具里看不出来。
    //    ⭐ 「语音类」小程序应当关掉它：用户明确点了播放，就是要出声。
    try {
      wx.setInnerAudioOption({
        obeyMuteSwitch: false,
        // 录音结束后音频会话可能还没释放，允许混音能让试听更稳
        mixWithOther: true,
        success: () => console.log('[app] 已关闭静音键跟随（obeyMuteSwitch=false）'),
        fail: (err) => console.warn('[app] setInnerAudioOption 失败：', err.errMsg),
      })
    } catch (err) {
      console.warn('[app] setInnerAudioOption 不可用：', err)
    }

    try {
      await login()
      this.globalData.ready = true
      console.log('[app] 登录完成')
      // ⚠️ 不 await：首页的首屏不该为了一个头像多等一次往返。
      //    拿到之前导航栏显示兜底头像，拿到之后 store 广播，组件自己会重画。
      void loadProfile()
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
