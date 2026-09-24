/**
 * ⭐ 内容寻址：文章 id = sha256(正文 trim 后) 的十六进制**前 ARTICLE_ID_LENGTH 位**（16 位 = 64 bit）。
 *    长度取多少、为什么是 16，写在 shared 的 constants（那才是唯一的定义处）。
 *
 * ⚠️⚠️ 全仓库**只有这一处**实现。
 *    这个式子本来散在三个地方（admin 服务 / 旧 CLI / backfill 脚本），
 *    每处都留一句「必须与别处口径一致」的注释 —— 那种注释不是约束，是祈祷。
 *    id 同时是主键、正文文件名、音频路径和客户端缓存 key：
 *    任何一处口径不一致，同一条句子就会变成两条互不相认的记录。
 *
 * ⚠️ 归一化**只有** trim()。不要顺手做 toLowerCase / 折叠空白 / 去标点：
 *    历史内容的 id 都按旧口径算过（库里的行、content/ 下的文件名、对象存储的 key），
 *    改口径必须配一次全量重命名，见 tools/rename-content-to-hash.mjs。
 */
import { createHash } from 'node:crypto'
import { ARTICLE_ID_LENGTH } from '@jushuo/shared'

export function articleIdOf(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, ARTICLE_ID_LENGTH)
}