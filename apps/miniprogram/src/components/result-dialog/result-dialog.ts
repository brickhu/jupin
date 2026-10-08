/**
 * ⭐⭐ **检测结果弹窗** —— 用户 2026-10 定的四个形态（设计稿 alert1–4）。
 *
 * ## 为什么从 eval-dialog 里拆出来
 *
 * 原来它和「确认能量」挤在同一个组件里（那次是"同一时刻只会出现一个，省一套浮层"）。
 * 用户 2026-10 明确要求**独立**：这两件事的**卡片长得不一样**（结果这张宽得多、
 * 中间还有一整段逐词着色的原文），共用一个卡片只会两边都别扭。
 *
 * ## ⚠️⚠️ 这个组件里**不用 UnoCSS 工具类**（和 eval-dialog 同一条规矩）
 *
 * 原因不是洁癖，是**踩过**：工具类在组件里"没生成/没生效"时是**静默失效** ——
 * 表现就是截图里那个样子：「得分详情」掉到第二行、整句挤成一行还溢出被裁 ✗
 * ⇒ 凡是**布局**（宽高、内外边距、折行、对齐）一律写在本文件的 wxss 里；
 *    颜色也写死（设计稿给了精确色值）。
 *
 * ## 它同时是"必须被看见"的那一层
 *
 * ⚠️⚠️ **唯一的出口是底部那颗状态胶囊**：遮罩点不动、没有 ×。
 *    不点它，缓存就不清，下次回到朗读页**还会再弹**（用户 2026-10 定）。
 */
Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** 这一把的分数（页面已经 formatScore 好，只负责画） */
    scoreText: { type: String, value: '' },
    /**
     * ⭐ 底部那颗状态胶囊的文案 + 形态（a/b/c/d）。
     * ⚠️ 判据在 @jushuo/shared 的 resultFormOf（有测试），页面算好传进来 ——
     *    组件**不自己算**，那是规则，不是界面。
     */
    resultLine: { type: null, value: null as { form: string; text: string } | null },
    /**
     * ⭐ 逐词着色后的原文（lib/word-colors 算好）。
     * ⚠️ 空数组 = 拿不到逐词 ⇒ 那一块不渲染（不画一句没颜色的原文假装判过了）。
     */
    resultWords: { type: Array, value: [] as { i: number; text: string; cls: string }[] },
  },

  data: { entered: false },

  lifetimes: {
    attached() {
      /**
       * ⚠️ 进出场：attached 里直接置 true 不会有过渡（同一帧渲染不出来），
       *    必须等一帧。和 eval-dialog 用的是同一套做法。
       */
      setTimeout(() => this.setData({ entered: true }), 16)
    },
  },

  methods: {
    /** ⚠️ 卡片自己吞掉点击/滑动，否则会穿透到下面的页面（恢复录音、滚动…） */
    noop() {},

    /**
     * ⚠️⚠️ **遮罩点不动**（用户 2026-10 定）：结果必须被看见。
     *    原来点遮罩等于「确认」，顺手就把结果划掉、缓存也清了 ⇒ 用户永远没看到分。
     *    这里保留这个方法只是为了让 bindtap 有个落点，**什么都不做**。
     */
    onMaskTap() {},

    /** ⭐ 唯一出口：底部那颗状态胶囊 —— 关窗 + 回 s1 + 这次进历史（页面接手） */
    onConfirm() {
      this.triggerEvent('confirm')
    },

    /** 「得分详情」→ pages/challenge（⚠️ **不关窗**：看完详情回来这条结果还在） */
    onOpenDetail() {
      this.triggerEvent('openDetail')
    },
  },
})
