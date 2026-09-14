/**
 * 完整测试讯飞 ISE — 使用 stay.wav 并正确分帧
 * 参考讯飞官方 demo 逻辑
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

// 解析 WAV 获取 PCM
function getPcm(p) {
  const b = fs.readFileSync(p)
  let o = 12
  while (o < b.length - 8) {
    const id = b.toString('utf8', o, o + 4)
    const sz = b.readUInt32LE(o + 4)
    if (id === 'data') return b.subarray(o + 8, o + 8 + sz)
    o += 8 + sz
  }
  throw Error('no data')
}

const date = new Date().toUTCString()
const url = `wss://${HOST}${URI}?authorization=${getAuthStr(date)}&date=${date}&host=${HOST}`

const PCM = getPcm('/tmp/stay.wav')
const TEXT = '\uFEFF[content]Stay hungry, stay foolish.\n'
const FRAME_SIZE = 1280

console.log(`PCM: ${PCM.length} bytes`)
console.log(`Text: "${TEXT.trim()}"`)

const ws = new WebSocket(url)

const STATUS = { FIRST: 0, CONTINUE: 1, LAST: 2 }
let status = STATUS.FIRST
let finalXml = ''

function sendChunk(chunk) {
  let frame
  switch (status) {
    case STATUS.FIRST:
      // 第一次数据发送：init + 第一帧音频
      frame = {
        common: { app_id: APP_ID },
        business: {
          sub: 'ise',
          ent: 'en_vip',
          category: 'read_sentence',
          text: TEXT,
          tte: 'utf-8',
          rstcd: 'utf8',
          ttp_skip: true,
          cmd: 'ssb',
          aue: 'raw',
          auf: 'audio/L16;rate=16000',
          extra_ability: 'multi_dimension',
        },
        data: { status: 0 },
      }
      ws.send(JSON.stringify(frame))
      // 第一帧音频
      frame = {
        common: { app_id: APP_ID },
        business: { aus: 1, cmd: 'auw', aue: 'raw' },
        data: { status: 1, data: chunk.toString('base64') },
      }
      ws.send(JSON.stringify(frame))
      status = STATUS.CONTINUE
      break
    case STATUS.CONTINUE:
      frame = {
        common: { app_id: APP_ID },
        business: { aus: 2, cmd: 'auw', aue: 'raw' },
        data: { status: 1, data: chunk.toString('base64') },
      }
      ws.send(JSON.stringify(frame))
      break
    case STATUS.LAST:
      frame = {
        common: { app_id: APP_ID },
        business: { aus: 4, cmd: 'auw', aue: 'raw' },
        data: { status: 2, data: chunk.toString('base64') },
      }
      ws.send(JSON.stringify(frame))
      break
  }
}

ws.on('open', () => {
  console.log('✅ Connected')
  let offset = 0

  function sendNext() {
    if (offset >= PCM.length) {
      status = STATUS.LAST
      sendChunk(Buffer.alloc(0))
      console.log('📤 Audio done, sent end frame')
      return
    }
    const end = Math.min(offset + FRAME_SIZE, PCM.length)
    const chunk = PCM.slice(offset, end)
    sendChunk(chunk)
    offset = end
    // busy-wait 40ms (官方 demo 风格)
    const stop = Date.now() + 40
    while (Date.now() < stop) {}
    sendNext()
  }

  sendNext()
})

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  console.log(`📩 code=${msg.code} status=${msg.data?.status} sid=${(msg.sid||'').slice(0,20)}`)

  if (msg.code === 0 && msg.data?.data) {
    finalXml += Buffer.from(msg.data.data, 'base64').toString()
  }

  if (msg.code !== 0) {
    console.error(`❌ ERR ${msg.code}: ${msg.message}`)
    if (finalXml) console.log('Partial XML:', finalXml.slice(0, 300))
    ws.close()
    return
  }

  if (msg.data?.status === 2) {
    console.log('\n✅ SUCCESS!')
    console.log('XML:', finalXml.slice(0, 800))
    ws.close()
  }
})

ws.on('error', e => console.error('❌ WS error:', e.message))
ws.on('close', c => {
  console.log(`close=${c}`)
  if (finalXml) {
    console.log('\n=== Final XML ===')
    console.log(finalXml)
  }
})

setTimeout(() => {
  console.log('⏰ TIMEOUT, finalXml:', finalXml.slice(0, 200))
  process.exit(1)
}, 30000)