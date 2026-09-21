# 讯飞 ISE 返回的字段清单（实测）

> **方法**：拿一段**真实录音**（`.uploads` 里模拟器传上来的那段，ffmpeg 解码成 16k/16bit/单声道）
> 走**生产参数**（`engines/xfyun.ts` 的 `buildBusinessParams`，`ise_unite=1` 百分制）跑一次，
> 把完整 XML 存下来逐节点列出属性。原始 XML：`/tmp/ise.xml`。
> 复现：`npx tsx apps/server/scripts/dump-ise-xml.ts <pcm文件> "<参考文本>"`

## 一、节点与字段

```
xml_result.read_sentence                       lan, type, version
  .rec_paper.read_chapter                      ★ 总分与四维都挂在这一层
      total_score / accuracy_score / fluency_score / standard_score / integrity_score
      is_rejected / reject_type / except_info / score_pattern / word_count
      beg_pos / end_pos / content
    .sentence[]                                total_score / accuracy_score / fluency_score
                                               / standard_score / word_count / index
                                               beg_pos / end_pos / content
      .word[]                                  content / total_score / dp_message
                                               beg_pos / end_pos / global_index / index / property
        .syll[]                                content / syll_score / syll_accent / beg_pos / end_pos
          .phone[]                             content / gwpp / dp_message / beg_pos / end_pos
```

| 字段 | 含义 | 我们用了吗 |
|---|---|---|
| `rec_paper.total_score` | 总分（0–100，`ise_unite=1`） | ✅ 存进 `submissions.score` |
| `accuracy_score` / `fluency_score` / `standard_score` / `integrity_score` | 四维 | ✅ 存进 `dimensions`，UI 展示 |
| `is_rejected` | 无有效语音 | ✅ 直接判失败 |
| `reject_type` / `except_info` | 拒绝原因 / 异常信息 | ❌ 只进了日志边缘 |
| `score_pattern` / `word_count` | 评分模式 / 词数 | ❌ |
| `beg_pos` / `end_pos` | **单位是帧，每帧 10ms** | ✅ 词级用于回放定位 |
| `word.dp_message` | 0 正常 / 16 漏读 / 32 增读 / 64 回读 / 128 替换 | ⚠️ **解析并存了，但没参与算分** |
| `word.property` | 停顿/连读/重读/句末升降调检错 | ❌ 官方标注「效果优化中」 |
| `syll.syll_score` | 音节得分 | ❌ |
| `syll.syll_accent` | 重读检错（1 = 该音节需要重读） | ❌ |
| `phone.gwpp` | **音素发音质量** | ❌ |
| `sentence[]` 分句四维 | 哪句稳、哪句弱 | ⚠️ 解析了，UI 没用 |

## 二、⭐ `extra_ability` 决定给不给细粒度数据（**不用放弃百分制**）

同一段音频、只改 `extra_ability`，四组对比（`ise_unite=1` 全程不变）：

| `extra_ability` | `syll.serr_msg` | `word.pitch` | `phone.gwpp` |
|---|---|---|---|
| `multi_dimension`（**我们现在传的**） | ❌ | ❌ | ✅ |
| `multi_dimension,syll_phone_err_msg` | ✅ | ❌ | ✅ |
| `multi_dimension,syll_phone_err_msg,pitch` | ✅ | ✅ | ✅ |
| （`plev=1` 单独加） | ❌ | ❌ | ✅ |

⭐ 结论：**要音节级检错（serr_msg）和逐帧音高（pitch），只要把它们加进 `extra_ability` 就行，
百分制照旧、不多花一分钱。**

> ### ⚠️ 更正（本文件初版写错了）
>
> 初版写的是「`pitch`/`serr_msg` 只在 `ise_unite=0` 时返回，想要就得放弃百分制再请求一次」。
> **那是错的，而且错得很典型**：我拿两个**同时变了两个变量**的样本下了结论
> （一个是生产参数，一个是探针脚本——后者既没传 `ise_unite`，`extra_ability` 里也没有
> `syll_phone_err_msg`）。真正的原因只是 `extra_ability` 少写了一段。
>
> **教训**：对比实验一次只改一个变量。这个文件第三节刚写完「文档写着 ≠ 实测成立」，
> 紧接着自己就踩了一个同类的坑。

## 三、总分是怎么算出来的（实测验算）

```
total_score = (0.6 × accuracy_score + 0.3 × fluency_score + 0.1 × standard_score)
              × integrity_score / 100
```

⚠️ 官方文档写的是句子题 0.5/0.3/0.2，**实际生效的是篇章权重 0.6/0.3/0.1**（`category` 传
`read_sentence`，返回的节点名却是 `<read_chapter>`）。实测验算：

```
0.6×76.607580 + 0.3×96.432000 + 0.1×89.673360 = 83.8537
引擎返回 total_score                          = 83.8615   Δ<0.01
```

## 四、⚠️ 一个方法上的教训

「文档写着」和「实测成立」是两件事 —— 分制（`ise_unite`）栽过一次，
权重是第二次。**凡是能拿真实返回算一遍的，就算一遍。**
## 五、⭐ 逐个字段的体检：哪些采用、哪些不采用（实测）

> 样本：**6 段合成对照**（标准 / 漏一个词 / 换成近音词 / 只读半句 / 语速 420 / 碎句）+ **4 段真实录音**，
> 每段都走生产参数跑一次，逐字段统计。这 10 段是判断「有没有信号」的依据。

| 字段 | 实测表现 | 决定 |
|---|---|---|
| `word.total_score` | 0–100，同一段录音内跨度 56~100 | ✅ **已采用**（总分的基础） |
| `syll.syll_score` | 0–100，**与词分不等价**：`the` 词分 65.7 而音节分 **37**；`future` 词分 65.7 音节分 79/73 | ✅ **采用**（能定位到音节，比词更细） |
| `syll.serr_msg` | **乱读 14/14、半句 9/14、换词 4/14、93 分的录音 2/14、96 分 1/14** —— 单调 | ✅ **最该采用的一个**（抓「读错」最灵） |
| `word.dp_message` | 漏一个词 → 1 处；只读半句 → 6 处；**近音换词（predict→protect）→ 0 处** | ✅ 采用（漏读/增读/回读）；⚠️ 「读成另一个词」它抓不住，靠 serr_msg |
| `integrity_score` | **只对少读/漏读反应**：漏词 91、半句 45，其余全 100 | ✅ 采用，但**别乘进总分**（会把漏读罚两次），当独立指标 |
| `accuracy_score` | 对换词敏感（换词那段只有 61） | ⚠️ 可作辅助，但**与词级分高度重叠** |
| `fluency_score` | 10 段全在 **79~100**，多数 92+ | ⚠️ **不做权重**（等于给所有人加常数）；**只做护栏**（防逐词念） |
| `standard_score` | 64~94，有一点信号 | ⚠️ 可作辅助 |
| `syll.syll_accent` | ⚠️⚠️ **10 段样本全部是 3 个** —— 连 TTS 标准音、碎句、真实录音都是 3 | ❌ **不采用**：不携带对错信息（更像「这句该重读哪几个音节」的位置标注） |
| `phone.gwpp` | 中位数几乎无区分度（-0.05 ~ -0.24）；**最低值反而在高分样本上更负**（93 分那条 -8.01） | ❌ **不做总分项**；✅ 按音素归类后有诊断价值（见第六节） |
| `word.property` | 10 段样本**全是 0 / 不出现**（官方也说「效果优化中」） | ❌ 不采用（没信号） |
| `word.pitch` | 开参数就有（逐帧音高） | ⏸ 暂不采用 —— 「语调好不好」要跟参考音对比，是另一个工程 |
| `is_rejected` | 语速 420 那段 → 总分 0、四维全 0、11 个词全坏 | ✅ 已用（判失败） |

**一句话总结**：

- **能用的**：词级分、音节分、音节检错（serr_msg）、增漏标记（dp_message）、完整度（integrity）
- **只能当护栏的**：流利度
- **不能用的**：重读检错（syll_accent，恒定值）、property（没信号）
- **留着做诊断、别进分数的**：音素质量 gwpp、音高 pitch

## 六、⭐ gwpp 的正确用法：不是打分，而是「你该练哪个音」

把 4 段真实录音的**音素级**数据按音素归拢（中位 gwpp 从差到好，只列出现 ≥2 次的）：

```
音素    出现  中位gwpp  最差gwpp  被标错
uh       3    -7.55    -8.01     2
ax      12    -1.52    -5.80     2
ih      20    -0.90    -7.07     1
eh       8    -0.84    -2.62     0
dh       8    -0.61    -5.01     2
…（t / n / s 等几乎都是 -0.0x）
```

最差的音节（原始音节串）：

```
dh ax    37   ← the 的发音，4 段里反复是 37/37/37/41/61
ih t     45
ih z     48
d ih k t 50/53   ← predict 的 -dict
p r ih   51   ← 被标错
f y uh   57   ← future 的 fu-，被标错
```

⭐ **这就是「如何进步」的落点**：不是告诉他「你 58 分」，而是
**「你的 the（/ðə/）一直在 37~61 分，这是最该练的一个音；其次是短元音 /ɪ/（it / is / predict）」**。

⇒ `gwpp` 与 `syll_score` + `serr_msg` 配合可以做出**音素级发音画像**：它们区分度不够、不进总分，
但决定「下一步练什么」。
## 七、⭐ 讯飞**不给**改进建议（实测）

把返回里**所有非数值字段**打出来看过：

| 位置 | 非数值字段 | 是什么 |
|---|---|---|
| `read_sentence` | `lan` / `type` / `version` | 元信息（en / study / 7.0.0.1020） |
| `rec_paper` | `except_info` / `reject_type` / `is_rejected` / `score_pattern` | **拒绝原因码**（乱读那段：except_info=28676、reject_type=1152、is_rejected=true） |
| `word` / `syll` / `phone` | `content` | 文本 / 音节串 / 音素符号 —— 是「这是什么」，不是「你该怎么改」 |

**没有任何一句「建议 / 提示 / 评价」文字。**它给的是**病灶坐标**（哪个词、哪个音节、哪个音素、错在哪一类），不是处方。
⇒ **改进建议必须我们自己生成。**自己生成反而更对路，三个理由：

1. 目标用户是中文母语者 —— 说什么话、用什么比喻，得我们自己定；
2. 单次录音只能给出「这次哪个词错了」，**跨录音聚合**才能说「你反复在 the 上丢分」—— 那才是「进步」的抓手；
3. 只有我们知道参考文本、知道这是哪一句、哪个词该怎么读。

### ⚠️ 更正：word.gwpp 当「定位」是有效的（上一节的结论要补一句）

上一节说 gwpp「中位数无区分度」—— 那是对**整句统计**而言。这一轮发现在 **「读成了另一个词」时它会大幅变负**：

```
把 predict 读成 protect  →  d ih k t 这个音节的 gwpp = -6.60 / -7.06
同一段里读对的词            gwpp 多在 -0.0x ~ -0.6
（对照：漏读的词 syll_score=0、dp_message=16、serr_msg=1）
```

⇒ **阈值型用法可行**：gwpp 低于 -4 基本就是「这个音素明显没读对」。
它不能进总分（整句中位数没有区分度），但**能精确指出是哪个音**。

