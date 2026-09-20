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
