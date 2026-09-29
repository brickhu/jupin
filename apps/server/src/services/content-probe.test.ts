import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasContent, probeContentFiles, resolveStaticRoot } from './content'

/** 仓库里真实存在的一份正文的 **id**（内容寻址：文件名就是 id，去掉 .json） */
async function someRealArticleId(): Promise<string> {
  const root = resolveStaticRoot()!
  const names = (await readdir(join(root, 'content/articles'))).filter((n) => n.endsWith('.json')).sort()
  // ⚠️ noUncheckedIndexedAccess：names[0] 是 string | undefined
  return (names[0] ?? '').replace(/\.json$/, '')
}

/**
 * 正文自检的**盘上那一层**。
 *
 * ⚠️ 为什么值得单测：这个探针只在 /health?deep=1 且 DIAG_ENABLED 打开时才跑
 *    （默认关着 —— 它属于「不该让未鉴权请求触发」的那类操作）。
 *    也就是说**没有测试的话它平时根本没人执行**，而它又是排查
 *    「朗读页正文加载失败」的唯一通道。
 *
 * ⚠️⚠️ 它踩过一次真坑：采样写死了 content/articles/1.json，而内容寻址
 *    （id = sha256(text) 前 16 位）之后这个文件名永远不存在 ⇒ 探针**一直报错**。
 *    一个永远红的自检比没有自检更糟：人会学会无视它。下面第一条就是防它回归。
 */

describe('probeContentFiles —— 正文自检的盘上那一层', () => {
  it('仓库里的正文全部可读：有文件、没有坏文件、采样是读得通的那一份', async () => {
    const root = resolveStaticRoot()
    expect(root, '解析不到静态资源根目录').toBeTruthy()

    const out = await probeContentFiles(root!)
    expect(out.ok, JSON.stringify(out.broken)).toBe(true)
    expect(Number(out.files)).toBeGreaterThan(0)
    expect(out.brokenCount).toBeUndefined()
    // ⭐ 采样必须真的读到了正文 —— 这一条就是防「写死文件名」回归的
    expect(out.sample).toBeTruthy()
    expect(String((out.sample as { head: string }).head).length).toBeGreaterThan(0)
  })

  it('id 与文件名不一致 / text 为空 / 坏 JSON 都要被抓出来', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jushuo-probe-'))
    try {
      await mkdir(join(root, 'content/articles'), { recursive: true })
      await writeFile(join(root, 'content/articles/aaa.json'), JSON.stringify({ id: 'aaa', text: 'hello world' }))
      await writeFile(join(root, 'content/articles/bbb.json'), JSON.stringify({ id: 'zzz', text: 'x' }))
      await writeFile(join(root, 'content/articles/ccc.json'), JSON.stringify({ id: 'ccc', text: '' }))
      await writeFile(join(root, 'content/articles/ddd.json'), '{ 这不是 JSON')

      const out = await probeContentFiles(root)
      expect(out.ok).toBe(false)
      expect(out.files).toBe(4)
      expect(out.brokenCount).toBe(3)
      // 采样要跳过坏文件：否则「看起来读到了」是假的
      expect((out.sample as { file: string }).file).toBe('aaa.json')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('正文目录是空的时候必须报出来，不能静默通过', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jushuo-probe-empty-'))
    try {
      await mkdir(join(root, 'content/articles'), { recursive: true })
      const out = await probeContentFiles(root)
      expect(out.ok).toBe(false)
      expect(out.files).toBe(0)
      expect(String(out.error)).toContain('空')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('目录不存在时返回 ok:false 而不是抛（/health 不该因为自检 500）', async () => {
    const out = await probeContentFiles(join(tmpdir(), 'jushuo-不存在-' + Date.now()))
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('读不到')
  })
})

/**
 * ⭐ 「这一行有正文吗」的判据。
 *
 * ⚠️ 这一组原来是 `contentExists(id)` —— 它 stat 盘上的 `content/articles/<id>.json`，
 *    于是要测"路径穿越不能读到仓库外"那一类。**2026-09 正文搬进库之后这些都不存在了**：
 *    判据就是 `articles.content` 是不是空，没有路径、没有文件、没有穿越可言。
 *    ⇒ 换成对这个判据本身的测试（它的两个失败方向都会让产品静默出错）：
 *      · 把"有正文"判成没有 ⇒ 那一句被轮转池踢掉（当天没题可排）
 *      · 把"没正文"判成有 ⇒ 排出一句读不出来的题（全站朗读页打不开）
 */
describe('hasContent —— 「这一行有正文吗」', () => {
  it('有正文 → true', () => {
    expect(hasContent({ text: 'hi' })).toBe(true)
  })

  it('⚠️ null / undefined 都是"没有"（NULL 与"这份内容不存在"同义）', () => {
    expect(hasContent({ text: null })).toBe(false)
    expect(hasContent({ text: undefined })).toBe(false)
  })

  it('⚠️ 只有原文就算"有"：判据是"这道题有没有题面"，不是"字段齐不齐"', () => {
    // 起因：拆列之后判据是 `text`（原文是这道题的根）。译文/词表/判据分可以后补，
    // 但没有原文这一条就没法出题 —— 所以只有 text 也必须算"有"。
    expect(hasContent({ text: 'Everything should be made…' })).toBe(true)
  })

  it('⚠️ 空串不算"有"（admin 建了草稿但还没写句子）', () => {
    expect(hasContent({ text: '' })).toBe(false)
  })
})
