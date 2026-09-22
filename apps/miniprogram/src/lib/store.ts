/**
 * ⭐ 全局「我」的 store —— **按句子（竞技场）组织的战绩** + streak。
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️⚠️ **键是 articleId，不是日期。**
 *
 *    竞技数据的单位永远是句子：排名、参与人数、最高分、我的最好成绩，
 *    全部跟着**那一段文本**走。日期只是排期表上的一个格子（见 db/schema.ts
 *    的 schedules），它答完「今天展示哪一句」就没它的事了。
 *
 *    这条写错过一次，代价是一整类查不出来的 bug：
 *      · 同一句被排在多天，按日期存就会把**同一份战绩复制好几份**，
 *        写其中一份、其余几份要等下次刷新才对 —— 于是「提交完不刷新」
 *      · 客户端的日期来自 URL、服务端来自自己的时钟，两个字符串
 *        只要差一个字符，首页就会拿一个**永远匹配不上的键**去查，
 *        表现同样是「不刷新」，而每一处代码单独看都是对的
 *    ⇒ 改按 articleId 之后，两边用的是**同一个不可变的身份**，
 *      这类错配从根上不可能发生。
 * ══════════════════════════════════════════════════════════════════
 *
 * 它要解决的原始问题：提交完返回首页，首页不更新。
 * 根子在于「我参与了吗」这个事实没有单一存放处，散在三个页面各自的 data 里。
 * 现在有一处权威的记录：谁拿到新数据就往里写，所有页面订阅它。
 *
 * ⚠️ 两条必须守住的边界：
 *
 *   ① **服务端是唯一真相，这里只做缓存与广播。**
 *      分数、名次、是否参与，全部来自接口返回值，端侧**绝不自己算**。
 *
 *   ② **每个页面仍然照常向服务端刷新。**
 *      store 解决的是「拿到了新数据，别人不知道」，不解决「一直没去拿」。
 */

import type {
  GrowthView,
  MeResponse,
  ScheduleDetail,
  SchedulesResponse,
  StreakDelta,
  StreakView,
} from '@jushuo/shared'
import { daysBetween, today } from '@jushuo/shared'

/** 我在某个**竞技场（句子）**里的战绩 */
export interface ArenaRecord {
  /** 我在这句上的最好成绩；没参与为 null */
  myBest: number | null
  /** 我在这句上打过几次分 */
  myAttempts: number
}

/**
 * 「我是谁」—— 头像 / 昵称 / 已征服句子数。
 *
 * ⚠️ 只放**展示用**的字段，不放 token / openid 那类身份凭据：
 *    凭据由 lib/api/client 自己管（它要落 storage 且要能刷新）。
 *    这里的东西会随头像一起渲染到导航栏上，多放一个字段就多一份泄露面。
 */
export interface Profile {
  nickname: string | null
  avatarUrl: string | null
  /** 已征服的句子数（服务端按去重句子算，只增不减） */
  conqueredCount: number
  /**
   * ⭐ 挑战过**几句**（去重句子，全时段累计）。
   * ⚠️ 与「已征服」是两件事：读过但没到征服线（≥85 分）的也算挑战过。
   *    两个数都得由服务端给 —— 端侧这份 arena 缓存只覆盖最近 7 天的排期，
   *    自己数出来必然偏小，而偏小的数字比没有更糟（用户会以为记录丢了）。
   */
  challengedCount: number
  /** ⭐ 一共挑战了**几回**（打分成功的提交数，全时段累计） */
  challengedRounds: number
  /**
   * ⭐ **能量点数**（替代旧的「每天 N 次挑战机会」）。
   * ⚠️ 端侧只展示：补足、扣减、奖励全在服务端（见 services/energy.ts），
   *    端侧自己算一份必然和服务器对不上。
   */
  energy: number
  /**
   * ⭐ 三个成长值 —— **分开展示、不合成总分**。
   * ⚠️ 同样只展示：每次提交拿了多少由服务端结算并落快照。
   */
  growth: GrowthView
}

export interface MeState {
  /** 服务端的「今天」—— 只用于显示与判断缓存过期，不参与任何竞技口径 */
  serverDate: string | null
  /** ⭐ articleId → 我在那个竞技场里的战绩 */
  arena: Record<number, ArenaRecord>
  /** 我的连续天数与解冻卡（**等级徽章已废除**） */
  streak: StreakView | null
  /** 我的头像 / 昵称 —— 自定义导航栏左侧那个圆形头像靠它 */
  profile: Profile | null
}

/**
 * 存储键 —— 带版本号。
 * ⚠️ 结构变了必须换键：拿旧结构去解新代码，症状是「缓存里的数据永远读不出来」，
 *    而没有任何东西报错。这次从「按日期」改成「按句子」，正是一次结构变更。
 */
const STORAGE_KEY = 'me_state_v2'

function emptyState(): MeState {
  return { serverDate: null, arena: {}, streak: null, profile: null }
}

let state: MeState = emptyState()
let hydrated = false
const listeners = new Set<(s: MeState) => void>()

/* ---------------------------------------------------------------- */
/* 读                                                               */
/* ---------------------------------------------------------------- */

export function getState(): MeState {
  return state
}

/** 我在**这一句**上的战绩；没参与过就返回「没参与」 */
export function arenaOf(articleId: number): ArenaRecord {
  return state.arena[articleId] ?? { myBest: null, myAttempts: 0 }
}

/**
 * ⭐ 我**加入句拼**了吗 —— 服务端认不认识我，users 表里有没有我这一行。
 *
 * ⚠️⚠️ 判据**只有一个**：profile 非空。它与「我起名字了没有」**毫无关系**。
 *
 *    这个产品里有两层身份，混在一起就会写出自相矛盾的界面：
 *
 *      ① 授权层 —— openid。wx.login（或云托管网关注入）静默拿到。
 *                  「静默」只是说授权这一步不需要用户点什么，
 *                  **不等于他已经进了我们的业务库**。
 *      ② 账号层 —— users 里有没有我这一行。**就是本函数**。
 *                  ⭐ 任何业务数据（分数、榜单、排期）都挂在 user_id 上，
 *                  所以业务数据的前置条件就是这一层。
 *
 *    昵称 / 头像**不构成任何一层**：它们只回答「榜上显示成什么」，
 *    是加入之后随时可以补、也随时可以一直不补的资料（见 pages/join）。
 *    曾经拿「昵称非空」当登录判断，代价很实在：一个有账号、有成绩、
 *    只是没起名字的人会被判成新人 —— 状态卡给他 0，挑战把他往加入页推。
 *
 * ⚠️ 判据是「服务端给过我身份」：profile 只可能来自服务端的成功应答
 *    （GET /api/user/me），而服务端在那个接口上按 openid 取用户、
 *    **没有就当场建一行**（见 middleware/auth.ts）——
 *    所以「能返回」本身就证明了那一行存在。
 *
 * ⚠️ profile 会**落 storage**，所以断网重开也仍然算「加入过」 ——
 *    这是对的：账号在服务端，不因这一次请求失败而消失。
 *    反过来，拿不到 profile（后端没起来 / appid 没配）才叫「还没加入」，
 *    这时**不要显示任何业务数据**，首页状态卡就是这么判的。
 *
 * ⚠️ 界面上它对应导航栏那一格：加入了画头像，没加入画「加入」按钮。
 */
export function hasJoined(): boolean {
  return state.profile !== null
}

/** 服务端的「今天」还没拿到时，退回本机时区的今天（只用于首屏占位） */
export function bestKnownDate(): string {
  return state.serverDate ?? today()
}

/**
 * 订阅变更，返回取消订阅的函数。
 *
 * ⚠️ 页面**必须**在 onUnload 里退订，否则页面销毁后回调还在跑，
 *    里面一句 setData 就会报「setData on destroyed page」。
 */
export function subscribe(fn: (s: MeState) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/* ---------------------------------------------------------------- */
/* 写                                                               */
/* ---------------------------------------------------------------- */

function commit(next: MeState): void {
  state = next
  persist()
  // ⚠️ 复制一份再遍历：回调里退订不会打乱这次遍历
  for (const fn of [...listeners]) {
    try {
      fn(state)
    } catch (err) {
      /**
       * ⚠️⚠️ 一个订阅者出错**不能**影响其它订阅者，但**更不能被静默吞掉**。
       *    只 warn 一句 message 的后果很隐蔽：页面重画的回调一旦抛异常，
       *    表现是「数据明明变了，界面就是不动」—— 而那正是最难查的一类问题，
       *    因为**没有任何东西是坏的**，只是没人告诉你它失败了。
       */
      console.error('[store] 订阅回调出错，对应页面不会更新：', err)
    }
  }
}

function persist(): void {
  try {
    wx.setStorageSync(STORAGE_KEY, state)
  } catch {
    // 存储写不进去不该影响主流程
  }
}

/**
 * 冷启动时把上次的状态读回来 —— 让首页**首帧就有数据**，不必先白一下。
 * ⚠️ 读回来的只是**缓存**：页面照常会向服务端刷一遍，以服务端为准。
 */
export function hydrate(): void {
  if (hydrated) return
  hydrated = true
  try {
    const raw = wx.getStorageSync(STORAGE_KEY) as Partial<MeState> | '' | undefined
    if (raw && typeof raw === 'object' && raw.arena) {
      state = {
        serverDate: raw.serverDate ?? null,
        arena: raw.arena,
        streak: raw.streak ?? null,
        // ⚠️ 这一条是**后加的字段**，还没换存储键：
        //    hydrate 是逐字段取、缺了就退回默认值，旧结构读进来只是 profile 为 null，
        //    不会像「按日期存」→「按句子存」那次一样解出错误的数据。
        //    真正会解错的结构变更才需要换键（见 STORAGE_KEY 的说明）。
        profile: raw.profile ?? null,
      }
      for (const fn of [...listeners]) fn(state)
    }
  } catch (err) {
    console.warn('[store] 读取缓存失败：' + (err as Error).message)
    state = emptyState()
  }
}

/** 两个「我的最好成绩」合并：有成绩的优先，都有取大 */
function mergeBest(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

/** 用排期列表接口的返回值刷新 */
export function applySchedules(res: SchedulesResponse): void {
  const arena = { ...state.arena }
  /**
   * ⚠️⚠️ 按 **articleId** 落，而不是按日期。
   *
   *    竞技数据跟着句子走 —— 同一句排在多天时，它们本来就是同一份战绩，
   *    这里写的是同一个键，不会出现「几份副本各自为政」。
   *
   * ⚠️ 而且必须**保守合并**，不能「后来者覆盖」：
   *    同一天列表里同一句会出现多次（今天 + 往日各一张卡），
   *    直接赋值等于让最后一张卡决定这一句显示什么 ——
   *    而顺序取决于服务端排序，出问题时是随机现象，根本查不出来。
   */
  for (const e of [res.today, ...res.history]) {
    const prev = arena[e.articleId]
    arena[e.articleId] = {
      myBest: mergeBest(prev?.myBest ?? null, e.myBest),
      myAttempts: Math.max(prev?.myAttempts ?? 0, e.myAttempts),
    }
  }
  // ⚠️ profile 原样带着走：它只有 /api/user/me 会写，这张列表不碰它
  commit({ serverDate: res.date, arena, streak: res.streak, profile: state.profile })
}

/** 用排期详情接口的返回值刷新 */
export function applyScheduleDetail(d: ScheduleDetail): void {
  const arena = { ...state.arena }
  arena[d.articleId] = { myBest: d.myBest, myAttempts: d.myAttempts }
  commit({ ...state, arena })
}

/**
 * ⭐⭐ 一次打分成功后写入 —— **这条是整个 store 存在的理由**。
 *
 * 朗读页拿到结果的那一刻就知道「我读的是哪一句、拿了多少分、streak 怎么变的」，
 * 直接写进来，首页 / 详情页立刻就是新数据 ——
 * 不用等 onShow，也不用管页面还在不在栈里。
 *
 * ⚠️ 键用 **articleId**（服务端回传的），不是 URL 上的日期。
 * ⚠️ 分数与 streak 都用**服务端给的**，端侧一个数都不算。
 */
export function applySubmissionResult(input: {
  articleId: number
  score: number
  streak?: StreakDelta
}): void {
  const prev = arenaOf(input.articleId)
  const arena = { ...state.arena }
  arena[input.articleId] = {
    // ⚠️ 取较大的那个：同一句可能提交多次，这一个是「又一次」，不一定是新高。
    //    端侧只做这一步保守合并；真正的权威值会在下一次刷新时被服务端覆盖。
    myBest: prev.myBest === null ? input.score : Math.max(prev.myBest, input.score),
    myAttempts: prev.myAttempts + 1,
  }

  // streak 直接用服务端算好的那一份；只有服务端没给时才保留旧的
  const streak: StreakView | null = input.streak
    ? {
        streakDays: input.streak.streakDays,
        streakBest: input.streak.streakBest,
        // ⚠️ 解冻卡的**到期日**提交响应里没带，保留上一次刷新拿到的值
        unfreezeCards: input.streak.unfreezeCards,
        // ⚠️ 提交响应里没有"待领取"这个数（发奖是服务端的事），保留上一次刷新拿到的值
        unfreezePending: state.streak?.unfreezePending ?? 0,
        unfreezeExpiresOn: state.streak?.unfreezeExpiresOn ?? null,
        readToday: input.streak.counted,
      }
    : state.streak

  commit({ ...state, arena, streak })
}

/**
 * ⭐ 用 GET /api/user/me 的返回值刷新「我是谁」。
 *
 * ⚠️ 顺带把 streak 也写进来：同一份响应里就有，而且是**更完整**的那一份
 *    （含解冻卡的到期日，提交响应里没有它）。
 *    两条路（这里和 schedules）写的是同一个服务端视图，谁后到谁生效。
 */
export function applyProfile(m: MeResponse): void {
  const profile: Profile = {
    nickname: m.nickname,
    avatarUrl: m.avatarUrl,
    conqueredCount: m.conqueredCount,
    challengedCount: m.challengedCount,
    challengedRounds: m.challengedRounds,
    energy: m.energy,
    growth: m.growth,
  }
  // ⚠️ 改完资料后**不用**再管界面态：加入页在提交成功后自己 navigateBack
  //    （见 pages/join/join.ts）。store 里没有一个"层开着没有"的标志了。
  commit({ ...state, profile, streak: m.streak })
}

/**
 * ⭐ 只改头像 / 昵称这两格，其余（已征服数、streak）原样留着。
 *
 * ⚠️⚠️ 为什么不能存完再 GET 一次 /me 才知道自己是谁：
 *    POST /api/user/profile 成功 = 资料**已经落库**，这时候全局 state 还停在
 *    「没昵称」只有一种可能 —— 那次多余的 GET 失败了。
 *    而界面拿这一格画头像和昵称，于是他明明刚填完，界面却还是一个没名字的人。
 *    ⇒ 保存成功这件事必须以**保存接口自己的返回值**为准，不能靠第二次请求。
 * ⚠️ 顺带说清边界：这一格只是**展示资料**，改不改都不影响「是否已加入」
 *    （见 hasJoined）—— 但正因为界面拿它显示头像和昵称，它落后一步就看得见。
 */
export function applyProfilePatch(patch: { nickname: string | null; avatarUrl: string | null }): void {
  const prev = state.profile
  commit({
    ...state,
    profile: {
      nickname: patch.nickname,
      // ⚠️ 这次没选头像时服务端返回的是**库里存着的那张**，直接采信它
      avatarUrl: patch.avatarUrl,
      // ⚠️ 下面三个都是**统计值**，保存接口不返回它们 —— 原样留着，
      //    别顺手清零（那会让首页状态卡闪一下 0）
      conqueredCount: prev?.conqueredCount ?? 0,
      // ⚠️ 能量与三个成长值同样是**统计值**，保存接口不返回 —— 原样留着，
      //    别顺手清零（那会让"我的主页"闪一下 0）
      energy: prev?.energy ?? 0,
      growth: prev?.growth ?? { self: 0, diligence: 0, standout: 0 },
      challengedCount: prev?.challengedCount ?? 0,
      challengedRounds: prev?.challengedRounds ?? 0,
    },
  })
}

/** 换账号 / 清空重置时调用 —— 否则会把上一个人的成绩显示给下一个人 */
export function reset(): void {
  commit(emptyState())
}

/** 缓存里的「今天」是否已经落后于真实今天（切后台过夜） */
export function isStale(now = today()): boolean {
  if (!state.serverDate) return true
  return daysBetween(state.serverDate, now) > 0
}
