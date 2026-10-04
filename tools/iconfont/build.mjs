/**
 * 从 Iconify（https://iconify.design）生成小程序的**纯 CSS 图标**。
 *
 *   输入：下面的 ICONS（**只有 iconify 名**，外加一句"用在哪"的备注）
 *   产物：apps/miniprogram/src/icons.wxss        —— 每个图标一条 `mask-image: url(data:image/svg+xml;base64,…)`
 *         apps/miniprogram/src/lib/icon-names.ts —— 图标名单 + iconify 名 → 类名（自动生成，别手抄）
 *         （以及本目录下 svg/ 里一份给人看的预览）
 *
 * ⭐ 为什么是 CSS mask 而不是 icon font（2026-09 换的，详见文件末尾「字体方案为什么被换掉」）：
 *    · **没有字体** ⇒ 没有子集、没有码位、没有 @font-face；
 *    · **没有画布归一化问题**：mask 用 `mask-size: contain`，每个图标**按自己的 viewBox**
 *      撑满 1em 的盒子 —— 不需要（也不可能）手写任何"画布 24 / 36"的数字；
 *    · **颜色照旧吃 currentColor**（`background-color: currentColor` 被 mask 剪成图标）；
 *    · **没有字体缓存**：字体按 family 名缓存（改了内容不改名 ⇒ 界面永远不变，踩过），
 *      而这里是 wxss 里的 data URI，跟着 wxss 一起编译，不存在这个问题。
 *
 * ⚠️ 为什么不用 Iconify 文档里那份 `d: path("…")` 的纯 CSS 写法：
 *    那个 CSS 属性只对**真正的 SVG `<path>` 元素**生效，而小程序 WXML 里造不出 `<path>`
 *    （没有 svg 标签）。Iconify 官方给"普通元素"准备的正是 `convertSVGToMask()` 那条路 —— 本文件是它的等价物。
 *
 * ⚠️ 运行时会联网（只补缺的图标）—— 拉到的 body 与**集合画布**都写进 icons.json 缓存
 *    （该文件入库，所以第二次起离线可跑）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '../..')
const CACHE = resolve(HERE, 'icons.json')
const SVG_OUT = resolve(HERE, 'svg')
const WXSS_OUT = resolve(ROOT, 'apps/miniprogram/src/icons.wxss')
const NAMES_OUT = resolve(ROOT, 'apps/miniprogram/src/lib/icon-names.ts')

/** ⚠️ 基础类名。组件（components/ui-icon）就挂这个 —— 改名要同步改那边 */
const BASE_CLASS = 'ui-icon'

/**
 * ⭐ **图标清单（唯一的一份名单）**。
 *   name —— iconify 名（`<集合>:<图标>`）；类名就是冒号后面那一段（`.ui-icon-<图标名>`）
 *   use  —— 用在哪，改图标时一眼知道影响面（会写进生成的 wxss 注释）
 *
 * ⚠️ 要加图标就往这里加一行，然后重跑本脚本；**别的文件都不用动**。
 * ⚠️ 两个集合里**同名的图标**会撞类名 —— 撞了脚本会报错，那时再显式起个别名。
 */
const ICONS = [
  { name: 'mdi:play', use: '卡片/结果页 播放' },
  { name: 'mdi:loading', use: '音频按钮 loading（旋转的弧）' },
  { name: 'mdi:stop', use: '金句卡 停止' },
  { name: 'mdi:chevron-right', use: '卡片/排名行 进入' },
  { name: 'mdi:chevron-left', use: '导航栏 返回' },
  { name: 'mdi:share-variant', use: '结果页 分享' },
  { name: 'mdi:heart-outline', use: '结果页 点赞' },
  { name: 'mdi:home', use: '导航栏 / 用户面板 我的主页' },
  { name: 'mdi:target', use: '用户面板 参与场次' },
  { name: 'mdi:clipboard-text-outline', use: '用户面板 我的挑战' },
  { name: 'mdi:fire', use: '用户面板菜单 连战记录' },
  { name: 'mdi:bell-outline', use: '用户面板 通知' },
  { name: 'mdi:microphone', use: '朗读页 s1 · 点击录音并朗读（设计稿口径）' },
  { name: 'mdi:check', use: '金句卡 已参与角标（右下角圆形勾）' },
  { name: 'mdi:magnify', use: '标签页 搜索框左侧的放大镜' },
  { name: 'mdi:close', use: '标签页 清空搜索' },
  { name: 'mdi:tag-outline', use: '首页「看全部标签」入口' },
  // ⭐ 收藏按钮的两个状态（用户 2026-09 指定）：空心 = 未收藏、实心 = 已收藏。
  //    ⚠️⚠️ 这是 Clarity 的 **favorite-***，它画的是**五角星（★）**，不是心 ——
  //      Clarity 里 `heart-line` / `heart-solid` 才是心形（另一套图形）。用户要的就是这颗星。
  { name: 'clarity:favorite-line', use: '竞技场 收藏（未收藏）' },
  { name: 'clarity:favorite-solid', use: '竞技场 收藏（已收藏）' },
  // ⚠️ 只把「控件 / 导航」做成图标。**表达性 / 语义标记一律用 emoji**，故意不放进这张表：
  //    · 📈 🔥 🏔️  成长值三指标（徽章那一类的荣誉标记，与 pages/profile 的做法一致）
  //    · ⚡ ❄️      能量 / 解冻卡（「我手上有什么」的语义标记，不是控件）
  //    · 🔥 ⚡ 🎙️ 🎯 连战页 / 能量页大图、两个空态插画
]

const setOf = (name) => name.split(':')[0]
const mdOf = (name) => name.split(':').slice(1).join(':')
/** 类名 = 图标名（去掉集合前缀）。`.ui-icon-<cls>` */
const clsOf = (name) => mdOf(name)

/**
 * 撞类名就报错：两个集合里同名的图标会生成同一个 `.ui-icon-x`，
 * 而 CSS 里后写的赢 —— 表现是"某个图标悄悄变成另一个"，只能靠肉眼发现。
 */
function assertNoClash() {
  const seen = new Map()
  for (const icon of ICONS) {
    const cls = clsOf(icon.name)
    if (seen.has(cls)) {
      throw new Error(
        `图标名撞了：${icon.name} 与 ${seen.get(cls)} 都叫 ${cls} —— ` +
          '类名是"图标名"，所以两个集合里同名会撞。换一个图标，或给它起个别名。',
      )
    }
    seen.set(cls, icon.name)
  }
}

/** 缓存形如 { grids: { mdi: 24 }, icons: { 'mdi/play': '<path …/>' } } */
function readCache() {
  if (!existsSync(CACHE)) return { grids: {}, icons: {} }
  const raw = JSON.parse(readFileSync(CACHE, 'utf8'))
  if (raw && typeof raw === 'object' && raw.icons) {
    return { grids: raw.grids ?? {}, icons: raw.icons }
  }
  /**
   * ⚠️ 老格式是**扁平的**（键 = 裸图标名，那时只有 MDI 一个集合）——
   *    就地迁到新键 `mdi/<名字>`，别让一整份缓存作废（否则要重新联网拉一遍）。
   */
  const icons = {}
  for (const [k, v] of Object.entries(raw ?? {})) icons[k.includes('/') ? k : `mdi/${k}`] = v
  return { grids: {}, icons }
}

/** 补缺：**按集合**分组请求（一次只能问一个集合），并把该集合的画布记下来（拼 SVG 的 viewBox 要用） */
async function loadIconData() {
  const cache = readCache()
  const sets = [...new Set(ICONS.map((i) => setOf(i.name)))]

  let changed = false
  for (const set of sets) {
    const wanted = ICONS.filter((i) => setOf(i.name) === set).map((i) => mdOf(i.name))
    const missing = wanted.filter((md) => !cache.icons[`${set}/${md}`])
    const needGrid = !cache.grids[set]
    if (missing.length === 0 && !needGrid) continue

    const query = missing.length > 0 ? missing : [wanted[0]]
    const url = `https://api.iconify.design/${set}.json?icons=${query.join(',')}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Iconify 请求失败：${res.status} ${url}`)
    const json = await res.json()

    const reported = Number(json.width ?? 0)
    if (reported > 0) {
      if (cache.grids[set] && cache.grids[set] !== reported) {
        throw new Error(
          `图标集 ${set} 的画布从 ${cache.grids[set]} 变成了 ${reported} —— 先确认这是 Iconify 的真改动再清掉缓存重跑。`,
        )
      }
      cache.grids[set] = reported
      changed = true
    }

    for (const md of missing) {
      const body = json.icons?.[md]?.body
      if (!body) throw new Error(`Iconify 的 ${set} 集合里没有这个图标：` + md)
      cache.icons[`${set}/${md}`] = body
      changed = true
    }
  }

  if (changed) writeFileSync(CACHE, JSON.stringify(cache, null, 2) + '\n')
  for (const set of sets) {
    if (!cache.grids[set]) throw new Error(`拿不到图标集 ${set} 的画布（Iconify 没报 width）`)
  }
  return cache
}

/**
 * 一个图标的独立 SVG（mask 的源）。
 *
 * ⚠️ mask 只看**不透明度**，所以 fill 写死纯黑最省事也最确定
 *    （Iconify 的 body 里是 `fill="currentColor"`；在 mask 里它解析成黑也没问题，
 *     但写死能免掉"这段 SVG 被当图片用时是什么颜色"的心智负担）。
 * ⚠️ viewBox 用**该集合自己的画布**：`mask-size: contain` 会把它撑满 1em 的盒子，
 *    于是每个图标按各自设计时的留白比例显示 —— 这就是"自动归一化"，不需要手写任何数字。
 */
function svgOf(body, grid) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${grid}" height="${grid}" viewBox="0 0 ${grid} ${grid}">` +
    body.replace(/currentColor/g, '#000') +
    '</svg>'
  )
}

/** base64 而不是百分号编码：wxss 里不用操心引号 / 括号 / `#` 的转义 */
const dataUri = (svg) => 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')

function renderWxss(cache, glyphs) {
  const sets = [...new Set(glyphs.map((g) => setOf(g.name)))].join(' / ')
  const out = []
  out.push('/* ⚠️ 自动生成，请勿手改 —— 重新生成：node tools/iconfont/build.mjs */')
  out.push(`/* 图标来自 Iconify（https://iconify.design）的 ${sets} 集合，每个图标一条 CSS mask。 */`)
  out.push('')
  out.push('/*')
  out.push(' * 基础：1em × 1em 的盒子，用 mask 剪出图标，颜色吃 currentColor。')
  out.push(' * ⚠️ 尺寸跟着**字号**走（1em）—— 调用方照旧写 text-32rpx 这类工具类即可，不用管宽高。')
  out.push(' * ⚠️ mask-size: contain ⇒ 每个图标按自己的 viewBox 撑满盒子：不会一大一小，也不会被裁。')
  out.push(' */')
  out.push(`.${BASE_CLASS} {`)
  out.push('  display: inline-block;')
  out.push('  width: 1em;')
  out.push('  height: 1em;')
  out.push('  vertical-align: -0.125em;')
  out.push('  background-color: currentColor;')
  out.push('  -webkit-mask-repeat: no-repeat;')
  out.push('  -webkit-mask-position: center;')
  out.push('  -webkit-mask-size: contain;')
  out.push('  mask-repeat: no-repeat;')
  out.push('  mask-position: center;')
  out.push('  mask-size: contain;')
  out.push('}')
  out.push('')
  for (const g of glyphs) {
    const uri = dataUri(svgOf(cache.icons[`${setOf(g.name)}/${mdOf(g.name)}`], cache.grids[setOf(g.name)]))
    out.push(`/* ${g.use}（${g.name}） */`)
    out.push(`.${BASE_CLASS}-${g.cls} {`)
    out.push(`  -webkit-mask-image: url("${uri}");`)
    out.push(`  mask-image: url("${uri}");`)
    out.push('}')
  }
  out.push('')
  return out.join('\n')
}

/**
 * ⭐ 生成那份**唯一**的名单文件：图标名 + iconify 名 → 类名。
 * ⚠️ 它存在的意义是"别人不用手抄"：`ui-button` 的校验、`<ui-icon>` 组件的校验都读它。
 */
function renderNames(glyphs) {
  const rows = glyphs.map((g) => `  '${g.name}', // ${g.use}`).join('\n')
  return `/* ⚠️ 自动生成，请勿手改 —— 重新生成：node tools/iconfont/build.mjs */
/* 名单的源头是 tools/iconfont/build.mjs 的 ICONS：那边加一行，这里就有。 */

/**
 * ⭐ **图标名单里真实存在的 iconify 名**。
 *
 * ⚠️⚠️ 这是全项目**唯一**的图标名单：校验、组件都读它，
 *    不许在别处手抄一份 —— 手抄的那份漂过（写过从来没进过名单的 \`heart\`、漏过 \`check\`）。
 * ⚠️ 名字必须带集合前缀（\`mdi:play\` / \`clarity:favorite-solid\`）：
 *    不同集合的 id 空间独立，只写后半段会含糊。
 */
export const ICON_NAMES = [
${rows}
] as const

export type IconName = (typeof ICON_NAMES)[number]

const ICON_NAME_SET: ReadonlySet<string> = new Set<string>(ICON_NAMES)

/** 这个名字在名单里吗？（不在的话画不出来 —— 只有一块空白，控制台会提醒） */
export function isIconName(name: string): boolean {
  return ICON_NAME_SET.has(String(name ?? '').trim())
}

/**
 * iconify 名 → CSS 类名：\`clarity:favorite-solid\` → \`${BASE_CLASS}-favorite-solid\`。
 * ⚠️ 类名就是"冒号后面那一段"（由生成器保证唯一，撞了会在构建时直接报错）。
 */
export function iconClassOf(name: string): string {
  const md = String(name ?? '').trim().split(':').pop() ?? ''
  return md ? '${BASE_CLASS}-' + md : ''
}
`
}

// ── 开跑 ──────────────────────────────────────────────────────────

assertNoClash()
const cache = await loadIconData()

const glyphs = ICONS.map((icon) => ({ ...icon, cls: clsOf(icon.name) }))

// 每次全量重写：ICONS 删掉某个图标时旧的 .svg 不该留在目录里
rmSync(SVG_OUT, { recursive: true, force: true })
mkdirSync(SVG_OUT, { recursive: true })
for (const g of glyphs) {
  const svg = svgOf(cache.icons[`${setOf(g.name)}/${mdOf(g.name)}`], cache.grids[setOf(g.name)])
  writeFileSync(resolve(SVG_OUT, g.cls + '.svg'), svg + '\n')
}

const wxss = renderWxss(cache, glyphs)
writeFileSync(WXSS_OUT, wxss)
writeFileSync(NAMES_OUT, renderNames(glyphs))

const kb = (n) => (n / 1024).toFixed(1) + ' KiB'
console.log(
  `[icons] ${glyphs.length} 个图标（各自的画布 ${Object.entries(cache.grids)
    .map(([s, g]) => s + ' ' + g)
    .join(' / ')}，mask 自动撑满 1em） → icons.wxss ${kb(Buffer.byteLength(wxss))}`,
)
console.log('[icons] ' + WXSS_OUT)
console.log('[icons] ' + NAMES_OUT)

/**
 * 字体方案为什么被换掉（2026-09，用户拍板换成 CSS mask）：
 *
 *   1. **画布不一致**：svgicons2svgfont 对所有字形用同一个缩放系数，
 *      于是 36 画布（Clarity）的字形比 24 画布（MDI）的大 1.5 倍 ——
 *      界面上就是"星能撑满容器、别的图标都缩小了"。那得靠人写死 BASE_GRID 才修好；
 *      而 mask 方案里这件事由 CSS 自己完成（mask-size: contain）。
 *   2. **字体缓存**：小程序 / 开发者工具按 font-family 缓存字体，改字形不改族名时界面**永远不变**
 *      （最后靠"族名带上内容哈希"才绕过去）—— 排查花了很久。
 *   3. **手抄清单**：类名、码位、白名单曾经分散在三处，各自漂过。
 *   而且字体方案还要让 eval-dialog / nav-bar 各 @import 一份（≈7 KB × 3）。
 *   换成 wxss 里的 mask 之后：没有字体、没有码位、没有画布数字，改图标只改 ICONS 一行。
 */
