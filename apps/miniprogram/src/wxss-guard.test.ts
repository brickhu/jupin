import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { lintWxSource, type WxProblem } from '../wxss-lint.mjs'

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
