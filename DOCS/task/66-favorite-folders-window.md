# 태스크 66 — 즐겨찾기 폴더 창 (스크린샷·다운로드 빠르게 보기)

> 상태: **구현 완료 · e2e 60 12/12 · 실기 확인 완료** (2026-09-10) · 대상: gitpervisor ·
> 근거: 코드 실측 2026-09-09(워킹트리 기준) ·
> 선행: 태스크 30(문서 창 `doc-*`), 56(이미지 ↑↓ 전환 규약), 65(복사 — 경로 복사가 이 경로를 탄다) ·
> **Rust 변경**: 신규 `commands/favorites.rs` + `Settings` 필드 1개 + `image` 피처 3개

## 1. 요구사항

타이틀바 [모아보기] 옆에 **[폴더]** 버튼. 누르면 등록한 즐겨찾기 폴더 목록이 뜨고, 폴더를 클릭하면
**별도 OS 창**에 그 폴더의 파일이 나열된다.

받아들이는 조건:
- 드롭다운: 즐겨찾기 목록 + "폴더 추가…" + 아직 안 넣은 프리셋(스크린샷·다운로드·바탕화면 — OS별 자동 감지).
  항목 우클릭 → 제거·이름 바꾸기. 터미널이 없어도 버튼은 보인다.
- 같은 폴더는 창 하나(재클릭 = 포커스). 하위 폴더는 같은 창에서 진입(브레드크럼·Backspace).
- 보기 모드 4종: **썸네일 그리드 S/M/L**, **목록**(이름·크기·수정일·종류). 정렬(수정일↓ 기본·이름·크기),
  "이미지만" 필터, 이름 검색. 폴더별로 기억.
- 이미지 더블클릭 → 창 안 라이트박스(←/→ 이전·다음, 끝에서 멈춤, `n / N`, Esc). 그 외 파일 → 기본 앱.
- 우클릭: **경로 복사 · 터미널에 경로 붙여넣기 · 기본 앱으로 열기 · 탐색기에서 보기.**
- 창 포커스 복귀·F5·버튼으로 갱신 — 스크린샷 찍고 돌아오면 보인다.
- Windows·macOS·Linux.

## 2. 현황(근거)

- **파일 접근은 전부 프로젝트 상대경로다.** `list_dir(project_id, rel_path)`(`tree.rs:24`),
  `read_file_base64(project_id, rel_path)`(`diff.rs:256`) — 모두 `project_path(&state, id)`로 루트를 푼다.
  임의 절대경로를 읽는 커맨드가 없다. 그래서 사용자는 지금 Downloads를 **프로젝트로 등록**해 트리로 보고
  경로를 끌어 쓴다(의도적 — 지우지 말 것). 이 태스크가 그 우회를 대체하되 등록은 그대로 둔다.
- **asset protocol이 없다**(`tauri.conf.json:15` csp `img-src 'self' data: blob:`). 이미지는 base64 data URL로
  IPC를 탄다(`diff.rs:227` "과대 파일 한도"). 스크린샷 수백 장을 원본으로 보내면 안 된다 → **썸네일 필수**.
  축소 선례 `logo.rs:110` `image::load_from_memory(..).thumbnail(T,T)`. `image` 크레이트는 png/jpeg만 켜져
  있다(`Cargo.toml:101`).
- **보조 창 인프라는 그대로 쓴다.** `open_doc_window(doc_id, title, origin, size)`(`lib.rs:500-552`): 라벨
  `doc-<id>`(영숫자·`-`, ≤64자), 이미 있으면 `set_focus`(싱글턴), 대상은 같은 origin의 localStorage
  `gp:doc-windows`(`floating.ts:36`)의 `DocTarget{projectId, path, edit?}`(`:40`). 라우팅 `main.tsx:105-146`,
  렌더 `DocWindow.tsx`. 캡처빌리티 `doc-*` 등록됨(`capabilities/default.json:11`).
  → **새 라벨·새 캡처빌리티·새 창 커맨드가 필요 없다.**
- 설정: Rust `Settings`(`git/types.rs:196-214`, `#[serde(default)]`, Default `:268`) ↔ TS `Settings`(`ipc.ts:221`)
  **통째 저장**(`settings.rs:17 set_settings`, `queries/index.ts:771 useSetSettings`).
- OS 열기: `reveal_path(path)`(`open.rs:344`, 절대경로·존재만 검사), `open_explorer(&Path)`(`:467/494/508`
  플랫폼별). 외부 프로세스는 반드시 `spawn_launcher`(`open.rs:43`, CLAUDE.md — OOM 사건).
- 감지 자원: `windows-registry`(`Cargo.toml:129`) 있음, `dirs` 없음, `sha2`(`:71`) 있음, `dunce`(`:36`) 있음.
- 창 간 통신: Tauri 이벤트는 전 창 브로드캐스트 — 모아보기 창 열림 감시(`main.tsx:208`)가 쓰는 방식.
- 가상 스크롤 라이브러리 없음(`package.json`). `ZoomableImage`(`ImageView.tsx:146`)는 `src` 문자열을 받는다.

## 3. 설계

### 3.1 설정 — `favoriteFolders`

```rust
pub struct FavoriteFolder { pub path: String, pub name: String }
pub favorite_folders: Vec<FavoriteFolder>,   // Settings, Default vec![]
```
TS `Settings.favoriteFolders: { path: string; name: string }[]`.

**이 목록이 곧 백엔드 허용 루트다**(§3.2). 드롭다운의 추가/삭제는 **직전 `getSettings()`**를 읽어
read-modify-write 한다. 설정 다이얼로그 form이 열린 채 저장하면 그 사이 넣은 즐겨찾기를 덮는 경합이 있다 —
`lspEnabledProjects`와 같은 기존 성질, 수용.

### 3.2 Rust `commands/favorites.rs` (신규 ~250줄, `lib.rs` 등록 5개)

```rust
fn allowed(state: &AppState, path: &str) -> Result<PathBuf, IpcError>
// dunce::canonicalize(path) 가 favorite_folders 중 하나의 canonical 루트에 starts_with — 아니면 Forbidden.
// 심링크로 밖으로 나가는 경우도 canonicalize가 잡는다. 아래 절대경로 커맨드 4개가 첫 줄에서 부른다.
```

- `fav_presets() -> Vec<FavoriteFolder>` — 존재하는 것만.
  - Windows: 스크린샷 = 레지스트리 `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`
    의 `{B7BEDE81-DF94-4682-A7D8-57A52620B86F}`(환경변수 확장) → 없으면 `%USERPROFILE%\Pictures\Screenshots`;
    다운로드 = `{374DE290-123F-4565-9164-39C4925E467B}` → `%USERPROFILE%\Downloads`; 바탕화면 `%USERPROFILE%\Desktop`.
  - macOS: 스크린샷 = `defaults read com.apple.screencapture location`(짧은 동기 `Command`, 출력 읽음) →
    없으면 `~/Desktop`; `~/Downloads`; `~/Desktop`.
  - Linux: `~/Pictures/Screenshots`(GNOME 42+) → `~/Pictures`; `XDG_DOWNLOAD_DIR`(`~/.config/user-dirs.dirs`
    한 줄 파싱) → `~/Downloads`; `~/Desktop`.
- `fav_list(path) -> Vec<FavEntry { name, is_dir, size, mtime_ms, kind }>` — `kind`는 확장자로
  `image`(png jpg jpeg gif webp bmp svg) · `video`(mp4 mov webm mkv) · `dir` · `other`. 점 파일·Windows 숨김
  제외. 정렬은 프론트. 상한 없음(메타 ~100B/개).
- `fav_thumb(app, path, edge: u32) -> String`(data URL `image/jpeg`) — gate → 캐시 키
  `sha256(path|mtime|size|edge)` → `app_cache_dir()/thumbs/<hex>.jpg` 있으면 그대로 → 없으면 `spawn_blocking`
  에서 `image::open(..).thumbnail(edge, edge)` → JPEG q80 → 캐시 기록 → 반환. `edge`는 **128/192/320 중
  하나만** 받는다(그리드 S/M/L, 그 외 거부 — 캐시 폭주 방지). svg는 썸네일 없이 `fav_read` 원본, video/other는
  프론트 아이콘. `image` 피처에 `gif`·`webp`·`bmp` 추가(pure Rust).
  ponytail: 캐시 용량 무제한 — `MaintenanceSection`에 "썸네일 캐시 비우기"(폴더 삭제 1줄). 상한·LRU는 커지면.
- `fav_read(path) -> FileBytes { mime, base64 }` — 라이트박스 원본. `diff.rs` FileBytes·크기 한도 재사용.
- `fav_open(path, how: "default" | "reveal")` — gate → `reveal`은 기존 `reveal(p)`; `default`는 Windows
  `explorer <file>`, macOS `open`, Linux `xdg-open` — 전부 `spawn_launcher`.

### 3.3 창 — `doc-*` 재사용

- `DocTarget`에 `folder?: string`(절대경로) 추가. 옵셔널 — 기존 localStorage 항목과 호환(`floating.ts:43-48` 주석).
- `openFolderWindow(path)`(`floating.ts`): `id` = FNV-1a 32bit × 2(정방향·역방향) hex 16자 — **결정적**이라 같은
  폴더 재클릭이면 Rust가 기존 창에 포커스만 준다. `docs[id] = { projectId: "", path, folder: path }`;
  `invoke("open_doc_window", { docId: id, title: basename, origin, size: [1100, 760] })`. `DOC_MAX`(20) 회전 그대로.
- `main.tsx:126`의 diff prefetch는 `if (t && !t.folder)`.
- `DocWindow.tsx`: `if (target?.folder) return <FolderWindow root={target.folder} />` — **lazy**(이미지 편집기
  청크와 분리, `DocWindow.tsx:17-27` 주석의 이유).

### 3.4 `components/folder/FolderWindow.tsx` (신규 ~350줄; `FolderGrid`·`FolderList`·`Lightbox`로 나눠도 됨)

- 상태: `dir`(현재 경로, root 하위) · `entries` · `mode: "grid-s"|"grid-m"|"grid-l"|"list"` · `sort` ·
  `imagesOnly` · `query` · `selected` · `lightbox: number | null`. `mode/sort/imagesOnly`는 localStorage
  `gp:folder-view:<root>`.
- 상단: `FloatTitleBar(title=폴더명, badge="폴더")` + 툴바(브레드크럼 · 검색 · 이미지만 · 정렬 · 모드 세그먼트 ·
  새로고침 · 탐색기).
- 그리드: CSS `grid-template-columns: repeat(auto-fill, minmax(edge, 1fr))`, 셀 `content-visibility: auto;
  contain-intrinsic-size`. 썸네일은 **IntersectionObserver로 보일 때만** 요청, 동시 8개 큐, 결과 `Map<path,
  dataUrl>`(창 수명). 목록: 테이블 + 종류 아이콘(썸네일 없음).
- 갱신: `getCurrentWindow().onFocusChanged(true)` → `fav_list` 재호출(mtime 동일이면 상태 유지), F5, 버튼.
  notify 감시는 안 한다(스크린샷은 다른 창에 있을 때 찍히고, 보려면 이 창을 클릭한다 = 포커스 = 갱신).
- 라이트박스: `fav_read` → `<img class="object-contain">`(ZoomableImage는 편집 버튼이 프로젝트 경로를 요구해
  안 쓴다). ←/→는 **필터·정렬된 이미지 순서**로 이동(태스크 56 규약: 끝에서 멈춤, `n / N`), 다음 1장 prefetch, Esc.
- 키: ↑↓←→ 선택, Enter 열기, Backspace 상위, **Ctrl+C = 경로 복사**(태스크 65 `copyText`), F5, Ctrl+1~4 모드.
- 우클릭 메뉴(`TerminalPane.tsx:306 MenuItem` 재사용): 경로 복사 · 터미널에 경로 붙여넣기 · 기본 앱으로 열기 ·
  탐색기에서 보기.
- **"터미널에 경로 붙여넣기"**: `emit("fav:paste-path", { path })`. 메인 창(`App` 초기화 1곳)이 `listen` →
  활성 pane(`useTerminals` active)의 `getTerminal(id).term.paste(quoted)` — 공백이 있으면 따옴표. 활성 터미널이
  없으면 토스트. **스크린샷 → Claude에 첨부**가 이 기능의 핵심 동선이다(Downloads를 프로젝트로 등록해 쓰던 이유).

### 3.5 타이틀바 — `FavoritesButton` (`TitleBar.tsx`, `AggregateButton`(`:95`) 옆 ~80줄)

- 항상 표시. 클릭 → 드롭다운: 즐겨찾기(이름, 툴팁 경로; 우클릭 → 제거·이름 바꾸기 `PromptDialog`) · 구분선 ·
  아직 없는 프리셋(`fav_presets` 1회 조회, "+" 아이콘) · "폴더 추가…"(`@tauri-apps/plugin-dialog`
  `open({ directory: true })`, 이름 기본 = basename — `ProjectList.tsx:2`와 같은 import).
- 항목 클릭 → `openFolderWindow(path)`. 존재하지 않는 경로는 흐리게 + 툴팁.
- 아이콘 `FolderOpen`(lucide), 라벨 "폴더", 스타일은 `AggregateButton`과 동일 클래스.

### 3.6 스코프 밖 (하지 않는다)

파일 삭제·이름·이동, 동영상·PDF·HEIC 썸네일(상위 경로: OS 셸 썸네일 `IShellItemImageFactory` / QuickLook /
freedesktop 캐시), notify 감시, 창 간 드래그(별도 webview라 HTML5 DnD가 안 넘어간다), 이미지 편집기 연결
(프로젝트 상대경로 요구), 설정 다이얼로그 섹션(드롭다운이 관리 UI다).

## 4. 검증

- **Rust 단위**: `allowed()` — 루트 밖·`..`·심링크 탈출 거부, 루트 자신·하위 허용; `fav_presets` 존재 필터;
  `fav_thumb` 캐시 히트(두 번째 호출이 디코드 없이 같은 바이트); `edge` 128/192/320 외 거부.
- **e2e 53(신규)**: 픽스처 폴더(png 3·jpg 1·txt 1·하위 폴더 1) 생성 → `__gpv`로 `favoriteFolders` 설정 →
  타이틀바 [폴더] → 항목 클릭 → `doc-*` 창 뜸 → 목록 6개 → 그리드 셀에 `data:image/jpeg` 도착 → 목록 모드·정렬·
  이미지만(4개) → 하위 폴더 진입·Backspace → png 더블클릭 → 라이트박스 → 키로 다음, `n / N` → 우클릭
  "경로 복사" → 클립보드 = 절대경로 → "터미널에 경로 붙여넣기" → 메인 터미널 입력줄에 경로 → 같은 항목 재클릭
  → 창 수 그대로(싱글턴) → 비허용 경로로 `fav_list` 직접 invoke → Forbidden.
- **수동**: Windows Win+Shift+S 저장 후 창 포커스 → 새 파일 보임; macOS 스크린샷 위치 커스텀 감지; Linux GNOME.

## 5. 하지 말 것

- gate(`allowed`)를 빼먹지 마라 — 절대경로 커맨드 4개 전부. 즐겨찾기 목록이 유일한 허용 루트다.
- 원본 이미지를 그리드에 보내지 마라(§2). 썸네일 edge는 3값 고정.
- 새 창 라벨·캡처빌리티를 만들지 마라 — `doc-*`로 충분하다.
- JS `new WebviewWindow`를 쓰지 마라(`floating.ts:6` — WebView2 인자 불일치로 빈 창).
- 외부 프로그램은 `spawn_launcher`로만.
- Downloads 프로젝트 등록을 지우거나 `.git` 게이트로 거르지 마라 — 사용자가 옮길 때까지 공존.

## 6. 구현 결과 (2026-09-10)

`b1d8852` 이후 워킹트리. 새 의존성 0(`image` 크레이트에 피처 3개만 추가).

| 무엇 | 어디 |
|---|---|
| 게이트 + 커맨드 5개 | `src-tauri/src/commands/favorites.rs` (신규) — `fav_presets`·`fav_list`·`fav_thumb`·`fav_read`·`fav_open` |
| 설정 | `git/types.rs` — `FavoriteFolder` 타입 + `Settings.favorite_folders` + Default |
| 등록 | `commands/mod.rs` 2줄, `lib.rs` invoke_handler 5줄 |
| 썸네일 디코더 | `Cargo.toml` — `image` 피처에 `gif`·`webp`·`bmp` (2군데: `cfg(windows)` / `cfg(not(windows))`) |
| 창 라우팅 | `lib/floating.ts` — `DocTarget.folder` + `openFolderWindow`, `DocWindow.tsx` — 갈림길, `main.tsx` — prefetch 제외 |
| 창 본체 | `components/folder/FolderWindow.tsx` (신규) |
| 진입점 | `components/TitleBar.tsx` — `FavoritesButton`(드롭다운이 관리 UI 자체) |
| 경로 → 터미널 | `App.tsx` — `fav:paste-path` 수신 → 활성 pane 에 `term.paste()` |
| 타입 | `lib/ipc.ts` — `FavoriteFolder`·`FavEntry` + 래퍼 5개 |

설계에서 **바꾼 것 셋**:

- **ⓐ 기본 앱 열기·탐색기에서 보기를 새로 만들지 않았다.** `open.rs` 의 `run_file`·`reveal` 을
  `pub(crate)` 로 열어 그대로 쓴다. 거기엔 `spawn_launcher` 의 systemd-run 위임과 좀비 회수가
  들어 있고, 그게 없어서 2026-08-01 에 프로세스가 387개까지 쌓였다(CLAUDE.md). 본문은 안 건드렸다.
- **ⓑ 창 id 를 FNV-1a 정·역 2회(16자)로 만든다** — 설계 그대로지만 이유를 여기 남긴다:
  `crypto.randomUUID` 를 쓰면 같은 폴더를 누를 때마다 창이 하나씩 늘어난다. 결정적이어야
  Rust 의 싱글턴 분기(`open_doc_window` 의 `get_webview_window`)가 걸린다.
- **ⓒ 우클릭 메뉴 한 줄(`Row`)을 폴더 창 안에 따로 뒀다.** `TerminalPane` 의 `MenuItem` 을
  가져오면 이 창 청크에 터미널 스토어·PTY 코어가 통째로 딸려 온다 — 폴더 창엔 터미널이 없다.
  (태스크 65 에서는 반대로 판단했다: 거기선 두 메뉴가 **같은 창**에 있어 순환 import 가 문제였다.)

### 검증 상태

- **통과**: `cargo check` 경고 0(신규분), **Rust 단위 테스트 232/232**, 프론트 `tsc` exit 0.
  새로 넣은 4건: `kind_of` 확장자 분류 · 썸네일 edge 3값 고정 · `mime_of` 가 image 분류 확장자를
  전부 덮는지 · **canonicalize 후 prefix 검사가 `..` 탈출을 거부하는지**(게이트의 핵심 성질).
- **e2e 60(신규) 12/12** — `GPV_E2E_ONLY=60`. 게이트(미등록 거부 → 등록 후 허용, 루트 밖 거부),
  종류 분류, 썸네일 크기 3값 고정, 창 라우팅 + 재클릭 시 창 불변, 우클릭 경로 복사.
  (스위트 번호는 태스크 번호와 다르다 — 53~59 는 다른 세션이 쓰기로 해 60 을 잡았다.)
- **실기 확인(이 머신, Windows 11)** — e2e 가 못 덮는 넷:

| 확인 | 결과 |
|---|---|
| `fav_presets` 가 실제 경로를 찾는가 | 스크린샷·다운로드·바탕화면 셋 다 — 스크린샷은 레지스트리 경로로 해석됨 |
| 그리드 썸네일이 실제로 그려지는가 | 이미지 135장 중 **화면에 보이는 20칸만** `data:image/jpeg` 로 도착(지연 로딩이 의도대로 동작) |
| 라이트박스 | 더블클릭 → `135 / 135` 표시 · ←→ 안내 |
| 터미널에 경로 붙여넣기 | 활성 터미널 입력줄에 **따옴표로 감싼 절대경로**(공백 포함 경로) |

### 실기에서 잡힌 결함 둘 (수정 완료)

- **`SETTINGS_INDEX` 누락.** `Settings.favorite_folders` 를 더하면서 설정 검색 인덱스에 항목을
  안 넣어 e2e 29 ⑤(모든 Settings 키 커버)가 깨졌다. 다른 세션의 회차가 잡아 줬다. 인덱스 항목과
  함께 **일반 섹션에 읽기 전용 한 줄**을 뒀다 — 검색 하이라이트가 착지할 자리가 필요하고,
  관리 UI 는 여전히 타이틀바 드롭다운이다.
- **"터미널에 경로 붙여넣기"가 활성 탭만 봤다.** 선택된 프로젝트에 터미널 탭이 없으면
  `terminals[0]`(다른 프로젝트 탭)이 잡히는데 그 탭은 마운트돼 있지 않아 xterm 인스턴스가 없다 →
  **화면에 터미널이 멀쩡히 보이는데 "터미널이 없습니다"** 가 떴다. 활성 탭 → `listTerminals()` 중
  살아 있는 것 순으로 고르게 고쳤다. 정적 검증으로는 절대 안 나오는 종류다.

### 다음 사람 몫

- e2e 를 붙일 때 **스위트 번호를 확인하라** — 태스크 번호와 다르다(62→50, 64→51, 65→52).
  `run.mjs` 의 목록에서 빈 번호를 고른다.
- 게이트 e2e 는 **비허용 경로로 `fav_list` 를 직접 invoke 해 거부되는지**를 반드시 포함한다.
  UI 로만 확인하면 프론트가 안 보내는 것과 백엔드가 막는 것이 구분되지 않는다.
