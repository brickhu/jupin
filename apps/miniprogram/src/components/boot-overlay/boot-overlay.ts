import * as me from '../../lib/store'

/**
 * ⭐⭐ **启动遮罩** —— 身份还没解析出结果之前，整页盖住（用户 2026-09 定）。
 *
 * ⚠️⚠️ 为什么要有它：`app.onLaunch` 要先完成授权（wx.login → 服务端换 openid）
 *    再问「我是谁」（`/api/user/me`）。这段时间里页面**没有任何权威数据** ——
 *    不盖住的话，用户会先看到一个假的「加入」（或 0 场 0 天），
 *    然后再"闪"成自己的头像与战绩。那一下比多等半秒难看得多。
 *
 * ⭐ 判据只有一个：store 的 `session === 'pending'`（见 SessionState）。
 *    · pending —— 还没跟服务端确认过身份 ⇒ 盖住；
 *    · ready   —— 服务端答复了（答复可以是"库里没有你这一行"）⇒ 撤遮罩，
 *                 页面按「已加入 / 未加入」画（未加入不是错误，不该继续等）；
 *    · unknown —— 问不到（断网/后端没起来）⇒ 也撤（画「重新连接」），
 *                 **不能让用户对着一个转圈无限等**。
 *
 * ⚠️ 有本机缓存（hydrate 读回 userInfo）时 session 一开始就是 ready ⇒ 遮罩根本不出现，
 *    首帧直接是上次那一屏（见 store 的 hydrate）。
 *
 * ⚠️ 它挂到**每一个页面**上（app.json 全局注册，各页 wxml 里一行 `<boot-overlay />`）。
 *    这是"所有页面统一覆盖"的实现方式 —— 公开落地页（分享进来的挑战详情 / 竞技场）
 *    也一起等：那一次请求迟早要发（/me），先让用户看清"正在进入"比先画半页更稳。
 */
type Internals = { unsub?: () => void }
const priv = (ctx: unknown): Internals => ctx as Internals

Component({
  data: {
    /** 盖不盖 —— 只由 store 的 session 决定（见文件头） */
    visible: false,
  },

  lifetimes: {
    attached() {
      this.sync()
      priv(this).unsub = me.subscribe(() => this.sync())
    },
    detached() {
      // ⚠️ 必须退订：页面销毁后回调还在跑，里面一句 setData 就会报错
      priv(this).unsub?.()
      priv(this).unsub = undefined
    },
  },

  methods: {
    /** 按当前 session 决定盖不盖；值没变就不 setData（跨层通信能省则省） */
    sync() {
      const visible = me.getState().session === 'pending'
      if (visible !== this.data.visible) this.setData({ visible })
    },

    /** catchtouchmove 用的空处理器：遮罩期间不许页面跟着手指滚 */
    noop() {},
  },
})
