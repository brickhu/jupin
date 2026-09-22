/**
 * 标准音落盘 —— 「合成 → 整句 mp3 → 逐词切片」这一步。
 *
 * 产物（与 services/standard-audio.ts 的 filesOf() 完全对齐）：
 *   content/audio/{id}.mp3          整句
 *   content/audio/{id}/w{i}.mp3     第 i 个词
 *
 * ⚠️⚠️ 切片个数**必须**等于 `text.split(/\s+/).length`
 *    （server 侧 filesOf() 就是这么算的）。engine 的分词由
 *    fishaudio.assertAlignment 在合成时就校验过，这里只负责按它切。
 *
 * ⚠️ 输出统一 **24kHz / 单声道** —— 现有 5 篇就是这组参数
 *    （ffprobe: mp3, 24000 Hz, 1ch, ~58kbps）。不统一的话
 *    新旧内容在客户端表现会不一致（音量/时长都对得上，但没必要两套）。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

import { ROOT } from '../../../env.mjs'
import { synthesize, type Alignment } from './fishaudio'

const run = promisify(execFile)

/** 现有内容的音频参数 */
const SAMPLE_RATE = 24000
const BITRATE = '64k'

/**
 * 每个词两侧各留多少秒。
 *
 * ⚠️ 为什么必须留 pad：词的自然时长可能只有 80ms（"to"、"the"），
 *    裸切出来是一声爆音，点词回放完全没法听。
 *
 * ⚠️ 0.09 这个值是**量出来的**：现有 5 篇 article 1 的 11 个切片
 *    总长 4.69s，整句音频 2.62s，差 2.07s ÷ 11 词 ÷ 2 侧 ≈ 0.094s。
 *    所以取 0.09 复现既有约定。
 */
const DEFAULT_PAD_SEC = 0.09

export interface ProduceResult {
  articleId: number
  /** 整句音频的绝对路径 */
  audioPath: string
  /** 切片个数（= 空格分词数） */
  wordCount: number
  alignment: Alignment
  /** 是否整句音频已存在而跳过 */
  skipped: boolean
}

function audioPathOf(articleId: number, suffix = '.mp3'): string {
  return resolve(ROOT, 'content/audio', `${articleId}${suffix}`)
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
 * 按对齐结果切出一个词的音频。
 *
 * ⚠️ 边界要在**相邻词的中点**处夹住，不能让两个切片抢同一段音频 ——
 *    否则点 "to" 会播出半个 "predict"。
 */
async function sliceWord(
  src: string,
  out: string,
  start: number,
  end: number,
  lowerBound: number,
  upperBound: number,
  pad: number,
): Promise<void> {
  const from = Math.max(lowerBound, start - pad)
  const to = Math.min(upperBound, end + pad)
  await run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-ss', from.toFixed(4),
    '-i', src,
    '-t', Math.max(0.02, to - from).toFixed(4),
    '-ar', String(SAMPLE_RATE), '-ac', '1', '-b:a', BITRATE,
    out,
  ])
}

/**
 * 为一条句子产出整套标准音资源。
 *
 * @param opts.force - 默认 false：整句音频已在盘上就跳过（可断点续跑）
 * @param opts.padSec - 词两侧留白，默认 DEFAULT_PAD_SEC
 */
export async function produceStandardAudio(
  articleId: number,
  text: string,
  opts: { force?: boolean; padSec?: number } = {},
): Promise<ProduceResult> {
  const pad = opts.padSec ?? DEFAULT_PAD_SEC
  const fullPath = audioPathOf(articleId)
  const words = text.split(/\s+/).filter(Boolean)
  const sliceDir = resolve(ROOT, 'content/audio', String(articleId))

  if (!opts.force && existsSync(fullPath)) {
    // 对齐信息可以从缓存里取回：切片要按它算边界
    const cached = await synthesize(text, { cache: true })
    const haveSlices = existsSync(resolve(sliceDir, `w${words.length - 1}.mp3`))
    if (haveSlices) {
      return {
        articleId,
        audioPath: fullPath,
        wordCount: words.length,
        alignment: cached.alignment,
        skipped: true,
      }
    }
  }

  const { audio, alignment } = await synthesize(text)

  // 整句：先写临时文件再转码，避免半截文件被当成成品
  const tmp = `${fullPath}.raw.mp3`
  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(tmp, audio)
  await transcode(tmp, fullPath)
  await rm(tmp, { force: true })

  // 逐词切片：先清空旧切片，避免句子变短后留下多余的 w*.mp3
  await rm(sliceDir, { recursive: true, force: true })
  await mkdir(sliceDir, { recursive: true })

  const segs = alignment.segments
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (!seg) continue
    // 夹取边界：前一个词的中点 / 后一个词的中点 / 音频两端
    const lower = i === 0 ? 0 : (segs[i - 1]!.end + seg.start) / 2
    const upper = i === segs.length - 1 ? Infinity : (seg.end + segs[i + 1]!.start) / 2
    await sliceWord(
      fullPath,
      resolve(sliceDir, `w${i}.mp3`),
      seg.start,
      seg.end,
      lower,
      upper,
      pad,
    )
  }

  return { articleId, audioPath: fullPath, wordCount: words.length, alignment, skipped: false }
}

/** 读一条已有句子的正文（供 pipeline 步骤与 CLI 复用） */
export async function readArticleText(articleId: number): Promise<string | null> {
  const p = resolve(ROOT, 'content/articles', `${articleId}.json`)
  if (!existsSync(p)) return null
  const j = JSON.parse(await readFile(p, 'utf8')) as { text?: string }
  return j.text ?? null
}

/** 盘上已有句子的 id 列表（升序） */
export async function listArticleIdsOnDisk(): Promise<number[]> {
  const { readdir } = await import('node:fs/promises')
  const dir = resolve(ROOT, 'content/articles')
  if (!existsSync(dir)) return []
  const names = await readdir(dir)
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => Number(n.replace(/\.json$/, '')))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b)
}
