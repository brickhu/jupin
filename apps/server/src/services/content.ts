import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ArticleContent } from '@jushuo/shared'

import { env } from '../env'

/**
 * 内容解析 —— 把**文章 id** 变成真正的正文。
 *
 * ⚠️⚠️ 路徑是**推导**出来的，不是存出来的：
 *    id = sha256(正文) 的前 16 位，正文文件名就是它 —— 所以
 *      `contentPathOf(id) === '/content/articles/<id>.json'`
 *    以前 `articles` 上有一列 `content_json` 存这个路径，那是**第二个真相**：
 *    它写的永远是同一个式子，却能跟 id 漂移（没有任何东西检查两者一致）。
 *    那一列已删除。
 * ⚠️ 「将来放 CDN」不需要每行存地址：CDN 会镜像同一套相对路径，
 *    变的只是**根**（STATIC_ROOT / 将来的 CDN base），不是每条记录的路径。
 *
 * ⚠️ 这是**几个消费方共用的唯一入口**：
 *      · routes/submissions.ts / scoring.ts —— 要 text 当评分参考文本
 *      · routes/articles.ts 的 /content —— 要整份数据给客户端渲染
 *      · services/article-index.ts —— 要从正文物化难度/标签索引
 *    几处必须走同一段解析，否则会出现「能评分、但页面读不出句子」这种漂移。
 */

/**
 * 静态资源**根目录** —— contentJson 相对它解析。
 *
 * ⚠️⚠️ 这里踩过一次：把「content 目录」当成了基准，
 *    于是 contentJson `/content/articles/1.json` 被解析成
 *    `/app/content/content/articles/1.json`，正文永远读不到。
 *    contentJson 是**完整的 URL 路径**（将来直接就是 CDN 上的地址），
 *    里面本来就含 content/ 这一段，所以基准必须是**根**，不是 content 目录。
 *
 * ⚠️ 候选之间靠「<root>/content 是否存在」来锚定，
 *    避免误选到某个碰巧存在的目录。
 */
export function resolveStaticRoot(): string | null {
  const candidates = [
    env.STATIC_ROOT,
    // 容器：WORKDIR=/app，content 在 /app/content
    process.cwd(),
    // 本机 pnpm dev：cwd 是 apps/server，仓库根在往上两级
    resolve(process.cwd(), '../..'),
  ].filter((d): d is string => Boolean(d))

  for (const dir of candidates) {
    const abs = resolve(dir)
    if (existsSync(resolve(abs, 'content'))) return abs
  }
  return null
}

/**
 * ⭐ **正文路径的唯一定义**：id 直接决定文件名。
 * ⚠️ 返回值是「相对静态根的 URL 路径」（含 content/ 这一段）——
 *    与将来 CDN 上的形状一致，换根不改路径。
 */
export function contentPathOf(articleId: string): string {
  return '/content/articles/' + articleId + '.json'
}

/** 读取正文；任何失败都返回 null（调用方决定是 404 还是空参考文本） */
export async function loadArticleContent(articleId: string): Promise<ArticleContent | null> {
  const rel = contentPathOf(articleId)
  const base = resolveStaticRoot()
  if (!base) {
    console.warn('[content] 找不到静态资源根目录（可用 STATIC_ROOT 指定）')
    return null
  }

  // ⚠️ 仍然防路径穿越：id 理论上来自数据库 / 调用方，别让 ../ 读到根目录之外
  //    （resolveStaticPath 里已有同一道防护，这里只是不绕过它）
  const abs = resolve(base, rel.replace(/^\/+/, ''))
  if (abs !== base && !abs.startsWith(base + '/')) {
    console.warn(`[content] 拒绝越界路径：${rel}`)
    return null
  }

  try {
    return JSON.parse(await readFile(abs, 'utf8')) as ArticleContent
  } catch (err) {
    console.warn(`[content] 读取失败 ${abs}：${(err as Error).message}`)
    return null
  }
}

/**
 * 静态资源路径解析（根目录 + 越界防护）—— readStaticFile / staticFileStamp 共用。
 * ⚠️ 复用 resolveStaticRoot()，不要另起一套 —— 本项目已经因为"两个地方各自解析路径"
 *    踩过一次（contentJson 被解析成 /app/content/content/...）。
 */
function resolveStaticPath(relPath: string): string | null {
  const base = resolveStaticRoot()
  if (!base) return null
  const abs = resolve(base, relPath.replace(/^\/+/, ''))
  if (abs !== base && !abs.startsWith(base + '/')) {
    console.warn(`[content] 拒绝越界路径：${relPath}`)
    return null
  }
  return abs
}

/**
 * 这个部署读得到这条句子吗？（只 stat，**不读内容**）
 *
 * ⭐ 存在的意义是回答「能不能把它排给用户」。
 *    `articles.isActive = true` 和「正文在这个部署的镜像里」是**两件事**：
 *    内容刚发布进库、镜像还没重新部署时，那一行会被抽中当天的题目，
 *    而客户端拿 contentJson 去取正文只会失败 —— 表现就是朗读页「正文加载失败」，
 *    且**当天所有人都打不开**（不是个别设备问题）。
 *
 * ⚠️ 只 stat 不读文件：轮转池每个请求都要过一遍这里（见 schedules.ts）。
 * ⚠️ 远程形态（http(s)://，将来的 CDN）一律算「有」——
 *    那由 CDN 负责，本机判断不了，也不该误判成「没有」而把句子踢掉。
 * ⚠️ 路径解析复用 resolveStaticPath()：防穿越那一段只允许有一份实现。
 */
export function contentExists(articleId: string): boolean {
  const abs = resolveStaticPath(contentPathOf(articleId))
  return abs !== null && existsSync(abs)
}

/** 读一个静态资源文件；拿不到就是 null */
export async function readStaticFile(relPath: string): Promise<Uint8Array | null> {
  const abs = resolveStaticPath(relPath)
  if (!abs) return null
  try {
    return new Uint8Array(await readFile(abs))
  } catch {
    return null
  }
}

/**
 * 静态资源的**版本戳**（size + mtime）—— 给「按文件内容做进程内缓存」的调用方。
 *
 * ⚠️⚠️ 为什么需要它：标准音的时长是解析 mp3 现算的、结果缓存在进程内。
 *    只按**路径**缓存的话，音频被重新生成（跑一次流水线 ④）之后，
 *    卡片上的时长会一直停留在旧值 —— 不报错，只是数字在骗人。
 *    带上这个戳，内容一变缓存自然失效；文件不在了返回 null（调用方按「没有」缓存）。
 */
export async function staticFileStamp(relPath: string): Promise<string | null> {
  const abs = resolveStaticPath(relPath)
  if (!abs) return null
  try {
    const s = await stat(abs)
    return `${s.size}:${Math.round(s.mtimeMs)}`
  } catch {
    return null
  }
}

/** 只要参考文本（评分用）—— 拿不到就返回空串，让链路继续跑 */
export async function loadArticleRefText(articleId: string): Promise<string> {
  return (await loadArticleContent(articleId))?.text ?? ''
}

/**
 * 深度自检：正文这条链路**到底通没通**。
 *
 * ⭐ 为什么值得单独探一次：云托管 **CLI 没有看容器日志的命令**，
 *    而正文不在这个部署的镜像里时，客户端只看到一句「正文加载失败」——
 *    从这里倒推是哪一层断的几乎不可能。所以三层一次列清楚：
 *      ① 盘上：有几份正文、每一份是不是合法 JSON、文件名与 id 是否一致
 *      ② 库里：有几行「可读」（isActive）的句子
 *      ③ ⭐ **差集**：库里有行、盘上没有正文的 ——
 *         这一条才是「后台发布到云环境但还没部署」的检出器：
 *         库里立刻可见（能被选中排期），镜像里却要等下次部署才有正文。
 *
 * ⚠️⚠️ 这里曾经**采样写死** `content/articles/1.json`。
 *    内容寻址（id = sha256(text) 前 16 位）之后这个文件名永远不会存在，
 *    于是这个探针一直报「读不到」，而它恰恰是排查「正文加载失败」的唯一通道 ——
 *    一个永远红的自检比没有自检更糟：人会学会无视它。
 *    ⇒ 不再采样固定文件名，改成扫目录 + 全量核对不变量。
 *
 * ⚠️ db 用**动态 import**：本文件被 db/seed-articles.ts 引用，
 *    静态引 db 会把「内容解析」和「连接池」绑成一个环（见 seed-articles.ts 文件头）。
 *    探针失败也绝不能抛 —— /health 不该因为一次自检 500。
 */
export async function probeContent(): Promise<Record<string, unknown>> {
  const root = resolveStaticRoot()
  if (!root) {
    return { ok: false, error: '找不到静态资源根目录（可用 STATIC_ROOT 指定）' }
  }

  const files = await probeContentFiles(root)

  // ── ③ 库里有行、盘上没有正文的 ──
  const missing: string[] = []
  let activeRows: number | null = null
  let dbError: string | undefined
  try {
    const { db } = await import('../db')
    const { articles } = await import('../db/schema')
    const { eq } = await import('drizzle-orm')
    const rows = await db
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.isActive, true))
    activeRows = rows.length
    for (const row of rows) {
      const rel = contentPathOf(row.id)
      if (!existsSync(resolve(root, rel.replace(/^\/+/, '')))) missing.push(rel)
    }
  } catch (err) {
    // 探针不抛：库连不上时至少要把盘上那一层说清楚
    dbError = (err as Error).message.slice(0, 160)
  }

  return {
    ...files,
    ok: files.ok === true && missing.length === 0,
    /** 库里 isActive 的行数（null = 没查到） */
    activeRows,
    /**
     * ⭐ 库里说「有」、这个部署里读不到的正文个数。
     *    非 0 几乎只有一个原因：内容刚发布进库，但镜像还没重新部署。
     */
    missingCount: missing.length || undefined,
    missingContent: missing.length ? missing.slice(0, 5) : undefined,
    dbError,
  }
}

/**
 * 盘上那一层（纯文件，不碰库）。
 *
 * ⚠️ 单独导出是为了**可测**：给一个目录就能验，不需要数据库、不需要启动服务。
 *    DIAG_ENABLED 关着的时候 /health 不跑探针，测试是它唯一的守门人。
 */
export async function probeContentFiles(root: string): Promise<Record<string, unknown>> {
  if (!root) return { ok: false, error: '缺少根目录' }

  const dir = resolve(root, 'content/articles')
  let names: string[] = []
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()
  } catch (err) {
    return { ok: false, root, error: '读不到 content/articles：' + (err as Error).message }
  }

  /**
   * 逐份解析。坏 JSON / id 与文件名不一致 / text 为空 ——
   * 这三种都是「客户端读不出来」，而且构建和 tsc 都不会吭声。
   */
  const broken: string[] = []
  let sample: Record<string, unknown> | null = null
  for (const name of names) {
    const abs = resolve(dir, name)
    try {
      const txt = await readFile(abs, 'utf8')
      const parsed = JSON.parse(txt) as { id?: unknown; text?: unknown }
      const idOk = String(parsed.id ?? '') === name.replace(/\.json$/, '')
      const text = String(parsed.text ?? '')
      if (!idOk) broken.push(name + '（id 与文件名不一致）')
      else if (!text) broken.push(name + '（text 为空）')
      // 采样取第一份**读得通**的：用来给人看一眼「确实读到了正文」
      if (!sample && idOk && text) sample = { file: name, bytes: txt.length, head: text.slice(0, 48) }
    } catch (err) {
      broken.push(name + '（' + (err as Error).message.slice(0, 60) + '）')
    }
  }

  return {
    ok: broken.length === 0 && names.length > 0,
    root,
    /** 盘上正文份数 */
    files: names.length,
    brokenCount: broken.length || undefined,
    broken: broken.length ? broken.slice(0, 5) : undefined,
    sample,
    error: names.length === 0 ? 'content/articles 是空的（镜像里漏了 content 目录？）' : undefined,
  }
}
