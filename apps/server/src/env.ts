import { existsSync } from 'node:fs'
import { z } from 'zod'

// 加载 .env（Node 20.12+ 内置，零依赖）
// ⚠️ 必须在读取 process.env 之前执行
if (existsSync('.env')) {
  process.loadEnvFile('.env')
}

/**
 * 环境变量校验 —— 启动时一次性校验，缺失立即失败。
 * ⚠️ 不要让配置错误在运行时才暴露。
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  TOKEN_SECRET: z.string().min(8, 'TOKEN_SECRET 至少 8 位'),
  ENGINE: z.enum(['mock', 'xfyun']).default('mock'),
  XFYUN_APP_ID: z.string().optional(),
  XFYUN_API_KEY: z.string().optional(),
  XFYUN_API_SECRET: z.string().optional(),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('❌ 环境变量校验失败：')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data

// 选了真实引擎却没配密钥 —— 早失败
if (env.ENGINE === 'xfyun') {
  const missing = (['XFYUN_APP_ID', 'XFYUN_API_KEY', 'XFYUN_API_SECRET'] as const).filter(
    (k) => !env[k],
  )
  if (missing.length > 0) {
    console.error(`❌ ENGINE=xfyun 但缺少：${missing.join(', ')}`)
    process.exit(1)
  }
}
