/**
 * ⭐⭐ 评测弹窗 —— 朗读页上**两块浮层**（都由这一张卡承担）：
 *
 *  ① 提交前的**确认能量**（'precheck'，用户 2026-09 追加）：问服务端要一次权威余额 →
 *     够就列清「消耗 / 剩余」让用户点确认，不够就一句人话 + 「去补能量」；
 *  ② 提交之后的**评测过程与结果**（'submitting'，原来的 s4 / s5 / s6）。
 *
 * ⚠️ 为什么两块合成一个组件而不是两个：它们**同一时刻只会出现一个**（页面按 phase 决定），
 *    都用同一套遮罩 / 居中卡片 / 进出场，拆成两个组件只会让那套浮层样式出现两份。
 *
 * 职责边界（刻意很窄）：
 *   · 它**只画**：遮罩、居中卡片、等待态、结果态、底部两个按钮；
 *   · 它**不判断**：能不能关、分数怎么来、能量扣没扣 —— 那些都是页面的事实，
 *     组件只把 phase 当输入、把两个动作当输出（confirm / openDetail）。
 *   ⚠️ 这么切的原因：同一份"这一把的分数与成长值"在页面上还有别的用处
 *      （数字滚动、能量小字、恢复 s5），状态留在页面一处，组件就不会成为第二份真相。
 */

/**
 * ⭐ 饼干那一行 —— 形状与朗读页里的 CookieLine 一致（那边算好、这边只画）。
 *
 * ⚠️ 只有**两种**形态：`+20 🍪`（拿到了）或「再高 3 分就能攻克」（没拿到）。
 *    没有"0 🍪"这一种 —— 那是把"你什么都没得到"说出来（prd §7.6）。
 */
interface CookieLine {
  text: string
  /** 'text-40rpx font-bold text-ink' 之类 —— 由页面决定 */
  cls: string
}

/**
 * ⭐ 等多久才说「比平时久一点」。
 *
 * ⚠️⚠️ 这个数回答的不是「打分要多久」，而是「用户从哪一刻开始怀疑卡死」。
 *    正常一次十几秒（长句更久、冷启动再加十几秒），所以 10 秒之前说那句"久"是假的；
 *    而 25 秒之后才说，用户已经盯着一个不动的圈二十多秒了。
 * ⚠️ 它**不是超时**：真正的超时在页面侧（SCORING_TIMEOUT_MS = 2 分钟，到点进 s6）。
 */
const SLOW_HINT_MS = 10_000

Component({
  properties: {
    /**
     * 这一层是**哪一块**：
     *   · 'precheck'  —— 提交前的确认能量（见文件头 ①）
     *   · 'submitting' —— 评测过程与结果（见文件头 ②）
     * ⚠️ 由**页面**决定：同一份 phase 在两种 mode 下含义完全不同（precheck 时 phase
     *    是 asking / confirm / no-energy / denied），组件不自己猜。
     */
    mode: { type: String, value: '' },
    /**
     * mode = 'submitting' 时：'uploading' 上传中 / 'scoring' 评测中 / 's5' 出分 / 's6' 失败。
     * mode = 'precheck' 时：'precheck' 正在问服务端权威余额；'s3' =
     *   已经拿到余额（够 / 不够都由 balanceEnergy 与 costEnergy 比出来）。
     * ⚠️ "问不到"（连不上 / 身份过期）**不在这一层**：页面会关掉它、回 s3 说人话。
     * ⚠️ 其它值一律**什么都不画** —— 页面不用自己控制显隐。
     */
    phase: { type: String, value: '' },
    /** 上传进度 0–100（只有 uploading 时有意义） */
    uploadPercent: { type: Number, value: 0 },
    /** s5 副标题（首次 / 破纪录 / 未破纪录三档，页面算好） */
    scoreSubtitle: { type: String, value: '' },
    /** s5 左上角那行「第 N 次朗读」 */
    attemptTitle: { type: String, value: '' },
    /**
     * ⭐ s5 那一行饼干（形状见 CookieLine）。
     * ⚠️ 默认 **null** ⇒ 整块不渲染 —— 这是"拿不到"与"失败态"共同的表达方式
     *    （`type: null` 是 wxml 组件里声明"可空对象"的写法，用 Object 构造器装不下 null）。
     */

    /** precheck 用：这一把要消耗几点（来自 shared 的 ENERGY_PER_CHALLENGE） */
    costEnergy: { type: Number, value: 0 },
    /** precheck 用：服务端给的权威余额（'asking' 与 'denied' 时可能是本机缓存值，别展示） */
    balanceEnergy: { type: Number, value: 0 },
  },

  data: {
    /** 进出场过渡的开关：先以"缩一点 + 透明"出现，下一帧再进到位 */
    entered: false,
    /** 等太久了（见 SLOW_HINT_MS）—— 只在等待态显示 */
    slow: false,
  },

  /**
   * ⚠️⚠️ 私有字段（计时器句柄）**不能直接写在 Component options 上** ——
   *    那是 Page 的写法（见 reading.ts 的 recorder / stopWatchdog）；
   *    组件实例上本来就有 `slowTimer()`（官方"报告耗时操作"的 API），
   *    同名还会让 TS 把两者当成一个东西。所以照 nav-bar / user-sheet 的约定
   *    挂在实例上、用一个惰性初始化的容器取（见文件末尾的 priv）。
   */

  observers: {
    /**
     * ⚠️⚠️ 慢提示的计时器**必须跟着 phase 走**，不能在 attached 里起一次就算了：
     *    用户可能先重录再提交第二次，那一次等待是全新的，不该继承上一轮已经烧掉的时间。
     * ⚠️ 离开等待态（出分 / 失败 / 关掉）要立刻清掉并复位 ——
     *    留着的话它会在出分之后突然冒一句"比平时久"，而那时分数都已经在屏幕上了。
     */
    phase(next: string) {
      const p = priv(this)
      clearSlowHint(p)
      if (next === 'uploading' || next === 'scoring') {
        this.setData({ slow: false })
        p.slowHintTimer = setTimeout(() => {
          p.slowHintTimer = null
          // ⚠️ 定时器与"用户已经出分"之间总有几十毫秒的窗口：到点再确认一次还在等待态
          const now = this.data.phase
          if (now === 'uploading' || now === 'scoring') this.setData({ slow: true })
        }, SLOW_HINT_MS)
      } else if (this.data.slow) {
        this.setData({ slow: false })
      }
    },
  },

  lifetimes: {
    attached() {
      /**
       * ⚠️ 先进场再置 entered：同一个 setData 里做完的话，这一帧就已经是最终位置，
       *    CSS 过渡没有"从哪来"的那一帧（同朗读页 s5 卡片入场那个坑）。
       */
      this.setData({ entered: false })
      setTimeout(() => this.setData({ entered: true }), 16)
    },
    detached() {
      // ⚠️ 必须清：组件销毁后计时器到点会往一个已经没了的实例上 setData
      clearSlowHint(priv(this))
    },
  },

  methods: {
    /**
     * ⚠️ 空方法：只用来 catchtap / catchtouchmove 截住冒泡。
     *    卡片不拦的话，点在卡片上会穿透到下面的遮罩（于是顺手把弹窗关了），
     *    在卡片上拖动会让底下的页面跟着滚。
     */
    noop() {},

    /**
     * 点遮罩 —— **只有"可以退出"的那几态才关得掉**：
     *   · 确认能量态（'confirm' / 'no-energy'）：等于取消，什么都没发生（录音还在）。
     *
     * ⚠️⚠️ **结果态（s5 / s6）点遮罩什么都不做**（用户 2026-10 定）。
     *
     *    原来这里是"与「确认」同一个动作"，那正好违反了这次的口径：
     *    **结果必须被看见，不能被顺手划掉** —— 不点那颗状态胶囊，
     *    下次回到这一页还要再弹一次（缓存不清）。手一滑就把结果划掉、
     *    还顺手把缓存清了 ⇒ 用户永远没看到自己得了几分。
     *
     *    ⇒ 结果态的**唯一出口**是底部那颗状态胶囊（它同时是"我看到了"的确认）。
     *
     * ⚠️ 其余几态同样什么都不做：
     *    · 'asking'（正在问权威余额）—— 还没问完就关，用户会以为没反应；
     *    · 'uploading' / 'scoring' —— 这次改版后**弹窗根本不在**这两态出现
     *      （等待改由卡片表达），这里留着只是防御。
     */
    onMaskTap() {
      const { mode, phase } = this.data
      if (mode === 'precheck') {
        if (phase === 'confirm' || phase === 'no-energy') this.onCancel()
      }
    },

    /** 结果态：确认 / 右上角 × —— 关窗 + 回 s1 + 把这一次追加进历史 */
    onConfirm() {
      this.triggerEvent('confirm')
    },

    /** 确认能量态：**开始提交**（页面接手：关这一层、开评测那一层、上传+受理） */
    onStart() {
      this.triggerEvent('start')
    },

    /** 确认能量态：取消（这一把不提交了；录音还在手上，随时能再点 ✓） */
    onCancel() {
      this.triggerEvent('cancel')
    },

    /** 余额不够：去「能量」页（页面负责导航；回来还能接着读，不用重录） */
    onGoEnergy() {
      this.triggerEvent('goEnergy')
    },

    /** 评测详情 —— 交给页面：navigateTo pages/challenge?sid=… */
    onOpenDetail() {
      this.triggerEvent('openDetail')
    },
  },
})

/**
 * ⭐ 组件实例上的**私有字段**（不参与渲染，所以不放 data）。
 * ⚠️ 惰性初始化：Component options 上不允许自定义字段，只能在第一次用到时挂上去
 *    （同 nav-bar / user-sheet 的 priv）。
 */
interface Internals {
  /** 慢提示的计时器；null = 没在跑 */
  slowHintTimer: ReturnType<typeof setTimeout> | null
}

const priv = (ctx: unknown): Internals => {
  const p = ctx as Internals
  if (p.slowHintTimer === undefined) p.slowHintTimer = null
  return p
}

/** 清掉慢提示的计时器（到点与否都不该再往一个可能已经关掉的弹窗上写） */
function clearSlowHint(p: Internals): void {
  if (p.slowHintTimer !== null) {
    clearTimeout(p.slowHintTimer)
    p.slowHintTimer = null
  }
}
