import type { MeResponse } from '@jushuo/shared'
import { CLOUD_ENV_ID } from './config'
import { login, markCloudInit } from './lib/api/client'
import { refreshMe } from './lib/join'
import { hydrate, hasJoined, markSessionUnknown } from './lib/store'
import type { MeState } from './lib/store'

/**
 * 小程序入口。
 *
 * ⭐ 打开即拿到**授权身份**（wx.login → openid），无密码、无验证码。
 *
 * ⚠️⚠️ 但**注册是另一件事**（2026-09 用户定：注册不能做成自动的）：
 *    打开小程序**不会**在 `users` 里建行 —— 那只发生在用户于「加入句拼」页
 *    按下「确认加入」时（见 lib/auth 与 components/profile-form）。
 *    在那之前他只有只读浏览：首页 / 句库 / 榜单 / 竞技场都能看，
 *    挑战、能量、参与记录、收藏一律先跳加入页。
 */
App({
  globalData: {
    ready: false,
    // ⚠️ 这里原来有 nextFreeAt（冷却时间戳）—— 冷却已下线，见 services/quota.ts
    /**
     * ⭐ 数据的**挂载点** —— 由 lib/store 的 commit() / hydrate() 统一写入。
     * ⚠️ 它就是 store 里那份 state 的**同一引用**，不是副本；
     *    别在这里单独改，改状态一律走 store 的 action（见 lib/store 顶部说明）。
     */
    state: null as MeState | null,
    /** ⭐ 快捷入口，= state.userInfo（GET /api/user/me 的原始返回体） */
    userInfo: null as MeResponse | null,
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
        // ⭐ 记下「init 这一步没抛异常」—— 云通道失败时要靠它区分
        //    「基础库太旧」和「云能力根本没起来」（见 client.ts 的 containerDiag）
        markCloudInit(true)
        console.log('[app] 云能力已初始化' + (CLOUD_ENV_ID ? ' env=' + CLOUD_ENV_ID : ' (默认环境)'))
      } else {
        markCloudInit(false, '当前基础库没有 wx.cloud')
        console.warn('[app] 当前基础库不支持 wx.cloud，音频直传不可用')
      }
    } catch (err) {
      markCloudInit(false, err)
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
      /**
       * ⭐⭐ 授权的下一步：把「我是谁」问一次，结果写进全局 store（用户 2026-09 定的首屏数据流）。
       *
       *   wx.login → code →（服务端换 openid；云托管通道由网关注入）
       *     → GET /api/user/me → store.userInfo（缓存 + 全局唯一来源）
       *
       * ⚠️ 不 await：它是"页面数据"而不是"能不能用"—— `await login()` 已经保证了后者。
       *    在它落地之前，**每个页面的 `boot-overlay` 会整页盖住**
       *    （判据是 store.session === 'pending'，见 components/boot-overlay）——
       *    所以不会出现"先画一个假的「加入」再闪成头像"。
       * ⚠️ refreshMe 自己吞掉失败（分三态写 store，见 lib/auth）：它供的是界面，
       *    不该连累启动流程；问不到时画「重新连接」，**绝不画「加入」**。
       */
      void refreshMe()
    } catch (err) {
      // ⚠️ 刻意**不弹 toast**：当前阶段后端经常没起来（尤其真机上），
      //    弹「登录失败」会让人以为是账号问题，而其实是「后端未连接」。
      //    首页的自检卡片会把这个错误连同原始 errMsg 一起展示，信息量更大也更准。
      //
      //    另外：真机自检页（T1–T6）是**纯端侧**的，后端连不上完全不影响它。
      this.globalData.ready = false
      /**
       * ⚠️⚠️ 登录失败要分成两种情况（见 store 的 SessionState）：
       *   · 本机缓存里**已经有身份**（hydrate 读回来的）→ 保持原样：
       *     账号在服务端，不因这一次请求失败而消失；
       *   · 本机什么都没有 → 标 `unknown`（画「重新连接」）。
       * ⚠️ 绝不能标 `ready`：那会让界面画出一个**假的「加入」** ——
       *    而"库里有我、只是这次没问到"的人会以为账号没了（B31 定下的）。
       */
      if (!hasJoined()) markSessionUnknown()
      console.warn('[app] 登录失败（后端未连接？）', err)
    }
  },
})
