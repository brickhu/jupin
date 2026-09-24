/**
 * ⚠️ 这里曾经还有一份 './domain'（User / Submission / Article 三个「领域模型」）。
 *    删掉的原因不是嫌它多，是它**与现实不符**：
 *      · 三个类型**没有任何地方 import**；
 *      · Article 里列着早已没人写的 tipsJson，却少 theme / difficulty /
 *        isActive / createdAt / publishedAt 等列 —— 照它写代码会得到一个错的模型。
 *    表的真实形状只有一处权威定义：apps/server/src/db/schema.ts。
 */
export * from './api'
export * from './content'