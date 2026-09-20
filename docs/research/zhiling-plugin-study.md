# 微信「智聆」语音评测插件调研

> 调研时间：本轮。**核心事实来自腾讯云官方文档与仓库真实源码；标注「未证实」的一律为推断。**
> 对象：微信小程序插件 **智聆口语评测**（`wx63d6102e26f0a3f8`）与 **智聆语音评测**（`wxe5a00a1780c8eb95`）。

---

## 一、结论（先看这个）

| 问题 | 结论 |
|---|---|
| 这两个插件是什么 | **同一套腾讯云「智聆口语评测 SOE」服务的两个小程序前端封装**，不是两套引擎 |
| 能不能替代讯飞 ISE | ❌ **不建议**。单位成本是讯飞的 **2–3 倍**（按词计费），且文本长度有硬上限 |
| 插件最诱人的地方 | 客户端零工程：录音 / 分片 / ws / 重试 / 签名全由插件包办，还能拿实时中间结果 |
| ⭐ **决定性障碍** | **插件拥有录音器**。实测反馈：插件初始化后，宿主自己调 `wx.getRecorderManager` 录的音**照样被上传到云端**。这与本项目的端侧架构正面冲突 |
| 引入前能否评估 | ❌ 不能。插件的开发文档在 `plugindevdoc` 页面**必须登录且添加插件后**才可见；未登录时正文为空 |

**一句话**：插件的价值全部落在本项目「云端只买一个分数、其余端侧自建」原则明确排除的那一侧；而它带来的**录音所有权冲突**恰好砸在本项目最核心的端侧能力上。

> 📊 **横向对比（讯飞 / 腾讯云 / Azure 中国区 / 有道 / 驰声 / 云知声 / 百度）见 [speech-eval-vendor-comparison.md](speech-eval-vendor-comparison.md)。**

---

## 二、两个插件的关系与差异

两者都是微信智聆语音团队出品，指向同一个腾讯云产品「智聆口语评测 SOE」。

| | **智聆口语评测** | **智聆语音评测** |
|---|---|---|
| AppID | `wx63d6102e26f0a3f8` | `wxe5a00a1780c8eb95` |
| 类目 | 工具 > 效率 | 教育服务 > 在线教育 |
| 最新版本 | **0.0.6** | **2.0.6** |
| 更新记录条数 | 4 条 | 40+ 条 |
| 最近更新内容 | 「增加错误返回码 20802 小程序请求频率限制」 | 2.0.6「未提前获取录音授权时，调用开始到首次监听开始评测回调时间间隔优化」 |
| 引用名（示例） | `ihearing-eval` | `soePlugin` |
| 取管理器 | `plugin.getRecordRecognitionManager()` | `plugin.getSoeRecorderManager({...})` |
| 官方开源示例 | ✅ [Tencent/iHearing](https://github.com/Tencent/iHearing)（MIT，130★，**最后提交 2019-04-03**） | ❌ 无 |
| 主推程度 | 历史产物，已开源、停更 | ⭐ **腾讯云官网当前指向的插件** |

**关键证据**：腾讯云「口语评测（新版）」文档 → SDK 文档 → 客户端 SDK → **「小程序插件」** 一页，正文只有一行表格，SDK 集成说明直接外链到：

```
https://mp.weixin.qq.com/wxopen/plugindevdoc?appid=wxe5a00a1780c8eb95&token=486467026&lang=zh_CN
```

即 **`wxe5a00a1780c8eb95`（智聆语音评测）才是「新版 SOE」的官方小程序插件**；`wx63d6102e26f0a3f8`（智聆口语评测）是 2019 年配套开源 demo 的旧插件，对应的是**基础版**接口。

> 来源：[腾讯云 1774 小程序插件](https://cloud.tencent.com/document/product/1774/107751)、[插件主页 e5a00](https://mp.weixin.qq.com/wxopen/pluginbasicprofile?action=intro&appid=wxe5a00a1780c8eb95&lang=zh_CN)、[插件主页 63d61](https://mp.weixin.qq.com/wxopen/pluginbasicprofile?action=intro&appid=wx63d6102e26f0a3f8&lang=zh_CN)

⚠️ 两代插件 **API 不兼容**：旧插件是 `start({content, evalMode: 'word'|'sentence', scoreCoeff})`（字符串模式名），新插件是 `getSoeRecorderManager()` + 数字 `evalMode`。网上教程混用两代会直接报错。

---

## 三、插件真实 API（已核实）

### 3.1 初始化

```js
// app.json
"plugins": { "soePlugin": { "version": "2.0.6", "provider": "wxe5a00a1780c8eb95" } }

// 页面
const plugin = requirePlugin("soePlugin")
```

**三种密钥接入方式**（源码级证据，来自腾讯云官方文档）：

```js
// ① 固定密钥 —— 官方明说「适用于前端调试」，会泄露密钥
manager = plugin.getSoeRecorderManager({ SecretId: '...', SecretKey: '...' })

// ② 临时密钥 —— 线上推荐：自己的服务端换 STS 凭证
manager = plugin.getSoeRecorderManager({
  getAuthorization: function (callback) {
    wx.request({ url: 'https://your.server/getTmpIdAndKey', success: d =>
      callback({ Token: d.Credentials.Token, TmpSecretId: ..., TmpSecretKey: ... }) })
  }
})

// ③ 微信云开发云函数换临时密钥
manager = plugin.getSoeRecorderManager({
  getAuthorization: cb => wx.cloud.callFunction({ name: 'getAuthorization', success: d => cb(d.result.Credentials) })
})
```

⭐ **重要推论**：**插件不能免掉后端**。它免掉的是「websocket 流式协议 + 分片 + 重试 + HMAC 签名」的客户端工程，换成了「一个发临时密钥的接口」。而这个接口（STS GetFederationToken）本身还是要服务端 + 腾讯云企业实名 + 套餐包。

> 来源：[腾讯云 884 录音评测说明](https://cloud.tencent.com/document/product/884/84112)

⭐ **官方 demo 实证**（[TencentCloud/tencentcloud-demo-mp-soe](https://github.com/TencentCloud/tencentcloud-demo-mp-soe)，最近提交 2025-07-23）—— 服务端换临时密钥的最小实现，连权限策略都是官方给的：

```js
// node-demo/authorization.js（官方原文）
const policy = { version: '2.0', statement: { effect: 'allow',
  action: ['soe:TransmitOralProcessWithInit'], resource: '*' } };
await client.GetFederationToken({ Name: 'soe', Policy: encodeURIComponent(JSON.stringify(policy)) });
```

官方 README 同时提醒：「正式部署时请在后台加一层自己网站本身的权限检验」。**这就是「插件不免后端」落到代码上的样子。**

### 3.2 事件与方法

| 成员 | 签名 | 说明 |
|---|---|---|
| `manager.onStart(fn)` | — | 录音开始 |
| `manager.onStop(fn)` | `res.tempFilePath` | 录音结束，**返回音频文件路径** |
| `manager.onResponse(fn)` | `res` | 分片中间结果（1.1.1 起加入） |
| `manager.onSuccess(fn)` | `res` | 最终评测结果 |
| `manager.onError(fn)` | `res` | 失败 |
| `manager.start(options)` | — | **启动录音 + 开始评测**（不是「上传已有音频」） |
| `manager.stop()` | — | 停止录音并收尾评测 |

### 3.3 `start(options)` 参数

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `content` | String | **必填** | 参考文本，对应云 API 的 `RefText` |
| `evalMode` | Number | 0 | 0 单词 · 1 句子 · 2 段落 · 3 自由说 · 4 单词音素纠错 · 5 情景 · 6 句子多分支 · 7 单词实时 · 8 拼音 |
| `duration` | Number | 60000 | 录音时长上限 ms，最大 300000（需段落/自由说模式） |
| `scoreCoeff` | Number | **1.5** | 苛刻指数，范围 [1.0, 4.0]，**对应不同年龄段** |
| `serverType` | Number | 0 | 0 英文 · 1 中文 |
| `textMode` | Number | 0 | 0 普通文本 · 1 音素结构文本 |
| `soeAppId` | String | — | 业务应用 ID |
| `sentenceInfoEnabled` | Number | 0 | 1 = 输出断句中间结果（需插件 ≥1.2.16），对应 `SentenceInfoSet` |
| `keyword` | String | — | 主题词 / 关键词 |

> ⚠️ 上表来自**基础版**（884）文档。新版（1774）的 `start` 是否扩展了参数，**无法在登录墙外核实**。

### 3.4 旧插件（0.x）的真实调用形态

来自 [Tencent/iHearing](https://github.com/Tencent/iHearing) 仓库源码（MIT）：

```js
const plugin = requirePlugin("ihearing-eval")
const manager = plugin.getRecordRecognitionManager()   // 全局唯一

manager.start({ content: "I go to school by bus", evalMode: 'sentence', scoreCoeff: 1.0 })
manager.stop()

manager.onStop = (res) => {
  const r = res.result
  r.pron_accuracy / r.pron_fluency / r.pron_completion     // 整体
  r.words[]  // { word, tag, pron_accuracy, word_start, word_end, phone_info[] }
             // tag: 0 匹配 · 1 多读 · 2 少读
  r.words[i].phone_info[]  // { phone, pron_accuracy }  ← 音素级
}
manager.onError = (res) => res.msg
```

⭐ 注意旧插件**不传任何密钥**——因为它是腾讯 2019 年为推广开源而提供的「厂商买单 + 频率限制」通道（错误码 `20802 小程序请求频率限制` 即其配额体现）。

> **未证实**：旧插件今天是否仍可免费使用、配额多少、是否已被下线。插件主页标注「以下版本已停止服务」但未列出具体版本。

---

## 四、返回结果与量表陷阱

新版（1774）返回结构与 `SuggestedScore` 公式（[官方 评测维度](https://cloud.tencent.com/document/product/1774/107384)）：

```
SuggestedScore = PronAccuracy × PronCompletion × (2 − PronCompletion)
```

| 字段 | 范围 | 说明 |
|---|---|---|
| `SuggestedScore` | [0,100] | 官方「建议评分」，**不是简单平均** |
| `PronAccuracy` 精准度 | **[0,100]** | 所有匹配单词的平均 |
| `PronFluency` 流利度 | ⚠️ **[0,1.0]** | 连读 / 弱读 / 失去爆破 / 意群停顿 |
| `PronCompletion` 完整度 | ⚠️ **[0,1.0]** | 匹配单词占参考文本比例；情景模式里代表**切题度** |
| `Words[].MatchTag` | 枚举 | 0 匹配 · 1 新增（多读）· 2 缺少（漏读）· 3 错读 · 4 未录入 |
| `Words[].MemBeginTime/MemEndTime` | ms | ⭐ **词级时间戳** |
| `PhoneInfos[]` | — | 音素级：`Phone` / `PronAccuracy` / 起止时间 / `DetectedStress` |
| `Tone` | — | 中文声调（英文恒为无效） |

### ⚠️⚠️ 最大的坑：量表在两代之间变了

- **旧插件（基础版）**：`pron_fluency` / `pron_completion` 与 `pron_accuracy` 同量纲，示例代码直接当百分比显示。
- **新版（1774）**：流利度、完整度是 **[0, 1.0]** 的小数。

**照抄网上旧教程 → 流利度显示 0.97% 而不是 97%。** 本项目若做引擎横评，必须对每个引擎单独建「量表归一化」层，不能假设同量纲。

### 分数语义的实战影响

`SuggestedScore` 里的 `(2 − PronCompletion)` 让**漏读的惩罚是超线性的**：

| 场景 | Accuracy | Completion | SuggestedScore |
|---|---|---|---|
| 完美 | 100 | 1.0 | **100** |
| 少读 30% | 100 | 0.7 | **91** |
| 读得准但只读了 2/3 | 90 | 0.67 | 80 |

→ 本项目的「征服 = ≥85 分」阈值，在腾讯云的分数体系下会**天然偏向「读全」而不是「读准」**；与讯飞 ISE 的分制（由 `ise_unite` 决定，见 [ise-probe-report.md](ise-probe-report.md)）不一致。**跨引擎的 85 分不可迁移。**

---

## 五、计费：对 25–50 词竞技场意味着什么

[官方计费概述](https://cloud.tencent.com/document/product/1774/107342)：

| 套餐 | 价格 | 折合 |
|---|---|---|
| 1 万次 | ¥9.9（**限购 1 个**） | 9.9 元/千次 — 仅够调试 |
| 15 万次 | ¥600 | **4 元/千次** |
| 100 万次 | ¥3750 | 3.75 元/千次 |
| 500 万次 | ¥17500 | 3.5 元/千次 |
| 1 亿次 | ¥300000 | 3 元/千次 |
| 后付费 | ¥0.005/次 | 5 元/千次 |

**计费次数 = 文本长度**（不是请求数）：

> 每 20 个单词计作 1 次，不足 20 按 20 计。62 个单词 → 62 ÷ 20 = 3.1 → **4 次**。
> **「目前只适用于段落模式和自由说模式。」**

并发：免费 50，超出 **¥30/个/月**。

### ⭐ 套到「句说」的竞技场（25–50 词）

新版各模式文本上限（[官方 评测模式](https://cloud.tencent.com/document/product/1774/107338)）：

| 模式 | 文本上限 | 音频上限 |
|---|---|---|
| 句子 | **≤ 30 词** | 60s |
| 段落 | ≤ 120 词 | 300s |

**推论**：竞技场一旦超过 30 词，就只能走**段落模式**，而段落模式**按词计费**：

| 竞技场长度 | 模式 | 计费次数 | 后付费成本 | 15 万套餐成本 |
|---|---|---|---|---|
| 25 词 | 句子 | 1 | ¥0.005 | ¥0.004 |
| **31–40 词** | **段落** | **2** | **¥0.010** | **¥0.008** |
| **41–50 词** | **段落** | **3** | **¥0.015** | **¥0.012** |

对比讯飞 ISE：**¥0.00387/次，不看文本长度**。

> ⭐ **成本差 2–3 倍，且随竞技场句子变长而恶化。**
> 这与 [engine-comparison.md](engine-comparison.md) 的既有结论一致，本文补充了「30 词是模式切换点」这个硬边界。

**产品层面的连锁反应**：本项目 ¥19.9/月 · ¥199.9/年。若每日 1 次免费提交 + 付费用户高频提交，
按 ¥0.012/次算，一个每天练 30 次的付费用户月成本 ≈ **¥10.8**，占 ¥19.9 的 54%。
用讯飞（¥0.00387）则是 ¥3.5，占 18%。**这个差距足以影响定价模型。**

---

## 六、⭐ 决定性障碍：插件拥有录音器

这是本文最重要的发现。

### 6.1 机制

`manager.start()` **本身就是「开始录音」**——不是「上传一个已有的音频去评测」。录音由插件内部发起（官方文档原文：*"在 start 函数内设置评测参数"* + 长按/松手示例）。

### 6.2 两条社区实证（跨两代插件都成立）

**① 旧插件（8 年前，wxopen.club）**
> 「查询官方文档后发现**本质还是调用了 getRecorderManager**。但是这个页面内还需要调用录音 api 的情况下，则报以上错误。」
> 官方回复的解法：**把宿主的录音参数改成和插件一致的格式**（`format: 'mp3', sampleRate: 16000, frameSize: 5, numberOfChannels: 1`）。

→ 插件和宿主**共用同一个 `RecorderManager` 单例**，参数不一致就崩。

**② 新版插件（7 年前，wxopen.club 提问 `getSoeRecorderManager`）**
> 「步骤一：引入智聆口语组件后，`getSoeRecorderManager` 唤起录音……结束。
> 步骤二：当前页面录音评测完，返回其他页面，其他页面 `getRecorderManager()` 唤起录音，开始录音。
> 到了步骤二正常录音时，**肯定会发送语音数据到 soe 的云端**，请问有什么方法可以销毁外部组件吗？」

官方回复只有一句：*「如果你确认的话，我觉得这是个 bug」* —— **没有给解决方案**。

→ **插件在宿主页面录音时仍在工作、仍在往云端送数据、仍然计费。**

### 6.3 为什么这对「句说」是致命的

看 [AGENT.md](../../AGENT.md) 的架构：

```
录音 → onFrameRecorded(PCM 帧) → Worker → 纯函数 FFT/YIN/VAD/DTW → 音高·流利度·进度·上色
                                                                        ↓
                                                          （只把音频拿去云端换一个分数）
```

引入插件后变成：

| 冲突点 | 后果 |
|---|---|
| 录音起点被插件接管 | 端侧拿不到「按下即录」的时序控制 |
| 插件设的 recorder 监听是全局的 | 宿主自己的 `onFrameRecorded` 可能被覆盖 / 静默失效 |
| 宿主录音被上传 + 计费 | **练习（本地免费重录）的边际成本不再是 0** —— 直接违反设计原则 2 |
| 插件不暴露 PCM 帧 | 官方只给了 `onStop → tempFilePath`（**录完之后**才有音频）与 `onResponse`（**评测中间结果**，不是音频帧）。**实时音高曲线 / 呼吸灯无从谈起** |

> **设计原则 2「高频动作边际成本必须为 0」**在插件架构下无法成立：
> 录音和评测被插件绑成了一个动作。

---

## 七、其他已核实的事实

| 项 | 事实 | 来源 |
|---|---|---|
| 音频格式 | pcm 16kHz 单声道 16bit ≥256kbps（wav/mp3/speex 皆可） | [使用限制](https://cloud.tencent.com/document/product/1774/107339) |
| 音频时长 | 最长 300s | 同上 |
| 语言 | 英文（美/英式，不可选，参考剑桥词典）、中文普通话；**不支持日韩** | 同上 |
| 参考文本 | 支持 IPA 指定发音 `{::ipapron{...}}`、命令块 `{::cmd{F_IPA=true}}`、分隔符 `|`、情景模式候选词 `@@{::words{...}}` | 同上 |
| 苛刻指数 | 三段数据的曲线随 1.0–4.0 变化，「对应不同年龄段」，官方建议**自己收音频调参** | [苛刻指数介绍](https://cloud.tencent.com/document/product/1774/107379) |
| 返回结果 | 官方明确 `SuggestedScore` 只是「建议评分」，**允许自定义评分逻辑**（用 Words 数组自己算） | [评测维度](https://cloud.tencent.com/document/product/1774/107384) |
| 插件添加规则 | 小程序后台「设置-第三方服务-插件管理」按 appid 添加；**「如果插件无需申请可直接使用；否则需要申请并等待插件开发者通过」** | [微信官方 使用插件](https://developers.weixin.qq.com/miniprogram/dev/framework/plugin/using.html) |
| 插件代码包 | 独立于小程序主包，不占主包体积 | 同上 |

⚠️ **官方文档从未给出「插件类目必须与小程序类目匹配」的规则**；插件主页上的「类目」是**插件自身**的服务类目，不构成硬门槛。（此前若有此印象，属于误记。）

### 合规：插件不免除任何义务

用插件录音**不会**让本项目绕过已有的合规要求——录音仍是 `scope.record`（插件内部调 `wx.getRecorderManager`，同样受该 scope 约束），仍须在隐私指引中声明「访问你的麦克风」。
区别只在**数据去向**：插件把音频直送腾讯云（境内），不涉及跨境；而若走境外引擎（如 Azure），还需履行《个人信息出境标准合同办法》义务。

> 详见 [微信小程序「录音 + 上传音频到第三方服务」合规调研](../微信小程序-录音上传第三方-合规调研.md)。

---

## 八、结论与建议

### 8.1 与讯飞 ISE 的最终对照

| 维度 | 讯飞 ISE（当前选择） | 智聆插件 |
|---|---|---|
| 单价（25–50 词） | **¥0.00387 固定** | ¥0.008–0.012（按词） |
| 免费额度 | 10 万次（企业认证） | 无（1 万次要 ¥9.9） |
| 文本长度 | 无惩罚 | ⚠️ **>30 词必须走段落模式并按词计费** |
| 客户端工程 | 自己写签名 + 上传 | ✅ 插件包办 |
| 实时中间结果 | ❌ 实测为零 | ✅ 有 |
| **端侧录音主权** | ✅ **完全归自己** | ❌ **被插件接管** |
| 引入门槛 | 服务端 HMAC 签名 | 云账号 + STS 接口 + 插件申请 |
| 文档可及性 | ✅ 公开 | ❌ **登录 + 添加插件后才可见** |

### 8.2 建议

1. **维持讯飞 ISE 作为主引擎**，本文不改变 [engine-comparison.md](engine-comparison.md) 的结论，但补充了三条更硬的证据：**30 词模式切换点**、**流利度/完整度量表差异**、**录音所有权冲突**。
2. **把「插件路线」明确记为已评估不可行**，理由是**架构层面**的（录音主权），不是价格层面的——避免以后有人只看到「免费省工程」而重新提出。
3. 若将来仍想用智聆（例如讯飞涨价或实时能力变成刚需），**必须先做真机探针**（见下），且只能在**放弃端侧实时分析**的前提下。

### 8.3 ⭐ 引入前必须做的探针实验（若要继续评估）

在真机上验证三条，**缺一不可**：

| # | 验证项 | 判定 |
|---|---|---|
| 1 | 插件初始化后，宿主 `wx.getRecorderManager().onFrameRecorded` 是否仍回调 | 不回调 → 端侧架构直接死亡 |
| 2 | 插件 `stop()` 之后，宿主自己录音时是否仍有数据发往 `soe.cloud.tencent.com` | 有 → 练习也在烧钱，违反原则 2 |
| 3 | `onStop(res.tempFilePath)` 拿到的音频，能否在**同一次录音**里既喂端侧分析又送云端 | 不能 → 必须录两遍 |

探针方式沿用 [probes/](../probes/) 的形态：真机 + vConsole + 抓包（Charles / Stream）。
**注意**：开发者工具**拿不到麦克风**，此实验**只能在真机**做。

---

## 九、来源清单

| 类型 | 链接 |
|---|---|
| 插件主页（新） | https://mp.weixin.qq.com/wxopen/pluginbasicprofile?action=intro&appid=wxe5a00a1780c8eb95&lang=zh_CN |
| 插件主页（旧） | https://mp.weixin.qq.com/wxopen/pluginbasicprofile?action=intro&appid=wx63d6102e26f0a3f8&lang=zh_CN |
| 开源示例 | https://github.com/Tencent/iHearing |
| 开源公告 | https://cloud.tencent.cn/developer/article/1427980 |
| SOE 录音评测说明（getSoeRecorderManager / start 参数） | https://cloud.tencent.com/document/product/884/84112 |
| 新版 · 小程序插件 | https://cloud.tencent.com/document/product/1774/107751 |
| 新版 · 计费概述 | https://cloud.tencent.com/document/product/1774/107342 |
| 新版 · 评测模式 | https://cloud.tencent.com/document/product/1774/107338 |
| 新版 · 使用限制 | https://cloud.tencent.com/document/product/1774/107339 |
| 新版 · 评测维度（返回字段） | https://cloud.tencent.com/document/product/1774/107384 |
| 新版 · 苛刻指数 | https://cloud.tencent.com/document/product/1774/107379 |
| 新版 · Android SDK（对照：SDK 亦自带录音） | https://cloud.tencent.com/document/product/1774/107356 |
| 微信官方 · 使用插件 | https://developers.weixin.qq.com/miniprogram/dev/framework/plugin/using.html |
| 社区 · 录音器冲突（旧插件） | https://wxopen.club/topic/5e466c9c811a38cc5e4aca86 |
| 社区 · 录音被上传（新插件） | https://wxopen.club/topic/5e495c87910cdf6fe3a85d80 |
| 社区 · 真机回调失效（新插件） | https://wxopen.club/topic/60cf58000cd4550a6931e7d2 |

---

## 十、未证实 / 待办

- [ ] 新版插件（2.0.6）`start(options)` 的完整参数表 —— **需登录且添加插件后**才能看 `plugindevdoc`
- [ ] 插件是否对上架有资质/申请门槛（官方规则只说「可能需申请」）
- [ ] 旧插件 `wx63d6102e26f0a3f8` 今天是否仍可用、免费配额多少、是否随「基础版下线」而失效
- [ ] 插件是否暴露 PCM 帧回调（官方文档未见；**很可能没有**，需探针）
- [ ] 节 8.3 的三项真机探针
