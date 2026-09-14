# 句说 · 技术架构文档

> 本文档定义句说的完整技术架构，与 `../AGENTS.md` 技术栈部分保持一致。

---

## 一、整体架构

```
┌─────────────────────────────────────────────────────────┐
│                      用户手机浏览器                       │
│            (iOS Safari / Android Chrome)                │
└──────────────┬──────────────────────┬───────────────────┘
               │                      │
        HTTPS  │                      │  HTTPS
               ▼                      ▼
┌──────────────────────┐  ┌──────────────────────────────┐
│  Zeabur 前端应用      │  │  Zeabur 后端应用              │
│  jushuo.zeabur.app   │  │  api-jushuo.zeabur.app       │
│  (静态站点)           │  │  (Hono Node.js 服务)         │
│  SolidJS + Vite      │  │  ├─ /api/auth/*              │
│  + TailwindCSS 4     │  │  ├─ /api/articles/*          │
│  git push 自动部署    │  │  ├─ /api/readings/*          │
└──────────────────────┘  │  ├─ /api/payment/*           │
                          │  └─ /api/share/*             │
                          │           │                   │
                          │           ▼                   │
                          │  ┌──────────────────────┐    │
                          │  │ Zeabur PostgreSQL    │    │
                          │  │ (Marketplace 一键创建)│    │
                          │  │ Drizzle ORM 管理      │    │
                          │  └──────────────────────┘    │
                          │                               │
                          │  外部 API 调用:               │
                          │  ├─ Azure Speech API (评分)   │
                          │  ├─ DeepSeek V4-Flash (建议)  │
                          │  └─ 支付宝 OpenAPI (支付)     │
                          └──────────────────────────────┘
```

**部署方案：** 前后端分别创建为两个 Zeabur Service，共享同一 Zeabur Project。PostgreSQL 通过 Zeabur Marketplace 一键添加，连接字符串自动注入后端环境变量。`git push main` 自动触发部署。

---

## 二、项目目录结构

```
jushuo/
├── frontend/                     # 前端 (SolidJS + TailwindCSS 4.0 + Vite)
│   ├── public/                   # 静态资源 (favicon, PWA icons)
│   ├── src/
│   │   ├── components/           # 通用组件
│   │   ├── pages/                # 页面级组件
│   │   ├── hooks/                # SolidJS 自定义 hooks
│   │   ├── services/             # API 调用封装
│   │   ├── stores/               # 全局状态
│   │   ├── utils/                # 工具函数
│   │   ├── types/                # TypeScript 类型
│   │   ├── App.tsx
│   │   └── index.tsx
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── package.json
│
├── backend/                      # 后端 (Hono + Drizzle + PostgreSQL)
│   ├── src/
│   │   ├── routes/               # 路由定义
│   │   ├── controllers/          # 请求处理
│   │   ├── services/             # 业务逻辑层
│   │   │   ├── scoring.ts        # 评分计算 (Q/E/P)
│   │   │   ├── azure.ts          # Azure Speech 调用
│   │   │   ├── deepseek.ts       # DeepSeek 发音建议
│   │   │   ├── content.ts        # AI 内容生成
│   │   │   └── payment.ts        # 支付宝支付
│   │   ├── db/                   # Drizzle 配置
│   │   │   ├── schema.ts         # 数据库 schema 定义
│   │   │   ├── index.ts          # 数据库连接
│   │   │   └── migrations/       # Drizzle 迁移文件
│   │   ├── middleware/           # Hono 中间件 (auth, rate-limit, cors)
│   │   ├── config/               # 环境配置
│   │   ├── utils/                # 工具函数
│   │   └── index.ts              # Hono 应用入口
│   ├── Dockerfile                # （可选）Zeabur 可自动识别，也可手动指定
│   ├── .env.example
│   ├── drizzle.config.ts         # Drizzle Kit 配置
│   └── package.json
│
├── scripts/                      # 工具脚本
│   ├── content-generator.ts      # AI 内容批量生成 (DeepSeek)
│   └── seed-articles.ts          # 初始文章数据填充
│
├── docs/                         # 项目文档
│   ├── product.md                # 产品定义
│   ├── mvp-spec.md               # MVP 规格
│   ├── tech-stack.md             # 技术栈参考
│   ├── growth.md                 # 增长运营
│   ├── architecture.md           # 本文件
│   ├── scoring-system.md         # 积分系统算法
│   └── ise-integration-plan.md   # 科大讯飞备份方案
│
└── AGENTS.md                     # 项目上下文（入口文件）
```

---

## 三、前端架构

### 3.1 技术栈

| 项 | 选型 | 理由 |
|----|------|------|
| 框架 | **SolidJS** (v1.x) + TypeScript | 无虚拟 DOM，~7KB gzip，响应式性能接近原生 |
| 构建 | **Vite** | 秒启 HMR，SolidJS 原生支持 |
| CSS | **TailwindCSS 4.0** | Rust 引擎，CSS-first 配置，一行 `@import "tailwindcss"` |
| 路由 | **@solidjs/router** | 官方路由，懒加载支持 |
| 图表 | **Chart.js** | 轻量折线图，绘制能力分趋势 |
| 录音 | **Web Audio API + MediaRecorder** | 原生 API，零依赖 |
| HTTP | 原生 **fetch** | Hono 服务端也基于 Web Standards，无需额外客户端 |

### 3.2 页面路由

| 路由 | 页面 | 权限 |
|------|------|------|
| `/login` | 登录页（邮箱+密码） | 公开 |
| `/` | 首页（今日推荐+录音入口） | 登录 |
| `/result/:id` | 评分结果页（免费版/付费版） | 登录 |
| `/profile` | 个人中心（曲线+历史+徽章） | 登录 |
| `/subscribe` | 订阅页 | 登录 |
| `/share/:id` | 分享页 | 公开 |

### 3.3 Vite 配置要点

```typescript
// frontend/vite.config.ts
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
```

> Zeabur 自动识别 Vite 项目，执行 `pnpm build` 并将 `dist/` 作为静态站点发布。

---

## 四、后端架构

### 4.1 技术栈

| 项 | 选型 | 理由 |
|----|------|------|
| 运行时 | **Node.js 20 LTS** | 稳定，ESM 原生 |
| 框架 | **Hono** (v4.x) | Web Standards API，内置 CORS/JWT/限流中间件，TypeScript 一等公民 |
| 数据库 | **PostgreSQL 17** | JSONB 完美存储发音错误详情，事务可靠，Drizzle 最佳搭档 |
| ORM | **Drizzle ORM** | TS-first，零运行时开销，内置迁移工具，SQL-like API |
| 校验 | **Zod** | 与 Hono 生态无缝集成，请求参数类型校验 |
| 日志 | **pino** | 高性能结构化 JSON 日志 |

**为什么选 Hono 而非 Express：**
1. 基于 Web Standards（Request/Response），与前端 fetch API 同构
2. 内置中间件：`hono/cors`、`hono/jwt`、`hono/rate-limiter`，无需安装额外包
3. RPC 模式支持端到端类型安全（`hc` 客户端），前后端共享类型
4. 更好的 TypeScript 类型推断

**为什么选 PostgreSQL 而非 MySQL：**
1. **JSONB**：Azure 返回的音素级错误详情是嵌套 JSON，PostgreSQL 的 JSONB 支持远优于 MySQL 的 JSON
2. Drizzle ORM 在 PostgreSQL 上功能最完整
3. `TEXT[]` 数组类型方便存储多值字段

### 4.2 API 路由设计

```
# 认证
POST   /api/auth/register          # 邮箱注册
POST   /api/auth/login             # 邮箱登录
POST   /api/auth/refresh           # 刷新 JWT

# 用户
GET    /api/user/me                # 获取当前用户信息
GET    /api/user/proficiency       # 获取能力分+等级+攻克进度
GET    /api/user/experience        # 获取经验分+称号+streak

# 文章
GET    /api/articles/today         # 获取今日推荐文章（按能力分推荐）
GET    /api/articles/:id           # 获取文章详情
GET    /api/articles/list          # 文章列表（分页+按难度筛选）

# 朗读评分（核心）
POST   /api/readings/score         # 提交录音 → 返回评分
                                     # multipart/form-data: audio + articleId
                                     # 返回: { qualityScore, expGained, proficiency, isConquered }
GET    /api/readings/history       # 朗读历史（分页）
GET    /api/readings/:id/detail    # 朗读详情（付费用户返回纠音+AI建议）

# 能力曲线（付费）
GET    /api/stats/proficiency-curve  # 能力分趋势数据
GET    /api/stats/quality-scatter    # 质量分散点数据
GET    /api/stats/experience-curve   # 经验分累计数据

# 支付
POST   /api/payment/unlock         # 单篇解锁（创建支付宝订单）
POST   /api/payment/subscribe      # Pro 订阅（签约周期扣款）
POST   /api/payment/notify         # 支付宝异步通知回调
GET    /api/payment/status/:id     # 查询订单状态

# 分享
GET    /api/share/:id              # 分享页数据

# 内容管理（内部/管理员）
POST   /api/admin/generate         # 触发 AI 内容生成
POST   /api/admin/articles         # 手动发布文章
```

### 4.3 评分核心流程

```
POST /api/readings/score
    │
    ▼
1. 中间件检查：
   ├─ JWT 鉴权
   └─ 限流检查（免费 5次/日，付费 500次/日）
    │
    ▼
2. 录音处理：
   ├─ 接收音频文件（WebM/MP4）
   ├─ 格式检查/转码（统一为 Azure 需要的格式）
   └─ 音频时长限制（最长 30 秒）
    │
    ▼
3. Azure Speech API 评分：
   ├─ 调用 pronunciationAssessment
   └─ 返回四维度分数 + 单词级/音素级错误
    │
    ▼
4. 计算 Q（质量分）：
   Q = (Accuracy + Fluency + Completeness + Prosody) / 4
    │
    ├── Q < 30 → 无效：0 经验，不进能力分，返回错误提示
    │
    ├── 30 ≤ Q < 60 → 练习级：给经验，不进能力分
    │
    └── Q ≥ 60 → 有效：给经验，进能力分
         │
         ▼
5. 计算 E（经验分）：
   ├─ 检查该用户是否首次读本文（isFirstRead）
   ├─ 首次且 Q ≥ 30 → E = D × 100，累加 total_experience
   └─ 非首次 → E = 0
    │
    ▼
6. 计算 P（能力分）：
   ├─ 查询用户最近 20 篇有效朗读记录（同篇取最高分）
   ├─ 加入本次记录（Q≥60时）
   ├─ 计算加权平均 P_new = Σ(Q×D) / ΣD
   ├─ 更新用户 proficiency_score
   └─ 检查是否达成新攻克（Q≥70）/ 完美攻克（Q≥90）
    │
    ▼
7. AI 发音建议（缓存优先）：
   ├─ 仅对 Q ≥ 30 的有效/练习级处理
   ├─ 查询缓存：按 (word, errorType) 匹配已缓存建议
   ├─ 未命中的错误词 → 调用 DeepSeek V4-Flash 生成中文建议
   ├─ 缓存新生成的建议
   └─ 注意：AI 建议仅付费用户可见，免费用户此字段为 null
    │
    ▼
8. 保存朗读记录到 DB
    │
    ▼
9. 返回结果：
   免费用户 → { qualityScore, expGained, proficiency, level, isConquered }
   付费用户 → 上述 + { errorWords, aiSuggestions }
```

### 4.4 DeepSeek AI 发音建议设计

**触发时机：** Azure 评分完成后，对错误单词生成建议。

**Prompt 示例：**
```
你是一位专业的英语发音教练，面向中国学习者。
以下单词读错了：
- 单词: "way"，正确音标: /weɪ/，用户读成了: /waɪ/
- 单词: "the"，正确音标: /ðə/，用户读成了: /zə/

请为每个单词给出1-2句简短的中文发音建议，包括：
1. 口型/舌位提示
2. 中国学习者常见错误提醒
3. 一个简单的练习方法

语气友好鼓励，避免术语堆砌。
```

**缓存策略：**
- 以 `(word, phoneme_error_type)` 为 key 缓存建议结果
- 缓存存储在 PostgreSQL 中（`pronunciation_tips` 表）
- 常见错误（如 /θ/→/s/、/w/→/v/、/eɪ/→/aɪ/）命中率预计 >80%
- 大幅降低 DeepSeek API 调用成本（每次评分实际新增 API 调用可能为 0-2 次）

**成本估算：**
- DeepSeek V4-Flash 输出 ~¥2/百万 tokens
- 每条建议约 100 tokens，1000 次评分约 ¥0.4-2
- 缓存命中后边际成本趋零

### 4.5 Hono 应用入口示例

```typescript
// backend/src/index.ts
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { jwt } from 'hono/jwt'
import { rateLimiter } from './middleware/rate-limiter'
import { authRoutes } from './routes/auth'
import { userRoutes } from './routes/user'
import { articlesRoutes } from './routes/articles'
import { readingsRoutes } from './routes/readings'
import { paymentRoutes } from './routes/payment'
import { shareRoutes } from './routes/share'
import { statsRoutes } from './routes/stats'

const app = new Hono()

// 全局中间件
app.use('*', cors())
app.use('/api/*', rateLimiter())

// 公开路由
app.route('/api/auth', authRoutes)
app.route('/api/share', shareRoutes)

// 需要鉴权的路由
app.use('/api/*', jwt({ secret: process.env.JWT_SECRET! }))
app.route('/api/user', userRoutes)
app.route('/api/articles', articlesRoutes)
app.route('/api/readings', readingsRoutes)
app.route('/api/stats', statsRoutes)
app.route('/api/payment', paymentRoutes)

export default app
```

> Zeabur 自动识别 Hono 项目，监听 `PORT` 环境变量（默认 3000），无需额外配置。

---

## 五、数据库设计（Drizzle Schema）

### 5.1 核心表

```typescript
// backend/src/db/schema.ts
import { pgTable, serial, varchar, text, integer, decimal, 
         boolean, jsonb, timestamp, date, bigint, pgEnum } from 'drizzle-orm/pg-core'

// 订阅类型枚举
export const subscriptionTypeEnum = pgEnum('subscription_type', ['single', 'monthly', 'yearly'])
export const paymentStatusEnum = pgEnum('payment_status', ['pending', 'success', 'refunded', 'failed'])

// 用户表
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  nickname: varchar('nickname', { length: 64 }),
  proficiencyScore: decimal('proficiency_score', { precision: 4, scale: 1 }).default('0').notNull(),
  totalExperience: integer('total_experience').default(0).notNull(),
  honorTitle: varchar('honor_title', { length: 32 }).default('朗读者').notNull(),
  streakDays: integer('streak_days').default(0).notNull(),
  lastReadAt: timestamp('last_read_at'),
  subscriptionEnd: timestamp('subscription_end'),
  dailySubmissionsLeft: integer('daily_submissions_left').default(5).notNull(),
  dailyResetDate: date('daily_reset_date').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// 文章表
export const articles = pgTable('articles', {
  id: serial('id').primaryKey(),
  content: text('content').notNull(),
  translation: varchar('translation', { length: 1024 }),
  difficulty: decimal('difficulty', { precision: 2, scale: 1 }).notNull(),
  dLen: decimal('d_len', { precision: 2, scale: 1 }).default('0').notNull(),
  dVocab: decimal('d_vocab', { precision: 2, scale: 1 }).default('0').notNull(),
  dSyntax: decimal('d_syntax', { precision: 2, scale: 1 }).default('0').notNull(),
  wordCount: integer('word_count').notNull(),
  sourceType: varchar('source_type', { length: 32 }).default('quote').notNull(),
  author: varchar('author', { length: 128 }),
  publishDate: date('publish_date'),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// 朗读记录表
export const readings = pgTable('readings', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  articleId: integer('article_id').references(() => articles.id).notNull(),
  qualityScore: decimal('quality_score', { precision: 4, scale: 1 }).notNull(),
  experienceGained: integer('experience_gained').default(0).notNull(),
  proficiencyBefore: decimal('proficiency_before', { precision: 4, scale: 1 }),
  proficiencyAfter: decimal('proficiency_after', { precision: 4, scale: 1 }),
  isPaid: boolean('is_paid').default(false).notNull(),
  isBest: boolean('is_best').default(false).notNull(),
  errorDetail: jsonb('error_detail'),
  aiSuggestions: jsonb('ai_suggestions'),
  audioDuration: integer('audio_duration'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// 发音建议缓存表
export const pronunciationTips = pgTable('pronunciation_tips', {
  id: serial('id').primaryKey(),
  word: varchar('word', { length: 64 }).notNull(),
  errorType: varchar('error_type', { length: 32 }).notNull(),
  correctPhoneme: varchar('correct_phoneme', { length: 32 }),
  userPhoneme: varchar('user_phoneme', { length: 32 }),
  tip: text('tip').notNull(),
  hitCount: integer('hit_count').default(1).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// 用户文章攻克状态表
export const userArticleStatus = pgTable('user_article_status', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  articleId: integer('article_id').references(() => articles.id).notNull(),
  bestScore: decimal('best_score', { precision: 4, scale: 1 }).default('0').notNull(),
  isConquered: boolean('is_conquered').default(false).notNull(),
  isPerfect: boolean('is_perfect').default(false).notNull(),
  isUnlocked: boolean('is_unlocked').default(false).notNull(),
  attempts: integer('attempts').default(0).notNull(),
  firstReadAt: timestamp('first_read_at').defaultNow().notNull(),
  bestReadAt: timestamp('best_read_at'),
})

// 支付记录表
export const payments = pgTable('payments', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  type: subscriptionTypeEnum('type').notNull(),
  channel: varchar('channel', { length: 16 }).default('alipay').notNull(),
  amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
  articleId: integer('article_id').references(() => articles.id),
  tradeNo: varchar('trade_no', { length: 128 }),
  outTradeNo: varchar('out_trade_no', { length: 128 }).notNull().unique(),
  status: paymentStatusEnum('status').default('pending').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  paidAt: timestamp('paid_at'),
})
```

### 5.2 Drizzle 使用示例

```typescript
// backend/src/db/index.ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const connectionString = process.env.DATABASE_URL!
const client = postgres(connectionString)
export const db = drizzle(client, { schema })

// 能力分计算示例
import { db } from '../db'
import { readings, articles } from '../db/schema'
import { desc, eq, and, gte } from 'drizzle-orm'

const recentReadings = await db
  .select({ q: readings.qualityScore, d: articles.difficulty })
  .from(readings)
  .innerJoin(articles, eq(readings.articleId, articles.id))
  .where(and(
    eq(readings.userId, userId),
    eq(readings.isBest, true),
    gte(readings.qualityScore, '60')
  ))
  .orderBy(desc(readings.createdAt))
  .limit(20)

let sumQD = 0, sumD = 0
for (const r of recentReadings) {
  const q = parseFloat(r.q)
  const d = parseFloat(r.d)
  sumQD += q * d
  sumD += d
}
const proficiency = sumD > 0 ? Math.round(sumQD / sumD) : 0
```

---

## 六、Zeabur 部署指南

> **核心思路：** 在 Zeabur 同一 Project 下创建两个 Service（前端 + 后端），再加一个 PostgreSQL Marketplace Service，三个组件通过 Zeabur 内部网络通信。`git push main` 自动部署，无需配置 Nginx/Docker/SSL。

### 6.1 准备工作

1. 注册 [Zeabur](https://zeabur.com) 账号（支持 GitHub 登录、支付宝付款）
2. 将代码推送到 GitHub 仓库（monorepo 结构：`frontend/` + `backend/`）
3. 升级到 **Dev 计划**（$5/月），获得数据库备份功能

### 6.2 创建后端应用

1. Zeabur Dashboard → **Create Project** → **Deploy New Service** → 选择 GitHub 仓库
2. **Root Directory** 设置为 `backend`
3. Zeabur 的 zbpack 自动识别为 Node.js/Hono 项目（若识别失败可手动选择 Node.js 或使用 Dockerfile）
4. 在同一 Project 中添加 **PostgreSQL**：Add Service → Marketplace → PostgreSQL
5. Zeabur 自动向 backend 注入 `DATABASE_URL` 等环境变量
6. 在 Settings → Environment Variables 中添加密钥：
   ```
   NODE_ENV=production
   JWT_SECRET=your-jwt-secret-key
   AZURE_SPEECH_KEY=xxx
   AZURE_SPEECH_REGION=eastasia
   DEEPSEEK_API_KEY=sk-xxx
   ALIPAY_APP_ID=xxx
   ALIPAY_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nxxx\n-----END PRIVATE KEY-----
   ALIPAY_PUBLIC_KEY=xxx
   ALIPAY_NOTIFY_URL=https://api-jushuo.zeabur.app/api/payment/notify
   ```
7. Zeabur 自动分配域名，如 `api-jushuo.zeabur.app`

### 6.3 创建前端应用

1. 在同一 Project 下 → **Add Service** → 再次选择 GitHub 仓库
2. **Root Directory** 设置为 `frontend`
3. Zeabur 自动识别 Vite 项目，执行 `pnpm build` 并发布 `dist/`
4. 在 Settings → Environment Variables 中添加构建变量：
   ```
   VITE_API_URL=https://api-jushuo.zeabur.app
   ```
5. Zeabur 自动分配域名，如 `jushuo.zeabur.app`

### 6.4 初始化数据库

首次部署后需要运行数据库迁移。两种方式：

**方式一（推荐）：在代码中添加启动时自动迁移**
```typescript
// backend/src/index.ts 末尾
import { migrate } from 'drizzle-orm/postgres-js/migrator'
if (process.env.NODE_ENV === 'production') {
  await migrate(db, { migrationsFolder: 'drizzle' })
}
```

**方式二：通过 Zeabur Console 执行**
在 Zeabur Dashboard → backend service → Console 中运行：
```bash
pnpm drizzle-kit migrate
pnpm seed
```

### 6.5 部署架构示意

```
Zeabur Project: jushuo
├── Service 1: jushuo-frontend (静态站点)
│   ├── Domain: jushuo.zeabur.app
│   ├── Build: Vite build → dist/
│   ├── Env: VITE_API_URL → 指向 backend
│   └── Auto-deploy: git push main
│
├── Service 2: jushuo-backend (Node.js)
│   ├── Domain: api-jushuo.zeabur.app
│   ├── Runtime: Node.js 20
│   ├── Env: DATABASE_URL(自动), JWT_SECRET, 各 API Key
│   └── Internal Network → PostgreSQL
│
└── Marketplace: PostgreSQL 17
    ├── Auto-backup (Dev 计划支持)
    ├── 内部连接（不暴露公网，更安全）
    └── 环境变量自动注入 backend
```

### 6.6 后端 Dockerfile（备用）

如果 Zeabur 的 zbpack 自动识别失败，可在 `backend/` 下放置 Dockerfile：

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### 6.7 自定义域名与 ICP 备案

| 阶段 | 域名方案 | 备案要求 |
|------|---------|---------|
| MVP 验证 | `jushuo.zeabur.app` + `api-jushuo.zeabur.app` | 无需备案，国内可直连（延迟 30-80ms） |
| 正式上线 | `jushuo.app` + `api.jushuo.app`（CNAME 到 Zeabur） | 需 ICP 备案，备案期间继续用 zeabur.app 域名 |

> 在 Zeabur 中绑定自定义域名：Settings → Domains → Add Domain，按提示配置 CNAME 记录即可，SSL 证书自动签发。

### 6.8 CORS 配置注意事项

后端 Hono CORS 中间件需要允许前端域名访问：

```typescript
app.use('*', cors({
  origin: [
    'https://jushuo.zeabur.app',        // MVP 阶段
    'https://jushuo.app',                // 正式上线后
    'http://localhost:5173',             // 本地开发
  ],
  credentials: true,
}))
```

---

## 七、未来扩展路径

当用户量增长超出 Zeabur Dev 计划资源时，可平滑迁移：

| 阶段 | 用户量 | 方案 | 月成本 |
|------|-------|------|-------|
| MVP | 0-200 | Zeabur Dev ($5/月) | ~¥36 |
| 成长期 | 200-1000 | Zeabur Pro ($19/月) 或升级资源 | ~¥135 |
| 规模化 | 1000+ | Sealos 国内版（按量付费）或阿里云 ECS+RDS | ¥200-500 |

迁移时只需更新环境变量中的 `DATABASE_URL` 和前端 `VITE_API_URL`，代码无需修改。

---

## 八、关键环境变量

```bash
# backend/.env (本地开发) / Zeabur 环境变量 (生产)
NODE_ENV=production
PORT=3000

# Database — Zeabur 自动注入，也可手动配置
DATABASE_URL=postgres://user:pass@host:5432/jushuo

# JWT
JWT_SECRET=your-jwt-secret-key

# Azure Speech
AZURE_SPEECH_KEY=xxx
AZURE_SPEECH_REGION=eastasia

# DeepSeek
DEEPSEEK_API_KEY=sk-xxx
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1

# Alipay
ALIPAY_APP_ID=xxx
ALIPAY_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nxxx\n-----END PRIVATE KEY-----
ALIPAY_PUBLIC_KEY=xxx
ALIPAY_NOTIFY_URL=https://api-jushuo.zeabur.app/api/payment/notify
```

```bash
# frontend/.env (本地开发) / Zeabur 构建变量 (生产)
VITE_API_URL=https://api-jushuo.zeabur.app
```
