/**
 * 探针：ISE 流式版到底会不会返回「中间逐词结果」？
 *
 * 目的：判定 data.status=0/1 的返回帧中是否携带可用的增量评测结果，
 *       或只是空帧、必须等 status=2 才有数据。
 *
 * 用法：npx dotenv -e .env -- node scripts/probe-ise-stream.cjs /tmp/probe.wav "reference text"
 */
const fs = require('fs')
const WebSocket = require('ws')
const crypto = require('crypto')

const APP_ID = process.env.XFYUN_APP_ID
const API_KEY = process.env.XFYUN_API_KEY
const API_SECRET = process.env.XFYUN_API_SECRET
const HOST = 'ise-api.xfyun.cn'
const URI = '/v2/open-ise'

const WAV = process.argv[2] || '/tmp/probe.wav'
const TEXT = process.argv[3] || 'Stay hungry, stay foolish.'

function getAuthStr(date) {
  const sig = crypto.createHmac('sha256', API_SECRET)
    .update('host: ' + HOST + '\ndate: ' + date + '\nGET ' + URI + ' HTTP/1.1', 'utf8')
    .digest('base64')
  const auth = 'api_key="' + API_KEY + '", algorithm="hmac-sha256", headers="host date request-line", signature="' + sig + '"'
  return Buffer.from(auth, 'utf8').toString('base64')
}

function getPcm(p) {
  const b = fs.readFileSync(p)
  let o = 12
  while (o < b.length - 8) {
    const id = b.toString('utf8', o, o + 4)
    const sz = b.readUInt32LE(o + 4)
    if (id === 'data') return b.subarray(o + 8, o + 8 + sz)
    o += 8 + sz
  }
  throw Error('no data chunk in wav')
}

const PCM = getPcm(WAV)
const date = new Date().toUTCString()
const url = 'wss://' + HOST + URI + '?authorization=' + getAuthStr(date) + '&date=' + date + '&host=' + HOST

console.log('=== ISE 流式结果探针 ===')
console.log('音频 PCM 字节数: ' + PCM.length + '  (~' + (PCM.length / 32000).toFixed(1) + 's @16k/16bit/mono)')
console.log('参考文本: "' + TEXT + '"')
console.log('发送节奏: 1280B / 40ms (实时速度)\n')

const ws = new WebSocket(url)
const FRAME = 1280
let offset = 0
let aus = 1
let acc = ''
let msgIndex = 0
let wordsSeen = 0
let finalWords = 0

ws.on('open', () => {
  ws.send(JSON.stringify({
    common: { app_id: APP_ID },
    business: {
      aue: 'raw', auf: 'audio/L16;rate=16000', category: 'read_sentence',
      cmd: 'ssb', ent: 'en_vip', sub: 'ise',
      text: '\uFEFF[content]' + TEXT + '\n',
      tte: 'utf-8', rstcd: 'utf8', ttp_skip: true,
      extra_ability: 'multi_dimension',
    },
    data: { status: 0 },
  }))
  pump()
})

function pump() {
  if (offset >= PCM.length) {
    ws.send(JSON.stringify({
      common: { app_id: APP_ID },
      business: { aus: 4, cmd: 'auw', aue: 'raw' },
      data: { status: 2, data: '' },
    }))
    console.log('\n[>] 已发送结束帧 (status=2)')
    return
  }
  const end = Math.min(offset + FRAME, PCM.length)
  const chunk = PCM.subarray(offset, end)
  ws.send(JSON.stringify({
    common: { app_id: APP_ID },
    business: { aus, cmd: 'auw', aue: 'raw' },
    data: { status: 1, data: chunk.toString('base64') },
  }))
  aus = 2
  offset = end
  setTimeout(pump, 40)
}

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString('utf8'))
  if (msg.code !== 0) {
    console.log('[!] code=' + msg.code + ' message=' + msg.message)
    return
  }
  const st = msg.data && msg.data.status
  const b64 = (msg.data && msg.data.data) || ''
  const xml = b64 ? Buffer.from(b64, 'base64').toString('utf8') : ''
  msgIndex++

  const wordsInChunk = (xml.match(/<word /g) || []).length
  const tag = (xml.match(/<[a-z_]+/g) || []).slice(0, 3).join(',')

  if (xml) acc += xml
  const wordsInAcc = (acc.match(/<word /g) || []).length
  if (wordsInAcc > wordsSeen) wordsSeen = wordsInAcc

  // 判定这一帧是不是「完整可解析的独立结果」
  let standalone = '-'
  if (xml.trim()) {
    standalone = /^\s*(<\?xml|<xml_result)/.test(xml) ? '完整文档' : '片段'
  }

  if (st !== 2 && msgIndex % 25 !== 0) { if (st === 2) {} else return }
  console.log(
    '[' + String(msgIndex).padStart(3) + '] status=' + st +
    ' chunkBytes=' + String(xml.length).padStart(5) +
    ' chunkWords=' + wordsInChunk +
    ' accWords=' + wordsInAcc +
    ' 形态=' + standalone +
    (tag ? ' 首标签<'+tag+'>' : ' (空)')
  )

  if (st === 2) {
    finalWords = wordsInAcc
    console.log('\n=== 结束 ===')
    console.log('总返回帧数: ' + msgIndex)
    console.log('status=2 时累计 XML 长度: ' + acc.length + ' 字符, <word> 数量: ' + finalWords)
    const w = acc.match(/<word [\s\S]*?<\/word>/)
    console.log('\n[单个 <word> 完整结构]\n' + (w ? w[0] : '(未匹配)').slice(0, 1200))
    console.log('\n[词级得分一览]')
    const re = /<word ([^>]*)>/g
    let m
    while ((m = re.exec(acc))) {
      const a = Object.fromEntries([...m[1].matchAll(/([a-z_]+)="([^"]*)"/g)].map(x => [x[1], x[2]]))
      console.log('  ' + (a.content || '?').padEnd(12) + ' total=' + a.total_score + ' dp_message=' + (a.dp_message ?? '-'))
    }
    ws.close()
    setTimeout(() => process.exit(0), 200)
  }
})

ws.on('error', (e) => { console.log('[!] WS error: ' + e.message); process.exit(1) })
ws.on('close', (c) => { console.log('[x] closed code=' + c); process.exit(0) })
setTimeout(() => { console.log('[!] 超时 60s'); process.exit(1) }, 60000)
