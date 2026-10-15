/**
 * ⭐ ui-dialog 的**纯逻辑** —— 位置解析 / 类名拼装 / head 行取谁 / 遮罩能否关。
 *
 * ⚠️ 为什么单独一个文件（而不是写在 ui-dialog.ts 里）：同 `ui-button-variants.ts` ——
 *    这几条**每一条错了都不报错、只是画错或拦不住**：
 *      · position 解析错 ⇒ 该贴底上滑的变成了居中放大
 *      · headMode 判错   ⇒ 配了 title 却还是画了 head 槽（或反过来）
 *      · closesOnMaskTap 松掉 ⇒ 等待期（能量已扣、云端还在算）被一次误触关掉
 * ⚠️ 这些函数**不能**从 ui-dialog.ts 里 import 来测：那个文件顶层就调 `Component()`，
 *    而 Node（vitest）里没有这个全局，import 它当场就抛。
 *    （同 ui-button：测试只 import 这个纯逻辑文件。）
 */

export type DialogPosition = 'center' | 'bottom'

/** 合法位置 —— ⚠️ 加取值必须同时在 ui-dialog.wxss 里加一段位置样式 */
export const POSITIONS: readonly DialogPosition[] = ['center', 'bottom']

/**
 * 收 / 放动画时长（ms）。
 *
 * ⚠️⚠️ **必须与 ui-dialog.wxss 里的 transition 时长一致**：收起是"先播动画、再摘节点"
 *    （见 ui-dialog.ts 的 toggle）—— 这里比 CSS 短，就是动画还没放完节点已经被摘掉，
 *    看起来是"啪"地消失。`ui-dialog.test.ts` 把两处钉在一起。
 */
export const ANIM_MS = 200

/** 位置解析：只认两个字面量，其余（空 / 拼错 / 没传）一律落 center */
export function normalizePosition(raw: unknown): DialogPosition {
  const v = String(raw ?? '').trim()
  return (POSITIONS as readonly string[]).includes(v) ? (v as DialogPosition) : 'center'
}

/**
 * head 那一行画谁：title 非空 ⇒ 只画 title（**head 槽整个不渲染**）；否则 ⇒ 画 head 槽。
 *
 * ⚠️ 判据是 `trim()` 之后的 title，不是 title 本身：传了空格 / 回车等于没传 ——
 *    否则会画出一条什么都没有的空标题行，而调用方以为自己配了 title。
 */
export function headMode(title: unknown): 'title' | 'slot' {
  return String(title ?? '').trim() ? 'title' : 'slot'
}

/**
 * ⭐ 点遮罩能不能关：**只有显式 true 才关**。
 *
 * ⚠️ 属性声明是 `type: Boolean, value: true`（见 ui-dialog.ts）⇒ 不传就是 true。
 *    这里刻意**不**写成 `closable !== false`：那会让"没传 / 传了 null"也算能关，
 *    而这条要拦的正是误触（等待期点遮罩无效），宁可少关不可多关。
 */
export function closesOnMaskTap(closable: unknown): boolean {
  return closable === true
}

export interface DialogClasses {
  /** 整屏那一层：只有 center 需要它自己当居中容器 */
  layer: string
  /** 面板：只带位置 —— 入场态由 WXML 按 entered 追加（见下） */
  panel: string
}

/**
 * 拼位置类名。
 *
 * ⚠️ 入场的 `ud-on` **不在这里**：它由 wxml 里 `{{entered ? 'ud-on' : ''}}` 追加。
 *    原因：entered 是在下一帧翻转的，若把它编进这里的返回值，
 *    就必须在**每个** setData 的地方重新算一次类名 —— 漏一处就永远不放大。
 *    （遮罩与面板用的是同一个表达式，两处不会走散。）
 */
export function dialogClasses(position: unknown): DialogClasses {
  const center = normalizePosition(position) === 'center'
  return {
    layer: center ? 'ud-layer ud-layer-center' : 'ud-layer',
    panel: 'ud-panel ' + (center ? 'ud-panel-center' : 'ud-panel-bottom'),
  }
}
