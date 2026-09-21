import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { users } from '../db/schema'
import { env } from '../env'
import { getTotalConquered } from '../services/conquest'
import { attemptLimitOf } from '../services/quota'
import { readStreakView } from '../services/streak'
import type { Variables } from '../middleware/auth'

export const userRoutes = new Hono<{ Variables: Variables }>()

/** 个人主页：Streak / 徽章 / 身份（会员与否决定每句能挑战几次） */
userRoutes.get('/me', async (c) => {
  const user = c.get('user')
  const userId = c.get('userId')

  // ⚠️ Streak 视图一律现算（它由库里四个字段纯推导），不缓存：
  //    跨过零点之后「今天读没读」会翻面，缓存会让它停在昨天。
  const isMember = !!user.memberUntil && user.memberUntil > new Date()
  const [streak, conqueredCount] = await Promise.all([
    readStreakView(userId),
    getTotalConquered(userId),
  ])

  return c.json({
    ok: true,
    data: {
      id: user.id,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      status: user.status,
      isMember: isMember,
      // ⭐ 每句还能挑战几次由身份决定（免费 1 / 付费 20）——
      //    客户端拿它写提示语，不在端侧再抄一份数字
      attemptsPerSentence: attemptLimitOf(isMember),
      conqueredCount,
      streak,
    },
  })
})

/**
 * ⭐ 头像 / 昵称的**唯一写入口** —— 小程序「头像昵称填写能力」的落地处。
 *
 * ⚠️⚠️ 为什么昵称必须由用户提供、不能我们生成：
 *    榜单上显示的就是昵称。给它一个自动编号（「挑战者 8231」）等于
 *    让用户在一张全是编号的榜上找不到自己，也无从判断「这是我吗」。
 *    所以榜上那个名字必须是用户自己认领的。
 *
 * ⚠️ 头像是**可选**的：chooseAvatar 用户可以取消。
 *    没有头像时客户端画昵称首字（一个空圆圈传达不了任何信息）。
 *
 * ⚠️ 判定「登录」的也是**昵称非空**（见客户端 store 的 isLoggedIn）：
 *    openid 是静默拿到的（wx.login），用户从来没有「没登录」过；
 *    他真正能感知到的那个「登录动作」，就是填了这个名字、认领了这个头像。
 */
userRoutes.post('/profile', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json<{ nickname?: string; avatarUrl?: string }>()

  const nickname = normalizeNickname(body.nickname)
  if (!nickname) {
    return c.json({ ok: false, error: '昵称不能为空（1–32 个字符）' }, 400)
  }
  const avatarUrl = normalizeAvatarUrl(body.avatarUrl)

  await db
    .update(users)
    .set({ nickname, ...(avatarUrl ? { avatarUrl } : {}) })
    .where(eq(users.id, userId))

  return c.json({ ok: true, data: { nickname, avatarUrl: avatarUrl ?? null } })
})

/**
 * 昵称净化：折叠空白、剥掉控制字符、限长。
 *
 * ⚠️ 为什么要剥控制字符：昵称会进榜单、进分享文案，**换行和零宽字符**
 *    会让它在界面上显示成空白或把行撑开 —— 而这一切在提交时完全看不出来。
 */
export function normalizeNickname(raw: string | undefined): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32)
}

/**
 * 头像地址只接受**本环境云存储的 fileID**。
 *
 * ⚠️⚠️ 不校验的后果不是「图片显示不出来」，而是用户可以把**任意 URL**
 *    存进 users.avatar_url —— 那会变成一张我们替别人托管的图
 *    （外部域名随时可能变成别的东西），而且榜单页会去请求它。
 *    这里只认 cloud://<本环境>.<桶>/<路径> 这一种形态，其余一律丢弃。
 */
export function normalizeAvatarUrl(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value.startsWith('cloud://')) return null
  const prefix = 'cloud://' + env.WX_CLOUD_ENV_ID + '.' + env.COS_BUCKET + '/'
  if (!env.WX_CLOUD_ENV_ID || !env.COS_BUCKET || !value.startsWith(prefix)) return null
  // 只允许头像目录 —— 免得有人把它当任意文件的分布器
  return value.slice(prefix.length).startsWith('avatars/') ? value : null
}
