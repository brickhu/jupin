#!/usr/bin/env node
/**
 * ⭐ 把**生产参数**下的完整「有道智云 实时语音评测」返回 dump 出来，并列出字段清单。
 *
 *   npx tsx apps/server/scripts/dump-youdao.ts /tmp/probe.pcm "The best way to predict the future is to invent it."
 *
 * ⚠️ 为什么先写这个、而不是直接写引擎：本项目接讯飞时就是这么走过来的 ——
 *    厂商文档里的字段清单**不等于**真实返回（ISE 那次就踩过：文档说有的字段实际没有，
 *    真正有用的 gwpp / syll 反而要加 extra_ability 才给）。
 *    想新接一个维度，正确做法是**先把原始返回 dump 下来看一眼**。
 *
 * ⚠️ 入参是**裸 PCM**（16k / 16bit / 单声道，无 WAV 头）。
 *    容器先转：ffmpeg -i 录音.webm -ar 16000 -ac 1 -f s16le /tmp/probe.pcm
 *
 * ⚠️ 有道走的是 **WebSocket 流式**（wss://openapi.youdao.com/stream_capt），
 *    跟讯飞的 wss 是同一类东西，但协议简单得多：文本帧发参考文本，
 *    二进制帧发音频，最后一帧发 {"end":"true"}。
 *
 * 需要先在控制台开通「实时语音评测」，并把 应用ID / 应用密钥 写进 .env：
 *   YDS_APP_KEY=...
 *   YDS_APP_SECRET=...
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'

import { env } from '../src/env'

const WS_URL = 'wss://openapi.youdao.com/stream_capt'
/** 16k / 16bit / 单声道 → 每 200ms 一帧（他们文档建议的发送节奏） */
const CHUNK_BYTES = 6400

const pcmPath = process.argv[2]
const refText = process.argv[3]
if (!pcmPath || !refText) {
  console.error('用法：npx tsx apps/server/scripts/dump-youdao.ts <裸PCM> "<参考文本>"')
  process.exit(1)
}
const appKey = env.YDS_APP_KEY ?? ''
const appSecret = env.YDS_APP_SECRET ?? ''
if (!appKey || !appSecret) {
  console.error('缺少 YDS_APP_KEY / YDS_APP_SECRET（写进根目录 .env 或 apps/server/.env.legacy）')
  process.exit(1)
}

/**
 * ⭐ 签名 = sha256(appKey + salt + curtime + secret)（官方文档原文）。
 * ⚠️ 顺序不能换：它不是 HMAC，就是把这四段**字符串拼起来**再 sha256。
 */
function sign(salt: string, curtime: string): string {
  return createHash('sha256').update(appKey + salt + curtime + appSecret).digest('hex')
}

function buildUrl(): string {
  const salt = randomUUID()
  const curtime = String(Math.floor(Date.now() / 1000))
  const q = new URLSearchParams({
    appKey,
    salt,
    curtime,
    sign: sign(salt, curtime),
    signType: 'v4',
    langType: 'en',
    format: 'wav',
    channel: '1',
    version: 'v1',
    rate: '16000',
  })
  return WS_URL + '?' + q.toString()
}

/** 把裸 PCM 包一层 44 字节 WAV 头（他们文档写的是 wav；有些实现两种都收） */
function wavOf(pcm: Uint8Array): Uint8Array {
  const header = new Uint8Array(44)
  const view = new DataView(header.buffer)
  const write = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) header[off + i] = s.charCodeAt(i)
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  const out = new Uint8Array(44 + pcm.byteLength)
  out.set(header, 0)
  out.set(pcm, 44)
  return out
}

/** 跑一次完整会话，返回收到的所有 JSON 帧 */
function run(audio: Uint8Array, wrapWav: boolean): Promise<unknown[]> {
  const frames: unknown[] = []
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(buildUrl())
    let sent = false
    const done = (err?: Error) => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      if (err) {
        /**
         * ⚠️ 把**已经收到的帧**一起带出去。
         *    探针的全部价值就是"看见真实返回"——失败时把帧丢掉，
         *    等于在最需要诊断的时候把证据扔了（踩过一次：坏密钥只会显示"超时"，
         *    而真相是服务端早就回了一个 errorCode:202）。
         */
        ;(err as Error & { frames?: unknown[] }).frames = frames
        reject(err)
      } else resolve(frames)
    }

    const timer = setTimeout(() => done(new Error('超时（30 秒没结束）')), 30_000)

    ws.onerror = (e: unknown) => {
      clearTimeout(timer)
      done(new Error('WebSocket 错误：' + JSON.stringify(e ?? null).slice(0, 200)))
    }
    ws.onmessage = (ev: MessageEvent) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data)
      let parsed: any
      try {
        parsed = JSON.parse(raw)
      } catch {
        frames.push({ __raw: raw.slice(0, 500) })
        return
      }
      frames.push(parsed)

      /**
       * ⭐ 错误帧是**即时终止**信号，不要干等 30 秒超时。
       *    errorCode 108（appKey 无效）、202（签名检验失败）这类错误服务端立刻就会回，
       *    硬等到超时只会把「密钥填错了」伪装成「网络不通」—— 排查方向直接跑偏。
       */
      if (parsed.action === 'error') {
        clearTimeout(timer)
        done(new Error('有道返回错误 errorCode=' + parsed.errorCode + ' msg=' + (parsed.msg ?? '')))
        return
      }

      // 握手完成后：发参考文本 → 发音频（200ms 一帧）→ 发结束标识
      if (!sent && parsed.action === 'started') {
        sent = true
        ws.send(JSON.stringify({ text: refText }))
        const body = wrapWav ? wavOf(audio) : audio
        let off = 0
        const tick = () => {
          if (off >= body.byteLength) {
            ws.send(JSON.stringify({ end: 'true' }))
            return
          }
          const chunk = body.subarray(off, Math.min(off + CHUNK_BYTES, body.byteLength))
          ws.send(chunk as unknown as ArrayBuffer)
          off += CHUNK_BYTES
          setTimeout(tick, 200)
        }
        tick()
      }

      // 结果收完（isFinal）→ 结束
      const result = parsed.result
      if (result && (result.isFinal === true || result.isFinal === 'true')) {
        clearTimeout(timer)
        done()
      }
    }
  })
}

async function main() {
  const pcm = new Uint8Array(readFileSync(pcmPath as string))
  const secs = (pcm.byteLength / 32000).toFixed(1)
  console.log('音频 ' + pcm.byteLength + ' 字节（~' + secs + 's @16k/16bit/mono）')
  console.log('参考文本：' + refText)

  for (const wrapWav of [false, true]) {
    console.log('\n=== 试一次：' + (wrapWav ? '带 WAV 头' : '裸 PCM') + ' ===')
    try {
      const frames = await run(pcm, wrapWav)
      writeFileSync('/tmp/youdao-' + (wrapWav ? 'wav' : 'pcm') + '.json', JSON.stringify(frames, null, 2))
      console.log('收到 ' + frames.length + ' 帧 → /tmp/youdao-' + (wrapWav ? 'wav' : 'pcm') + '.json')
      for (const f of frames) console.log('  ' + JSON.stringify(f).slice(0, 300))
      const last = frames[frames.length - 1] as any
      if (last?.result?.words?.length) {
        console.log('⭐ 这一种能出词级结果，就用它')
        return
      }
    } catch (err) {
      const e = err as Error & { frames?: unknown[] }
      console.error('失败：' + e.message)
      const got = e.frames ?? []
      if (got.length) {
        console.error('⚠️ 失败前收到 ' + got.length + ' 帧 —— 照原样打出，这就是诊断依据：')
        for (const f of got) console.error('  ' + JSON.stringify(f).slice(0, 400))
        writeFileSync('/tmp/youdao-' + (wrapWav ? 'wav' : 'pcm') + '-failed.json', JSON.stringify(got, null, 2))
      } else {
        console.error('⚠️ 一帧都没收到 —— 握手就没成功（先查网络连通 / URL / 参数是否被拒）')
      }
    }
  }
  console.log('\n两种都没出词级结果 —— 把 /tmp/youdao-*.json 发我看。')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
