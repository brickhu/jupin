/**
 * 标准音落盘 —— 「合成 → 整句 mp3」这一步。
 *
 * 产物：`content/audio/{id}.mp3`（**只有整句**）
 *
 * ⚠️⚠️ 这里**曾经还产 `content/audio/{id}/w{i}.mp3`（逐词切片）**，已删除（2026-09）：
 *    点词播放改走**微信 TTS**，客户端不再需要逐词音频文件，
 *    也就不需要在合成之后再跑一遍 ffmpeg 抠 N 个小文件（对象存储里那 N 份也没了）。
 *    ⇒ 词表（words/links）的生产在 **word-info.ts**，与音频无关。
 *
 * ⚠️ 词级对齐（alignment）仍然返回：它是**连读否决**的依据（词与词之间真的停了 ⇒ 不连读）。
 *    但它只是生成期的中间数据，**不进正文 JSON**。
 *
 * ⚠️ 输出统一 **24kHz / 单声道** —— 现有内容就是这组参数
 *    （ffprobe: mp3, 24000 Hz, 1ch, ~58kbps）。不统一的话
 *    新旧内容在客户端表现会不一致（音量/时长都对得上，但没必要两套）。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

import { contentPathOf, plainWordsOf } from '@jushuo/shared'
import { ROOT } from '../../../env.mjs'
import { synthesize, type Alignment } from './fishaudio'

const run = promisify(execFile)

/** 标准音的成品目录 —— ⚠️ 它是**内容**，进仓库（缓存才在 tools/pipeline/data/cache/） */
const OUT = resolve(ROOT, 'content/audio')

/** 标准音清单 —— 记「每一篇的音频是怎么来的」，见 writeManifest */
const MANIFEST = resolve(OUT, 'manifest.json')

/** 现有内容的音频参数 */
const SAMPLE_RATE = 24000
const BITRATE = '64k'

export interface ProduceResult {
  articleId: string
  /** 整句音频的绝对路径 */
  audioPath: string
  /** 词数（= plainWordsOf 的个数，只用于日志） */
  wordCount: number
  /** 词级对齐（连读否决要用；不进正文 JSON） */
  alignment: Alignment
  /** 是否整句音频已存在而跳过 */
  skipped: boolean
}

function audioPathOf(articleId: string, suffix = '.mp3'): string {
  return resolve(OUT, `${articleId}${suffix}`)
}

/**
 * ⭐ 认领这一篇的音频：把合成指纹写进 content/audio/manifest.json。
 *
 * ⚠️ 为什么由**合成这一侧**写：只有它知道用的是哪个模型 / 音色。
 *    共用同一份清单，是为了让另一个生产者（tools/build-content-audio.ts 的
 *    macOS say）能认出「这篇不是我的产物、别覆盖」。
 * ⚠️ 只在**真的重新生成过**之后写：跳过时不写，免得替别人产的文件签名。
 */
async function writeManifest(articleId: string, fingerprint: string): Promise<void> {
  let manifest: Record<string, string> = {}
  try {
    manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as Record<string, string>
  } catch {
    // 没有 / 坏了就新建一份 —— 清单是**缓存**，不该因为读不出来就让合成失败
  }
  manifest[articleId] = fingerprint
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
}

/** ffmpeg 转码 —— 统一到 24kHz 单声道 */
async function transcode(src: string, dst: string): Promise<void> {
  await mkdir(dirname(dst), { recursive: true })
  await run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', src,
    '-ar', String(SAMPLE_RATE), '-ac', '1', '-b:a', BITRATE,
    dst,
  ])
}

/**
 * 为一条句子产出标准音（整句 mp3）。
 *
 * @param opts.force - 默认 false：整句音频已在盘上就跳过（可断点续跑）
 */
export async function produceStandardAudio(
  articleId: string,
  text: string,
  opts: { force?: boolean } = {},
): Promise<ProduceResult> {
  const fullPath = audioPathOf(articleId)
  const words = plainWordsOf(text)

  if (!opts.force && existsSync(fullPath)) {
    // 对齐信息从缓存里取回（连读否决要用它）
    const cached = await synthesize(text, { cache: true })
    return {
      articleId,
      audioPath: fullPath,
      wordCount: words.length,
      alignment: cached.alignment,
      skipped: true,
    }
  }

  const synth = await synthesize(text)
  const { audio, alignment } = synth

  // 整句：先写临时文件再转码，避免半截文件被当成成品
  const tmp = `${fullPath}.raw.mp3`
  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(tmp, audio)
  await transcode(tmp, fullPath)
  await rm(tmp, { force: true })

  // ⭐ 整句落地才认领 —— 半截产物不该写进清单
  await writeManifest(articleId, synth.fingerprint)

  return { articleId, audioPath: fullPath, wordCount: words.length, alignment, skipped: false }
}

/**
 * 正文 JSON 的**绝对**路径 —— 相对路径走 shared 的唯一实现（contentPathOf），
 * 这里只把它钉到本机仓库根。
 */
function articleJsonPathOf(articleId: string): string {
  return resolve(ROOT, contentPathOf(articleId).replace(/^\/+/, ''))
}

/** 读一篇的正文（纠错后的那份） */
export async function readArticleText(articleId: string): Promise<string | null> {
  const p = articleJsonPathOf(articleId)
  if (!existsSync(p)) return null
  const j = JSON.parse(await readFile(p, 'utf8')) as { text?: string }
  return j.text ?? null
}

/**
 * 盘上已有句子的 id 列表（升序）。
 * ⚠️ 内容寻址：id = 正文文件名 = sha256(text) 前 16 位，所以这里直接返回文件名，不再 Number()。
 */
export async function listArticleIdsOnDisk(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const dir = resolve(ROOT, 'content/articles')
  if (!existsSync(dir)) return []
  const names = await readdir(dir)
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.replace(/\.json$/, ''))
    .sort()
}

/**
 * ⭐⭐ **剪掉孤儿音频** —— 盘上有、但已经没有对应句子的那些。
 *
 * ⚠️⚠️ 为什么必须有这一步（2026-10 发现的真实事故）：
 *    **句子 id 是内容哈希**（`sha256(text)` 前 16 位）⇒ **改一句文案就换一个 id**，
 *    而旧音频与旧 manifest 条目**留在原地没人清**。
 *    实测一次就攒了 3 个孤儿，其中一个还被提交进了仓库。
 *
 * ⚠️ 为什么不是「把 content/audio/*.mp3 加进 .gitignore」：
 *    **那个目录里 18/19 是正经内容**（成品标准音），ignore 会把它们一起漏掉。
 *    `.gitignore` 里对这件事的定性也是明写的：
 *    「合成缓存不是产物 —— **成品在 content/audio/**」。
 *
 * ⚠️ 只扫**顶层** `{id}.mp3`：`{id}/w{i}.mp3`（逐词切片）2026-09 已经废除了，
 *    万一盘上还留着旧目录，不动它 —— 那不是这一步的职责。
 *
 * @returns 被删掉的 id（调用方拿去打日志）
 */
export async function pruneOrphanAudio(): Promise<string[]> {
  const { readdir, rm } = await import('node:fs/promises')
  if (!existsSync(OUT)) return []

  const valid = new Set(await listArticleIdsOnDisk())
  const names = await readdir(OUT)

  const removed: string[] = []
  for (const name of names) {
    if (!name.endsWith('.mp3')) continue
    const id = name.replace(/\.mp3$/, '')
    if (valid.has(id)) continue
    await rm(resolve(OUT, name), { force: true })
    removed.push(id)
  }

  /**
   * ⚠️ manifest 里的条目**要跟着清**（不只是清掉被删 MP3 的那几条）：
   *    留着它，下次这条 id 被复用时会因为「清单里已经有指纹」而**跳过合成**
   *    —— 结果是新句子配着旧音频，而且没有任何报错。
   *
   * ⚠️⚠️ 所以判据是「**这个 id 还有没有句子**」，不是「刚刚有没有删掉它的 mp3」：
   *    实测就漏过一条 —— manifest 里有、盘上没有 mp3（生成到一半失败 / 音频被单独删过），
   *    按"跟着 mp3 删"的写法它永远不会被清掉。
   */
  let manifest: Record<string, string> = {}
  try {
    manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as Record<string, string>
  } catch {
    return removed
  }
  const staleManifest = Object.keys(manifest).filter((id) => !valid.has(id))
  if (staleManifest.length > 0) {
    for (const id of staleManifest) delete manifest[id]
    await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
  }

  // 返回值 = 盘上删掉的 + 清单里清掉的（去重），调用方打日志用
  return [...new Set([...removed, ...staleManifest])]
}
