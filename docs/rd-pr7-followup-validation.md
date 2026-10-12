# RD 診斷：PR #7 review 後續修正驗證紀錄

驗證日期：2026-10-12。本頁記錄 [PR #7](https://github.com/stephen-taipei/adorable-git-grpah/pull/7) review（head `e4fa5cf`）提出的 P1、P2 修正。另存新檔，不覆寫 [rd-open-p1.md](rd-open-p1.md)、[rd-p1-fix-validation.md](rd-p1-fix-validation.md) 或 [rd-validation.md](rd-validation.md) 的既有結果。

## 狀態

- **修正已推送，待 Codex 獨立正式驗收。**
- 最新受測候選版本為 **`2eb2e47`**（見文末「第二輪」）；`19d41e3` 的結果保留在下方各節，不改寫。
- 原始正式結果維持 **BLOCK**（`3eb1cb8`、Run `sbw-20261011T201955Z-a8a3cc81d327`、Package `review-5b6fe6a1273d586ad1e10f84bf7feec7`）。本頁是工程檢查，不是正式驗收，維持 HOLD。
- 原 campaign `campaign-41b66b43bd4f86a8fb0a6cac89a94aad` 維持 13／13。沒有修改舊 ledger、signed runtime、signer／allowlist，也沒有建立新的 run、package 或 campaign。

## 受測版本與環境

| 項目         | 值                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| 分支／PR     | `Solid/rd-diagnostics-claude`／PR #7                                                                              |
| 受測 SHA     | `19d41e33f7a388baef6c7268cd68c65818e11136`（parent `e4fa5cf`，review head）。本頁所在 commit 只變更 `docs/`。     |
| 環境         | Claude Code cloud container，Ubuntu 24.04，Node 22.22.0，pnpm 10.28.0                                             |
| 瀏覽器       | Chromium 141.0.7390.37（Playwright），Firefox 157.0.1（腳本在無 DISPLAY 時自行啟動 Xvfb）                         |
| Git          | 2.52.0，以官方 `v2.52.0` 原始碼編譯於 session 暫存區（容器內建 2.43.0 不支援 `--no-lazy-fetch`）                  |
| Package 解析 | `apps/*/node_modules/@adorable/*` 皆 symlink 至本 checkout `libs/*`；Nx 全程 `--skip-nx-cache`、`NX_DAEMON=false` |

## P1：過期設定草稿覆寫另一分頁的認證

**問題**：A 以 credential X 開啟設定，B 更換或清除 credential，A 尚未處理 B 的 `storage` 事件就提交草稿。`saveCredential()` 雖讀到共享 token／generation 已變，仍寫入 X，覆寫 B 的變更或恢復已清除的 credential。

**修正**（[authScope.ts](../apps/web/src/authScope.ts)、[App.tsx](../apps/web/src/App.tsx)）：

- `saveCredential()` 在任何持久化寫入前，比對共享 token 與 generation 和本分頁已採用的基準；不符即丟出 `AuthConflict`，不寫 scope、generation 或 credential。
- App 收到 `AuthConflict` 後採用目前共享狀態（新 scope，丟棄舊 graph、選取與結果），以目前值重新掛載對話框草稿，並顯示「另一個分頁已變更 GitHub token，這次未儲存」。`storage` 事件關閉對話框仍保留，但只是輔助。
- Credential 無法讀取的分頁沒有基準，使用者看到錯誤後明確重試時仍可寫入，保留「初始讀取失敗後的已驗證 Clear」。
- Viewer key 仍為 `[sourceKey, commit, pull, nonce]`，不含 raw token 或 token hash。

**回歸**：

- 兩分頁（[app-auth-isolation.mjs](../tools/e2e/app-auth-isolation.mjs)）：同一 context 的兩個真正 App 分頁。A 的 `storage` handler 被延後（capture listener 暫存事件，之後以相同內容重新派送給 App 自己的 handler）；A 開著 credential A 的草稿，B 更換或清除後 A 提交。斷言：顯示衝突提示；共享 credential 維持 B 的結果（`fixture-tab-auth-b` 或 `null`），reload 後仍是；草稿被換成目前值；A 採用後每個 committed frame 不含舊選取／結果，新 adapter 舊 SHA 請求 0；延後的事件最後派送時不再改變任何狀態；A 不再用舊 credential 查詢。
- 單元（[authScope.test.ts](../apps/web/src/authScope.test.ts)）：他分頁更換／清除後，A 以舊基準提交（相同或不同 token）都丟出 `AuthConflict`，localStorage 與 scope record 完全不變；採用共享狀態後可正常儲存；credential 無法讀取時明確重試仍可 Clear。

| 情境                            | `e4fa5cf`（修正前）                                                         | `19d41e3` |
| ------------------------------- | --------------------------------------------------------------------------- | --------- |
| B 更換後 A 提交舊草稿           | 沒有提示（逾時）；B 之後的請求改用 credential A，B 的變更被覆寫             | 通過      |
| B 清除後 A 提交舊草稿           | 沒有提示（逾時）；B 之後的請求帶回 credential A，已清除的 credential 被恢復 | 通過      |
| 其他兩分頁 9 情境、同分頁 17 項 | 通過                                                                        | 通過      |

修正前結果的取得方式：工作樹暫時還原 `e4fa5cf` 的 `App.tsx` 與 `authScope.ts`，搭配與受測 commit 位元組相同的測試檔執行，之後還原並以 `cmp` 確認。

## P2：Firefox helper 失敗時遺留 listener

**問題**：`verifyFirefoxApp()` 先 `server.listen`，再建置 bundle、啟動 Firefox，清理用的 `try/finally` 在其後才開始；建置或 launch 失敗時 server 不會關閉。

**修正**（[app-auth-firefox.mjs](../tools/e2e/app-auth-firefox.mjs)）：server 監聽、bundle build、helper 自建的 Firefox profile、browser launch 與後續檢查都在同一個範圍內。結束時逐項釋放 pages、browser、仍存活的 browser 程序、profile 與 server；任一步失敗不影響其他步驟，原始失敗保持為拋出的錯誤（清理錯誤附在 `cleanupErrors`）。只處理 helper 自己建立的資源。

**回歸**（[app-auth-firefox-cleanup.mjs](../tools/e2e/app-auth-firefox-cleanup.mjs)，由 `diagnostics.mjs firefox` 執行）：每個案例在獨立子程序執行，子程序不呼叫 `process.exit`，必須自行結束；父程序之後檢查實際資源。

| 案例      | 故障                                        | 子程序結束 | 原始錯誤保留            | Listener 拒絕連線 | Firefox 程序 | Profile |
| --------- | ------------------------------------------- | ---------- | ----------------------- | ----------------- | ------------ | ------- |
| `build`   | server 啟動後 bundle build 失敗             | 是（0）    | 是                      | 是                | 未啟動       | 未建立  |
| `launch`  | 建置成功後以 `/bin/false` 啟動，launch 失敗 | 是（0）    | 是                      | 是                | 未取得       | 已移除  |
| `verify`  | Firefox 載入 App 後驗證失敗                 | 是（0）    | 是                      | 是                | 已結束       | 已移除  |
| `cleanup` | 同上，另讓第一個清理步驟失敗                | 是（0）    | 是（清理錯誤 1 項另附） | 是                | 已結束       | 已移除  |

修正前重現：以 `e4fa5cf` 的 helper 讓建置在 server 啟動後失敗，helper 拒絕後程序仍存活，`lsof` 顯示 `127.0.0.1:36513 (LISTEN)`；該 probe 程序已手動結束，暫存檔已移除。

## 命令與結果（`19d41e3`，乾淨工作樹，一次執行）

typecheck／test／build／lint／prettier、`diagnostics.mjs local`、`diagnostics.mjs chrome` 接 `firefox` 三組並行，總耗時 460 秒。

| 命令                                             | 結果                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `pnpm typecheck --skip-nx-cache`                 | 通過                                                                 |
| `pnpm test --skip-nx-cache`                      | 276／276：graph-core 69、graph-ui 39、extension-core 47、web 121     |
| `pnpm build --skip-nx-cache`                     | 通過（web、Chrome、Firefox）；web bundle 不含 `randomUUID`           |
| `pnpm --filter @adorable/extension-firefox lint` | 0 errors／0 notices／4 warnings（與基線相同）                        |
| `npx prettier --check .`、`git diff --check`     | 通過                                                                 |
| `node tools/e2e/diagnostics.mjs local`           | 通過：既有 App／Viewer 回歸、兩分頁 11 情境、非 secure context 18 項 |
| `node tools/e2e/diagnostics.mjs chrome`          | 通過                                                                 |
| `node tools/e2e/diagnostics.mjs firefox`         | 通過：清理回歸 4 案例、Firefox App 4 項、extension 流程              |
| GitHub CI `verify`（`19d41e3`）                  | 通過                                                                 |

Ink ratio（desktop／mobile）：local 0.0308／0.1184、Chrome 0.0308／0.1184、Firefox 0.0288／0.1181。

**資源清理證據**：執行後沒有殘留 browser、Vite、launcher 或 Xvfb 行程（只有已由 init 回收的 defunct 項目），`/tmp` 前後清單相同。

## 契約保留

- 唯讀 Git、固定 SHA、coverage／unknown、literal pathspec、禁 external diff／textconv／lazy fetch：`apps/web/plugins/*` 未變更，相關測試通過。
- Extension token 留在 background：`libs/extension-core` 未變更，Chrome／Firefox 流程通過。
- Host／Origin／loopback 查詢邊界：`vite.config.ts`、`tools/start.mjs` 未變更。

## 證據保存與限制

- 本次 logs 與 results JSON 只在容器的 Git 忽略目錄（`apps/*/e2e/.artifacts/diagnostics`）與 session 暫存區，沒有推送，容器結束後不保留；本頁是摘要，不是 receipt，沒有簽章。
- [rd-open-p1.md](rd-open-p1.md) 列出的本機 `apps/web/e2e/.artifacts/governance/` 原始證據不在 Cloud checkout 中：本次未取得、未修改、未重建，也不以本頁取代。

## 尚未驗證

- 獨立正式 review、fixed-SHA 綁定、host-signed receipt 與 `sbw complete`（交回 Codex）。
- macOS、Chrome for Testing 153、使用者既有 profile、真實 token／private repo、Safari／iOS PWA。
- 延後 `storage` handler 以 capture listener 暫存並重新派送模擬，不是真實分頁凍結；同一 context 的分頁通常共用 renderer。
- Firefox 只做 DOM 與請求層級檢查；逐 committed frame 檢查只在 Chromium。
- 升級過渡期殘留風險同 [rd-p1-fix-validation.md](rd-p1-fix-validation.md)：仍開著的舊版 bundle 分頁不輪替 generation，也沒有本次的寫入前檢查。
- Credential 無法讀取的分頁在錯誤後明確重試時不做基準比對（沒有基準可比）。

## 正式驗收待辦（`19d41e3` 時，已由第二輪取代）

1. 取得適用授權後，以 `19d41e3` 建立 fixed-SHA 綁定與 production 產物，保留本機既有治理證據。
2. 由授權方建立新的正式 review／治理額度（本次未建立），提供本頁、[rd-p1-fix-validation.md](rd-p1-fix-validation.md) 與 [rd-open-p1.md](rd-open-p1.md)。
3. 視需要在 macOS、Chrome for Testing、本機 Firefox 補跑三套 `diagnostics.mjs`。
4. 取得獨立 review 與 host-signed receipt 後由 `sbw complete` 判定；在此之前維持 HOLD，原始 BLOCK 不改為 PASS。

## 第二輪：`2eb2e47`

受測 SHA：`2eb2e47fb3900f9472affde0ce1a6aa9c342e826`（parent `0cbed56`）。Codex 核對 `19d41e3`／`0cbed56` 後，確認 P1 跨分頁覆寫回歸通過，另提出兩項 P2；兩項都只在測試工具，產品程式與 `19d41e3` 相同。

| 問題                                                                                                          | 修正                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `app-auth-firefox.mjs`：失敗紀錄在 catch 內、清理之前寫入；寫入拋錯（或讀頁面不回應）會跳過清理並取代原始錯誤 | 失敗紀錄改為獨立的 best-effort 範圍，讀頁面最多等 3 秒；紀錄錯誤加入 `cleanupErrors`，仍拋出原始失敗，清理一定執行 |
| `app-auth-firefox-cleanup.mjs`：launch 案例使用 `/bin/false`，macOS 沒有此路徑                                | 改用 `process.execPath`：Node 會真的啟動並因 Firefox 參數立即結束，Linux／macOS／Windows 都適用                    |

**新增回歸**：清理案例 `record`（驗證失敗，且 artifacts 目錄不存在使紀錄寫入失敗）。

- 修正前（`19d41e3` 的 helper）：子程序 120 秒內沒有自行結束；Firefox 程序與 `/tmp/agg-ff-app-profile-*` profile 遺留。遺留的 probe 程序與 profile 已手動清除。
- 修正後：子程序自行結束（exit 0）；原始錯誤保留；`cleanupErrors` 只有「failure record: ENOENT …」；listener 拒絕連線、Firefox 程序已結束、profile 已移除。

**清理回歸 5 案例結果**（`2eb2e47`）：

| 案例      | 子程序結束 | 清理錯誤                                 | Firefox 程序 |
| --------- | ---------- | ---------------------------------------- | ------------ |
| `build`   | 0          | 無                                       | 未啟動       |
| `launch`  | 0          | 無                                       | 未取得       |
| `record`  | 0          | `failure record: ENOENT …`               | 已結束       |
| `verify`  | 0          | 無                                       | 已結束       |
| `cleanup` | 0          | `injected: fixture: cleanup step failed` | 已結束       |

**命令與結果**（`2eb2e47`，乾淨工作樹，三組並行，479 秒）：

| 命令                                        | 結果                                                                                                                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck`／`pnpm test`／`pnpm build` | 通過；tests 276／276（graph-core 69、graph-ui 39、extension-core 47、web 121）                                                                                                                                                       |
| Firefox lint、prettier、`git diff --check`  | 0 errors／4 warnings（與基線相同）；通過；通過                                                                                                                                                                                       |
| `node tools/e2e/diagnostics.mjs local`      | 通過：兩分頁 11 情境、非 secure context 18 項、既有回歸                                                                                                                                                                              |
| `node tools/e2e/diagnostics.mjs firefox`    | 通過：清理回歸 5 案例、Firefox App 4 項、extension 流程                                                                                                                                                                              |
| `node tools/e2e/diagnostics.mjs chrome`     | 第一次在並行負載下失敗：`waitForEvent('serviceworker')` 15 秒逾時，發生在任何測試本體之前（與 [rd-validation.md](rd-validation.md) 已列的 service worker 啟動逾時相同）；單獨重跑一次通過。本 PR 未變更 extension 程式，原因仍未定位 |

Ink ratio（desktop／mobile）：local 0.0308／0.1184、Chrome（重跑）0.0308／0.1184、Firefox 0.0288／0.1181。執行後沒有殘留 browser、Vite、launcher 或 Xvfb 行程；`/tmp` 沒有新增項目（Firefox 自行移除一個 `MozillaUpdateLock-*` 鎖檔）。

### 尚未驗證（第二輪）

- 同「尚未驗證」一節；另外 Chrome extension background service worker 偶發啟動逾時尚未定位（重跑通過）。
- macOS 上的清理回歸由 Codex 本機驗證（本次只在 Linux 執行）。

### 正式驗收待辦（現行，交回 Codex）

1. 以 `2eb2e47` 建立 fixed-SHA 綁定與 production 產物，保留本機既有治理證據。
2. 由授權方建立新的正式 review／治理額度（本次未建立），提供本頁、[rd-p1-fix-validation.md](rd-p1-fix-validation.md) 與 [rd-open-p1.md](rd-open-p1.md)。
3. 在 macOS 補跑 `diagnostics.mjs firefox`（含清理回歸）與 local／chrome。
4. 取得獨立 review 與 host-signed receipt 後由 `sbw complete` 判定；在此之前維持 HOLD，原始 BLOCK 不改為 PASS。
