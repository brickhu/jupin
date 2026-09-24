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
 *   ② **`alignment` 是「块内累积、块间重置」的** —— ⚠️⚠️ 这条被 2026-09 的一次真实内容推翻过：
 *      短句只有一个块（块内累积 ⇒ 最后一块最全）；**长句引擎会切成多块，新块从第 1 段重新数**，
 *      于是「保留最后一个非 null」只拿到最后一块的段。
 *      实测（49 词那条）：chunk1 累积到 40 段（The…argued），chunk2 又从 1 段数到 14 段
 *      ⇒ 症状是「对齐校验失败：本地分词 49 个词，引擎返回 14 个 segment」。
 *      现在按「是不是上一块的延续」分块，再把各块按**块时长偏移**拼成全局时间轴。
 *
 *   ②b **连字符会被引擎拆开**：subsistence-oriented → 2 段、market-driven → 2 段、
 *      historians-turned-sociologists → 3 段、multi-directional → 2 段；
 *      而 shared 的 `plainWordsOf` **不拆**（它只按空白切）。
 *      ⇒ 「逐项相等」根本不成立，要按**本地词消费引擎段**（用 '-' 拼起来能对上就算），
 *        见 alignToWords。
 *
 *   ③ `segments[].text` 与**空格分词**的关系是「本地一个词 = 引擎 1…N 段」（见 ②b）——
 *      这与 plainWordsOf / 词表 / 逐词上色共用同一条规则。spec 第九节要求
 *      「必须与自建词表逐项一致」：本文件用 alignToWords 把这个假设变成
 *      **一条会炸的断言 + 一个「一个词一段」的规范结果**，而不是一个静默的错位。
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
import { plainWordsOf } from '@jushuo/shared'

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
  /** 本次用的音色（清单要记它，否则换音色后没人知道音频是谁念的） */
  voiceId: string
  /** 「这份音频是怎么来的」指纹 —— 落进 content/audio/manifest.json，见 fingerprintOf */
  fingerprint: string
}

/** 缓存目录 —— 同一段文本重跑不该再烧一次额度（README 的硬要求） */
const CACHE_DIR = resolve(ROOT, 'tools/pipeline/data/cache/fishaudio')

/** 默认模型。⚠️ 免费额度走的就是这个；换模型改 FISH_MODEL 即可，不用动代码 */
const DEFAULT_MODEL = 's2.1-pro-free'

/**
 * ⭐ 默认**音色** —— fish-audio 的 `reference_id`（在 fish.audio 上训练/收藏的音色 id）。
 *
 * ⚠️ 它和模型不一样，是**产品决定**，所以写死在代码里而不是只放本机 .env：
 *    换音色 = 全库标准音的音色一起换，必须是可评审、可回滚、跨环境一致的一处改动。
 *    临时试音色用 FISH_VOICE_ID 覆盖，别改这里。
 * ⚠️ 不传 reference_id 时引擎会用它自己当前推荐的默认音色 ——
 *    那等于把「我们的内容是什么声音」交给对方随时改，所以必须显式传。
 */
const DEFAULT_VOICE_ID = 'b347db033a6549378b48d00acb0d06cd'

const DEFAULT_BASE_URL = 'https://api.fish.audio'

/** 单次合成的总超时 —— 免费额度偶尔排队，给宽松一点 */
const TIMEOUT_MS = 120_000

interface FishEnv {
  key: string
  proxy: string | undefined
  baseUrl: string
  model: string
  /** 音色（reference_id） */
  voiceId: string
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
    voiceId: process.env.FISH_VOICE_ID || DEFAULT_VOICE_ID,
  }
}

/**
 * ⭐ 对齐校验 —— spec 第九节的硬要求，这里让它**会炸**。
 *
 * ⚠️⚠️ 实测出来的两条规则（2026-09 用真实内容 dump，见文件头 ②/②b）：
 *    ① 引擎**剥掉词首/词尾的标点**："it." → "it"、"fatal:" → "fatal"（词数不变）；
 *    ② 引擎**把连字符拆开**："subsistence-oriented" → "subsistence" + "oriented"、
 *       "historians-turned-sociologists" → 3 段 —— 而 plainWordsOf **不拆**，词数会变多。
 *    ⇒ 所以不能逐项比对：得**按本地词去消费引擎段**（本地一个词吃掉 1…N 段，
 *      用 '-' 拼起来能对上就算），吃完必须一段不剩。
 *
 * ⚠️ 归一化**保留内部连字符与撇号**：don't / well-known 是词内的东西，不能被剥掉。
 */
function normalizeToken(w: string): string {
  return w.replace(/^[^\p{L}\p{N}']+/u, '').replace(/[^\p{L}\p{N}']+$/u, '')
}

/**
 * 把引擎段对齐到**本地词**上：返回「一个本地词一段」的合并结果
 * （连字符被拆开的那些段合并回来，取首段的 start、末段的 end）。
 *
 * ⚠️ 对不上就**抛** —— 这是「静默错位」的唯一出口。
 * ⚠️ 返回值的不变量：`segments.length === plainWordsOf(text).length`，
 *    下游（连读否决）可以直接按词下标取用。
 * ⚠️ `text` 用**本地词**（"days," 而不是 "days"）—— 它只是给人看的，
 *    时间轴才是下游要的。
 */
export function alignToWords(text: string, segments: AlignmentSegment[]): AlignmentSegment[] {
  const words = plainWordsOf(text)
  const out: AlignmentSegment[] = []
  let i = 0
  for (const w of words) {
    const parts = normalizeToken(w).split('-').filter(Boolean)
    if (parts.length === 0) {
      // 纯符号 token（"—" / "--"）：没有可发音的内容，给一个零长度的点，不吃引擎段
      const at = out.length > 0 ? out[out.length - 1]!.end : (segments[0]?.start ?? 0)
      out.push({ text: w, start: at, end: at })
      continue
    }
    const group: AlignmentSegment[] = []
    for (const part of parts) {
      const s = segments[i]
      if (!s || normalizeToken(s.text) !== part) {
        throw new Error(
          `对齐校验失败：本地第 ${out.length} 个词 ${JSON.stringify(w)} 需要引擎段 ` +
            `${JSON.stringify(part)}，实际拿到 ${JSON.stringify(s?.text ?? null)}（第 ${i} 段）。\n` +
            `  本地：${JSON.stringify(words)}\n  引擎：${JSON.stringify(segments.map((x) => x.text))}`,
        )
      }
      group.push(s)
      i++
    }
    out.push({ text: w, start: group[0]!.start, end: group[group.length - 1]!.end })
  }
  if (i !== segments.length) {
    throw new Error(
      `对齐校验失败：本地分词 ${words.length} 个词，引擎返回 ${segments.length} 个 segment` +
        `（本地吃完还剩 ${segments.length - i} 段）。\n` +
        `  本地：${JSON.stringify(words)}\n  引擎：${JSON.stringify(segments.map((x) => x.text))}`,
    )
  }
  for (const s of segments) {
    if (!(s.end >= s.start)) {
      throw new Error(`对齐校验失败：词 ${JSON.stringify(s.text)} 的 end < start`)
    }
  }
  return out
}

/** 一段 SSE 原文 → 音频 + 对齐（纯函数，便于单测） */
export function parseSse(raw: string): { audio: Buffer; alignment: Alignment } {
  const chunks: Buffer[] = []
  /** 各块的对齐（块内累积、块间重置 —— 见文件头 ②）；cur = 当前这一块 */
  const groups: Alignment[] = []
  let cur: Alignment | null = null
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

    // ⚠️ 块内累积、块间重置（见文件头 ②）—— 不是「留最后一个」那么简单
    if (evt.alignment?.segments) {
      const next: Alignment = {
        segments: evt.alignment.segments,
        audioDuration: evt.alignment.audio_duration ?? 0,
      }
      // 同一块内新的一定以旧的为前缀；否则就是**新块的开始**
      if (cur && isPrefixOf(cur.segments, next.segments)) cur = next
      else {
        if (cur) groups.push(cur)
        cur = next
      }
    }
  }
  if (cur) groups.push(cur)

  if (!sawEvent) throw new Error('fish-audio 没有返回任何 SSE 事件')
  if (chunks.length === 0) throw new Error('fish-audio 返回了事件，但没有音频块')
  if (groups.length === 0) {
    throw new Error(
      'fish-audio 没有返回 alignment —— 没有词级时间戳就没法切片。' +
        '检查 FISH_MODEL 是否支持时间戳（s1 / s2-pro 系列才给）。',
    )
  }

  // ⚠️ 顺序 = 到达顺序，不排序（chunk_seq 恒为 0，排序等于随机）
  return { audio: Buffer.concat(chunks), alignment: stitchAlignments(groups) }
}

/** b 是否以 a 为前缀（同一块内 alignment 是累积的，所以后一个一定以它开头） */
function isPrefixOf(a: AlignmentSegment[], b: AlignmentSegment[]): boolean {
  if (a.length > b.length) return false
  return a.every((s, i) => s.text === b[i]!.text)
}

/**
 * ⭐ 把各块的对齐拼成**一条全局时间轴**。
 *
 * ⚠️ 每块的 start/end 都从 0 秒重新开始（实测：chunk2 的第一个事件 dur=0.93，
 *    和 chunk1 一样）⇒ 后一块必须加上**前面所有块的时长**。
 * ⚠️ 用块自己的 audio_duration 做偏移：它也是块内累积的，最后一块给出该块的总时长
 *    （实测两块 20.43s + 8.27s ≈ 音频 28.7s，与 mp3 体积吻合）。
 */
function stitchAlignments(groups: Alignment[]): Alignment {
  const segments: AlignmentSegment[] = []
  let offset = 0
  for (const g of groups) {
    for (const s of g.segments) {
      segments.push({ text: s.text, start: s.start + offset, end: s.end + offset })
    }
    offset += g.audioDuration
  }
  return { segments, audioDuration: offset }
}

/**
 * ⚠️⚠️ 缓存键必须**带上音色**：只按 model+text 缓存的话，换了音色重跑会直接
 *    命中旧音频 —— 表现是「改了音色却什么都没变」，不报错、只能靠人听出来。
 */
/**
 * 清单指纹 —— 记「这份音频是谁生成的」。
 *
 * ⚠️ 前缀 fish: 有用途：另一个生产者（tools/build-content-audio.ts 的 macOS say，
 *    离线兜底用）靠它认出「这不是我的产物，别覆盖」—— 否则改一句正文再跑
 *    content:audio，全库音色就会被悄悄换掉一部分。
 */
export function fingerprintOf(text: string, model: string, voiceId: string): string {
  return `fish:${model}:${voiceId}:${createHash('sha1').update(text).digest('hex').slice(0, 16)}`
}

function cacheKeyOf(text: string, model: string, voiceId: string): string {
  return createHash('sha1').update(`${model}\n${voiceId}\n${text}`).digest('hex')
}

/**
 * 合成一句话。
 *
 * @param text - 要朗读的英文；必须与 content/articles/*.json 里的 text 一致
 * @param opts.cache - 默认 true。同文本 + 同模型直接读盘，不再请求引擎
 */
export async function synthesize(
  text: string,
  opts: { cache?: boolean } = {},
): Promise<Synthesis> {
  const env = readEnv()
  const useCache = opts.cache ?? true
  const key = cacheKeyOf(text, env.model, env.voiceId)
  const fingerprint = fingerprintOf(text, env.model, env.voiceId)
  const audioPath = resolve(CACHE_DIR, `${key}.mp3`)
  const alignPath = resolve(CACHE_DIR, `${key}.json`)

  if (useCache && existsSync(audioPath) && existsSync(alignPath)) {
    return {
      audio: await readFile(audioPath),
      alignment: JSON.parse(await readFile(alignPath, 'utf8')) as Alignment,
      text,
      cached: true,
      voiceId: env.voiceId,
      fingerprint,
    }
  }

  const raw = await requestSse(env, text)
  const { audio, alignment } = parseSse(raw)
  /**
   * ⭐ 落缓存 / 返回的都是**对齐到本地词**的版本（一个词一段）：
   *    引擎那边连字符是拆开的（见文件头 ②b），原样存下去，下游按词下标取用时就会错位。
   *    ⚠️ 对不上会在这里**抛** —— 这是「静默错位」的唯一出口。
   *    ⚠️ 老缓存里存的是引擎原始分段（那时还没有连字符拆分与分块这两件事），
   *       只在校验通过后才写盘，所以短句的老缓存读出来仍是「一词一段」。
   */
  const aligned: Alignment = {
    segments: alignToWords(text, alignment.segments),
    audioDuration: alignment.audioDuration,
  }

  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(audioPath, audio)
  await writeFile(alignPath, JSON.stringify(aligned, null, 2))

  return { audio, alignment: aligned, text, cached: false, voiceId: env.voiceId, fingerprint }
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
  // ⚠️ reference_id = 音色（见文件头的 DEFAULT_VOICE_ID）；不传就是「对方的默认音色」
  const body = JSON.stringify({ text, reference_id: env.voiceId })

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
