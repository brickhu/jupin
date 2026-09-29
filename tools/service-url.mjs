#!/usr/bin/env node
/**
 * 查某个环境的**服务端地址**（管理台要知道"去哪找服务端"）。
 *
 *   node tools/service-url.mjs dev
 *   node tools/service-url.mjs prod
 *
 * ⚠️⚠️ 这个脚本查出来的值**只作参考，别直接信任**：
 *    `DescribeCloudBaseRunServiceDomain` 传 `ServiceName` 时，实测
 *    **dev 与 prod 返回同一个域名**（都是 dev 的那个）—— 它按服务名查，
 *    没有带上环境的实例编号，所以对多环境项目会给出错的那个。
 *    ⇒ 权威值在**控制台**：环境 → 服务 → 访问设置 / 默认域名。
 *      这里打印出来只是为了少打字，配进 `.env.<env>` 之前请对一眼。
 */
import { createRequire } from 'node:module'

import { loadEnv, ROOT } from './env.mjs'

const mode = process.argv[2] ?? 'dev'
if (!['local', 'dev', 'prod'].includes(mode)) {
  console.error('用法：node tools/service-url.mjs [dev|prod]')
  process.exit(1)
}

loadEnv(mode)
const req = createRequire(ROOT + '/package.json')
const api = req('@wxcloud/cli/lib/api/cloudapiDirect')
const { setApiCommonParameters } = req('@wxcloud/cli/lib/api/common')
setApiCommonParameters({ region: 'ap-shanghai' })

const service = process.env.MP_CLOUD_SERVICE || 'jupin'
try {
  const r = await api.DescribeCloudBaseRunServiceDomain({
    EnvId: process.env.WXCLOUD_ENV_ID,
    ServiceName: service,
  })
  console.log(`${mode}（envId=${process.env.WXCLOUD_ENV_ID}）`)
  console.log(`  公网域名 ${r.DefaultPublicDomain || '（无）'}`)
  console.log(`  内网域名 ${r.DefaultInternalDomain || '（无）'}`)
  console.log(`  访问方式 ${JSON.stringify(r.AccessTypes)}`)
  console.log('\n⚠️ 与 .env.' + mode + ' 里的 ADMIN_API_URL 对一眼：这个接口可能返回**别的环境**的域名。')
} catch (err) {
  console.error('查询失败：' + (err?.Message ?? err?.message ?? err))
  process.exit(1)
}
