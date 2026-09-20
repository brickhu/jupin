import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ArticleContent } from '@jushuo/shared'

import { env } from '../env'

/**
 * 内容解析 —— 把 articles.contentJson 里那个「地址」变成真正的正文。
 *
 * ⚠️ 设计上 contentJson 是**静态资源地址**（未来指向 CDN），正文本身不入库。
 *    但内容流水线还没建、也还没有 CDN，所以这里同时接受两种形态：
 *      · `http(s)://…`  → 直接 fetch（未来 CDN 走这条，服务端只是透传）
 *      · `/content/…`   → 读本地 content/ 目录（当前开发用，仓库里的 fixture）
 *
 * ⚠️ 这是**两个消费方共用的唯一入口**：
 *      · routes/submissions.ts —— 要 text 当评分参考文本
 *      · routes/articles.ts 的 /content —— 要整份数据给客户端渲染
 *    两处必须走同一段解析，否则会出现「能评分、但页面读不出句子」这种漂移。
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

/** 读取正文；任何失败都返回 null（调用方决定是 404 还是空参考文本） */
export async function loadArticleContent(contentJson: string): Promise<ArticleContent | null> {
  if (/^https?:\/\//.test(contentJson)) {
    try {
      const res = await fetch(contentJson)
      if (!res.ok) {
        console.warn(`[content] HTTP ${res.status}：${contentJson}`)
        return null
      }
      return (await res.json()) as ArticleContent
    } catch (err) {
      console.warn(`[content] 拉取失败 ${contentJson}：${(err as Error).message}`)
      return null
    }
  }

  if (!contentJson.startsWith('/')) {
    console.warn(`[content] 无法识别的 contentJson 形态：${contentJson}`)
    return null
  }

  const base = resolveStaticRoot()
  if (!base) {
    console.warn('[content] 找不到静态资源根目录（可用 STATIC_ROOT 指定）')
    return null
  }

  // ⚠️ contentJson 来自数据库，仍要防路径穿越 —— 别让 ../ 读到根目录之外
  const abs = resolve(base, contentJson.replace(/^\/+/, ''))
  if (abs !== base && !abs.startsWith(base + '/')) {
    console.warn(`[content] 拒绝越界路径：${contentJson}`)
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
 * 读一个静态资源文件（相对 contentJson 的同一套根目录解析 + 越界防护）。
 *
 * ⚠️ 复用 resolveStaticRoot()，不要另起一套 —— 本项目已经因为"两个地方各自解析路径"
 *    踩过一次（contentJson 被解析成 /app/content/content/...）。
 */
export async function readStaticFile(relPath: string): Promise<Uint8Array | null> {
  const base = resolveStaticRoot()
  if (!base) return null

  const abs = resolve(base, relPath.replace(/^\/+/, ''))
  if (abs !== base && !abs.startsWith(base + '/')) {
    console.warn(`[content] 拒绝越界路径：${relPath}`)
    return null
  }
  try {
    return new Uint8Array(await readFile(abs))
  } catch {
    return null
  }
}

/** 只要参考文本（评分用）—— 拿不到就返回空串，让链路继续跑 */
export async function loadArticleRefText(contentJson: string): Promise<string> {
  return (await loadArticleContent(contentJson))?.text ?? ''
}

/**
 * 深度自检：正文文件到底在不在、能不能解析。
 *
 * ⚠️ 为什么值得单独探一次：云托管 **CLI 没有看容器日志的命令**，
 *    而「镜像里漏了 content 目录」和「句库是空的」在客户端表现**一模一样** ——
 *    都是朗读页「正文加载失败」。不探一次就只能靠猜。
 */
export async function probeContent(): Promise<Record<string, unknown>> {
  const root = resolveStaticRoot()
  if (!root) {
    return { ok: false, error: '找不到静态资源根目录（可用 STATIC_ROOT 指定）' }
  }

  const sample = 'content/articles/1.json'
  const abs = resolve(root, sample)
  try {
    const txt = await readFile(abs, 'utf8')
    const parsed = JSON.parse(txt) as { text?: string }
    return {
      ok: true,
      root,
      sample,
      bytes: txt.length,
      head: parsed.text?.slice(0, 48) ?? null,
    }
  } catch (err) {
    return { ok: false, root, sample, error: (err as Error).message }
  }
}
