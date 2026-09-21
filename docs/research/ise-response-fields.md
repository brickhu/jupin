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
