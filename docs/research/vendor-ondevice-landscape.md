# 口语评测厂商 + 端侧离线开源方案调研

> 证据分级：**【官方】**=官方文档/官网原文；**【二手】**=媒体/博客/论文转述；**【未证实】**=未找到官方来源。GitHub star 为 API 快照。

## 一、其他厂商

**百度智能云「语音评测」——疑已不对外提供**
- 官方[免费测试资源](https://cloud.baidu.com/doc/SPEECH/s/Wl9mh4doe)与[计费概述](https://cloud.baidu.com/doc/SPEECH/s/Al9mh44v7)的产品清单只有大模型语音、短/实时语音识别、音频文件转写、语音合成、离线语音合成，**无任何「语音评测」条目**，文档目录同样没有。**【官方】**
- 全站仅能检索到百度 AI 市场上**第三方**（苏州声通）售卖的「AI语音评测」￥10/1000 次（支持英汉日法、音素到段落全维度）。[链接](https://aim.baidu.com/product/89283278-9005-4de3-9997-88f48531f8ee) **【官方页面·第三方商品】**
- **未找到**百度官方语音评测的下线公告或现存文档 ⇒ 不能作为候选。

**有道智云——可自助开通，价格公开**
- 实时评测走 `wss://openapi.youdao.com/stream_capt`，中英（zh-CHS/en），wav/16k/16bit/单声道，单次≤120s；输出完整性/流利度/准确度/语速/总分，含**单词级与音素级**评分及错音提示（judge/calibration/prominence）。[官方文档](https://ai.youdao.com/DOCSIRMA/html/tts/api/ssyypc/index.html) **【官方】**
- 按量 50 元/万次（月≤100 万）、45、40；资源包 5 万次 212 元/30 天、100 万次 4000 元/180 天；新用户赠 10 元体验金，折合约 **0.004–0.005 元/次**。[官方定价](https://ai.youdao.com/DOCSIRMA/html/tts/price/yypc/) **【官方】**

**驰声 Chivox——自助通道上线，但 SDK/直连 API 仍商务报价**
- 自助定价：新账号免费 600 评测点（30 天）；Standard $19.90 起，$0.0038/词·句、$0.0075/段；**SDK 与直连 API「Priced separately」需单独报价**。[官方定价](https://www.chivox.com/en/pricing) **【官方】**
- 中文侧新客免费额度需**加企业客服**领取：个人 1000 次/14 天、企业 10000 次/60 天。[官方公告](https://www.chivox.com/sounddynamics/info.aspx?itemid=1595) **【官方】**

**云知声 Unisound——产品在线，价格不公开**
- 覆盖音素/单词/句子/篇章、自然拼读、韵律（重读·连读·语调·意群）、考试题型，中英双语；Web API + iOS/Android/HarmonyOS SDK。[官方产品页](https://ai.unisound.com/sa-call-eval) **【官方】**
- 价格页只有「商务定制 / 私有化部署」（商务邮箱 zhuhongze@unisound.com）⇒ **需商务报价，无法自助开通**。厂商自述「与人工专家打分准确率 95% 以上」**（厂商口径，未找到第三方验证）**。

**其他**
- **先声智能**：open.singsound.com 在线，覆盖英/中/日（单词·句子·段落·音标·自然拼读·口语作文·故事复述）；**未找到公开定价页**。[产品页](https://open.singsound.com/doc/engine?type=params_desc) **【官方产品页·价格未证实】**
- **思必驰 / 声智科技**：未找到官方口语评测 API 文档，**未找到官方来源**。
- **Google / Amazon**：**未找到**官方发音评估 API；Google Read Along 为端侧 ML 方案（Android 官方博客，正文抓取失败，**二手**）。

## 二、端侧离线开源方案

**1. 技术路线**：声学模型后验 → GOP。Kaldi 官方 recipe 定义 GOP-NN，并明确**分类器方法优于纯 GOP**、**chain 模型不适合算 GOP**（需 nnet3 非 chain TDNN）。[官方 README](https://github.com/kaldi-asr/kaldi/blob/master/egs/gop_speechocean762/README.md) ⇒ **依赖强制对齐 + 声学模型后验**，这是端侧的核心成本。**【官方】**

**2. 开源项目（★为 GitHub API 快照）**

| 项目 | ★ | 许可 | 端侧 |
|---|---|---|---|
| kaldi-asr/kaldi | 15483 | NOASSERTION（需自查） | 服务端 C++，含 762 recipe |
| tbright17/kaldi-dnn-ali-gop | 236 | 无 | 最后提交 2019 |
| YuanGongND/gopt | 229 | BSD-3 | ICASSP2022 GOPT，PyTorch |
| jimbozhang/kaldi-gop | 163 | 无 | 2021 后停更 |
| jimbozhang/speechocean762 | 195 | 语料 | 5000 句/250 人/五专家，**允许商用** |
| Halleck45/OpenPronounce | 65 | MIT | Wav2Vec2+DTW，需两个 ~1.2GB 权重 |
| frank613/CTC-based-GOP | 43 | 无 | **免强制对齐**，值得关注 |

**无一个仓库声明支持 onnxruntime-web / CoreML / TFLite 或端侧推理**，端侧化需自行导出量化。**【官方 README 核实】**

**3. 打分相关性（已证实）**
- speechocean762 官方 Kaldi 基线（音素级）：原始 GOP **MSE 0.69 / PCC 0.25**，GOP 特征 **MSE 0.16 / PCC 0.45**。[论文](https://ar5iv.labs.arxiv.org/html/2104.01378)
- GOPT（ICASSP 2022）：RF 音素 PCC 0.44、SVR 0.45、**LSTM 0.591**；句级 total 前人最好 **0.720**。[论文](https://ar5iv.labs.arxiv.org/html/2205.03432)
- OpenPronounce 官方 benchmark（500 句）：句级 **Pearson 0.633 / Spearman 0.652**，说话人均值 Spearman 0.825。[benchmark](https://github.com/Halleck45/OpenPronounce/blob/main/benchmarks/README.md)

**4. 平台可行性（官方）**
- **WXWebAssembly 存在**：v2.13.0 起全局可用、v2.15.0 起可在 Worker 内使用；支持 Memory/Table/Global（iOS 导出暂不支持 Global）与 `.wasm.br`；**文档未提多线程/SharedArrayBuffer/SIMD**。[官方文档](https://developers.weixin.qq.com/miniprogram/dev/framework/performance/wasm.html)
- 微信另有原生端侧推理 API **`wx.createInferenceSession`（ONNX，AI 推理能力 Beta）**，比自建 WASM 更现实；但**算子与体积限制明细未能抓取（页面 JS 渲染），需实测**。[官方 API](https://developers.weixin.qq.com/miniprogram/dev/api/ai/inference/wx.createInferenceSession.html)
- 体积：Wav2Vec2 权重 ~1.2GB/个【官方】，**远超小程序代码包量级（估算）**，须蒸馏/量化到数十 MB。
- 中文开源薄弱（std-mandarin-kaldi 仅 8★、2021 后无更新）⇒ **中文需自建，英文可复用（估算）**。
- 工作量（**估算，无官方来源**）：量化声学模型 + 强制对齐 + GOP 回归 + 校准，1–2 人月原型起步，不含标注采集。

**5. 结论**：**纯端侧「部分可行」**——适合**朗读跟读即时反馈**（漏读、明显错音）与**预筛/断网降级**，句级相关仅 **r≈0.6**；**不适合**正式评分、排名、考试、付费判定（不可仲裁、跨设备不可复现、无第三方验证）。

## 【对小程序选型的影响】
1. **厂商候选收窄为有道 + 驰声**：百度语音评测在官方文档、计费、免费资源三处全部缺席，**不要再列入候选**；云知声、先声虽在线但无公开价格，只能走商务，不适合早期快速验证。
2. **有道可作基线**：0.004–0.005 元/次【官方】、可自助开通、含音素级 judge/calibration，是本批里**唯一价格与能力都公开**的选项——建议与已选定的讯飞 ISE 做同音频 A/B。
3. **驰声按「商务」预算，别按自助价预算**：自助价只覆盖 MCP/Function Calling，**小程序直连 SDK/API 属 Priced separately**，且中文免费额度要加客服领取，采购周期会拖长。
4. **端侧不做评分主链路**：开源方案句级 r≈0.6、音素级 PCC 0.25–0.6，且**无仓库支持端侧推理**；只应作为即时反馈/降级增强层，不作为分数来源。
5. **若做端侧，优先微信原生 `createInferenceSession` 而非自建 WXWebAssembly**：WXWebAssembly 无多线程/SIMD 承诺，原生推理自带量化支持；但**必须实测**（算子覆盖、模型体积、端侧耗时），不要在设计阶段当既成能力。
