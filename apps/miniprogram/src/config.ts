/**
 * 小程序端配置。
 *
 * ⚠️ 本地调试前必须先改 DEV_BASE_URL —— 换成你电脑的局域网 IP。
 *    查法：ipconfig getifaddr en0   (macOS)
 *    端口取根目录 .env 里的 API_PORT（默认 3000）
 *
 * ⚠️ 为什么不能用 localhost：真机上 localhost 指向手机自己，
 *    必须走局域网 IP；且在开发者工具里要勾选「不校验合法域名」。
 */
const DEV_BASE_URL = 'http://192.168.31.131:8899'

/**
 * 生产环境走微信云托管的 CallContainer —— 免域名、免备案，
 * 由小程序原生通道调用，不需要公网地址（见 AGENT.md 部署一节）。
 * 留空即可。
 */
const PROD_BASE_URL = ''

/** 是否本地调试。发版前改成 false */
const IS_DEV = true

export const BASE_URL = IS_DEV ? DEV_BASE_URL : PROD_BASE_URL

/**
 * 微信云开发 / 云托管的环境 ID。
 *
 * ⚠️ 开通云托管后把环境 ID 填到这里（控制台「环境」页可见）。
 *    留空则 wx.cloud.init() 走默认环境；若一个环境都没有会抛异常
 *    （app.ts 已 try/catch，不会影响接口联调）。
 *
 * 用途：音频直传对象存储（wx.cloud.uploadFile）依赖它。
 */
export const CLOUD_ENV_ID = ''
