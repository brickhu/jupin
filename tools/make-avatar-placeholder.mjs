#!/usr/bin/env node
/**
 * 生成「默认头像」占位图 —— src/assets/avatar-placeholder.png。
 *
 *   node tools/make-avatar-placeholder.mjs
 *
 * ⚠️ 为什么要有这个脚本，而不是直接把一张 png 丢进仓库：
 *    头像占位图这种东西**必然会改**（换颜色、换大小、换成别的形状）。
 *    留下生成脚本，改的时候是改几行数字，而不是「找设计要一张图」——
 *    后者在真实项目里通常意味着这张图再也不会被改。
 *
 * ⚠️ 手写 PNG 编码（zlib + CRC32）而不是引一个图形库：
 *    为了一张 128×128 的占位图往依赖里加 canvas/sharp，
 *    在 CI 和别人的机器上都是麻烦（原生模块、字体、平台差异）。
 *    这张图只有圆和圆，几十行纯 Node 就够了。
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/miniprogram/src/assets/avatar-placeholder.png')

const SIZE = 128
/** 每个像素采样 4×4 次 —— 圆边才不会锯齿（占位图小，成本可以忽略） */
const SS = 4

// ---- 配色：与产品里那圈浅紫一致（= 品牌色 10% 混白）----
const BG = [238, 236, 253] // #eeecfd
const FG = [176, 170, 232] // #b0aae8 人形，比底色深一档

/** 圆在某个像素上的覆盖率（0–1）：圆心 (cx,cy)、半径 r */
function cover(cx, cy, r, x, y) {
  let hit = 0
  for (let i = 0; i < SS; i++) {
    for (let j = 0; j < SS; j++) {
      const sx = x + (i + 0.5) / SS - cx
      const sy = y + (j + 0.5) / SS - cy
      if (sx * sx + sy * sy <= r * r) hit++
    }
  }
  return hit / (SS * SS)
}

const px = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // 底色圆（整张图就是它）
    const bg = cover(64, 64, 64, x, y)
    // 人形 = 头 + 肩，两个圆的并集；再用底色圆裁掉溢出部分
    const head = cover(64, 46, 18, x, y)
    const body = cover(64, 112, 32, x, y)
    const person = (1 - (1 - head) * (1 - body)) * bg

    const i = (y * SIZE + x) * 4
    for (let c = 0; c < 3; c++) {
      px[i + c] = Math.round(BG[c] * (1 - person) + FG[c] * person)
    }
    px[i + 3] = Math.round(bg * 255)
  }
}

// ---- 最小 PNG 编码 ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // 位深
ihdr[9] = 6 // 颜色类型：RGBA
// 10–12：压缩 / 滤波 / 隔行，全 0

// 每行前面加一个滤波类型字节（0 = None）
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, png)
console.log('✅ 已生成 ' + OUT + '（' + png.length + ' 字节）')
