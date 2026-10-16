# adorable-git-graph

Cartoon-style, animated git graph for your **local** repositories, in your browser.

```bash
cd your-repo
npx adorable-git-graph
```

- Every commit is a little ball with a face; branches are flowing pipes; newest at the top, like `git log --graph`.
- **Live**: commit, switch branches or fetch in your terminal and new commits pop in without reloading.
- **Pick other repos** next to this one from the menu, or open any path on your computer.
- **Read-only**: it only runs read-only `git` commands. It listens on `127.0.0.1` only, and other sites or
  ports cannot read its data.
- No runtime dependencies. Needs Node.js 22+ and `git`.

## Usage

```
adorable-git-graph [repo] [options]

  repo                 Repository to show (default: AGG_REPO_DIR, else the current directory)
  -p, --port <port>    Port to listen on (default: 4200, or the next free one)
      --no-open        Do not open the browser
  -h, --help           Show help
  -v, --version        Show the version
```

| Environment variable   | Default                                                  | Meaning                                                           |
| ---------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| `AGG_MAX_COMMITS`      | `300`                                                    | Commits read at first (scroll to the bottom for more, up to 5000) |
| `AGG_MAX_BRANCHES`     | `8`                                                      | Branches drawn                                                    |
| `AGG_DEFAULT_BRANCH`   | `origin/HEAD` → `main` → `master` → current              | Branch shown in the first lane                                    |
| `AGG_REPO_ROOTS`       | the repo's parent folder                                 | Folders scanned for the repo menu (`:`-separated, `;` on Windows) |
| `AGG_REPO_SCAN_DEPTH`  | `3`                                                      | How deep the scan goes                                            |
| `AGG_LOCAL_REPOS_FILE` | `~/.local/state/adorable-git-graph/local-repos-cli.json` | Where paths you add are remembered                                |

The page can also show any GitHub repository (🐙 GitHub); that talks to `api.github.com` directly from your browser.

There is also a Chrome extension and a Firefox add-on that show the same graph on github.com.
Source, docs and privacy policy: <https://github.com/stephen-taipei/adorable-git-graph>.

## License

Apache-2.0
