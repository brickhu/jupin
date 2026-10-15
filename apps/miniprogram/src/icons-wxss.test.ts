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

/**
 * ⚠️⚠️ **类名要用生成物里的 `ICON_CLASSES`，不能从 iconify 名现算**（2026-10-15 修）。
 *
 *    类名**不总是**"冒号后面那一段"：写了 `as` 别名的图标不是
 *    （`material-symbols:check` 的类名是 `ms-check`，不是 `check` —— 后者已经被 `mdi:check` 占了）。
 *    原来这里现算 ⇒ 与 wxss 里真实定义的类名对不上，测试红、而**真机上是图标静默不画**。
 *    ⭐ `ICON_CLASSES` 与 `ICON_NAMES` **同序**（同一个 ICONS 数组生成）——
 *      下面的 viewBox 那条就是靠这个同序关系拿到集合画布的。
 */
const classList = (() => {
  const body = /export const ICON_CLASSES = \[([^\]]*)\] as const/.exec(NAMES)?.[1] ?? ''
  return [...body.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1] as string)
})()

describe('生成的图标样式（src/icons.wxss）', () => {
  it('⭐ 名单里的每个图标都有一条 mask，且没有多余的', () => {
    expect(classList.length, 'ICON_CLASSES 没解析出来').toBe(nameList.length)
    expect([...masks.keys()].sort()).toEqual([...classList].sort())
  })

  it('base64 能解回合法 SVG，且 viewBox 就是该集合自己的画布', () => {
    const bad: string[] = []
    /** ⚠️ 按**下标**配对：ICON_NAMES 与 ICON_CLASSES 同序（别名让两者不再是字符串关系） */
    for (let i = 0; i < nameList.length; i++) {
      const name = nameList[i] as string
      const cls = classList[i] as string
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

  /**
   * ⭐⭐ 守的是**「名字 → 类名」这条解析链**（2026-10-15 补，别名机制的守卫）。
   *
   * ⚠️⚠️ 出事的样子：`iconClassOf` 按"冒号后面那一段"现算类名，而某个图标写了 `as` 别名
   *    （`material-symbols:check` 的类名是 `ms-check`）⇒ 拼出 `ui-icon-check`，
   *    而 wxss 里根本没有这个类 ⇒ **图标静默不画，只有一块空白**，控制台也不报错。
   *
   *    ⇒ 逐条把名单里每个名字解析一遍，断言它拼出来的类**在 wxss 里真的存在**。
   *      这条比"类名列表逐字相等"更强：它走的是**运行时真正用的那个函数**。
   */
  it('⭐⭐ 名单里每个名字都能解析成一个 wxss 里真实存在的类（别名解析链）', async () => {
    const mod = (await import('./lib/icon-names')) as {
      ICON_NAMES: readonly string[]
      iconClassOf: (n: string) => string
    }
    const missing: string[] = []
    for (const name of mod.ICON_NAMES) {
      const cls = mod.iconClassOf(name).replace(/^ui-icon-/, '')
      if (!cls || !masks.has(cls)) missing.push(name + ' → ' + (cls || '(空)'))
    }
    expect(missing, '这些名字解析出来的类在 icons.wxss 里不存在 ⇒ 真机上图标不画').toEqual([])
  })

  it('⭐ 别名确实生效（material-symbols:check 不能解析成 mdi 的 check）', async () => {
    const mod = (await import('./lib/icon-names')) as {
      iconClassOf: (n: string) => string
    }
    expect(mod.iconClassOf('material-symbols:check')).toBe('ui-icon-ms-check')
    expect(mod.iconClassOf('mdi:check')).toBe('ui-icon-check')
    // 没写别名的照旧是"冒号后面那一段"
    expect(mod.iconClassOf('mdi:chevron-right')).toBe('ui-icon-chevron-right')
  })
})
