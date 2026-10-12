# RD 診斷：尚未完成的兩項 P1

更新日期：2026-10-12。使用者已授權將 `Solid/rd-diagnostics-claude` 推到 GitHub，讓 Claude 修正以下兩項 P1，並保留既有驗收證據。

本頁是 GitHub 可讀的缺陷與驗收說明。完整本機交接檔仍由共享交接工具管理，不加入本 repo。

## 固定基線與驗收狀態

- 受測產品 source：`3eb1cb832ebae0bb9de8146931203ec014d16b81`。
- 最新正式結果：**BLOCK**。實際 reviewer 為 `gpt-6-astra`／`max`，完整觀察 46／46 manifest paths。
- Run：`sbw-20261011T201955Z-a8a3cc81d327`。
- Package：`review-5b6fe6a1273d586ad1e10f84bf7feec7`。
- 原始結果 SHA-256：`646480f71df5bb9c74a68694a0b7c6b977aaf19af2d1e60146884131e1038480`。
- 兩項缺陷已使用該 source 的 production bundle、隔離瀏覽器、合成認證與 intercepted network 重現。

先前 250 項測試、4 個 typecheck targets、3 個 production builds，以及 localhost／Chrome for Testing 153／Firefox isolated 流程通過。這些結果沒有涵蓋以下兩個失敗情境，不能代替正式驗收。

## P1：HTTP 區網頁面初始化當機

涉及 [App.tsx](../apps/web/src/App.tsx) 的 `persistViewerNonce()`、`initialAuthentication()` 及認證儲存失敗處理。

這些路徑直接使用 `crypto.randomUUID()`。一般非 loopback HTTP 是非 secure context，不提供這個 API。初始化與 fallback 都可能拋出錯誤，使 React App 進入 ErrorBoundary。

### 重現

1. 使用隔離瀏覽器載入受測 production bundle，將頁面 origin 設為非 loopback HTTP，例如 `http://lan.rd.fixture.test/`。測試攔截網路並提供合成資料。
2. 清除該頁面的 nonce，確認 `window.isSecureContext === false`、`typeof crypto.randomUUID === 'undefined'`。
3. 載入真正 App。
4. 原始重現顯示當機提示，且 `.web-root` 不存在。`crypto.getRandomValues` 仍為可用函式。

### 修正驗收

- 非 secure context 必須仍能顯示 App 與預設 repo。
- 非秘密 scope ID 的產生不得依賴 secure-context-only API。
- 初始讀取、nonce 寫入／讀回、credential 寫入／讀回失敗時，App 必須保持可用，且拒絕恢復不確定的舊狀態。
- 不放寬 Host／Origin／loopback 查詢邊界，不開啟新的區網 Git 查詢權限。
- 用真正 App 補回歸，不能只測 HTTP status。ErrorBoundary 也有 `.agg-root`，所以以 `.web-root` 與實際功能確認成功。

## P1：跨分頁認證變更後恢復舊 Viewer 狀態

涉及 [App.tsx](../apps/web/src/App.tsx) 的 credential、nonce、`viewerStateKey` 與 adapter 生命週期。

Credential 使用共享 `localStorage`，nonce 使用分頁獨立的 `sessionStorage`。B 分頁改認證後，A 重載會讀到新 credential，卻沿用舊 nonce，讓新 adapter 接收到舊認證範圍的選取。

### 重現

1. 同一 origin 開啟兩個真正 App 分頁 A、B，以合成 API 與合成 credential 測試。
2. A 在認證範圍 A 選取一個 SHA，保存目前 Viewer 狀態。
3. B 更換 credential，然後重新載入 A。
4. 原始重現中 A 的 nonce 未變，新 credential 下收到 1 次舊選取 SHA 的 request。
5. 另外覆蓋 B 清除 credential、A 保持開啟及 A 重載的情境。

### 修正驗收

- Shared credential 與非秘密認證代次必須一致；恢復 Viewer 前須確認代次。
- 處理必要的跨分頁變更／清除事件，取消舊請求並清除舊結果與選取。
- 每個新認證的 first committed frame 都不得包含舊結果或舊選取；新 adapter 收到舊選取 SHA 的 request 數必須為 0。
- Viewer key 不得包含 raw token 或 token hash。
- 保留同認證、同 repo／URL 的焦點恢復，URL precedence、fork／圖外 commit 恢復與儲存部分失敗行為。
- 保留既有同分頁 17 項實際 App 回歸，補上真正兩分頁 change／clear／reload 測試。

本次使用者已授權 Claude 修正上述兩項 P1 及其必要回歸。先前「即時跨分頁同步延後」不能用來略過本項必要的認證隔離，也不擴大為其他產品功能。

## 既有證據保存

完整原始檔仍留在本機的 `apps/web/e2e/.artifacts/governance/`，該目錄由 Git 忽略，不會隨分支推送。遠端 clone 取得本頁摘要，不能假設已取得完整 logs、screenshots、signed runtime 或 receipt。

必須保留以下檔案及其既有 bytes：

- `receipts/final-native-review-3eb1cb8.json` 與 `receipts/final-native-review-3eb1cb8.json.receipt.json`。
- `receipts/web-final-native-block-reconciled.json`。
- `readonly-block-reproductions/read-only-production-reproduction.json` 與兩張重現圖片。
- `probes/final-3eb1cb8-readonly-probe.mjs`。
- `receipts/web-auth-actual-app-red.log`、`receipts/web-auth-actual-app-green.log`、baseline binding 與 dependency-resolution 紀錄。
- 工程 tests／typecheck／build／browser logs、`receipts/web-final-fixed-sha-artifacts.json` 與固定 production 產物。
- Campaign ledger、已簽 `task-runtimes/campaign-exception-13/bundle` 與全部歷史。

新增修正與驗證另存新紀錄，不覆寫舊結果。原始 BLOCK 不得改成 PASS。

## 接續檢查與交付邊界

1. 以本分支與上述固定基線開始，先核對目前 checkout、workspace package resolution 及 source；不要使用已移除的 Codex 暫存 worktree。
2. 先補真正 HTTP 非 secure context 與兩分頁認證回歸，再完成修正。
3. 按 repo scripts 執行 tests、typecheck、build 與三種 isolated 流程，禁用舊 cache。E2E 入口為 `node tools/e2e/diagnostics.mjs local`、`chrome`、`firefox`；先完成 dependencies、build 及合格 browser preflight。
4. 保留唯讀 Git、固定 SHA、coverage／unknown、literal pathspec、禁 external diff／textconv／lazy fetch，以及 extension token 留 background 的契約。
5. 原 campaign `campaign-41b66b43bd4f86a8fb0a6cac89a94aad` 維持 13／13，唯一限定 final claim 已用完。本次授權處理兩項 P1，不授權改寫舊 ledger、擴大 signer／allowlist、重置額度或把舊 review 重新綁定。
6. 將修正保留為待正式驗收的候選版本。新的正式 review／治理額度仍須適用的授權與 gates；未通過時保持 HOLD，不以本機檢查代替獨立正式驗收。
7. 此次僅授權這個工作分支的 GitHub 推送。Merge、npm／extension 商店及公開服務發佈另需授權。

既有 [RD 驗證紀錄](rd-validation.md) 是前一階段紀錄；最新兩項 P1 與 BLOCK 以本頁所列固定結果為準。
