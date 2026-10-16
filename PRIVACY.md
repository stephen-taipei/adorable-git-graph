# Privacy Policy · 隱私權政策

_Last updated / 最後更新：2026-10-13_

This policy covers **Adorable Git Graph**: the Chrome extension, the Firefox add-on, and the local web app
(`npx @stephen.taipei/adorable-git-graph` / `pnpm start`). The source code is public at
<https://github.com/stephen-taipei/adorable-git-graph>.

[繁體中文版在下方](#繁體中文)

## Summary

Adorable Git Graph does **not** collect, sell, or share any personal data. It has no analytics, no tracking,
no advertising, and no server operated by the developer. Everything it stores stays on your own device.

## What the browser extension handles

| Data                                                                                     | Why                                                                           | Where it goes                                                       | Where it is stored                                                                                      |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| The owner / name of the GitHub repository you are viewing (from the github.com page URL) | To fetch that repository's branches, commits and tags                         | Sent only to the GitHub REST API (`https://api.github.com`)         | Not stored                                                                                              |
| Optional GitHub personal access token you enter on the options page                      | To raise GitHub's rate limit and read private repositories you have access to | Sent only to `https://api.github.com`, as an `Authorization` header | Extension local storage (`storage.local`) on your device, until you clear it or uninstall the extension |
| GitHub API responses (commit messages, author names, branch / tag names, avatar URLs)    | To draw the graph and avoid repeated requests                                 | —                                                                   | Extension local storage, cached for about 10 minutes                                                    |
| Display preferences (for example animation on / off, detail panel size)                  | To remember your choices                                                      | —                                                                   | Extension local storage                                                                                 |

- On Firefox, the add-on asks for your consent ("authentication information") when you save a token; without it the token
  is neither saved nor sent.
- The token is only read by the extension's background script. It is never exposed to the github.com page, never
  put in a URL, and never sent anywhere other than `api.github.com`.
- Author avatars are loaded directly from GitHub's image servers (the avatar URLs returned by the GitHub API).
- The extension only runs on `https://github.com/*` and only requests `https://api.github.com/*`.

## What the local web app handles

- It runs on your own computer and listens only on `localhost`. It reads your local Git repositories by running
  read-only `git` commands; nothing is uploaded.
- Paths of repositories you add with "Open another path…" are remembered in a file in your user state directory
  (for example `~/.local/state/adorable-git-graph/`). Delete that file to forget them.
- If you switch to the GitHub source, the same rules as the extension apply: requests go only to
  `https://api.github.com`, and an optional token is kept in your browser's `localStorage` for that local page.

## Third parties

Requests to GitHub are subject to the
[GitHub General Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).
No other third party receives any data.

## Your choices

- Clear the token on the extension's options page (this also clears the cache), or uninstall the extension to remove
  everything it stored.
- Use a fine-grained, read-only token (`Contents: Read-only` + `Metadata: Read-only`) limited to the repositories you need,
  or no token at all.

## Changes and contact

Changes to this policy are published in this file; its Git history shows every revision.
Questions: open an issue at <https://github.com/stephen-taipei/adorable-git-graph/issues>.

---

## 繁體中文

本政策適用於 **Adorable Git Graph** 的 Chrome 擴充功能、Firefox 附加元件，以及本機 web app
（`npx @stephen.taipei/adorable-git-graph` / `pnpm start`）。原始碼公開於 <https://github.com/stephen-taipei/adorable-git-graph>。

### 摘要

Adorable Git Graph **不會**收集、販售或分享任何個人資料；沒有分析、追蹤或廣告，也沒有開發者經營的伺服器。
所有儲存的資料都只留在你的裝置上。

### 擴充功能會處理的資料

| 資料                                                                  | 用途                                            | 送往哪裡                                                  | 存在哪裡                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| 你正在瀏覽的 GitHub repo 的 owner / 名稱（取自 github.com 網址）      | 取得該 repo 的 branch、commit、tag              | 只送往 GitHub REST API（`https://api.github.com`）        | 不儲存                                                              |
| 你在設定頁自行輸入的 GitHub personal access token（選填）             | 提高 GitHub 的請求額度、讀取你有權限的私有 repo | 只以 `Authorization` header 送往 `https://api.github.com` | 擴充功能的本機儲存空間（`storage.local`），直到你清除或移除擴充功能 |
| GitHub API 回應（commit 訊息、作者名稱、branch / tag 名稱、頭像網址） | 繪製圖表、避免重複請求                          | —                                                         | 擴充功能的本機儲存空間，快取約 10 分鐘                              |
| 顯示偏好（例如動畫開關、詳情面板大小）                                | 記住你的設定                                    | —                                                         | 擴充功能的本機儲存空間                                              |

- Firefox 版在你儲存 token 時會先徵求「驗證資訊」的資料收集同意；沒有同意就不會儲存也不會送出 token。
- token 只有擴充功能的 background 讀得到，不會暴露給 github.com 頁面、不會出現在網址裡，也不會送往 `api.github.com` 以外的地方。
- 作者頭像直接從 GitHub 的圖片伺服器載入（GitHub API 回傳的頭像網址）。
- 擴充功能只在 `https://github.com/*` 執行，只會請求 `https://api.github.com/*`。

### 本機 web app 會處理的資料

- 在你自己的電腦上執行，只監聽 `localhost`；以唯讀的 `git` 指令讀取本機 repo，不會上傳任何東西。
- 用「開啟其他路徑…」加入的 repo 路徑記在使用者 state 目錄裡的檔案（例如 `~/.local/state/adorable-git-graph/`），刪除該檔案即可清除。
- 切換到 GitHub 來源時，規則與擴充功能相同：只請求 `https://api.github.com`，選填的 token 存在該本機頁面的瀏覽器 `localStorage`。

### 第三方

對 GitHub 的請求適用 [GitHub 一般隱私權聲明](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)。
沒有其他第三方會收到任何資料。

### 你的選擇

- 在擴充功能的設定頁清除 token（會一併清除快取），或移除擴充功能以刪除它儲存的所有資料。
- 使用只授權必要 repo 的 fine-grained 唯讀 token（`Contents: Read-only` + `Metadata: Read-only`），或完全不使用 token。

### 變更與聯絡

本政策的變更會更新在此檔案，Git 歷史記錄每一次修訂。問題請到
<https://github.com/stephen-taipei/adorable-git-graph/issues> 開 issue。
