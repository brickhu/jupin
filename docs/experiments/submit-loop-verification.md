# 实验：提交打分闭环（上传 → 讯飞 ISE → 出分）

**结论：已跑通。** 用一段真实的 16kHz 朗读音频，走小程序**完全相同**的两个端点，
拿到了真分数、真逐词时间戳和真排行榜。

| 项 | 值 |
|---|---|
| 音频 | macOS `say -v Samantha` 合成，16000Hz / 16bit / 单声道，**2.624 秒**（83978 字节裸 PCM） |
| 端点 | `POST /api/uploads`（本地直传）→ `POST /api/submissions` |
| 引擎 | `xfyun`（讯飞 ISE 流式评测，真实调用，非 mock） |
| 耗时 | **3.16 秒**（音频本身 2.62 秒） |
| 总分 | **100** |
| 逐词 | the 88.88 · best 100 · way 100 · to 99.99 …（带真实 `startMs` / `endMs`） |
| 榜单 | 排名 2 / 11 人，击败 9 人 |

## 为什么做这个实验

产品里唯一**没法在开发者工具里验证**的一环是麦克风 ——
工具返回的录音帧是满量程随机字节（见 `selftest.ts` 的 T7）。
于是「提交打分不工作」这句判断，永远分不清是**麦克风的锅**还是**后端的锅**。

这个实验把后半段单独钉死：**只要给一段合法的 16kHz PCM，后端一定出分。**

## 复现步骤

```bash
# 1. 合成参考朗读（原文必须与 articles/1.json 的 text 逐字一致）
say -v Samantha -o /tmp/jushuo.aiff "The best way to predict the future is to invent it."
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/jushuo.aiff /tmp/jushuo.wav

# 2. ⚠️ 从 WAV 里取 data 块，不能用 tail -c +45 ——
#    say 生成的 WAV 在 fmt 和 data 之间塞了 4096 字节的 LIST 元数据
python3 - <<'PY'
import struct
d = open('/tmp/jushuo.wav','rb').read()
i = 12
while i < len(d) - 8:
    cid = d[i:i+4]; size = struct.unpack('<I', d[i+4:i+8])[0]
    if cid == b'data':
        open('/tmp/jushuo.pcm','wb').write(d[i+8:i+8+size]); break
    i += 8 + size + (size & 1)
PY

# 3. 建号 → 拿 userId
BASE=http://localhost:8899
curl -s -H 'x-wx-source: devtools' -H 'x-wx-openid: dev_claude' $BASE/api/user/me

# 4. 上传 → 提交（audioKey 形如 audio/{articleId}/{userId}/{ts}.pcm）
curl -s -X POST $BASE/api/uploads \
  -H 'x-wx-source: devtools' -H 'x-wx-openid: dev_claude' \
  -F "articleId=1" -F "audioKey=$KEY" -F "file=@/tmp/jushuo.pcm"

curl -s -X POST $BASE/api/submissions \
  -H 'x-wx-source: devtools' -H 'x-wx-openid: dev_claude' \
  -H 'content-type: application/json' \
  -d "{\"articleId\":1,\"audioKey\":\"$KEY\"}"
```

⚠️ 本地联调账号的 openid 用 `dev_` 前缀，然后跑 `pnpm dev:unlock` 开会员绕开冷却。
`x-wx-source` / `x-wx-openid` 这两个 header 只在**本机**有效 ——
线上是微信网关注入的，公网请求带不上（见 `middleware/auth.ts`，那是本项目唯一的安全要害）。

## 没被这个实验覆盖的

- **麦克风**：设备到底给什么采样率、什么字节率、什么格式 —— 只能真机测（真机自检 T1–T4 / T7）。
- **小程序端的上传通道**：本实验直接打 HTTP，没走 `wx.uploadFile` 的进度回调与真机文件系统。
- **压测**：单次调用，没有并发/超时/重试的表现数据。
