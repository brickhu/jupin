import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * ⭐⭐ 数据所有权守门：每张表 / 每个业务列，运行时只能有**一个**「唯一写入方」。
 *
 * ⚠️⚠️ 为什么要立这道测试（而不是一处一处打补丁）：
 *     docs/domain-model.md 的「越界写入清单」一次审计就找出 16 处绕过唯一写入方、
 *     直写表的地方。如果每次发现一处就改一处，规矩只活在审计文档和人脑里 ——
 *     下一个人加接口时照样能绕过去，而**没有任何东西会报错**。
 *     这份文档本来就有先例：auth.test.ts 扫源码钉「每个 /api 前缀都挂了鉴权」、
 *     content-files.test.ts 扫正文钉字数口径。这里用同一种办法，把
 *     「谁只能写哪张表 / 哪个列」变成可执行的断言：
 *       · 所有权表 = 规矩（表/列 → 唯一允许写它的文件，注释指回 docs/domain-model.md）；
 *       · 扫描器   = 执法（源码里的 insert/update/delete 与 raw SQL，全部拿去查所有权表）；
 *       · 豁免清单 = 欠账（当前已知的越界，逐条登记 + 一句「为什么现在不改」）。
 *     新增越界在这里就会红；清理一处，只需要**删掉豁免清单里的一行**。
 *
 * ⚠️ 为什么豁免清单还要反过来断言「没有死条目」：
 *     死条目会让这张表慢慢失真 —— 代码早改走唯一入口了，豁免还在，
 *     于是下次真出现同文件同表的越界会被这条陈旧豁免**静默放行**。
 *     所以「豁免的 (文件, 表) 必须还能在源码里扫到」也是硬断言。
 *
 * ── 扫描范围（写死在这里，和审计口径一致）──
 *   · 硬拦：apps/server/src/**（运行时）、tools/**（admin 是运行时工具）
 *   · 登记但不硬拦：apps/server/scripts/**、tools/*.mjs
 *     （天然是一次性 / 运维入口；它们可以绕过所有权，但必须出现在豁免清单里，
 *      否则「永远看不见」）
 *   · 排除：apps/server/drizzle/**（迁移天然一次性，且要如实反映历史，不能改）、
 *     **\/*.test.ts（测试自己会造 SQL 字面量）、node_modules / dist / .git
 *
 * ⚠️ 为什么 raw SQL 只在 query( / execute( / sql\` 实参里找关键字：
 *     否则注释（如 \`// 旧实现 UPDATE users SET energy=9999\`）、
 *     console.log 里的清理提示（如 seed-dev-arena 的 'DELETE FROM ...'）
 *     都会被当成真的写入 —— 一条永远在红的假警报比没有警报更糟。
 *
 * ⚠️ 已知的表达力边界（不假装它能管）：
 *     判据是「文件」级别。同一个文件内部的第二次写入（审计 #4：admin 的 upsertArticle
 *     与 setPublishedBatch 各自写 is_active）这里看不见 —— 那属于文件内收敛，
 *     要靠 code review，不是所有权表能表达的。
 */

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')

/* ------------------------------------------------------------------ */
/* 所有权表：表 / 列 → 唯一允许写它的文件                                */
/* 口径见 docs/domain-model.md：总表（一）+ 越界清单（二）                */
/* ------------------------------------------------------------------ */

/** 文件路径都写成仓库相对路径（POSIX 分隔符），扫描结果里用的也是这个形状 */
const P = {
  energy: 'apps/server/src/services/energy.ts',
  participations: 'apps/server/src/services/participations.ts',
  streak: 'apps/server/src/services/streak.ts',
  articleIndex: 'apps/server/src/services/article-index.ts',
  standardAudio: 'apps/server/src/services/standard-audio.ts',
  articleContent: 'apps/server/src/services/article-content.ts',
  articleDelete: 'apps/server/src/services/article-delete.ts',
  scoring: 'apps/server/src/services/scoring.ts',
  submissionsRoute: 'apps/server/src/routes/submissions.ts',
  favorites: 'apps/server/src/services/favorites.ts',
  userService: 'apps/server/src/services/user.ts',
  userRoute: 'apps/server/src/routes/user.ts',
  authRoute: 'apps/server/src/routes/auth.ts',
  shopRoute: 'apps/server/src/routes/shop.ts',
  settle: 'apps/server/src/services/settle.ts',
  rewards: 'apps/server/src/services/rewards.ts',
  recommend: 'apps/server/src/services/recommend.ts',
  unfreeze: 'apps/server/src/services/unfreeze.ts',
  goods: 'apps/server/src/services/goods.ts',
  order: 'apps/server/src/services/order.ts',
  admin: 'tools/admin/server.ts',
} as const

interface TableRule {
  /** 唯一写入方（多个 = 该表按列/动作分工，见 note 与 COLUMN_OWNERS） */
  owners: string[]
  /** 为什么是它 —— 指到函数或 docs/domain-model.md 的小节 */
  note: string
}

const TABLE_OWNERS: Record<string, TableRule> = {
  // 能量：流水是真相，users.energy 只是缓存，两者必须**同事务**写（docs 1.11 / 越界 #1#2）
  energy_ledger: { owners: [P.energy], note: 'topUp / hold / release / addEnergy 全在 services/energy.ts' },
  // 战绩派生索引：一人一句一行，只能由同一份 computeParticipation 重算（docs 1.5）
  participations: {
    owners: [P.participations, P.articleDelete],
    note: 'syncParticipation / rebuildParticipations；article-delete 在删句子时清掉引用',
  },
  // 收藏：主键 (user_id, article_id)，两个方向都幂等（docs 1.9）
  favorites: {
    owners: [P.favorites, P.articleDelete],
    note: 'setFavorite；article-delete 在删句子时清掉引用',
  },
  // 每日排期：轮转与运营排期都走同一模块（docs 1.7 的两套之一）
  goods: { owners: [P.goods], note: 'services/goods.ts' },
  payments: { owners: [P.order], note: 'services/order.ts 下单 / 支付回调' },
  reward_rules: { owners: [P.rewards], note: 'services/rewards.ts' },
  // 奖励发放：幂等键 (reason, ref_type, ref_id, user_id) 就在这张表（docs 1.4）
  reward_grants: { owners: [P.rewards], note: 'grantReward' },
  // 解冻卡：一张卡一行，发放 / 领取 / 使用各有一个唯一函数（docs 1.10）
  unfreeze_cards: { owners: [P.unfreeze], note: 'grantUnfreezeCard / claimUnfreezeCards / useUnfreezeCards' },
  // 一次朗读 + 一次评测（同一行）：受理/可见性在路由，评测列在 scoring（docs 1.2 / 1.3）
  submissions: {
    owners: [P.scoring, P.submissionsRoute, P.articleDelete],
    note: '评测列 scoring.ts；受理 insert 与 is_public 在 routes/submissions.ts',
  },
  // users 是多概念共用一张表：身份/profile、连战、能量缓存、成长值、推荐窗口…
  // 默认按「表级」放行（细分列见 COLUMN_OWNERS）；表级这组就是这些概念的运行时写入方。
  users: {
    owners: [
      P.userService,
      P.userRoute,
      P.authRoute,
      P.shopRoute,
      P.energy,
      P.streak,
      P.settle,
      P.rewards,
      P.recommend,
      P.scoring,
    ],
    note: '按列分工，见 COLUMN_OWNERS；表级只兜底没登记的列',
  },
  // articles 的正文真相在 content/articles/*.json，这里只是可 SQL 筛选的索引。
  // difficulty/tags 与 standard_audio 各有一个唯一写入方（docs 1.1 / 1.8）。
  articles: {
    owners: [P.articleIndex, P.standardAudio, P.articleContent, P.articleDelete],
    note:
      'difficulty → article-index；standard_audio → standard-audio；' +
      '正文各列（text/translation/scores/challenge/advice/words/links/tags）→ article-content；' +
      '发布面（is_active 等）见 COLUMN_OWNERS；' +
      '**删除**（连同成绩/参与/收藏三张引用表）→ article-delete',
  },
}

/**
 * 列级所有权：表里不同概念共用一个表时，用它把「唯一写入方」钉到列上。
 * 键是**数据库列名**（不是 drizzle 的属性名），扫描器会把属性名翻成列名再比。
 * 没有登记的列回退到 TABLE_OWNERS。
 */
const COLUMN_OWNERS: Record<string, Record<string, string[]>> = {
  users: {
    // 能量（docs 1.11）
    energy: [P.energy],
    energy_date: [P.energy],
    // 连战（docs 1.10）—— 规则是 shared/streak.ts 的纯函数，服务层只做「读→算→写」
    streak_days: [P.streak],
    streak_best: [P.streak],
    last_read_date: [P.streak],
    // 身份（docs：建号 = 打开即登录）
    openid: [P.userService],
    // 登录态：只有两处换 code 时顺手落库（routes/auth.ts 的 login/session 与 routes/shop.ts 下单前刷新）
    session_key: [P.authRoute, P.shopRoute],
    session_key_at: [P.authRoute, P.shopRoute],
    // 成长值累计：结算唯一入口 settle（docs 1.4）
    growth_self: [P.settle],
    growth_diligence: [P.settle],
    growth_standout: [P.settle],
    // 发卡记账位：grantReward 成功后由 rewards 推进（docs 1.4 / 1.10）
    unfreeze_marker_streak: [P.rewards],
    // 今日推荐 24 小时窗口：recommendToday 落库（docs 1.7）
    today_article_id: [P.recommend],
    today_assigned_at: [P.recommend],
    // 无效提交计数（防刷）
    invalid_count: [P.scoring],
    invalid_date: [P.scoring],
    // profile 编辑（PUT /api/user/profile）
    nickname: [P.userRoute],
    avatar_url: [P.userRoute],
    gender: [P.userRoute],
    age: [P.userRoute],
    bio: [P.userRoute],
  },
  articles: {
    // 难度派生列：schema 注释要求「只由 syncArticleIndex 物化」（docs 1.8）
    difficulty: [P.articleIndex],
    // 标准音是否「分发得出去」：standard-audio 上传成功后写（docs 1.1）
    standard_audio: [P.standardAudio],
    /**
     * ⚠️ 发布面（上线状态 / 发布时间 / 主题）。
     *
     * 原来这里指向 `tools/admin/server.ts`（本地管理台**直连库**写这三列）。
     * 2026-09 改为：管理台**不再连库**，它调服务端的 `/api/admin/*`，
     * 由 `services/article-content.ts` 承担这次写入 ⇒ 所有者跟着搬到服务里。
     * 这条改动本身也是"写入只剩一条路"的一部分：以前是两份逻辑（管理台 + 服务端），
     * 全靠这两处各自记得"发布时间只在草稿→上线那一刻写"。
     */
    is_active: [P.articleContent],
    published_at: [P.articleContent],
    theme: [P.articleContent],
  },
  submissions: {
    // 结算快照列由 settle 写（与评测列同表，但概念不同，docs 1.4）
    growth_self: [P.settle],
    growth_diligence: [P.settle],
    growth_standout: [P.settle],
    growth_meta: [P.settle],
    streak_delta: [P.settle],
  },
}

/* ------------------------------------------------------------------ */
/* 豁免清单：当前已知的越界写入，逐条登记                                 */
/*   audit 指回 docs/domain-model.md 第二节的编号；「审计外」= 本次扫描新发现 */
/*   dead-entry 断言要求每条 (file, table) 现在都还能扫到，否则测试红       */
/* ------------------------------------------------------------------ */

interface Exemption {
  audit: string
  file: string
  /** 这条豁免覆盖该文件写到的哪些表；每张表都必须仍能扫到，否则视为死条目 */
  tables: string[]
  why: string
}

const EXEMPTIONS: Exemption[] = [
  /**
   * ⚠️⚠️ 这里**曾经有一条豁免**：`tools/admin/server.ts` 整行写 `articles`
   *    （它的 upsertArticle 自己拼 difficulty / standard_audio 一起写）。
   *    2026-09 删除：管理台改成**全程走 HTTP**（`/api/admin/*`），
   *    写入统一由服务端的 `services/article-content.ts` 负责 ⇒ 豁免不再需要。
   *    那条豁免本身就是「两套写入逻辑」的证据 —— 它消失，说明那件事做完了。
   */
  {
    audit: '审计外',
    file: 'apps/server/scripts/import-content-files.ts',
    tables: ['articles'],
    why:
      '把正文从 content/articles/*.json 一次性搬进 articles.content（2026-09 内容改为以库为真相）。' +
      '它是**迁移工具**：只在"首次部署 / 换环境 / 从备份恢复"时跑一次，且默认只填 content IS NULL 的行；' +
      '交给发布服务层反而要求那个服务先能读文件，等于把要删掉的那条依赖留在原地。',
  },
  {
    audit: '#5 / #6',
    file: 'apps/server/src/db/seed-articles.ts',
    tables: ['articles'],
    why: '灌库（部署入口）把「文件存在」等同于「已上线」，直插 is_active/published_at/theme，并在 STORAGE=local 时直改 standard_audio；一次性部署动作，改走发布服务会把启动期依赖搞复杂。',
  },
  {
    audit: '#8 / #16',
    file: 'tools/backfill-article-theme.ts',
    tables: ['articles', 'submissions'],
    why:
      '一次性把旧内容 id 改写成 hash：articles.id 与 submissions 的引用必须一起改，' +
      '跑完即弃（schedules / article_tags 两张表 2026-09 已删除，这一步随之去掉）。' +
      'submissions.theme 只有这一处写。',
  },
  {
    audit: '#9',
    file: 'tools/rename-content-to-hash.mjs',
    tables: ['articles'],
    why: '一次性改名脚本，raw UPDATE articles.standard_audio；文件名改完就没用了。',
  },
    {
      audit: '#10',
      file: 'tools/fix-article-ids.mjs',
      tables: ['articles'],
      why:
        '一次性/运维入口：把**非哈希的句子 id** 改写成 sha256(正文) 前 16 位' +
        '（服务端 2026-09 之前不校验 id 时期留下的行，例如 zzdev653288）。' +
        '默认只看不改、只连 local；外键已去掉，所以改 id 不必联动别的表。',
    },
    {
      audit: '#10',
      file: 'tools/e2e-submission.mjs',
      /**
       * ⚠️ 一个 (文件, 表) 一条。它既要造用户与提交，也要：
       *    · **直接插一条悬空行**来测"进程崩了之后清扫会不会整行删掉"（那条路没法从接口造）；
       *    · 跑完**把自己造的用户整个删掉**（按外键顺序，含出分发的奖励）。
       */
      tables: ['users', 'submissions', 'participations', 'energy_ledger', 'reward_grants'],
      why:
        '端到端业务流测试：对着真实服务跑一遍「上传→受理→检测→落库→历史卡」，' +
        '它要自己造一个测试用户并给能量（raw 写 users）—— 跑完把能量清零，' +
        '不依赖服务端任何测试后门。',
    },
    {
      audit: '#10',
      file: 'tools/e2e-concurrent.mjs',
      // ⚠️ 它造用户 + 造提交（并发），跑完按外键顺序把所有指向 users 的表都清掉
      /**
       * ⚠️ 只登记它**真的会写**的那几张 —— 多写一张就要多一条豁免，
       *    而守门会校验"豁免的表在 schema 里有 owner"（`likes`/`subscriptions` 没有 ⇒ 会崩）。
       */
      tables: [
        'users',
        'submissions',
        'participations',
        'energy_ledger',
        'reward_grants',
      ],
      why:
        '并发撞号测试：同时提交 N 次，验证服务端不崩（撞唯一键不能让异常逃逸）' +
        '且序号恰好 1..N。它自建用户、造提交，跑完按外键顺序清理（含出分发的奖励）。',
    },
  {
    audit: '#10',
    file: 'tools/dev-unlock.mjs',
    tables: ['users'],
    why: '本机联调开会员，只连本地 docker 容器；会员概念已被能量取代，脚本留着是为了旧数据，等清掉 member_until 后整个删。',
  },
  {
    audit: '#11',
    file: 'apps/server/scripts/wipe-history.ts',
    tables: [
      'participations',
      'likes',
      'reviews',
      'submissions',
      'unfreeze_cards',
      'reward_grants',
      'energy_ledger',
      'users',
    ],
    why: '清库运维脚本本体（AGENT.md 点名的事故脚本），有探针账号与 --confirm 保护；它天然要跨所有唯一写入方清数据。',
  },
  {
    audit: '#12',
    file: P.unfreeze,
    tables: ['users'],
    why: '补签要把 last_read_date 推到「昨天」，必须和消耗解冻卡同事务；走 services/streak.ts 会再开一次写、重复读状态。',
  },
  {
    audit: '#13',
    file: 'apps/server/src/db/seed-dev-arena.ts',
    tables: ['users', 'unfreeze_cards', 'submissions'],
    why: 'dev 假数据要造「已结算过」的形状（直写 streak / 直插 scored 行 / 直发卡），绕开 settle+grantReward；只在本地跑，且末尾已补 rebuildParticipations。',
  },
  {
    audit: '#14',
    file: 'apps/server/scripts/settle-smoke.ts',
    tables: ['energy_ledger', 'reward_grants', 'unfreeze_cards', 'submissions', 'users'],
    why: '结算冒烟：自建探针账号、自清自己造的行（AGENT.md 要求「只删自己造的」）；必须要能直插 scored 行。',
  },
  {
    audit: '#14',
    file: 'apps/server/scripts/streak-record-smoke.ts',
    tables: ['unfreeze_cards', 'submissions', 'users'],
    why: '连战日历冒烟：同上，自建自清探针账号，直接摆出历史连战数据。',
  },
]

/* ------------------------------------------------------------------ */
/* 扫描器：源码里的 DB 写操作 → (文件, 行, 表, 列)                        */
/* ------------------------------------------------------------------ */

const schemaSrc = readFileSync(join(ROOT, 'apps/server/src/db/schema.ts'), 'utf8')

/** drizzle 的变量名（energyLedger）→ 真表名（energy_ledger） */
const identToTable = new Map<string, string>()
/** 表名 → { drizzle 属性名: 数据库列名 } */
const propToColumn = new Map<string, Map<string, string>>()
/** 表名 → 数据库列名集合（用来验所有权表的列名没写错） */
const columnsOfTable = new Map<string, Set<string>>()

function braceBlock(src: string, start: number): string {
  let depth = 0
  let i = start
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return src.slice(start, i + 1)
}

for (const m of schemaSrc.matchAll(
  /export const ([A-Za-z_][A-Za-z0-9_]*)\s*=\s*mysqlTable\(\s*'([a-z_]+)'\s*,\s*\{/g,
)) {
  const ident = m[1]
  const table = m[2]
  if (!ident || !table) continue
  identToTable.set(ident, table)
  const body = braceBlock(schemaSrc, schemaSrc.indexOf('{', m.index + m[0].length - 1))
  const props = new Map<string, string>()
  const cols = new Set<string>()
  for (const c of body.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*[a-zA-Z]+\(\s*'([a-z_]+)'/g)) {
    const prop = c[1]
    const col = c[2]
    if (!prop || !col) continue
    props.set(prop, col)
    cols.add(col)
  }
  propToColumn.set(table, props)
  columnsOfTable.set(table, cols)
}

interface WriteHit {
  file: string
  line: number
  table: string
  /** 写到的数据库列；null = 解析不出（如 values(变量)） */
  columns: string[] | null
  kind: string
}

const lineOf = (src: string, index: number): number => src.slice(0, index).split('\n').length

/** 跳过一段字符串字面量（单/双/模板），返回结束后的下标 */
function skipString(src: string, start: number): number {
  const quote = src[start]
  let i = start + 1
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2
      continue
    }
    if (src[i] === quote) return i + 1
    i++
  }
  return i
}

/** 解析对象字面量的顶层键（跳过值；含展开、简写、注释、嵌套对象/数组/调用） */
function objectKeys(src: string, open: number): string[] {
  const keys: string[] = []
  let i = open + 1
  let depth = 1
  let nest = 0
  let expectKey = true
  while (i < src.length && depth > 0) {
    const ch = src[i]
    if (ch === undefined) break
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      const n = src.indexOf('\n', i)
      i = n < 0 ? src.length : n + 1
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const n = src.indexOf('*/', i)
      i = n < 0 ? src.length : n + 2
      continue
    }
    if (ch === '"' || ch === "'" || ch === '\`') {
      i = skipString(src, i)
      expectKey = false
      continue
    }
    if (ch === '{') {
      depth++
      i++
      continue
    }
    if (ch === '}') {
      depth--
      i++
      if (depth === 0) break
      continue
    }
    if (ch === '(' || ch === '[') {
      nest++
      i++
      continue
    }
    if (ch === ')' || ch === ']') {
      nest--
      i++
      continue
    }
    if (depth === 1 && nest === 0 && ch === ',') {
      expectKey = true
      i++
      continue
    }
    if (depth === 1 && nest === 0 && expectKey) {
      if (src.startsWith('...', i)) {
        expectKey = false
        i += 3
        continue
      }
      const kv = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(src.slice(i))
      if (kv?.[1]) {
        keys.push(kv[1])
        i += kv[0].length
        expectKey = false
        continue
      }
      const shorthand = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=[,}])/.exec(src.slice(i))
      if (shorthand?.[1]) {
        keys.push(shorthand[1])
        i += shorthand[1].length
        expectKey = true
        continue
      }
      expectKey = false
      i++
      continue
    }
    i++
  }
  return keys
}

/** values(变量) / set(变量) 时，回找该变量的对象字面量（如 admin 的 const row = {...}） */
function resolveIdent(src: string, ident: string, before: number): string[] | null {
  const rx = new RegExp('const\\s+' + ident + '\\s*=\\s*\\{', 'g')
  let last: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = rx.exec(src)) !== null) {
    if (m.index > before) break
    last = m
  }
  if (!last) return null
  const open = src.indexOf('{', last.index)
  return open < 0 ? null : objectKeys(src, open)
}

function scanDrizzle(file: string, src: string): WriteHit[] {
  const hits: WriteHit[] = []
  for (const m of src.matchAll(/\.(insert|update|delete)\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g)) {
    const method = m[1]
    const ident = m[2]
    if (!method || !ident) continue
    const table = identToTable.get(ident)
    if (!table) continue // 不是 drizzle 表（如 createHash().update(text)）
    let columns: string[] | null = null
    if (method !== 'delete') {
      const after = src.slice(m.index + m[0].length)
      const setter = method === 'insert' ? /\.values\(/.exec(after) : /\.set\(/.exec(after)
      if (setter) {
        let j = m.index + m[0].length + setter.index + setter[0].length
        while (/\s/.test(src[j] ?? '')) j++
        if (src[j] === '{') columns = objectKeys(src, j)
        else {
          const im = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(j))
          if (im?.[1]) columns = resolveIdent(src, im[1], m.index)
        }
      }
    }
    const props = propToColumn.get(table)
    hits.push({
      file,
      line: lineOf(src, m.index),
      table,
      columns: columns === null ? null : columns.map((c) => props?.get(c) ?? c),
      kind: 'drizzle.' + method,
    })
  }
  return hits
}

function scanRaw(file: string, src: string): WriteHit[] {
  const hits: WriteHit[] = []
  // 只看 query( / execute( / sql\` 的实参 —— 注释与日志字符串里的 SQL 不算写入
  for (const call of src.matchAll(/(?:query|execute|sql)\s*(?:\(|\`)/g)) {
    const start = call.index + call[0].length
    let end: number
    if (call[0].endsWith('\`')) {
      const close = src.indexOf('\`', start)
      end = close < 0 ? src.length : close
    } else {
      let depth = 1
      let i = start
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === '(') depth++
        else if (src[i] === ')') depth--
      }
      end = i
    }
    const text = src.slice(start, end)
    const keywords: RegExp[] = [
      /INSERT\s+INTO\s+([a-z_][a-z0-9_]*)/gi,
      /UPDATE\s+([a-z_][a-z0-9_]*)/gi,
      /DELETE\s+FROM\s+([a-z_][a-z0-9_]*)/gi,
    ]
    for (const kw of keywords) {
      for (const m of text.matchAll(kw)) {
        const table = m[1]
        if (!table) continue
        let columns: string[] | null = null
        if (/^UPDATE/i.test(m[0])) {
          const setAt = text.toLowerCase().indexOf('set', m.index + m[0].length)
          if (setAt >= 0) {
            let clause = text.slice(setAt + 3)
            const where = clause.search(/\bwhere\b/i)
            if (where >= 0) clause = clause.slice(0, where)
            columns = [...new Set([...clause.matchAll(/([a-z_][a-z0-9_]*)\s*=/gi)].map((x) => x[1] ?? ''))]
          }
        } else if (/^INSERT/i.test(m[0])) {
          const paren = /^\s*\(([^)]*)\)/.exec(text.slice(m.index + m[0].length))
          if (paren?.[1]) {
            columns = paren[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
          }
        } else {
          columns = [] // DELETE：整行，没有列
        }
        hits.push({ file, line: lineOf(src, start + m.index), table, columns, kind: 'raw' })
      }
    }
  }
  return hits
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'drizzle'])
const SOURCE_EXT = /\.(ts|mts|mjs|js)$/

function walk(dir: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(p, out)
    } else if (SOURCE_EXT.test(e.name) && !/\.test\.ts$/.test(e.name)) {
      out.push(p)
    }
  }
}

function scanScopeOf(rel: string): 'hard' | 'soft' {
  if (rel.startsWith('apps/server/scripts/')) return 'soft'
  if (/^tools\/[^/]+\.mjs$/.test(rel)) return 'soft'
  return 'hard'
}

const sourceFiles: string[] = []
for (const root of ['apps/server/src', 'tools', 'apps/server/scripts']) walk(join(ROOT, root), sourceFiles)

const allHits: WriteHit[] = []
for (const abs of sourceFiles) {
  const rel = relative(ROOT, abs).split(sep).join('/')
  const src = readFileSync(abs, 'utf8')
  allHits.push(...scanDrizzle(rel, src), ...scanRaw(rel, src))
}

interface Violation extends WriteHit {
  scope: 'hard' | 'soft'
  /** 违规命中的列（没有列概念时为 undefined） */
  column: string | undefined
  /** 该表/该列的所有者；null = 还没登记所有权规则 */
  owners: string[] | null
}

const violations: Violation[] = []
for (const hit of allHits) {
  const rule = TABLE_OWNERS[hit.table]
  const colRule = COLUMN_OWNERS[hit.table]
  const tableOwners = rule?.owners
  let column: string | undefined
  let owners: string[] | null

  if (hit.columns === null || hit.columns.length === 0) {
    // 列未知 / DELETE 整行：只能按表判
    if (!tableOwners) owners = null
    else if (tableOwners.includes(hit.file)) continue
    else owners = tableOwners
  } else if (colRule) {
    // 列级规则优先：先找「有明确列所有者但不含本文件」的列（报错更精确），
    // 再找「没有列所有者、表级也不含本文件」的列
    const explicit = hit.columns.find((c) => colRule[c] && !colRule[c]?.includes(hit.file))
    const fallback = hit.columns.find((c) => !colRule[c] && tableOwners && !tableOwners.includes(hit.file))
    const unregistered = hit.columns.find((c) => !colRule[c] && !tableOwners)
    if (explicit) {
      column = explicit
      owners = colRule[explicit] ?? null
    } else if (fallback) {
      column = fallback
      owners = tableOwners ?? null
    } else if (unregistered) {
      column = unregistered
      owners = null
    } else continue
  } else {
    if (!tableOwners) owners = null
    else if (tableOwners.includes(hit.file)) continue
    else owners = tableOwners
  }

  violations.push({
    ...hit,
    scope: scanScopeOf(hit.file),
    column,
    owners,
  })
}

const pairKey = (file: string, table: string): string => file + '|' + table
const livePairs = new Set(violations.map((v) => pairKey(v.file, v.table)))
const exemptPairs = new Map<string, Exemption>()
for (const e of EXEMPTIONS) {
  for (const t of e.tables) exemptPairs.set(pairKey(e.file, t), e)
}

function describeViolation(v: Violation): string {
  const owner = v.owners && v.owners.length > 0 ? v.owners.join('、') : '（该表/列还没有登记所有权规则）'
  const cols = v.columns && v.columns.length > 0 ? '，涉及列：' + v.columns.join(', ') : ''
  const at = v.column ? v.table + '.' + v.column : v.table
  return (
    v.file + ':' + v.line + ' 写了 ' + at + '（' + v.kind + cols + '）——所有者应为 ' + owner + '。\n' +
    '    怎么改：改走上面的唯一写入方入口；若确属一次性/运维/dev 路径，在 domain-write-guard.test.ts 的 EXEMPTIONS 里登记 file+table+原因。'
  )
}

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

describe('数据所有权守门 —— 唯一写入方', () => {
  /**
   * ⚠️ 先保扫描器还活着：正则一旦失配，下面几条会变成空转的绿灯。
   *    这里钉「扫到的写入数量」和「覆盖到的表数量」。
   */
  it('扫描器扫到了足够多的写入（别让正则悄悄失配）', () => {
    expect(allHits.length, '扫描到的 DB 写操作太少，正则可能失配了').toBeGreaterThan(40)
    const tables = new Set(allHits.map((h) => h.table))
    expect(tables.size, '覆盖到的表太少').toBeGreaterThan(8)
  })

  /** 所有权表本身别写错：文件在、表在、列在 schema 里 */
  it('所有权表自检：所有者文件存在、表和列都能在 schema 里指出来', () => {
    for (const e of EXEMPTIONS) {
      expect(existsSync(join(ROOT, e.file)), '豁免清单里的文件不存在：' + e.file).toBe(true)
      expect(e.why.trim().length, e.file + ' 的豁免没写原因').toBeGreaterThan(0)
    }
    for (const [table, rule] of Object.entries(TABLE_OWNERS)) {
      expect(identToTable.size, '没解析出任何表').toBeGreaterThan(0)
      expect(columnsOfTable.has(table), '所有权表里的表在 schema 里不存在：' + table).toBe(true)
      expect(rule.owners.length, table + ' 没有登记所有者').toBeGreaterThan(0)
      for (const owner of rule.owners) {
        expect(existsSync(join(ROOT, owner)), table + ' 的所有者文件不存在：' + owner).toBe(true)
      }
    }
    for (const [table, cols] of Object.entries(COLUMN_OWNERS)) {
      const schemaCols = columnsOfTable.get(table)
      expect(schemaCols, '列级所有权里的表在 schema 里不存在：' + table).toBeTruthy()
      for (const [col, owners] of Object.entries(cols)) {
        expect(schemaCols?.has(col), table + ' 的列级所有权列名写错：' + col).toBe(true)
        expect(owners.length, table + '.' + col + ' 没有登记所有者').toBeGreaterThan(0)
        for (const owner of owners) {
          expect(existsSync(join(ROOT, owner)), table + '.' + col + ' 的所有者文件不存在：' + owner).toBe(true)
        }
      }
    }
  })

  /**
   * ⭐ 硬拦：apps/server/src 与 tools/**（admin）里的越界写入。
   *    要么改走唯一写入方，要么在 EXEMPTIONS 里登记。
   */
  it('⭐ 运行时越界写入 —— 必须改走唯一写入方，或在豁免清单里显式登记', () => {
    const unregistered = violations.filter((v) => v.scope === 'hard' && !exemptPairs.has(pairKey(v.file, v.table)))
    const message = ['发现 ' + unregistered.length + ' 处未登记的运行时越界写入：', ...unregistered.map(describeViolation)].join('\n')
    expect(unregistered, message).toEqual([])
  })

  /**
   * ⚠️ 登记但不硬拦：apps/server/scripts/** 与 tools/*.mjs 天然是一次性/运维入口，
   *    允许绕过所有权，但**必须登记**（否则永远看不见）。
   */
  it('⚠️ 一次性/运维入口的写入 —— 可以绕过所有权，但必须登记', () => {
    const unregistered = violations.filter((v) => v.scope === 'soft' && !exemptPairs.has(pairKey(v.file, v.table)))
    const message = [
      '发现 ' + unregistered.length + ' 处未登记的一次性/运维写入（不必改代码，登记即可）：',
      ...unregistered.map(describeViolation),
    ].join('\n')
    expect(unregistered, message).toEqual([])
  })

  /**
   * ⭐⭐ 反向锁：豁免清单里没有死条目。
   *    代码早改走唯一入口了、豁免还在 —— 这会让下次同文件同表的越界被静默放行。
   *    清理一处 = 删掉这里的一行。
   */
  it('⭐ 豁免清单里没有一条已经不存在（死条目），每条 (文件, 表) 现在都还能扫到', () => {
    const dead: string[] = []
    for (const e of EXEMPTIONS) {
      for (const t of e.tables) {
        if (!livePairs.has(pairKey(e.file, t))) dead.push(e.file + ' → ' + t + '（审计 ' + e.audit + '）')
      }
    }
    const message = [
      '以下豁免已经失效（对应写入没了 / 已改走所有者）：请删掉 EXEMPTIONS 里的这些行，',
      '并同步 docs/domain-model.md 的越界清单：',
      ...dead,
    ].join('\n')
    expect(dead, message).toEqual([])
  })

  /**
   * ⚠️ 防「大豁免」：一条豁免只覆盖它声明的表；同一个文件写别的表不会被顺带放行。
   *    这条同时把软/硬两种入口分开统计，方便报告。
   */
  it('豁免粒度：每个 (文件, 表) 各自登记，不允许按文件一揽子放行', () => {
    const declared = new Set<string>()
    for (const e of EXEMPTIONS) {
      for (const t of e.tables) {
        const key = pairKey(e.file, t)
        expect(declared.has(key), '重复登记的豁免：' + key).toBe(false)
        declared.add(key)
      }
    }
    const hard = violations.filter((v) => v.scope === 'hard').length
    const soft = violations.filter((v) => v.scope === 'soft').length
    // 只是把最终数字留在测试输出里，供人核对（断言保证两边一致）
    expect(hard + soft, '违规总数与逐条报告不一致').toBe(violations.length)
    console.log(
      '[domain-write-guard] 违规 ' + violations.length + ' 处（硬拦 ' + hard + ' / 登记 ' + soft + '），' +
        '涉及 ' + livePairs.size + ' 个 (文件, 表)，豁免 ' + EXEMPTIONS.length + ' 条。',
    )
  })
})
