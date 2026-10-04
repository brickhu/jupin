import { PARTICIPATION_ID_LENGTH } from './constants/index'
import { sha256Hex } from './article-id'

/**
 * ⭐⭐ **参与记录的地址**：`sha256(` + "`<userId>:<articleId>`" + `)` 的十六进制前 `PARTICIPATION_ID_LENGTH` 位。
 *
 * ⚠️⚠️ 与 `articleIdOf` 同一条纪律：**这个式子只允许有这一处实现**。
 *    服务端建表/写库、迁移回填、接口校验都从它派生 —— 各写一份必然漂。
 *
 * ⚠️ 必须是**派生值**：`participations` 是重算式派生索引（重建会重写所有行），
 *    自增 id 一重建就换号，已经发出去的链接（`/api/participation/{id}`）会指向别人。
 *    ⚠️ 与迁移 0057 的回填**逐字符一致**：
 *    `LEFT(SHA2(CONCAT(user_id, ':', article_id), 256), 24)`。
 *    改这里必须同时改那边（并重建整表），否则老行与新行会分成两套地址 —— 而且两边都不报错。
 *
 * ⚠️ 用 `:` 分隔而不是直接拼：`(12, '3x')` 与 `(123, 'x')` 直接拼是同一个串。
 */
export function participationIdOf(userId: number, articleId: string): string {
  return sha256Hex(`${userId}:${articleId}`).slice(0, PARTICIPATION_ID_LENGTH)
}
