import { count, eq } from 'drizzle-orm'

import { db } from '../db'
import { articles, favorites, participations, submissions } from '../db/schema'

/**
 * ⭐⭐ **删除一条句子**（管理台的功能，2026-09 用户提出"句子管理缺少删除功能"）。
 *
 * ⚠️⚠️ **只删这一句，用户的数据一概不删**（用户 2026-09 明确要求："participations 的记录其实不用删"）。
 *
 *    为什么这样是**对的**（不是妥协）：
 *    ① 句子的 id 是**内容哈希**（`sha256(text)` 前 16 位）⇒ 同一句删掉再加回来 **id 完全相同**，
 *       历史（成绩 / 参与 / 收藏）**自动接回** —— 删掉用户成绩反而是不可逆的损失；
 *    ② 指向已删句子的行**在界面上不会出现**：所有列表都是
 *       `innerJoin(articles, …)`（见 routes/user.ts 的"我的参与"），关联不上就自然被过滤掉；
 *    ③ 外键已去掉（迁移 0047）：`submissions` / `participations` / `favorites` 的
 *       `article_id` 不再 REFERENCES `articles` —— 否则 `DELETE` 会被 1451 拦下，
 *       而"留历史"与"外键约束"是互斥的。
 *
 * ⚠️ 与"下架"（`is_active = false`）的分工：
 *    · **下架** = 不推荐、不进首页，但句子还在（内容可以改回来）；
 *    · **删除** = 这条内容不要了（写错了、重复了）。**删的是内容，不是数据**。
 *
 * ⚠️ 收在服务里、不让路由直接 `db.delete(articles)`：删句子牵扯四张表的概念，
 *    放任各处自己删迟早出现"某处顺手级联删掉用户成绩"。
 */

export interface ArticleRefs {
  submissions: number
  participations: number
  favorites: number
}

/** 这条句子被多少用户数据引用（删除前告诉人"有这些历史，它们会留着"） */
export async function articleRefsOf(articleId: string): Promise<ArticleRefs> {
  const [s] = await db.select({ n: count() }).from(submissions).where(eq(submissions.articleId, articleId))
  const [p] = await db.select({ n: count() }).from(participations).where(eq(participations.articleId, articleId))
  const [f] = await db.select({ n: count() }).from(favorites).where(eq(favorites.articleId, articleId))
  return {
    submissions: Number(s?.n ?? 0),
    participations: Number(p?.n ?? 0),
    favorites: Number(f?.n ?? 0),
  }
}

/**
 * 删一条句子（**只删 `articles` 里那一行**）。
 *
 * ⚠️⚠️ **有历史就拒绝**（`refs` 非空时 `deleted: false`），路由据此回 409。
 *    为什么必须拒绝 —— 这是用户 2026-09 提"participations 要记下 text"时一起显出来的：
 *    · participations 要**自足**（没上线 / 内容改过也能显示"读的是哪句"）⇒ 它必须存 text 快照；
 *    · 而快照的**取数来源是 articles** ⇒ 句子真被硬删之后，**新记录再也取不到 text 了**；
 *    · 更要紧的是：删掉一句有成绩的句子 = 用户的"已挑战"历史指向一个不存在的东西。
 *    ⇒ 所以日常该用的是**下架**（`is_active = false`）；删除只用于"刚建错、还没人碰过"的句子。
 *
 * ⚠️ 外键虽然已在迁移 0047 去掉（那是为了"内容被改/下线时历史仍留得住"），
 *    但**去外键不等于允许硬删** —— 约束松了，判据就得写在代码里（就是这一条）。
 *
 * @returns `deleted` 是否真删了；`refs` = 这句被多少用户数据引用
 */
export async function deleteArticle(articleId: string): Promise<{ deleted: boolean; refs: ArticleRefs }> {
  const refs = await articleRefsOf(articleId)
  if (refs.submissions > 0 || refs.participations > 0 || refs.favorites > 0) {
    return { deleted: false, refs }
  }
  await db.delete(articles).where(eq(articles.id, articleId))
  return { deleted: true, refs }
}
