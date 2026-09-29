import { defineConfig } from 'vitest/config'

/**
 * 小程序端的测试配置。
 *
 * ⚠️⚠️ 为什么需要它：`src/config.ts` 里有一批**构建期注入的常量**
 *    （`__MP_LOCAL_API_URL__` / `__MP_DEV_ENV_ID__` / …）——
 *    `build.mjs` 打包时会用 `define` 把它们替换成真实值，
 *    而 vitest **不走那个构建**，于是任何 import 到 `config.ts` 的模块
 *    （比如 `lib/api/upload.ts`）在测试里都会以
 *    `ReferenceError: __MP_CLOUD_SERVICE__ is not defined` 炸掉。
 *
 *    ⇒ 这里补一份**只为跑测试**的假值：测试关心的是逻辑（拼路径、生成幂等键），
 *      不是"连的是哪个环境"。值刻意写成一眼能看出是测试的字符串。
 */
export default defineConfig({
  define: {
    __MP_LOCAL_API_URL__: JSON.stringify('http://127.0.0.1:8899'),
    __MP_LAN_API_URL__: JSON.stringify(''),
    __MP_DEV_ENV_ID__: JSON.stringify('dev-test'),
    __MP_PROD_ENV_ID__: JSON.stringify('prod-test'),
    __MP_CLOUD_SERVICE__: JSON.stringify('jupin'),
    __MP_BUILD_TIME__: JSON.stringify('2026-01-01T00:00:00.000Z'),
  },
})
