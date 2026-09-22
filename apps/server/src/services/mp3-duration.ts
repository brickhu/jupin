/**
 * ⭐ 从 MP3 字节里算时长 —— 不依赖任何外部工具。
 *
 * ⚠️⚠️ 为什么必须自己算：运行容器里没有 ffprobe / afinfo
 *    （镜像是 node:20-alpine，只有业务代码 + content/），
 *    而首页卡片要显示「这一段有多长」。所以只能读文件自己解析。
 *
 * ⚠️ 解析顺序（先精确、后退而求其次）：
 *    ① ID3v2 头要跳过 —— 不跳的话第一个帧同步字会被标签内容里的
 *       0xFF 骗到，算出来的时长会离谱（而且不会报错）。
 *    ② 第一个有效帧里若有 Xing/Info 头，里面有总帧数 ⇒ 精确时长
 *       （VBR 也只有这条路算得准）。
 *    ③ 没有 Xing 就按 CBR 估：字节数 × 8 ÷ 比特率。
 *
 * ⚠️ 算不出来返回 null（而不是 0）—— 调用方据此不显示时长，
 *    而不是给用户看一个 0:00。
 */

/** MPEG1 Layer III 的比特率表（kbps），下标就是帧头里那 4 位 */
const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
/** MPEG2 / MPEG2.5 Layer III */
const BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]

/** 采样率表：键是版本位（3 = MPEG1，2 = MPEG2，0 = MPEG2.5） */
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
}

interface FrameInfo {
  offset: number
  sampleRate: number
  bitrateKbps: number
  samplesPerFrame: number
  /** 边信息长度 —— Xing 头紧跟在它后面 */
  sideInfoSize: number
}

/** 跳掉 ID3v2 标签（若有），返回音频数据的起始偏移 */
function skipId3(buf: Buffer): number {
  if (buf.length < 10) return 0
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0 // 'ID3'
  /** 大小是 4 个「同步安全」字节：每字节只用低 7 位 */
  const size =
    ((buf[6] as number) & 0x7f) * 2097152 +
    ((buf[7] as number) & 0x7f) * 16384 +
    ((buf[8] as number) & 0x7f) * 128 +
    ((buf[9] as number) & 0x7f)
  return 10 + size
}

/** 从 from 开始找第一个合法的帧头 */
function findFrame(buf: Buffer, from: number): FrameInfo | null {
  for (let i = from; i + 4 <= buf.length; i++) {
    if (buf[i] !== 0xff) continue
    const b1 = buf[i + 1] as number
    if ((b1 & 0xe0) !== 0xe0) continue // 高 3 位必须是 111（同步字）
    const versionBits = (b1 >> 3) & 0x03
    const layerBits = (b1 >> 1) & 0x03
    if (versionBits === 1 || layerBits === 0) continue // 保留值 = 这不是帧头
    if (layerBits !== 1) continue // 只认 Layer III（别的编码每帧采样数不同，别猜）
    const b2 = buf[i + 2] as number
    const bitrateIndex = (b2 >> 4) & 0x0f
    const sampleRateIndex = (b2 >> 2) & 0x03
    if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) continue
    const rates = SAMPLE_RATES[versionBits]
    const sampleRate = rates ? rates[sampleRateIndex] : undefined
    if (!sampleRate) continue
    const table = versionBits === 3 ? BITRATE_V1_L3 : BITRATE_V2_L3
    const bitrateKbps = table[bitrateIndex]
    if (!bitrateKbps) continue
    const mono = (((buf[i + 3] as number) >> 6) & 0x03) === 3
    /** 每帧采样数：Layer III 在 MPEG1 是 1152，MPEG2/2.5 是 576 */
    const samplesPerFrame = versionBits === 3 ? 1152 : 576
    /** 边信息长度（决定 Xing 头在哪）：单声道只有立体声的一半 */
    const sideInfoSize = versionBits === 3 ? (mono ? 17 : 32) : mono ? 9 : 17
    return { offset: i, sampleRate, bitrateKbps, samplesPerFrame, sideInfoSize }
  }
  return null
}

/** 读 Xing / Info 头里的总帧数（没有返回 null） */
function xingFrameCount(buf: Buffer, frame: FrameInfo): number | null {
  const p = frame.offset + 4 + frame.sideInfoSize
  if (p + 12 > buf.length) return null
  const tag = buf.toString('latin1', p, p + 4)
  if (tag !== 'Xing' && tag !== 'Info') return null
  const flags = buf.readUInt32BE(p + 4)
  if ((flags & 0x01) === 0) return null // 没有帧数这个字段
  return buf.readUInt32BE(p + 8)
}

/**
 * MP3 总时长（毫秒）；解析不出来返回 null。
 *
 * ⚠️ 只认 Layer III —— 我们自己的标准音和词音都是它。
 *    遇到别的编码会在找帧头时被判掉，宁可返回 null 也不要瞎猜。
 *
 * ⚠️ 与 ffprobe 有**约 60–70ms 的系统性差异**（实测 7 个文件一致偏高）：
 *    ffprobe 扣掉了 MP3 的编码器延迟与末尾填充（LAME 的 gapless 信息），我们没扣。
 *    ⇒ 显示到「分:秒」时完全看不出来（2.688s 与 2.624s 都是 0:03）。
 *      哪天真要精确到帧，得再去读 Xing 头后面那段 LAME 扩展。
 */
export function mp3DurationMs(buf: Buffer): number | null {
  const start = skipId3(buf)
  const frame = findFrame(buf, start)
  if (!frame) return null

  const exactFrames = xingFrameCount(buf, frame)
  if (exactFrames && exactFrames > 0) {
    return Math.round((exactFrames * frame.samplesPerFrame * 1000) / frame.sampleRate)
  }

  /** CBR 估算：从第一个帧头到文件末尾的字节数 ÷ 每秒字节数 */
  const audioBytes = buf.length - frame.offset
  if (audioBytes <= 0) return null
  const bytesPerSecond = (frame.bitrateKbps * 1000) / 8
  return Math.round((audioBytes / bytesPerSecond) * 1000)
}
