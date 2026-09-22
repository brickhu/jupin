/**
 * ⭐ 只认 magic 判断「这一堆字节到底是什么容器」—— 不猜、不看后缀。
 *
 * ⚠️⚠️ 为什么它必须放在 shared（而不是服务端自己一份、小程序再抄一份）：
 *    同一段字节会被**两端**各判一次 —— 服务端判「要不要拿 ffmpeg 解码」，
 *    小程序判「这几声是采样还是编码后的码流，能不能画成波形」。
 *    两份判据各自演化的话，会出现「服务端解得开、客户端却认定它不能画」这种
 *    谁也说不清的状态。
 *
 * ⚠️ 默认值是 `raw-pcm`：真机链路 `format:'PCM'` 直出无头裸 PCM，
 *    这是**唯一**「没有任何 magic」的情况，所以只能把它当兜底。
 *    其余签名（EBML / RIFF / OggS / fLaC / ID3 / ftyp / MPEG 同步）都极不可能
 *    出现在裸 PCM 开头（那几个字节必须恰好拼成一个负数样本、且拼成这些 ASCII）。
 *
 * ⚠️ 唯一有真实误判风险的是**裸 MPEG 帧同步**（`FF Ex`）——
 *    裸 PCM 里一个 ≤ -8192 的样本就会长这样。
 *    所以还会校验**后续字节里的位率/采样率索引**，把 `FF FF 00`（PCM 的 -1, 0）挡掉。
 *    ⛔ 不要退回「只要前两字节是 FF Ex 就算 mp3」那种写法：
 *       实测它会把约 **12%** 的正常 PCM 帧误判成压缩块（首样本落在 -7937..-1 就命中），
 *       表现是真机上八分之一的录音**无故没有波形**。
 *
 * ⚠️ 残余风险如实记录：`FF FF 10` 这类字节串既能当 PCM（-1, 16）也能通过 mp3 的字段校验，
 *    单凭前几字节**分不开**。真正可行的判据是「后面还有没有第二个帧同步」，
 *    但那需要完整的位率/采样率表，收益不抵复杂度。
 *    这里选择接受这个风险 —— 因为它的失败方式是**报一个清晰的解码错误**，
 *    而不是静默地把一次正常录音毁掉；且实际录音以近似静音开头，首样本为 0xFFFF 的概率极低。
 */
export type AudioContainer =
  | 'raw-pcm'
  | 'wav'
  | 'webm'
  | 'ogg'
  | 'mp4'
  | 'mp3'
  | 'aac'
  | 'flac'

function ascii(bytes: Uint8Array, offset: number, len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[offset + i] as number)
  return s
}

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