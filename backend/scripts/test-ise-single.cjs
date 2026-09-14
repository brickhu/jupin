/**
 * 整个音频作为一帧发送
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

// PCM data
function loadPcm(p) { const b=fs.readFileSync(p); let o=12; while(o<b.length-8){const id=b.toString('utf8',o,o+4),sz=b.readUInt32LE(o+4);if(id==='data')return b.subarray(o+8,o+8+sz);o+=8+sz}throw Error('no data')}
const pcm = loadPcm('/tmp/stay.wav') // say 生成的英文语音
console.log(`PCM: ${pcm.length} bytes, text: "Stay hungry, stay foolish."`)

const ws = new WebSocket(url)

ws.on('open', () => {
  console.log('Connected')

  // init frame
  const text = '\uFEFF[content]Stay hungry, stay foolish.\n'
  ws.send(JSON.stringify({
    common: { app_id: APP_ID },
    business: { sub:'ise', ent:'en_vip', category:'read_sentence',
      text: Buffer.from(text).toString('base64'),
      tte:'utf-8', rstcd:'utf8', ttp_skip:true, cmd:'ssb', aue:'raw', auf:'audio/L16;rate=16000'
    },
    data: { status: 0 }
  }))
  console.log('Init sent')

  // 整个音频作为一帧（aus=4, status=2）
  ws.send(JSON.stringify({
    common: { app_id: APP_ID },
    business: { aus: 4, cmd: 'auw', aue: 'raw' },
    data: { status: 2, data: pcm.toString('base64') }
  }))
  console.log(`Audio sent: ${pcm.length} bytes`)
})

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  console.log(`Msg: code=${msg.code}, status=${msg.data?.status}, sid=${(msg.sid||'').slice(0,25)}`)

  if (msg.code !== 0) { console.error(`ERR ${msg.code}: ${msg.message}`); return }
  if (msg.data?.status === 2) {
    const xml = msg.data.data ? Buffer.from(msg.data.data,'base64').toString() : ''
    console.log('SUCCESS!\nXML:', xml.slice(0,500))
    ws.close()
  }
})

ws.on('error', e => console.error('WS error:', e.message))
ws.on('close', c => console.log(`close=${c}`))
setTimeout(() => { console.log('TIMEOUT'); process.exit(1) }, 15000)