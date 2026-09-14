# 端侧能力评估

> 目的：在设计原则「云端只买一个分数」下，确定端侧必须自建的能力在小程序 / 原生客户端上分别能做到什么程度。

---

## 一、能力矩阵

| 能力 | 小程序 | 原生客户端（iOS） | 备注 |
|---|---|---|---|
| 实时 PCM 帧 | ✅ getRecorderManager + onFrameRecorded | ✅ AVAudioEngine | 都能拿 16k 单声道帧 |
| VAD / 能量 / 时长 | ✅ 纯 JS | ✅ Accelerate/vDSP | 算力差异，但都够 |
| FFT / 自相关（音高） | ⚠️ **需手写**（无 AnalyserNode） | ✅ vDSP 硬件加速 | 小程序是工程量问题 |
| **逐词音高 / 抖动 / 闪烁** | ❌ | ✅ **SFVoiceAnalytics** | 苹果免费给词级韵律特征 |
| 实时转写（进度） | ✅ 微信同声传译插件（免费） | ✅ SFSpeechRecognizer / SpeechAnalyzer | |
| **离线转写 + 词级时间戳** | ❌ | ✅ **SFTranscriptionSegment** | 含 timestamp / duration / confidence |
| **转写模型体积** | — | ✅ **系统空间，零 App 体积**（iOS 26 SpeechAnalyzer） | |
| 音频精确切片播放 | ⚠️ seek() 精度有限 | ✅ AVAudioPlayer | 小程序用**预切文件**规避 |
| DTW 对比 | ✅ 纯 JS | ✅ | |
| 端侧模型（音素级） | ❌ createInferenceSession 为 Beta + 算子受限 | ✅ Core ML / NNAPI | 小程序端侧模型不现实 |

---

## 二、iOS 原生能力细节

### SFTranscriptionSegment（Speech 框架）

每个词带这些字段：

```
alternativeSubstrings   // 备选识别结果
confidence              // 置信度 0–1
duration                // 该词时长
substring               // 词文本
timestamp               // 起始时间戳
voiceAnalytics          // ⭐ 词级韵律特征
```

⭐ **voiceAnalytics（SFVoiceAnalytics）提供词级的 pitch / jitter / shimmer / voicing**——jitter/shimmer 是临床语音病理学的标准指标。**Apple 免费给到词级，行业里很罕见。**

### ⭐ iOS 26 的 SpeechAnalyzer / SpeechTranscriber

WWDC25 新 API，关键点：

> 模型存储在**系统级空间，不算进 App 的下载体积和运行内存**，系统会自动更新。

其他特性：
- 以音频时间轴 timecode 对齐，**精确到单个采样点**
- reportingOptions: [.volatileResults] → 实时临时结果
- attributeOptions: [.audioTimeRange] → 词级时间范围
- 用 AssetInventory 按需下载语言资源（仍是系统空间）

⚠️ **兼容性**：iOS 26 较新，需 fallback 到 SFSpeechRecognizer（iOS 10+），两者共用 SFTranscriptionSegment 结构。

---

## 三、微信小程序本地能力细节

### ⚠️ wx.createInferenceSession（AI 推理，**Beta**）

| 项 | 值 |
|---|---|
| 基础库要求 | **2.30.0+** |
| 模型格式 | **只支持 .onnx** |
| 模型路径 | 代码包路径 **或本地文件系统路径**（wx.env.USER_DATA_PATH）→ **可下载后加载** |
| 精度 | precisionLevel 0–4（fp16/fp32 + Winograd + 近似 math） |
| 量化 | allowQuantize |
| NPU | allowNPU —— ⚠️ **仅对 iOS 有效** |
| 动态轴 | 需手动给 typicalShape，否则报错 |

**⚠️ 社区反馈（V2EX，2023）：**

> 「换了很多 onnx 模型都不让用……要么是提示模型有动态轴需要创建 session 时候给出一个 typicalShape，要么给了 typicalShape，也还是报错。」
> 「好不容易找到一个 fcn 模型可以用的……只要运行到 createInferenceSession 这里，就会闪退。」

**结论：算子兼容性和稳定性是大问题，且只有 iOS 能用 NPU。在小程序里做端侧音素模型风险高。**

### 微信「免费」能力的真相

| 能力 | 是否本地 |
|---|---|
| 微信同声传译插件（ASR/TTS/翻译） | ❌ **是微信服务端能力**（对开发者免费，但音频出设备） |
| onFrameRecorded 拿 PCM 帧 | ✅ 真本地 |
| 纯 JS 算法（FFT/VAD/DTW） | ✅ 真本地 |

---

## 四、开源端侧模型可行性

| 模型 | int8 体积 | 手机可行性 |
|---|---|---|
| Kaldi TDNN（GOP 风格） | **4–10 MB** | ⭐ 中低端机轻松 |
| DistilHuBERT 类 | ~25 MB | 旗舰轻松，中端可跑 |
| wav2vec2-base 音素 | ~95 MB | 旗舰 + NPU 可跑 |
| GOPT（基于 wav2vec2） | ~95 MB+ | 端侧不现实 |

**现实区间：10–30 MB。** 但见下方三个真实障碍。

---

## 五、⭐ 三个真实障碍

### 障碍 1：算子兼容性（小程序）

不是「能不能优化」，而是「**跑不跑得起来**」。必须拿实际模型真机跑一遍才能确认。

### 障碍 2：分数校准（最被低估）

**如果本地分出 90、提交到云端只有 70，用户会认为整个评分体系是假的。**

要让本地分与云端分**可比**，需要大量平行数据做回归校准，且覆盖不同口音、性别、设备——**几周工作量，且每次换模型都要重做**。

**规避方式**：本地只做「相对趋势」（比上次好/差），**不做绝对分数** → 就不需要校准。

### 障碍 3：设备异构 + 模型漂移

- 低端机跑不动要降级模型 → **尺子不一样**
- iOS 的 SpeechAnalyzer 模型**系统自动更新** → **尺子被第三方控制**

**结论：本地分绝不可作为排行榜的尺子**（这是设计原则 3 的由来）。

---

## 六、结论

| 问题 | 答案 |
|---|---|
| 端侧必需能力，小程序能做到吗？ | ✅ **能**，只有「手写 FFT」和「音频精确切片」是工程量问题 |
| 端侧模型，小程序能跑吗？ | ❌ **不现实**（Beta + 算子受限 + 仅 iOS 有 NPU） |
| 原生客户端独有优势 | SFVoiceAnalytics（词级韵律）· SpeechAnalyzer（零体积模型）· Core ML |
| 这些值得为它放弃小程序吗？ | ❌ **不值得**——都是「实现便利」，可用工程量弥补；而小程序的传播效率是 App 做不到的 |

> 详见 platform-decision.md
