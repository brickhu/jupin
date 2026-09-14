/**
 * 仿讯飞官方 nodejs demo，逐帧发送 PCM 数据
 * 先测试中文（cn_vip），验证音频流是否正常
 */
const fs = require('fs')
const WebSocket = require('ws')

const APP_ID = process.env.XFYUN_APP_ID
const API_KEY = process.env.XFYUN_API_KEY
const API_SECRET = process.env.XFYUN_API_SECRET

const HOST = 'ise-api.xfyun.cn'
const URI = '/v2/open-ise'
const HOST_URL = `wss://${HOST}${URI}`

// 鉴权
function getAuthStr(date) {
  const crypto = require('crypto')
  const sigOrigin = `host: ${HOST}\ndate: ${date}\nGET ${URI} HTTP/1.1`
  const sig = crypto.createHmac('sha256', API_SECRET).update(sigOrigin, 'utf8').digest('base64')
  const authOrigin = `api_key="${API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`
  return Buffer.from(authOrigin, 'utf8').toString('base64')
}

const date = new Date().toUTCString()
const wssUrl = HOST_URL + '?authorization=' + getAuthStr(date) + '&date=' + encodeURIComponent(date) + '&host=' + encodeURIComponent(HOST)

console.log('连接中...')
const ws = new WebSocket(wssUrl)

const STATUS = { FIRST: 0, CONTINUE: 1, LAST: 2 }
let status = STATUS.FIRST

// 从 PCM 文件读取
// 先用 Python 生成一个中文 PCM：读取 WAV 去掉头得到 PCM
function loadPcmFromWav(wavPath) {
  const buf = fs.readFileSync(wavPath)
  let off = 12
  while (off < buf.length - 8) {
    const id = buf.toString('utf8', off, off + 4)
    const sz = buf.readUInt32LE(off + 4)
    if (id === 'data') return buf.subarray(off + 8, off + 8 + sz)
    off += 8 + sz
  }
  throw new Error('no data chunk')
}

// 生成中文语音（使用 say 说中文）
const { execSync } = require('child_process')
execSync('say -o /tmp/chinese.wav --data-format=LEI16@16000 "今天天气怎么样" 2>/dev/null', { stdio: 'pipe' })
const pcmData = loadPcmFromWav('/tmp/chinese.wav')
console.log(`PCM 数据大小: ${pcmData.length} bytes (${(pcmData.length / 16000 / 2).toFixed(2)}s)`)

ws.on('open', () => {
  console.log('WebSocket 已连接')
  // 按 1280 字节分片发送
  const FRAME_SIZE = 1280
  let offset = 0
  let paused = false

  function sendFrame() {
    if (paused) return

    if (offset >= pcmData.length) {
      status = STATUS.LAST
      sendChunk(Buffer.alloc(0))
      return
    }

    const end = Math.min(offset + FRAME_SIZE, pcmData.length)
    const chunk = pcmData.slice(offset, end)
    sendChunk(chunk)
    offset = end

    if (offset < pcmData.length) {
      // 等待 40ms（与 demo 一致）
      const stop = Date.now() + 40
      while (Date.now() < stop) { /* busy wait */ }
      setImmediate(sendFrame)
    }
  }

  function sendChunk(data) {
    let frame
    switch (status) {
      case STATUS.FIRST:
        // 第一次发送：init + 第一帧音频
        frame = {
          common: { app_id: APP_ID },
          business: {
            sub: 'ise',
            ent: 'cn_vip',
            category: 'read_sentence',
            text: '\uFEFF今天天气怎么样',
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
        console.log('发送 init 帧')

        // 然后立即发送第一帧音频
        frame = {
          common: { app_id: APP_ID },
          business: { aus: 1, cmd: 'auw', aue: 'raw' },
          data: { status: 1, data: data.toString('base64') },
        }
        status = STATUS.CONTINUE
        console.log(`  音频帧: aus=1, size=${data.length}`)
        break

      case STATUS.CONTINUE:
        frame = {
          common: { app_id: APP_ID },
          business: { aus: 2, cmd: 'auw', aue: 'raw' },
          data: { status: 1, data: data.toString('base64') },
        }
        console.log(`  音频帧: aus=2, size=${data.length}`)
        break

      case STATUS.LAST:
        frame = {
          common: { app_id: APP_ID },
          business: { aus: 4, cmd: 'auw', aue: 'raw' },
          data: { status: 2, data: data.toString('base64') },
        }
        console.log('  音频帧: aus=4 (LAST)')
        break
    }
    ws.send(JSON.stringify(frame))
  }

  sendFrame()
})

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  console.log(`  收到: code=${msg.code}, status=${msg.data?.status}, sid=${(msg.sid || '').slice(0, 30)}`)

  if (msg.code !== 0) {
    console.error(`  ❌ 错误 ${msg.code}: ${msg.message}`)
    return
  }

  if (msg.data?.status === 2) {
    const xml = msg.data.data ? Buffer.from(msg.data.data, 'base64').toString() : ''
    console.log('✅ 评分成功!')
    console.log('XML:', xml.slice(0, 500))
    ws.close()
  }
})

ws.on('error', (err) => console.error('WS error:', err.message))
ws.on('close', (code) => console.log(`close code=${code}`))

setTimeout(() => { console.log('TIMEOUT'); process.exit(1) }, 30000)