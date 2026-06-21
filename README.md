<div align="center">

<img src="public/logo.png" alt="Gitpervisor" width="128" height="128" />

# Gitpervisor

**A developer cockpit that supervises all your local projects from one window — Git status, side-by-side diffs, commit & push, an embedded terminal, a database workspace, a built-in browser for localhost previews, and live detection of what your AI coding agents are doing.**

_Think “JetBrains commit tool window × Windows Terminal × a DB client,” but multi-repo and IDE-free._

<br/>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?style=for-the-badge&logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-stable-000000?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org)

![Platform](https://img.shields.io/badge/platform-Windows%20·%20macOS%20·%20Linux-555?style=flat-square)
![Version](https://img.shields.io/badge/version-0.2.0-blue?style=flat-square)

<br/>

**English** · [한국어](README.ko.md)

[**Features**](#-features) · [**Download**](#-download) · [**Build from source**](#-build-from-source) · [**Shortcuts**](#️-keyboard-shortcuts) · [**Architecture**](#️-architecture)

</div>

<br/>

<div align="center">

[![Gitpervisor main screen](designs/main-screen-v2.png)](designs/main-screen-v2.png)

<sub>Project rail · Changes panel · Monaco side-by-side diff · embedded terminal · Log panel — all in one window</sub>

</div>

---

## Why Gitpervisor

If you juggle several projects at once, your day is a loop: **open a project → run `git status` → read the diff → commit → push** — then do it again for the next repo. Spinning up a heavy IDE for each one is slow, and a pile of terminal tabs loses track of which repo is in what state.

Gitpervisor collapses that loop into **one lightweight window**, and then goes a step further: it also watches the **AI coding agents** you have running in its terminals, so you can see at a glance which projects are still working and which are done.

- 📁 **Every registered repo at a glance** in the sidebar — branch · ahead/behind · change count · conflicts
- 🤖 **AI agent activity badges** — see which projects have a *Claude Code* turn still running vs. finished, without switching tabs
- 🔍 Click a project → **changed files + side-by-side diff instantly**
- ✅ **stage → commit → push** right there, with live progress streaming
- 🔄 Save in any external editor and the **file watcher auto-refreshes** the sidebar
- ❯_ Run builds and scripts in a **real embedded terminal** with split panes
- 🗄️ Query **MongoDB / SQL Server** in a built-in DB workspace — no separate client
- 🌐 **Preview your localhost dev server** and browse the web (GitHub, search) in a built-in browser tab

> **It never touches auth, hooks, or signing.** Every git operation is delegated to your system `git` CLI, so your credential manager, SSH agent, hooks, commit signing, and `.gitconfig` all work **exactly as they already do**.

---

## ✨ Features

### 🤖 AI agent activity detection
Gitpervisor scans the live terminal buffers and surfaces a per-project badge showing whether an AI coding agent is **working** or **done**. It keys off the `esc to interrupt` marker that *Claude Code* prints while processing a turn, scanning the full visible screen (not just the cursor line) so footers and plan-mode lines don't fool it. Run agents across five repos and tell at a glance which ones still need you — no tab-hopping.

### 🗂️ Multi-repo status dashboard
Register folders and the sidebar shows a status dot, branch, `↑↓`, and change count per repo. Twenty projects refresh **in under a second** via parallel queries.

| Dot | Meaning |
|:---:|---------|
| 🟢 green | clean — no changes, nothing to push |
| 🟡 yellow | has changes, or ahead/behind |
| 🔴 red | conflict / merge·rebase in progress |
| ⚫ gray | path missing · git error |

### 🔍 Side-by-side diff viewer
Built on **Monaco `DiffEditor`** — syntax highlight, word-level intraline highlight, and **folding of unchanged regions** (`hideUnchangedRegions`) all built in. Index ↔ working tree, staged (HEAD ↔ index), and per-commit diffs are all supported; binary and large files (1.5 MB) are guarded safely.

### ✅ Commit workflow
Checkbox staging → commit message → **Commit / Commit and Push** (+ Amend). Discard (revert changes · delete untracked) goes through a confirm dialog and is safe under `autocrlf`. Fetch / Pull / Push stream progress line by line, and offer a `-u` push when there's no upstream.

### 🔄 Real-time auto-refresh
A filesystem watcher (`notify` + 400 ms debounce) **detects saves from external editors** and reflects them in the sidebar badges and the Changes list live. `.git/objects` and `*.lock` are ignored so build output doesn't swamp it.

### 🌿 History & Log panel
A collapsible bottom Log panel split three ways — **branch tree (local/remote) · commit list · commit detail (file tree + full message)**. Click a file in a commit and that commit's diff opens in the center viewer. Pagination keeps thousands of commits smooth.

### ❯_ Embedded terminal + tabbed workspace
Spawns a shell right in the project path — **`portable-pty` (ConPTY) + `@xterm/xterm`**, a real pseudo-terminal where oh-my-posh prompts, ANSI, and `vim` all work. The center viewer switches via `[📄 Viewer] [❯_ pwsh] [🌐 Browser] [＋]` tabs and supports **Windows-Terminal-style splits** (horizontal/vertical, drag-resize, maximize). Switch tabs and the PTY stays alive in Rust, so scrollback is preserved.

### 🗄️ Database workspace
A built-in query workspace with a **Monaco editor**, connection sidebar, and result grid. **MongoDB** and **SQL Server** are supported today (SQL Server includes an estimated execution plan); **PostgreSQL · MySQL · SQLite** are on the way. Query your app's database without leaving the cockpit.

### 🌐 Embedded browser
A browser tab right next to Viewer / DB / terminal, with back/forward/reload, an omnibox, bookmarks, and a download policy. It **auto-routes by host**: `localhost`/`127.0.0.1` dev servers render in an in-DOM `<iframe>` (fully integrated with splits, modals, and focus), while external sites like GitHub or a search engine render in a **native child webview** — so sites that block framing with `X-Frame-Options` still load. Preview what you're building and look things up without leaving the cockpit.

### 🧩 Extras
**File tree panel** for browsing a repo without the terminal · **per-project memos/notes** that persist · **system monitor** (CPU/MEM) in the title bar · **Darcula / Monokai themes** via `<html data-theme>` + CSS variables, with adjustable diff and terminal font sizes.

---

## 📦 Download

Grab the latest installer for your OS from the [**Releases**](https://github.com/imtelloper/gitpervisor/releases/latest) page:

| OS | File |
|----|------|
| **Windows** | `.msi` or `.exe` (NSIS installer → Program Files + shortcuts) |
| **macOS** | `.dmg` (universal — Apple Silicon + Intel) |
| **Linux** | `.AppImage` (portable) · `.deb` (Debian/Ubuntu) · `.rpm` (Fedora/RHEL) |

> **Requires `git ≥ 2.35` on your PATH** — the app uses your system git CLI. If git isn't found, Gitpervisor shows a guidance screen on launch instead of failing silently.
>
> Builds aren't code-signed yet, so on first launch Windows SmartScreen ("More info → Run anyway") or macOS Gatekeeper (right-click → Open) may warn you.

---

## 🚀 Build from source

### Requirements

- **Node.js 18+** / npm
- **Rust** (stable) — <https://rustup.rs>
- **git ≥ 2.35** on your PATH
- Linux only: `libwebkit2gtk-4.1-dev`, `libssl-dev`, and the usual Tauri system deps (see [the workflow](.github/workflows/release.yml) for the full apt list)

### Develop

```sh
npm install
npm run tauri dev
```

### Build

```sh
npm run tauri build
```

### Test

```sh
cd src-tauri && cargo test   # porcelain v2 parser fixture tests
npm run build                # tsc typecheck + vite bundle
```

---

## ⌨️ Keyboard shortcuts

Follows the same layout as the JetBrains commit tool window.

| Shortcut | Action |
|----------|--------|
| `F5` | Refresh all projects |
| `Ctrl` + `K` | Commit |
| `Ctrl` + `Shift` + `K` | Push |
| `Ctrl` + `T` | Pull |
| <code>Ctrl</code> + <code>`</code> | Toggle terminal (Viewer ↔ terminal) |
| `Ctrl` + `Shift` + `D` | Split active pane right |
| `Ctrl` + `Shift` + `E` | Split active pane down |
| `Ctrl` + `Shift` + `W` | Close active pane |

---

## 🏗️ Architecture

**Three principles**

- **Rust is the single source of truth for data.** All git-output parsing finishes in Rust; the frontend only ever receives structured JSON.
- **Reads run in parallel, writes are serialized per repo.** status/log/diff run concurrently; mutating ops (commit/push/stage) are queued per repo with a `Mutex` (different repos still run in parallel).
- **Event → invalidate → refetch.** The backend only signals "this repo changed"; the frontend invalidates that query's cache — no state rides on the event payload, so there are no races.

```mermaid
graph LR
    subgraph FE["Frontend · React (WebView)"]
        UI["UI<br/>Sidebar · Changes · Diff · Log · Terminal · DB · Browser"]
        QC["TanStack Query cache"]
        ST["Zustand UI state"]
        UI --> QC
        UI --> ST
    end

    subgraph BE["Backend · Rust (Tauri)"]
        CMD["Tauri Commands<br/>projects · status · log · diff · actions · terminal · db"]
        RUNNER["GitRunner<br/>arg array · timeout · CREATE_NO_WINDOW"]
        PARSE["Parsers<br/>porcelain v2 · log -z"]
        WATCH["RepoWatcher<br/>notify + 400ms debounce"]
        CMD --> RUNNER --> PARSE
    end

    QC -- "invoke()" --> CMD
    RUNNER --> GIT["system git CLI"]
    GIT --> REPOS["registered repos"]
    REPOS -. "FS events" .-> WATCH
    WATCH -. "repo://changed" .-> FE
```

### Why the git CLI instead of libgit2

| Concern | git CLI ✅ | libgit2 |
|---------|-----------|---------|
| Auth (push/pull) | credential manager · SSH agent **just work** | implement callbacks yourself — the #1 pain on Windows |
| hooks / signing / `.gitconfig` | all work as-is | partial or unsupported |
| Windows build | no extra deps | frequent openssl/vcpkg issues |
| Parsing | stable `--porcelain=v2 -z` format, officially provided | returns structs directly |

→ The same approach as GitHub Desktop (dugite). The porcelain format solves the parsing downside, and auth/hooks/signing come for free.

📐 Full design, IPC contracts, and edge cases live in **[DOCS/DESIGN.md](DOCS/DESIGN.md)**.

---

## 🧰 Tech stack

| Layer | Choice |
|-------|--------|
| Desktop shell | **Tauri 2** (Rust) |
| Frontend | **React 19** + TypeScript + Vite 7 |
| Diff & SQL editor | **Monaco Editor** |
| State | **Zustand** (UI) + **TanStack Query v5** (git data) |
| Styling | **Tailwind CSS 4** (Darcula / Monokai tokens) |
| Terminal | **portable-pty** (ConPTY) + **@xterm/xterm** (+ webgl) |
| Browser | **wry** native child webview (`unstable`) + `<iframe>` |
| File watching | **notify-debouncer-full** (Rust) |
| Database | **mongodb** + **tiberius** (SQL Server) |
| Persistence | **tauri-plugin-store** (`projects.json` / `settings.json`) |
| Git | **system git CLI** (`--porcelain=v2 -z`) |

---

## 🔒 Security & design philosophy

- **Shell-injection-proof by construction** — a single `GitRunner` gateway executes only via arg arrays, paths always go after `--`, and commit messages are passed over `-F -` (stdin), so there's no argument-injection surface.
- **The app never changes a repo without your consent** — auto-fetch is off by default, every write is an explicit button.
- **It stores and handles no tokens or passwords** — auth is delegated entirely to your git stack.
- **Minimal Tauri capabilities** — only dialog · opener · store and its own commands; no remote content loading.
- **No console flicker** (Windows `CREATE_NO_WINDOW`), **no auth-prompt hangs** (`GIT_TERMINAL_PROMPT=0`).

---

## 🗺️ Roadmap

- [x] Core viewer · multi-repo status · worktree diff
- [x] Commit workflow · push/pull/fetch with progress streaming · watcher auto-refresh
- [x] History · Log panel · per-commit & staged diff
- [x] Embedded terminal · viewer tabs · split panes
- [x] AI agent activity detection
- [x] Database workspace (MongoDB · SQL Server)
- [x] Embedded browser (localhost preview + external sites · bookmarks)
- [ ] More DB engines (PostgreSQL · MySQL · SQLite)
- [ ] Broader AI-agent signals beyond Claude Code

**Out of scope (intentionally, for now — YAGNI):** merge-conflict resolution UI · interactive rebase · commit-graph lanes · GitHub/GitLab API · file editing (viewer only).

---

## 🤝 Contributing

Issues and PRs are welcome. Good first areas: additional DB engines, more AI-agent activity signals, and platform-specific terminal fixes. Please open an issue to discuss larger changes before sending a PR. See **[DOCS/DESIGN.md](DOCS/DESIGN.md)** for the architecture and IPC contracts, and **[DOCS/TROUBLESHOOTING.md](DOCS/TROUBLESHOOTING.md)** if you hit a build snag.

---

## 📄 License

[MIT](LICENSE) © imtelloper — use it, fork it, ship it.

<div align="center">
<br/>
<sub>Built with 🦀 Tauri · React · Rust</sub>
</div>
