# 태스크 09 — 빠른 파일 열기 (Quick Open)

> 상태: 설계(Design) · 대상: gitpervisor · 산출물 성격: 아키텍처/계약/단계/위험 (구현은 후속)
> 근거: 코드 실측 2026-07-06 · 관련: [01-aggregate-hotkey.md](01-aggregate-hotkey.md)(platform 헬퍼·키 전수 전례), [08-find-in-files.md](08-find-in-files.md)(KeyboardShortcuts 등록 위치 전례 — §3.6), [13-symbol-search.md](13-symbol-search.md)(본 문서의 QuickPick 프리미티브 재사용)

## 1. 요구사항

`mod+P`로 파일명 퍼지 검색 모달을 열고, 타이핑으로 좁혀 Enter로 뷰어에 연다 —
VS Code Ctrl+P / WebStorm Cmd+Shift+N과 같은 워크플로.

- 검색 대상: 선택 프로젝트의 **추적 + 미추적(.gitignore 제외)** 전체 파일. `node_modules`·`target` 등 무시 경로는 나오면 안 된다.
- 임베디드(중첩) 저장소의 파일도 검색된다(합성 projectId 관례로 올바른 저장소에 라우팅).
- 퍼지 매칭: subsequence + 가중치(경로 구분자·파일명 보너스), 최근 연 파일(viewerTabs) 우선. 수만 파일 레포에서 입력이 버벅이지 않아야 한다.
- ↑↓/Enter/Esc 키보드 내비. Enter=뷰어 탭으로 열기(기존 selectDiff 경로), Esc/백드롭=닫기.
- **QuickPick 모달 프리미티브를 공유 컴포넌트로 정의**한다 — 13(심볼 검색)이 입력+리스트+키보드 내비에 더해 **비동기 소스(pending 로딩 표시·`debounceMs`·seq 무효화)**까지 그대로 재사용한다(중복 정의 금지 — 13 §3.4 교차 요구).

## 2. 현황(근거)

### 2.1 파일 열기 경로 — 이미 완비, 진입점만 없음
- 뷰어 열기: `src/stores/ui.ts:97` `selectDiff(target, repoId?)` — `:181-198`에서 선택 설정 + 뷰어 파일 탭 업서트(같은 키면 target만 갱신). 탭 동일성 키는 `viewerTabKey`(`:42-49`).
- 현재 진입점은 마우스 전용: 파일 트리 클릭(`src/components/tree/FileTreePanel.tsx:442`,`:456` — `selectDiff({ mode: "file", path })`), Changes/Log 패널, go-to-definition(`src/components/diff/goto-definition.ts:243`).
- 점프 착지도 완비: `DiffTarget`의 `file` 모드가 `line/column`을 받고(`src/lib/ipc.ts:80`), `DiffViewer.tsx:120-141` `revealTarget`이 그 위치로 스크롤+선택한다. Quick Open은 line 없이 열므로 그대로 통과.
- 임베디드 저장소 라우팅: `ui.ts:56-60` `selectedDiffRepoId` — 합성 id(`<outer>::<rel>`)를 주면 diff/편집이 중첩 저장소로 라우팅된다. `ViewerFileTabs.tsx:53`이 탭 전환 시 `repoId`를 되돌려주는 전례.

### 2.2 파일 목록 소스 — 전체 목록 커맨드는 없음
- `list_dir`(`src-tauri/src/commands/tree.rs:19-27`)은 **한 단계** 지연 로딩 전용. gitignore 판정은 디렉토리당 `git check-ignore` 배치 spawn(`:273`,`:304-330`) — 재귀 순회에 쓰면 디렉토리 수만큼 invoke+git spawn이 든다.
- `git ls-files -z --cached --others --exclude-standard`는 이미 백엔드 전례가 있다: `find_module_files`(`tree.rs:479`) — 추적+미추적 포함·.gitignore 제외를 git이 한 번에 처리.
- 배치 커맨드 관례: `list_project_roots`(`tree.rs:182-239`) — 여러 대상을 invoke 1개로, 내부 `buffer_unordered(4)`(`:205`), 항목별 오류 격리(`error` 필드).
- **ls-files 실측(2026-07-06, 본 설계 중 측정 — 프로세스 spawn 포함)**: gitpervisor 230파일 콜드 52ms/웜 32ms · SAFETY-AI 1,653파일 92/44ms · legacy-hrcs 10,826파일 149/134ms. 파일 수 10k에서도 150ms 선 — 모달 열 때 재조회해도 체감 무해.
- 임베디드 저장소는 ls-files에 **디렉토리 한 줄**(`sub/nested/` — 후행 `/`)로만 나온다(2026-07-06 재현 실측 — status.rs와 동일하게 내부 미재귀). 내부 파일은 합성 id로 별도 조회해야 한다.
- 합성 id 해석은 공용: `projects.rs:12-20` `project_path`가 `::`를 갈라 중첩 경로로 되푼다. 합성 id 생성은 `status.rs:65-96`(`:96` `{outer_id}::{rel_from_outer}`), 프론트는 `RepoStatus.parentId/relPath`(`ipc.ts:49-52`)로 배치 statuses(`src/queries/index.ts:306-325`)에서 임베디드 목록을 이미 갖고 있다.

### 2.3 IPC·캐시 무효화 인프라
- `src/lib/ipc.ts:489-491` MAX_CONCURRENT 8 + 타임아웃 8s + 재시도, `:506-521` 동일 (cmd+args) single-flight, `:499-500` background 레인은 큐 뒤로. 읽기 배치 전례: `getStatuses`(`:596-603`), `listProjectRoots`(`:688-692`).
- 커맨드 등록: `src-tauri/src/lib.rs:270` `generate_handler` 블록(`:295-296` list_dir/list_project_roots, `:302` find_definition).
- 목록 무효화 신호는 이미 있다: watcher가 400ms 디바운스로 `repo://changed`를 emit(`src-tauri/src/watcher.rs:30-31`,`:44-50`), 프론트는 250ms 코얼레싱으로 statuses/diff/log/branches를 invalidate(`src/lib/events.ts:53-62`) — 여기 쿼리 키 한 줄 추가로 파일 목록도 최신화된다.

### 2.4 단축키 인프라 — mod+P의 충돌 검사
- 항상-마운트 `GlobalShortcuts`(`src/components/KeyboardShortcuts.tsx:13-26`, `App.tsx:131` 마운트)가 태스크 01로 생겼다 — mod+Shift+A 전례(`:16-19`). `platform.ts:8-10` `isMod`, `:13` `modLabel`.
- `KeyboardShortcuts`(`:34-123`)는 **프로젝트 선택 + 모아보기 아님**일 때만 마운트된다(`App.tsx:107-117` — `aggregateOpen`이면 AggregateTerminals로 분기, `:117`에서 마운트). 핸들러는 `:55` `if (!e.ctrlKey) return;` 게이트라 mac Cmd 미지원 — 신규 키는 F5(`:50-54`)처럼 **게이트 앞에서 `isMod`로 직접 검사**해야 한다(08 §2.5와 동일 실측).
- `selectDiff`는 `aggregateOpen`을 바꾸지 않는다(`ui.ts:181-198` 실측 — selectedDiff/selectedDiffRepoId/viewerTabs만 갱신). 즉 모아보기 중에 파일을 열어도 모아보기가 닫히며 뷰어로 전환되는 동작은 **없다** — §3.1 등록 위치 결정의 근거.
- 기존 키 전수(01 §2.5 갱신분): F5(`KeyboardShortcuts.tsx:50`), Ctrl+Shift+D/E/W(`:60-79`), Ctrl+W(`:83-93`), Ctrl+K/Ctrl+Shift+K(`:95-99`), Ctrl+T(`:100-102`), Ctrl+\`(`:103-116`), Ctrl+Shift+↑/↓(ProjectList), mod+Shift+A(`:16`), 터미널 내 Ctrl+W·Ctrl(+Shift)+C/V(`terminal-engine.ts:202-226`). **Ctrl+P는 앱 내 미사용.**
- Monaco 0.55 로컬 소스 실측 — `mod+P`(CtrlCmd+KeyP)는 기본 바인딩에 **없다**. KeyP 바인딩은 macOS `WinCtrl+P`(커서 위 — `node_modules/monaco-editor/esm/vs/editor/browser/coreCommands.js:581`, `suggestController.js:812` 등 secondary)와 찾기 위젯 `Alt+P`(preserve case 토글 — `contrib/find/browser/findModel.js:39-42`)뿐. 즉 에디터 포커스 중에도 mod+P는 window로 버블된다.
- WebView2 브라우저 액셀러레이터: `lib.rs:81` `BASE_BROWSER_ARGS`에 액셀러레이터 비활성 플래그 없음 → Ctrl+P는 Chromium 인쇄 액셀러레이터로 살아 있을 수 있다(검증 필요 — §3.1·§6).

### 2.5 모달 UI 관례 — QuickPick의 골격
- `src/components/common/PromptDialog.tsx:39-47` — `fixed inset-0 z-[60]` 백드롭 + 백드롭 클릭 닫기 + 패널 `stopPropagation`. 입력의 Enter/Esc는 `preventDefault+stopPropagation`으로 다른 전역 핸들러 누수 차단(`:56-67`). 자동 포커스는 `setTimeout(0)`(`:18-24`).
- 모달 오픈 상태는 `useUi`에 boolean으로 두는 관례: `settingsOpen`(`ui.ts:82`/`:110`) 등 — 단축키 핸들러가 `useUi.getState()`로 열 수 있다.

### 2.6 E2E 인프라
- `tests/e2e/lib/cdp.mjs:86-110` — CDP로 Tauri 커맨드 직접 invoke(+비throw `try`). 백엔드 커맨드 검증 전례는 `suites/10-codenav.mjs`(find_definition — 픽스처 파일 생성 후 결과·오류코드 단언).
- 프론트 DOM 검증 전례는 `suites/14-frontend-dom.mjs` — dev 노출 `window.__gpv`(ui/terminals/queryClient, `src/main.tsx:33-38`,`:91-94`)로 상태 구동, 합성 keydown 디스패치(`:70-73`), xterm 포커스 케이스(`:135-138`), `fixed z-50` 메뉴 탐색(`:218`). `window.__monaco`도 dev 노출(`monaco-setup.ts:437-439`).

## 3. 설계

### 3.1 키 선택 — 후보 비교

| 후보 | 판정 | 근거 |
|---|---|---|
| **mod+P** | **채택** | VS Code/Sublime 근육기억. 앱 내 미사용(§2.4). Monaco 기본 바인딩 없음(로컬 소스 실측 §2.4). WebView2 인쇄 액셀러레이터와 겹칠 수 있으나 Chromium 계열은 웹 콘텐츠의 `keydown preventDefault`가 인쇄를 억제하는 게 관례(검증 필요 — 실기 스모크 §6). 억제 실패 시 **mod+E로 재배정**(아래 폴백). |
| mod+E (폴백) | 예비 | PyCharm Ctrl+E(최근 파일) 관례와 근접. 앱·Monaco·WebView2 예약 없음(검증 필요). mod+P 실기 검증 실패 시에만 승격 — 이 문서의 계약은 키 상수 1곳(`KeyboardShortcuts`)만 바꾸면 되도록 설계. |
| mod+O | 기각 | 브라우저/WebView2 "파일 열기" 액셀러레이터 예약 가능성이 mod+P보다 높고(OS 파일 다이얼로그), "Open"이 OS 파일 열기와 의미 혼동. |
| mod+Shift+N | 기각 | WebStorm 관례이나 Chromium "시크릿 창" 액셀러레이터 인접 + 13(심볼 검색) 후보군과 혼선. 3키 코드보다 2키가 빈도 높은 기능에 맞다. |

**터미널(xterm) 포커스 통과는 하지 않는다(01과 다른 결정)**: Ctrl+P는 readline/emacs `previous-history` 실사용 키라 PTY에서 가로채면 안 된다(01 §3.1이 Ctrl+G를 기각한 것과 같은 근거). 모아보기 토글(그리드 전체가 터미널이라 통과 필수)과 달리 Quick Open은 에디터/트리 문맥 기능 — 터미널 포커스 중 미동작을 의도로 수용한다. 원하면 후속에서 `terminal-engine.ts` 화이트리스트 1줄로 켤 수 있다.

**등록 위치 — 대안 비교(08 §3.6·13 §3.6과 동일 결정)**:

| 대안 | 판정 | 근거 |
|---|---|---|
| **`KeyboardShortcuts`(프로젝트 선택+모아보기 아님일 때만 마운트)** | **채택** | 마운트 조건(`App.tsx:107-117`, §2.4)이 곧 활성 조건 — 미선택이면 검색 대상이 없고, 모아보기 중엔 뷰어가 가려져 있다. `selectDiff`는 `aggregateOpen`을 닫지 않으므로(§2.4 실측) 모아보기 중 열면 onPick이 **가려진 뷰어**로 착지하는 어긋난 UX — 13 §3.6이 GlobalShortcuts를 기각한 "빈 모달" 시나리오 그대로. 가드(`selectedProjectId`·`aggregateOpen`)를 손으로 다는 대신 마운트 조건을 재사용해 실수 표면 최소화. 단 `:55` `e.ctrlKey` 게이트가 mac Cmd를 걸러내므로 F5(`:50-54`)처럼 **게이트 앞에서 `isMod` 직접 검사**(08 §3.6 동일 처리). |
| GlobalShortcuts(항상 마운트) + `selectedProjectId`/`aggregateOpen` 가드 | 기각 | 01의 모아보기 토글은 "모아보기 중에도" 눌러야 해서 항상-마운트가 필요했던 것 — Quick Open은 반대로 모아보기 중 착지가 불가능하다(§2.4). 가드 2개를 수동 유지하는 것보다 마운트 조건 일치가 낫고, 08·13과 결정이 갈라져 유지보수 혼선. 모아보기 중 지원이 필요해지면 "선택 시 모아보기 닫고 착지" 동작을 먼저 정의한 뒤 이동(후속). |

동작: 토글(열려 있으면 닫기 — VS Code 동일). 프로젝트 미선택·모아보기 중엔 핸들러 자체가 언마운트라 no-op. 모달이 열린 채 mod+Shift+A로 모아보기에 진입하는 엣지는 QuickOpenHost 렌더 조건의 `!aggregateOpen`이 흡수한다(§4 — 가려진 모달 잔존 방지).

### 3.2 파일 목록 소스 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **신규 IPC `list_repo_files`(git ls-files 배치)** | **채택** | `--cached --others --exclude-standard`가 추적+미추적·.gitignore 제외를 git 한 방에 처리(§2.2 전례 tree.rs:479). 실측 10k 파일 ~150ms(§2.2) — 인덱스가 곧 캐시라 콜드/웜 차이도 작다. 배치 시그니처(`project_ids`)로 outer+임베디드를 invoke 1개에 처리(WebView2 동시 invoke 유실 회피 — list_project_roots 미러). |
| 기존 `list_dir` 재귀(프론트 BFS) | 기각 | 디렉토리 수만큼 invoke — IPC 게이트(MAX_CONCURRENT 8, §2.3)를 점유해 사용자 클릭을 굶기고, 디렉토리당 git check-ignore spawn(§2.2)으로 10k 파일 레포에서 수십 초. |
| Rust 직접 워크(walkdir+ignore crate) | 기각 | 신규 의존성 2개로 git ls-files와 동일 결과를 재구현. gitignore 시맨틱 불일치 위험(전역 excludes·`.git/info/exclude`)을 git이 이미 정확히 처리. |

### 3.3 목록 캐시·무효화 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **react-query 캐시 + `repo://changed` invalidate + 열 때 stale 재조회** | **채택** | 이전 목록으로 즉시 그리고(stale-while-revalidate) 도착분으로 교체 — 거대 레포에서도 첫 페인트 0ms. 무효화 신호는 기존 watcher 경로(§2.3)에 쿼리 키 1줄. 쿼리 키는 정렬본(`useStatuses` `queries/index.ts:310` 관례 — 키 흔들림 방지). |
| 캐시 없음(열 때마다 fresh 대기) | 기각 | 150ms~수백 ms를 매번 기다린다. 빈 쿼리 상태(최근 파일)도 목록 도착 전엔 못 그림. |
| 전용 증분 인덱스(watcher가 목록 직접 갱신) | 기각 | ls-files가 이미 충분히 싸다(실측). 증분 정합성(rename/ignore 변경) 유지 비용이 이득을 넘는 과잉(YAGNI). |

### 3.4 퍼지 매칭 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **자체 구현 `src/lib/fuzzy.ts`(subsequence+가중치)** | **채택** | 요구가 명확히 작다: 소문자 subsequence 필터 → 점수(연속 매치 보너스·경계 직후 보너스[`/`·`_`·`-`·`.`·camelCase]·**basename 매치 가중**·매치 시작 위치 감점·짧은 경로 타이브레이크). ~90 LOC. 의존성 0(package.json 실측 — 퍼지 라이브러리 없음). 13(심볼)도 같은 스코어러를 재사용 가능. |
| fzf 계열 JS 포팅(fzf-for-js 등) | 기각 | 번들 추가 + 경로 특화 보너스(basename·구분자)를 결국 커스텀해야 함. 알고리즘 코어(Smith-Waterman류)는 이 규모에서 체감 차이 없음. |
| fuse.js | 기각 | bitap 기반 근사 매칭 — 대량 항목에서 느리고 "vsc→ViewerFileTabs" 같은 subsequence 관례와 결과가 다르다(오타 허용은 요구 아님). |

성능 전략: 백엔드 캡 50,000행/저장소(§4) × subsequence 1패스는 수십 ms 이내(문자 스캔) — 키 입력마다 동기 실행하되, **쿼리가 직전 쿼리의 연장이면(startsWith) 직전 생존자만 재스캔**(fzf 관례, ref 1개). 표시 캡 100행. 빈 쿼리는 스캔 없이 "최근 파일(viewerTabs 역순, `ui.ts:65`) + 나머지 앞부분"을 그대로 보여준다. 최근 파일은 비어 있지 않은 쿼리에서도 고정 보너스로 가산.

### 3.5 QuickPick 프리미티브(공유) — 배치 결정

| 대안 | 판정 | 근거 |
|---|---|---|
| **신규 `src/components/common/QuickPick.tsx`(제네릭 프레젠테이션 컴포넌트)** | **채택** | 입력+리스트+키보드 내비+백드롭을 상태 무관 컴포넌트로 — Quick Open(동기 소스)과 13 심볼 검색(비동기 IPC 소스)이 `source(query)` 하나로 공유. PromptDialog(§2.5)의 z-[60]·stopPropagation·자동 포커스 관례를 미러. |
| PromptDialog 확장(리스트 옵션 추가) | 기각 | Prompt는 "값 입력→확인" 시맨틱(validate/onConfirm) — 리스트 내비·비동기 소스·하이라이트를 얹으면 두 용도 모두 비대해진다. |
| useUi 전역 askQuickPick(req) 패턴(Confirm/Prompt 미러) | 기각 | Confirm/Prompt는 호출부가 산재해 전역 호스트가 이득이지만, QuickPick 사용처는 단축키 진입 2곳(09/13) — 각자 얇은 호스트가 명확하고, 제네릭 타입(`T`)이 전역 스토어를 오염하지 않는다. |

구성: `QuickOpenHost`(09 전용 어댑터)가 `useUi.quickOpenOpen`으로 마운트되어 파일 소스(퍼지 랭킹)와 `onPick→selectDiff`를 QuickPick에 주입한다. 비동기 소스 경합은 QuickPick 내부 seq 토큰으로 최신 쿼리 응답만 반영(13을 위한 계약 — §4).

**비동기 소스의 디바운스·로딩도 프리미티브 책임(13 §3.4 교차 요구)**: `debounceMs?: number`(기본 0 — 09의 동기 소스는 지연 무의미, 13은 250)와 Promise pending 중 내부 로딩 스피너를 QuickPick 계약에 포함한다(§4). 디바운스를 source 함수 내부에 숨기는 대안은 기각 — seq 무효화(디바운스 이후 발사된 요청에만 토큰 부여)·로딩 표시(pending의 시작/끝 관측)가 모두 QuickPick 내부 상태와 얽혀 있어, 소스가 자체 디바운스하면 "타이핑 중인데 스피너가 안 도는" 구간과 토큰 경계가 모호해진다. 09는 둘 다 기본값(디바운스 0·스피너 미표시)으로 통과하므로 비용 없음.

### 3.6 임베디드 저장소 포함
- 호스트가 `useStatuses` 캐시(§2.2)에서 `parentId === 선택 프로젝트`인 임베디드 저장소들(합성 id + relPath)을 모아 `list_repo_files([outerId, ...합성 id들])` **invoke 1개**로 요청.
- 표시 경로는 outer 기준(`relPath + "/" + path`), **열기는 저장소 기준**: `selectDiff({ mode: "file", path }, 합성 id)` — goto-definition(`goto-definition.ts:243`)과 동일 라우팅. 임베디드 항목은 리스트에 `⊂ <relPath>` 힌트 배지.
- outer 결과의 후행 `/` 항목(임베디드 저장소 디렉토리 — §2.2 실측)은 백엔드에서 제외(파일이 아님, 중복 방지).
- statuses 미도착 시(첫 실행 직후) outer만 검색된다 — 수용(다음 열기부터 포함, §6).

### 3.7 범위 절단 (YAGNI)
- **v1**: mod+P 토글 + `list_repo_files` + fuzzy.ts + QuickPick 프리미티브 + QuickOpenHost(최근 파일 가중·임베디드 포함) + E2E.
- **후속(비채택)**: ① 심볼 검색·`@`/`#` 프리픽스 모드(→13이 QuickPick 재사용으로 별도 구현), ② 파일 내용 검색(→08), ③ mod+P 연타로 최근 파일 순환(VS Code), ④ 검색 히스토리 영속, ⑤ 우측 미리보기 패널, ⑥ 터미널 포커스 통과(§3.1).

## 4. 계약(타입·커맨드·이벤트)

**신규 Tauri 커맨드 1개** — `list_repo_files`. 이벤트 신규 0(기존 `repo://changed` 재사용).

```rust
// src-tauri/src/commands/tree.rs — list_project_roots(§2.2) 미러: 배치·오류 격리·buffer_unordered(4).
// git ls-files -z --cached --others --exclude-standard (find_module_files와 동일 인자 — tree.rs:479).
// 사용자 입력이 git 인자로 들어가지 않으므로 인젝션 표면 없음(교차 계약의 grep류 관례 중
// 결과 캡·forward-slash만 해당). 후행 '/' 항목(임베디드 저장소 디렉토리)은 제외.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoFileList {
    pub project_id: String,     // 요청 id 에코(합성 id 포함)
    pub files: Vec<String>,     // 저장소 루트 기준 상대 경로, forward-slash('\\'→'/' — tree.rs:425 관례)
    pub truncated: bool,        // MAX_FILES(50_000) 초과로 절단됨 — UI가 "일부만 표시" 배지
    pub error: Option<String>,  // 저장소별 오류 격리(경로 소실 등) — 배치 전체를 죽이지 않는다
}

#[tauri::command]
pub async fn list_repo_files(
    state: State<'_, AppState>,
    project_ids: Vec<String>,   // [outer, ...합성 id] — project_path가 합성 id를 해석(projects.rs:20)
) -> Result<Vec<RepoFileList>, IpcError>;
// runner::run_git(READ_TIMEOUT_SECS=10s) 사용. lib.rs generate_handler(:270 블록)에 1줄 등록.
```

```ts
// src/lib/ipc.ts — 읽기 전용 배치. 모달 진입 경로라 interactive(기본) 레인, 재시도 허용(기본 3).
export interface RepoFileList {
  projectId: string;
  files: string[];
  truncated: boolean;
  error: string | null;
}
listRepoFiles: (projectIds: string[]) =>
  call<RepoFileList[]>("list_repo_files", { projectIds }, { timeoutMs: 20_000 }),
```

```ts
// src/components/common/QuickPick.tsx (신설) — **09가 정의하고 13이 재사용하는 공유 계약.**
// 렌더: PromptDialog 관례 미러 — fixed inset-0 z-[60] 백드롭(클릭 닫기), 패널 stopPropagation,
// 입력 자동 포커스(setTimeout 0). 리스트는 max-h + overflow-y-auto, 활성 항목 scrollIntoView(nearest).
export interface QuickPickItem<T = unknown> {
  id: string;                 // 리스트 key (파일 경로 / 심볼 위치 등 고유값)
  label: string;              // 주 표기 — 파일명/심볼명
  labelHighlights?: number[]; // label 내 매치 문자 인덱스(퍼지 하이라이트) — 없으면 무강조
  description?: string;       // 보조 표기(디렉토리 경로/시그니처) — truncate 렌더
  hint?: string;              // 우측 배지(임베디드 "⊂ rel", 13의 종류 태그 등)
  data: T;                    // onPick으로 되돌려줄 페이로드
}
export interface QuickPickProps<T> {
  placeholder: string;
  /** 쿼리 → 정렬·캡 완료된 항목. 동기(09: 프론트 퍼지) 또는 Promise(13: IPC 검색) 모두 허용.
   *  비동기 경합은 내부 seq 토큰으로 최신 쿼리 응답만 반영한다(13 계약). */
  source: (query: string) => QuickPickItem<T>[] | Promise<QuickPickItem<T>[]>;
  /** 입력 → source 호출 디바운스(ms). 기본 0(09 — 동기 소스). 13은 250(타이핑 중
   *  grep 중첩 방지 — 13 §3.4와 동기화된 값). 디바운스·seq·로딩은 셋 다 QuickPick
   *  내부 책임 — source에 숨기지 않는다(§3.5). */
  debounceMs?: number;
  onPick: (item: QuickPickItem<T>) => void;  // 선택 시 — 호출 측이 닫기(onClose)까지 수행
  onClose: () => void;
  emptyText?: string;         // 결과 0건 문구 (기본 "결과 없음")
  footer?: React.ReactNode;   // 하단 상태줄(truncated 배지 등) — 선택
}
export function QuickPick<T>(props: QuickPickProps<T>): React.ReactElement;
// 키 규칙: ↑/↓ 활성 이동(순환) · Enter=onPick(활성) · Esc=onClose — 셋 다
// preventDefault+stopPropagation(PromptDialog.tsx:56-67 관례, 전역 핸들러 누수 차단).
// 마우스: hover=활성, 클릭=onPick.
// 로딩(13 §3.4 교차 요구): Promise 소스의 "최신 seq" 요청이 pending인 동안 입력 우측에
// 내부 로딩 스피너를 표시하고, 직전 결과 리스트는 유지한다(깜빡임 방지). 동기 소스는
// pending이 없어 스피너가 나타나지 않는다 — 09는 무영향.
```

```ts
// src/lib/fuzzy.ts (신설) — 09/13 공용 스코어러.
export interface FuzzyHit { score: number; positions: number[] } // positions=매치 문자 인덱스
/** 소문자 subsequence 매치 + 가중치(§3.4). 불일치면 null. */
export function fuzzyMatch(query: string, text: string): FuzzyHit | null;
```

```ts
// src/stores/ui.ts — settingsOpen(:82) 미러. KeyboardShortcuts가 getState()로 토글.
interface UiState {
  quickOpenOpen: boolean;                 // 초기 false, 영속 없음(세션 상태)
  setQuickOpenOpen: (open: boolean) => void;
}
```

```ts
// src/components/KeyboardShortcuts.tsx — KeyboardShortcuts(:34-123) onKey에 추가(등록 위치 §3.1).
// ctrlKey 게이트(:55) "앞"에서 F5(:50-54)처럼 isMod로 직접 검사(mac Cmd 통과 — 08 §3.6 동일).
// 마운트 조건(프로젝트 선택+모아보기 아님, App.tsx:107-117)이 곧 활성 조건 — 별도 가드 불필요.
// preventDefault 필수: WebView2 인쇄 액셀러레이터 억제(검증 필요 — §6, 실패 시 키만 "e"로 교체).
if (isMod(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
  e.preventDefault();
  const ui = useUi.getState();
  ui.setQuickOpenOpen(!ui.quickOpenOpen);
  return;
}
```

```ts
// src/components/quickopen/QuickOpenHost.tsx (신설) — App.tsx의 ConfirmHost/PromptHost(:134-135)
// 형제로 마운트. quickOpenOpen && selectedProjectId && !aggregateOpen일 때만 QuickPick 렌더
// (!aggregateOpen: 모달 열림 중 mod+Shift+A로 모아보기 진입하는 엣지 흡수 — §3.1).
// 소스: useQuery({ queryKey: ["repo-files", ...정렬된 [outer,...합성id]], queryFn: listRepoFiles })
//   — staleTime 30s. events.ts repo://changed 코얼레싱 블록(:56-61)에
//   qc.invalidateQueries({ queryKey: ["repo-files"] }) 1줄 추가.
// onPick: selectDiff({ mode: "file", path: item.data.path }, item.data.repoId) 후 닫기.
```

## 5. 단계(구현 순서)

1. **백엔드 `list_repo_files`** — tree.rs에 커맨드+RepoFileList, lib.rs 등록 1줄. 임베디드 디렉토리(후행 `/`) 제외·50k 캡·forward-slash. 단위 테스트(픽스처 repo — status.rs `embedded_repo_becomes_nested_status` 미러). (~80 LOC + 테스트 ~40)
2. **ipc.ts 계약** — RepoFileList 타입 + `listRepoFiles`. (~15 LOC)
3. **`src/lib/fuzzy.ts`** — fuzzyMatch(subsequence+가중치, §3.4). (~90 LOC)
4. **`QuickPick.tsx` 프리미티브** — §4 계약대로(`debounceMs`·seq 무효화·pending 로딩 스피너 포함 — 13 §3.4 교차 요구). 13이 그대로 쓸 수 있게 Quick Open 특화 로직 금지. (~150 LOC)
5. **`QuickOpenHost.tsx`** — repo-files 쿼리(+statuses에서 합성 id 수집), 랭킹 소스(최근 파일=viewerTabs 가중, 직전 쿼리 생존자 재사용), onPick 라우팅, truncated footer. events.ts invalidate 1줄. (~110 LOC)
6. **ui.ts + KeyboardShortcuts** — quickOpenOpen 상태 2줄 + mod+P 핸들러(§4 — ctrlKey 게이트 앞, 등록 위치 §3.1). StatusBar 안내는 두지 않는다(발견성은 후속 치트시트 — 01 §3.5와 동일 결론). (~15 LOC)
7. **E2E `tests/e2e/suites/20-quick-open.mjs`** —
   - 백엔드(10-codenav.mjs 미러): 픽스처에 파일·`.gitignore`·중첩 git init 생성 → `cdp.invoke("list_repo_files")`로 ① 추적+미추적 포함 ② ignored 제외 ③ 후행 `/` 없음 ④ 합성 id 조회 동작 ⑤ 없는 프로젝트 NOT_FOUND(`10-codenav.mjs:37-38` 패턴) 단언.
   - 프론트(14-frontend-dom.mjs 미러): `__gpv`로 픽스처 선택 → 합성 `Ctrl+P` keydown(`:70-73` 패턴) → `quickOpenOpen===true`+input 출현 → input에 값 주입+`input` 이벤트 → ArrowDown/Enter keydown → `selectedDiff.path` 단언(viewerTabs 업서트 포함) → Esc로 닫힘 단언 → `setAggregateOpen(true)` 후 Ctrl+P 재디스패치 → `quickOpenOpen===false` 유지 단언(등록 위치 §3.1 — KeyboardShortcuts 언마운트) → finally에서 setAggregateOpen(false)·selectDiff(null)·상태 원복.

규모: **M(2~3일)** — Rust ~120 LOC + 프론트 ~380 LOC + E2E ~120 LOC. 신규 커맨드 1개.

## 6. 위험과 완화

| 위험 | 설명 | 완화 |
|---|---|---|
| mod+P가 WebView2 인쇄로 새어나감 | Ctrl+P는 Chromium 인쇄 액셀러레이터 — 웹 콘텐츠 keydown preventDefault가 억제하는 게 Chromium 관례지만 WebView2(+`BASE_BROWSER_ARGS` 무설정, §2.4)에서의 실기 확인 없음(검증 필요). E2E 합성 keydown은 액셀러레이터 경로를 안 타서 이 위험을 못 잡는다 | 실기 스모크(Windows 1회)를 릴리스 체크리스트에 포함. 실패 시 폴백 mod+E로 재배정 — 키 상수는 KeyboardShortcuts 1곳(§3.1 설계로 국소화) |
| 초거대 레포 절단 | 50k 캡 초과분은 검색 불가 — 사용자가 "왜 안 나오지"로 인지 | truncated 배지("일부만 표시 — 더 입력해 좁히세요")를 QuickPick footer로 명시. 캡 상향/스트리밍은 실사용 신호 후(YAGNI) |
| 키 입력 프레임 드랍 | 50k 경로 × 스코어링이 저사양에서 한 프레임(16ms)을 넘을 수 있다 | 직전 쿼리 생존자 재사용(§3.4)으로 후속 키입력은 급감. 그래도 걸리면 QuickPick `debounceMs`(§4 계약에 이미 존재)를 1프레임(16ms)으로 올리면 끝 — 아키텍처 변경 없음 |
| WebView2 응답 유실로 빈 모달 | 첫 조회 invoke가 유실되면 목록이 안 온다 | 단일 배치 invoke + call() 자동 재시도(읽기 전용이라 안전, §2.3) + react-query 캐시가 있으면 이전 목록으로 동작 |
| 임베디드 목록 누락 | statuses 미도착(첫 실행 직후)이면 outer만 검색됨 | 수용 — statuses 도착 후 쿼리 키가 바뀌어 자동 보강. Quick Open이 statuses를 기다리게 하지 않는다(빠른 열기가 우선) |
| 터미널 포커스 중 무동작 | xterm 화이트리스트 비통과는 의도(§3.1 — C-p readline 충돌) | 문서·치트시트(후속)로 안내. 요구가 생기면 화이트리스트 1줄 |
| mac 실기 미검증 | Cmd+P가 WKWebView 기본 메뉴/시스템에 먹히는지 실기 확인 없음(검증 필요) — Tauri 기본 메뉴에 Print 항목 존재 여부가 관건 | 01 §6과 동일 정책: mac 스모크 1회 릴리스 체크리스트. 실패 시 mod+E 폴백 동일 적용 |
