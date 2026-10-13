/**
 * Firefox 的資料收集同意（manifest 的 `data_collection_permissions.optional: ["authenticationInfo"]`）：
 * 使用者自填的 GitHub token 會送到 api.github.com，屬於「驗證資訊」。只有使用者在設定頁儲存 token 時才請求同意，
 * 沒有同意（或之後在附加元件管理員撤銷）就不送 token，照未登入的方式抓。Chrome 沒有這個機制，一律視為同意。
 */
const IS_FIREFOX = typeof __AGG_TARGET__ !== 'undefined' && __AGG_TARGET__ === 'firefox';

// @types/chrome 沒有 data_collection 欄位（Firefox 140+ 才有）
const TOKEN_CONSENT = {
  data_collection: ['authenticationInfo'],
} as unknown as chrome.permissions.Permissions;

export async function hasTokenConsent(): Promise<boolean> {
  if (!IS_FIREFOX) return true;
  try {
    return await chrome.permissions.contains(TOKEN_CONSENT);
  } catch {
    return false;
  }
}

/** 必須在使用者操作（click）的處理函式裡、任何 await 之前呼叫，Firefox 才會顯示同意對話框。 */
export async function requestTokenConsent(): Promise<boolean> {
  if (!IS_FIREFOX) return true;
  try {
    return await chrome.permissions.request(TOKEN_CONSENT);
  } catch {
    // 不是在使用者操作裡（例如程式觸發的 click）就不能問：已經同意過就照用，否則視為沒有同意
    return hasTokenConsent();
  }
}
