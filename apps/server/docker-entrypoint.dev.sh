#!/bin/sh
# 开发容器启动脚本：迁移 → 种子 → 起服务
#
# ⭐ 为什么要放进容器：
#    迁移和种子若在宿主机跑，用的是 .env 里的 localhost:${DB_PORT}；
#    在容器里跑则用 compose 注入的 db:3306。
#    两条路径并存极易搞混（"明明迁移了怎么还报表不存在"）。
#    放进容器 = 只有一条路径。
set -e

echo "[dev] 应用数据库迁移…"
pnpm --filter @jushuo/server db:migrate

echo "[dev] 写入种子数据（幂等）…"
if pnpm --filter @jushuo/server seed; then
  echo "[dev] 种子完成"
else
  echo "[dev] ⚠️ 种子失败，继续启动（不影响空库调试）"
fi

echo "[dev] 启动开发服务…"
exec pnpm --filter @jushuo/server dev
