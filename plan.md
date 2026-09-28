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
- [ ] **A10** **成长值 3 → 1**：自我超越 / 坚持不懈 / 人中翘楚 合成一个；首页「荣誉榜」三块 TOP10、结果页三张成长值卡、我的主页三行、`users` 两个成长列与 `submissions` 增量快照一并砍 —— 建议：**砍**（同一次提交被拆成三次「进步」，用户要理解四次）
- [ ] **A11** **能量撤出每屏文案**：朗读页每一屏的「消耗 2，剩余 3」小字（`syncEnergyNote` 的产物）+ 用户面板那行「⚡ 能量 N 点 · ❄️ 解冻卡 M 张」—— 建议：**砍文案、机制不动**（余额不够要另留一条提示）
- [ ] **A12** **删「征服 / 攻克」这一层**：`services/conquest.ts` 的命名、接口里的 `conqueredCount`、注释里整套「攻克」措辞统一叫「朗读金句」—— 建议：**删**（与「朗读金句」是同一个数、同一个口径）
- [ ] **A13** **解冻卡简化**：去掉「发放 → 领取 → 有效期 → 使用」四段生命周期、连战记录页「领取 N 张」按钮，以及 `reward_rules` / `reward_grants` 两层发放流水；方向二选一：**A 断了就断** / **B 断档自动补签一次** —— 待你选
- [ ] **A14** **今日推荐的 5 条规则收进内部**：不再把「定档 / 同档同句 / 未读优先 / 整档挑最久 / 兜底换档」原文当卡片文案（`reason`），卡片只留一句人话 —— 建议：**收进内部**
- [ ] **A15** **「我在哪一档」界面只留一个数**：不再同时表达「我的档位 / 这一句的档位 / 是否兜底换档」（内部 `myLevel` / `level` / `degraded` 可留）—— 建议：**只留一个**（现状是界面一个都没显示，所以这条是「决定怎么显示」）
- [ ] **A16** **挑战宣言 / 朗读建议**（`challenge` / `advice`）：接口已返回、客户端从没渲染；**A 补上 / B 砍掉，待你拍板** —— ⚠️ 不是「没人要」：你早先明说要，当时的要求是「挑战宣言当作分享卡标题」+「金句页把两句拼成一段」；分享卡标题现在走客户端的 `buildShareTitle`，没用 `challenge`
- [ ] **A17** **主题 tags 的展示**：只有「我的收藏」每一行一行小字，没有任何按标签的筛选入口 —— 建议：**砍展示、留数据**（将来做筛选要用）

### B. 工程

- [ ] **B1** **清掉旧额度时代的残留**：`MyStats` / `isMember`（types/api.ts:617）、`nextFreeAt`（miniprogram app.ts:15）、`QuotaExhaustedError`（types/api.ts:875）—— 门禁早已是能量（`ENERGY_EXHAUSTED`），这些是死字段
- [ ] **B2** 客户端还在处理已退役的 `QUOTA_EXHAUSTED`（reading.ts / lib/api/client.ts）—— 改成 `ENERGY_EXHAUSTED`，否则额度用完时用户看不到可行动提示
- [ ] **B3** `join.test.ts` 里的假响应字段（isMember / dailyLimit / usedToday / freezeCount）—— 同 B1
- [ ] **B4** `packages/shared/src/streak.ts` 的 `freeze*` 命名统一成 `unfreeze*` —— 卡叫「解冻卡」，代码名还留着一半
- [ ] **B5** 核对 growth-and-energy.md §11 的冲突清单（A/B/C 三组）是否逐条落地 —— 该文档自标「已实施」，但清单本身没勾；已确认徽章 / 额度 / 门禁三组已改
- [ ] **B6** **支付链路**（等 A2/A3/A4 定了再开工）：goods / payments 表、虚拟支付、发货推送验签、pages/me/energy 充值、对账与退款（payment-and-purchase.md）
- [ ] **B24** **删掉全局排期**：`GET /api/schedules`（含 `/:date`）整条 + `services/schedules.ts` 的轮转 + `services/schedule-date.ts` + `schedules` 表 + `submissions.schedule_date`（连同死索引）+ `participations.last_schedule_date` + 内容管理台排期 + 金句页 `?date=` 入口（只留 `?article=`）—— **保留**每用户 24 小时窗口（`users.today_article_id` / `today_assigned_at`、`GET /api/user/today`、窗口内固定不换、按窗口起始日取模）—— 做完的标志：全仓库搜不到 `/api/schedules` / `schedule_date` / `?date=`，且首页与 24h 窗口行为不变
- [ ] **B25** **「最新上线」搬到 `GET /api/articles/latest`**：公开接口，按 `articles.published_at` 倒序取 6，复用 `services/schedule-shape.ts` 的 `pickLatestArticles`（已有单测）—— 做完的标志：首页「最新上线」由新接口供数，`/api/schedules` 不再是它的来源。⚠️ 公开接口拿不到调用者的「今日那一句」，`pickLatestArticles` 的「剔除今日」要么由客户端过滤、要么取消 —— 先定这一条再动手
- [ ] **B28** **朗读页的提交流程改成弹窗**（用户 2026-09 追加，覆盖 `docs/design/reading/SPEC.md` 里 s4–s6 的排版）：点下 s3 的绿 ✓ 的**同一帧**弹出浮层，里面依次是「正在上传录音（真实进度）→ AI 评测中 → 出分 / 失败」；原来的 s4 拆成 `uploading` / `scoring` 两态（"卡在 0%"和"卡在 99%"该说的话不同）。等待期点遮罩无效、不画 ×（能量已锁、云端已算，关掉只会让人以为白花一次）；结果态底部是**确认 + 评测详情**：确认 = 关窗 + 卡片回 s1 + 这一次立刻进下方历史，评测详情 = `navigateTo pages/challenge`（返回还回到结果弹窗）。等待超 10 秒补一句「比平时久，分数还在云端算」（不是超时；真超时仍是 2 分钟 → s6）。落地：`components/eval-dialog` + reading 页状态机改写，`prd.md` §7.3 已对齐 —— 做完的标志：真机上从提交到出分全在浮层里走完，等待期点不动下面的页面，点确认后卡片回 s1 且历史多出这一次

- [ ] **B26** **界面名词改名批次**（只改用户可见字）：金句页标题「朗读竞技场」→「金句」；结果页按钮「看竞技场」→「看金句」；「参与场次」→「朗读金句」（列表页标题 + 用户面板菜单）；「初级场 / 中级场 / 高级场 / 专家场」→「初级 / 中级 / 高级 / 专家难度」；收藏页空态与个人主页对比文案里的「竞技场」→「金句」—— 做完的标志：界面上搜不到「竞技场 / 场次 / 场」，且没有一处混用「金句」与「句子」

### C. 上线 / 运维

- [ ] **C1** dev / prod 跑迁移 **0031–0034** —— 内容是「清库 + id 缩到 16 位 + 删冗余列」；跑完靠 `SEED_ON_START` 重灌种子并上传新音频。⚠️ 推 `dev` 会自动触发（AUTO_MIGRATE + SEED_ON_START）
- [ ] **C2** dev 临时开 **MySQL 外网地址** —— 才能从本机灌种子；灌完可关
- [ ] **C3** **prod 的 `jushuo` 库还不存在**（`Unknown database`）—— 先建库再谈迁移
- [ ] **C4** 小程序开发者工具**清一次 Storage 缓存** —— 里面可能还留着旧的 64 位 id
- [ ] **C5** 清理旧对象存储 key（64 位 id 那批）—— 上线后它们成为孤儿
- [ ] **C6** **产品验证实验**：真人录音回答 5 个产品问题 —— ①朗读难度是否真影响拿分难度 ②分数分布→门槛标定 ③重口音识别率 ④竞技场长度与重录意愿 ⑤词级诊断准不准。需要讯飞密钥 + 4–6 位朗读者；方案见 docs/experiments/validation-experiment.md。⚠️ **方案级风险**：若 ①「朗读难度不影响拿分难度」成立，则「按难度分层」在产品里没有依据 —— 难度需要重新定位（可能动摇它的存在本身）

---

## 已完成

> ⭐ 本节的 `[x]` 由 `pnpm plan:status --write` **从 git 派生**，不要手写、不要手改。
> 天生没有 commit 的完成项写在下一节。

- [x] **B7** 把存量按主题拆成带 `plan <ID>` 的 commit —— 做完的标志：工作区干净、`plan:status` 认得出这批提交

- [x] **B8** plan 改用**统一 checkbox**（`- [ ]` / `- [x]`），`[x]` 由 `pnpm plan:sync` 从 git 派生并归档 —— 做完的标志：plan.md 全是 checkbox、`plan:status` 能报「有 commit 但没勾」、`--write` 幂等

- [x] **B9** 写清**多任务并行**的冲突规则（四个冲突面 + 各自的消法），并加 `pnpm task:*` worktree 工具 —— 做完的标志：AGENT.md 有这一节、`pnpm task:start/list/remove` 可用

- [x] **B10** AGENT.md 写清**「人怎么派活」**—— 四种句型、你只需要决定的三件事、每次任务的固定回路 —— 做完的标志：AGENT.md 有这一节，派活不用再问

- [x] **B11** 难度定级改为**纯 LLM 判定**：废弃「脚本算特征」方案 —— 改掉步骤说明与注释、在 spec.md 记下这条决策 —— 做完的标志：全仓库没有把它当**现行方案**的地方（注释/文档里的「已废弃」说明不算；docs/archive 不动）

- [x] **B12** 难度提示词改为**中国学习者视角**：四档重写 + 加「中国学习者最常错的音」清单 + reason 必须点出具体难点 —— 做完的标志：提示词以中国学习者为基准，prd/spec 记下这条口径

- [x] **B13** 用新口径**重判存量内容**（B12/B14 已完成）—— 只改正文 JSON 的 `pronLevel` / `vocabLevel` / `reason`（`text` 不动 ⇒ **id 不变**），改完刷 `articles` 的派生索引（`pnpm content:regrade --apply`）—— 做完的标志：8 句的两轴与 reason 都是当前提示词判出来的，且 `articles.pron_level` / `vocab_level` 与 JSON 一致

- [x] **B14** 校准难度提示词的**档位分布** —— 实测（B12 之后重判 8 句）：**7 句上移**、5 句挤在「高级」，出现**天花板效应**。根因：清单写成「**出现即加难度**」，而 `the` 的 /ð/、连读几乎每句都有 → 要改成按**密度与叠加**升档，并写明「`the` 的 /ð/ 太普遍，**不单独**构成升档理由」—— 做完的标志：重判后档位至少覆盖 3 档、不挤在单档

- [x] **B16** **难度拆成两维**（词汇难度 + 发音难度）—— 轴已定（2026-09）。要做四件：
  ① 数据上两个档位（`vocabLevel` / `pronLevel`），库里两列（派生索引，供筛选排序）；
  ② `reason` **进正文 JSON 且给用户看**，固定格式：**以「相当于<级别>水平」开头**（级别用考试口径：小学 / 初中 / 高中 / 大学四级 / 六级 / 考研 / 雅思 6.5 / GRE），随后是发音难点，`；` 后是词汇与句式点评。例：
     `相当于大学4级水平，world 的 r 和 l 挨着念、结尾 -ngths 连读很别扭；词都比较常见，只有 sophistication 稍超纲。`
  ③ detail 接口改成**显式挑字段**（现在 `...content` 是"JSON 里有什么就漏什么"，reason 要漏给用户但别的内部字段不能）；
  ④ 顺带把轴无关的符号改名：`DIFFICULTY_LABEL`→`LEVEL_LABEL`、`DIFFICULTY_ORDER`→`LEVEL_ORDER`、`normalizeDifficulty`→`normalizeLevel`、`ArticleDifficulty`→`ArticleLevel`；字段/列 `difficulty`→`pronLevel`/`pron_level`
  —— 做完的标志：正文 JSON 有两个档位 + 一句 reason（格式如上）、库里两列、admin 与 detail 都能看到、8 句实测两轴分布都合理。**B15 并入本条**，词汇轴的锚点用你给的人工样本：
  - **专家**：The assumption that human behavior is governed entirely by rational choice ignores the profound influence of subconscious emotions, which often drive decisions long before logic has had the chance to intervene
  - **高级**：Companies that fail to adapt to the rapidly changing technological landscape risk being left behind by competitors who are quicker to embrace innovation.
  - **中级**：Although the internet has made it easier than ever to access information, finding reliable sources requires a high level of critical thinking
  - **中级**：The only thing we have to fear is fear itself, nameless, unreasoning, unjustified terror which paralyzes needed efforts.
  - **初级**：The best way to predict the future is to invent it.
  - **初级**：Don't count the days, make the days count.

- [x] **B17** admin「新增句子」改成**批量入库**（2026-09 需求）：① 多段输入（空行分隔）→ LLM **拆分 + 纠错** → ② 多选/可编辑候选列表（默认全选）→ ③ 批量生成（**先 LLM 出 N 条 → 再批量 TTS → 最后上传静态资源 + 入库草稿**）→ ④ 入库列表（URL + 勾选）→【发布】批量置为已发布 —— 做完的标志：粘一段多段文本（含 `itand` 这类错）能拆成多条、纠错、勾选、批量入库、批量发布，且**已存在的条目被跳过（不浪费生成成本）**

- [x] **B18** 批量入库的**拆分改成代码按空行**（一段 = 一条，确定性），LLM **只负责纠错 + 四项元数据** —— 用户 2026-09 决定：**接受将来出现超长句**，不要模型自己判切分 —— 做完的标志：段数 = 条数（代码保证），模型只填内容；提示词里删掉「切分规则」

- [x] **B19** 把 `The world is like a mirror…` 换成**纠错版**：纠错后的正文入库并发布；带错的那条（`c3cd0bb15f936445`）下架 —— 用户 2026-09 确认

- [x] **B20** 难度**收回成一个档位**（`difficulty`）+ `reason`，三个判据分另记进 `scores`：**判据是判据，不是字段**（用户 2026-09 三次纠正 —— 先「词汇 / 发音是两维」，再「输出就是一个难度字段和 reason」，最后「每个纬度的评分也记进去」）—— 撤掉 `pronLevel` / `vocabLevel` 两个字段与库列（迁移 0036），提示词改成「按 词汇×5 / 发音×3 / 长度×2 各打 1–5 分 → **代码**加权合成档位」，把 ECDICT 做成 LLM 的 `dict_lookup` 工具，并按用户给的 6 句锚点校准（**FDR 那句必须是中级**），存量 9 条已按新口径重判 —— 做完的标志：正文 JSON 是 `difficulty` + `scores` + `reason`、库里一列且与 JSON 一致（`content-files.test.ts` 会验算档位）、admin 只有一个徽章（三个分可改、档位实时算）、客户端只有一枚徽章 + 一句话

- [x] **B21** 冷启动「重试到预算用尽」时**抛的是原始错误、不是人话**：`requestWithRetries` 里预算预检查 `break`（client.ts:421）之后直接 `throw lastErr`（:481），绕过了下面那段 COLD_START / SCORING 的友好错误。而 `callContainer` 单次上限 15s、启动预算 25s，冷启动时请求正是「挂在半路直到超时」——几乎必然走 `break` 这条出口，于是用户看到的是 `request:fail timeout`，那段友好提示成了**死代码**。**只改这一处出口**：把「预算耗尽」的翻译抽成一个 `exhaustedError()`，循环内最后一次失败与 `break` 之后都走它；不动重试节奏、不动任何接口行为 —— 做完的标志：冷启动挂起导致预算耗尽时，页面拿到的是 `code: 'COLD_START'`（或 `SCORING`）的人话，而不再是原始超时串；`tsc` 通过

- [x] **B22** **部署后标准音全丢、前端所有播放按钮消失**：`seedStandardAudio` 逐行 `storage.put`，**第一次失败即整趟抛出、没有重试、没有逐行隔离**；调用方只 catch 打日志。迁移 0031–0034 清库后 `standard_audio` 全空，接口返回 `audio: null`，前端 `wx:if="{{entry.audio}}"` 于是**一个播放入口都不渲染**（dev 实测 `standardAudioConfigured: 0`、`fileInBucket: false`，而盘上 mp3 与 `/media` 都正常）。**不要**只做「再灌一次」——要让它抗住启动期的瞬时失败 —— 做完的标志：灌音频按行隔离 + 带退避重试，`/health?deep=1` 能报出**真实的上传错误**（现在只有 `fileInBucket: false`，看不出为什么），且失败不再让列留空

- [x] **B23** **dev 冷启动（`min=0`）下客户端首屏几乎必然失败**（用户 2026-09 选择「保持 min=0、改客户端」）：`LAUNCH_BUDGET_MS = 25s` < 云托管缩容后的冷启动（实测 30s 级），而 `callContainer` 单次上限只有 15s —— 启动请求在实例起来之前预算就耗尽。现象是「首次打开/打卡 → 连不上服务器，检查网络后重试」，**再点一次就好**（那时实例已热，0.15s）。这是省钱（`min=0`）与体验的同一个取舍，不是新 bug。① 启动预算提到能覆盖冷启动；② 冷启动失败时给「正在唤醒服务」而不是把平台缩容说成网络故障 —— 做完的标志：冷启动下**不用手动重试**首次启动就能成功（等待约 30 秒），超时文案不再误导成网络问题

- [x] **B27** **朗读页下方「历史挑战」列表**（`docs/design/reading/SPEC.md` 施工计划第 4 步）：接口 `GET /api/user/article-records` 与端侧 `fetchArticleRecords` 早就有了，但朗读页一个字段都没渲染 —— 用户看不到「我在这一句上读过几次、每次多少分」。要做的：`lib/article-history.ts` 把接口响应变成一行（第 N 次 + 时间 + 分数 + 最高），免掉「当前这一次」（口径见 SPEC「历史列表不含当前这一次」），行点进 `pages/challenge` 看那一次的详情；加载中 / 失败可重试 / 空列表三种文案各一条 —— 做完的标志：真机在朗读页（有分的那一次）能看到这句的逐次记录，行点进去是**那一次**的结果屏，且没有当前那一条

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
- **「竞技场 / 场次 / 场」这组用户词** —— 假概念；用户词只有「金句 · 挑战 · 难度 · 今日挑战」，不要再加回来（prd 第二节）
- **全局排期 / 每天一句** —— 首页那一句由**每用户 24 小时窗口**决定；不要加回按天分配（删除任务见 B24）
- **短文 ⊃ 多个竞技场 的两层结构** —— 内容单位与比较单位都是「一句」
- **练习模式 / 竞技模式** —— 产品只有「录音重录」与「提交检测」两个动作
- **85 分攻克线** —— 改成出分即攻克（判据 = `status='scored'`）
- **能力分 P / 经验分 E / 质量分 Q（对外）/ 难度系数 D（对外）/ v1 难度分级（1–5 星）** —— 都比不过「一个 0–3 档 + 分数 + 名次」
- **CEFR 等级 / 6 个称号** —— 与产品语言不一致
- **能力分曲线 / 三条曲线 / 能力边界图 / 平均击败百分位 / 总积分** —— 由「单句刷新 + 难度档位」取代；总积分类累加值不做排行榜
- **每句额度（免费 1 次 + 2 分钟间隔）** —— 已整体换成能量（跨天留存）
