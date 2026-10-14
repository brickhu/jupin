/**
 * ⭐ 暗色模式 —— **构建期自动生成反向色**，WXML 里一个类名都不用多写。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它解决的是什么
 *
 *   `theme.colors` 里每个 token 只有**一处**定义，浅色的叫 `DEFAULT`、暗色的叫 `dark`
 *   （嵌套槽位如 `primary.weak.dark` 同样认）。本文件在构建期：
 *     ① 递归把「浅色值 → 暗色值」全部抽出来；
 *     ② 扫一遍 UnoCSS 的产物，凡是用到这些色值的规则，原样复制一条到
 *        `@media (prefers-color-scheme: dark)` 里、把色值换成暗色那一版。
 *
 *   ⇒ 于是 `class="bg-page"` 在浅色下是白、暗色下自动变深 —— 不用写 `dark:bg-page`，
 *     也不用维护第二份类名。
 *
 * ⚠️⚠️ 为什么不用 UnoCSS 的 variant（`dark:bg-page`）
 *   本项目的 separator 是 `__`（见 uno.config.mjs 的说明），而 `dark__x` 会被
 *   preset-weapp 当成「class `.dark` 的后代」编译成 `.dark .dark__x` —— **不是媒体查询**。
 *   在 `variants` 里手写前缀也会和 preset 的选择器改写打架。构建期注入没有这些坑。
 *
 * ⚠️⚠️ 它**看不见硬编码色值**
 *   页面 WXSS 里写死的 `#ffffff` / `#4f46e5` 那些（如 pages/\*\/\*.wxss）不走 token，
 *   本文件碰不到 —— 那些要手工收敛进 token，才能跟着反向。
 *
 * ⚠️ 明暗**相同**的 token（如 `page.on` 与 `on-dark` 恰好相等）会被跳过，
 *   不产生冗余规则。以后加 token 只要有 `dark` 就自动纳入，不用改这里。
 * ══════════════════════════════════════════════════════════════════
 */

export const DARK_MEDIA = '@media (prefers-color-scheme: dark)'

/** `#rgb` / `#rrggbb` → UnoCSS 与产物里那种 `r g b` 空格分隔写法；非法返回 null */
function hexToRgbTriple(hex) {
  let s = String(hex).replace('#', '')
  if (s.length === 3) s = s.split('').map((c) => c + c).join('')
  if (s.length !== 6) return null
  const n = [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16))
  if (n.some((v) => Number.isNaN(v))) return null
  return n.join(' ')
}

/**
 * ⭐ 摊平成「token 名 → 该 token 的浅色值 + 各槽位暗色值」。
 *
 * 槽位语义（与 uno.config.mjs 的写法一一对应）：
 *   · `DEFAULT` → 类名里的不带后缀那档：`bg-page` 取 `page.DEFAULT`
 *   · `weak` / `strong` / `on` → 类名里的后缀档：`bg-page-weak` 取 `page.weak`
 * 每一档再分 `light` / `dark` 两个值。
 *
 * ⚠️⚠️ **必须按 token 名匹配，不能按色值匹配** —— 踩过：
 *    `page.DEFAULT` 和 Tailwind 内置的 white 都是 `#ffffff`，按值匹配会把
 *    `.bg-white`（含 `.card` 快捷类展开出来的）一起反向成"页面底色"，
 *    于是卡片在暗色下变成页面色、白字变成深字。
 *    按名字匹配则天然不碰 `bg-white`（它不属于任何 token），行为可预测。
 *
 * ⚠️ 只收「浅暗都有、且不相等」的档位 —— 缺暗色的（说明还没设计）与
 *    明暗同值的（反向无意义）都不进表。
 */
export function collectDarkTokens(colors) {
  const flat = (node, path, out) => {
    if (typeof node === 'string') {
      out.push([path.join('.'), node])
      return
    }
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) flat(node[k], [...path, k], out)
    }
  }

  const tokens = new Map()
  const skipped = []

  for (const group of Object.keys(colors || {})) {
    const entries = []
    flat(colors[group], [], entries)

    /** token 名（含组名，如 `page` / `page.on`）→ { light, dark } */
    const t = new Map()

    /**
     * 路径 → token 名 + 槽位。
     * ⚠️ 这里**必须把组名保留在 token 名里**（`page` → `page`、`page.on` → `page.on`）：
     *    若把组名当作"token 名"、把其余路径当"槽位"，`page.DEFAULT` 与 `page.on`
     *    会被压成同一个槽位而**互相覆盖**（踩过：只剩 3 个 token、跳过项全写着"on"）。
     */
    const slotOf = (segs) => {
      const leafIsDark = segs[segs.length - 1] === 'dark'
      const name = [group, ...segs.filter((s) => s !== 'DEFAULT' && s !== 'dark')].join('.')
      return { name, leafIsDark }
    }

    for (const [path, value] of entries) {
      const { name, leafIsDark } = slotOf(path.split('.'))
      const rec = t.get(name) ?? {}
      rec[leafIsDark ? 'dark' : 'light'] = value
      t.set(name, rec)
    }

    for (const [label, cell] of t) {
      if (!cell.light) continue
      if (!cell.dark) {
        skipped.push(label + '（缺暗色）')
        continue
      }
      if (cell.light === cell.dark) continue
      const light = hexToRgbTriple(cell.light)
      const dark = hexToRgbTriple(cell.dark)
      if (!light || !dark) {
        skipped.push(label + '（色值非法）')
        continue
      }
      tokens.set(label, { light, dark })
    }
  }

  return { tokens, skipped }
}

/** 能从 class 里剥出来的颜色工具前缀（命中即认为该 class 是一个「颜色工具类」） */
const COLOR_PREFIXES = [
  'bg', 'text', 'border', 'decoration', 'from', 'via', 'to', 'ring', 'outline',
  'fill', 'stroke', 'shadow', 'divide', 'placeholder', 'caret', 'accent',
]




/**
 * ⭐ 扫一遍已生成的 CSS，产出暗色覆盖块。
 *
 * 对每条规则里的 class：
 *   ① 剥掉颜色工具前缀（`bg-` / `text-` / `border-` …）拿到 token 名；
 *   ② 用**最长前缀**去 `tokens` 里找（保证 `text-surface-on` 命中 `surface.on`
 *      而不是 `surface`）；
 *   ③ 命中就把规则体里的**浅色值**换成该 token 的**暗色值**。
 *
 * ⚠️ 必须在 `downgradeColorSyntax()` **之前**调用 —— 本函数产出的仍是 CSS Color 4 写法
 *    （`rgb(r g b / a)`），要和 UnoCSS 的产物一起过那一道降级。
 * ⚠️ 只吃**单个选择器**的顶层单行规则：逗号分组的（如 `.bg-card,.bg-white{…}`）
 *    两个类可能受益不同，整条复制会误伤其中一个 —— 直接跳过（宁可少一条，不可错一条）。
 * ⚠️ `bg-white` / `text-white` 这类 Tailwind 内置色**不属于任何 token**，天然不反向 ✓
 * ⚠️ 已有的 `@media` 块与注释行跳过，本函数只负责补。
 */
/**
 * ⭐ 按花括号配平切出**顶层规则**。
 *
 * ⚠️⚠️ 不能按换行解析 —— UnoCSS 会把逗号分组的选择器写成多行：
 *      `.bg-page,\n.bg-white{background-color:#fff}`
 *    按行切的话第一行 `.bg-page,` 是不完整规则，会被整条丢掉（踩过：
 *    产物里明明有 `bg-page`，暗色却 0 条规则）。
 *   ⚠️ 本函数只收「选择器体里没有嵌套花括号」的规则；`@media` 块整体跳过
 *      （选择器以 `@` 开头 → 交给后面的 flush 判断，遇 `@` 直接不进）。
 */
export function collectTopLevelRules(css) {
  const rules = []
  let depth = 0
  let start = 0
  // ⚠️ 先剥掉注释：注释里可能含花括号，会把配平数错（踩过：`/* layer: default */`
  //    让整个产物一条规则都切不出来）。UnoCSS 的产物里注释只在层分隔处，剥掉不影响语义。
  const s = String(css).replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '{') {
      depth++
      continue
    }
    if (c !== '}') continue
    depth--
    if (depth !== 0) continue
    const chunk = s.slice(start, i + 1)
    start = i + 1
    const at = chunk.indexOf('{')
    const selector = chunk.slice(0, at).trim()
    const body = chunk.slice(at + 1, -1)
    if (!selector || selector.startsWith('@') || selector.startsWith('/*')) continue
    if (selector.includes('{')) continue
    rules.push([selector, body])
  }
  return rules
}

export function buildDarkCss(css, colors) {
  const { tokens, skipped } = collectDarkTokens(colors)
  if (tokens.size === 0) return { css: '', count: 0, tokens: 0, skipped }

  /** token 名按长度降序 —— 保证最长前缀优先命中（text-surface-on → surface.on） */
  const names = [...tokens.keys()].sort((a, b) => b.length - a.length)

  /**
   * ⭐ class → token 的浅/暗色值。
   *
   * ⚠️⚠️ 关键：token 名里的**槽位分隔符是 `.`**（`page.on`），而**类名里是 `-`**
   *   （`text-page-on`）。所以不能拿类名后缀直接和 token 名比 —— 要在**每个连字符处**切一刀，
   *   逐段去表里找。（踩过：`bg-page` 能反向、`text-page-on` 永远匹配不上，
   *   因为 `"page-on" !== "page.on"`。）
   *
   * ⚠️ 还要先剥掉**透明度后缀**（`text-page-on_65` → `page-on`）—— 它是 UnoCSS 的
   *   透明度修饰符，不是 token 名的一部分。
   *
   * 切分规则（从左往右找最长命中，保证 `surface-on` 命中 `surface.on` 而不是 `surface`）：
   *   · 左半是已注册的 token 组名
   *   · 右半为该组的槽位；没有右半时取 DEFAULT
   */
  const resolve = (cls) => {
    if (!cls.startsWith('.')) return null
    const bare = cls.slice(1)
    for (const prefix of COLOR_PREFIXES) {
      if (!bare.startsWith(prefix + '-')) continue
      const suffix = bare.slice(prefix.length + 1).replace(/_[0-9]+$/, '')
      if (!suffix) continue
      const cuts = []
      for (let i = suffix.indexOf('-'); i !== -1; i = suffix.indexOf('-', i + 1)) cuts.push(i)
      cuts.push(-1) // 无槽位（DEFAULT）
      // 长组名优先
      for (const i of cuts) {
        const group = i === -1 ? suffix : suffix.slice(0, i)
        const slotRaw = i === -1 ? '' : suffix.slice(i + 1)
        const name = slotRaw ? group + '.' + slotRaw : group
        if (names.includes(name)) return tokens.get(name)
      }
    }
    return null
  }

  /**
   * ⚠️⚠️ 选择器**可能是逗号分组的** —— UnoCSS 会把「色值相同」的类合并成一条：
   *      `.bg-page,
   *       .bg-white{background-color:#fff}`
   *    这一类里有 `bg-page`（该反向）和 `bg-white`（不该反向，它是 Tailwind 内置色）。
   *    ⇒ **不能整条复制**。做法：把组里的每个类单独解析，
   *      各自算出「同一个 body、换成本类暗色值」后的结果，**再按结果重新分组**，
   *      每组输出一条选择器。这样 `bg-page` 单独进暗色块、`bg-white` 自然不进。
   */
  const groupOf = new Map() // 结果 body → Set(选择器)
  for (const [selector, body] of collectTopLevelRules(css)) {
    for (const sel of selector.split(',').map((x) => x.trim())) {
      if (!sel.startsWith('.') || sel.includes(':') || sel.includes('[') || sel.includes(' ')) continue
      const cell = resolve(sel)
      if (!cell) continue
      if (!body.includes('(' + cell.light)) continue
      const darkBody = body.split('(' + cell.light).join('(' + cell.dark)
      const set = groupOf.get(darkBody) ?? new Set()
      set.add(sel)
      groupOf.set(darkBody, set)
    }
  }

  if (groupOf.size === 0) return { css: '', count: 0, tokens: tokens.size, skipped }
  const rules = []
  for (const [body, sels] of groupOf) {
    for (const sel of sels) rules.push(sel + '{' + body + '}')
  }
  return {
    css: DARK_MEDIA + '{\n' + rules.join('\n') + '\n}',
    count: rules.length,
    tokens: tokens.size,
    skipped,
  }
}
