# 生产镜像 —— 同时用于本地构建与**微信云托管**部署。
#
# ⭐ 构建上下文必须是**仓库根目录**：
#    云托管里对应「部署发布 → 目标目录」留空（等价于根目录），
#    对应 CLI 的 --targetDir=. ，对应 debug.config.json 的 buildDir: ""。
#    因为 pnpm workspace 必须能看到 pnpm-workspace.yaml / pnpm-lock.yaml / packages/shared。
#    云托管的「DockerFile 文件」填：apps/server/Dockerfile
#
# ⚠️ 运行阶段**没有 node_modules**：产物是 esbuild 打的单文件 bundle
#    （见 apps/server/build.mjs）。镜像小、冷启动快，
#    也绕开了「shared 的 main 指向 TS 源码、Node 加载不了」这个坑。

# ---- 构建阶段 ----
FROM node:20-alpine AS build
WORKDIR /app
RUN npm i -g pnpm@9

# ⚠️ 必须把**所有** workspace 成员的 package.json 都拷进来：
#    pnpm 按 pnpm-workspace.yaml 的 glob 找项目，少一个就会和 pnpm-lock.yaml 对不上，
#    --frozen-lockfile 会直接失败。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/miniprogram/package.json ./apps/miniprogram/
COPY tools/pipeline/package.json ./tools/pipeline/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
# ⚠️⚠️ **不再 COPY content** ✗ —— 它已经从 git 里移除（用户明确要求 ✓）
#    而且云端本来就**不需要**它：句子在库 ✓ 标准音在对象存储 ✓
#    （本机联调才用它，见 routes/media.ts 那条"云端根本不走"的路由 ✓）
#    ⚠️ 留一个空目录：services/content.ts 的 resolveStaticRoot() 靠"有没有 content/"
#       来判根在哪 ✓ 没有它只是"静态资源读不到"（返回 null ✓ 不报错 ✓）
RUN mkdir -p content

# ⭐⭐ KWS 模型（端侧逐词标注用）—— **不进 git** ✗（4.4MB 的第三方预训练产物）
#    构建时拉一次，落在 content/kws/ ⇒ 下面运行阶段的 `COPY --from=build /app/content`
#    会自动把它带过去 ✓ 而服务端**不需要额外的路径解析** —— 现有的 readStaticFile
#    就能读到它（那是本仓库明确写过的一条教训：不要两处各自解析路径 ✓）
#    ⚠️ alpine 的 tar 解 .tar.bz2 需要 bzip2 包 ⇒ 一起装 ✓
#    ⚠️ 落点是 **apps/server/assets/kws/**（服务端资产 ✓）而**不是 content/** ✗ ——
#       见 scripts/fetch-kws-model.mjs 里的说明 ✓
# ⚠️⚠️ **这一步失败不许把整个部署弄挂** ✗
#    模型只是个**可选资源**：没有它，只有「逐词标注」这一个功能降级 ✓
#    （路由会回 404「模型未就绪」✓ 端侧探针会明确报出来 ✓）
#    而它要从 GitHub releases 拉 31MB ✗ —— 构建机网络抽风是常事 ✓
#    ⇒ 用 `|| echo` 兜住：**构建照常成功**，只是 KWS 功能没就绪 ✓
#    ⚠️ 反过来（让它 fatal）的代价是：一次网络抖动 = **整个 dev 部署失败** ✗
#       而部署一挂，**所有别的改动也一起上不去** ✗ —— 那个代价大得多 ✓
RUN apk add --no-cache curl bzip2 \
 && (node apps/server/scripts/fetch-kws-model.mjs \
     || echo '⚠️ [kws] 模型没抓到 —— 构建继续，逐词标注功能降级（其余功能不受影响）')

RUN pnpm --filter @jushuo/server build

# ---- 运行阶段 ----
FROM node:20-alpine
WORKDIR /app

# ⭐ ffmpeg —— 音频归一化用（services/audio.ts）。
# ⚠️ 为什么服务端必须能解码：客户端传上来的**不一定是裸 PCM** ——
#    开发者工具直出 WebM/Opus 容器，真机直出裸 PCM。设备产出什么格式，客户端说了不算。
#    没有它，「本地录音 → 提交打分」在开发者工具里就跑不通（实测根因）。
RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production
ENV PORT=3000
ENV MIGRATIONS_DIR=drizzle

# 迁移 SQL —— 容器启动时 AUTO_MIGRATE=true 会用到
COPY --from=build /app/apps/server/drizzle ./drizzle
# 静态内容 —— services/content.ts 的 CONTENT_DIR 候选之一就是 /app/content
COPY --from=build /app/content ./content
# ⭐ KWS 模型（服务端资产）—— 显式 COPY，不搭 content 的车 ✓
#    模型不在时这里会 COPY 失败 ✗ ⇒ 用通配兜一层（构建阶段那条 RUN 允许失败 ✓）
COPY --from=build /app/apps/server/assets* ./assets
COPY --from=build /app/apps/server/dist/index.mjs ./index.mjs
COPY --from=build /app/apps/server/dist/index.mjs.map ./index.mjs.map

EXPOSE 3000
CMD ["node", "index.mjs"]
