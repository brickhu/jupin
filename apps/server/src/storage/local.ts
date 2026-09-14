import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ObjectStorage } from './types'

/**
 * 本地开发用的对象存储实现：直接落盘。
 *
 * ⚠️ 仅用于本地联调 —— 让「上传 → 取回」这条链路在没有云环境时也能跑通。
 *    生产请用 WxCloudStorage。
 *
 * ⚠️ 根目录基于**模块位置**解析而非 CWD —— 否则用 filter 方式启动时
 *    CWD 是 apps/server，会把文件读到 apps/server/.uploads 去。
 */
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_ROOT = resolve(SERVER_ROOT, '../../.uploads')

export class LocalStorage implements ObjectStorage {
  readonly name = 'local'
  private readonly root: string

  constructor(root: string = process.env.STORAGE_LOCAL_DIR ?? DEFAULT_ROOT) {
    this.root = resolve(root)
    console.log('[storage] local root = ' + this.root)
  }

  private pathOf(key: string): string {
    const file = resolve(this.root, key)
    // ⚠️ 防路径穿越：解析后必须仍在 root 内
    if (file !== this.root && !file.startsWith(this.root + '/')) {
      throw new Error('非法的对象 key: ' + key)
    }
    return file
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathOf(key)))
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true })
  }

  /** 本地专用：模拟小程序直传（生产由对象存储直传完成） */
  async put(key: string, data: Uint8Array): Promise<void> {
    const file = this.pathOf(key)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, data)
  }
}
