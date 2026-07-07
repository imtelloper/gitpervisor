# 태스크 13 — 전역 심볼 검색 (Go to Symbol)

> 상태: 설계(Design) · 대상: gitpervisor · 산출물 성격: 아키텍처/계약/단계/위험 (구현은 후속)
> 근거: 코드 실측 2026-07-06 · 관련: [09-quick-open.md](09-quick-open.md)(QuickPick 프리미티브 재사용), [10-python-outline.md](10-python-outline.md)(파일 내 심볼 — 본 태스크는 프로젝트 전체), [08-find-in-files.md](08-find-in-files.md)(텍스트 전문 검색 — 본 태스크는 정의만)

## 1. 요구사항

프로젝트 **전체**에서 심볼명(함수/클래스/타입 등의 정의 이름)으로 검색해 그 정의 위치로 점프한다.
PyCharm의 Ctrl+N(Cmd+O) "Go to Class/Symbol"에 해당.

- 부분일치: `query` 입력 → `def run_query`, `class QueryBuilder` 모두 후보로.
- 항목에 시그니처와 `경로:라인`을 보여주고, 선택하면 뷰어가 그 파일의 그 심볼 위치로 착지(스크롤+단어 선택).
- 입력 중 실시간 갱신(디바운스) — 이전 쿼리의 늦은 응답이 최신 결과를 덮으면 안 된다.
- 터미널(xterm)·Monaco 포커스 중에도 단축키가 동작해야 한다.

## 2. 현황(근거)

### 2.1 백엔드 참조 구현 — find_definition (정확일치 전용이라 재사용 불가, 관례의 원천)
- `src-tauri/src/commands/tree.rs:364-458` `find_definition(project_id, symbol, ext)` — git grep -P 기반 정의 검색. 신규 커맨드가 그대로 따라야 할 관례가 전부 여기 있다:
  - 심볼 검증: 빈/128자 초과/식별자 외 문자 거부 → 조용히 빈 결과(`:372-377`) — 정규식 인젝션·과검색 방지. `$`만 이스케이프(`:522`).
  - `git grep -P -n --column --no-color -I --untracked` + **확장자 pathspec**(`:388-401`) — 거대 레포에서 사후 필터 대비 수 배 가속(주석 실측 nqvm-ais 1.4s→0.2s, `:386-387`).
  - 결과 캡 12(`:446`), 상대경로 forward-slash 정규화(`:425`), `--column`이 가리키는 패턴 시작을 심볼 시작 열로 보정(`:428-431`).
  - **정의문 우선 정렬**: 심볼로 시작하는 줄(대입 폴백)은 `weak`로 미뤄 def/class를 앞세움(`:408-450`).
  - 모듈 파일 폴백 `find_module_files`(`:454-457`, `:462-518`) — **얕은 경로 우선 정렬** `sort_by_key(|p| (p.matches('/').count(), p.clone()))`(`:504`)이 본 태스크 랭킹의 전례.
- 언어별 정의 패턴 원천 `def_query(ext, symbol)`(`:521-587`) — py/ts·js/rs/go/java·kt/rb + 제네릭 폴백. 전 패턴이 심볼을 `{s}\b` **정확일치**로 끼워 넣는다 → 부분일치는 심볼 자리 일반화가 필요(§3.1).
- 시그니처 추출 `extract_signature(repo, rel, line_no, fallback)`(`:591-635`) — 데코레이터/속성 위로 + 정의 닫힘까지 아래로(최대 8줄), 1200자 캡(`:630`). 매치당 `std::fs::read_to_string` 1회(`:592`) — 캡 12에선 무해하나 캡 100에선 비용 검토 필요(§6). [14-hover-docstring.md](14-hover-docstring.md)가 이 함수를 `extract_sig_doc`로 개명·확장 예정(§4 교차 노트).
- git 타임아웃: `runner::READ_TIMEOUT_SECS = 10`(`src-tauri/src/git/runner.rs:9`). 커맨드 등록: `src-tauri/src/lib.rs:270`(invoke_handler), find_definition은 `:302`.
- 성능 실측(인용): find_definition — pathspec 적용 후 nqvm-ais(17.6GB) 콜드 195~485ms, 캐시 히트 ~0ms. get_file_diff 3ms.

### 2.2 프론트 조회 규약 — ipc.call 레인·single-flight
- `src/lib/ipc.ts:489-491` `MAX_CONCURRENT = 8`, `INVOKE_TIMEOUT_MS = 8000`, `MAX_ATTEMPTS = 3`. lane: background는 큐 뒤(`:534-538`). 동일 (cmd+args) 진행 중 호출은 single-flight로 합침(`:506-521`) — **같은 쿼리** 반복만 합쳐지고, 타이핑으로 쿼리가 바뀌면 매번 새 invoke이므로 프론트 무효화는 별도 필요(§3.4).
- `ipc.findDefinition`(`:680-685`) — lane 인자 관례(interactive/background). `DefMatch` 타입 미러 `:83-89`, `DiffTarget`의 file 모드에 `line?/column?` 점프 좌표(`:80`).
- `src/components/diff/goto-definition.ts:29-43` 심볼→결과 Promise 캐시(Map, 상한 800 전체 클리어) — 부분일치 쿼리는 재사용률이 낮아 이 캐시 전례는 미러하지 않는다(§3.7).

### 2.3 점프 착지 경로 — 이미 완성돼 있어 그대로 탄다
- `src/stores/ui.ts:181-198` `selectDiff(target, repoId?)` — 뷰어 탭 업서트(같은 키면 target만 갱신 → **같은 파일 내 줄 이동은 기존 탭 재사용**, 키에 line 미포함 `:42-49`).
- `src/components/diff/DiffViewer.tsx:120-125` target.line/column 수신 → `revealTarget`(`:129-141`)이 중앙 스크롤+단어 선택+포커스. 같은 파일 내 이동은 재마운트 없이 effect(`:227-230`). go-to-definition의 opener도 같은 경로를 쓴다(`goto-definition.ts:225-246`, selectDiff 호출 `:243`).
- 현재 뷰어 파일의 ext는 `DiffViewer.tsx:148` `setDefContext(projectId, path.split(".").pop() ?? "")`로 이미 추적 중 — 심볼 검색의 랭킹 힌트로 재사용 가능(§3.2).
- 뷰어 표시는 activeTab이 "viewer"일 때다 — 터미널 탭을 보던 중이면 `useTerminals.getState().setActiveTab(pid, "viewer")` 전환이 선행돼야 한다(`KeyboardShortcuts.tsx:86` 판정, `:109-110` 전환 전례).

### 2.4 단축키 인프라
- `src/components/KeyboardShortcuts.tsx:13-26` `GlobalShortcuts`(항상 마운트, mod+Shift+A), `:34-123` `KeyboardShortcuts`(프로젝트 선택 시 마운트, `App.tsx:117`; GlobalShortcuts 마운트는 `App.tsx:131`). ref로 최신 projectId 참조(`:44-45`).
- `src/lib/platform.ts:8-10` `isMod`(mac=metaKey), `:13` `modLabel`.
- xterm 화이트리스트: `src/lib/terminal-engine.ts:192-198` — Ctrl+\`/Ctrl+Shift+D·E·W/Ctrl+Shift+↑↓/mod+Shift+A가 `return false`로 window까지 버블. **신규 키도 한 줄 추가 필수.** 터미널이 소비 중: Ctrl+W(`:202-211`), Ctrl(+Shift)+C/V(`:214-226`), Tab(`:133-141`).

### 2.5 기존 키 전수(충돌 검사 기준)
| 키 | 동작 | 근거 |
|---|---|---|
| F5 | 새로고침 | KeyboardShortcuts.tsx:50-54 |
| Ctrl+Shift+D/E/W | 분할/패널 닫기 | KeyboardShortcuts.tsx:60-79 |
| Ctrl+W | 뷰어 파일 탭 닫기(터미널 내: 패널 닫기) | KeyboardShortcuts.tsx:83-94 / terminal-engine.ts:202-211 |
| Ctrl+K / Ctrl+Shift+K | 커밋 / 푸시 | KeyboardShortcuts.tsx:95-99 |
| **Ctrl+T** | **pull** | KeyboardShortcuts.tsx:100-102 |
| Ctrl+\` | 터미널 토글 | KeyboardShortcuts.tsx:103-115 |
| mod+Shift+A | 모아보기 토글 | KeyboardShortcuts.tsx:16-19 |
| Ctrl+S(뷰어) | 저장 | DiffViewer.tsx:219-221 |
| 예약(다른 문서) | 08=mod+Shift+F, 09=mod+P, 10=mod+Shift+O, 11=Shift+F12, 15=Shift+Alt+F | 각 문서 |

### 2.6 Monaco 0.55.1 내부 실측 (node_modules/monaco-editor)
- 파일 내 심볼 QuickAccess(`@`)의 기본 키는 **Ctrl/Cmd+Shift+O**: `esm/vs/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js:54` (`KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyO`) — 태스크 10의 영역이며 프로젝트 전체 검색은 Monaco에 없다(standalone 에디터는 워크스페이스 개념 부재).
- `KeyCode.KeyN` 바인딩은 **mac 전용 보조 바인딩**(WinCtrl+N = ⌃N — 리스트 아래 이동)뿐: `esm/vs/editor/browser/coreCommands.js:645`, `contrib/suggest/browser/suggestController.js:784`, `contrib/parameterHints/browser/parameterHints.js:122`. **Ctrl+Alt+N / Cmd+Alt+N 바인딩은 전무** → Monaco 포커스 중에도 window로 버블된다.
- 내장 TS 워커는 단일 모델만 알아 definitions를 이미 껐고(`src/components/diff/monaco-setup.ts:44-53`, `definitions:false` `:48`) 진단도 OFF(`:80-86`) — 워커류가 전역 심볼의 소스가 될 수 없다는 실측 근거.

### 2.7 E2E 인프라
- `tests/e2e/run.mjs:14-34` SUITES 등록, `lib/cdp.mjs:10-11` 포트 스캔(29222 우선)·타이틀 식별, `cdp.eval/invoke`.
- find_definition 검증 전례: `tests/e2e/suites/10-codenav.mjs:18-38`(픽스처 defs.ts 생성 → invoke → 검증/인젝션 거부/NOT_FOUND).
- 프론트 DOM 구동 전례: `suites/14-frontend-dom.mjs:71-73` 합성 keydown 디스패치, `:90` `window.__gpv.ui.getState().selectDiff(...)` 직접 구동, `:135-138` xterm textarea 포커스 상태 keydown. dev 노출: `src/main.tsx:34-37`(`__gpv`), `monaco-setup.ts:437-439`(`__monaco`).

## 3. 설계

### 3.1 검색 백엔드 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **신규 `find_symbols` — def_query의 심볼 자리를 부분일치 패턴으로 일반화** | **채택** | `def_query`를 "심볼 리터럴" 대신 "심볼 정규식 조각"을 받게 리팩터(`{s}` → `{sym_pat}`). find_definition은 이스케이프된 리터럴을, find_symbols는 `[\w$]*{q}[\w$]*`를 주입(예: `^\s*(async\s+)?def\s+[\w$]*query[\w$]*`). 검증·pathspec·정렬·시그니처 등 §2.1 관례를 같은 모듈(tree.rs) 안에서 그대로 재사용. grep 1패스. |
| 프론트에서 find_definition 반복 호출(접두 열거) | 기각 | 부분일치를 정확일치 API로 흉내낼 수 없다(후보 심볼명을 모름). invoke 폭주는 WebView2 유실 규약 위반. |
| 제네릭 패턴(`:579-585`)만 + pathspec 없이 전 파일 | 기각 | pathspec 제거는 실측 5배 손해(§2.1). 언어별 패턴(interface/trait/enum 등)의 정밀도도 잃는다. |
| ctags/LSP 인덱스 도입 | 기각 | 외부 바이너리 의존(자동 다운로드 전 문서 공통 비채택) + 인덱스 수명 관리(파일 변경 무효화)가 범위 초과. git grep은 항상 가용(코어 의존, `:383-385`). |

패턴 구성: 전 언어의 def_query 패턴 합집합(py 3 + ts/js 6 + rs 6 + go 2 + java/kt 2 + rb 2 = **21개 `-e`**) + 확장자 pathspec 합집합. 한 줄이 여러 패턴에 맞아도 git grep은 줄당 1회 출력이라 별도 dedupe 부담이 작다(안전망으로 (path,line) dedupe만).
쿼리 검증은 find_definition과 동일 규칙(`:372-377`) + **최소 2자**(1자는 과검색 — 빈 결과 반환). 대소문자는 smart-case: 쿼리가 전부 소문자면 `-i` 추가, 대문자 포함 시 민감(PyCharm 관례).

### 3.2 언어 스코프 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **전 언어(패턴·pathspec 합집합) + 현재 뷰어 ext는 랭킹 부스트** | **채택** | Go to Symbol은 파일이 안 열려 있어도 쓰는 진입 기능(PyCharm도 전 언어). pathspec 합집합이 데이터/미디어를 여전히 배제해 성능 이득 유지. 현재 뷰어 ext(`DiffViewer.tsx:148`이 이미 추적)는 동순위 내 우선만 — 결과를 숨기지 않는다. |
| 현재 뷰어 파일의 ext 한정 | 기각 | 뷰어가 비어 있으면 동작 불가. 다언어 레포(rs+ts)에서 반쪽 결과 — "안 먹는 것처럼 보이는" 상태. |
| 스코프 토글 UI(언어 선택 드롭다운) | 기각 | v1 과잉(YAGNI). 랭킹 부스트가 실사용을 커버. |

### 3.3 랭킹 — 백엔드에서 캡 전에 수행
정렬 키(사전식): ① 이름 일치 등급(정확 > 접두 > 부분) ② 정의 강도(def/class류 > 대입/const 폴백 — `:439-450`의 weak 분류 재사용) ③ 현재 뷰어 ext 일치 ④ 경로 깊이 얕은 순(`:504` 전례) ⑤ 경로·라인. 매치 줄에서 쿼리를 포함하는 식별자(`[A-Za-z_$][\w$]*`)를 찾아 `name`과 심볼 시작 열을 함께 추출(`:428-431`의 열 보정을 부분일치로 확장). 랭킹이 캡보다 먼저여야 하므로 프론트 랭킹은 기각 — 캡 100이 "아무거나 100개"가 되면 안 된다. 원시 매치는 스트리밍 파싱 중 1000줄에서 중단(§6 완화).

### 3.4 UI — 09 QuickPick 재사용 (중복 정의 금지)
- 모달·퍼지 매칭·키보드 내비·`fixed z-50`+백드롭 관례는 [09-quick-open.md](09-quick-open.md)의 QuickPick 프리미티브를 그대로 사용한다. 본 태스크는 **심볼 모드**만 추가: 클라이언트 퍼지 필터는 끄고(백엔드가 이미 부분일치+랭킹 수행) 비동기 아이템 소스(입력→invoke→아이템)와 로딩 스피너를 쓴다 — 09 계약에 비동기 소스가 포함돼야 함(교차 요구).
- 입력 **디바운스 250ms**(백엔드 콜드 195~485ms 실측 기준 — 타이핑 중 grep 중첩 방지) + 최소 2자. **이전 요청 무효화**: 요청마다 seq 토큰을 캡처하고 응답 도착 시 최신 seq가 아니면 폐기 — ipc의 single-flight(`ipc.ts:506-521`)는 동일 쿼리만 합치므로 이것으로 대체 불가.
- 항목 표시: `name` 강조 + 시그니처 첫 줄(코드 폰트) + 우측 `경로:라인`(회색). 시그니처는 extract_signature 재사용(§4).
- 선택 시: `useTerminals.getState().setActiveTab(pid, "viewer")`(터미널 탭에서 열었을 때 뷰어로 전환, §2.3) → `useUi.getState().selectDiff({ mode: "file", path, line, column })` — DiffViewer의 revealTarget이 심볼 착지를 그대로 수행(§2.3). repoId는 생략(outer) — v1 스코프는 현재 선택 프로젝트(§3.7).

### 3.5 키 선택 — 후보 비교

| 후보 | 판정 | 근거 |
|---|---|---|
| **mod+Alt+N** | **채택** | PyCharm Ctrl+N의 니모닉(Name) 계승. 앱 내 미사용(§2.5, altKey 조합 전무 — src 전체 grep 실측). Monaco 0.55.1에 바인딩 없음(§2.6 실측). 터미널 의미 충돌 없음(Ctrl+Alt+N은 쉘/readline 관례 없음). WebView2/브라우저 예약 아님(검증 필요). |
| Ctrl+N (PyCharm 원판) | 기각 | WebView2 브라우저 액셀러레이터의 새 창 예약 가능성(검증 필요 — 위험을 안고 갈 이유 없음). 터미널에선 readline "다음 히스토리"(C-n) 실사용 — 화이트리스트로 가로채면 안 됨. |
| Ctrl+T (PyCharm 대안 Cmd+O 인접) | 기각 | 이미 pull(KeyboardShortcuts.tsx:100-102). |
| mod+Shift+O | 기각 | 태스크 10(파일 내 심볼) 예약 + Monaco 내장 quick outline과 동일 키(§2.6) — 의미 충돌. |
| mod+P / mod+Shift+F | 기각 | 09(빠른 파일 열기)/08(전문 검색) 예약. |

**채택: `mod+Alt+N`** — mac=`⌘⌥N`, Windows/Ubuntu=`Ctrl+Alt+N`. 매칭 규칙: `isMod(e) && e.altKey && !e.shiftKey && e.key.toLowerCase() === "n"`(기존 `e.key` 관례 유지 — 01 §3.4).

### 3.6 등록 위치 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **KeyboardShortcuts(프로젝트 선택 시 마운트)에 추가** | **채택** | 검색은 `selectedProjectId`가 필수(스코프=현재 프로젝트) — 미선택이면 대상이 없다. 마운트 조건이 곧 활성 조건과 일치. pidRef 최신 참조 패턴(`:44-45`) 재사용. |
| GlobalShortcuts(항상 마운트) | 기각 | 프로젝트 미선택/모아보기 중엔 뷰어 자체가 없어 열어도 착지 불가 — "빈 모달" UX만 남는다. 필요해지면(모아보기 중 지원) 후속에 이동. |

### 3.7 범위 절단 (YAGNI)
- **v1**: find_symbols(전 언어·캡 100·랭킹) + QuickPick 심볼 모드 + mod+Alt+N + xterm 화이트리스트 1줄 + E2E.
- **비포함(후속)**: ① 임베디드 중첩 저장소 팬아웃(git grep은 임베디드 repo로 재귀하지 않음 — 합성 `<outerId>::<rel>` 병렬 조회는 후속) ② 전 프로젝트 횡단 검색 ③ 심볼 종류(kind) 아이콘 분류(시그니처가 이미 전달) ④ 결과 Promise 캐시(부분일치는 재사용률 낮음 — 디바운스로 충분) ⑤ 09 quick open 내 `@`/`#` 접두 통합(별도 키가 더 발견성 높음 — 열린 질문).

## 4. 계약(타입·커맨드·이벤트)

```rust
// src-tauri/src/commands/tree.rs — 신규. find_definition 바로 아래 co-locate.
// def_query는 (ext, sym_pat: &str)를 받도록 일반화 — find_definition은 이스케이프된
// 리터럴, find_symbols는 "[\\w$]*{q}[\\w$]*" 를 주입한다(기존 호출 결과 불변).
//
// [교차 노트 — tree.rs 동일 함수를 만지는 태스크 간 조정]
// · def_query: 태스크 11(11-find-references.md)이 ext_globs(ext) 분리를 계획한다.
//   병합 순서 권장: 11의 ext_globs 분리 선행 → 본 태스크의 sym_pat 일반화 후행
//   (분리된 ext_globs 위에서 일반화하면 pathspec 경로가 한 곳으로 남는다).
// · extract_signature: 태스크 14(14-hover-docstring.md) 구현 후 extract_sig_doc
//   (반환 (String, Option<String>))로 개명 — find_symbols는 signature만 사용(doc 무시).
//   14 선행 시 아래 SymbolMatch.signature 소스는 extract_sig_doc의 .0이다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolMatch {
    pub name: String,      // 매치된 심볼 식별자(하이라이트용)
    pub path: String,      // 레포 상대 경로(forward slash — find_definition 관례)
    pub line: u32,         // 1-based
    pub column: u32,       // 1-based, 심볼 시작 열
    pub signature: String, // extract_signature 재사용(14 이후 extract_sig_doc — signature만, doc 무시)
}

/// 심볼명 부분일치로 정의 후보를 검색한다. 쿼리 검증(2..=64자, 식별자 문자만) 실패·
/// git 오류·타임아웃은 조용히 빈 결과(find_definition 관례). 결과 캡 100(랭킹 후 절단).
/// ext_hint = 현재 뷰어 파일 확장자(랭킹 부스트 전용, 필터 아님) — 없으면 None.
#[tauri::command]
pub async fn find_symbols(
    state: State<'_, AppState>,
    project_id: String,
    query: String,
    ext_hint: Option<String>,
) -> Result<Vec<SymbolMatch>, IpcError>;
// src-tauri/src/lib.rs invoke_handler에 commands::find_symbols 등록(:302 인접).
```

```ts
// src/lib/ipc.ts — DefMatch(:83) 인접에 타입 미러 + 래퍼.
export interface SymbolMatch {
  name: string; path: string; line: number; column: number; signature: string;
}
// interactive 레인(사용자 타이핑 직결). attempts:1 — 낡은 쿼리의 재시도는 슬롯 낭비,
// 다음 키 입력이 새 요청을 만든다. 타임아웃은 기본 8s(백엔드 grep 10s 캡보다 짧아도
// 낡은 응답은 어차피 seq 무효화로 폐기됨).
findSymbols: (projectId: string, query: string, extHint: string | null) =>
  call<SymbolMatch[]>("find_symbols", { projectId, query, extHint },
    { lane: "interactive", attempts: 1 }),
```

```ts
// src/components/SymbolSearch.tsx (신설) — 09의 QuickPick 프리미티브에 심볼 모드 소스 연결.
// 열기: KeyboardShortcuts.tsx onKey에 분기 추가 —
//   isMod(e) && e.altKey && !e.shiftKey && k === "n" → e.preventDefault(); 심볼 검색 열기
// (열림 상태는 useUi에 boolean 1개 추가: symbolSearchOpen / setSymbolSearchOpen — settingsOpen 미러)
// 선택: setActiveTab(pid, "viewer") → selectDiff({ mode:"file", path, line, column })
```

```ts
// src/lib/terminal-engine.ts — 화이트리스트 블록(:192-198)에 추가.
if (isMod(e) && e.altKey && k === "n") return false; // 심볼 검색 — window로 버블
```

**백엔드 신규 1커맨드(read-only), 이벤트 없음.** find_definition 관례(검증·pathspec·캡·forward-slash) 전부 준수.

## 5. 단계(구현 순서)

1. **def_query 일반화** — `(ext, symbol)` → `(ext, sym_pat)` 시그니처 변경 + find_definition 호출부 보정. 태스크 11의 ext_globs 분리가 계획돼 있으면 그것을 먼저 병합한 뒤 수행(§4 교차 노트). 기존 E2E(10-codenav)가 회귀 가드. (~20 LOC 변경)
2. **find_symbols 구현** — 검증(2자 미만 거부)·smart-case `-i`·21패턴+pathspec 합집합 grep·스트리밍 파싱(1000줄 중단)·이름/열 추출·랭킹·(path,line) dedupe·캡 100·시그니처 추출(파일 내용 HashMap 캐시로 중복 읽기 제거). lib.rs 등록 1줄. (~170 LOC)
3. **ipc.ts** — SymbolMatch + findSymbols 래퍼. (~15 LOC)
4. **QuickPick 심볼 모드** — [09-quick-open.md](09-quick-open.md) 프리미티브에 비동기 소스 연결: 디바운스 250ms·seq 무효화·로딩/빈 상태·항목 렌더(name 강조+시그니처+경로:라인)·선택 착지. useUi에 open 상태 1개. (~120 LOC — 09 완료가 선행)
5. **단축키** — KeyboardShortcuts 분기 + terminal-engine 화이트리스트 1줄 + 발견성(뷰어/트리 어딘가 title에 `⌘⌥N`/`Ctrl+Alt+N` 병기). (~10 LOC)
6. **E2E** — ① `suites/10-codenav.mjs` 확장(또는 신규 `20-symbol-search.mjs`): 픽스처에 `gpvAlpha`/`gpvAlphaBeta`/`class GpvAlphaCls` 작성 → `find_symbols {query:"gpvAlpha"}` 접두>부분 순위·name/line/column 검증, 2자 미만·특수문자 쿼리 → 빈 결과, 없는 프로젝트 → NOT_FOUND(10-codenav.mjs:29-38 미러). ② `14-frontend-dom.mjs` 패턴: `__gpv.ui`로 픽스처 선택 → 합성 keydown(Ctrl+Alt+N, `:71-73` 미러) → 모달 DOM 출현 → input에 값 주입+input 이벤트 → 항목 폴링 → Enter → `__gpv.ui.getState().selectedDiff`가 `{mode:"file", path, line}`인지 단언. xterm textarea 포커스 상태에서 1회 재검증(`:135-138` 미러).

규모: **M (2~4일)** — Rust ~190 LOC + 프론트 ~150 LOC + 테스트. 4단계가 09 산출물에 의존.

## 6. 위험과 완화

| 위험 | 설명 | 완화 |
|---|---|---|
| 짧은/흔한 쿼리의 grep 부하 | 2자 쿼리(`re` 등)는 거대 레포에서 수천 매치 — 출력 파싱·시그니처 추출이 비대해짐 | 최소 2자 + 디바운스 250ms + 스트리밍 1000줄 중단 + 캡 100 + 시그니처는 캡 후에만·파일 내용 캐시. 중단 시 파일 순서 편향은 v1 수용(더 타이핑하면 좁혀짐 — 문서화) |
| AltGr 레이아웃 충돌 | 일부 유럽 레이아웃에서 Ctrl+Alt=AltGr라 Ctrl+Alt+문자가 글자 입력일 수 있음 — 입력 필드 포커스 중 오발 가능 | 주요 대상(한/영 레이아웃)은 무관. 리스크 시 `e.code === "KeyN"` 전환 또는 `e.getModifierState("AltGraph")` 가드(후속). 모달/입력 포커스 중엔 preventDefault 전에 대상 확인 |
| 늦은 응답이 최신 결과를 덮음 | grep 195~485ms 동안 추가 타이핑 → 응답 역전 | seq 토큰 무효화(§3.4). ipc single-flight는 동일 쿼리만 합치므로 별도 구현 필수를 계약에 명시 |
| 임베디드 중첩 저장소 미포함 | git grep은 임베디드 repo 내부로 재귀하지 않음 — 중첩 저장소의 심볼이 안 나옴 | v1 한계로 수용·문서화(§3.7). 후속: 합성 projectId(`<outer>::<rel>`) 팬아웃 배치 커맨드(WebView2 유실 규약 준수) |
| def_query 시그니처 변경 회귀 | find_definition의 패턴 의미가 미세하게 바뀌면 Ctrl+클릭 점프가 조용히 깨짐. 태스크 11도 같은 함수(ext_globs 분리)·14도 같은 파일(extract_sig_doc 개명)을 수정해 병합 충돌 여지 | 리터럴 주입 경로는 이스케이프 포함 동일 문자열이 되도록 단위 유지 + 기존 10-codenav E2E가 회귀 가드(1단계에서 먼저 통과 확인). 병합 순서는 §4 교차 노트(11 선행 → 13 후행, 14는 독립이나 개명 반영) |
| WebView2 Ctrl+Alt+N 예약 여부 미검증 | 브라우저 액셀러레이터 목록에 없다고 보나 실기 미확인 | (검증 필요) — E2E ②의 합성 keydown과 별개로 실기 물리 키 1회 확인을 구현 체크리스트에 포함. 실패 시 폴백 후보 mod+Alt+S |
