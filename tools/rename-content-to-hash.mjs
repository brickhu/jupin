#!/usr/bin/env node
/**
 * 把正文 / 标准音文件从「数字名」改成「内容 hash 名」，并同步库里的路径。
 *
 *   content/articles/{old}.json  →  {id}.json   （同时把 JSON 里的 id 改成 hash）
 *   content/audio/{old}.mp3     →  {id}.mp3
 *   content/audio/{old}/w*.mp3  →  {id}/w*.mp3
 *   articles.content_json / standard_audio 一并改
 *
 * ⚠️ 幂等：文件名已经是 hash 时，重命名是空操作，只更新库路径。
 * ⚠️ dev/prod 的文件来自镜像（重新部署后已是 hash 名），本机只做库路径同步。
 *
 *   node tools/rename-content-to-hash.mjs [local|dev|prod]
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { loadEnv, ROOT } from './env.mjs'

const arg = process.argv[2]
const target = arg === 'prod' ? 'prod' : arg === 'dev' ? 'dev' : 'local'
loadEnv(target)

let url = process.env.DATABASE_URL
if (target !== 'local') {
  const require = createRequire(resolve(ROOT, 'package.json'))
  const { DescribeWxCloudBaseRunDBClusterDetail } = require(resolve(ROOT, 'node_modules/@wxcloud/cli/lib/api/cloudapiDirect'))
  const { setApiCommonParameters } = require(resolve(ROOT, 'node_modules/@wxcloud/cli/lib/api/common'))
  setApiCommonParameters({ region: 'ap-shanghai' })
  const envId = process.env.WXCLOUD_ENV_ID
  const detail = await DescribeWxCloudBaseRunDBClusterDetail({ EnvId: envId })
  const { DbInfo = {}, NetInfo = {} } = detail
  if (!DbInfo.IsOpenPubNetAccess || !NetInfo.PubNetAddress) {
    console.error('❌ 数据库没开外网地址')
    process.exit(1)
  }
  url =
    'mysql://' +
    encodeURIComponent(process.env.MYSQL_USERNAME ?? 'root') +
    ':' +
    encodeURIComponent(process.env.MYSQL_PASSWORD) +
    '@' +
    NetInfo.PubNetAddress +
    '/' +
    (process.env.MYSQL_DATABASE ?? 'jushuo')
}

const mysql = createRequire(resolve(ROOT, 'apps/server/package.json'))('mysql2/promise')
const conn = await mysql.createConnection(url)
try {
  /**
   * ⚠️ 旧文件名不再从 articles.content_json 读（那一列已删）。
   *    但**旧基名仍可从 standard_audio 推出来**：这一列此刻还指向旧音频名
   *    `content/audio/<旧基名>.mp3`，而它正是被本脚本改成新名字的。
   *    没有音频的行（standard_audio 为空）退回用 id —— 那说明文件名本来就已经是 hash。
   */
  const [rows] = await conn.query('SELECT id, standard_audio FROM articles ORDER BY id')
  let renamed = 0
  for (const r of rows) {
    const oldBaseFromAudio = String(r.standard_audio ?? '').split('/').pop().replace(/\.mp3$/, '')
    if (!oldBaseFromAudio) {
      console.warn('[rename] #' + r.id + ' 没有 standard_audio，按「文件名已是 hash」处理')
    }
    const oldName = (oldBaseFromAudio || r.id) + '.json'
    const oldBase = oldName.replace(/\.json$/, '')
    const newName = r.id + '.json'

    if (oldName !== newName) {
      const from = resolve(ROOT, 'content/articles', oldName)
      const to = resolve(ROOT, 'content/articles', newName)
      if (existsSync(from) && !existsSync(to)) {
        renameSync(from, to)
        renamed++
      }
      const at = existsSync(to) ? to : from
      if (existsSync(at)) {
        const j = JSON.parse(readFileSync(at, 'utf8'))
        j.id = r.id
        writeFileSync(at, JSON.stringify(j, null, 2) + '\n', 'utf8')
      }
    }

    // 音频：整句 + 切片目录
    const oldAudio = 'content/audio/' + oldBase + '.mp3'
    const newAudio = 'content/audio/' + r.id + '.mp3'
    if (oldBase !== r.id) {
      const fa = resolve(ROOT, oldAudio)
      const ta = resolve(ROOT, newAudio)
      if (existsSync(fa) && !existsSync(ta)) renameSync(fa, ta)
      const da = resolve(ROOT, 'content/audio', oldBase)
      const db = resolve(ROOT, 'content/audio', r.id)
      if (existsSync(da) && !existsSync(db)) renameSync(da, db)
    }

    const standard = r.standard_audio ? newAudio : null
    // ⚠️ 只更新 standard_audio：content_json 那一列已删（正文路径由 id 推导）
    await conn.execute('UPDATE articles SET standard_audio = ? WHERE id = ?', [
      standard,
      r.id,
    ])
    console.log('  ' + oldName + ' → ' + newName + (r.standard_audio ? '  + ' + newAudio : ''))
  }
  console.log('[rename] 完成，重命名 ' + renamed + ' 个正文文件')
} finally {
  await conn.end()
}
