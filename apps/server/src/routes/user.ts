import { Hono } from 'hono'
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
