# 句拼 · 数据库与架构（SPEC）

> 产品设计见 [prd.md](prd.md)。

---

## 一、技术原则

### 原则 1：云端只买「一个分数」

```ts
score(audio: Buffer, refText: string) → { total: number }
```

**音高、流利度、进度、预检、回放、上色、对比——全部端侧自建。**
云端返回的词级/句级数据是**可选副产品**：有则用于精修，无则端侧兜底。

**推论**：换引擎成本 ≈ 0；将来端侧模型可用时，直接替换 `score()` 实现。

### 原则 2：高频动作边际成本为 0

只有「提交检测」调用云端。录音/重录纯本地。

### 原则 3：内容以静态资源分发，不经后端 API

内容（短文/竞技场/标准音/词级数据）→ CDN，小程序端直拉。

---

## 二、平台决策：微信小程序

### 依据

| 因素 | 判断 |
|---|---|
| ⭐ **竞技场需要人口密度** | 人口密度需要传播效率。小程序"点开就玩"，App 要下载 → **漏斗差一个数量级** |
| **端侧必需能力** | 小程序全都能实现（见下），只有两项是工程量问题 |
| **端侧模型** | 唯一的 App 独有优势，但本来就是 P2 |
| **支付** | 小程序内支付现成 |

### 端侧能力可行性

| 能力 | 小程序 | 说明 |
|---|---|---|
| 录音（PCM 16k） | ✅ | `getRecorderManager` + `onFrameRecorded` 给实时帧 |
| 本地预检（VAD/能量/时长） | ✅ | 纯 JS 信号处理 |
| ASR 可识别性 | ✅ | 微信同声传译插件（免费） |
| 实时进度 | ✅ | 插件 `onRecognize` |
| 音高曲线 | ⚠️ ✅ | **需手写 FFT/自相关**（无 `AnalyserNode`） |
| 语速 / 停顿 | ✅ | 纯算法 |
| 点词回放 / A/B | ⚠️ ✅ | 标准音用预切文件；用户音用 `seek` |
| 逐词上色 | ✅ | 端侧 DTW 对比标准音 |
| 端侧音素模型 | ❌ | `createInferenceSession` 为 Beta + 算子受限（**P2 才需要**） |

### 风险隔离

对微信能力的依赖只有两处，且都有兜底：

| 依赖 | 兜底 |
|---|---|
| 同声传译插件 | 退回纯本地时长/能量判定；实时进度退回本地 VAD |
| 支付 | 小程序虚拟支付 |

### ⭐ 转 App 的触发条件

| 条件 | 说明 |
|---|---|
| 数据显示流失主因是"反馈不够精确/实时" | 而非"不知道这个产品" |
| 端侧音素级诊断成为核心差异化 | 竞品都在做而小程序做不了 |
| 已有足够用户量支撑下载转化 | 例如 DAU 过万 + 自然搜索流量 |

**因为架构是"云端只要分数"，转 App 的成本主要在 UI 重写，不在能力重建——这个决定可逆。**

---

## 三、系统架构总览

```
┌─ 小程序端（产品本体）───────────────────────────────┐
│  内容层  短文/竞技场/标准音/词级数据 ← CDN 静态资源     │
│  音频层  Worker：FFT·音高·VAD·DTW                   │
│  交互层  录音/重录 · 预检 · 上色 · 回放 · A/B         │
└──────────────────┬────────────────────────────────┘
                   │ ① 提交 (audio + arenaId)
                   │ ② 榜单查询
┌──────────────────▼────────────────────────────────┐
│  Node 服务（微信云托管）                             │
│  · 鉴权(openid) · 冷却 · 榜单 · 征服 · 支付回调       │
│  · ScoreEngine 薄适配层                            │
└──────┬──────────────────────┬─────────────────────┘
       │                      │
┌──────▼──────┐      ┌────────▼────────┐
│ 讯飞 ISE     │      │ MySQL 8         │
│ (只买分数)   │      │ 成绩/用户/榜单    │
└─────────────┘      └─────────────────┘

内容生产流水线（离线，独立）→ COS/CDN
```

---

## 四、端侧架构

### 选型

| 项 | 选择 | 理由 |
|---|---|---|
| **框架** | **原生小程序 + TypeScript** | 核心是音频处理 + 高频动画，跨端框架恰在这两处最易出坑；且不做多端 |
| **音频采集** | `getRecorderManager` + `format:'PCM'` + `frameSize` + `onFrameRecorded` | 直出 16k/16bit/单声道，零转码 |
| **音频分析** | ⭐ **`wx.createWorker` 独立线程** | FFT/DTW 占用主线程会导致动画掉帧 |
| **状态** | 极简自研 store 或 `mobx-miniprogram` | 状态很少，不引入重框架 |
| **图表** | canvas 2d 手绘 | 能力边界图只是柱状图，ECharts 过重（主包 2MB） |
| **分包** | 主包只放首页 + 朗读页 | 主包限制 2MB |

### 录音 + 分析流水线（Worker 内）

```
onFrameRecorded (每 40ms, 1280B = 640 采样 @16k)
        │
        ├─→ 能量 / VAD   → 有效语音时长、停顿位置  → 预检 ①② · 流利度
        ├─→ 自相关(YIN)  → 基频 → 音高曲线         → 语调反馈
        └─→ 累积 PCM     → 完整音频（提交用）

主线程只收分析结果，不碰原始音频
```

**性能**：640 点自相关每 40ms 一次，JS 约 0.1–0.5ms，Worker 无压力。

### 本地预检的分工

| 层 | 判据 | 位置 |
|---|---|---|
| ① 技术有效性 | 时长 ≥ 2s、有语音活动、能量正常 | Worker |
| ② 长度合理性 | 有效语音时长 < 150wpm 预期的 50% | Worker |
| ③ 可识别性 | ASR 识别词数 ≈ 0 | 主线程（插件）；不可用时退回 ①② |

---

## 五、内容分发

### 静态资源结构

```
/cdn/
  topics.json                     # 主题集
  articles/{id}.json              # 正文：句子原文 + 词级数据  → articles.content_json
  articles/{id}.tips.json         # 朗读技巧                 → articles.tips_json
  audio/standard/{id}.mp3         # 标准发音                 → articles.standard_audio
  audio/word/{id}/{pos}.mp3       # ⭐ 单词音频（预切）
```

### 为什么走 CDN 而不是后端 API

| | 后端 API | CDN 静态资源 |
|---|---|---|
| 后端负载 | 每次读内容都查库 | **零** |
| 分发成本 | 数据库 + 服务器 | **CDN，几乎免费** |
| 响应速度 | 取决于后端 | **边缘节点** |
| 离线能力 | ❌ | ✅ **可缓存到本地** |

### ⭐ 单词音频预切

在**生产阶段**就把每个词的音频切好，而不是运行时用 `seek()` 动态切。

**理由**：点词回放和 A/B 对比是核心体验，精度重要，而 `InnerAudioContext.seek()` 精度不够可靠。预切后播放就是普通音频文件，简单且精确。

---

## 六、后端

| 层 | 选择 | 理由 |
|---|---|---|
| **运行时** | **微信云托管**（Node 容器） | 支持 WebSocket、免域名备案、免运维 |
| **框架** | **Hono** | 轻、快、TS 友好 |
| **数据库** | ⭐ **MySQL 8**（云托管内置） | 部署目标只提供 MySQL；本模型不用任何 PG 特有特性 |
| **ORM** | **Drizzle**（`drizzle-orm/mysql2`） | 方言可换，schema 即类型 |
| **对象存储** | 微信云开发存储 / 腾讯云 COS | 标准音与内容 JSON |
| **缓存** | **MVP 不需要 Redis** | 单竞技场榜单查询走一条复合索引，毫秒级 |

### 为什么是 MySQL 而不是 PostgreSQL

**原设计选的是 PostgreSQL，后来推翻了。** 决定因素不是技术偏好，是**部署目标**：

- 微信云托管**只提供 MySQL 5.7/8.0**，没有 PG；
- 官方明确「不支持用来部署数据库/Redis 等有状态服务」——也不能自己塞一个 PG 容器（容器无持久化存储）；
- 变通路径只有「腾讯云 TDSQL-C PostgreSQL + 服务配 VPC 打通」，要多一份账单、多一套运维、跨 VPC 连接。

而我们这个数据模型**不用任何 PG 特有特性**：无 jsonb、无数组、无 CTE、无窗口函数。
既然如此，用它换「同环境 VPC 内网库 + 免运维 + 一张账单」是明显划算的。

> ⚠️ 唯一损失：MySQL 没有 `INSERT ... RETURNING`。受影响的只有两处，
> 已分别用 `INSERT IGNORE` + 回查、以及 `ON DUPLICATE KEY UPDATE` 解决
> （见 `services/user.ts` 与 `routes/submissions.ts` 的注释）。

### 榜单查询

⚠️ 没有物化榜单表，全部从 `submissions` 现算。核心是一个「每人最高分」派生表：

```sql
-- 每人在该文章的最高分（所有榜单查询的基础）
SELECT user_id, MAX(score) AS best, MIN(created_at) AS first_at
FROM submissions
WHERE article_id = ? AND status = 'scored'
GROUP BY user_id

-- 我的排名 = 比我高的 + 同分但先到的 + 1
SELECT
  COUNT(CASE WHEN best > ? THEN 1
             WHEN best = ? AND first_at < ? THEN 1 END) AS better,
  COUNT(*) AS total
FROM (上面的派生表);
```

**排序规则**：分数降序，同分按**最早提交时间升序**（先到者优先）——这样「刚刚超过你」的语义才准确。

> ⚠️ 严格说「先到」应是「**先达到该分数**」，但那是 correlated 子查询；
> 这里用「最早提交时间」近似，对榜单语义影响可忽略。已记在 `services/leaderboard.ts` 的注释里。

### ⚠️ 时间列一律用 DATETIME，不用 TIMESTAMP

MySQL 的 `TIMESTAMP` 只到 **2038 年**；而 Drizzle 的 `datetime` 没有 `defaultNow()`，
所以默认值写成显式 SQL：`.default(sql\`CURRENT_TIMESTAMP(3)\`)`。
另外 `DATETIME` **不存时区**——全链路按 UTC 读写（连接池 `timezone: 'Z'` + 容器 `TZ=UTC`），
否则「上次挑战是在什么时候」会整体偏移（它决定要不要被 2 分钟间隔拦住）。

**榜心而非全榜**：揭晓页只返回"附近 5 条 + 人数 + 我的排名"，一次查询、数据量极小。

---

## 七、引擎接入层

```ts
interface ScoreEngine {
  score(audio: Buffer, refText: string): Promise<ScoreResult>
}

interface ScoreResult {
  total: number               // ⭐ 唯一必需：0–100
  words?: WordScore[]         // 可选：有则用于精修，无则端侧兜底
  sentences?: SentenceScore[] // 可选
}
```

**第一版实现 `XfyunEngine`。**

### 引擎选型结论

| 引擎 | 结论 |
|---|---|
| **科大讯飞 ISE** | ⭐ **选它**：最便宜（¥0.00387/次）+ 10 万次免费 + 已踩完坑 |
| 腾讯云 SOE | ❌ 不选：其增值能力（实时/音素/IPA/SDK 工程）**我们要么端侧自建、要么不需要**；且按文本长度计费、免费额度少 10 倍 |
| 驰声 Chivox | 备选：唯一明确支持实时流式 + 音素级，但贵 5–7 倍（¥0.027/次） |

> **注意**：上一轮曾把腾讯云 SDK 的"静音检测/分片/重试"当作选型优势——**这是错的**，那些是本该端侧自建的工程实现，不构成引擎能力差异。

---

## 八、数据模型

### 数据库表

**命名原则**：**「竞技场」是抽象概念，不落到表名上。** 朗读单元就叫 `articles`，提交记录就叫 `submissions`。

```sql
-- 用户
users
  id, openid(UNIQUE), unionid, nickname, avatar_url
  status                      -- normal | banned | deleted
  member_until                -- ⭐ 冗余会员到期（热判断，不值得每次 join subscriptions）
  invalid_count, invalid_date -- 无效提交计数（防刷）

-- ⚠️ 这里原来有一列 next_free_at（24h 滚动冷却）。冷却已下线，改成
--    「每句额度（免费 1 / 付费 20）+ 固定间隔 2 分钟」——
--    额度**从 submissions 现算**，不存副本：存了就是第二份真相，必然漂移。见迁移 0012。
  created_at

-- 朗读单元索引（文章 = 句子）。⚠️ 正文/技巧/标准音都是静态资源引用，不入库
articles
  id                          -- 由内容流水线分配
  content_json                -- 正文静态 JSON 地址（句子原文 + 词级数据）
  tips_json                   -- 朗读技巧 JSON 地址
  standard_audio              -- 标准发音 MP3 地址
  difficulty                  -- 难度 1–5      INDEX
  category                    -- 分类          INDEX
  content_status              -- draft | published | archived
  content_hash                -- 内容指纹，流水线重跑时判断要不要重新发布
  is_active                   -- 竞技开关（与 content_status 是两回事）
  participant_count           -- 冗余计数，可排序
  conquered_count             -- 征服人数（≥85）
  created_at, updated_at

article_tags                  -- 独立成表才能按单个标签索引
  article_id, tag             UNIQUE(article_id, tag)  INDEX(tag)

-- 提交记录：**每次提交一条，永久保留**
submissions
  id                          -- ⭐ hash(userId, articleId, seq)，服务端算
  user_id, article_id, seq    -- seq = 该用户在该文章的第几次提交
  status                      -- scored | failed
  score, is_conquered
  audio_key                   -- audio/{articleId}/{userId}/{ts}.pcm（永久保留）
  audio_bytes, audio_duration_ms
  like_count                  -- 冗余计数，可排序
  word_scores                 -- 词级分数 JSON（讯飞的副产品）
  engine, fail_reason
  created_at, scored_at
  UNIQUE(user_id, article_id, seq)   -- 序列号唯一，并发撞号兜底
  UNIQUE(user_id, audio_key)         -- ⭐ 幂等 + 防刷：一次录音只算一次提交
  INDEX(user_id, created_at)

-- 订阅
subscriptions
  id, user_id, plan, status, source, payment_id, start_at, end_at, created_at

-- 支付（财务凭证，独立于订阅）
payments
  id, user_id, out_trade_no(UNIQUE), plan, amount(分), status
  prepay_id, transaction_id(UNIQUE)   -- 微信支付：预支付会话 + 微信订单号
  paid_at
  refund_no, refund_amount, refunded_at   -- 退款是独立的单
  raw_notify                          -- ⭐ 回调原文，对账出问题时的唯一救命稻草
  created_at

-- 点赞
likes
  id, submission_id, user_id, created_at   UNIQUE(submission_id, user_id)

-- LLM 反馈（⚠️ 与讯飞的「分」是两回事）
reviews
  id, submission_id
  content                     -- 可空：pending 时还没有正文
  model
  status                      -- pending | done | failed
  attempts, error
  created_at, updated_at      INDEX(status, created_at)  -- 异步 worker 捞待处理
```

### ⚠️ 榜单是**派生**的，没有物化表

`arena_entries` 已删除。榜单从 `submissions` 现算：

```sql
-- 每个用户在该文章的最高分
SELECT user_id, MAX(score) AS best, MIN(created_at) AS first_at
FROM submissions WHERE article_id = ? AND status = 'scored'
GROUP BY user_id
```

好处是**不可能漂移**；代价是榜单要聚合。文章上的 `participant_count` / `conquered_count` 是冗余计数，
由提交时维护（首次提交 +1、首次征服 +1），用于列表页排序。

### CDN 侧 JSON

```jsonc
// articles.contentJson 指向的正文 JSON
{
  "id": 123,
  "text": "The only way to do great work is to love what you do.",  // ⭐ 评分参考文本
  "translation": "做好工作的唯一方法就是热爱你所做的事。",
  "difficulty": 1,
  "words": [
    {
      "pos": 0, "word": "The", "ipa": "ðə", "posTag": "art.", "meaningZh": "这（定冠词）",
      "startMs": 0, "endMs": 180, "audioUrl": "/audio/word/123/0.mp3"
    }
  ]
}
```

```jsonc
// articles.tipsJson 指向的技巧 JSON
{
  "tips": [
    {
      "type": "weak_form",
      "wordStart": 0, "wordEnd": 0,
      "noteZh": "the 要弱读成 /ðə/，不要读成 /ðiː/",
      "audioStartMs": 0, "audioEndMs": 180
    }
  ]
}
```

⚠️ **评分前服务端要 fetch 这份 JSON 取 `text`** —— 这是「内容不入库」的必然代价
（多一次可缓存的 HTTPS 请求）。见 `apps/server/src/routes/submissions.ts` 的 `articleRefText()`。

---

## 九、内容生产流水线（离线）

```
① 选文（人工）
   来源：名言集 / 演讲节选 / 短篇散文
   ⚠️ 影视台词、歌词有版权风险

② 切分竞技场（LLM 提案 → 人工确认）
   原则：语义完整 · 10–20 秒 · 自然停顿点 · 每篇 3–5 个

③ 朗读难度定级（脚本算特征 → LLM 判断 → 人工审核）
   ⚠️ 是「朗读难度」，不是「阅读难度」
   特征：难音密度 / 连读点数 / 弱读词数 / 词数与音节数 / 最长词音节数
   锚点：5–10 条人工已定级样本（校准标尺）
   输出：difficulty + reason（可解释）

④ 标准音 + 词级时间戳（fish-audio /v1/tts/stream/with-timestamp）
   整篇一份 + 每个竞技场一份
   ⚠️ 韵律条件必须与用户独立朗读一致，A/B 对比才公平

⑤ 整篇翻译（LLM）

⑥ 音标 / 词性 / 义项（ECDICT 查表，MIT 协议，76 万词条）
   ⚠️ 音标绝不能让 LLM 生成（会幻觉且难发现）

⑦ 词级释义（ECDICT 给义项 → LLM 选语境义 → 人工审核）
   LLM 从「生成」降级为「选择」

⑧ 朗读技巧（规则检测 → LLM 润色 → 人工审核）
   连读：词尾辅音 + 下词首元音（规则可判）
   弱读：固定功能词表
   难音：音标含 /θ/ /ð/ /v/ /l/ /r/ 及长短元音对立
   LLM 只负责把检测到的点写成自然中文，不得新增

⑨ 对齐校验 + 切片 + 入库
   ⚠️ fish-audio 返回的 segments[].text 必须与自建词表逐项一致
      （分词规则须与引擎一致，见下节）
   按时间戳预切单词音频
```

**人工不可替代的三件事**：选文 · 审核 · 抽查。

---

## 十、⚠️ 讯飞 ISE 接入踩坑清单

> 这些是"不知道就会再踩一次、而且踩了很难查"的坑。

### 坑 1：不传 `ise_unite=1` 会拿到 0–5 分制

流式版有「评测返回结果与分制控制」参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `rst` | `entirety` | 返回结果与分制控制 |
| `ise_unite` | **`0`** | **返回结果控制** |
| `plev` | `0` | 返回字段详细程度（`plev=0` 时英文返回 accuracy/serr_msg/syll_accent/fluency/**standard_score**/**pitch**） |

文档原文：**「英文百分制推荐传参（`rst="entirety"` 且 `ise_unite="1"` 且配合 `extra_ability` 参数使用）」**

```js
business: {
  rst: 'entirety',              // 默认即有
  ise_unite: '1',               // ⚠️ 默认是 0，必须显式传
  extra_ability: 'multi_dimension',
}
```

**只传 `extra_ability` 不传 `ise_unite` → 得到 0–5 分制**（`total_score` 形如 `4.795611`）。

⚠️ **文档陷阱**：网上易搜到的《语音评测 API 文档》是**普通版**文档（2020-08 已下线），示例分制与流式版**不同**。照它写代码会踩坑。

### 坑 2：必须加分值断言

```js
if (!(score >= 0 && score <= 100)) throw new Error('ISE 分制异常: ' + score)
```

**一条断言即可防住，成本为零。**

### 坑 3：`integrity_score` 是乘性因子

成人句子总分公式（文档明确）：

```
total_score = (0.5 × accuracy_score
             + 0.3 × fluency_score
             + 0.2 × standard_score) × integrity_score
```

篇章版为 0.6 / 0.3 / 0.1。

⭐ **完整度是乘性的**——准确度再高，漏读导致完整度下降会把总分成比例拉低。

**影响**：UI 上「漏读」必须与「发音不准」区别表达（漏读用灰色删除线，不用红色）；预检第②层本质上是在保护用户不被完整度重罚。

### 坑 4：字段语义

| 字段 | 含义 |
|---|---|
| `beg_pos` / `end_pos` | **单位：帧，每帧 10ms** |
| `word.dp_message` | 0 正常 / 16 漏读 / 32 增读 / 64 回读 / 128 替换 |
| `syll.syll_score` | 音节得分 |
| `syll.serr_msg` | 音节检错（1 或 2049 = 朗读错误；2049 = 音节与重音皆错） |
| `syll.syll_accent` | 重读检错（1 = 该音节需要重读） |
| `word.pitch` | 逐帧音高 ⭐ 语调曲线的免费数据源 |
| `is_rejected` | 是否被拒（无有效语音） |

**已知但暂不可用**：word 层 `property` 与 `werr_msg` 用于停顿/连读/重读/句末升降调检错，官方标注"效果优化中"。**P2 再评估。**

### 坑 5：其他

- **音频格式不符会被判"乱读"，分值不可参考**——务必严格 16k / 16bit / 单声道 PCM
- **WebAPI 并发 50 路**；音频时长上限约 2 分钟
- **音标是「讯飞音标」，不是国际音标**——与 ECDICT 的 IPA 有差异，需映射
- IP 白名单未配置会返回 `10105 illegal client_ip`
- `X-CheckSum` 有效期 5 分钟，需与标准时间同步
- **分词分句规则**（用于素材库对齐）：句末标点 `.!?;`；缩写中的点号不算句末；分词符号为 `:
,|\` `|` `\` `,` `.` 之外的字符转空格

### 已知能力边界

| 能力 | 状态 |
|---|---|
| 词级 / 音节级 / 音素级检错 | ✅ 可用 |
| **分句级评分** | ✅ 可用（竞技场是句群，可用于展示"哪句稳、哪句弱"） |
| 行为异常检测 | ✅ **11 类**（乱说英文/唱歌/咳嗽/吹气…）+ 音质异常 |
| **实时中间结果** | ❌ **实测 116 帧全空——协议层不支持** |

---

## 十一、成本模型

```
成本 = 提交次数 × 单价
```

**没有"实时会话"、"分片请求"、"音素解析"等隐藏成本项——一个变量。**

DAU 1000（免费 950 / 付费 50）估算：

| 项 | 计算 | 月成本 |
|---|---|---|
| 免费用户提交 | 950 × 1 次/天 | ¥110 |
| 付费用户提交 | 50 × 6 次/天 | ¥35 |
| **合计** | | **≈ ¥145** |
| 月收入 | 50 × ¥19.9 | ¥995 |
| **毛利** | | **≈ ¥850（85%）** |

---

## 十二、风险与验证清单

### 动手前必须验证（技术侧）

| # | 风险 | 影响 | 怎么验 |
|---|---|---|---|
| **1** | `onFrameRecorded` 在 iOS/Android 的兼容性与行为差异 | ⚠️ **最高**——它挂了整个端侧分析就没了 | 真机（**开发者工具无法调试麦克风**） |
| **2** | 手写 FFT/自相关在 Worker 中的性能 | 中 | 真机压测 |
| **3** | `seek()` 播放切片的精度 | 中 | 可用预切规避标准音部分 |
| **4** | 音频格式不符导致 ISE 判"乱读" | 中 | 严格校验 16k/16bit/单声道 |
| **5** | 主包 2MB | 低 | 资源都在 CDN |

### 产品侧验证

见 [prd.md 第九节](prd.md)（朗读难度 / 阈值标定 / 重口音识别率 / 竞技场长度）。

**技术 1、2 与产品 1–4 可合并成一次真机实验。**
