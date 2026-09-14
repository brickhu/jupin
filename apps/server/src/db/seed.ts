import { db } from './index'
import { arenas } from './schema'

/**
 * 开发用种子数据。
 * ⚠️ 真实内容（短文/词级数据/技巧）走 CDN 静态资源，这里只放元数据。
 */
const SEED_ARENAS = [
  {
    id: 1, passageId: 1, position: 0,
    content: 'The only way to do great work is to love what you do.',
    stars: 1, wordCount: 13, expectedSpeechMs: 5200,
  },
  {
    id: 2, passageId: 1, position: 1,
    content: 'Stay hungry, stay foolish.',
    stars: 1, wordCount: 4, expectedSpeechMs: 1600,
  },
  {
    id: 3, passageId: 2, position: 0,
    content: 'In the middle of difficulty lies opportunity.',
    stars: 2, wordCount: 9, expectedSpeechMs: 3600,
  },
  {
    id: 4, passageId: 2, position: 1,
    content: 'Life is what happens when you are busy making other plans.',
    stars: 3, wordCount: 12, expectedSpeechMs: 4800,
  },
  {
    id: 5, passageId: 3, position: 0,
    // ⭐ 词汇简单但朗读极难 —— 必须存在这样一个样本，用于验证难度定级
    content: "The sixth sick sheikh's sixth sheep is sick.",
    stars: 5, wordCount: 8, expectedSpeechMs: 4000,
  },
]

async function main(): Promise<void> {
  console.log('写入种子竞技场…')
  for (const a of SEED_ARENAS) {
    await db.insert(arenas).values(a).onConflictDoUpdate({
      target: arenas.id,
      set: { content: a.content, stars: a.stars, expectedSpeechMs: a.expectedSpeechMs },
    })
  }
  console.log(`✅ 完成，共 ${SEED_ARENAS.length} 个竞技场`)
  process.exit(0)
}

void main()
