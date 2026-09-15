import { db } from './index'
import { articles } from './schema'

/**
 * 开发用种子数据。
 *
 * ⚠️ articles 只是**索引**：正文在 contentJson 指向的静态 JSON 里。
 *    这里 contentJson 用相对路径占位 —— 内容流水线（tools/pipeline）建好后，
 *    会生成真正的 JSON 并把它放到 CDN，再把 URL 写回这里。
 */
const SEED_ARTICLES = [
  { id: 1, contentJson: '/content/articles/1.json', difficulty: 1, category: 'quote' },
  { id: 2, contentJson: '/content/articles/2.json', difficulty: 1, category: 'quote' },
  { id: 3, contentJson: '/content/articles/3.json', difficulty: 2, category: 'quote' },
  { id: 4, contentJson: '/content/articles/4.json', difficulty: 3, category: 'quote' },
  {
    id: 5,
    // ⭐ 词汇简单但朗读极难 —— 必须存在这样一个样本，用于验证难度定级
    contentJson: '/content/articles/5.json',
    difficulty: 5,
    category: 'tongue_twister',
  },
]

async function main(): Promise<void> {
  console.log('写入种子文章…')
  for (const a of SEED_ARTICLES) {
    await db.insert(articles).values(a).onDuplicateKeyUpdate({
      set: { contentJson: a.contentJson, difficulty: a.difficulty, category: a.category },
    })
  }
  console.log(`✅ 完成，共 ${SEED_ARTICLES.length} 篇`)
  process.exit(0)
}

void main()
