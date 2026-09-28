import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * ⭐⭐ **产物里的 WXML 不许带注释**（用户 2026-09 报的：界面上看到了工程备注）。
 *
 * ⚠️ 为什么这条值得单独守：小程序编译器对 WXML 注释的处理**不是删掉** ——
 *    它可能留成文本节点/空白节点，于是注释里那些写给自己的话
 *    （「⇒ 别看着这块少了一行又加回来」「本轮先不做」）就有机会显示在页面上。
 *    源码里留着注释是对的（改代码的人要靠它），**产物**里必须一条不剩。
 *    ⇒ 删注释那一步在 build.mjs 的 stripWxmlComments()，这条测试盯它有没有生效。
 *
 * ⚠️ dist 不存在时**跳过**而不是失败：这条守的是构建产物，不该让一个没跑过构建的
 *    工作区在 `vitest run` 上红掉（ci 里是先 build 再 test）。
 */
const DIST = fileURLToPath(new URL('../dist', import.meta.url))

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : p.endsWith('.wxml') ? [p] : []
  })
}

describe('产物 WXML 不带注释', () => {
  it('dist 里每个 .wxml 都没有 <!-- -->（源码照旧保留）', () => {
    const files = walk(DIST)
    if (files.length === 0) {
      // 没构建过就没什么可查的 —— 这一条不是"源码检查"
      expect(true).toBe(true)
      return
    }
    const bad = files.filter((f) => fs.readFileSync(f, 'utf8').includes('<!--'))
    expect(bad.map((f) => path.relative(DIST, f))).toEqual([])
  })
})
