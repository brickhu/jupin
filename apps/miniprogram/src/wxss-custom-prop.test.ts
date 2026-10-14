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

/**
 * ⚠️⚠️ 这个用例存在的理由是一次**真实的、全站级的**事故（2026-10）：
 *
 *   ui-button 为了「外部能覆盖颜色」写了这样的回落：
 *
 *     .ub { --btn-bg: var(--btn-bg, var(--tk-color)); }
 *     .ub-fill { background: var(--btn-bg); }
 *
 *   看起来是"有默认值、也能被外部覆盖"的常见写法，**其实整条都失效**：
 *   按 CSS 规范，自定义属性**引用自身**会形成依赖环（cycle），
 *   结果是「invalid at computed-value time」——`--btn-bg` 变成 guaranteed-invalid，
 *   于是 `background: var(--btn-bg)` 这条声明**直接不被采用**。
 *
 *   表现（截图抓到的）：所有实心按钮**没有底色**、**没有高度**、**没有内边距**，
 *   只剩一行文字；`outline` 看起来"有边框"只是因为 `border-color` 的初始值
 *   是 `currentColor`，属于"错了但像对的"。⚠️ 构建、tsc、eslint 全都不报。
 *
 *   ⇒ 正确写法：**组件只「读」`--x`（读的时候带 fallback），永不「写」它**；
 *     默认值放在另一个名字上（`--ub-color-*`），由使用处 `var(--x, <默认>)` 取。
 *
 * ⚠️ 为什么必须机器守着：这类错误**没有任何编译器会报**，而人工 review
 *    看到 `var(--btn-bg, var(--tk-color))` 只会觉得"写得很规范"。
 */
/**
 * ⚠️ 必须**先剥注释**再扫：本文件自己的说明里就写着那个错误示例
 *    （`--btn-bg: var(--btn-bg, ...)`），不剥的话测试会把自己绊倒。
 *    剥掉后行号会变，所以按"剥注释时保留换行"的方式做，行号仍然对得上。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

function findSelfReferences(file: string): string[] {
  const text = stripComments(readFileSync(file, 'utf-8'))
  const found: string[] = []
  for (const [i, line] of text.split('\n').entries()) {
    // 只看 `--name: … var(--name …` 这种（同一条声明里引用自己）
    for (const m of line.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*[^;{}]*/g)) {
      const name = m[1]
      const value = m[0]
      if (value.includes('var(' + name + ')') || value.includes('var(' + name + ',')) {
        found.push(`${file}:${i + 1}  ${name} 引用了自身`)
      }
    }
  }
  return found
}

describe('样式 —— 自定义属性不许引用自身（会成环 ⇒ 整条声明失效）', () => {
  it('src 下所有 .wxss 都没有自引用', () => {
    const files = walk(SRC).filter((f) => f.endsWith('.wxss'))
    expect(files.length).toBeGreaterThan(0)

    const bad = files.flatMap(findSelfReferences)
    expect(bad, '这些自定义属性引用了自身，会导致整条声明被丢弃：\n' + bad.join('\n')).toEqual([])
  })

  it('组件里对外可覆盖的 --btn-* 只被读、不被声明', () => {
    const text = stripComments(readFileSync(join(SRC, 'components/ui-button/ui-button.wxss'), 'utf-8'))

    // 数一下 --btn-* 出现在"声明"位置的次数（`--btn-x:` 后面不是 var(--btn-x 的场景）
    const declared = [...text.matchAll(/(^|[\s;{])--btn-[a-z]+:/g)].length
    expect(declared, '组件不许声明 --btn-*（那会盖掉外部覆盖，且极易写成自引用环）').toBe(0)

    // 反向确认：确实"读"了（否则外部覆盖那套功能是假的）
    expect(text).toContain('var(--btn-bg,')
  })
})
