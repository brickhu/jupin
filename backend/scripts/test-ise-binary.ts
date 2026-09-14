/**
 * 讯飞 ISE 测试 - 二进制帧发送音频
 * 官方协议: aue=raw → 音频帧用二进制 WebSocket 帧
 */
import fs from 'fs'
import WebSocket from 'ws'
import crypto from 'crypto'

const APP_ID = process.env.XFYUN_APP_ID!
const API_KEY = process.env.XFYUN_API_KEY!
const API_SECRET = process.env.XFYUN_API_SECRET!
const HOST = 'ise-api.xfyun.cn'
const PATH = '/v2/open-ise'

function genUrl() {
  const date = new Date().toUTCString()
  const sig = crypto.createHmac('sha256', API_SECRET)
    .update(`host: ${HOST}\ndate: ${date}\nGET ${PATH} HTTP/1.1`, 'utf8')
    .digest('base64')
  const auth = `api_key="${API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`
  return `wss://${HOST}${PATH}?authorization=${encodeURIComponent(Buffer.from(auth).toString('base64'))}&date=${encodeURIComponent(date)}&host=${encodeURIComponent(HOST)}`
}

function getPcm(path: string): Buffer {
  const buf = fs.readFileSync(path)
  let off = 12
  while (off < buf.length - 8) {
    const id = buf.toString('utf8', off, off + 4)
    const sz = buf.readUInt32LE(off + 4)
    if (id === 'data') return buf.subarray(off + 8, off + 8 + sz)
    off += 8 + sz
  }
  throw new Error('no data chunk')
}

async function main() {
  const pcm = getPcm('/tmp/test-speech.wav')
  const text = 'Hello'
  console.log(`PCM: ${pcm.length} bytes, text: "${text}"`)

  const ws = new WebSocket(genUrl())
  let initDone = false
  let finalXml = ''
  let settled = false

  ws.on('open', () => {
    console.log('✅ Connected')
    ws.send(JSON.stringify({
      common: { app_id: APP_ID },
      business: {
        aue: 'raw', auf: 'audio/L16;rate=16000', category: 'read_sentence',
        cmd: 'ssb', ent: 'en_vip', sub: 'ise',
        text: Buffer.from(text).toString('base64'), ttp_skip: true,
        extra_ability: 'multi_dimension',
      },
      data: { status: 0 },
    }))
    console.log('Init sent')
  })

  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString())
    console.log(`Msg: code=${msg.code} status=${msg.data?.status}`)

    if (msg.code !== 0) {
      console.error(`ERR ${msg.code}: ${msg.message}`)
      ws.close()
      process.exit(1)
    }

    if (!initDone && msg.data?.status != null) {
      initDone = true
      console.log('✅ Init confirmed, sending audio as binary frames...')

      // 二进制帧发送音频
      const FRAME_SIZE = 1280
      let offset = 0

      const sendNext = () => {
        if (offset >= pcm.length) {
          // 结束帧 (JSON)
          ws.send(JSON.stringify({
            business: { cmd: 'ssb', aus: 4 },
            data: { status: 2 },
          }))
          console.log('End frame sent')
          return
        }
        const end = Math.min(offset + FRAME_SIZE, pcm.length)
        const chunk = pcm.slice(offset, end)
        ws.send(chunk)  // 二进制帧
        offset = end
        setTimeout(sendNext, 40)
      }
      sendNext()
    }

    if (msg.data?.data) { finalXml += msg.data.data; console.log(`  XML: ${finalXml.length} chars`) }
    if (msg.data?.status === 2) {
      console.log('\n✅ SUCCESS!')
      console.log('XML:', finalXml.slice(0, 1000))
      ws.close()
      settled = true
      process.exit(0)
    }
  })

  ws.on('error', e => console.error('WS err:', e.message))
  ws.on('close', c => {
    console.log(`Close code=${c}`)
    if (!settled) console.log('final XML so far:', finalXml.slice(0, 300))
  })
  setTimeout(() => { console.log('TIMEOUT'); process.exit(1) }, 15000)
}

main().catch(console.error)