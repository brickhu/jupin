# 句说 · 阿里云部署指南

> SAE（Serverless 应用引擎）+ RDS PostgreSQL Serverless + OSS 静态托管

---

## 一、费用预估

| 组件 | 规格 | 月费 |
|------|------|------|
| SAE（后端） | 0.5核1G，按量 | ~¥15-25 |
| RDS PostgreSQL Serverless | 0.5核1G，按量 | ~¥10-15 |
| OSS（前端静态托管） | 标准存储 | ~¥1-3 |
| 邮件推送 | 200封/天免费 | ¥0 |
| **合计** | | **~¥26-43/月** |

---

## 二、RDS PostgreSQL Serverless

### 2.1 创建实例

1. 登录[阿里云 RDS 控制台](https://rds.console.aliyun.com)
2. 点击 **创建实例**
3. 配置：
   - **计费方式**：Serverless
   - **引擎**：PostgreSQL 17
   - **规格**：0.5核-1核，1GB
   - **存储**：20GB ESSD PL1
   - **VPC**：与 SAE 在**同一个 VPC**
4. 创建成功后，设置白名单：添加 SAE 应用的 VPC 网段

### 2.2 创建数据库

```sql
CREATE DATABASE jushuo;
```

### 2.3 连接信息

保存以下信息到后续 SAE 环境变量：
```
DATABASE_URL=postgres://用户名:密码@数据库内网地址:5432/jushuo
```

> 内网地址在 RDS 实例详情页查看，格式如 `pgm-xxx.pg.rds.aliyuncs.com`

---

## 三、后端部署（SAE）

### 3.1 创建容器镜像仓库（ACR）

1. 登录[ACR 控制台](https://cr.console.aliyun.com)
2. 创建**个人版**实例（免费）
3. 创建命名空间 `jushuo`
4. 创建镜像仓库 `backend`

### 3.2 本地构建并推送镜像

```bash
cd backend

# 登录 ACR
docker login --username=你的阿里云账号 registry.cn-hangzhou.aliyuncs.com

# 构建镜像
docker build -t registry.cn-hangzhou.aliyuncs.com/jushuo/backend:latest .

# 推送镜像
docker push registry.cn-hangzhou.aliyuncs.com/jushuo/backend:latest
```

> 每次更新代码重复此步骤即可

### 3.3 创建 SAE 应用

1. 登录[SAE 控制台](https://sae.console.aliyun.com)
2. **命名空间**：选择与 RDS 同地域
3. **创建应用**：
   - **应用部署方式**：镜像
   - **镜像地址**：`registry.cn-hangzhou.aliyuncs.com/jushuo/backend:latest`
   - **规格**：0.5核 1GB
   - **最小实例**：0（缩容到零，省费用）
   - **最大实例**：1（MVP 足够）
   - **VPC**：与 RDS 同一个 VPC

### 3.4 配置环境变量

在 SAE 应用配置中添加：

```env
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://用户:密码@数据库内网地址:5432/jushuo
JWT_SECRET=<生成一个随机密钥>
AZURE_SPEECH_KEY=<你的 Azure Key>
AZURE_SPEECH_REGION=eastasia
DEEPSEEK_API_KEY=<你的 DeepSeek Key>
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
SMTP_HOST=smtpdm.aliyun.com
SMTP_PORT=465
SMTP_USER=<阿里云邮件推送账号>
SMTP_PASS=<阿里云邮件推送密码>
EMAIL_FROM=noreply@jushuo.com
ALIPAY_APP_ID=placeholder
ALIPAY_PRIVATE_KEY=placeholder
ALIPAY_PUBLIC_KEY=placeholder
ALIPAY_NOTIFY_URL=https://<你的SAE域名>/api/payment/notify
```

### 3.5 数据库迁移

SAE 支持**初始化容器**，或者通过本地执行：

```bash
# 本地用临时连接执行迁移
DATABASE_URL=<生产数据库地址> npx drizzle-kit migrate
```

或者将 SAE 应用的**启动后脚本**设为：
```bash
node dist/db/migrate.js
```

### 3.6 绑定域名

1. 在 SAE 应用详情中获取**内网/外网访问地址**
2. 绑定自定义域名（可选）

---

## 四、前端部署（OSS 静态网站托管）

### 4.1 创建 OSS Bucket

1. 登录[OSS 控制台](https://oss.console.aliyun.com)
2. 创建 Bucket：
   - **地域**：与 SAE 同地域
   - **存储类型**：标准存储
   - **读写权限**：公共读

### 4.2 配置静态网站托管

1. Bucket 详情 → **静态页面**
2. 设置：
   - **默认首页**：`index.html`
   - **默认 404 页**：`index.html`（SPA 路由需要）

### 4.3 构建并上传前端

构建时需要指定生产 API 地址：

```bash
cd frontend

# 构建（指定生产后端地址）
VITE_API_URL=https://<你的SAE域名> npm run build

# 上传到 OSS（使用阿里云 CLI）
ossutil cp -r dist/ oss://你的-bucket-名称/ --update

# 或使用 OSS 控制台手动上传 dist/ 目录
```

> 如果使用自定义域名（如 `api.jushuo.app`），也可以设置 `VITE_API_URL=https://api.jushuo.app`

### 4.4 绑定域名（可选）

1. OSS Bucket → **域名管理** → 绑定自定义域名
2. 添加 CNAME 记录指向 OSS 域名

---

## 五、阿里云邮件推送

1. 登录[邮件推送控制台](https://dm.console.aliyun.com)
2. **发信域名**：验证你的域名（如 `jushuo.com`）
3. **SMTP 密码**：生成 SMTP 专用密码
4. 将上述信息填入 SAE 环境变量

---

## 六、持续部署（CI/CD）

推荐用 GitHub Actions 自动构建推送：

在仓库根目录创建 `.github/workflows/deploy.yml`：

```yaml
name: Deploy to Aliyun

on:
  push:
    branches: [main]

jobs:
  deploy-backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build & Push Docker Image
        run: |
          docker build -t registry.cn-hangzhou.aliyuncs.com/jushuo/backend:latest backend/
          docker push registry.cn-hangzhou.aliyuncs.com/jushuo/backend:latest

  deploy-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build Frontend
        run: |
          cd frontend
          npm install
          npm run build
      - name: Upload to OSS
        run: |
          ossutil cp -r frontend/dist/ oss://your-bucket/ --update
```

---

## 七、首次部署检查清单

- [ ] RDS 与 SAE 在**同 VPC**
- [ ] RDS 白名单已放通 SAE 网段
- [ ] SAE 环境变量全部配置正确
- [ ] 数据库迁移已执行（`drizzle-kit migrate`）
- [ ] OSS Bucket 已开启静态网站托管
- [ ] OSS 已设置 404 为 index.html
- [ ] 阿里云邮件推送已验证域名
- [ ] 前端 `/api` 已配置生产后端地址