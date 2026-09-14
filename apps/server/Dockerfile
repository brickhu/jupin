# ---- 构建阶段 ----
FROM node:20-alpine AS build
WORKDIR /app
RUN npm i -g pnpm@9

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
RUN pnpm --filter @jushuo/server build

# ---- 运行阶段 ----
FROM node:20-alpine
WORKDIR /app
RUN npm i -g pnpm@9

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/packages/shared/src ./packages/shared/src

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
