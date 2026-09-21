# 句拼 · 项目入口

> **每次开始任务前先读本文件。**
> 前四节是必读；工程细节（仓库结构 / 调试 / 部署）按需查阅。

---

## 一句话

**句拼 —— 每日英语朗读竞技场。**
英文朗读大比拼，AI 评分冲排名。

每天一句，全站同题：读同一段文本、比同一个分数，排名天然公平。
读完当天这一句就算一天**连续**（Streak），断了会用冻结卡自动补上。

产品的全部就是三条：**AI 反馈的得分 · 排名 · Streak**（含由 Streak 推导的等级徽章）。
难度、分类、积分、关卡都刻意不做 —— 每加一条，用户就多一个要理解的概念。

> ⚠️ 定位文案的唯一来源是 [packages/shared/src/brand.ts](packages/shared/src/brand.ts)，
> 本文件与小程序页面都从那里取，不要各抄一份。

---

## 仓库与分支（开工前第一件事）

远端：<https://github.com/brickhu/jupin>（public）

| 分支 | 用途 |
|---|---|
| **`dev`** | **日常开发都提交在这里**。开工前先 `git switch dev` |
| **`main`** | 只从 `dev` 合并，不直接在上面提交。它是 GitHub 的默认分支 |

```bash
git switch dev                      # 开工
# …改动…
git add -A && git commit -m "feat: …"
git push                            # 推到 origin/dev

# 要合主线时
git switch main && git merge dev && git push && git switch dev
```

> ⚠️⚠️ **部署取的是「当前工作区」，跟 git 完全无关。**
> `pnpm deploy:dev` 是把仓库根目录**当场打包上传**（`run:deploy --targetDir .`），
> 小程序上传读的是本地 `dist/`。所以「云上跑的是哪个版本」= 你此刻在哪个分支、改了没提交也会一起上去。
> 要确保线上是某个分支的代码，先切过去、工作区干净，再部署。

---

## 三条不可违背的设计原则

### 1. 云端只买「一个分数」，其余全部端侧实现

音高、流利度、进度、预检、回放、上色、对比——**这些是产品能力，必须自建**。
云端只是一个函数：`score(audio, refText) → number`。

> 端侧能力是资产（抄不走、不涨价、不停服）；云端能力是商品（可替换）。

### 2. 高频动作边际成本必须为 0

**录音 / 重录：本地，无限免费。**
**提交检测：云端，唯一花钱的地方。**

「练习」不是一种模式，它就是**带着反馈的重录**这个动作本身。

### 3. 排行榜用云端分，个人参考用端侧分

排行榜需要「统一尺子 + 不可篡改」；个人反馈只需要「相对趋势」。
**本地分绝不允许进入排名或征服判定。**

---

## 核心机制速查

| 项 | 定义 |
|---|---|
| **内容单位** | 短文（100–300 词） |
| **竞技单位** | 竞技场 = 句群（10–20 秒，25–50 词） |
| **用户动作** | 只有两个：录音/重录 · 提交检测 |
| **横向指标** | 句内排名（"第 16 名 / 1,284 人"） |
| **纵向指标** | ① 单场刷新（62→87）② 能力边界（征服到 ⭐⭐⭐⭐） |
| **征服** | 该竞技场拿到 **≥85 分**，永久保留、只增不减 |
| **难度** | 对外只暴露 ⭐ ~ ⭐⭐⭐⭐⭐ |
| **免费额度** | 每 24 小时 1 次提交（**滚动冷却**，非自然日重置） |
| **付费** | ¥19.9/月 · ¥199.9/年，无限次提交 |
| **付费触发** | 点击「提交检测」时弹窗（不是首页倒计时） |
| **平台** | 微信小程序（原生 + TypeScript） |
| **评分引擎** | 科大讯飞 ISE（薄适配层，可替换） |

---

## 文档索引

| 文件 | 内容 | 何时查阅 |
|---|---|---|
| **AGENT.md** | 本文件 — 入口 + 工程手册 | **每次开始任务** |
| [prd.md](prd.md) | 产品设计：核心循环、指标体系、预检、付费模型 | 做产品决策时 |
| [spec.md](spec.md) | 数据库与架构：端侧/后端/引擎/数据模型/内容流水线 | 写代码时 |
| [docs/](docs/README.md) | **调研 · 实验 · 归档**（见下） | 需要依据/背景时 |

**分工边界**：产品「为什么/给谁/怎么玩」→ prd.md；系统「怎么实现」→ spec.md；**工程「怎么搭/怎么调/怎么发」→ 本文件**；调研与评估 → docs/。

### docs/ 子目录

| 路径 | 内容 |
|---|---|
| [docs/research/](docs/README.md) | 引擎横评 · ISE 实测报告 · 端侧能力评估 · 内容生产调研 · 平台选型论证 |
| [docs/experiments/](docs/experiments/validation-experiment.md) | ⏳ **合并验证实验方案（动手前必经）** |
| [docs/probes/](docs/probes/probe-ise-stream.cjs) | 探针脚本 |
| docs/archive/ | ⚠️ v1 废弃文档，仅作历史参考 |

---

# 一、仓库结构

pnpm workspace monorepo。

```
jushuo/
├── AGENT.md  prd.md  spec.md
├── package.json                 # workspace 根
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .dockerignore                # ⚠️ 必读：云托管按它裁剪上传，绝不能写 ! 否定规则
├── docker-compose.yml           # ⭐ 本地 MySQL + API
│
├── packages/
│   └── shared/                  # 唯一共享包
│       └── src/
│           ├── types/           # API DTO · CDN JSON · 领域类型
│           ├── constants/       # 85 分阈值 · 24h · 星级定义 · 功能词表
│           └── audio/           # ⭐ 纯函数音频算法（见第三节）
│
├── apps/
│   ├── miniprogram/             # 小程序端
│   └── server/                  # 后端服务
│
└── tools/
    └── pipeline/                # 内容生产流水线（离线）
```

## 1.1 小程序端 `apps/miniprogram/`

```
apps/miniprogram/
├── project.config.json          # miniprogramRoot: "dist/"
├── project.private.config.json  # 本地配置（gitignore）
├── build.mjs                    # esbuild 构建脚本 + UnoCSS 生成
├── uno.config.mjs               # UnoCSS 配置（→ dist/uno.wxss）
├── src/
│   ├── app.ts / app.json / app.wxss
│   ├── pages/
│   │   ├── index/               # 环境自检 + 产品入口（诊断页）
│   │   ├── reading/             # ⭐ 朗读页：录音 → 提交 → 打分（唯一的产品动作入口）
│   │   └── selftest/            # 真机自检 T1–T6
│   ├── components/              # （尚未创建）词级上色文本 · 榜单 · 冷却弹层
│   ├── workers/
│   │   └── audio-analysis/      # Worker：收帧 → 调纯函数 → 回结果
│   ├── lib/
│   │   ├── audio/               # 录音、PCM 适配、播放（薄壳）
│   │   ├── api/                 # 后端接口封装
│   │   ├── content/             # CDN 内容拉取 + 本地缓存
│   │   └── store/               # 极简全局状态
│   └── typings/
└── package.json
```

**⚠️ 小程序 + monorepo 的四个特有摩擦点：**

| 摩擦点 | 后果 |
|---|---|
| 小程序不解析 `node_modules` 依赖树 | workspace symlink 会让“构建 npm”失灵 |
| **Worker 必须是单文件** | 不能 `require` 外部包，必须独立打包 |
| **Worker 不走开发者工具转译** | ⭐ 见下，产物语法必须降级到 ES2017 |
| 无打包器 | WXML/WXSS/JSON 需单独拷贝 |

### ⚠️⚠️ 构建 target 绝不能高于 `es2017`

**症状**：真机上报 `Error: invalid file: workers/audio-analysis/index.js, 38:28` +
`SyntaxError: Unexpected token ?`，而**模拟器完全正常**。

**根因**：Worker 是**独立 JS 上下文**，不走开发者工具的 es6→es5 转译
（本项目 `project.config.json` 里 `es6` / `enhance` 都是 `false`）。
`??`（空值合并）与 `?.`（可选链）是 ES2020 语法，真机引擎解析 Worker 时直接崩。

**为什么是 es2017 而不是更低**：esbuild **无法把 `async/await` 降级到 ES5**，
而 es2017 原生就有 async/await，同时会把 `??` / `?.` / `??=` / `||=` / `&&=` 降级掉。

```js
// apps/miniprogram/build.mjs
target: 'es2017',   // ⛔ 不要调到 es2020 及以上
```

**构建后有守卫会复查**（`assertNoModernSyntax()`）：产物里一旦残留这些语法，
构建**退出码 1**，并列出具体文件。

> 这类问题**只在真机上炸、模拟器完全正常**，报错形式又离根因很远（`invalid file: xxx.js`），
> 排查成本极高 —— 所以宁可构建期就拦下来。


**解法 = esbuild 打包 + 拷贝静态资源：**

```js
// build.mjs
const common = {
  bundle: true,                  // ⭐ 把 @jushuo/shared 打进去
  platform: 'neutral',
  target: 'es2020',
  format: 'cjs',
  alias: { '@jushuo/shared': '../../packages/shared/src/index.ts' },
}

// 1. 页面 / 组件 / lib
await esbuild.build({ ...common, entryPoints: ['src/**/*.ts'], outdir: 'dist', outbase: 'src' })

// 2. ⭐ Worker 单独打包成单文件（小程序硬要求）
await esbuild.build({ ...common,
  entryPoints: ['src/workers/audio-analysis/index.ts'],
  outfile: 'dist/workers/audio-analysis/index.js' })

// 3. 拷贝 WXML / WXSS / JSON / 图片
await cp('src', 'dist', { recursive: true, filter: f => !f.endsWith('.ts') })
```

**开发模式**：`esbuild --watch` + 微信开发者工具自动刷新。

> **为什么不用 Taro/uni-app**：核心是音频处理 + 高频上色动画，跨端框架恰在这两处最易出坑；且不做多端。

### 样式方案：UnoCSS（**已接入**）

选型论证见 **[docs/research/styling-decision.md](docs/research/styling-decision.md)**。要点：

**WXML 不能调用 JS**，所以一切「在 JS 里算类名再塞进模板」的方案（StyleX / CSS-in-JS 全家）在小程序里都要额外搭一层 `data` 桥接。UnoCSS 走「构建期扫源码 → 生成静态 WXSS」，模板里直接写类名，**运行时零开销**。

```
uno.config.mjs  配置 + downgradeColorSyntax + assertWxssSafe
build.mjs       buildUnoCss()：扫 src/**/*.{wxml,ts} → dist/uno.wxss
src/app.wxss    顶部 @import "./uno.wxss"
```

⚠️ **两个必知的坑**（都会静默失效，不报错）：

| 坑 | 规则 |
|---|---|
| WXSS 不支持转义选择器 | 变体分隔符是 `__`：写 `hover__bg-gray-100`，**不是** `hover:bg-gray-100`。也因此**别用 BEM 的 `block__element` 命名** |
| UnoCSS 66 输出 CSS Color 4 | 产物必须过 `downgradeColorSyntax()`，否则老 WebView **整条颜色声明丢弃**。`assertWxssSafe()` 会在构建期拦截 |

> 间距刻度：1 单位 = 8rpx（`p-4` → `32rpx`），与现有手写 WXSS 同刻度。

## 1.2 后端 `apps/server/`

```
apps/server/
├── src/
│   ├── index.ts                 # Hono app
│   ├── routes/
│   │   ├── auth.ts              # wx.login → openid → 签发 token
│   │   ├── articles.ts          # 朗读单元索引 · 榜单 · 榜心
│   │   ├── submissions.ts       # ⭐ 提交检测（核心）
│   │   ├── user.ts
│   │   └── payment.ts
│   ├── engines/                 # ⭐ ScoreEngine 薄适配层
│   │   ├── types.ts             # interface ScoreEngine
│   │   ├── xfyun.ts             # 讯飞实现（⚠️ 必传 ise_unite=1）
│   │   └── mock.ts              # ⭐ 本地开发用，不烧额度
│   ├── services/
│   │   ├── cooldown.ts          # 24h 滚动冷却
│   │   ├── leaderboard.ts       # 排名 · 榜心
│   │   └── conquest.ts          # 征服判定
│   ├── db/                      # Drizzle schema + migrations
│   └── lib/
├── drizzle.config.ts
├── Dockerfile                   # 正式构建
├── Dockerfile.development       # ⭐ 实时开发用
└── package.json
```

## 1.3 内容流水线 `tools/pipeline/`

```
tools/pipeline/
├── src/
│   ├── steps/                   # 01-select → 09-publish，一步一文件
│   ├── lib/                     # fishaudio · ecdict · llm · cos
│   └── cli.ts                   # pnpm pipeline run --from 04 --to 09
├── data/drafts/                 # 中间产物（gitignore）
└── package.json
```

⭐ **做成可重复、可断点续跑的流水线**，不是一次性脚本——内容会持续生产，改第 ⑦ 步不该重跑 ①–⑥。

## 1.4 ⭐ 核心闭环：录音 → 提交 → 打分

产品的**唯一动作入口**是朗读页 `pages/reading/`。用户只有两件事可做：**录音（重录）、提交检测**。

```
录音（RecorderManager，裸 PCM）
  → onStop 拿到 tempFilePath
  → 上传对象存储（**只传 key，不传音频本体**）
  → POST /api/submissions { articleId, audioKey }
  → 服务端读音频 → 评分引擎 → 写 submissions
  → 返回 { score, rank, leaderboard, words, nextFreeAt }
```

**服务端**（`routes/submissions.ts`）的顺序不能改，理由都写在文件注释里：
校验路径属于本人 → **幂等检查（必须在冷却之前）** → 冷却 → 分配 seq → 读音频 → 评分 → 落库 → 更新冷却。

### ⚠️⚠️ 本地与线上的音频通道是**两条不同的路**

| | 线上 | 本地（模拟器） |
|---|---|---|
| 上传 | `wx.cloud.uploadFile` → 微信对象存储 | `wx.uploadFile` → `POST /api/uploads` |
| 取回 | `WxCloudStorage` + COS SDK | `LocalStorage`（落盘 `.uploads/`） |

**为什么必须分叉**：本地 Docker **拿不到 COS 凭证** —— 临时密钥要调 `/_/cos/getauth`，
而那是云托管**内网**接口，本机调不到。不分叉的话，小程序把音频传到了微信云、
本地服务端却在 `.uploads/` 里找不到，提交必然 400「读取音频失败」——
**而且看起来像是提交逻辑写错了**。

`POST /api/uploads` **只在 `STORAGE=local` 时开放**（云端部署直接 404），
落到的 `LocalStorage.put()` 本来就是为「模拟小程序直传」预留的。

### 内容：`contentJson` 是**完整 URL 路径**，不是文件路径

`articles.contentJson` 形如 `/content/articles/1.json`，**里面本来就含 `content/` 这一段**
（那是它将来在 CDN 上的地址）。所以解析的基准是**仓库根**，不是 content 目录 ——
踩过一次：当成 content 目录之后去找 `/app/content/content/articles/1.json`，正文永远读不到。

服务端的两个消费方**共用** `services/content.ts` 的同一个函数
（评分要 `text`、页面要整份数据），不共用会出现「能评分、但页面读不出句子」这种极难排查的漂移。

内容文件在仓库根 `content/articles/*.json`，是**流水线建成前的占位**：
`words` 字段留空（评分只用 `text`），词级数据要等 `tools/pipeline` 产出。

### ⚠️ 实时上色能做什么、不能做什么

朗读页录音时词会实时变绿，**含义必须说清楚**：

| | 依据 | 含义 |
|---|---|---|
| **实时**（录音中） | 端侧 VAD + 语速折算 | 绿色 = **「这个时间段检测到你在读」**，**不是**读准了 |
| **云端**（提交后） | 评分引擎的词级分数 | 绿色 = 读对（≥85），红色 = 有问题 —— 这才是权威判定 |

「读准没读准」需要**音素级评测**，端侧做不到：`spec.md` 的能力表里「端侧音素模型 ❌」，
`docs/research/vendor-ondevice-landscape.md` 实测端侧音素级 PCC 只有 0.25–0.6，
`docs/research/ise-probe-report.md` 实测讯飞 ISE 流式版**零中间结果**。

所以这是刻意的分工（`spec.md` 写的兜底路径「实时进度退回本地 VAD」）：
**实时给「读到哪了」，云端给「读得怎么样」。**

⚠️ 实时进度按 **`MS_PER_WORD`=400ms（150 词/分）** 把「有效语音时长」折算成词索引。
读得快/慢会漂移。真正对齐要靠标准音 + DTW，或 ASR 的实时识别结果 —— 两条路都还没接。

#### 噪声底估计踩过的两个坑（都记在 `audio/vad.ts` 里）

| 做法 | 结果 |
|---|---|
| 滚动窗口的 **20% 分位** | 连续朗读时语音帧占比 >80%，那个分位数本身就是语音 → **整句 11 个词检测到 0ms** |
| 最初几帧最小能量**播种** + 快降慢升 | 用户**开口即读**时噪声底被锁死在语音上 → 5060ms 朗读只算出 1280ms |
| ✅ **滚动窗口最小值**（32 帧 ≈ 2 秒） | 不依赖「静音该占多大比例」的假设；真实朗读 2 秒内必有词间气口 |

> 这两个坑都是**写完之后跑仿真才发现的**，不是推出来的 ——
> 所以 `vad-stream.test.ts` 里补了两条回归测试。改动这块时别绕过它们。

### 测试时被 24 小时冷却卡住 → `pnpm dev:unlock`

```bash
pnpm dev:unlock          # 解除全部本地账号的冷却
pnpm dev:unlock:status   # 只看状态，不改
```

**做法是把账号置为会员，而不是改冷却判断** —— `services/cooldown.ts` 里本来就写了
「会员不受冷却限制」，这是产品的真实机制（付费免冷却）。
用一个已存在的产品路径来解锁，好过为了开发方便在生产代码里开一个 if 口子。

⚠️ 工具**只动 `openid` 以 `dev_` 开头的账号**。本地联调时 openid 是
`dev_${wx.login 的 code}`（见 `routes/auth.ts`），线上是真实微信 openid、没有这个前缀 ——
所以它在**原理上不可能误伤真实用户**。

⚠️ 每次在开发者工具里**重新登录**都可能生成**新的 dev_ 账号**
（`wx.login` 的 code 变了 → openid 变了 → 新用户），
所以这个脚本设计成**可反复执行、每次覆盖全部 dev_ 账号**。

---

# 二、环境搭建

## ⭐ 推荐路径：一条命令起全套（Docker / OrbStack）

```bash
pnpm install          # 1. 装依赖
pnpm dev:docker       # 2. 起 db + api（自动迁移 + 自动种子）
pnpm dev:mp           # 3. 小程序 esbuild --watch
```

第 3 步之后，用**微信开发者工具**打开 `apps/miniprogram`（`miniprogramRoot` 指向 `dist/`）。

**容器会自动完成**：应用迁移 → 写种子（幂等）→ 启动服务。
所以不需要单独跑 `db:migrate` / `seed`。

```bash
pnpm dev:docker:logs    # 跟日志
pnpm dev:docker:ps      # 看状态
pnpm dev:docker:down    # 停
pnpm dev:docker:reset   # ⭐ 推倒重来（删卷 + 重建 + 重新自举）
```

## 另一条路径：宿主机直跑（调后端断点时用）

```bash
pnpm db:up && pnpm dev
```

容器化牺牲的是**调试便利**（attach debugger 麻烦）。要在 Node 里打断点就用这条。

## ⚠️ 小程序连后端的三个坑

### 0. ⭐ 系统代理 —— 最难查，因为它会骗过 curl

**症状**：`curl http://localhost:8899/health` 返回 200，但开发者工具里请求失败。

**原因**：macOS 的系统代理指向一个**能转发外网、但拒绝转发本地地址**的代理
（Clash 这类规则代理常见）。Chromium 内核的开发者工具会走系统代理，`wx.request` 无法绕过。

**实测证据**（本项目真实复现）：

```bash
scutil --proxy  # → SOCKSEnable: 1, SOCKSProxy: 127.0.0.1, SOCKSPort: 1081

curl -x socks5h://127.0.0.1:1081 http://example.com          # 200  ✅ 代理本身活着
curl -x socks5h://127.0.0.1:1081 http://localhost:8899       # Empty reply from server  ❌
curl -x socks5h://127.0.0.1:1081 http://127.0.0.1:8899       # Empty reply from server  ❌
curl -x socks5h://127.0.0.1:1081 http://192.168.31.131:8899  # Empty reply from server  ❌
```

**所有本地 / 局域网地址都被拒答，只有外网正常** —— 所以换地址救不了。

**修法**（按推荐度）：

1. ⭐ **开发者工具 → 设置 → 代理设置 → 不使用代理**（只影响工具，不动系统）
2. 系统设置 → 网络 → 代理 → 「忽略这些主机与域名」加入
   `localhost, 127.0.0.1, 192.168.0.0/16`
3. 直接关掉系统代理

> ⚠️ **教训**：`curl` **不读** macOS 系统代理设置，
> 所以「curl 能通」不能证明开发者工具能通。
> 排查这类问题必须用 `curl -x <代理> ...` 显式走一遍代理。

### 1. 改用你机器的局域网 IP

`apps/miniprogram/src/config.ts`：```ts
const DEV_BASE_URL = 'http://192.168.31.131:8899'   // ← 改成你的
```

查法：`ipconfig getifaddr en0`（macOS）。端口取根目录 `.env` 的 `API_PORT`。

**真机上 `localhost` 指向手机自己**，必须走局域网 IP。已实测局域网可访问。

### 2. 开发者工具里勾选「不校验合法域名」

详情 → 本地设置 → ☑ 不校验合法域名、web-view、TLS 版本以及 HTTPS 证书。

> ⚠️ 开发者工具**拿不到麦克风**，音频相关一律必须真机。

## ⚠️ 端口冲突（本机已有 MySQL / Postgres / 其他服务时）

`docker-compose.yml` 的宿主机端口**可配置**，根目录 `.env` 里改：

```bash
DB_PORT=5544    # 容器内 MySQL 始终 3306；本机 3306 被占时改这里
API_PORT=8899   # 容器内服务始终 3000；本机 3000 被占时改这里
```

**⚠️ 两个都改了才一致**：`API_PORT` 是容器映射到宿主机的端口，容器内服务始终监听 3000。

## 已验证的脚手架能力

| 项 | 命令 | 状态 |
|---|---|---|
| 全量类型检查 | `pnpm -r typecheck` | ✅ 4 个包通过 |
| 音频算法单测 | `pnpm --filter @jushuo/shared test` | ✅ 15 个用例 |
| 后端端到端 | 登录 → 提交 → 排名 → 冷却被拦 | ✅ 跑通 |
| 小程序构建 | `pnpm --filter @jushuo/miniprogram build` | ✅ Worker 单文件、无 require 残留、语法已降到 ES2017 |

---

# 三、本地调试

## 3.1 ⭐ 四层策略（大部分时间不需要全栈环境）

```
┌─ 阶段 1：纯 UI 开发（零 Docker）────────────────┐
│  小程序 + MockEngine + 本地 mock 数据            │
│  改样式、调动画、试交互 —— 日常 80% 的时间         │
└─────────────────────────────────────────────────┘
              ↓ 需要联调
┌─ 阶段 2：docker compose up ────────────────────┐
│  真 db + 真 api，验证接口契约、榜单、冷却逻辑       │
└─────────────────────────────────────────────────┘
              ↓ 需要真机
┌─ 阶段 3：真机预览 + 局域网 IP ──────────────────┐
│  验证 onFrameRecorded、音频分析、播放精度          │
└─────────────────────────────────────────────────┘
              ↓ 上线前
┌─ 阶段 4：云托管测试环境 ────────────────────────┐
│  端到端验证，环境与线上一致                        │
└─────────────────────────────────────────────────┘
```

## 3.2 ⭐ 音频算法必须是纯函数

**FFT / YIN / VAD / DTW 不依赖任何小程序 API**——只是「输入 Float32Array，输出数字」。

```ts
// packages/shared/src/audio/   ← 纯函数，零平台依赖
export function detectPitch(frame: Float32Array, sampleRate: number): number
export function computeVad(frames: Float32Array[], opts: VadOptions): VadResult
export function dtwDistance(a: number[][], b: number[][]): number
```

**好处：**
- ✅ 可在 **Node 里跑单元测试**（vitest），不用开小程序
- ✅ 可在 **CI 里跑**，算法回归立刻发现
- ✅ 反馈循环从「改代码 → 上传 → 真机扫码 → 读日志」缩短到 `pnpm test`

> **小程序里调试音频算法是地狱**——没有断点、难以复现、日志要开 vConsole。**能搬出来的全搬出来。**
> Worker 只留一层薄适配：收帧 → 调纯函数 → 发结果。

## 3.3 ⭐ Docker 化 + OrbStack 统一管理（**已实测通过**）

| 层 | Docker 化 | 说明 |
|---|---|---|
| **MySQL** | ✅ 推荐 | 一键起、可重置（本地与线上同一方言） |
| **后端服务** | ✅ **已实测** | 见下 |
| 内容流水线 | ✅ 能 | 批处理天然适合，但交互调试略麻烦 |
| ⚠️ **小程序端** | ❌ **绝对不行** | **微信开发者工具必须跑在宿主机** |

### 用法

```bash
pnpm dev:docker          # 起 db + api 容器（首次构建约 1 分钟）
pnpm dev:docker:logs     # 跟日志
pnpm dev:docker:ps       # 看状态
pnpm dev:docker:down     # 停
```

在 **OrbStack** 里能直接看到 `jushuo-db` / `jushuo-api`，统一启停、看日志。

### 实测结论（macOS + OrbStack）

| 验证项 | 结果 |
|---|---|
| 容器构建 | ✅ |
| 连数据库（走 compose 服务名 `db:3306`） | ✅ |
| ⭐ **挂载卷热重载** | ✅ `[tsx] change in ./src/index.ts Restarting...` |
| 端口映射到宿主机（真机可访问） | ✅ `0.0.0.0:8899->3000` |

⚠️ **热重载是这个方案的分水岭** —— macOS 上挂载卷的文件监听历来不可靠，OrbStack 实测通过。

### 两个已确认的细节

1. **`.env` 与 compose 环境变量不冲突**
   容器内会加载挂载进来的 `.env` + `.env.local`（其中 `DATABASE_URL` 指向宿主机的 `localhost:5544`，在容器里是**错的**）。
   但分层的**最内层就是真实环境变量**（见 tools/env.mjs）：进程里已有的键任何文件都盖不动，
   所以 compose `environment:` 注入的 `db:3306` 生效。
   （这个行为单独验证过，不是推测。）

2. **端口**：宿主机 `API_PORT`（本机 8899）→ 容器 3000。
   小程序真机通过**宿主机局域网 IP + 8899** 访问。

### 什么时候还是用 `pnpm dev`

容器化牺牲的是**调试便利**（断点、attach）。要在 Node 里打断点调后端时，宿主机直跑更顺：

```bash
pnpm db:up && pnpm dev    # 只把数据库放容器里
```

**两种方式并存，按场景选。**

**微信云托管官方方案「实时开发 / Live Coding」**（VSCode 插件 `Weixin Cloudbase`，容器右键选 Live Coding）会**自动生成 `Dockerfile.development` 和 `docker-compose.yml`**，代码变更自动重启进程。

官方对开发态 Dockerfile 的定义：**单阶段构建 + 编译命令转成启动命令**。
对应到我们：`tsc build` → `tsx watch src/index.ts`。

本项目的实际形态（`docker-compose.yml` + `apps/server/Dockerfile.development`）：

```yaml
# docker-compose.yml
name: jushuo
services:
  db:
    image: mysql:8.4
    # ⚠️ 必须显式 utf8mb4：昵称里有 emoji，utf8 三字节存不下会直接报错
    command: ['--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci']
    environment: { MYSQL_DATABASE: jushuo, MYSQL_USER: jushuo, MYSQL_PASSWORD: dev, MYSQL_ROOT_PASSWORD: dev, TZ: UTC }
    ports: ["${DB_PORT:-3306}:3306"]
    volumes: ["mysqldata:/var/lib/mysql"]
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-uroot", "-pdev"]
      interval: 5s

  api:
    build: { context: ., dockerfile: apps/server/Dockerfile.development }
    ports: ["${API_PORT:-3000}:3000"]   # ⭐ 必须映射到宿主机，真机才能访问
    volumes:
      - ./:/app                          # 源码挂载 → 热重载
      - /app/node_modules                # 防止被覆盖
    environment:
      DATABASE_URL: mysql://jushuo:dev@db:3306/jushuo
      ENGINE: mock
    depends_on:
      db: { condition: service_healthy }
volumes: { mysqldata: }
```

```dockerfile
# apps/server/Dockerfile.development
FROM node:20-alpine
WORKDIR /app
RUN npm i -g pnpm@9 tsx
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
RUN pnpm install
COPY apps/server/docker-entrypoint.dev.sh /usr/local/bin/dev-entrypoint
CMD ["/usr/local/bin/dev-entrypoint"]   # 迁移 → 种子 → tsx watch
```

## 3.4 本地调试的三条路 —— 以及为什么**不用**官方 VSCode 插件

> 官方文档：[本地调试](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/guide/debug/)

| 方案 | 模拟器怎么连 | 需要什么 | 结论 |
|---|---|---|---|
| **A. `wx.request` 打 localhost**（本项目采用） | `http://localhost:8899` | 只要 Docker | ✅ 默认 |
| B. 官方 VSCode 插件本地调试 | 模拟器 `callContainer` 打到本地容器 | VSCode + `weixin-cloudbase` 插件 + **Nightly 版**开发者工具 + 每服务一个 Dockerfile | ⚠️ 不采用，见下 |
| C. 模拟器直接打云环境 | 模拟器 `callContainer` 打到**真实 dev 环境** | 什么都不用，改一行 `MODE` | ✅ 想验生产链路时用这个 |

### 为什么不用官方的 VSCode 插件（方案 B）

**① 它解决的问题我们没有。**
它的唯一增量能力是：让模拟器里的 `callContainer` 请求**打到本地容器**。
而我们模拟器走 `wx.request` 打 localhost，本来就是本地容器 —— 不需要绕这一圈。

**② ⚠️ 它明确不支持 WebSocket 调试。**
官方原文：「暂不支持 WebSocket 调试」。
而**讯飞 ISE 流式评测走的正是 WebSocket** —— 这条路一旦选它，ISE 的流式链路就永远没法本地调。

**③ 它和 pnpm monorepo 的组织方式不吻合。**
插件要求「服务根目录下有 Dockerfile」，多服务则用 `project.config.json` 的 `cloudcontainerRoot`
指向一个「每个子目录一个服务」的父目录。
而我们是 `apps/server` + `packages/shared` 的工作区结构，
Dockerfile 的构建上下文必须是**仓库根**（要 `pnpm-lock.yaml` 和 `packages/shared`），
和插件的预期目录模型对不上。

**④ 代价不小：** VSCode + 插件 + Nightly 版开发者工具，只为一个我们已有的能力。

### ⭐ 一条更简单的替代（想验生产链路时用）

如果目的是「让模拟器也走 `callContainer`，和真机同一条链路」，**根本不需要插件**：

```ts
// apps/miniprogram/src/config.ts
export const MODE: Mode = 'cloud'   // 模拟器也走 callContainer → 真实 dev 环境
```

- `MODE = 'auto'`（默认）：模拟器 → `wx.request` → 本地 Docker；真机 → `callContainer` → dev
- `MODE = 'cloud'`：模拟器也走 `callContainer` → **真实 dev 环境**（零配置）

方案 B 是「`callContainer` + 服务跑在本地」，
而方案 C 是「`callContainer` + 服务跑在云端」—— 后者零配置，且验的是**真实部署**。

### ⚠️ 从这份文档里必须记住的两条

**① 本地调试拿到的 `x-wx-openid` 不是真实身份。**

> 官方原文：「本地调试中获得的 x-wx-openid 不包含用户身份，仅能用于部分小程序接口，
> 和线上获取的用户真实 OpenID 不一致。如需调试微信支付等依赖真实 OpenID 的功能，
> 请手动改用成开发者自己的真实 OpenID。」

⭐ **这一条直接决定我们的支付方案**：本项目要做微信支付（订阅 ¥19.9 / ¥199.9），
而支付**强依赖真实 openid**。所以：

- **支付联调必须在真实环境做**（dev 环境用真机 `callContainer`，openid 由微信网关注入，是真的）；
- 本地 `wx.request` 那条路走的是 `dev_${code}` 伪 openid，**只能测逻辑，不能测支付**。

**② 第六节「本地打通线上 VPC」是这份文档里对我们唯一有潜在价值的能力。**

它可以把内网地址加为 Proxy node，让**本地容器**访问线上 VPC 里的资源
（官方原文举例「如数据库」）。
用途：不用 mysqldump 同步数据，本地 API 直连云端 MySQL 复现线上问题。
现在不需要（本地 MySQL schema 一致），但**遇到「线上才复现」的数据问题时值得回头看这一节**。

## 3.5 ⚠️ 真机调试的网络

**手机访问不到 `localhost`**——那指向手机自己。

```
开发者工具 → 详情 → 本地设置 → ☑ 不校验合法域名
小程序请求地址 → http://192.168.x.x:3000    ← 宿主机局域网 IP
```

Docker 端口映射到宿主机后，**局域网设备可正常访问**（macOS Docker Desktop 默认行为）。

| 现实坑 | 应对 |
|---|---|
| 换 WiFi / 网络隔离 → IP 变了 | 内网穿透（frp / cloudflared），或固定开发机 IP |
| 真机不在同一局域网 | 内网穿透，或直接部署到云托管测试环境 |
| **音频必须真机才能测** | ⚠️ 无法回避——开发者工具拿不到麦克风 |

⭐ **更省心的替代**：把 dev 后端部署到云托管测试环境。免所有网络问题，环境还与线上一致（`develop` 分支自动部署）。

---

# 四、部署与 CI/CD

## 4.0 部署目标：微信云托管（**已接通**）

### 真实环境坐标

| 项 | 值 |
|---|---|
| AppID | `wxc0418392e9116a01` |
| 环境 | dev = `dev-0go66cfz212d3d83` ／ prod = `prod-9gjwc01kcd98d6d1` |
| 服务名 | **`jupin`**（`deploy-cloud.mjs` 的 `SERVICE` 常量；写错会报 -601031） |
| 公网域名（dev） | `https://jushuo-219743-12-1258596499.sh.run.tcloudbase.com` |
| 数据库 | 云托管 MySQL，内网 `MYSQL_ADDRESS`（形如 `10.x.x.x:3306`） |

一条命令部署：`pnpm deploy:dev`（= `node tools/deploy-cloud.mjs dev`）。

### ⭐ 真机体验的前置清单（缺一样都会卡住）

**模拟器连的是本机 Docker，真机连的是云托管 dev 环境 —— 两者是完全不同的两套东西。**
真机跑不通时先照这张表逐项核对，别去改客户端代码：

| # | 条件 | 怎么查（都从 `/health` 看，云托管没有日志可看） | 谁来做 |
|---|---|---|---|
| 1 | dev 服务已部署且在跑 | `curl <dev域名>/health` 返回 200 | `pnpm deploy:dev` |
| 2 | **表结构是新版** | `existingTables` 里要有 **`articles`**；若还是 `arenas`/`arena_entries` 说明停在旧 schema | `pnpm deploy:dev --reset` |
| 3 | **句库不为空** | `articleCount` = 5（为 0 或 null 就是没灌上） | `SEED_ON_START=true`，deploy 工具已自动带上 |
| 4 | 正文文件在镜像里 | `/health?deep=1` 的 `content.ok` = true（会回显 `root` 和读到的第一句） | Dockerfile 已 `COPY content` |
| 5 | ⚠️ **「开放接口服务」已开启** | `/health?deep=1` 的 `storage.auth` 为 `ok` | ⛔ **只能在控制台点** |

> 3 和 4 是**两个独立**的失败点，但客户端表现**一模一样**（朗读页「正文加载失败」）——
> 所以它们在 `/health` 里被拆成了两个独立的字段，别混。

**第 5 条是唯一的纯人工步骤，而且它有三件事，不是一件。**
官方《开放接口服务》的四步里前三步缺一不可：

| 步 | 做什么 | 我们踩的坑 |
|---|---|---|
| ① | 控制台-云调用-**微信令牌权限配置**里加**接口白名单** | ⭐ **最容易漏**。文档把这一步排在**第一位**；格式是**路径**不是完整 URL（如 `/wxa/msg_sec_check`），我们要加的是 **`/_/cos/getauth`** |
| ② | 控制台-云调用-**打开「开放接口服务」开关** | 注意要开在**本环境**上 —— 本项目有 dev / prod **两个**环境 |
| ③ | **重新构建一次版本** | 官方原文：「实例扩缩容时**不遵循当前的开关状态，而是遵循版本创建时的开关状态**」 |
| ④ | 镜像里要有 shell | 官方：「开放接口服务依赖 shell，镜像内无 `sh/bash` 将无法正常部署容器」。我们用 `node:20-alpine` ✓ |

#### 怎么判断到底生效没有 —— 官方给了**两个**判据，都要看

> 通过请求头返回 `x-openapi-seqid` 和**解析地址为内部地址（`10.0.0.x` / `169.254.0.x`）**判断是否使用了开放接口服务。

两个判据都做进了 `/health?deep=1`：

| 判据 | 从哪看 | 含义 |
|---|---|---|
| ① `storage.openapiDns` / `openapiActive` | `storage/index.ts` 的 `probeStorage()` | 解析到 **公网 IP** → **旁加载的 sidecar 根本不在这个实例上** |
| ② `storage.authError` 里有没有 `x-openapi-seqid` | `storage/wxcloud.ts` 的 `getAuth()` | 没有 → 请求没被平台接管 |

> ⭐ **判据 ① 比 ② 更有信息量**：它能区分「sidecar 压根不在」和「sidecar 在、但请求没匹配上」。
> 只看 ② 的话两者都表现为「没有 seqid」。

**实测记录（dev 环境，2026-09-15）** —— 两个判据都判定未生效：

```
storage.openapiDns  = 81.69.216.43      ← 公网 IP
storage.openapiActive = false
storage.auth        = failed
authError           = HTTP 404 body="" 【诊断】没有 x-openapi-seqid
```

⚠️ **两个容易混淆的失败，处置完全不同**：

| 现象 | 含义 |
|---|---|
| **404 + 空 body + 无 seqid + DNS 是公网 IP** | 请求**完全没被平台接管** —— sidecar 不在 |
| `errcode: 85107` | 走通了云调用，但**路径不在白名单**里 |

本项目遇到的是**前一种**。而且当时已经在开关打开后重建过 **6 个版本**，所以
「实例遵循版本创建时的开关状态」这条也解释不了 —— 那就得回头确认**开关到底开在哪个环境上**
（本项目有 dev / prod **两个**环境，只有这两个）。

> `@wxcloud/cli` 的子命令只有 deploy / env / function / init / login / logout / migrate / run / service / storage / version，
> **没有任何云调用相关命令**，这一步没有命令行途径。

**为什么句库靠 `SEED_ON_START` 而不是 `pnpm seed:cloud`**：
云上 `Dockerfile` 的 `CMD` 只有 `node index.mjs`，不像本地开发镜像会自动 seed；
而 `seed:cloud` 走数据库**外网地址**，要先在控制台把公网入口打开 ——
为 5 行种子开数据库公网入口不划算。`SEED_ON_START` 让容器启动时自己灌（幂等 upsert）。

### ⚠️ 六条实测踩出来的坑

**① 启动顺序：必须先监听，再做数据库初始化。**
把 `await waitForDatabase()` 放在 `serve()` 之前，是**部署失败的头号原因**：
云托管存活探针 `initialDelaySeconds` 只有 2 秒，MySQL 冷启动恢复要几十秒，
探针在端口开始监听之前狂敲 → `connection refused` → 判定部署失败 → 反复重启。
正确做法：`serve()` 立刻执行，数据库初始化 `void initDatabase()` 异步进行。

**② CLI 没有任何查看容器日志的命令。**
`wxcloud` 的子命令只有 env / function / run / service / storage / version——
**没有 logs**。所以排查唯一通道是应用自己把状态暴露到 HTTP 上。
`/health` 因此刻意**始终返回 200** 并回显 `db` / `dbError` / `dbAttempts` / `migrated` / `existingTables`。
它是**存活探针**不是就绪探针：数据库挂了也不能返回 5xx，否则 Pod 被判不健康反复重启，
而你又看不到日志——排查会彻底卡死。

**③ 配置错误也不能 `process.exit(1)`。**
同理：进程退出 = `connection refused` = 部署失败，而你看不到为什么。
`env.ts` 校验失败时降级为「带错误启动」，把具体哪个变量错了写进 `/health`。

**④ `tsc` 的产物在 Node 上跑不起来。**
`tsconfig.base.json` 是 `moduleResolution: bundler`，编译出的相对导入**不带 `.js` 扩展名**
（`ERR_MODULE_NOT_FOUND`）；而且 `@jushuo/shared` 的 `main` 指向 `./src/index.ts`（TS 源码），
Node 无法从 node_modules 加载 `.ts`。
→ 服务端改用 **esbuild 打成单文件**（`apps/server/build.mjs`）：
两个问题一并解决，运行镜像还不需要 `node_modules`。

**⑤ `.dockerignore` 里绝对不要写 `!` 否定规则。**
`@wxcloud/cli` 用 `gitignore-globs` + 自写的 `minimatchWithList` 解析：
只要列表里存在一条未命中的 `!` 规则，它就整体返回「不忽略」——
**一条 `!.env.example` 就能让 node_modules/.pnpm-home 全部被打包上传**（本仓库 318MB）。
另一处：点开头的目录（`.git` / `.pnpm-home`）不会被展开成 `**` 模式，
但顶层目录会被整体剪枝，所以仍然生效——**打包后务必核对文件数**。

**⑦ ⚠️ 接口信封只有一种，任何端点都不许破例。**
`/health` 曾经直接返回扁平的 `{ status, engine, ... }`，而其余接口都是 `{ ok: true, data }`。
小程序的 `request()` 统一按信封解包（`'ok' in body && body.ok`），
于是**每次健康检查都被自己判成失败，报「请求失败」**——而服务端明明返回了 200。

> 这个 bug 的代价很大：前端症状（「连不上后端」）和真实网络状况**完全脱节**，
> 导致我们花了很多时间去查系统代理。代理问题确实存在，但它不是这个症状的原因。
> **教训：当「服务端日志正常 + 前端报失败」同时出现时，先怀疑契约不一致，再怀疑网络。**

**⑥ 不要用 `execFileSync` 直接跑 wxcloud 并把异常抛出去。**
`error.message` 会把**完整命令行**拼进去，而命令行里有 `MYSQL_PASSWORD` 与 `TOKEN_SECRET`，
一旦原样打印，密钥就直接落到终端和日志文件里。
`tools/deploy-cloud.mjs` 里自己 catch 并只输出脱敏后的尾部内容。

### 三条硬约束

| # | 约束 | 后果 |
|---|---|---|
| **1** | ⚠️ **请求体上限 100KiB**（官方文档明写；超限报业务错误码 **-606001**，官方从未提过 HTTP 413） | **音频不能走请求体**——20 秒音频约 640KB 必被拒 |
| **2** | ⭐ **CallContainer 免域名、免备案**，openid 从 `x-wx-openid` header 直接拿 | 自建服务器要买域名+备案+配白名单，云托管全免 |
| **3** | **容器不支持持久化存储** | 音频/内容必须走对象存储 |

### 因此的架构决策

```
① 小程序 wx.cloud.uploadFile → 对象存储直传（无 100KiB 限制，有进度回调）
② CallContainer 提交 { arenaId, fileID }  ← 极小请求
③ 后端按 fileID 取回音频 → 调讯飞 → 返回
④ 评完分删除音频（隐私策略）
```

**对象存储已做成可替换接口**（`apps/server/src/storage/`）：本地用 `LocalStorage`（落盘 `.uploads/`），生产用 `WxCloudStorage`。

⚠️⚠️ 但**本地与线上的音频通道是两条不同的路**，见 §1.4 —— 本地没有 COS 凭证，
必须由 `POST /api/uploads` 代劳，否则「上传 → 提交」本地永远跑不通。

> ⚠️⚠️ **两个只有「换服务」时才会暴露的坑**（都踩过，各花了几小时）：
>
> 1. **旁加载（开放接口服务）是「服务级」的，且只对创建于开关打开之后的实例生效。**
>    旧服务 `jushuo`（建号 2026-01，早于开关）的实例里**从来没有**旁加载 ——
>    容器内 `api.weixin.qq.com` 解析到公网、`/_/cos/getauth` 直接 301 出网。
>    而控制台开关一直是开的。**重建服务之后立刻就好了。**
>    判据：容器内该域名解析到 `169.254.x.x` / `10.x`（内网）才算生效 ——
>    `/health?deep=1` 的 `storage.dns` 直接给这个答案。
> 2. **旁加载用的是自签证书，Node 不认** —— 必须设
>    `NODE_EXTRA_CA_CERTS=/app/cert/certificate.crt`（官方《云调用常见问题》正是这条），
>    否则 HTTPS 报 `fetch failed ← self-signed certificate`（这句话离「证书」很远）。
>    该变量**只能由服务环境变量给**（Node 只在启动时读），`deploy-cloud.mjs` 已自动带上。

### ⚠️ 冷启动 30 秒 > callContainer 超时 15 秒

服务 `minNum=0`（默认）时连续 30 分钟无访问即缩容到 0，
下次请求要等 **30 秒**冷启动——而 `wx.cloud.callContainer` 的 `timeout` **上限只有 15 秒**。
→ 真机预览的**第一个请求必然超时失败**。
要可用就把「实例副本数最小值」设为 1（有持续费用），或在前端做「首次失败提示重试」。

### ⚠️ 数据库环境变量不会自动注入

云托管只定义 `MYSQL_ADDRESS` / `MYSQL_USERNAME` / `MYSQL_PASSWORD` 三个变量，
且**只有走控制台「模板一键部署」才会自动注入**。手动开通的 MySQL 必须自己填进
「服务设置 → 基本信息 → 环境变量」——**没有 `MYSQL_DATABASE`**，库名自己建自己起。
`MYSQL_ADDRESS` 是 `"host:port"` **一个字段**（官方模板源码里就是 `.split(':')`）。

> 完整约束见 [docs/research/cloud-hosting-constraints.md](docs/research/cloud-hosting-constraints.md)。

## 4.1 ✅ 可以完全 git 驱动

**微信云托管有三条部署路径：**

| 方式 | 适用 |
|---|---|
| **① 云托管自带流水线** ⭐ 推荐 | 关联 GitHub/GitLab/Gitee，**push 自动构建部署**（含 Webhook 自动配置） |
| **② 云托管 CLI**（`@wxcloud/cli`） | 自定义构建、或非主流仓库 |
| ③ 镜像仓库 | 已有镜像体系，推 CCR 后云托管拉取 |

**官方 CLI 命令（原文）：**

```bash
npm install -g @wxcloud/cli
wxcloud login --appId ${WXCLI_APPID} --privateKey ${WXCLI_KEY}
wxcloud run:deploy \
  --libraryImage ${IMAGE_TAG} \
  --containerPort=3000 \
  --envId=${WXRUN_ENVID} \
  --serviceName=jupin \
  --releaseType FULL --detach --noConfirm
```

CLI 密钥在 **云托管控制台 → 全局设置 → CLI 密钥** 生成，存 GitHub Secrets（不可明文入 yml）。

## 4.2 分支策略

| 分支 | 后端 | 小程序 | 数据库 |
|---|---|---|---|
| `feature/*` | 不部署 | 仅构建检查 | — |
| **`dev`** | **dev 环境**（push 即部署） | 仅构建检查 | 容器启动时自动迁移 |
| **`main`** | **prod 环境**（合并即部署） | 仅构建检查 | 容器启动时自动迁移 |

⭐ **小程序不按分支分环境。** 三种模式（本机 / dev / prod）的坐标在**构建期一起**烘进包里，
由 config.ts 在运行时按平台与版本自动分流（模拟器→本机、开发版与体验版→dev、正式版→prod）。
所以小程序只上传一次（体验版），跟后端分支无关 —— 只有后端需要分环境部署。

### CI 需要的 Secrets

| 名称 | 级别 | 从哪来 |
|---|---|---|
| `WXCLOUD_APPID` · `WXCLOUD_CLI_SECRET` | 账号级 | 云托管控制台 → 全局设置 → CLI 密钥 |
| `XFYUN_APP_ID` · `XFYUN_API_KEY` · `XFYUN_API_SECRET` | 账号级 | 讯飞 ISE |
| `WX_APPID` · `WX_SECRET` | 账号级 | 小程序 AppID / AppSecret（**服务端**用：/tcb/* 与 code2session） |
| `WXCLOUD_ENV_ID` | **环境级** | dev / prod 各一份 |
| `MYSQL_ADDRESS` · `MYSQL_USERNAME` · `MYSQL_PASSWORD` · `MYSQL_DATABASE` | **环境级** | 同上 |
| `TOKEN_SECRET` | **环境级** | ⚠️ 各环境**必须不同**且不能省 —— 省了脚本会现生成一个，而 runner 是临时的，等于每次部署都换密钥、登录态全掉 |

环境级那几个建议用 GitHub **Environment**（建 `dev` / `prod` 两个）承载。
顺带可以给 `prod` 配 **Required reviewers** —— 那样「合并到 main」就变成需要你点一下确认。

另有一个**变量**（Variables，不是 Secret）：`SEED_ON_START`。
设成 `true` 时云端启动会灌种子；**prod 首次部署必须开一次**，否则 prod 句库是空的。

## 4.3 四条流水线

| # | 产物 | 触发 | 方式 |
|---|---|---|---|
| 1 | 后端服务 | push | 云托管流水线 / CLI |
| 2 | 小程序体验版 | push | `miniprogram-ci` |
| 3 | 内容 → COS/CDN | ⭐ **手动**（审核驱动） | `workflow_dispatch` |
| 4 | 数据库迁移 | 部署后 | ⚠️ **半自动，需人工确认** |

### 后端 `.github/workflows/deploy.yml` ⭐ 已实装

> 真实文件就是它，下面这段只是摘要；细节（含每个 secret 的用途）写在文件头部注释里。
>
> ```
> push dev  → job deploy-dev  → environment: dev  → node tools/deploy-cloud.mjs dev
> push main → job deploy-prod → environment: prod → node tools/deploy-cloud.mjs prod
> ```
>
> ⚠️ 用的是 `tools/deploy-cloud.mjs` 而**不是**裸的 `wxcloud run:deploy`：
> 服务环境变量是整份覆盖的，裸命令少写一个键就把数据库连接信息冲掉。
> 脚本会先读回当前配置再合并，并自动补 COS_BUCKET / COS_REGION / TOKEN_SECRET。
>
> ⚠️ 路径过滤：`**.md` / `docs/**` / `apps/miniprogram/**` 的改动**不触发**后端部署
> （后端镜像里没有小程序代码）。同一个分支的部署串行，避免云托管报 ResourceInUse。

（下面这段是最初的草稿，保留作为「为什么这么设计」的参考）

```yaml
name: Deploy Server
on:
  push:
    branches: [main, develop]
    paths: ['apps/server/**', 'packages/shared/**']

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile

      # ⭐ 部署前必须过
      - run: pnpm --filter @jushuo/shared typecheck
      - run: pnpm --filter server typecheck
      - run: pnpm --filter server test

      - name: Deploy
        env:
          WXCLOUD_APPID:      ${{ secrets.WXCLOUD_APPID }}
          WXCLOUD_CLI_SECRET: ${{ secrets.WXCLOUD_CLI_SECRET }}
          WXCLOUD_ENVID: ${{ github.ref == 'refs/heads/main'
                           && secrets.WXCLOUD_ENVID_PROD
                           || secrets.WXCLOUD_ENVID_TEST }}
        run: |
          npm i -g @wxcloud/cli
          wxcloud login --appId "$WXCLOUD_APPID" --privateKey "$WXCLOUD_CLI_SECRET"
          wxcloud run:deploy --envId="$WXCLOUD_ENVID" \
            --serviceName=jupin --containerPort=3000 \
            --releaseType FULL --detach --noConfirm
```

### 小程序 `.github/workflows/upload-miniprogram.yml`

```yaml
name: Upload MiniProgram
on:
  push:
    branches: [main, develop]
    paths: ['apps/miniprogram/**', 'packages/shared/**']

jobs:
  upload:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter miniprogram build

      - name: 上传体验版
        env:
          WX_APPID:      ${{ secrets.WX_APPID }}
          WX_UPLOAD_KEY: ${{ secrets.WX_UPLOAD_KEY }}
        run: |
          npx miniprogram-ci upload \
            --pp ./apps/miniprogram \
            --pkp ./private.key \
            --appid "$WX_APPID" \
            --uv "1.0.${{ github.run_number }}" \
            --desc "${{ github.event.head_commit.message }}"
```

> 上传密钥在 **微信公众平台 → 开发管理 → 开发设置 → 小程序代码上传** 生成，配 IP 白名单后写入 Secrets。

### 内容 `.github/workflows/publish-content.yml`

```yaml
name: Publish Content
on:
  workflow_dispatch:
    inputs:
      from_step: { description: '起始步骤', default: '01' }
      to_step:   { description: '结束步骤', default: '09' }
```

**内容不做持续部署**——人工审核驱动，必须手动触发。

## 4.4 ⚠️ 数据库迁移必须单独处理

**迁移不能跟着部署自动跑**：不可逆、多实例滚动发布时可能并发执行、出问题需人工判断。

**用 expand-contract 模式：**

```
部署新代码（兼容新旧两种 schema）
  → 手动 / 单独 job 跑迁移
  → 观察无误
  → 清理旧字段
```

## 4.5 自动化程度总览

| 环节 | 自动化 |
|---|---|
| 后端构建 + 部署 | ✅ push 即部署 |
| 类型检查 / 测试 | ✅ CI 卡口 |
| 小程序体验版 | ✅ 自动上传 |
| **小程序正式发布** | ❌ **必须人工**（微信平台硬限制，绕不过） |
| 数据库迁移 | ⚠️ 半自动 |
| 内容生产 + 发布 | ⚠️ 手动触发 |

---

## 4.6 MySQL 5.7 → 8.0：只能注销重建，不能原地升级

> 官方原文（[云托管 MySQL 文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/guide/mysql/)）：
> 「**不支持从 MySQL 5.7 原地升级到 MySQL 8.0，需要注销后重新开通。**」
> 「选定数据库版本后不可修改，需要注销数据库后重新开通。」

云托管 MySQL 是 serverless 托管实例，**控制台不给版本升级入口**，
CLI 也只暴露了 `DescribeWxCloudBaseRunDBClusterDetail` 一个只读接口（没有 create/upgrade/delete）。
所以「升级」= **销毁 + 重新开通 + 迁数据**。

### 三个不可逆的决策点

| # | 决策 | 说明 |
|---|---|---|
| 1 | **版本** | 开通后不可改 |
| 2 | **`lower_case_table_names`**（大小写敏感） | ⚠️ **8.0 开通后不支持修改**，选定即锁死 |
| 3 | **新密码** | 重新开通要重设，旧密码作废 |

⭐ **第 2 条我们不受影响**：本项目的表名 / 列名 / 索引名 / 约束名**全部小写**
（`users` `articles` `submissions` `payments` `article_tags` …），
所以大小写敏感与否都安全，选默认即可。

### 操作步骤

```bash
# 0. 先看清当前真实地址与版本，记下来备用
pnpm db:info

# 1. 控制台 → dev 环境 → MySQL → 「销毁数据库」
#    ⚠️ 数据全丢。判断标准见下。

# 2. 「重新开通」，版本选 8.0，设新密码

# 3. 改 .env.dev（deploy 时会覆盖服务配置，不用去控制台手改）
#    MYSQL_ADDRESS=<新的内网地址:3306>
#    MYSQL_PASSWORD=<新密码>
pnpm db:info          # 校验 .env.dev 与真实地址是否一致

# 4. 部署：AUTO_MIGRATE=true 会在容器启动时自动建表
pnpm deploy:dev
curl https://jushuo-219743-12-1258596499.sh.run.tcloudbase.com/health
# 期望 db: ready / migrated: true

# 5. 灌种子（需要临时开一下外网地址，从本机打；灌完可关）
DATABASE_URL='mysql://root:<密码>@<外网地址>/jushuo' \
  node_modules/.bin/tsx apps/server/src/db/seed.ts
```

### ⚠️ 什么时候可以「直接销毁」，什么时候必须先导出

| 库里的东西 | 做法 |
|---|---|
| 只有种子数据（`pnpm seed` 能重建） | ✅ 直接销毁，重建后重灌 |
| 有真实用户数据（成绩 / 支付记录） | ⛔ **必须先导出**。见 CloudBase 的 [MySQL 版本升级](https://docs.cloudbase.net/database/configuration/db/tdsql/up-version) 流程：DMC 平台导出 SQL → 销毁 → 重开 8.0 → 导入 |

本项目 dev 环境的判断（2026-09 实测）：`articles` 5 行（种子）、其余全空
→ **可以直接销毁**。

### 为什么建议**现在**做而不是以后

同样的操作，现在做和以后做的成本差别很大：

- **现在**：库里只有可重建的种子数据，20 分钟搞定；
- **以后**：一旦有了真实成绩和支付记录，就必须走 DMC 导出/导入，
  而且支付记录涉及对账，导错一行都是事故。

另外 MySQL 5.7 已于 **2023-10 EOL**，不再有安全更新。

### 我们的 schema 在 5.7 上能跑，8.0 也能跑

已实测：迁移 SQL 在真实云库（5.7.18-cynos）上跑通，4 张表 + 索引 + 外键全部正确，
`datetime(3) DEFAULT CURRENT_TIMESTAMP(3)` 也正常生成。
本项目**不使用任何 8.0 独有特性**（无 CTE / 窗口函数 / `RANK` 保留字冲突），
所以升级前后行为一致 —— 升级的动机是**维护性**（EOL），不是功能。

---

## 4.7 三环境架构：local / dev / prod

| 环境 | 谁在用 | API 通道 | 云托管环境 | 服务 |
|---|---|---|---|---|
| **local** | 开发者工具**模拟器** | `wx.request` → `http://localhost:8899` | dev（仅用于对象存储） | 本机 Docker |
| **dev** | **真机调试 / 预览 / 体验版** | `wx.cloud.callContainer` | `dev-0go66cfz212d3d83` | `jushuo` |
| **prod** | **正式版（release）** | `wx.cloud.callContainer` | `prod-9gjwc01kcd98d6d1` | `jushuo` |

### 怎么自动分流的

两个信号组合判定，**不需要手改任何一行**：

```ts
wx.getDeviceInfo().platform            // 'devtools' | 'ios' | 'android'
wx.getAccountInfoSync()
  .miniProgram.envVersion              // 'develop' | 'trial' | 'release'
```

```
platform === 'devtools'          → local     （模拟器一律打本机）
envVersion === 'release'         → prod      （正式版）
其余（develop / trial）           → dev       （真机调试 / 预览 / 体验版）
```

**实测 5 个场景全部通过**（`ENV` / `TARGET` 是 config.ts 导出的，自检页会显示）：

| 场景 | platform | envVersion | → 环境 |
|---|---|---|---|
| 模拟器 | `devtools` | `develop` | `local` → `http://localhost:8899` |
| 真机调试 (iOS) | `ios` | `develop` | `dev` → callContainer |
| 真机调试 (Android) | `android` | `develop` | `dev` → callContainer |
| 体验版 | `ios` | `trial` | `dev` → callContainer |
| 正式版 | `android` | `release` | `prod` → callContainer |

### ⚠️ 体验版为什么也指向 dev

体验版是给测试者用的。如果它指向 prod，**测试成绩会写进正式榜单** ——
对一个以「竞技场排名」为核心的产品，用户看到的排名就是脏的。

要改成指向 prod，把 `config.ts` 里 `resolveEnv()` 的 `trial` 分支挪一下即可（只有一行）。

### 手动强制某个环境

```ts
// apps/miniprogram/src/config.ts
export const ENV_OVERRIDE: EnvName | null = 'prod'   // null = 自动
```

临时验证某个环境时用，验完记得改回 `null`。

### ⚠️ 小程序端的配置是**构建时注入**的，不在源码里

小程序**没有运行时环境变量**（没有 `process.env`），所以环境 ID、服务名、地址
必须在构建时烘进包里。但这不等于要写在源码里。

```
根目录 .env 的 MP_* 变量
        ↓  apps/miniprogram/build.mjs 读取
        ↓  esbuild define 注入
apps/miniprogram/src/config.ts 里的 __MP_*__ 常量
```

| `.env` 变量 | 用途 |
|---|---|
| `MP_LOCAL_API_URL` | 模拟器打的本机地址 |
| `MP_LAN_API_URL` | 真机走局域网的逃生通道（留空即禁用） |
| `MP_DEV_ENV_ID` | dev 环境 ID |
| `MP_PROD_ENV_ID` | prod 环境 ID |
| `MP_CLOUD_SERVICE` | 云托管服务名 |

**改环境只改 `.env`，不改代码。** CI 里用同名环境变量注入即可复用同一份代码。

⚠️ 前四项缺失时构建会**直接失败**，而不是产出一个静默连不上的坏包。

> 这是被指出来的问题：早期版本把 `dev-0go66cfz212d3d83`、`prod-9gjwc01kcd98d6d1`
> 和某个人的局域网 IP `192.168.31.131` 直接写死在 `config.ts` 里。
> 后果是：改环境要改源码、局域网 IP 绑死在一个人机器上、多环境 CI 无法复用。

### 部署与凭据

```bash
pnpm db:info            # 查 dev 云库真实地址 / 版本 / 状态
pnpm db:info:prod       # 查 prod
pnpm deploy:dev         # 部署到 dev
pnpm deploy:prod        # 部署到 prod
pnpm seed:cloud         # 给 dev 灌种子
pnpm seed:cloud:prod    # 给 prod 灌种子（会警告）
```

⚠️ **凭据按环境分开命名**，不要用同一个变量名：

| 环境 | 变量 |
|---|---|
| dev | `MYSQL_ADDRESS_DEV` / `MYSQL_PASSWORD_DEV` / … |
| prod | `MYSQL_ADDRESS_PROD` / `MYSQL_PASSWORD_PROD` / … |

`deploy-cloud.mjs` 会按目标环境取对应的那一组，写进该环境的服务环境变量。

## 4.8 服务端怎么读小程序直传的音频

小程序用 `wx.cloud.uploadFile` 直传对象存储后，服务端要按 `fileID` 把音频取回来
才能送讯飞评测。这一步有三条路，我们选了第一条。

### ✅ 采用：COS-SDK + 「开放接口服务」取临时密钥

官方文档给的正规做法（[COS-SDK 服务端使用](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/development/storage/service/cos-sdk.html)）：

```js
// ① 取临时密钥（容器内调用，零长期密钥）
GET http://api.weixin.qq.com/_/cos/getauth
// → { TmpSecretId, TmpSecretKey, Token, ExpiredTime }

// ② 用 getAuthorization 回调初始化 COS-SDK（SDK 自动续期）
// ③ cos.getObject({ Bucket, Region, Key }) / cos.deleteObject(...)
```

官方场景文档《[如何处理用户上传的图片然后返回](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/scene/deploy/sharp.html)》
描述的正是我们这条链路：客户端 uploadFile 拿 fileID → 服务端读 → 处理 → 返回。

**`fileID` → COS Key 的转换**已在 `storage/types.ts` 的 `normalizeKey()` 里：

```
cloud://dev-0go66cfz212d3d83.6465-dev-0go66cfz212d3d83-1258596499/audio/xxx.pcm
                              └──────────── bucket ────────────┘ └── key ──┘
```

### ⛔ 前置条件：「开放接口服务」必须在控制台开启

**服务管理 → 云调用 → 打开「开放接口服务」开关**。

⚠️ 未开启时的表现**非常不直观**：`/_/cos/getauth` 返回 **HTTP 404**。
原因是「开放接口服务」本质是平台在容器网络里拦截发往 `api.weixin.qq.com` 的请求、
把 `/_/` 开头的路径转到云调用代理；**开关没打开时请求会真的打到微信服务器**，
而那里根本没有 `/_/cos/getauth` 这个路径，于是 404。

> 本项目为此专门做了深度自检端点：`GET /health?deep=1`（仅 `DIAG_ENABLED=true` 时可用）。
> 它会把「取临时密钥 → 用密钥读一个不存在的 key」整条链路跑一遍，
> 期望拿到 `NoSuchKey` —— 那个错误恰恰证明鉴权、桶、地域全部正确。
> 首次运行就是它把 404 抓出来的，否则要等到真正提交音频才会暴露。

### 另外两条路为什么不选

| 方案 | 为什么不用 |
|---|---|
| 客户端取临时链接（`wx.cloud.getTempFileURL`）后把 URL 发给服务端 fetch | ⚠️ 把服务端变成「按客户端给的 URL 去抓取」——**这是个 SSRF 面**，还得额外维护域名白名单 |
| `tcb/batchdownloadfile` 拿下载链接 | 需要 `access_token`，等于多一层令牌生命周期管理；而 `/_/cos/getauth` 零令牌 |

### ⚠️ 代价：bundle 从 3.16MB 涨到 6.45MB

`cos-nodejs-sdk-v5` 依赖**已废弃的 `request`**，把整个依赖树拖了进来（+3.3MB）。
镜像本身 141MB，占比可接受；但若要瘦身，**手写 COS v5 签名**（只有 SHA1/HMAC，约 50 行纯函数、可单测）
能把这 3.3MB 全部省掉。目前不做，记账在此。

### 另外：`conf` 依赖不会写盘

SDK 依赖 `conf`，而容器没有持久化存储。查证后确认 `conf` 只在 `sdk/session.js`（断点续传功能）里用到，
我们只用 `getObject` / `deleteObject`，不会触发。

### ⚠️ 三个环境的数据是**完全隔离**的

dev 和 prod 各有自己的 MySQL 与对象存储桶（`6465-dev-…` / `7072-prod-…`），
互不可见。这既是好事（测试不会污染正式），也意味着：

- **不要在 prod 上灌种子数据做验证**；
- 正式榜单的数据只能来自真实用户。

---

# 五、环境变量与密钥

| 环境 | 存放 |
|---|---|
| 本地 | `.env`（gitignore） |
| CI | GitHub Secrets |
| 生产 | 云托管控制台环境变量（⚠️ 但 `MYSQL_*` 可在本地 `.env` 覆盖，见 `tools/deploy-cloud.mjs`） |

**数据库相关工具**：`pnpm db:info` 查云库真实地址/版本/状态；
`pnpm deploy:dev` 部署（本地 `.env` 的 `MYSQL_*` 覆盖服务配置）。

**密钥清单**：`XFYUN_APP_ID` · `XFYUN_API_KEY` · `XFYUN_API_SECRET` · `DATABASE_URL` · `WX_APPID` · `WX_SECRET` · `TOKEN_SECRET` · `FISH_AUDIO_KEY` · `LLM_KEY` · `COS_SECRET_ID` · `COS_SECRET_KEY`

**CI 专用 Secrets**：`WXCLOUD_APPID` · `WXCLOUD_CLI_SECRET` · `WXCLOUD_ENVID_PROD` · `WXCLOUD_ENVID_TEST` · `WX_UPLOAD_KEY`

---

# 六、当前状态

| 阶段 | 状态 |
|---|---|
| 产品设计 | ✅ 定稿（prd.md） |
| 技术选型 | ✅ 定稿（spec.md） |
| 工程搭建 | ✅ 脚手架跑通（4 包 typecheck + 音频单测 + 端到端接口 + 本地 Docker） |
| **云端部署** | ✅ **已部署**（dev 环境，`/health` 可达，`db: ready`） |
| 云端数据库 | ✅ **已打通**（地址修正后一次连上，迁移完成，种子已灌） |
| **技术验证 T1–T6** | ✅ **已完成**（iOS + Android 双端通过，端侧架构成立） |
| **产品验证 P1–P4** | ⏳ **待做**（需要讯飞密钥 + 4–6 位朗读者） |

## ✅ 已解决：`connect ETIMEDOUT` 的真正原因是地址过期

数据库实例**一直活着**，只是**内网地址变了**：

| | 地址 |
|---|---|
| 服务环境变量里（v1 时代，2026-01 写死） | `10.23.106.149:3306` ❌ |
| 实际内网地址 | `10.10.103.14:3306` ✅ |

云托管 MySQL 是 **serverless 实例**，实例重建/迁移后内网 IP 会变，
而服务环境变量不会自动跟着变 —— 于是容器连一个已经不存在的地址，表现为 `ETIMEDOUT`
（**连接超时而非拒绝**：没有任何东西回 RST，包直接进了黑洞）。

`ETIMEDOUT` vs `ECONNREFUSED` 是很有用的区分：

- `ECONNREFUSED` = 有东西应答并发了 RST → 主机可达、端口没开
- `ETIMEDOUT` = **完全没有应答** → 地址不可路由 / 被防火墙静默丢弃

**现在怎么查**（CLI 没有数据库命令，但开发了一个工具）：

```bash
pnpm db:info      # 打印集群 ID / 版本 / 状态 / 内网地址 / 外网地址
```

它直接调 CLI 内部的 `DescribeWxCloudBaseRunDBClusterDetail` 接口 ——
CLI 只暴露了这一个数据库接口，没有命令包装它。

修正地址只需改本地 `.env` 的 `MYSQL_ADDRESS` 然后 `pnpm deploy:dev`
（本地 `.env` 的 `MYSQL_*` 会覆盖服务配置，比去控制台手改省事 ——
控制台改配置要求「没有部署任务在跑」，否则报 `ResourceInUse`）。

## 下一步

1. ✅ **T1–T6 已完成**（2026-09-15，iPhone 15 + Redmi K30）。
   结论：**端侧架构成立** —— `onFrameRecorded` 两端都稳定回帧，音频都是 16kHz 单声道。
   详见 [validation-experiment.md 表 5](docs/experiments/validation-experiment.md)。
   ⚠️ 两个必须记住的实测结论：
   - **`frameSize` 只是建议**：请求 2KB，iOS 给 4096、Android 给 2560。不能拿它推期望值。
   - **iOS 的 JS 比 Android 慢一个数量级**（YIN 单帧 7.2ms vs 0.55ms，疑为 iOS 无 JIT）。
     端侧算法的性能预算必须按 **iOS** 定。

2. ⭐ **实现 `WxCloudStorage.get/remove`** —— 提交链路要按 fileID 取回音频。
   完成后整条「录音 → 上传 → 评分 → 榜单」才跑得通。
2. 考虑 **MySQL 5.7 → 8.0**：云托管**不支持原地升级**，只能注销重建（见 4.6 节）。
   现在库里只有可重建的种子数据，是**成本最低的时机**。
3. 实现 `WxCloudStorage.get/remove` —— 提交链路要按 fileID 取回音频。
4. 跑合并验证实验。**技术风险最高的一条**是 `onFrameRecorded` 在 iOS/Android 的真机行为——
   **它挂了，整个端侧架构就要重来**。

> ⚠️ 开发者工具无法调试麦克风，**必须真机**。
> 而真机又打不到本地（云托管只保证「模拟器中的 callContainer 请求会请求到本地」），
> 所以真机联调必须依赖上面这条云端链路。

---

# 附：已废弃（不要参考）

| 内容 | 状态 |
|---|---|
| `AGENTS.md` | ⚠️ **描述的是被废弃的旧设计**（D/Q/E/P 积分、能力分曲线、SolidJS），仅作历史参考 |
| `docs/` 下旧文档 | ⚠️ 同上，均已废弃 |
| `frontend/` `backend/` | ⚠️ 旧实现，不继承 |
