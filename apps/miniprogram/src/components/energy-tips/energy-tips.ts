/**
 * ⭐⭐ **energy-tips —— 能量扣除面板**（prd §7.2，用户 2026-10 定）。
 *
 * 它是 `eval-dialog` 的替代品（后者只被即将废弃的 `pages/reading` 使用，随它一起删）。
 *
 * ## 它只做一件事：说清"花多少、剩多少"，让用户自己按
 *
 * ⚠️ 从哪来：`recoded` 态那颗 `✓`（提交检测）—— 顺序是
 *    **点 ✓ → 漏读粗筛 → 本面板 → 确认 → `checking`**。
 *
 * ## ⚠️⚠️ 两个数都由**页面**从服务端权威值算好传进来，组件不做减法
 *
 * 端侧自己算余额就是第二份真相（真实踩过：显示"剩 1 点"而服务端说 0）。
 *
 * ## ⚠️ 余额不够**不是错误，是业务规则**
 *
 * 文案要给下一步（去补能量），**不准**写成"失败 / 出错" ——
 * 那会让用户以为小程序坏了，然后反复重试（而那正是要拦的行为）。
 */
Component({
  properties: {
    /**
     * 此刻在做什么：
     *   · 'precheck' —— **正在问服务端要权威余额**（几百毫秒，必须看得见，别关）
     *   · 'ask'      —— 拿到余额了，问用户要不要花
     */
    phase: { type: String, value: 'ask' },
    /** 这一次要花多少（服务端的 ENERGY_PER_CHALLENGE，不是端侧写死的数） */
    cost: { type: Number, value: 0 },
    /** 当前权威余额 */
    balance: { type: Number, value: 0 },
  },

  methods: {
    /** 取消 ⇒ 面板关掉，入口**停在 recoded**（录音还在、状态不变，见 prd §7.2） */
    onCancel() {
      this.triggerEvent('cancel')
    },
    /** 确认 ⇒ 真正提交，宿主把入口切到 checking */
    onConfirm() {
      this.triggerEvent('confirm')
    },
    /** 不够时的出口：去能量页 */
    onGoEnergy() {
      this.triggerEvent('goEnergy')
    },
  },
})
