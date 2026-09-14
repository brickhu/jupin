import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serve } from '@hono/node-server'
import { authRoutes } from './routes/auth'
import { articlesRoutes } from './routes/articles'
import { readingsRoutes } from './routes/readings'
import { userRoutes } from './routes/user'
import { statsRoutes } from './routes/stats'
import { paymentRoutes } from './routes/payment'
import { shareRoutes } from './routes/share'
import { authMiddleware } from './middleware/auth'
import { rateLimitMiddleware } from './middleware/rate-limit'

const app = new Hono()

// 全局中间件
app.use('*', cors({
  origin: (origin) => {
    const allowed = [
      'https://jushuo.zeabur.app',
      'https://jushuo.app',
      'http://localhost:5173',
    ]
    if (!origin || allowed.includes(origin)) return origin
    if (origin.endsWith('.aliyuncs.com')) return origin
    if (origin.endsWith('.jushuo.app')) return origin
    return undefined
  },
  credentials: true,
}))
app.use('*', logger())

// 公开路由
app.route('/api/auth', authRoutes)
app.route('/api/share', shareRoutes)
app.route('/api/payment/notify', paymentRoutes)

// 需要鉴权的路由
app.use('/api/*', authMiddleware)
app.use('/api/*', rateLimitMiddleware)
app.route('/api/user', userRoutes)
app.route('/api/articles', articlesRoutes)
app.route('/api/readings', readingsRoutes)
app.route('/api/stats', statsRoutes)
app.route('/api/payment', paymentRoutes)

// 健康检查
app.get('/health', (c) => c.json({ status: 'ok' }))

const port = parseInt(process.env.PORT || '3000')
console.log(`Server running on port ${port}`)

serve({ fetch: app.fetch, port })