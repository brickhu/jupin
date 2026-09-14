import { and, count, eq } from 'drizzle-orm'
import { db } from '../db'
import { arenaEntries, arenas } from '../db/schema'

/**
 * 征服 —— 在竞技场拿到 ≥ 85 分即征服，**永久保留、只增不减**。
 *
 * ⚠️ 用**绝对分**判定，不用排名判定。
 *    排名判定会因「竞技场人数少」或「对手太强」而失真；
 *    绝对分是同一把尺子，不受人数与人群水平影响。
 */

/** 各星级的已征服数量（用于「能力边界图」） */
export async function getConqueredByStars(
  userId: number,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ stars: arenas.stars, n: count() })
    .from(arenaEntries)
    .innerJoin(arenas, eq(arenas.id, arenaEntries.arenaId))
    .where(and(eq(arenaEntries.userId, userId), eq(arenaEntries.isConquered, true)))
    .groupBy(arenas.stars)

  const out: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
  for (const r of rows) out[String(r.stars)] = Number(r.n)
  return out
}

export async function getTotalConquered(userId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(arenaEntries)
    .where(and(eq(arenaEntries.userId, userId), eq(arenaEntries.isConquered, true)))
  return Number(row?.n ?? 0)
}
