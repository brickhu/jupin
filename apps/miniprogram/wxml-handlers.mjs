/**
 * ⭐ WXML 里绑的事件名，在**同名 .ts** 里必须真的有那个方法。
 *
 * ⚠️⚠️ 为什么值得单独查：绑定一个不存在的方法**既不报错也不提示** ——
 *    用户点了完全没反应，控制台最多一行 warning。真实事故：
 *
 *      user-sheet.wxml 里写了 catchtap="onOpenEnergy"，
 *      而 user-sheet.ts 里没有这个方法（那次编辑只落到了 WXML 上）
 *      → 用户的原话：「能量文字点不动」
 *
 * ⚠️ 构建原来完全查不到它：tsc 只看 .ts，类名检查只看 class 属性。
 *    这和「类名拼错导致样式静默失效」是同一类问题，所以也放在构建期拦。
 */

/** 所有事件绑定属性：bindtap / catchtap / capture-bind:tap / mut-bind:tap … */
const EVENT_ATTR = /(?:bind|catch|capture-bind|capture-catch|mut-bind)[:]?[a-zA-Z]+="([^"]*)"/g

/**
 * 收集 WXML 里绑定的方法名。
 * ⚠️ 跳过 {{...}} 表达式：那是动态绑定，静态查不了（本项目目前没有这种写法）。
 * ⚠️ 空串是合法的（用来阻止冒泡，如 catchtap=""）。
 */
export function collectHandlers(wxml) {
  const names = new Set()
  for (const m of wxml.matchAll(EVENT_ATTR)) {
    const value = (m[1] || '').trim()
    if (!value || value.includes('{')) continue
    names.add(value)
  }
  return [...names]
}

/**
 * ⚠️⚠️ 先把注释剥掉再找方法名 —— 这一步不能省。
 *
 *    不剥的话，注释里提一句 onOpenEnergy 就会被当成「有实现」，
 *    而这正是最容易发生的情况：出事之后人们在注释里写「这里本该有 onOpenEnergy」。
 *    （本项目真的踩过：改了注释、忘了加方法，检查却以为方法在。）
 *
 * ⚠️ 代价说清楚：这会把字符串里的 // 之后也当注释切掉。对「方法定义都在自己一行」
 *    的真实代码没有影响；万一将来出现误报，先看这里。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '')
}

/** 找出「绑了但 .ts 里没有实现」的方法名 */
export function missingHandlers(wxml, ts) {
  const code = stripComments(ts)
  const missing = []
  for (const name of collectHandlers(wxml)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    /** 方法定义 / 属性写法都算：onX( … 或 onX: … */
    if (!new RegExp('\\b' + escaped + '\\s*[(:]').test(code)) missing.push(name)
  }
  return missing
}
