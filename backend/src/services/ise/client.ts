import WebSocket from 'ws'
import { generateAuthUrl } from './auth'
import { parseIseResult } from './parser'
import type { IseResult, AssessOptions } from './types'

const FRAME_STATUS = { FIRST: 0, CONTINUE: 1, LAST: 2 }

export async function assessPronunciation(opts: AssessOptions): Promise<IseResult> {
  const { text, audioBuffer, category = 'read_sentence' } = opts
  const url = generateAuthUrl()

  console.log(`[ISE] 开始评分, text="${text}", category=${category}, audioSize=${audioBuffer.length}`)

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let finalXml = ''
    let settled = false
    let frameStatus = FRAME_STATUS.FIRST

    const done = (err?: Error, result?: IseResult) => {
      if (settled) return
      settled = true
      try { ws.close() } catch {}
      if (err) reject(err)
      else resolve(result!)
    }

    ws.on('open', () => {
      console.log('[ISE] WebSocket 已连接')

      // 构造带 BOM 和 [content] 标签的文本（英文句子格式）
      const formattedText = category === 'read_sentence'
        ? `\uFEFF[content]${text}\n`
        : `\uFEFF${text}`

      // 1. 发送初始化帧 (cmd=ssb)
      const initFrame = JSON.stringify({
        common: { app_id: process.env.XFYUN_APP_ID },
        business: {
          aue: 'raw',
          auf: 'audio/L16;rate=16000',
          category,
          cmd: 'ssb',
          ent: 'en_vip',
          sub: 'ise',
          text: formattedText,  // 原始 UTF-8 字符串（带 BOM）
          tte: 'utf-8',
          rstcd: 'utf8',
          ttp_skip: true,
          extra_ability: 'multi_dimension',
        },
        data: { status: 0 },
      })
      ws.send(initFrame)
      console.log(`[ISE] 初始化帧已发送, text="${text}"`)

      // 2. 分片发送音频（与官方 demo 一致，init 后立即发第一帧）
      const FRAME_SIZE_PCM = 1280
      let offset = 0

      const sendAudioChunk = (chunk: Buffer) => {
        let frame: string
        switch (frameStatus) {
          case FRAME_STATUS.FIRST:
            // 第一帧音频 (aus=1)
            frame = JSON.stringify({
              common: { app_id: process.env.XFYUN_APP_ID },
              business: { aus: 1, cmd: 'auw', aue: 'raw' },
              data: { status: 1, data: chunk.toString('base64') },
            })
            frameStatus = FRAME_STATUS.CONTINUE
            break
          case FRAME_STATUS.CONTINUE:
            // 中间帧 (aus=2)
            frame = JSON.stringify({
              common: { app_id: process.env.XFYUN_APP_ID },
              business: { aus: 2, cmd: 'auw', aue: 'raw' },
              data: { status: 1, data: chunk.toString('base64') },
            })
            break
          case FRAME_STATUS.LAST:
            // 最后一帧 (aus=4)
            frame = JSON.stringify({
              common: { app_id: process.env.XFYUN_APP_ID },
              business: { aus: 4, cmd: 'auw', aue: 'raw' },
              data: { status: 2, data: chunk.toString('base64') },
            })
            break
          default:
            return
        }
        ws.send(frame)
      }

      const sendNextChunk = () => {
        if (offset >= audioBuffer.length) {
          // 发送结束帧
          frameStatus = FRAME_STATUS.LAST
          sendAudioChunk(Buffer.alloc(0))
          console.log('[ISE] 音频发送完成')
          return
        }
        const end = Math.min(offset + FRAME_SIZE_PCM, audioBuffer.length)
        const chunk = audioBuffer.slice(offset, end)
        sendAudioChunk(chunk)
        offset = end
        // 40ms 间隔（模拟实时流）
        setTimeout(sendNextChunk, 40)
      }

      // 立即开始发送
      sendNextChunk()
    })

    ws.on('message', (data: Buffer) => {
      try {
        const msgStr = data.toString('utf8')
        const msg = JSON.parse(msgStr)
        console.log(`[ISE] code=${msg.code} status=${msg.data?.status}`)

        if (msg.code !== 0) {
          done(new Error(`ISE Error ${msg.code}: ${msg.message}`))
          return
        }

        if (msg.data?.data) {
          // ISE 返回的 data 是 base64 编码的 XML
          finalXml += Buffer.from(msg.data.data, 'base64').toString('utf8')
        }
        if (msg.data?.status === 2) {
          console.log(`[ISE] 收到最终结果, XML长度=${finalXml.length}`)
          const result = parseIseResult(finalXml)
          done(undefined, result)
        }
      } catch (e) {
        console.error('[ISE] 消息解析错误:', e)
        done(e as Error)
      }
    })

    ws.on('error', (err) => {
      const msg = err.message || ''
      console.error('[ISE] WebSocket 错误:', msg)
      if (msg.includes('401') || msg.includes('Unexpected server response')) {
        done(new Error('讯飞鉴权失败：请检查 APP_ID / APIKey / APISecret 是否正确，且应用已开通"语音评测(流式版)"能力并完成企业认证'))
      } else {
        done(new Error(`ISE connection error: ${msg}`))
      }
    })

    ws.on('close', (code) => {
      console.log(`[ISE] WebSocket 关闭, code=${code}, settled=${settled}`)
      if (!settled) {
        const msg = code === 1006
          ? '讯飞 WebSocket 连接中断（可能鉴权失败或被拒绝）'
          : `ISE WebSocket closed: code=${code}`
        done(new Error(msg))
      }
    })

    setTimeout(() => done(new Error('ISE request timeout')), 30000)
  })
}