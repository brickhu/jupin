import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ENERGY_PACKS, ENERGY_PER_CHALLENGE, PAY_MIN_PRICE_FEN } from '../packages/shared/src/constants/index.ts'
import { loadEnv } from './env.mjs'

/**
 * ⭐ 生成虚拟支付「道具批量导入」模板（道具管理 → 批量添加）。
 *
 *   node_modules/.bin/tsx tools/make-goods-template.ts
 *
 * ⚠️⚠️ 为什么要有这个工具，而不是手填一个 xlsx：
 *    1. 道具价格、名称、ID 必须和代码里的 ENERGY_PACKS **逐字对上** ——
 *       对不上的后果是支付时报 -15013（道具价格错误），而那个报错离原因很远
 *    2. 价格会变、以后还要加解冻卡 ⇒ 手填的模板改一次就多一份不知道对不对的副本
 *    3. 它顺便校验三条官方限制（ID ≤32 英文字符 / 名称 ≤10 字 / 备注 ≤50 字）
 *
 * ⚠️⚠️ 官方模板里的「道具价格」写的是「**需为整数**，不超过 10000 元」——
 *    而道具价格是安卓 / iOS **双端通用**的唯一价格，我们这边改一个小数就对不上（报 -15013）。
 *    ⇒ 我们的三档一律按**整元**定（1 / 20 / 180），这个工具把它写死成不变量：
 *      · 全是整元 ⇒ 产出一个文件（正常情况）
 *      · 有档位不是整元 ⇒ 仍然产出两个版本并**警告要改哪几个数**（留给将来真需要小数时）
 */

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const TEMPLATE_URL =
  'https://res.wx.qq.com/op_res/WL4AnS7O0RpEJNI6PAI0i_lE5XkTaVl7eietFZuLjkQEOgj_XGEOyrbjiXsr2oegDlqQQ7HVV6YcE5Ne3ZW4hA'
const CACHE = resolve(ROOT, '.uploads/import-template/goods-template.xlsx')
const WORK = resolve(ROOT, '.uploads/import-template/work')
const OUT_DIR = resolve(ROOT, 'docs/design/assets')

/** XML 文本转义 —— 道具名/备注里出现 & < > 会把 xlsx 写坏 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** ⭐ 道具 id：① 官方限制 ≤32 位英文字符 —— 所以拿商品码去掉下划线，纯字母数字最保险 */
function productIdOf(code: string): string {
  return code.replace(/_/g, '')
}

interface Row { id: string; name: string; image: string; price: string; note: string }

/** 把 ENERGY_PACKS 映射成模板的五行 */
function buildRows(priceMode: 'decimal' | 'integer'): Row[] {
  return ENERGY_PACKS.map((g) => {
    const yuan = g.priceFen / 100
    const price = priceMode === 'integer' ? String(Math.round(yuan)) : String(yuan)
    return {
      id: productIdOf(g.code),
      /** ⚠️ 官方限制：名称不超过 10 个字 */
      name: g.amount + '点能量',
      /** 图片非必填（模板里只有 id / 名称 / 价格 标了必填） */
      image: '',
      price,
      /** 备注不对外展示 —— 用它记回商品码，将来对账时能一眼对上 */
      note: 'goods.code=' + g.code + '；' + g.amount + '点=' + g.amount / ENERGY_PER_CHALLENGE + '次挑战',
    }
  })
}

/** 官方三条限制（超了导入会被驳回，而且报错不会指出是哪一格） */
function validate(rows: Row[]): string[] {
  const problems: string[] = []
  for (const r of rows) {
    if (!/^[A-Za-z0-9]{1,32}$/.test(r.id)) problems.push(r.id + '：道具 id 必须是 1–32 位英文字符')
    if ([...r.name].length > 10) problems.push(r.id + '：名称超过 10 个字（' + r.name + '）')
    const n = Number(r.price)
    if (!Number.isFinite(n) || n <= 0 || n > 10000) problems.push(r.id + '：价格必须是 0–10000 的数字')
    if ([...r.note].length > 50) problems.push(r.id + '：备注超过 50 个字')
  }
  return problems
}

async function ensureTemplate(): Promise<void> {
  if (existsSync(CACHE)) return
  mkdirSync(resolve(ROOT, '.uploads/import-template'), { recursive: true })
  console.log('· 下载官方模板…')
  const res = await fetch(TEMPLATE_URL)
  if (!res.ok) throw new Error('下载模板失败：HTTP ' + res.status)
  writeFileSync(CACHE, Buffer.from(await res.arrayBuffer()))
}

/** 造一个 xlsx：沿用官方模板的骨架（列宽、样式、页面设置），只替换单元格 */
function writeXlsx(rows: Row[], outPath: string): void {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  execFileSync('unzip', ['-o', '-q', CACHE, '-d', WORK])

  const HEADERS = ['道具id', '道具名称', '道具图片', '道具价格', '备注']
  const strings: string[] = [...HEADERS]
  for (const r of rows) strings.push(r.id, r.name, r.image, r.price, r.note)

  const sst =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' +
    strings.length + '" uniqueCount="' + strings.length + '">' +
    strings.map((s) => '<si><t>' + esc(s) + '</t></si>').join('') +
    '</sst>'
  writeFileSync(resolve(WORK, 'xl/sharedStrings.xml'), sst, 'utf8')

  const cell = (col: string, rowNo: number, idx: number) =>
    '<c r="' + col + rowNo + '" t="s"><v>' + idx + '</v></c>'
  const headerRow =
    '<row r="1" spans="1:5" x14ac:dyDescent="0.35">' +
    ['A', 'B', 'C', 'D', 'E'].map((c, i) => cell(c, 1, i)).join('') +
    '</row>'
  const dataRows = rows
    .map((_, ri) => {
      const rowNo = ri + 2
      const base = HEADERS.length + ri * 5
      return (
        '<row r="' + rowNo + '" spans="1:5" x14ac:dyDescent="0.35">' +
        ['A', 'B', 'C', 'D', 'E'].map((c, i) => cell(c, rowNo, base + i)).join('') +
        '</row>'
      )
    })
    .join('')

  /** ⚠️ 骨架（sheetViews / cols / pageMargins）照抄官方模板，只换 dimension 与 sheetData；
   *    hyperlinks 去掉 —— 那是官方例子给图片格挂的外链，我们没有图 */
  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac xr xr2 xr3" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" xmlns:xr2="http://schemas.microsoft.com/office/spreadsheetml/2015/revision2" xmlns:xr3="http://schemas.microsoft.com/office/spreadsheetml/2016/revision3">' +
    '<dimension ref="A1:E' + (rows.length + 1) + '"/>' +
    '<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>' +
    '<sheetFormatPr defaultColWidth="11" defaultRowHeight="15.5" x14ac:dyDescent="0.35"/>' +
    '<cols>' +
    '<col min="1" max="1" width="29.4609375" customWidth="1"/>' +
    '<col min="2" max="2" width="28.4609375" customWidth="1"/>' +
    '<col min="3" max="3" width="27.4609375" customWidth="1"/>' +
    '<col min="4" max="4" width="27" customWidth="1"/>' +
    '<col min="5" max="5" width="25.69140625" customWidth="1"/>' +
    '</cols>' +
    '<sheetData>' + headerRow + dataRows + '</sheetData>' +
    '<phoneticPr fontId="2" type="noConversion"/>' +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    '</worksheet>'
  writeFileSync(resolve(WORK, 'xl/worksheets/sheet1.xml'), sheet, 'utf8')

  rmSync(outPath, { force: true })
  /** ⚠️ [Content_Types].xml 必须排在最前（部分解析器按顺序读） */
  execFileSync('zip', ['-X', '-q', outPath, '[Content_Types].xml'], { cwd: WORK })
  execFileSync('zip', ['-X', '-q', '-r', outPath, '_rels', 'docProps', 'xl'], { cwd: WORK })
}

async function main(): Promise<void> {
  /** ⚠️ 要读 .env 才能核对道具 ID（根 .env 里那份，与 target 无关） */
  loadEnv('local')
  await ensureTemplate()
  mkdirSync(OUT_DIR, { recursive: true })

  /** ⭐ 全整元 = 正常情况（与微信侧的「需为整数」天然一致）⇒ 只产出一个文件 */
  const allInteger = ENERGY_PACKS.every((g) => g.priceFen % 100 === 0)
  const modes = allInteger ? (['integer'] as const) : (['decimal', 'integer'] as const)

  for (const mode of modes) {
    const rows = buildRows(mode)
    const problems = validate(rows)
    const label = mode === 'integer' ? '整数元' : '小数元'
    const out = resolve(
      OUT_DIR,
      allInteger ? 'jupin-道具批量导入.xlsx' : 'jupin-道具批量导入-' + label + '.xlsx',
    )
    writeXlsx(rows, out)

    console.log('')
    console.log('=== ' + label + ' → ' + out.slice(ROOT.length + 1) + ' ===')
    console.log(['道具id', '名称', '价格(元)', '备注'].join(' | '))
    for (const r of rows) console.log([r.id, r.name, r.price, r.note].join(' | '))
    if (problems.length) console.log('  ❌ ' + problems.join('；'))
  }

  console.log('')
  if (allInteger) {
    console.log('✅ 三档都是整元 —— 与微信侧「道具价格需为整数」天然一致，一个文件即可。')
  } else {
    console.log('⚠️ 有档位不是整元，所以产出两个版本：')
    console.log('   先导入【小数元】那版（与代码里的 ENERGY_PACKS 完全一致）。')
    console.log('   万一官方只收整数元，再用【整数元】那版 —— 但那时代码要跟着改成：')
    for (const g of ENERGY_PACKS) {
      console.log(
        '     ' + g.code.padEnd(12) + 'priceFen: ' + g.priceFen + ' → ' +
          Math.round(g.priceFen / 100) * 100,
      )
    }
    console.log('   （不改的话发货时会对不上价，报 -15013）')
  }
  /**
   * ⭐⭐ 核对 `.env` 里的道具 ID 与这份文件是否**逐字一致**。
   *
   * ⚠️ 不一致的症状是支付时报 **-15010（道具未发布）** ——
   *    而那个报错会让人跑去微信侧翻道具列表，不会想到「我们配的 ID 和导入的差一个下划线」。
   *    （这个坑真踩过一次：文件里是 energy10，.env 里写成了 energy_10。）
   */
  const mismatched: string[] = []
  for (const g of ENERGY_PACKS) {
    const want = productIdOf(g.code)
    const key = 'XPAY_PRODUCT_' + g.code.toUpperCase()
    const got = process.env[key]
    if (got && got !== want) mismatched.push('  · ' + key + '=' + got + '，但导入文件里是 ' + want)
  }
  console.log('')
  if (mismatched.length) {
    console.log('❌ .env 里的道具 ID 与这份导入文件对不上（会报 -15010 道具未发布）：')
    for (const m of mismatched) console.log(m)
  } else {
    console.log('✅ .env 里的道具 ID 与这份导入文件一致（没有配的会跳过）')
  }
  console.log('')
  console.log('最低价下限（iOS 硬约束）：¥' + PAY_MIN_PRICE_FEN / 100)
}

main().catch((e) => {
  console.error('❌', e)
  process.exit(1)
})
