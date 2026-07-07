# 태스크 15 — 포매터 통합 (ruff format / biome)

> 상태: 설계(Design) · 대상: gitpervisor · 산출물 성격: 아키텍처/계약/단계/위험 (구현은 후속)
> 근거: 코드 실측 2026-07-06 · 관련: [01-aggregate-hotkey.md](01-aggregate-hotkey.md)(단축키 충돌 목록·등록 관례) · 태스크 16(외부 린터 — **이 문서 §3.2 러너 계약을 재사용**, 중복 정의 금지)

## 1. 요구사항

뷰어에서 열어 편집 중인 파일을 **Shift+Alt+F**(및 저장 시 옵션)로 코드 포맷한다.

- 파이썬(.py/.pyi) → **ruff format**, 웹(.ts/.tsx/.js/.jsx/.json/.css) → biome vs prettier 비교 후 채택(§3.1).
- 포맷 결과는 에디터에 **최소 edit**로 적용 — 커서·undo 스택·스크롤을 파괴하는 전체 `setValue` 금지.
- 저장 시 자동 포맷은 **설정 옵트인**(기본 꺼짐).
- 미설치 시: 토스트 안내 + 설정으로 유도. ~~자동 바이너리 다운로드는 비채택(전 문서 공통)~~ **[2026-07-07 개정]** 구현에서 **빌드 시 번들 폴백**으로 발전: 발견 순서에 ④번들(`runner.rs discover` — `scripts/fetch-tools.mjs`가 버전 pin+게시자 해시 검증으로 채움, `tauri.conf.json` bundle.resources). "앱 런타임의 자동 다운로드"는 여전히 안 하나, 원칙 자체는 "발견 우선+검증된 폴백"으로 개정됨 — LSP(17 §3.3)는 런타임 관리형 다운로드 채택. 00-INDEX §4.3 참조.
- 범위: **뷰어 파일뷰(`mode:"file"`, 편집 가능)만 v1.** diff뷰·이미지·마크다운 미리보기는 제외.
- **외부 도구 러너 계약을 이 문서가 정의**한다(바이너리 발견·실행·타임아웃·미설치 UX) — 태스크 16(린터)이 그대로 재사용.

## 2. 현황(근거)

### 2.1 뷰어 편집·저장 파이프라인 — 포맷이 접속할 흐름
- 편집 가능 조건: `src/components/diff/DiffViewer.tsx:104` `editable = isFileView && !isImageView`. 뷰어가 받는 projectId는 `diffRepoId ?? projectId`(`src/components/workspace/ViewerTab.tsx:31`) — 임베디드 저장소도 합성 id로 라우팅되고, 백엔드 `project_path`가 `<outer>::<rel>`을 해석한다(`src-tauri/src/commands/projects.rs:12-20`) → 포맷 커맨드도 자동 대응.
- 저장: `DiffViewer.tsx:168-183` `saveRef` — `writeFile.mutateAsync` 성공 시 `baselineRef` 갱신 + `setDirty(false)` + 토스트. Ctrl+S는 Monaco `addCommand`로 내부 등록(`:219-221`). 뮤테이션은 `useWriteFile`(`src/queries/index.ts:724-735`) → `write_file`(`src-tauri/src/commands/tree.rs:31-53`, `resolve_in_repo` 컨테인먼트 `:695-712`).
- dirty 판정: `onDidChangeModelContent`에서 `getValue() !== baselineRef.current`(`DiffViewer.tsx:215-217`). **포맷이 모델을 바꾸면 이 리스너가 dirty=true를 만든다** — 별도 배선 불필요.
- 내용 동기화 효과(`DiffViewer.tsx:195-206`): `dirtyRef.current`면 쿼리/워처 데이터로 **덮어쓰지 않는다** → 포맷 직후(dirty) 화면이 디스크 내용으로 되돌아가는 사고 없음. 저장하면 dirty가 풀리고 watcher invalidate가 정상 재동기화(기존 흐름 그대로).
- 입력 크기 상한: 뷰어는 1.5MB 초과 파일을 표시하지 않음(`src-tauri/src/commands/diff.rs:15` `MAX_DIFF_BYTES = 1_572_864`) → 포맷 입력도 같은 상한이면 충분.

### 2.2 Monaco 0.55.1 포맷 인프라 — 로컬 소스(node_modules) 실측
- **Shift+Alt+F는 Monaco 내장 키**: `FormatDocumentAction`(id `editor.action.formatDocument`)의 primary가 `Shift+Alt+F`, Linux만 `Ctrl+Shift+I`(`node_modules/monaco-editor/esm/vs/editor/contrib/format/browser/formatActions.js:192-194`). 발화 조건 `editorTextFocus`(`:191`), precondition은 `notInCompositeEditor && writable && hasDocumentFormattingProvider`(`formatActions.js:189`) — **notInCompositeEditor**는 복합(내부) 에디터에서 발화 자체를 막는 조건이라 diff뷰류 임베디드 에디터를 Monaco 스스로 배제한다 → §1 "v1 파일뷰 한정" 결정의 보강 근거. `EditorAction` 상속 + `registerEditorAction`(`:184`,`:245`) — Action2 기반 goto류와 달리 `editor.getAction()`이 null이 아니다(0.55 함정 비적용).
- precondition 키는 document **또는** range provider가 있으면 참(`…/browser/widget/codeEditor/codeEditorWidget.js:1730`).
- **오늘의 동작(암묵 기능)**: TS/JS 워커가 range 포맷 provider를 등록하고(`…/vs/language/typescript/tsMode.js:175-177`, 우리 설정도 켜둠 — `src/components/diff/monaco-setup.ts:53` `documentRangeFormattingEdits: true`), JSON/CSS 워커는 document 포맷 provider를 등록한다(`…/vs/language/json/jsonMode.js:119-131`, `…/vs/language/css/cssMode.js:168-170`). → **ts/js/json/css는 지금도 Shift+Alt+F가 "워커 기본 포맷"(들여쓰기·공백 수준, 따옴표·세미콜론·줄폭 관리 없음)으로 동작하고, python은 provider가 없어 무동작.**
- provider 선택: standalone 기본 셀렉터는 **formatter[0]**(`…/vs/editor/editor.api2.js:19`). 목록은 document provider가 앞, range provider는 뒤에 합성 편입(`…/format/browser/format.js:27-56`). 같은 score(언어 id 셀렉터)면 **나중 등록이 앞**(`…/vs/editor/common/languageFeatureRegistry.js:145-166` `_time` 역순) — JSON/CSS 워커는 언어 첫 사용 시 지연 등록이라 앱 시작 시 등록한 우리 provider보다 늦어 **동률에서 워커가 이길 수 있다**(§3.3에서 해소).
- 적용 파이프라인(전체 `setValue` 금지의 근거): provider가 edit를 돌려주면 ① **Monaco가 에디터 워커 diff로 최소 edit를 재계산**(`format.js:246` `computeMoreMinimalEdits`), ② 진행 중 사용자 편집/커서 이동 시 결과 폐기(`format.js:237` `EditorStateCancellationTokenSource(Value|Position)`, `:247-249`), ③ 적용은 undo 스탑 전후 + 스크롤 상대위치 복원(`…/format/browser/formattingEdit.js:39`,`:41`,`:51`,`:53`) — replace/replaceMove 시맨틱(`:45`,`:48`). → **provider가 전체 범위 edit 1건만 줘도 커서·undo·스크롤 보존은 Monaco가 해준다.**
- `registerDocumentFormattingEditProvider`는 런타임 실존(`…/vs/editor/standalone/browser/standaloneLanguages.js:420`).
- 재사용할 프론트 전례: provider 1회 등록 가드(`src/components/diff/goto-definition.ts:167-171`), 언어 목록 순회 등록(`:219-222`), 파일 컨텍스트 주입(`DiffViewer.tsx:147-149` `setDefContext`), 워커 기능 선별 차단(`monaco-setup.ts:44-58` `tsModeNoDefs` — setModeConfiguration은 교체 방식이라 전체 필드 나열), dev `window.__monaco` 노출(`:437-439`).

### 2.3 외부 도구 실행 인프라 — 현재 git 전용, 신규 러너 필요
- `src-tauri/src/git/runner.rs:107-114` `run_git` — "모든 git 실행의 단일 관문", `Command::new(git)` 고정. **임의 바이너리 실행 유틸은 코드베이스에 없다.**
- 미러할 관례: 바이너리 발견 `where.exe`/`command -v` + 고정 폴백(`runner.rs:52-77`/`:79-105`), 설정 오버라이드 `RwLock`(`:30-44`), stdin 파이프 변형(`run_git_with_stdin` `:175-235` — drop으로 EOF 전달), `kill_on_drop` + `tokio::time::timeout`(`:139`,`:154`), Windows `CREATE_NO_WINDOW`(`:146-147`), 읽기 타임아웃 10초(`:9`).
- 포매터는 gitpervisor 자신의 의존성이 아니다: `package.json:23-53`에 biome/prettier/ruff 없음 → **사용자 환경(PATH)·대상 레포에서 발견**해야 한다.
- 설정 확장 지점: `Settings`는 구조체 레벨 `#[serde(default)]`(`src-tauri/src/git/types.rs:196`)라 **필드 추가가 하위호환**(Default `:226-247`). 프론트 미러 `src/lib/ipc.ts:146-165`, UI 입력 전례 `src/components/settings/SettingsDialog.tsx:521-523`(gitPath).
- 오류 코드: `src-tauri/src/error.rs:5-26`에 도구 미설치용 코드 없음(신규 `ToolNotFound` 필요). 프론트 미러 `ipc.ts:347-364`.
- 토스트: `src/stores/ui.ts:5-9` `Toast`(액션 버튼 없음), `pushToast`(`:255-259`).
- IPC 규약: 읽기 `call()`은 single-flight + lane + 타임아웃(`ipc.ts:489-521`), 변경은 `callMutating`(재시도 금지, `:561-584`).

### 2.4 단축키 충돌·플랫폼
- Shift+Alt+F는 앱 전역 키와 무충돌 — 기존 전수 목록(01 문서 §2.5) + `src/components/KeyboardShortcuts.tsx:50-116` 실측(F5·Ctrl+K/T/`·Ctrl+Shift+D/E/W/K·Ctrl+W)에 Alt 조합 없음.
- **GlobalShortcuts·terminal-engine 화이트리스트(`src/lib/terminal-engine.ts:190-198`) 추가 불필요** — Monaco 내부 키바인딩은 에디터 포커스에서만 발화(§2.2 `editorTextFocus`)하고, 터미널 포커스 중 포맷은 요구사항이 아니다.

## 3. 설계

### 3.1 웹 포매터 선택 — biome 채택

| 후보 | 판정 | 근거 |
|---|---|---|
| **biome** | **채택** | 단일 네이티브 바이너리(Rust) — node 런타임 불필요, 프로세스 기동 ms급(검증 필요 — 이 머신에 미설치 §2.3, §5 1단계 실측). stdin→stdout 포맷 지원(`biome format --stdin-file-path=<path>`)(검증 필요). ts/tsx/js/jsx/json 안정 + css 지원(최신 안정 버전 기준 — 검증 필요). 러너 계약(§3.2)에 그대로 맞음(ruff와 동형: "바이너리 하나"). |
| prettier | 기각(v1) | 바이너리가 아니라 JS — node 발견·버전 문제가 러너 계약에 별도 축을 추가하고, 프로세스 콜드 기동 수백 ms(포맷 한 번에 체감 지연)(검증 필요 — §5 1단계 실측; 단 "node 발견·버전 별도 축" 기각 사유는 성능과 독립). 단 생태계 표준이라 **프로젝트가 .prettierrc 기반이면 biome 결과와 스타일 불일치**(§6) → 후속 과제로 prettier 러너 옵션. |
| @prettier/standalone 번들 내장 | 기각 | 외부 프로세스 없이 웹뷰 안에서 포맷 가능하지만, 파이썬(ruff)은 어차피 외부 바이너리라 **두 체계 이원화** + 번들 비대 + 태스크 16(린터)은 내장 불가라 러너 계약이 결국 필요. |
| dprint | 기각 | 플러그인(wasm) 설치·관리 체계가 별도로 필요 — 단일 바이너리 2개(ruff·biome)보다 표면적이 큼. |

파이썬은 **ruff format** 확정(요구사항 명시 — black 호환 스타일 + 단일 바이너리. black은 파이썬 런타임 필요라 기각).

### 3.2 외부 도구 러너 계약 (공유 — 태스크 16 재사용, 이 문서가 원 출처)

| 대안 | 판정 | 근거 |
|---|---|---|
| **`src-tauri/src/tools/runner.rs` 신설** | **채택** | git/runner.rs는 git 경로 캐시·GitNotFound에 결합된 단일 관문(§2.3) — 일반화하면 git 안전 규약이 흐려진다. stdin/timeout/kill_on_drop/CREATE_NO_WINDOW 관례만 미러한 별도 모듈이 16(린터)과의 공유 표면. |
| `run_git` 일반화(바이너리 인자화) | 기각 | 모든 기존 호출부가 "git 전용 관문" 전제를 잃음. env 주입(`GIT_TERMINAL_PROMPT` 등)도 도구별로 무의미. |
| 프론트에서 PTY(터미널)로 실행 | 기각 | dirty 에디터 내용을 파일 저장 없이 포맷할 수 없고(§1), stdout 파싱·종료코드 수집이 셸 의존적이며 인젝션 표면이 생긴다. |

**계약 (16이 그대로 재사용):**

1. **발견 순서** — ① 설정 명시 경로(존재+파일 검증, 실패 시 즉시 오류 — 조용한 폴백 금지: 사용자가 지정한 도구가 아닌 것으로 포맷되면 안 됨) → ② *(옵트인, 기본 꺼짐)* 프로젝트 로컬(§6 공급망) → ③ PATH(`where.exe`/`command -v`, `runner.rs:52-77` 미러) → **④ 앱 번들 폴백 [2026-07-07 구현 소급]**(`tools/runner.rs:175-189` — 아무것도 없을 때 resource_dir/tools의 검증된 번들 사용, §1 개정 각주 참조).
2. **프로젝트 로컬 후보(옵트인 시에만)** — ruff: `.venv/Scripts/ruff.exe`·`venv/Scripts/ruff.exe`(Windows), `.venv/bin/ruff`·`venv/bin/ruff`(unix). biome: `node_modules/@biomejs/cli-<platform>/biome(.exe)`(플랫폼 패키지 배치 — 검증 필요) 및 `node_modules/.bin/biome.exe`. **`.cmd`/`.bat`/`.ps1` 셔틀은 실행 금지** — `cmd /C` 경유가 필요해 콘솔 창·인자 재해석(인젝션) 표면이 생긴다. 진짜 실행 파일만.
3. **실행** — 인자는 백엔드가 도구 enum별 고정 배열로 조립. 사용자 유래 문자열 중 **`resolve_in_repo`(`tree.rs:695-712`)를 통과한 레포 상대 경로만 인자로 허용**, 그 외 사용자 유래 문자열은 인자 금지. 소비자별 준수 형태: 15는 경로를 `--stdin-filename`/`--stdin-file-path` 값으로(§3.4, 내용은 stdin), 16은 위치 인자로(내용은 실파일 — 16 §3.2-3.3). 경로 인자는 **`--` 구분자 뒤에 두거나 선행 `-`를 `./` 접두로 중화** — `-v.py` 같은 파일명이 도구 플래그로 오파싱되는 것 방지(`--` 지원 여부는 도구별 검증 필요, 미지원이면 `./` 중화 고정). `run_git_with_stdin` 미러: stdin piped→write→drop(EOF), stdout/stderr 수집, `kill_on_drop(true)`, `CREATE_NO_WINDOW`, cwd=레포 루트(도구의 설정 파일 탐색 기준 — 검증 필요).
4. **타임아웃** — 10초(`READ_TIMEOUT_SECS` 감각 — ruff/biome 포맷은 실측상 ms~수십 ms급 도구(검증 필요), 10초면 병리적 상황만 걸림). 초과 시 `Timeout` 오류.
5. **미설치 UX** — 신규 `ErrorCode::ToolNotFound` → 프론트 토스트 "`ruff`가 설치되어 있지 않습니다 — 설정에서 경로를 지정하거나 설치하세요" + 토스트 액션 버튼(신규, §4)으로 설정 열기. ~~자동 다운로드 기각~~ **[2026-07-07 개정]** ④번들 폴백 구현으로 이 경로는 "번들까지 없을 때"(비표준 빌드)만 발생 — 원격 획득의 공급망 문제는 빌드 시 fetch-tools(pin+해시 fail-fast)가 흡수. §1 개정 각주·17 §3.3 참조.
6. **상태 조회** — `format_tool_status`(§4)가 도구별 `{found, path, source, version}`을 반환 — 설정 UI "설치됨 ✓ (경로)" 표시 + E2E 게이트.

### 3.3 Monaco 적용 방식 — DocumentFormattingEditProvider + 전체범위 edit 1건

| 대안 | 판정 | 근거 |
|---|---|---|
| **`registerDocumentFormattingEditProvider` 등록, 전체범위 edit 1건 반환** | **채택** | Shift+Alt+F 키바인딩·컨텍스트 메뉴("Format Document")·precondition·**최소 edit 재계산(`format.js:246`)·재편집 시 취소(`:237`)·undo 스탑·스크롤 복원(`formattingEdit.js:37-53`)을 전부 Monaco가 처리**(§2.2). 우리 코드는 "문자열 in → 문자열 out"만. |
| 프론트에서 자체 prefix/suffix diff로 최소 edit 계산 | 기각 | `computeMoreMinimalEdits`(§2.2)가 에디터 워커에서 이미 diff 기반 최소화를 수행 — 중복 구현. |
| 헤더 버튼에서 `setValue`/`executeEdits` 직접 호출 | 기각 | `setValue`는 커서·undo·뷰스테이트 파괴 + 내용 동기화 효과(§2.1)와 별도 조율 필요. `executeEdits` 직접 호출은 키바인딩·취소·precondition을 수동 재구현하는 것. |

- **provider 언어**: `python`, `typescript`, `javascript`, `json`, `css`(+`tsx/jsx`는 Monaco 언어 id상 typescript/javascript에 포함). goto-definition의 순회 등록 패턴(`goto-definition.ts:219-222`) 미러, 1회 등록 가드(`:167-171`) 미러.
- **컨텍스트**: provider는 모델만 받으므로 projectId·relPath를 모듈 컨텍스트로 주입 — `setDefContext`(`DiffViewer.tsx:147-149`) 관례를 미러한 `setFormatContext(projectId, relPath)`를 같은 효과에서 호출(파일뷰의 Editor 모델은 path 없는 자동 URI라 URI에서 역산 불가).
- **워커 포매터 경합 해소**: JSON/CSS 워커의 document provider는 지연 등록이라 동률에서 우리를 이긴다(§2.2). → `jsonDefaults`/`cssDefaults`의 `setModeConfiguration`으로 `documentFormattingEdits`/`documentRangeFormattingEdits`만 끈다(`tsModeNoDefs` 전례 — 교체 방식이므로 기본값 전체 나열, `monaco-setup.ts:44-58` 미러). TS/JS는 끌 필요 없음 — 워커는 range뿐이고 document provider(우리)가 목록에서 항상 앞(`format.js:30-54`). Format Selection(Ctrl+K Ctrl+F)은 TS/JS 워커에 그대로 남는다(v1 무간섭).
- **provider 구현**: `model.getValue()` → `ipc.formatSource(...)` → `changed=false`면 `[]`, 아니면 `[{ range: model.getFullModelRange(), text: formatted }]`. 도구 미설치·오류는 여기서 잡아 토스트 후 `[]` 반환(포맷 액션은 조용히 no-op — `format.js:254-256` edits 없으면 종료).
- **dirty/저장 상호작용(실측 §2.1)**: 포맷 edit → `onDidChangeModelContent` → dirty=true → 저장 버튼 활성 + 동기화 효과가 덮어쓰지 않음. 추가 배선 0.
- **저장 시 자동 포맷(옵트인)**: `saveRef.current`(§2.1) 앞단에 — `settings.formatOnSave && editable && 지원 언어`면 `await ed.getAction("editor.action.formatDocument")?.run()` 후 저장. **포맷 실패(미설치·구문 오류)여도 저장은 진행**(포맷은 보조 — 저장을 인질로 잡지 않는다).
- **발견성**: 뷰어 헤더 저장 버튼(`DiffViewer.tsx:292-306`) 옆에 "포맷" 버튼(지원 언어에서만 렌더, `title="포맷 (Shift+Alt+F)"`). Linux는 Monaco 기본이 Ctrl+Shift+I(§2.2)라 title을 플랫폼별로 병기.

### 3.4 백엔드 커맨드 흐름
`format_source`: ① `project_path`(합성 id 대응) ② `resolve_in_repo(repo, rel_path)`(`tree.rs:695-712`)로 절대경로 확정 — 파일명은 도구의 설정·언어 판별 힌트(`--stdin-filename`/`--stdin-file-path`)로만 쓰고 디스크는 읽지 않는다(dirty 내용은 stdin — resolve_in_repo 통과 경로라 §3.2-3 경로 인자 허용 규정에 부합) ③ 확장자→도구 매핑 ④ 러너 발견·실행 ⑤ exit 0 → formatted 반환, exit≠0 → `GitError`류가 아닌 `Io`+stderr(구문 오류 등 도구 메시지 그대로) ⑥ 입력 1.5MB 초과 거부(§2.1 상한 미러).

IPC 규약: 읽기 전용 계산(레포 무변경)이므로 `call()` — 단 프로세스 스폰이라 `attempts: 1`(유실 시 재시도로 이중 스폰 방지 — 멱등이지만 낭비), `timeoutMs: 20_000`(백엔드 10s보다 여유), lane은 사용자 제스처라 `interactive`. 커맨드 등록은 `src-tauri/src/lib.rs:270` `generate_handler!` 블록.

### 3.5 범위 절단 (YAGNI)
- **v1**: 파일뷰 × {py, ts/tsx, js/jsx, json, css} × {Shift+Alt+F, 헤더 버튼, 컨텍스트 메뉴(공짜)} + 저장 시 포맷 옵트인 + 설정(경로 2·토글 2) + 러너 계약.
- **후속**: ① prettier 러너(.prettierrc 프로젝트 존중 — §6 스타일 불일치의 근본 해소), ② Format Selection 자체 구현, ③ md/yaml/html/rust(rustfmt) 확장, ④ diff뷰에서 바로 포맷, ⑤ ruff의 임포트 정렬(`ruff check --select I --fix`)은 태스크 16(린터) 영역, ⑥ 프로젝트별 포매터 설정(전역 설정만 v1).

## 4. 계약(타입·커맨드·이벤트)

```rust
// src-tauri/src/tools/runner.rs (신설 — 태스크 16 공유 표면)
pub enum Tool { Ruff, Biome }                       // 16이 variant 추가(RuffCheck는 같은 Ruff 바이너리)
pub enum ToolSource { Explicit, ProjectLocal, Path } // 발견 출처 — status 노출·감사용
pub struct ToolBin { pub path: PathBuf, pub source: ToolSource }
/// 발견 순서 §3.2. allow_project_local=false면 ②를 건너뛴다(기본).
pub fn discover(tool: Tool, repo: &Path, explicit: Option<&Path>, allow_project_local: bool) -> Option<ToolBin>;
/// run_git_with_stdin(runner.rs:175-235) 미러 — kill_on_drop·CREATE_NO_WINDOW·타임아웃.
pub async fn run_tool_stdin(bin: &ToolBin, args: &[&str], stdin: &[u8], timeout_secs: u64)
    -> Result<ToolOutput, IpcError>;                 // ToolOutput { code, stdout: Vec<u8>, stderr: String }
```

```rust
// src-tauri/src/commands/format.rs (신설) — lib.rs:270 블록에 등록
#[tauri::command] pub async fn format_source(
    state: State<'_, AppState>, project_id: String, rel_path: String, content: String,
) -> Result<FormatResult, IpcError>;
// FormatResult { formatted: Option<String>, changed: bool, tool: String }  (camelCase serde)
//   changed=false → formatted=None (1.5MB 왕복 페이로드 절약)
#[tauri::command] pub async fn format_tool_status(
    state: State<'_, AppState>, project_id: String,
) -> Result<Vec<ToolStatus>, IpcError>;
// ToolStatus { tool: String, found: bool, path: Option<String>, source: Option<String>, version: Option<String> }

// src-tauri/src/error.rs — ErrorCode에 ToolNotFound 추가 ("TOOL_NOT_FOUND")
```

```rust
// src-tauri/src/git/types.rs Settings 필드 추가 (serde default라 하위호환 — :196)
pub formatter_ruff_path: Option<String>,   // 명시 경로 (null=자동 발견)
pub formatter_biome_path: Option<String>,
pub formatter_project_local: bool,          // 프로젝트 로컬 바이너리 허용 — 기본 false (§6).
                                            // 이 옵트인은 16 린트(파일 열람만으로 자동 실행 — 16 §3.3/§6)에도 적용:
                                            // 열람=실행으로 위험 표면 확대. 설정 UI 문구에 반드시 병기.
pub format_on_save: bool,                   // 저장 시 자동 포맷 — 기본 false
```

```ts
// src/lib/ipc.ts — Settings 미러 4필드 + ErrorCode "TOOL_NOT_FOUND" 추가
export interface FormatResult { formatted: string | null; changed: boolean; tool: string }
export interface FormatToolStatus { tool: string; found: boolean; path: string | null; source: string | null; version: string | null }
formatSource: (projectId, relPath, content) =>
  call<FormatResult>("format_source", { projectId, relPath, content }, { timeoutMs: 20_000, attempts: 1 }),
formatToolStatus: (projectId) =>
  call<FormatToolStatus[]>("format_tool_status", { projectId }, { attempts: 1, lane: "background" }),
```

```ts
// src/components/diff/format-provider.ts (신설) — goto-definition.ts:167-171/:219-222 미러
export function registerFormatProviders(): void;                   // 1회 가드, 언어별 등록
export function setFormatContext(projectId: string, relPath: string): void; // DiffViewer.tsx:147-149 효과에서 호출
// provider: getValue() → ipc.formatSource → [] | [{ range: fullModelRange, text }]
// ToolNotFound catch → pushToast(action: 설정 열기) 후 [] 반환
```

```ts
// src/stores/ui.ts — Toast 액션 버튼(옵션) 확장. 기존 pushToast(:255-259) 시그니처 호환 유지.
export interface Toast { id: number; kind: ...; message: string;
  action?: { label: string; run: () => void } }   // "설정 열기" → setSettingsOpen(true)
```

이벤트 신규 0. 키 신규 등록 0 — **Shift+Alt+F는 Monaco 내장**(§2.2), provider 등록만으로 활성화된다.

## 5. 단계(구현 순서)

1. **외부 사실 확정 + `tools/runner.rs`** — ruff/biome 설치 후 "(검증 필요)" 항목 실측 확정: §3.1 기동 지연(biome ms급·prettier 수백 ms 주장), stdin 플래그, §3.2 플랫폼 패키지 배치, 경로 인자 `--` 구분자 지원, §6 EOL 정책. 이어 Tool/discover/run_tool_stdin (~130 LOC, runner.rs 미러라 대부분 이식).
2. **`commands/format.rs` + ErrorCode::ToolNotFound + lib.rs 등록** — format_source/format_tool_status (~120 LOC).
3. **Settings 4필드** — types.rs(+Default)·ipc.ts 미러·SettingsDialog "포매터" 섹션(경로 입력 2 — gitPath 전례 `:521-523`, 토글 2, format_tool_status 상태 표시) (~80 LOC).
4. **프론트 provider** — format-provider.ts(~90) + monaco-setup.ts json/css 워커 포맷 off(~15) + DiffViewer setFormatContext·포맷 버튼(~30).
5. **저장 시 포맷** — saveRef 확장 (~15 LOC) + **Toast action** (~15 LOC).
6. **E2E** — `tests/e2e/suites/20-formatter.mjs` 신설:
   - 게이트: `format_tool_status`로 ruff/biome 발견 확인, 미설치면 `r.skip`(14-frontend-dom.mjs:18-20의 스킵 전례).
   - 커맨드 레벨(10-codenav.mjs:18/:37-38 invoke·오류코드 검증 전례 미러): 픽스처에 어질러진 `.py`/`.ts` 작성 → `cdp.invoke("format_source", …)` → 결과 정규형·`changed` 플래그·**멱등성**(2회째 changed=false) 검증. 음성 케이스: 잘못된 rel_path(`../x`) 거부, 1.5MB 초과 거부, (도구 하나를 명시 경로로 오지정 후) `TOOL_NOT_FOUND`.
   - DOM 레벨(14-frontend-dom.mjs:90 `selectDiff({mode:"file"…})` 전례): 파일뷰 열기 → `window.__monaco` + `__gpv`로 에디터 획득 → `editor.getAction("editor.action.formatDocument").run()` → 모델 값 변경 + dirty(저장 버튼 "저장 *") 확인 → Ctrl+Z 1회로 원복(undo 스탑 검증).

규모: **M(2~4일)** — 백엔드 ~250 LOC + 프론트 ~250 LOC + 테스트. 러너 계약이 절반(16이 회수).

## 6. 위험과 완화

| 위험 | 설명 | 완화 |
|---|---|---|
| **공급망 — 프로젝트 로컬 바이너리 실행** | `node_modules/.bin`·`.venv`의 실행 파일은 **레포가 심는 것** — 악성 레포를 열고 포맷 한 번이면 임의 코드 실행. **이 옵트인(`formatter_project_local`)은 태스크 16 린트에도 적용된다(16 §3.3/§6)** — 린트는 파일 열람만으로 자동 실행되므로, 옵트인 시 위험 표면이 "명시적 포맷 제스처"에서 "열람=실행"으로 확대. 대안 비교: ① 전역 PATH+명시 경로만(안전, 프로젝트별 버전 무시) ② 프로젝트 로컬 자동(편리, 위험) ③ **옵트인 전역 설정(채택)** — 기본 꺼짐, 설정 문구에 위험 명시("신뢰하는 프로젝트에서만" + 16 자동 실행 적용 사실 병기 — §4), `.cmd`/`.bat` 셔틀 금지(§3.2), 발견 출처(`source`)를 status·토스트에 노출해 어떤 바이너리가 돌았는지 항상 확인 가능 | 기본값은 ①과 동일 동작. 프로젝트 단위 신뢰 목록은 v1 비채택(설정 표면 과잉 — 후속) |
| json/css 워커 포맷 대체 회귀 | 워커 포맷을 끄면(§3.3) biome 미설치 환경에서 지금 되던(암묵) json/css Shift+Alt+F가 사라짐 | 끄는 시점을 biome provider 등록과 원자적으로 묶고, 미설치 시 토스트가 설치를 안내(무반응이 아님). "워커 폴백 유지" 대안은 등록 순서 경합(§2.2)이 비결정적이라 기각 |
| 프로젝트 표준 포매터와 불일치 | prettier 표준 레포를 biome으로 포맷하면 대량 diff·리뷰 오염 | 포맷은 명시적 제스처(자동 아님, formatOnSave도 옵트인) + 토스트에 도구명 표시 + undo 1회 복구(§2.2 undo 스탑) + 후속 prettier 러너(§3.5) |
| EOL(CRLF) 정규화 대량 diff | ruff/biome이 stdin 입력의 개행을 LF로 통일하면 파일 전체가 변경으로 잡힐 수 있음(도구별 EOL 보존 정책 — 검증 필요) | E2E에 CRLF 픽스처 케이스 추가, 문제 시 백엔드에서 입력 EOL 감지→출력 재적용 (~15 LOC) |
| 구문 오류 파일 | 도구가 비0 종료 — 포맷 불가 | stderr를 토스트로 그대로 전달(도구 메시지가 위치를 알려줌), 내용 무변경, 저장은 별개로 가능(§3.3) |
| 포맷 중 파일 전환·편집 경합 | 결과 도착 전에 모델이 바뀌면 낡은 결과 적용 위험 | Monaco가 구조적으로 차단 — `EditorStateCancellationTokenSource(Value\|Position)`(`format.js:237`)가 편집·커서 이동 시 결과 폐기(`:247-249`). 추가 코드 0 |
| WebView2 invoke 응답 유실 | 포맷 호출이 영원히 pending → 무반응처럼 보임 | `attempts:1 + timeoutMs 20s`(§3.4) — 실패 토스트 후 재시도는 사용자 키 입력(멱등). 슬롯 독점 없음(single-flight, `ipc.ts:506-521`) |
