# 開發與發布細節

> 給貢獻者與維護者的完整技術說明。使用方式請看 [README](../README.zh-TW.md)。

「比較與變更」面板的設計與限制：[RD 診斷文件](rd-diagnostics.md)、[驗證紀錄](rd-validation.md)、[RD 試用方案](rd-pilot.md)。

[npm CLI](#npm-套件cli) · [Web app](#web-apppnpm-start) · [Chrome extension](#chrome-extensionappsextension) · [Firefox extension](#firefox-extensionappsextension-firefox) · [開發與 e2e](#開發與-e2e) · [專案結構](#專案結構) · [運作原理](#運作原理)

## npm 套件（CLI）

```bash
cd ~/code/some-repo
npx @stephen.taipei/adorable-git-graph            # 開啟瀏覽器；也可以 npx @stephen.taipei/adorable-git-graph ~/code/other --port 4300 --no-open
```

與 `pnpm start` 是同一個畫面、同一套本機 repo endpoint（`libs/git-local`（`@adorable/git-local`）的 `serveLocalRepos`），差別：

- 不需要 Vite：`apps/cli/src/server.ts` 是獨立的 `node:http` server，提供預先建置好的畫面（`VITE_AGG_SERVER=1` 建置，**bundle 不含任何 git 歷史**），
  即時更新用 SSE（`/__agg/events`）取代 HMR。
- 只綁 `127.0.0.1`；每個請求都做與 dev server 相同的 Host / 同源檢查（DNS rebinding、其他 localhost 埠的頁面都讀不到）。
- 零 runtime 相依（server 與 graph-core 打成單一 `dist/server.mjs`）；需要 Node ≥ 22 與 `git`。
- 環境變數與 `pnpm start` 相同（`AGG_MAX_COMMITS`、`AGG_REPO_ROOTS`…）；手動加入的路徑記在 `local-repos-cli.json`。

```bash
pnpm --filter ./apps/cli build   # → apps/cli/dist（web/ + server.mjs）與 LICENSE
pnpm --filter ./apps/cli e2e     # npm pack 後從 tarball 執行：內容檢查、即時更新、repo 選單、跨來源 / Host / 路徑穿越
cd apps/cli && npm publish               # 發布（prepack 會重新建置）；第一次發布前先 npm pack --dry-run 檢查內容
```

## Web app（`pnpm start`）

- 預設讀**本機 git**（Vite plugin 執行 `git log`）：離線可用、不吃 GitHub rate limit、包含尚未 push 的 commit / branch。
- **即時更新**：在終端機 `git commit` / 切 branch / `git fetch`，畫面會自己長出新的小球（不用重新整理，由 HMR 推送）。
  只有**新增**的 commit 會彈出來；你正在看的位置與選取的 commit 不會被重設（如果你本來就在最上面，新的 commit 直接出現在眼前）。
  偵測方式：逐層監看 `.git` 的 `HEAD` / `packed-refs` / `refs/**` 目錄（不用遞迴 `fs.watch`，它在 Linux 上第二次 commit 起就會漏事件），
  另有每 2 秒比對 ref 清單的安全網；git 暫時出錯時保留上一張好的圖，不會讓 dev server 掛掉。
- **選擇本機 repo**（只有 dev server）：`📍 本機` 旁的選單列出預設 repo（★）與它**同層資料夾**裡的 git repo
  （往下找 3 層；一般 repo、worktree、`*.git` bare repo 都算；不進入 `.` 開頭與 `node_modules` / `dist` / `build` 等資料夾（後者本身就是 repo 時仍會列出），不跟隨 symlink、不往 repo 裡面找）。
  選了之後網址變成 `/?local=<id>`（可加書籤、上一頁 / 下一頁可用），那個 repo 一樣即時更新
  （最多同時監看 4 個非預設 repo，最久沒看的先停；10 分鐘沒人看的也會停，再選到時重新開始）。
  清單外的 repo：按選單旁的 `＋`（開啟其他路徑…）輸入**絕對路徑**（可用 `~`，repo 裡的子資料夾或 `.git` 也可以）；
  加入過的路徑由 dev server 記在使用者的 state 目錄：`~/.local/state/adorable-git-graph/local-repos-<專案雜湊>.json`
  （`$XDG_STATE_HOME`；Windows 為 `%LOCALAPPDATA%\adorable-git-graph\`；`AGG_LOCAL_REPOS_FILE` 可改位置），重開後仍在清單裡；要移除就編輯或刪掉這個檔案。
  選單可以用鍵盤上下瀏覽：停下來（或按 Enter）才會切換，不會每經過一個 repo 就讀一次。
  回到這個分頁時清單會重新掃描（剛 `git clone` 的 repo 會出現）。
- **更早的歷史**：捲到底會自動載入下一批（本機一次多 300 筆，最多 5000 筆；GitHub 從每條 branch 缺的 parent 往回各抓一頁），
  載入時不會移動你正在看的位置、不會重播動畫；失敗時頁尾顯示「再試一次」，不會自己一直重試。靜態建置沒有後端可讀，維持「更早的歷史已省略」。
  診斷面板的涵蓋範圍（commit 數、是否讀到歷史起點）跟著載入的範圍更新。
- 標題列下方的 `📍 本機 | 🐙 GitHub`：切到 GitHub 後輸入 `owner/repo` 或 GitHub 網址（也可直接開 `/?repo=owner/repo`），
  從瀏覽器直接呼叫 GitHub REST API（與 extension 同一套 `fetchGitHubGraph`），結果快取 10 分鐘。
  未登入每小時 60 次，點 ⚙ 可貼入 fine-grained PAT（只存 localStorage、只送往 `api.github.com`；更換 / 清除 token 會一併清掉快取）。
- 🌓 切換 自動 / 白天 / 夜晚主題（會記住）；點 commit：有 GitHub remote 就開 commit 頁，否則複製完整 sha。
- 環境變數：`AGG_REPO_DIR`（要看哪個 repo，預設就是本專案；一般 repo、bare repo、shallow clone 都可以）、
  `AGG_MAX_COMMITS`（預設 300，不再被 layout 偷偷截成 400）、`AGG_MAX_BRANCHES`（預設 8）、
  `AGG_DEFAULT_BRANCH`（預設依序：`origin/HEAD` → `main` → `master` → 目前 branch；`main` 或 `origin/main` 兩種寫法都可以）。
  例如預設改看另一個專案：`AGG_REPO_DIR=~/code/other pnpm start`。
  選單的掃描範圍：`AGG_REPO_ROOTS`（以 `:` 分隔，Windows 為 `;`，可用 `~`；預設是預設 repo 的上一層）、`AGG_REPO_SCAN_DEPTH`（預設 3）。
  例如：`AGG_REPO_ROOTS=~/code:~/work pnpm start`。掃描上限 5000 個資料夾 / 300 個 repo / 3 秒，超過時選單會提示清單不完整。
- `pnpm --filter @adorable/web build && pnpm --filter @adorable/web preview`：靜態版，**把建置當下的 git 快照烤進 bundle**。

> ⚠️ 靜態版的 bundle 只含 **commit 的第一行（subject）與作者名稱**，不含 email 與 commit 本文（`Signed-off-by` / `Co-authored-by` 等 trailer 不會被讀進來）。
> 但 subject、作者名與 branch / tag 名稱仍是公開資訊：**不要把私有 repo 的建置結果公開部署**。
> dev server 預設只綁 `localhost`；`/__agg/git-snapshot`、`/__agg/repos` 只存在於 dev、只回應同源請求（其他 localhost 埠上的頁面讀不到，e2e 有驗證），不會出現在 build 中。
> 偽造的 `Host`（DNS rebinding）會先被 Vite 自己的 host 檢查擋掉。瀏覽器選 repo 時只送出 server 算出的 id（realpath 的雜湊），不會送路徑；
> 唯一的例外是「開啟其他路徑」：那是使用者自己輸入的路徑，server 只接受同源頁面送來的 `application/json` POST（跨站表單 / no-cors 請求送不出，fetch 會被 CORS preflight 擋下），
> 不接受 Windows 的 UNC / 裝置路徑，路徑也不存放在瀏覽器（`localhost:<port>` 這個 origin 會被其他專案的 dev server 共用）。
> repo 清單、手動加入路徑與「預設以外」的 repo 只回應**這台電腦**的連線：`pnpm start -- --host` 讓手機連進來時，其他裝置只看得到預設 repo（它本來就在 bundle 裡）；
> 記錄路徑的檔案也放在專案外（Vite 不會把它當靜態檔案提供）。注意：經由 tunnel / reverse proxy 轉進 localhost 的連線，在 dev server 看來就是這台電腦；
> HMR 會廣播給所有連線，所以其他 repo 的更新只送「有變」的通知，內容要經由只回應本機的 endpoint 拿。
> 掃描只檢查資料夾裡有沒有 `.git`，不會在清單上的每個 repo 執行 git；只有你選了某個 repo，dev server 才會在那裡執行唯讀的 git 指令（等同你自己在那裡打 `git log`）。
> git 一律以 PATH 裡的**絕對路徑**執行：repo 裡放了一個 `git` / `git.exe` 也不會被執行（Windows 會先在工作目錄找執行檔，所以不能直接用 `git` 這個名字）。
> repo id 沒有加密鹽：知道你某個 repo 完整路徑的網站，可以把你導向 `/?local=<id>` 讓 dev server 開始監看那個 repo（讀不到內容，只會多跑幾個唯讀的 git 指令）。
> 靜態版沒有後端可重讀 git，因此不顯示重新整理按鈕。
> `pnpm build` 不使用 Nx 快取 web（快照是建置當下的 git 狀態，不是檔案內容的函數）。

## Chrome extension（`apps/extension`）

載入到 Chrome：`chrome://extensions` → 開啟「開發人員模式」→「載入未封裝項目」→ 選 `apps/extension/dist`。
然後打開任一 GitHub repo（例如 `https://github.com/stephen-taipei/adorable-git-graph`）：

- 右下角出現 **Git Graph** 小球按鈕（或點工具列圖示）→ 開啟全螢幕卡通 git graph；操作方式見 README 的「介面」
- 跟隨 GitHub 的 light / dark 模式（白天 / 星空夜景）；介面語言預設依瀏覽器語言，標題列 🌐 可切換（41 種，見[多語系](#多語系)）
- 開啟時後面的 GitHub 頁面不會被捲動、按鍵不會觸發 GitHub 的快捷鍵（在搜尋框打字很安全）

> 安裝後，**已開啟的 GitHub 分頁需重新整理一次**，content script 才會注入。

### Chrome Web Store 上架

```bash
pnpm --filter @adorable/extension release        # 乾淨 working tree → 正式建置 → 產物檢查 → release/adorable-git-graph-chrome-<version>.zip
pnpm --filter @adorable/extension store-assets   # 在自己的電腦上（要連得到 github.com）：store-assets/ 的 1280×800 截圖 ×4 與宣傳圖
```

商店表單（說明、權限理由、資料揭露）與 AMO 的審查說明見 [store-listing.md](store-listing.md)。

## Firefox extension（`apps/extension-firefox`）

需求：Firefox **≥ 140**（ESR 140 以上；原因見下方「AMO 上架」）。

```bash
pnpm --filter @adorable/extension-firefox build     # → apps/extension-firefox/dist
```

- **臨時載入**：開啟 `about:debugging#/runtime/this-firefox` →「載入暫時性附加元件…」→ 選 `apps/extension-firefox/dist/manifest.json`（關掉 Firefox 就會移除）。
- **開發時自動載入**：`pnpm --filter @adorable/extension-firefox start`（`web-ext run`，會開一個乾淨的 Firefox 並載入，並開到本專案的 GitHub 頁面；用 `pnpm dev:firefox` 另開終端機 watch 建置）。
- 使用方式、畫面與 Chrome 版完全相同（同一份原始碼、同一套 `GitGraphViewer`）。
- Firefox 的 MV3 把 host 權限當成使用者可撤銷的「網站存取」：若在附加元件設定裡關掉 `github.com` 的存取，浮動按鈕就不會出現，點工具列圖示會看到 `!` 徽章。

**與 Chrome 版的差異**（manifest 全部在 `libs/extension-core/scripts/manifest.mjs`；另外 vite 轉譯目標依瀏覽器各取其最低版本，`build.mjs` 內一行；應用程式碼沒有分支）

|            | Chrome                        | Firefox                                                                   |
| ---------- | ----------------------------- | ------------------------------------------------------------------------- |
| background | `service_worker`              | `scripts`（event page；Firefox 的 MV3 沒有 service worker）               |
| 識別       | —                             | `browser_specific_settings.gecko.id`（GUID）+ `strict_min_version: 140.0` |
| 其他       | `minimum_chrome_version: 116` | `gecko_android.strict_min_version: 142.0`、`data_collection_permissions`  |

event page 閒置 30 秒會被停掉，而以 `sendResponse` 非同步回覆的訊息不會延長它的壽命（背景若改成回傳 Promise 則可以，目前沒這樣做），
所以 background 對 GitHub 的請求設了 25 秒上限（`AbortSignal.timeout`；兩個瀏覽器共用同一份程式，逾時顯示「網路錯誤」而不是莫名失敗）。

### AMO 上架（addons.mozilla.org）

```bash
git status                                         # 必須是乾淨的（已 commit）：source zip 取自 HEAD
pnpm --filter @adorable/extension-firefox release  # 一條龍：以乾淨環境建置 → 檢查產物 → lint → 打包 add-on → 打包 source zip
```

`release`（`apps/extension-firefox/scripts/release.mjs`）做的事，也可以分開跑：

```bash
pnpm --filter @adorable/extension-firefox build           # 注意：會吃環境裡殘留的 AGG_* 變數（開發 / e2e 用）；release 會先清掉
pnpm --filter @adorable/extension-firefox lint            # web-ext lint：目前 0 個錯誤
pnpm --filter @adorable/extension-firefox package         # → web-ext-artifacts/adorable_git_graph-<version>.zip
pnpm --filter @adorable/extension-firefox package:source  # → web-ext-artifacts/adorable-git-graph-source.zip（git archive HEAD；working tree 不乾淨會拒絕）
```

- **原始碼要一起上傳**：bundle 是壓縮過的（React、three.js），AMO 審查要求提供原始碼與建置步驟。`package:source` 產生的壓縮檔含 `pnpm-lock.yaml`；
  建置方式：Node ≥ 22.18、pnpm 10.28，`pnpm install --frozen-lockfile && pnpm --filter @adorable/extension-firefox build`。
  審查說明可寫：`web-ext lint` 的 4 個 `UNSAFE_VAR_ASSIGNMENT` 警告來自 react-dom 內部（`dangerouslySetInnerHTML` 的處理），本專案原始碼沒有 `innerHTML`。
- **`gecko.id` 是永久身分**：`adorable-git-graph@stephen.taipei`（2026-10-13 首次上架前決定）。上架後再換 = 另一個附加元件，使用者與更新都不會延續，**不要再改**。
- **`strict_min_version` 為什麼是 140**：`data_collection_permissions` 是 Firefox 140（Android 142）才有的欄位，宣告它就不能把最低版本設得更低（`web-ext lint` 會警告）。
- **資料收集宣告**：`required: ["browsingActivity"]`（目前瀏覽的 repo 來自網址，會送到 `api.github.com`）、
  `optional: ["authenticationInfo"]`（使用者自填的 token）。設定頁儲存 token 時才請求同意（`libs/extension-core/src/shared/consent.ts`）；
  沒有同意或之後在附加元件管理員撤銷，就不儲存 / 不送 token，照未登入的方式抓。Chrome 沒有這個機制，不受影響。
- Firefox for Android 沒有測試過，`gecko_android` 只是為了讓 manifest 通過檢查。

## 開發與 e2e

```bash
pnpm start --repo ~/code/repo  # 看指定 repo（省略 --repo 則看本專案）
pnpm start            # web app（http://localhost:4200）
pnpm dev              # Chrome extension watch build（改完到 chrome://extensions 按重新載入）
pnpm dev:firefox      # Firefox extension watch build
pnpm typecheck        # nx run-many -t typecheck
pnpm test             # vitest：layout 演算法、git log 解析、GitHub client、URL 解析、設定、git 快照 plugin
pnpm e2e              # 真實瀏覽器：web app + Chrome extension + Firefox extension 端到端（見下）
```

`pnpm e2e` 會一次一套（`--parallel=1`）跑 Chrome extension、web、Firefox extension 三套端到端測試（順序由 nx 決定）。

三套的共同重點：列資訊與順序、**捲動時線圖與文字列對齊**（捲到好幾個位置，包含超過 canvas 緩衝距離的大跳躍與列表尾端，
對每一列的小球中心取樣截圖像素）、搜尋 / branch 聚焦 / 詳情 / 鍵盤、三種寬度的 RWD（無橫向溢出、底部面板不蓋住被選取的列）、
重新整理保留捲動位置與選取、夜間主題、錯誤畫面、token 不外洩。細節見各 `e2e/run.mjs` 開頭的註解與步驟名稱。

**Chrome extension**（`apps/extension/e2e`）：build 一份指向 mock GitHub API 的 extension → 用 Chromium（`--headless=new`）載入 →
在假的 `github.com` 頁面上驗證 FAB、overlay、繪圖、頁面不被捲動、按鍵不洩漏到頁面、Esc 分層、404 / rate-limit 錯誤畫面、快取命中與強制重抓、設定頁與 token 傳遞，截圖輸出到 `apps/extension/e2e/.artifacts/`。
**web**（`apps/web/e2e`）：啟動真正的 dev server，對一個臨時建立的 git repo 驗證本機快照、**commit / 建 branch 後畫面即時更新且不重新整理**（含捲動錨定）、
連續多次 commit / 切 branch、cross-origin 讀不到 dev endpoint、本機 repo 選單（掃描範圍、切換 / 上一頁 / deep link、選到的 repo 即時更新、手動輸入路徑與錯誤訊息、跨站無法新增路徑、窄螢幕不溢出）、GitHub 來源切換（輸入驗證、404、rate limit、deep link 與快取、token 不外洩且移除後不留帶 token 的快取）、
主題記憶、本機 build + preview（快照烤進 bundle、無 Refresh、dev endpoint 不存在）、
infinite scroll（本機 705 筆 / GitHub mock：捲到底分批載入、不跳動不重播、錯誤與再試一次）、詳情面板寬 / 窄切換。

**Firefox extension**（`apps/extension-firefox/e2e`）：用 puppeteer-core 經 WebDriver BiDi 驅動**真正的 Firefox**，載入打包後的 add-on（等同「載入暫時性附加元件」），
頁面由本機假的 github 伺服器提供（e2e 版 manifest 額外比對 `http://127.0.0.1/*`，所以跑的不是正式 manifest；正式 manifest 由單元測試、`web-ext lint` 與 `release` 的產物檢查把關）。
除了三套共同的檢查，還包含：頁面在 overlay 後面不能捲動也被設為 inert（Tab 進不去，GitHub 換掉 `<body>` 後也一樣）、按鍵不洩漏到頁面、點背景關閉、快取與強制重抓、夜間主題、SPA 換頁的錯誤畫面、
**真的按下工具列按鈕**（`action.onClicked` → `tabs.sendMessage`）、沒有 content script 的頁面顯示 `!` 徽章、從設定按鈕開 `moz-extension://…/options.html` 並驗證 token 只以 Bearer header 送出、
以及 **event page 被終止後**（直接呼叫 Firefox 內部的 `terminateBackground()`，確認狀態為 `stopped`）下一個請求能喚醒它並正常回應。
另外，結尾會檢查 content script、event page、options 頁都沒有未捕捉的 console 錯誤，token 也不得出現在頁面（含 shadow DOM）或任何 URL。
需求：Firefox（`FIREFOX_PATH` 可指定）與 Xvfb（headless Firefox 沒有 EGL，WebGL 要靠虛擬顯示器；或用 `xvfb-run` 包起來）。
找不到 Firefox 時會提示並略過，設了 `CI` 或 `REQUIRE_FIREFOX` 則視為失敗。

三套的截圖輸出到各自的 `e2e/.artifacts/`。Chrome extension 的 e2e 與 `store-assets` 要用 **Chromium**：Google Chrome 正式版（137 起）會忽略 `--load-extension`，extension 不會載入。第一次先執行 `pnpm --filter @adorable/extension exec playwright-core install chromium`，或用 `CHROME_PATH` 指向 Chromium / Chrome for Testing。web app 的 e2e 找不到 Chrome 時設定 `CHROME_PATH`；`FIREFOX_PATH` 指向不存在的檔案會直接報錯（不會悄悄改用別的 Firefox）。

## 多語系

- 字串都在 `libs/graph-ui/src/i18n/locales/<tag>.json`（41 個語系，BCP 47）；形狀以 `en.json` 為準，`zh-Hant-TW.json` 是原始中文文案。
  缺的 key 執行時退回英文；`catalogs.test.ts` 檢查每個檔案的 key、佔位符（`{n}` 等）、各語言需要的複數形（`Intl.PluralRules`）與商店摘要長度（≤ 132 字）。
- 新增字串：先加到 `en.json` 與 `zh-Hant-TW.json`，再補其他語系（測試會列出缺的）。複數用 `{ "one": …, "other": … }`，類別依語言而不同（俄文 one/few/many/other、中日韓只有 other）。
- 語系清單、顯示名稱、瀏覽器語言對應（`zh-CN` → 简体中文、`zh-HK` → 繁體中文（香港）、拉丁美洲西語 → `es-MX`、`no` → `nb`…）在 `i18n/locales.ts`。
- 選擇：預設跟隨瀏覽器（`navigator.languages`）；🌐 選單的選擇記在 web 的 `localStorage`（`agg.locale`）或 extension 的 `chrome.storage.local`（`locale`）。web 換語言會重新載入頁面；extension 即時切換。
- 載入：web 每個語系是獨立 chunk，只下載用到的；extension 的 content script 是單一 IIFE，語系檔放在 `dist/locales/`，由 background 讀取（不用 web_accessible_resources）。
- extension manifest 的 description / 工具列提示用 `_locales/<code>/messages.json`（建置時由語系檔產生）。Chrome 與 Firefox 的代碼不同，也不是每個語系都有：

| 語系                | Chrome               | Firefox    | 語系       | Chrome        | Firefox       |
| ------------------- | -------------------- | ---------- | ---------- | ------------- | ------------- |
| zh-Hant-TW          | zh_TW                | zh_TW      | nb         | no            | nb_NO         |
| zh-Hans             | zh_CN                | zh_CN      | es         | es            | es_ES         |
| zh-Hant、zh-Hant-HK | —（manifest 用英文） | —          | es-MX      | es_419        | es_MX         |
| my、km、lo          | —                    | my、km、lo | pt / pt-BR | pt_PT / pt_BR | pt_PT / pt_BR |

其他語系兩邊都用同一個代碼（ja、ko、th、ar…）。沒有對應的語系只影響商店摘要與工具列提示，extension 內的介面仍然是該語言。

- 版面不做 RTL 鏡像（線圖的幾何是由左到右）；阿拉伯文、希伯來文的字串本身由瀏覽器的 bidi 正確顯示。

## 專案結構

```
apps/
  web/                  Vite + React：pnpm start 的 localhost 版
    plugins/            git-snapshot：Vite 接線，把 libs/git-local 掛到 dev server，提供 virtual:git-snapshot、經 HMR 推送新快照
    src/                SourceBar（本機 / GitHub 切換、本機 repo 選單）、TokenDialog、useGraphSource、localRepos
  extension/            Chrome（MV3）：只有建置入口、圖示產生器與 e2e，原始碼都在 libs/extension-core
  extension-firefox/    Firefox（MV3）：建置入口、web-ext 的 lint / package / run、e2e（puppeteer + 真實 Firefox）
  cli/                  npm 套件 @stephen.taipei/adorable-git-graph：獨立 node:http server（SSE）+ 預先建置的 web 畫面、e2e（npm pack 後執行）
libs/
  git-local/            本機 git 執行環境（node 端，web dev server 與 cli 共用）：執行唯讀 git log / 診斷、監看 .git refs、
                        掃描本機 repo、依 id 提供快照的 endpoint 與 Host / 同源檢查；`./protocol` 是瀏覽器也能用的協定
  extension-core/       兩個瀏覽器共用的 extension：background、content script（Shadow DOM 掛載 FAB + overlay）、options 頁、
                        建置（content/background 打成 IIFE）與 manifest 產生器、圖示
  graph-core/           純 TS、零相依：型別、lane 配置演算法、GitHub REST client、git log 解析、demo 資料
  graph-ui/             three.js 場景 + React viewer（extension 與 web app 共用）
tools/e2e/              e2e 共用：Chrome 偵測、mock GitHub API（含 CORS）、假的 GitHub 頁面、截圖像素判斷
```

- `graph-core` / `graph-ui` / `git-local` 以 `exports → src/index.ts` 提供原始碼，由使用端 bundler 編譯，不需獨立 build；`extension-core` 例外：它是建置工具 + 原始碼套件（`exports` 為 `./build`、`./manifest`、`./icons`），由兩個 extension app 呼叫。
- `graph-core` 與 `git-local` 是 **Node 可直接執行的 TS**（相對 import 帶 `.ts`、`erasableSyntaxOnly`），所以 `vite.config.ts` 與腳本能直接 import 它們。
- UI/UX 全部在 `graph-ui`（`GitGraphViewer`），web app 與 extension 只負責資料來源與外框。
- 兩個瀏覽器版本的原始碼是同一份（`libs/extension-core`）；差異只在 manifest（`createManifest({ target })`）與 vite 轉譯目標，manifest 有單元測試鎖住。
- Nx 的 `build` 快取已把 `AGG_*` 環境變數算進 hash（它們會改變產物），所以 dev / e2e 的建置不會被當成正式版從快取還原；`pnpm --filter … build` 本來就繞過 Nx。

## 運作原理

1. **資料**：background 以 GitHub REST API 抓 repo → default branch + 目前瀏覽的 branch + open PR 分支（其餘依序補到上限，預設 5 條），
   各抓最近 60 筆 commit，以 sha 合併成 DAG，另抓 tags。commit 分兩階段抓：先抓 default 與瀏覽中的 branch，
   其餘 branch 的 head 已經在載入的歷史裡就不再請求（ref 照樣顯示），所以最多 `分支數 + 4` 次請求，
   常見的「branch 都已合併」情況只要 5–6 次。結果快取 10 分鐘（`chrome.storage.local`）。
   成功回應的 `x-ratelimit-*` 標頭記在 `GraphData.rateLimit`（不進快取）；剩餘額度偏低時列表上方會提示加入 token。
2. **佈局**（`graph-core/layout.ts`）：children-first 拓樸排序 → 類 `git log --graph` 的 lane 配置；
   列 = 排序後的位置（0 = 最新）、欄 = lane（default branch 固定在第 0 欄）；每條 lane 有固定顏色；
   邊先沿自己的 lane 垂直走，只在靠近 parent 的一列以 S 曲線轉進它的 lane，避免穿過其他節點。
   `graph-core/insights.ts` 提供統計、可到達性（「包含於哪些 branch」、領先幾個 commit）與搜尋。
3. **繪圖**（`graph-ui/scene`）：正交相機 + `MeshToonMaterial`（3 階色）+ inverted-hull 描邊；
   表情、腮紅、皇冠等以 canvas 貼圖；管線用自製 ribbon geometry + shader（描邊 / 流動箭頭 `>` / reveal 動畫）。
   一個 WebGL canvas 只畫「可視範圍 + 上下緩衝」的**視窗**（400 列 × 44px 會超過貼圖上限），而且放在**捲動內容裡面**、
   和 DOM 列一起由合成器捲動，所以線圖與文字列永遠對齊、不會有一個 frame 的錯位；捲到緩衝快用完才重新定位並重畫。
   hover / 選取 / 搜尋淡化都由 DOM 列驅動，canvas 只負責畫（`pointer-events: none`）。
   進場由上往下依序彈出（只播目前可視範圍）；有新 commit 時，只有可視範圍附近的新球彈出來。
4. 尊重 `prefers-reduced-motion`（略過進場與閒置晃動）；分頁隱藏時暫停渲染。
