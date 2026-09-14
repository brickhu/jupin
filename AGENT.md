# 句说 · 项目入口

> **每次开始任务前先读本文件。**
> 前四节是必读；工程细节（仓库结构 / 调试 / 部署）按需查阅。

---

## 一句话

**以句子为单位的英语朗读竞技场。**

用户在短文里选一个 10–20 秒的句群朗读，与所有读过同一句群的人比排名。竞技场天然公平——所有人读同一段文本，比的是纯发音质量。

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
├── docker-compose.yml           # ⭐ 本地 PostgreSQL + API
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
├── build.mjs                    # esbuild 构建脚本
├── src/
│   ├── app.ts / app.json / app.wxss
│   ├── pages/                   # 首页 · 短文页 · 朗读页 · 揭晓页 · 我的
│   ├── components/              # 词级上色文本 · 呼吸灯 · 榜单 · 冷却弹层
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

**⚠️ 小程序 + monorepo 的三个特有摩擦点：**

| 摩擦点 | 后果 |
|---|---|
| 小程序不解析 `node_modules` 依赖树 | workspace symlink 会让"构建 npm"失灵 |
| **Worker 必须是单文件** | 不能 `require` 外部包，必须独立打包 |
| 无打包器 | WXML/WXSS/JSON 需单独拷贝 |

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

## 1.2 后端 `apps/server/`

```
apps/server/
├── src/
│   ├── index.ts                 # Hono app
│   ├── routes/
│   │   ├── auth.ts              # wx.login → openid → 签发 token
│   │   ├── arenas.ts            # 竞技场元数据 · 榜单 · 榜心
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

---

# 二、环境搭建

```bash
# 1. 依赖
pnpm install

# 2. 本地数据库（+ 首次迁移与种子）
pnpm db:up                        # docker compose up -d db
pnpm db:generate                  # 仅 schema 变更后需要
pnpm db:migrate
pnpm seed

# 3. 起后端（.env 里 ENGINE=mock，不烧额度）
pnpm dev                          # → http://localhost:3000

# 4. 小程序
pnpm dev:mp                       # esbuild --watch
# 然后微信开发者工具打开 apps/miniprogram（miniprogramRoot 指向 dist/）

# 5. 验证
pnpm -r typecheck
pnpm -r test
```

## ⚠️ 端口冲突（本机已有 Postgres / 其他服务时）

`docker-compose.yml` 的宿主机端口是**可配置**的：

```bash
DB_PORT=5544 API_PORT=8899 docker compose up -d db
```

并把 `apps/server/.env` 的 `DATABASE_URL` 指向同一端口。

**⚠️ 注意**：`API_PORT` 映射后，后端进程本身也要监听同一端口（`PORT` 环境变量）。

## 已验证的脚手架能力

| 项 | 命令 | 状态 |
|---|---|---|
| 全量类型检查 | `pnpm -r typecheck` | ✅ 4 个包通过 |
| 音频算法单测 | `pnpm --filter @jushuo/shared test` | ✅ 15 个用例 |
| 后端端到端 | 登录 → 提交 → 排名 → 冷却被拦 | ✅ 跑通 |
| 小程序构建 | `pnpm --filter @jushuo/miniprogram build` | ✅ Worker 单文件、无 require 残留 |

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

## 3.3 Docker 化（能，但要分层）

| 层 | Docker 化 | 说明 |
|---|---|---|
| **PostgreSQL** | ✅ 推荐 | 一键起、可重置 |
| **后端服务** | ✅ 能，官方就是这条路 | 见下 |
| 内容流水线 | ✅ 能 | 批处理天然适合，但交互调试略麻烦 |
| ⚠️ **小程序端** | ❌ **绝对不行** | **微信开发者工具必须跑在宿主机** |

**微信云托管官方方案「实时开发 / Live Coding」**（VSCode 插件 `Weixin Cloudbase`，容器右键选 Live Coding）会**自动生成 `Dockerfile.development` 和 `docker-compose.yml`**，代码变更自动重启进程。

官方对开发态 Dockerfile 的定义：**单阶段构建 + 编译命令转成启动命令**。
对应到我们：`tsc build` → `tsx watch src/index.ts`。

```yaml
# docker-compose.yml
services:
  db:
    image: postgres:17
    environment: { POSTGRES_DB: jushuo, POSTGRES_PASSWORD: dev }
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s

  api:
    build: { context: ., dockerfile: Dockerfile.development }
    ports: ["3000:3000"]              # ⭐ 必须映射到宿主机，真机才能访问
    volumes:
      - ./:/app                       # 源码挂载 → 热重载
      - /app/node_modules             # 防止被覆盖
    environment:
      DATABASE_URL: postgres://postgres:dev@db:5432/jushuo
      ENGINE: mock
    depends_on:
      db: { condition: service_healthy }

volumes: { pgdata: }
```

```dockerfile
# Dockerfile.development
FROM node:20-slim
WORKDIR /app
RUN npm i -g pnpm@9 tsx
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "server", "dev"]
```

## 3.4 ⚠️ 真机调试的网络（最痛的一环）

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

## 4.0 ⚠️ 部署目标：微信云托管（当前状态：**未部署**）

**方案已定，但尚未落地**——只有 `apps/server/Dockerfile` 就绪，云环境/CI 都还没建。

### 三条硬约束（先读，否则会返工）

| # | 约束 | 后果 |
|---|---|---|
| **1** | ⚠️ **小程序 → 云托管服务的请求体有大小限制**（大请求报 nginx 413） | **音频不能走请求体**——20 秒音频 640KB 必被拒 |
| **2** | ⭐ **CallContainer 免域名、免备案**，且 openid 直接从 header 拿 | 自建服务器要买域名+备案+配白名单，云托管全免 |
| **3** | **容器不支持持久化存储** | 音频/内容必须走对象存储 |

### 因此的架构决策

```
① 小程序 wx.cloud.uploadFile → 对象存储直传（无大小限制，有进度回调）
② CallContainer 提交 { arenaId, fileID }  ← 极小请求
③ 后端按 fileID 取回音频 → 调讯飞 → 返回
④ 评完分删除音频（隐私策略）
```

**对象存储已做成可替换接口**（`apps/server/src/storage/`）：本地用 `LocalStorage`（落盘 `.uploads/`），生产用 `WxCloudStorage`（**待云环境就绪后实现**）。

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
  --serviceName=jushuo-api \
  --releaseType FULL --detach --noConfirm
```

CLI 密钥在 **云托管控制台 → 全局设置 → CLI 密钥** 生成，存 GitHub Secrets（不可明文入 yml）。

## 4.2 分支策略

| 分支 | 后端 | 小程序 | 数据库 |
|---|---|---|---|
| `feature/*` | 不部署 | 仅 CI 检查 | — |
| `develop` | 测试环境 | 上传体验版 | 自动迁移（测试库） |
| `main` | 生产环境 | 上传体验版 | ⚠️ **人工确认后迁移** |

## 4.3 四条流水线

| # | 产物 | 触发 | 方式 |
|---|---|---|---|
| 1 | 后端服务 | push | 云托管流水线 / CLI |
| 2 | 小程序体验版 | push | `miniprogram-ci` |
| 3 | 内容 → COS/CDN | ⭐ **手动**（审核驱动） | `workflow_dispatch` |
| 4 | 数据库迁移 | 部署后 | ⚠️ **半自动，需人工确认** |

### 后端 `.github/workflows/deploy-server.yml`

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
            --serviceName=jushuo-api --containerPort=3000 \
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

# 五、环境变量与密钥

| 环境 | 存放 |
|---|---|
| 本地 | `.env`（gitignore） |
| CI | GitHub Secrets |
| 生产 | 云托管控制台环境变量 |

**密钥清单**：`XFYUN_APP_ID` · `XFYUN_API_KEY` · `XFYUN_API_SECRET` · `DATABASE_URL` · `WX_APPID` · `WX_SECRET` · `TOKEN_SECRET` · `FISH_AUDIO_KEY` · `LLM_KEY` · `COS_SECRET_ID` · `COS_SECRET_KEY`

**CI 专用 Secrets**：`WXCLOUD_APPID` · `WXCLOUD_CLI_SECRET` · `WXCLOUD_ENVID_PROD` · `WXCLOUD_ENVID_TEST` · `WX_UPLOAD_KEY`

---

# 六、当前状态

| 阶段 | 状态 |
|---|---|
| 产品设计 | ✅ 定稿（prd.md） |
| 技术选型 | ✅ 定稿（spec.md） |
| **验证实验** | ⏳ **待做 — 动手前的必经步骤** |
| 工程搭建 | ⛔ 未开始 |

**下一步只有一个：跑合并验证实验。**

必须最先验的是**技术风险最高的一条**：`onFrameRecorded` 在 iOS/Android 的真机行为——**它挂了，整个端侧架构就要重来**。

> ⚠️ 开发者工具无法调试麦克风，**必须真机**。

---

# 附：已废弃（不要参考）

| 内容 | 状态 |
|---|---|
| `AGENTS.md` | ⚠️ **描述的是被废弃的旧设计**（D/Q/E/P 积分、能力分曲线、SolidJS），仅作历史参考 |
| `docs/` 下旧文档 | ⚠️ 同上，均已废弃 |
| `frontend/` `backend/` | ⚠️ 旧实现，不继承 |
