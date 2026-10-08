/**
 * ⭐ **评测确认弹窗** —— 提交前确认能量（用户 2026-09 追加）。
 *
 * ## 它现在只做这一件事
 *
 * 原来它同时管四件：确认能量 / 等待 / 出分 / 失败。2026-10 拆开之后：
 *   · **等待** ⇒ 朗读页卡片上的那三颗钮（✓ 转圈、↺ 变灰）—— 用户要求"确认之后弹层关掉"
 *   · **出分与失败** ⇒ components/result-dialog（独立的那个）
 * ⇒ 这里只剩"花多少、还剩多少，确认吗"。
 *
 * ⚠️⚠️ **为什么必须拆（别合回去）**：合在一起时，层与卡片的 `wx:if` 条件不一致，
 *    检测期间**只剩一层黑遮罩、没有卡片** ✗ —— 页面被压黑又点不动，什么都看不到。
 *    一个组件承担多种"形态"时，这种错位几乎必然发生。
 *
 * 职责边界（刻意很窄）：
 *   · 它**只画**：遮罩、居中卡片、问余额的转圈、够/不够两态、两个动作按钮；
 *   · 它**不判断**：能不能提交、余额够不够、扣没扣 —— 那些都是页面的事实，
 *     组件只把 phase / 两个数当输入、把三个动作当输出（start / cancel / goEnergy）。
 */
Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /**
     * 页面此刻在做什么：
     *   · 'precheck' —— **正在问服务端要权威余额**（几百毫秒，必须看得见，别关）
     *   · 其它（页面此时是 s3）—— 已经拿到余额，等用户决定
     * ⚠️ 不做成布尔是因为"还在问"和"问到了"这两种都要画，而且不能混。
     */
    phase: { type: String, value: '' },
    /** 这一把要消耗几点（来自 shared 的 ENERGY_PER_CHALLENGE） */
    costEnergy: { type: Number, value: 0 },
    /** 服务端给的权威余额（'precheck' 时可能是本机缓存值，别展示） */
    balanceEnergy: { type: Number, value: 0 },
  },

  data: { entered: false },

  lifetimes: {
    attached() {
      // ⚠️ 等一帧再置 true：同一帧里置 true 不会有过渡（渲染不出前后两态）
      setTimeout(() => this.setData({ entered: true }), 16)
    },
  },

  methods: {
    /** ⚠️ 卡片自己吞掉点击/滑动，否则会穿透到下面的页面 */
    noop() {},

    /**
     * 点遮罩 —— **只有"等用户决定"那一态才等于取消**（录音还在，什么都没发生）。
     * ⚠️ 'precheck'（正在问权威余额）时点遮罩什么都不做：还没问完就关，
     *    用户会以为点了没反应。
     */
    onMaskTap() {
      if (this.data.phase === 'precheck') return
      this.triggerEvent('cancel')
    },

    /** 「确认提交」→ 页面接手（关这一层、开始上传 + 受理） */
    onStart() {
      this.triggerEvent('start')
    },

    /** 「取消」—— 什么都没发生：不锁能量、不上传，录音还在 */
    onCancel() {
      this.triggerEvent('cancel')
    },

    /** 「去补能量」—— 这一层**不关**（回来接着确认），有余额了再点 ✓ */
    onGoEnergy() {
      this.triggerEvent('goEnergy')
    },
  },
})
