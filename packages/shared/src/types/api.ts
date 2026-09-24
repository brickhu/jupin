import type { ScoreParts } from '../scoring'
import type { ArticleLevel, ArticleTheme, ArticleWord, AudioRef } from './content'

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
  nickname: string
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
   * ⭐ 手上还有几张**解冻卡**（未过期、未使用）。
   * ⚠️ **现算**，不是 users 上的计数器 —— 卡有有效期，整数表达不了。
   */
  unfreezeCards: number
  /** ⭐ 待领取几张（发了但用户还没去「连战记录」页点领取） */
  unfreezePending: number
  /** 手上最早到期那张的到期日 'YYYY-MM-DD'；没有就是 null */
  unfreezeExpiresOn: string | null
}

/**
 * ⭐ 「连战记录」—— 一个月里哪天读了、哪天的缺口是解冻卡补的。
 *
 * ⚠️ 日历排版要的三个数（首日/天数/首日是周几）**全由服务端给**：
 *    端侧拿 'YYYY-MM-01' 去 new Date() 会按 UTC 解析，星期几有可能差一天，
 *    而那种错在界面上只表现为"整个月的格子整体错位"，很难看出来。
 */
export interface StreakRecordDay {
  date: string
  /** read = 那天读了；unfreeze = 那天的缺口是用解冻卡补上的 */
  kind: 'read' | 'unfreeze'
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
  unfreezeCards: number
  unfreezePending: number
  unfreezeExpiresOn: string | null
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
 * ⭐ 成长榜的一行。
 *
 * ⚠️ 与 LeaderboardRow **故意分开**：那个的 score 是朗读分（要统一显示一位小数，
 *    见 formatScore），而成长值是**整数** —— 套 formatScore 会显示成 12.0。
 * ⚠️ 昵称口径与竞技场榜单一致：没起过名字是「挑战者」，自己显示「你」。
 */
export interface GrowthRankRow {
  rank: number
  nickname: string
  /** 成长值（整数，累加值） */
  value: number
  isMe: boolean
}

/** 首页那三块成长榜（自我超越 / 坚持不懈 / 人中翘楚，各 TOP10） */
export interface GrowthRankResponse {
  self: GrowthRankRow[]
  diligence: GrowthRankRow[]
  standout: GrowthRankRow[]
}

/** 一次提交给 streak 带来的具体变化 —— 结果页要逐条讲清楚 */
export interface StreakDelta {
  streakDays: number
  streakBest: number
  /** 这次读有没有被计入（false = 今天已经读过） */
  counted: boolean
  /** streak 变化量 */
  delta: number
  /** 读完之后手上还有几张解冻卡（含本次新发的） */
  unfreezeCards: number
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
 *    ⚠️ 唯一按日期算的是连续天数（streak），它在 SchedulesResponse 里单列。
 */
/**
 * ⭐ 卡片上的标准音。
 *
 * ⚠️ full / kind 的含义由 kind 决定（同 content.ts 的 AudioRef）：
 *    · cloud → 云存储 fileID，要用 wx.cloud.getTempFileURL 换地址
 *    · http  → 服务端路径，加 BASE_URL 前缀直接用
 * ⚠️ durationMs 可能是 null（算不出来）—— 那时端侧只显示按钮、不显示时长。
 */
export interface ScheduleAudio extends AudioRef {
  durationMs: number | null
}

/**
 * ⭐ 句库**列表**里的一条（瘦）—— GET /api/articles。
 *
 * ⚠️ 刻意**不含词级数据**（音标 / 释义 / 逐词音频）：那是详情页的事
 *    （GET /api/articles/:id）。要塞进列表，首屏就得为全站句子付一遍这个代价。
 */
export interface ArticleListItem {
  id: string
  text: string
  translation: string
  /** ⭐ 朗读难度（三个判据按权重合成的一个档位，见 shared/level.ts） */
  difficulty: ArticleLevel | null
  tags: string[]
  /** 标准音（可播引用 + 时长）；这一句没有标准音时是 null ⇒ 端侧不画播放入口 */
  audio: ScheduleAudio | null
  /** ⭐ 视觉主题（背景/前景/配图）；老内容为 null ⇒ 端侧按 id 复算（见 shared/theme.ts） */
  theme: ArticleTheme | null
}

/**
 * ⭐ 详情里那一段标准音 —— 比卡片上的 ScheduleAudio 多一份**逐词音频地址**。
 *
 * ⚠️ words 的下标与 `plainWordsOf(text)` 一一对应（同一个切词实现，见 shared/tokenize.ts）；
 *    点第 i 个词就播 words[i]。
 * ⚠️ 这个形状**只有详情接口**用：列表/卡片只给整句地址（多给的每个词都要付一遍
 *    对象存储地址的代价）。
 */
export interface ArticleDetailAudio extends AudioRef {
  /**
   * 逐词音频地址；**下标与 plainWordsOf(text) 一一对应**。
   *
   * ⚠️ 元素可能是 **null** —— 服务端拼不出这个 fileID 时（环境缺
   *    WX_CLOUD_ENV_ID / COS_BUCKET，见 standard-audio.ts 的 fileIdOf）就是 null。
   *    **不能把 null 挤掉**：一挤下标就整体错位，客户端点第 i 个词会播到第 i+1 个的音。
   *    ⇒ 客户端遇到 null 应当**跳过播放**（那个词没有音频），而不是播一个空地址。
   */
  words: (string | null)[]
}

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
 *    与 ArticleListItem.audio / SubmissionAudioResponse.audio 同一个约定。
 * ⚠️ 难度与 reason 用 `| null`：正文里没写（老 JSON）就是 null，**不补默认值**。
 */
export interface ArticleDetail {
  id: string
  text: string
  translation: string
  words: ArticleWord[]
  /** ⭐ 发音难度（中文母语者读出来有多难念） */
  difficulty: ArticleLevel | null
  /** ⭐ 词汇难度（小学 / 高中 / 六级 / GRE 那套口径，含句式复杂度） */
  /**
   * ⭐ **给用户看的一句话** —— 以「相当于<级别>水平」开头，说清这句难在哪
   *    （完整格式与写法要求见 ArticleContent.reason）。
   */
  reason: string | null
  tags: string[]
  audio: ArticleDetailAudio | null
  theme: ArticleTheme | null
}

/**
 * ⭐ 「我在这句上的战绩」—— GET /api/user/arena-records（**鉴权接口**）。
 *
 * ⚠️⚠️ 公开接口（句子列表 / 竞技场）**不含任何「我的」字段**；
 *    端侧把这一份按 articleId 融进公开列表 —— 卡片描边、「已参与 N 次 · 最高 X 分」、
 *    按钮文案、竞技场里的「我的战绩」都从它来。这样公开响应人人一样（可缓存），
 *    而「我的」永远只有一个来源。
 *
 * ⚠️ rank / beatenCount 只在请求时带 `ranks=1` 才有：名次是**跨用户**算出来的
 *    （公开榜单只给前 20，客户端自己算不出第 500 名），所以只在该算的那一屏算。
 */
export interface ArenaRecord {
  articleId: string
  /** 我的最好成绩；没参与过为 null */
  bestScore: number | null
  /** 我在这句打过几次分（只数打分成功的，与「参与人数」同口径） */
  attempts: number
  /** 我的名次；没参与过、或没要 ranks 时为 null */
  rank: number | null
  /** 我击败了多少人；同上为 null */
  beatenCount: number | null
}

/** GET /api/user/arena-records 的响应 */
export interface ArenaRecordsResponse {
  items: ArenaRecord[]
}

/**
 * ⭐ 首页/列表上的一张竞技场卡片。
 *
 * ⚠️⚠️ `date` / `isScheduled` / `isToday` **只有今日那一张有** ——
 *    因为「日期只是一个编辑精选的容器，和竞技场无关」（db/schema.ts）。
 *    历史卡片来自**句库**：它回答的是「还有哪些竞技场」，不是「过去哪几天」，
 *    所以那三个字段对整个历史列表都没有意义。
 *    ⇒ 点进竞技场一律按 **articleId** 寻址（/api/arenas/:articleId），不再用日期。
 */
export interface ScheduleEntry {
  /**
   * 这一条**排给哪一天** 'YYYY-MM-DD'（北京时间）。
   * ⚠️ 只有今日那一张有（历史卡片来自句库，与日期无关）。
   * ⚠️ 它**不是**竞技场的地址 —— 那个是 articleId。
   */
  date?: string
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
  audio: ScheduleAudio | null
  /**
   * 这条句子是不是**运营专门排给那一天**的（false = 从池子按天轮转来的）。
   * ⚠️ 只有今日那一张有。
   */
  isScheduled?: boolean
  /** ⚠️ 只有今日那一张有（历史卡片与「今天」无关） */
  isToday?: boolean
  /** 参与人数（按句子去重的用户数） */
  participantCount: number
  /** 最高分；无人参与为 null */
  topScore: number | null
  /** ⭐ 视觉主题（背景/前景/配图）；老内容为 null ⇒ 端侧用品牌色兜底 */
  theme: ArticleTheme | null
}

/**
 * 单个挑战的详情 —— 从首页卡片点进来。
 *
 * ⚠️ 与 ScheduleEntry 的分工：卡片是「一眼扫过去」，详情是「看进去」。
 *    所以这里多出**完整榜单**与**我的名次**（列表里 7 天各算一次名次太贵）。
 */
export interface ScheduleDetail {
  date: string
  articleId: string
  /**
   * ⭐ 从这里发起的挑战该**记到哪一天**。
   * ⚠️ 按日期寻址时就是那个日期（历史挑战的「再次挑战」必须归到那一天，
   *    否则昨天那张卡片的数字会变）；按句子寻址时是**今天**（见 ArenaDetail）。
   */
  submissionDate: string
  text: string
  translation: string
  /** ⭐ 朗读难度（三个判据按权重合成的一个档位，见 shared/level.ts） */
  difficulty: ArticleLevel | null
  /** ⭐ 标签（服务端已规范化；空数组 = 这一句没有标签） */
  tags: string[]
  isScheduled: boolean
  isToday: boolean
  participantCount: number
  topScore: number | null
  /** ⭐ 视觉主题（背景/前景/配图） */
  theme: ArticleTheme | null
  /** 完整榜单（从头往下数，最多 20 条） */
  leaderboard: LeaderboardRow[]
}

/**
 * ⭐⭐ 竞技场详情 —— **按句子**寻址（`/api/arenas/:articleId`）。
 *
 * ⚠️⚠️ 这才是竞技场的正经地址。db/schema.ts 里写着：排期「不是竞技单位，
 *    只是一个按日组织的展示层」，**日期只是编辑精选的容器，和竞技场无关** ——
 *    排名 / 参与人数 / 最高分 / 我的最好成绩，全部按 article_id 查。
 *
 * ⚠️ 与 ScheduleDetail 的差别只有「日期」那一块：
 *    按句子进来的挑战**算今天**（submissionDate = 服务端的今天），
 *    页面也据此显示「今天读一句，连战就接上了」。
 *    而按日期进来的是「回到那一天再挑战一次」，submissionDate 就是那一天。
 */
export interface ArenaDetail {
  articleId: string
  text: string
  translation: string
  /** ⭐ 朗读难度（三个判据按权重合成的一个档位，见 shared/level.ts） */
  difficulty: ArticleLevel | null
  /** ⭐ 标签（服务端已规范化；空数组 = 这一句没有标签） */
  tags: string[]
  /** ⭐ 这次挑战该记到哪一天 —— 按句子寻址时是服务端的**今天** */
  submissionDate: string
  /** submissionDate 是不是今天（页面据此显示连战提示） */
  isToday: boolean
  participantCount: number
  topScore: number | null
  /** ⭐ 视觉主题（背景/前景/配图） */
  theme: ArticleTheme | null
  /** 完整榜单（从头往下数，最多 20 条） */
  leaderboard: LeaderboardRow[]
}

export interface SchedulesResponse {
  /** 服务端认定的「今天」 */
  date: string
  today: ScheduleEntry
  /**
   * ⭐ 历史挑战：**句库**里的其他竞技场，新句在前。
   *
   * ⚠️ 它与 today 是**两个不同的来源**（不是同一个列表切两半）：
   *    · today   —— 今天的**排期**那一条
   *    · history —— **articles 表**（句库）：竞技数据的单位永远是句子，
   *                  排期只是「哪一天展示哪一句」的展示层（见 db/schema.ts）
   * ⚠️ 不会和 today 那句重复（池子小的时候隔几天就会轮回到同一句）。
   * ⚠️ 端侧**不再需要**这个日期：点进去走按句子寻址的 /api/arenas/:articleId。
   *    规则与单测见 services/schedule-shape.ts。
   */
  history: ScheduleEntry[]
}

/* ---------- 其他 ---------- */

export interface TokenResponse {
  token: string
  user: { id: number; nickname: string | null }
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
 * ⭐ 三个成长值 —— **分开给，不合成总分**。
 *
 * ⚠️ 三个数各自回答一个问题，相加之后没人解释得清那个数是怎么来的：
 *    · self      自我超越（跟自己的历史比）
 *    · diligence 坚持不懈（坚持的里程碑）
 *    · standout  人中翘楚（跟榜单比）
 */
export interface GrowthView {
  self: number
  diligence: number
  standout: number
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
  /** ⭐ 三个成长值（分开展示） */
  growth: GrowthView
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
  growth: GrowthView
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
  articleId: string
  /** 句子原文 —— 列表里靠它认出是哪一句 */
  text: string
  /** 这句有多少个词（句子本身的长度，不是我能控制的） */
  words: number
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
  /**
   * ⭐ **最近这次挑战属于哪一天**（YYYY-MM-DD）—— 点卡片跳**竞技场**要用它。
   * ⚠️ 竞技场是按「哪一天」取场次的（pages/arena 的 onLoad），
   *    所以这里给的必须是**你参与的那一场**的日期，而不是端侧的今天。
   * ⚠️ 老数据可能没有（schedule_date 为空）→ 空串，端侧那时不给跳。
   */
  lastScheduleDate: string
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
