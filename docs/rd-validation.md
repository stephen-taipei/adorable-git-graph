# RD 診斷驗證紀錄

驗證日期：2026-10-11。範圍為 P0＋P1 的唯讀診斷、本機啟動與兩個 extension 的共用建置。

| 檢查                                                  | 結果                            | 證據與範圍                                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm -r typecheck`                                   | 通過                            | graph-core、graph-ui、extension-core、web                                                                                                                                |
| `pnpm -r test`                                        | 217／217 通過                   | core 68、UI 39、extension 32、web 78；原生 Git watcher 在可使用原生 watcher 的本機執行環境通過                                                                           |
| 本機 Git fixtures                                     | 通過                            | SHA-1／SHA-256、分歧／相同／無共同祖先、root／merge parent、shallow／partial clone／缺物件、rename／binary／大型 diff；以 Git 輸出核對，並核對 `.git` 內容沒有被查詢修改 |
| GitHub／background fixtures                           | 通過                            | 固定 SHA、commit 分頁與 files 上限、fork PR、權限／限流；暖快取後換 token、延遲設定事件／讀取、延遲及失敗的清除、取消與 background 重啟；patch 完整性不足保持 unknown    |
| `node tools/e2e/diagnostics.mjs local`                | 通過                            | 實際單命令 launcher、比較、commit／file diff、取消重試、焦點恢復、關閉動畫與 mobile overflow                                                                             |
| `node tools/e2e/diagnostics.mjs chrome`               | 通過                            | Chrome for Testing 的隔離 profile；commit／fork PR、圖形之外的 commit、Home 返回原選取、關閉重開保留焦點、token 清除                                                     |
| `node tools/e2e/diagnostics.mjs firefox`              | 通過                            | 本機 Firefox 的隔離 profile；同一組 extension 完整流程                                                                                                                   |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm build` | 通過                            | web、Chrome、Firefox 共用原始碼                                                                                                                                          |
| Firefox `web-ext lint`                                | 0 errors／0 notices／4 warnings | React 產物的 `innerHTML` 指派警告；基線也有這 4 個警告。診斷 patch 以 React 文字節點呈現                                                                                 |
| `git diff --check`                                    | 通過                            | 空白與 conflict marker 檢查                                                                                                                                              |

E2E 截圖在 `apps/web/e2e/.artifacts/diagnostics`、`apps/extension/e2e/.artifacts/diagnostics`、`apps/extension-firefox/e2e/.artifacts/diagnostics`。三個流程都在診斷開啟、動畫關閉時取樣空的 DOM 線圖欄位，等待實際 WebGL 像素後截圖。修正後的 desktop／mobile ink ratio 皆高於 `0.01`；確切值與受測 SHA 以建置／驗證 receipt 為準。新增回歸涵蓋 URL commit A 改選 B 後重開仍保留 B，以及導覽到 C 時選取 C。Chrome 可使用 `CHROME_PATH` 指定支援 sideload 的 Chrome for Testing；Firefox 使用本機安裝的瀏覽器，以 `--no-remote`／`--new-instance` 隔離既有使用者 instance。Mock 在收到 request 時記錄認證 header，token 清除前等待先前診斷與 request 完成，避免把延遲回應誤算為清除後的新請求。測試會關閉自建 browser、server、launcher，並移除自建暫存 fixture／profile。

## 尚未驗證

- GitHub E2E 使用 mock API。未以使用者的真實 private repo、真實 token 或線上 fork PR 驗證。
- Chrome 補驗曾有一次 PR context 等待逾時；加入失敗狀態與截圖後重跑通過，尚未定位該次逾時原因。
- 本輪 Chrome 隔離測試曾有一次 background service worker 啟動超過 15 秒；保存瀏覽器啟動紀錄後補跑通過，尚未定位該次啟動逾時原因。
- 使用者既有 Chrome／Firefox profile 的 extension Reload 與真實公開 repo 診斷，以最新版的 live-browser receipt 為準。
- 未執行 npm、Chrome Web Store、AMO 或公開服務發布。
- 試用成功率、任務時間及重複使用門檻尚未實測。參考 [試用方案](rd-pilot.md)。
- 正式 native review 已完整檢查最初的 42 個變更檔案，找到認證快取隔離與 commit context 還原問題。兩項問題都有重現與修正驗證。正式驗收須重新綁定修正後的固定 SHA、取得獨立 review 與 host-signed receipt，再由 `sbw complete` 判定；本機測試通過不會自行解除正式 HOLD。

可重跑命令、唯讀限制與 extension 更新方式見 [RD 診斷文件](rd-diagnostics.md)。
