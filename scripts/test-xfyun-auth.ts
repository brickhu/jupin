/**
 * 快速测试讯飞 ISE 鉴权是否通过
 * 运行: npx tsx scripts/test-xfyun-auth.ts
 */
import { generateAuthUrl } from '../backend/src/services/ise/auth'

const url = generateAuthUrl()
console.log('=== 讯飞 ISE 鉴权测试 ===')
console.log('WebSocket URL (前 200 字符):', url.slice(0, 200) + '...')

// 尝试建立 WebSocket 连接
import WebSocket from 'ws'

const ws = new WebSocket(url)
let settled = false

ws.on('open', () => {
  console.log('✅ WebSocket 连接成功！鉴权通过')
  const initFrame = JSON.stringify({
    common: { app_id: process.env.XFYUN_APP_ID },
    business: {
      aue: 'raw',
      auf: 'audio/L16;rate=16000',
      category: 'read_sentence',
      cmd: 'ssb',
      ent: 'en_vip',
      sub: 'ise',
      text: Buffer.from('Hello world.', 'utf8').toString('base64'),
      ttp_skip: true,
      extra_ability: 'multi_dimension',
    },
    data: { status: 0 },
  })
  ws.send(initFrame)

  // 发一个结束帧（无音频）
  setTimeout(() => {
    const endFrame = JSON.stringify({
      business: { cmd: 'ssb', aus: 4 },
      data: { status: 2 },
    })
    ws.send(endFrame)
  }, 500)
})

ws.on('message', (data: Buffer) => {
  const msg = JSON.parse(data.toString('utf8'))
  console.log('📩 收到响应:', JSON.stringify(msg, null, 2))
  if (msg.code === 0) {
    console.log('✅ 响应 code=0，业务鉴权通过！')
  } else {
    console.log(`❌ 响应 code=${msg.code}: ${msg.message}`)
  }
  if (msg.data?.status === 2) {
    console.log('🏁 评测完成')
    settled = true
    ws.close()
  }
})

ws.on('error', (err) => {
  console.error('❌ WebSocket 错误:', err.message)
  settled = true
})

ws.on('close', (code) => {
  console.log(`🔌 连接关闭, code=${code}`)
  if (!settled) {
    console.error('❌ 连接意外关闭，鉴权可能失败')
  }
  process.exit(settled ? 0 : 1)
})

setTimeout(() => {
  if (!settled) {
    console.error('❌ 超时：30 秒未收到响应')
    ws.close()
    process.exit(1)
  }
}, 30000)