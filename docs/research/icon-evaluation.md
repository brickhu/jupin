# 图标方案选型

> **结论**：用 **icon font**（Iconify/MDI 子集 → base64 TTF + PUA 码位 + `:before`），
> **不用** `@unocss/preset-icons`。
> 产物 `apps/miniprogram/src/iconfont.wxss`（自动生成，勿手改），生成器 `tools/iconfont/build.mjs`。

---

## 一句话理由

`@unocss/preset-icons` 生成的是 **`mask` + `1em` + CSS 自定义属性**；
而本项目的样式约定是「一律写成 WebView ∩ Skyline 的子集」（见 [skyline-evaluation.md](skyline-evaluation.md)），
其中 **`em` 明确不支持、`mask` 根本不在支持列表里**。
icon font 只用到 `@font-face` + `:before` + 继承的 `color`/`font-size`，全部落在子集内。

---

## 实证：preset-icons 到底生成了什么

用本仓库自己的 weapp preset + 同一批 MDI 图标跑了一遍（脚本见下方「复现」），
`i-mdi-chevron-right`（`mode: auto` 会自动选 `mask`）的产物是：

```css
.i-mdi-chevron-right {
  --un-icon: url("data:image/svg+xml,...");
  -webkit-mask: var(--un-icon) no-repeat;
  mask: var(--un-icon) no-repeat;
  -webkit-mask-size: 100% 100%;
  mask-size: 100% 100%;
  background-color: currentColor;
  color: inherit;
  width: 1em;
  height: 1em;
}
```

`mode: bg` 则是 `background: url(...) no-repeat; width: 1em; height: 1em` —— 同样带 `em`，
而且 `background-image` **吃不到 `currentColor`**，无法跟随每篇文章的主题色。

逐条对照本项目的约束：

| preset-icons 产物 | 项目约束 | 结论 |
|---|---|---|
| `width/height: 1em` | Skyline **不支持 `em`** | ⛔ 挡住将来切 Skyline |
| `-webkit-mask` / `mask` | Skyline 属性表里**没有 `mask`** | ⛔ 同上，且 iOS 上有已知失效案例 |
| `--un-icon`（CSS 变量） | 变量要求安卓 8.0.35 / iOS 8.0.38，**高于 Skyline 基线** | ⚠️ 多一个版本门槛 |
| `background-color: currentColor` | Skyline 的 `currentColor` 标注为 ❌ | ⚠️ 但主题卡本来就用 `currentColor`，属既有取舍 |
| data URI 内联 SVG | 避开「WXSS 不能引本地图片」 | ✅ 这条比手写 `mask` 好 |

`assertWxssSafe()` 对它**是通过的**（它输出的不是 CSS Color 4、也不含转义选择器）——
也就是说，这道守卫拦不住它，必须靠人判断。

### iOS 的 mask 风险不是假想

微信开放社区 / uni-app 社区都有「`mask` 在网页和安卓正常、iOS 显示不出来」的记录。
图标一旦在 iOS 上静默消失，表现是「按钮里空了一块」，不报错、不兜底。

---

## icon font 的取舍

用到的 CSS 只有：`@font-face`（base64 TTF）、`.iconfont` 的 `font-family`、
以及每个字形的 `::before { content: '\e0xx' }`。颜色和字号**全部继承宿主元素**
（`color` 是普通继承，不依赖 `currentColor` 关键字；字号是 `rpx`），
所以在主题卡里天然跟着 `theme.foreground` 走，和 `currentColor + 透明度` 那套分层是同一套。

- 字形来自 **Iconify 的 MDI 集合**，24×24 网格，**不做 normalize** ——
  每个字形保留 MDI 原本的相对比例（chevron 天生小、home 占满格）。
  代价是「字号 ≠ 视觉高度」，各处字号要按 `ICONS` 里的注释反推，不是随手写的。
- 码位放在 **PUA（U+E001…）**，不与任何正常字符冲突。
- 当前 12 个字形：ttf **3.0 KiB** → wxss（base64）**5.5 KiB**。

### ⚠️ 隔离组件必须自己引一份

`nav-bar` / `user-sheet` 是 `isolated`（有意不依赖 app.wxss），
`.iconfont` 进不去，所以这两份 wxss 各自 `@import "../../iconfont.wxss"`。
代价是 base64 在包里被内联 **3 次**（app / nav-bar / user-sheet，合计约 17 KiB）。
这一步是**故意**的：为一个图标把导航栏的隔离拆掉，不划算。

### ⚠️ 字形都用在「独占一个元素」的位置

剩下 12 个字形一律是独立元素（`<text class="iconfont icon-x"></text>`），
没有一个是嵌在句子中间的行内图标 —— 需要行内的地方（能量、解冻卡、成长值）都回到了 emoji，
所以不存在「行内图标和文字基线对不齐」这类问题。

---

## 边界：哪些 emoji 留着

判据只有一条：**这个字形是回答「点这里做什么」(控件 / 导航)，还是回答「这是什么」(语义标记 / 插画)**。
前者换成图标字体（必须跟随文字颜色），后者直接用 emoji。

| 换成图标字体（控件 / 导航） | 直接用 emoji（语义标记 / 插画） |
|---|---|
| 播放 / 暂停 / 停止 / 分享 / 点赞 | ⚡ 能量 · ❄️ 解冻卡（"我手上有什么"） |
| 返回 / 回首页 / 卡片与列表的行尾箭头 / 日历翻月 | 📈 🔥 🏔️ 成长值三指标（徽章那一类的荣誉标记） |
| 用户面板菜单图标（参与 / 挑战 / 连战 / 主页 / 通知） | 🔥 连战页 · ⚡ 能量页 120rpx 大图 |
| | 🎙️ 我的挑战 · 🎯 参与场次 空态 56rpx |

- 控件要跟随文字颜色（主题卡上尤其明显），彩色 emoji 会跟卡片底色打架 —— 这是换掉它们的原因。
- ⚠️ **语义 / 荣誉标记一律不换**：能量、解冻卡、成长值三指标回答的是「这是什么」，
  要彩色、要一眼认出来；做成单色字形会变死板。
  `pages/profile` 的成长值、`pages/me/energy` 的能量大图本来就用 emoji，跟着它们对齐。
- 空态大图是插画，换成单色字形是另一件事，不顺手做。

---

## 怎么改

```bash
# 加图标：编辑 tools/iconfont/build.mjs 的 ICONS（md 图标名 / cp 码位 / cls 类名），然后
node tools/iconfont/build.mjs      # → apps/miniprogram/src/iconfont.wxss

# 界面里用（颜色/字号跟着宿主）：
#   <text class="iconfont icon-play"></text>
#   <text class="iconfont {{playing ? 'icon-pause' : 'icon-play'}}"></text>
```

图标名取自 [Iconify](https://icon-sets.iconify.design/mdi/)。首次联网拉取后会缓存到
`tools/iconfont/icons.json`（**只补新增的**），之后离线可重建。
改完图标必须重新 `node build.mjs` —— 和改其它 WXSS 一样，devtools 读的是 `dist/`。

---

## 复现（本次比较用的探针）

在 `apps/miniprogram/` 下建一个临时脚本，用本仓库 preset 生成 preset-icons 产物：

```js
import { readFile } from 'node:fs/promises'
import { createGenerator, presetIcons } from 'unocss'
import presetWeapp from 'unocss-preset-weapp'

const bodies = JSON.parse(await readFile('../../tools/iconfont/icons.json', 'utf8'))
const mdi = { prefix: 'mdi', width: 24, height: 24,
  icons: Object.fromEntries(Object.entries(bodies).map(([n, body]) => [n, { body }])) }

const uno = await createGenerator({
  presets: [presetWeapp(), presetIcons({ mode: 'auto', collections: { mdi: () => mdi } })],
  separators: '__',
})
console.log((await uno.generate('i-mdi-play i-mdi-home', { preflights: false })).css)
```

> ⚠️ `collections` 的值必须是**加载器函数**（`() => IconifyJSON`）；
> 直接传 IconifyJSON 会被当成 `InlineCollection`，匹配不到任何图标、**静默返回空 CSS**。

---

## 验证状态

| 结论 | 状态 |
|---|---|
| ttf 的 cmap 含全部 12 个 PUA 码位、字形名唯一 | ✅ 本仓库实测（解析 ttf 的 cmap 表） |
| 字形能真实渲染、比例与 MDI 一致 | ✅ 本仓库实测（PIL 渲染成 PNG 逐字看） |
| 产物过 `assertWxssSafe` / `assertClassesResolve` / `lintWxSource` | ✅ 构建期 |
| WeChat 真机加载 base64 `@font-face` | ⚠️ **未在真机复现**（官方支持 base64；需在真机自检里确认） |
| Skyline 下 `@font-face` 的表现 | ⚠️ 未核实（Skyline 文档没列这一项）。当前跑 WebView，不受影响 |
