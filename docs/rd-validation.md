# RD 診斷驗證紀錄

驗證日期：2026-10-11。範圍為 P0＋P1 的唯讀診斷、本機啟動與兩個 extension 的共用建置。

| 檢查                                                  | 結果                            | 證據與範圍                                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm -r typecheck`                                   | 通過                            | graph-core、graph-ui、extension-core、web                                                                                                                                |
| `pnpm -r test`                                        | 210／210 通過                   | core 68、UI 39、extension 25、web 78；最後調整 watcher 測試的事件斷言後，5 項 watcher 測試再次通過                                                                       |
| 本機 Git fixtures                                     | 通過                            | SHA-1／SHA-256、分歧／相同／無共同祖先、root／merge parent、shallow／partial clone／缺物件、rename／binary／大型 diff；以 Git 輸出核對，並核對 `.git` 內容沒有被查詢修改 |
| GitHub／background fixtures                           | 通過                            | 固定 SHA、commit 分頁與 files 上限、fork PR、權限／限流、取消、token scope、延遲及失敗的快取清除；patch 完整性不足保持 unknown                                           |
| `node tools/e2e/diagnostics.mjs local`                | 通過                            | 實際單命令 launcher、比較、commit／file diff、取消重試、焦點恢復、關閉動畫與 mobile overflow                                                                             |
| `node tools/e2e/diagnostics.mjs chrome`               | 通過                            | Chrome for Testing 的隔離 profile；commit／fork PR、圖形之外的 commit、Home 返回原選取、關閉重開保留焦點、token 清除                                                     |
| `node tools/e2e/diagnostics.mjs firefox`              | 通過                            | 本機 Firefox 的隔離 profile；同一組 extension 完整流程                                                                                                                   |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm build` | 通過                            | web、Chrome、Firefox 共用原始碼                                                                                                                                          |
| Firefox `web-ext lint`                                | 0 errors／0 notices／4 warnings | React 產物的 `innerHTML` 指派警告；基線也有這 4 個警告。診斷 patch 以 React 文字節點呈現                                                                                 |
| `git diff --check`                                    | 通過                            | 空白與 conflict marker 檢查                                                                                                                                              |

E2E 截圖在 `apps/web/e2e/.artifacts/diagnostics`、`apps/extension/e2e/.artifacts/diagnostics`、`apps/extension-firefox/e2e/.artifacts/diagnostics`。三個流程都在診斷開啟、動畫關閉時取樣空的 DOM 線圖欄位，等待實際 WebGL 像素後截圖；desktop／mobile 的 ink ratio 分別為 local `0.0308／0.1177`、Chrome `0.0341／0.1177`、Firefox `0.0314／0.1179`。Chrome 可使用 `CHROME_PATH` 指定支援 sideload 的 Chrome for Testing；Firefox 使用本機安裝的瀏覽器。測試會關閉自建 browser、server、launcher，並移除自建暫存 fixture／profile。

## 尚未驗證

- GitHub E2E 使用 mock API。未以使用者的真實 private repo、真實 token 或線上 fork PR 驗證。
- Chrome 補驗曾有一次 PR context 等待逾時；加入失敗狀態與截圖後重跑通過，尚未定位該次逾時原因。
- 已建置 extension 並在隔離瀏覽器載入。使用者既有 Chrome／Firefox profile 的 extension Reload 尚未驗證。
- 未執行 npm、Chrome Web Store、AMO 或公開服務發布。
- 試用成功率、任務時間及重複使用門檻尚未實測。參考 [試用方案](rd-pilot.md)。
- 工程獨立審查與 Better Workflows 的 host-signed critic receipt 是不同證據。目前 runtime 未提供可驗證的 signer／attestation route，正式 review gate 保持 HOLD；不把本機測試或未驗證的 reviewer model 身分當成正式 receipt。

可重跑命令、唯讀限制與 extension 更新方式見 [RD 診斷文件](rd-diagnostics.md)。
