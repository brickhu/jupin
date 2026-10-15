import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = fileURLToPath(new URL('./', import.meta.url))

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/** 抠出 `observers: { … }` 那一段（按花括号配对，不靠正则跨全文） */
function observersOf(src: string): string | null {
  const at = src.indexOf('observers: {')
  if (at < 0) return null
  let i = src.indexOf('{', at)
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') {
      depth--
      if (depth === 0) return src.slice(i, j + 1)
    }
  }
  return null
}

/**
 * ⭐⭐ 守的是**观察者不许 `return` 一个值**。
 *
 * ⚠️⚠️ 这是花了很久才查出来的一条（2026-10-15）：微信把 `observers` 的类型定成 `=> void`，
 *    写成 `return this.foo(...)` 会让 **整个 Component 字面量的 `this` 类型推断崩掉** ——
 *    症状是**满屏「Cannot invoke an object which is possibly 'undefined'」**
 *    （`this.restore` / `this.stopPoll` / `this.precheck` 全都报），**一条都指不到真凶**。
 *    ⇒ 一律「先调用、再空 `return`」。
 */
describe('微信 Component 的观测者写法', () => {
  it('⭐⭐ 观察者里不许 `return` 一个值（会崩掉整个 this 的类型推断）', () => {
    const bad: string[] = []
    for (const f of walk(DIR)) {
      const body = observersOf(readFileSync(f, 'utf-8'))
      if (!body) continue
      /** 剥掉注释再判 —— 否则"解释这条规则的注释"会自己触发 */
      const code = body
        .split('\n')
        .filter((l) => {
          const t = l.trim()
          return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
        })
        .join('\n')
      /**
       * ⚠️ 只认「`return` 后面**同一行**还跟着**非空白**字符」——
       *    写成 `\breturn\s+([^;\n}])` 会把空 `return` 之后的缩进当返回值（误报，踩过）。
       */
      for (const m of code.matchAll(/\breturn[ \t]+([^\s;])/g)) {
        bad.push(f.slice(DIR.length) + ' → return ' + m[1] + '…')
      }
    }
    expect(bad, '这些观察者返回了值 ⇒ 整个 this 推断会崩（报错却指不到这里）：').toEqual([])
  })
})
