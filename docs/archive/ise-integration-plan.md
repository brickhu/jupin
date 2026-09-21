# 句拼 · 科大讯飞 ISE 语音评测 API 对接技术方案

> 文档版本：v1.0 · 2026-06-28 · 作者：fei

---

## 一、方案概述

### 1.1 选型结论

**主选：科大讯飞 ISE 流式版（WebSocket）**，替代原方案 Azure Speech。核心依据：
- 成本更低：单次 ¥0.004（套餐二），约 Azure 的 40%
- 教育场景权威：四六级/中高考同源技术
- 国内直连，支付宝购买，开通门槛低
- 7 大评分维度 + 音节/音素级纠错粒度，满足产品需求
- 10 万次免费额度（企业认证）支撑冷启动

### 1.2 整体架构

```
┌─────────────────┐     ┌──────────────────────────────┐     ┌─────────────────┐
│  前端 (SolidJS) │────▶│  后端 (Express.js + Node.js) │────▶│  讯飞 ISE API   │
│  - 录音 (WAV)   │◀────│  - 鉴权 URL 生成             │◀────│  wss://ise-api  │
│  - 音频上传     │     │  - 音频转发 (WebSocket)      │     │  .xfyun.cn      │
│  - 结果展示     │     │  - XML → JSON 解析           │     └─────────────────┘
└─────────────────┘     │  - 评分存储 + 能力分计算      │
                        └──────────────────────────────┘
```

---

## 二、API 基础信息

### 2.1 连接地址

| 项 | 值 |
|---|---|
| 协议 | `wss://`（WebSocket Secure） |
| Host | `ise-api.xfyun.cn` |
| 路径 | `/v2/open-ise` |
| 完整 URL 模板 | `wss://ise-api.xfyun.cn/v2/open-ise?authorization={auth}&date={date}&host={host}` |

### 2.2 鉴权方式（HMAC-SHA256 签名）

每次 WebSocket 连接需在 URL query 中携带三个鉴权参数，均需 **Base64 编码 + URL 编码**：

**步骤：**

1. 生成 RFC1123 格式 GMT 时间：
   ```
   date = "Tue, 28 Jun 2026 06:29:31 GMT"
   ```

2. 构造签名字符串（注意换行符 `\n`）：
   ```
   signature_origin = "host: ise-api.xfyun.cn\ndate: {date}\nGET /v2/open-ise HTTP/1.1"
   ```

3. 用 API_SECRET 对签名字符串做 HMAC-SHA256，结果 Base64 编码得到 `signature`

4. 构造 Authorization 字符串：
   ```
   authorization = 'api_key="{API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="{signature}"'
   ```

5. 对 `authorization`、`date`、`host` 分别做 Base64 编码，再做 URL 编码（`encodeURIComponent`）

6. 拼接最终 URL：
   ```
   wss://ise-api.xfyun.cn/v2/open-ise?authorization={urlEncodedAuth}&date={urlEncodedDate}&host={urlEncodedHost}
   ```

### 2.3 从控制台获取的凭证

| 凭证 | 说明 | 环境变量名 |
|---|---|---|
| APP_ID | 应用 ID | `XFYUN_APP_ID` |
| API_KEY | 接口密钥 | `XFYUN_API_KEY` |
| API_SECRET | 接口密钥（用于签名） | `XFYUN_API_SECRET` |

---

## 三、通信协议

### 3.1 交互流程

```
Client                                    Server
  │                                         │
  │──── WebSocket Connect (带鉴权URL) ────▶│
  │◀─────── 连接建立 (101 Switching) ──────│
  │                                         │
  │──── Frame 1: 初始化帧 (JSON) ─────────▶│  (cmd: "ssb", 携带文本+参数)
  │◀─────── 确认响应 ──────────────────────│
  │                                         │
  │──── Frame 2..N: 音频帧 (二进制 PCM) ──▶│  (每帧 40ms, status=1)
  │◀─────── 中间结果 (可选) ───────────────│
  │                                         │
  │──── Frame N+1: 结束帧 (JSON) ─────────▶│  (status=2)
  │◀─────── 最终评测结果 (XML) ────────────│
  │                                         │
  │──── WebSocket Close ──────────────────▶│
```

### 3.2 帧类型说明

| 帧类型 | 方向 | 内容格式 | 说明 |
|---|---|---|---|
| 初始化帧 | Client → Server | JSON | 评测配置 + 参考文本 |
| 音频帧 | Client → Server | Binary (PCM) | 16kHz 16bit 单声道原始音频 |
| 结束帧 | Client → Server | JSON | 标记音频发送完毕 |
| 结果帧 | Server → Client | JSON (含XML) | 评测结果，最终帧包含完整 XML |

---

## 四、参数详解

### 4.1 初始化帧（business 字段）

```json
{
  "common": {
    "app_id": "YOUR_APP_ID"
  },
  "business": {
    "aue": "raw",
    "auf": "audio/L16;rate=16000",
    "category": "read_sentence",
    "cmd": "ssb",
    "ent": "en_vip",
    "sub": "ise",
    "text": "<BASE64_ENCODED_TEXT>",
    "ttp_skip": true,
    "extra_ability": "multi_dimension"
  },
  "data": {
    "status": 0
  }
}
```

**字段说明：**

| 参数 | 取值 | 说明 |
|---|---|---|
| `aue` | `"raw"` | 音频编码：原始 PCM（推荐） |
| `auf` | `"audio/L16;rate=16000"` | 音频格式：16bit PCM，16kHz 采样率 |
| `category` | 见下表 | 评测题型 |
| `cmd` | `"ssb"` | 命令字，固定值 |
| `ent` | `"en_vip"` | 英文评测引擎（流式版）；中文用 `cn_vip` |
| `sub` | `"ise"` | 业务类型，固定值 |
| `text` | Base64 字符串 | 待评测文本（UTF-8 编码后 Base64） |
| `ttp_skip` | `true` | 跳过文本处理（流式传输时使用） |
| `extra_ability` | `"multi_dimension"` | 返回全维度评分（推荐开启） |
| `data.status` | `0` | 首帧标记 |

**category 题型选择：**

| 值 | 题型 | 句拼场景 |
|---|---|---|
| `read_sentence` | 句子朗读 | ⭐ **MVP 主力场景**（短句 5-50 词） |
| `read_word` | 单字/单词 | 单词练习 |
| `read_chapter` | 篇章朗读 | 长文练习（扩展） |
| `read_syllable` | 音节 | 暂不使用 |

### 4.2 音频帧

| 属性 | 要求 |
|---|---|
| 格式 | PCM 原始数据（无 WAV 头） |
| 采样率 | 16000 Hz |
| 位深 | 16 bit |
| 声道 | 单声道（mono） |
| 字节序 | 小端序（Little Endian） |
| 每帧大小 | **640 字节 = 320 samples × 2 bytes**（对应 20ms） |
| 推荐帧间隔 | 20ms-40ms |
| 发送方式 | 二进制帧（WebSocket binary frame） |

**前端录音配置对应：**
```javascript
// MediaRecorder 配置（注意：MediaRecorder 默认不输出 raw PCM）
// 推荐使用 Web Audio API + AudioWorklet 直接获取 PCM
const audioConstraints = {
  sampleRate: 16000,
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true
};
```

### 4.3 结束帧

```json
{
  "business": {
    "cmd": "ssb",
    "aus": 4
  },
  "data": {
    "status": 2
  }
}
```

---

## 五、返回结果解析

### 5.1 响应结构

服务端返回 JSON，评测结果在 `data.data` 字段中（XML 格式字符串）：

```json
{
  "code": 0,
  "message": "success",
  "sid": "ise0001xxxxxx",
  "data": {
    "status": 2,
    "data": "<read_sentence>...</read_sentence>"   // ← XML 评测结果
  }
}
```

**status 含义：**
- `0`：连接确认
- `1`：中间结果（可忽略，等最终结果）
- `2`：最终结果（包含完整 XML）

### 5.2 XML 结果结构（英文 read_sentence）

```xml
<read_sentence>
  <rec_paper>
    <read_sentence>
      <!-- 总分 -->
      <total_score>85.5</total_score>
      
      <!-- 句子级维度分 -->
      <accuracy_score>82.0</accuracy_score>
      <fluency_score>88.0</fluency_score>
      <integrity_score>90.0</integrity_score>
      <tone_score>83.0</tone_score>
      <is_rejected>false</is_rejected>
      
      <!-- 单词列表 -->
      <word>
        <content>When</content>
        <total_score>90</total_score>
        <syll>
          <content>w</content>
          <total_score>95</total_score>
          <!-- 音素级 -->
          <phone>
            <content>w</content>
            <total_score>95</total_score>
            <mono_tone>0</mono_tone>
          </phone>
        </syll>
        <syll>
          <content>ɛn</content>
          <total_score>88</total_score>
          <phone>
            <content>ɛ</content>
            <total_score>85</total_score>
          </phone>
          <phone>
            <content>n</content>
            <total_score>90</total_score>
          </phone>
        </syll>
      </word>
      
      <!-- 更多 word 节点... -->
    </read_sentence>
  </rec_paper>
</read_sentence>
```

### 5.3 核心字段映射到句拼评分

| 讯飞字段 | 句拼用途 | 免费用户可见 | 付费用户可见 |
|---|---|---|---|
| `total_score` | 整体质量分 Q（0-100） | ✅（用于计算 P 和 H） | ✅ |
| `accuracy_score` | 准确度分 | ❌ | ✅ |
| `fluency_score` | 流利度分 | ❌ | ✅ |
| `integrity_score` | 完整度分 | ❌ | ✅ |
| `tone_score` | 韵律/语调分 | ❌ | ✅ |
| `word[].content` | 单词文本 | ❌ | ✅ |
| `word[].total_score` | 单词总分 | ❌ | ✅（单词高亮） |
| `word[].syll[].phone[]` | 音素级评分 | ❌ | ✅（音素标注） |

**能力分 P 计算：**
```javascript
// Q = total_score（讯飞返回的0-100分，直接作为质量分）
// D = 文章难度系数（预计算）
// P_new = P + K × (Q - S(P, D))  （见 scoring-system.md）
```

---

## 六、后端实现方案

### 6.1 依赖安装

```bash
cd backend
npm install ws crypto-js fast-xml-parser
npm install -D @types/ws @types/crypto-js
```

| 包 | 用途 |
|---|---|
| `ws` | WebSocket 客户端（Node.js 连接讯飞） |
| `crypto-js` | HMAC-SHA256 签名（Node 18+ 也可用内置 `crypto`） |
| `fast-xml-parser` | XML → JSON 解析 |

### 6.2 核心模块设计

```
backend/src/
├── services/
│   └── ise/
│       ├── index.ts           # 导出 IseService
│       ├── auth.ts            # 鉴权 URL 生成
│       ├── client.ts          # WebSocket 客户端封装
│       ├── parser.ts          # XML 结果解析
│       └── types.ts           # TypeScript 类型定义
├── routes/
│   └── assessment.ts          # 评分 API 路由
└── middleware/
    └── rateLimit.ts           # 限流（免费5次/付费500次）
```

### 6.3 鉴权 URL 生成 (`auth.ts`)

```typescript
import crypto from 'crypto';

const APP_ID = process.env.XFYUN_APP_ID!;
const API_KEY = process.env.XFYUN_API_KEY!;
const API_SECRET = process.env.XFYUN_API_SECRET!;

const HOST = 'ise-api.xfyun.cn';
const PATH = '/v2/open-ise';

export function generateAuthUrl(): string {
  // RFC1123 GMT 时间
  const date = new Date().toUTCString();

  // 构造签名字符串
  const signatureOrigin = `host: ${HOST}\ndate: ${date}\nGET ${PATH} HTTP/1.1`;

  // HMAC-SHA256 签名
  const signature = crypto
    .createHmac('sha256', API_SECRET)
    .update(signatureOrigin, 'utf8')
    .digest('base64');

  // Authorization 字符串
  const authorization =
    `api_key="${API_KEY}", ` +
    `algorithm="hmac-sha256", ` +
    `headers="host date request-line", ` +
    `signature="${signature}"`;

  // Base64 + URL 编码
  const encode = (s: string) =>
    encodeURIComponent(Buffer.from(s, 'utf8').toString('base64'));

  return `wss://${HOST}${PATH}?authorization=${encode(authorization)}&date=${encode(date)}&host=${encode(HOST)}`;
}
```

### 6.4 WebSocket 客户端封装 (`client.ts`)

```typescript
import WebSocket from 'ws';
import { generateAuthUrl } from './auth';
import { parseIseResult } from './parser';
import type { IseConfig, IseResult } from './types';

export interface AssessOptions {
  text: string;           // 待评测文本（英文句子）
  audioBuffer: Buffer;    // PCM 音频数据（16kHz/16bit/mono）
  category?: 'read_sentence' | 'read_word' | 'read_chapter';
  onProgress?: (partial: any) => void;
}

export async function assessPronunciation(opts: AssessOptions): Promise<IseResult> {
  const { text, audioBuffer, category = 'read_sentence' } = opts;
  const url = generateAuthUrl();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let finalXml = '';
    let settled = false;

    const done = (err?: Error, result?: IseResult) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve(result!);
    };

    ws.on('open', () => {
      // 1. 发送初始化帧
      const initFrame = JSON.stringify({
        common: { app_id: process.env.XFYUN_APP_ID },
        business: {
          aue: 'raw',
          auf: 'audio/L16;rate=16000',
          category,
          cmd: 'ssb',
          ent: 'en_vip',
          sub: 'ise',
          text: Buffer.from(text, 'utf8').toString('base64'),
          ttp_skip: true,
          extra_ability: 'multi_dimension',
        },
        data: { status: 0 },
      });
      ws.send(initFrame);

      // 2. 分片发送音频（每帧 1280 字节 = 40ms）
      const FRAME_SIZE = 1280;
      let offset = 0;
      const sendNext = () => {
        if (offset >= audioBuffer.length) {
          // 3. 发送结束帧
          const endFrame = JSON.stringify({
            business: { cmd: 'ssb', aus: 4 },
            data: { status: 2 },
          });
          ws.send(endFrame);
          return;
        }
        const end = Math.min(offset + FRAME_SIZE, audioBuffer.length);
        const chunk = audioBuffer.slice(offset, end);
        ws.send(chunk, { binary: true });
        offset = end;
        // 控制发送节奏，模拟实时
        setTimeout(sendNext, 40);
      };
      sendNext();
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.code !== 0) {
          done(new Error(`ISE Error ${msg.code}: ${msg.message}`));
          return;
        }
        if (msg.data?.data) {
          finalXml += msg.data.data;
        }
        if (msg.data?.status === 2) {
          // 最终结果
          const result = parseIseResult(finalXml);
          done(undefined, result);
        }
      } catch (e) {
        done(e as Error);
      }
    });

    ws.on('error', (err) => done(err));
    ws.on('close', (code) => {
      if (!settled) done(new Error(`WebSocket closed unexpectedly: ${code}`));
    });

    // 超时保护（30秒）
    setTimeout(() => done(new Error('ISE request timeout')), 30000);
  });
}
```

### 6.5 XML 解析 (`parser.ts`)

```typescript
import { XMLParser } from 'fast-xml-parser';

export interface WordScore {
  word: string;
  score: number;
  syllables: {
    syll: string;
    score: number;
    phones: { phone: string; score: number }[];
  }[];
}

export interface IseResult {
  totalScore: number;       // 总分 (Q，0-100)
  accuracyScore: number;    // 准确度
  fluencyScore: number;     // 流利度
  integrityScore: number;   // 完整度
  toneScore: number;        // 语调/韵律
  words: WordScore[];       // 单词级评分
  rejected: boolean;        // 是否被拒（如无有效语音）
}

const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  parseTagValue: true,
  isArray: (name) => ['word', 'syll', 'phone'].includes(name),
});

export function parseIseResult(xml: string): IseResult {
  const obj = parser.parse(xml);
  const paper = obj?.read_sentence?.rec_paper?.read_sentence;
  if (!paper) {
    throw new Error('Invalid ISE XML result: missing rec_paper');
  }

  const toNum = (v: any, d = 0): number => {
    const n = Number(v);
    return isNaN(n) ? d : n;
  };

  const words: WordScore[] = (paper.word || []).map((w: any) => ({
    word: String(w.content || ''),
    score: toNum(w.total_score),
    syllables: (w.syll || []).map((s: any) => ({
      syll: String(s.content || ''),
      score: toNum(s.total_score),
      phones: (s.phone || []).map((p: any) => ({
        phone: String(p.content || ''),
        score: toNum(p.total_score),
      })),
    })),
  }));

  return {
    totalScore: toNum(paper.total_score),
    accuracyScore: toNum(paper.accuracy_score),
    fluencyScore: toNum(paper.fluency_score),
    integrityScore: toNum(paper.integrity_score),
    toneScore: toNum(paper.tone_score),
    words,
    rejected: paper.is_rejected === 'true',
  };
}
```

### 6.6 API 路由 (`routes/assessment.ts`)

```typescript
import { Router } from 'express';
import { assessPronunciation } from '../services/ise/client';
import { checkRateLimit } from '../middleware/rateLimit';
import { calculateScores } from '../services/scoring/engine';
import { authenticate } from '../middleware/auth';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/**
 * POST /api/assess
 * Body: multipart/form-data
 *   - audio: WAV/PCM 音频文件
 *   - article_id: 文章 ID（用于获取参考文本和难度 D）
 * 返回: 评分结果（根据用户是否付费决定返回粒度）
 */
router.post(
  '/assess',
  authenticate,
  checkRateLimit,
  upload.single('audio'),
  async (req, res) => {
    const userId = req.user!.id;
    const { article_id } = req.body;
    const audioFile = req.file;

    if (!audioFile) return res.status(400).json({ error: '缺少音频文件' });
    if (!article_id) return res.status(400).json({ error: '缺少 article_id' });

    // 1. 获取文章参考文本和难度 D
    const article = await db.getArticle(article_id);
    if (!article) return res.status(404).json({ error: '文章不存在' });

    // 2. 将 WAV 转为 PCM（如果前端传 WAV，需去掉 44 字节头）
    const pcmData = audioFile.buffer.slice(44); // WAV header = 44 bytes

    // 3. 调用讯飞 ISE
    const iseResult = await assessPronunciation({
      text: article.text,
      audioBuffer: pcmData,
      category: 'read_sentence',
    });

    if (iseResult.rejected) {
      return res.status(400).json({ error: '未检测到有效语音，请重新朗读' });
    }

    // 4. 计算荣誉分 H 和能力分 P
    const { H_total, P_new } = await calculateScores(userId, iseResult.totalScore, article.difficulty);

    // 5. 根据用户付费状态决定返回内容
    const isPaid = await db.isUserPaid(userId);

    const response = {
      honorScore: Math.round(H_total),
      proficiencyScore: Math.round(P_new),
      // 付费用户才返回详细评分
      ...(isPaid && {
        qualityScore: iseResult.totalScore,
        accuracyScore: iseResult.accuracyScore,
        fluencyScore: iseResult.fluencyScore,
        integrityScore: iseResult.integrityScore,
        toneScore: iseResult.toneScore,
        words: iseResult.words,
      }),
    };

    // 6. 保存评分记录
    await db.saveRecording({
      user_id: userId,
      article_id,
      quality_score: iseResult.totalScore,
      audio_path: audioFile.filename,
      ise_raw_xml: iseResult, // 可保存原始结果用于调试
      is_paid_session: isPaid,
    });

    res.json(response);
  }
);

export default router;
```

---

## 七、前端录音实现（SolidJS）

### 7.1 录音工具类（获取 PCM 数据）

前端不直接用 MediaRecorder（输出 webm/opus），而是用 **Web Audio API + AudioWorklet** 获取原始 PCM：

```typescript
// src/utils/audioRecorder.ts
export class AudioRecorder {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private pcmChunks: Int16Array[] = [];
  private sampleRate = 16000;

  async start(): Promise<void> {
    this.pcmChunks = [];

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: this.sampleRate,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
    this.source = this.audioContext.createMediaStreamSource(this.stream);

    // ScriptProcessor（兼容性更好；生产可用 AudioWorklet）
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.pcmChunks.push(int16);
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  async stop(): Promise<Blob> {
    if (this.processor) this.processor.disconnect();
    if (this.source) this.source.disconnect();
    if (this.audioContext) await this.audioContext.close();
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());

    // 合并所有 PCM 块
    const totalLength = this.pcmChunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Int16Array(totalLength);
    let offset = 0;
    for (const chunk of this.pcmChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    // 添加 WAV 头
    const wavBuffer = this.encodeWAV(merged);
    return new Blob([wavBuffer], { type: 'audio/wav' });
  }

  private encodeWAV(samples: Int16Array): ArrayBuffer {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    const writeStr = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, this.sampleRate, true);
    view.setUint32(28, this.sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    for (let i = 0; i < samples.length; i++) {
      view.setInt16(44 + i * 2, samples[i], true);
    }

    return buffer;
  }
}
```

### 7.2 SolidJS 组件中使用

```tsx
// src/components/RecordingButton.tsx
import { createSignal } from 'solid-js';
import { AudioRecorder } from '../utils/audioRecorder';

export function RecordingButton(props: { articleId: string; onResult: (r: any) => void }) {
  const [recording, setRecording] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  let recorder: AudioRecorder | null = null;

  const start = async () => {
    recorder = new AudioRecorder();
    await recorder.start();
    setRecording(true);
  };

  const stop = async () => {
    if (!recorder) return;
    setRecording(false);
    setLoading(true);
    const wavBlob = await recorder.stop();

    const formData = new FormData();
    formData.append('audio', wavBlob, 'recording.wav');
    formData.append('article_id', props.articleId);

    const res = await fetch('/api/assess', {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      body: formData,
    });
    const data = await res.json();
    props.onResult(data);
    setLoading(false);
  };

  return (
    <button
      class="record-btn"
      classList={{ recording: recording(), loading: loading() }}
      onClick={recording() ? stop : start}
      disabled={loading()}
    >
      {loading() ? '评分中...' : recording() ? '停止朗读' : '开始朗读'}
    </button>
  );
}
```

---

## 八、限流配置

### 8.1 免费用户 vs 付费用户

```typescript
// middleware/rateLimit.ts
import rateLimit from 'express-rate-limit';

export const checkRateLimit = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24小时
  max: (req) => {
    // 根据用户类型返回配额
    return req.user?.isPro ? 500 : 5;
  },
  keyGenerator: (req) => `assess:${req.user!.id}`,
  message: { error: '今日评分次数已用完，升级 Pro 获取更多次数' },
  standardHeaders: true,
});
```

**注意：** 单篇解锁（¥0.99/篇）不占用免费额度，需在解锁后标记该次请求为"已解锁"跳过限流。

---

## 九、成本测算

### 9.1 套餐购买建议

| 阶段 | 用户规模 | 推荐套餐 | 月均成本 | 说明 |
|---|---|---|---|---|
| 冷启动（0-3月） | <100 人 | **免费 10 万次**（企业认证） | ¥0 | 90 天足够验证 |
| 早期（3-6月） | 100-500 人 | **套餐二：150 万次/年 ¥5,800** | ¥483 | 覆盖 ~400 Pro 用户 |
| 成长期（6-12月） | 500-2000 人 | 套餐三：750 万次/年 ¥27,000 | ¥2,250 | 覆盖 ~2000 Pro 用户 |

### 9.2 单次成本与定价关系

| 定价 | 单次成本 | 毛利率 |
|---|---|---|
| ¥0（免费用户，5次/日） | ¥0.004 | -100%（获客成本） |
| ¥0.99/篇 解锁 | ¥0.004 | **99.6%** |
| ¥29/月 Pro | ~¥0.77（按日均 500 次 × 30天 × ¥0.004） | **97.3%** |
| ¥199/年 Pro | ~¥9.2（同上 × 12月） | **95.4%** |

> 语音 API 成本占订阅收入的 3-5%，毛利率非常健康。

---

## 十、错误处理与容错

### 10.1 常见错误码

| 错误码 | 含义 | 处理方式 |
|---|---|---|
| 401 | 鉴权失败 | 检查时间同步、API_KEY/SECRET 是否正确 |
| 403 | 权限不足 | 检查 ISE 服务是否开通、套餐是否有效 |
| 48195 (8195) | 音频数据错误 | 检查 PCM 格式是否正确（采样率/位深/声道） |
| 10105 | 并发超限 | 套餐并发不足，提示稍后重试或升级 |
| 11200 | 无权限 | 检查 app_id 与 API_KEY 是否匹配 |
| 10114 | 音频时长超限 | 单次录音建议不超过 60 秒 |
| 10160 | 请求解析错误 | 检查 JSON 格式、text 是否正确 Base64 |

### 10.2 容错策略

1. **鉴权失败（401）自动重试 1 次**：可能是时间偏差，重新生成签名
2. **网络超时（30s）**：前端提示"网络不稳定，请重试"
3. **音频格式错误**：前端加强 WAV→PCM 转换校验
4. **服务不可用**：降级提示"评分服务暂时繁忙"，不阻塞用户朗读练习
5. **结果解析失败**：保存原始 XML 到日志，异步告警

---

## 十一、安全注意事项

1. **API 密钥只存后端**：前端**绝不**接触 API_KEY/SECRET，鉴权 URL 在后端生成
2. **音频文件存储**：用户录音文件存 OSS，设置生命周期规则（90 天后自动删除）
3. **鉴权 URL 有效期**：生成后立即使用，不要缓存（签名有时效性）
4. **HTTPS 强制**：前后端通信全程 HTTPS，防止音频数据被窃听
5. **音频大小限制**：后端限制上传文件 ≤ 5MB（约 5 分钟 16kHz PCM）

---

## 十二、上线 Checklist

- [ ] 注册讯飞开放平台账号，完成企业认证
- [ ] 创建应用，开通"语音评测（流式版）"服务
- [ ] 领取 10 万次免费额度
- [ ] 将 APP_ID / API_KEY / API_SECRET 配置到后端环境变量
- [ ] 后端实现 `services/ise/` 模块（auth + client + parser）
- [ ] 前端实现 AudioRecorder，输出 16kHz/16bit/mono WAV
- [ ] 联调：录音 → 上传 → 评分 → 结果展示
- [ ] 验证免费用户只返回两个分数，付费用户返回全维度
- [ ] 压测：模拟 20 并发评分请求（免费套餐并发上限）
- [ ] 配置日志监控：错误率、平均响应时间、成本消耗
- [ ] 购买套餐二（¥5,800/150万次）备用，防止免费额度耗尽
