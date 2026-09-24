#!/usr/bin/env node
/**
 * ⭐ 小程序 icon font 子集生成器（构建期一次性工具，不是运行时依赖）。
 *
 *   用法：node tools/iconfont/build.mjs
 *   产物：apps/miniprogram/src/iconfont.wxss（@font-face base64 TTF + .icon-xxx）
 *
 * 为什么是 icon font 而不是 SVG / Iconify 组件：见 docs/research/icon-evaluation.md。
 * ⚠️ 不要手改产物 iconfont.wxss —— 改图标清单就改这里的 ICONS，然后重跑。
 * ⚠️ 图标来自 Iconify 的 MDI 集合，首次联网拉取后缓存进 icons.json（之后离线可重建）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { SVGIcons2SVGFontStream } from 'svgicons2svgfont'
import svg2ttf from 'svg2ttf'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const CACHE = resolve(HERE, 'icons.json')
const SVG_OUT = resolve(HERE, 'svg')
const WXSS_OUT = resolve(ROOT, 'apps/miniprogram/src/iconfont.wxss')

const FONT_FAMILY = 'jushuo-icons'
/** ⚠️ MDI 是 24×24 网格：fontHeight 只做整体缩放，**不做 normalize** ——
 *  normalize 会把每个字形的外框都拉满 em，chevron 这种天生窄小的字形会被撑成巨人，
 *  MDI 原本「同一网格里互相配好的比例」就全废了。 */
const GRID = 24
const FONT_HEIGHT = 1024

/**
 * 图标清单。
 *   md        —— Iconify(MDI) 图标名
 *   cp        —— 私有区码位（PUA，不与任何正常字符冲突）
 *   cls       —— 生成的类名后缀（`.icon-<cls>`）
 *   use       —— 用在哪（注释用，改图标时一眼知道影响面）
 */
const ICONS = [
  { md: 'play',          cp: 0xe001, cls: 'play',          use: '卡片/结果页 播放' },
  { md: 'loading',       cp: 0xe002, cls: 'loading',       use: '音频按钮 loading（旋转的弧）' },
  { md: 'stop',          cp: 0xe003, cls: 'stop',          use: '金句卡 停止' },
  { md: 'chevron-right', cp: 0xe004, cls: 'chevron-right', use: '卡片/排名行 进入' },
  { md: 'chevron-left',  cp: 0xe005, cls: 'chevron-left',  use: '导航栏 返回' },
  { md: 'share-variant', cp: 0xe006, cls: 'share',         use: '结果页 分享' },
  { md: 'heart-outline', cp: 0xe007, cls: 'heart-outline', use: '结果页 点赞' },
  { md: 'home',          cp: 0xe008, cls: 'home',          use: '导航栏 / 用户面板 我的主页' },
  { md: 'target',        cp: 0xe009, cls: 'target',        use: '用户面板 参与场次' },
  { md: 'clipboard-text-outline', cp: 0xe00a, cls: 'clipboard', use: '用户面板 我的挑战' },
  { md: 'fire',          cp: 0xe00b, cls: 'fire',          use: '用户面板菜单 连战记录' },
  { md: 'bell-outline',  cp: 0xe00c, cls: 'bell',          use: '用户面板 通知' },
  // ⚠️ 只把「控件 / 导航」做成字形。**表达性 / 语义标记一律用 emoji**，故意不放进这张表：
  //    · 📈 🔥 🏔️  成长值三指标（徽章那一类的荣誉标记，与 pages/profile 的做法一致）
  //    · ⚡ ❄️      能量 / 解冻卡（「我手上有什么」的语义标记，不是控件）
  //    · 🔥 ⚡ 🎙️ 🎯 连战页 / 能量页大图、两个空态插画
]

async function loadIconBodies() {
  const bodies = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}

  // ⚠️ 只补缺的那几个：往 ICONS 里加图标时不用手删缓存，也不会重复联网
  const missing = ICONS.map((i) => i.md).filter((md) => !bodies[md])
  if (missing.length > 0) {
    const url = `https://api.iconify.design/mdi.json?icons=${missing.join(',')}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Iconify 请求失败：${res.status} ${url}`)
    const json = await res.json()
    for (const md of missing) {
      const body = json.icons?.[md]?.body
      if (!body) throw new Error('Iconify 里没有这个图标：' + md)
      bodies[md] = body
    }
    writeFileSync(CACHE, JSON.stringify(bodies, null, 2) + '\n')
  }
  return bodies
}

const svgOf = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${GRID}" height="${GRID}" viewBox="0 0 ${GRID} ${GRID}">${body}</svg>`

/** SVG 字形序列 → SVG font 文本（svgicons2svgfont 是流式 API，这里收成一个字符串） */
function buildSvgFont(bodies) {
  return new Promise((done, fail) => {
    const chunks = []
    const fontStream = new SVGIcons2SVGFontStream({
      fontName: FONT_FAMILY,
      fontHeight: FONT_HEIGHT,
      round: 10,
      log: () => {},
    })
    fontStream.on('data', (c) => chunks.push(Buffer.from(c)))
    fontStream.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    fontStream.on('error', fail)

    for (const icon of ICONS) {
      const glyph = new Readable({ read() {} })
      glyph.push(Buffer.from(svgOf(bodies[icon.md])))
      glyph.push(null)
      glyph.metadata = { unicode: [String.fromCodePoint(icon.cp)], name: icon.cls }
      fontStream.write(glyph)
    }
    fontStream.end()
  })
}

function renderWxss(ttfBuffer) {
  const out = []
  out.push('/* ⚠️ 自动生成，请勿手改 —— 重新生成：node tools/iconfont/build.mjs */')
  out.push('/* 图标来自 Iconify 的 MDI 集合（https://iconify.design），只打包下面这几个字形。 */')
  out.push('')
  out.push('@font-face {')
  out.push(`  font-family: '${FONT_FAMILY}';`)
  out.push(`  src: url('data:font/ttf;base64,${ttfBuffer.toString('base64')}') format('truetype');`)
  out.push('  font-weight: normal;')
  out.push('  font-style: normal;')
  out.push('}')
  out.push('')
  out.push('/* 用法：<text class="iconfont icon-play"></text> —— 颜色/字号都跟着宿主元素走 */')
  out.push('.iconfont {')
  out.push(`  font-family: '${FONT_FAMILY}';`)
  out.push('  font-style: normal;')
  out.push('  font-weight: normal;')
  out.push('  line-height: 1;')
  out.push('  font-variant: normal;')
  out.push('  text-transform: none;')
  out.push('  -webkit-font-smoothing: antialiased;')
  out.push('}')
  out.push('')
  for (const icon of ICONS) {
    out.push(`/* ${icon.use} */`)
    out.push(`.icon-${icon.cls}::before { content: '\\${icon.cp.toString(16)}'; }`)
  }
  out.push('')
  return out.join('\n')
}

const bodies = await loadIconBodies()

// 每次全量重写：ICONS 删掉某个图标时旧的 .svg 不该留在目录里
rmSync(SVG_OUT, { recursive: true, force: true })
mkdirSync(SVG_OUT, { recursive: true })
for (const icon of ICONS) writeFileSync(resolve(SVG_OUT, icon.cls + '.svg'), svgOf(bodies[icon.md]) + '\n')

const svgFont = await buildSvgFont(bodies)
writeFileSync(resolve(HERE, 'font.svg'), svgFont)

// 逐个核对码位，避免「图标和类名对错位」这种只能靠肉眼发现的静默错误
// （SVG font 用的是十六进制实体 unicode="&#xE001;"）
const inFont = new Set(
  [...svgFont.matchAll(/unicode="&#x([0-9A-Fa-f]+);"/g)].map((m) => parseInt(m[1], 16)),
)
for (const icon of ICONS) {
  if (!inFont.has(icon.cp)) {
    throw new Error(`生成的字体里找不到 ${icon.cls}（U+${icon.cp.toString(16)}）`)
  }
}

const ttf = svg2ttf(svgFont, {})
const ttfBuffer = Buffer.from(ttf.buffer)
writeFileSync(resolve(HERE, 'jushuo-icons.ttf'), ttfBuffer)

const wxss = renderWxss(ttfBuffer)
writeFileSync(WXSS_OUT, wxss)

const kb = (n) => (n / 1024).toFixed(1) + ' KiB'
console.log(`[iconfont] ${ICONS.length} 个字形 → ttf ${kb(ttfBuffer.length)} → iconfont.wxss ${kb(Buffer.byteLength(wxss))}`)
console.log('[iconfont] ' + WXSS_OUT)
