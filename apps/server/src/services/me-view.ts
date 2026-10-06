import type { MeResponse } from '@jushuo/shared'

import { getTotalConquered } from './conquest'
import { readEnergy } from './energy'
import { readCookies } from './cookies'
import { readStreakView } from './streak'
import { challengeStats } from './submission'
import type { User } from './user'

/**
 * ⭐⭐ 「我是谁」的**唯一构造点**（`GET /api/user/me` 与 `POST /api/auth/register` 共用）。
 *
 * ⚠️⚠️ 为什么必须抽出来：注册接口要**当场把这一份返回给客户端** ——
 *    端侧加入成功后立刻要拿 `id`（上传路径要用）与全套展示数据来落 store。
 *    如果注册只回一个轻量对象、让客户端再 GET 一次 /me，那"加入成功"这件事
 *    就又赌了一次网络（本项目已经因为"存完再查一次"踩过坑，见 store 的
 *    applyProfilePatch 注释）。两份实现抄来抄去也迟早分叉。
 *
 * ⚠️ 数据全部现算（streak / 能量 / 成长值都随零点与流水变化），这里不缓存。
 */
export async function buildMeView(user: User): Promise<MeResponse> {
  const userId = user.id
  const [streak, conqueredCount, stats, energy, cookies] = await Promise.all([
    readStreakView(userId),
    getTotalConquered(userId),
    // ⭐ 首页状态卡上的「挑战过几句 / 一共几回」—— 服务端数，
    //    端侧那份缓存只覆盖最近 7 天的排期，数出来必然偏小。
    challengeStats(userId),
    // ⭐ 能量先**补足**再读（惰性 + 幂等，见 services/energy.ts）
    readEnergy(userId),
    // ⭐ 饼干：累计获得（只增）+ 可用（可花）—— 见 prd §7.6
    readCookies(userId),
  ])

  return {
    id: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    gender: (user.gender ?? null) as 'male' | 'female' | null,
    age: user.age ?? null,
    bio: user.bio ?? null,
    status: user.status,
    // ⭐ **能量点数**（替代旧的「每天 N 次挑战机会」）。
    //    每次挑战消耗 2 点、每日补足到 3 点；端侧只管展示，不自己算余额。
    energy,
    // ⭐ 三个成长值 —— **分开给，不合成总分**（三个数各自回答一个问题，
    //    相加之后没人解释得清那个数是怎么来的）
    cookies,
    // ⭐ 首页状态卡：挑战过几句 / 一共挑战了几回（全时段累计，只数打分成功的）
    challengedCount: stats.challengedCount,
    challengedRounds: stats.challengedRounds,
    conqueredCount,
    streak,
  }
}
