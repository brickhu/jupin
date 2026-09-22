import { spawn } from 'node:child_process'
import { AUDIO_SPEC, sniffAudioContainer } from '@jushuo/shared'
import type { AudioContainer } from '@jushuo/shared'

/**
 * ⚠️ `sniffAudioContainer` / `AudioContainer` 的**实现在 @jushuo/shared 里**
 *    （packages/shared/src/audio/sniff.ts）—— 小程序那边要用同一份判据
 *    判断「手里的帧能不能画成波形」（见朗读页的帧分类）。
 *    这里只是**转出去**，好让本服务的其它文件继续 `from './audio'` 取用，
 *    同时保证两端永远只有一份实现。
 */
export { sniffAudioContainer }
export type { AudioContainer }

/**
 * ⭐ 音频归一化 —— 把「上传上来的任何东西」变成讯飞要的 16kHz / 16bit / 单声道裸 PCM。
 *
 * ⚠️⚠️ 这个文件存在的理由是一次**真实的误判**：
 *    开发者工具录音时，`onFrameRecorded` 给的帧确实是压缩块（过零率 ≈0.50），
 *    于是被判定为「工具给的不是可用音频」。
 *    但**落盘文件完全相反** —— 它是一段货真价实的麦克风录音，
 *    只是装在 WebM/Opus 容器里（实测：8.82 秒，RMS -27dB，过零率 0.156 = 标准语音）。
 *
 *    结果就是：服务端拿 WebM 容器当裸 PCM 喂给讯飞 → 分数必然垃圾或直接报错。
 *    「本地录音 → 提交打分」跑不通，根因只在这一处。
 *
 * ⭐ 修法刻意放在**服务端**而不是小程序端：
 *    设备到底产出什么格式，客户端说了不算 —— 同一份代码，
 *    真机直出裸 PCM，开发者工具直出 WebM，将来还可能出 mp3。
 *    在唯一能装解码器的地方（服务端）统一归一化，
 *    整条链路对「设备给了什么」就彻底免疫了。
 */

/** 16kHz / 16bit / 单声道下每秒的字节数 —— 时长与字节数之间的唯一换算系数 */
export const PCM_BYTES_PER_SEC =
  (AUDIO_SPEC.sampleRate * AUDIO_SPEC.channels * AUDIO_SPEC.bitDepth) / 8


export interface NormalizedAudio {
  /** 16kHz / 16bit / 单声道裸 PCM —— 直接可喂讯飞 */
  pcm: Uint8Array
  /** 上传内容的原始容器类型（只用于日志与排查） */
  container: AudioContainer
  /** 是否真的解码过（false = 本来就是裸 PCM） */
  transcoded: boolean
}

/**
 * 归一化入口。
 *
 * ⚠️ 裸 PCM 原样返回（同一个引用）—— 真机链路一字节都不多花。
 * ⚠️ 其余容器一律交给 ffmpeg 解码 + 重采样。
 */
export async function normalizeAudio(bytes: Uint8Array): Promise<NormalizedAudio> {
  const container = sniffAudioContainer(bytes)
  if (container === 'raw-pcm') return { pcm: bytes, container, transcoded: false }

  const pcm = await decodeToPcm16k(bytes)
  if (pcm.length === 0) {
    throw new Error(`音频解码后为空（容器识别为 ${container}，输入 ${bytes.byteLength} 字节）`)
  }
  return { pcm, container, transcoded: true }
}

/**
 * 用 ffmpeg 解码 + 重采样成 16kHz/16bit/单声道。
 *
 * ⚠️ 走 stdin/stdout 管道，不落临时文件 —— 音频最大也就几 MB，没必要碰磁盘。
 * ⚠️ 镜像里必须有 ffmpeg（见 apps/server/Dockerfile）；缺了会给出**指名道姓**的报错，
 *    而不是让人去猜「读取音频失败」是哪儿的问题。
 */
export function decodeToPcm16k(input: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', 'pipe:0',
        '-f', 's16le',
        '-ac', String(AUDIO_SPEC.channels),
        '-ar', String(AUDIO_SPEC.sampleRate),
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
      reject(
        new Error(
          `无法执行 ffmpeg（服务端镜像需要装 ffmpeg）: ${err.message}`,
        ),
      )
    })
    // ⚠️ 输入是坏数据时 ffmpeg 会提前退出并关掉 stdin，此时 write 会 EPIPE ——
    //    这不是失败原因（真正的失败原因在 exit code 和 stderr），忽略它
    proc.stdin.on('error', () => {})
    proc.on('close', (code) => {
      if (code === 0) resolve(new Uint8Array(Buffer.concat(chunks)))
      else reject(new Error(`ffmpeg 解码失败（exit ${code}）：${stderr.trim().slice(0, 200)}`))
    })

    proc.stdin.end(Buffer.from(input))
  })
}
