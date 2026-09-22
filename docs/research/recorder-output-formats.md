# 录音 API 的产出格式：**文件 ≠ 帧**

> 一句话：`onFrameRecorded` 的帧和 `tempFilePath` 的文件是**两样东西**，
> 格式可以完全不同 —— 而且**只有文件会被上传**。

| | `onFrameRecorded` 的帧 | `tempFilePath` 的**文件** |
|---|---|---|
| 开发者工具 | 压缩块（当 PCM 读：过零率 ≈0.50、RMS -4.8dB） | **WebM / Opus / 48kHz —— 货真价实的麦克风录音** |
| 真机 | 裸 PCM | 裸 PCM（`format:'PCM'` 直出无头） |

## 这个误判的代价

**第一次**：看到帧的过零率 0.50、RMS 恰好 -4.8dB（= 1/√3），判定「开发者工具给的不是可用音频」。
这个结论**对帧是对的**。

**第二次（要命）**：据此认为整个**录音**都是垃圾，于是把所有注意力放在「工具没有麦克风通路」上。
而真相是：**工具一直在正常录音**，只是产出一个 WebM 容器。
「本地录音 → 提交打分」跑不通的根因在**服务端** —— 它把 WebM 容器当成裸 PCM 喂给了讯飞。

## 实测证据

取证对象是`.uploads/audio/1/36/1789465897824.pcm` —— 就是小程序当年上传的那一份文件，未做任何处理：

```
前 12 字节   1a45 dfa3 9f42 8681 0142 f781 0142 f281     → EBML 头
DocType      webm        Muxer: Chrome      Codec: A_OPUS
ffprobe      codec_name=opus  sample_rate=48000  channels=1  format_name=matroska,webm
解码后       8.82 秒 · RMS -27.0dB · 峰值 0.632 · **过零率 0.156**
```

判定基线（本项目实测）：
- 真实语音 → 过零率 **0.03~0.15**，RMS < -14dB ← **0.156 落在这里**
- 压缩字节被当成 PCM 读 → 过零率 ≈ **0.50**，RMS ≈ **-4.8dB**

解码后直接喂讯飞：**总分 74**，逐词 `best=92.7 way=100 to=100 predict=69.7 future=89.5 is=99.9 invent=88.6 it=84.0`，
首词 `the=0 (omission)` —— 录音起头偏晚，第一个词被切掉了。这是**真实朗读**才有的分数分布。

## 修法：归一化放在服务端

`apps/server/src/services/audio.ts`：

1. `sniffAudioContainer(bytes)` 只认 magic（EBML / RIFF / OggS / fLaC / ID3 / ftyp / MPEG 同步），
   兜底才是 `raw-pcm` —— 因为真机链路**没有任何 magic**，它只能是兜底。
2. 裸 PCM **原样返回**（同一个引用），真机链路零开销。
3. 其余容器交给 `ffmpeg` 解码 + 重采样成 16kHz/16bit/单声道（走 stdin/stdout 管道，不落磁盘）。

⭐ **为什么放服务端而不是小程序端**：设备产出什么格式，客户端说了不算 ——
同一份代码，真机直出裸 PCM，开发者工具直出 WebM，将来还可能出 mp3/aac。
在唯一装得起解码器的地方统一，整条链路对「设备给了什么」就彻底免疫了。

⚠️ 镜像必须装 ffmpeg（`apps/server/Dockerfile` 与 `Dockerfile.development` 都已加）。
缺了会报一句**指名道姓**的错误，而不是含糊的「读取音频失败」。

## 已知残余问题

- **慢**：8.82 秒的音频从提交到出分要 **10 秒** —— 讯飞是流式接口，目前按实时速率推帧
  （`FRAME_INTERVAL_MS = 40`）。这是用户在「付款时刻」要等的时长，值得单独优化。
- **裸 MPEG 同步的判据不是绝对可靠**：`FF FF 10` 这类字节串既能当 PCM（-1, 16）
  也能通过 mp3 的字段校验。见 `services/audio.ts` 里如实记录的残余风险。

## 录音与存档格式：**mp3**（压缩与「有麦克风帧」的唯一交集）

> 一句话：`pcm` 有帧但太大，`aac` 小但**拿不到帧**，`mp3` 两个都有。

| format | 体积（20 秒） | `frameSize` 帧回调 | 结论 |
| --- | --- | --- | --- |
| pcm | ~640 KB | ✅ | 波形能做，体积太大 |
| aac（接口默认值） | ~120 KB | ❌「暂仅支持 mp3、pcm 格式」 | 体积小，但**实时波形没有数据源** |
| **mp3** | **~120 KB** | ✅ | ⭐ 选它 |

⚠️ 接口默认值是 aac，但那**不是**决定因素：默认值只保证了编码器/容器/播放支持，
而 aac 会把「麦克风到底收到我的声音没有」这个用户唯一能自查的东西一起丢掉。

### 「引擎要 PCM」不是理由

「引擎要 PCM」这条**不成立**：服务端本来就会把上传的音频解码成 16k/16bit/单声道裸 PCM
再喂讯飞（`services/audio.ts` 的 `normalizeAudio`）。实测（同一次 7.3 秒录音）：

| 上传的容器 | sniff 结果 | 解码耗时 | 解出的 16k PCM |
| --- | --- | --- | --- |
| `.aac`（ADTS，Android 常见） | `aac` | 33 ms | 235 KB |
| `.m4a`（MP4 容器，iOS 常见） | `mp4` | 29 ms | 232 KB |
| `.mp3` | `mp3` | 36 ms | 232 KB |
| WebM/Opus（开发者工具） | `webm` | — | — |
| 裸 PCM（老客户端） | `raw-pcm` | 0（原样） | — |

所以格式这件事**只影响三处**，跟打分无关：上传体积、存储体积、能不能直接播。

### 一次 20 秒挑战的体积

| 形态 | 大小 | 说明 |
| --- | --- | --- |
| 裸 PCM 16k/16bit/单声道 | 640 KB | 老方案上传的就是它，播放器还放不出来 |
| **mp3 48kbps（现在的上传 = 存档）** | **~120 KB** | 压缩的，而且**有帧回调** |
| 服务端给遗留格式补的 mp3 32kbps | ~80 KB | 只在遇到 PCM/WebM 时才生成 |

⭐ 于是链路变成：**上传即存档** —— 服务端不转码、不删原件、也不再存第二份。
（`services/recording.ts` 的 `archiveRecording` 遇到 aac/mp3/m4a 直接返回 null。）
遗留的裸 PCM / WebM 才补一道 mp3：转码发生在**分数落库之后**，失败只 warn，
不影响任何一条成绩。

⚠️ 打分不受压缩影响：引擎喂的是**解码出来的** PCM（mp3 实测 36ms 解出 232KB）。
48kbps 有损对发音特征的影响可忽略 —— 但这条残余风险如实记在这里，不假装没有。

### 帧里装的是什么：**mp3 分片**，靠平台解码器取振幅

⚠️ 官方文档对 `frameBuffer` 只写了「录音分片数据」四个字。实情是：
`format:'mp3'` 时帧里装的就是 **mp3 码流**，不是采样。

**怎么拿振幅 —— 平台自带解码器，不用自己写。**
小程序有一个兼容 Web 的 `WebAudioContext`（`wx.createWebAudioContext()`），
它的 `decodeAudioData` 能把这段 mp3 分片直接解成采样：

```js
const audioCtx = wx.createWebAudioContext()
recorder.onFrameRecorded((res) => {
  audioCtx.decodeAudioData(res.frameBuffer, (buffer) => {
    const samples = buffer.getChannelData(0) // 或走 analyser.getByteTimeDomainData
    // → 峰值柱 / 强度
  })
})
```

⭐ 出处：掘金《微信小程序实现实时录音音频强度输出》
（https://juejin.cn/post/7325246251460460596 ）—— 作者把这条路走通了，
本项目照它的思路实现（`lib/audio/frame-decode.ts`）。它里面几条经验值得记住：

- 那条路**只在真机上成立**：作者原文「在微信开发者工具上直接运行都不运行了，
  真机上试了一下，成了」。⇒ 代码必须把「解不出来」当成正常分支，不能假设它总能解。
- 用 `format:'mp3'` + `frameSize: 1`（1KB ≈ 170ms 音频，2KB 会有明显顿挫）。
- `source.connect(analyser)`，**不要** connect 到 destination —— 那会边录边外放。
- 强度公式 `(max-min)/128*100/2`（0..255 时域数据）＝ `(max-min)/2*100`（-1..1 采样），
  已落在 `@jushuo/shared` 的 `intensityOf` 里。

**代码里的三条退路**（`reading.ts` 的 `handleFrame`）：

1. 解得出采样 → 照画（真机上的正常路径）；
2. 解不出来、而这一片本来就是裸 PCM → 按 16bit 小端读着画；
3. 解不出来、而这一片是编码块 → **停掉波形**并写一行说明。

⛔ 绝不拿压缩字节当振幅画柱子：那会得到一条满量程、一动不动的假波形
（这个坑本项目踩过，见上文「文件 ≠ 帧」）。

⚠️ 也**试过**更省事的路：从 mp3 帧头里读 `global_gain`（量化增益）当音量代理，
不用解码。拿一段真实录音实测，它与真实 RMS 包络的相关系数只有 **-0.06** ——
完全不成立，已放弃。结论：帧是 mp3 码流时，除了解码没有别的办法拿到振幅。

⚠️ 顺带简化掉的一件事：**试听不再需要「帧拼 WAV」**。
以前真机落盘的是裸 PCM、播放器不认，只能拿帧自己造一个 WAV；
现在落盘的就是 mp3，两个平台都能直接播（老缓存仍走那条备用逻辑）。

