/**
 * 两帧音频：第一帧 + 最后一帧
 * Base64 数据每帧不超过 26000 字符
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
  const sig = crypto.createHmac('sha256', API_SECRET)
    .update(`host: ${HOST}\ndate: ${date}\nGET ${URI} HTTP/1.1`, 'utf8')
    .digest('base64')
  const auth = `api_key="${API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`
  return Buffer.from(auth, 'utf8').toString('base64')
}

const date = new Date().toUTCString()
const url = `wss://${HOST}${URI}?authorization=${getAuthStr(date)}&date=${encodeURIComponent(date)}&host=${encodeURIComponent(HOST)}`

function loadPcm(p) { const b=fs.readFileSync(p); let o=12; while(o<b.length-8){const id=b.toString('utf8',o,o+4),sz=b.readUInt32LE(o+4);if(id==='data')return b.subarray(o+8,o+8+sz);o+=8+sz}throw Error('no data')}
const pcm = fs.readFileSync('/tmp/ise-demo/ise_ws_nodejs_demo/read_sentence_cn.pcm')
console.log(`PCM: ${pcm.length} bytes (official demo PCM for Chinese)`)

// 计算分帧
const FRAME_BYTES = 19000
const frames = []
for (let i = 0; i < pcm.length; i += FRAME_BYTES) {
  frames.push(pcm.slice(i, Math.min(i + FRAME_BYTES, pcm.length)))
}
console.log(`分 ${frames.length} 帧`)

const ws = new WebSocket(url)
let step = 0

ws.on('open', () => {
  console.log('Connected')

  // Init - 中文
  const text = '\uFEFF今天天气怎么样'
  console.log('Text:', text)
  ws.send(JSON.stringify({
    common: { app_id: APP_ID },
    business: { sub:'ise', ent:'cn_vip', category:'read_sentence',
      text: Buffer.from(text).toString('base64'),
      tte:'utf-8', rstcd:'utf8', ttp_skip:true, cmd:'ssb', aue:'raw', auf:'audio/L16;rate=16000'
    },
    data: { status: 0 }
  }))
  console.log('Init sent')

  // 第一帧音频
  ws.send(JSON.stringify({
    common: { app_id: APP_ID },
    business: { aus: 1, cmd: 'auw', aue: 'raw' },
    data: { status: 1, data: frames[0].toString('base64') }
  }))
  console.log(`Frame 1: ${frames[0].length} bytes, base64=${(frames[0].length*4/3).toFixed(0)} chars`)
  step = 1
})

let frameIdx = 1
const timer = setInterval(() => {
  if (step === 0) return
  if (frameIdx >= frames.length) {
    clearInterval(timer)
    // 最后一帧
    ws.send(JSON.stringify({
      common: { app_id: APP_ID },
      business: { aus: 4, cmd: 'auw', aue: 'raw' },
      data: { status: 2, data: '' }  // 空数据
    }))
    console.log('Last frame sent')
    return
  }
  ws.send(JSON.stringify({
    common: { app_id: APP_ID },
    business: { aus: 2, cmd: 'auw', aue: 'raw' },
    data: { status: 1, data: frames[frameIdx].toString('base64') }
  }))
  console.log(`Frame ${frameIdx+1}: ${frames[frameIdx].length} bytes`)
  frameIdx++
}, 100) // 100ms 间隔

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  console.log(`Msg: code=${msg.code}, status=${msg.data?.status}`)
  if (msg.code === 0 && msg.data?.status === 2) {
    const xml = msg.data.data ? Buffer.from(msg.data.data,'base64').toString() : ''
    console.log('SUCCESS!\nXML:', xml.slice(0,500))
    clearInterval(timer)
    ws.close()
  }
  if (msg.code !== 0 && msg.code !== undefined) {
    console.error(`ERR ${msg.code}: ${msg.message}`)
  }
})

ws.on('error', e => console.error('WS error:', e.message))
ws.on('close', c => console.log(`close=${c}`))
setTimeout(() => { console.log('TIMEOUT'); clearInterval(timer); process.exit(1) }, 20000)