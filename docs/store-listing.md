# 商店上架資料（Chrome Web Store / Firefox AMO）

可以直接複製貼上的表單內容。欄位名稱依 2026-10 的後台介面整理；後台改版時以實際欄位為準。

## 0. 上架前 checklist

- [ ] `main` 已包含要上架的版本；`apps/extension/package.json` 與 `apps/extension-firefox/package.json` 的 `version` 一致（目前 `0.2.0`；每次上架都要比商店上的版本大）
- [ ] Firefox e2e 在 macOS 跑過：`pnpm --filter @adorable/extension-firefox e2e`（雲端容器沒有 Firefox）
- [ ] Chrome：`pnpm --filter @adorable/extension release` → `apps/extension/release/adorable-git-graph-chrome-<version>.zip`
- [ ] Firefox：`pnpm --filter @adorable/extension-firefox release` → `web-ext-artifacts/` 的 add-on zip 與 `adorable-git-graph-source.zip`
- [ ] 截圖與宣傳圖：第一次先裝 Chromium（`pnpm --filter @adorable/extension exec playwright-core install chromium`；Google Chrome 正式版不能載入未封裝的 extension），再執行 `pnpm --filter @adorable/extension store-assets`（自己的電腦，需要連得到 github.com；預設拍 `stephen-taipei/adorable-git-graph`，可加 `-- --repo owner/name`；詳情截圖預設自動挑沒有內文、沒被 revert 的 commit，也可以用 `-- --detail <sha>` 指定）
- [ ] 隱私權政策網址可以打開：<https://github.com/stephen-taipei/adorable-git-graph/blob/main/PRIVACY.md>
- [ ] Chrome 開發者帳號（一次性註冊費）、AMO 帳號

## 1. 共用文案

**名稱**：Adorable Git Graph

**一句話（Chrome summary ≤ 132 字元 / AMO summary ≤ 250 字元）**

> See any GitHub repository's history as a cartoon-style, animated git graph — branches, merges, tags and commits at a glance.

**說明（英文）**

```
Adorable Git Graph turns the history of any GitHub repository into a friendly, animated git graph — right on github.com.

• Every commit is a little ball with a face; branches are flowing pipes; merges and forks grow by themselves.
• A git log --graph style list, newest on top: SHA, author, date, branch / tag / HEAD labels and conventional-commit types.
• Search by message, author, SHA, branch or tag; focus a single branch and see how far ahead it is.
• Click a commit for the full message, parents / children, which branches contain it, and a link to GitHub.
• Scroll to the bottom to load older history. Follows GitHub's light / dark mode. Works on phones and desktops.
• Three themes to switch between: Candy, Hacker imp and Halloween pumpkin.
• Keyboard friendly: j / k / ↑ / ↓, Home / End, / to search, Esc to close.

Read-only and private by design:
• Only talks to the GitHub API (api.github.com). No analytics, no tracking, no servers of ours.
• Optional fine-grained, read-only GitHub token for higher rate limits and private repositories. It is stored only in your browser and sent only to api.github.com.

Open any repository on github.com and click the Git Graph button (or the toolbar icon).
Source code (Apache-2.0): https://github.com/stephen-taipei/adorable-git-graph
Also available for your local repositories: npx @stephen.taipei/adorable-git-graph
```

**說明（繁體中文）**

```
Adorable Git Graph 把任何 GitHub repo 的歷史畫成可愛、會動的 git graph，直接在 github.com 上使用。

• 每個 commit 是一顆有表情的小球，branch 是流動的管線，merge / fork 會自己長出來。
• 類似 git log --graph 的列表，最新的在最上面：SHA、作者、日期、branch / tag / HEAD 標籤與 commit 類型。
• 可依訊息、作者、SHA、branch、tag 搜尋；聚焦單一 branch，看它領先幾個 commit。
• 點 commit 看完整訊息、parent / child、包含它的 branch，以及在 GitHub 開啟。
• 捲到底載入更早的歷史；跟隨 GitHub 的淺色 / 深色模式；手機與桌機都能用。
• 三種主題可切換：糖果、駭客小惡魔、萬聖節南瓜。
• 鍵盤操作：j / k / ↑ / ↓、Home / End、/ 搜尋、Esc 關閉。

唯讀、重視隱私：
• 只連到 GitHub API（api.github.com），沒有分析、追蹤，也沒有我們自己的伺服器。
• 可選填 fine-grained、唯讀的 GitHub token 以提高請求額度並讀取私有 repo；token 只存在你的瀏覽器，只會送往 api.github.com。

打開 github.com 上的任一 repo，點右下角的 Git Graph 按鈕（或工具列圖示）即可。
原始碼（Apache-2.0）：https://github.com/stephen-taipei/adorable-git-graph
本機 repo 版：npx @stephen.taipei/adorable-git-graph
```

**圖片**（`apps/extension/store-assets/`）

| 檔案                                                | 用途                                                     |
| --------------------------------------------------- | -------------------------------------------------------- |
| `screenshot-1-graph.png` … `screenshot-5-theme.png` | 1280×800 截圖（Chrome 至少 1 張、最多 5 張；AMO 也可用） |
| `promo-small-440x280.png`                           | Chrome 小型宣傳圖（必填）                                |
| `promo-marquee-1400x560.png`                        | Chrome marquee 宣傳圖（選填）                            |
| `libs/extension-core/assets/icons/icon-128.png`     | 商店圖示 128×128                                         |

## 2. Chrome Web Store

**商品詳細資料**

- 類別：Developer Tools（開發人員工具）
- 語言：English（另可加繁體中文的本地化說明）
- 首頁網址 / 支援網址：`https://github.com/stephen-taipei/adorable-git-graph`、`https://github.com/stephen-taipei/adorable-git-graph/issues`

**隱私權做法（Privacy practices）**

- 單一用途說明：

  > Shows the commit history of the GitHub repository you are viewing on github.com as an interactive, animated git graph.

- 權限理由：

  | 權限                                  | 理由（貼到表單）                                                                                                                                                               |
  | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `storage`                             | Stores the user's settings (optional GitHub token, number of branches / commits, display preferences) and a short-lived cache of GitHub API responses, locally in the browser. |
  | Host `https://api.github.com/*`       | Fetches branches, commits and tags of the repository the user is viewing from the GitHub REST API. No other host is contacted.                                                 |
  | Content script `https://github.com/*` | Adds the Git Graph button and the graph overlay to GitHub repository pages. Nothing is rendered on non-repository pages.                                                       |

- 遠端程式碼：**No, I am not using remote code**（所有 JS 都在套件內；只抓 JSON 資料）。
- 資料使用（勾選會處理的類別）：
  - **Authentication information** — 使用者自填的 GitHub token（選填）：只存在本機、只送往 api.github.com。
  - **Web history** — 目前瀏覽的 GitHub repo（owner / 名稱，取自網址）會送到 api.github.com 以取得歷史。
  - 其他類別不勾。
- 三項聲明全部勾選：不販售或轉移給第三方（核准用途除外）、不用於與單一用途無關的目的、不用於判斷信用或放款。
- 隱私權政策網址：`https://github.com/stephen-taipei/adorable-git-graph/blob/main/PRIVACY.md`

**發布設定**：可見度 Public；地區 All regions。第一次審查時間不固定，通常數天。

## 3. Firefox AMO

- 上傳：`web-ext-artifacts/adorable_git_graph-<version>.zip`；「是否需要原始碼」選 **Yes**，上傳 `adorable-git-graph-source.zip`
- 相容：Firefox（桌面）。Android 未測試，第一次上架建議不要勾 Android
- 類別：Web Development（若後台已改名，選最接近「開發者工具」的類別）
- 授權：Apache License 2.0
- 隱私權政策：貼上 PRIVACY.md 的內容或網址
- 支援網址：`https://github.com/stephen-taipei/adorable-git-graph/issues`
- 附加元件 ID：`adorable-git-graph@stephen.taipei`（manifest 內建，上架後不能改）

**給審查員的說明（Notes to Reviewer）**

```
Build from the attached source (adorable-git-graph-source.zip):
  Node.js >= 22.18, pnpm 10.28 (pinned in package.json "packageManager")
  pnpm install --frozen-lockfile
  pnpm --filter @adorable/extension-firefox build
  → apps/extension-firefox/dist (identical to the uploaded package)

web-ext lint: 0 errors. The 4 UNSAFE_VAR_ASSIGNMENT warnings come from react-dom internals
(dangerouslySetInnerHTML handling); the add-on's own source never uses innerHTML.

Data collection: the repository the user is viewing (owner/name from the github.com URL) is sent to
api.github.com to fetch its history → required "browsingActivity". An optional GitHub token entered on
the options page is sent only to api.github.com as an Authorization header → optional "authenticationInfo";
consent is requested when the user saves a token, and without it the token is neither stored nor sent.
No data is sent to the developer or any other party.

To test: open https://github.com/stephen-taipei/adorable-git-graph and click the "Git Graph" button
at the bottom right (or the toolbar icon). No account or token is needed.
```
