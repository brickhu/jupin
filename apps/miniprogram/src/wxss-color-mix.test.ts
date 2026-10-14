import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('.', import.meta.url))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** 剥注释但**保留换行**（行号不变） */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/**
 * ⚠️⚠️ 这个用例存在的理由（用户 2026-10 拍板放开了 color-mix）：
 *
 *   按钮 fill 的高光要**从 --btn-bg 实时算一个更亮的同色**，因为未来卡片里的按钮
 *   要配 `themeFromHash` 的**动态主题色**（每篇文章一个色相）—— 构建期根本不知道那个颜色。
 *   于是用了 `color-mix()`。代价是**退出了「Skyline ∩ WebView」的交集保证**：
 *   不认 color-mix 的引擎会把**整条声明丢掉**（本项目为"老 WebView 丢整条颜色声明"
 *   专门写过 downgradeColorSyntax，这是同一类风险）。
 *
 *   ⇒ 所以规矩是：**凡是用 color-mix 的地方，同一条规则里必须在它**之前**
 *     留一条不依赖 color-mix 的降级声明**（同一个属性名）。老引擎丢后一条、留前一条，
 *     表现是"高光偏灰"而不是"没有高光"。
 *
 *   ⚠️ 这条规矩没有编译器会管，而漏了的后果是**部分真机上样式静默消失** ——
 *      所以机器盯着。
 */
describe('WXSS —— color-mix 必须带降级声明', () => {
  const files = walk(SRC).filter((f) => f.endsWith('.wxss'))

  it('src 下有 .wxss（前提）', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('每处 color-mix 的前一条声明都是同一个属性（降级）', () => {
    const problems: string[] = []

    for (const file of files) {
      const lines = stripComments(readFileSync(file, 'utf-8')).split('\n')
      for (const [i, line] of lines.entries()) {
        if (!line.includes('color-mix(')) continue

        // 该行声明的属性名（例如 background-image）
        const prop = /^\s*([a-z-]+)\s*:/.exec(line)?.[1]
        if (!prop) {
          problems.push(`${file}:${i + 1}  color-mix 所在行取不到属性名`)
          continue
        }

        // 往上找最近的一条非空声明，要求属性名相同且不含 color-mix
        let found = false
        for (let j = i - 1; j >= 0; j--) {
          const prev: string | undefined = lines[j]
          if (prev === undefined) break
          if (/^\s*[{}]/.test(prev) || /^\s*$/.test(prev)) break // 走到规则边界就停
          const prevProp = /^\s*([a-z-]+)\s*:/.exec(prev)?.[1]
          if (!prevProp) continue
          if (prevProp !== prop) break
          if (!prev.includes('color-mix(')) found = true
          break
        }

        if (!found) {
          problems.push(
            `${file}:${i + 1}  ${prop} 用了 color-mix 但前面没有同属性的降级声明` +
              `（老引擎会丢掉整条 ⇒ 该样式静默消失）`,
          )
        }
      }
    }

    expect(problems, problems.join('\n')).toEqual([])
  })
})
