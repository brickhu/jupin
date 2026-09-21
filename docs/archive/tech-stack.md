# 句拼 · 技术栈参考

> 详细架构方案见 `architecture.md`，科大讯飞备份方案见 `ise-integration-plan.md`。

## 前端

| 项 | 选型 | 说明 |
|----|------|------|
| 框架 | **SolidJS**（v1.x）+ TypeScript | 无虚拟 DOM，产物 ~7KB gzip |
| 构建工具 | **Vite** | 秒启 HMR，SolidJS 原生插件 |
| CSS | **TailwindCSS 4.0** | Rust 引擎，CSS-first 配置 |
| 路由 | **@solidjs/router** | 官方路由，支持懒加载 |
| 图表 | **Chart.js** | 绘制能力分趋势折线图（轻量） |
| 录音 | **Web Audio API + MediaRecorder API** | 原生 API，零依赖 |
| 托管 | **Zeabur**（静态站点） | 连接 GitHub 自动部署，内置 HTTPS/CDN |
| 域名 | MVP: `*.zeabur.app`；正式: `jushuo.app` | ICP 备案后切换 |

**代码位置：** `frontend/`

## 后端

| 项 | 选型 | 说明 |
|----|------|------|
| 运行时 | **Node.js 20 LTS** | 稳定，ESM 原生支持 |
| 框架 | **Hono**（v4.x） | 超快 Web 标准框架，内置 CORS/JWT/限流 |
| 数据库 | **PostgreSQL 17** | Zeabur Marketplace 一键创建，JSONB 支持 |
| ORM | **Drizzle ORM** | TypeScript-first，零运行时开销，迁移工具内置 |
| 鉴权 | **JWT**（Hono 内置 jwt 中间件） | 无状态 token |
| 限流 | **Hono 内置 rate-limiter** | 免费 5 次/日、付费 500 次/日 |
| 托管 | **Zeabur**（Node.js 服务） | 连接 GitHub 自动部署 |
| API 域名 | MVP: `*.zeabur.app`；正式: `api.jushuo.app` | 前后端分离部署 |

**代码位置：** `backend/`

## 语音引擎

**主选：Azure Speech Pronunciation Assessment API**
- 原生支持音素级评分（准确度、流利度、完整度、韵律）
- 成本：$0.30/实时小时（按需），预留可至 $0.15-0.24/小时
- 备份：科大讯飞 ISE（详见 `ise-integration-plan.md`）

## AI 服务

**内容生成 & 发音建议：DeepSeek V4-Flash**
- 国内 API 直连，无需翻墙
- 缓存命中输入 ¥0.2/百万 tokens，输出 ¥2/百万 tokens
- 单篇内容成本 ~¥0.0007
- 发音建议按 (单词, 错误类型) 缓存，命中率 >80%
- 仅付费用户可见 AI 建议

## 登录系统

| 阶段 | 方案 | 备注 |
|------|------|------|
| **MVP** | **邮箱 + 密码** | 阿里云企业认证尚未开通 |
| 企业认证通过后 | **手机号 + 短信验证码** | 阿里云短信服务，~¥0.05/条 |
| 二期可选 | 微信扫码 / 支付宝授权登录 | 降低登录摩擦 |

## 支付接入

| 场景 | 方案 | 备注 |
|------|------|------|
| 单篇解锁 | **支付宝电脑网站支付**（¥0.99） | 用户扫码付款 |
| Pro 订阅 | **支付宝周期扣款协议**（¥29/月 或 ¥199/年） | 签约后自动扣款 |
| **优先级** | 先只接支付宝 | DeepSeek + 支付宝 = 全部国内链路 |

## 部署方式

- 前后端分别创建两个 Zeabur 应用，连接 GitHub 仓库
- `git push main` 自动部署
- PostgreSQL 通过 Zeabur Marketplace 一键创建，连接字符串自动注入环境变量
