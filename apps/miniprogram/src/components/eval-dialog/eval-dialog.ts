/**
 * ⭐⭐ 评测弹窗 —— 朗读页「提交评测 → 评测中 → 出分 / 失败」
 *    （原来的 s4 / s5 / s6）**盖在页面上**（用户 2026-09 定）。
 *
 * 职责边界（刻意很窄）：
 *   · 它**只画**：遮罩、居中卡片、等待态、结果态、底部两个按钮；
 *   · 它**不判断**：能不能关、分数怎么来、能量扣没扣 —— 那些都是页面的事实，
 *     组件只把 phase 当输入、把两个动作当输出（confirm / openDetail）。
 *   ⚠️ 这么切的原因：同一份"这一把的分数与成长值"在页面上还有别的用处
 *      （数字滚动、能量小字、恢复 s5），状态留在页面一处，组件就不会成为第二份真相。
 */

/** 成长值三卡 —— 形状与朗读页里的 GrowthCard 一致（那边算好、这边只画） */
interface GrowthCard {
  key: string
  label: string
  value: string
  /** 'text-orange-500' 之类 —— 由页面按 GROWTH_META 决定 */
  textCls: string
  borderCls: string
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
     * 'uploading' 上传中 / 'scoring' 评测中 / 's5' 出分 / 's6' 失败。
     * ⚠️ 其它值（s1/s2/s3/loading）一律**什么都不画** —— 页面不用自己控制显隐。
     */
    phase: { type: String, value: '' },
    /** 上传进度 0–100（只有 uploading 时有意义） */
    uploadPercent: { type: Number, value: 0 },
    /** s5 大号分数（页面在滚动时逐帧写进来） */
    scoreText: { type: String, value: '' },
    /** s5 副标题（首次 / 破纪录 / 未破纪录三档，页面算好） */
    scoreSubtitle: { type: String, value: '' },
    /** s5 左上角那行「第 N 次朗读」 */
    attemptTitle: { type: String, value: '' },
    /** s5/s6 的三张成长值卡（s5 拿不到服务端增量时是空数组） */
    growthCards: { type: Array, value: [] as GrowthCard[] },
    /** s6 的副标题（默认「录音不符合规范」；超时那次会换一句真话） */
    failDetail: { type: String, value: '' },
    /** 底部那行能量小字（成品文本，页面拼） */
    energyNote: { type: String, value: '' },
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
     * 点遮罩 —— **只有结果态才关得掉**。
     *
     * ⚠️⚠️ 评测中那两次（uploading / scoring）点遮罩必须**什么都不做**：
     *    那次提交的能量已经锁了、云端也已经在打分，关掉只会让用户以为白花了一次。
     *    （同时页面在这一态根本不画 ×，两条路都堵死。）
     */
    onMaskTap() {
      if (this.data.phase === 's5' || this.data.phase === 's6') this.onConfirm()
    },

    /** 确认 / 右上角 × —— 交给页面：关窗 + 回 s1 + 把这一次追加进历史 */
    onConfirm() {
      this.triggerEvent('confirm')
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
