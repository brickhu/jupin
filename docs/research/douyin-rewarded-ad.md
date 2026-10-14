# 抖音小程序流量主（激励广告）收益调研

> 配套文档：微信侧同名调研见 [rewarded-ad-channel.md](rewarded-ad-channel.md)。
> 本文只回答**抖音这条路能挣多少、怎么结算、门槛是什么**，不重复微信侧已经算过的能量定价逻辑。

---

## 〇、结论速览

| 问题 | 答案 | 强度 |
|---|---|---|
| **接入门槛** | 企业主体：**小程序已上线 + 主营类目满足条件**（无 DAU 要求）<br>个人主体：**已上线 + DAU ≥ 50** | ⭐ 官方 |
| **主要广告类型** | 激励视频 / 信息流 / 插屏 / 视频前后贴片（共 4 种） | ⭐ 官方 |
| **结算周期** | **自然月**为一个周期，一般**每月 10 日前**生成上月结算单 | ⭐ 官方 |
| **结算方式** | ⚠️ **给字节开发票**（开票主体必须与小程序主体一致）；企业/个人分别见官方指南 | ⭐ 官方 |
| **能不能查到钱** | ✅ 有官方 OpenAPI：查广告收入、查结算单列表 | ⭐ 官方 |
| **eCPM 实际水位** | ❓ **没有官方公开值，也没有可靠第三方数据** | ❓ **本文最大空缺** |
| **官方分成比例** | ❓ **未在公开文档中找到。**微信是 5:5 / 3:7（有官方 PDF），抖音这条我找不到等价文件 | ❓ |

⭐ **一句话**：**抖音这条通道的门槛比微信低得多**（企业主体基本是"上线就能开"），
但**收益水位我这次没能查实**——而这恰恰是你要的那个数。

---

## 一、准入条件（⭐ 官方原文）

来源：[流量主能力页](https://developer.open-douyin.com/m/capacity-center-page/capacity-detail/7179893068693389370)。

> **企业主体开发者**：小程序已上线，主营类目满足条件具体参考流量主接入指南
> **个人主体开发者**：小程序已上线，**DAU≥50**，主营类目满足条件具体参考流量主接入指南

⭐ **这是抖音相对微信最大的优势**，直接对照 [rewarded-ad-channel.md](rewarded-ad-channel.md) §3.1：

| | 微信 | 抖音 |
|---|---|---|
| 主体门槛 | 累计 UV ≥ 1000 + 备案认证 | 企业：**无 DAU 要求**；个人：**DAU ≥ 50** |
| 开通速度 | ⚠️ 需要先攒量 | ⭐ **上线即可申请** |

⚠️ 但两个条件的措辞都要注意：
- **"主营类目满足条件"** —— 具体类目清单在[流量主接入指南](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/business-monetization/publisher/publisher)里（该页 JS 渲染，本次未取到正文）。❓ **需要复核：工具类目是否在内、有没有额外限制。**
- **"DAU ≥ 50"只针对个人主体**。若走企业主体，这一条不存在。

⭐ 另注：能力页写明**"是否可用于沙盒环境：是"** —— 广告能力在沙盒里可测，比很多能力友好。

---

## 二、广告类型（⭐ 官方原文）

| 广告类型 | 官方描述的适用场景 |
|---|---|
| **激励视频广告** | 用户可观看广告获得奖励，**适用于道具解锁获得积分等场景** ← 与"看广告换能量"完全对应 |
| 信息流广告 | 适用于内容信息流 / 详情页中 |
| 插屏广告 | 页面切换或回合结束等场景，**只支持竖屏** |
| 视频前/后贴片广告 | 适用于有视频内容的小程序 |

⭐ 官方社区文章（[从小程序获取广告收入](https://developer.open-douyin.com/forum/share/post/6719cdd534cab1c307a2283c)，2024-10）的**作者经验**：

> "这里推荐**插屏广告或者激励视频广告，收入可能更好**。（个人经验，实际以自己的小程序为准）"

🔶 这是开发者个人经验，不是官方口径，但与微信侧结论一致（激励视频是高价值形态）。

---

## 三、结算（⭐ 官方）

### 3.1 周期与方式

来源：[流量主能力页](https://developer.open-douyin.com/m/capacity-center-page/capacity-detail/7179893068693389370)"管理结算信息"一节原文：

> "**结算周期：每个自然月为一个结算周期**；
> 一般情况下，系统会在**每个月 10 日前生成上月结算单**，若遇节假日等特殊情况结算单顺延生成"

⭐ 社区文章补充了一条**关键差异**：

> "同意相关政策以后，填写自己的结算账户信息，可以跟财务核对好，**可以给字节开票的税率**，能开专票还是普票。**开票主体要跟小程序主体一致**"

⚠️ **这个方向和钻石兑换是一致的**（都是"你给平台开票"），而**微信侧企业结算是"寄等额增值税发票后腾讯打款"** —— 形态类似，但**开票主体一致性**这条在抖音被明确写出来了，别踩。

### 3.2 结算文档

| 文档 | 链接 | 本次是否取到正文 |
|---|---|---|
| 企业主体小程序流量主结算指南 | [链接](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/business-monetization/publisher/daily-settlement-guide-new) | ❌ JS 渲染 |
| 个人主体小程序流量主结算 | [链接](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/business-monetization/publisher/invalid) | ❌ 未取 |
| 流量主行为规范 | [链接](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/business-monetization/publisher/traffic-master-behavior) | ❌ JS 渲染 |
| 结算 FAQ | [链接](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/operation/management/publisher/FAQ/) | ❌ 未取 |

❓ **待核实**：个人主体的代扣代缴口径（微信侧已知"到手再打约 8 折"）、有无最低起结金额、打款账期（微信是结算后 30 个工作日）。

### 3.3 ⭐ 可以写代码去查钱（这条比微信强）

能力页的接口列表里有**服务端 OpenAPI**，可直接程序化取数：

| API | 用途 |
|---|---|
| [查询广告收入](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/traffic-permission/query-ad-income) | 查广告产生的收入 |
| [**广告收入 5 分钟聚合数据 Webhook**](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/traffic-permission/ad-data-webhook) | ⭐ **5 分钟粒度的收入推送** —— 比"每天查一次"精确得多，做实时对账和 eCPM 反推都用它 |
| [查询广告结算单列表](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/traffic-permission/query-ad-settlement-list) | 查结算单 |
| [申请流量主能力](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/traffic-permission/open-traffic-permission) / [查询申请状态](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/traffic-permission/query-status) | 能力申请可走接口 |
| [新增广告位](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/traffic-permission/add-ad-placement) / [更新广告位状态](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/traffic-permission/update-ad-placement-status) / [查询广告位列表](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/traffic-permission/query-ad-placement-list) | 广告位管理可走接口 |
| [创建激励广告](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/api/open-interface/ads/rewarded-video/tt-createRewardedVideoAd) | 客户端 `tt.createRewardedVideoAd` |
| [创建插屏广告](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/api/open-interface/ads/interstitial/tt.createInterstitialAd) | 客户端插屏 |
| [广告组件](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/component/open-capacity/ad) | 接入组件 |

⭐ **实际意义**：微信侧项目里"服务端验证真看完"标为待实测（见 rewarded-ad-channel.md §3.3）。
抖音这条**有官方查收入接口**，意味着**对账和效果监控可以自动化**，不必只靠后台截图。
⚠️ 但注意：**"查收入"不等于"验证某个用户真看完了"**，两者是不同的问题，别混。

---

## 四、收益水位：⭐ 本文的核心空缺

### 4.1 为什么查不到（这是原因，不是搜索不够）

⭐ **结论：抖音开放平台在制度上就不公开 eCPM。** 依据是**它公开了什么、没公开什么**：

| 已公开 | 未公开 |
|---|---|
| 准入条件、广告类型、结算周期 | ❌ **eCPM / 千次曝光单价** |
| 分成账户与开票要求 | ❌ **平台与开发者的分成比例** |
| 一堆"查收入"的接口 | ❌ 填充率、曝光率 |
| [流量主行为规范](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/business-monetization/publisher/traffic-master-behavior) | ❌ 任何价格承诺 |

⇒ **它给你"查自己收入"的工具（见 §3.3），但不给任何"预期水位"。** 这是有意为之——
eCPM 由广告主出价实时决定，平台不做承诺。所以"查不到"是**正常状态**，不是资料缺失。

### 4.2 第三方数据：只有两条，且都不可靠

| 来源 | 声称 | 质量评级 |
|---|---|---|
| [技术栈博客](https://jishuzhan.net/article/2090667548730605569)（2026-08，自媒体） | **激励广告 eCPM 现在平均约 20 元**；以往常态 30；**过去最高 100–200** | ⚠️ **低**。自媒体，且**讲的是微信**不是抖音 |
| 同一篇 | **门槛已下调至累计 500 用户**（原 1000） | ⚠️ 与项目 `rewarded-ad-channel.md` 记的"UV ≥ 1000"**冲突，需复核** |
| CSDN 文库 / 各类"抖音小程序月赚"教程 | "单机日收益 60–138 元"等 | ❌ **不采用**。是课程/项目招商物料，不是实测 |

🔶 **唯一值得留意的是趋势**：两条来源都指向"**收益在下滑**"。
⚠️ 但**没有任何一条给出抖音自身的可信 eCPM**——这一点必须如实保留。

⚠️ 特别注意那条"**过去最高 100–200、现在约 20**"：如果这个下滑趋势是真的，
意味着项目 `rewarded-ad-channel.md` 里 §4.6 的收入模型（按 eCPM 15/30/60 分档）
**乐观档位可能已经不现实**。❓ **需要在上线后用真实数据校准，不要沿用旧的乐观值。**

⇒ **任何把微信的 eCPM 直接搬到抖音的做法都是错的**，本文不提供抖音 eCPM 的数字。

### 4.3 能确定的一件事：口径上要不要再打折


微信侧已经确认过一条重要口径（rewarded-ad-channel.md §4.2）：

> ✅ **流量主后台的 eCPM 是「到手口径」，已经扣过平台分成了** —— 不要再打五折。

❓ **抖音后台展示的 eCPM 是不是同样是到手口径，未确认。** 这是上线后第一周必须看结算页确认的事
（微信侧也是同一个待确认项）。

### 4.4 怎么把 eCPM 定下来（可执行）

既然查不到，就用**官方提供的接口自己量**：

1. 接入激励视频 → 上线 → 有真实曝光后，
2. 调[查询广告收入接口](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/traffic-permission/query-ad-income)，
3. 用「收入 ÷ 有效曝光次数 × 1000」反推**真实到手 eCPM**。

⭐ 这是唯一可靠的办法，**而且只需要几天真实流量**。
⚠️ 但要注意大促扰动：微信侧已知"10 月中下旬电商预算 +50%~100%、11.9–11.11 +300%"
（rewarded-ad-channel.md §4.2）。**抖音同为字节系，大促波动只会更明显** ⇒
**别拿双 11 那几天的数当基线。**

### 4.5 可以直接复用的部分

能量定价那套**不需要重算**——它与平台无关：

- 一个能量点的**真实边际成本**：¥0.00075–0.003（讯飞 ISE ÷ 2 点）
- 一个能量点的**零售价**：¥0.06–0.10
- **保本公式**：`一次广告到手收入 ÷ 每点零售价`
- ⭐ 已验证结论：**1 点/次可行、2 点/次基本不保本**（要 eCPM 120）、
  规则应**只在"余额 < 2"时给入口 + 日限 2–3 次**

⇒ **等 eCPM 一量出来，套进上面的公式即可，不必重新推演。** 详见 rewarded-ad-channel.md §4.4–§4.6。

⚠️ 一个抖音特有的叠加因素：抖音的 iOS 是**钻石兑换**（见 [douyin-platform-research.md](douyin-platform-research.md) §4），
而**广告收入不受 iOS 支付限制**。⇒ **在拿到钻石兑换资格之前（上线 90 天内），
激励视频是 iOS 上唯一的"变现/垫底"手段，权重比微信侧更高。**

---

## 五、待核实清单

| # | 事项 | 怎么核实 |
|---|---|---|
| 1 | **激励视频真实到手 eCPM** | 上线后用查收入接口反推（§4.3）——**这是本文最该补的一项** |
| 2 | **官方分成比例** | 问对接运营 / 看结算页费率说明；微信有官方 PDF，抖音应也有但未公开 |
| 3 | **后台 eCPM 是否为到手口径** | 对比"后台显示值"与"实际结算金额" |
| 4 | **工具类目是否满足流量主主营类目条件** | [流量主接入指南](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/business-monetization/publisher/publisher)（JS 渲染，需登录看） |
| 5 | **"真看完"能否服务端验证** | 抖音激励视频回调/校验能力，与微信侧同一问题 |
| 6 | **个人主体代扣代缴与实际到手** | 个人主体结算指南 |
| 7 | **打款账期与最低起结金额** | 结算 FAQ |
| 8 | **付费与广告能否并存** | 微信侧这条也标了 ❓（rewarded-ad-channel.md §5.3）；抖音的流量主行为规范需逐条核 |

---

## 六、与微信的对照小结

| 维度 | 微信 | 抖音 | 谁更好 |
|---|---|---|---|
| 开通门槛 | 累计 UV ≥ 1000 + 备案 | 企业：已上线；个人：DAU ≥ 50 | ⭐ **抖音** |
| 广告形态 | 激励视频为主 | 4 种（激励/信息流/插屏/贴片） | 抖音更全 |
| 结算周期 | 每月 15 号前（❓两种说法并存） | 自然月，每月 10 日前 | 相当 |
| 结算方式 | 企业寄发票打款；个人代扣代缴 | **你给字节开票**，主体须一致 | 相当 |
| **收益数据可得性** | 后台为主 | ⭐ **有 OpenAPI 可查收入与结算单** | ⭐ **抖音** |
| **eCPM 水位** | 🔶 有区间（10–60） | ❓ **未知** | **微信（有数）** |
| 官方分成比例 | ⭐ 有官方 PDF（5:5 / 3:7） | ❓ 未找到 | 微信（有据） |

⭐ **结论**：**抖音这条通道"更容易开、更容易查"，但"挣多少"目前是空白。**
它值得接（门槛低、iOS 前 90 天是唯一变现手段），但**不要在接入前就拿它做收入预测**。

---

## 七、来源

**抖音官方**

- [流量主能力页](https://developer.open-douyin.com/m/capacity-center-page/capacity-detail/7179893068693389370)（准入条件 / 广告类型 / 结算周期 / 接口列表）
- [流量主接入指南](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/business-monetization/publisher/publisher) · [企业主体结算指南](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/business-monetization/publisher/daily-settlement-guide-new) · [个人主体结算](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/business-monetization/publisher/invalid) · [结算 FAQ](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/operation/management/publisher/FAQ/)
- [流量主行为规范](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/business-monetization/publisher/traffic-master-behavior)
- [从小程序获取广告收入（社区文章，2024-10）](https://developer.open-douyin.com/forum/share/post/6719cdd534cab1c307a2283c)
- [tt.createRewardedVideoAd](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/api/open-interface/ads/rewarded-video/tt-createRewardedVideoAd) · [tt.createInterstitialAd](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/api/open-interface/ads/interstitial/tt.createInterstitialAd) · [广告组件](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/component/open-capacity/ad)
- [查询广告收入](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/traffic-permission/query-ad-income) · [查询广告结算单列表](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/traffic-permission/query-ad-settlement-list)

**项目内**

- [rewarded-ad-channel.md](rewarded-ad-channel.md) —— 微信侧同名调研（能量定价、保本线、合规红线，与平台无关的部分可直接复用）
- [douyin-platform-research.md](douyin-platform-research.md) —— 抖音平台总调研（支付 / 类目 / 迁移成本）
