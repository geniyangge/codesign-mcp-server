/**
 * 版本号唯一来源。
 *
 * 修改版本时只改这里，然后执行 `pnpm run version:sync` 同步到 package.json。
 * `pnpm test` 与 `prepublishOnly` 都会校验两处是否一致，防止漏同步。
 */
export const VERSION = "2.0.0";
