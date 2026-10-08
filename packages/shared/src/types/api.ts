import type { ScoreParts } from '../scoring'
import type { ArticleLevel, ArticleTheme, ArticleWordItem, AudioRef } from './content'

/**
 * 引擎输出的词级结果。
 * ⚠️ 与内容的 ArticleWord 是两回事：
 *   WordScore = **运行时的评分结果**（这次这个词读得怎么样）
 *   ArticleWord = **内容侧的词级数据**（音标 / 释义 / 示范音频）
 * 客户端按 position 把两者拼起来渲染。
 */
export interface WordScore {
  word: string
  score: number
  dp: 'normal' | 'omission' | 'insertion' | 'repetition' | 'mispronunciation'
  startMs: number
  endMs: number
}

/**
 * ⭐ 讯飞 ISE 的四个**句级维度**（需要 extra_ability: multi_dimension 才会返回）。
 *
 * ⚠️ 掌握它们的真实关系，否则界面上很容易把话说过头：
 *
 *     total = (0.6×accuracy + 0.3×fluency + 0.1×standard) × integrity
 *
 *   ⚠️⚠️ 权重是 **0.6 / 0.3 / 0.1**，不是文档里那个 0.5 / 0.3 / 0.2 ——
 *      这是拿真实返回**算出来的**，不是抄来的：
 *        真实录音：acc 88.81818 / flu 74.44706 / std 54.59834 / integrity 91.66666
 *                  → 0.6/0.3/0.1 得 74.327783，实际 74.327800（Δ = 0.000017）
 *                  → 0.5/0.3/0.2 得 71.190964（差 3.1 分，明显不对）
 *        分句节点同样只对得上 0.6/0.3/0.1。
 *      原因：**我们这一路返回的节点名是 <read_chapter>，走的是篇章权重**，
 *      即使请求里 category 传的是 read_sentence（见 engines/xfyun.ts 的实测记录）。
 *
 *   完整度（integrity）是**乘性因子** —— 读得再准，漏读会把总分按比例整体拉低。
 *   所以「总分低」有两种完全不同的解释：发音不准（准确度低），或者没读完（完整度低）。
 *   界面上必须把这两件事分开说，否则用户不知道该练什么。
 *
 * 字段来源：rec_paper 下的 <read_chapter> 节点（**即使题型是 read_sentence**，节点名也叫 read_chapter）。
 * 实测结构见 apps/server/scripts/dump-ise-xml.ts。
 */
export interface ScoreDimensions {
  /** 准确度 —— 权重 0.5 */
  accuracy: number
  /** 流利度 —— 权重 0.3 */
  fluency: number
  /** 标准度 —— 权重 0.2（音节/重音层面与标准音的接近程度） */
  standard: number
  /** 完整度 —— **乘性因子**，漏读/增读会直接压低总分 */
  integrity: number
}

/** 统一响应包装 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string }

/* ---------- 提交检测（核心） ---------- */

export interface SubmitRequest {
  articleId: string
  /** 音频在对象存储里的 key：audio/{articleId}/{userId}/{ts}.pcm */
  audioKey: string
  /**
   * 可选：该音频的**带签名下载地址**（小程序 wx.cloud.getTempFileURL 拿到的）。
   *
   * ⚠️ 为什么需要它：服务端自己读对象存储要靠「开放接口服务」取临时密钥，
   *    而该服务在本项目 dev 环境实测**始终没有旁加载到实例**
   *    （容器内 api.weixin.qq.com 解析到公网 IP、响应头无 x-openapi-seqid）。
   *    给了这个地址，服务端就不必依赖那个服务。
   *
   * ⚠️ 服务端会严格校验它：host 必须是我们自己的桶，且路径解出来必须**等于 audioKey**。
   *    详见 services/audio-key.ts 的 assertAudioUrlMatchesKey。
   */
  audioUrl?: string
  /**
   * ⭐ 是否**公开这次录音** —— 决定「卡片之外的入口」能不能听到这段声音。默认 false。
   *
   * ⚠️ 它不是「能不能上榜」：无论公开与否，成绩都进榜、音频都存在对象存储里。
   *    区别只是**别人能不能听到**。
   * ⚠️ 它也不是「分享卡片能不能听」：从挑战详情的分享卡片（群聊 / 个人聊天 /
   *    通知）进来的任何人都能听，不受这一位影响（链接即凭据）。
   *    语音是生物特征 —— 默认必须是不公开，公开由用户自己打开开关。
   */
  isPublic?: boolean
}

/**
 * ⭐ 提交的**受理**结果 —— 不是打分结果。
 *
 * ⚠️⚠️ 为什么提交与打分要在协议上分开：
 *    一次讯飞评测要 10–20 秒，而云托管 callContainer 单次超时上限只有 15 秒。
 *    一个请求**装不下**一次打分 —— 所以后端受理后立刻返回 submissionId，
 *    客户端轮询 SubmissionStatusResponse，直到 status 变成 scored / failed。
 *
 *    这样链路上**没有任何「打分最多能跑多久」的假设**：
 *    唯一的判据是服务端的心跳，句子再长也只是多轮询几次。
 */
export interface SubmissionStatusResponse {
  submissionId: string
  status: 'scoring' | 'scored' | 'failed'
  /**
   * ⚠️ 只在 status === 'scored' 时存在。
   *    POST 受理时如果这段音频**早就打过分**（幂等命中），也会直接带上它 ——
   *    客户端看到 scored 就不必再轮询了。
   */
  result?: SubmitResponse
  /** ⚠️ 只在 status === 'failed' 时存在 */
  error?: string
  /**
   * ⭐ **这一句（article）我一共攒了多少饼干**（用户 2026-10 定）。
   *
   * ⚠️ 口径是「这一句」不是「这一局」：同一句话会在**不同的参与**里被反复挑战，
   *    而用户想问的是"这句我总共练出来多少" ⇒ 按 article 汇总。
   * ⚠️ 只算**已领取**的（账本里有行）：还没点结果那颗钮的还在
   *    `submissions.cookies_earned` 里躺着，不算"攒到" ✓
   * ⚠️ 附在轮询响应上而不是另开一个接口：朗读页本来就在轮询它，
   *    多一个请求只为了一个数字不划算。
   */
  sentenceCookies?: number
}

export interface SubmitResponse {
  /** 云端权威分 0–100 */
  score: number
  /**
   * ⭐ AI 教练的 4–8 字点评（展示用）。
   * ⚠️ 可能没有：没配大模型、或调用失败 —— 前端据此整块不渲染，
   *    而不是显示一个空框（见 services/coach.ts）。
   */
  aiComment?: string
  /** ⭐ AI 教练的提升建议（给用户自己看，会指名到具体的词/音） */
  aiAdvice?: string
  /**
   * ⭐ **我们自己那套打分的分项明细** —— 结果页的「评分详情」显示的就是它。
   *
   * ⚠️ 不要拿引擎那四维（accuracy/fluency/standard/integrity）当详情：
   *    总分已经不按它们等权算了，摆在一起用户对不上（「我准确度 91，为什么总分 85」）。
   *    这里给的正是总分的五个组成部分，加起来就是那个分。
   */
  parts?: ScoreParts
  /**
   * ⭐ 这次读的**参考原文**（服务端一并给出）。
   *
   * ⚠️ 为什么要它：详情/分享页要把句子逐词上色，而逐词结果的第 i 项
   *    对应的是**这一句**的第 i 个词 —— 客户端自己再去拉一次正文，
   *    等于同一份数据两条路，哪天正文改了版本就对不上了。
   */
  text?: string
  /** ⭐ 这段录音有多长（毫秒）—— 结果页显示在播放按钮旁边 */
  durationMs?: number
  /**
   * ⭐ 这次挑战属于哪一天（YYYY-MM-DD）—— 结果页的排名卡点进竞技场要用它。
   * ⚠️ 不能拿端侧日期凑：历史挑战点进去要看的是**当时那一轮**的榜单。
   */
  scheduleDate?: string
  rank: number
  participantCount: number
  /** 距上一名还差多少分；null 表示已是第一 */
  gapToPrev: number | null
  /** 击败人数（= participantCount - rank） */
  beatenCount: number
  isPersonalBest: boolean
  isConquered: boolean
  /**
   * ⭐ 这次提交读的是**哪一句**（服务端认定的）。
   *
   * ⚠️⚠️ 客户端拿它当「我在这句上的战绩」的键 —— 竞技数据跟着句子走，与日期无关。
   *    必须由服务端回传：终端自己从 URL 里取的话，取错了就是
   *    「提交完参与状态不刷新」，而每一处代码单独看都是对的。
   */
  articleId: string
  /**
   * ⭐ 这段录音当前的可见性（别人能不能听到）。
   *
   * ⚠️ 提交时**不再问**用户，统一按默认值落库，结果页再给开关 ——
   *    所以这里必须回传**权威值**，不能让客户端自己猜一个：
   *    用户可能已经改过，而结果页会被反复拉到。
   */
  isPublic: boolean
  /** ⭐ 这一句的视觉主题 —— 结果卡用它上色；老内容为 null ⇒ 品牌色兜底 */
  theme: ArticleTheme | null
  /** 上一次成绩，用于「🎉 62 → 87」 */
  previousBest: number | null
  /**
   * ⭐ 这一把是**这句**的第几次提交（从 1 开始）—— s5 副标题「第 K 次挑战」用的就是它。
   *
   * ⚠️⚠️ **可空**（2026-09 改）：序号**只在"有结论"时才分配**（见 db/schema.ts），
   *    与「我在这句打过几次分」（参与记录的 attempts）不是同一个数 —— 后者只数 scored。
   *    端侧原来拿 store 的缓存猜、还夹了下限 2：缓存里没有这句的旧战绩时会猜成
   *    「第 2 次」，而 previousBest 又是 null（首次）—— 两个字段自相矛盾。
   * ⚠️ 「是不是首次」仍由 previousBest === null 判，不用它：首次失败过的用户
   *    第二次出分时 previousBest 还是 null，那时该显示「首次挑战」。
   */
  attempts?: number
  /**
   * ⭐ 这一把的**饼干快照** —— 结果页那一行的 +N 就是它。
   *
   * ⚠️ 为什么可选：结算（services/settle.ts）与「status 置为 scored」不在同一个事务里，
   *    轮询恰好卡在两者之间时会读到 null；老数据也可能没结算过。
   *    端侧拿不到就**整块不渲染**（不是摆一个 +0 🍪）。
   */
  cookies?: CookieAwardView
  /** 榜单中心 5 条 */
  leaderboard: LeaderboardRow[]
  /** 词级结果（可选增强；缺失时端侧兜底） */
  words?: WordScore[]
  /**
   * 句级四维得分（可选增强）。
   * ⚠️ 缺失时界面必须能优雅退化 —— mock 引擎与历史数据都可能没有。
   */
  dimensions?: ScoreDimensions
  /**
   * ⭐ 这次打分带来的 streak 变化。
   * ⚠️ 只有**真正打分成功**的那一次才有 —— 幂等重放不带它，
   *    因为重放不是一次新的「今天来读了」。
   */
  streak?: StreakDelta
}

export interface LeaderboardRow {
  rank: number
  /** 这一行是谁 */
  userId: number
  /**
   * ⭐⭐ **这一行参与记录的地址** —— 从榜单点进去看详情就是 `GET /api/participation/{participationId}`。
   *    它等于 `participations.id = sha256(userId + ':' + articleId)` 前 24 位（见 db/schema.ts）。
   */
  participationId: string
  nickname: string
  /**
   * 头像 —— ⚠️ 是**云存储 fileID**（cloud://…），不是 http 地址：
   *    客户端必须用 lib/cloud-file.ts 的 resolveCloudFileUrl 换成临时地址才能进 <image src>。
   * 没设头像 / 用户行不存在时为 null（界面退回本地占位图）。
   */
  avatarUrl: string | null
  score: number
  isMe: boolean
}

/* ---------- Streak（连续天数） ---------- */

/**
 * Streak 的**展示视图** —— 服务端算好、客户端只负责显示。
 *
 * ⚠️ 客户端不重算「今天读没读」：手机时钟可以随便改，
 *    让客户端来判断只会出现「本地显示已打卡、服务端根本不记」的错位。
 *    日期一律来自服务端的 day.ts。
 */
export interface StreakView {
  /** 当前连续天数 */
  streakDays: number
  /**
   * 历史最长连续天数 —— **只增不减**。
   * ⚠️ 等级徽章已整体废除，它现在只剩展示用途（我的主页上的「历史最长」）。
   */
  streakBest: number
  /** 今天是否已经读过（读过再读不叠加） */
  readToday: boolean
  /**
   * ⭐ **补签的当前状态** —— 断档之后花能量把缺口填上（prd §7.8）。
   * ⚠️ 它是解冻卡那三项的替代：同样回答"断档了我能做什么"，
   *    但答案从"手上几张卡"变成了"补得上吗、要花几点"。
   */
  makeup: MakeupState
}

/**
 * ⭐ 「连战记录」—— 一个月里哪天读了。
 *
 * ⚠️ 日历排版要的三个数（首日/天数/首日是周几）**全由服务端给**：
 *    端侧拿 'YYYY-MM-01' 去 new Date() 会按 UTC 解析，星期几有可能差一天，
 *    而那种错在界面上只表现为"整个月的格子整体错位"，很难看出来。
 */
export interface StreakRecordDay {
  date: string
  /** ⚠️ 只剩 read —— 「unfreeze」那种格子随解冻卡一起作废（2026-10） */
  kind: 'read'
}

export interface StreakRecordResponse {
  /** 'YYYY-MM' */
  month: string
  firstDay: string
  daysInMonth: number
  /** 1 号是周几（0 = 周日） */
  weekdayOfFirst: number
  /** 服务端的今天 */
  today: string
  streakDays: number
  streakBest: number
  days: StreakRecordDay[]
  /**
   * ⭐ **补签的当前状态** —— 与 `StreakView.makeup` 同一份口径。
   * ⚠️ 这一页是补签的**唯一入口**，所以它必须带着"现在能不能补"，
   *    否则端侧要么自己算（算不出来，见 MakeupState 的说明）、要么再发一个请求。
   */
  makeup: MakeupState
}

/* ------------------------------------------------------------------ */
/* ⭐ 能量 / 商店（见 docs/design/payment-and-purchase.md）              */
/* ------------------------------------------------------------------ */

/**
 * 能量流水的一条。
 *
 * ⚠️ 服务端只给 `reason` **原文**（purchase / daily_topup / challenge_hold …），
 *    文案由端侧映射 —— 这样加一个 reason 不用改接口，而端侧也不会去猜业务。
 */
export interface EnergyLedgerItem {
  id: number
  /** 正数入账、负数出账，单位「点」 */
  delta: number
  /** 服务端的 reason 原文 */
  reason: string
  /** submission | day | purchase | reward */
  refType: string
  refId: string
  /** ISO 时间串 */
  createdAt: string
}

/** me/energy 页的数据：余额 + 流水（分页） */
export interface EnergyResponse {
  /** 当前余额。⚠️ 服务端已经顺带做过「每日补足」，端侧拿到的就是真实可用点数 */
  energy: number
  /** 每次挑战消耗多少点 —— ⚠️ 端侧别自己写死 2 */
  perChallenge: number
  /** 每天补足到的下限 */
  dailyFloor: number
  items: EnergyLedgerItem[]
  /** 下一页游标（把最后一条的 id 当 before 传回来）；null = 没有更多了 */
  nextBefore: number | null
}

/**
 * ⭐⭐ **补签的结果**（`POST /api/user/makeup`）—— 规格：prd §7.8。
 *
 * ⚠️⚠️ 补不成**也返回 200**（`ok: false` 是正常业务结果，不是请求错误）——
 *    返回 4xx 会让端侧的通用错误处理弹一句无用的"网络异常"。
 *
 * ⚠️⚠️ `reason` **必须区分成四种**，因为用户要做的事完全不同：
 *    · already-read-today ⇒ 今天已经读过了（缺口要在读**之前**补）
 *    · no-gap             ⇒ 没断档，不用补
 *    · too-long           ⇒ 断太久，**说成"重新开始"而不是失败**
 *    · not-enough-energy  ⇒ 配合 `shortfall` 指向"吃饼干 / 充值"
 *    混成一句"补签失败"等于什么都没告诉用户。
 */
export interface MakeupResponse {
  /** 补成了没有 */
  ok: boolean
  /** 缺口几天（0 = 没断档） */
  gapDays: number
  /** 补签本身要花几点能量 */
  cost: number
  /**
   * ⭐ **当天总共要几点** —— 补签 + 还要读的那一句。
   * ⚠️ 必须给：用户看到"补签 3 点"会以为花 3 点就够了，
   *    而当天他还得读一句（再 2 点）。总账要摆在明处，否则他会以为界面在骗他。
   */
  totalCost: number
  /**
   * ⭐ **还差几点能量**（只在 `not-enough-energy` 时有意义）。
   * ⚠️ 没有它，用户只知道"不够"，不知道"还差多少" → 也没法决定要不要去吃饼干。
   */
  shortfall: number
  /** 补完之后的连战视图 */
  streak: StreakView
  /** 补不了的原因（⚠️ 只可能是这四个值，schema 里是 enum） */
  reason?: MakeupFailureReason
}

/**
 * ⭐ **补签的当前状态** —— 服务端用 `shared/makeup.ts` 的纯函数算好、随连战视图下发。
 *
 * ⚠️⚠️ 为什么由服务端算：端侧**根本算不出来** —— 缺口要看 `lastReadDate`，
 *    而那个字段不下发（只发 `streakDays / streakBest / readToday`）。
 *    要端侧算就得把 `lastReadDate` 也发出去，那等于把"今天算哪天"这个判断
 *    又交回给一台时钟可以被随便改的手机。
 *    ⇒ 与「readToday 由服务端判定」同一条原则。
 *
 * ⚠️ 它**不含** `newLastReadDate`（补完该落到哪天）—— 那是服务端写库的内部细节，
 *    发出去只会让人以为客户端可以自己改连战。
 */
export interface MakeupState {
  /** 现在能不能补 */
  ok: boolean
  /** 缺口几天（0 = 没断档） */
  gapDays: number
  /** 补签本身要花几点能量 */
  cost: number
  /** 当天总共要几点（补签 + 还要读的那一句） */
  totalCost: number
  /** ok=false 时说明为什么 */
  reason?: MakeupFailureReason
}

/**
 * ⭐ **饼干换能量的结果**（`POST /api/user/exchange`）。
 *
 * ⚠️ 与补签一样，换不成**也返回 200**（`ok: false` 是业务结果）——
 *    返回 4xx 只会让端侧弹一句无用的"网络异常"。
 */
export interface ExchangeResponse {
  ok: boolean
  /** 换到几点能量（ok=false 时是 0） */
  energyGained: number
  /** 用掉多少饼干（ok=false 时是 0） */
  cookiesSpent: number
  /** 换完之后的两个数 —— ⚠️ 端侧别自己加减，以服务端回的为准 */
  cookies: CookieView
  /** 换完之后的能量余额 */
  energy: number
  /** 换不成的原因 */
  reason?: ExchangeFailureReason
}

/** 换不成的原因 */
export type ExchangeFailureReason =
  /** 饼干不够换 1 点（< 40 块） */
  | 'not-enough-cookies'

/**
 * ⭐ **看激励视频补能量的结果**（`POST /api/user/ad-energy`）。
 *
 * ⚠️ 与补签 / 兑换同一约定：发不成**也返回 200**（`ok: false` 是业务结果）——
 *    返回 4xx 只会让端侧弹一句无用的"网络异常"。
 *
 * ⚠️⚠️ 三种「成功」要分清（端侧文案全靠它）：
 *    · `energyGained > 0`            —— 真发了；
 *    · `ok && energyGained === 0`    —— ⭐ **重放**（同一个 requestId 又来了：
 *      响应丢了客户端重试、或连点两下）。**点数没变**，所以**不能**再说一次"+1"；
 *    · `ok === false`                —— 没发（原因见 `reason`）。
 *
 * ⚠️ 我们**没有**自己的日限（2026-10 用户定）：能看几次由微信广告系统决定
 *    （官方口径「每个用户每天可观看激励式视频广告的次数有限」，数字未公布），
 *    端侧表现为 `onError` / 拉取失败。服务端只有一个「最小间隔」挡脚本。
 */
export interface AdEnergyResponse {
  ok: boolean
  /** 这一次真发出去几点（重放 / 失败时是 0） */
  energyGained: number
  /** 发完（或重放）之后的能量余额 —— ⚠️ 端侧别自己加减 */
  energy: number
  /** 发不成的原因 */
  reason?: AdEnergyFailureReason
}

/** 发不成的原因 */
export type AdEnergyFailureReason =
  /** 距上一次发放太近 —— ⚠️ 只有脚本会撞上（一次广告最短 6 秒），正常用户看不到 */
  | 'too-soon'
  /** 用户行不存在 —— ⚠️ 防御性分支：`/api/user/*` 的鉴权本该先 403 掉，理论上到不了 */
  | 'unavailable'

/** 补签补不了的原因 —— 与 `shared/makeup.ts` 的 `MakeupBlockReason` + 能量那条合起来 */
export type MakeupFailureReason =
  | 'already-read-today'
  | 'no-gap'
  | 'too-long'
  | 'not-enough-energy'

/**
 * ⭐ **领取这一把饼干的响应**（用户 2026-10 定：点开结果之后才入账）。
 *
 * ⚠️ 重复领取也回 200，但 `claimed` 只会是**第一次**那个金额
 *    （幂等由账本的唯一键 + affectedRows 保证，见服务端 claimCookies）。
 */
export interface ClaimCookiesResponse {
  /** 这一次实际到账的饼干；0 = 本来就没攻克，或者之前已经领过了 */
  claimed: number
  /** 领取之后的余额（用它刷新界面，别在端侧自己加） */
  cookies: CookieView
}

/**
 * ⭐ **饼干流水的一条** —— 与 `EnergyLedgerItem` 同形（两张流水表结构一样，
 *    见 schema 里 cookie_ledger 的注释：为什么它们是两张表而不是一张）。
 *
 * ⚠️ `reason` 是给端侧做文案映射用的（`conquer` → 「攻克句子」…），
 *    端侧认不出来的一律叫「奖励」—— 加一种 reason 不该逼着端侧发版。
 */
export interface CookieLedgerItem {
  id: number
  /** 正数入账（攻克）、负数出账（换能量） */
  delta: number
  /** conquer | exchange | admin */
  reason: string
  refType: string
  refId: string
  /** **入账**时刻（ISO）—— 记账发生的时间 */
  createdAt: string
  /**
   * ⭐⭐ **成就发生的时刻**（ISO；只有 `conquer` 有）。
   *
   * ⚠️⚠️ 为什么它与 `createdAt` 是两个数：**兜底清扫会补跑结算** ——
   *    一条 9 月 28 日的提交可能在 10 月 6 日才被补上（进程死在写分数与结算之间）。
   *    那时 `createdAt` 是"刚刚"，而用户读到的是「**我什么时候做到的**」⇒
   *    他会以为"我刚才那次 54 分居然给了 10 块"，进而以为规则算错了。
   *    ⇒ **流水行要显示 `achievedAt`**（缺了才退回 `createdAt`）。
   */
  achievedAt?: string
  /** ⭐ 那一次的得分（只有 `conquer` 有）—— 摆出来，用户能自己核对"为什么给了" */
  score?: number
}

/** ⭐ 饼干页的数据：两个位置的余额 + 流水（分页） */
export interface CookiesResponse {
  /** 累计获得（只增）+ 可用（可花）—— 见 CookieView */
  cookies: CookieView
  items: CookieLedgerItem[]
  /** 下一页游标（把最后一条的 id 当 before 传回来）；null = 没有更多了 */
  nextBefore: number | null
}

/** 商店里的一件商品（价格由服务端给，端侧不写死） */
export interface ShopGoodsItem {
  code: string
  /** 发多少点 */
  amount: number
  /** 售价，单位**分** */
  priceFen: number
  title: string
  subtitle: string
  badge: string | null
  /**
   * ⭐ 现在能不能买（在售 + 已配道具 ID）。
   * ⚠️ 端侧据此**置灰**，而不是让用户点了才失败 ——
   *    「点了没反应」和「按不了」在体验上差很远。
   */
  sellable: boolean
}

export interface ShopGoodsResponse {
  items: ShopGoodsItem[]
  /** 0 = 现网 / 1 = 沙箱 —— 端侧在界面上标一下，免得测试时以为花的是真钱 */
  payEnv: number
}

/** wx.requestVirtualPayment 的参数 —— 由服务端签好名，端侧**原样展开**传进去 */
export interface VirtualPayData {
  /**
   * ⚠️ 用**联合类型**而不是 string：基础库的入参就是这两个字面量，
   *    写成 string 的话端侧传给 wx.requestVirtualPayment 会直接类型不通过。
   *    我们只用 short_series_goods（道具直购）。
   */
  mode: 'short_series_goods' | 'short_series_coin'
  /** ⚠️ 是**字符串**（基础库要求 string 形式），不是对象 */
  signData: string
  paySig: string
  signature: string
}

/** 下单结果 */
export interface ShopOrderResponse {
  outTradeNo: string
  amountFen: number
  points: number
  /** ⭐ true = mock 通道已经「付掉了」，端侧**不要**再拉起支付 */
  mockPaid: boolean
  payData: VirtualPayData
}

/**
 * ⭐ **用户目录**里的一行（`GET /api/users`）。
 *
 * ⚠️⚠️ **这条接口是公开的，而且含 `energy`** —— 这是 2026-09 用户**明确要求**的口径
 *    （"这个公开，含 energy"）。
 *    ⚠️ 它**不等于**"能量可以公开"成为通则：`/api/profile/:id`（个人主页）与
 *      `/api/user/me` 那条边界**没变** —— 能量是账号余额，主页仍然只给本人。
 *      ⇒ 别拿这里当先例往别的公开接口上加 energy。
 */
export interface UserSummary {
  /** 用户 id（本库自增主键，业务处处用它） */
  id: number
  /** 昵称；null = 还没起过名字（端侧显示占位，不在服务端编） */
  nickname: string | null
  /** 头像 —— 云存储 fileID（cloud://…），端侧先换址才能进 <image src> */
  avatarUrl: string | null
  /** ⭐ 能量余额（公开，见上面的说明） */
  energy: number
  /** 加入时间（ISO） */
  createdAt: string
  /**
   * ⭐ **参与次数** = 参与场次（**一句 = 一场**，只数拿到分的）。
   * ⚠️ 与 `/api/profile/:id` 的 `conqueredCount`、`challengeStats.challengedCount`
   *    是**同一个数**（三条口径都是"有分的句子数"），所以共用这个名字。
   */
  conqueredCount: number
  /** ⭐ **挑战回合** —— 出过分的提交次数（同一句重读 N 次算 N 回）。 */
  challengedRounds: number
  /** ⭐ **连战天数** —— 取自 `users.streak_days`（与 `readStreakView().streakDays` 同一个值）。 */
  streakDays: number
  /**
   * ⭐ **饼干** —— 累计获得 + 可用（见 CookieView 的说明）。
   * ⚠️ 与个人主页、用户面板同源。
   */
  cookies: CookieView
}

/** `GET /api/users` 的响应 */
export interface UserListResponse {
  items: UserSummary[]
}

/** 一次提交给 streak 带来的具体变化 —— 结果页要逐条讲清楚 */
export interface StreakDelta {
  streakDays: number
  streakBest: number
  /** 这次读有没有被计入（false = 今天已经读过） */
  counted: boolean
  /** streak 变化量 */
  delta: number
}

/* ---------- 每日挑战 ---------- */

/**
 * 首页列表里的一张挑战卡。
 *
 * ⚠️⚠️ **竞技数据属于句子，不属于日期。**',
 *    句子就是竞技场：所有人读同一段文本、比同一个分数。
 *    日期只是首页这张列表上的一个格子 —— 它指向哪个句子，就进哪个竞技场。
 *
 *    所以下面这几个字段（参与人数 / 最高分 / 我的成绩 / 挑战次数）是
 *    **那个句子**的数据。同一句被排在多天时，那几张卡片会显示同一份数字 ——
 *    这是对的：它们本来就是同一个竞技场。
 *
 *    ⚠️ 连续天数（streak）不在公开列表接口里 —— 它在 `/api/user/me` 上（按自然日算）。
 */
/**
 * ⭐ 卡片上的标准音。
 *
 * ⚠️ full / kind 的含义由 kind 决定（同 content.ts 的 AudioRef）：
 *    · cloud → 云存储 fileID，要用 wx.cloud.getTempFileURL 换地址
 *    · http  → 服务端路径，加 BASE_URL 前缀直接用
 * ⚠️ durationMs 可能是 null（算不出来）—— 那时端侧只显示按钮、不显示时长。
 */
export interface StandardAudio extends AudioRef {
  durationMs: number | null
}


/**
 * ⭐ 详情里那一段标准音 —— 比卡片上的 StandardAudio 多一份**逐词音频地址**。
 *
 * ⚠️ 以前这里多一个 words: 逐词音频地址的数组（下标对应 plainWordsOf）——
 *    已经删除：点词播放改走微信 TTS，正文与接口都不再存逐词音频。
 */
/**
 * ⭐ 句库**详情**（全量）—— GET /api/articles/:id，阅读页要的那一份。
 *
 * ⚠️⚠️ **这里就是「公不公开」的那一处定义** —— 列在这里的字段才会下发给客户端。
 *    以前这个接口写的是 `{ ...content }`（展开正文 JSON），那等于
 *    「正文里有什么就漏什么」，**不是决定而是事故**。
 *    ⇒ 以后往正文 JSON 加字段时，必须回到这里想一遍：它该不该给客户端。
 *
 * ⚠️ 它是「**静态 JSON + 两个运行期字段**」的合成体：
 *    · 其余字段来自 `content/articles/<id>.json`（见 ArticleContent）；
 *    · audio / theme 由服务端**按当前环境**拼出来 ——
 *      fileID 里带环境 ID 与桶名，绝不能写进仓库里的那份 JSON。
 * ⚠️ 没有标准音时 audio 是 **null**（不是给一个 full=null 的壳）——
 *    与 StandardAudio / SubmissionAudioResponse.audio 同一个约定。
 * ⚠️ 难度、challenge 与 advice 用 `| null`：正文里没写（老 JSON）就是 null，**不补默认值**。
 */
export interface ArticleDetail {
  id: string
  text: string
  translation: string
  words: ArticleWordItem[]
  /** ⭐ 词间连读标注（与 words 一一对应；`links[i]` 描述 words[i] 与 words[i+1] 之间；"" = 不连） */
  links: string[]
  /** ⭐ 难度档位（初级 / 中级 / 高级 / 专家）—— 由词汇/发音/长度三个判据分合成 */
  difficulty: ArticleLevel | null
  /**
   * ⭐ **给用户看的第一句：挑战宣言** —— 判决 + 依据（如「这句是真硬，母语者都读不顺」）。
   *    ⚠️ 它同时是**分享卡标题**的正文：客户端会拼成「朗读挑战:」+ challenge。
   */
  challenge: string | null
  /**
   * ⭐ **给用户看的第二句：朗读建议** —— 把挑战框小（真难的只有这几点）。
   *    与 challenge 拼接成一段显示（完整定义见 ArticleContent.challenge / .advice）。
   */
  advice: string | null
  tags: string[]
  /**
   * ⭐ 标准音 —— 阅读页顶行要显示 `▶ 00:23`，所以**时长跟着一起来**。
   * ⚠️ 用 StandardAudio（= AudioRef + durationMs）而不是 AudioRef：
   *    同一个事实（"这段音频多长"）在列表接口、详情接口、结果页三处
   *    必须是**同一种表达**，否则客户端要按接口各写一套解析。
   * ⚠️ durationMs 可能是 null（算不出来）—— 那时端侧**只显示按钮、不显示时长**，
   *    不能显示 00:00（那看着像音频坏了）。
   */
  audio: StandardAudio | null
  theme: ArticleTheme | null
}

/**
 * ⭐ 收藏列表里的一条 —— GET /api/user/favorites（**鉴权**）。
 * ⚠️ 与参与记录分开：那个回答"我在这句上打得怎么样"，这个回答
 *    "我收了哪几句话"（正文 + 难度/标签 + 收藏时间 + 顺带带上我的战绩）。
 */
export interface FavoriteItem {
  articleId: string
  text: string
  translation: string
  difficulty: ArticleLevel | null
  tags: string[]
  theme: ArticleTheme | null
  /** 收藏时间（ISO）—— 列表按它倒序 */
  favoritedAt: string
  /** 我的最好成绩；没参与过为 null（收藏与参与是两件事） */
  bestScore: number | null
  /** 我在这句打过几次分 */
  attempts: number
}

/** GET /api/user/favorites 的响应 */
export interface FavoritesResponse {
  items: FavoriteItem[]
}

/**
 * ⭐ **"这一句我收藏了吗"** —— `GET /api/user/favorited?articleId=`（鉴权）。
 *
 * ⚠️ 独立的一条查询（用户 2026-09 定）：**不掺进** participation 的响应，也不依附
 *    已删的 `arena-records`。收藏与"参与"是两件事 —— **没读过也能收藏**，
 *    混在一起就会出现"只收藏没读过 ⇒ 按钮变空心"那种 bug。
 */
export interface FavoritedResponse {
  favorited: boolean
}

/**
 * ⭐ **某一句被多少人收藏**（`GET /api/stats/favorite-count?ids=` 的一项，**公开**）。
 *
 * ⚠️ 它是 `favorites`（一人一句一行）的**现算聚合**，不是冗余计数列 ——
 *    所以永远准、不需要 ±1、也就不需要重建与对账。
 *    （对比 `submissions.like_count`：那一列是为了**排序**才存的；收藏不参与排序。）
 * ⚠️ 与「我收藏了吗」（`/api/user/favorited`）是两件事：
 *    那个答"我"，这个答"大家" —— 前者要身份、后者谁都能问。
 * ⚠️ 与参与统计（`ArticleStats`）**同形**：都是按句的公开聚合、都按 ids 零值补齐，
 *    只是一个数参与、一个数收藏 —— 所以它们并排放在 `/api/stats` 下。
 */
export interface ArticleFavoriteCount {
  articleId: string
  /** 多少人收藏了这一句；没人收藏是 0（**不是 null** —— "零"就是这个数的答案） */
  favoriteCount: number
}

/** `GET /api/stats/favorite-count` 的响应（按请求的 ids 零值补齐） */
export interface ArticleFavoriteCountsResponse {
  items: ArticleFavoriteCount[]
}

/**
 * ⭐ 我在**某一句**上的历史挑战（逐次）—— `GET /api/user/participation/{articleId}/submissions`。
 *
 * ⚠️ 路径就是「参与」这个资源本身：一次参与 = (我, 这一句)，它的**子资源**才是逐次提交。
 *    （2026-09 改：原来挂在 `/api/user/article-records?article=` 上 —— 那是"按句子查提交"，
 *    与"我的参与记录"是两个入口，现在统一从 participation 进去。）
 * ⚠️ 粒度是**一次提交**，与「参与场次」不同：那边一句一行（一人一句一行的派生索引），
 *    这边要的是"我在这一句上读过几次、每次多少分" —— 朗读页下方那一段历史用它。
 * ⚠️ 只给**有结论的**（status = scored / failed）：检测中的那次没有结论，
 *    混进来会让列表出现一条"没有结论的历史"。
 */
export interface ParticipationSubmissionItem {
  submissionId: string
  /**
   * ⚠️ `scored` = 有分；`failed` = **检测跑到了但没出分**（未检测到有效语音）。
   *    后者也**要显示在列表里**（按「未出分」渲染）—— 只显示有分的会让序号断档
   *    （用户 2026-09 看到「第 4 次 → 第 6 次」就是这个原因）。
   */
  status: 'scored' | 'failed'
  /** 云端权威分 0–100；`failed` 时是 null（**不是 0**，0 分是合法成绩） */
  score: number | null
  /** 这一把是**第几次**读这句（从 1 开始）—— 列表里显示"第 3 次" */
  seq: number
  /** 提交时间（ISO） */
  createdAt: string
  /** 这次挑战属于哪一天（点进竞技场要用；老记录可能没有） */
  scheduleDate: string | null
  /** 别人能不能听到这段录音 */
  isPublic: boolean
}

/** `GET /api/user/participation/{articleId}/submissions` 的响应 */
export interface ParticipationSubmissionsResponse {
  items: ParticipationSubmissionItem[]
  /** 我在这句上的最好成绩；一次都没读过为 null */
  bestScore: number | null
  /** 我在这句上出过分几次 */
  attempts: number
  /**
   * ⭐ 我在这句上的**名次**（跨用户算）；没出过分是 null。
   * ⚠️ 端侧算不出这个数（要别人的成绩）⇒ 必须服务端给（与竞技场榜单同一处实现）。
   */
  rank: number | null
  /** 这一句的参与人数；没人参与是 0 */
  participantCount: number
  /**
   * ⭐ 全场**最低分**（同一个人只算最好那次，与最高分同口径）；没人参与是 null。
   * ⚠️ 朗读页那张「我的参与」摘要卡要用它（与「我的挑战」列表的四个数同一套）。
   */
  lowestScore: number | null
}

/**
 * ⭐ 首页/列表上的一张竞技场卡片 —— **纯句子数据**。
 *
 * ⚠️⚠️ 它**不含任何"哪一天 / 是不是今天"**（2026-09 清掉）：
 *    · `date` / `isScheduled` / `isToday` 曾经都在这里，但它们回答的是
 *      「这次挑战记哪一天 / 是不是今天 / 是不是运营排的」——那是**请求上下文**，
 *      不是句子的属性（同一句在谁眼里、哪一天，都是另一回事）。
 *    · 现在日期只在**"今天的"那两条接口的信封**上（`LatestCardsResponse` /
 *      `TodayArticleResponse` 的 `date`），而且**只用于端侧按天做缓存失效**；
 *      成绩归属由服务端在受理提交时决定（`POST /api/user/submissions`）。
 *    ⇒ 点进竞技场一律按 **articleId** 寻址，不用日期。
 *
 * ⚠️⚠️ **参与统计（人数 / 最高 / 最低）不在卡片上**（用户 2026-09 定：L1 解耦）：
 *    卡片是"句子内容"，统计是 `participations` 的**聚合派生值**，两者生命周期不同
 *    （内容稳定可缓存、统计每次现算）。要显示"N 人参与"，端侧拿这一屏的 id 去调
 *    **批量统计接口** `GET /api/participations/stats?ids=a,b,c` 合并。
 */
export interface ArticleCard {
  articleId: string
  /** 句子原文 */
  text: string
  translation: string
  /** ⭐ 朗读难度（三个判据按权重合成的一个档位，见 shared/level.ts） */
  difficulty: ArticleLevel | null
  /** ⭐ 标签（服务端已规范化；空数组 = 这一句没有标签） */
  tags: string[]
  /**
   * ⭐ 卡片上的标准音（可播引用 + 时长）—— 用来在卡片上放「圆形播放按钮」。
   *
   * ⚠️ 这里原来**刻意没有**这个字段，理由是「卡片整张是『点进详情』的 tap 目标，
   *    再塞一个音频控件必然互相误触」。现在按产品要求加上，误触是这么处理的：
   *      · 播放按钮是**独立的一小块**，用 catchtap 吃掉事件（不冒泡到卡片）
   *      · 手点不到的地方（圆点以外）仍然是「点进详情」
   *    ⇒ 代价与收益都摆在明面上：多了一个更小的独立热区。
   *
   * ⚠️ 为 null = 这句没有标准音 ⇒ 端侧**不渲染播放入口**
   *    （渲染一个点了 404 的按钮比不渲染更糟）。
   */
  audio: StandardAudio | null
  /** ⭐ 视觉主题（背景/前景/配图）；老内容为 null ⇒ 端侧用品牌色兜底 */
  theme: ArticleTheme | null
}

/**
 * ⭐⭐ **今日推荐**（`GET /api/articles/today?uid=<id>`）—— 「今天适合读哪一句」。
 *
 * ⚠️⚠️ **它带 `date`**（服务端的今天）：这条是"今天的"接口，端侧拿它**做缓存失效**
 *    （跨天就不能再拿上次那张卡当"今日挑战"画出来）。
 *    ⚠️ 与**通用查询** `GET /api/articles` 的区别就在这里：那条与"今天"无关，所以没有 date。
 *    ⚠️ 但 `date` **不是**"这次挑战记哪一天"的依据 —— 归属由服务端在受理提交时决定
 *    （`POST /api/user/submissions`，见 `scheduleDate`）。
 *
 * 接口口径（用户 2026-09 定）：
 *   · **只收 0 个或 1 个 uid**，公开可读（`/api/articles/*` 本来就是公开前缀）；
 *   · **uid 可省略（匿名 / 未登录）**：**默认初级档**，在该档句子里**随机**挑一条、
 *     **参与人数多的更容易被抽中**，且**不写任何用户行** —— 首页对游客也要画得出那张卡；
 *   · 带 uid 时选句口径见 services/recommend.ts：以 uid 为单位、每 24 小时换一次，
 *     分配落在 users.today_article_id / today_assigned_at 上，窗口内**原样返回**；
 *   · 「我今天在这句上的战绩」是**另一件事**，拆到鉴权接口
 *     `GET /api/user/participation/{articleId}`（返回 ParticipationRecord，没参与过为 null）。
 *
 * ⚠️ 别再加回 `myLevel` / `level` / `levelBasis` / `myBest` / `myAttempts`：
 *    前三项是**工程备注**（用户明确不要），后两项已经在 participation 接口里。
 */
export interface TodayArticleResponse {
  /** 服务端认定的「今天」—— **只用于端侧按天缓存失效** */
  date: string
  /** 那一句（**纯句子数据**，见 ArticleCard 的头注释） */
  item: ArticleCard
}

/**
 * ⭐⭐ **一句的参与统计**（`GET /api/participations/stats?ids=a,b,c`，公开）。
 *
 * ⚠️⚠️ 用户 2026-09 定的结构（L1 解耦）：统计是 `participations` 的**聚合派生值**，
 *    **不挂在 article / ArticleCard / ArticleDetail 上** —— 那三个是"句子内容"
 *    （稳定、可缓存），而这三个数每次现算（有人提交就变）。
 *    挂在内容结构上会出现两种坏结果：缓存把人数冻住；以及"内容一删，统计跟着没"。
 *
 * ⚠️ 于是它与句子的**生命周期无关**：`articleId` 只是个 key，句子行不在了
 *    （下架 / 内容换版）这一条照样能查到 —— 参与记录自带 words/links 快照。
 *
 * ⚠️ 没人参与时 `topScore` / `lowestScore` 是 **null**（不是 0：0 会被读成"有人拿了 0 分"），
 *    且两者一定同时有值或同时为 null（服务端同一条 SQL 取出来的）。
 */
export interface ArticleStats {
  articleId: string
  /** 参与人数（按句子去重的用户数） */
  participantCount: number
  /** 全场最高分；无人参与为 null */
  topScore: number | null
  /** 全场最低分（同一人只算最好那次）；无人参与为 null */
  lowestScore: number | null
}

/** `GET /api/participations/stats?ids=…` 的响应（**按请求的 ids 零值补齐**） */
export interface ArticleStatsResponse {
  items: ArticleStats[]
}

/**
 * ⭐⭐ 这一句的**参与记录**（`GET /api/participations?articleId=…`，公开）。
 *
 * 用户 2026-09 定：竞技场那一条"大而全"的接口（`/api/arenas/{articleId}`）拆掉，
 * 句子数据、参与者/榜单、参与统计各自一条 —— 这个类型是"参与者"那一条的行。
 *
 * ⚠️⚠️ 它挂在**参与资源**下（`/api/participations`），**不要求句子还在**：
 *    参与数据是用户资产，不能因为内容被下架/换版就查不到。
 *
 * 参数口径（服务端实现见 services/article-participations.ts）：
 *   · `sort=time`（默认，按最新参与时间倒序）| `sort=score`（按最高分倒序 = 榜单）
 *   · `limit`（1..100，默认 20）、`offset`（默认 0）
 *
 * ⚠️ `rank` **与 sort 无关**：它永远是按最高分算的全局名次 ——
 *    按时间排的时候，"他是第几名"依然是有用的信息。
 * ⚠️ 没有 `isMe`：这一条是公开接口，认不出看的人是谁；
 *    端侧拿 `userId` 跟自己的 id 比即可（见 store 的 userInfo.id）。
 */
export interface ArticleParticipationRow {
  /** ⭐ 名次（按最高分全序算；同分按"谁先拿到"再按 uid，与榜单口径一致） */
  rank: number
  /**
   * ⭐⭐ **这一行参与记录的地址**（`participations.id`）—— 点这一行看 TA 的参与详情用它：
   *    `GET /api/participation/{participationId}`（见那个接口的说明）。
   */
  participationId: string
  /** ⭐ 用户 id（本库自增主键）—— 端侧拿它跟自己的 id 比，也是个人主页的地址 */
  userId: number
  nickname: string
  /** 头像 —— ⚠️ 云存储 fileID（cloud://…），端侧要先换址（见 lib/cloud-file.ts） */
  avatarUrl: string | null
  /** ⭐ 这个人在这一句上**出过分**几次 */
  attempts: number
  /** ⭐ 最高分 —— 排名的依据 */
  bestScore: number
  /** ⭐ 最新一次参与时间（ISO） */
  lastAt: string
}

/** `GET /api/articles/{id}/participations` 的响应 */
export interface ArticleParticipationsResponse {
  items: ArticleParticipationRow[]
  /** 该句参与者总数（分页判据：`offset + items.length < total` 就还有下一页） */
  total: number
}


/* ---------- 其他 ---------- */

/**
 * ⭐ **句库通用查询的信封**（`GET /api/articles`）—— **没有 `date`**。
 *
 * 参数口径：`tags` / `difficulty` 逗号分隔**任一命中**，`sort=date|participants`，
 * `limit` 默认 50（1..100）。
 *
 * ⚠️⚠️ 它**不带 date**：这条回答的是「句库里有哪些句子」，与"今天"无关。
 *    带 date 的是另外两条 **"今天的"** 接口：
 *    · `GET /api/articles/latest` → `LatestCardsResponse`（`{ date, items }`）
 *    · `GET /api/articles/today?uid=<id>` → `TodayArticleResponse`（`{ date, item }`）
 *    它们的 `date` 是服务端的今天，**只用于端侧按天做缓存失效**。
 *    ⚠️ 「这次挑战记哪一天」不靠这些 date —— 归属由服务端在受理提交时决定
 *    （`POST /api/user/submissions` 的 `scheduleDate`，缺省就是它的今天）。
 */
export interface ArticleListResponse {
  /** 命中的句子（正文读不到的已剔除；顺序由请求的 `sort` 决定） */
  items: ArticleCard[]
  /**
   * ⭐ **命中总数**（标签 / 难度筛完之后、分页之前）—— 无限滚动靠它判断"还有没有下一页"：
   *    `offset + items.length < total` 就还有。⚠️ 不含"正文读不到被剔除"的那些。
   */
  total: number
}

/**
 * ⭐ **一个标签 + 它被多少篇文章用着**（`GET /api/tags`）。
 * ⚠️ 数与列表接口**同一口径**：只算已上线且正文读得到的文章 ——
 *    否则会出现"标签上写 3 篇、点进去只看到 1 篇"。
 */
export interface TagCount {
  tag: string
  count: number
}

/**
 * ⭐ **全部标签**（`GET /api/tags`）—— tags 页要的那一份。
 * ⚠️ 排序由服务端定死：**文章数降序 → 标签升序**（少了第二键，同数量的标签顺序会漂）。
 * ⚠️ 搜索**不在服务端做**：标签总量是这个量级里的几十个，端侧本地过滤更快、也不用多一次往返。
 */
export interface TagsResponse {
  items: TagCount[]
}

/**
 * ⭐ **最新上线**（`GET /api/articles/latest`）—— 首页下半段那一段。
 *
 * ⚠️ 与通用查询（`ArticleListResponse`）的**唯一区别**：这里多一个 `date`
 *    （服务端的今天），端侧拿它判断"这份首屏缓存是不是今天的"（见 store 的
 *    `cachedLatestCards`）——跨天的列表不能拿来当今天的画。
 * ⚠️ 同理 `date` **不参与成绩归属**（归属由服务端在受理提交时决定）。
 */
export interface LatestCardsResponse {
  /** 服务端认定的「今天」—— **只用于端侧按天缓存失效** */
  date: string
  /** 按上线时间倒序的最新 N 句（正文读不到的已剔除） */
  items: ArticleCard[]
}

export interface TokenResponse {
  token: string
  /**
   * ⚠️⚠️ **登录 ≠ 注册**（2026-09 定）：还没加入句拼的人也能拿到 token，
   *    但那时 `user` 是 **null** —— 端侧据此画「加入」，不是当成登录失败。
   */
  user: { id: number; nickname: string | null } | null
}

export interface MyStats {
  isMember: boolean
  streak: StreakView
}

/**
 * ⭐ 「我是谁」—— 全局用户面板（头像 / 昵称 / 战绩）的**唯一数据源**。
 *
 * ⚠️ 它就是 GET /api/user/me 的返回体，客户端**不再自己拼**：
 *    头像和昵称将来可能来自微信授权，任意时刻都可能变；
 *    端侧再存一份自己拼的副本，就是第二份真相。
 *    这里的字段全部原样用服务端的。
 *
 * ⚠️ streak 也在这份响应里 —— 它和 schedules 响应里的那份是同一个视图，
 *    两条路都写进全局 store，谁后到谁生效（服务端是唯一真相）。
 */
/**
 * ⭐ **饼干的两个位置**（规格：prd §7.6）—— 累计获得 + 可用。
 *
 * ⚠️⚠️ 为什么是**两个数**而不是一个：一个数不能同时当"进度"和"钱包" ——
 *    花掉它时看起来像退步（损失厌恶）。「累计获得」才是那条只增的进步线。
 *    两个数**共用同一个 🍪 符号**（界面上是"累计 1,240 / 可用 320"）。
 */
export interface CookieView {
  /** 累计获得 —— 只增不减（= 流水里所有正数之和） */
  total: number
  /** 可用余额（可花；换能量会减少它） */
  balance: number
}

/**
 * ⭐ **这一把赚到的饼干** —— 结果页那一行（规格：prd §7.6）。
 *
 * ⚠️ 与 `CookieView` 分工不同：这个回答「**这一次**赚了多少」，
 *    那个回答「我一共多少」。把累计值摆到结果页会是 +1240 这种数。
 * ⚠️ `passLine` 是给端侧算「还差 X 分」用的：
 *    `差 = passLine + 1 − 本次得分`（`pointsToConquer()`）。
 *    **屏幕上永远不出现「0 🍪」** —— 没攻克时显示"还差 X 分"，那是邀请，不是判决。
 */
export interface CookieAwardView {
  /** 这一把赚到的饼干（**0 = 没攻克**） */
  earned: number
  /** 攻克线 = max(85, 我在这句的历史最好分) */
  passLine: number
  /** 难度基准（10/20/30/40）—— 明细里解释"为什么是这个数" */
  base: number
  /** 生效的名次系数（0.1–1.0） */
  rankFactor: number
}

/** ⭐ 性别 —— 只认这两个值；null = 未填 */
export type Gender = 'male' | 'female'

/**
 * ⭐ 保存资料的表单 —— POST /api/user/profile 的请求体。
 *
 * ⚠️ 三态语义：**键不存在 = 这次不改这一格；显式 null / 空串 = 清空；有值 = 设置**。
 *    头像特殊：avatarUrl 只在真的换了头像时才传，不传就保持库里那张
 *    （见 routes/user.ts 的说明）。
 */
export interface ProfileUpdate {
  nickname: string
  avatarUrl?: string
  gender?: Gender | null
  age?: number | null
  bio?: string | null
}

/** POST /api/user/profile 的返回 —— **落库后的真相**，客户端直接拿它更新全局 state */
export interface ProfileUpdateResponse {
  nickname: string | null
  avatarUrl: string | null
  gender: Gender | null
  age: number | null
  bio: string | null
}

export interface MeResponse {
  id: number
  nickname: string | null
  avatarUrl: string | null
  /** 性别：'male' | 'female'；null = 未填 */
  gender: Gender | null
  /** 年龄（岁，6–120）；null = 未填 */
  age: number | null
  /** 简介（≤200 字）；null = 未填 */
  bio: string | null
  /** 'active' / 'banned'；界面目前只区分「能不能用」 */
  status: string
  /**
   * ⭐ **能量点数**（替代旧的"每天 N 次挑战机会"）。
   * ⚠️ 每次挑战消耗 2 点、每日补足到 3 点；端侧只做展示，不自己算余额。
   */
  energy: number
  /** ⭐ 挑战过**几句**（去重句子数，全时段累计）—— 首页状态卡的「挑战场次」 */
  challengedCount: number
  /** ⭐ 一共挑战了**几回**（打分成功的提交数，全时段累计）—— 首页状态卡的「挑战回合」 */
  challengedRounds: number
  /** 攻克金句数：**拿到过分数**的去重句子数（只要参与并出分就算，只增不减） */
  conqueredCount: number
  /** ⭐ 饼干：累计获得 + 可用 */
  cookies: CookieView
  streak: StreakView
}

/**
 * ⭐⭐ 「个人主页」的数据 —— 按**用户 id** 取一份
 *    （GET /api/profile/:id，不需要登录）。
 *
 * ⚠️⚠️ 这一页对**所有人**都长一样，包括我自己：一份数据、一套渲染。
 *    链接就是这一页的地址，转发出去谁打开看到的都是同一个人的主页。
 *    所以这里给的是**这一页要画的全部字段**（含能量 / 解冻卡）——
 *    不再是「本人一套、访客一套」。
 *
 * ⚠️ 代价讲清楚：这一份是**公开数据**，加字段前先问一句
 *    「它值不值得给陌生人看」。openid / status / 榜单明细这些与主页无关的都不给。
 */
export interface UserProfileResponse {
  /** 用户 id —— 拼分享路径用：/pages/profile/profile?u=<id> */
  id: number
  nickname: string | null
  avatarUrl: string | null
  /** 连续朗读天数（服务端现算的视图，不是库里那一列） */
  streakDays: number
  /** 参与场次：拿到过分数的去重句子数 */
  conqueredCount: number
  /** 挑战回合：打分成功的提交数 */
  challengedRounds: number
  /** ⭐ 饼干：累计获得 + 可用 */
  cookies: CookieView
}

/**
 * ⭐ 「我的挑战」列表里的一条（GET /api/user/challenges）。
 *
 * ⚠️ 它**不是** SubmitResponse：列表只要够认出「这是哪一次」+ 一眼看到分数，
 *    把榜单、逐词明细也带上会让响应大好几倍，而列表根本不用。
 */
/**
 * ⭐ 列表里一条的**逐词结果** —— 只要够把那一行的句子重新上色。
 *
 * ⚠️ 刻意不是完整的 WordScore：起始/结束时间、坏音素都是点开详情才有用的东西，
 *    而列表是一次几十条地返回 —— 带上它们等于把整个详情包乘上条数。
 * ⚠️ score 是**原始分**（不四舍五入）：标绿的判据与结果屏共用同一个数，
 *    这里先舍一次，两边就会在 84.96 这种边界上一个绿一个灰。
 */
export interface ChallengeWordScore {
  /**
   * 引擎认定的那个词 —— **对齐要用它**（见 alignWordScores）。
   * ⚠️ 不能省：引擎词表可能比原文多一个插入词（把别的音读成了词），
   *    少了它就只剩「按下标硬套」这条路，而那会让颜色整体错位。
   */
  word: string
  score: number
  /** 引擎的读音判定；不是 'normal' 一律标红（与结果屏同一条口径） */
  dp: string
}

/**
 * ⭐ 分享出去的「一次挑战结果」—— GET /api/challenge/:sid（**不需要登录**）。
 *
 * ⚠️ 它是给别人看的：拿到链接的人可能没有账号、也没读过这句。
 *    所以这里只放**公开信息**：分数、分项、逐词、榜单、这条录音是否公开；
 *    录音地址只在 isPublic 时给（成绩永远进榜，公开与否只管**声音**）。
 */
/**
 * ⭐⭐ 「一次挑战」的公开数据 —— 按**提交 id** 取一份
 *    （GET /api/challenge/:sid，不需要登录）。
 *
 * ⚠️ 与 UserProfileResponse 是同一个模型：**一份数据人人（包括本人）都一样**，
 *    「谁在看」不改变服务端给什么 —— 只有出分了才有这一份。
 *      · 录音 —— **无条件返回**（链接即凭据；从挑战详情分享卡片进来的都能听）
 *      · owner.id —— 端侧拿它跟自己的 id 比，决定「是不是本人」（标题 / 开关 / 按钮）
 */
export interface ChallengeShareResponse {
  /** 这条挑战是谁读的；id 用于端侧判断 owner */
  owner: { id: number; nickname: string; avatarUrl: string | null }
  /** 与本人看到的 result 同构（同一处 describe() 产出）—— **只有 status='scored' 才有** */
  result: SubmitResponse
  /** 这段录音的可播地址 —— 出分了就返回，不看 isPublic；没有录音时为 null */
  audio: SubmissionAudioRef | null
  /** 提交时刻（ISO）—— 分享页只显示到分钟 */
  at: string
}

export interface ChallengeRecord {
  submissionId: string
  articleId: string
  /** 这次挑战归属哪一天（老数据可能为空） */
  scheduleDate: string | null
  /** 0–100，一位小数；没打完分时为空 */
  score: number | null
  isConquered: boolean
  /** scoring / scored / failed */
  status: string
  /** AI 的 4–8 字点评（有没有取决于当时配没配大模型） */
  aiComment: string | null
  /** 句子原文 —— 列表里靠它认出「这是哪一句」 */
  text: string
  /**
   * 逐词结果，下标与 text 切出来的词一一对应。
   * ⚠️ 老成绩没有这一列（或条数对不上）时是 null ——
   *    那时列表退回**不标色**的整句，而不是猜着上色。
   */
  wordScores: ChallengeWordScore[] | null
  /** ⭐ 这一句的视觉主题（bar 卡用它上色） */
  theme: ArticleTheme | null
  /** 时间（ISO 字符串），列表按它倒序 */
  at: string
}

/**
 * ⭐ 一段**用户录音**的可播地址 —— 与 AudioRef 同构，只是字段名叫 src 而不是 full。
 *
 * ⚠️ 两条通道各有一套，客户端那侧只有一处分支（lib/audio/standard.ts 已处理）：
 *      · 'cloud' —— 云存储 fileID，客户端用 wx.cloud.getTempFileURL 换地址。
 *        云开发通道**不需要配 downloadFile 合法域名**，真机正式版才播得响。
 *      · 'http'  —— 服务端路径（本机联调，客户端自己拼 BASE_URL）。
 * ⚠️ 地址从**开放接口**发出来（GET /api/challenge/:sid 与 /:sid/audio）：
 *    音频可见性由**入口**决定，不再分「本人接口 / 公开接口」两条路。
 *    分享卡片（群聊 / 个人聊天 / 通知）的链接本身就是凭据（sid 是 SUBMISSION_ID_LENGTH 位 hash）。
 */
export interface SubmissionAudioRef {
  kind: 'cloud' | 'http'
  src: string
}

/** GET /api/challenge/:sid/audio —— 拿一段录音的可播地址（audio 为 null = 音频不在了） */
export interface SubmissionAudioResponse {
  audio: SubmissionAudioRef | null
}

/**
 * ⭐ 「参与场次」里的一条 —— **一句 = 一个竞技场 = 一场**。
 *
 * ⚠️ 一条记录对应「我对这一句的全部战绩」，不是一次提交：
 *    同一句读十次，这里仍然只是一条（次数在 attempts 里）。
 */
export interface ParticipationRecord {
  /**
   * ⭐ **这一行的地址** = `sha256(userId + ':' + articleId)` 前 24 位十六进制（见 db/schema.ts）。
   * ⚠️ 它是**派生值**，所以整表重建后不变 —— 分享出去的链接不会指到别人身上。
   */
  id: string
  articleId: string
  /**
   * ⭐⭐ **这一句累计赚到的饼干**（与 `users.cookies` 同一套口径）。
   *
   * ⚠️ 它是这条参与下**已出分** submissions 的 `cookies_earned` 之和（口径与 `attempts` 一致）。
   * ⚠️ 公开接口也带着它：饼干本来就是公开数据（个人主页就展示）。
   */
  cookies: number
  /**
   * ⭐⭐ **词表快照**（与 `ArticleDetail.words` 同形：原词含标点 + 音标 / 重音 / 音节 / 释义 / 技巧）。
   *
   * ⚠️⚠️ 它**同时就是原文**：`words[].text` 含标点，用空格拼起来就是那句话 ——
   *    所以这里**没有 `text` 字段**（2026-09 改）：原文是派生值，
   *    端侧要显示句子就 `words.map(w => w.text).join(' ')`。
   *    服务端也不再存 `text` 列（同一件事两份数据，还闹出过"空数组 ⇒ 词数显示 0"的 bug）。
   * ⚠️ 这是**当时那一份**的快照：句子改过 / 下线，历史卡片照样自足。
   */
  words: ArticleWordItem[]
  /** ⭐ **连读标注快照**：`links[i]` 描述 `words[i]` 与 `words[i+1]` 之间；空串 = 不连。 */
  links: string[]
  /** 我在这一句上挑战了几次（只数拿到分的） */
  attempts: number
  /** 最高分 / 最低分（都是拿到分的那些提交） */
  bestScore: number
  worstScore: number
  /** 我在这一句上的名次与参与人数（按最高分排） */
  rank: number
  participantCount: number
  /** 最近一次挑战的时间（ISO）—— 列表按它倒序 */
  lastAt: string
  /**
   * ⭐ **兜底原文** —— **只在词表快照为空时才有这个字段**（内容缺口）。
   *
   * ⚠️⚠️ 正常行**没有它**：句子由端侧从 `words` 拼
   *    （`words.map(w => w.text).join(' ')`），服务端**不再存 text 列**。
   *    但确实有内容的 `articles.words` 是空数组 —— 那种行端侧拼不出任何字，
   *    于是读取时现取一次 `articles.text` 带上（**不落库**）。
   * ⚠️ 端侧判据：`text ?? words.map(...).join(' ')`。
   */
  text?: string
  /** ⭐ 视觉主题（保留字段，本页暂不消费） */
  theme: ArticleTheme | null
}

export interface ParticipationsResponse {
  items: ParticipationRecord[]
}

export interface ChallengesResponse {
  items: ChallengeRecord[]
}
/**
 * ⭐ 提交被拒的**业务分支**（429，但不是"错误"，是规则）。
 *
 * ⚠️ 它和真正的失败要分开说：客户端要给出**可行动**的提示
 *    （「今天的次数用完了，明天再来」），而不是一句「请求失败」。
 */
export interface QuotaExhaustedError {
  code: 'QUOTA_EXHAUSTED'
  /** free = 免费用户今天那 1 次用完了（付费可以继续）；cap = 付费用户今天也满了 */
  reason: 'free' | 'cap'
  /** 今天已经挑战了几次 */
  usedToday: number
  /** 今天的上限（免费 1 / 付费 50） */
  dailyLimit: number
}

/** 已经下线的错误码，留个说明免得看到旧代码发懵 */
// export interface TooFrequentError { code: 'TOO_FREQUENT'; retryAfterSec: number }
// export interface CooldownError { code: 'COOLDOWN'; nextFreeAt: string }
