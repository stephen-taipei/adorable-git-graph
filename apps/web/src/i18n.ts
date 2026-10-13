import { detectLocale } from '@adorable/graph-ui';
import type { Locale } from '@adorable/graph-ui';

const zh = {
  local: '本機',
  github: 'GitHub',
  repoPlaceholder: 'owner/repo 或 GitHub 網址',
  go: '前往',
  themeAuto: '配色：跟隨系統',
  schemeLabel: (id: string) =>
    `配色：${({ light: '淺色', dark: '深色' } as Record<string, string>)[id] ?? id}`,
  themeIdCandy: '主題：糖果（點一下切換）',
  themeIdHacker: '主題：駭客小惡魔（點一下切換）',
  themeIdHalloween: '主題：萬聖節南瓜（點一下切換）',
  themeLoading: '正在載入主題…',
  themeFailed: '主題載入失敗，請確認連線後重試。',
  themeRetry: '重試',
  localTitle: '本機 repository',
  tokenTitle: 'GitHub Token（選填）',
  tokenHelp: '未登入每小時只能呼叫 60 次 GitHub API；加入 token 可提升到 5,000 次並讀取私有 repo。',
  tokenWarn:
    '請使用 fine-grained token，只勾要看的 repo，權限只開 Contents: Read-only 與 Metadata: Read-only，不要用有寫入權限的 token。Token 只存在這個瀏覽器的 localStorage，只會送往 api.github.com。',
  save: '儲存',
  clear: '清除',
  cancel: '取消',
  localHint: '正在讀取本機 git 歷史；有新 commit 時畫面會自己更新。',
  pickRepo: '選擇本機 repository',
  localUnlisted: '（不在清單中的 repository）',
  addPath: '開啟其他路徑…',
  pathLabel: 'git repository 的路徑',
  pathPlaceholder: '/path/to/repo 或 ~/code/repo',
  open: '開啟',
  reposTruncated: '…清單已達掃描上限（可用 AGG_REPO_ROOTS 指定資料夾）',
  reposFailed: '無法取得 repository 清單',
  pathErrors: {
    invalid_path: '請輸入路徑。',
    not_absolute: '請輸入絕對路徑（可以用 ~ 代表家目錄）。',
    not_found: '找不到這個資料夾。',
    not_git: '這個資料夾不在 git repository 裡。',
    unsafe_repo:
      'git 拒絕開啟這個 repository：它屬於另一個使用者（請用 git config --global --add safe.directory <路徑> 信任它）。',
    failed: '無法開啟（dev server 沒有回應）。',
  },
  localUnknown:
    'dev server 找不到這個本機 repository（可能已移動、刪除，或 dev server 重新啟動後不在掃描範圍內）。請從上方選單重新選擇。',
  localOffline: '連不到 dev server，無法讀取這個本機 repository。',
  localFailed: '無法讀取本機的 git 歷史。',
  localOnly: '只有在執行 dev server 的這台電腦上，才能選擇與讀取其他本機 repository。',
  snapshotErrors: {
    missing_dir: '找不到這個 repository 的資料夾（可能已移動或刪除）。',
    not_git: '這個資料夾不在 git repository 裡。',
    no_git: '找不到 git：請確認已安裝 git，而且在 PATH 裡。',
    unsafe_repo:
      'git 拒絕開啟這個 repository：它屬於另一個使用者（請用 git config --global --add safe.directory <路徑> 信任它）。',
    git_error: '無法讀取 git 歷史（git 回報錯誤）。詳細原因請看執行 dev server 或建置的終端機。',
  } as Record<string, string>,
};

const en: typeof zh = {
  local: 'Local',
  github: 'GitHub',
  repoPlaceholder: 'owner/repo or GitHub URL',
  go: 'Go',
  themeAuto: 'Colours: follow system',
  schemeLabel: (id: string) =>
    `Colours: ${({ light: 'light', dark: 'dark' } as Record<string, string>)[id] ?? id}`,
  themeIdCandy: 'Theme: Candy (click to switch)',
  themeIdHacker: 'Theme: Hacker imp (click to switch)',
  themeIdHalloween: 'Theme: Halloween pumpkin (click to switch)',
  themeLoading: 'Loading theme…',
  themeFailed: 'The theme could not be loaded. Check your connection and retry.',
  themeRetry: 'Retry',
  localTitle: 'Local repository',
  tokenTitle: 'GitHub token (optional)',
  tokenHelp:
    'Anonymous requests are limited to 60 GitHub API calls per hour. A token raises that to 5,000 and unlocks private repos.',
  tokenWarn:
    'Use a fine-grained token limited to the repos you want to view, with only Contents: Read-only and Metadata: Read-only. Never use a token with write access. It is stored in this browser’s localStorage and sent only to api.github.com.',
  save: 'Save',
  clear: 'Clear',
  cancel: 'Cancel',
  localHint: 'Reading your local git history; the view updates when you commit.',
  pickRepo: 'Choose a local repository',
  localUnlisted: '(repository not in the list)',
  addPath: 'Open another path…',
  pathLabel: 'Path to a git repository',
  pathPlaceholder: '/path/to/repo or ~/code/repo',
  open: 'Open',
  reposTruncated: '…scan limit reached (set AGG_REPO_ROOTS to pick folders)',
  reposFailed: 'Could not load the repository list',
  pathErrors: {
    invalid_path: 'Enter a path.',
    not_absolute: 'Enter an absolute path (~ for your home folder works).',
    not_found: 'That folder does not exist.',
    not_git: 'That folder is not inside a git repository.',
    unsafe_repo:
      'Git refuses to open this repository because it belongs to another user (trust it with: git config --global --add safe.directory <path>).',
    failed: 'Could not open it (the dev server did not respond).',
  },
  localUnknown:
    'The dev server does not know this local repository (it may have moved, been deleted, or fallen outside the scanned folders after a restart). Pick one from the menu above.',
  localOffline: 'Cannot reach the dev server to read this local repository.',
  localFailed: 'Could not read the local git history.',
  localOnly:
    'Other local repositories can only be chosen and read on the computer running the dev server.',
  snapshotErrors: {
    missing_dir:
      'The folder of this repository does not exist (it may have been moved or deleted).',
    not_git: 'This folder is not inside a git repository.',
    no_git: 'git was not found: make sure it is installed and on your PATH.',
    unsafe_repo:
      'Git refuses to open this repository because it belongs to another user (trust it with: git config --global --add safe.directory <path>).',
    git_error:
      'Could not read the git history (git reported an error). The details are in the terminal running the dev server or the build.',
  },
};

export const locale: Locale = detectLocale();
export const t = locale === 'zh-TW' ? zh : en;
