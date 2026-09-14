import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { eq, and, gt, sql } from 'drizzle-orm'
import { db } from '../db'
import { users, verificationCodes } from '../db/schema'
import { sendVerificationCode } from '../services/mail'

const registerSchema = z.object({
  email: z.string().email('邮箱格式不正确'),
  password: z.string().min(6, '密码至少6位'),
  code: z.string().length(6, '验证码为6位'),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const sendCodeSchema = z.object({
  email: z.string().email('邮箱格式不正确'),
})

export const authRoutes = new Hono()

// 发送验证码
authRoutes.post('/send-code', zValidator('json', sendCodeSchema), async (c) => {
  const { email } = c.req.valid('json')

  // 检查 60 秒内是否已发送过
  const recent = await db.select({ id: verificationCodes.id })
    .from(verificationCodes)
    .where(
      and(
        eq(verificationCodes.email, email),
        gt(verificationCodes.createdAt, sql`now() - interval '60 seconds'`),
        eq(verificationCodes.used, false),
      )
    )
    .limit(1)

  if (recent.length > 0) {
    return c.json({ error: '请 60 秒后再发送' }, 429)
  }

  // 生成 6 位验证码
  const code = Math.floor(100000 + Math.random() * 900000).toString()

  // 存入数据库，有效期 10 分钟
  await db.insert(verificationCodes).values({
    email,
    code,
    expiresAt: sql`now() + interval '10 minutes'`,
  })

  // 发送邮件（异步，不阻塞）
  sendVerificationCode(email, code)

  return c.json({ message: '验证码已发送' })
})

// 注册（需验证码）
authRoutes.post('/register', zValidator('json', registerSchema), async (c) => {
  const { email, password, code } = c.req.valid('json')

  // 检查邮箱是否已注册
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
  if (existing.length > 0) {
    return c.json({ error: '该邮箱已注册' }, 409)
  }

  // 校验验证码
  const validCode = await db.select({ id: verificationCodes.id })
    .from(verificationCodes)
    .where(
      and(
        eq(verificationCodes.email, email),
        eq(verificationCodes.code, code),
        eq(verificationCodes.used, false),
        gt(verificationCodes.expiresAt, sql`now()`),
      )
    )
    .limit(1)

  if (validCode.length === 0) {
    return c.json({ error: '验证码无效或已过期' }, 400)
  }

  // 标记验证码已使用
  await db.update(verificationCodes)
    .set({ used: true })
    .where(eq(verificationCodes.id, validCode[0].id))

  const passwordHash = await bcrypt.hash(password, 10)
  const today = new Date().toISOString().split('T')[0]

  const [user] = await db.insert(users).values({
    email,
    passwordHash,
    dailyResetDate: today,
  }).returning()

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: '7d' })

  return c.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      proficiencyScore: user.proficiencyScore,
      totalExperience: user.totalExperience,
      honorTitle: user.honorTitle,
    },
  }, 201)
})

// 登录
authRoutes.post('/login', zValidator('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json')

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
  if (!user) {
    return c.json({ error: '邮箱或密码错误' }, 401)
  }

  const valid = await bcrypt.compare(password, user.passwordHash)
  if (!valid) {
    return c.json({ error: '邮箱或密码错误' }, 401)
  }

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: '7d' })

  return c.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      proficiencyScore: user.proficiencyScore,
      totalExperience: user.totalExperience,
      honorTitle: user.honorTitle,
    },
  })
})