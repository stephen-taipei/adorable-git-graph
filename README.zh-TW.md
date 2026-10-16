<div align="center">

# Adorable Git Graph

**把 git 歷史畫成可以捲動的卡通。**

用 three.js 畫的動態 git graph，支援 GitHub repo 與本機 repo：每個 commit 是一顆有表情的小球，每條 branch 是流動的管線。唯讀，沒有我們自己的伺服器。

[![Version](https://img.shields.io/badge/version-0.1.0-2563EB?style=flat-square)](package.json)
[![npm](https://img.shields.io/npm/v/adorable-git-graph?style=flat-square&color=CB3837)](https://www.npmjs.com/package/adorable-git-graph)
[![Chrome](https://img.shields.io/badge/Chrome-MV3_%E2%89%A5116-4285F4?style=flat-square)](#chrome-擴充功能)
[![Firefox](https://img.shields.io/badge/Firefox-MV3_%E2%89%A5140-FF7139?style=flat-square)](#firefox-附加元件)
[![License](https://img.shields.io/badge/license-Apache--2.0-64748B?style=flat-square)](LICENSE)
[![CI](https://github.com/stephen-taipei/adorable-git-graph/actions/workflows/ci.yml/badge.svg)](https://github.com/stephen-taipei/adorable-git-graph/actions/workflows/ci.yml)

[English](README.md) · **繁體中文**

</div>

[安裝](#安裝) · [介面](#介面) · [主題](#主題) · [鍵盤](#鍵盤) · [隱私與安全](#隱私與安全) · [開發](#開發) · [已知限制](#已知限制) · [完整技術文件](docs/development.md)

![Adorable Git Graph：git log --graph 式列表，卡通 commit 小球、branch 標籤、作者、日期與 SHA](docs/images/hero.png)

## 這是什麼

Adorable Git Graph 把 repo 歷史畫成 `git log --graph` 式的列表（最新在最上面），旁邊是一條卡通線圖。三種形式共用同一套 UI：

| 形式                                  | 在哪裡用                          | 資料來源                             |
| ------------------------------------- | --------------------------------- | ------------------------------------ |
| [Chrome 擴充功能](#chrome-擴充功能)   | github.com 任一 repo 頁面上的按鈕 | GitHub REST API                      |
| [Firefox 附加元件](#firefox-附加元件) | 同 Chrome，同一份原始碼           | GitHub REST API                      |
| [`npx adorable-git-graph`](#npm-cli)  | 瀏覽器開 `localhost`              | 本機 `git`（也能看任何 GitHub repo） |

- 小球表情依 commit 類型：`feat` 大笑、`fix` 冒汗、merge 比較大顆、root 長嫩芽、default branch 最新 commit 戴皇冠。
- 每一列有 branch / tag / HEAD 標籤、merge 標記、conventional commit 類型、作者、日期與短 SHA（點一下複製）。
- 搜尋、branch 聚焦、commit 詳情、捲到底自動載入更早歷史、淺色 / 深色、手機到桌機都能用。
- **比較與變更**面板：選 base / head，看雙方各自獨有的 commit、changed files 與 lazy diff，摘要保留 SHA。說明見 [docs/rd-diagnostics.md](docs/rd-diagnostics.md)。

## 安裝

### Chrome 擴充功能

Chrome Web Store 與 Firefox Add-ons 正在審核中。上架前請從原始碼載入：

```bash
pnpm install
pnpm build                     # → apps/extension/dist
```

開啟 `chrome://extensions`，打開「開發人員模式」→「載入未封裝項目」→ 選 `apps/extension/dist`。之後打開任一 GitHub repo，點右下角的 **Git Graph** 按鈕或工具列圖示。

> [!NOTE]
> 安裝前已經開著的 GitHub 分頁，要重新整理一次按鈕才會出現。

### Firefox 附加元件

需要 Firefox 140 以上。

```bash
pnpm install
pnpm --filter @adorable/extension-firefox build   # → apps/extension-firefox/dist
```

開啟 `about:debugging#/runtime/this-firefox` →「載入暫時性附加元件…」→ 選 `apps/extension-firefox/dist/manifest.json`。關掉 Firefox 就會移除。

### npm CLI

給本機 repo 用，不需要 clone 本專案。需要 Node.js 22+ 與 `git`。

```bash
cd your-repo
npx adorable-git-graph
```

- **即時更新**：在終端機 commit、切 branch 或 fetch，新的 commit 會直接彈出來，不用重新整理。
- **切換 repo**：從選單選同層的其他 repo，或輸入電腦上任何路徑。
- 只綁 `127.0.0.1`。參數與環境變數見 [apps/cli/README.md](apps/cli/README.md)。

### 從原始碼跑 web app

```bash
pnpm install
pnpm start                       # http://localhost:4200，預設顯示本專案
pnpm start --repo ~/code/repo    # 看其他本機 repo
```

與 CLI 同一個畫面，由 Vite dev server 提供。細節見 [docs/development.md](docs/development.md#web-apppnpm-start)。

## 介面

![commit 詳情面板：完整訊息、完整 SHA、作者、日期與在 GitHub 開啟](docs/images/detail.png)

| 區域       | 內容                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| 線圖欄     | 一條 branch 一條 lane，default branch 在最左；fork / merge 以 S 曲線轉彎                                 |
| 每一列     | branch / tag / HEAD 標籤（★ default、☁ remote、⚑ tag）、類型標籤、作者、日期、短 SHA                     |
| 工具列     | 搜尋（訊息、作者、SHA、branch、tag，多個詞須同時符合）、統計、branch 篩選並顯示領先 default 幾個 commit  |
| 詳情       | 完整訊息與 SHA、parent / child、包含此 commit 的 branch、上一個 / 下一個、在 GitHub 開啟；⤢ 切換寬版面板 |
| 標題列按鈕 | 重播進場動畫、回到最新、重新抓取、切換主題、設定                                                         |
| 比較與變更 | base / head 比較、changed files、lazy diff、含 SHA 的摘要                                                |

版面依 viewer 本身寬度切換：寬螢幕詳情在列表右側並排，中螢幕是右側抽屜，手機是底部面板。尊重 `prefers-reduced-motion`。

## 主題

三種主題，各有淺色與深色，選擇會被記住。

| 糖果                             | 駭客小惡魔                             | 萬聖節南瓜                         |
| -------------------------------- | -------------------------------------- | ---------------------------------- |
| 預設：粉彩配色、綠色小圓球吉祥物 | 霓虹終端機配色、小惡魔吉祥物，小球長角 | 橘紫配色、南瓜吉祥物，小球戴巫師帽 |

![駭客小惡魔主題（深色）](docs/images/themes.png)

## 鍵盤

| 按鍵                    | 動作                                                |
| ----------------------- | --------------------------------------------------- |
| `↑` `↓` / `j` `k`       | 選取上一個 / 下一個 commit                          |
| `Home` `End`            | 跳到最新 / 已載入的最舊                             |
| `/`                     | 搜尋                                                |
| `Enter` / `Shift+Enter` | 下一筆 / 上一筆搜尋結果                             |
| `Esc`                   | 一次收一層：詳情 → 搜尋文字 → branch 聚焦 → overlay |

## 隱私與安全

- **唯讀**：任何地方都沒有 git 寫入操作。
- **會離開你電腦的資料**：擴充功能只連 `api.github.com` 與 GitHub 的頭像圖片。CLI 與 web app 在本機執行唯讀的 `git` 指令，只有你切到 GitHub repo 時，才由瀏覽器呼叫 `api.github.com`。
- **沒有分析、沒有追蹤、沒有我們自己的伺服器。** 完整政策：[PRIVACY.md](PRIVACY.md)。
- **選填 token**：fine-grained GitHub PAT 可把額度從每小時 60 次提高到 5,000 次，並讀取私有 repo。只授與 `Contents: Read-only` 與 `Metadata: Read-only`。token 只存在擴充功能的本機儲存空間，只有 background 讀取，只以 `Authorization` header 送往 `api.github.com`；頁面與 content script 都看不到。
- **最小權限**：`storage` + `https://api.github.com/*`；content script 只匹配 `https://github.com/*`。
- **本機 server**：只綁 `localhost` / `127.0.0.1`，資料 endpoint 只回應這台電腦的同源請求。

> [!WARNING]
> 靜態建置（`pnpm --filter @adorable/web build`）會把 commit subject、作者名稱與 branch / tag 名稱烤進 bundle。不要把私有 repo 的建置結果公開部署。

## 開發

需求：Node.js ≥ 22.18、pnpm（版本鎖在 `packageManager`）。

```bash
pnpm install
pnpm start          # web app：http://localhost:4200
pnpm dev            # Chrome 擴充功能 watch build
pnpm dev:firefox    # Firefox 擴充功能 watch build
pnpm typecheck
pnpm test           # vitest
pnpm build          # 建置全部
pnpm e2e            # 真實瀏覽器端到端：Chrome 擴充功能、web app、Firefox 附加元件
```

Chrome e2e 與商店截圖要用 Chromium（Google Chrome 137 起會忽略 `--load-extension`）。第一次先執行 `pnpm --filter @adorable/extension exec playwright-core install chromium`。

```
apps/
  web/                 pnpm start 的 Vite + React app
  extension/           Chrome MV3 建置入口、圖示、e2e
  extension-firefox/   Firefox MV3 建置入口、web-ext lint / package、e2e
  cli/                 npm 套件 adorable-git-graph
libs/
  extension-core/      兩個瀏覽器共用：background、content script、設定頁、manifest
  graph-core/          純 TS：型別、lane 配置、GitHub client、git log 解析
  graph-ui/            three.js 場景 + React GitGraphViewer、主題
tools/e2e/             e2e 共用：mock GitHub API、假的 github.com 頁面
```

其餘細節都在 [docs/development.md](docs/development.md)：線圖如何配置與繪製、web app 的所有選項與環境變數、e2e 涵蓋範圍、Chrome Web Store / AMO 上架步驟。商店文案在 [docs/store-listing.md](docs/store-listing.md)。

## 已知限制

- GitHub 來源第一次每條 branch 約讀 60 筆，更早的捲到底才分批載入，每批都要呼叫 API。
- 未設定 token 時 GitHub API 每小時只有 60 次，連續開多個 repo 會碰到 rate limit。
- 只支援 github.com，不含 GitHub Enterprise、GitLab；本機來源則任何 git repo 都可以。
- repo 選單只有 CLI 與 `pnpm start` 有；擴充功能讀的是 GitHub，不能選本機 repo。
- 沒有橫向模式與自由縮放：刻意的取捨，換來一致的捲動、搜尋與 RWD。
- 沒有 GPU（軟體 WebGL）時動畫會掉幀。
- Firefox 版在 Linux 與 macOS 的新版 Firefox 上測過；最低支援的 Firefox 140、Windows 與 Firefox for Android 沒有實測。

## 授權

[Apache-2.0](LICENSE) · [隱私權政策](PRIVACY.md) · 由 [stephen-taipei](https://github.com/stephen-taipei) 開發與維護。
