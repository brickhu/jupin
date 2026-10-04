import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * ⚠️⚠️ 这些用例存在的理由：图标是**生成**出来的（`tools/iconfont/build.mjs` → `src/icons.wxss`），
 *    而生成物坏了**不会有任何报错** —— 页面上只是"那块空白"或"图标一大一小"。
 *    两次真实事故都栽在这类静默错误上：
 *      · 字体时代画布写错 → 字形被裁成一块碎片（看着像箭头）；
 *      · MDI/Clarity 画布不同却没归一 → 同一个字号下一个撑满、一个缩小。
 *    所以这里把生成物的**不变量**钉住：名单 ↔ 类名 ↔ mask ↔ viewBox。
 */
const HERE = fileURLToPath(new URL('.', import.meta.url))
const WXSS = readFileSync(HERE + 'icons.wxss', 'utf8')
const CACHE = JSON.parse(readFileSync(HERE + '../../../tools/iconfont/icons.json', 'utf8'))
const NAMES = readFileSync(HERE + 'lib/icon-names.ts', 'utf8')

/** 从生成的 wxss 里抠出 `{ 图标名: [mask 的 data URI, …] }` */
function masksOf(wxss: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const rule = /\.ui-icon-([a-z0-9-]+)\s*\{([^}]*)\}/g
  for (const m of wxss.matchAll(rule)) {
    const cls = m[1] as string
    const body = m[2] as string
    out.set(cls, [...body.matchAll(/url\("(data:image\/svg\+xml;base64,[^"]+)"\)/g)].map((u) => u[1] as string))
  }
  return out
}

const masks = masksOf(WXSS)
const nameList = [...NAMES.matchAll(/^ {2}'([a-z0-9-]+:[a-z0-9-]+)',/gm)].map((m) => m[1] as string)

describe('生成的图标样式（src/icons.wxss）', () => {
  it('⭐ 名单里的每个图标都有一条 mask，且没有多余的', () => {
    const want = nameList.map((n) => n.split(':').pop() as string).sort()
    expect([...masks.keys()].sort()).toEqual(want)
  })

  it('base64 能解回合法 SVG，且 viewBox 就是该集合自己的画布', () => {
    const bad: string[] = []
    for (const name of nameList) {
      const cls = name.split(':').pop() as string
      const set = name.split(':')[0] as string
      const grid = CACHE.grids[set]
      const uris = masks.get(cls) ?? []
      // -webkit- 与标准属性各一条，内容必须相同
      if (uris.length !== 2 || uris[0] !== uris[1]) bad.push(`${cls}: mask 条数/内容不一致`)
      for (const uri of uris) {
        const svg = Buffer.from(uri.split('base64,')[1] as string, 'base64').toString('utf8')
        if (!svg.startsWith('<svg')) bad.push(`${cls}: 解出来不是 svg`)
        if (!svg.includes(`viewBox="0 0 ${grid} ${grid}"`)) {
          bad.push(`${cls}: viewBox 不是 ${set} 的画布 ${grid}（会把图标裁掉/放大）`)
        }
        // mask 只看不透明度，颜色写死纯黑最确定
        if (/currentColor/.test(svg)) bad.push(`${cls}: SVG 里还留着 currentColor`)
      }
    }
    expect(bad).toEqual([])
  })

  it('⭐ 基类：1em 的盒子 + currentColor + contain（尺寸跟字号、每个图标撑满一格）', () => {
    const base = /\.ui-icon\s*\{([^}]*)\}/.exec(WXSS)?.[1] ?? ''
    expect(base).toContain('width: 1em')
    expect(base).toContain('height: 1em')
    expect(base).toContain('background-color: currentColor')
    expect(base).toContain('mask-size: contain')
    expect(base).toContain('-webkit-mask-size: contain')
  })

  it('⚠️ 没有字体残留（换方案后不该再出现 @font-face / PUA 码位）', () => {
    expect(WXSS).not.toContain('@font-face')
    expect(WXSS).not.toContain('data:font')
    expect(WXSS).not.toMatch(/content:\s*'\\[0-9a-f]{4}'/)
  })
})
