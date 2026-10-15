import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('./', import.meta.url))
const APP_JSON = JSON.parse(readFileSync(SRC + 'app.json', 'utf-8')) as { pages: string[] }

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|wxml|json)$/.test(p) && !p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/**
 * ⭐⭐ 守的是**"页面被删了、别处还在跳它"**这一类静默失效。
 *
 * ⚠️⚠️ 这个是真实发生过的：删掉 `pages/challenge`（成绩单展示页，用户 2026-10-15 定）之后，
 *    还有 5 处注释/常量在指它 —— 编译不报错、测试不报错，只有**用户点进去才发现白屏**。
 *    ⇒ 判据只有一条：**源码里出现的每个 `/pages/...` 都必须在 app.json 里**
 *      （后者是"这一页真的存在"的唯一事实来源）。
 *
 * ⚠️ 顺带守 `isPublic`：那个开关已经取消（语音一律公开）—— 留着它，
 *    下一个人会以为"关掉就静音"，而它其实什么都不做。
 */
describe('页面引用与实际页面一致', () => {
  const files = walk(SRC)
  const pages = new Set(APP_JSON.pages)

  it('⭐⭐ 源码里引用的每个 /pages/... 都在 app.json 里（删页不留悬空引用）', () => {
    const missing = new Map<string, string[]>()
    for (const f of files) {
      const src = readFileSync(f, 'utf-8')
      for (const m of src.matchAll(/['"`](\/pages\/[A-Za-z0-9/_-]+)/g)) {
        const raw = (m[1] ?? '').slice(1)
        /** ⚠️ `/pages/me/` 这种是**前缀**（门禁清单用的），不是一页 ⇒ 跳过 */
        if (raw.endsWith('/')) continue
        const path = raw
        if (pages.has(path)) continue
        const list = missing.get(path) ?? []
        list.push(f.slice(SRC.length))
        missing.set(path, list)
      }
    }
    expect(
      [...missing.entries()].map(([p, fs]) => p + ' ← ' + fs.join(', ')),
      '这些页面在 app.json 里不存在 ⇒ 点进去白屏：',
    ).toEqual([])
  })

  it('⚠️ `isPublic` 不许再出现（那个开关已取消：语音一律公开）', () => {
    const bad: string[] = []
    for (const f of files) {
      if (readFileSync(f, 'utf-8').includes('isPublic')) bad.push(f.slice(SRC.length))
    }
    expect(bad, '「是否公开」的残留 ⇒ 会让下一个人以为关掉就静音：').toEqual([])
  })
})
