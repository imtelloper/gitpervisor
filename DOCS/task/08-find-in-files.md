# 태스크 08 — 전역 코드 검색 (Find in Files)

> 상태: 설계(Design) · 대상: gitpervisor · 산출물 성격: 아키텍처/계약/단계/위험 (구현은 후속)
> 근거: 코드 실측 2026-07-06 · 관련: [01-aggregate-hotkey.md](01-aggregate-hotkey.md)(GlobalShortcuts·platform 헬퍼·xterm 화이트리스트 전례), [09-quick-open.md](09-quick-open.md)(파일 "이름" 검색 QuickPick — 본 태스크는 파일 "내용" 검색으로 역할 분리)

## 1. 요구사항

프로젝트 전체에서 텍스트/정규식을 검색하는 **Find in Files**(PyCharm/WebStorm `Ctrl+Shift+F` 상당)를 추가한다.

- `mod+Shift+F`(mac=Cmd, 그 외=Ctrl)로 검색 패널을 열고 입력에 포커스.
- 옵션: 대소문자 구분 · 단어 단위 · 정규식 · include 글롭(예: `*.ts`, `src/**`).
- 결과는 **파일별 그룹핑** + 매치 라인 표시 + **검색어 하이라이트**.
- 결과 항목 클릭 → 뷰어에서 해당 파일의 그 라인·열로 점프(기존 go-to-definition 착지 인프라 재사용).
- 재검색 연타 시 이전 요청 무효화(스테일 응답이 새 결과를 덮지 않게).
- 거대 레포(nqvm-ais 17.6GB)에서도 UI가 멈추지 않아야 한다 — 결과 캡 필수.
- 터미널(xterm) 포커스 중에도 단축키가 동작해야 한다.

## 2. 현황(근거)

### 2.1 grep 백엔드 참조 구현 — find_definition이 관례를 이미 확립
- `src-tauri/src/commands/tree.rs:364-458` `find_definition` — `git grep -P -n --column --no-color -I --untracked`(`:389-391`)로 검색. 패턴은 **`-e` 인자로 전달**(`:392-395`) — `-`로 시작하는 패턴의 플래그 인젝션이 구조적으로 불가. 확장자 pathspec은 `--` 뒤에 붙인다(`:396-401`).
- **pathspec 가속 실측이 코드 주석으로 남아 있다**: `tree.rs:386-388` "확장자 pathspec으로 대상 언어 파일만 스캔한다 — 거대 레포(데이터·미디어 포함)에서 사후 필터 대비 수 배 빠르다(실측 nqvm-ais 1.4s → 0.2s)". 즉 **전체 스캔도 ~1.4초 수준**(패턴 3개 기준)이고, pathspec을 주면 ~0.2초.
- 입력 검증: 심볼은 영숫자·`_`·`$`만 허용(`:372-377`) — 패턴 인젝션·과검색 방지. 결과 캡 12(`:446`), 상대경로 forward-slash 정규화(`:425`), `--column`의 열을 심볼 시작 **문자 단위**로 보정(`:427-431`).
- 매치 없음 = exit 1 = 정상(빈 stdout)이라는 주석(`:383-386`). `run_git`은 exit code를 `GitOutput.code`로 준다(`src-tauri/src/git/runner.rs:19-21`, `:167-171`) — **무매치(1)와 오류(그 외)를 구분 가능**.
- 실행 관문: `runner.rs:108-114` `run_git`(인자 배열만 — 셸 문자열 조합 금지), 타임아웃 시 `kill_on_drop`으로 프로세스 정리(`:139`, `:153-154`). 읽기 타임아웃 `READ_TIMEOUT_SECS = 10`(`:9`).
- 커맨드 등록: `src-tauri/src/lib.rs:270` `invoke_handler`, `find_definition`은 `:302`.
- 로컬 git 실측(2.49.0.windows.1, `git grep -h`): `-i`(대소문자), `-w`(단어), `-F`(고정 문자열), `-P`(PCRE), `--untracked`, `--column`, **`-m/--max-count <n>`(파일당 최대 결과)** 전부 존재. 단 사용자가 지정한 구버전 git의 `-m` 지원 하한 버전은 미확정(검증 필요 — Git 릴리스 노트).

### 2.2 IPC 호출 규약
- `src/lib/ipc.ts:489-491` `MAX_CONCURRENT 8` · 기본 타임아웃 8s · 재시도 3. 같은 `(cmd+args)` 진행 중 호출은 single-flight로 1건에 합쳐진다(`:503-521`) — **같은 쿼리 Enter 연타는 invoke 1개만 쓴다**. lane(interactive/background)은 `:499-500`, `findDefinition`의 lane 파라미터 전례는 `:680-685`.
- 읽기 커맨드에 개별 `timeoutMs`/`attempts` 지정 전례: `readFileBase64` `:611-616`(30s·재시도 1).

### 2.3 점프 인프라 — 이미 완성돼 있어 재사용만 하면 된다
- `DiffTarget`의 `file` 모드는 `line`/`column`을 갖는다(`ipc.ts:80` "line/column=점프 도착 심볼 위치").
- `src/stores/ui.ts:181-198` `selectDiff` — 대상을 뷰어 탭으로 업서트(같은 키의 탭이 있으면 target만 갱신 → **같은 파일 내 라인 이동은 기존 탭에서 일어남**). go-to-definition의 점프 호출 전례: `src/components/diff/goto-definition.ts:243` `selectDiff({ mode: "file", path, line, column }, ctx?.projectId)`.
- `src/components/diff/DiffViewer.tsx:129-141` `revealTarget` — 줄 중앙 스크롤 + 심볼 단어 선택 + 포커스. 같은 파일 내 위치만 바뀌어도 재마운트 없이 이동하는 효과(`:227-230`).
- `src/components/workspace/WorkspaceTabs.tsx:74-77` — `selectedDiff`가 설정되면 **Viewer 탭으로 자동 전환**. 터미널/브라우저 탭을 보던 중 결과를 클릭해도 뷰어가 앞으로 나온다.

### 2.4 결과 UI를 둘 자리 — 세 전례가 모두 존재
- **하단 접이식 패널**: `src/components/log/LogPanel.tsx:10-42`(토글 헤더 + 펼침 영역), 높이 드래그 `ResizeHandle`(`:45-95`, pointer+rAF). 높이는 `ui.ts:134-137` localStorage 복원 + `:221-225` `setLogHeight` 클램프·영속. 마운트는 `src/App.tsx:116`(선택 프로젝트 분기 안).
- **사이드바 패널**: `src/components/tree/FileTreePanel.tsx:692-696`(`style={{width}}` + `border-r` 패널), 마운트 `App.tsx:102-104` — 이미 ProjectList + FileTree 2개가 가로를 점유.
- **중앙(뷰어) 탭**: `WorkspaceTabs.tsx:81-133` TabChip 열(`:277-319`), fixed z-50 메뉴+백드롭 관례(`:219-224`).

### 2.5 단축키 현황 — mod+Shift+F는 비어 있다
- `src/components/KeyboardShortcuts.tsx:34-123` — 프로젝트 선택 시 마운트(`App.tsx:117`). 핸들러는 `:55` `if (!e.ctrlKey) return;` 게이트라 mac Cmd 미지원 — **신규 키는 F5(`:50-54`)처럼 게이트 앞에서 `isMod`로 직접 검사**해야 한다. 항상-마운트 `GlobalShortcuts`(`:13-26`)는 mod+Shift+A 전례.
- 기존 키 전수(01 §2.5 표 + 이후 추가분): F5 / Ctrl+K / Ctrl+Shift+K / Ctrl+T / Ctrl+\` / Ctrl+Shift+D·E·W / Ctrl+W / Ctrl+Shift+↑↓ / mod+Shift+A(`KeyboardShortcuts.tsx:16`) / Ctrl(+Shift)+C·V(터미널 내) — **Ctrl+Shift+F·Cmd+Shift+F 미사용**. 교차 문서 예약 키(09=mod+P, 10=mod+Shift+O, 11=Shift+F12, 13=mod+Alt+N, 15=Shift+Alt+F)와도 안 겹침.
- xterm 통과 화이트리스트: `src/lib/terminal-engine.ts:190-198` — Ctrl+\`(`:192`), Ctrl+Shift+D/E/W(`:193`), Ctrl+Shift+↑/↓(`:195-196`), mod+Shift+A(`:198`). **신규 키도 한 줄 추가하지 않으면 터미널 포커스 중 무시된다.**
- Monaco 충돌 실측(`node_modules/monaco-editor/esm/vs/editor/contrib/find/browser/findController.js`): 에디터 내 찾기 = `Ctrl/Cmd+F`(`:432`), 바꾸기 = `Ctrl+H`·mac `Cmd+Alt+F`(`:786-787`). **Ctrl+Shift+F / Cmd+Shift+F는 Monaco 코어에 미바인딩** — 뷰어 포커스 중에도 window로 버블된다.
- `src/lib/platform.ts:8-10` `isMod`, `:13` `modLabel` — 01이 신설한 헬퍼 재사용.

### 2.6 E2E 인프라
- CDP 커맨드 직접 구동 전례: `tests/e2e/suites/10-codenav.mjs:18` `cdp.invoke("find_definition", …)` — 신규 IPC 검증의 표준형. 포트 스캔 `tests/e2e/lib/cdp.mjs:10`(29222 우선).
- 프론트 DOM 구동 전례: `tests/e2e/suites/14-frontend-dom.mjs:71-73` 합성 keydown 디스패치, `:135-140` xterm textarea 포커스 후 키 검증(Ctrl+W), `:166-186` Ctrl+Shift+A 단축키 검증(터미널 포커스 케이스 포함), `:25-27` `window.__gpv` 스토어 헬퍼. dev 노출은 `src/main.tsx:33-37`(`__gpv`)·`monaco-setup.ts:437-438`(`__monaco`).

## 3. 설계

### 3.1 검색 엔진 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **git grep (`-F`/`-P` 스위치)** | **채택** | 항상 가용(git은 앱 코어 의존 — `runner.rs:124-129`가 미설치를 이미 처리). find_definition으로 실전 검증된 경로(pathspec 실측 가속 `tree.rs:386-388`). `.gitignore` 자동 제외(node_modules·target을 공짜로 뺌) + `--untracked`로 새 파일 포함. **리터럴 모드는 `-F`(고정 문자열)라 패턴 이스케이프 문제가 원천 소멸.** |
| ripgrep 실행 | 기각 | 더 빠르지만 미설치 환경이 존재(`tree.rs:361-362` 주석이 같은 이유로 git grep 선택). 외부 도구 발견·미설치 UX는 15의 러너 계약 영역이고, 자동 바이너리 다운로드는 전 문서 공통 비채택. |
| Rust 자체 walker + regex 크레이트 | 기각 | .gitignore/바이너리 판정/인코딩을 전부 재구현 — git grep이 무료로 주는 것을 수백 LOC로 복제. PCRE 대비 문법도 갈라짐. |
| 프론트(JS)에서 파일 순회 | 기각 | 파일 목록·내용을 IPC로 나르는 순간 WebView2 동시 invoke 유실 규약과 페이로드 폭주에 정면충돌. |

### 3.2 신규 IPC `search_in_project` — 인자·검증·캡

find_definition의 관례(입력 검증 → `-e` 패턴 → `--` pathspec → 캡 절단 → forward-slash)를 그대로 따른다.

- **모드**: `regex=false`(기본) → `-F`(고정 문자열, 이스케이프 불필요). `regex=true` → `-P`(PCRE — find_definition과 동일 플레이버, `\b` 지원).
- **검증**: 쿼리 빈 문자열·1자(전량 매치 유발) 거부, 길이 캡 512. 정규식 컴파일 실패는 git이 exit≠0/1 + stderr로 알려준다 → `GIT_ERROR`로 표면화(사용자에게 "잘못된 정규식" 토스트). exit 1(무매치)은 빈 결과.
- **옵션 매핑**: `case_sensitive=false` → `-i` · `whole_word=true` → `-w` (둘 다 로컬 git 2.49 실측 존재 — §2.1).
- **include 글롭 → pathspec**: `--` 뒤에 그대로. 검증 — 절대경로·`..` 컴포넌트·**선행 `:`(pathspec 매직 `:!`·`:(exclude)` 등) 거부**, 개수 캡 8. find_definition의 `*{ext}` 글롭(`tree.rs:388`)과 동일 통로.
- **캡(3중)**: ① git 수준 `-m 50`(파일당 — 미니파이/락파일 한 파일 폭주 차단, 구버전 git 폴백은 §6) ② 파싱 수준 총 500 매치에서 절단 + `truncated=true` ③ 라인 텍스트는 매치 중심 **240자 윈도우**로 잘라 반환(열은 윈도우 기준으로 재계산 — 미니파이 1줄 수 MB가 IPC를 타지 않게).
- **성능 전략(17.6GB)**: git grep은 추적+미추적(무시 제외) 파일만 스캔 — 전체 스캔 실측 ~1.4s(§2.1), pathspec 시 ~0.2s. 명시적 Enter 실행(§3.4)이므로 콜드 1~2초는 수용 범위. include 글롭이 곧 pathspec 가속 경로다. 백엔드 타임아웃은 `READ_TIMEOUT_SECS`(10s) 유지 — 초과 시 `kill_on_drop`으로 git 프로세스 정리(`runner.rs:139`).

### 3.3 결과 UI 위치 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **하단 접이식 패널(LogPanel 형제)** | **채택** | 매치 라인은 가로로 길다 — 전폭 하단이 유일하게 안 잘린다. 뷰어와 **동시 표시**: 결과 클릭→점프해도 결과 리스트가 남아 다음 항목으로 이동 가능(Find in Files의 핵심 루프). 토글 헤더·높이 드래그·localStorage 영속까지 LogPanel(`:10-42`,`:45-95`)을 그대로 미러 — 신규 패턴 0. |
| 사이드바 패널(FileTree 형제) | 기각 | 이미 ProjectList+FileTree 2개가 가로 점유(`App.tsx:101-104`) — 3번째 세로 패널은 뷰어 폭을 압살. 좁은 폭에 긴 매치 라인이 말줄임돼 하이라이트가 안 보임. |
| 뷰어(중앙) 탭 | 기각 | 결과 클릭 시 `selectDiff`가 Viewer 탭으로 자동 전환(`WorkspaceTabs.tsx:74-77`)돼 **결과 화면 자체가 사라진다** — 항목 순회 UX 파탄. 탭 인프라도 터미널/브라우저/API 전용 구조라 개조 비용만 크다. |
| 중앙 모달(PyCharm 다이얼로그형) | 기각 | 뷰어를 가림 — 점프 확인 후 재검색하려면 재오픈. Esc 처리·포커스 트랩 등 신규 패턴 추가. PyCharm도 점프 후엔 하단 Find 툴윈도우로 내려보낸다. |

배치: `App.tsx`의 선택 프로젝트 분기 안, `<LogPanel/>` 바로 위(`:116` 위치) — 둘 다 접이식이라 동시 펼침도 자연스럽다. 검색 대상은 `selectedProjectId`(임베디드 중첩 저장소는 v1 제외 — §3.7).

### 3.4 실행·무효화·취소 흐름

| 대안 | 판정 | 근거 |
|---|---|---|
| **Enter 명시 실행** | **채택** | 17.6GB 레포에서 키스트로크당 git spawn(콜드 ~1.4s×N)은 IPC 슬롯 8개(`ipc.ts:489`)를 굶긴다. Enter 실행이면 동시 검색은 사실상 1건. |
| 라이브 검색(300ms 디바운스) | 기각(후속 후보) | 소형 레포에선 쾌적하나 레포 크기별 분기·최소 글자수 규칙이 v1 범위를 넘는다. |

- **스테일 드롭**: 스토어에 `seq` 카운터 — 실행 시 `++seq`를 캡처, 응답 도착 시 캡처 값 ≠ 현재 `seq`면 폐기. 다른 쿼리로 재검색하면 이전 응답이 새 결과를 덮지 못한다. 같은 쿼리 연타는 single-flight(`ipc.ts:503-521`)가 invoke 1건으로 병합.
- **취소**: `seq` 증가 + `searching=false`(UI 즉시 해제). 백엔드 git 프로세스는 별도 cancel 커맨드 없이 10s 타임아웃 + `kill_on_drop`이 정리 — **취소 IPC 비채택**(검색은 읽기 전용·10s 상한이라 잔여 실행 무해. http_cancel 같은 취소 계약은 120s급 네트워크 작업용).
- 호출 규약: `lane: "interactive"`, `attempts: 1`(무거운 검색 자동 재실행 금지 — 유실 시 사용자가 Enter 재입력), `timeoutMs: 15_000`(백엔드 10s + 여유).

### 3.5 하이라이트·그룹핑·컨텍스트

- **그룹핑**: 백엔드가 파일 단위로 묶어 반환(`SearchFile[]`) — git grep 출력이 파일 순서라 파싱 중 그룹핑이 공짜. 파일 헤더(경로+건수, 클릭 접기) 아래 매치 라인 나열.
- **하이라이트는 프론트 재계산** — 백엔드는 `text`+`column`만 준다. 리터럴: `indexOf`(대소문자 옵션 반영, 길이=쿼리 길이) — 정확. 정규식: `new RegExp(pattern, flags)` best-effort — 컴파일/매치 실패 시 하이라이트만 생략(결과 자체는 정확). 백엔드가 매치 길이를 주는 대안은 Rust에서 PCRE 재실행이 필요해(regex 크레이트는 PCRE 비호환) 기각.
- **컨텍스트 라인 — 대안 비교**:

| 대안 | 판정 | 근거 |
|---|---|---|
| **컨텍스트 없음(매치 라인 1줄)** | **채택** | 클릭 → `revealTarget`이 줄 중앙+심볼 선택으로 즉시 컨텍스트를 준다(`DiffViewer.tsx:129-141`) — 점프 인프라가 완성돼 있어 미리보기의 존재 이유가 약함. 페이로드 최소. |
| `git grep -C 2` 포함 | 기각 | 출력에 `--` 구분자·비매치 라인이 섞여 파서 복잡도 급증 + 페이로드 ~5배. |
| 호버 미리보기(gitpervisor-def 모델 재사용) | 기각(후속) | `ensurePreviewModel`(goto-definition.ts:88-104) 재사용 여지는 있으나 v1 가치 대비 과잉. |

### 3.6 키 배정 — `mod+Shift+F` 확정

| 후보 | 판정 | 근거 |
|---|---|---|
| **mod+Shift+F** | **채택** | 앱 내 미사용 + 교차 문서 예약과 무충돌(§2.5). Monaco 코어 미바인딩(실측 §2.5 — Ctrl+F/Ctrl+H만 사용). PTY 제어문자 아님(Ctrl+Shift 조합은 셸 의미 없음 — Windows Terminal도 같은 키를 자체 검색에 씀). VS Code/PyCharm 전역 검색 관례와 일치. WebView2/WKWebView 예약 아님(검증 필요 — 브라우저 액셀러레이터 목록에 부재 추정). |
| mod+F | 기각 | Monaco 에디터 내 찾기(`findController.js:432`)와 정면충돌 — 뷰어 포커스 중 파일 내 찾기를 죽인다. |
| mod+H | 기각 | Monaco 바꾸기(`:786`)와 충돌. |
| mod+Shift+H | 기각 | "바꾸기 in Files" 관례(VS Code) — 후속 Replace 기능을 위해 비워둔다(§3.7). |

- **등록 위치: `KeyboardShortcuts`(프로젝트 선택 시 마운트)** — 검색 대상이 선택 프로젝트라 마운트 조건이 요구와 정확히 일치(01의 GlobalShortcuts가 필요했던 "모아보기 중에도" 요구가 여기엔 없다 — 모아보기 화면엔 검색 패널 자체가 없음). 단 `:55`의 `e.ctrlKey` 게이트는 mac Cmd를 걸러내므로 **F5(`:50`)처럼 게이트 앞에서 `isMod(e) && e.shiftKey && !e.altKey && key==="f"`로 직접 검사**한다.
- 동작: 닫혀 있으면 열고 입력 포커스, 열려 있으면 입력 재포커스+전체선택(재검색 타이핑 즉시 시작). 뷰어에 선택 텍스트가 있으면 쿼리로 프리필(후속 — v1 제외). 입력 포커스 중 `Escape` = 패널 닫기(메뉴 닫기 관례 미러 — 터미널 포커스가 아니므로 Claude Code 중단 키와 무충돌).
- **xterm 통과 1줄**: `terminal-engine.ts:198`의 mod+Shift+A 옆에 `if (isMod(e) && e.shiftKey && k === "f") return false;` — 없으면 터미널 포커스 중 무시된다(§2.5).
- 발견성: 패널 헤더와 (여유 시) Toolbar 검색 아이콘 `title`에 `modLabel` 병기(`⌘⇧F` / `Ctrl+Shift+F`).

### 3.7 범위 절단 (YAGNI)

- **v1**: 리터럴/정규식 + 대소문자/단어/include 글롭 + 하단 결과 패널(그룹핑·하이라이트·캡·truncated 안내) + 클릭 점프 + Enter 실행/스테일 드롭 + 단축키.
- **후속**: ① Replace in Files(쓰기 경로·프리뷰·원자성 — 별도 태스크급), ② 라이브 검색(디바운스), ③ exclude 글롭 필드(v1은 include만 — pathspec 매직 비허용 유지), ④ 임베디드 중첩 저장소 검색(git grep은 중첩 repo에 재귀하지 않음 — 합성 projectId `<outer>::<rel>`로 저장소별 재실행 필요), ⑤ 검색 히스토리·선택 텍스트 프리필, ⑥ 결과 항목 호버 미리보기(§3.5), ⑦ `git grep` 대신 커밋/브랜치 대상 검색(`<rev>` 인자).

## 4. 계약(타입·커맨드·이벤트)

**신규 Tauri 커맨드 1개** (`src-tauri/src/commands/search.rs` 신설, `lib.rs` invoke_handler 등록). 이벤트 신규 0.

```rust
// commands/search.rs — find_definition 관례(검증→ -e 패턴→ -- pathspec→캡→forward-slash) 준수
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line: u32,          // 1-based
    pub column: u32,        // 1-based, 문자 단위(text 윈도우 기준 — tree.rs:427-431 보정 미러)
    pub text: String,       // 매치 라인(매치 중심 최대 240자 윈도우, lossy UTF-8)
}
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct SearchFile { pub path: String, pub matches: Vec<SearchMatch> } // path: 레포 상대·forward-slash
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub files: Vec<SearchFile>,
    pub total_matches: u32,  // 절단 전 카운트 아님 — 반환된 매치 수(캡 500 이하)
    pub truncated: bool,     // 캡 절단 발생("결과 500+개 — 조건을 좁히세요" 배너)
}

/// git grep [-F|-P] -n --column --no-color -I --untracked [-i] [-w] [-m 50] -e <query> [-- <globs…>]
/// 검증: query 2..=512자 · include는 절대경로/`..`/선행 `:` 거부·최대 8개.
/// exit 1=빈 결과 · exit>1=GIT_ERROR(stderr 포함 — 잘못된 정규식 등).
#[tauri::command]
pub async fn search_in_project(
    state: State<'_, AppState>,
    project_id: String,
    query: String,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    include: Vec<String>,
) -> Result<SearchResult, IpcError>
```

```ts
// src/lib/ipc.ts — 타입 미러 + 메서드
export interface SearchMatch { line: number; column: number; text: string }
export interface SearchFileHit { path: string; matches: SearchMatch[] }
export interface SearchResult { files: SearchFileHit[]; totalMatches: number; truncated: boolean }
export interface SearchOpts {
  regex: boolean; caseSensitive: boolean; wholeWord: boolean; include: string[];
}
// 재시도 금지(무거운 검색 자동 재실행 방지 — 유실 시 사용자가 Enter 재입력), 백엔드 10s+여유.
searchInProject: (projectId: string, query: string, opts: SearchOpts) =>
  call<SearchResult>("search_in_project", { projectId, query, ...opts },
    { timeoutMs: 15_000, attempts: 1 }),
```

```ts
// src/stores/search.ts (신설) — zustand, ui.ts 관례(localStorage per-key 영속) 미러
interface SearchState {
  open: boolean;                 // 세션 상태(aggregateOpen 미러 — 영속 없음)
  height: number;                // "gp:search-height" 영속 — setLogHeight(ui.ts:221-225) 클램프 미러
  query: string;
  opts: SearchOpts;
  result: SearchResult | null;
  searching: boolean;
  error: string | null;
  seq: number;                   // 스테일 드롭 토큰(§3.4)
  openPanel(): void;             // open=true — 입력 포커스는 컴포넌트 effect가 담당
  closePanel(): void;
  run(projectId: string): void;  // ++seq 캡처 → ipc.searchInProject → seq 일치 시에만 반영
  cancel(): void;                // ++seq + searching=false
}
```

```ts
// src/components/search/SearchPanel.tsx (신설) — LogPanel 구조 미러(토글 헤더+ResizeHandle+본문)
// 결과 클릭: useUi.getState().selectDiff({ mode: "file", path, line, column })
//   — goto-definition.ts:243 전례. repoId 생략(=선택 프로젝트) — 중첩 저장소는 v1 제외(§3.7).

// src/components/KeyboardShortcuts.tsx — onKey에 게이트(:55) 앞 추가:
//   if (isMod(e) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
//     e.preventDefault(); useSearch.getState().openPanel(); return; }

// src/lib/terminal-engine.ts — 화이트리스트(:198 옆) 한 줄:
//   if (isMod(e) && e.shiftKey && k === "f") return false;
```

## 5. 단계(구현 순서)

1. **`commands/search.rs` 신설 + `lib.rs` 등록** — 인자 검증, git grep 조립(`-F`/`-P` 분기, `-m 50`), 파서(파일 그룹핑·240자 윈도우·캡 절단), exit code 분기. (~160 LOC Rust)
2. **`ipc.ts` 타입 + `searchInProject`** — (~30 LOC)
3. **`stores/search.ts`** — seq 스테일 드롭 포함. (~70 LOC)
4. **`SearchPanel.tsx`** — 헤더(입력 + Aa/W/.\*/글롭 토글 버튼 + 카운트/truncated 배너) + 파일 그룹 리스트 + 하이라이트(`<mark>` 스팬) + EmptyState(무결과/오류). LogPanel의 ResizeHandle 미러. (~230 LOC)
5. **배선** — App.tsx에 `<SearchPanel/>`(LogPanel 위), KeyboardShortcuts 키 추가, terminal-engine 화이트리스트 1줄, title 병기. (~20 LOC)
6. **E2E** — `tests/e2e/suites/20-find-in-files.mjs` 신설:
   - 백엔드(10-codenav 미러): 픽스처에 다국어 파일 작성 → `cdp.invoke("search_in_project", …)`로 리터럴/대소문자/단어단위/정규식/include 글롭 각 1건, 파일당 캡(-m)·총 캡·truncated, 잘못된 정규식→`GIT_ERROR`, `..` 글롭 거부, 없는 프로젝트→`NOT_FOUND`.
   - 프론트(14-frontend-dom 패턴): `Ctrl+Shift+F` 합성 keydown(`:71-73` 미러) → 패널 DOM 출현·입력 포커스 확인 → `__gpv` 스토어로 쿼리 주입+실행 → 결과 행 DOM 단언 → 결과 클릭 → `__gpv.ui.getState().selectedDiff`가 `{mode:'file', line}`인지 단언 → xterm textarea 포커스 상태에서 재디스패치(`:135-140` Ctrl+W 패턴 미러) → Escape로 닫힘 → 상태 원복.

규모: **M(2~3일)** — Rust ~160 + 프론트 ~350 LOC + 테스트. 신규 커맨드 1, 이벤트 0.

## 6. 위험과 완화

| 위험 | 설명 | 완화 |
|---|---|---|
| 흔한 단어 검색의 과대 출력 | `-m` 미지원 구버전 git(지원 하한 버전 검증 필요)에서는 파일당 캡이 빠져 git이 전량을 pipe에 쓴다 — `run_git`은 stdout 전체를 수집하므로 순간 메모리 피크 | `-m` 실패 시(비정상 exit) 없이 재실행하는 폴백 + 파싱 총 500 절단 + 10s 타임아웃·`kill_on_drop`(runner.rs:139)이 상한. 쿼리 최소 2자 강제. 잔존 위험은 문서화 |
| PCRE↔JS 정규식 문법 차 | 검색은 git(-P·PCRE), 하이라이트는 JS RegExp 재실행 — lookbehind 변형·POSIX 클래스 등에서 어긋날 수 있다 | 하이라이트만 조용히 생략(결과 라인·점프는 백엔드 값이라 정확). 재현 케이스는 후속에서 매치 오프셋 백엔드 계산으로 승격 |
| .gitignore된 파일은 검색 불가 | git grep 특성(추적+미추적, 무시 제외) — node_modules 제외는 장점이지만 "무시된 로컬 설정 파일"은 못 찾는다 | v1 수용(성능 방어와 동전의 양면). 패널에 "무시된 파일 제외" 힌트 표기. 필요 시 후속에서 `--no-exclude-standard` 옵션 |
| 스테일/좀비 검색의 슬롯 점유 | 응답 유실(WebView2)이나 장시간 검색이 IPC 슬롯(8개)을 문다 | attempts 1 + 15s 프론트 타임아웃으로 슬롯 점유 상한. 스토어가 동시 검색을 1건으로 강제(seq) — 최악 점유 1/8 슬롯 |
| 라인 번호 스테일 점프 | 검색 후 파일이 편집되면 결과의 line이 어긋난 위치로 착지 | `revealTarget`이 단어 미일치 시 커서만 놓아 오작동은 없음(DiffViewer.tsx:134-139). truncated/스테일 안내와 함께 재검색 유도. watcher 연동 자동 재검색은 과잉(비채택) |
| 비UTF-8 파일의 열 어긋남 | `from_utf8_lossy` 치환으로 column(문자 단위) 계산이 밀릴 수 있다 | find_definition과 동일 수준 수용 — 점프는 라인 중심이라 체감 미미. 바이너리는 `-I`가 이미 제외 |
| WebView2/WKWebView 키 예약 | Ctrl+Shift+F·Cmd+Shift+F가 keydown으로 도달하는지 실기 미검증(검증 필요) | E2E 6단계 합성 keydown + 실기 스모크 1회를 릴리스 체크리스트에 포함. 01의 mac 검증 항목과 묶어 진행 |
| 네이티브 브라우저 패널 포커스 중 무반응 | 브라우저 탭은 별도 child webview — keydown이 메인 웹뷰에 안 온다 | 구조적 한계 수용(기존 단축키 전부 동일 — 01 §6 미러) |
