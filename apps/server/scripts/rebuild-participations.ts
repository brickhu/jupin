import { rebuildParticipations } from '../src/services/participations'

/**
 * 参与记录的重建 / 对账 —— 它是 submissions 的**派生索引**，
 * 所以必须能"整表重算一遍，结果一模一样"（这就是它的验收判据）。
 *
 *   pnpm db:participations           只看：把与 submissions 不一致的逐字段列出来
 *   pnpm db:participations --apply   写回：重算每个 (user, article)，并删掉孤儿行
 *
 * ⚠️ 什么时候要跑：
 *   · 迁移 0038 之后（那条迁移自己带了一次回填，这里是它的补刀与对账）；
 *   · 手工改过 submissions（脚本 / SQL / 清库）之后；
 *   · 怀疑榜单上的某个人对不上时 —— 先 --check 看一眼。
 *
 * ⚠️ 环境由 APP_ENV 决定（.env / .env.<mode>），与 apps/server 其它脚本一致：
 *   APP_ENV=prod pnpm db:participations --apply 才是动线上。
 */
const apply = process.argv.includes('--apply')

console.log(apply ? '⚠️ APPLY：会写回 participations 并删除孤儿行' : '（只看不改；加 --apply 才写回）')

const res = await rebuildParticipations({ check: !apply })

console.log('该有参与记录：' + res.computed + ' 条')
if (apply) console.log('已写回：' + res.rows + ' 条；删掉孤儿行：' + res.orphans + ' 条')
if (res.mismatches.length > 0) {
  console.log('')
  console.log('❌ 与 submissions 不一致 ' + res.mismatches.length + ' 处：')
  for (const m of res.mismatches.slice(0, 50)) {
    console.log(
      '   user=' + m.userId + ' article=' + m.articleId + '  ' + m.what +
      '  表里=' + JSON.stringify(m.actual) + '  应为=' + JSON.stringify(m.expected),
    )
  }
  if (res.mismatches.length > 50) console.log('   …还有 ' + (res.mismatches.length - 50) + ' 处')
  process.exit(1)
}
console.log('✅ 一致（重建前后没有差别）')
process.exit(0)
