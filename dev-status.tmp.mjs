import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { loadEnv, ROOT } from './tools/env.mjs'

const require2 = createRequire(resolve(ROOT, 'package.json'))
const CLI = resolve(ROOT, 'node_modules/@wxcloud/cli/lib')
const api = require2(CLI + '/api/cloudapiDirect')
const { setApiCommonParameters } = require2(CLI + '/api/common')
setApiCommonParameters({ region: 'ap-shanghai' })

loadEnv('dev')
const envId = process.env.WXCLOUD_ENV_ID
const service = process.env.MP_CLOUD_SERVICE || 'jupin'
const V = 'jupin-072'

const show = (label, r) => {
  console.log('### ' + label)
  const s = typeof r === 'string' ? r : JSON.stringify(r, null, 1)
  console.log(s.length > 3500 ? s.slice(0, 3500) + '\n…（截断）' : s)
  console.log('')
}
const base = { EnvId: envId, ServerName: service, VersionName: V }

for (const [label, fn] of [
  ['进程日志 DescribeCloudBaseRunProcessLog', () => api.DescribeCloudBaseRunProcessLog(base)],
  ['服务域名 DescribeCloudBaseRunServiceDomain', () => api.DescribeCloudBaseRunServiceDomain(base)],
]) {
  try { show(label, await fn()) } catch (e) { show(label + ' → 失败', e?.Message ?? e?.message ?? e) }
}
