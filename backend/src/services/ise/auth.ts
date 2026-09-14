import crypto from 'crypto'

const HOST = 'ise-api.xfyun.cn'
const PATH = '/v2/open-ise'

export function generateAuthUrl(): string {
  const apiKey = process.env.XFYUN_API_KEY
  const apiSecret = process.env.XFYUN_API_SECRET

  if (!apiKey || !apiSecret) {
    throw new Error('XFYUN_API_KEY 或 XFYUN_API_SECRET 未配置')
  }

  // RFC1123 GMT 时间
  const date = new Date().toUTCString()

  // 构造签名字符串
  const signatureOrigin = `host: ${HOST}\ndate: ${date}\nGET ${PATH} HTTP/1.1`

  // HMAC-SHA256 签名
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(signatureOrigin, 'utf8')
    .digest('base64')

  // Authorization 字符串
  const authorization =
    `api_key="${apiKey}", ` +
    `algorithm="hmac-sha256", ` +
    `headers="host date request-line", ` +
    `signature="${signature}"`

  // authorization → base64 + URL 编码
  const authorizationB64 = encodeURIComponent(
    Buffer.from(authorization, 'utf8').toString('base64'),
  )
  // date / host → 不编码（官方 demo 一致）
  return `wss://${HOST}${PATH}?authorization=${authorizationB64}&date=${date}&host=${HOST}`
}