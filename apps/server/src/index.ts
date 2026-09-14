import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serve } from '@hono/node-server'
import { env } from './env'
import { authMiddleware } from './middleware/auth'
import { authRoutes } from './routes/auth'
import { arenasRoutes } from './routes/arenas'
import { submissionsRoutes } from './routes/submissions'
import { userRoutes } from './routes/user'

const app = new Hono()

app.use('*', logger())
app.use('*', cors({
  origin: (origin) => origin ?? '*',
  credentials: true,
}))

// 健康检查（部署探针用）
app.get('/health', (c) => c.json({ status: 'ok', engine: env.ENGINE }))

// 公开路由
app.route('/api/auth', authRoutes)

// 需鉴权路由
app.use('/api/arenas/*', authMiddleware)
app.use('/api/submissions/*', authMiddleware)
app.use('/api/user/*', authMiddleware)

app.route('/api/arenas', arenasRoutes)
app.route('/api/submissions', submissionsRoutes)
app.route('/api/user', userRoutes)

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[server] http://localhost:${info.port}  engine=${env.ENGINE}`)
})

export { app }

