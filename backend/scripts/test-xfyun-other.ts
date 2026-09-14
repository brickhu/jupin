/**
 * 测试讯飞 REST API（不同鉴权方式），彻底排查凭证问题
 */
import crypto from 'crypto'
import https from 'https'

const APP_ID = process.env.XFYUN_APP_ID!
const API_KEY = process.env.XFYUN_API_KEY!
const API_SECRET = process.env.XFYUN_API_SECRET!

console.log('=== 讯飞 REST API 鉴权测试 ===')
console.log('APP_ID:', APP_ID)
console.log('API_KEY:', API_KEY)
console.log('API_SECRET:', API_SECRET?.slice(0, 8) + '...')

// 讯飞中文纠错 REST API（使用 X-Appid + MD5 鉴权）
function testNlpCorrector() {
  return new Promise<void>((resolve) => {
    console.log('\n📡 测试 中文纠错 REST API...')
    
    const curTime = Math.floor(Date.now() / 1000).toString()
    const body = JSON.stringify({ text: '我是一名学生' })
    const param = Buffer.from(JSON.stringify({ type: 'result' })).toString('base64')
    const checkSum = crypto.createHash('md5')
      .update(API_KEY + curTime + param).digest('hex')

    const postData = JSON.stringify({
      header: { app_id: APP_ID, status: 3 },
      parameter: { 'tchy-correct': { category: 'result' } },
      payload: { 'tchy-correct': { encoding: 'utf8', sequence: 0, status: 3, text: Buffer.from(body).toString('base64') } }
    })

    const options = {
      hostname: 'tchy-api.xfyun.cn',
      path: '/v2.1/tchy-correct',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Appid': APP_ID,
        'X-CurTime': curTime,
        'X-Param': param,
        'X-CheckSum': checkSum,
      },
    }

    const req = https.request(options, (res) => {
      let body = ''
      res.on('data', (chunk: string) => body += chunk)
      res.on('end', () => {
        console.log(`  HTTP ${res.statusCode}: ${body.slice(0, 200)}`)
        if (res.statusCode === 401 || res.statusCode === 403) {
          console.log('  ❌ API 凭证无效')
        } else if (res.statusCode === 200) {
          try {
            const j = JSON.parse(body)
            if (j.header?.code === 0) {
              console.log('  ✅ 有效凭证 + 服务正常！')
            } else {
              console.log(`  ⚠️ 凭证有效，服务返回: code=${j.header?.code}`)
            }
          } catch {
            console.log('  ⚠️ 凭证有效（无法解析响应）')
          }
        } else {
          console.log('  ⚠️ 凭证可能有效（服务返回非预期状态码）')
        }
        resolve()
      })
    })
    req.on('error', (e) => {
      console.log(`  ❌ 请求失败: ${e.message}`)
      resolve()
    })
    req.write(postData)
    req.end()
  })
}

// 讯飞语音评测（HTTP 方式）- 如果有的话
function testIseHttp() {
  return new Promise<void>((resolve) => {
    console.log('\n📡 测试 ISE HTTP API...')
    
    const curTime = Math.floor(Date.now() / 1000).toString()
    const param = Buffer.from(JSON.stringify({})).toString('base64')
    const checkSum = crypto.createHash('md5')
      .update(API_KEY + curTime + param).digest('hex')

    const options = {
      hostname: 'ise-api.xfyun.cn',
      path: '/v2/open-ise',  // 试 HTTP
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Host': 'ise-api.xfyun.cn',
        'X-Appid': APP_ID,
        'X-CurTime': curTime,
        'X-Param': param,
        'X-CheckSum': checkSum,
      },
    }

    const req = https.request(options, (res) => {
      let body = ''
      res.on('data', (chunk: string) => body += chunk)
      res.on('end', () => {
        console.log(`  HTTP ${res.statusCode}: ${body.slice(0, 200)}`)
        if (res.statusCode === 401 || res.statusCode === 403) {
          console.log('  ❌ API 凭证无效')
        } else {
          console.log('  ⚠️ 不同鉴权方式的结果')
        }
        resolve()
      })
    })
    req.on('error', (e) => {
      console.log(`  ❌ 请求失败: ${e.message}`)
      resolve()
    })
    req.write(JSON.stringify({}))
    req.end()
  })
}

async function main() {
  await testNlpCorrector()
  await testIseHttp()
  console.log('\n=== 测试完成 ===')
  process.exit(0)
}
main()