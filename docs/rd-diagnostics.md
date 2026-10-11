# 唯讀 RD 診斷

這一版完成 P0＋P1：以固定 SHA 查詢分支分歧、獨有 commits、變更檔案與文字 diff，並保留 GitHub commit／PR 頁面的調查脈絡。操作不修改 repo，也不執行 fetch。涵蓋範圍不足時，計數為 `null`，祖先關係為 `unknown`，不把空清單當作沒有變更。

## 開始使用

```sh
pnpm install --frozen-lockfile
pnpm start --repo /absolute/path/to/repo
# 可選：pnpm start --repo ~/code/repo --port 4300
```

一條命令會啟動 localhost web 與唯讀 Git 查詢。Git 必須支援 `--no-lazy-fetch`；啟動時以能力探測確認，不能保證安全讀取時拒絕查詢。關閉終端機前按 Ctrl-C。原有 `AGG_REPO_DIR`、`AGG_REPO_ROOTS`、`AGG_LOCAL_REPOS_FILE` 設定仍可用。

1. 選 repo，開啟「唯讀診斷」。
2. 選 base／head，按「比較」。文字 ref 在查詢開始時解析成 SHA；PR 的 base／head 使用已取得的固定 SHA。
3. 核對雙向獨有 commit 數、祖先關係與每個結果的完整性。
4. 點檔案讀取 diff；選 commit 可讀取 `parent → commit` 的變更。
5. 使用 GitHub 連結核對，或複製含 SHA、時間、語意與完整性的摘要。

分支檔案語意固定為 `merge-base → head`。它與 `base tree → head tree` 不同。Merge commit 預設 first parent，可切換到來源實際回傳的其他 parent。Root commit 先確認不是 shallow 邊界，再與 empty tree 比較。沒有共同祖先或有多個 merge base 時，本機可以保留已核對的分歧計數，但不選擇檔案比較基準。

「關閉動畫」會記住偏好，並尊重系統 reduced-motion。每個 repo 的基本選取、branch 焦點與搜尋會以 sessionStorage 保存，並記錄所在 commit／PR context。相同 commit 頁重開會還原手動選取；導覽到另一個 commit 時，會選取新的 URL context。不保存本機路徑、檔案內容或 token。

## Chrome／Firefox 同步更新

```sh
pnpm build
pnpm --filter @adorable/extension-firefox lint
```

兩個 extension 都使用 `libs/extension-core`、`libs/graph-core` 與 `libs/graph-ui` 的同一份原始碼。產物分別在 `apps/extension/dist` 和 `apps/extension-firefox/dist`。

- Chrome：`chrome://extensions` 開啟開發人員模式，初次選「載入未封裝項目」並指向 `apps/extension/dist`。每次 build 後按該 extension 的重新載入，再重新整理已開啟的 GitHub 分頁。
- Firefox：`about:debugging#/runtime/this-firefox` 選「載入暫時性附加元件」，指向 `apps/extension-firefox/dist/manifest.json`。每次 build 後按 Reload；重啟 Firefox 後需重新臨時載入。正式簽署／商店發布另行處理。

在 GitHub commit／PR 頁面開啟 extension 時，診斷會使用目前頁面的 commit 或 PR 編號。同 repo 的 SPA 導覽也會更新 context。PR 首版只顯示編號、title、state、draft、base/head repo/ref/SHA、取得時間與連結；按「使用 PR base/head」才設定比較欄位，保留 fork 身分。

Extension 的 token 留在 background。Content script 只送查詢並取得結果；每次診斷都綁定取得 graph 時的非秘密認證代次。更換 token／設定會立即取消診斷、清除 background 的診斷記憶體快取並通知 content，通知不等待 graph 磁碟快取刪除。Background 序列化讀取目前設定，不採納延遲事件中的舊設定；舊 adapter 的請求會被拒絕。Background 重啟後會要求 content 重抓 graph，重新取得代次。

## 完整性與限制

| 資料             | 讀取／顯示限制                                                                     | 結果                                                                             |
| ---------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 圖形歷史         | GitHub 預設 5 branches／每支 60 commits；本機主要歷史合計 300 再補 default/current | 固定顯示 refs／commits 覆蓋範圍與時間，舊快照缺 metadata 為 unknown              |
| 比較 commit 清單 | 每側最多 200；分歧計數由來源另行計算                                               | 清單與計數完整性分開，不由 graph 數量推導                                        |
| 檔案清單         | 本機、GitHub 首版最多顯示 300                                                      | GitHub compare 到 300 時保守標 partial；commit 檔案分頁最多 3 頁                 |
| 文字 patch       | 512 KiB；只在點檔案後讀取                                                          | 本機超限標 partial；GitHub 未提供完整性證據時標 unknown，缺 patch 標 unavailable |
| Shallow／缺物件  | 不補抓、不懶載入                                                                   | 保守回傳 unknown／unavailable；可讀的 commit-parent tree diff 仍可使用           |

GitHub compare API 的檔案只在第一頁，commit 分頁與 files 上限分開判定。[官方 REST 文件](https://docs.github.com/en/rest/commits/commits#compare-two-commits)。GitHub PR 原生 three-dot 語意使用共同祖先到 head；本專案將 merge-base SHA 明確顯示。[官方比較說明](https://docs.github.com/en/pull-requests/reference/branches)。

Binary、rename、缺 patch 與截斷分開呈現。Ancestry 不證明 patch 等價、修改現在仍有效或已部署；squash、cherry-pick、revert 不由圖形判定。Remote-tracking refs 是本機觀察值，未查詢 remote 最新狀態。

本機 query 只接受 loopback 同源 JSON，repo 使用 server 產生的不透明 id。所有 ref 先解析為 SHA，pathspec 為 literal，停用 external diff、textconv、fsmonitor、signature helper、lazy fetch；子行程有取消與時間／輸出上限。變更與 patch 使用有界記憶體快取；extension 的快取只留在 background，依認證代次與 repo 隔離，每個請求仍需通過代次檢查。來源／token 更新不沿用舊快取，不將檔案內容寫入 browser storage。

靜態建置只含既有 subject-only graph 快照，不加入檔案內容，也沒有本機診斷 endpoint。舊快照或無 adapter 的來源明確降級。這一版沒有 Git 寫入操作、AI 解說、reviews/checks 聚合、worktree 狀態或商店發布。

## 驗證與回復

```sh
pnpm -r typecheck
pnpm -r test
node tools/e2e/diagnostics.mjs local
node tools/e2e/diagnostics.mjs chrome
node tools/e2e/diagnostics.mjs firefox
pnpm build
```

E2E 使用自建暫存 Git repo、mock GitHub API 與隔離 browser profile，截圖保存在各 app 的 `e2e/.artifacts/diagnostics`。`CHROME_PATH` 可指定 Chrome for Testing。Firefox 使用本機已安裝版本，測試用 manifest 才增加 localhost match；正式產物保留 GitHub-only 權限。macOS watcher 測試須在允許原生檔案通知的環境執行。

回復時可切回實作前的 Git revision，重新 build 並 reload extension；診斷沒有修改所查詢 repo 的 refs、index 或 objects。使用者偏好可從 browser site storage 移除，不影響 repo。
