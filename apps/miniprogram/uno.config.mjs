/**
 * UnoCSS 配置 —— 只服务小程序端的 WXSS 生成。
 *
 * ⚠️ 为什么是 UnoCSS 而不是 StyleX / 运行时 CSS-in-JS：
 *   **WXML 不能调用 JS**，所以任何「在 JS 里算类名再塞进模板」的方案
 *   （stylex.props() 之类）在小程序里都得额外搭一层 data 桥接才用得上。
 *   UnoCSS 走的是「构建期扫源码 → 生成静态 WXSS」的路子，
 *   模板里直接 class="flex items-center"，**零运行时**。
 *
 * ⚠️ separators 必须是 '__'：
 *   WXSS 不支持 `\:` `\[` 这类转义选择器，所以 `hover:bg-x` 这种类名
 *   在小程序里**根本无法表达**（写了也不生效）。UnoCSS 允许换分隔符，
 *   于是写成 `hover__bg-x`、`active__opacity-50`。
 *
 * ⚠️ 产物必须过 downgradeColorSyntax()：
 *   UnoCSS 66 输出 CSS Color 4 的 `rgb(79 70 229 / 0.1)`，
 *   老 WebView 解析不了会**整条声明丢弃**（颜色静默消失，不是报错）。
 *   见该函数注释。
 */
import presetWeapp from 'unocss-preset-weapp'
// ⭐ 小程序类名转义的**权威规则表**。unocss-preset-weapp 内部就是用它把 CSS 选择器
//    里的 \[ \] \. 换成 _lfl_ / _lfr_ / _dl_ 的；我们复用它来处理另一半（WXML 源码）。
import { transformSelector } from 'unplugin-transform-class/utils'

export default {
  presets: [presetWeapp()],
  separators: '__',

  /**
   * ⚠️ 这里的色值**全部取自页面里既有的颜色**，不是新设计的 ——
   *    迁移只换写法，不换视觉。灰阶/间距/字号一律用 UnoCSS 默认刻度。
   *
   * 间距刻度：1 单位 = 8rpx = 4px 等效（`p-4` → `padding: 32rpx`），与手写 WXSS 同刻度。
   */
  theme: {
    colors: {
      // ---- 品牌 + 语义状态 ----
      brand: '#4f46e5', // 品牌色（= indigo-600）
      ok: '#16a34a', // 读对 / 征服（= green-600）
      warn: '#f59e0b', // 未征服（= amber-500）
      bad: '#dc2626', // 读错 / 错误（= red-600）

      // ---- 文字层级：4 级，越往后越淡 ----
      // ⚠️ 迁移时页面里散落着 7 级灰度（#111 #333 #444 #666 #8a8a8e #999 #aaa），
      //    那是随手加的、不是设计出来的。这里收敛成 4 级，取的是原本出现频次最高的值，
      //    被合并掉的是 #444→body、#8a8a8e→faint、#aaa→faint（色差均 <10%，肉眼基本无感）。
      ink: '#111', // 标题 / 强调 / 深色底
      body: '#333', // 正文
      muted: '#666', // 次要正文
      faint: '#999', // 标签 / 辅助说明

      // ---- 面 ----
      page: '#f7f7f8', // 页面底色
      line: '#f0f0f0', // 分隔线
    },
  },
}

/**
 * 把 CSS Color 4 的颜色语法降级成老 WebView 认的写法。
 *
 * 为什么必须有这一步：UnoCSS 66 输出 `rgb(79 70 229 / 0.1)`、`rgb(0 0 0 / 0)`
 * 这种空格分隔 + 斜杠 alpha 的写法（CSS Color 4）。
 * 小程序 iOS 端跑的是系统 WKWebView、Android 端是 XWeb，
 * 版本旧的那个一旦不认识这个语法，是**整条声明被丢弃** ——
 * 表现是「颜色莫名其妙没了」，不报错，极难排查。
 * 转成 rgba(r, g, b, a) 则在所有版本上都成立。
 *
 * ⚠️ 对已经是 rgba(1, 2, 3, 0.5) 的传统写法是 no-op（逗号不是空白），
 *    所以可以安全地对任何 CSS 反复调用。
 */
export function downgradeColorSyntax(css) {
  const alpha = '((?:[^()]|\\([^()]*\\))+?)' // 允许 var(--un-bg-opacity) 这类带括号的值
  const triple = '([\\d.]+%?)\\s+([\\d.]+%?)\\s+([\\d.]+%?)'

  return css
    .replace(new RegExp(`\\b(rgb|hsl)a?\\(\\s*${triple}\\s*\\/\\s*${alpha}\\s*\\)`, 'g'),
      (_, fn, a, b, c, al) => `${fn}a(${a}, ${b}, ${c}, ${al})`)
    .replace(new RegExp(`\\b(rgb|hsl)a?\\(\\s*${triple}\\s*\\)`, 'g'),
      (_, fn, a, b, c) => `${fn}(${a}, ${b}, ${c})`)
}

/**
 * 产物的小程序约束检查 —— 构建期拦截「只在真机上炸」的问题。
 *
 * ⚠️ 为什么值得单独做一道（和 build.mjs 的 assertNoModernSyntax() 同一类防护）：
 *    下面每一条**在模拟器里都完全正常**，只在真机 / 特定 WebView 版本上暴露，
 *    而且表现是「静默失效」而非报错，排查成本极高。构建期拦下来几乎零成本。
 */
export function assertWxssSafe(css) {
  const problems = []
  if (/(rgb|hsl)a?\(\s*[\d.]+%?\s+[\d.]+%?\s+[\d.]+%?\s*[/)]/.test(css)) {
    problems.push('残留 CSS Color 4 颜色语法 rgb(r g b / a) —— 老 WebView 会丢掉整条声明')
  }
  if (/\\[[\]]/.test(css) || /\\[:.$]/.test(css)) {
    problems.push('含反斜杠转义选择器 —— WXSS 不支持，对应类名会静默失效')
  }
  if (/:not\(#\\#\)/.test(css)) {
    problems.push('含 :not(#\\#) 特异性 hack —— WXSS 不支持')
  }
  // ---- 以下三条是 Skyline 子集约束，见 docs/research/skyline-evaluation.md ----
  // ⚠️ 它们**在 WebView 下能正常跑**，加进来不是为了修今天的 bug，
  //    而是为了让产物始终落在两个引擎的交集里 ——
  //    将来按页面切 Skyline 时，样式不用回头返工。
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, ' ') // 去掉注释，避免 /*!*/ 里的 * 误报
  if (/(^|[{};,])\s*\*\s*(?=[{,])/m.test(bare)) {
    problems.push('含 * 通配选择器 —— Skyline 不支持')
  }
  if (/\[[^\]]*\]\s*(?=[{,])/.test(bare)) {
    problems.push('含属性选择器 [attr] —— Skyline 不支持（WebView 支持，但会挡住将来切 Skyline）')
  }
  if (/:hover\b/.test(bare)) {
    problems.push('含 :hover —— Skyline 未支持；触屏场景请改用 active__ 变体')
  }

  if (problems.length > 0) {
    throw new Error('uno.wxss 违反小程序约束：\n  · ' + problems.join('\n  · '))
  }
}

/**
 * 收集 WXML 里**实际会生效**的类名。
 *
 * 两部分：class 属性的静态部分，以及 `{{}}` 里引号中的条件类名。
 * ⚠️ 插值表达式里的 `health.pending` 这种**不是**类名，不能算进来。
 */
export function collectWxmlClasses(code) {
  const out = new Set()
  const add = (s) => {
    for (const t of s.split(/\s+/)) if (t) out.add(t)
  }
  for (const m of code.matchAll(/\sclass="([^"]*)"/g)) {
    const value = m[1]
    add(value.replace(/\{\{[\s\S]*?\}\}/g, ' '))
    for (const expr of value.match(/\{\{[\s\S]*?\}\}/g) ?? []) {
      // ⚠️ 必须先剔除**比较运算的右操作数**。
      //    `{{phase === 'submitting' ? 'x' : ''}}` 里 'submitting' 是判断条件、
      //    不是类名；不剔除就会误报「submitting 这个类名没有定义」，构建直接失败。
      const onlyClasses = expr.replace(/(===|!==|==|!=|<=|>=|<|>)\s*'[^']*'/g, '$1')
      for (const lit of onlyClasses.matchAll(/'([^']*)'/g)) add(lit[1])
    }
  }
  return out
}

/**
 * 收集 WXSS 里定义过的类名。
 * ⚠️ 只在**选择器位置**上找 —— 否则 `rgba(0, 0, 0, .5)` 里的 `.5` 会被误认成类名。
 */
export function collectWxssClasses(css) {
  const out = new Set()
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const rule of bare.match(/[^{}]+\{/g) ?? []) {
    for (const m of rule.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) out.add(m[1])
  }
  return out
}

/**
 * 建立「源码里写的类名 → WXSS 里实际的选择器名」映射。
 *
 * ⚠️⚠️ 为什么必须有这一步（这是本项目最容易静默失效的地方）：
 *    WXSS 不支持 \[ \] \. 这类转义选择器，所以 unocss-preset-weapp 会把
 *    CSS 选择器改写成安全形式：
 *        .pb-\[60rpx\]   →  .pb-_lfl_60rpx_lfr_
 *        .p-2\.5          →  .p-2_dl_5
 *    但它**只改了 CSS 那一半**。源码那一半要靠 unplugin-transform-class 插件改写，
 *    而我们是自己调 UnoCSS Node API、没有那个插件 ——
 *    于是 WXML 里写着 class="pb-[60rpx]"，WXSS 里却是 .pb-_lfl_60rpx_lfr_，
 *    **两者根本对不上，这一整类工具类全部静默失效**（生成得出来、就是不生效）。
 *
 *    映射不用手抄，直接对 UnoCSS 实际命中的 token 跑同一张规则表，
 *    保证两边用的是**同一个函数**、同一个版本。
 */
export function makeEscapeMap(tokens) {
  const map = new Map()
  for (const token of tokens) {
    const escaped = transformSelector(token)
    if (escaped !== token) map.set(token, escaped)
  }
  return map
}

/**
 * 按映射改写 WXML 里的 class 类名。
 *
 * ⚠️ class 属性要**分两段处理**，这是本函数唯一微妙的地方：
 *
 *   1. **静态部分** —— 按空白切成 token 整词查表替换。
 *      不做子串替换，避免误伤。
 *
 *   2. **`{{ ... }}` 插值表达式** —— 里面的字符串字面量**也是类名，必须一起改写**：
 *      `class="{{running ? 'bg-[#111]' : 'bg-[#bbb]'}}"` 这两个类名同样会匹配不上。
 *      但表达式本身的 `.` `:` `(` `)` `?` **一个字都不能碰** ——
 *      碰了模板直接废掉（`health.pending` 会被改成 `health_dl_pending`）。
 *      所以只对引号内的内容做 token 替换，引号外原样保留。
 *
 * @returns {{ code: string, hits: number }}
 */
export function escapeWxml(code, map) {
  if (map.size === 0) return { code, hits: 0 }
  let hits = 0

  /** 按空白切分，整 token 精确命中才替换 */
  const escapeTokens = (s) =>
    s
      .split(/(\s+)/)
      .map((tok) => {
        const rep = map.get(tok)
        if (rep === undefined) return tok
        hits++
        return rep
      })
      .join('')

  /** 切出插值，逐段处理：插值外整词替换，插值内只替换引号字面量 */
  const escapeValue = (value) => {
    let out = ''
    let rest = value
    for (;;) {
      const open = rest.indexOf('{{')
      if (open === -1) return out + escapeTokens(rest)
      const close = rest.indexOf('}}', open)
      if (close === -1) return out + escapeTokens(rest)
      out += escapeTokens(rest.slice(0, open))
      const expr = rest.slice(open + 2, close)
      out += '{{' + expr.replace(/'([^']*)'/g, (_m, lit) => "'" + escapeTokens(lit) + "'") + '}}'
      rest = rest.slice(close + 2)
    }
  }

  const out = code.replace(/(\sclass=")([^"]*)(")/g, (_m, pre, value, post) => pre + escapeValue(value) + post)
  return { code: out, hits }
}
