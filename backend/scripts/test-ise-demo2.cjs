/**
 * 完全复刻 讯飞官方 Node.js demo
 * 使用 read_sentence_cn.pcm（官方 PCM 文件）
 * 文本: 今天天气怎么样 (cn_vip)
 */
const fs = require('fs')
const WebSocket = require('ws')
const crypto = require('crypto')

const HOST = 'ise-api.xfyun.cn'
const URI = '/v2/open-ise'
const HOST_URL = `wss://${HOST}${URI}`

const date = new Date().toUTCString()
const sig = crypto.createHmac('sha256', process.env.XFYUN_API_SECRET)
  .update(`host: ${HOST}\ndate: ${date}\nGET ${URI} HTTP/1.1`, 'utf8')
  .digest('base64')
const auth = Buffer.from(`api_key="${process.env.XFYUN_API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`).toString('base64')

const url = `${HOST_URL}?authorization=${auth}&date=${date}&host=${HOST}`
console.log('URL (host param):', HOST)

const FRAME_SIZE = 1280
const STATUS = { FIRST: 0, CONTINUE: 1, LAST: 2 }
let status = STATUS.FIRST
const pcmData = fs.readFileSync('/tmp/ise-demo/ise_ws_nodejs_demo/read_sentence_cn.pcm')
console.log(`PCM: ${pcmData.length} bytes`)

const ws = new WebSocket(url)

ws.on('open', () => {
  console.log('WebSocket connected')
  let offset = 0
  let paused = false

  function sendChunk(data) {
    let frame
    switch (status) {
      case STATUS.FIRST:
        // 发送 init 帧
        frame = {
          common: { app_id: process.env.XFYUN_APP_ID },
          business: {
            sub: 'ise', ent: 'cn_vip', category: 'read_sentence',
            text: `\uFEFF今天天气怎么样`,
            tte: 'utf-8', rstcd: 'utf8', ttp_skip: true, cmd: 'ssb',
            aue: 'raw', auf: 'audio/L16;rate=16000'
          },
          data: { status: 0 }
        }
        ws.send(JSON.stringify(frame))
        console.log('INIT')

        // 立即发送第一帧音频
        frame = {
          common: { app_id: process.env.XFYUN_APP_ID },
          business: { aus: 1, cmd: 'auw', aue: 'raw' },
          data: { status: 1, data: data.toString('base64') }
        }
        status = STATUS.CONTINUE
        console.log(`AUDIO aus=1 size=${data.length}`)
        break
      case STATUS.CONTINUE:
        frame = {
          common: { app_id: process.env.XFYUN_APP_ID },
          business: { aus: 2, cmd: 'auw', aue: 'raw' },
          data: { status: 1, data: data.toString('base64') }
        }
        break
      case STATUS.LAST:
        frame = {
          common: { app_id: process.env.XFYUN_APP_ID },
          business: { aus: 4, cmd: 'auw', aue: 'raw' },
          data: { status: 2, data: data.toString('base64') }
        }
        console.log('AUDIO LAST (empty)')
        break
    }
    ws.send(JSON.stringify(frame))
  }

  // 用 ReadStream + busy-wait 完全复刻 demo
  const reader = fs.createReadStream('/tmp/ise-demo/ise_ws_nodejs_demo/read_sentence_cn.pcm', {
    highWaterMark: FRAME_SIZE
  })
  reader.on('data', (chunk) => {
    if (paused) return
    sendChunk(chunk)
    const stop = Date.now() + 40
    while (Date.now() < stop) { /* busy wait */ }
  })
  reader.on('end', () => {
    status = STATUS.LAST
    sendChunk(Buffer.alloc(0))
  })
})

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  console.log(`  MSG: code=${msg.code} status=${msg.data?.status}`)
  if (msg.code !== 0) {
    console.error(`  ERROR ${msg.code}: ${msg.message}`)
    return
  }
  if (msg.data?.status === 2) {
    const xml = msg.data.data ? Buffer.from(msg.data.data, 'base64').toString() : ''
    console.log('SUCCESS!')
    console.log('XML:', xml.slice(0, 500))
  }
})

ws.on('error', (err) => console.error('WS error:', err.message))
ws.on('close', (code) => console.log(`close=${code}`))
setTimeout(() => { console.log('TIMEOUT'); process.exit(1) }, 20000)