# Skyline 渲染引擎评估

> **结论**：**现在不全量切，但所有样式按 Skyline 的子集写。**
> Skyline 支持的 WXSS 是 WebView 的**真子集**，按子集写不影响 WebView 表现，
> 却能让将来切换变成「配置级改动」而不是重写。

**来源**：微信官方文档（`framework/runtime/skyline/*`）。核实状态逐条标注。

---

## 它是什么

Skyline 是 WebView 之外的另一套渲染引擎。架构差异：

| | WebView | **Skyline** |
|---|---|---|
| 渲染线程 | JS 逻辑、建树、CSS 解析、Layout、Paint **同一条线程** | 独立渲染线程负责 Layout/Composite/Paint |
| 组件框架 | 老版 | **glass-easel（单线程版）** |
| setData | 有通信开销 + 序列化开销 | ⭐ **无通信/序列化开销** |
| WXSS | 运行时解析文本 | ⭐ **构建时预编译成二进制**（快 5 倍+） |
| 样式更新 | 全量计算 | 局部更新，避免多次遍历 DOM |
| 建树 | — | 优化 30–40%（组件下沉，view/text/image 变原生节点） |
| 内存 | 一页一个 WebView 实例 | 多页共享一个渲染引擎实例 |
| 页面栈 | 最多 10 层 | 无限制 |

> ⚠️ 原文措辞：Skyline「以性能为首要目标，因此 **CSS 特性上在满足基本需求的前提下进行了大幅精简**」。
> 这句话是理解后面所有限制的前提。

---

## 支持版本与开启条件

### 版本（来源：官方「环境准备」）

| 平台 | 版本 |
|---|---|
| 微信安卓 | **8.0.33+**（基础库 2.30.4+） |
| 微信 iOS | **8.0.34+**（基础库 2.31.1+） |
| 开发者工具 | Stable 1.06.2307260+（建议 Nightly） |
| **Windows / Mac PC 端** | ⚠️ **未支持**（规划中）→ 自动 fallback 到 WebView |

### ⚠️⚠️ 最容易踩的坑：不开 AB 实验，正式用户根本不会走 Skyline

官方原文：Skyline 默认接入 **We 分析 AB 实验**，**未配置的情况下页面渲染仍为 WebView**。

也就是说：**代码写对了、开发者工具里跑通了，线上用户看到的还是 WebView。**
要么去 We 分析配置 AB 实验（注意：**开发者自己也会受实验影响**），要么关掉 AB 实验默认启用。
本地调试可以用「小程序菜单 → 开发调试 → Switch Render」强切（仅开发版/体验版，重启微信后恢复 Auto）。

### 迁移要改的配置（一处都不能少）

```jsonc
// app.json
{
  "lazyCodeLoading": "requiredComponents",          // 按需注入
  "renderer": "skyline",
  "componentFramework": "glass-easel",
  "rendererOptions": {
    "skyline": {
      "defaultDisplayBlock": true,                  // ⭐ 对齐 WebView 的默认 block 布局
      "defaultContentBox": true                     // ⭐ 对齐 WebView 的 content-box（基础库 3.1.0+）
    }
  }
}

// page.json（每个页面）
{
  "disableScroll": true,        // ⚠️ Skyline 不支持页面全局滚动 → 必须用 scroll-view
  "navigationStyle": "custom"   // ⚠️ Skyline 不支持原生导航栏 → 必须自己实现
}
```

> `defaultDisplayBlock` / `defaultContentBox` 强烈建议开：Skyline 默认是
> `display: flex` + `border-box` + `flex-direction: column`，
> **和 WebView 默认值全都不一样**。开了这两个，两个引擎的表现才接近，
> 「一份样式跑两端」才成立。

**页面粒度可选**：`renderer` 可以只在 `page.json` 配，Skyline 页和 WebView 页可以互相跳转。
**自动回退**：不使用 Skyline 独有特性时，低版本/PC 端会无缝退回 WebView。

---

## WXSS 子集差异（**对 UnoCSS 产物最要命的一节**）

### 选择器

| 选择器 | Skyline | 备注 |
|---|---|---|
| 通配 `* {}` | ❌ | |
| 元素 `tag {}` | ✅ | ⚠️ 遵循样式隔离（WebView 不遵循），可用 `tagNameStyleIsolation: legacy` 对齐 |
| 类 `.class {}` | ✅ | |
| ID、分组、`>`、` `、`~`、`+` | ✅ | |
| **属性 `[attr] {}`** | ❌ | ⚠️ 现有 `app.wxss` 里的 `.btn-primary[disabled]` 会失效 |
| 伪类 `:active` | ✅ | |
| 伪类 `:first-child` / `:last-child` | ✅ | |
| 伪类 `:not` / `:only-child` / `:empty` | ✅ | Skyline 1.3.0+ |
| 伪类 `:nth-child` | ✅ | Skyline 1.3.3+ |
| **伪类 `:hover`** | ⚠️ **未列入官方支持列表** | 触屏上也基本无意义 |
| 伪元素 | ✅ 仅 `::before` / `::after` | |

### 属性 / 单位

| 项 | Skyline | 影响 |
|---|---|---|
| `display` | 只 `none` / `flex` / `block`（默认 **flex**） | ⚠️ **不支持 inline / inline-block 布局**（开发中） |
| 默认 `flex-direction` | **column** | ⚠️ WebView 是 row |
| 默认 `box-sizing` | **border-box** | ⚠️ WebView 是 content-box |
| `position` | relative / absolute / fixed | **不支持 sticky**（用 sticky-header 组件替代） |
| `overflow` | hidden / visible | ⚠️ **scroll 不支持**，只能 scroll-view |
| `gap` | ✅ | |
| **CSS 变量** | ✅ | 安卓 8.0.35 / iOS 8.0.38（**高于 Skyline 本身的 8.0.33/8.0.34**） |
| `rpx` | ✅ | 样式计算阶段原生支持 |
| `px` / `rem` / `vw` / `vh` / `calc()` | ✅ | |
| **`em`** | ❌ | |
| **`currentColor`** | ❌ | 考虑支持中 |
| `box-shadow` | ⚠️ **不支持多个叠加** | |
| `filter` / `backdrop-filter` | ⚠️ 不支持 multi function、不支持 drop-shadow | |
| `text-overflow: ellipsis` | ✅ 但**仅作用于 text 节点** | 需配 `white-space: nowrap` + `overflow: hidden`；多行用 `<text max-lines>` |
| `z-index` | ⚠️ **不支持层叠上下文，只对兄弟节点生效** | |
| SVG 里的 `rgba` | ❌ | 用 `fill-opacity` 替代 |
| `font-size` | 不支持百分比、不支持 keyword | |
| `animation-fill-mode: none / backwards` | ❌ 表现均为 forwards | |

### 组件差异（节选）

| 组件 | 情况 |
|---|---|
| `scroll-view` | ⚠️ **需显式 `type="list"`**；直接子节点按需渲染（离屏不渲染，`boundingClientRect` 拿不到尺寸） |
| `text` | 内联文本**只能**用 text；混排要用新增的 `span` 组件 |
| `navigation-bar` | ❌ **不支持**，Skyline 只能用自定义导航 |
| `movable-view` | ❌ 不做，用手势 + worklet 替代 |
| `web-view` | ❌ 不做，建议该页面单独配 `renderer: webview` |
| `rich-text` | 渲染结果可能不同 |
| 组件 `animate` 接口 | ❌ 不支持，改用 **worklet 动画** |
| 新增 | `span` / `snapshot`（子树截图）/ `sticky-header` / `list-view` / `grid-view`（瀑布流） |

### 开发体验的退化

- **开发者工具「真机调试」暂未支持**（扫码预览不受影响 —— 推断，官方只说「真机调试」）
- **热重载暂未支持**（需关掉热重载重新编译）
- 开发者工具下 map / canvas / video / camera 无法调试，需真机预览
- 扩展屏调试可能异常

---

## ⭐ 对我们项目的具体影响

### 1. 对刚落地的 UnoCSS 产物做一次逐条审计

| 我们生成的 | Skyline | 处置 |
|---|---|---|
| `page,root-portal-content,::before,::after{--un-*}` | ⚠️ | `page` ✅、`::before/::after` ✅、CSS 变量 ✅（但**要求安卓 8.0.35 / iOS 8.0.38**，比 Skyline 本身门槛更高）。`root-portal-content` 是 Skyline 的 `root-portal` 组件，反而正好对上 |
| `.flex` `.p-4` 等类选择器 | ✅ | |
| `.active__opacity-50:active` | ✅ | `:active` 在支持列表内 |
| **`.hover__bg-gray-100:hover`** | ⚠️ | `:hover` **不在官方支持列表**。项目里应避免使用 `hover__` 变体 |
| `rgb(r, g, b)` 传统写法 | ✅ | 已由 `downgradeColorSyntax()` 降级；Skyline 的 `rgb[a]` 支持明确列出 |
| **`.shadow-md`（两层 shadow）** | ❌ | **Skyline 不支持多 shadow 叠加**，只认一层 |
| `rpx` / `gap` / `calc()` | ✅ | |
| 任意值转义 `_lfl_` / `_dl_` | ✅ | 类选择器，不受选择器语法限制 |

**因此 `assertWxssSafe()` 应再补两条**（现在只查了颜色语法 / 反斜杠转义 / `:not(#\#)`）：
1. 出现 `*` 通配选择器 → 失败
2. 出现属性选择器 `[…]` 或 `:hover` → 失败

这样产物天然落在两个引擎的交集里。

### 2. 产品层面的取舍

**Skyline 的强项恰好命中我们的核心场景**：朗读时的**逐词上色**是高频率 setData，而 glass-easel 单线程版**取消了 setData 的通信与序列化开销**；揭晓页的动画则受益于 worklet 在渲染线程同步执行。这正是我们之前实测 iOS 端 JS 慢 13 倍后最担心的一环。

**但成本也不小**：

| 成本 | 说明 |
|---|---|
| 自定义导航栏 | 每个页面都要自己做，且要处理胶囊避让 |
| 滚动全部改 `scroll-view` | 且要 `type="list"`；离屏节点不渲染会影响 `boundingClientRect` |
| 线上生效依赖 AB 实验 | 不配就一直走 WebView —— 容易白干 |
| PC 端不支持 | 自动 fallback，可接受 |
| 真机调试不支持 | ⚠️ 对本项目**特别痛**：`docs/experiments/device-selftest-runbook.md` 整套音频验证依赖真机 |

### 3. 建议

1. **现在切全量 = 不划算**。前端真实界面还没做出来，此时付出「自定义导航 + 滚动重写」的成本，是在为一个还没定型的 UI 买单。
2. **但样式一律按 Skyline 子集写**。它是 WebView 的子集，按子集写零代价，却让将来切换变成配置级改动。具体：
   - 开 `defaultDisplayBlock` + `defaultContentBox` 对齐 WebView 默认值
   - 不用 `:hover`、不用属性选择器、不用 `em`、不用多层 `box-shadow`、不用 `sticky`
   - 布局不依赖 inline / inline-block
3. **等朗读页做出来再决策**。那时才有真实的高频上色场景可以对比 —— 在 WebView 下测一次帧率与掉帧，再决定要不要为这一页单独开 Skyline（**支持页面粒度**，不必全量）。
4. **决策前先确认 AB 实验**。否则测出来的「Skyline 表现」可能其实是 WebView 的。

---

## 待核实

- `:hover` 是否真的不支持 —— 官方未列入支持列表，但也没有明确写「不支持」（**推断**）
- 开发者工具「真机调试暂未支持」是否影响**扫码预览**（推断不影响，需实测）
- CSS Color 4 的 `rgb(r g b / a)` 在 Skyline 下是否支持 —— 表格只写 `rgb[a]`，**未明确语法版本**
- Windows / Mac 端 fallback 的实际表现
