import { spawn } from 'node:child_process'
import { AUDIO_SPEC, STORED_AUDIO_FALLBACK } from '@jushuo/shared'
import type { SubmissionAudioRef } from '@jushuo/shared'

import { env } from '../env'
import { fileIdOf, getStorage } from '../storage'
import type { ObjectStorage } from '../storage'
import { normalizeAudio, sniffAudioContainer } from './audio'
import type { AudioContainer } from './audio'

/**
 * ⭐ 用户录音的**存与放** —— 全站只有这一处。
 *
 * 三个事实决定了它长什么样：
 *
 *  ① **客户端录的就是压缩格式**（微信接口的默认 format = aac，见 RECORD_SPEC）。
 *     ⇒ 上传上来的那份**本身就是存档**：既不用转码，也不用再存一份，
 *       省存储和带宽是同一个动作（20 秒 ≈ 120KB，裸 PCM 是 640KB）。
 *  ② 但**历史遗留**还在：老客户端录的是裸 PCM，开发者工具给的是 WebM。
 *     ⇒ 这些才需要服务端补一道：打分时已经解码出 16k PCM 了，
 *       顺手编一份 mp3 存下来、把原件删掉（见 archiveRecording）。
 *  ③ **播放要能直接响**：aac / mp3 在真机与模拟器的 InnerAudioContext 上都原生可播，
 *     所以「放」这一侧几乎不需要转码 —— 只有遗留格式才转一次。
 *
 * ⚠️ 打分**不受格式影响**：引擎喂的是服务端解码出来的 16k PCM
 *    （mp3 / aac / webm / 裸 PCM 实测都能解，见 services/audio.ts）。
 */

/** 能直接被播放器播的存档扩展名 —— 命中就一字节都不动地交出去 */
const PLAYABLE_EXTS = ['mp3', 'm4a', 'aac', 'wav']

/**
 * 容器 → MIME。
 * ⚠️ 不做成通用表，只覆盖我们真的会存下来的几种；
 *    写错 MIME 的症状是「音频下下来了但播不出声」，而它看起来像文件本身坏了。
 */
function mimeOfContainer(container: AudioContainer): string {
  if (container === 'mp3') return 'audio/mpeg'
  if (container === 'aac') return 'audio/aac'
  if (container === 'mp4') return 'audio/mp4'
  if (container === 'wav') return 'audio/wav'
  if (container === 'ogg') return 'audio/ogg'
  return 'application/octet-stream'
}

function extOf(key: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(key)
  return m ? (m[1] as string).toLowerCase() : ''
}

/** 这份存档是不是已经可以直接播（不需要转码） */
export function isStoredPlayable(key: string): boolean {
  return PLAYABLE_EXTS.includes(extOf(key))
}

/** 同目录、同文件名，只把扩展名换成存档格式 —— 原件与存档**一一对应**，好排查 */
export function storedKeyOf(originalKey: string): string {
  return originalKey.replace(/\.[a-z0-9]+$/i, '') + '.' + STORED_AUDIO_FALLBACK.ext
}

/**
 * 把 16k 裸 PCM 编成 mp3。
 *
 * ⚠️ 与 decodeToPcm16k 对称：同样走 stdin/stdout 管道，不落临时文件。
 * ⚠️ 必须显式声明输入格式（-f s16le -ar -ac）：裸 PCM 没有头，ffmpeg 猜不出来。
 * ⚠️ 编码器是 libmp3lame —— Dockerfile 里那个 Alpine 的 ffmpeg 自带（已实测）。
 *    缺了会给出**指名道姓**的报错，而不是让人对着「存档失败」猜。
 */
export function encodeMp3(pcm: Uint8Array, bitrateKbps = STORED_AUDIO_FALLBACK.bitrateKbps): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 's16le',
        '-ar', String(AUDIO_SPEC.sampleRate),
        '-ac', String(AUDIO_SPEC.channels),
        '-i', 'pipe:0',
        '-c:a', 'libmp3lame',
        '-b:a', bitrateKbps + 'k',
        '-f', 'mp3',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )

    const chunks: Buffer[] = []
    let stderr = ''
    proc.stdout.on('data', (c: Buffer) => chunks.push(c))
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString()
    })
    proc.on('error', (err) => {
      reject(new Error('无法执行 ffmpeg（服务端镜像需要装带 libmp3lame 的 ffmpeg）: ' + err.message))
    })
    // ⚠️ 输入是坏数据时 ffmpeg 会提前退出并关掉 stdin，此时 write 会 EPIPE ——
    //    真正的失败原因在 exit code 和 stderr 里，忽略它
    proc.stdin.on('error', () => {})
    proc.on('close', (code) => {
      if (code === 0 && chunks.length > 0) resolve(new Uint8Array(Buffer.concat(chunks)))
      else reject(new Error('mp3 编码失败（exit ' + code + '）：' + stderr.trim().slice(0, 200)))
    })

    proc.stdin.end(Buffer.from(pcm))
  })
}

/** 整份音频（任意格式）→ 可播的 mp3 字节 */
export async function toPlayableMp3(raw: Uint8Array): Promise<Uint8Array> {
  const { pcm } = await normalizeAudio(raw)
  return encodeMp3(pcm)
}

/**
 * ⭐ 存档：把上传上来的录音转成 mp3 存下来，并**删掉原件**。
 *
 * ⚠️ 顺序是「先写新的、再删旧的」：反过来的话，中途失败就**两头都没有**。
 * ⚠️ 已经是 mp3 的（理论上不会有）直接跳过，返回 null 表示「无需改动」。
 * ⚠️ 它会抛。调用方（打分流程）必须自己兜住 ——
 *    存档是省存储的优化，绝不能因为它失败就让一次成绩变成失败。
 *
 * @returns 新的 key；无需改动时返回 null
 */
export async function archiveRecording(
  originalKey: string,
  pcm: Uint8Array,
): Promise<string | null> {
  if (!originalKey) return null
  /**
   * ⚠️⚠️ **已经是压缩格式的（aac/m4a/mp3）什么都不做**：
   *    它本身就是存档，再编一遍 mp3 是白花一次有损转码 + 多存一份 ——
   *    而现在的正式链路（RECORD_SPEC = aac）走的正是这一条。
   *    只有遗留的裸 PCM / WebM 才需要补一道（返回 null = 无需改动）。
   */
  if (isStoredPlayable(originalKey)) return null

  const key = storedKeyOf(originalKey)
  if (key === originalKey) return null

  const storage = getStorage()
  const mp3 = await encodeMp3(pcm)
  await storage.put(key, mp3)
  try {
    await storage.remove(originalKey)
  } catch (err) {
    // 删不掉只是多占一份空间，存档本身已经成功 —— 不值得让这次存档算失败
    console.warn('[recording] 原件没删掉（存档已就绪）：' + originalKey + ' ← ' + (err as Error).message)
  }
  console.log(
    '[recording] 存档 ' + originalKey + ' → ' + key + '（' + pcm.byteLength + ' → ' + mp3.byteLength + ' 字节）',
  )
  return key
}

/**
 * ⭐ 回放：拿一段存档的**可播字节**。
 *
 * ⚠️ 已经是 mp3/aac 的直接交出去 —— 老记录（裸 PCM / WebM）才转一次码。
 *    新记录永远走第一条路，播放路径上没有任何转码。
 */
export async function playableBytesOf(
  storage: ObjectStorage,
  key: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const raw = await storage.get(key)
  if (isStoredPlayable(key)) {
    /**
     * ⚠️⚠️ MIME 按**文件内容**给，不按后缀：
     *    同一个 aac 格式，Android 落盘常是 .aac（ADTS）、iOS 可能是 .m4a（MP4 容器），
     *    而我们的 key 后缀是按客户端那个文件名取的。
     *    后缀与内容不一致时，播放器（尤其 iOS）可能直接不播 —— 且不报错。
     *    sniffAudioContainer 只认 magic，正好是这里唯一可信的判据。
     */
    return { bytes: raw, mime: mimeOfContainer(sniffAudioContainer(raw)) }
  }
  return { bytes: await toPlayableMp3(raw), mime: STORED_AUDIO_FALLBACK.mime }
}

/** 云端转码副本的 key —— 一条提交一个，转一次就一直在 */
function playbackKeyOf(submissionId: string): string {
  return 'playback/' + submissionId + '.' + STORED_AUDIO_FALLBACK.ext
}

/**
 * ⭐ 给客户端一条能直接播的地址；音频不在了返回 null。
 *
 * ⚠️ 两条通道各给各的，客户端那侧只有一处分支（lib/audio/standard.ts 已经处理过）：
 *    云端给 fileID（云开发通道，**不需要配 downloadFile 合法域名**），
 *    本机给相对路径（客户端自己拼 BASE_URL）。
 * ⚠️ 云端只有**老记录**才需要那个转码副本：新记录存的就是 mp3。
 *    副本按需生成、生成后一直用 —— 不做成「打分时就转好」，
 *    因为多数人根本不会回头听，那是白花一次转码 + 上传。
 */
export async function playbackRefOf(
  submissionId: string,
  audioKey: string | null,
): Promise<SubmissionAudioRef | null> {
  if (!audioKey) return null
  const storage = getStorage()

  // 音频已经被删（失败的提交会被清掉，见 services/scoring.ts）→ 明说没有，别给死链
  if (!(await storage.exists(audioKey))) return null

  // 本机联调：由 /media/recording/:id 回吐字节（那条路由只在 STORAGE=local 时存在）
  if (env.STORAGE === 'local') return { kind: 'http', src: '/media/recording/' + submissionId }

  if (isStoredPlayable(audioKey)) return { kind: 'cloud', src: fileIdOf(audioKey) }

  const key = playbackKeyOf(submissionId)
  if (!(await storage.exists(key))) {
    await storage.put(key, await toPlayableMp3(await storage.get(audioKey)))
    console.log('[recording] 老记录的可播副本已生成 ' + key)
  }
  return { kind: 'cloud', src: fileIdOf(key) }
}