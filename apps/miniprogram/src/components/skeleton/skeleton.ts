/**
 * ⭐⭐ **全局骨架占位区** —— 首屏各数据块在"还没加载成功"之前，统一用它替代。
 *
 * ⚠️⚠️ 为什么要有它（用户 2026-09 定）：首页四块（个人状态 / 今日卡 /
 *    最新卡片 / 排行榜）各自异步加载，**各自的到达时间不同**。原来只有整页一个
 *    `loading` 开关 —— 表现是"要么整页白，要么内容一块块跳出来"。
 *    统一用同一个骨架组件，才能让"还没到"与"到了但是空的"看起来不一样：
 *    骨架 = 正在取；空态 = 取到了，就是没有。
 *
 * ⚠️ 它**只负责形状**，不含任何数据/请求。调用方用 `wx:if` 决定显示骨架还是真内容：
 *      <skeleton wx:if="{{latestLoading}}" variant="list" rows="3" />
 *
 * variant：
 *   · stats —— 顶部个人状态卡（三格数字）
 *   · card  —— 单张卡（今日挑战那种带按钮的）
 *   · list  —— 一列同构卡片（最新上线）
 *   · rank  —— 排行榜（tab + 若干行）
 */
Component({
  properties: {
    /** 形状：stats | card | list | rank */
    variant: { type: String, value: 'card' },
    /** list / rank 的行数 */
    rows: { type: Number, value: 3 },
  },

  data: {
    /** list / rank 用它 wx:for（模板里不写字面量数组，见 wxml） */
    lines: [0, 1, 2],
    /** 固定三个 tab / 三格数字 */
    triple: [0, 1, 2],
  },

  observers: {
    rows(n: number) {
      this.setData({ lines: buildLines(n) })
    },
  },

  lifetimes: {
    attached() {
      this.setData({ lines: buildLines(this.data.rows) })
    },
  },
})

/** 行数收敛到 1–10：0 会让骨架整块消失（看起来像加载完了），太多会撑出一屏 */
function buildLines(n: number): number[] {
  const count = Math.max(1, Math.min(10, Math.floor(n) || 3))
  return Array.from({ length: count }, (_, i) => i)
}
