import { afterEach, describe, expect, it } from 'vitest'
import { env } from '../env'
import { normalizeAge, normalizeAvatarUrl, normalizeBio, normalizeGender, normalizeNickname } from './user'

/**
 * ⚠️ 这两个函数是**用户资料的唯一关卡**，而且两者的失败方式都很难发现：
 *    昵称没净化 → 榜单上出现换行 / 看不见的零宽字符；
 *    头像没校验 → users.avatar_url 变成一张我们替外部域名托管的图。
 *    所以逐条钉死，尤其是「看起来像但其实不是本环境」的那几种。
 */

describe('normalizeNickname —— 昵称净化', () => {
  it('折叠空白并把首尾空格去掉', () => {
    expect(normalizeNickname('  张  三  ')).toBe('张 三')
  })

  it('剥掉换行 / 控制字符 / 零宽字符', () => {
    expect(normalizeNickname('张\u0007三\u200b\n读\u2028句')).toBe('张三读句')
  })

  it('超长截到 32（不按字节，中文也算一个）', () => {
    expect(normalizeNickname('朗'.repeat(40))).toHaveLength(32)
  })

  it('非字符串 / 全是空白 → 空串（调用方据此报 400）', () => {
    expect(normalizeNickname(undefined)).toBe('')
    expect(normalizeNickname('   ')).toBe('')
    expect(normalizeNickname('\u200b\u200b')).toBe('')
  })
})

describe('normalizeAvatarUrl —— 只认本环境云存储的头像', () => {
  const saved = { envId: env.WX_CLOUD_ENV_ID, bucket: env.COS_BUCKET }

  afterEach(() => {
    env.WX_CLOUD_ENV_ID = saved.envId
    env.COS_BUCKET = saved.bucket
  })

  const withStorage = (envId: string, bucket: string) => {
    env.WX_CLOUD_ENV_ID = envId
    env.COS_BUCKET = bucket
    return 'cloud://' + envId + '.' + bucket + '/'
  }

  it('本环境 + avatars/ 前缀 → 原样收下', () => {
    const prefix = withStorage('dev-abc', 'bucket-1')
    const fileId = prefix + 'avatars/7/1700000000.png'
    expect(normalizeAvatarUrl(fileId)).toBe(fileId)
  })

  it('⭐ 别的环境的 fileID → 丢掉（换个环境就能伪造外链）', () => {
    withStorage('dev-abc', 'bucket-1')
    expect(normalizeAvatarUrl('cloud://prod-xyz.bucket-2/avatars/7/a.png')).toBe(null)
  })

  it('⭐ 本环境但不是 avatars/ 目录 → 丢掉（否则变成任意文件的分布器）', () => {
    const prefix = withStorage('dev-abc', 'bucket-1')
    expect(normalizeAvatarUrl(prefix + 'recordings/7/a.mp3')).toBe(null)
  })

  it('普通 http(s) 地址 → 丢掉', () => {
    withStorage('dev-abc', 'bucket-1')
    expect(normalizeAvatarUrl('https://evil.example.com/a.png')).toBe(null)
  })

  it('⚠️ 没配云存储（本地联调）→ 一律丢掉，而不是放行', () => {
    env.WX_CLOUD_ENV_ID = ''
    env.COS_BUCKET = ''
    expect(normalizeAvatarUrl('cloud://anything.anything/avatars/1/a.png')).toBe(null)
  })

  it('空 / 非字符串 → null', () => {
    withStorage('dev-abc', 'bucket-1')
    expect(normalizeAvatarUrl(undefined)).toBe(null)
    expect(normalizeAvatarUrl('   ')).toBe(null)
  })
})

describe('normalizeGender —— 只认 male / female', () => {
  it('合法值原样收下', () => {
    expect(normalizeGender('male')).toBe('male')
    expect(normalizeGender('female')).toBe('female')
  })

  it('⭐ 不做翻译：男 / M / 1 一律 null（不替用户改数据）', () => {
    expect(normalizeGender('男')).toBe(null)
    expect(normalizeGender('M')).toBe(null)
    expect(normalizeGender(1)).toBe(null)
  })

  it('空 / 未填 → null', () => {
    expect(normalizeGender(undefined)).toBe(null)
    expect(normalizeGender(null)).toBe(null)
    expect(normalizeGender('')).toBe(null)
  })
})

describe('normalizeAge —— 整数、6–120', () => {
  it('合法整数原样收下（数字或数字字符串）', () => {
    expect(normalizeAge(28)).toBe(28)
    expect(normalizeAge('28')).toBe(28)
    expect(normalizeAge(6)).toBe(6)
    expect(normalizeAge(120)).toBe(120)
  })

  it('⭐ 越界 / 小数 / 非数字 → null', () => {
    expect(normalizeAge(5)).toBe(null)
    expect(normalizeAge(121)).toBe(null)
    expect(normalizeAge(28.5)).toBe(null)
    expect(normalizeAge('abc')).toBe(null)
    expect(normalizeAge(99999)).toBe(null)
  })

  it('空 → null（清空年龄）', () => {
    expect(normalizeAge(null)).toBe(null)
    expect(normalizeAge(undefined)).toBe(null)
    expect(normalizeAge('')).toBe(null)
    expect(normalizeAge('   ')).toBe(null)
  })
})

describe('normalizeBio —— 剥控制字符 / 折叠空白 / 限 200', () => {
  it('折叠空白、去掉首尾空格', () => {
    expect(normalizeBio('  喜欢  读   句子 ')).toBe('喜欢 读 句子')
  })

  it('剥掉换行 / 控制字符 / 零宽字符', () => {
    expect(normalizeBio('第一行\n第二行\u200b')).toBe('第一行第二行')
  })

  it('超长截到 200', () => {
    expect(normalizeBio('读'.repeat(260))).toHaveLength(200)
  })

  it('空 / 非字符串 → null', () => {
    expect(normalizeBio('')).toBe(null)
    expect(normalizeBio('   ')).toBe(null)
    expect(normalizeBio(undefined)).toBe(null)
    expect(normalizeBio(123)).toBe(null)
  })
})
