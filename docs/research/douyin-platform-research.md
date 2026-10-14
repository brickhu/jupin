# 抖音平台调研：能不能把句拼做在抖音上

> 结论：**技术可行，工作量 2–4 人月；真正的闸门不是技术，是两个前置资格（类目归属 + 90 天经营期）。**
> 本文记录**讨论结论**，不是任务清单。任务与状态见 [plan.md](../../plan.md)。

---

## 〇、怎么读这份文档

本文最容易被误用的地方，是**把"当时查到的"当成"现在生效的"**。所以每条结论都标了强度：

| 标记 | 含义 | 能不能当依据 |
|---|---|---|
| ⭐**已核实** | 有官方原文，下文附链接与原文摘录 | 可以当方向，**执行前仍需复核** |
| 🔶**推断** | 从官方文字或公开报道推出，没有直接口径 | ❌ 不能当依据 |
| ❓**待核实** | 我拿不到，必须登录开放平台或问对接运营 | ❌ 阻塞项 |

⚠️ 一个总纲提醒：**本文引用的抖音官方公告，末次编辑时间集中在 2024 年 7 月 – 2025 年 2 月。** 抖音开放平台的规则变动频繁（见 §3 担保支付下线就是例子），**所有 ⭐已核实 的条目在真正动手时都要重新核一遍**。尤其支付和类目两块。

---

## 一、这次讨论解决了哪些问题

从最初"句拼在微信上目标用户不对味"，一路收敛到四个独立问题。它们的结论并不一致，**混在一起想是之前反复绕圈的原因**：

| # | 问题 | 结论 |
|---|---|---|
| 1 | 熟人社交里用户不愿展示声音，产品还有救吗？ | ✅ 有解，但解法是**把"听见声音"和"知道是谁"断开**，不是砍掉声音 |
| 2 | 要不要从微信迁到抖音？ | ⚠️ 用户在抖音 ≠ 产品该在抖音。但**如果用户确实主要来自抖音阅读直播，那答案倾向于迁** |
| 3 | 抖音端怎么收费？ | ✅ 形态是**内容电商**（卖具体的点评结果），不是游戏内购；且**分阶段**而非分平台 |
| 4 | 能不能做"带声音的视频分享"？ | ✅ **抖音有官方接口**，这是目前看到的**最强形态** |

**最重要的一条认知转变**：视频/合拍把"展示声音"的社交语义从**"我被评价"**换成了**"我参与了一个挑战"**。自我暴露的浓度被稀释——这恰好解掉了问题 1 里那个死结。

---

## 二、字节侧已核实的能力清单

### 2.1 带声音的视频分享 ⭐

这是整轮讨论里最有价值的发现。

| 能力 | 官方页面 | 关键原文 |
|---|---|---|
| **拍摄视频并发布至抖音** | [能力页](https://developer.open-douyin.com/capacity-center-page/capacity-detail/7179893068680790076) | "用户可在小程序拍摄短视频并将视频**发布至抖音**，发布视频时还可设置**标题、话题**等信息" |
| 同上 · 锚点 | 同上 | "如果已开通**短视频自主挂载**能力后，发布的视频还可以**直接携带小程序锚点，为小程序带来流量及转化**" |
| 同上 · 准入 | 同上 | "**小程序上线可接入**" |
| 同上 · 硬限制 | 同上 | "拍摄器**仅可由用户手动触发，不可自动触发**"；"保留用户的编辑权" |

接口三项：用户授权（摄像头）、[视频拍摄器](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/api/retweet/video)、[发布抖音视频](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/api/open-interface/video-capacity/upload-douyin-video/)。

另外存在可用于**自己生成**视频的录制能力：[MediaRecorder](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/develop/api/media/canvas-recording/media-recorder/MediaRecorder) 与 [`tt.createMediaRecorder`](https://partner.open-douyin.com/docs/resource/zh-CN/live-interactive-tools/development/js-api/media/canvas-recording/tt-create-media-recorder)（官方文档带"扫码体验"，属主推能力）。

**❓ 待真机验证的两个生死点**（文档页 JS 渲染，抓不到正文，只有接口名与导航结构）：

1. **MediaRecorder 能不能把"用户录音"作为音轨混进去**，还是只能录 canvas 画面 + 麦克风实时输入？
2. **「发布抖音视频」是否接受本地生成的视频文件**，还是只接受拍摄器产出的文件？

⚠️ 参考项目已有教训：`docs/research/skyline-evaluation.md` 记过"开发者工具下 canvas / video / camera 无法调试，需真机预览"。**这类能力在模拟器里一定测不出来。**

**这条的战略含义**：如果视频能带锚点出去，**分发就不再只依赖达人**——每个发视频的用户都在替产品挂一次锚点。达人的角色从"唯一流量入口"降级为"种子"。

⚠️ 但**对外发布的视频是公开的**，用户录音会被公开传播。这与 §6 隐私原则的关系**尚未想清楚**，是下一轮要解决的问题。

### 2.2 分享能力的降级 ⭐

抖音小程序的对外分享止于**私信与群**（[分享至抖音私信/群](https://developer.open-douyin.com/docs/resource/zh-CN/dop/ability/opensdk/share/video-create-bind)），**没有朋友圈等价物**。

⇒ 原 PRD 里"分享到朋友圈"、第九节"分享率"指标，在抖音端都需要重新定义。

⚠️ 巧合的好处：之前讨论已经定了"只做点对点挑战、不做广播"，这个结论在抖音上**天然成立**，不需要额外约束。

### 2.3 身份：抖音云不注入 openid ⭐🔶

- ⭐ 抖音有标准 [`code2Session`](https://developer.open-douyin.com/docs/resource/zh-CN/mini-game/develop/server/log-in/code-2-session)，且官方有[云上 code2session 的迁移说明](https://partner.open-douyin.com/docs/resource/zh-CN/developer/tools/cloud/function-service/invoke-sever/login) —— 说明身份是迁移中的真实议题。
- ⭐ 抖音小程序有**匿名登录态**（`anonymous_openid`）。
- 🔶 **推断**：微信云托管"由网关注入 openid"那条路（现项目线上主通道，见 `apps/server/src/services/wx-login.ts` 注释）在抖音上不成立。

⇒ **抖音端建议默认走 HTTP 传输通道**（`config.ts` 里 `TRANSPORT = 'http'`），把 `code2Session` 作为主路径而不是备胎。
⇒ 顺带的好处：抖音的匿名态可以做**"先读，要上榜再授权"**，比微信的静默登录更顺。

### 2.4 对象存储 ⭐

抖音云有[对象存储服务端 API](https://developer.open-douyin.com/docs/resource/zh-CN/developer/tools/cloud/api-reference/tos/server)。

⇒ 现项目的 `storage/wxcloud.ts`（微信云托管 `/tcb/*` 实现，还专门绕开了"旁加载"的坑）**整体作废，纯新写**。这是服务端最重的一块。

---

## 三、支付：三个必须先知道的结论

### 3.1 担保支付已下线 ⭐

《[担保支付能力全量迁移至通用交易系统](https://developer.open-douyin.com/forum/bulletin/post/6769033bff7dbb42ad955679)》（2024-12-23）原文：

> "**担保支付能力将下线**，新增小程序**即日起**需接入通用交易系统（除生活服务和电商行业小程序）……存量小程序请于 **2025 年 3 月 12 日**前完成切换。"

⇒ **任何写着"接担保支付 ECPay"的方案都是过期的**（包括本文档早期版本的方案）。要走[通用交易系统](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/trade-system/guide/general/aboutbasic)。

### 3.2 iOS 不是"不能支付"，是"要攒资格后用钻石兑换" ⭐

⚠️ **这里纠正过一个错误判断**：早期依据 2023 年《[小程序 iOS 虚拟支付规范](https://developer.open-douyin.com/forum/bulletin/post/64f1563a97afe26d6f0c98fd)》（末次编辑 2024-09）认为"iOS 端不支持虚拟支付"。**这个说法已不完整。**

《[全新支付方式-小程序钻石兑换能力上线啦](https://developer.open-douyin.com/forum/bulletin/post/668f505b68a0c340143c088f)》（2024-07-11）原文：

> "平台上线**小程序钻石兑换能力**，用户可通过钻石兑换方式**在 iOS 系统中进行虚拟商品和服务的购买**。"
>
> 亮点：**"支持 iOS 端虚拟商品和服务兑换"**

| 项 | 事实 |
|---|---|
| 能力是否存在 | ⭐ ✅ 存在，官方主推 |
| 开放范围 | ⭐ **试点中，仅工具行业 + 短剧行业** |
| 机制 | **钻石兑换**（用钻石换虚拟商品），不是直接卖虚拟品 |

⚠️ 但 2023 年那份规范**并未作废**：官方 FAQ 明确把[短剧类 iOS 虚拟支付规范](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/operation/industry-norm/1/virtual-payment-guide)作为整改依据，且报错码 21050 的说明里写着"小程序出现 **iOS 虚拟支付违规行为**……**现已封禁现金支付能力**"。

⭐ **硬红线**（官方 FAQ 审核条目原文）："其他**直接通过非抖音钻石的方式发起交易**，或者**间接引导至外部第三方网页或 APP 发起支付**均属于 iOS 虚拟支付违规行为。"

⇒ **iOS 上不能引导用户去 H5 / 微信 / 公众号 付款。** 这条会影响所有降级文案设计。

### 3.3 工具类目支持卖虚拟服务，7 天账期 ⭐

来自 3.1 那份迁移公告的结算表：

| 行业 | 类目 | 商品类型 | 结算方式 | 账期 |
|---|---|---|---|---|
| **工具** | 一级类目：工具；社交各二级 | **虚拟服务（301）** | 支付后结算 | **7 天** |
| **工具** | 同上 | **信息付费（302）** | 支付后结算 | **7 天** |

⇒ **Android 这条线的虚拟商品售卖完全合规且被支持。**

---

## 四、钻石兑换：资格、费率、账期

### 4.1 准入条件（工具行业，缺一不可）⭐

来源：官方 FAQ《[钻石兑换-你的疑问我来解读](https://developer.open-douyin.com/forum/bulletin/post/66c55cd273a9173bf14f8668)》，并给出控制台自查路径。

| 条件 | 自查路径（官方给的） |
|---|---|
| 小程序完成 **ICP 备案** | 控制台-基础设置-备案信息 |
| 完成**通用交易系统**接入，且**交易订单 ≥ 1 笔**（超时未付不算） | 控制台-能力-支付-交易管理-交易记录 |
| **完成试运营阶段**（新手村不支持） | 控制台-总览-基本信息 |
| **上架时间 ≥ 90 天** | 控制台-开发-版本管理-版本日志 |
| 信用分 **≥ 80** | 控制台-健康-健康概览 |
| 无过高投诉率 / 无严重违规 / 主体无严重违规 / 无侵权成立记录 | 控制台-健康-违规记录 等 |

申请后**需平台评估，约 5–7 个工作日**。

⚠️ **明确"暂未开放"的子类目**（原文）："工具-营销工具-互动营销、工具-**娱乐工具-答题/解密/测评**暂未开放"。

⇒ **❓ 阻塞项 1：句拼（英语朗读评测）落在工具行业的哪个二级类目？** 若归到"娱乐工具-测评"，则**钻石兑换开不了**。这是整条 iOS 支付路线的闸门，**必须先查类目树**。

### 4.2 费率与换算 ⭐

| 项 | 官方口径 |
|---|---|
| **兑换比** | **钻石:现金 = 10:1**，钻石为整数，最小 1 颗 ⇒ **1 钻 = ¥0.1** |
| **平台技术服务费** | **1%**（公式里的 `× 99%`） |
| **结算公式** | 开发者应得收益 =（订单净额 × 99% － 呆坏账）×（1 + 开票增值税率）/ 1.06 |

**换算表（用户消耗掉的钻石 → 你到账）：**

| 消耗钻石 | 订单净额 | 到手（6% 开票） | 到手（3% 开票） | 到手（1% 开票） |
|---|---|---|---|---|
| 1 颗 | ¥0.10 | ¥0.0990 | ¥0.0962 | ¥0.0934 |
| 100 颗 | ¥10 | ¥9.90 | ¥9.62 | ¥9.34 |
| 1000 颗 | ¥100 | **¥99.00** | **¥96.20** | **¥93.40** |
| 10000 颗 | ¥1000 | ¥990.00 | ¥961.98 | ¥933.96 |

⭐ **一句话口径**：**消耗的钻石数 × 0.1 元 × 99%**。1000 钻换 99 块。

⚠️ **公式之外还要扣**（官方 Q5 原文）："分账时产生的平台费用部分（包括**支付手续费、cps 达人抽佣、平台抽佣**等）全部从**手续费账户**中抽取"。
⇒ **给达人开的 CPS 佣金不在这 99% 里，是另外扣的。**

⭐ 另注：官方 Q5 说明**两个账户不同口径**——「抖音支付账户」只服务钻石场景的技术服务费与推广计划费用；「手续费账户」服务非钻石支付订单。**做财务模型时不能混成一个数。**

### 4.3 账期：月结，比 Android 慢 6–8 倍 ⭐

官方 Q1 原文：

> "前一个月 **20 日**至本月 **19 日**为一个结算周期……开发者可以根据结算单中的「结算总金额」**给平台开具发票**，将发票递交给平台审核后，平台进行结算。"

⚠️ **方向是"你给抖音开票"**（Q10："发票由小程序主体开具，提供给抖音开放平台"）。开通时会被要求开「抖音支付账户」，不开影响结算。

| 线 | 账期 |
|---|---|
| Android（通用交易系统，工具类虚拟服务） | **支付后 7 天** |
| **iOS（钻石兑换）** | **约 1.5–2 个月**（月结 + 你开票 + 平台审核） |

⇒ **iOS 的钱要当成"两个月后的钱"，别排进前几个月现金流。**

### 4.4 几个容易踩的坑 ⭐

- **没消耗的钻石不结算。** 原文："最终结算金额**以消耗钻石为准**"。⇒ 用户充值未消耗的部分是**平台上的预收款**，不是你的收入。
- **退款退的是钻石，不是现金。** 接口只支持**支付 +7 日内**退回，超过 7 天走线下或找平台运营。
- **呆坏账定义极宽**：包含"任何一方综合考虑用户体验/舆论影响等因素而决定的退款"，且明确"**含 iOS 渠道费率**、税费、手续费等"。
- 单笔充值上限 50000 钻（¥5000）。

### 4.5 待核实 ❓

1. **苹果 iOS 渠道费到底扣多少。** 官方结算公式里**没有这一项**，但"呆坏账"定义里提到"含 iOS 渠道费率"。公开报道与用户投诉指向 30%（[新浪投诉案例](https://tousu.sina.com.cn/complaint/view/17397867441)）。🔶 **推断 iOS 到手可能只有 Android 的七成左右，但无官方来源，不可用于定价。**
2. **2026 年的实时口径。** 引用的公告末次编辑集中在 2024-07 – 2025-02。另：苹果 2025-11 推出"小程序合作伙伴计划"对部分小程序抽佣降至 15%（[报道](https://finance.sina.com.cn/jjxw/2025-11-14/doc-infxifin3375100.shtml)），抖音这条线大概率受影响。**必须以控制台实时要求为准。**

---

## 五、收费形态（结论）

### 5.1 总原则：内容电商，不是游戏内购

抖音的生态、达人的带货能力、"主播点评"这个天然场景，全都指向同一个方向：**卖一个具体结果和一次服务**，而不是卖资源和数值。

⇒ 原有"能量包"（10/300/3000 三档）是**微信虚拟支付的产物**，迁移时正好借机砍掉。

### 5.2 推荐形态

| 形态 | 定价 | 用途 | 平台适配 |
|---|---|---|---|
| **单句精评**（主形态） | ¥1–9 | 逐词音素级反馈 + 连读/重音/语调点评 + "卡在哪、怎么改" | 低价冲动型，抖音电商逻辑 |
| **周期陪跑**（主播线） | ¥29–99 / 期（4–8 周） | 一组金句 + 每周直播点评 + 榜单 + 结营成绩 | 与主播直播节奏对齐，CPS 值得他谈 |
| **激励视频换能量** | 免费 | iOS 前 90 天的垫底方案 | 按 eCPM 10–60 元/千次估 |

### 5.3 明确不做的三种

| 不做 | 原因 |
|---|---|
| **纯订阅制** | 抖音用户无订阅习惯；改"一期"可降一个量级的认知成本 |
| **卖评测次数（原核心）** | 在用户最想要结果的那一刻收过路费；且 iOS 前 90 天卖不了 |
| **卖名次 / 榜单曝光** | 直接摧毁产品的比较价值，唯一禁区 |

### 5.4 分阶段，而非分平台（重要简化）

| 阶段 | iOS | Android |
|---|---|---|
| **阶段一（上线 0–90 天）** | 免费 / 激励视频 | 正常付费 |
| **阶段二（资格达标后）** | 钻石兑换 | 直接支付 |

⇒ **不需要两套货架、两套价格、两套文案。** 用户看到的价格一致，只是"怎么付"不同。
⇒ 但如果**类目落在"测评"**（§4.1），则阶段二对 iOS 永远不成立，**必须改产品定位或接受 iOS 永久免费**。

⚠️ 合规提示：若"周期陪跑"的交付物被认定为**课程内容**，可能需要教育类目；若定位为"评测次数 + 教练点评 + 打卡框架"，更接近**工具类虚拟服务**。**收同样的钱，说法不同，类目门槛完全不同。**

---

## 六、隐私与"声音"的设计结论

这三条来自前几轮讨论，与平台无关，但对抖音端同样成立：

1. **榜上有名，声上无名。** 榜单显示昵称头像（要社交认同），但播放的音频**不带昵称、不带头像、不带主页链接**。这是"开放收听"敢默认开的前提。
2. **用互惠代替主动公开。** 想听别人，得先在这一档留下过一次录音。解掉"只听不录"的搭便车。
3. **降低永久性。** 录音应更像"说过的话"而不是"发布的作品"——一段时间无人互动后退出可听池。

⚠️ **与 §2.1 的冲突尚未解决**：对外发布的视频是**公开且可传播**的，用户录音会离开产品边界。需要单独一轮设计决策。

---

## 七、迁移工程评估（摘要）

> 详细的映射表、执行顺序与 `payments` 表设计，建议单独成文 `docs/migration-douyin.md`。

### 7.1 规模

| 项 | 数字 |
|---|---|
| 小程序端 | 19,028 行 / 144 文件 / 10 页面 / 12 组件 |
| 服务端 | 22,211 行 / 107 文件 |
| **直接绑微信的文件** | **72 个** |
| `wx.cloud` 调用 | 40 处 |
| `wx.login` | 16 处 |
| 估算工作量 | **2–4 人月** |

### 7.2 分四层

| 层 | 内容 | 成本 |
|---|---|---|
| **A 通用 API** | `showToast`(36)、`setStorageSync`(8)、`request`(8)、`navigateTo`(7) | 低。`wx.`→`tt.`。⭐ **导航已收口 `lib/route.ts`、auth 收口 `lib/auth.ts`**，这是最值钱的前期投资 |
| **B 真实耦合** | `RecorderManager`、`createInnerAudioContext`、`createWebAudioContext`、`getRandomValues`、上传下载、激励视频、`tt.pay` | 中。**录音+波形是产品本体，必须第一周真机验** |
| **C 身份与网关** | `wx.cloud.callContainer` + 网关注入 openid | 中高。新建 `dy-login.ts` / `dy-access-token.ts` |
| **D 存储 + 支付** | `storage/wxcloud.ts`（`/tcb/*`）、`services/xpay.ts`（虚拟支付双签名） | **高，且 D 大部分是纯新建** |

### 7.3 好消息：数据模型基本是对的

`apps/server/src/db/schema.ts` 的 `payments` 表已经做了几件**恰好是换支付渠道最需要的事**：

- `outTradeNo` 自己生成、做幂等键 → 不用动
- `status`（pending/paid/refunded/failed）与 `deliveredAt` **分开**（注释写明"钱到了"和"货发了"是两件事）→ 状态机直接复用
- 退款是**独立的单**（`refundNo`）→ 复用
- `goodsCode/goodsKind/goodsAmount` 是**下单快照**、不 join goods 表 → 复用

要改的只是渠道相关列：`xpayProductId`（goods）、`prepayId`/`xpayOrderId`/`payEnv`/`transactionId`（payments）。
⇒ **建议：加一组 `dy*` 列并保留 `xpay*` 列**，让"支付渠道"变成数据维度而不是代码分支。

⚠️ **一条现有约束会失效**：`goods.priceFen` 注释写"必须是整元（微信道具只收整数元）"。抖音按现金定价，**¥9.9 这类价格可以做**。迁移时值得重新定一次价。

### 7.4 不用改的（最大的资产）

- **评测链路全部不用动**：讯飞 ISE 打分、`services/scoring.ts`、`settle.ts`、能量结算、连战、饼干 —— 全部与渠道无关。
- 榜单、难度分档、今日挑战、参与记录、收藏、个人主页 —— 一行不用改。
- Hono + MySQL/Drizzle + `ObjectStorage` 抽象 —— 整体保留，只换实现。

### 7.5 会被重写的工程设施（纯体力，约占总工作量 1/3）

`uno.config.mjs` + `unocss-preset-weapp`（→ TTSS）、`wxss-lint.mjs`、`wxml-handlers.mjs`（→ TTML）、`build.mjs` / `build-atomic.mjs`、`project.config.json`、`lib/cloud-file.ts`。

### 7.6 执行顺序

| 步 | 内容 | 验证物 |
|---|---|---|
| **0** | **合规前置**：账号主体能开什么类目 | 类目清单（含 §4.1 的"测评"归属） |
| **1** | **技术 spike（3–5 天，做完就丢）** | 录一段→上传→现有服务端出分→放标准音。同时验录音质量、连通性、`code2Session`、对象存储 |
| **2** | 身份与存储切换（1–2 周） | `dy-login.ts` / `dycloud.ts` + 匿名态与绑定合并 |
| **3** | 客户端全量平移（2–3 周） | 10 页 / 12 组件；构建链同步改 |
| **4** | 支付（2–3 周） | 按通用交易系统重建；iOS 形态差异 |
| **5** | 灰度与对齐（1–2 周） | 真机矩阵、分享降级后的文案与入口 |

### 7.7 最可能返工的三点

1. **录音体验是否等价**（产品本体，不是功能项）。
2. **iOS 形态差异** —— 若不能在阶段一就写进 PRD，会在定价页/商品页/引导流程到处漏。
3. **分享能力降级** —— 第九节"分享率"指标与 7.11 分享入口需重定义。

---

## 八、下一步（按优先级）

| # | 事项 | 为什么排这个位置 |
|---|---|---|
| 1 | **查句拼在工具行业的二级类目归属**（是否为"娱乐工具-测评"） | 一个 ❓ 决定 iOS 支付路线存在与否 |
| 2 | **查账号主体能开的类目** | 不通则后面全部作废 |
| 3 | **复核抖音实时支付口径**（费率、开放行业、苹果渠道费） | 本文引用已是 2024–2025 年的公告 |
| 4 | **真机验证两个视频生死点**（音轨混入、本地文件发布） | 决定 §2.1 那条最强形态能不能做 |
| 5 | **先做最便宜的验证**：手动做 3 条"成绩卡视频"挂锚点发出去，看点击与转化 | 数据是死的就不必做管线 |
| 6 | 写 `docs/migration-douyin.md`（映射表 + `payments` 的 `dy*` 列设计） | §7 的详细展开 |

---

## 九、来源

**抖音开放平台**

- [拍摄视频并发布至抖音（能力页）](https://developer.open-douyin.com/capacity-center-page/capacity-detail/7179893068680790076) · [发布抖音视频](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/api/open-interface/video-capacity/upload-douyin-video/) · [视频拍摄器](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/api/retweet/video)
- [MediaRecorder](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/develop/api/media/canvas-recording/media-recorder/MediaRecorder) · [tt.createMediaRecorder](https://partner.open-douyin.com/docs/resource/zh-CN/live-interactive-tools/development/js-api/media/canvas-recording/tt-create-media-recorder)
- [分享至抖音私信/群](https://developer.open-douyin.com/docs/resource/zh-CN/dop/ability/opensdk/share/video-create-bind)
- [code2Session](https://developer.open-douyin.com/docs/resource/zh-CN/mini-game/develop/server/log-in/code-2-session) · [云上 code2session](https://partner.open-douyin.com/docs/resource/zh-CN/developer/tools/cloud/function-service/invoke-sever/login)
- [对象存储服务端 API](https://developer.open-douyin.com/docs/resource/zh-CN/developer/tools/cloud/api-reference/tos/server)
- [通用交易系统能力介绍](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/trade-system/guide/general/aboutbasic)
- [担保支付能力全量迁移至通用交易系统](https://developer.open-douyin.com/forum/bulletin/post/6769033bff7dbb42ad955679)（2024-12-23）
- [全新支付方式-小程序钻石兑换能力上线啦](https://developer.open-douyin.com/forum/bulletin/post/668f505b68a0c340143c088f)（2024-07-11）
- [钻石兑换-你的疑问我来解读](https://developer.open-douyin.com/forum/bulletin/post/66c55cd273a9173bf14f8668)（2024-08-21）
- [钻石结算指南](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/business-monetization/guaranteed-payment/general/diamond-payment/diamond-settlement-guide-new) · [钻石兑换常见问题](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/business-monetization/guaranteed-payment/general/diamond-payment/diamond-faq)
- [小程序 iOS 虚拟支付规范](https://developer.open-douyin.com/forum/bulletin/post/64f1563a97afe26d6f0c98fd)（2023-09）· [短剧类小程序 iOS 虚拟支付规范说明](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/operation/industry-norm/1/virtual-payment-guide)
- [流量入口概述](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/flow-entrance/host-app-intro)
- [星图 · 投稿任务-小程序推广计划](https://www.xingtu.cn/help-center/author/112809)

**项目内**

- [prd.md](../../prd.md) · [spec.md](../../spec.md) · [plan.md](../../plan.md)
- [docs/design/payment-and-purchase.md](../design/payment-and-purchase.md)（现有微信支付设计，双渠道对照应以本文为输入更新）
- [docs/research/rewarded-ad-channel.md](rewarded-ad-channel.md)（激励视频 eCPM 与保本线）
- [docs/research/skyline-evaluation.md](skyline-evaluation.md)（"canvas/video/camera 需真机预览"）
- [docs/archive/growth.md](../archive/growth.md)（早期增长计划，抖音列为 P1）
- [docs/微信小程序-录音上传第三方-合规调研.md](../微信小程序-录音上传第三方-合规调研.md)（个人主体教育类目限制）
