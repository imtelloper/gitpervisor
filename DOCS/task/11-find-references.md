# 태스크 11 — 참조 찾기 (Find Usages)

> 상태: 설계(Design) · 대상: gitpervisor · 산출물 성격: 아키텍처/계약/단계/위험 (구현은 후속)
> 근거: 코드 실측 2026-07-06 (monaco-editor 0.55 로컬 소스 포함) · 관련: 태스크 08(전역 검색 — 같은 git grep 계열 IPC 관례 공유), [01-aggregate-hotkey.md](01-aggregate-hotkey.md)(단축키 충돌 목록 전례)

## 1. 요구사항

뷰어에서 심볼 위에 커서를 두고 **Shift+F12**를 누르면 그 심볼의 사용처 목록을 **peek 위젯**(에디터 안 인라인 패널: 좌측 미리보기 + 우측 파일별 그룹 트리)으로 보여준다 — PyCharm Find Usages의 휴리스틱(LSP 없는) 버전.

- 검색 범위: 현재 뷰어 파일이 속한 저장소(임베디드 합성 id 포함), 같은 언어 계열 파일만.
- peek 목록에서 항목 더블클릭(또는 Enter) → 실제 뷰어 파일 탭으로 열고 해당 줄로 점프.
- 결과 0건이면 Monaco 기본 "No references found" 인라인 메시지, 1건이면 peek 없이 바로 점프(Monaco 기본 동작 그대로).
- 파일뷰·diff뷰 양쪽에서 동작(diff뷰는 실기 검증 전제 — §6).

## 2. 현황(근거)

### 2.1 백엔드 — 참조 검색 커맨드는 없고, 관례의 원형(find_definition)은 완성돼 있음
- `src-tauri/src/commands/tree.rs:364` `find_definition` — 심볼 검증(식별자만 허용: 빈/128자 초과/특수문자 거부, `:372-377`), `git grep -P -n --column --no-color -I --untracked`(`:388-401`), 확장자 pathspec(`:396-401`, 주석 `:386-387`에 "사후 필터 대비 수 배 빠르다 — 실측 nqvm-ais 1.4s → 0.2s"), 결과 캡 12(`:446-448`), 상대경로 forward-slash 변환(`:425`), `--column`이 패턴 시작(키워드)을 가리켜 심볼 열로 보정(`:427-431`).
- 확장자→pathspec 매핑은 `def_query`(`tree.rs:521-587`) 안에 정의 패턴과 함께 묶여 있다 — 참조 검색은 패턴 없이 **확장자 목록만** 필요하므로 공용 함수로 분리할 지점.
- `git` 실행은 `runner::run_git`(`tree.rs:402`), 읽기 타임아웃 10초(`src-tauri/src/git/runner.rs:9` `READ_TIMEOUT_SECS: u64 = 10`). 매치 없음은 exit 1 → 빈 stdout 정상 처리(`tree.rs:385` 주석).
- 커맨드 등록: `src-tauri/src/lib.rs:302` `commands::find_definition` — 신규 커맨드는 같은 목록에 추가.
- 성능 실측(인용 가능): find_definition — pathspec 적용 후 nqvm-ais(17.6GB) 콜드 195~485ms, 캐시 히트 ~0ms, `get_file_diff` 3ms.

### 2.2 프론트 — 정의 점프 인프라가 참조 찾기의 부품을 대부분 이미 가짐
- `src/components/diff/goto-definition.ts:19` 커스텀 스킴 `gitpervisor-def`, `:81-83` `defUri(path)`(경로만, 파일당 모델 1개).
- **미리보기 모델 사전 생성**: `ensurePreviewModel`(`:87-104`) — `ipc.getDiff(mode:"file")`로 내용을 받아 커스텀 URI 모델 생성, FIFO 상한 40(`:97-100`), 생성 경합 가드(`:93`). 현재 **모듈 프라이빗** — 참조 찾기가 재사용하려면 export 필요.
- 심볼 캐시: `Map` 키 `projectId:ext:symbol`, 상한 800(`:29-43`). 예열은 동시 2 스태거(`:70-77`, background lane).
- import 별칭 해석 `resolveImportAlias`(`:113-132`) — **정의 검색용**(별칭은 레포에 정의가 없으므로 원명으로 되돌림). 참조 검색의 의미론(그 이름이 쓰인 곳)과는 목적이 다름 — §3.6에서 v1 범위 절단.
- provider 등록 언어 목록 `LANGS`(`:162-165`), 1회 등록 가드(`:167-171`).
- **openCodeEditor opener는 이미 있음**: `monaco.editor.registerEditorOpener`(`:225-246`) — 스킴 검사(`:227`) 후 `useUi.getState().selectDiff({mode:"file",path,line,column}, ctx.projectId)`(`:243`)로 뷰어 탭을 연다. 같은 스킴 URI를 반환하는 한 **peek의 더블클릭도 추가 코드 없이 이 opener로 라우팅된다**(§2.4에서 경로 실측).
- 컨텍스트: `setDefContext(projectId, ext)`(`:24-26`)를 `DiffViewer.tsx:147-149`가 모든 모드에서 갱신 — 참조 provider도 같은 ctx를 쓰면 된다. provider 등록 시점: `DiffViewer.tsx:144-146` `registerGotoDefinition()` 1회 effect.
- 점프 착지: `DiffViewer.tsx:129-141` `revealTarget` — `selectDiff`의 line/column으로 심볼 선택+포커스. `stores/ui.ts:97`(인터페이스)/`:181-198`(구현) `selectDiff`가 viewerTabs에 탭 적립(`ui.ts:65`). 토스트는 `ui.ts:115`/`:255` `pushToast`.

### 2.3 Monaco 0.55 — Shift+F12·peek·모델 해석의 실측 사실 (node_modules/monaco-editor 소스)
- **Shift+F12는 살아 있다**: `esm/vs/editor/contrib/gotoSymbol/browser/goToCommands.js:534-551` `GoToReferencesAction` — id `editor.action.goToReferences`, 키바인딩 `Shift+F12`(`:549`, when `editorTextFocus` `:548`), precondition `hasReferenceProvider && notInPeekEditor && !isInEmbeddedEditor`(`:546`). 즉 **ReferenceProvider만 등록하면 키가 자동 활성** — 앱 레벨 keydown 등록 0.
- `registerAction2`로 등록된 `EditorAction2`(`goToCommands.js:60`, `:534`)라 `editor.getAction()`은 null — E2E/프로그램 실행은 `ed.trigger(src, "editor.action.goToReferences", {})`(goto 계열 공통 함정, 기존 메모리와 일치).
- **다중 결과 → peek 자동**: `goToCommands.js:137-141` — `multipleReferences` 기본값 `'peek'`(`esm/vs/editor/common/config/editorOptions.js:790`)이고 결과 2건 이상이면 `_openInPeek`. **1건이면 바로 점프**: `goToCommands.js:143-145` → `editorService.openCodeEditor`(`:172-179`) → 표준 opener 경유.
- **includeDeclaration**: `esm/vs/editor/contrib/gotoSymbol/browser/goToSymbol.js:56-67` — provider는 `{includeDeclaration:true}`로 호출되고, 결과가 정확히 2건이면 `{includeDeclaration:false}`로 **재호출**해 1건이 되면 그걸로 바로 점프. → provider가 이 플래그를 실제로 구현해야 "정의 1 + 사용 1" 케이스가 peek 없이 사용처로 점프한다.
- **peek 미리보기는 '이미 존재하는 모델'만 해석**: standalone의 `ITextModelService.createModelReference`는 `modelService.getModel(resource)`가 없으면 `Promise.reject(new Error("Model not found"))`(`esm/vs/editor/standalone/browser/standaloneServices.js:121-131`). 지연 로딩 훅 없음.
- 모델 해석 시점 2곳: ① 트리 스니펫 — `FileReferences.resolve`가 파일 그룹 펼침 시 해석하되 **실패를 삼킨다**(`referencesModel.js:91-108`, catch 후 onUnexpectedError만). ② 좌측 미리보기 — `referencesWidget.js:469-513` `_revealReference`의 `await createModelReference`(`:482`,`:493`)는 **reject가 전파**돼 컨트롤러의 에러 알림으로 빠진다(`referencesController.js:163-165`). → **선택될 수 있는 모든 참조 파일의 모델이 peek 표시 전에 존재해야 안전**.
- **peek 안 더블클릭 → 실제 열기**: 트리 더블클릭/Enter는 kind `'goto'`(`referencesWidget.js:368-378`, `:465-468`), 미리보기 에디터 더블클릭은 kind `'open'`(`:429-443`) — 둘 다 `referencesController.js:104-129` 분기를 거쳐 `openReference` → `_editorService.openCodeEditor`(`:256-266`). standalone에서 `registerEditorOpener`는 `registerCodeEditorOpenHandler`로 이 경로에 연결된다(`standaloneEditor.js:382-397`). → §2.2의 기존 opener가 그대로 받는다.
- Esc로 peek 닫힘(`referencesController.js:327-340`).
- **diff뷰**: DiffEditor 내부 에디터는 평범한 `CodeEditorWidget`(`esm/vs/editor/browser/widget/diffEditor/diffEditorWidget.js:249-252`) — `isInEmbeddedEditor`는 기본 false(`editorContextKeys.js:46`)라 precondition 통과. 실제 peek 렌더 품질은 실기 검증 필요(§6).

### 2.4 충돌 요인 — TS/JS 내장 워커가 참조 provider를 이미 켜고 있음
- `src/components/diff/monaco-setup.ts:44-58` `tsModeNoDefs` — `definitions: false`로 껐지만 **`references: true`(`:49`)는 살아 있다**. 워커는 단일 모델만 알므로(주석 `:37-43` — 같은 이유로 definitions를 껐고 가짜 마커 150개 실측 근거도 이 파일) 현재 파일 안 참조를 `inmemory://` URI로 반환한다. 우리 provider(커스텀 URI)와 **양쪽 결과가 병합**(`goToSymbol.js`의 `getLocationLinks`가 등록된 모든 provider 결과를 합침)돼 현재 파일 참조가 **다른 URI로 2벌 표시**된다. → `references: false`로 꺼서 소스를 하나로 좁힌다(definitions 전례와 동일한 수법).

### 2.5 단축키 충돌 검사 — Shift+F12는 비어 있음
- 앱 전역 키: F5(`src/components/KeyboardShortcuts.tsx:50`), Ctrl+K/Shift+K/T/`/W, Ctrl+Shift+D/E/W/A(`KeyboardShortcuts.tsx:13-26`,`:47-120`) — F12 계열 없음.
- 터미널 화이트리스트(terminal-engine.ts)는 무관 — Shift+F12는 `editorTextFocus`(§2.3)에서만 의미가 있어 터미널 포커스 통과가 필요 없다.
- WebView2: F12=DevTools 예약. **Shift+F12의 예약 여부는 (검증 필요)** — 미도달 시 폴백은 §3.5.

### 2.6 E2E 인프라
- 백엔드 검증 전례: `tests/e2e/suites/10-codenav.mjs:18` `cdp.invoke("find_definition", …)` — 픽스처 파일 작성 후 커맨드 직접 구동, 심볼 검증·NOT_FOUND까지 커버(`:29-38`).
- 프론트 검증 전례: `tests/e2e/suites/14-frontend-dom.mjs:18-20` dev 노출 게이트(`window.__gpv`), `:90` `selectDiff`로 뷰어 열기. `monaco-setup.ts:437-439`가 dev에서 `window.__monaco` 노출. 스위트 번호는 19까지 사용 중 → 신규 20.

## 3. 설계

### 3.1 검색 백엔드 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **신규 IPC `find_references`: `git grep -F -w`(고정 문자열+단어 경계) + 확장자 pathspec** | **채택** | find_definition 관례 정합(§2.1: 같은 runner, 같은 pathspec 가속, 같은 심볼 검증). `-F`는 정규식 해석 자체가 없어 인젝션 표면 0(-w와 병용 가능). `--column`이 패턴 시작=심볼 시작이라 find_definition의 열 보정(`tree.rs:427-431`)도 불필요. `--untracked`로 새 파일 포함. |
| find_definition을 모드 인자로 확장 | 기각 | 반환 형태(시그니처 추출·정의 우선 정렬·모듈 폴백)가 참조 검색과 전혀 다름 — 한 커맨드에 두 의미를 접으면 양쪽 캡·정렬 로직이 얽힌다. 커맨드 분리가 lib.rs 등록 1줄 비용으로 더 싸다. |
| 프론트에서 열린 모델들만 스캔(백엔드 없이) | 기각 | 뷰어는 파일을 1~2개만 모델로 가짐 — "사용처"의 본질이 레포 전체 검색이라 요구사항 미충족. |
| ripgrep 바이너리 직접 실행 | 기각 | find_definition이 이미 기각한 이유 그대로(`tree.rs:383-385` 주석): rg는 앱 PATH에 없을 수 있고 git은 항상 가용. |

### 3.2 정의줄 구분(includeDeclaration) — 대안 비교

Monaco가 `{includeDeclaration:false}` 재호출을 실제로 쓰므로(§2.3) 정의줄 판별이 필요하다.

| 대안 | 판정 | 근거 |
|---|---|---|
| **프론트 대조: `find_references`와 `find_definition`(기존 캐시 `lookup`)을 병행 호출, (path,line) 일치를 정의로 마킹** | **채택** | warmDefinitionCache(§2.2)로 캐시가 이미 데워진 경우가 많아 추가 비용 ~0ms(실측 캐시 히트 ~0ms). 신규 의존/백엔드 로직 0. includeDeclaration 필터는 캐시된 원본 결과에 사후 적용이라 Monaco의 2중 호출(§2.3)에도 백엔드 재호출 없음. |
| 백엔드가 def_query 패턴으로 각 매치 줄을 분류(`isDefinition` 플래그) | 기각 | Rust 쪽 정규식 실행이 필요한데 **Cargo.toml에 regex 크레이트가 없다**(실측 — dunce/base64 등만). PCRE(git grep -P)↔regex 크레이트 방언 차이도 관리 비용. |
| 백엔드 2차 git grep(정의 패턴)으로 차집합 | 기각 | 거대 레포 콜드 그렙 1회 추가(+195~485ms 실측) — 매 호출 지연 배증. |

한계 수용: find_definition 캡 12(§2.1) 밖의 정의줄은 마킹 누락 — 휴리스틱 도구의 허용 오차로 명시(§6).

### 3.3 미리보기 모델 공급 — 핵심 난관, 대안 비교

standalone Monaco는 "이미 있는 모델"만 미리보기로 해석하고(§2.3), 선택된 참조의 모델 부재는 에러로 전파된다. 참조가 수십 파일이면 모델 수십 개가 필요하다.

| 대안 | 판정 | 근거 |
|---|---|---|
| **provider 반환 전 결과의 모든 파일 모델을 선생성 — 단 파일 수 캡 30, 동시 4 스태거, `ensurePreviewModel` 재사용** | **채택** | 지연 로딩 훅이 구조적으로 없음(§2.3 — `createModelReference`는 동기 조회 즉시 reject). `get_file_diff` 3ms 실측 → 30파일 × (3ms+IPC 오버헤드) ≈ 100~300ms로 peek 표시 지연 수용 범위(Monaco가 250ms 프로그레스로 가림, `goToCommands.js:134`). 파일 캡 30 < 모델 FIFO 상한 40(§2.2)이라 peek가 연 모델이 자기 자신을 밀어내지 않는다. |
| 최근접 파일만 선생성 + 나머지 백그라운드 스태거(지연 하이브리드) | 기각 | 첫 표시는 빨라지나 사용자가 빨리 다른 파일 행을 클릭하면 "Model not found" 에러 알림(§2.3 ② 전파) — 확률적 실패를 UX에 노출. 채택안의 지연이 충분히 작아 복잡도 대비 이득 없음. |
| `ITextModelService` 오버라이드로 진짜 지연 해석 구현 | 기각 | `StandaloneServices.initialize` 선점 등 비공개 내부 API 의존 — @monaco-editor/react 초기화 순서와 얽혀 업그레이드마다 깨질 표면. |
| 신규 배치 IPC(read_files 여러 개 한 번에) | 기각(후속 후보) | 파일 30개 × 3ms면 기존 `ipc.getDiff`(`ipc.ts:605`) 재사용으로 충분. call()의 MAX_CONCURRENT 8·single-flight(`ipc.ts:489`,`:503-519`)이 동시 invoke 유실을 이미 관리. 실측상 병목이면 그때 추가. |

`ensurePreviewModel`·`defUri`는 goto-definition.ts에서 **export로 승격**해 재사용(신규 모듈이 import). 같은 `gitpervisor-def` 스킴을 쓰므로 peek 더블클릭 → 기존 opener → 뷰어 탭 경로가 **무변경으로 성립**(§2.3·§2.2).

### 3.4 결과 캡과 그룹핑

- **총 매치 캡 200 + 파일 캡 30** — stdout 파싱 중 어느 한쪽 도달 시 중단, `truncated: true` 반환. 프론트는 truncated면 `pushToast("info", …)` 1회("참조가 많아 일부만 표시").
- 파일별 그룹은 **Monaco가 무료 제공** — `ReferencesModel`이 URI로 정렬·그룹화(`referencesModel.js:236-238`)하므로 백엔드는 평평한 배열만 반환(백엔드 그룹핑 비채택 — 이중 구현).
- git grep 자체 출력 폭주(흔한 심볼)는 10초 타임아웃(§2.1)이 마지노선. `git grep -m <n>`(파일당 매치 상한)이 있으면 stdout 자체를 줄일 수 있다 — git 버전 요구사항 존재 (검증 필요), 미지원이면 파싱 캡만으로 수용.

### 3.5 키·발견성

- **Shift+F12** — Monaco 내장 바인딩 그대로(§2.3), 앱 레벨 등록 0, 터미널 화이트리스트 불필요(§2.5). 기존 키와 충돌 없음(§2.5).
- WebView2가 Shift+F12를 가로채는 것으로 실측되면(§2.5 검증 필요): 폴백은 에디터 **컨텍스트 메뉴** — provider 등록만으로 우클릭 메뉴에 "Go to References"가 자동 노출된다(`goToCommands.js:552-556` EditorContext menu 등록). 키 재배정 불필요.
- peek 내 조작은 Monaco 기본(Enter/더블클릭=열기, Esc=닫기, F4/Shift+F4=다음/이전)을 그대로 쓴다.

### 3.6 범위 절단 (YAGNI)

- **v1**: `find_references` IPC + ReferenceProvider(LANGS 대상) + 모델 선생성 + 정의줄 마킹(프론트 대조) + truncated 토스트 + TS 워커 references off.
- **별칭 v1 규칙**: 커서의 **단어 그대로** 검색한다(별칭 `Y`에서 실행하면 `Y`의 사용처, 원명 `X`에서 실행하면 `X`의 사용처). `resolveImportAlias`(§2.2)는 적용하지 않는다 — 그 함수의 목적은 "정의가 없는 별칭을 원명으로 치환"이지, 사용처 의미론(이 이름이 쓰인 곳)이 아니다. 원명+별칭 통합 추적(정의를 별칭으로 들여온 파일까지)은 LSP급 해석이라 후속.
- **후속**: ① 다중 저장소/임베디드 확장 검색(v1은 ctx.projectId 하나), ② 주석/문자열 내 매치 제외(git grep은 토큰 무지 — 휴리스틱 수용), ③ VS Code식 사이드 References 패널, ④ read_files 배치 IPC(§3.3), ⑤ Rename(참조 기반 일괄 변경).
- 자동 바이너리 다운로드 없음(전 문서 공통). 프로젝트 내부 실행파일 실행도 없음 — 이 태스크는 git만 쓴다.

## 4. 계약(타입·커맨드·이벤트)

```rust
// src-tauri/src/commands/tree.rs — find_definition(§2.1) 옆에 신설. lib.rs invoke_handler에 등록 1줄.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefMatch {
    pub path: String, // 레포 상대 경로(forward slash — find_definition 관례)
    pub line: u32,    // 1-based
    pub column: u32,  // 1-based, 심볼 시작(-F라 --column이 곧 심볼 위치)
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsResult {
    pub matches: Vec<RefMatch>, // 평평한 배열 — 그룹핑은 Monaco(§3.4)
    pub truncated: bool,        // 매치 200 또는 파일 30 캡 도달
}

/// git grep -F -w -n --column --no-color -I --untracked -e {symbol} -- *.ts *.tsx …
/// 심볼 검증은 find_definition과 동일(식별자만 — tree.rs:372-377 미러).
/// 확장자→pathspec은 def_query에서 분리한 공용 fn ext_globs(ext)를 양쪽이 사용.
/// [교차 노트 — tree.rs 동시 수정 조정] def_query는 태스크 13(13-symbol-search.md)도
/// 수정한다(심볼 자리를 sym_pat 정규식 조각으로 일반화). 병합 순서 권장: 본 태스크의
/// ext_globs 분리 선행 → 13의 sym_pat 일반화 후행. 태스크 14(14-hover-docstring.md)는
/// 같은 파일의 extract_signature를 extract_sig_doc로 개명 — 본 태스크와 함수 겹침 없음.
/// 매치 없음/타임아웃/비식별자 → Ok(빈 결과) (find_definition 관례).
#[tauri::command]
pub async fn find_references(
    state: State<'_, AppState>, project_id: String, symbol: String, ext: String,
) -> Result<RefsResult, IpcError>;
```

```ts
// src/lib/ipc.ts — DefMatch(:83-88)·findDefinition(:680-685) 옆에 추가.
export interface RefMatch { path: string; line: number; column: number }
export interface RefsResult { matches: RefMatch[]; truncated: boolean }
findReferences: (projectId: string, symbol: string, ext: string) =>
  call<RefsResult>("find_references", { projectId, symbol, ext }, { lane: "interactive" });
```

```ts
// src/components/diff/goto-definition.ts — 기존 프라이빗을 export로 승격(구현 변경 0).
export function defUri(path: string): monaco.Uri;                 // :81-83
export function ensurePreviewModel(path: string): Promise<void>;  // :87-104 (FIFO 40 유지)
export function lookup(symbol: string, lane?): Promise<DefMatch[]>; // :30-43 — 정의줄 대조용(§3.2)
```

```ts
// src/components/diff/find-references.ts (신설) — DiffViewer.tsx:144-146 effect에서
// registerGotoDefinition()과 나란히 1회 호출.
export function registerFindReferences(): void;
// 내부: LANGS(goto-definition.ts:162-165 재사용) 대상 monaco.languages.registerReferenceProvider.
// provideReferences(model, position, context):
//   0) [교차 표기 — 17-lsp-integration.md §3.5] 태스크 17(LSP) 도입 시 진입부에
//      lspActive(projectId, lang)이면 null 반환(상호배타 게이트) — LSP references와
//      결과가 병합되면 §2.4와 같은 중복 그룹→peek 회귀가 재발한다.
//   1) word = model.getWordAtPosition(position); ctx 없으면 null.
//   2) [refs, defs] = Promise.all([refsLookup(word), lookup(word)])  // 각자 캐시(Map 800 미러)
//   3) context.includeDeclaration === false → (path,line)이 defs와 일치하는 매치 제외(§3.2)
//   4) 결과의 고유 path(≤30)를 ensurePreviewModel로 동시 4 스태거 선생성 후 반환(§3.3)
//   5) return matches.map(m => ({ uri: defUri(m.path),
//        range: new monaco.Range(m.line, m.column, m.line, m.column + word.length) }))
//   truncated면 useUi.getState().pushToast("info", …) 1회.
```

```ts
// src/components/diff/monaco-setup.ts:49 — 1값 변경: references: true → false (§2.4).
// definitions:false와 같은 근거(단일 모델 워커의 로컬 결과가 레포 검색과 병합돼 중복 그룹).
```

**이벤트/스토어 변경 0** — peek·점프·탭 적립 전부 기존 경로(Monaco 내장 + 기존 opener + selectDiff). 신규 키바인딩 등록 0(Shift+F12는 Monaco 내장).

## 5. 단계(구현 순서)

1. **백엔드 `find_references`** — `def_query`에서 `ext_globs(ext)` 분리(양쪽 사용) + 커맨드 본체 + `lib.rs` 등록. 이 분리는 태스크 13의 def_query sym_pat 일반화보다 **선행** 병합 권장(§4 교차 노트). (~110 LOC Rust)
2. **ipc.ts 계약** — RefMatch/RefsResult/findReferences. (~15 LOC)
3. **goto-definition.ts export 승격** — defUri/ensurePreviewModel/lookup 3개. (diff ~3 LOC)
4. **find-references.ts** — provider + 정의줄 대조 + 모델 선생성 스태거 + truncated 토스트, DiffViewer effect에 등록 1줄. (~120 LOC)
5. **monaco-setup.ts `references: false`** — 1줄 + 주석 갱신.
6. **실기 스모크** — Shift+F12 도달(WebView2)·diff뷰 peek 렌더·peek 더블클릭→탭 열림(§2.3 경로) 확인. 컨텍스트 메뉴 노출 확인(§3.5 폴백 겸용).
7. **E2E `tests/e2e/suites/20-find-references.mjs`** — ① 백엔드: 픽스처 2파일(정의 1 + 사용처 3, `gpvRefTarget`)에 `cdp.invoke("find_references", …)` — 두 파일 매치·1-based line/column·단어 경계(`gpvRefTargetXyz` 미매치)·비식별자 거부·없는 프로젝트 NOT_FOUND·truncated=false (10-codenav.mjs 미러). ② 프론트(dev 게이트 `__gpv`/`__monaco`, 14-frontend-dom.mjs:18-20 패턴): `selectDiff`로 픽스처 열기 → `__monaco.editor.getEditors()`로 에디터 획득, `setPosition` 후 `ed.trigger("e2e","editor.action.goToReferences",{})` → `.reference-zone-widget` DOM 출현 + 참조 카운트 표기 확인 → Esc 디스패치로 닫힘 확인. (~100 LOC)

규모: **M(2~3일)** — Rust ~110 + TS ~140 + 테스트 ~100 LOC. Monaco 내장 경로 실기 검증(6단계)이 변수.

## 6. 위험과 완화

| 위험 | 설명 | 완화 |
|---|---|---|
| 흔한 심볼 폭주 | `get` 같은 심볼은 수천 매치 — git grep stdout·파싱 비용, peek도 무의미해짐 | 매치 200/파일 30 캡 + truncated 토스트(§3.4). 10초 타임아웃(runner.rs:9)이면 빈 결과로 조용히 수용. `-m` 파일당 상한은 git 버전 확인 후 적용(검증 필요) |
| 미리보기 모델 FIFO 경합 | peek가 30개 모델을 점유한 채 사용자가 Ctrl+호버(정의 미리보기)를 하면 FIFO 40에서 peek 모델이 밀려나 이후 행 클릭 시 "Model not found" 에러 알림(§2.3 ② 전파) | 파일 캡 30<40으로 기본 여유 확보. 실측상 재현되면 상한 40→60 상향(메모리 대비 소폭) 또는 peek 열림 중 예열 억제 — 후속 조정 항목으로 명시 |
| Shift+F12 미도달 | WebView2가 키를 선점하면 액션 미발화 (검증 필요 — §2.5) | 6단계 실기 스모크로 확정. 미도달 시에도 컨텍스트 메뉴 "Go to References"가 자동 노출(§3.5)돼 기능 자체는 접근 가능. 필요 시 GlobalShortcuts에서 `ed.trigger` 중계(후속) |
| dirty 편집 중 라인 불일치 | 검색·미리보기는 디스크 스냅샷 기준 — 저장 안 한 편집이 있으면 줄 번호가 어긋난 위치로 점프할 수 있다 | 뷰어는 읽기 중심(diff뷰 readOnly — DiffViewer.tsx:59)이라 빈도 낮음. 수용하고 문서화. live 모델 매핑은 dirty 시 오히려 더 어긋나(검색은 디스크 기준) 기각 |
| 거대/바이너리 파일 미리보기 공백 | `get_file_diff`가 tooLarge/binary면 newContent null → 빈 모델 생성(goto-definition.ts:94의 `?? ""`) — 미리보기가 공백으로 보임 | 점프(더블클릭)는 opener가 실제 파일로 열어 동작. 미리보기 공백은 수용(그런 파일이 참조 매치되는 경우 자체가 드묾 — pathspec이 소스 확장자만 스캔) |
| diff뷰 peek 렌더 품질 | 내부 에디터가 embedded가 아니라 precondition은 통과(§2.3)하나, hideUnchangedRegions 접힘·좁은 분할 폭과 zone widget의 상호작용은 미검증 | 6단계 실기 확인. 깨지면 v1은 파일뷰 한정으로 축소(“편집” 버튼으로 파일뷰 전환 경로가 이미 있음 — DiffViewer.tsx:307-315) |
| 정의줄 마킹 누락 | find_definition 캡 12 밖 정의는 includeDeclaration=false에서도 남는다(§3.2) | 휴리스틱 허용 오차로 수용 — 영향은 "2건 컴팩트 축약"(§2.3) 미발동뿐, 목록 자체는 정상 |
