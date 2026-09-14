/**
 * 直接测试讯飞 ISE 连接，使用真实语音 WAV 文件
 * 用法: pnpm dotenv -e .env -- pnpm tsx scripts/test-ise-direct.ts
 */
import fs from 'fs'
import WebSocket from 'ws'
import crypto from 'crypto'

const APP_ID = process.env.XFYUN_APP_ID!
const API_KEY = process.env.XFYUN_API_KEY!
const API_SECRET = process.env.XFYUN_API_SECRET!
const HOST = 'ise-api.xfyun.cn'
const PATH = '/v2/open-ise'

function generateAuthUrl(): string {
  const date = new Date().toUTCString()
  const signatureOrigin = `host: ${HOST}\ndate: ${date}\nGET ${PATH} HTTP/1.1`
  const signature = crypto
    .createHmac('sha256', API_SECRET)
    .update(signatureOrigin, 'utf8')
    .digest('base64')

  const authorization = `api_key="${API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`

  const authorizationB64 = encodeURIComponent(Buffer.from(authorization, 'utf8').toString('base64'))
  const dateEnc = encodeURIComponent(date)
  const hostEnc = encodeURIComponent(HOST)

  return `wss://${HOST}${PATH}?authorization=${authorizationB64}&date=${dateEnc}&host=${hostEnc}`
}

async function main() {
  console.log('=== 直接测试讯飞 ISE ===\n')

  // 1. 读取 WAV 文件并正确解析 data chunk（不假设 44 字节头）
  const wavPath = '/tmp/stay.wav'
  const wavBuffer = fs.readFileSync(wavPath)
  
  // 解析 WAV 找到 data chunk
  let pcmOffset = 12 // 跳过 "RIFF" + size + "WAVE"
  while (pcmOffset < wavBuffer.length - 8) {
    const chunkId = wavBuffer.toString('utf8', pcmOffset, pcmOffset + 4)
    const chunkSize = wavBuffer.readUInt32LE(pcmOffset + 4)
    if (chunkId === 'data') {
      pcmOffset += 8
      break
    }
    pcmOffset += 8 + chunkSize
  }
  const pcmData = wavBuffer.subarray(pcmOffset)
  console.log(`WAV 文件大小: ${wavBuffer.length}, PCM 数据偏移: ${pcmOffset}, PCM 数据大小: ${pcmData.length}`)

  const text = 'Stay hungry, stay foolish.'
  const url = generateAuthUrl()

  console.log('参考文本:', text)
  console.log('连接 URL 前 80 字符:', url.slice(0, 80) + '...')

  const ws = new WebSocket(url)
  let finalXml = ''
  let initConfirmed = false

  ws.on('open', () => {
    console.log('\n✅ WebSocket 已连接')

    // 发送初始化帧
    // 英文句子需要 [content] 节点 + UTF-8 BOM
    const formattedText = `\uFEFF[content]${text}\n`
    const initFrame = JSON.stringify({
      common: { app_id: APP_ID },
      business: {
        aue: 'raw',
        auf: 'audio/L16;rate=16000',
        category: 'read_sentence',
        cmd: 'ssb',
        ent: 'en_vip',
        sub: 'ise',
        tte: 'utf-8',
        text: Buffer.from(formattedText, 'utf8').toString('base64'),
        ttp_skip: true,
        extra_ability: 'multi_dimension',
      },
      data: { status: 0 },
    })
    console.log('发送初始化帧...')
    ws.send(initFrame)
  })

  ws.on('message', (data: Buffer) => {
    const msgStr = data.toString('utf8')
    const msg = JSON.parse(msgStr)
    console.log(`收到消息: code=${msg.code}, status=${msg.data?.status}, sid=${msg.sid || 'N/A'}`)

    if (msg.code !== 0) {
      console.error(`❌ 错误: ${msg.code} - ${msg.message}`)
      ws.close()
      return
    }

    // 收到初始化确认后发送音频（仅一次）
    if (!initConfirmed && (msg.data?.status === 0 || msg.data?.status === 1)) {
      initConfirmed = true
      console.log('初始化确认收到，发送音频数据...')

      // 分片发送 PCM 数据
      const FRAME_SIZE = 1280
      let offset = 0

      const sendChunk = () => {
        if (offset >= pcmData.length) {
          console.log('音频发送完成')
          return
        }

        const end = Math.min(offset + FRAME_SIZE, pcmData.length)
        const chunk = pcmData.slice(offset, end)
        const isFirst = offset === 0
        const isLast = end >= pcmData.length
        const aus = isFirst && isLast ? 4 : isFirst ? 1 : isLast ? 3 : 2

        ws.send(JSON.stringify({
          business: { cmd: 'auw', aus, aue: 'raw' },
          data: {
            status: isLast ? 2 : 1,
            data: chunk.toString('base64'),
          },
        }))
        console.log(`  音频帧: aus=${aus}, offset=${offset}-${end}`)
        offset = end

        if (!isLast) {
          setTimeout(sendChunk, 40)
        }
      }
      sendChunk()
    }

    if (msg.data?.data) {
      finalXml += msg.data.data
      console.log(`  XML 数据累积: ${finalXml.length} 字符`)
    }

    if (msg.data?.status === 2) {
      console.log('\n✅ 收到最终结果!')
      console.log('XML:', finalXml.slice(0, 500) + '...')
      ws.close()
    }
  })

  ws.on('error', (err) => {
    console.error('❌ WebSocket 错误:', err.message)
  })

  ws.on('close', (code) => {
    console.log(`WebSocket 关闭, code=${code}`)
    if (finalXml) {
      console.log('\n=== 最终 XML 结果 ===')
      console.log(finalXml)
    }
  })

  // 30秒超时
  setTimeout(() => {
    console.error('❌ 超时')
    ws.close()
    process.exit(1)
  }, 30000)
}

main().catch(console.error)