# 句拼 · 项目入口

> **每次开始任务前先读本文件。**
> 本文件只回答「**去哪看**」（索引）与「**怎么跑起来**」（操作手册）。业务规则、字段定义、产品行为不写在这里 —— 重复即错误。

## 一句话

**句拼 —— 每日英语朗读竞技场。** 英文朗读大比拼，AI 评分冲排名。

三条核心：**AI 反馈的得分 · 排名 · Streak**；难度 / 分类 / 积分 / 关卡刻意不做。

> ⚠️ 成长体系已不是「等级徽章」——徽章**整体废除**，现为 **三个成长值指标（自我超越 / 坚持不懈 / 人中翘楚）+ 能量 + 解冻卡**。
> 口径见 [prd.md](prd.md) 与 [docs/design/growth-and-energy.md](docs/design/growth-and-energy.md)；字段与规则以代码注释为准
> （[schema.ts](apps/server/src/db/schema.ts) · [types/api.ts](packages/shared/src/types/api.ts)）。

> ⚠️ 定位文案的唯一来源是 [packages/shared/src/brand.ts](packages/shared/src/brand.ts)。

---

## 文档与真相来源（先读这一节）

| 来源 | 角色 | 权威范围 |
|---|---|---|
| **代码及其注释** | **真相** | 业务规则与逻辑的唯一来源；变更 = 改注释 |
| [plan.md](plan.md) | **唯一的目标与任务来源** | 哪些做了、哪些没做；状态只有 在做/待办/已完成/已废弃 |
| [prd.md](prd.md) | **唯一的业务与需求来源** | 业务名词、概念、需求 |
| **AGENT.md**（本文件） | 工程**架构索引 + 上下文索引** | 只回答「去哪看」与「怎么跑起来」 |
| [spec.md](spec.md) | 技术决策记录（已降级） | 为什么这样选型；不再承载表结构（指向 `schema.ts`） |
| [docs/](docs/README.md) | 调研 · 实验 · 设计稿 · 归档 | 需要依据与背景时 |

**元规则：重复即错误。** 同一事实出现在第二个地方，即使当下一致，也已经是 bug 的种子；改一处必须删掉/改掉别处。
所以本文件已删除一切复述业务规则 / 数据模型字段 / 产品行为的段落，只留指向代码或 prd.md 的指针。

**开工顺序**：先读 AGENT.md（工程怎么跑）→ 任务看 **plan.md** → 业务看 **prd.md** → **现状看代码与注释**。

docs/ 子目录：[research/](docs/README.md)（引擎横评 · ISE 实测 · 端侧能力 · 内容生产 · 平台选型 · 样式选型）·
[design/](docs/design/growth-and-energy.md)（成长与能量 · 奖励/解冻卡 · 支付）·
[experiments/](docs/experiments/validation-experiment.md)（合并验证实验）·
[probes/](docs/probes/probe-ise-stream.cjs) · archive/（v1 废弃）。

> ⚠️ **任务清单不在本文件**：历史的「当前状态 / 下一步」表已收编进 plan.md。

---

## 统一开发流程（每次任务都走这五步）

> 前两步是**文档先于代码**：先在 plan 里落任务 → 再在 prd 里对齐概念 → 然后才写代码。
> 反过来（先写代码后补文档）等于让代码当真相、文档当注释 —— 文档必然追不上。

| 步 | 做什么 | 判据 |
|---|---|---|
| **① 落任务** | 需求如果是明确的 plan/todo，**先写进 [plan.md](plan.md)**（带 ID + 做完的标志），再动手 | plan.md 里有这一条 |
| **② 对齐文档** | 如果是**新需求 / 新概念**，先改 [prd.md](prd.md)（名词、概念、应该是什么）；涉及「为什么这么选」再动 [spec.md](spec.md) | 文档没对齐不写代码 |
| **③ 编码 + 注释** | 写代码，**同时**把规则变更写进注释（代码是真相，注释是它的一部分） | 改代码不改注释 = bug |
| **④ 提交时闭环** | commit 信息带 `plan <ID>`；提交前跑 `pnpm check`；然后 `pnpm plan:sync` 按 git 把 `- [ ]` 勾成 `- [x]` 并归档进「已完成」 | `pnpm plan:status` 认得出这条，且没有 🔲 |
| **⑤ 无 commit 的完成项** | 真机实验 / 外部配置 / 决定这类做完也没有 commit 的，在 plan.md 手写一行并标 `[无 commit]` | 这类条目要少 |

**提交信息格式**（scope 里挂任务 ID）：

```
feat(plan B1): 清掉旧额度时代的残留
fix(plan C3): prod 建库后迁移 0031 才跑得通
```

**⚠️ 提交 ≠ 推送 —— 这两个动作性质不同**（`plan:status` 会分别标出来）

| 动作 | 是什么 | 影响 |
|---|---|---|
| 改工作区 | 草稿 | 无 |
| `git commit` | **记账** | 幂等、可回滚；**不影响远程、不影响部署** |
| `git push` | **发布** | ⚠️ push 到 `dev` / `main` 会触发 `.github/workflows/deploy.yml` **真的部署**到对应云环境（只有纯 `**.md` / `docs/**` / `apps/miniprogram/**` 的改动不触发） |

⇒ **记账用 commit，发布才 push。**
**权限边界（明确写死）**：AI agent 的操作权限**到 `git commit` 为止**；
`git push` **只能由人来决定** —— 因为 push 就是发布（见上表），
不能让一次「整理记录」的动作顺手把线上改了。
`pnpm plan:status` 读的是**本地** git 历史，但它会把「已推送 / 仅本地」分开标 ——
因为仅本地的 commit 只在**这台机器**上成立，换一台机器或 CI 就是另一个答案。

**「已完成」由 git 派生，不手写。** plan.md 里 `- [ ]` = 未完成、`- [x]` = 已完成；
`pnpm plan:status` 扫提交信息里的 `plan <ID>`，把每个任务对上它的 commit（时间 + sha + 推送状态），
`pnpm plan:sync` 再据此**回写** checkbox 并把整行搬进「## 已完成」段。
⇒ `[x]` 是 git 的**投影**，不是第二份真相；人只写 `- [ ]`，机器只写 `[x]`。
天生没有 commit 的完成项（真机实验 / 外部配置 / 决定）手写进「已完成 · 无 commit」段。

---

## 多任务并行（冲突只在四个地方）

> 并行的难点不是「合并冲突」，而是**互相覆盖**：两个任务在同一个目录改文件，
> 后保存的赢，而且**当场没有任何报错**。所以先隔离工作区，再谈合并。

| # | 冲突面 | 为什么 | 怎么消 |
|---|---|---|---|
| ① | **工作区**（文件互相覆盖） | 同一目录两个任务同时改 | **一个任务一个 worktree**：`pnpm task:start B9` → `.worktrees/wt-B9`，分支 `feature/B9` |
| ② | **迁移**（序号 + journal + snapshot） | drizzle 的迁移**全局有序**：两个分支各 `db:generate` 一次会抢同一个序号，`_journal.json` 与 snapshot 必冲突 | **串行资源**：同一时刻只允许一条在飞；后合并的那条**删掉自己那份重新 generate** |
| ③ | **单一真相文件**（`shared` 的公共类型 / 函数、`plan.md`） | 它们被设计成「只有一处」，天生是热点 | 改公共面的任务**不与任何任务并行**（先合它，别人再 rebase）；`plan.md` 只**追加**自己那一段 |
| ④ | **运行时资源**（MySQL `:5544`、API `:8899`、容器名 `jushuo-*`） | 两个 worktree 都跑 `pnpm dev:docker` → 端口 / 容器名撞车 | **只有一条任务线跑 Docker**；其余只跑 `pnpm check` |

**一条规则**：并行度 = **互不相交的写入面**。分不清两个任务的写入面是否相交，就别并行。

### `plan.md` 是最容易撞的文件

`pnpm plan:sync` 会**整段重建**「已完成」段（把 `[x]` 行搬进去）。两个分支各跑一次 ⇒ 合并必冲突，还可能丢改动。

- 任务分支：**只追加**自己的 `- [ ]` 行，**不要**跑 `plan:sync`。
- 合并进 `dev` 之后，**在 dev 上跑一次** `pnpm plan:sync`，单独提交。

### 合并与发布

`dev` / `main` 是 **push 即部署**（带 `AUTO_MIGRATE`，dev 还有 `SEED_ON_START`）—— 所以**合并即发布**。
多个任务并行完成时：

1. 先合「碰公共面」的那条（`shared` / 迁移）。
2. 其余依次 `git rebase dev` 再合并（每次合并触发一次部署，`concurrency` 保证串行）。
3. 想**一次发多个任务**：先合到 `integration/<批次>` 分支跑 `pnpm check`，绿了再一次合进 `dev`。

> ⚠️ `feature/*` 分支 push **不部署**（见 §4.2）—— 所以任务分支推到远端备份是安全的；
> 但按规矩 **push 由人决定**，agent 只 commit。

---
## 仓库与分支（开工前第一件事）

远端：<https://github.com/brickhu/jupin>（public）

| 分支 | 用途 |
|---|---|
| **`dev`** | **日常开发都提交在这里**。开工前先 `git switch dev` |
| **`main`** | 只从 `dev` 合并，不直接在上面提交。它是 GitHub 默认分支 |

```bash
git switch dev                      # 开工
# …改动…
git add -A && git commit -m "feat: …"
git push                            # 推到 origin/dev
git switch main && git merge dev && git push && git switch dev   # 合主线
```

> ⚠️⚠️ **部署取「当前工作区」，跟 git 与提交状态完全无关**：`pnpm deploy:dev` 把仓库根当场打包上传
> （`run:deploy --targetDir .`），小程序上传读本地 `dist/`。要线上是某分支，先切过去、工作区干净，再部署。

---

## 常用命令（都在仓库根执行）

| 命令 | 作用 |
|---|---|
| `pnpm install` | 装依赖（pnpm workspace） |
| `pnpm typecheck` / `pnpm test` / `pnpm build` | 全仓类型检查 / 测试 / 构建（`pnpm -r …`） |
| `pnpm check` | 上面三样 + **文档检查**（`pnpm check:docs`）+ **plan 闭环检查**（`plan:status --strict`） |
| `pnpm plan:status` / `pnpm plan:sync` | 打印任务 vs git 证据 / 按 git 回写 plan.md 的 checkbox（**唯一会改 plan.md 的模式**） |
| `pnpm dev:docker` | 起 db + api（`docker compose --profile full up -d --build`，自动迁移 + 种子） |
| `pnpm dev:docker:logs` / `:ps` / `:down` / `:reset` | 跟日志 / 看状态 / 停 / 推倒重来（删卷重建） |
| `pnpm dev:mp` / `pnpm dev` | 小程序 esbuild --watch / 本机直跑后端（配合 `pnpm db:up`） |
| `pnpm db:up` / `pnpm db:down` | 只起 / 停 MySQL 容器 |
| `pnpm db:generate` / `db:migrate` / `seed` / `seed:arena` | 生成迁移 / 跑迁移 / 灌种子 / 灌开发竞技场 |
| `pnpm pipeline`（`… run --from 04 --to 09`） / `pnpm content:audio` | 内容流水线 / 本地补标准音 |
| `pnpm admin` | 本地内容管理台 → `http://127.0.0.1:4983` |
| `pnpm db:info` / `db:info:prod` | 查云库真实地址 / 版本 / 状态 |
| `pnpm deploy:dev` / `deploy:prod` | 部署到云托管 dev / prod |
| `pnpm seed:cloud` / `seed:cloud:prod` | 给云库灌种子（走外网地址，见 `4.6） |
| `pnpm dev:unlock` / `dev:unlock:status` | 本地账号置会员 / 只看状态（见 `3.6） |

---

## 架构为什么这样切

**云端只买「一个分数」**（`score(audio, refText) → number`，其余端侧自建）、**高频动作边际成本为 0**（录音/重录本地无限，提交检测是唯一花钱处）、**榜单用云端分、个人参考用端侧分**。
完整论证在 spec.md 第一节与 prd.md，实现见 `apps/server/src/engines/` 与 `packages/shared/src/`。

---

# 一、仓库结构

pnpm workspace monorepo。**正文与音频的真相是 `content/`（不在库里）**。

```
jupin/
├── AGENT.md  plan.md  prd.md  spec.md
├── package.json  pnpm-workspace.yaml  tsconfig.base.json
├── docker-compose.yml        # ⭐ 本地 MySQL + API
├── .dockerignore             # ⚠️ 云托管按它裁剪上传；绝不能写 ! 否定规则
├── content/                  # 静态内容：articles/<id>.json · audio/<id>.mp3 + <id>/wN.mp3 · misc/
├── packages/shared/          # 唯一共享包：类型 / 常量 / 纯函数（含端侧音频算法）
├── apps/{miniprogram,server}/
└── tools/
    ├── pipeline/             # 内容生产流水线（离线）
    ├── admin/                # 本地内容管理台（句库管理 · 127.0.0.1:4983）
    ├── deploy-cloud.mjs  cloud-db-info.mjs  seed-cloud.mjs  gh-secrets.mjs  dev-unlock.mjs  wipe-history.mjs
    ├── env.mjs               # ⭐ 环境变量分层加载（唯一入口）
    └── iconfont/
```

## 1.1 小程序端 `apps/miniprogram/`

```
apps/miniprogram/
├── project.config.json          # miniprogramRoot: "dist/"
├── build.mjs                    # esbuild 打包 + UnoCSS 生成 + 静态拷贝 + es2017 守卫
├── uno.config.mjs  wxss-lint.mjs  wxml-handlers.mjs
└── src/
    ├── app.ts / app.json / app.wxss / iconfont.wxss
    ├── pages/                   # index · reading · arena · challenge · join · profile
    │                            #   me/{streak,energy,challenges,participations,edit-user}
    ├── components/              # nav-bar · user-sheet · arena-card · submission-card · audio-button · profile-form
    ├── lib/                     # api/ · audio/ · content/ · store.ts · join.ts · nav.ts …
    └── typings/
```

| 摩擦点 | 后果 |
|---|---|
| 小程序不解析 `node_modules` 依赖树 | workspace symlink 会让「构建 npm」失灵 |
| 无打包器 | WXML/WXSS/JSON 需单独拷贝 |
| 真机引擎不保证支持新语法 | 产物必须降到 ES2017，见下 |
| 有状态模块必须**外置** | 内联会被每个页面各求值一次 →「全局 store 不全局」 |

**⚠️⚠️ `build.mjs` 的 `target` 绝不能高于 `es2017`**：`project.config.json` 里 `es6` / `enhance` 都是 `false`，
放弃开发者工具的降级兜底；`??` / `?.` 一旦漏进产物，**真机解析直接抛 `SyntaxError: Unexpected token ?`，而模拟器完全正常**。
不更低是因为 esbuild 无法把 `async/await` 降到 ES5。`assertNoModernSyntax()` 构建后复查，残留即**退出码 1**，别绕过。
（不用 Taro/uni-app：核心是音频处理与高频上色动画，跨端框架恰在这里最易出坑，且不做多端。）

**样式方案 UnoCSS（已接入）**：WXML 不能调用 JS，所以「在 JS 里算类名」的方案（StyleX / CSS-in-JS）都要多搭一层 `data` 桥接；
UnoCSS 走「构建期扫源码 → 静态 WXSS」，运行时零开销。`uno.config.mjs` 配 `downgradeColorSyntax` + `assertWxssSafe`；
`build.mjs` 的 `buildUnoCss()` 扫 `src/**/*.{wxml,ts}` → `dist/uno.wxss`；`src/app.wxss` 顶部 `@import "./uno.wxss"`。
⚠️ 两个静默失效的坑：① 变体分隔符是 `__`（写 `hover__bg-gray-100`，**不是** `hover:bg-gray-100`，也别用 BEM 的 `block__element`）；
② UnoCSS 66 输出 CSS Color 4，产物必须过 `downgradeColorSyntax()`，否则老 WebView 整条颜色声明丢弃。
间距刻度：1 单位 = 8rpx（`p-4` → `32rpx`）。

## 1.2 后端 `apps/server/`

```
apps/server/
├── src/
│   ├── index.ts  env.ts
│   ├── routes/              # auth · articles · schedules · submissions · uploads · leaderboards · arenas · user · pay · shop · media · public
│   ├── engines/             # ⭐ ScoreEngine 薄适配层（types · xfyun · mock）
│   ├── services/            # submission · scoring · streak · growth · energy · schedules · content … 的业务逻辑
│   ├── storage/             # local / wxcloud（可替换接口）
│   ├── db/                  # Drizzle schema + migrations + seed
│   └── lib/
├── build.mjs                # esbuild 打成单文件（原因见 `4.0 坑 ④）
├── Dockerfile               # 正式构建
├── Dockerfile.development   # ⭐ 实时开发用
└── docker-entrypoint.dev.sh # 迁移 → 种子 → tsx watch
```

⭐ `engines/` 是唯一花钱的地方：`score(audio, refText)` 的适配层，可整体替换。本地把 `ENGINE=mock`（见 [.env.local.example](.env.local.example)），不烧额度。

## 1.3 内容流水线 `tools/pipeline/`

```
tools/pipeline/src/   cli.ts（pnpm pipeline run --from 04 --to 09） · steps/（一步一文件） · lib/（fishaudio · ecdict · llm · article-id · article-meta）
```
⭐ 做成可重复、可断点续跑的流水线：内容会持续生产，改第 ⑦ 步不该重跑 ①–⑥。

## 1.4 本地内容管理台 `tools/admin/`

```
tools/admin/   server.ts（node:http：接口 + 静态文件 + 登录） · web/（无构建） · .state.json（会话密钥 + 当前环境，gitignore）
```
句库管理：列表 / 搜索 / 新增（LLM 出译文·难度·标签 → fish 出标准音和词级区间 → 草稿 → 发布）/ 编辑 / 重做标准音 / 排期；右上角切 `local · dev · prod`。
⚠️ 只写本机仓库 + 某一个环境的库，不碰对象存储（音频进桶是部署那一步的事）。详见 [tools/admin/README.md](tools/admin/README.md)。

---

# 二、环境搭建

## ⭐ 推荐路径：一条命令起全套（Docker / OrbStack）

```bash
pnpm install          # 1. 装依赖
pnpm dev:docker       # 2. 起 db + api（自动迁移 + 自动种子）
pnpm dev:mp           # 3. 小程序 esbuild --watch
```
之后用**微信开发者工具**打开 `apps/miniprogram`（`miniprogramRoot` 指向 `dist/`）。容器自动完成迁移 → 种子（幂等）→ 启动，无需单独跑 `db:migrate` / `seed`。
`pnpm dev:docker:logs` / `:ps` / `:down` / `:reset` 跟日志 / 看状态 / 停 / 推倒重来。

**宿主机直跑**（要打断点调后端时，容器化牺牲的正是 attach 调试）：`pnpm db:up && pnpm dev`。

## ⚠️ 小程序连后端的三个坑

**0. 系统代理 —— 最难查，因为它会骗过 curl。** `curl http://localhost:8899/health` 回 200，但开发者工具请求失败：
macOS 系统代理链到一个「能转发外网、但拒绝转发本地地址」的代理（Clash 类常见），Chromium 内核的开发者工具会走它，`wx.request` 绕不过。

```bash
scutil --proxy                                               # → SOCKSProxy: 127.0.0.1, SOCKSPort: 1081
curl -x socks5h://127.0.0.1:1081 http://example.com          # 200 ✅ 代理本身活着
curl -x socks5h://127.0.0.1:1081 http://localhost:8899       # Empty reply ❌
curl -x socks5h://127.0.0.1:1081 http://192.168.31.131:8899  # Empty reply ❌
```
所有本地 / 局域网地址都被拒答 —— 换地址救不了。修法：① ⭐ 开发者工具 → 设置 → 代理设置 → **不使用代理**；② 系统代理「忽略这些主机与域名」加 `localhost, 127.0.0.1, 192.168.0.0/16`；③ 关系统代理。
⚠️ `curl` 不读 macOS 系统代理，所以「curl 能通」不能证明开发者工具能通 —— 必须用 `curl -x <代理> …` 显式走一遍。

**1. 改用本机局域网 IP。** 地址来自构建期注入（`4.7），配在根目录 `.env.local`：
```
MP_LOCAL_API_URL=http://localhost:8899
# MP_LAN_API_URL=http://192.168.x.x:8899   ← 真机逃生通道，留空即禁用
```
查法 `ipconfig getifaddr en0`；端口取根目录 `.env` 的 `API_PORT`。**真机上 `localhost` 指向手机自己**，必须走局域网 IP。

**2. 开发者工具勾选「不校验合法域名」**（详情 → 本地设置）。⚠️ 开发者工具拿不到麦克风，音频相关一律必须真机。

## ⚠️ 端口冲突

`docker-compose.yml` 的宿主机端口可配，根目录 `.env` 里改：
```bash
DB_PORT=5544    # 容器内 MySQL 始终 3306；本机 3306 被占时改这里
API_PORT=8899   # 容器内服务始终 3000；本机 3000 被占时改这里
```
**两个都改，并让 `.env.local` 的 `DATABASE_URL` 跟着一致**：容器里走服务名 `db:3306`，`.env.local` 那份是给宿主机（`127.0.0.1:5544`）的。

**已验证**：`pnpm -r typecheck` 4 包通过 · `pnpm --filter @jushuo/shared test` · 登录→提交→排名→门禁被拦跑通 · `pnpm --filter @jushuo/miniprogram build` 单文件、无 require 残留、语法降到 ES2017。

---

# 三、本地调试

## 3.1 ⭐ 四层策略（大部分时间不需要全栈环境）

```
阶段 1  纯 UI（零 Docker）：小程序 + MockEngine + 本地 mock —— 日常 80% 时间
阶段 2  `pnpm dev:docker`：真 db + 真 api，验证接口契约、榜单、门禁
阶段 3  真机预览 + 局域网 IP：验证音频分析、播放精度
阶段 4  云托管测试环境：端到端，环境与线上一致
```

## 3.2 ⭐ 音频算法必须是纯函数

`packages/shared/src/audio/` 里只有**零平台依赖**的纯函数（FFT / 重采样 / WAV 编解码；入口注释写明不得 import 小程序 / Node / 浏览器 API）。
⚠️ 实时逐词跟随已下线，DTW / MFCC / VAD / 基频全部删除 —— **改动时别再把它们加回来**。
好处：可在 Node 用 vitest 单测、可在 CI 跑、反馈循环从「改代码→上传→真机扫码→读日志」缩短到 `pnpm test`。小程序里调音频是地狱，能搬出来的全搬出来。

## 3.3 ⭐ Docker + OrbStack（已实测通过）

| 层 | Docker 化 | 说明 |
|---|---|---|
| MySQL / 后端服务 | ✅ 推荐 / ✅ 已实测 | 一键起、可重置；本地与线上同一 MySQL 方言 |
| 内容流水线 | ✅ 能 | 批处理天然适合，交互调试略麻烦 |
| ⚠️ 小程序端 | ❌ **绝对不行** | 微信开发者工具必须跑在宿主机 |

命令见 `二。OrbStack 里能看到 `jushuo-db` / `jushuo-api`。实测：容器构建 ✅ · 连 `db:3306` ✅ · **挂载卷热重载 ✅**（`[tsx] change… Restarting...`，这是方案分水岭）· 端口映射 `0.0.0.0:8899->3000` ✅。
两个细节：① 容器内加载挂载进来的 `.env` + `.env.local`，但**真实环境变量优先级最高**（见 [tools/env.mjs](tools/env.mjs)），故 compose 注入的 `db:3306` 生效；② 宿主机 `API_PORT`(8899) → 容器 3000。
⚠️ compose 里**刻意不设 `ENGINE` / `STORAGE`**（由 `.env.local` 决定）—— 两边都写就是两份真相。

## 3.4 本地调试三条路 —— 以及为什么**不用**官方 VSCode 插件

| 方案 | 模拟器怎么连 | 需要什么 | 结论 |
|---|---|---|---|
| **A. `wx.request` 打 localhost**（本项目采用） | `http://localhost:8899` | 只要 Docker | ✅ 默认 |
| B. 官方 VSCode 插件 | `callContainer` 打本地容器 | VSCode + `weixin-cloudbase` + **Nightly** 开发者工具 + 每服务一个 Dockerfile | ⚠️ 不采用 |
| C. 模拟器直接打云环境 | `callContainer` 打**真实 dev 环境** | 什么都不用，改一行 `MODE` | ✅ 验生产链路用 |

不用 B 的理由：① 它解决的问题我们没有（我们本来就打本地容器）；② ⚠️ **官方明说不支持 WebSocket 调试**，而**讯飞 ISE 流式评测走的就是 WebSocket**；③ 它要求「服务根目录下有 Dockerfile」，与我们「构建上下文必须是仓库根」的 monorepo 结构对不上；④ 代价是 VSCode + 插件 + Nightly 工具。
替代（验生产链路）：把 `apps/miniprogram/src/config.ts` 的 `MODE` 设成 `'cloud'` —— `MODE='auto'`（默认）模拟器→本机、真机→dev；`MODE='cloud'` 模拟器也 `callContainer` 到**真实 dev**（零配置）。

⚠️ **必须记住：本地调试拿到的 `x-wx-openid` 不是真实身份**（官方原文：「和线上获取的用户真实 OpenID 不一致」）。
**这直接决定支付方案**：支付强依赖真实 openid，所以**支付联调必须在真实环境做**（真机 `callContainer`，openid 由微信网关注入）；本地 `wx.request` 只能测逻辑。
> 官方文档第六节「本地打通线上 VPC」（Proxy node 让本地容器访问线上内网资源）在「线上才复现」的数据问题时值得回头看。

## 3.5 ⚠️ 真机调试的网络

手机访问不到 `localhost`（指向手机自己）。开发者工具勾「不校验合法域名」；小程序请求地址写 `http://192.168.x.x:8899`（宿主机局域网 IP）。
Docker 端口映射后局域网设备可正常访问。现实的坑：换 WiFi/网络隔离 → IP 变（内网穿透 frp / cloudflared，或固定 IP）；真机不在同一局域网（内网穿透，或直接部署到云托管测试环境）；**音频必须真机**（无法回避）。
⭐ 更省心：把 dev 后端部署到云托管测试环境，免所有网络问题，环境还与线上一致（`dev` 分支自动部署）。

## 3.6 测试时被门禁卡住 → `pnpm dev:unlock`

```bash
pnpm dev:unlock          # 把本地账号置为会员（会员 = 每天 50 次挑战）
pnpm dev:unlock:status   # 只看状态，不改
node tools/dev-unlock.mjs --user <id>   # 只解锁某一个
```
**置为会员，而不是改额度判断** —— 会员是产品真实机制，用一个已存在的产品路径解锁，好过在生产代码里开 if 口子。
⭐ 正常不需要跑：服务端已把「非生产环境一律给会员」做成不变量（`services/user.ts` 的 `withLocalDevPrivilege`）。本脚本是手动兜底。
⚠️ 安全边界：只连本机 docker 容器里的 `jushuo` 库。容器名 / 账号密码可用 `DEV_DB_CONTAINER` 等环境变量覆盖，默认值只指向本地开发库。

---

# 四、部署与 CI/CD

## 4.0 部署目标：微信云托管（已接通）

| 项 | 值 |
|---|---|
| AppID | `wxc0418392e9116a01` |
| 环境 | dev = `dev-0go66cfz212d3d83` ／ prod = `prod-9gjwc01kcd98d6d1` |
| 服务名 | **`jupin`**（`MP_CLOUD_SERVICE`；写错报 `-601031`） |
| 公网域名(dev) | `https://jupin-219743-12-1258596499.sh.run.tcloudbase.com`（前缀跟服务名走，旧的 `jushuo-…` 已 404） |
| 数据库 | 云托管 MySQL，内网 `MYSQL_ADDRESS`（`10.x.x.x:3306`） |

部署：`pnpm deploy:dev`（= `node tools/deploy-cloud.mjs dev`）。

### ⭐ 真机体验前置清单（模拟器连本机 Docker，真机连云托管 dev，是两套东西；跑不通先照此核对，别改客户端）

| # | 条件 | 怎么查（都看 `/health`，云托管没有日志可看） | 谁来做 |
|---|---|---|---|
| 1 | dev 服务已部署且在跑 | `curl <dev域名>/health` 返回 200 | `pnpm deploy:dev` |
| 2 | 表结构是新版 | `existingTables` 里有 **`articles`**；还是 `arenas`/`arena_entries` 即停在旧 schema | `pnpm deploy:dev --reset` |
| 3 | 句库不为空 | `articleCount` 不为 0 / null | `SEED_ON_START=true`（deploy 工具已带上） |
| 4 | 正文文件在镜像里 | `/health?deep=1` 的 `content.ok` = true 且 **`missingCount` 为空** | Dockerfile 已 `COPY content` |
| 5 | ⚠️「开放接口服务」已开启 | `/health?deep=1` 的 `storage.auth` = `ok` | ⛔ 只能在控制台点（见下） |

> 3 与 4 是**两个独立**失败点但客户端表现一样（朗读页「正文加载失败」），故拆成两个字段。
> 4 还会报**差集** `missingCount` / `missingContent`：「库里有这行、镜像里没有它的正文」。非 0 几乎只因内容刚发布进库、镜像没重新部署。
> 客户端读的是镜像里的正文与音频，库里那行只是索引 ⇒ 被轮转抽中的那天全站都会「正文加载失败」。为此 `services/schedules.ts` 的轮转池会跳过读不到正文的句子；
> ⚠️ 但**已明确排期的那天不会自动换题**，所以发布到云环境后要么马上部署，要么盯着 `missingCount`。

**第 5 条是唯一纯人工步骤，且有三件事**（官方四步里前三步缺一不可）：

| 步 | 做什么 | 我们踩的坑 |
|---|---|---|
| ① | 控制台-云调用-**微信令牌权限配置**加接口白名单 | ⭐ 最容易漏；格式是**路径**不是完整 URL，我们要加 **`/_/cos/getauth`** |
| ② | 打开「开放接口服务」开关 | 要开在**本环境**上（有 dev / prod 两个） |
| ③ | **重新构建一次版本** | 官方：「实例扩缩容时**不遵循当前开关，而遵循版本创建时的开关状态**」 |
| ④ | 镜像里要有 shell | 官方：「依赖 shell，无 `sh/bash` 无法正常部署」。我们用 `node:20-alpine` ✓ |

生效判据（官方两个，都做进了 `/health?deep=1`）：① `storage.openapiDns` / `openapiActive` —— 解析到**公网 IP** 说明旁加载 sidecar 不在本实例；② `storage.authError` 里有没有 `x-openapi-seqid` —— 没有即请求没被平台接管。
⭐ 判据 ① 更有信息量（区分「sidecar 不在」与「sidecar 在但请求没匹配」）。两个易混失败：**404 + 空 body + 无 seqid + DNS 是公网 IP** = 完全没被接管；`errcode: 85107` = 走通了但**路径不在白名单**。
`@wxcloud/cli` 没有任何云调用命令，这一步没有命令行途径。

**为什么句库靠 `SEED_ON_START` 而不是 `pnpm seed:cloud`**：云上 `Dockerfile` 的 `CMD` 只有 `node index.mjs`，不像本地开发镜像自动 seed；而 `seed:cloud` 走数据库外网地址，要先在控制台开公网入口。`SEED_ON_START` 让容器启动时自己灌（幂等 upsert）。

### ⚠️ 七条实测踩出来的坑

**① 必须先监听，再做数据库初始化。** 把 `await waitForDatabase()` 放在 `serve()` 之前是部署失败头号原因：存活探针 `initialDelaySeconds` 只有 2 秒，MySQL 冷启动几十秒，探针在端口监听前狂敲 → `connection refused` → 判失败反复重启。正确：`serve()` 立刻执行，`void initDatabase()` 异步。

**② CLI 没有查看容器日志的命令**（子命令只有 env / function / run / service / storage / version）。所以 `/health` 刻意**始终返回 200** 并回显 `db` / `dbError` / `dbAttempts` / `migrated` / `existingTables`。
它是**存活探针**不是就绪探针：数据库挂了也不能 5xx，否则 Pod 被判不健康反复重启，而你又看不到日志。

**③ 配置错误也不能 `process.exit(1)`**（同理：进程退出 = `connection refused` = 部署失败且看不到原因）。`env.ts` 校验失败时降级为「带错误启动」，把哪个变量错了写进 `/health`。

**④ `tsc` 产物在 Node 跑不起来**：`tsconfig.base.json` 是 `moduleResolution: bundler`，相对导入不带 `.js`（`ERR_MODULE_NOT_FOUND`）；`@jushuo/shared` 的 `main` 指向 `./src/index.ts`，Node 无法加载 `.ts`。→ 服务端用 **esbuild 打成单文件**（`apps/server/build.mjs`），两个问题一并解决，运行镜像也不需要 `node_modules`。

**⑤ `.dockerignore` 绝对不要写 `!` 否定规则**：`@wxcloud/cli` 用 `gitignore-globs` + `minimatchWithList`，只要有一条未命中的 `!` 规则就整体返回「不忽略」—— 一条 `!.env.example` 能让 `node_modules/.pnpm-home` 全部被打包（本仓库曾达 318MB）。**打包后务必核对文件数。**

**⑥ 不要用 `execFileSync` 直接跑 wxcloud 并抛异常**：`error.message` 会拼进完整命令行，其中有 `MYSQL_PASSWORD` 与 `TOKEN_SECRET`，原样打印就把密钥落到终端和日志。`tools/deploy-cloud.mjs` 自己 catch 并只输出脱敏尾部。

**⑦ 接口信封只有一种，任何端点不许破例。** `/health` 曾直接返回扁平 `{ status, engine, ... }`，而其余接口都是 `{ ok: true, data }`；小程序 `request()` 统一按信封解包（`'ok' in body && body.ok`），于是**每次健康检查都被自己判成失败**。
> 教训：当「服务端日志正常 + 前端报失败」同时出现，**先怀疑契约不一致，再怀疑网络**（这个 bug 曾把我们引去查系统代理）。

### 三条硬约束与由此的架构

| # | 约束 | 后果 |
|---|---|---|
| 1 | ⚠️ **请求体上限 100KiB**（超限报 **`-606001`**，不是 HTTP 413） | 音频不能走请求体（20 秒约 640KB） |
| 2 | ⭐ CallContainer 免域名、免备案，openid 从 `x-wx-openid` header 直接拿 | 自建服务器要域名 + 备案 + 白名单 |
| 3 | 容器不支持持久化存储 | 音频/内容必须走对象存储 |

```
① 小程序 wx.cloud.uploadFile → 对象存储直传（无 100KiB 限制，有进度回调）
② CallContainer 提交 { arenaId, fileID }（极小请求）
③ 后端按 fileID 取回音频 → 调讯飞 → 返回
④ 评完分删除音频（隐私策略，DELETE_AUDIO_AFTER_SCORE）
```

存储是**可替换接口**（`apps/server/src/storage/`）：本地 `LocalStorage`（落盘 `.uploads/`），生产 `WxCloudStorage`。
⚠️⚠️ **本地与线上的音频通道是两条路**：本地 Docker 拿不到 COS 凭证（临时密钥要调 `/_/cos/getauth`，那是云托管**内网**接口），
所以 `POST /api/uploads` **只在 `STORAGE=local` 时开放**（云端 404）。不分叉的话，小程序把音频传到微信云、本地服务端却在 `.uploads/` 找不到，提交必然 400「读取音频失败」，而且看起来像提交逻辑写错了。

> ⚠️ **两个只有「换服务」才暴露的坑**：① 旁加载是**服务级**的，且只对创建于开关打开之后的实例生效（旧服务实例里从来没有，重建服务后立刻好）；判据是容器内 `api.weixin.qq.com` 解析到 `169.254.x.x` / `10.x`（`/health?deep=1` 的 `storage.dns` 给答案）。
> ② 旁加载用自签证书，Node 不认 → 必须设 `NODE_EXTRA_CA_CERTS=/app/cert/certificate.crt`，否则报 `fetch failed ← self-signed certificate`；该变量只能由服务环境变量给（Node 只在启动时读），`deploy-cloud.mjs` 已自动带上。

**冷启动 30s > callContainer 超时 15s**：`minNum=0`（默认）时闲置 30 分钟缩容到 0，下次要等 30 秒，而 `callContainer` 的 `timeout` 上限只有 15 秒 → **真机预览第一个请求必然超时失败**。要么把实例副本数最小值设为 1（有费用），要么前端做「首次失败提示重试」。

**数据库环境变量不会自动注入**：云托管只定义 `MYSQL_ADDRESS` / `MYSQL_USERNAME` / `MYSQL_PASSWORD`，且只有走控制台「模板一键部署」才自动注入。
手动开通的 MySQL 要自己填进「服务设置 → 环境变量」；**没有 `MYSQL_DATABASE`**，库名自己建；`MYSQL_ADDRESS` 是 `"host:port"` 一个字段。

## 4.1 部署方式与官方 CLI

| 方式 | 适用 |
|---|---|
| **① 云托管自带流水线** ⭐ 推荐 | 关联 GitHub/GitLab/Gitee，push 自动构建部署 |
| **② 云托管 CLI**（`@wxcloud/cli`） | 自定义构建、非主流仓库 |
| ③ 镜像仓库 | 已有镜像体系，推 CCR 后拉取 |

```bash
npm install -g @wxcloud/cli
wxcloud login --appId ${WXCLI_APPID} --privateKey ${WXCLI_KEY}
wxcloud run:deploy --libraryImage ${IMAGE_TAG} --containerPort=3000 --envId=${WXRUN_ENVID} \
  --serviceName=jupin --releaseType FULL --detach --noConfirm
```
⚠️ 本项目不直接用裸命令：**服务环境变量是整份覆盖的**，少写一个键就冲掉数据库连接。`tools/deploy-cloud.mjs` 会先读回再合并，并自动补 `COS_BUCKET` / `COS_REGION` / `TOKEN_SECRET`。CLI 密钥在**控制台 → 全局设置 → CLI 密钥**生成，存 GitHub Secrets。

## 4.2 分支策略与 Secrets

| 分支 | 后端 | 小程序 | 数据库 |
|---|---|---|---|
| `feature/*` | 不部署 | 仅构建检查 | — |
| **`dev`** | **dev 环境**（push 即部署） | 仅构建检查 | 容器启动时自动迁移 |
| **`main`** | **prod 环境**（合并即部署） | 仅构建检查 | 容器启动时自动迁移 |

⭐ 小程序**不按分支分环境**：三种模式坐标构建期一起烘进包，由 `config.ts` 运行时按平台与版本分流（模拟器→本机、开发版/体验版→dev、正式版→prod），所以小程序只上传一次，只有后端分环境部署。

| Secrets | 级别 | 从哪来 |
|---|---|---|
| `WXCLOUD_APPID` · `WXCLOUD_CLI_SECRET` | 账号级 | 控制台 → 全局设置 → CLI 密钥 |
| `XFYUN_APP_ID` · `XFYUN_API_KEY` · `XFYUN_API_SECRET` | 账号级 | 讯飞 ISE |
| `WX_APPID` · `WX_SECRET` | 账号级 | 小程序 AppID / AppSecret（服务端用：`/tcb/*` 与 `code2session`） |
| `WXCLOUD_ENV_ID` | 环境级 | dev / prod 各一份 |
| `MYSQL_ADDRESS` · `MYSQL_USERNAME` · `MYSQL_PASSWORD` · `MYSQL_DATABASE` | 环境级 | 同上 |
| `TOKEN_SECRET` | 环境级 | ⚠️ 各环境必须不同且不能省（省了脚本现生成一个，而 runner 临时 → 每次部署换密钥、登录态全掉） |
| `XPAY_OFFER_ID` · `XPAY_APP_KEY` · `XPAY_SANDBOX_APP_KEY` · `XPAY_PRODUCT_ENERGY_{10,300,3000}` | 环境级 | 虚拟支付（⚠️ `XPAY_ENV` 刻意不在这里，由 deploy 脚本按环境写死：dev=沙箱 / prod=现网） |

不用手抄，一条命令搬上去：`node tools/gh-secrets.mjs dev`（只列，不打印值）· `… dev --apply` · `… prod --apply`（需先 `gh auth login`）。
环境级建议用 GitHub **Environment**（建 `dev` / `prod`）承载；可给 `prod` 配 **Required reviewers**，让「合并到 main」变成点一下确认。
另有一个 **Variable**（不是 Secret）`SEED_ON_START`：`true` 时云端启动灌种子；**prod 首次部署必须开一次**，否则句库是空的。

## 4.3 四条流水线

| # | 产物 | 触发 | 方式 |
|---|---|---|---|
| 1 | 后端服务 | push | 云托管流水线 / CLI |
| 2 | 小程序体验版 | 人工 | 微信开发者工具上传（或自建 `miniprogram-ci`） |
| 3 | 内容 → COS/CDN | ⭐ 手动（审核驱动） | `workflow_dispatch` 或本地 `pnpm pipeline` |
| 4 | 数据库迁移 | 部署后 | ⚠️ 半自动，需人工确认 |

后端 `.github/workflows/deploy.yml` **已实装**：`push dev → deploy-dev（environment: dev）`、`push main → deploy-prod（environment: prod）` → `node tools/deploy-cloud.mjs <env>`。
部署前必过 `pnpm typecheck` + `pnpm test` 并检查 secrets 配齐。路径过滤：`**.md` / `docs/**` / `apps/miniprogram/**` 不触发后端部署；同分支部署**串行**（`concurrency`，不取消进行中的），避免 `ResourceInUse`。

```bash
# CLI 手动部署（脚本已封装，以下为等价命令，供排查用）
./node_modules/.bin/wxcloud login --appId "$WXCLOUD_APPID" --privateKey "$WXCLOUD_CLI_SECRET"
wxcloud run:deploy --envId="$WXCLOUD_ENV_ID" --serviceName=jupin --containerPort=3000 \
  --releaseType FULL --detach --noConfirm

# 小程序上传（miniprogram-ci，供自建流水线；上传密钥在公众平台→开发管理→开发设置→小程序代码上传 生成，配 IP 白名单后写 Secrets）
npx miniprogram-ci upload --pp ./apps/miniprogram --pkp ./private.key \
  --appid "$WX_APPID" --uv "1.0.${github.run_number}" --desc "<提交说明>"

# 内容人工发布（不做持续部署）
pnpm pipeline run --from 01 --to 09     # 本地跑流水线
pnpm admin                              # 或在本机管理台里发布
```

## 4.4 ⚠️ 数据库迁移必须单独处理

迁移**不能跟着部署自动跑**（不可逆、多实例滚动发布可能并发、出问题需人工判断）。用 expand-contract：
```
部署新代码（兼容新旧 schema）→ 手动 / 单独 job 跑迁移 → 观察无误 → 清理旧字段
```

## 4.5 自动化程度总览

| 环节 | 自动化 |
|---|---|
| 后端构建 + 部署 / 类型检查 + 测试 | ✅ push 即部署 / ✅ CI 卡口 |
| 小程序体验版 | ⚠️ 目前人工上传 |
| **小程序正式发布** | ❌ 必须人工（微信平台硬限制） |
| 数据库迁移 / 内容生产发布 | ⚠️ 半自动 / ⚠️ 手动触发 |

## 4.6 MySQL 5.7 → 8.0：只能注销重建，不能原地升级

> 官方：「不支持从 MySQL 5.7 原地升级到 8.0，需要注销后重新开通」「选定版本后不可修改」。

云托管 MySQL 是 serverless 实例，控制台没有版本升级入口，CLI 只暴露只读的 `DescribeWxCloudBaseRunDBClusterDetail`。三个不可逆决策点：**版本**（开通后不可改）、**`lower_case_table_names`**（8.0 开通后不支持改；本项目表/列/索引/约束名全小写，选默认即可）、**新密码**（重开要重设）。

```bash
pnpm db:info                                   # 0. 先看清当前真实地址与版本，记下备用
# 1. 控制台 → dev → MySQL →「销毁数据库」；2.「重新开通」选 8.0 并设新密码
# 3. 改 .env.dev 的 MYSQL_ADDRESS / MYSQL_PASSWORD（deploy 会覆盖服务配置，不用去控制台手改）
pnpm db:info                                   # 校验 .env.dev 与真实地址一致
pnpm deploy:dev                                # 4. AUTO_MIGRATE=true 容器启动自动建表
curl https://jupin-219743-12-1258596499.sh.run.tcloudbase.com/health   # 期望 db: ready / migrated: true
DATABASE_URL='mysql://root:<密码>@<外网地址>/jushuo' \
  node_modules/.bin/tsx apps/server/src/db/seed.ts    # 5. 灌种子（需临时开外网地址，灌完可关）
```
⚠️ 判断能否**直接销毁**：库里只有可重建的种子数据（`pnpm seed`）→ 可以；有真实成绩 / 支付记录 → ⛔ 必须先导出（DMC 导出 SQL → 销毁 → 重开 8.0 → 导入）。
现在做成本最低（未来有支付记录就得对账，导错一行是事故）。MySQL 5.7 已于 2023-10 EOL；本项目不用任何 8.0 独有特性，升级动机是维护性。

## 4.7 三环境架构：local / dev / prod

| 环境 | 谁在用 | API 通道 | 云托管环境 | 服务 |
|---|---|---|---|---|
| **local** | 模拟器 | `wx.request` → `http://localhost:8899` | dev（仅对象存储） | 本机 Docker |
| **dev** | 真机调试 / 预览 / 体验版 | `wx.cloud.callContainer` | `dev-0go66cfz212d3d83` | `jupin` |
| **prod** | 正式版（release） | `wx.cloud.callContainer` | `prod-9gjwc01kcd98d6d1` | `jupin` |

分流不用手改：`wx.getDeviceInfo().platform`（`devtools`/`ios`/`android`）+ `wx.getAccountInfoSync().miniProgram.envVersion`（`develop`/`trial`/`release`）→
`devtools→local`；`release→prod`；其余（`develop`/`trial`）`→dev`。
⚠️ 体验版也指 dev：否则**测试成绩会写进正式榜单**。要改，把 `config.ts` 里 `resolveEnv()` 的 `trial` 分支挪一行即可。临时强制环境用 `ENV_OVERRIDE`（验完改回 `null`）。

**小程序配置是构建期注入的**（小程序没有 `process.env`）：根目录 `.env` 的 `MP_*` → `build.mjs`（经 [tools/env.mjs](tools/env.mjs)）→ esbuild `define` → `config.ts` 的 `__MP_*__` 常量。

| 变量 | 用途 |
|---|---|
| `MP_LOCAL_API_URL` | 模拟器打的本机地址 |
| `MP_LAN_API_URL` | 真机走局域网的逃生通道（留空即禁用） |
| `MP_DEV_ENV_ID` / `MP_PROD_ENV_ID` | dev / prod 环境 ID |
| `MP_CLOUD_SERVICE` | 云托管服务名 |

**改环境只改 `.env`，不改代码**；CI 用同名环境变量注入即可复用同一份代码。⚠️ 前四项缺失时构建**直接失败**（否则会产出静默连不上的坏包）。

## 4.8 服务端怎么读小程序直传的音频

小程序 `wx.cloud.uploadFile` 直传后，服务端按 `fileID` 取回音频送评测。采用官方做法：**COS-SDK +「开放接口服务」取临时密钥**（[官方文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/development/storage/service/cos-sdk.html)）。
```js
GET http://api.weixin.qq.com/_/cos/getauth   // ① 取临时密钥（容器内，零长期密钥）→ { TmpSecretId, TmpSecretKey, Token, ExpiredTime }
// ② 用 getAuthorization 回调初始化 COS-SDK（自动续期）  ③ cos.getObject / cos.deleteObject
```
`fileID` → COS Key 的转换在 `storage/types.ts` 的 `normalizeKey()`（形体：`cloud://<env>.<bucket>/audio/xxx.pcm`）。
⚠️ 未开启「开放接口服务」时 `/_/cos/getauth` 返回 **HTTP 404**（请求真的打到微信服务器，那里没这个路径）。为此做了 `GET /health?deep=1`（仅 `DIAG_ENABLED=true`）：把「取临时密钥 → 读一个不存在的 key」跑一遍，期望拿到 `NoSuchKey` —— 它证明鉴权/桶/地域全对；首次就是它把 404 抓出来的。
两条不选的路：客户端取临时链接再让服务端 fetch（**SSRF 面** + 域名白名单）；`tcb/batchdownloadfile`（需要 `access_token`，多一层令牌生命周期）。
代价与备注：`cos-nodejs-sdk-v5` 依赖已废弃的 `request`，bundle 从 3.16MB 涨到 6.45MB（镜像 141MB，可接受；手写 COS v5 签名可省掉）；`conf` 只在 `sdk/session.js` 断点续传里用到，我们只用 `getObject`/`deleteObject`，不写盘。

### ⚠️ 三环境数据完全隔离

dev / prod 各有自己的 MySQL 与对象存储桶，互不可见。**不要在 prod 灌种子做验证**；正式榜单数据只能来自真实用户。

---

# 五、环境变量与密钥

四份全在仓库根，绝不散在子包里（模板 `.env.example` / `.env.local.example` / `.env.dev.example` / `.env.prod.example`）：

| 文件 | 用于 |
|---|---|
| `.env` | 公用：账号级凭据 / 小程序构建注入（`MP_*`）/ 本机端口（`DB_PORT` `API_PORT`） |
| `.env.local` | 本地：DevTools 模拟器 + 本机 docker + 内容流水线 |
| `.env.dev` / `.env.prod` | 云托管 dev / prod |

优先级：`进程环境变量 > .env.<mode> > .env`，由 [tools/env.mjs](tools/env.mjs) 统一加载。⚠️ 同名键只在对应那份文件出现一次；除 `*.example` 外的 `.env*` 都已 gitignore，绝不提交；CI 直接用进程变量、不落文件。

常用键：
- 微信 `WXCLOUD_APPID` · `WXCLOUD_CLI_SECRET` · `WXCLOUD_ENV_ID` · `WX_APPID` · `WX_SECRET`
- 引擎 `XFYUN_APP_ID` · `XFYUN_API_KEY` · `XFYUN_API_SECRET`
- 数据库 `DATABASE_URL`（本机）· `MYSQL_ADDRESS` · `MYSQL_USERNAME` · `MYSQL_PASSWORD` · `MYSQL_DATABASE`
- 开关 `ENGINE`（`mock`/`xfyun`，配齐讯飞三键自动判 `xfyun`）· `STORAGE`（`local`/`wxcloud`）· `TOKEN_SECRET` · `DELETE_AUDIO_AFTER_SCORE` · `SEED_ON_START` · `AUTO_MIGRATE` · `DIAG_ENABLED` · `NODE_EXTRA_CA_CERTS`
- 内容 `FISH_API_KEY` · `FISH_PROXY_URL`（`socks5://127.0.0.1:1081`）· `FISH_MODEL` · `FISH_VOICE_ID`（仅试音色）· `LLM_API_KEY` · `LLM_BASE_URL`（写域名即可，不带 `/v1`）· `LLM_MODEL` · `LLM_TEMPERATURE` · `ADMIN_USER` · `ADMIN_PASSWORD`（留空首次启动随机生成并回写）
- 对象存储 `COS_BUCKET` · `COS_REGION` · `COS_SECRET_ID` · `COS_SECRET_KEY`
- 本地联调 `DEV_OPENID`（决定伪 openid；改它可开第二个测试账号）
- 支付 `XPAY_*`

`pnpm db:info` 查云库真实地址/版本/状态；`pnpm deploy:dev` 部署（本地 `.env` 的 `MYSQL_*` 覆盖服务配置）。

---

# 六、常见故障排查

> ⚠️ 「现在做到哪一步了」看 [plan.md](plan.md)，不在本文件。本节只留操作知识。

## ✅ `connect ETIMEDOUT` 的真正原因通常是地址过期

云托管 MySQL 是 serverless，实例重建/迁移后内网 IP 会变，而服务环境变量不会自动跟着变，于是容器连一个不存在的地址。
`ETIMEDOUT`（**完全没有应答**，包进黑洞）vs `ECONNREFUSED`（有东西发 RST，主机可达、端口没开）是很有用的区分。
查法：`pnpm db:info`（调 CLI 内部的 `DescribeWxCloudBaseRunDBClusterDetail`，打印集群 ID / 版本 / 状态 / 内外网地址，并比对 `.env.<env>`）。
修正只需改 `.env.dev` 的 `MYSQL_ADDRESS` 再 `pnpm deploy:dev`（本地文件的 `MYSQL_*` 覆盖服务配置；控制台改配置要求「没有部署任务在跑」，否则报 `ResourceInUse`）。

## ⚠️ 正文路径由 id 推导，库里不存路径

`contentPathOf(id)` = `/content/articles/<id>.json`（`packages/shared/src/content-path.ts`，服务端消费在 `services/content.ts`）—— 里面本来就含 `content/`，所以解析基准是**仓库根**，不是 content 目录。踩过一次：当 content 目录后去找 `/app/content/content/articles/….json`，正文永远读不到。
> `articles` 曾有一列 `content_json` 存这个路径，已删除（迁移 `0030`）：路径完全可由 id 推导，存下来只会跟 id 漂移。这是「重复即错误」的实例。

---

# 附：已废弃（不要参考）

| 内容 | 状态 |
|---|---|
| [docs/archive/](docs/archive/) 下的 v1 文档 | D/Q/E/P 积分、能力分曲线、SolidJS + Azure、阿里云部署，仅历史参考 |
| 等级徽章阶梯（8 档，原 `badges.ts` 已删） | **已整体废除**，换成三个成长值指标 |
| 实时逐词跟随 / 端侧评分分析 / 自检页（v1） | 产品下线；`packages/shared/src/audio/` 只保留 FFT / 重采样 / WAV |
| 分类 / 积分 / 关卡 / 包月订阅 | 下线，见 prd.md「已删除的概念」与 plan.md「已废弃 / 明确不做」 |

> 完整且持续更新的清单在 [plan.md](plan.md)。
