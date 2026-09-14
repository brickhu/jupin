/**
 * 测试完整评分流程：注册 → 登录 → 打分
 */
import fs from 'fs'

const BASE = 'http://localhost:3000'
const TEST_EMAIL = `test-ise-${Date.now()}@jushuo.com`
const TEST_PWD = 'test123456'

async function main() {
  console.log('=== 测试完整评分流程 ===\n')
  
  // 1. 发送验证码
  console.log('📡 发送验证码到', TEST_EMAIL)
  const codeResp = await fetch(`${BASE}/api/auth/send-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL }),
  })
  const codeData: any = await codeResp.json()
  console.log('  响应:', JSON.stringify(codeData))
  
  // 2. 从 Mailpit 获取验证码（轮询等待邮件到达）
  console.log('📡 从 Mailpit 获取验证码...')
  let ourMsg: any = null
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const mailpitResp = await fetch('http://localhost:8025/api/v1/messages')
    const mailpitData: any = await mailpitResp.json()
    ourMsg = mailpitData.messages?.find(
      (m: any) => m.To?.some((t: any) => t.Address === TEST_EMAIL)
    )
    if (ourMsg) break
    if (i < 9) process.stdout.write('.')
  }
  if (!ourMsg) {
    console.error('\n  ❌ 未找到发给', TEST_EMAIL, '的邮件')
    process.exit(1)
  }
  console.log(' ✅')
  
  const msgResp = await fetch(`http://localhost:8025/api/v1/message/${ourMsg.ID}`)
  const msgData: any = await msgResp.json()
  const body = msgData.Text || ''
  const codeMatch = body.match(/(\d{6})/)
  const code = codeMatch ? codeMatch[1] : null
  if (!code) {
    console.error('  ❌ 未找到验证码')
    process.exit(1)
  }
  console.log('  ✅ 验证码:', code)
  
  // 3. 注册
  console.log('📡 注册...')
  const registerResp = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PWD, code }),
  })
  const registerData: any = await registerResp.json()
  console.log('  响应:', JSON.stringify(registerData))
  
  // 4. 登录
  console.log('📡 登录...')
  const loginResp = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PWD }),
  })
  const loginData: any = await loginResp.json()
  console.log('  响应:', JSON.stringify(loginData))
  
  const token = loginData.token
  if (!token) {
    console.error('  ❌ 登录失败')
    process.exit(1)
  }
  console.log('  ✅ Token:', token.slice(0, 30) + '...')
  
  // 4. 获取文章
  console.log('\n📡 获取文章...')
  const articlesResp = await fetch(`${BASE}/api/articles/today`, {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  const articlesData: any = await articlesResp.json()
  const articles = articlesData.articles || []
  if (articles.length === 0) {
    console.error('  ❌ 没有文章')
    process.exit(1)
  }
  const article = articles[0]
  console.log('  ✅ 文章 ID:', article.id, '内容:', (article.content || '').slice(0, 50) + '...')
  
  // 5. 生成测试 WAV 音频（1 秒非静音正弦波 PCM，16kHz 16bit mono）
  console.log('\n📡 提交评分...')
  const sampleRate = 16000
  const pcmData = Buffer.alloc(sampleRate * 2 * 1)
  // 填充 1kHz 正弦波（50% 音量）
  for (let i = 0; i < pcmData.length; i += 2) {
    const t = i / 2 / sampleRate
    const amp = 32767 * 0.5
    const val = Math.sin(2 * Math.PI * 1000 * t) * amp
    pcmData.writeInt16LE(Math.round(val), i)
  }
  
  const wavHeader = Buffer.alloc(44)
  wavHeader.write('RIFF', 0)
  wavHeader.writeUInt32LE(36 + pcmData.length, 4)
  wavHeader.write('WAVE', 8)
  wavHeader.write('fmt ', 12)
  wavHeader.writeUInt32LE(16, 16)
  wavHeader.writeUInt16LE(1, 20)
  wavHeader.writeUInt16LE(1, 22)
  wavHeader.writeUInt32LE(sampleRate, 24)
  wavHeader.writeUInt32LE(sampleRate * 2, 28)
  wavHeader.writeUInt16LE(2, 32)
  wavHeader.writeUInt16LE(16, 34)
  wavHeader.write('data', 36)
  wavHeader.writeUInt32LE(pcmData.length, 40)
  
  const wavBuffer = Buffer.concat([wavHeader, pcmData])
  const tmpFile = '/tmp/test-score.wav'
  fs.writeFileSync(tmpFile, wavBuffer)
  
  // 用 form-data 提交
  const form = new FormData()
  form.append('audio', new Blob([wavBuffer], { type: 'audio/wav' }), 'test.wav')
  form.append('articleId', String(article.id))
  
  const scoreResp = await fetch(`${BASE}/api/readings/score`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: form,
  })
  
  const scoreData = await scoreResp.json()
  console.log('  状态码:', scoreResp.status)
  console.log('  响应:', JSON.stringify(scoreData, null, 2))
  
  fs.unlinkSync(tmpFile)
  
  if (scoreResp.status === 200) {
    console.log('\n✅🎉 评分成功！ISE 服务正常工作！')
  } else {
    console.log(`\n❌ 评分失败`)
  }
}

main().catch(console.error)