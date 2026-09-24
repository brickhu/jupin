/**
 * 标准音落盘 —— 「合成 → 整句 mp3 → 逐词切片」这一步。
 *
 * 产物（与 services/standard-audio.ts 的 filesOf() 完全对齐）：
 *   content/audio/{id}.mp3          整句
 *   content/audio/{id}/w{i}.mp3     第 i 个词
 *
 * ⚠️⚠️ 切片个数**必须**等于 `plainWordsOf(text).length`（shared 的唯一实现）
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

import { contentPathOf, plainWordsOf } from '@jushuo/shared'
import { ROOT } from '../../../env.mjs'
import { synthesize, type Alignment } from './fishaudio'

const run = promisify(execFile)

/** 标准音清单 —— 记「每一篇的音频是怎么来的」，见 writeManifest */
const MANIFEST = resolve(ROOT, 'content/audio/manifest.json')

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

/**
 * ⭐ 一个词的播放区间**至少**要这么长（秒）—— 见 wordRangesOf 里那段说明。
 * ⚠️ 0.3 的来由：弱读虚词（the / to / is）本身只有 80ms 上下，
 *    而引擎给它们的边界还常常偏几十毫秒 —— 光靠 pad 救不回来，
 *    必须保证一个「带上下文、听得清」的最小长度。
 */
/**
 * ⭐ 最小可听长度（秒）—— **唯一一处定义**。
 * ⚠️ 导出是给 tools/admin 的手工改区间校验用的：那边若另写一个 300，
 *    就会出现「后台能存、CI 测试却红」的漂移（content-files.test.ts 也查这条）。
 */
export const MIN_PLAY_SEC = 0.3

export interface ProduceResult {
  articleId: string
  /** 整句音频的绝对路径 */
  audioPath: string
  /** 切片个数（= 空格分词数） */
  wordCount: number
  alignment: Alignment
  /** 是否整句音频已存在而跳过 */
  skipped: boolean
}

function audioPathOf(articleId: string, suffix = '.mp3'): string {
  return resolve(ROOT, 'content/audio', `${articleId}${suffix}`)
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
 * ⭐ 每个词的**播放区间**（秒）—— 预切切片与「运行时定位」**共用这一条规则**。
 *
 * ⚠️⚠️ 边界取**相邻两词的中点**，再各留 pad，并被中点 / 音频两端夹住。
 *    为什么不直接用引擎给的原始 start/end：短词只有 80ms（"the"），
 *    裸切出来就是一声爆音；中点夹取还保证相邻两词不会互相抢 ——
 *    否则点 "to" 会播出半个 "predict"。
 * ⚠️ 只允许这一处实现：切片文件和写进正文 JSON 的时间戳必须是**同一组数**，
 *    否则「点词听到的」和「记下来的」会不一致，而且完全看不出来。
 *
 * ⚠️⚠️ 短词还要再兜一层「最小可听长度」（MIN_PLAY_SEC）：引擎对**弱读的虚词**
 *    （the / to / is）给出的边界经常落在**停顿**上。实测 "Don't count the days…"
 *    里那个 the：引擎给 [0.72,0.80]，而这段音频 0.74–0.79 的 RMS 只有 8~44
 *    （峰值 5014 —— 那就是数字静音），真正的 /ðə/ 在 0.70–0.73 与 0.80–0.82 两处。
 *    ⇒ 80ms 的窗口剥出来是一声空响（「没切到位」就是这么来的）。
 *    所以区间短于 MIN_PLAY_SEC 时，以引擎给的词为中心**对称扩到最小可听长度**。
 *    ⚠️ 允许与相邻词重叠 —— 这是**播放**区间，不是训练集，重叠无害；
 *       听得清才是第一位（原来的中点夹取是为了「不互相抢」，只在长词上还保留）。
 */
function wordRangesOf(alignment: Alignment, pad: number): { start: number; end: number }[] {
  const segs = alignment.segments
  return segs.map((seg, i) => {
    const lower = i === 0 ? 0 : (segs[i - 1]!.end + seg.start) / 2
    const upper = i === segs.length - 1 ? Infinity : (seg.end + segs[i + 1]!.start) / 2
    let start = Math.max(lower, seg.start - pad)
    let end = Math.min(upper, seg.end + pad)
    if (end - start < MIN_PLAY_SEC) {
      const mid = (seg.start + seg.end) / 2
      start = mid - MIN_PLAY_SEC / 2
      end = mid + MIN_PLAY_SEC / 2
      /**
       * ⚠️ 贴到音频开头时（句首第一个词）**不是截短，而是整体往右挪** ——
       *    截短就又回到「太短听不清」了，等于这个修复在句首失效。
       */
      if (start < 0) {
        end -= start
        start = 0
      }
    }
    return { start: Math.max(0, start), end: Math.max(0, end) }
  })
}

/** 从整句音频上抠出 [from, to] 这一小段 */
async function sliceRange(src: string, out: string, from: number, to: number): Promise<void> {
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
  articleId: string,
  text: string,
  opts: { force?: boolean; padSec?: number } = {},
): Promise<ProduceResult> {
  const pad = opts.padSec ?? DEFAULT_PAD_SEC
  const fullPath = audioPathOf(articleId)
  // ⚠️ 切词走唯一实现（plainWordsOf）：切片下标 = 客户端点词下标
  const words = plainWordsOf(text)
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

  const synth = await synthesize(text)
  const { audio, alignment } = synth

  // 整句：先写临时文件再转码，避免半截文件被当成成品
  const tmp = `${fullPath}.raw.mp3`
  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(tmp, audio)
  await transcode(tmp, fullPath)
  await rm(tmp, { force: true })

  // 逐词切片：先清空旧切片，避免句子变短后留下多余的 w*.mp3
  await rm(sliceDir, { recursive: true, force: true })
  await mkdir(sliceDir, { recursive: true })

  const ranges = wordRangesOf(alignment, pad)
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]!
    await sliceRange(fullPath, resolve(sliceDir, `w${i}.mp3`), r.start, r.end)
  }

  // ⭐ 切片都切完了才认领 —— 半截产物不该写进清单
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

/** 读一条已有句子的正文（供 pipeline 步骤与 CLI 复用） */
export async function readArticleText(articleId: string): Promise<string | null> {
  const p = articleJsonPathOf(articleId)
  if (!existsSync(p)) return null
  const j = JSON.parse(await readFile(p, 'utf8')) as { text?: string }
  return j.text ?? null
}

/**
 * ⭐ 把词级**播放区间**写进正文 JSON 的 words —— 「点词播放」真正需要的那份数据。
 *
 * ⚠️⚠️ 为什么写进正文 JSON，而不是另存一份对齐文件：客户端点词时要的就是这几个数，
 *    而正文 JSON 已经会随内容一起发布 / 缓存（服务端 /api/articles/:id 直接透传它）。
 *    多一个文件 = 多一处可能没跟上部署的东西。
 * ⚠️ 区间与预切切片**同源**（wordRangesOf）—— 所以「换成运行时定位」不会改变听到的内容。
 * ⚠️ 只写我们自己知道的字段；音标 / 词性 / 释义留给流水线 ⑥⑦（现在是 null）。
 * ⚠️ id 是 sha256(正文) 的前 16 位，写 words **不会**改变 id —— 正文一个字都没动。
 */
export async function writeWordTimestamps(articleId: string, alignment: Alignment): Promise<number> {
  const p = articleJsonPathOf(articleId)
  const j = JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>
  const ranges = wordRangesOf(alignment, DEFAULT_PAD_SEC)
  /**
   * ⚠️ word 用**正文里的原词**（带标点："days," / "count."），
   *    不是引擎返回的那份 —— 引擎会把词首尾的标点剥掉（见 fishaudio 的 assertAlignment）。
   *    它要和 plainWords 的下标一一对应，别在这里把标点丢掉。
   */
  const tokens = plainWordsOf(String(j.text ?? ''))
  j.words = ranges.map((r, i) => ({
    pos: i,
    word: tokens[i] ?? alignment.segments[i]?.text ?? '',
    ipa: null,
    posTag: null,
    meaningZh: null,
    startMs: Math.round(r.start * 1000),
    endMs: Math.round(r.end * 1000),
  }))
  await writeFile(p, JSON.stringify(j, null, 2) + '\n')
  return ranges.length
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
