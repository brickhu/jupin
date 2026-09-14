/**
 * 测试讯飞 ISE - 使用 WAV 格式直接发送
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
  return `wss://${HOST}${PATH}?authorization=${authorizationB64}&date=${encodeURIComponent(date)}&host=${encodeURIComponent(HOST)}`
}

async function main() {
  console.log('=== 测试讯飞 ISE - WAV 模式 ===\n')

  const wavFile = fs.readFileSync('/tmp/test-speech.wav')
  const text = 'Stay hungry, stay foolish.'

  console.log(`WAV 文件大小: ${wavFile.length}`)
  console.log('参考文本:', text)

  const ws = new WebSocket(generateAuthUrl())
  let finalXml = ''
  let initDone = false

  ws.on('open', () => {
    console.log('✅ WebSocket 已连接')

    // 初始化帧 - 使用 aue='wav'
    ws.send(JSON.stringify({
      common: { app_id: APP_ID },
      business: {
        aue: 'wav',
        auf: 'audio/L16;rate=16000',
        category: 'read_sentence',
        cmd: 'ssb',
        ent: 'en_vip',
        sub: 'ise',
        text: Buffer.from(text, 'utf8').toString('base64'),
        ttp_skip: true,
        extra_ability: 'multi_dimension',
      },
      data: { status: 0 },
    }))
    console.log('初始化帧已发送 (aue=wav)')
  })

  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString('utf8'))
    console.log(`收到: code=${msg.code}, status=${msg.data?.status}, sid=${msg.sid?.slice(0,30)||'N/A'}`)

    if (msg.code !== 0) {
      console.error(`❌ 错误 ${msg.code}: ${msg.message}`)
      ws.close()
      return
    }

    if (!initDone && (msg.data?.status === 0 || msg.data?.status === 1)) {
      initDone = true
      console.log('发送音频数据（WAV 格式，含头）...')

      // 分片发送 WAV 数据
      const FRAME_SIZE = 16000  // 每帧 16000 字节 PCM ≈ 1秒，Base64 ≈ 21333 字符，<26000
      let offset = 0

      const sendChunk = () => {
        if (offset >= wavFile.length) {
          console.log('音频发送完成')
          return
        }
        const end = Math.min(offset + FRAME_SIZE, wavFile.length)
        const chunk = wavFile.slice(offset, end)
        const isFirst = offset === 0
        const isLast = end >= wavFile.length
        const aus = isFirst && isLast ? 4 : isFirst ? 1 : isLast ? 3 : 2
        const b64 = chunk.toString('base64')

        ws.send(JSON.stringify({
          business: { cmd: 'auw', aus, aue: 'wav' },
          data: { status: isLast ? 2 : 1, data: b64 },
        }))
        console.log(`  帧: aus=${aus}, offset=${offset}-${end}, b64=${b64.length}`)
        offset = end
        if (!isLast) setTimeout(sendChunk, 100)
      }
      sendChunk()
    }

    if (msg.data?.data) {
      finalXml += msg.data.data
      console.log(`  XML 累积: ${finalXml.length} 字符`)
    }

    if (msg.data?.status === 2) {
      console.log('\n✅ 评分成功！')
      console.log('最终 XML:', finalXml.slice(0, 1000))
      ws.close()
    }
  })

  ws.on('error', (err) => console.error('❌ WebSocket 错误:', err.message))
  ws.on('close', (code) => {
    console.log(`WebSocket 关闭, code=${code}`)
    if (finalXml) console.log('XML:', finalXml)
  })

  setTimeout(() => { console.error('❌ 超时'); ws.close(); process.exit(1) }, 30000)
}

main().catch(console.error)