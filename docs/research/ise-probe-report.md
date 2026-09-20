# 讯飞 ISE 实测报告

> **方法**：写探针脚本，用 macOS say 合成真实英文语音（4.5 秒），完全复现生产参数（en_vip + multi_dimension + 1280B/40ms 实时节奏），逐帧观察返回。
> 探针脚本：`docs/probes/probe-ise-stream.cjs`

---

## 结论 1：⚠️ 流式版**没有任何中间结果**

共 117 帧返回：

| 帧类型 | 数量 | 返回内容 |
|---|---|---|
| status=0（首帧） | 1 | 空 |
| status=1（中间帧） | 115 | **全部 chunkBytes=0，累计 word 数始终为 0** |
| status=2（结束帧） | 1 | **一次性返回 18185 字符完整 XML，20 个 word 节点** |

**讯飞的「流式」指的是流式上传音频，不是流式返回结果。**

### 影响

- **用讯飞做不到「读一个词、亮一个词」的实时反馈**
- 但**结束帧发出后 <100ms 就返回完整结果**——对 10–20 秒的竞技场，等待感很轻，实时性的价值有限

---

## 结论 2：⭐ 分制由 ise_unite 参数决定（这是原项目 bug 的根因）

实测 total_score=4.795611、standard_score=5.000000 → **0–5 分制**。

流式版文档有「评测返回结果与分制控制」参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| rst | entirety | 返回结果与分制控制 |
| **ise_unite** | **0** | **返回结果控制** |
| plev | 0 | 返回字段详细程度 |

**文档原文：「英文百分制推荐传参（rst="entirety" 且 ise_unite="1" 且配合 extra_ability 参数使用）」**

### 修法

```js
business: {
  rst: 'entirety',              // 默认即有
  ise_unite: '1',               // ⚠️ 默认是 0，必须显式传
  extra_ability: 'multi_dimension',
}
```

**不是「自己乘 20」这种野路子——引擎自己就能返回百分制。**

### ⚠️ 文档陷阱

网上易搜到的《语音评测 API 文档》（docs/voiceservice/ise/API.html）是**普通版**文档（2020-08 已下线），其示例分制与流式版**不同**（普通版示例是 0–100）。

**照那份文档写代码 → 写出 Math.round(totalScore) → 得到 0–5 的值 → 所有阈值判断失效。**

**加一条断言即可防住：**

```js
if (!(score >= 0 && score <= 100)) throw new Error('ISE 分制异常: ' + score)
```

---

## 结论 3：词级数据结构（实测 XML）

```xml
<word beg_pos="1" content="i" dp_message="0" end_pos="8" global_index="0"
      pitch="181.07 181.07 182.11 ..." total_score="4.999288">
  <syll beg_pos="1" content="ay" serr_msg="0" syll_accent="0" syll_score="4.958241">
    <phone beg_pos="1" content="ay" dp_message="0" end_pos="8" gwpp="-0.008387"/>
  </syll>
</word>
```

### 字段语义

| 字段 | 含义 |
|---|---|
| beg_pos / end_pos | **单位：帧，每帧 10ms**（实测 end_pos=450 ↔ 4.5s 音频） |
| word.dp_message | 0 正常 / 16 漏读 / 32 增读 / 64 回读 / 128 替换 |
| syll.syll_score | 音节得分 |
| syll.serr_msg | 音节检错（1 或 2049 = 朗读错误；2049 = 音节与重音皆错） |
| syll.syll_accent | 重读检错（1 = 该音节需要重读） |
| phone.gwpp | 音素发音质量 |
| **word.pitch** | ⭐ **逐帧音高** — 语调曲线的免费数据源 |
| is_rejected | 是否被拒（无有效语音） |

**已知但暂不可用**：word 层 property 与 werr_msg 用于停顿/连读/重读/句末升降调检错，官方标注「效果优化中，无需关注」。**P2 再评估。**

---

## 结论 4：integrity_score 是乘性因子

成人句子总分公式（文档明确）：

```
total_score = (0.5 × accuracy_score
             + 0.3 × fluency_score
             + 0.2 × standard_score) × integrity_score
```

篇章版为 0.6 / 0.3 / 0.1。

> ### ⚠️ 更正（后补，由真实返回反推）：**我们这一路走的是 0.6 / 0.3 / 0.1**
>
> 上面那段是**文档写的**，但拿真实返回一算对不上 —— 实际生效的是篇章权重：
>
> | 数据来源 | acc | flu | std | integrity | 实际 total | 0.5/0.3/0.2 | 0.6/0.3/0.1 |
> |---|---|---|---|---|---|---|---|
> | 真实录音（WebM，8.8s） | 88.81818 | 74.44706 | 54.59834 | 91.66666 | 74.327800 | 71.190964 (Δ-3.14) | **74.327783 (Δ-0.000017)** |
> | 同一份的 `<sentence>` 节点 | 99.12162 | 99.32672 | 100 | （该节点无此字段） | 99.271000 | 99.358826 (Δ+0.088) | **99.270988 (Δ-0.000012)** |
>
> **原因**：请求里 category 传的是 `read_sentence`，但返回的节点名是
> **`<read_chapter>`**（见 `apps/server/src/engines/xfyun.ts` 的实测记录），走的也就是篇章权重。
>
> ⭐ 教训：**「文档写着」和「实测成立」是两件事** —— 分制（结论 2）已经栽过一次，这是第二次。
>    凡是能拿真实返回算一遍的，就算一遍。
>
> ⚠️ 另：`<sentence>` 节点**没有** `integrity_score`，只有 `rec_paper` 那一层才有。

⭐ **完整度是乘性的**——准确度再高，漏读导致完整度下降会把总分成比例拉低。

**影响**：UI 上「漏读」必须与「发音不准」区别表达（灰色删除线 ≠ 红色）；本地预检第②层本质上是在保护用户不被完整度重罚。

---

## 结论 5：其他能力边界

| 能力 | 状态 |
|---|---|
| 词级 / 音节级 / 音素级检错 | ✅ 可用 |
| **分句级评分** | ✅ 可用（竞技场是句群，可展示「哪句稳、哪句弱」） |
| 行为异常检测 | ✅ **11 类** + 音质异常 |
| **实时中间结果** | ❌ **协议层不支持** |
| 音标体系 | ⚠️ **「讯飞音标」≠ 国际音标**，与 ECDICT 的 IPA 有差异 |

### 其他注意事项

- **音频格式不符会被判「乱读」，且分值不可参考**——务必严格 16k / 16bit / 单声道 PCM
- WebAPI 并发 50 路；音频时长上限约 2 分钟
- IP 白名单未配置会返回 10105 illegal client_ip
- X-CheckSum 有效期 5 分钟，需与标准时间同步
- **分词分句规则**：句末标点为 . ! ? ; ；缩写中的点号不算句末；详细规则见官方《试题格式及结果说明》

---

## 附：探针脚本用法

```bash
# 生成测试音频（macOS）
say -v Samantha -o /tmp/probe.aiff "Your test sentence here."
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/probe.aiff /tmp/probe.wav

# 跑探针
cd backend && npx dotenv -e .env -- node scripts/probe-ise-stream.cjs /tmp/probe.wav "Your test sentence here."
```

**改音频路径和文本即可验证任何关于 ISE 流式行为的假设。**
