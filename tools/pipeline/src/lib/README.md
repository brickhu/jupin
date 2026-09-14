# lib/

外部依赖的封装。每个文件对应一个外部服务：

| 文件 | 服务 | 用途 |
|---|---|---|
| fishaudio.ts | fish-audio | 标准音 TTS + **词级时间戳** |
| ecdict.ts | ECDICT（MIT，76 万词条） | 音标 / 词性 / 义项 / 词形变化 |
| llm.ts | DeepSeek 等 | 翻译、难度定级、释义选择、技巧润色 |
| cos.ts | 腾讯云 COS | 产物上传 + CDN 刷新 |

⚠️ 全部需要加缓存层：同一步骤重复跑不应重复调用外部 API。
