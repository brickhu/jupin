import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = fileURLToPath(new URL('./', import.meta.url))

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.wxss')) out.push(p)
  }
  return out
}

/**
 * ⭐⭐ 守的是**「图标尺寸写 font-size，不写 width/height」**。
 *
 * ⚠️⚠️ `ui-icon` **没有** `virtualHost` ⇒ 参与布局的是它的**宿主节点**，
 *    而里面那个盒子是 **1em**（跟着**字号**走，见 icons.wxss 的 `.ui-icon`）。
 *    在宿主上写 width/height 的后果**不是"图标变大了"**，而是：
 *    宿主被撑大、里面的图标仍是继承来的字号那么大，还按 `vertical-align: -0.125em`
 *    坐在基线上 ⇒ **看起来偏上、不居中**（用户 2026-10-15 报的就是这个，查了半天
 *    才从"字形不对称"改到"宿主 vs 1em"）。
 *
 * ⚠️ 判据：名字形如 `-i<数字>` 的类（`br-i20` / `xx-i24` 这种**图标专用**命名）
 *    只许用 font-size 定尺寸。圆钮的尺寸类（`ab-sm` / `br-c48`）不在此列 ——
 *    它们量的是**圆**，里面另有图标。
 */
describe('图标尺寸的写法', () => {
  it('⭐⭐ 图标专用类（-i<数字>）必须用 font-size，不许用 width/height', () => {
    const bad: string[] = []
    for (const f of walk(DIR)) {
      const src = readFileSync(f, 'utf-8')
      for (const m of src.matchAll(/\.([a-z-]*?-i\d+)\s*\{([^}]*)\}/g)) {
        const [, name, body] = m
        if (body === undefined) continue
        if (!name || name.startsWith('.')) continue
        const hasFontSize = /font-size\s*:/.test(body)
        const hasBox = /(width|height)\s*:/.test(body)
        if (hasBox && !hasFontSize) {
          bad.push(f.slice(DIR.length) + ' → .' + name + '（用了 width/height 反而会不居中）')
        }
      }
    }
    expect(bad, '图标尺寸要写 font-size（ui-icon 内部是 1em）：').toEqual([])
  })

  it('⭐⭐ 宿主节点必须 font-size + line-height: 1 + display: flex（三者缺一都会偏）', () => {
    const src = readFileSync(DIR + 'btn-record/btn-record.wxss', 'utf-8')
    for (const name of ['br-i12', 'br-i14', 'br-i20', 'br-i24']) {
      const rule = new RegExp('\\.' + name + '\\s*\\{([^}]*)\\}').exec(src)?.[1] ?? ''
      expect(rule.includes('font-size'), '.' + name + ' 少了 font-size（尺寸要走字号）').toBe(true)
      expect(rule.includes('line-height: 1'), '.' + name + ' 少了 line-height: 1').toBe(true)
      /**
       * ⚠️⚠️ 这条最容易被省：里面那个 `.ui-icon` 是 `inline-block` +
       *    `vertical-align: -0.125em`（图标字体惯例）⇒ 它贴基线、**偏上 0.125em**，
       *    行盒也比 1em 高一点。宿主不做 flex 容器的话，外层怎么居中它都偏上。
       */
      expect(rule.includes('display: flex'), '.' + name + ' 的宿主不是 flex ⇒ 图标会贴基线偏上').toBe(true)
    }
  })
})
