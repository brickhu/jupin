# 图标方案选型

> **结论（2026-09 更新）**：用 **CSS mask 图标**——
> 图标数据取自 [Iconify](https://iconify.design)，构建期把每个图标压成一条
> `mask-image: url("data:image/svg+xml;base64,…")` + 一个 `1em × 1em` 的盒子
> （`background-color: currentColor` 被 mask 剪成图标）。
> 产物 `apps/miniprogram/src/icons.wxss`（自动生成，勿手改），生成器 `tools/iconfont/build.mjs`，
> 界面统一走 `<ui-icon name="clarity:favorite-solid" />`。
>
> ⚠️⚠️ **这条路与下面「当初否掉 preset-icons」的理由属于同一类 CSS（`mask` + `em`）** ——
> Skyline 兼容与 iOS 失效那两条代价**原样存在**，只是换来了「没有字体」这一大堆好处。
> 取舍见「代价（必须知道）」。

---

## 为什么从 icon font 换过来（2026-09，实测踩坑）

字体方案（`@font-face` + PUA 码位 + `::before`）跑了几个月，被三件事顶掉：

1. **画布不一致，而且不报错。**
   `svgicons2svgfont` 对**所有字形用同一个缩放系数**（`fontHeight ÷ 最高的字形`），
   于是 36 画布（Clarity）的字形比 24 画布（MDI）的大 **1.5 倍** ——
   界面上表现成「星能撑满容器，其它图标都缩小了」。
   修法是**手写死一个基础画布**（`BASE_GRID`）把两套坐标统一，属于人肉数字。
   而 mask 方案里这件事是 CSS 自己算的：`mask-size: contain` + 每个图标自己的 `viewBox`。
2. **字体缓存。**
   小程序 / 开发者工具**按 `font-family` 缓存字体**。改了字形内容但族名不变时，
   界面**永远不变**（代码、产物、构建全对）—— 最后靠「族名带上内容哈希」才绕过去，
   排查花了很久。而 wxss 里的 data URI 跟着 wxss 一起编译，不存在这个问题。
3. **三处手抄。** 类名、码位、白名单曾经分散在三处，各自漂过
   （白名单里写过从来没进过字体的 `heart`，又漏了在用的 `check`）。

顺带消掉的成本：字体方案要让 `nav-bar` / `user-sheet` / `eval-dialog` 这类 `isolated` 组件
**各自 `@import` 一份 base64 字体**（约 7 KiB × 3）。

## 为什么不是 Iconify 文档里那份 `d: path("…")`

Iconify 的 "SVG in CSS" 有两种形态：

- `d: path("…")` —— 那个 CSS 属性**只对真正的 SVG `<path>` 元素生效**；
  小程序 WXML 里造不出 `<path>`（没有 `svg` 标签），所以用不上。
- **`convertSVGToMask()`** —— 官方给「普通元素」准备的那条，**本项目用的就是它**。

## 自动化到什么程度

- 加图标 = 在 `tools/iconfont/build.mjs` 的 `ICONS` 里加一行 iconify 名，重跑脚本；
  **没有码位要分配、没有画布数字要写、没有白名单要同步**（`lib/icon-names.ts` 自动生成）。
- 「大小一致」由 CSS 保证：每个图标按自己的 `viewBox` 撑满同一个 `1em` 盒子。
- 尺寸跟着**字号**走（`1em`），所以调用方照旧写 `text-32rpx` 这类工具类；
  颜色跟着 `currentColor` 走。

---

## 代价（必须知道）

| 代价 | 说明 |
|---|---|
| ⛔ **挡住将来切 Skyline** | 本项目样式约定是「只用 WebView ∩ Skyline 的子集」（见 [skyline-evaluation.md](skyline-evaluation.md)）。`mask` 不在 Skyline 的属性表里，`em` 也标注不支持 ⇒ **真要切 Skyline 时这一层得重做**（当前跑 WebView，不受影响）。 |
| ⚠️ **iOS 有静默失效的社区案例** | 「`mask` 在网页和安卓正常、iOS 显示不出来」——图标一旦消失就是「按钮里空了一块」，不报错、不兜底。**建议在真机 iOS 上确认一次**（模拟器看不出来）。 |

两条备选（都是一句话切换，需要时再说）：

- **icon font**（上一版）：WebView 上稳、无 `mask`/`em`，但踩了上面三条坑；
- **`background-image` 内联 SVG**：没有 `mask`，但 `background-image` **吃不到 `currentColor`**，
  主题卡上跟不了前景色（这条当初就被否过）。

---

## 边界：哪些 emoji 留着

判据只有一条：**这个图标是回答「点这里做什么」(控件 / 导航)，还是回答「这是什么」(语义标记 / 插画)**。
前者做成图标（必须跟随文字颜色），后者直接用 emoji。

| 做成图标（控件 / 导航） | 直接用 emoji（语义标记 / 插画） |
|---|---|
| 播放 / 停止 / 分享 / 点赞 / 收藏（★） | ⚡ 能量 · ❄️ 解冻卡（"我手上有什么"） |
| 返回 / 回首页 / 卡片与列表的行尾箭头 | 📈 🔥 🏔️ 成长值三指标（徽章那一类的荣誉标记） |
| 用户面板菜单图标（参与 / 挑战 / 连战 / 主页 / 通知） | 🔥 连战页 · ⚡ 能量页 120rpx 大图 |
| 麦克风 / 已参与角标 / loading | 🎙️ 我的挑战 · 🎯 参与场次 空态 56rpx |

- 控件要跟随文字颜色（主题卡上尤其明显），彩色 emoji 会跟卡片底色打架 —— 这是把它们做成图标的原因。
- ⚠️ **语义 / 荣誉标记一律不换**：能量、解冻卡、成长值三指标回答的是「这是什么」，
  要彩色、要一眼认出来；做成单色图标会变死板。
- 空态大图是插画，换成单色图标是另一件事，不顺手做。

---

## 怎么改

```bash
# 加/换图标：编辑 tools/iconfont/build.mjs 的 ICONS（只写 iconify 名 + 一句"用在哪"），然后
node tools/iconfont/build.mjs      # → apps/miniprogram/src/icons.wxss + src/lib/icon-names.ts

# 界面里用（颜色 / 字号跟着宿主，排版类写在 <ui-icon> 上）：
#   <ui-icon name="mdi:play" class="text-32rpx text-ink ml-2" />
#   <ui-icon name="{{playing ? 'mdi:stop' : 'mdi:play'}}" class="text-40rpx" />
```

图标名取自 [Iconify](https://icon-sets.iconify.design/)（`mdi` / `clarity` 等集合）。
首次联网拉取后会缓存到 `tools/iconfont/icons.json`（**只补新增的**），之后离线可重建。
改完必须重跑脚本 —— devtools 读的是 `dist/`。

⚠️ 名字写错**不会报错**，只是那块空白；`<ui-icon>` 与 `ui-button` 都会在控制台点名
（名单来自自动生成的 `lib/icon-names.ts`）。

---

## 附：当初比较 preset-icons 的探针（历史证据）

`@unocss/preset-icons` 的产物与我们现在这套**是同一类**（`mask` + `1em`），
当初的对照表因此仍然有效：

| preset-icons 产物 | 项目约束 | 结论 |
|---|---|---|
| `width/height: 1em` | Skyline **不支持 `em`** | ⛔ 挡住将来切 Skyline |
| `-webkit-mask` / `mask` | Skyline 属性表里**没有 `mask`** | ⛔ 同上，且 iOS 上有已知失效案例 |
| `--un-icon`（CSS 变量） | 变量要求安卓 8.0.35 / iOS 8.0.38，**高于 Skyline 基线** | ⚠️ 多一个版本门槛（我们没用到变量 ✅） |
| `background-color: currentColor` | Skyline 的 `currentColor` 标注为 ❌ | ⚠️ 但主题卡本来就用 `currentColor`，属既有取舍 |
| data URI 内联 SVG | 避开「WXSS 不能引本地图片」 | ✅ 我们也是内联 |

复现（在 `apps/miniprogram/` 下建临时脚本）：

```js
import { readFile } from 'node:fs/promises'
import { createGenerator, presetIcons } from 'unocss'
import presetWeapp from 'unocss-preset-weapp'

const bodies = JSON.parse(await readFile('../../tools/iconfont/icons.json', 'utf8'))
const mdi = { prefix: 'mdi', width: 24, height: 24,
  icons: Object.fromEntries(Object.entries(bodies.icons).map(([n, body]) => [n, { body }])) }

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
| 每个图标一条 mask、base64 内联、图标名与类名一一对应（无撞名） | ✅ 本仓库实测（生成器 + 构建期类名校验） |
| 产物过 `assertWxssSafe` / `assertClassesResolve` / `lintWxSource` | ✅ 构建期 |
| 同一个字号下各图标光学尺寸一致 | ✅ 实测（mask 按各自 `viewBox` 撑满 1em） |
| iOS 真机上 `mask` 是否稳定 | ⚠️ **未复现**：社区有失效案例，建议真机确认一次 |
| Skyline 下的表现 | ⚠️ 已知不支持（`mask` / `em`），当前跑 WebView 不受影响 |
