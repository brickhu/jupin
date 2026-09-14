/**
 * 测试英文 read_sentence，验证 [content] 文本格式
 */
const fs = require('fs')
const WebSocket = require('ws')
const crypto = require('crypto')

const APP_ID = process.env.XFYUN_APP_ID
const API_KEY = process.env.XFYUN_API_KEY
const API_SECRET = process.env.XFYUN_API_SECRET

const HOST = 'ise-api.xfyun.cn'
const URI = '/v2/open-ise'

function getAuthStr(date) {
  const sigOrigin = `host: ${HOST}\ndate: ${date}\nGET ${URI} HTTP/1.1`
  const sig = crypto.createHmac('sha256', API_SECRET).update(sigOrigin, 'utf8').digest('base64')
  const authOrigin = `api_key="${API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`
  return Buffer.from(authOrigin, 'utf8').toString('base64')
}

const date = new Date().toUTCString()
const wssUrl = `wss://${HOST}${URI}?authorization=${getAuthStr(date)}&date=${encodeURIComponent(date)}&host=${encodeURIComponent(HOST)}`

// 加载 PCM 数据
function loadPcm(wavPath) {
  const buf = fs.readFileSync(wavPath)
  let off = 12
  while (off < buf.length - 8) {
    const id = buf.toString('utf8', off, off + 4)
    const sz = buf.readUInt32LE(off + 4)
    if (id === 'data') return buf.subarray(off + 8, off + 8 + sz)
    off += 8 + sz
  }
  throw new Error('no data')
}

// 使用之前生成的英文语音
const pcmData = loadPcm('/tmp/stay.wav')
console.log(`PCM: ${pcmData.length} bytes (${(pcmData.length / 32000).toFixed(2)}s)`)

const ws = new WebSocket(wssUrl)
const STATUS = { FIRST: 0, CONTINUE: 1, LAST: 2 }
let status = STATUS.FIRST

ws.on('open', () => {
  console.log('WebSocket 已连接')

  const FRAME_SIZE = 1280
  let offset = 0

  function sendChunk(data) {
    let frame
    switch (status) {
      case STATUS.FIRST: {
        // 测试不同的英文文本格式
        const formatA = '\uFEFF[content]Stay hungry, stay foolish.\n'  // 带换行
        const formatB = '\uFEFF[content]Stay hungry, stay foolish.'    // 无换行
        // 用 formatA 试
        frame = {
          common: { app_id: APP_ID },
          business: {
            sub: 'ise',
            ent: 'en_vip',
            category: 'read_sentence',
            text: Buffer.from(formatA, 'utf8').toString('base64'),
            tte: 'utf-8',
            rstcd: 'utf8',
            ttp_skip: true,
            cmd: 'ssb',
            aue: 'raw',
            auf: 'audio/L16;rate=16000',
          },
          data: { status: 0 },
        }
        ws.send(JSON.stringify(frame))
        console.log('init (formatA)')

        frame = {
          common: { app_id: APP_ID },
          business: { aus: 1, cmd: 'auw', aue: 'raw' },
          data: { status: 1, data: data.toString('base64') },
        }
        status = STATUS.CONTINUE
        console.log(`  aus=1, size=${data.length}`)
        break
      }
      case STATUS.CONTINUE:
        frame = {
          common: { app_id: APP_ID },
          business: { aus: 2, cmd: 'auw', aue: 'raw' },
          data: { status: 1, data: data.toString('base64') },
        }
        console.log(`  aus=2`)
        break
      case STATUS.LAST:
        frame = {
          common: { app_id: APP_ID },
          business: { aus: 4, cmd: 'auw', aue: 'raw' },
          data: { status: 2, data: data.toString('base64') },
        }
        console.log('  aus=4 (LAST)')
        break
    }
    ws.send(JSON.stringify(frame))
  }

  function sendFrame() {
    if (offset >= pcmData.length) {
      status = STATUS.LAST
      sendChunk(Buffer.alloc(0))
      return
    }
    const end = Math.min(offset + FRAME_SIZE, pcmData.length)
    sendChunk(pcmData.slice(offset, end))
    offset = end
    if (offset < pcmData.length) {
      const stop = Date.now() + 40
      while (Date.now() < stop) { }
      setImmediate(sendFrame)
    }
  }
  sendFrame()
})

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  console.log(`  收到: code=${msg.code}, status=${msg.data?.status}`)

  if (msg.code !== 0) {
    console.error(`  ❌ ${msg.code}: ${msg.message}`)
    return
  }
  if (msg.data?.status === 2) {
    const xml = msg.data.data ? Buffer.from(msg.data.data, 'base64').toString() : ''
    console.log('✅ 成功!')
    console.log('XML:', xml.slice(0, 500))
    ws.close()
  }
})

ws.on('error', (e) => console.error('WS error:', e.message))
ws.on('close', (code) => console.log(`close=${code}`))
setTimeout(() => { console.log('TIMEOUT'); process.exit(1) }, 30000)