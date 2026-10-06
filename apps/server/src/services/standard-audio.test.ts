import { afterEach, describe, expect, it } from 'vitest'
import { env } from '../env'
import { audioKeyOf, audioRefOf, localStandardAudioKey } from './standard-audio'

/**
 * ⚠️ 这一条是**回归测试**：本机的标准音一度去云桶里找，报「拿不到标准音」。
 *    原因不是「本机没有对象存储」，而是判据用错了：
 *    .env.local 里同时配着 WX_CLOUD_ENV_ID / COS_BUCKET（本机也要能直传录音、头像），
 *    于是 fileIdOf() 在本机也成功 —— 只看它就等于把本机也当成云托管。
 *    文章 id 变成内容 hash 之后，云桶里那条旧编号的 key 就对不上了。
 */
describe('audioRefOf', () => {
  const original = env.STORAGE
  afterEach(() => {
    env.STORAGE = original
  })

  it('本机（STORAGE=local）给服务端路径 —— 云环境变量配了也不能走云', () => {
    // 前提：本机确实配了云环境，否则下面这条断言测不到真东西
    // （.env.local 里有 WX_CLOUD_ENV_ID / COS_BUCKET，云上那两个键由 .env.dev/prod 给）
    env.STORAGE = 'local'
    const id = 'a'.repeat(64)
    expect(audioRefOf({ id, standardAudio: 'content/audio/' + id + '.mp3' })).toEqual({
      full: '/media/articles/' + id + '.mp3',
      kind: 'http',
    })
  })

  it('standard_audio 为空 ⇒ null（客户端据此隐藏播放入口，而不是给一个点了 404 的按钮）', () => {
    expect(audioRefOf({ id: 'a'.repeat(64), standardAudio: null })).toBe(null)
    expect(audioRefOf({ id: 'a'.repeat(64), standardAudio: '' })).toBe(null)
  })

  it('云托管（STORAGE=wxcloud）给 fileID；云环境变量缺失时退回服务端路径', () => {
    env.STORAGE = 'wxcloud'
    const id = 'b'.repeat(64)
    const ref = audioRefOf({ id, standardAudio: 'content/audio/' + id + '.mp3' })
    if (env.WX_CLOUD_ENV_ID && env.COS_BUCKET) {
      expect(ref).toEqual({
        full: 'cloud://' + env.WX_CLOUD_ENV_ID + '.' + env.COS_BUCKET + '/content/audio/' + id + '.mp3',
        kind: 'cloud',
      })
    } else {
      // 裸环境（CI）没有云坐标 —— 那就只能退回本机那条路，但至少不能是空的
      expect(ref?.kind).toBe('http')
    }
  })
})

/**
 * ⭐ `localStandardAudioKey` —— "本机这一行该不该有标准音"的**唯一判断**。
 *
 * ⚠️ 它存在的理由（2026-09 真实缺口）：原来只有"种子清单里的句子"会被挂上，
 *    管理台新增的句子不在清单里 ⇒ 音频文件明明生成好了，`standard_audio` 永远是 NULL
 *    ⇒ 接口不给 audio ⇒ 新句子在模拟器里"取音频失败"。
 *    ⇒ 判据统一成"盘上有没有这个 mp3"，这里把三种情形钉住。
 */
describe('localStandardAudioKey —— 盘上是唯一判据', () => {
  const root = '/tmp/jushuo-static'

  it('盘上有这个 mp3 ⇒ 给出该写进 standard_audio 的 key', () => {
    expect(localStandardAudioKey('abc123', { root, exists: () => true })).toBe(audioKeyOf('abc123'))
  })

  it('盘上没有 ⇒ null（还没生成音频，不该凭空写一个指向空文件的 key）', () => {
    expect(localStandardAudioKey('abc123', { root, exists: () => false })).toBeNull()
  })

  it('连静态根都找不到 ⇒ null（容器/本机路径都不对时不要猜）', () => {
    expect(localStandardAudioKey('abc123', { root: null, exists: () => true })).toBeNull()
  })
})
