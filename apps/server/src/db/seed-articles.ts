/**
 * 开发用的种子句子 —— **索引**，不是正文。
 *
 * ⚠️ articles 只是索引：正文在 contentJson 指向的静态 JSON 里
 *    （仓库根 content/articles/*.json；云上由 Dockerfile COPY 到 /app/content）。
 *    内容流水线（tools/pipeline）建好后会生成真正的 JSON 并放到 CDN，
 *    再把 URL 写回这里。
 *
 * ⚠️ 为什么单独拆一个文件、且用**动态 import** 拿 db：
 *    服务启动时（db/index.ts）和命令行（db/seed.ts）都要用它。
 *    若在本文件顶部静态 import db，就会和 db/index.ts 形成循环依赖
 *    （index → seed-articles → index）。动态 import 把解析推迟到调用时，绕开这个环。
 *
 * ⚠️ 这里**不写排期** —— 种子只提供句子，排期是 schedules 表的事。
 *    开发环境刻意不预置排期，好让「每日挑战」走轮转自动补行那条路。
 *    排期是运营动作；种子数据占掉某一天，反而会让本地永远测不到轮转。
 */

export interface SeedArticle {
  id: number
  contentJson: string
}

export const SEED_ARTICLES: SeedArticle[] = [
  { id: 1, contentJson: '/content/articles/1.json' },
  { id: 2, contentJson: '/content/articles/2.json' },
  { id: 3, contentJson: '/content/articles/3.json' },
  { id: 4, contentJson: '/content/articles/4.json' },
  { id: 5, contentJson: '/content/articles/5.json' },
]

/**
 * 幂等写入种子句子（靠主键 upsert，重复跑不会产生重复行）。
 * @returns 写入/更新的条数
 */
export async function seedArticles(): Promise<number> {
  const { db } = await import('./index')
  const { articles } = await import('./schema')

  for (const a of SEED_ARTICLES) {
    await db
      .insert(articles)
      .values(a)
      .onDuplicateKeyUpdate({ set: { contentJson: a.contentJson } })
  }
  return SEED_ARTICLES.length
}
