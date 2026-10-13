/** 由 scripts/build.mjs 以 `define` 注入。預設 https://api.github.com，僅 e2e 會指向 mock server。 */
declare const __AGG_API_BASE__: string;
/** 由 scripts/build.mjs 以 `define` 注入：建置目標。測試時沒有定義（視為 Chrome）。 */
declare const __AGG_TARGET__: 'chrome' | 'firefox';
