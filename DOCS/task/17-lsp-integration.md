# 태스크 17 — LSP 통합 (아키텍처 v2)

> 상태: **M1 + M2 venv + M3 + M4 완주 — LSP provider 7종 완성(2026-07-07)** · 설계 v2 · 대상: gitpervisor
>
> **M1 완주** — basedpyright 브리지(commands/lsp.rs·lsp/acquire.rs) + 프론트 어댑터
> (src/lib/lsp/{client,providers,sync}.ts) + 휴리스틱 게이트 + 옵트인 UI. 실앱 검증: 타입 인지
> 자동완성, 로컬 정의 점프, 호버, publishDiagnostics→뷰어 마커(owner `lsp:{key}`), 누수 0.
>
> **M2 venv 탐지 완료** — `acquire::detect_python`(.venv/venv/env/VIRTUAL_ENV/시스템, 절대경로) →
> `python` 섹션 config `pythonPath` 응답(연구 실측: 이 키로만 채택, 바 이름 폐기, initializationOptions
> 무시, `.venv` 자동 인식). 실앱 검증: venv 전용 모듈 해석·미해결 진단 0.
>
> **M3 TypeScript 완주** — typescript-language-server 5.3.0 + typescript 5.9.3(관리 사본, 워크스페이스
> tsserver 옵트인 `lsp_workspace_tsserver`). tsserver 배선은 `initializationOptions.tsserver.path`
> (tls 5.3.0은 `--tsserver-path` 플래그 없음 — de-risk 실측). **references·signatureHelp provider 추가**
> (py·ts 공통, 5 provider 완비). **실앱 검증**: TS 타입 인지 자동완성(52개 string 메서드), 정의 점프,
> 참조(3건), 시그니처("combine(a: number, b: string): string"), 앱 옵트인 경로 세션 자동 활성, 누수 0.
>
> **M4 완주** — `rename`(F2, prepareRename + WorkspaceEdit: 현재 파일은 Monaco 라이브 적용,
> 다른 파일은 ipc.writeFile로 디스크 적용[resolve_in_repo 가드], 오프셋 역순 applyLspEdits) +
> `inlayHints`(TS는 tsserver preferences로 활성 — 리터럴 파라미터명·타입). **실앱 검증**: rename
> WorkspaceEdit(정의+사용처), applyLspEdits 역순 적용, inlayHint 4종(반환/파라미터/변수 타입), 등록.
> → **provider 7종 완비**: completion·hover·definition·references·signatureHelp·rename·inlayHints.
>
> **M2 획득 자동화 완료(node 번들 포함)** — `lsp_ensure` 커맨드 + `acquire::ensure_installed`:
> npm tarball(**pin sha512** → flate2/tar 해제) + **node 런타임**(PATH 없으면 다운로드 → nodejs.org
> **SHASUMS256(sha256)** 검증 → win=zip·unix=tar.gz 해제) → temp→rename 원자 설치 → `.ok` 마커,
> 진행률 Channel. `resolve_node`(PATH→관리 사본). 설정에 "언어 서버 다운로드" 버튼(클릭=동의).
> **검증**: 서버 재다운로드 멱등 + 제거 후 실다운로드→설치(실앱), node zip URL·SHASUMS·해시·zip
> 레이아웃·실행 실물 검증, parse_shasums/sha256 유닛 테스트. 신규 crate: flate2·tar·sha2·zip.
>
> **C++(clangd) 추가(2026-07-07)** — 언어 중립 구조를 살려 clangd(22.1.6, LLVM 네이티브 바이너리 —
> **node 불필요**)를 붙였다. `ResolvedServer`를 program+args로 일반화(py/ts=node+js, cpp=clangd 직접
> 실행, stdio 기본). 획득은 clangd/clangd GitHub 릴리스 zip(sha256 pin[Win]+zip 해제+원자 설치 —
> node용 zip 로직 재사용). extToLang에 c/h/cpp/cc/cxx/hpp 등, LSP_LANGS에 cpp/c. **실앱 검증**:
> lsp_ensure('cpp')→clangd 다운로드(15s)→ready, 타입 인지 완성(Widget 멤버), 정의 점프, 누수 0.
> compile_commands.json(CMake `CMAKE_EXPORT_COMPILE_COMMANDS=ON`)은 clangd가 자동 인식(있으면 정확).
> **다른 언어(rust-analyzer·gopls·jdtls 등)도 동일 패턴으로 저비용 확장** — 러너·어댑터·획득이 기반.
>
> **다국어 확장(2026-07-07)** — 획득을 데이터 기반(`NativeSpec`)으로 일반화해 언어 추가를 항목 하나로.
> 병렬 리서치로 각 서버 획득 방식 실측 후 3방식으로 정리:
> - **네이티브 다운로드**(GitHub 릴리스 바이너리, node 불필요): clangd(C/C++)·**rust-analyzer(Rust)**·
>   **lua-language-server(Lua)**. 아카이브 3종(zip·gz단일·tar.gz) `ArchiveKind`로 처리, sha256 pin.
> - **PATH 발견**(툴체인 제공, 프리빌트 없음): **gopls(Go)** — `gopls serve`, ~/go/bin·GOBIN·GOPATH 탐색.
> **실앱 검증**: rust(`r.`→멤버·정의, 단 첫 로딩 ~10-30s), lua(`M.`→멤버), go(PATH 발견 정상 — 미설치 감지).
>
> **추가 5개 언어(2026-07-08)** — 병렬 리서치(실다운로드+실행 실측) 후 기존 3패턴에 항목 추가로 완결:
> - **npm+node**(deps 웹팩 번들 0-install): **intelephense(PHP)** 1.18.5 — `node lib/intelephense.js
>   --stdio`, sha512 pin. basedpyright와 동일 구조. **네이티브 다운로드**: **zls(Zig)** 0.16.0 —
>   win=zip(flat, zls.exe)/unix=tar.xz(신규 `ArchiveKind::TarXz` — 시스템 tar로 해제), stdio 무인자.
> - **PATH 발견**(프리빌트 없음 — 툴체인 설치본): **ruby-lsp(Ruby)**·**csharp-ls(C#, ~/.dotnet/tools)**·
>   **jdtls(Java)**. jdtls 앱 내 다운로드는 JRE21+launcher jar glob+config/data 특수처리라 보류하고,
>   PATH 발견으로 편입(brew/mason 설치본 — gopls/ruby/csharp와 동일 티어).
> - Zig는 Monaco 내장 언어가 아니라 monaco-setup에 `register`+monarch 토크나이저로 직접 등록.
> **실앱 검증**: php(`$r->`→w/h/area, intelephense 다운로드 1.8s)·zig(`r.`→멤버, zls 다운로드 0.9s, Zig
> 툴체인 없이 로컬 구조체 분석)·ruby/csharp/java(PATH 발견 정상 — 툴체인 미설치 감지). 누수 0.
>
> **→ 태스크 17 완료.** provider 7종 · **파이썬·TS/JS·C/C++·Rust·Lua·Go·PHP·Zig·Ruby·C#·Java(11개 언어군)**.
> 앱 내 완전 획득(node·npm 서버·네이티브 바이너리·PATH 발견 4방식). 알려진 한계: rust-analyzer는 Cargo
> 프로젝트+cargo 툴체인 필요(첫 로딩 느림), 시스템 헤더·deps 없는 프로젝트는 외부 import 미해결(환경 문제).
> 근거: 코드 실측 2026-07-07(**08~16 구현 완료 상태** 기준) + 외부 배포 실측(npm 레지스트리·nodejs.org·GitHub 릴리스 — 전부 실제 HTTP 호출·tarball 해부로 확인, §2.9)
> 관련: [15-formatter.md](15-formatter.md)·[16-lint-markers.md](16-lint-markers.md)(러너·마커 인프라 재사용), [11-find-references.md](11-find-references.md)·[13-symbol-search.md](13-symbol-search.md)(LSP가 상위 호환으로 대체), [08-find-in-files.md](08-find-in-files.md)·[09-quick-open.md](09-quick-open.md)(LSP와 무관하게 유지)

**v1(2026-07-06) 대비 바뀐 결정 4가지:**
1. **서버 획득**: "자동 바이너리 다운로드 비채택" **철회** → 발견 우선 + **관리형 다운로드 폴백**(§3.3). 근거: 15/16에서 번들 폴백(runner.rs discover ④)·버전 pin+해시 검증 다운로드(fetch-tools.mjs)가 구현·검증되어 전례가 성립했고, "사용자 환경이 셋팅되어 있다는 보장이 없다 — 우리쪽에 있어야 한다"는 제품 결정이 확정됨(세션 2026-07-07).
2. **진단(publishDiagnostics) v1 포함**(§3.7). v1 절단 근거였던 "뷰어는 린터가 아니다"가 16 구현으로 소멸 — owner 분리 마커 인프라가 실존하고(lint-markers.ts), 사용자가 실사용에서 요구한 것이 정확히 "타입/구문 오류 빨간 밑줄"이다.
3. **TS 서버: vtsls → typescript-language-server 채택 변경**(§3.2). tarball 해부 실측이 결정: vtsls는 의존 트리(npm install) 없이는 실행 불가, typescript-language-server는 의존성 0 단일 tarball — 획득 모델(§3.3)과의 정합이 기능 패리티 우위를 이긴다.
4. 인용 앵커 전면 갱신(08~16 구현으로 라인 시프트 + 신설 파일).

## 1. 요구사항

뷰어(Monaco)에 **타입 인지 자동완성 · 정확한 정의/참조 점프 · 리네임 · 시그니처 힌트 · 인레이 힌트 · 타입 진단(빨간 밑줄)**을 붙인다.
현행 휴리스틱(git grep)과 ruff/biome(규칙 린트)은 "규칙 위반"까지만 — **타입 오류(`add("x")` 인자 불일치 등)는 언어 서버만 잡는다.**

- 대상 언어 v1: **Python + TypeScript/JavaScript**. 그 외 언어는 휴리스틱 유지.
- **옵트인**: 프로젝트별 명시 활성화(기본 OFF). 프로젝트 18개(운영 실측) 자동 기동은 메모리 폭주.
- **"그냥 되는" 획득**: 사용자 머신에 서버가 없어도 동작해야 한다 — 발견 우선(사용자/프로젝트 설치본), 없으면 동의 1회 후 관리형 다운로드(§3.3). 단 **앱 설치파일에는 번들하지 않는다**(node 런타임 35.5MB 실측 — §2.9 — 때문에 ruff/biome처럼 번들하면 설치파일이 폭증).
- LSP 미가용(획득 거부·크래시·비대상 언어)이면 **기존 휴리스틱+ruff/biome로 자동 폴백** — 지금보다 나빠지는 경로가 없어야 한다.
- 규모: **L**(주 단위) — 마일스톤 분할·중간 폴백 필수(§5).

## 2. 현황(근거)

### 2.1 현행 코드 인텔리전스 — 전부 휴리스틱, 타입 자리가 비어 있음
- 정의 검색: `src-tauri/src/commands/tree.rs` `find_definition`(등록 `src-tauri/src/lib.rs:304`) — git grep 기반, 캐시 히트 ~0ms 실측. 08~14 구현 완료(Quick Open·심볼 검색·참조·아웃라인·호버 독스트링).
- 프론트 provider: `src/components/diff/goto-definition.ts:23` 모듈 ctx(모델 URI가 inmemory라 경로를 모름 — LSP 어댑터도 동일 제약), `:183-186` 등록 1회 가드, `:190` hover / `:219` definition 진입부. `src/components/diff/find-references.ts:40` `registerFindReferences`, `:45` provideReferences 진입부 — **§3.6 공존 게이트를 걸 실존 지점들.**
- TS 워커: `src/components/diff/monaco-setup.ts:44` `tsModeNoDefs`(definitions:false `:48`, references:false `:52`), `:83` `tsDiagsOff` — 단일 모델 워커의 가짜 진단 150건 실측으로 OFF. **"여러 provider 결과 병합이 UX를 깨뜨린다"는 검증된 사실**(§3.6 게이트의 직접 근거).

### 2.2 Monaco 0.55.1 — 필요한 API 전부 공개 표준
- `node_modules/monaco-editor/monaco.d.ts`: registerReferenceProvider(`:6716`)·registerRenameProvider(`:6721`)·registerSignatureHelpProvider(`:6731`)·registerHoverProvider(`:6736`)·registerDefinitionProvider(`:6756`)·registerCompletionItemProvider(`:6801`)·registerInlayHintsProvider(`:6849`) — **7기능 전부 standalone 공개 API.** 마커: setModelMarkers(`:1039`)·getModelMarkers(`:1051`)·MarkerSeverity(`:78`).
- monaco-languageclient류 의존성 없음(package.json 실측 0건). dev 노출 `monaco-setup.ts:498` `window.__monaco`.

### 2.3 전송 인프라 — invoke 유실 규약과 Channel 스트리밍 전례
- WebView2 동시 invoke 응답 유실 방어: `src/lib/ipc.ts:577-579` MAX_CONCURRENT 8·INVOKE_TIMEOUT_MS 8000·MAX_ATTEMPTS 3, `:601` single-flight dedupKey, `:622-624` background lane, `:649` callMutating(변경 커맨드 재시도 금지). **LSP 요청/응답을 invoke 왕복에 실으면 재시도가 중복 id로 서버를 오염** — §3.5의 직접 근거.
- Channel 스트리밍 전례: `src-tauri/src/commands/terminal.rs:49-56` `term_open(on_data: Channel<Vec<u8>>)`, `:165` `term_write`(fire-and-forget), `:184` `term_attach`(sink 교체 — `:29` `sink: Arc<Mutex<Channel<…>>>`), 수명주기 이벤트 `term://exit`.

### 2.4 프로세스 러너 — 15가 구현한 계약을 그대로 확장
- `src-tauri/src/tools/runner.rs:142` `discover()` — 발견 순서 **①명시 경로(`:149`) → ②프로젝트 로컬 옵트인(`:157`) → ③PATH(`:168`) → ④번들 폴백(`:175`)**. `:86` `is_real_exe`(.cmd/.bat/.ps1 셔틀 거부), `:195` `run_tool_stdin`(kill_on_drop·CREATE_NO_WINDOW·타임아웃), `:238` `bundled_tools_dir`(resource_dir 해석). **LSP의 node·서버 발견은 이 순서 관례에 "⑤관리형 다운로드 사본"을 더한 것**(§3.3).
- 장수 child 전례: `src-tauri/src/state.rs:30` `terminals: Mutex<HashMap<String, TerminalSession>>`, 종료 정리 `src-tauri/src/lib.rs:372-377` Destroyed→kill_all.
- 설정 영속: `state.rs:109` load_settings / `:131` save_settings.

### 2.5 뷰어 편집 파이프라인 — didOpen/didChange/didSave 훅 지점 실존 (16이 이미 사용 중)
- `src/components/diff/DiffViewer.tsx:125` editorKey(projectId 포함), `:262` onFileMount, `:269` onDidChangeModelContent(**`:273` python on-type 린트 분기 — didChange 디바운스 트리거의 실증 전례**), `:212` saveRef(didSave 지점, `:217` formatOnSave 분기), `:250-260` 내용 동기화 효과(외부 변경 setValue — didChange 재전송 지점), `:285-291` 언마운트 cleanup(didClose 지점), `:141` revealTarget(정의 점프 착지 — LSP 결과도 `DiffTarget{mode:"file",path,line,column}`(`src/lib/ipc.ts:80`) 재사용).

### 2.6 마커 인프라 — 16 구현 완료, LSP 진단이 얹힐 자리
- `src/components/diff/lint-markers.ts:8` `OWNERS = ["ruff","biome"]`(owner 분리), `:23-36` toMarker(severity 매핑 + code/규칙 URL `{value,target}`), `:44-48` refreshLintMarkers(content 버퍼 파라미터 — on-type), `:61` clearLintMarkers. E2E로 owner 독립성 검증 완료(27-lint.mjs — ruff clear 후 biome 유지).
- 심각도 실증: ruff `invalid-syntax`→Error(sev 8) 빨간 밑줄이 미저장 버퍼 타이핑에서 뜨는 것까지 DOM 검증(2026-07-07). **LSP 진단은 owner `"lsp"`로 같은 파이프라인에 합류**(§3.7).

### 2.7 다운로드·검증 전례 — fetch-tools가 성립시킨 관례
- `scripts/fetch-tools.mjs:21-22` 버전 pin(RUFF_VERSION/BIOME_VERSION) + 공개 sha256 대조 — **불일치는 fail-fast 중단, .sha256 취득 실패만 경고 후 속행**(본 문서 적대 검증이 "불일치 throw가 catch에 삼켜지는" 버그를 발견 → 2026-07-07 수정 완료). `src-tauri/tauri.conf.json:21-22` bundle.resources로 번들 배치. **"버전 pin + 게시자 해시 검증 + 재현 스크립트"가 이 레포의 다운로드 표준** — §3.3이 런타임(앱 내) 다운로드로 확장한다.

### 2.8 단축키·E2E
- `src/components/KeyboardShortcuts.tsx` — F키 전수 grep: F5(`:51`) 단 1건, **F2(리네임) 미사용 확인**. mod+P(`:59`)/mod+Alt+N(`:66`)/mod+Shift+F(`:73`)와 충돌 없음.
- E2E: `tests/e2e/lib/cdp.mjs:10` 포트 스캔(29222 — lib.rs:89 인라인 문자열과 일치), `:50`,`:116` **Channel 인자 지원 실측**(openChannel) — lsp_start를 CDP로 직접 구동 가능.

### 2.9 외부 배포 사실 — 실측 확정 (2026-07-07, npm 레지스트리·nodejs.org·GitHub API·tarball 해부)

| 항목 | 실측값 |
|---|---|
| **basedpyright** 1.39.9 (npm) | dependencies **0**(완전 번들, engines node≥14). tarball **5.8MB**→해제 26.2MB. integrity **sha512**. bin `basedpyright-langserver`→`langserver.index.js`(내부 require는 상대경로만 — **tarball 하나 해제 = 실행 가능 확정**). GitHub 릴리스에 standalone 바이너리 **없음**(whl/sdist/vsix뿐) → **node 런타임 필수** |
| pyright 1.1.411 (npm) | deps `{fsevents}`(macOS 전용). 해제 18.4MB. 프로토콜 동일 — 탐지 폴백용 |
| **typescript-language-server** 5.3.0 (npm) | dependencies **0**(자체 번들). tarball→해제 **2.2MB**. engines node≥20. 단 **tsserver(typescript 패키지) 미포함** — 워크스페이스 것 또는 별도 획득 필요 |
| vtsls (@vtsls/language-server 0.3.0) | 셸 패키지 0.04MB — dist/main.js가 외부 모듈 require → **tarball 단독 실행 불가 확정**(npm install 트리 필요). typescript는 하위 dep에 5.9.3 고정 |
| typescript (npm) | 로컬 실측 `node_modules/typescript` 23MB, dependencies 0 — 단일 tarball 획득 가능 |
| **Node.js 런타임** | 최신 LTS v24.18.0. `node-v24.18.0-win-x64.zip` **35.5MB**(HEAD 200 실측), 같은 폴더 `SHASUMS256.txt` 존재(200) → **zip 무결성 검증 가능** |
| integrity 형식 | npm 4패키지 전부 **sha512(base64)** — 검증 로직 1종으로 통일 가능 |

## 3. 설계

### 3.0 전체 그림

```
[Monaco Editor] ←7 providers+진단— [src/lib/lsp/ 수제 어댑터]
                                    │ lsp_send(fire-and-forget invoke)   ↑ Channel<String> (서버→프론트 JSON-RPC 1건=이벤트 1건)
                                    ▼                                    │
[Rust commands/lsp.rs] — 레지스트리(HashMap<"{projectId}:{lang}", LspSession>) — Content-Length 프레이밍(Rust)
                                    │ spawn: node <서버>.js --stdio  (runner 관례: kill_on_drop·CREATE_NO_WINDOW)
                                    ▼
[획득 계층 lsp/acquire.rs] — node: ①명시→②PATH(≥20)→③관리 사본(다운로드) / 서버: ①PATH→②관리 사본(다운로드)
                              다운로드 = 버전 pin + sha512/sha256 검증 + app_local_data_dir/lsp/ 해제 (fetch-tools 관례의 런타임화)
```

핵심 원칙(변경 없음): **JSON-RPC id 상관관계는 전적으로 프론트 어댑터가 관리.** invoke는 "바이트를 stdin에"(ack뿐)라 유실돼도 어댑터 타임아웃+`$/cancelRequest`가 자기치유. 다운스트림은 Channel 1개 순서 보장(term_open 미러 — §2.3).

### 3.1 Python 서버 — basedpyright (v1 채택 유지, 근거가 추정→실측으로 승격)

| 후보 | 판정 | 근거 |
|---|---|---|
| **basedpyright** | **채택** | pyright 포크 기능 동등+α(inlay hints 개선). **npm tarball이 의존성 0·상대경로 require만 — 다운로드+해제만으로 실행 확정**(§2.9 tarball 해부). 5.8MB로 4후보 중 획득 비용 최소급. |
| pyright | 차선(탐지 폴백) | MS 공식. deps에 fsevents(macOS) — Windows 무관하나 0은 아님. PATH에 이미 있으면 재사용(프로토콜 동일 — 어댑터 변경 0). |
| jedi-language-server | 기각 | 타입 추론 자동완성·인레이가 약함 — 요구 1번 미충족. |

- 기동: `node <관리사본>/langserver.index.js --stdio` (bin 매핑 실측 — `--stdio` 동작 자체는 M1 스파이크에서 확정, 검증 필요).
- venv: 프로젝트 루트 `.venv/`·`venv/` 존재 시 initialize 후 설정(python.pythonPath 계열 — 정확한 키는 스파이크에서, 검증 필요). `pyrightconfig.json`/`pyproject.toml`은 서버가 스스로 읽음(검증 필요).

### 3.2 TS 서버 — typescript-language-server (v1의 vtsls에서 **채택 변경**)

| 후보 | 판정 | 근거 |
|---|---|---|
| **typescript-language-server** | **채택** | **의존성 0 단일 tarball 2.2MB — 획득 모델(§3.3)과 정합 확정**(§2.9). tsserver는 **①관리 사본 typescript tarball(23MB, deps 0) 기본 → ②워크스페이스 `node_modules/typescript` 재사용은 옵트인**(프로젝트 TS 버전과 진단 일치 이점이 있지만, 레포가 심은 JS를 장수 프로세스로 실행하는 공급망 표면이라 `formatter_project_local`과 같은 옵트인 뒤에 둔다 — §3.3·§6). tsserver 경로 지정 방식(`--tsserver-path` 또는 initializationOptions.tsserver.path)은 스파이크에서 확정(검증 필요). |
| vtsls | 기각(v1 채택 철회) | VSCode 패리티는 최고(추정)지만 **tarball 단독 실행 불가 실측**(§2.9) — npm install 트리가 필요해 "npm 실행 가능 환경" 의존이 획득 계층에 통째로 추가된다. npm 미보장이 이 설계의 출발점(§1)이므로 자기모순. |
| Monaco 내장 TS 워커 재활성 | 기각 | 단일 모델 한계 구조적(§2.1 — 가짜 진단 150건 실측). |

- tsconfig 탐지: 루트 `tsconfig.json`/`jsconfig.json` 있을 때만 TS 세션 기동 자격(inferred project 폭주 방지).
- engines node≥20 — node 획득(§3.3)의 최소 버전을 20으로 지배.

### 3.3 서버 획득 — 발견 우선 + 관리형 다운로드 폴백 (신설 · v1 "다운로드 비채택" 철회)

| 대안 | 판정 | 근거 |
|---|---|---|
| **발견 우선 + 첫 사용 시 관리형 다운로드(동의 1회)** | **채택** | 15/16 번들 폴백과 동일 철학("발견 먼저, 없으면 우리가 채운다" — runner.rs:142-190 구현 실증) + fetch-tools의 pin·해시 검증 관례(§2.7)를 런타임으로 확장. 사용자에게 있으면 그걸 써서 버전 일치, 없으면 받아서 "그냥 됨". VS Code(Pylance)·rust-analyzer 확장과 같은 업계 표준 패턴. |
| 앱 설치파일에 번들(ruff/biome처럼) | 기각 | node zip 35.5MB+basedpyright 26.2MB+typescript 23MB ≈ **+85MB/플랫폼**(해제 시 더 큼) — 이미 ruff 31MB+biome 77MB를 실은 설치파일에 추가는 과대. LSP는 안 쓰는 사용자 비율이 높아 전원 부담이 부당. |
| 사용자 설치 탐지만(v1 결정) | 기각(철회) | "환경 미보장 — 우리쪽에 있어야" 제품 결정(2026-07-07 세션)과 정면 충돌. 파이썬 사용자에게 npm/node 설치를 요구하는 이질성도 여전. |
| pip 경유(basedpyright wheel) | 기각 | pip 존재를 또 가정 + wheel 12.8MB가 node 스크립트를 파이썬으로 감싼 우회 — npm tarball 직행(5.8MB)이 더 단순·작음. |

**획득 순서(도구별)** — runner discover(§2.4) 관례의 확장:
- **node**: ①설정 명시 경로(`lsp_node_path`) → ②PATH `node`(`--version` 확인 — **언어별 최소: py≥14, ts≥20**. §3.2의 ≥20을 전역 강제하면 node 14~19 사용자가 py만 쓰는데도 35.5MB를 받게 됨) → ③관리 사본(v24.18.0 win-x64 zip 35.5MB 다운로드 → **코드에 pin된 sha256과 대조**(SHASUMS256.txt에서 pin 시점 채록 — 런타임 fetch 아님) → 해제).
- **서버**: ①설정 명시 경로(`lsp_server_path_*` — 15 계약 ① 관례: 지정했는데 실행 불가면 조용한 폴백 금지) → ②PATH(`basedpyright-langserver`/`typescript-language-server` — 사용자 전역 설치 존중) → ③관리 사본(npm 레지스트리 tarball 다운로드 → **코드에 pin된 sha512와 대조** → 해제). **레지스트리가 주는 integrity를 그때 믿지 않고, pin 시점에 검증한 해시를 코드에 고정**(TOFU 창 제거 — fetch-tools보다 한 단계 강화. 버전 업은 pin+해시 동시 갱신 커밋).
- **tsserver**: ①관리 사본 typescript tarball(기본) → ②워크스페이스 `node_modules/typescript`(**옵트인** — §3.2. 레포 공급 코드 장수 실행이라 기본 OFF).
- 프로젝트-로컬 서버(레포의 node_modules/.bin·venv 안)는 **v1 탐지 제외** — 열람만으로 레포 공급 코드가 장수 프로세스로 도는 공급망 표면(§6). 15의 `formatter_project_local` 옵트인과 별도 논의로 후속.

**설치 원자성**(동시 ensure·부분 실패 방어): 획득물별 **single-flight 뮤텍스**(py·ts 세션이 동시에 node를 요구해도 다운로드 1회), **temp 디렉토리에 해제 후 rename**으로 원자 설치, 설치 완료를 **버전 태그 마커 파일**로 판정(마커 없으면 "손상 잔해"로 간주하고 재획득 — 해시는 아카이브만 검증하므로 해제 중 크래시는 마커가 잡는다). 레이아웃: `app_local_data_dir/lsp/{node-24.18.0, basedpyright-1.39.9, …}/` + `.ok` 마커.

**동의 UX**: 프로젝트에서 LSP 토글 ON → 필요 획득물이 없으면 다이얼로그 1회 — **총량 고지**: "언어 서버 구성 요소를 다운로드합니다(이번: basedpyright 5.8MB[+Node 35.5MB], 이후 TS 사용 시 최대 ~25MB 추가)" + 진행률 + 실패 시 조용히 휴리스틱 유지. 동의는 앱 전역 1회 기록(§4 Settings — 총량을 고지했으므로 이후 TS 계열 추가 다운로드에 재고지 없음). 오프라인/프록시 실패는 재시도 버튼만 — LSP 없이도 앱은 완전 동작(§1 폴백).

**디스크 예산**(해제 후 기준 통일): node ~70MB + basedpyright 26.2MB + typescript-language-server 2.2MB + typescript 23MB ≈ **최대 ~121MB**(전부 받는 최악 경우). node가 시스템에 있고 워크스페이스 tsserver 옵트인 시 **~28MB**(basedpyright+tls). "데이터 초기화" 설정(기존 브라우저 세션 초기화 전례)에 LSP 캐시 삭제 포함. (§1의 "번들 기각 +85MB"는 아카이브 기준 합산 — 해제 기준으론 위 수치가 정본.)

### 3.4 수명주기 — 스폰·유휴 종료·상한 (v1 유지)

| 대안 | 판정 | 근거 |
|---|---|---|
| **프로젝트별 옵트인 + 첫 코드 파일 열람 시 lazy 기동 + 유휴 10분 종료 + 동시 세션 상한 4(LRU)** | **채택** | 언어 서버 인덱싱은 수백 MB~GB(17.6GB급 레포 실존). 18개 자동 기동은 즉사. 유휴 판정은 백엔드 last_activity(Rust가 수명 단일 진실 — PTY 관례). |
| 전 프로젝트 자동 기동 | 기각 | 메모리 폭주 + AI 에이전트 디스크 I/O 경합. |
| 프론트 타이머 유휴 종료 | 기각 | 웹뷰 리로드/HMR에 타이머 증발 → 좀비. |

- 세션 키 `"{projectId}:{lang}"`(lang ∈ py|ts). 임베디드 합성 id(`<outer>::<rel>`)도 그대로 — rootUri만 그 경로(키는 파싱하지 않고 통문자열 비교 — `::` 충돌 없음).
- **유휴 판정은 "열린 문서 0 + 마지막 활동 10분"** — last_activity만 보면 파일을 열어둔 채 읽기만 하는 사용자의 세션이 끊겨 눈앞의 진단 밑줄이 소멸한다(didOpen 문서 수를 세션이 추적, 열린 문서가 있으면 리퍼 유예).
- 크래시/유휴/수동 종료 공통 `lsp://exit` 이벤트(term://exit 미러) → 어댑터가 pending 전부 reject + 휴리스틱 폴백 + 진단 owner 클리어. 다음 상호작용이 재기동(initialize·didOpen 재전송은 어댑터 책임).
- 재기동 멱등: 같은 키 세션 존재 시 sink 교체(term_attach 미러 — 웹뷰 리로드 대응).

### 3.5 전송 브리지 — stdio ↔ 프론트 (v1 유지)

| 대안 | 판정 | 근거 |
|---|---|---|
| **Channel 다운스트림 + fire-and-forget invoke 업스트림(프레이밍은 Rust)** | **채택** | term_open/term_write 동형(§2.3) — 검증된 패턴. Content-Length 프레이밍을 Rust가 해제해 프론트는 "완결 JSON 1건=이벤트 1건"만 본다. |
| invoke 요청/응답 왕복 | 기각 | WebView2 유실 규약(§2.3) 한복판 — 재시도=중복 id 오염, 미재시도=요청 증발. 서버발 알림 채널도 따로 필요해짐. |
| app.emit 브로드캐스트 | 기각 | 전 창 낭비 — 이벤트는 수명주기(lsp://exit)에만(term:// 관례). |

- 상관관계: id 단조 증가, `Map<id,{resolve,reject,timer}>`. 타임아웃 기본 10초(자동완성 3초 — 늦은 완성은 무가치). 취소: CancellationToken→`$/cancelRequest`+pending 제거. 모델 전환 시 그 모델 pending 전부 취소.
- 문서 동기화: 파일뷰(mode:"file")만 didOpen/didChange(**full sync** — 파일 1개라 incremental 이득 없음)/didSave/didClose. 훅 4지점은 §2.5 실측(16의 lintRef가 같은 지점을 이미 사용 — 병렬 배선).
- **didChange 직렬화(coalescing 큐)**: fire-and-forget invoke 여러 건은 도착 순서가 보장되지 않는다(8슬롯 동시) — full sync는 유실엔 강하지만 **재정렬엔 약하다**(옛 전문이 나중에 적용되면 조용히 오염). 어댑터는 didChange를 in-flight 1건으로 직렬화하고, 대기 중엔 최신 상태만 유지(coalescing — 이전 대기분 폐기). "마지막 didChange 유실"(다음 전송이 없어 무기한 스테일)은 ①ack(lsp_send resolve) 실패 시 1회 재전송이 아닌 **상태 재전송**(내용이 최신 스냅샷이라 중복 무해 — 멱등)과 ②didSave에 **includeText**(저장 시점 강제 재동기화)로 이중 방어.
- 좌표: LSP 0-based(UTF-16 기본 — 검증 필요) ↔ Monaco 1-based — ±1 변환 유틸 1곳 고정.

### 3.6 프론트 어댑터·공존 게이트 (v1 유지, 앵커 실존화)

| 대안 | 판정 | 근거 |
|---|---|---|
| **수제 어댑터(`src/lib/lsp/` — 7 provider+진단)** | **채택** | 등록 API 전부 공개 표준 실측(§2.2). 변환은 기계적 ~7타입. 추가 의존성 0. |
| monaco-languageclient | 기각 | monaco 빌드 교체 수준 침습 + 0.55 대응 불확실 + 번들 수 MB. |
| vscode-languageserver-protocol 타입만 차용 | 부분 채택 | devDependency 타입 전용 — 런타임 0(검증 필요: 타입 전용 임포트 tree-shake). |

**휴리스틱 공존 — 상호배타 게이트**: 휴리스틱 provider 전부가 진입부에서 `lspActive(projectId, lang)`이면 null 반환. 대상 실존 지점: goto-definition.ts hover(`:190`)·definition(`:219`) + find-references.ts provideReferences(`:45`). LSP 세션이 죽으면(lsp://exit) 플래그만 내려가 **같은 등록 상태로 즉시 폴백**(등록/해제 레이스 없음). 근거: 정의 2건→peek 위젯 회귀 실측(§2.1).
- **게이트 활성 조건은 "세션 생존"이 아니라 "initialize 완료 + 첫 정상 응답 이후"** — 대형 레포 초기 인덱싱 수 분 동안 세션은 살아있지만 요청이 전부 타임아웃이면, 생존 기준 게이트는 휴리스틱까지 막아 "아무것도 안 되는" v1 대비 퇴행을 만든다(§1 "나빠지는 경로 없음" 위반). 추가로 **per-request 폴백**: LSP 요청이 타임아웃한 그 1회는 휴리스틱 결과로 응답.

### 3.7 진단 — v1 포함 (신설 · v1 절단 철회)

| 대안 | 판정 | 근거 |
|---|---|---|
| **publishDiagnostics → owner `"lsp"` 마커로 표시, ruff/biome와 공존** | **채택** | ①마커 파이프라인 실존(§2.6 — toMarker·severity 매핑·owner 분리 E2E 검증 완료)이라 추가 비용이 수신 핸들러+매핑뿐. ②사용자 실사용 요구가 정확히 이것("오류나는 부분은 알아서 빨간 밑줄 그여야" — 2026-07-07). ③타입 오류는 LSP 고유 가치 — 절단하면 §1 요구를 반쪽 납품. ruff(규칙)와 pyright(타입)는 주 영역이 달라 owner 분리로 자연 공존. |
| LSP 활성 시 ruff 린트 중단(완전 대체) | 기각 | pyright는 스타일 규칙(ruff 수백 개)을 안 잡는다 — 가치 손실. 겹침은 일부 클래스(구문 오류·미정의·미사용)뿐. |
| v1 절단 유지(진단 무시) | 기각(철회) | 절단 근거였던 "뷰어는 린터가 아니다"는 16 구현으로 이미 뒤집힘. |

- 수신: `textDocument/publishDiagnostics` 알림 → LspDiag→IMarkerData 매핑(16 toMarker 관례 — severity 1:1, code/codeDescription.href→`{value,target}`) → `setModelMarkers(model, owner, …)`. 적용 전 `model.isDisposed()`+URI 일치 가드.
- **owner는 세션 스코프 `"lsp:{sessionKey}"`** — 단일 상수 "lsp"면 같은 물리 파일이 outer 세션과 임베디드 세션(`<outer>::<rel>:py`) 양쪽 워크스페이스에 속할 때(파일 URI 동일) didClose 직후의 지연 publish(빈 배열 포함)가 서로의 마커를 덮어쓴다(깜빡임·오소거). 세션별 owner + "그 모델을 didOpen한 세션발 알림만 적용" 가드로 차단.
- 정리: didClose·lsp://exit 시 자기 owner 클리어(lint-markers `clearLintMarkers` 관례 — OWNERS 상수에 추가하지 않고 LSP 어댑터가 자기 owner를 스스로 관리: 모듈 경계 분리).
- **겹침 노이즈**(같은 구문 오류에 ruff+pyright 밑줄 2겹): v1은 공존 출시 후 실측 — 과하면 "LSP 활성 시 ruff on-type의 구문 오류 카테고리만 억제"를 M4에서(§6 위험표).

### 3.8 08~16과의 관계

| 태스크 | LSP 활성 시 | LSP 비활성/비대상 언어 |
|---|---|---|
| 11 참조 / 14 호버 | `references`/`hover`가 대체(게이트 §3.6) | 휴리스틱 폴백 유지 |
| 10 아웃라인 / 13 심볼 검색 | `documentSymbol`/`workspace/symbol` 대체 가능(후속 — v1 범위 밖) | 유지 |
| 16 린트 | **공존**(owner 분리 — §3.7) | 단독 동작 |
| 15 포매터 | 무관(LSP 포매팅은 안 씀 — ruff/biome이 이미 우수) | — |
| 08 전역 검색 / 09 파일 열기 | **여전히 필요**(LSP 영역 아님) | — |

### 3.9 범위 절단 (YAGNI)

- **v1 포함**: py/ts 서버 2종, 7 provider+진단, 파일뷰 한정, 옵트인 토글, 획득 계층(동의·pin·해시·진행률), lsp://exit 폴백.
- **후속 절단**: ① code actions/quick fix ② workspace/symbol·documentSymbol 합류 ③ diff뷰·미리보기 모델 LSP ④ 리네임 프리뷰 UI(v1은 적용+토스트 요약) ⑤ didChangeWatchedFiles 클라이언트(서버 자체 감시 우선 — 검증 필요) ⑥ 프로젝트-로컬 서버 옵트인 ⑦ 기타 언어(rust-analyzer·gopls — 러너·어댑터가 기반이라 저비용 후속) ⑧ LSP 포매팅.

## 4. 계약(타입·커맨드·이벤트)

```rust
// src-tauri/src/lsp/acquire.rs (신설) — 획득 계층. 버전·해시 pin은 이 파일 상수로.
// 신규 crate: sha2(해시 검증), zip(node zip 해제), tar+flate2(npm tgz 해제) — HTTP는 기존
// reqwest 0.13 재사용(http.rs API 클라이언트가 이미 사용, Cargo.toml 실측). fetch-tools.mjs는
// Node 스크립트라 런타임 전례가 못 됨 — Rust 재구현이며 M2 산정에 포함(§5).
const NODE_VERSION: &str = "24.18.0";              // + 플랫폼별 zip sha256(SHASUMS256.txt에서 pin 시점 채록)
const BASEDPYRIGHT: (&str, &str) = ("1.39.9", "sha512-7ijtpTtV3E…"); // (버전, tarball sha512)
const TS_LANGSERVER: (&str, &str) = ("5.3.0", "sha512-5puofxZHgF…");
const TYPESCRIPT:    (&str, &str) = ("5.9.3", "sha512-…");           // pin 시점 채록

/// 필요 획득물(노드·서버·tsserver)을 보장. 이미 있으면 즉시, 없으면 다운로드(진행률 Channel).
/// 다운로드 전 동의 플래그(settings.lsp_download_approved) 확인 — 미동의면 NeedsConsent 반환.
/// 원자성(§3.3): 획득물별 single-flight 뮤텍스 + temp 해제 후 rename + `.ok` 버전 마커.
#[tauri::command]
async fn lsp_ensure(state, app: AppHandle, lang: String, on_progress: Channel<String>)
    -> Result<LspEnsureResult, IpcError>;
// LspEnsureResult { ready: bool, needs_consent: bool, downloads: Vec<{name,bytes}>, node: String }

// src-tauri/src/commands/lsp.rs (신설) — terminal.rs 미러.
// AppState에 `lsp: Mutex<HashMap<String, LspSession>>` 추가(state.rs:30 관례).
pub struct LspSession {
    stdin: ChildStdin,                  // lsp_send가 Content-Length 프레이밍 후 write
    child: Arc<Mutex<Child>>,           // kill_on_drop + Destroyed 훅(lib.rs:372-377 관례)
    sink: Arc<Mutex<Channel<String>>>,  // 완결 JSON-RPC 1건=이벤트 1건 (sink 교체 = 리로드 대응, terminal.rs:29 미러)
    last_activity: Arc<Mutex<Instant>>, // 유휴 리퍼(10분) — lsp_send마다 갱신
}

#[tauri::command] // 스폰+stdio 연결만 — initialize 핸드셰이크는 프론트 어댑터가. 기존 세션은 sink 교체 멱등.
async fn lsp_start(state, project_id: String, lang: String, on_msg: Channel<String>) -> Result<LspServerInfo, IpcError>;
#[tauri::command] // 완결 JSON-RPC 문자열을 프레이밍해 stdin에. payload 없는 ack — 재시도 금지(중복 id 오염).
fn lsp_send(state, session_key: String, msg: String) -> Result<(), IpcError>;
#[tauri::command] // 어댑터가 shutdown/exit 먼저 → 호출. 3초 내 미종료 시 kill.
fn lsp_stop(state, session_key: String) -> Result<(), IpcError>;
// 이벤트: "lsp://exit" { sessionKey, code } — 크래시/유휴/stop 공통.
// 정리 훅: lib.rs Destroyed(main) 핸들러에 lsp_kill_all 추가(:377 kill_all 관례).
```

```rust
// Settings 확장(git/types.rs + ipc.ts 미러) — set_settings 재사용, 신규 커맨드 없음.
pub lsp_enabled_projects: Vec<String>,      // 옵트인 프로젝트 id (기본 [] = 전부 OFF)
pub lsp_download_approved: bool,            // 다운로드 동의(앱 전역 1회 — 총량 고지 §3.3)
pub lsp_node_path: Option<String>,          // node 명시 경로(발견 ① — formatter_*_path 관례)
pub lsp_server_path_py: Option<String>,     // 서버 명시 경로(발견 ① — 15 계약 ①: 지정 실패 시 조용한 폴백 금지)
pub lsp_server_path_ts: Option<String>,
pub lsp_workspace_tsserver: bool,           // 워크스페이스 node_modules/typescript 재사용 옵트인(기본 false — §3.2)
```

```ts
// src/lib/ipc.ts — lsp_send는 attempts:1(재시도 금지). lsp_ensure는 진행이 Channel이라 타임아웃 길게.
lspEnsure: (lang: "py" | "ts", onProgress: Channel<string>) => Promise<LspEnsureResult>;
lspStart: (projectId: string, lang: "py" | "ts", onMsg: Channel<string>) => Promise<LspServerInfo>;
lspSend: (sessionKey: string, msg: string) => Promise<void>;   // attempts: 1
lspStop: (sessionKey: string) => Promise<void>;

// src/lib/lsp/client.ts — 세션·상관관계·취소의 단일 진실.
export function lspActive(projectId: string, lang: string): boolean;  // §3.6 게이트
export function ensureSession(projectId: string, ext: string): Promise<LspSessionHandle | null>;
// src/lib/lsp/providers.ts — 7 provider 등록(1회 가드 — goto-definition.ts:183 관례).
//   정의 점프는 기존 DiffTarget{mode:"file",path,line,column}(ipc.ts:80) 경로 재사용.
// src/lib/lsp/diagnostics.ts — publishDiagnostics→setModelMarkers(model,"lsp",…) (§3.7).
// src/lib/lsp/sync.ts — DiffViewer 훅 4곳(§2.5): didOpen(onFileMount:262)·didChange(:269, 250ms
//   디바운스 — :273 lintRef 병렬)·didSave(saveRef:212)·didClose(cleanup:285-291).
```

**신규 키 없음** — F2 리네임·Ctrl+Space 완성·Ctrl+Shift+Space 시그니처는 provider 등록만으로 Monaco 내장 바인딩 활성(F2 미사용 실측 §2.8). goto 계열 E2E는 `ed.trigger()`(Action2 — getAction null, 메모리 관례).

## 5. 단계(구현 순서)

1. **M1 스파이크 — Python 1프로젝트 완주** (게이트: 실패 시 전체 재검토)
   - 획득은 **수동**: fetch-tools 확장 스크립트로 basedpyright tarball을 관리 사본 위치에 해제(앱 내 자동화는 M2). node는 개발 머신 PATH(v24 실측 존재).
   - `commands/lsp.rs`(스폰+프레이밍 리더+send/stop+레지스트리+유휴 리퍼 ~300 LOC) + `lsp/client.ts`(initialize·pending·취소 ~250) + `lsp/providers.ts`(completion/hover/definition 3종+게이트 ~200) + `lsp/sync.ts`+DiffViewer 훅(~100).
   - 성공 기준: 자기 레포에서 **타입 인지 자동완성·정확한 정의 점프·`--stdio` 프로토콜 완주**(§3.1 검증 필요 소거), 종료 시 프로세스 잔류 0.
2. **M2 — 획득 계층**: `lsp/acquire.rs`(node 발견/다운로드, 서버 tarball+pin 해시, single-flight+원자 설치+`.ok` 마커, 진행 Channel, 동의 플래그 ~300 LOC — **신규 crate sha2/zip/tar/flate2 도입 포함**, HTTP는 기존 reqwest 재사용) + 설정 UI(옵트인 토글·동의 다이얼로그·캐시 삭제·명시 경로 3종). tsserver 경로 방식 확정(§3.2 검증 필요 소거).
3. **M3 — TS + 진단**: typescript-language-server 라우팅(tsconfig 게이트), publishDiagnostics→owner "lsp" 마커(§3.7), references/signatureHelp 추가(find-references.ts:45 게이트 포함) (~300 LOC).
4. **M4 — rename+inlayHints+안정화**: WorkspaceEdit 다중 파일 적용(**쓰기는 기존 write_file 경로만 — resolve_in_repo 가드 재사용, 신규 쓰기 표면 0**), LRU 축출, 겹침 노이즈 실측·조정(§3.7), lsp://exit 폴백 마감 (~200 LOC).
5. **E2E `tests/e2e/suites/28-lsp.mjs`**: ① 관리 사본 부재 시 lsp_ensure가 needs_consent 반환(네트워크 비의존 경로) ② 사본 존재 시 lsp_start→Channel로 initialize 응답 수신(cdp.mjs:116 openChannel 실측 지원) ③ 픽스처 .py 완성/정의 발화 ④ 진단: 구문 오류 픽스처 → `getModelMarkers({owner:"lsp"})` ⑤ lsp_stop 후 프로세스 부재 ⑥ 게이트: LSP 활성 중 휴리스틱 hover/references 미발화. 다운로드 자체는 네트워크 의존이라 로컬 아티팩트 주입으로 대체(fetch-tools 관례).

규모: **L** — Rust ~600(M1 lsp.rs 300 + M2 acquire 300) + 프론트 ~1,050(M1 550 + M3 진단·provider ~300 + M4 리네임·인레이 ~200) + 테스트. 마일스톤별 납품 가능(각 단계 독립 폴백).

## 6. 위험과 완화

| 위험 | 설명 | 완화 |
|---|---|---|
| 다운로드 공급망 | 레지스트리/미러 변조·MITM | 버전 pin + **코드 고정 해시**(sha512/SHASUMS256 — 다운로드 시점의 레지스트리 integrity를 믿지 않음, §3.3). https만. 검증 실패 = 파일 폐기+조용한 폴백 |
| lsp_send invoke 유실·재정렬 | 요청 재시도 금지(중복 id). full sync는 유실엔 강하나 **재정렬엔 약함** | 요청: 어댑터 타임아웃→reject→$/cancelRequest + 그 1회 휴리스틱 폴백(§3.6). didChange: coalescing 직렬화(in-flight 1건) + ack 실패 시 최신 스냅샷 재전송(멱등) + didSave includeText 강제 재동기화(§3.5) |
| 워크스페이스 tsserver 실행 | 옵트인 시 레포가 심은 `node_modules/typescript`를 장수 프로세스로 실행 — 프로젝트-로컬 공급망 표면과 동류 | 기본 OFF(`lsp_workspace_tsserver` — §3.2/§4). 기본 경로는 관리 사본(pin 해시 검증본) |
| 서버 메모리/인덱싱 폭주 | 17.6GB급 레포 인덱싱 수 GB·수 분 | 옵트인 OFF 기본+유휴 10분+상한 4(LRU)+상태 배지(수동 종료). 안 켜면 비용 0 |
| 진단 겹침 노이즈 | 같은 구문 오류에 ruff+pyright 2겹 밑줄 | owner 분리로 시각적 1겹(위치 동일시 Monaco가 겹쳐 그림 — 호버 카드만 2장). 실측 후 과하면 LSP 활성 시 ruff 구문 카테고리 억제(M4, §3.7) |
| 디스크 사용 | 최대 ~120MB 앱 전역 캐시 | 동의 다이얼로그에 크기 명시(§3.3) + 설정에서 캐시 삭제. node/tsserver 시스템 재사용 시 26MB |
| 좀비/고아 프로세스 | 웹뷰 리로드·크래시 후 잔류 | kill_on_drop+Destroyed lsp_kill_all+유휴 리퍼 3중. 키가 결정적이라 재기동 시 멱등 회수(sink 교체 — term_attach 관례) |
| 리네임 파일 쓰기 | WorkspaceEdit가 레포 밖 경로 지시 가능(악성·버그) | 적용 전 전 경로를 resolve_in_repo 가드 통과 write_file로만 — 신규 쓰기 표면 0(§5 M4) |
| 프로젝트-로컬 서버 공급망 | 레포가 심은 서버 = 열람성 RCE | v1 탐지 제외(§3.3) — PATH·관리 사본만. 후속 별도 옵트인 |
| 외부 사실 잔여 미검증 | --stdio 상세·UTF-16 인코딩·tsserver 경로 플래그·venv 설정 키 | 전부 "(검증 필요)" 표기 + M1/M2 스파이크가 게이트. 배포 형태·크기·의존성·해시는 **이미 실측 확정**(§2.9)이라 재검토 범위가 v1보다 좁다 |
| monaco 0.55 함정 | getAction null(Action2)·deprecated 스텁 | ed.trigger()·구조 캐스트 관례(§2.2·§4). 접점이 7 provider+진단으로 유한 |
