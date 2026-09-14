/**
 * 测试讯飞 ISE 鉴权 - 尝试不同的 URL 编码方式
 */
import crypto from 'crypto'
import WebSocket from 'ws'
import http from 'http'
import https from 'https'

const HOST = 'ise-api.xfyun.cn'
const PATH = '/v2/open-ise'

const apiKey = process.env.XFYUN_API_KEY!
const apiSecret = process.env.XFYUN_API_SECRET!

console.log('=== 讯飞 ISE 鉴权测试 - 对比编码方式 ===')
console.log('APP_ID:', process.env.XFYUN_APP_ID)
console.log('API_KEY:', apiKey)

function buildUrl(encodeHost: boolean, encodeDate: boolean): { url: string, date: string } {
  const date = new Date().toUTCString()
  const signatureOrigin = `host: ${HOST}\ndate: ${date}\nGET ${PATH} HTTP/1.1`
  const signature = crypto.createHmac('sha256', apiSecret)
    .update(signatureOrigin, 'utf8').digest('base64')
  const authorization = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`
  const authB64 = Buffer.from(authorization, 'utf8').toString('base64')
  
  const enc = (s: string) => encodeURIComponent(s)
  const encB64 = (s: string) => encodeURIComponent(Buffer.from(s, 'utf8').toString('base64'))
  
  const hostParam = encodeHost ? encB64(HOST) : enc(HOST)
  const dateParam = encodeDate ? encB64(date) : enc(date)
  
  return {
    url: `wss://${HOST}${PATH}?authorization=${encB64(authorization)}&date=${dateParam}&host=${hostParam}`,
    date
  }
}

function testConnection(label: string, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(`\n📡 ${label}...`)
    console.log(`  URL (前 150 字符): ${url.slice(0, 150)}...`)
    
    const ws = new WebSocket(url)
    let settled = false
    
    ws.on('open', () => {
      console.log('  ✅ 连接成功！')
      ws.close()
      settled = true
      resolve(true)
    })
    
    ws.on('error', (err) => {
      console.log(`  ❌ 失败: ${err.message}`)
      settled = true
      resolve(false)
    })
    
    ws.on('close', (code) => {
      if (!settled) {
        console.log(`  ❌ 连接关闭, code=${code}`)
        resolve(false)
      }
    })
    
    setTimeout(() => {
      if (!settled) { ws.close(); resolve(false) }
    }, 5000)
  })
}

async function main() {
  // 方式 1: 只有 authorization base64 (CSDN Demo 的方式)
  const { url: url1 } = buildUrl(false, false)
  await testConnection('方式1: host/date 不编码 (CSDN Demo 方式)', url1)

  // 方式 2: host 不编码, date base64
  const { url: url2 } = buildUrl(false, true)
  await testConnection('方式2: host 不编码, date base64', url2)

  // 方式 3: 全部 base64 (当前代码的方式)
  const { url: url3 } = buildUrl(true, true)
  await testConnection('方式3: 全部 base64 (当前代码方式)', url3)

  // 方式 4: host base64, date 不编码
  const { url: url4 } = buildUrl(true, false)
  await testConnection('方式4: host base64, date 不编码', url4)

  console.log('\n=== 测试完成 ===')
  process.exit(0)
}

main()