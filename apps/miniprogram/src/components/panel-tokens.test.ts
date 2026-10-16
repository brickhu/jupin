import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * ⚠️ 读源码先**剥注释**：解释"强调色走 accent"的注释里会提到旧色名，
 *    不剥的话守门会被自己的说明触发（这个项目里踩过不止一次）。
 */
const strip = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//')
    })
    .join('\n')

const read = (p: string) => strip(readFileSync(new URL(p, import.meta.url), 'utf-8'))

/** 这一族组件（用户面板 + 挂着它的顶栏）—— 颜色都该走 token，不再写死 */
const FILES = ['user-sheet/user-sheet.wxss', 'nav-bar/nav-bar.wxss'] as const
const SRC = FILES.map((f) => ({ f, code: read(f) }))

/**
 * ⭐⭐ 守的是**用户面板（以及挂着它的顶栏）的颜色全部走 design token**
 *    （用户 2026-10-16：「用户面板你能将颜色统一配置为 design token 中的 page，
 *     文字用 page.on 可以吗？」→ 接着：「nav-bar.wxss 也要统一该」）。
 *
 * ⚠️ 为什么不是纯洁癖：写死的色值**不会跟着深色反向**（构建期只翻 token）——
 *    面板底色写死 #ffffff，深色模式下就是一张白纸贴在暗背景上；
 *    而 `--tk-page` / `--tk-page-on` / `--tk-line` 会自动跟着主题走。
 *
 * ⚠️ 旧色名是 uno.config 里明确标了"废弃"的那几个：
 *    brand(#4f46e5 靛蓝) → accent · ink(#111) → page.on · muted(#666) → page.on + 透明度 · body(#333) → surface
 */
describe('用户面板的颜色：全部走 token', () => {
  it('⭐⭐ 不许再写死底色 / 文字色（page · page.on · line · surface）', () => {
    for (const { f, code } of SRC) {
      /**
       * ⚠️ 先把 `var(--tk-x, 兜底)` 整个剥掉再判 —— 兜底值**本来就该是**色值，
       *    直接搜 #ffffff 会把它当成"写死了"（第一版就这么误判的）。
       */
      const bare = code.replace(/var\([^)]*\)/g, 'VAR')
      expect(bare.includes('#ffffff'), f + '：底色又写死了（深色下会是一张白纸）').toBe(false)
      expect(bare.includes('color: #111'), f + '：又写死了 #111（废弃的 ink，应用 page.on）').toBe(false)
      expect(bare.includes('#f0f0f0'), f + '：分隔线又写死了（有 --tk-line）').toBe(false)
    }
  })

  it('⭐⭐ 不许再用废弃的 brand 靛蓝（#4f46e5 / #f3f2ff / #eeecfd）', () => {
    for (const { f, code } of SRC) {
      for (const legacy of ['#4f46e5', '#f3f2ff', '#eeecfd']) {
        expect(code.includes(legacy), f + '：又用回了废弃的 brand 色 ' + legacy + '（应用 accent）').toBe(false)
      }
      expect(code.includes('var(--tk-accent'), f + '：强调色没走 accent').toBe(true)
    }
  })

  it('⭐⭐ 必须真的用上 page / page.on（用户点名要的两个）', () => {
    for (const { f, code } of SRC) {
      expect(code.includes('var(--tk-page,'), f + '：底色没走 page token').toBe(true)
      expect(code.includes('var(--tk-page-on,'), f + '：文字没走 page.on token').toBe(true)
    }
  })

  it('⚠️ 写 token 时都要带兜底值（token 没生成时不能整条声明失效）', () => {
    for (const { f, code } of SRC) {
      const noFallback = [...code.matchAll(/var\((--tk-[a-z-]+)\)/g)].map((m) => m[1])
      expect(noFallback, f + '：这些 token 没给兜底值：' + noFallback.join(', ')).toEqual([])
    }
  })
})
