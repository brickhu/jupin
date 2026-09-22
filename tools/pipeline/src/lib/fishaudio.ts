/**
 * fish-audio：标准音 TTS + **词级时间戳**。
 *
 * 端点是 `/v1/tts/stream/with-timestamp`（SSE 流）。
 *
 * ⚠️⚠️ 下面这几条**不是文档写的，是把真实返回 dump 下来看到的**
 *    （本项目接讯飞 ISE 时就吃过一次「文档字段清单 ≠ 真实返回」，见
 *     apps/server/scripts/dump-youdao.ts 的注释）。改动前请重新 dump：
 *
 *   ① **`chunk_seq` 和 `chunk_audio_offset_sec` 恒为 0**，不能用来排序。
 *      音频必须**按 SSE 到达顺序**拼接 —— 这是唯一可靠的顺序来源。
 *
 *   ② **`alignment` 是逐块累积的**：前几块是 `null`，
 *      越往后越全，**最后一块包含完整的 `segments[]`**。
 *      所以要保留「最后一个非 null 的 alignment」，不是第一个。
 *
 *   ③ `segments[].text` 与**空格分词**逐项一致
 *      （`text.split(/\s+/)`）—— 这正是 services/standard-audio.ts
 *      的 filesOf() 算 w{i}.mp3 个数用的规则。spec 第九节要求
 *      「必须与自建词表逐项一致」，本文件用 assertAlignment 把这个假设
 *      变成一条会炸的断言，而不是一个静默的错位。
 *
 *   ④ 代理是**必须**的：本机直连 api.fish.audio 直接超时，
 *      只有走 FISH_PROXY_URL 才通。Node 的 fetch 不支持 socks5，
 *      所以这里用 node:https + socks-proxy-agent，而不是 fetch。
 *
 * ⚠️ 词级时间戳是**带内**返回的：它和音频在同一个流里，
 *    不需要第二次请求，也不需要用 ffmpeg 猜边界。
 */

import { request } from 'node:https'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { SocksProxyAgent } from 'socks-proxy-agent'

import { ROOT } from '../../../env.mjs'

/** 一个词的起止时间（秒） */
export interface AlignmentSegment {
  text: string
  start: number
  end: number
}

/** 整句的对齐信息 */
export interface Alignment {
  segments: AlignmentSegment[]
  /** 引擎自己报的音频时长（秒）—— 与 ffprobe 量出来的会差几十毫秒（mp3 帧填充） */
  audioDuration: number
}

export interface Synthesis {
  /** 拼好的整句 mp3 */
  audio: Buffer
  alignment: Alignment
  /** 回显本次合成的文本，便于调用方比对 */
  text: string
  /** 是否命中缓存 */
  cached: boolean
}

/** 缓存目录 —— 同一段文本重跑不该再烧一次额度（README 的硬要求） */
const CACHE_DIR = resolve(ROOT, 'tools/pipeline/data/cache/fishaudio')

/** 默认模型。⚠️ 免费额度走的就是这个；换模型改 FISH_MODEL 即可，不用动代码 */
const DEFAULT_MODEL = 's2.1-pro-free'

const DEFAULT_BASE_URL = 'https://api.fish.audio'

/** 单次合成的总超时 —— 免费额度偶尔排队，给宽松一点 */
const TIMEOUT_MS = 120_000

interface FishEnv {
  key: string
  proxy: string | undefined
  baseUrl: string
  model: string
}

function readEnv(): FishEnv {
  const key = process.env.FISH_API_KEY
  if (!key) {
    throw new Error(
      '缺少 FISH_API_KEY —— 写进 .env.local（本机）或 .env.dev / .env.prod（云端）后再试',
    )
  }
  return {
    key,
    proxy: process.env.FISH_PROXY_URL || undefined,
    baseUrl: (process.env.FISH_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: process.env.FISH_MODEL || DEFAULT_MODEL,
  }
}

/**
 * ⭐ 对齐校验 —— spec 第九节的硬要求，这里让它**会炸**。
 *
 * 引擎的分词必须和我们算 w{i}.mp3 个数用的分词规则逐项一致，
 * 否则切片会整体错位：w0.mp3 放的是第二个词的声音，而且不报错。
 *
 * ⚠️⚠️ 实测出来的一条规则（用现有 5 句话逐句 dump 过，全部一致）：
 *    引擎**会剥掉词首/词尾的标点**，但**词数一个不差**：
 *      "it." → "it"    "final," → "final"    "fatal:" → "fatal"
 *    5 句话的段数与空格分词数分别是 11/11、5/5、16/16、18/18、14/14。
 *
 *    所以校验分两层：
 *      ① **词数必须相等** —— 这条最要紧，切片个数直接由它决定；
 *      ② 归一化（去首尾标点）后**逐项相等** —— 防止引擎把两个词并成一个
 *         再吐出等量的别的词，那也能骗过词数检查。
 *
 * ⚠️ 用「保留内部标点」的归一化：don't / well-known 不能被拆开。
 */
function normalizeToken(w: string): string {
  return w.replace(/^[^\p{L}\p{N}']+/u, '').replace(/[^\p{L}\p{N}']+$/u, '')
}

export function assertAlignment(text: string, alignment: Alignment): void {
  const ours = text.split(/\s+/).filter(Boolean)
  const theirs = alignment.segments.map((s) => s.text)
  if (ours.length !== theirs.length) {
    throw new Error(
      `对齐校验失败：本地分词 ${ours.length} 个词，引擎返回 ${theirs.length} 个 segment。\n` +
        `  本地：${JSON.stringify(ours)}\n  引擎：${JSON.stringify(theirs)}`,
    )
  }
  for (let i = 0; i < ours.length; i++) {
    const a = normalizeToken(ours[i] ?? '')
    const b = normalizeToken(theirs[i] ?? '')
    if (a !== b) {
      throw new Error(
        `对齐校验失败：第 ${i} 个词不一致 —— 本地 ${JSON.stringify(ours[i])}` +
          `（归一化 ${JSON.stringify(a)}），引擎 ${JSON.stringify(theirs[i])}` +
          `（归一化 ${JSON.stringify(b)}）`,
      )
    }
  }
  for (const s of alignment.segments) {
    if (!(s.end >= s.start)) {
      throw new Error(`对齐校验失败：词 ${JSON.stringify(s.text)} 的 end < start`)
    }
  }
}

/** 一段 SSE 原文 → 音频 + 对齐（纯函数，便于单测） */
export function parseSse(raw: string): { audio: Buffer; alignment: Alignment } {
  const chunks: Buffer[] = []
  let alignment: Alignment | null = null
  let sawEvent = false

  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
    if (dataLines.length === 0) continue
    const payload = dataLines.join('\n')
    if (payload === '' || payload === '[DONE]') continue

    let evt: {
      audio_base64?: string
      alignment?: { segments?: AlignmentSegment[]; audio_duration?: number } | null
    }
    try {
      evt = JSON.parse(payload) as typeof evt
    } catch {
      // 非 JSON 的 data 行（例如心跳）直接跳过，不让它毁掉整次合成
      continue
    }
    sawEvent = true

    if (evt.audio_base64) chunks.push(Buffer.from(evt.audio_base64, 'base64'))

    // ⚠️ 累积语义：留最后一个非 null 的
    if (evt.alignment?.segments) {
      alignment = {
        segments: evt.alignment.segments,
        audioDuration: evt.alignment.audio_duration ?? 0,
      }
    }
  }

  if (!sawEvent) throw new Error('fish-audio 没有返回任何 SSE 事件')
  if (chunks.length === 0) throw new Error('fish-audio 返回了事件，但没有音频块')
  if (!alignment) {
    throw new Error(
      'fish-audio 没有返回 alignment —— 没有词级时间戳就没法切片。' +
        '检查 FISH_MODEL 是否支持时间戳（s1 / s2-pro 系列才给）。',
    )
  }

  // ⚠️ 顺序 = 到达顺序，不排序（chunk_seq 恒为 0，排序等于随机）
  return { audio: Buffer.concat(chunks), alignment }
}

function cacheKeyOf(text: string, model: string): string {
  return createHash('sha1').update(`${model}\n${text}`).digest('hex')
}

/**
 * 合成一句话。
 *
 * @param text - 要朗读的英文；必须与 content/articles/*.json 里的 text 一致
 * @param opts.cache - 默认 true。同文本 + 同模型直接读盘，不再请求引擎
 */
export async function synthesize(
  text: string,
  opts: { cache?: boolean; assert?: boolean } = {},
): Promise<Synthesis> {
  const env = readEnv()
  const useCache = opts.cache ?? true
  const key = cacheKeyOf(text, env.model)
  const audioPath = resolve(CACHE_DIR, `${key}.mp3`)
  const alignPath = resolve(CACHE_DIR, `${key}.json`)

  if (useCache && existsSync(audioPath) && existsSync(alignPath)) {
    return {
      audio: await readFile(audioPath),
      alignment: JSON.parse(await readFile(alignPath, 'utf8')) as Alignment,
      text,
      cached: true,
    }
  }

  const raw = await requestSse(env, text)
  const { audio, alignment } = parseSse(raw)
  if (opts.assert ?? true) assertAlignment(text, alignment)

  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(audioPath, audio)
  await writeFile(alignPath, JSON.stringify(alignment, null, 2))

  return { audio, alignment, text, cached: false }
}

/**
 * 把代理地址归一化成 **socks5h**（由代理解析域名）。
 *
 * ⚠️⚠️ 这一步不是洁癖，是**必须的**：实测本机 `socks5://` 会在 TLS 握手前
 *    被 reset（`Client network socket disconnected before secure TLS
 *    connection was established`），换成 `socks5h://` 立刻 200。
 *    差别只有一处：socks5 让**本机**解析域名，socks5h 让**代理**解析。
 *    本机 DNS 拿不到 api.fish.audio（直连也是超时），所以必须走 socks5h。
 *    等价于 curl 的 `--socks5-hostname`。
 *
 * ⚠️ 所以 .env.local 里写 `socks5://` 是对的、不用改 —— 由这里统一纠正。
 */
function normalizeProxy(raw: string): string {
  if (raw.startsWith('socks5://')) return `socks5h://${raw.slice('socks5://'.length)}`
  return raw
}

/** 真正的网络调用 —— 只有这一处碰网 */
function requestSse(env: FishEnv, text: string): Promise<string> {
  const url = new URL(`${env.baseUrl}/v1/tts/stream/with-timestamp`)
  const body = JSON.stringify({ text })

  // ⚠️ Node 的 fetch 不认 socks5，所以走 node:https + agent
  const agent = env.proxy ? new SocksProxyAgent(normalizeProxy(env.proxy)) : undefined

  return new Promise<string>((res, rej) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        agent,
        headers: {
          Authorization: `Bearer ${env.key}`,
          'Content-Type': 'application/json',
          model: env.model,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (resp) => {
        const status = resp.statusCode ?? 0
        const chunks: Buffer[] = []
        resp.on('data', (c: Buffer) => chunks.push(c))
        resp.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if (status !== 200) {
            rej(
              new Error(
                `fish-audio 返回 ${status}：${raw.slice(0, 400)}\n` +
                  `（402 = 额度用尽；401/403 = key 不对；超时请检查 FISH_PROXY_URL）`,
              ),
            )
            return
          }
          res(raw)
        })
      },
    )

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error(`fish-audio 超过 ${TIMEOUT_MS / 1000}s 没有返回`))
    })
    req.on('error', rej)
    req.write(body)
    req.end()
  })
}
