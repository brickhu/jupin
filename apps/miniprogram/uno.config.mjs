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

/**
 * ⭐ 主题刻度 —— **唯一来源**。
 *   ⚠️ 提成模块级常量（而不是写在 export default 里）是为了让下面的 preflights
 *      能读到它，把色值导成 CSS 变量给手写 WXSS 用（见 preflights 的说明）。
 */
const theme = {
    colors: {
      primary: {
        DEFAULT: '#2B142C', // 主色默认
        dark: '#2C1A2D', // 主色暗黑适配
        weak: {
          DEFAULT: '#352436', 
          dark: '#1C121C', 
        }, // 弱化
        strong:{
          DEFAULT: '#1D0D1D', 
          dark: '#3B203C', 
        }, //加强
        on: {
          DEFAULT: '#FFFFFF', 
          dark: '#F7F3F7',
        } // 反色
      }, // 整个APP中的主色，主要用于按钮、链接、强调文字等
      surface: {
        DEFAULT: '#F6F6F6', 
        dark: '#1D161D', 
        weak: {
          DEFAULT: '#FEFEFE', 
          dark: '#141014',
        },
        strong:{
          DEFAULT: '#E2E2E2', 
          dark: '#2C202C', 
        },
        on: {
          DEFAULT: '#290E2A', 
          dark: '#EFEBEF', 
        } // 反色
      }, // 整个APP中的表面色，主要用于卡片、背景等
      accent:{
        DEFAULT: '#EF7203', 
        dark: '#F57D14',  
        weak: {
          DEFAULT: '#FFAE66',   
          dark: '#AE5C13',  
        },
        strong:{
          DEFAULT: '#FF8D28',   
          dark: '#FB8D2D', 
        },
        on: {
          DEFAULT: '#FFFFFF', 
          dark: '#221911', 
        } // 反色
      }, // 整个APP中的强调色，主要用于按钮、链接、强调文字等
      warning: {
        DEFAULT: '#FBCA58', 
        on: '#FFFFFF', 
      }, // 整个APP中的警告色，主要用于提示、警告等
      error: {
        DEFAULT: '#FF4C4C', 
        on: '#FFFFFF',  // 反色
      }, // 整个APP中的错误色，主要用于错误提示、错误状态等
      success: {
        DEFAULT: '#21B99B', 
        on: '#FFFFFF', // 反色
      }, // 整个APP中的成功色，主要用于成功提示、成功状态等
      brand: '#4f46e5', // 废弃，用accent替代
      ok: '#16a34a', // 废弃，用success替代
      warn: '#f59e0b', // 废弃，用warning替代
      bad: '#dc2626', // 废弃，用error替代


      ink: '#111', // 废弃，用page.on替代
      body: '#333', // 废弃，普通卡片底色用surface.DEFAULT，表面文字用surface.on
      muted: '#666', // 废弃，普通文字用page.on，或surface.on 添加透明度替代
      faint: '#999', // 废弃

      // ---- 面 ----
      page: {
        DEFAULT: '#ffffff', // 页面底色（浅）
        dark: '#171217', // 页面底色（暗）
        on: {
          DEFAULT: '#131311', // 页面上的通用文字色（浅）
          dark: '#F1EEF1', // 页面上的通用文字色（暗）
        },
      }, // 页面底色 + 页面上的通用文字色（浅 / 暗各一套）
      line: '#f0f0f0', // 废弃，普通卡片边框用surface.strong，或surface.on 添加透明度替代
      cardline: '#cccccc', // 废弃，普通卡片边框用surface.strong，或surface.on 添加透明度替代
    },
    spacing: {
      none: '0rpx',
      xs: '8rpx',
      sm: '16rpx',
      md: '32rpx',
      lg: '48rpx',
      xl: '64rpx',
      '2xl': '80rpx',
      '3xl': '96rpx',
      '4xl': '128rpx',
      '5xl': '144rpx',
      '6xl': '160rpx',
    },
    fontSize: {
      xs: ['24rpx', { lineHeight: '32rpx' }],
      sm: ['28rpx', { lineHeight: '36rpx' }],
      base: ['32rpx', { lineHeight: '40rpx' }],
      lg: ['36rpx', { lineHeight: '44rpx' }],
      xl: ['40rpx', { lineHeight: '48rpx' }],
    },
    borderRadius: {
      none: '0rpx',
      sm: '8rpx',
      md: '20rpx',
      lg: '32rpx',
      full: '9999rpx',
    },
  }

export default {
  presets: [presetWeapp()],
  separators: '__',

  /**
   * ⭐⭐ **把 theme 的色值导成 CSS 变量**（`--tk-<组>[-<槽位>]`），挂在 page 上。
   *
   * 解决的是这个债：**组件 WXSS 是手写 CSS，引用不到 UnoCSS 的类名**，
   * 于是「按钮那种 12 变体 × 多语义色」的组件只能把色值**再抄一遍** ——
   * 主题色一改就三处不同步（uno.config / app.wxss / 组件 wxss）。
   *
   * 有了这些变量，组件就能只写 `var(--tk-primary)`，**色值单一来源**。
   * ⚠️ 浅色一份、暗色一份 —— 后者放在同一个文件的媒体查询里，**自动生效**，不需要
   *     dark-mode.mjs 那套「按类名反向」（那套只对有类名的工具类有效）。
   *
   * ⚠️ 为什么递归树而不是拼路径字符串：`#使用 'primary-weak-dark'` 这种拼法里，
   *    「组名带连字符」和「槽位」无法区分（`page.on` vs `page-on`）。
   *    递归时天然知道每一层的 key，不存在这个歧义。
   */
  preflights: [
    {
      getCSS: () => {
        const colors = theme.colors
        const light = new Map()
        const dark = new Map()

        /**
         * 递归：每一层对象里，`DEFAULT` 是浅色、`dark` 是暗色，其余键是下一层。
         * ⚠️ 一次遍历只用一张单键 Map —— 用数组 push + 事后去重会写出重复变量
         *    （踩过：`--tk-primary-weak` 出现两次，原因是在两个分支里各 push 了一次）。
         */
        const walk = (node, name) => {
          if (typeof node === 'string') {
            light.set(name, node)
            return
          }
          if (!node || typeof node !== 'object') return
          if (typeof node.DEFAULT === 'string') light.set(name, node.DEFAULT)
          if (typeof node.dark === 'string') dark.set(name, node.dark)
          for (const key of Object.keys(node)) {
            if (key === 'DEFAULT' || key === 'dark') continue
            walk(node[key], name + '-' + key)
          }
        }

        for (const group of Object.keys(colors)) walk(colors[group], '--tk-' + group)

        /**
         * ⭐ 再派生两个**透明度变体**：`--tk-<组>-soft`（8%）与 `--tk-<组>-glass`（20%）。
         *
         * ⚠️ 为什么要从 hex 现算，而不是让组件写 `rgba(...)`：
         *    组件自己写 rgba 就等于**把色值再抄一遍**（改主题色时那半会不同步）。
         *    这里算一次，组件只写 `var(--tk-primary-glass)` —— 单一来源。
         * ⚠️ 透明度的写法用 `0.2` 而不是 `.2`：本项目已经因为"老 WebView 认不出的颜色语法
         *    会把整条声明丢掉"专门写了 downgradeColorSyntax，前导点没必要冒险。
         * ⚠️ 只对**浅色**那张表生成（暗色变体是"深色半透明"，见下面 darkSemi）；
         *    暗色下要半透明时用 `--tk-dark-semi` 这类固定值即可 —— 玻璃态本来就是
         *    "叠在底层内容上"，暗色下用该色本身压暗更自然。
         */
        const hexToRgb = (hex) => {
          let h = String(hex).replace('#', '')
          if (h.length === 3) h = h.split('').map((c) => c + c).join('')
          if (h.length !== 6) return null
          const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
          return Number.isNaN(r + g + b) ? null : [r, g, b]
        }
        for (const [name, hex] of [...light.entries()]) {
          const rgb = hexToRgb(hex)
          if (!rgb) continue
          const [r, g, b] = rgb
          // 只给"基色"派生（--tk-primary / --tk-accent …），槽位色不派生，免得出噪声
          // 只给「基色」（--tk-<组>，连字符恰好 3 个）派生；槽位色不派生，免得出噪声
          if ((name.match(/-/g) || []).length !== 3) continue
          light.set(name + '-soft', `rgba(${r},${g},${b},0.08)`)
          light.set(name + '-glass', `rgba(${r},${g},${b},0.2)`)
        }

        /**
         * ⭐ 刻度也导出成变量：spacing / fontSize / borderRadius。
         *   这样手写 WXSS 的组件（如 ui-button）能写 `var(--tk-space-2xl)`，
         *   而不是把 80rpx 再抄一遍 —— 改刻度不用动组件。
         *   ⚠️ fontSize 的值可能是 `['32rpx', { lineHeight }]` 这种元组，取第 0 位。
         */
        const scaleInto = (map, src, prefix) => {
          if (!src || typeof src !== 'object') return
          for (const key of Object.keys(src)) {
            const v = src[key]
            const value = Array.isArray(v) ? v[0] : v
            if (typeof value === 'string') map.set(prefix + key, value)
          }
        }
        /**
         * ⭐ 再派生**禁用态**要用的 50% alpha 值：`--tk-<组>-50` 与 `--tk-<组>-on-50`。
         *   ⚠️ 为什么必须在这里算：CSS 拆不开 hex（拿不到 r/g/b），color-mix 在小程序不稳，
         *      所以"底 50% + 字 50%"只能由构建期把 rgba 算好。
         *   ⚠️ 浅色与暗色**各算一份** —— 禁用态也要跟着暗色走。
         */
        const deriveAlpha = (map) => {
          for (const [name, hex] of [...map.entries()]) {
            if ((name.match(/-/g) || []).length !== 3) continue // 只对基色（--tk-<组>）
            const rgb = hexToRgb(hex)
            if (rgb) map.set(name + '-50', `rgba(${rgb.join(',')},0.5)`)
            const onHex = map.get(name + '-on')
            const onRgb = onHex && hexToRgb(onHex)
            if (onRgb) map.set(name + '-on-50', `rgba(${onRgb.join(',')},0.5)`)
          }
        }
        deriveAlpha(light)
        deriveAlpha(dark)

        scaleInto(light, theme.spacing, '--tk-space-')
        scaleInto(light, theme.fontSize, '--tk-font-')
        scaleInto(light, theme.borderRadius, '--tk-radius-')
        /** 组件级的固定值也走变量：玻璃态的模糊半径、按钮描边宽度 */
        light.set('--tk-blur-glass', '20rpx')
        light.set('--tk-border-btn', '2rpx')

        const decl = (m) => [...m.entries()].map(([k, v]) => k + ':' + v).join(';')
        // ⚠️ 挂在 page 上（和 UnoCSS 自己的 --un-* 同一个宿主），组件里可直接继承
        return (
          'page,root-portal-content{' + decl(light) + '}\n' +
          '@media (prefers-color-scheme: dark){page,root-portal-content{' + decl(dark) + '}}'
        )
      },
    },
  ],

  /**
   * ⭐ **组合类（shortcut）** —— 目前只有一个：普通白卡（没有主题色的容器）。
   *
   * ⚠️ 为什么值得有它：全项目有三十多处 `bg-white rounded-2.5 ...`，
   *    要让它们"长得一样"就得每处抄同一串类名 —— 抄漏一处就是一张没有边框的卡。
   *    收成一个 `card` 之后，"白卡长什么样"只有这一处定义。
   *
   * ⚠️ 它是**构建期展开的原子类**（产物里就是 `.card{...}`），不是 app.wxss 里
   *    手写的语义类 —— 后者会踩到"页面 WXSS 在 app.wxss 之后加载、同名类互相覆盖"那个坑
   *    （见 src/app.wxss 的说明）。所以这条路是安全的。
   *
   * ⚠️ 句子卡（`arena-card`）**不用**这个：它有主题色，边框跟主题前景色走
   *    （见 components/arena-card/arena-card.wxss 的 .ac-card）。
   */
  /**
   * ⭐⭐ **safelist** —— 按钮那批维度类必须在这里登记。
   *
   * ⚠️⚠️ 为什么非它不可：本组件的类名是在 **TS 里拼**的（`'ub-s-' + size`），
   *   而 UnoCSS 是**构建期扫源码里的字面量** —— 拼出来的名字扫不到，
   *   shortcut 就**不会展开**。
   *   实测踩过：只写了 `ub-s-md` 能出（因为别处有这串字面量），
   *   `ub-s-sm/lg/xl` **一条都没生成**，表现是"尺寸写什么都不生效"且没有任何报错。
   *
   * ⚠️ 所以：**给这个组件加新维度值，必须同时在这里加一行**。
   *   （另一条路是把类名以字面量列在 TS 里；但 safelist 更直白、也不会被误删。）
   */
  safelist: [
    'ub-base', 'ub-hover', 'ub-full',
    'ub-tall', 'ub-square',
    // color / 反色
    ...[
      'primary', 'accent', 'success', 'warning', 'error',
    ].flatMap((c) => ['ub-c-' + c, 'ub-fg-' + c]),
    // 墨色：outline / ghost / glass 的字与边框
    // size
    ...['sm', 'md', 'lg', 'xl'].map((s) => 'ub-s-' + s),
    // roundness
    ...['sm', 'md', 'lg', 'full'].map((r) => 'ub-r-' + r),
  ],

  shortcuts: {
    card: 'bg-surface rounded-2.5 border-2 border-solid border-surface-strong',

    /* ══════════════════════════════════════════════════════════════
     * ⭐⭐ 按钮的四组维度 —— **从 token 生成**，不在组件 WXSS 里手抄。
     *
     * 分工（这是关键，顺序不能颠倒）：
     *   · 这里的 shortcut 只负责把 **token 塞进 `--tk-color`**（"这一档的基色是哪个"）
     *   · 组件 WXSS 再把它**派生**成可覆盖的 `--btn-bg` / `--btn-fg` / …：
     *         --btn-bg: var(--btn-bg, var(--tk-color))
     *   ⇒ 外部只要在调用处写 `style="--btn-bg:#f00"` 就能覆盖，
     *     **不依赖 shortcut 与外部声明的先后顺序**（两者属性名不同，不会打架）。
     *
     * ⚠️ 不要把 `--btn-bg` 直接写在 shortcut 里 —— 那会和外部覆盖用**同一个属性名**，
     *    谁赢取决于 CSS 顺序，是隐性 bug。
     * ══════════════════════════════════════════════════════════════ */

    /* base：按钮的基础布局 —— ⚠️ 连这几条也走 shortcut，不在组件 WXSS 里手写。
       `leading-none` 是 line-height:1（⚠️ 别写 leading-1：刻度里 1 = 8rpx，那就塌了）。
       `border-2` 走 theme 的 borderWidth（2rpx）。 */
    'ub-base': 'flex items-center justify-center box-border leading-none border-2 border-solid border-transparent',

    /* 状态类 —— 同样是原子类的组合，不手写。
       ⚠️ 这里**没有** ub-disabled：禁用态要"底与字**各自**降到 50% alpha"，
          那需要按色给 rgba（见 preflights 的 --tk-<色>-50 / -on-50），
          shortcut 只能展开成原子类、表达不了 ⇒ 它留在组件 WXSS 里。
          （曾误用 `ub-disabled: 'opacity-50'`：那是群组不透明度，
            前景相对自己的底其实没变，只是整块相对页面变淡。） */
    'ub-hover': 'opacity-85',
    'ub-full': 'w-full',

    /* color：只给基色 `--tk-color` ——
       ⚠️⚠️ 必须用「任意属性」语法 `[--tk-color:theme(...)]`，**不能用 `bg-primary`**：
          `bg-primary` 会真的把 background 设上，于是组件里的 `var(--btn-bg)` 被它盖住，
          外部覆盖 `--btn-bg` 就失效了（踩过）。任意属性只写变量、不产生任何样式。 */
    'ub-c-primary': '[--tk-color:theme(colors.primary.DEFAULT)]',
    'ub-c-accent': '[--tk-color:theme(colors.accent.DEFAULT)]',
    'ub-c-success': '[--tk-color:theme(colors.success.DEFAULT)]',
    'ub-c-warning': '[--tk-color:theme(colors.warning.DEFAULT)]',
    'ub-c-error': '[--tk-color:theme(colors.error.DEFAULT)]',

    /* 各色的「反色」与「玻璃底」——同样只设变量 */
    'ub-fg-primary': '[--tk-on:theme(colors.primary.on.DEFAULT)]',
    'ub-fg-accent': '[--tk-on:theme(colors.accent.on.DEFAULT)]',
    'ub-fg-success': '[--tk-on:theme(colors.success.on)]',
    'ub-fg-warning': '[--tk-on:theme(colors.warning.on)]',
    'ub-fg-error': '[--tk-on:theme(colors.error.on)]',

    /* size：只给「这一档多高 / 内边距多少」两个变量 + 字号。
       ⚠️ 高度与左右内边距**不在这里**，而是由 ub-tall（常态）/ ub-square（only-icon）
          去读这两个变量 —— 这样"正方形"就不需要复合选择器了。 */
    'ub-s-sm': '[--ub-size:var(--tk-space-xl)] [--ub-pad:var(--tk-space-md)] text-xs',
    'ub-s-md': '[--ub-size:var(--tk-space-2xl)] [--ub-pad:var(--tk-space-md)] text-sm',
    'ub-s-lg': '[--ub-size:var(--tk-space-3xl)] [--ub-pad:var(--tk-space-lg)] text-base',
    'ub-s-xl': '[--ub-size:var(--tk-space-4xl)] [--ub-pad:var(--tk-space-xl)] text-lg',

    /* 常态：内容宽度 + 左右内边距；only-icon：强制正方形（宽=高、无内边距）。
       ⚠️ 两个都走 shortcut —— 调用方（sync）按 onlyIcon **二选一**，不再写复合选择器。
       ⚠️⚠️ 二者**互斥、绝不能同时挂**：产物里 ub-square 在 ub-tall 之后，
          同时挂会让 padding:0 被 ub-tall 的 padding-left/right 覆盖（正方形就歪了）。
          要改这个关系，必须连同 sync() 的二选一一起改。 */
    /* ⚠️ 这里必须带内联 fallback：`--ub-size` 只由 .ub-s-* 声明，
       而 .ub 里**不能**再写 `--ub-size: var(--ub-size, …)` 去兜底 —— 那是自引用环。 */
    'ub-tall': 'h-[var(--ub-size,var(--tk-space-2xl))] px-[var(--ub-pad,var(--tk-space-md))]',
    'ub-square': 'h-[var(--ub-size,var(--tk-space-2xl))] w-[var(--ub-size,var(--tk-space-2xl))] p-0',

    /* roundness：四档圆角，走 theme 的 borderRadius */
    'ub-r-sm': 'rounded-[var(--tk-radius-sm)]',
    'ub-r-md': 'rounded-[var(--tk-radius-md)]',
    'ub-r-lg': 'rounded-[var(--tk-radius-lg)]',
    'ub-r-full': 'rounded-[var(--tk-radius-full)]',

  },

  /**
   * ⚠️ 这里的色值**全部取自页面里既有的颜色**，不是新设计的 ——
   *    迁移只换写法，不换视觉。灰阶/间距/字号一律用 UnoCSS 默认刻度。
   *
   * 间距刻度：1 单位 = 8rpx = 4px 等效（`p-4` → `padding: 32rpx`），与手写 WXSS 同刻度。
   */
  theme,
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
