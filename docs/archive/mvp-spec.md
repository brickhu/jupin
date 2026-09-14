# 句说 · MVP 规格

> **MVP 载体：独立 Web 网站（移动端优先响应式）**，非小程序/非原生 App。
> 目标：3 人团队 4 周内可交付。

## 为什么是网站不是小程序？

| 维度 | 微信小程序 | 独立网站 |
|------|-----------|---------|
| 上线周期 | 7-15 天审核 | **即时上线** |
| 更新频率 | 每次更新需审核 | **随时推送** |
| 用户获取 | 微信生态内传播 | URL 直达，任何渠道均可 |
| 录音支持 | 小程序录音 API | Web Audio API（可靠性 95%+） |
| 支付接入 | 微信支付（需商户号+审核） | 支付宝扫码即可 |
| 后续 App 打包 | 需重新开发 | PWA 或 WebView 壳直接转 |

## MVP 核心原则

1. **最短闭环：** 从看到句子到完成评分，3 步内完成
2. **第一天就收钱：** 付费墙从 MVP 第一天就存在
3. **不做社交：** 不做社区、排行榜、feed 流，只做分享链接
4. **人工+AI 混合：** 内容生成允许半人工操作（手动触发，人工审核后上线）
5. **网站优先：** 零审核周期，随时部署，移动端优先响应式

## 功能优先级

### P0 — MVP 必须包含（4 周交付）

| 编号 | 功能 | 描述 |
|------|------|------|
| P0.1 | 句子展示页 | 今日推荐短句，可滑动浏览（5-50 词），附中文翻译 |
| P0.2 | 手机录音 | Web Audio API + MediaRecorder 录制，自动上传 |
| P0.3 | AI 基础评分 | 调用 Azure Speech API，返回质量分 Q（0-100） |
| P0.4 | 经验分+能力分展示 | 显示本次经验分、累计经验、当前能力分 P 及称号 |
| P0.5 | 能力分趋势图 | 折线图展示最近 30 次能力分变化 |
| P0.6 | 免费/付费区分 | 免费用户只看到两个数字；付费用户看到逐句纠音+三条曲线 |
| P0.7 | 单篇付费解锁 | ¥0.99 支付宝扫码解锁本篇纠音 |
| P0.8 | Pro 订阅 | ¥29/月 或 ¥199/年，支付宝周期扣款 |
| P0.9 | 用户系统 | 邮箱+密码注册登录，保存朗读历史和分数数据 |
| P0.10 | 分享链接 | 生成分享页 URL（含句子+分数变化） |
| P0.11 | 今日推荐算法 | 根据用户能力分 P 推荐难度 D 接近的文章 |

### P1 — 有余力则做（4-6 周）

连胜 streak、CEFR 等级标志、历史记录查询、AI 内容批量生成脚本、错误单词列表+对比播放、PWA 支持。

### P2 — MVP 之后

周排行榜（日活>500）、主题分类（内容量足够后）、好友PK（日活>1000）、多语言、自定义文章上传、音素级动画可视化、原生 App（留存>40%后）。

## 用户流程（页面级）

**新用户首次打开：**
```
访问网站 → 邮箱注册/登录 → 首页看到今日推荐句子
  → 点击"开始朗读" → 麦克风授权 → 录音 → 完成
  → 等待 2-3 秒 → 评分结果页：
    ┌──────────────────────────────┐
    │  评分剩余 4/5 次              │
    │  "The only way to do great   │
    │   work is to love what       │
    │   you do." — Steve Jobs      │
    │  ┌──── 评分结果 ──────┐      │
    │  │  经验分 +150        │      │
    │  │  能力分 65（B1）     │      │
    │  │  难度 1.5           │      │
    │  └──────────────────────┘      │
    │  🔓 ¥0.99 解锁发音诊断        │  ← 付费墙
    │  或开通 Pro ¥29/月           │
    │  [📊 我的能力曲线] [📤 分享]  │
    └──────────────────────────────┘
```

**付费解锁后：** 句中错误单词红色标注，展示音素级纠正（如"way 中 /eɪ/ 读成了 /aɪ/"），可反复朗读打磨分数。

## Web 录音注意事项

| 浏览器 | 录音支持 | 备注 |
|--------|---------|------|
| iOS Safari 15+ | ✅ MediaRecorder（mp4 格式） | iOS 16.4+ 更稳定 |
| Android Chrome 90+ | ✅ MediaRecorder（WebM/Opus） | 兼容性最好 |
| 桌面 Chrome/Edge | ✅ | 开发调试方便 |

必须处理的场景：
1. **HTTPS 强制**：浏览器录音只在 HTTPS 下工作（localhost 除外）
2. **麦克风授权引导**：拒绝后需提示"请允许使用麦克风"
3. **录音格式统一**：WebM/Opus（Chrome）或 MP4/AAC（Safari），后端转码后传 Azure
4. **网络断开处理**：本地缓存录音，恢复后自动上传
5. **时长限制**：最长录音 30 秒自动停止

## 数据模型（MVP 最小版本）

详见后端代码 `backend/src/db/schema.ts`。核心表：

- **user**：id, email, password_hash, nickname, proficiency_score(P), total_experience(E_total), honor_title, streak_days, last_read_at, subscription_end, daily_submissions_left, daily_reset_date
- **article**：id, content, translation, difficulty(D), d_len, d_vocab, d_syntax, word_count, source_type, author, publish_date, is_active
- **reading_record**：id, user_id, article_id, quality_score(Q), experience_gained, proficiency_before, proficiency_after, is_paid, is_best, error_detail(jsonb), ai_suggestions(jsonb), audio_duration
- **user_article_status**：id, user_id, article_id, best_score, is_conquered(Q≥70), is_perfect(Q≥90), is_unlocked, attempts, first_read_at, best_read_at
- **pronunciation_tips**：id, word, error_type, correct_phoneme, user_phoneme, tip(中文建议), hit_count（AI建议缓存）
- **payment**：id, user_id, type('single'/'subscription'), channel('alipay'), amount, article_id, trade_no, out_trade_no, status('pending'/'success'/'refunded')

## 开发计划（4 周）

**Phase 1（第 1-2 周）核心闭环：**
前端项目初始化(1d) → 邮箱注册登录(1.5d) → 首页+录音按钮(2d) → 录音功能(3d) → 后端API基础(2d) → Azure评分集成(3d) → 评分结果页(2d)

**Phase 2（第 3 周）付费与曲线：**
支付宝接入(3d) → 单篇解锁+纠音展示(3d) → Pro订阅+周期扣款(2d) → 经验分+能力分计算(2d) → 趋势折线图(2d)

**Phase 3（第 4 周）留存与传播：**
连胜streak(1d) → 分享链接页(2d) → 推荐算法(1d) → AI内容生成脚本(2d) → PWA(1d) → Zeabur部署(0.5d) → 测试修复(3d)

## 验收标准

| 指标 | 验收标准 |
|------|---------|
| 核心闭环 | 进入→看句子→录音→评分→看到分数，全流程 < 10 秒响应 |
| 付费流程 | ¥0.99 单篇解锁 + ¥29 Pro 订阅签约成功，支付宝到账 |
| 能力分计算 | 读难文低分不明显降分；读简单文高分不明显涨分（防刷题） |
| 录音兼容性 | iOS Safari + Android Chrome 双端正常录音评分 |
| HTTPS 部署 | 全站 HTTPS，录音功能正常 |
| 分享链接 | 分享到微信可直接打开，社交卡片正确显示 |

## 成本估算（月度）

| 项目 | 月成本 | 备注 |
|------|-------|------|
| Zeabur Dev 计划 | $5（~¥36） | 前后端两个应用 + PostgreSQL |
| Azure Speech API | ¥300-900 | 1000用户×日均5次估算，最大成本项 |
| DeepSeek API | ¥1-5 | 内容生成+发音建议，缓存后极低 |
| 域名 jushuo.app | ¥3-6 | ~¥50/年 |
| 支付宝手续费 | 0.6%-1.0% | 从流水扣除 |
| **合计** | **~¥340-950/月** | |

**盈亏平衡：约 100 个付费用户即可盈利。**
