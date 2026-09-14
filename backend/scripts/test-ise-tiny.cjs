/**
 * 极简测试：单帧音频（整个音频作为一帧发送）
 */
const fs = require('fs')
const WebSocket = require('ws')
const crypto = require('crypto')

const APP_ID = process.env.XFYUN_APP_ID
const API_KEY = process.env.XFYUN_API_KEY
const API_SECRET = process.env.XFYUN_API_SECRET
const HOST = 'ise-api.xfyun.cn'
const URI = '/v2/open-ise'
const BASE_URL = `wss://${HOST}${URI}`

function getAuthStr(date) {
  const sig = crypto.createHmac('sha256', API_SECRET)
    .update(`host: ${HOST}\ndate: ${date}\nGET ${URI} HTTP/1.1`, 'utf8')
    .digest('base64')
  const auth = `api_key="${API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`
  return Buffer.from(auth, 'utf8').toString('base64')
}

function getPcm(p) { const b=fs.readFileSync(p); let o=12; while(o<b.length-8){const id=b.toString('utf8',o,o+4),sz=b.readUInt32LE(o+4);if(id==='data')return b.subarray(o+8,o+8+sz);o+=8+sz}throw Error('no data')}
const pcm = getPcm('/tmp/tiny.wav')

function makeUrl() {
  const d = new Date().toUTCString()
  return `${BASE_URL}?authorization=${getAuthStr(d)}&date=${encodeURIComponent(d)}&host=${encodeURIComponent(HOST)}`
}

function test(fmt) {
  return new Promise((resolve) => {
    const ws = new WebSocket(makeUrl())
    let done = false
    ws.on('open', () => {
      ws.send(JSON.stringify({
        common: { app_id: APP_ID },
        business: { sub:'ise', ent: fmt.ent, category:'read_sentence',
          text: Buffer.from(fmt.text).toString('base64'),
          tte:'utf-8', rstcd:'utf8', ttp_skip:true, cmd:'ssb', aue:'raw', auf:'audio/L16;rate=16000'
        },
        data: { status: 0 }
      }))
      ws.send(JSON.stringify({
        common: { app_id: APP_ID },
        business: { aus: 4, cmd: 'auw', aue: 'raw' },
        data: { status: 2, data: pcm.toString('base64') }
      }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (done) return
      if (msg.code === 0 && msg.data?.status === 2) {
        done = true
        resolve('SUCCESS')
        ws.close()
      } else if (msg.code !== 0 && !done) {
        done = true
        resolve(`ERR ${msg.code}: ${msg.message}`)
        ws.close()
      }
    })
    ws.on('error', (e) => { if(!done){done=true;resolve(`WS_ERR: ${e.message}`)} })
    setTimeout(() => { if(!done){done=true;resolve('TIMEOUT')} }, 8000)
  })
}

async function main() {
  const formats = [
    { text: '\uFEFFhello', ent: 'en_vip', desc: 'English plain' },
    { text: '\uFEFF[content]hello\n', ent: 'en_vip', desc: 'English [content]' },
    { text: '\uFEFF今天天气怎么样', ent: 'cn_vip', desc: 'Chinese plain' },
    { text: '\uFEFFhello world', ent: 'en_vip', desc: 'English multi-word' },
    { text: '\uFEFF[content]Hello world.\n[content]', ent: 'en_vip', desc: 'English [content] closed' },
  ]
  for (const fmt of formats) {
    const result = await test(fmt)
    console.log(`${fmt.desc}: ${result}`)
  }
}

main().catch(console.error)