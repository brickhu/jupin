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
# 静态内容（contentJson 写成相对路径时从这里读）
COPY content ./content
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
COPY --from=build /app/apps/server/dist/index.mjs ./index.mjs
COPY --from=build /app/apps/server/dist/index.mjs.map ./index.mjs.map

EXPOSE 3000
CMD ["node", "index.mjs"]
