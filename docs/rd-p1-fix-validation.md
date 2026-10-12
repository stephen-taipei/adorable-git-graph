# RD 診斷：兩項 P1 修正驗證紀錄

驗證日期：2026-10-12。本頁是 [RD 診斷：尚未完成的兩項 P1](rd-open-p1.md) 的修正與工程驗證紀錄，另存新檔，不覆寫既有結果。

## 狀態

- **兩項 P1 已修正，待獨立正式驗收。**
- 原始正式結果維持 **BLOCK**（`3eb1cb8`、Run `sbw-20261011T201955Z-a8a3cc81d327`、Package `review-5b6fe6a1273d586ad1e10f84bf7feec7`，見 [rd-open-p1.md](rd-open-p1.md)）。本頁是工程檢查，不是正式驗收，不解除 BLOCK／HOLD。
- 原 campaign `campaign-41b66b43bd4f86a8fb0a6cac89a94aad` 維持 13／13。本次沒有修改舊 ledger、signed runtime、signer／allowlist，也沒有建立新的 run、package 或 campaign。

## 受測版本與環境

| 項目           | 值                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 分支           | `Solid/rd-diagnostics-claude`                                                                                                  |
| 受測 SHA       | `f20038e66ddcb5377d3fef563586baffa4699ed7`（修正與回歸測試）。本頁所在 commit 只變更 `docs/`，不改產品程式或測試。             |
| 修正前         | `3a236e6b07f756e3049830a672186a2c5aaad986`；其 `apps/web/src/App.tsx` 與產品基線 `3eb1cb8` 相同（SHA-256 `85f0bf3c…899b84`）。 |
| 執行環境       | Claude Code cloud container，Ubuntu 24.04，Node 22.22.0，pnpm 10.28.0                                                          |
| 瀏覽器         | Playwright Chromium 141.0.7390.37（`/opt/pw-browsers`），Firefox 157.0.1（`xvfb-run` 提供顯示器）                              |
| Git            | 2.52.0，以官方 `v2.52.0` tag 原始碼編譯於 session 暫存區（理由見「環境差異」）                                                 |
| Package 解析   | `@adorable/*` 為 pnpm workspace symlink，指向本 checkout 的 `libs/*`，exports 指向 `./src/index.ts`；Nx 全程 `--skip-nx-cache` |
| Synthetic 資料 | 自建暫存 Git repo、合成 credential、瀏覽器內攔截的 GitHub API；不連外、不使用真實 token                                        |

## 修正內容

### P1：HTTP 區網頁面初始化當機

- 非秘密 scope ID 改由 `crypto.getRandomValues` 產生（[authScope.ts](../apps/web/src/authScope.ts) `opaqueId()`），不再使用 secure-context-only 的 `crypto.randomUUID`。極端環境沒有 Web Crypto 時也不拋錯。
- 初始讀取、scope 寫入／讀回、generation 寫入、credential 寫入／讀回失敗時，App 保持可用；不確定狀態一律使用不持久化的 scope，並移除已持久化的 scope record，因此同頁與重載都不恢復舊焦點。
- 未修改 `vite.config.ts`、`tools/start.mjs`、`apps/web/plugins/*`；Host／Origin／loopback 查詢邊界不變。

### P1：跨分頁認證變更後恢復舊 Viewer 狀態

| Storage                              | 位置           | 內容                                                                                             | 寫入時機                                       |
| ------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `agg.github-token`                   | localStorage   | credential（格式不變）                                                                           | TokenDialog 儲存／清除                         |
| `agg:auth-generation:v1`（新）       | localStorage   | 隨機、非秘密 generation                                                                          | 每次 credential 寫入前先輪替                   |
| `agg:viewer-auth-nonce:v1`（新格式） | sessionStorage | `{v:2, nonce, generation}`；nonce 為隨機 ID，generation 為所綁定的值（尚無版本化寫入時為空字串） | 分頁採用某個 generation 時；舊版 UUID 值不採用 |

- 儲存順序：先寫本分頁 scope record，再輪替 generation，最後寫 credential，三者都讀回確認；任一步失敗即 fail closed（顯示錯誤、不恢復舊狀態）。
- 恢復 Viewer 前，分頁以一次一致讀取取得 credential 與 generation（偵測到並行寫入時重讀），只有 scope record 綁定的 generation 相同才沿用原 scope。
- 開啟中的分頁處理 `storage` 事件（credential、generation 或 `clear()`），另在 `pageshow`（bfcache）、回到前景與掛載後各重新核對一次。偵測到變更即採用新 credential 與新 scope：同一個 commit 內 viewer scope 改變，舊 graph、選取、診斷結果被丟棄，舊 adapter 的請求取消，並清除本分頁 GitHub graph 快取。
- Viewer key 仍為 `[sourceKey, commit, pull, nonce]`。Generation、scope record 與 viewer key 都不含 raw token 或 token hash。既有 `agg:gh:*` graph 快取沿用其 module 內 fingerprint（原設計，未變更）。

## 重現與修正結果

修正前結果的取得方式：在工作樹暫時還原 `3a236e6` 的 `apps/web/src/App.tsx`，搭配與受測 commit 位元組相同的測試檔（`tools/e2e/app-auth-isolation.mjs` SHA-256 `88e0fc32…c74e2`、`tools/e2e/diagnostics.mjs` SHA-256 `f552b471…74db5b`）執行，之後還原並以 `cmp` 確認。

| 情境                                              | 修正前                                                                                                                              | `f20038e`           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 非 loopback HTTP（`http://lan.rd.fixture.test/`） | `isSecureContext=false`、`randomUUID` undefined、`getRandomValues` 可用；顯示 ErrorBoundary「The view crashed」，`.web-root` 不存在 | 18／18 項通過       |
| 兩分頁：同 credential，B 開啟後 A 重載恢復焦點    | 通過                                                                                                                                | 通過                |
| 兩分頁：B 更換 credential，A 保持開啟後重載       | A 未採用新 credential（逾時）                                                                                                       | 通過，舊 SHA 請求 0 |
| 兩分頁：B 更換 credential，A 立即重載             | 恢復舊選取，新 credential 下 1 次舊 SHA 請求                                                                                        | 通過，舊 SHA 請求 0 |
| 兩分頁：A 離開期間 B 更換 credential，A 回來      | 恢復舊選取，新 credential 下 1 次舊 SHA 請求                                                                                        | 通過，舊 SHA 請求 0 |
| 兩分頁：B 清除 credential，A 保持開啟後重載       | A 未採用匿名狀態（逾時）                                                                                                            | 通過，舊 SHA 請求 0 |
| 兩分頁：B 清除 credential，A 立即重載             | 恢復舊選取，匿名狀態下 1 次舊 SHA 請求                                                                                              | 通過，舊 SHA 請求 0 |
| 兩分頁：A 離開期間 B 清除 credential，A 回來      | 恢復舊選取，匿名狀態下 1 次舊 SHA 請求                                                                                              | 通過，舊 SHA 請求 0 |
| 既有同分頁 17 項實際 App 回歸                     | 17／17 通過                                                                                                                         | 17／17 通過         |

回歸測試內容（[app-auth-isolation.mjs](../tools/e2e/app-auth-isolation.mjs)，由 `node tools/e2e/diagnostics.mjs local` 執行）：

- 兩分頁：同一 browser context 的兩個真正 App 分頁，每個情境使用新的 context。React Profiler 記錄每個 committed frame；從 A 丟棄舊 graph 的 frame 起，所有 frame 不得有舊選取、檔案清單或 patch，新 adapter 的舊 SHA 請求必須為 0。保持開啟情境另讓一個舊 credential 請求懸置，確認放行後的遲到結果不會進入畫面。離開情境以同源靜態檔確認 A 的 tab storage 在回來前未被 App 改動（事件確實錯過）。每個情境檢查 credential 本身以外的 storage 沒有 raw token，viewer／focus／inspection／scope／generation 紀錄沒有 token SHA-256。
- 非 secure context：本 checkout 的 production bundle（`vite build`，預設設定）由瀏覽器攔截後以 `http://lan.rd.fixture.test/` 提供，GitHub API 為合成回應，其他請求一律中止並記錄。以 `.web-root`、預設 repo 3 個 commits、設定儲存、Bearer 認證的 GitHub graph、診斷查詢、同 credential 重載恢復與 credential 變更後不恢復確認功能；再覆蓋初始 credential 讀取、scope 讀取、scope 寫入失敗，以及儲存時 scope 寫入／讀回、generation 寫入、credential 寫入／讀回失敗（同頁與重載）。全程沒有請求逃出攔截，LAN origin 只請求 `/`、JS、CSS 與 favicon，沒有 `/__agg` endpoint。
- 單元測試（[authScope.test.ts](../apps/web/src/authScope.test.ts)，20 項）：無 `randomUUID`／無 Web Crypto 的 ID、同分頁恢復、他分頁變更／清除後不恢復、舊格式 record、讀寫失敗、並行寫入的讀取、儲存順序與失敗時不改 credential、record 不含 credential 材料。

## 命令與結果（受測 SHA `f20038e`，乾淨工作樹）

環境變數：`NX_DAEMON=false NX_SKIP_NX_CACHE=true NX_ISOLATE_PLUGINS=false`，`PATH` 前置 Git 2.52.0。

| 命令                                                 | 結果                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm typecheck --skip-nx-cache`                     | 通過（4 targets）                                                          |
| `pnpm test --skip-nx-cache`                          | 270／270 通過：graph-core 68、graph-ui 39、extension-core 47、web 116      |
| `pnpm build --skip-nx-cache`                         | 通過（web、Chrome、Firefox）                                               |
| `pnpm --filter @adorable/extension-firefox lint`     | 0 errors／0 notices／4 warnings（與先前基線相同的 React `innerHTML` 警告） |
| `npx prettier --check .`                             | 通過                                                                       |
| `git diff --check`                                   | 通過                                                                       |
| `node tools/e2e/diagnostics.mjs local`               | 通過；含既有 3 組 App／Viewer 回歸、兩分頁 7 情境、非 secure context 18 項 |
| `node tools/e2e/diagnostics.mjs chrome`              | 通過（Chromium 141 隔離 profile）                                          |
| `xvfb-run -a node tools/e2e/diagnostics.mjs firefox` | 通過（Firefox 157 隔離 profile）                                           |

E2E 的 desktop／mobile ink ratio：local 0.0308／0.1184、Chrome 0.0308／0.1184、Firefox 0.0519／0.1181。測試結束後已確認沒有殘留的 browser、Vite、launcher 或 Xvfb 行程；自建暫存 repo、production bundle 與 profile 由測試移除，另手動移除一個 vitest 暫存目錄。

### 環境差異

- 容器內建 Git 2.43.0 不支援 `--no-lazy-fetch`，產品依設計拒絕本機查詢，local E2E 無法進行。另有 2 項既有 `plugins/diagnostics.test.ts` 需要 Git 2.52 的 `diff --max-depth`，在 2.51.2 下於修正前後都失敗。因此以官方 `v2.52.0` 原始碼編譯 Git，只放在 session 暫存區並前置於 `PATH`；未修改產品程式或系統 Git。
- Linux headless Firefox 沒有顯示器時沒有 WebGL，`diagnostics.mjs firefox` 會在 WebGL ink 檢查逾時（「WebGL is not available」），因此以 `xvfb-run` 執行。這是環境設定，未修改測試。

## 契約保留

- 唯讀 Git、固定 SHA、coverage／unknown、literal pathspec、禁 external diff／textconv／lazy fetch：`apps/web/plugins/*` 未變更，相關測試通過。
- Extension token 留在 background：`libs/extension-core` 未變更，Chrome／Firefox 流程通過。
- 同認證同 repo／URL 焦點恢復、URL precedence、圖外／fork commit 恢復與儲存部分失敗：既有回歸全數通過，兩分頁測試另確認 credential 變更後再選取仍可於同 credential 重載恢復。

## 證據保存與限制

- 本次 logs、screenshots 與 results JSON 產生在容器內 Git 忽略的 `apps/*/e2e/.artifacts/diagnostics` 與 session 暫存區，沒有推送；容器結束後不保留。本頁是摘要，不是 receipt，沒有簽章。
- [rd-open-p1.md](rd-open-p1.md) 列出的本機 `apps/web/e2e/.artifacts/governance/` 原始證據不在 Cloud checkout 中；本次沒有讀取、修改或重建，也沒有以本頁取代。

## 尚未驗證

- 獨立正式 review、fixed-SHA 綁定、host-signed receipt 與 `sbw complete`。
- macOS、Chrome for Testing 153、使用者既有 profile、真實 token／private repo。
- Web App 兩分頁與非 secure context 回歸只在 Chromium 執行；Firefox、Safari／iOS PWA 未覆蓋這兩組情境（Firefox 流程只涵蓋 extension）。
- `pageshow`（bfcache 返回）與回到前景的重新核對沒有 E2E；只由程式與單元層面覆蓋 `syncAuth`。
- Credential 與 generation 是兩個 localStorage key，不是原子寫入。寫入端先輪替 generation，讀取端重讀並在 credential 變更時再換 scope；各瀏覽器跨分頁的 storage 套用順序沒有逐一驗證。
- 升級過渡期：仍開著的舊版 bundle 分頁更換 credential 時不會輪替 generation。新版開啟中分頁仍會因 credential 變更換 scope，但當時未載入的新版分頁之後回來可能沿用舊 scope；舊分頁重新整理後消失。
- 試用成功率與任務時間未實測。

## 正式驗收待辦

1. 取得適用授權後，以 `f20038e` 建立 fixed-SHA 綁定與 production 產物，並保留本機既有治理證據。
2. 由授權方建立新的正式 review／治理額度（本次未建立 run、package 或 campaign），提供本頁與 [rd-open-p1.md](rd-open-p1.md) 給 reviewer。
3. 視需要在 macOS、Chrome for Testing、本機 Firefox 補跑 `diagnostics.mjs local／chrome／firefox`。
4. 取得獨立 review 與 host-signed receipt 後由 `sbw complete` 判定；在此之前維持 HOLD，原始 BLOCK 不改為 PASS。
