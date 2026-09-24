import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentExists, probeContentFiles, resolveStaticRoot } from './content'

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

describe('contentExists —— 「这个部署读得到它吗」', () => {
  it('仓库里真实存在的正文 → true（入参是 **id**，不是路径）', async () => {
    expect(contentExists(await someRealArticleId())).toBe(true)
  })

  it('盘上没有的 id → false', async () => {
    expect(contentExists('f'.repeat(64))).toBe(false)
  })

  /**
   * ⚠️ 这个函数的入参是 **文章 id**（正文路径由 contentPathOf 推导）——
   *    以前它收的是「正文路径」字符串（那时库里存着 content_json 一列）。
   *    下面几条锁住新语义：路径形态不再被当成合法输入，更不允许穿越。
   */
  it('把路径当 id 传 → false（不再接受路径形态）', async () => {
    expect(contentExists('/content/articles/' + 'f'.repeat(64) + '.json')).toBe(false)
    expect(contentExists('https://cdn.example.com/content/articles/x.json')).toBe(false)
  })

  it('id 里带 ../ 也不能读到仓库外 → false', async () => {
    expect(contentExists('/../package.json')).toBe(false)
    expect(contentExists('../../package.json')).toBe(false)
  })
})
