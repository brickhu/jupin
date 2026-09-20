# docs —— 调研、实验与归档

> **项目入口在根目录 [AGENT.md](../AGENT.md)。**
> 产品设计见 [prd.md](../prd.md)，数据库与架构见 [spec.md](../spec.md)。
> 本目录只放**调研、评估、实验与历史归档**。

---

## 目录

### research/ —— 调研与评估

| 文件 | 内容 | 关键结论 |
|---|---|---|
| [engine-comparison.md](research/engine-comparison.md) | 评分引擎横评（讯飞 / 腾讯云 / 驰声 / Azure / 云知声 / 开源） | ⭐ 选讯飞 ISE |
| [ise-probe-report.md](research/ise-probe-report.md) | **讯飞 ISE 实测报告**（探针实验） | ⚠️ 零中间结果 · ⭐ 分制由 ise_unite 决定 |
| [zhiling-plugin-study.md](research/zhiling-plugin-study.md) | **微信「智聆」语音评测插件调研**（两个插件的真实 API · 计费 · 录音所有权） | ❌ 不可用：**插件拥有录音器，与端侧架构冲突** · 单价 2–3× |
| [speech-eval-vendor-comparison.md](research/speech-eval-vendor-comparison.md) | **口语评测云服务选型对比**（讯飞 / 腾讯云 / Azure 中国区 / 有道 / 驰声 / 云知声 / 百度） | ⭐ 讯飞仍最便宜 · ⭐ **有道是唯一可自助开通的备胎** · ⚠️ Azure 中国区**支持**发音评估但 ~13× · ❌ 百度该产品疑已下线 |
| [azure-pronunciation-assessment.md](research/azure-pronunciation-assessment.md) | Azure Speech 发音评估专题（能力 / 定价 / 中国区可用性 / 小程序接入） | ⭐ 中国区（世纪互联）**支持发音评估** ¥3/小时 + ¥3.05/功能/小时 · ⚠️ **Prosody 仅 en-US** · ⚠️ 域名无法进小程序白名单，必须中转 |
| [vendor-ondevice-landscape.md](research/vendor-ondevice-landscape.md) | 其余厂商 + 端侧离线开源方案（GOP / WXWebAssembly / createInferenceSession） | ⚠️ 端侧句级 r≈0.6、音素级 PCC 0.25–0.6，**只配做即时反馈，不进排名** |
| [on-device-capability.md](research/on-device-capability.md) | 端侧能力评估（iOS 原生 / 小程序 / 开源模型） | 小程序必需能力全都能做 |
| [content-production-research.md](research/content-production-research.md) | 内容生产调研（fish-audio 时间戳 / ECDICT / 难度定级 / 技巧生成） | fish-audio 原生支持词级时间戳 |
| [platform-decision.md](research/platform-decision.md) | 平台选型论证（小程序 vs 原生客户端） | ⭐ 做小程序 |
| [miniprogram-api-constraints.md](research/miniprogram-api-constraints.md) | **微信小程序 API 硬约束（官方文档核实）** | ⚠️ frameSize 单位 KB 且须整数 · sampleRate PC 不支持 · Worker 最大并发 1 |
| [cloud-hosting-constraints.md](research/cloud-hosting-constraints.md) | **微信云托管约束**（部署方案） | ⭐ CallContainer 免域名免备案 · ⚠️ **音频必须走对象存储直传**（请求体有大小限制） |
| [styling-decision.md](research/styling-decision.md) | 样式方案选型（StyleX / Tailwind / UnoCSS） | ⭐ 选 UnoCSS + preset-weapp —— **WXML 调不了 JS，CSS-in-JS 全部出局** · ⚠️ 变体分隔符必须是 `__` |
| [skyline-evaluation.md](research/skyline-evaluation.md) | **Skyline 渲染引擎评估**（官方文档核实） | ⭐ 现在不切、但按它的 WXSS 子集写 · ⚠️ **不开 AB 实验线上仍走 WebView** · ⚠️ 不支持 `*`/属性选择器/inline 布局/sticky/多层 shadow |

### experiments/ —— 待执行的实验

| 文件 | 内容 | 状态 |
|---|---|---|
| [validation-experiment.md](experiments/validation-experiment.md) | **合并验证实验方案** — 一次采集回答 6 个问题 | ⏳ **待做，动手前的必经步骤** |

### probes/ —— 探针脚本

| 文件 | 用途 |
|---|---|
| [probe-ise-stream.cjs](probes/probe-ise-stream.cjs) | 验证讯飞 ISE 流式行为的探针。改音频路径与文本即可验证任何假设 |

### archive/ —— 已废弃

⚠️ **以下全部是 v1 设计的文档，已被推翻，仅作历史参考。**

| 文件 | 废弃原因 |
|---|---|
| product.md · mvp-spec.md · scoring-system.md | D/Q/E/P 积分体系、能力分曲线已被推翻 |
| tech-stack.md · architecture.md | SolidJS + Azure 技术栈已推翻 |
| deploy-aliyun.md | 部署方案已改为微信云托管 |
| growth.md | 增长策略待重做 |
| ise-integration-plan.md | 当年 ISE 对接记录（部分经验仍有参考价值） |
| v2-product-spec.md | 已拆分为 prd.md + spec.md |

---

## 本目录的写作原则

1. **结论前置** —— 每篇开头先给结论，再给证据
2. **标注核实状态** —— 区分「官方文档写的」/「实测的」/「推断的」
3. **记录错误与修正** —— 走过的弯路要写明，避免重蹈
4. **可复现** —— 实验要给出脚本和步骤
