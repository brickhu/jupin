# 句拼 · 计划（PLAN）

> **这是唯一的目标与任务来源。**
> 业务与需求看 [prd.md](prd.md) · 现状与规则看**代码及其注释** · 工程索引看 [AGENT.md](AGENT.md) · 技术选型看 [spec.md](spec.md)。
>
> **规矩**
> 1. **任务只能写在这里。** 其它文件里的「待办 / 待确认 / 待定 / 测试清单」都是**写作当时的快照**；
>    不一致就是文档 bug，改掉其中一个。
> 2. **安排一条任务就记一笔**：带 ID（A 需你拍板 / B 工程 / C 上线），并写清**做完的标志**。
> 3. **手写的状态只有三种：在做 / 待办 / 已废弃。**
>    ⭐ **「已完成」不手写** —— 由 `pnpm plan:status` **从 git 派生**（提交信息带 `plan <ID>`）。
>    只有天生没有 commit 的完成项（真机实验 / 外部配置 / 决定）才手写一行并标 `[无 commit]`。
> 4. 每一步都走 [AGENT.md](AGENT.md) 的**「统一开发流程」**：
>    先落任务 → 再对齐 prd → 再写代码 + 注释 → 提交时闭环。
> 5. **记账用 `git commit`，发布才 `git push`。** push 到 `dev` / `main` 会触发 CI **真的部署**
>    （见 AGENT.md 部署一节），所以别为了「让 plan 状态生效」去推送。
>    ⭐ **AI 的操作权限到 commit 为止 —— push 由人决定。**
>    `plan:status` 读本地 git，但会把「已推送 / 仅本地」分开标。
>
> 元规则是 **重复即错误**：同一事实出现在第二个地方，即使当下一致，也已经是 bug 的种子。

---

## 在做

| # | 任务 | 说明 |
|---|---|---|
| — | **（空）** | 文档真相来源治理已于 2026-09-24 完成，见「已完成」 |

---

## 待办

### A. 需要你拍板（产品 / 外部）

| # | 问题 | 建议 | 论证在哪 |
|---|---|---|---|
| A1 | **点赞 / 评论**：`likes`、`reviews` 两张表 + `submissions.like_count` 全仓库**没有一处读写** | **删**（能量线都砍了，点赞既无入口也无出口） | —— |
| A2 | 小程序**主体类型**：个人 / 个体户 / 企业 | 决定虚拟支付走哪条开通流程 | payment-and-purchase.md §10 / §11.4 |
| A3 | 开通前自查：**对公提现账户**、支付管理员、**小程序简称**（iOS 必需） | 需你逐项确认 | payment-and-purchase.md §11.1 |
| A4 | 支付**沙箱**什么时候开 | 动手第一步就开（签名的坑只能在沙箱里试出来） | payment-and-purchase.md §10.5 |
| A5 | 充值**档位具体数字** | 架构先支持任意整数倍，数字后定 | payment-and-purchase.md §2.2 |
| A6 | 解冻卡：到期提醒？**持有上限**（建议 12）？单次补签最多几天？ | 只在卡面显示到期日、不做推送；有上限 | reward-system.md §10 |
| A7 | 存量成长值**是否回溯** | 不回溯，从 0 开始 | growth-and-energy.md §6 |
| A8 | **退款后能量怎么处理** | 扣回，允许扣成负数 | payment-and-purchase.md §6.3 |
| A9 | 流水页要不要把 hold/release 折成一行 | 折成一行「挑战 −2」 | payment-and-purchase.md §10 |

### B. 工程

| # | 任务 | 说明 |
|---|---|---|
| B1 | **清掉旧额度时代的残留**：`MyStats` / `isMember`（types/api.ts:617）、`nextFreeAt`（miniprogram app.ts:15）、`QuotaExhaustedError`（types/api.ts:875） | 门禁早已是能量（`ENERGY_EXHAUSTED`），这些是死字段 |
| B2 | 客户端还在处理已退役的 `QUOTA_EXHAUSTED`（reading.ts / lib/api/client.ts） | 要改成 `ENERGY_EXHAUSTED`，否则额度用完时用户看不到可行动提示 |
| B3 | `join.test.ts` 里的假响应字段（isMember / dailyLimit / usedToday / freezeCount） | 同上 |
| B4 | `packages/shared/src/streak.ts` 的 `freeze*` 命名统一成 `unfreeze*` | 卡叫「解冻卡」，代码名还留着一半 |
| B5 | 核对 growth-and-energy.md §11 的冲突清单（A/B/C 三组）是否逐条落地 | 该文档自标「已实施」，但清单本身没勾；已确认徽章 / 额度 / 门禁三组已改 |
| B6 | **支付链路**（等 A2/A3/A4 定了再开工）：goods / payments 表、虚拟支付、发货推送验签、pages/me/energy 充值、对账与退款 | payment-and-purchase.md |
| B7 | **把当前工作区按主题拆成若干个带 `plan <ID>` 的 commit** | 现在 290 个文件未提交，所以「已完成」还没法真正由 git 派生（`pnpm plan:status` 显示 0/21）。做完这条新流程才真正生效 |

### C. 上线 / 运维

| # | 任务 | 说明 |
|---|---|---|
| C1 | dev / prod 跑迁移 **0031–0034** | 内容是「清库 + id 缩到 16 位 + 删冗余列」；跑完靠 `SEED_ON_START` 重灌种子并上传新音频 |
| C2 | dev 临时开 **MySQL 外网地址** | 才能从本机灌种子；灌完可关 |
| C3 | **prod 的 `jushuo` 库还不存在**（`Unknown database`） | 先建库再谈迁移 |
| C4 | 小程序开发者工具**清一次 Storage 缓存** | 里面可能还留着旧的 64 位 id |
| C5 | 清理旧对象存储 key（64 位 id 那批） | 上线后它们成为孤儿 |
| C6 | **产品验证实验**：真人录音回答 5 个产品问题 | ①朗读难度是否真影响拿分难度 ②分数分布→门槛标定 ③重口音识别率 ④竞技场长度与重录意愿 ⑤词级诊断准不准。需要讯飞密钥 + 4–6 位朗读者；方案见 docs/experiments/validation-experiment.md。⚠️ **技术侧 T1–T6 已完成**（见「已完成」），这里只剩产品侧 |

---

## 已完成

> ⚠️ **下面这段是迁移期的存量记录**（2026-09-24 那次大扫除）：当时还没有 ID 约定，
> 工作也**大多还没提交**。此后新完成的条目不在这里手写 —— 由 `pnpm plan:status` 从 git 派生。
> 只有天生没有 commit 的完成项才写在这里，并标 `[无 commit]`。

- **[无 commit] 2026-09-15** **端侧脚手架技术验证 T1–T6 真机通过**（iPhone 15 + Redmi K30）：
  `onFrameRecorded` 两端稳定回帧 ⇒ **端侧架构成立**。
  两条必须记住的实测结论：① `frameSize` **只是建议**（请求 2KB，iOS 实际给 4096、Android 2560）；
  ② iOS 的 JS 比 Android 慢约 13 倍（YIN 单帧 7.2ms vs 0.55ms），**性能预算按 iOS 定**。
  详见 docs/experiments/validation-experiment.md 表 5；`frameSize` 那条已进 recorder.ts 的注释。
- **（早于本次记录）** 脚手架跑通（全仓 typecheck + 单测 + 端到端接口 + 本地 Docker）；
  dev 环境部署打通（`/health` 可达、`db: ready`）；云端数据库迁移与种子完成；
  `WxCloudStorage.get/remove` 已实现（提交链路按 fileID 取回音频）
- **2026-09-24** 内容寻址：`articleId = sha256(text) 前 16 位`、`submissionId 前 16 位`（迁移 0031 / 0032）
- **2026-09-24** 删掉五处「同一事实的第二个来源」：`content_json`（0030）、`content_status` / `tips_json` / `updated_at`（0033）、`participant_count` / `conquered_count` / `submissions.is_conquered`（0034）
- **2026-09-24** 主题兜底统一：`resolveTheme(theme, articleId)` 有 id 就按 id 复算，品牌色只在连 id 都没有时用
- **2026-09-24** 分词（`plainWordsOf`）与正文路径（`contentPathOf`）收敛到 shared 单一实现，12 处副本归零
- **2026-09-24** 本机内容管理台 `tools/admin`：登录页选环境（真实探库校验）、句库列表 / 详情 / 编辑 / 发布 / 排期、逐词播放与区间编辑；旧 `tools/jushuo-admin.ts` 删除
- **2026-09-24** 能量体系与奖励系统落地：`energy_ledger` / `unfreeze_cards` / `reward_rules` / `reward_grants`、`ENERGY_EXHAUSTED` 门禁、`pages/me/energy`（**有残余，见待办 B1–B4**）
- **2026-09-24** 等级徽章整体废除（`badges.ts` 等已删）
- **2026-09-24** **文档真相来源治理**：建 `plan.md` 作为唯一任务来源；
  写死四条分工 + 元规则「重复即错误」（见 AGENT.md「文档与真相来源」）。
  · `spec.md` **579 → 279 行**：删掉表结构 / 静态资源布局 / CDN JSON 形状 / 讯飞踩坑清单 / 风险清单，只留选型与为什么
  · `AGENT.md` **1491 → 585 行**：删掉一切业务规则、数据模型、产品行为的复述，只留索引与操作手册
  · 三份 design 文档的「待定 / 待你确认 / 测试清单」收编进本文件，原处只留指针
  · 修掉现存矛盾：等级徽章（prd + AGENT 都还写着它在）、85 分征服线、prd 整个作废的「会员/免费额度」付费模型
  · 新增 `pnpm check:docs`（链接与仓库路径必须存在、spec.md 不许出现 DDL），接进 `pnpm check`

---

## 已废弃 / 明确不做

| 内容 | 原因 |
|---|---|
| 等级徽章阶梯（8 档） | 已整体废除，换成三个成长值指标 |
| 端侧评分分析 / 实时逐词跟随 / 自检页（v1） | 按 prd 已下线 |
| 管理台「能量」页 | 你明确「能量线别做」；只留占位入口 |
| 分类 category / 积分 / 关卡 | 产品做减法时下线 |
| 包月订阅 | 自动续费门槛（DAU≥1000、发布≥90 天、主体非个人）一条都不满足 |
| `spec.md` 里的 DDL / 表结构 / 静态资源布局 | 与 `schema.ts`、`services/content.ts` 是同一事实两处，已删（改为指向代码） |
