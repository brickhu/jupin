/**
 * ⭐ 一帧 PCM 的响度 —— 录音条上那排声波柱子靠它。
 *
 * ⚠️ 输出是**0..1 的归一化值**，不是物理量：
 *    调用方只需要"画多高"，任何以 dBFS 或振幅为单位的返回值都会逼着
 *    页面自己去定标（而页面里没有、也不该有音频常识）。
 *
 * ⚠️⚠️ 用的是 **RMS（均方根）**，不是峰值。
 *    峰值会让每一帧都被个别采样点拉满 —— 那排柱子会一直顶格、看不出在说话，
 *    看起来像"坏了"。RMS 才对应人耳感知的响度。
 */

/**
 * 显示区间（dBFS）。
 *
 * ⚠️ 为什么不铺满整个 -96..0：
 *    安静房间的底噪大约在 -60 上下，正常人说话在 -30 ~ -10。
 *    铺满全程的话，说话只占柱子的 1/5 高度，看着像没反应；
 *    而 -8 以上已经是削顶的级别，留一段空档避免"一直在顶格"。
 */
const FLOOR_DB = -55
const CEIL_DB = -8

/**
 * 视觉曲线：把归一化值再开一次方。
 *
 * ⚠️ 这不是"美化"，是补偿：dB 是对数量纲，线性映射到高度之后，
 *    轻声说话那段（-50 ~ -35）会被压成几乎一样高的矮柱子 ——
 *    而那正是用户最需要看到反馈的音量区间。
 */
const CURVE = 0.75

/** 16bit 有符号 PCM 的满量程 */
const FULL_SCALE = 32768

/**
 * @param pcm 归一化后的 PCM（16bit **小端** 单声道）—— 与 Recorder.emit 的输出一致。
 * @returns 0（静音）~ 1（接近满量程）
 */
export function pcmLevel(pcm: ArrayBuffer | Uint8Array): number {
  const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm)
  const samples = bytes.byteLength >> 1
  // 半帧都凑不出来（设备给了奇数长度，或干脆是空帧）→ 当作静音，不要抛
  if (samples === 0) return 0

  const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2)
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const v = view.getInt16(i * 2, true)
    sum += v * v
  }
  const rms = Math.sqrt(sum / samples)
  // 全静音时 log(0) 是 -Infinity —— 早退掉，别让 -Infinity 流进后续的钳位
  if (rms < 1) return 0

  const dbfs = 20 * Math.log10(rms / FULL_SCALE)
  const norm = (dbfs - FLOOR_DB) / (CEIL_DB - FLOOR_DB)
  return Math.pow(Math.min(1, Math.max(0, norm)), CURVE)
}
