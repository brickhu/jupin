# 句拼 · 计划（PLAN）

> **这是唯一的目标与任务来源。**
> 业务与需求看 [prd.md](prd.md) · 现状与规则看**代码及其注释** · 工程索引看 [AGENT.md](AGENT.md) · 技术选型看 [spec.md](spec.md)。
>
> **规矩**
> 1. **任务只能写在这里。** 其它文件里的「待办 / 待确认 / 待定 / 测试清单」都是**写作当时的快照**；
>    不一致就是文档 bug，改掉其中一个。
> 2. **安排一条任务就记一笔**：一行一个 checkbox，带 ID（A 需你拍板 / B 工程 / C 上线），
>    并写清**做完的标志**。
> 3. **状态用 checkbox 表达**：`- [ ]` 未完成 · `- [x]` 已完成。
>    ⭐ `[x]` **只由 `pnpm plan:status --write` 从 git 派生**（提交信息带 `plan <ID>`），
>    **人不手写、不手改** —— 所以它不是「手写的完成清单」，而是 git 的投影。
>    天生没有 commit 的完成项（真机实验 / 外部配置 / 决定）写成普通列表项，
>    放在下面的**「已完成 · 无 commit」**里。
> 4. 「在做 / 待办 / 已废弃」由**所在小节**表达，不再额外写状态字段。
> 5. 每一步都走 [AGENT.md](AGENT.md) 的**「统一开发流程」**：
>    先落任务 → 再对齐 prd → 再写代码 + 注释 → 提交时闭环。
> 6. **记账用 `git commit`，发布才 `git push`。** push 到 `dev` / `main` 会触发 CI **真的部署**
>    （见 AGENT.md 部署一节），所以别为了「让 plan 状态生效」去推送。
>    ⭐ **AI 的操作权限到 commit 为止 —— push 由人决定。**
>    `plan:status` 读本地 git，但会把「已推送 / 仅本地」分开标。
>
> 元规则是 **重复即错误**：同一事实出现在第二个地方，即使当下一致，也已经是 bug 的种子。

---

## 在做


---

## 待办

### A. 需要你拍板（产品 / 外部）

- [ ] **A1** **点赞 / 评论**：`likes`、`reviews` 两张表 + `submissions.like_count` 全仓库没有一处读写 —— 建议：**删**（能量线都砍了，点赞既无入口也无出口）
- [ ] **A2** 小程序**主体类型**：个人 / 个体户 / 企业 —— 做完的标志：定了走哪条虚拟支付开通流程（依据 payment-and-purchase.md §10 / §11.4）
- [ ] **A3** 开通前自查：**对公提现账户**、支付管理员、**小程序简称**（iOS 必需）—— 做完的标志：逐项确认（payment-and-purchase.md §11.1）
- [ ] **A4** 支付**沙箱**什么时候开 —— 建议：动手第一步就开（签名的坑只能在沙箱里试出来）
- [ ] **A5** 充值**档位具体数字** —— 建议：架构先支持任意整数倍，数字后定（payment-and-purchase.md §2.2）
- [ ] **A6** 解冻卡：到期提醒？**持有上限**？单次补签最多几天？—— 建议：只在卡面显示到期日、不做推送；有上限（12）；补签不额外限制（reward-system.md §10）
- [ ] **A7** 存量成长值**是否回溯** —— 建议：不回溯，从 0 开始（growth-and-energy.md §6）
- [ ] **A8** **退款后能量怎么处理** —— 建议：扣回，允许扣成负数（payment-and-purchase.md §6.3）
- [ ] **A9** 流水页要不要把 hold/release 折成一行 —— 建议：折成一行「挑战 −2」

### B. 工程

- [ ] **B1** **清掉旧额度时代的残留**：`MyStats` / `isMember`（types/api.ts:617）、`nextFreeAt`（miniprogram app.ts:15）、`QuotaExhaustedError`（types/api.ts:875）—— 门禁早已是能量（`ENERGY_EXHAUSTED`），这些是死字段
- [ ] **B2** 客户端还在处理已退役的 `QUOTA_EXHAUSTED`（reading.ts / lib/api/client.ts）—— 改成 `ENERGY_EXHAUSTED`，否则额度用完时用户看不到可行动提示
- [ ] **B3** `join.test.ts` 里的假响应字段（isMember / dailyLimit / usedToday / freezeCount）—— 同 B1
- [ ] **B4** `packages/shared/src/streak.ts` 的 `freeze*` 命名统一成 `unfreeze*` —— 卡叫「解冻卡」，代码名还留着一半
- [ ] **B5** 核对 growth-and-energy.md §11 的冲突清单（A/B/C 三组）是否逐条落地 —— 该文档自标「已实施」，但清单本身没勾；已确认徽章 / 额度 / 门禁三组已改
- [ ] **B6** **支付链路**（等 A2/A3/A4 定了再开工）：goods / payments 表、虚拟支付、发货推送验签、pages/me/energy 充值、对账与退款（payment-and-purchase.md）
- [ ] **B13** 用新口径**重判存量内容**的难度（依赖 B12）—— 按母语者判"简单"的句子对中国学习者未必简单，8 句种子的档位大概率要动 —— 做完的标志：每句的 difficulty 都是新提示词判出来的

### C. 上线 / 运维

- [ ] **C1** dev / prod 跑迁移 **0031–0034** —— 内容是「清库 + id 缩到 16 位 + 删冗余列」；跑完靠 `SEED_ON_START` 重灌种子并上传新音频。⚠️ 推 `dev` 会自动触发（AUTO_MIGRATE + SEED_ON_START）
- [ ] **C2** dev 临时开 **MySQL 外网地址** —— 才能从本机灌种子；灌完可关
- [ ] **C3** **prod 的 `jushuo` 库还不存在**（`Unknown database`）—— 先建库再谈迁移
- [ ] **C4** 小程序开发者工具**清一次 Storage 缓存** —— 里面可能还留着旧的 64 位 id
- [ ] **C5** 清理旧对象存储 key（64 位 id 那批）—— 上线后它们成为孤儿
- [ ] **C6** **产品验证实验**：真人录音回答 5 个产品问题 —— ①朗读难度是否真影响拿分难度 ②分数分布→门槛标定 ③重口音识别率 ④竞技场长度与重录意愿 ⑤词级诊断准不准。需要讯飞密钥 + 4–6 位朗读者；方案见 docs/experiments/validation-experiment.md

---

## 已完成

> ⭐ 本节的 `[x]` 由 `pnpm plan:status --write` **从 git 派生**，不要手写、不要手改。
> 天生没有 commit 的完成项写在下一节。

- [x] **B10** AGENT.md 写清**「人怎么派活」**—— 四种句型、你只需要决定的三件事、每次任务的固定回路 —— 做完的标志：AGENT.md 有这一节，派活不用再问
- [x] **B11** 难度定级改为**纯 LLM 判定**：废弃「脚本算特征」方案 —— 改掉步骤说明与注释、在 spec.md 记下这条决策 —— 做完的标志：全仓库没有把它当**现行方案**的地方（注释/文档里的「已废弃」说明不算；docs/archive 不动）
- [x] **B12** 难度提示词改为**中国学习者视角**：四档重写 + 加「中国学习者最常错的音」清单 + reason 必须点出具体难点 —— 做完的标志：提示词以中国学习者为基准，prd/spec 记下这条口径
- [x] **B7** 把存量按主题拆成带 `plan <ID>` 的 commit —— 做完的标志：工作区干净、`plan:status` 认得出这批提交
- [x] **B8** plan 改用**统一 checkbox**（`- [ ]` / `- [x]`），`[x]` 由 `pnpm plan:sync` 从 git 派生并归档 —— 做完的标志：plan.md 全是 checkbox、`plan:status` 能报「有 commit 但没勾」、`--write` 幂等
- [x] **B9** 写清**多任务并行**的冲突规则（四个冲突面 + 各自的消法），并加 `pnpm task:*` worktree 工具 —— 做完的标志：AGENT.md 有这一节、`pnpm task:start/list/remove` 可用

## 已完成 · 无 commit（手写）

> 只有**真机实验 / 外部配置 / 决定**这类天生没有 commit 的完成项写在这里。

- **2026-09-15** **端侧脚手架技术验证 T1–T6 真机通过**（iPhone 15 + Redmi K30）：
  `onFrameRecorded` 两端稳定回帧 ⇒ **端侧架构成立**。
  两条必须记住的实测结论：① `frameSize` **只是建议**（请求 2KB，iOS 实际给 4096、Android 2560）；
  ② iOS 的 JS 比 Android 慢约 13 倍（YIN 单帧 7.2ms vs 0.55ms），**性能预算按 iOS 定**。
  详见 docs/experiments/validation-experiment.md 表 5；`frameSize` 那条已进 recorder.ts 的注释。
- **（早于本次记录）** 脚手架跑通（全仓 typecheck + 单测 + 端到端接口 + 本地 Docker）；
  dev 环境部署打通（`/health` 可达、`db: ready`）；云端数据库迁移与种子完成；
  `WxCloudStorage.get/remove` 已实现（提交链路按 fileID 取回音频）

---

## 已废弃 / 明确不做

- **等级徽章阶梯（8 档）** —— 已整体废除，换成三个成长值指标
- **端侧评分分析 / 实时逐词跟随 / 自检页（v1）** —— 按 prd 已下线
- **管理台「能量」页** —— 你明确「能量线别做」；只留占位入口
- **分类 category / 积分 / 关卡** —— 产品做减法时下线
- **包月订阅** —— 自动续费门槛（DAU≥1000、发布≥90 天、主体非个人）一条都不满足
- **`spec.md` 里的 DDL / 表结构 / 静态资源布局** —— 与 `schema.ts`、`services/content.ts` 是同一事实两处，已删（改为指向代码）
