# Azure Speech 发音评估（Pronunciation Assessment）调研

调研时间：2026-09 ｜ 面向"英语口语评测微信小程序"选型

图例：**【官方】**＝官方文档/官方定价页/官方价格 API 直接支撑；**【推断】**＝由官方线索推导，标注置信度。

---

## 一、能力

| 项 | 结论 |
|---|---|
| 评分维度 | 全文级 AccuracyScore / FluencyScore / CompletenessScore + 综合 PronScore；开启 `EnableProsodyAssessment` 后额外返回 ProsodyScore 【官方】 |
| 粒度 | `Granularity=Phoneme` 一次返回 **全文/词/音节/音素** 四级；`Word` 到词级；`FullText` 仅全文 【官方】 |
| 音节 | **仅 en-US** 有音节组；音素"名称"仅 en-US(IPA) 与 en-US/zh-CN(SAPI) 提供，其余语种只给分不给音素名 【官方】 |
| Miscue | `EnableMiscue=true` 返回 ErrorType 的 Omission/Insertion；但 **音频>30s 的连续模式不支持 EnableMiscue**，需自行与参考文本对齐 【官方】 |
| 语言 | 发音评估共 33 个 locale，含 en-US / en-GB / zh-CN / zh-HK / zh-TW，且**每个语言在所有 speech-to-text 区域可用** 【官方】 |
| 韵律 | **ProsodyScore 仅 en-US**，需 SDK ≥ 1.35.0 【官方】 |

来源：[how-to 文档](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-pronunciation-assessment)、[语言支持页](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=pronunciation-assessment)。

**PronScore 公式**（2025-11 更新）：把 accuracy/fluency/completeness/prosody 从低到高记为 s0…s3，朗读场景带韵律 = 0.4·s0+0.2·s1+0.2·s2+0.2·s3，不带韵律 = 0.6·s0+0.2·s1+0.2·s2；口语场景无 completeness。**最低分权重最高**，低分项对总分影响被放大。【官方】

## 二、新特性

- **三种场景**：Reading（scripted）/ Speaking（unscripted）/ Gaming。【官方】
- **unscripted 自由说**：不传 ReferenceText。口语场景**没有 CompletenessScore**，改出 content score（vocabulary / grammar / topic）。官方建议单次录音 **15 秒（≥50 词）～10 分钟**，topic 分需**≥3 句**。【官方】
- **Content Assessment 已下线**：内建预览版自 **Speech SDK 1.46.0** 起移除，官方替代方案是**自己调 Azure OpenAI `gpt-4o`** 做打分 prompt —— 即内容分要另建一条 LLM 链路，官方未给该链路定价。【官方】

来源：[Pronunciation assessment tool 文档](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/pronunciation-assessment-tool)。

## 三、定价

公开区（美东 list 价）：

| 计费项 | 价格 | 来源 |
|---|---|---|
| 实时语音转文本 S1 | **$1.00 / 音频小时** | 【官方】[Retail Prices API](https://prices.azure.com/api/retail/prices?$filter=armRegionName%20eq%20'eastus'%20and%20productName%20eq%20'Azure%20Speech') |
| 批量转写 S1 | $0.18 / 音频小时 | 同上 |
| 快速转写 | $0.36 / 音频小时 | 同上 |
| 增强加载项（价格页写明含 "Pronunciation Assessment (prosody)"，按**每功能每小时**计） | **$0.30 / 小时 / 功能** 【推断·中高置信度】 | 价格页给出计费结构但价格由 JS 渲染为 "$-"，0.30 取自 Retail API 计量项 `S1 Speech to Text Enhanced Feature Audio` |
| F0 免费层 | **每月 5 音频小时**（实时；批量不支持；与自定义共享） | 【官方】[定价页](https://azure.microsoft.com/pricing/details/cognitive-services/speech-services) |
| 承诺层 | 2K $1,600/月（≈$0.80/h）、10K $6,500（≈$0.65/h）、50K $25,000（≈$0.50/h）、100K $40,000（≈$0.40/h） | 【官方】Retail API 计量项 |

**基线规则**：发音评估本身与 STT 同价（含承诺层可抵扣），**prosody 属于加价项**，Accuracy/Fluency/Completeness/Miscue 含在基线内。【官方】

**单次成本估算**【推断·高置信度】：30 秒音频 = 1/120 小时 → 公开区实时 STT $0.0083 + prosody $0.0025 ≈ **$0.011（≈¥0.08）/次**。

## 四、国内可用性

- **中国区（世纪互联）提供发音评估。** 官方主权云文档把「发音评估」列在**受支持功能**清单中；区域为 chinaeast2 / chinanorth2 / chinanorth3；F0 与 S0 均可；**支持语言与公有云一致**。不支持的是自定义语音/个人语音/TTS 虚拟人/自定义关键字/语音直播/实时解释器/视频翻译/LLM 语音。【官方】[sovereign-clouds](https://docs.azure.cn/zh-cn/ai-services/speech-service/sovereign-clouds)
- **端点与 SDK**：REST `https://<region>.stt.speech.azure.cn/...`，令牌 `https://<region>.api.cognitive.azure.cn/sts/v1.0/issueToken`；SDK 必须用 `SpeechConfig(endpoint=...)` 而非 region。【官方】
- **中国区价格**（含税）：实时 **¥3/音频小时**、快速 ¥2.29、批量 ¥1.83；**增强加载项「发音评估(韵律、语法、词汇、主题)」¥3.05/小时/功能**；F0 每月 5 小时免费。【官方】[azure.cn 定价页](https://www.azure.cn/zh-cn/pricing/details/cognitive-services/)
  - 30 秒单次 ≈ ¥0.025 + ¥0.0254 ≈ **¥0.05/次**【推断·高置信度】。
- **访问海外区是否需要海外网络 / 延迟**：**未找到官方来源**。合理推断（**低置信度，勿写入 PRD**）：内地直连海外的 speech 端点不稳定，需海外出口或专线；同城中国区 RTT 与内地普通云服务同量级。**无官方延迟数字。**

## 五、Subscription Key 保护

- 官方提供 STS 换票：用资源 Key 换 **有效期 10 分钟**的 Bearer Token，SDK 支持 `AuthorizationToken`。【官方】[REST 认证](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short#authentication)
- 微软员工在官方 Q&A 明确：把 subscriptionKey 放客户端**不安全**（可被反编译），应放后端 / Key Vault。【二手·微软官方渠道答复】[Q&A](https://learn.microsoft.com/en-us/answers/questions/2005725/can-azure-speech-subscriptionkey-stored-in-client)
- **小程序侧的硬约束**：服务器域名只支持 https/wss、不能用 IP、**"域名必须经过 ICP 备案"**。\`*.cognitiveservices.azure.com\` 与 \`*.stt.speech.azure.cn\` 均无法配置。【官方】[微信网络文档](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)
- ⇒ **必须自建后端**，Key 天然留在服务端。

## 六、未找到官方来源的事项

1. prosody 加价的逐项官方标价（价格页为 JS 渲染的 "$-"）。
2. 跨境/中国区访问的官方延迟数字。
3. Azure OpenAI 内容评估链路的官方定价与延迟。
4. 微信小程序端直接运行 Speech SDK 的官方支持说明（未找到任何官方来源）。

---

## 【对小程序选型的影响】

1. **必须自建后端，且后端域名要 ICP 备案。** 小程序的服务器域名规则直接封死了"端上直连 Azure"这条路；再叠加 Key 不得落客户端（10 分钟 STS token 也需服务端签发），音频上行+评分回传都应走自有备案域名。这不是可选优化项，是硬约束。
2. **成本可控，可以按次定价。** 中国区 ≈¥0.05/次（30 秒），公开区 ≈¥0.08/次；F0 每月 5 小时可覆盖早期验证。若做高频竞技场玩法，100K 承诺层可把单价压到 ≈$0.40/小时，但需要先确认量级。
3. **韵律分只有 en-US，评分口径会被语种绑死。** 若产品想打"地道度/自然度"（语调、重音、节奏），只有美音素材拿得到 ProsodyScore；en-GB/zh-CN 素材会缺一整个评分维度。**建议题库语音全量锁定 en-US**，否则不同素材不可比。
4. **长录音会丢 Miscue；内容分是另一条技术链路。** >30 秒的连续模式不支持 EnableMiscue，"漏读/多读"检测要自研对齐；content assessment 已从 SDK 下线，语法/词汇/话题分必须自建 LLM 链路（且其中国区可用性与成本本报告未核实）。
5. **产品交互参数要按官方建议来定：** 自由说单次 15 秒～10 分钟、topic 分需 ≥3 句；朗读场景 CompletenessScore 才有效。这直接决定小程序的录音时长上限、是否分句切分、以及"预检（录音质量）"环节的必要性。
