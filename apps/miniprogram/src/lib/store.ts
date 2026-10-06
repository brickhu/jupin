/**
 * ⭐ 全局「我」的 store —— 三层里的**逻辑层 + 热更新层**。
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️⚠️ 三层分工，别串：
 *
 *   ① store（本文件）—— 全局状态的调用入口、业务逻辑、热更新。
 *      **所有写入都必须经过 commit()**，它是全项目唯一同时动这三层的地方：
 *          state = next                    状态层
 *          globalData.state / .userInfo     挂载层（同一引用，不是副本）
 *          wx.setStorageSync(KEY, state)    持久层
 *          notify(listeners)                热更新
 *      任何别处单独写 globalData 或 storage，都是把这三层撕开 ——
 *      迟早出现「界面变了但缓存没变」这类查不出来的不一致。
 *
 *   ② globalData —— 数据的**挂载点**。任何地方都能
 *      getApp().globalData.state（或 .userInfo）直接读当前状态。
 *
 *   ③ storage —— 持久化。小程序**没有** localStorage / sessionStorage，
 *      持久只有 wx.setStorageSync；会话级数据留在内存即可。
 *      读回缓存的入口只有 hydrate()。
 * ══════════════════════════════════════════════════════════════════
 *
 * ⚠️⚠️ **竞技数据的键是 articleId，不是日期。**
 *
 *    竞技数据的单位永远是句子：排名、参与人数、最高分、我的最好成绩，
 *    全部跟着**那一段文本**走。日期只是排期表上的一个格子（见 db/schema.ts
 *     的公开列表），它答完「今天展示哪一句」就没它的事了。
 *
 *    这条写错过一次，代价是一整类查不出来的 bug：
 *      · 同一句被排在多天，按日期存就会把**同一份战绩复制好几份**，
 *        写其中一份、其余几份要等下次刷新才对 —— 于是「提交完不刷新」
 *      · 客户端的日期来自 URL、服务端来自自己的时钟，两个字符串
 *        只要差一个字符，首页就会拿一个**永远匹配不上的键**去查，
 *        表现同样是「不刷新」，而每一处代码单独看都是对的
 *    ⇒ 改按 articleId 之后，两边用的是**同一个不可变的身份**，
 *      这类错配从根上不可能发生。
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
  ArticleDetail,
  ArticleFavoriteCount,
  ArticleStats,
  MeResponse,
  ParticipationRecord,
  ProfileUpdateResponse,
  LatestCardsResponse,
  TodayArticleResponse,
  StreakDelta,
  StreakView,
} from '@jushuo/shared'
import { daysBetween, today } from '@jushuo/shared'

/**
 * 全局状态。
 *
 * ⚠️ 「我是谁」只有一份：`userInfo`，就是 `GET /api/user/me` 的**原始返回体**。
 *    不再另存一份裁剪过的 profile —— 那种派生副本一旦和原始数据并存，
 *    就会出现「两个来源对不上」，而 streak 这类字段尤其容易分叉。
 */
/**
 * ⭐ 身份解析状态 —— 别把「还没问到」和「问到了但没有账号」混成一件事。
 *
 *   · 'pending'：还没跟服务端确认过身份（启动登录中 / 冷启动首屏）。
 *     界面上该**等一下**（导航栏左侧画 spinner），而不是先画个「加入」——
 *     否则每个用户打开小程序都会先看到一个假的「加入」，再闪成自己的头像。
 *   · 'ready'  ：问到了（服务端给了答复）。这时再按 hasJoined() 决定画头像还是「加入」。
 *   · 'unknown'：**问不到**（超时 / 没网 / 后端没起来）。
 *     ⚠️⚠️ 它与 'ready' + userInfo=null **不是一件事**：
 *       · 'ready' + null  = "服务端说库里没我这一行" ⇒ 该画「加入」；
 *       · 'unknown'       = "我根本不知道库里有没有我" ⇒ 画「重新连接」，
 *         绝不能画「加入」—— 那等于告诉一个有记录的人"你还没加入"。
 *     （这就是"用 wx.login / 本机缓存 当判据"会踩的坑：它答不了库里有没有我。）
 */
export type SessionState = 'pending' | 'ready' | 'unknown'

export interface MeState {
  /** ⭐ /api/user/me 的原始返回体；null = 服务端还没答上来（还没确认账号） */
  userInfo: MeResponse | null
  /** ⭐ 身份解析到哪一步了（见 SessionState） */
  session: SessionState
  /**
   * ⭐ 上一次拿到的**最新上线**那一屏（首页下半段）—— 只为冷启动首屏秒开。
   *
   * ⚠️⚠️ 它是**公开内容**的缓存，与上面那些「我的」数据分开：内容只有拉到才有，
   *    而云托管缩容到 0 时第一次请求要硬等 9~25 秒（见 client.ts 的 LAUNCH_BUDGET_MS），
   *    那段时间首屏不该是一片空白。
   * ⚠️ 用它之前**必须按 `date` 校验**（见 cachedLatestCards）：跨天的列表是错的。
   */
  latestCards: LatestCardsResponse | null
  /**
   * ⭐ 上一次拿到的**今日挑战卡** —— 同样只为冷启动首屏。
   *
   * ⚠️ 没有它的话，冷启动那 9~25 秒里首页最上面那张卡是**空的**（只有下面的
   *    「最新上线」有缓存），而它恰恰是这一页的主角。
   * ⚠️ 同样按 `date` 校验（见 cachedToday）：跨天不能再把昨天那句当"今日挑战"。
   */
  today: TodayArticleResponse | null
  /**
   * ⭐⭐ articleId → 我在那一句上的**参与记录**（`GET /api/user/participation/{articleId}` 的原始返回）。
   *
   * ⚠️⚠️ 三态要分清（键在不在本身就是信息）：
   *    · **键不存在** —— 还没拉过（未知）；界面按"默认未参与"画，但不是结论；
   *    · **null**     —— 拉到了，服务端**明确说**这一句我没参与过；
   *    · **对象**     —— 参与过（bestScore / attempts / rank / 词表快照…）。
   *    ⇒ 绝不能把"没拉到"（超时/断网）写成 null —— 那是把"不知道"说成"没去过"。
   *
   * ⚠️ 它是「一句的参与状态」的**唯一来源**（今日卡的按钮文案、已参与描边、
   *    按钮下方那行都读它）。原来是拿公开列表接口 + 一条批量「战绩」接口融合出来的，
   *    现在按用户 2026-09 的口径改成**按句子单独取**。
   */
  participation: Record<string, ParticipationRecord | null>
  /**
   * ⭐⭐ **句子详情（`GET /api/articles/{id}`）的会话级缓存** —— 只活在内存里，**不落 storage**。
   *
   * 用户 2026-09 定：句子数据（正文 / 词表 / 难度 / 标签 / 主题 / 标准音 / 参与概要）
   * 拉一次就该全站共用 —— 朗读页与竞技场页读的是同一份。
   *
   * ⚠️⚠️ **不落 storage** 有两个理由：
   *    ① 它带**词级数据**（音标 / 释义 / 技巧），一句话就是几十 KB ——
   *       写进去会把 storage 撑爆（小程序单 key 上限 1MB）；
   *    ② "上一次会话的正文"跨会话复用价值极低（句子会改、会下架），
   *       而存着旧正文反而会让用户看到过期内容。
   *    ⇒ 它就是**会话缓存**：本次启动有效，重开小程序重新拉。
   *
   * ⚠️ 其中 `participantCount / topScore / lowestScore` 会跟着缓存一起变旧；
   *    要绝对新鲜的参与人数看 `/api/articles/{id}/participations` 的 `total`。
   */
  articleDetail: Record<string, ArticleDetail>
  /**
   * ⭐⭐ 句子 → **参与统计**（`GET /api/stats/participation?ids=` 的批量结果）。
   *
   * 用户 2026-09 定的结构（L1 解耦）：人数 / 最高 / 最低是 `participations` 的
   * **聚合派生值**，**不挂在句子卡片 / 详情上**（那两个是内容，可缓存）。
   *
   * ⚠️ 统计是**现算**的：加载器 `lib/stats.ts` 每次都重新拉（不做 loaded 短路），
   *    这里存的只是"最近一次拿到的值"，供卡片与概要卡跨组件读同一份。
   * ⚠️ 它同样**不落 storage**（与 articleDetail 同理：会话级、值会变）。
   * ⚠️ 键不存在 = 还没拉到（界面按"还没有人参与"画，但那不是结论）。
   */
  articleStats: Record<string, ArticleStats>
  /**
   * ⭐⭐ 句子 → **收藏总量**（`GET /api/stats/favorite-count?ids=` 的批量结果）。
   *
   * ⚠️ 与 `articleStats` **完全同层同法**（用户 2026-09 定：统计统一进 store）：
   *    它也是**公开**的聚合、也**现算**（每次都重新拉，不做 loaded 短路）、
   *    也**不落 storage**（会话级：值会随别人收藏而变，缓存住就是"过期数字"）。
   * ⚠️ 键不存在 = 还没拉到 —— 界面按"还没人收藏"画，但那**不是结论**：
   *    要显示"N 人收藏"就必须等这一格有值（`null` 与 `0` 是两件事）。
   */
  articleFavoriteCounts: Record<string, number>
}

/**
 * 存储键 —— 带版本号。
 * ⚠️ 结构变了必须换键：拿旧结构去解新代码，症状是「缓存里的数据永远读不出来」，
 *    而没有任何东西报错。v2 → v3 就是把 `profile` 换成了 `userInfo`。
 * ⚠️ 但**加一个可选字段不需要换**（v3 加那一份公开列表就是这种）：旧缓存里没有它，
 *    读回时 `?? null` 兜住即可。换键会让所有人的战绩缓存白丢一次，
 *    换来的只是「更整齐」—— 判据是**拿旧数据会不会解错**，不是字段有没有变。
 */
const STORAGE_KEY = 'me_state_v3'

function emptyState(): MeState {
  return {
    userInfo: null,
    session: 'pending',
    latestCards: null,
    today: null,
    participation: {},
    articleDetail: {},
    articleStats: {},
    articleFavoriteCounts: {},
  }
}

/** 一份零值 streak —— 只在「还没拿到 /me、但已经发生了一件需要账号的事」时临时用 */
function emptyStreak(): StreakView {
  return {
    streakDays: 0,
    streakBest: 0,
    readToday: false,
    unfreezeCards: 0,
    unfreezePending: 0,
    unfreezeExpiresOn: null,
  }
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

/**
 * ⭐ 我**加入句拼**了吗 —— 服务端认不认识我，users 表里有没有我这一行。
 *
 * ⚠️⚠️ 判据**只有一个**：userInfo 非空。它与「我起名字了没有」**毫无关系**。
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
 * ⚠️ 判据是「服务端给过我身份」：userInfo 只可能来自服务端的成功应答
 *    （GET /api/user/me），而服务端在那个接口上按 openid 取用户、
 *    **没有就当场建一行**（见 middleware/auth.ts）——
 *    所以「能返回」本身就证明了那一行存在。
 *
 * ⚠️ userInfo 会**落 storage**，所以断网重开也仍然算「加入过」 ——
 *    这是对的：账号在服务端，不因这一次请求失败而消失。
 *    反过来，拿不到它（后端没起来 / appid 没配）才叫「还没加入」，
 *    这时**不要显示任何业务数据**，首页状态卡就是这么判的。
 *
 * ⚠️ 界面上它对应导航栏那一格：加入了画头像，没加入画「加入」按钮。
 */
export function hasJoined(): boolean {
  return state.userInfo !== null
}


/**
 * 订阅变更，返回取消订阅的函数。
 *
 * ⚠️ 页面**必须**在 onUnload 里退订，否则页面销毁后回调还在跑，
 *    里面一句 setData 就会报「setData on destroyed page」。
 *
 * ⚠️⚠️⚠️ **订阅回调里只许"读 store + 重画"，绝不许"取数 → 写 store"**。
 *    那是一条**自激的请求风暴**：
 *        取数 → `applyXxx` → `commit` → 广播 → 回调 → 再取数 → …
 *    （2026-09 真实踩过：首页在订阅回调里调 `fillCardData()`，而它调的
 *      `ensureStats` 设计上"每次都重新拉"，于是无限请求 `/api/stats/*`。）
 *
 *    ⇒ 要在"某个事件"发生时补一次取数，**盯那个事件**（例如身份从 pending 变 ready），
 *      **不要盯"每一次广播"**。广播是"有人写完了"的通知，不是"该去拉了"的信号。
 */
export function subscribe(fn: (s: MeState) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/* ---------------------------------------------------------------- */
/* 写 —— 全部经 commit()，三层一起动                               */
/* ---------------------------------------------------------------- */

/**
 * ⭐ 挂载层：把当前 state 写到 globalData。
 *
 * ⚠️ 挂的是**同一个引用**，不是拷贝 —— 否则 globalData 会变成第二份真相。
 * ⚠️ App 还没建好（启动早期）或单测环境没有 getApp 时，挂载失败不影响主流程。
 */
function mount(): void {
  try {
    const app = getApp<{
      globalData: { state: MeState | null; userInfo: MeResponse | null }
    }>()
    if (!app?.globalData) return
    app.globalData.state = state
    app.globalData.userInfo = state.userInfo
  } catch {
    // 挂载失败只影响「全局直读」这条路，store 本身照常工作
  }
}

/**
 * ⭐ 三层唯一的调配点。顺序有意为之：
 *    先定状态 → 再挂载 → 再持久化 → 最后广播（订阅者读到的必是最新值）。
 */
function commit(next: MeState): void {
  state = next
  mount()
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

/** 持久层 —— 唯一写 storage 的地方（只被 commit 调） */
function persist(): void {
  try {
    /**
     * ⚠️⚠️ **句子详情不进 storage**（见 MeState.articleDetail 的说明）：
     *    它带词级数据、量大，而且只对"本次启动"有意义。
     *    ⇒ 持久化前先把它摘掉；hydrate 那边也永远是空表。
     */
    const snapshot: Partial<MeState> = { ...state }
    delete snapshot.articleDetail
    delete snapshot.articleStats
    delete snapshot.articleFavoriteCounts
    wx.setStorageSync(STORAGE_KEY, snapshot)
  } catch {
    // 存储写不进去不该影响主流程
  }
}

/**
 * 冷启动时把上次的状态读回来 —— 让首页**首帧就有数据**，不必先白一下。
 * ⚠️ 读回来的只是**缓存**：页面照常会向服务端刷一遍，以服务端为准。
 * ⚠️ 这是唯一读 storage 的地方。
 */
export function hydrate(): void {
  if (hydrated) return
  hydrated = true
  try {
    const raw = wx.getStorageSync(STORAGE_KEY) as Partial<MeState> | '' | undefined
    /**
     * ⚠️ 判据只看"是不是一个对象"——**别拿某个字段当哨兵**。
     *    这里原来写的是 `&& raw.arena`，而 `arena` 那一格 2026-09 已经删了：
     *    留着它，旧缓存永远进不来（战绩缓存白丢），而且下一格被删时还会再犯一次。
     */
    if (raw && typeof raw === 'object') {
      state = {
        userInfo: raw.userInfo ?? null,
        latestCards: raw.latestCards ?? null,
        // ⚠️ 老缓存里没有它（那时还没缓存今日卡）⇒ null，首屏少一次秒开，不会解错
        today: raw.today ?? null,
        // ⚠️ 同上：老缓存里没有参与记录 ⇒ 空表（= 全部"还没拉过"），不会解错
        participation: raw.participation ?? {},
        // ⚠️⚠️ **永远是空的**：句子详情是会话缓存，不落 storage（见 MeState.articleDetail）
        articleDetail: {},
        // ⚠️ 同理：参与统计是"最近一次拿到的值"，不落 storage（见 MeState.articleStats）
        articleStats: {},
        // ⚠️ 收藏总量与它同层同法（见 MeState.articleFavoriteCounts）
        articleFavoriteCounts: {},
        // ⚠️ 缓存里有 userInfo 就直接算「已解析」（头像秒出，不必先转一圈 spinner）；
        //    没有就仍算 pending —— 本机也没记住我是谁，得等这次登录问回来。
        session: raw.userInfo ? 'ready' : 'pending',
      }
      for (const fn of [...listeners]) fn(state)
    }
  } catch (err) {
    console.warn('[store] 读取缓存失败：' + (err as Error).message)
    state = emptyState()
  }
  // 即使没有缓存也挂一次：让 globalData 至少指向当前（空）状态
  mount()
}

/**
 * 拿当前 userInfo；还没有时建一份**最小的**（id 0 + 全零）。
 *
 * ⚠️ 只在「已经发生了一件只有真实账号才做得到的事」时才用得到 ——
 *    比如一次打分成功（提交本身要求账号）。
 *    光靠它 hasJoined() 会变 true，这是对的：事情都做成了，账号当然在。
 *    下一次 /api/user/me 回来会整份覆盖它，不必在这里凑字段。
 */
function ensureUserInfo(): MeResponse {
  return (
    state.userInfo ?? {
      id: 0,
      nickname: null,
      avatarUrl: null,
      gender: null,
      age: null,
      bio: null,
      status: 'active',
      energy: 0,
      challengedCount: 0,
      challengedRounds: 0,
      conqueredCount: 0,
      cookies: { total: 0, balance: 0 },
      streak: emptyStreak(),
    }
  )
}

/**
 * 用「最新上线」列表接口（**公开**，`GET /api/articles/latest`）的返回值刷新。
 *
 * ⚠️ 它原来是 `applySchedules`（`GET /api/schedules`）—— 那条接口与 `schedules` 排期表
 *    一起删了（用户 2026-09 定）。现在这个包只回答「最近上线了哪几句」。
 *
 * ⚠️⚠️ 这里刻意**不碰** participation 与 userInfo —— 公开接口不带「我的」字段了：
 *    · 「我在这句上的战绩 / 参没参与」→ applyParticipation（/api/user/participation/{id}）
 *    · 「连续天数 / 解冻卡」→ /api/user/me（写 userInfo 的是 applyProfile）
 *    一份数据一个写入方，才不会有「两个来源对不上」。
 */
export function applyLatestCards(res: LatestCardsResponse): void {
  // ⚠️ 其余字段原样带着走（各有各的写入方，见上）
  // ⭐ 整份存下来 —— 它同时是「首屏缓存」（见 MeState.latestCards，含 date）
  commit({ ...state, latestCards: res })
}

/**
 * 用「今天读哪一句」（**公开**，`GET /api/articles/today`）的返回值刷新。
 *
 * ⚠️ 和 applyLatestCards 一样，**只存公开内容 + date**（date 用来判缓存过期）。
 *    它不碰 participation / userInfo —— 「我在这句上的战绩」另有写入方。
 */
export function applyToday(res: TodayArticleResponse): void {
  commit({ ...state, today: res })
}

/**
 * ⭐ 冷启动首屏用：把上次那一屏列表取回来 —— **只在服务端说还是同一天时**。
 *
 * ⚠️⚠️ 跨天一律返回 null：缓存里存的是**那一天**的列表，
 *    拿昨天的当「今日挑战」画出来，点进去还是昨天那句 —— 错的比空着更糟。
 * ⚠️ 判据用响应里的 `date`（**服务端的今天**）而不是本地时钟：
 *    手机时间可以随便改，而"这份缓存是哪天的"只有服务端说了算。
 */
export function cachedLatestCards(): LatestCardsResponse | null {
  const s = state.latestCards
  return s && s.date === today() ? s : null
}

/**
 * ⭐ 冷启动首屏用：把上次那张**今日挑战卡**取回来 —— 同样只在 `date` 还是今天时。
 *
 * ⚠️ 没有它的话，冷启动那 9~25 秒里首页最上面那张卡是空的（下面「最新上线」反而有）。
 * ⚠️ 跨天一律 null：今日卡是有"哪一天"含义的，昨天那张不能当今天的画。
 */
export function cachedToday(): TodayArticleResponse | null {
  const t = state.today
  return t && t.date === today() ? t : null
}

/**
 * ⭐⭐ 「一句的参与状态」的**唯一写入方** —— `GET /api/user/participation/{articleId}` 的返回值。
 *
 * ⚠️ `record` 为 **null** 是**结论**（服务端说这一句我没参与过），不是"没拉到" ——
 *    后者**不要调它**（键不存在才是"未知"，见 MeState.participation 的说明）。
 * ⚠️ 键是 **articleId**（句子身份），与日期无关（同 store 头部那条口径）。
 */
export function applyParticipation(articleId: string, record: ParticipationRecord | null): void {
  applyParticipations([{ articleId, record }])
}

/**
 * ⭐⭐ 批量版（**列表**用）—— 一次 commit 写多句。
 *
 * ⚠️ 为什么要有它：一屏 7 张卡（首页今日 + 最新 6 张）如果逐条写，就是 7 次广播、
 *    7 次整页重画 —— 而那 7 条是**同一批**拿回来的，本来就该是一次更新。
 *
 * ⚠️ 与单条版同一条纪律：`record: null` 是**结论**（服务端说没参与过），
 *    "没拉到"**不要**走这里（键不存在才是未知）。
 */
export function applyParticipations(
  items: { articleId: string; record: ParticipationRecord | null }[],
): void {
  if (items.length === 0) return
  const participation = { ...state.participation }
  for (const it of items) participation[it.articleId] = it.record
  commit({ ...state, participation })
}

/**
 * ⭐ 读「我在这一句上的参与状态」。
 *
 * @returns `loaded` = 拉过没有（服务端给过答复）；
 *          `record` = 参与记录；`loaded && record === null` 才是"明确没参与过"。
 * ⚠️ 调用方**必须**分开这两件事：`loaded === false` 时按默认（未参与）画，
 *    但那不是结论，界面不该说"你还没参与过"这种肯定句以外的话。
 */
export function participationOf(articleId: string): {
  loaded: boolean
  record: ParticipationRecord | null
} {
  const loaded = Object.prototype.hasOwnProperty.call(state.participation, articleId)
  return { loaded, record: loaded ? (state.participation[articleId] ?? null) : null }
}

/**
 * ⭐ 读**会话缓存**里的句子详情（`GET /api/articles/{id}`）。
 *
 * ⚠️ 没有就返回 **null**（= 还没拉过），调用方去拉一次再写回来 —— 见 lib/content。
 * ⚠️ 这个缓存**不落 storage**，重开小程序即失效（见 MeState.articleDetail）。
 */
export function getArticleDetail(id: string): ArticleDetail | null {
  return state.articleDetail[id] ?? null
}

/**
 * ⭐ 写会话缓存。⚠️ 同一个 id **后写的覆盖先写的**（服务端是唯一真相，不做合并）。
 */
export function applyArticleDetail(detail: ArticleDetail): void {
  commit({ ...state, articleDetail: { ...state.articleDetail, [detail.id]: detail } })
}

/**
 * ⭐ 读**最近一次**拿到的参与统计（`GET /api/stats/participation`）。
 * ⚠️ 键不存在 = 还没拉到 —— 界面按"还没有人参与"画，但那不是结论。
 */
export function getArticleStats(articleId: string): ArticleStats | null {
  return state.articleStats[articleId] ?? null
}

/**
 * ⭐ 批量写参与统计（一次 commit）。
 * ⚠️ 统计是**现算**的：同一 id 每次拉到就覆盖，不做合并（服务端是唯一真相）。
 *
 * ⚠️⚠️ **值一模一样就不 commit**（也就不广播）—— 这是防"订阅里取数"自激的**结构性防线**：
 *    统计是"每次都重新拉"的，所以"拉回来发现没变"是**常态**；
 *    若无条件 commit，任何"广播 → 取数"的回调都会变成死循环（见 subscribe 的说明）。
 *    ⚠️ 它**不能替代**那条铁律（值真的变了照样会广播），但能让绝大多数空转消失。
 */
export function applyArticleStats(items: ArticleStats[]): void {
  if (items.length === 0) return
  const articleStats = { ...state.articleStats }
  let changed = false
  for (const it of items) {
    const prev = articleStats[it.articleId]
    if (
      prev &&
      prev.participantCount === it.participantCount &&
      prev.topScore === it.topScore &&
      prev.lowestScore === it.lowestScore
    ) {
      continue
    }
    articleStats[it.articleId] = it
    changed = true
  }
  if (!changed) return
  commit({ ...state, articleStats })
}

/**
 * ⭐ 读**最近一次**拿到的收藏总量（`GET /api/stats/favorite-count`）。
 * ⚠️ `null` = 还没拉到，`0` = 确实没人收藏 —— **两者必须分开**
 *    （把"没拉到"写成 0，界面会肯定地说"还没人收藏"，而那是错的）。
 */
export function getFavoriteCount(articleId: string): number | null {
  return state.articleFavoriteCounts[articleId] ?? null
}

/**
 * ⭐ 批量写收藏总量（一次 commit）—— 与 `applyArticleStats` 同法。
 * ⚠️ 0 也要写进去：它是**答案**（"确实没人收藏"），不是"没拿到"。
 * ⚠️⚠️ 同样**值没变就不 commit**（理由见 applyArticleStats）：这一格是 2026-09 新加的，
 *    加它的同时就把这条防线补上了 —— 否则它会成为第二个自激的引信。
 */
export function applyFavoriteCounts(items: ArticleFavoriteCount[]): void {
  if (items.length === 0) return
  const articleFavoriteCounts = { ...state.articleFavoriteCounts }
  let changed = false
  for (const it of items) {
    if (articleFavoriteCounts[it.articleId] === it.favoriteCount) continue
    articleFavoriteCounts[it.articleId] = it.favoriteCount
    changed = true
  }
  if (!changed) return
  commit({ ...state, articleFavoriteCounts })
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
 * ⚠️ streak 落在 userInfo 里（它是 /me 的一部分）；服务端没给 streak 时
 *    保留旧值，账号信息还没有时也不凭空造一份 —— 下一次 /me 会补齐。
 */
export function applySubmissionResult(input: {
  articleId: string
  score: number
  streak?: StreakDelta
}): void {
  // streak 直接用服务端算好的那一份；只有服务端没给时才保留旧的
  let userInfo = state.userInfo
  if (input.streak) {
    const base = userInfo ?? ensureUserInfo()
    userInfo = {
      ...base,
      streak: {
        // 解冻卡的到期日 / 待领取数提交响应里没有，保留上一次刷新拿到的值
        ...base.streak,
        streakDays: input.streak.streakDays,
        streakBest: input.streak.streakBest,
        unfreezeCards: input.streak.unfreezeCards,
        readToday: input.streak.counted,
      },
    }
  }

  /**
   * ⚠️⚠️ 顺手把这一句的**参与记录**标成"未知"（删掉键）：刚打完分，
   *    上一次拉到的 `null` / 旧 attempts 已经过期了 —— 下次页面读它时会重新拉
   *    （见 lib/participation.ts）。留着一个旧快照，表现就是"提交完按钮没变"。
   */
  const participation = { ...state.participation }
  delete participation[input.articleId]

  commit({ ...state, userInfo, participation })
}

/**
 * ⭐ 用 GET /api/user/me 的返回值刷新「我是谁」。
 *
 * ⚠️ 原样存整份响应 —— 不裁剪：裁剪出来的那份就是第二份真相，
 *    而 streak / status 这些字段迟早会在某一处被需要。
 * ⚠️ 这是 userInfo 的**唯一正式写入方**；提交响应、改资料都只做局部合并。
 */
export function applyProfile(m: MeResponse): void {
  commit({ ...state, userInfo: m, session: 'ready' })
}

/**
 * ⭐ 问不到身份（超时 / 没网 / 后端没起来）—— 由 lib/auth 在"没问到"时调用。
 *
 * ⚠️⚠️ 它与 `'ready'` 的区别是硬的：`'ready'` 的意思是"服务端给了答复"
 *    （答复可以是"库里没有你这一行"，见 clearIdentity）。把"问不到"也说成
 *    ready，界面就会画出一个**假的「加入」按钮** —— 有记录的老用户会以为
 *    账号没了（见 SessionState 的说明）。
 */
export function markSessionUnknown(): void {
  if (state.session === 'unknown') return
  commit({ ...state, session: 'unknown' })
}

/**
 * ⭐⭐ 服务端**明确**说「库里没有我这一行」—— 把本机那份"已加入"的快照清掉。
 *
 * ⚠️⚠️ 为什么必须清：`userInfo` 会落 storage，它是**上一次**问到的快照。
 *    服务端那边的行可能已经没了（清库 / 换环境 / 账号被删），而本机会一直
 *    自信地认为"我加入过" ⇒ `ensureAuthed()` 直接放行，用户点下去发现每个
 *    鉴权接口都 403，界面表现成"什么都打不开"。
 *
 * ⚠️ 清的是**身份相关**的那几格（userInfo / participation 战绩）；公开内容缓存
 *    （latestCards / today）留着 —— 它们与账号无关，且是首屏秒开用的。
 * ⚠️ session 标成 `'ready'`（不是 'pending'）：服务端**已经答复过**了，
 *    答案是"没有你这一行" ⇒ 界面该画「加入」，而不是继续转圈。
 */
export function clearIdentity(): void {
  // ⚠️ 参与记录也一并清掉：它是"我的"数据，跟着账号走
  commit({ ...state, userInfo: null, participation: {}, session: 'ready' })
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
export function applyProfilePatch(patch: ProfileUpdateResponse): void {
  const base = ensureUserInfo()
  commit({
    ...state,
    userInfo: {
      ...base,
      // ⚠️ 直接用服务端返回的**落库真相**：这次没选头像时它给的是库里存着的那张，
      //    不能因为入参没带就把界面上的头像抹掉（见 routes/user.ts 的说明）。
      nickname: patch.nickname,
      avatarUrl: patch.avatarUrl,
      gender: patch.gender,
      age: patch.age,
      bio: patch.bio,
    },
  })
}

/** 换账号 / 清空重置时调用 —— 否则会把上一个人的成绩显示给下一个人 */
export function reset(): void {
  commit(emptyState())
}

