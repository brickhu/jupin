import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { lintMultilineText, lintWxSource, type WxProblem } from '../wxss-lint.mjs'

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
 * ⚠️⚠️ 这些用例存在的理由：tsc 与 esbuild **都不碰 wxss**，
 *    所以这类错误构建期看不出来，只有微信开发者工具才会炸 ——
 *    而那时人已经在看页面了。两次真实事故见 wxss-lint.mjs 的说明。
 */
describe('WXSS / WXML 的静态检查', () => {
  it('⭐ 全项目的 .wxss / .wxml 都是干净的', () => {
    const bad: string[] = []
    for (const file of walk(SRC)) {
      if (!file.endsWith('.wxss') && !file.endsWith('.wxml')) continue
      const problems: WxProblem[] = lintWxSource(readFileSync(file, 'utf8'))
      for (const p of problems) {
        bad.push(relative(SRC, file) + ':' + p.line + '  →  ' + p.what)
      }
    }
    expect(bad).toEqual([])
  })

  it('注释头被吃掉（孤立的注释结尾）要报', () => {
    const mangled = [
      '/** 头部 */',
      '.a { width: 1rpx; }',
      ' *',
      ' * 沙箱提示',
      ' */',
      '.b { background: #fff; }',
    ].join('\n')
    expect(lintWxSource(mangled).some((p) => p.what.includes('孤立的注释结尾'))).toBe(true)
  })

  it('反引号要报（哪怕在注释里）', () => {
    const q = String.fromCharCode(96)
    const text = '/**\n * 写成 ' + q + 'bg-warn/10' + q + ' 这样\n */\n'
    expect(lintWxSource(text).some((p) => p.what.includes('反引号'))).toBe(true)
  })

  it('花括号不配平要报（截断 / 漏改的指纹）', () => {
    expect(lintWxSource('.a { width: 1rpx;').some((p) => p.what.includes('没有闭合'))).toBe(true)
    expect(lintWxSource('.a { } }').some((p) => p.what.includes('多余的'))).toBe(true)
  })

  it('正常文件一个都不报（别把好文件误伤了）', () => {
    const good = '/**\n * 说明\n */\n.a {\n  width: 1rpx;\n  border-radius: 20rpx;\n}\n'
    expect(lintWxSource(good)).toEqual([])
  })
})

/**
 * ⭐⭐ `<text>` 内容另起一行会被渲染出一个空行（`<text>` 保留换行）。
 *
 * ⚠️⚠️ 这组用例的重点**不是"能抓到"，而是"不误伤"**：
 *    写这条规则时连续误报了两轮 ——
 *      ① 单行的 `<text>x</text>` 因为也以 `>` 结尾，被当成"标签独占一行"；
 *      ② 注释里举的反例被当成真代码（剥注释时只认了块注释，没认 HTML 注释）。
 *    两次都让构建当场变红。**一条会误伤正确代码的检查比没有更糟** ——
 *    所以正确写法在这里是**逐个钉住**的。
 */
describe('lintMultilineText —— <text> 的内容必须紧贴标签', () => {
  it('多行写法（标签独占一行、内容另起一行）⇒ 报出来', () => {
    const bad = ['<text class="a">', '  文案', '</text>'].join('\n')
    expect(lintMultilineText(bad)).toHaveLength(1)
  })

  it('⭐ 单行写法 ⇒ **不报**（它也以 > 结尾，光看结尾会误判）', () => {
    expect(lintMultilineText('<text class="a">文案</text>')).toEqual([])
  })

  it('⭐ 内容紧贴、收尾在下一行 ⇒ 不报（内容确实紧贴了）', () => {
    expect(lintMultilineText(['<text class="a">文案', '</text>'].join('\n'))).toEqual([])
  })

  it('自闭合 ⇒ 不报', () => {
    expect(lintMultilineText(['<text class="a" />', '别的'].join('\n'))).toEqual([])
  })

  it('⭐⭐ 注释里举的反例 ⇒ **不报**（HTML 注释风格，和 WXML 一致）', () => {
    const withExample = ['<!-- 不要写成：', '<text class="a">', '  文案', '</text>', '-->'].join('\n')
    expect(lintMultilineText(withExample)).toEqual([])
  })

  it('⭐ 块注释里举的反例 ⇒ 也不报', () => {
    const withExample = ['/* 反例：', '<text class="a">', '  文案', '</text>', '*/'].join('\n')
    expect(lintMultilineText(withExample)).toEqual([])
  })

  it('注释注释掉之后，真正的代码照样抓得到', () => {
    const mixed = ['<!-- 示例 -->', '<text class="a">', '  文案', '</text>'].join('\n')
    expect(lintMultilineText(mixed)).toHaveLength(1)
  })
})
