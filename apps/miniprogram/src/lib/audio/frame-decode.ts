import { samplesFromByteTimeDomain } from '@jushuo/shared'

/**
 * ⭐ 把一帧「录音分片」解成**采样** —— 实时波形在 mp3 格式下唯一的出路。
 *
 * ⚠️⚠️ 为什么必须解码：format:'mp3' 时帧里装的是 **mp3 码流**，不是采样。
 *    官方文档对 frameBuffer 只写了「录音分片数据」四个字，没说编码；
 *    而这一点由那个已经跑通的实现确认了（掘金《微信小程序实现实时录音音频强度输出》，
 *    作者同样是「录 mp3 → 需要先把 mp3 转成 pcm 才能算强度」）。
 *
 * ⭐ 解法：小程序有一个兼容 Web 的 WebAudioContext（wx.createWebAudioContext()），
 *    它的 decodeAudioData 能把这段 mp3 分片直接解成采样 —— **不用自己写解码器、
 *    也不用引 js-mp3 那类库**（那篇作者试过，在现在的基础库上已经没反应了）。
 *
 * ⚠️⚠️ 它**只在真机上成立**：那篇作者实测「在微信开发者工具上直接运行都不运行了，
 *    真机上试了一下，成了」。所以这里的契约是：**解不出来就返回 null**，
 *    由调用方决定退路（按裸 PCM 读 / 干脆不画），绝不硬画。
 */

/** 只在真机上初始化得起来；初始化失败就不再重试 */
let ctx: WechatMiniprogram.WebAudioContext | null = null
let unavailable = false
/** 解码后接的那个 analyser —— 与那篇一致（getChannelData 拿不到时的退路） */
let analyser: WechatMiniprogram.AnalyserNode | null = null

function contextOf(): WechatMiniprogram.WebAudioContext | null {
  if (unavailable) return null
  if (ctx) return ctx
  try {
    if (typeof wx.createWebAudioContext !== 'function') {
      console.warn('[frame-decode] 这个环境没有 wx.createWebAudioContext，波形走不了解码这条路')
      unavailable = true
      return null
    }
    ctx = wx.createWebAudioContext()
    return ctx
  } catch (err) {
    console.warn('[frame-decode] 创建 WebAudioContext 失败：' + (err as Error).message)
    unavailable = true
    return null
  }
}

function analyserOf(c: WechatMiniprogram.WebAudioContext): WechatMiniprogram.AnalyserNode {
  if (!analyser) {
    analyser = c.createAnalyser()
    // ⚠️ 与那篇一致：2048 是时域波形的常用窗口（frequencyBinCount = fftSize / 2）
    analyser.fftSize = 2048
  }
  return analyser
}

/**
 * 解码后的 AudioBuffer → 采样。
 *
 * ⚠️ 先试 getChannelData（最直接：拿到的就是 Float32 采样），
 *    拿不到再退回「接 analyser 读时域数据」那条路 —— 后者是那篇里验证过的写法，
 *    但它要新建一个 BufferSourceNode，代价更大。
 * ⚠️ 那句 source.connect(analyser) **不要**改成 connect(destination)：
 *    接 destination 会**边录边外放**（那篇作者试过），而这里只想读振幅。
 */
function samplesOfBuffer(
  c: WechatMiniprogram.WebAudioContext,
  buffer: WechatMiniprogram.AudioBuffer,
): Float32Array | null {
  try {
    const data = buffer.getChannelData(0)
    if (data && data.length > 0) return data
  } catch {
    // 落到下面的 analyser 方案
  }

  try {
    const source = c.createBufferSource()
    source.buffer = buffer
    const an = analyserOf(c)
    source.connect(an)
    source.start()
    const bytes = new Uint8Array(an.frequencyBinCount)
    an.getByteTimeDomainData(bytes)
    return samplesFromByteTimeDomain(bytes)
  } catch (err) {
    console.warn('[frame-decode] 从 AudioBuffer 取采样失败：' + (err as Error).message)
    return null
  }
}

/**
 * 解一帧 → 采样（-1..1）。**任何失败都返回 null**，不抛。
 *
 * ⚠️ 超时兜底不能省：开发者工具里 decodeAudioData 可能**永远不回调**
 *    （那篇作者的原文是「在微信开发者工具上直接运行都不运行了」）。
 *    没有超时，波形就会停在「正在准备」上，而看不出是环境不支持。
 */
export function decodeFrameToSamples(
  frame: ArrayBuffer,
  timeoutMs = 1500,
): Promise<Float32Array | null> {
  const c = contextOf()
  if (!c) return Promise.resolve(null)

  return new Promise<Float32Array | null>((resolve) => {
    let settled = false
    const done = (v: Float32Array | null) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const timer = setTimeout(() => {
      console.warn('[frame-decode] 解码超时（这个环境可能不支持 decodeAudioData）')
      done(null)
    }, timeoutMs)

    try {
      c.decodeAudioData(
        frame,
        (buffer) => {
          clearTimeout(timer)
          done(samplesOfBuffer(c, buffer))
        },
        (err) => {
          clearTimeout(timer)
          console.warn('[frame-decode] decodeAudioData 失败：' + JSON.stringify(err ?? null).slice(0, 120))
          done(null)
        },
      )
    } catch (err) {
      clearTimeout(timer)
      console.warn('[frame-decode] decodeAudioData 抛异常：' + (err as Error).message)
      done(null)
    }
  })
}
