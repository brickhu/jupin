import { ARTICLE_ID_LENGTH } from './constants/index'

/**
 * ⭐ **内容寻址**：句子 id = `sha256(text.trim())` 的十六进制前 `ARTICLE_ID_LENGTH` 位（16 位 = 64 bit）。
 *
 * ⚠️⚠️ 这个式子**只允许有这一处实现**（全端共用：服务端、管理台、小程序、脚本）。
 *    它的来历值得记下来：本来散在三处（admin 服务 / 旧 CLI / backfill 脚本），
 *    每处都写一句"必须与别处口径一致"的注释 —— 那种注释不是约束，是祈祷。
 *    id 同时是主键、音频路径、客户端缓存 key：**任何一处口径不一致，
 *    同一条句子就会变成两条互不相认的记录**。
 *    2026-09 真的发生过：服务端不校验，接口能建出 `zzdel358045` 这种非哈希 id。
 *
 * ⚠️ **为什么这里不用 `node:crypto`**：shared 要被小程序构建依赖，
 *    而那边没有 node 内置模块。所以这里是一份**纯实现的 sha256**（约 40 行），
 *    好处是"同一个式子所有端都能调用"，正是这个文件存在的理由。
 *    ⚠️ 纯实现有写错的风险 ⇒ 单测拿 `node:crypto` 的结果**逐字节对拍**（见 article-id.test.ts）。
 *
 * ⚠️ 归一化**只有** `trim()`。不要顺手做 toLowerCase / 折叠空白 / 去标点：
 *    历史内容的 id 都按这个口径算过（库里的行、对象存储的 key），改口径必须配一次全量重命名。
 */
export function articleIdOf(text: string): string {
  return sha256Hex(text.trim()).slice(0, ARTICLE_ID_LENGTH)
}

/**
 * sha256 的十六进制摘要（小写）—— 纯实现，见上面关于"为什么不用 node:crypto"的说明。
 *
 * ⚠️ 它**不是**给业务用的：只在包内被 `articleIdOf` / `participationIdOf` 这类
 *    "id = 某个哈希的前 N 位"的派生函数复用（单测会拿 node:crypto 逐字节对拍）。
 */
export function sha256Hex(input: string): string {
  const bytes = utf8Bytes(input)
  const bitLen = bytes.length * 8

  // ---- padding：0x80 + 若干 0x00，使总长 ≡ 56 (mod 64)，再接 8 字节大端位长 ----
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  // ⚠️ 位长可能超过 2^32（>512MB 的文本），所以写成高/低两个 32 位字
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000))
  view.setUint32(padded.length - 4, bitLen >>> 0)

  const K = SHA256_K
  const H = SHA256_H.slice()
  const w = new Uint32Array(64)

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }

    let a = H[0]!
    let b = H[1]!
    let c = H[2]!
    let d = H[3]!
    let e = H[4]!
    let f = H[5]!
    let g = H[6]!
    let h = H[7]!
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    H[0] = (H[0]! + a) >>> 0
    H[1] = (H[1]! + b) >>> 0
    H[2] = (H[2]! + c) >>> 0
    H[3] = (H[3]! + d) >>> 0
    H[4] = (H[4]! + e) >>> 0
    H[5] = (H[5]! + f) >>> 0
    H[6] = (H[6]! + g) >>> 0
    H[7] = (H[7]! + h) >>> 0
  }

  let out = ''
  for (const x of H) out += x.toString(16).padStart(8, '0')
  return out
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

/** 字符串 → UTF-8 字节（小程序环境没有 TextEncoder 的稳定实现，这里自己写） */
function utf8Bytes(str: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)
    // 代理对（emoji 等）合并成一个码点
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000
        i++
      }
    }
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return new Uint8Array(out)
}

/** sha256 的 64 个轮常数（RFC 6234） */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** sha256 的 8 个初始散列值（RFC 6234） */
const SHA256_H = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])
