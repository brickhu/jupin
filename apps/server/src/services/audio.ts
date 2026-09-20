import { spawn } from 'node:child_process'
import { AUDIO_SPEC } from '@jushuo/shared'

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

/** 上传内容的容器类型 —— 只认 magic，不猜 */
export type AudioContainer =
  | 'raw-pcm'
  | 'wav'
  | 'webm'
  | 'ogg'
  | 'mp4'
  | 'mp3'
  | 'aac'
  | 'flac'

/** 16kHz / 16bit / 单声道下每秒的字节数 —— 时长与字节数之间的唯一换算系数 */
export const PCM_BYTES_PER_SEC =
  (AUDIO_SPEC.sampleRate * AUDIO_SPEC.channels * AUDIO_SPEC.bitDepth) / 8

function ascii(bytes: Uint8Array, offset: number, len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[offset + i] as number)
  return s
}

/**
 * 判断上传的字节到底是什么容器。
 *
 * ⚠️ 默认值是 `raw-pcm`：真机链路 `format:'PCM'` 直出无头裸 PCM，
 *    这是**唯一**「没有任何 magic」的情况，所以只能把它当兜底。
 *    其余签名（EBML / RIFF / OggS / ID3 / ftyp / fLaC）都极不可能出现在裸 PCM 开头
 *    （那几个字节必须恰好拼成一个负数样本且拼成这些 ASCII，概率可忽略）。
 *
 * ⚠️ 唯一有真实误判风险的是**裸 MPEG 帧同步**（`FF Ex`）——
 *    裸 PCM 里一个 ≤ -8192 的样本就会长这样。
 *    所以还会校验**后续字节里的位率/采样率索引**，把 `FF FF 00`（PCM 的 -1, 0）挡掉。
 *
 * ⚠️ 残余风险如实记录：`FF FF 10` 这类字节串既能当 PCM（-1, 16）也能通过 mp3 的字段校验，
 *    单凭前几字节**分不开**。真正可行的判据是「后面还有没有第二个帧同步」，
 *    但那需要完整的位率/采样率表，收益不抵复杂度。
 *    这里选择接受这个风险 —— 因为它的失败方式是**报一个清晰的解码错误**，
 *    而不是静默地把一次正常录音毁掉；且实际录音以近似静音开头，首样本为 0xFFFF 的概率极低。
 */
export function sniffAudioContainer(bytes: Uint8Array): AudioContainer {
  if (bytes.length >= 8) {
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return 'webm' // EBML → WebM / Matroska（开发者工具走这条）
    }
    const head4 = ascii(bytes, 0, 4)
    if (head4 === 'RIFF') return 'wav'
    if (head4 === 'OggS') return 'ogg'
    if (head4 === 'fLaC') return 'flac'
    if (ascii(bytes, 0, 3) === 'ID3') return 'mp3'
    if (ascii(bytes, 4, 4) === 'ftyp') return 'mp4'
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && ((bytes[1] as number) & 0xe0) === 0xe0) {
    const b1 = bytes[1] as number
    const b2 = bytes[2] as number

    // ① ADTS AAC：layer 字段恒为 00，b1 ∈ {F0, F1, F8, F9}
    if ((b1 & 0xf6) === 0xf0) {
      const rateIndex = (b2 >> 2) & 0x0f
      if (rateIndex <= 12) return 'aac'
    } else {
      // ② MPEG 音频（mp3）：版本与层都不能是保留值，位率索引必须有效（0=free，15=非法）
      const version = (b1 >> 3) & 0x03
      const layer = (b1 >> 1) & 0x03
      const bitrateIndex = (b2 >> 4) & 0x0f
      const rateIndex = (b2 >> 2) & 0x03
      if (
        version !== 1 &&
        layer !== 0 &&
        bitrateIndex >= 1 &&
        bitrateIndex <= 14 &&
        rateIndex <= 2
      ) {
        return 'mp3'
      }
    }
  }

  return 'raw-pcm'
}

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
