import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { asc, count, eq, isNotNull } from 'drizzle-orm'
import { db } from '../db'
import { articles } from '../db/schema'
import { env } from '../env'
import { getStorage } from '../storage'
import { readStaticFile, resolveStaticRoot } from './content'

/**
 * ⭐ 标准音进对象存储 —— 内容侧唯一的「写」。
 *
 * ⚠️⚠️ 为什么必须写到对象存储，而不是让服务端从仓库里读文件回吐：
 *
 *   · **云托管通道下没有可用的 URL**。API 走 callContainer 时不拼地址（微信网关代劳），
 *     而 InnerAudioContext 只认 URL —— 服务端自己回吐的音频，客户端根本拿不到地址。
 *   · 对象存储是**云开发自己的存储**，小程序用 wx.cloud.getTempFileURL 就能换取
 *     一个可播的地址，**不需要配 downloadFile 合法域名**。
 *   · 和用户录音走的是同一套设施：一个问题只有一种解法，
 *     以后换 CDN、加防盗链都只动这一处。
 *
 * ⚠️ 盘上（content/audio/）的那一份**仍然要保留** ——
 *    它是源文件，是「重新灌一遍」的依据；对象存储里的只是它的分发副本。
 */

/** 对象存储里的前缀 —— 与 content/ 下的目录结构一一对应 */
const KEY_PREFIX = 'content/audio'

/** 这篇文章的标准音在对象存储里的 key */
export function audioKeyOf(articleId: number): string {
  return `${KEY_PREFIX}/${articleId}.mp3`
}

/** 这篇的第 index 个单词的发音 */
export function wordAudioKeyOf(articleId: number, index: number): string {
  return `${KEY_PREFIX}/${articleId}/w${index}.mp3`
}

/**
 * ⭐ 把 key 变成小程序能用的 **fileID**。
 *
 * ⚠️ 格式是 `cloud://<环境ID>.<桶名>/<路径>` —— 两段都**不能省**：
 *    只有桶名的话，小程序无法判断这是哪个环境的对象。
 *    ⚠️ 环境 ID 拿不到时返回 null（而不是拼一个错的），
 *       让调用方明确地「没有音频」而不是「有个播不出来的地址」。
 */
export function fileIdOf(key: string): string | null {
  if (!env.WX_CLOUD_ENV_ID || !env.COS_BUCKET) return null
  return `cloud://${env.WX_CLOUD_ENV_ID}.${env.COS_BUCKET}/${key}`
}

/**
 * 这篇文章要上传的全部文件（整句 + 每个词）。
 * ⚠️ 词表来自**与客户端同一条切词规则**，见 tools/build-content-audio.mjs 的说明。
 */
function filesOf(articleId: number, text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  return [
    `${articleId}.mp3`,
    ...words.map((_, i) => `${articleId}/w${i}.mp3`),
  ]
}

/**
 * ⭐ 一篇文章的标准音引用 —— 云托管给 fileID，本机给服务端路径。
 *
 * ⚠️ 以 **standard_audio 这一列**为准，不是「环境有没有对象存储」：
 *    列是空的 = 这篇还没灌过（内容流水线没跑），必须返回 null，
 *    让客户端**隐藏播放入口** —— 否则会渲染一个能点、点了 404 的按钮。
 *
 * ⚠️ 本机那条走 /media/ 下的公开路由，不能是 /api/ 下的鉴权路由：
 *    InnerAudioContext 不带 Authorization 头，挂鉴权路由下必然 401。
 *    见 routes/media.ts 的注释。
 */
export function audioRefOf(article: { id: number; standardAudio: string | null }):
  | { full: string; kind: 'cloud' | 'http' }
  | null {
  if (!article.standardAudio) return null
  const cloud = fileIdOf(audioKeyOf(article.id))
  return cloud
    ? { full: cloud, kind: 'cloud' }
    : { full: `/media/articles/${article.id}.mp3`, kind: 'http' }
}

export interface SeedAudioResult {
  uploaded: number
  skipped: number
  /** 盘上根本没有音频的文章 —— 提示要先去跑生成脚本 */
  missing: number[]
}

/**
 * 幂等地把 content/audio/** 灌进对象存储。
 *
 * ⚠️ 幂等靠**探测整句音频是否存在**，而不是逐个文件探：
 *    一句话的音和它的逐词音是一起生成的，只要整句在，逐词就在。
 *    省掉的是每次冷启动几十次 head 请求。
 *
 * ⚠️ 刻意**不做全量校验**：内容换了要重新灌，那是内容发布流程该管的事，
 *    不是每次启动都跑一遍的巡检。要强制重灌就先把对象删掉。
 */
export async function seedStandardAudio(
  log: (msg: string) => void = console.log,
): Promise<SeedAudioResult> {
  const out: SeedAudioResult = { uploaded: 0, skipped: 0, missing: [] }
  const root = resolveStaticRoot()
  if (!root) {
    log('[audio] 找不到静态资源根目录，跳过标准音灌入')
    return out
  }

  const rows = await db.select().from(articles)
  const storage = getStorage()

  for (const row of rows) {
    const jsonPath = resolve(root, row.contentJson.replace(/^\/+/, ''))
    if (!existsSync(jsonPath)) continue
    const text = (JSON.parse(await readFile(jsonPath, 'utf8')) as { text?: string }).text ?? ''
    if (!text) continue

    const localFull = resolve(root, KEY_PREFIX, `${row.id}.mp3`)
    if (!existsSync(localFull)) {
      // ⚠️ 盘上没有 = 还没跑生成脚本。这不该让服务起不来，但必须留下痕迹
      out.missing.push(row.id)
      continue
    }

    if (await storage.exists(audioKeyOf(row.id))) {
      out.skipped++
    } else {
      for (const rel of filesOf(row.id, text)) {
        const bytes = await readStaticFile(`${KEY_PREFIX}/${rel}`)
        if (!bytes) continue
        await storage.put(`${KEY_PREFIX}/${rel}`, bytes)
        out.uploaded++
      }
      log(`[audio] 已灌入 #${row.id}（${filesOf(row.id, text).length} 个文件）`)
    }

    // ⭐ 把 key 记进库 —— /api/articles/:id/content 要靠它拼 fileID
    if (row.standardAudio !== audioKeyOf(row.id)) {
      await db.update(articles).set({ standardAudio: audioKeyOf(row.id) }).where(eq(articles.id, row.id))
    }
  }

  if (out.missing.length > 0) {
    log(`[audio] ⚠️ 这些文章盘上没有标准音，请先跑 pnpm content:audio：#${out.missing.join(', ')}`)
  }
  return out
}

/**
 * 深度自检：标准音这条链路**到底通没通**。
 *
 * ⭐ 为什么值得单独查：这条链路跨三层，任何一层断了客户端表现都一样 ——
 *    「朗读页没有喇叭 / 点了没声音」，而从那个现象倒推是哪一层几乎不可能：
 *      ① 库里的 standard_audio 有没有值   （没值 → 接口直接不给 audio，按钮都不渲染）
 *      ② 对象存储里那个文件在不在        （不在 → 客户端拿到 fileID 也播不出来）
 *      ③ 客户端最终会拿到什么样的引用    （cloud fileID / http 路径 / 什么都没有）
 *    这里把三层一次列清楚。
 */
export async function probeStandardAudio(sample = 3): Promise<Record<string, unknown>> {
  const rows = await db.select().from(articles).orderBy(asc(articles.id)).limit(sample)
  const storage = getStorage()
  const items: Record<string, unknown>[] = []

  for (const row of rows) {
    const key = audioKeyOf(row.id)
    let exists: boolean | string = false
    try {
      exists = await storage.exists(key)
    } catch (err) {
      exists = '探测失败: ' + (err as Error).message.slice(0, 120)
    }
    const ref = audioRefOf(row)
    items.push({
      id: row.id,
      dbColumn: row.standardAudio ?? '(空 —— 接口不会返回 audio，客户端连按钮都不渲染)',
      fileInBucket: exists,
      clientRef: ref ? ref.kind + (ref.kind === 'cloud' ? '（免域名，走 wx.cloud.downloadFile）' : '') : '(null)',
    })
  }

  const [total] = await db.select({ n: count() }).from(articles)
  const [configured] = await db
    .select({ n: count() })
    .from(articles)
    .where(isNotNull(articles.standardAudio))

  return {
    articles: Number(total?.n ?? 0),
    standardAudioConfigured: Number(configured?.n ?? 0),
    sample: items,
  }
}

