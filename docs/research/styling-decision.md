# 小程序样式方案选型

> **结论**：选 **UnoCSS + `unocss-preset-weapp`**。已接入 `apps/miniprogram/build.mjs`，
> 产物 `dist/uno.wxss`（构建期生成，运行时零开销）。

---

## 一句话理由

**WXML 不能调用 JS。** 这一条直接判了所有「在 JS 里算类名再塞进模板」的方案（CSS-in-JS 全家）死刑 ——
它们在小程序里都得额外搭一层 `data` 桥接才能用，而模板写法反而退化。

UnoCSS 走的是另一条路：**构建期扫源码 → 生成静态 WXSS**。模板里直接 `class="flex items-center"`。

---

## 核实状态说明

| 结论 | 来源 |
|---|---|
| UnoCSS 支持**原生**小程序（非仅 Taro/uni-app） | ✅ 官方 README 明确列出「原生微信小程序 wxml」并给出 demo 仓库 |
| preset 与 UnoCSS 主版本同步 | ✅ `unocss-preset-weapp@66.0.2` 依赖 `@unocss/core@^66.1.3` |
| 本仓库可生成、产物形态、刻度、转义行为 | ✅ **本仓库实测**（见下方「可复现」） |
| WXSS 不支持 `\:` `\[` 转义选择器 | ⚠️ 来自 preset 作者说明（`transformerClass` 就是为此存在）；**未单独在真机复现** |
| 老 WebView 会丢弃 CSS Color 4 颜色语法 | ⚠️ **推断**（未在真机复现）。因为消除代价极低，直接降级而不做实验 |

---

## 候选对比

| | StyleX | Tailwind + weapp-tailwindcss | **UnoCSS + preset-weapp** |
|---|---|---|---|
| **原生小程序可用性** | ❌ 需自建 data 桥接 | ✅ | ✅ |
| **WXML 写法** | 用不上（类名在 JS 里算） | `class="..."` | `class="..."` |
| **转义类名**（`\:`、`\[`） | 输出 `:not(#\#)` 特异性 hack | 需 weapp-tailwindcss 专门转换 | ✅ 内置 `transformerClass` |
| **变体怎么写** | n/a | 需转换 | `hover__bg-x`（原生可写） |
| **`rpx`** | 手写 | 需配置 | ✅ 默认 |
| **运行时开销** | 0（静态） | 0 | 0 |
| **接入现有 esbuild** | 需 unplugin + `metafile: true` | 需 postcss/vite 插件 | ⭐ **纯 Node API，直接进 build.mjs** |
| **按需生成** | ✅ | ✅ | ✅ |

### 为什么排除 StyleX（实测记录）

在 `.tmp/` 里用 esbuild 单独跑过 `@stylexjs/stylex@0.19.0` + `@stylexjs/unplugin@0.19.0`：

- ✅ 能出 CSS + JS，`rpx` 保留（`padding: 24rpx`），静态样式**零运行时**（`props()` 只返回 `{className}`）
- ⚠️ 产物带 `:not(#\#)` / `:not(#\#):not(#\#)` 特异性 hack —— **能不能被 WXSS 接受未经验证**
- ⚠️ 必须开 `metafile: true`，且 `styleResolution: 'application-order'` 对产物无影响
- ⛔ **致命**：类名必须在 JS 里通过 `stylex.props()` 算出来，而 **WXML 调用不了 JS** ——
  要用就得把每个元素的 className 先在 `data` 里算好再绑，等于给每个视图加一层样板

结论：StyleX 的**卖点**（原子 CSS + 无运行时）UnoCSS 全都有，
而 StyleX 的**核心用法**（在 JS 里组合样式）恰好是小程序用不了的那个。

---

## 接入方式

```
apps/miniprogram/
├── uno.config.mjs        # 配置 + 纯函数：downgradeColorSyntax / assertWxssSafe
│                         #            makeEscapeMap / escapeWxml / collect*Classes
├── uno.config.test.mjs   # 23 个测试
├── build.mjs             # syncStaticAssets()：拷贝 → 生成 WXSS → 改写 WXML 类名 → 复查
└── src/app.wxss          # 只留全局基线 + 顶部 @import "./uno.wxss"
```

**为什么不用 UnoCSS CLI**（`unocss "pages/**/*.wxml" -o unocss.wxss`）：
直接用 Node API `createGenerator` 只有几行，却能省掉一次子进程 + glob + 对 cwd 的隐式依赖，
而且能自然接进 `build.mjs --watch`。

> **⚠️ 别被 preset 的 `platform` 选项误导**：它的类型是 `'taro' | 'uniapp'`、默认 `'uniapp'`，
> 看着像「用这个 preset 就得是 Taro/uni-app」。**不是。**
> 读源码（`unocss-preset-weapp/dist/index.mjs`）：
>
> ```js
> const wxPrefix     = ["page,root-portal-content,::before,::after"];  // ⭐ 原生小程序
> const taroPrefix   = ["*,::before,::after"];
> const uniappPrefix = ["uni-page-body,::before,::after"];
>
> if (options.isH5) preflightRoot = options.platform === "uniapp" ? uniappPrefix : taroPrefix;
> else              preflightRoot = wxPrefix;   // ⭐ 非 H5 → 一律走原生小程序分支
> ```
>
> `platform` **只在 `isH5: true` 时被查询**；我们 `isH5` 是默认的 `false`，
> 所以 preflight 根节点恒为 `page`（原生小程序根元素）——
> 即预处理器实际把我们编译到了**原生路径**，与 `platform` 的默认值无关。
> `root-portal-content` 是同组里多带的一个选择器，原生下匹配不到任何元素，无害。

**扫描范围是 `.wxml` + `.ts`**。只扫 wxml 会漏掉
`class="{{ok ? 'text-ok' : 'text-bad'}}"` 写进 `.ts` 的那种条件类名 —— 漏了是**静默失效**，没有任何报错。

---

## 设计 token 在哪里

**唯一位置：`apps/miniprogram/uno.config.mjs` 的 `theme`。**

⚠️ 这套配置**不会被自动发现** —— `build.mjs` 是显式调用 `createGenerator(unoConfig)` 的，
所以 UnoCSS 那套「按 cwd 找 `uno.config.ts` / `unocss.config.ts`」的机制在这里**不生效**：
在别处新建配置文件会被**静默忽略**（改了没反应，也不报错）。

theme 是三层合并的结果：

```
我们的 theme        apps/miniprogram/uno.config.mjs      ← 只写这里
      ↓ 合并
preset 的 theme     unocss-preset-weapp/dist/theme.mjs    ← rpx 刻度由它提供
      ↓ 合并
UnoCSS 默认 theme   @unocss/preset-mini                   ← 默认调色板
```

实测合并后生效 **46 个 color 键**（39 个默认调色板 + 我们加的 7 个）。
spacing / fontSize / borderRadius 已经由 preset rpx 化，**不需要重复定义**：
`p-4`→`32rpx`、`p-sm`→`28rpx`、`text-sm`→`28rpx`+`line-height:40rpx`、`rounded`→`8rpx`。

### 当前的语义 token

| token | 值 | 用途 |
|---|---|---|
| `brand` | `#4f46e5` | 品牌 / 主操作 |
| `ok` · `warn` · `bad` | `#16a34a` · `#f59e0b` · `#dc2626` | 读对/征服 · 未征服 · 读错 |
| `ink` | `#111` | 标题 / 强调 / 深色底 |
| `body` | `#333` | 正文 |
| `muted` | `#666` | 次要正文 |
| `faint` | `#999` | 标签 / 辅助说明 |
| `page` | `#f7f7f8` | 页面底色 |
| `line` | `#f0f0f0` | 分隔线 |

> 灰阶层是**收敛**出来的，不是重新设计：迁移时页面里散着 **7 级**灰度
> （`#111 #333 #444 #666 #8a8a8e #999 #aaa`），明显是随手加的。
> 合并了 `#444→body`、`#8a8a8e→faint`、`#aaa→faint`，色差都在 RGB 15~17（约 6~10%）以内。

### 要加东西分别写在哪

| 要做的事 | 写在哪 | 当前状态 |
|---|---|---|
| 设计 token（颜色 / 间距 / 字号 / 圆角） | `theme` | 见上表 |
| 现有工具类表达不了的新原子类 | `rules` | 空（**944 条全部来自 preset**） |
| 一串工具类打包成语义类 | `shortcuts` | 空 —— 故意不加，现在还没有稳定的组件词汇 |
| 全局基础样式 | `preflights` 或 `src/app.wxss` | `page {}` 留在 app.wxss（约定俗成的位置） |

⚠️ **不要手写工具类 WXSS**。中间地带（「这组属性我想复用」）的正确归属是 `shortcuts`，
不是 `.my-class { ... }`。

---

## ⚠️ 三个必须知道的坑

### 坑 1：变体分隔符必须是 `__`，不能是 `:`

WXSS 不支持转义选择器，所以 `hover:bg-red` 这个类名**在小程序里无法表达**。
配置里写死 `separators: '__'`，实际写法是：

```html
<view class="active__opacity-50 hover__bg-gray-100">
```

产出的是普通伪类选择器 `.active__opacity-50:active{...}` —— 这是 WXSS 支持的。

> ⚠️ 副作用：因为 `__` 被占用了，**不要再引入 BEM 风格的 `block__element` 语义类名**。
> 本项目现有的语义类名用的是单短横线（`.btn-primary`），不冲突。

### 坑 2：CSS Color 4 颜色语法会让颜色**静默消失**

UnoCSS 66 输出的是：

```css
.bg-brand_10 { background-color: rgb(79 70 229 / 0.1); }   /* 空格分隔 + 斜杠 alpha */
```

这是 CSS Color 4。小程序 iOS 端跑系统 WKWebView、Android 端跑 XWeb，
**版本旧的那个一旦不认识，是整条声明被丢弃** —— 表现是「颜色莫名其妙没了」，不报错。

因此产物必须过 `downgradeColorSyntax()` 转成 `rgba(79, 70, 229, 0.1)`。

### 坑 3：类名转义**只做了一半** —— 不改 WXML 就整套失效

> 这是接入时最难发现的坑：**生成得出来、构建不报错、开发者工具也不报错，就是不生效。**

WXSS 不支持 `\[` `\]` `\.` 这类转义选择器，所以 `unocss-preset-weapp` 会把 CSS 选择器改写成安全形式：

```css
.pb-\[60rpx\]   →   .pb-_lfl_60rpx_lfr_
.p-2\.5         →   .p-2_dl_5
```

但它**只改了 CSS 那一半**。源码那一半由 `unplugin-transform-class` 插件负责改写 ——
而我们是自己调 UnoCSS 的 Node API，**没有那个插件**。

于是 WXML 里写着 `class="pb-[60rpx]"`、WXSS 里却是 `.pb-_lfl_60rpx_lfr_` ——
**类名对不上，这一整类工具类全部静默失效**。

**解法**：生成 WXSS 后，用**同一张规则表**（`transformSelector`，直接来自 `unplugin-transform-class/utils`，
保证与预设同源同版本）把 dist 里 WXML 的类名改成一致形式。**src 始终保持自然写法**。

```html
<!-- src（人写的） -->
<view class="pb-[60rpx] p-2.5">
<!-- dist（构建产物） -->
<view class="pb-_lfl_60rpx_lfr_ p-2_dl_5">
```

⚠️ 两个细节，都不做就会把模板改坏或漏改：

| 细节 | 做法 |
|---|---|
| 替换粒度 | **只替换整 token**，绝不子串替换 |
| `{{ }}` 插值 | 必须**分两段**：表达式本身的 `.` `:` `(` `)` `?` 一个字都不能碰（碰了 `health.pending` 会变成 `health_dl_pending`，模板直接废）；但引号里的**条件类名必须一起改写**（`{{ok ? 'bg-[#111]' : 'bg-[#bbb]'}}`） |

---

## 三道构建期守卫

共同原则：**宁可构建失败，也不要留到真机上才发现**（和 `assertNoModernSyntax()` 同类）。

| 守卫 | 拦什么 | 为什么 |
|---|---|---|
| `assertWxssSafe()` | 残留 CSS Color 4 语法 / 反斜杠转义选择器 / `:not(#\#)` / `*` 通配 / 属性选择器 / `:hover` | 前三条会静默丢样式；**后三条是 Skyline 子集约束**（见 [skyline-evaluation.md](skyline-evaluation.md)） |
| `assertClassesResolve()` | WXML 里用了、但**任何 WXSS 都没定义**的类名 | 类名拼错一个字母 / 转义漏一处，表现都是**样式静默不生效** |
| `assertNoModernSyntax()` | 产物 JS 里的 ES2020+ 语法 | Worker 不走开发者工具转译，真机直接 `SyntaxError` |

> `assertClassesResolve()` 的比较对象是 **dist 里所有 .wxss**（含手写的 `app.wxss`），
> 所以它查的是「有没有死类」，**不是**强制你必须用工具类。
> 实测有效：故意写 `pb-typo-xxx` 时构建失败并指名文件。

---

## 已知取舍

1. **扫 `.ts` 会引入误报**：TS 里的普通标识符（如变量名 `ms`）会被当成 token 提取。
   本仓库实测引入 3 条无关规则（`.me` `.ms` `.b`，共约 60 字节）。
   判断：**代价可忽略，收益（不漏条件类名）更大**。
2. **`shadow-*` 输出 `px` 不是 `rpx`**：`shadow-md` → `0 4px 6px -1px`。
   旧版 preset 会 ×2 转成 rpx，v66 不转了。对阴影来说不随屏宽缩放其实更合理，**保留现状**。
3. **刻度**：间距 1 单位 = 8rpx = 4px 等效（`p-4` → `padding: 32rpx`），与现有手写 WXSS 同刻度。
   `w-*` / `h-*` 是 1:1 的 rpx（`w-128` → `128rpx`）。
4. **页面级 WXSS 已全部删除**。两个页面的 `.wxss` 合并进 WXML 上的工具类，`app.wxss` 只留 `page {}` 基线。
   原因：页面 WXSS 加载在 `app.wxss` 之后，**两个页面对同名类写不同定义时会互相"意外生效"** ——
   迁移前 `selftest.wxss` 就重新定义了 `.card` 和 `.btn-primary`，和首页长得完全不一样，而 `app.wxss` 里那份是死代码。

---

## 可复现

```bash
pnpm --filter @jushuo/miniprogram test    # 23 个测试
pnpm --filter @jushuo/miniprogram build   # 产出 dist/uno.wxss + 改写 dist/**/*.wxml 类名
```

测试覆盖：颜色降级 / `__` 变体 / 任意值转义 / 刻度 / 按需生成 / 颜色与 Skyline 安全检查 /
**类名转义链路（WXML 类名必须能在产物 CSS 里找到）** / 插值边界。

---

## 当前状态

- ✅ 已接入构建链路（含 `--watch` 下 wxml/wxss/json/ts 变更自动重同步）
- ✅ `app.wxss` 已 `@import "./uno.wxss"`，只保留 `page {}` 基线
- ✅ **两个页面已迁移**（index / selftest），页面级 wxss 已删除
- ✅ 三道构建期守卫生效；实测 `dist` 内 **104 个引用类名 / 108 个定义**全部对得上
- ✅ 迁移按 **Skyline 子集**写（不用 `:hover` / 属性选择器 / inline 布局 / 多层 shadow）
- ✅ 灰阶已**收敛成 4 级语义 token**（`ink` / `body` / `muted` / `faint`）+ `page` / `line`，
  页面里只剩 3 个一次性任意值（`bg-[#bbb]` 禁用态、`text-[#b08a3e]`/`bg-[#fdf8ee]` 提示条）
