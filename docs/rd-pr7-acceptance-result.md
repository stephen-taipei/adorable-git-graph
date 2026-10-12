# RD 診斷：PR #7 正式驗收結果

**正式驗收：PASS。** 正式完成時間：2026-10-12 17:23（Asia/Taipei）。

本頁內容取自 repo owner 本機 Codex 正式驗收流程的回報，原始證據（`acceptance-result.json`、receipt、ledger 等）只存在 owner 本機的治理證據目錄，沒有隨 Git 推送。Cloud 環境沒有讀取或核對這些證據，本頁只是摘要，不是 receipt。

## 受測版本

| 項目              | 值                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 受測 candidate    | `2eb2e47fb3900f9472affde0ce1a6aa9c342e826`                                                                                        |
| Docs-only PR HEAD | `410aa672adc4d2af6ec0e1ae37f53c2b72dc7ea3`                                                                                        |
| 分支／PR          | `Solid/rd-diagnostics-claude`／[PR #7](https://github.com/stephen-taipei/adorable-git-grpah/pull/7)                               |
| 合併              | 以 merge commit 合併至 `main`：`1fe01c3a25049d513f8327c703437652e32ed39a`；合併前確認 HEAD 為 `410aa67`、CI `verify` 通過、無衝突 |
| 契約              | 原始 `code-change-v1`／`deep` 契約與驗收標準保留                                                                                  |

## 驗收項目

| 驗收項目                           | 結果                                                                       | 證據（owner 本機）                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 固定 SHA、原始 BASE、完整 sentinel | PASS                                                                       | `launch-preflight.json`、`caps.json`                                                         |
| 獨立 Astra/max review              | PASS，0 findings；實際讀取 54/54 檔案                                      | `native-result.json`、`native-result.json.receipt.json`、`actual-review-verification.json`   |
| Host-signed 精確 receipt           | PASS；Ed25519 signature，來源／package／sentinel／model／effort 綁定已核對 | `host-review-receipt-verification.json`                                                      |
| 原始 9 項 typed evidence           | PASS                                                                       | `native-critic-admission.json`、`diff-review-admission.json`、`final-evidence-admission.log` |
| 原始 4 個 execution stages         | complete                                                                   | run `ledger.json`                                                                            |
| `sbw complete`                     | `ok: true`，`status: completed`                                            | `completion.json`                                                                            |
| 清理與歷史保留                     | PASS                                                                       | `cleanup.json`、`preservation-check.json`                                                    |

Native review 的實際 transport 為 `gpt-6-astra`／`max`，Codex CLI `0.153.4`（屬原始 sealed runtime 支援清單，binary bytes 符合既有 allowlist）。新安裝的 CLI `0.162.1` 未用於本次 review。

## 工程驗證（owner 本機）

276/276 tests、typecheck、三套 production build、Prettier、diff check 通過；Firefox lint 0 errors／4 個既有 warnings；macOS local、Chrome for Testing 153.0.8010.12、Firefox 157.0.1 全流程通過；PR HEAD 的 GitHub CI `verify` 通過。正式驗收沒有重跑這些已通過的工程檢查。Cloud 端的工程驗證見 [PR #7 review 後續修正驗證紀錄](rd-pr7-followup-validation.md)。

## 歷史與授權

- Campaign `campaign-41b66b43bd4f86a8fb0a6cac89a94aad`，新增 run `sbw-20261012T084245Z-4bfcfb72709c`；限定一次正式 attempt，實際使用一次，新增修正額度 0。
- 13/13、原始 BLOCK、舊 claim 與 1,541 份既有證據保留；24 個固定 SHA production 檔案 hash 未變更。
- 作業中全域 ledger 被移至 `.better-workflows-V5`，原始 cache 路徑不存在。本輪使用 SHA-256 與原始值一致的封存 ledger，依原始 inventory 暫時重建 184 個 runtime 檔案與 1 份 ledger 副本供未修改的舊驗證器核對，完成後只清除本輪副本。未修改 plugin registry、key、signer、launcher、probe 或 allowlist。封存 ledger digest：`d8e5959d1fb2abbe6efe197b3f28d99df6afd1184aa914b63720cb9edc66847d`。
- Owner 原 checkout 之後觀察到 `main`／`3d52d79`，變更來源未驗證；正式驗收使用隔離的 candidate checkout，未切換或覆寫原 checkout。兩份暫時 checkout 已清除，四個 native review PID 均已退出。

## 歷史紀錄的效力

[rd-open-p1.md](rd-open-p1.md) 的原始 BLOCK、[rd-p1-fix-validation.md](rd-p1-fix-validation.md) 與 [rd-pr7-followup-validation.md](rd-pr7-followup-validation.md) 中的 HOLD 都是當時的歷史快照，不改寫。本次正式結果以本頁與 owner 本機 `acceptance-result.json` 為準。

## 尚未驗證與待追蹤

- Chrome extension background service worker 在 Cloud 並行負載下偶發初始啟動逾時，原因未定位（macOS 序列驗證一次通過）。
- 使用者既有瀏覽器 profile、真實 token、private repo 未測；未重載使用者已安裝的擴充套件。
- 全域 ledger 被移至 `.better-workflows-V5` 的來源與時間未說明，建議另行追查。
- Owner 原 checkout 變更為 `main`／`3d52d79` 的來源未驗證，再次使用前建議確認沒有未提交變更或意外歷史。
- 未執行 npm、Chrome Web Store、AMO 或公開服務發布。
