/**
 * `tools/env.mjs` 的类型声明。
 *
 * ⚠️ 为什么需要单独一个文件：`tools/env.mjs` 是**给 .mjs 运维脚本用的 JS**，
 *    而 tools/pipeline 是 TypeScript（tsconfig 里没开 allowJs）。
 *    没有这份声明，TS 会报 TS7016「隐式 any」，
 *    于是 `pnpm typecheck` 整个仓库红掉。
 *
 * ⚠️ 两组签名**必须与 env.mjs 保持一致** —— 改了那边记得改这里。
 *    这里只声明本仓库 TS 代码真正用到的导出（ROOT / loadEnv / MODES）。
 */

/** 仓库根目录（env.mjs 在 tools/ 下） */
export const ROOT: string

/** 允许的三种运行模式 —— 与 .env.<mode> 的文件名一一对应 */
export const MODES: readonly ['local', 'dev', 'prod']

/**
 * 按 mode 分层加载 .env + .env.<mode>，写进 process.env。
 *
 * @returns 本次**从文件里读到的**键值（不含进程里原有的）
 */
export function loadEnv(mode?: string): Record<string, string>

/** 解析一份 .env，返回键值（文件不存在时返回空对象） */
export function parseEnvFile(path: string): Record<string, string>

/** 某个 mode 对应的文件绝对路径 */
export function envFileOf(mode: string): string

/** 幂等地把某个键写进某份 .env */
export function writeEnvVar(file: string, key: string, value: string): void
