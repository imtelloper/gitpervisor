# 태스크 10 — 파이썬 아웃라인 (DocumentSymbolProvider)

> 상태: 설계(Design) · 대상: gitpervisor · 산출물 성격: 아키텍처/계약/단계/위험 (구현은 후속)
> 근거: 코드 실측 2026-07-06 · 관련: [09-quick-open.md](09-quick-open.md)(QuickPick 프리미티브 — 본 태스크는 **비의존**, §3.4 참조)

## 1. 요구사항

파이썬 파일의 `def`/`class` 구조 트리를 Monaco `DocumentSymbolProvider`로 제공한다.
provider **하나를 등록하면** 다음 세 기능이 코드 추가 없이 살아난다(전부 아웃라인 모델 소비자 — §2 실측):

- **스티키 스크롤 정확도**: 현재 파이썬은 들여쓰기 추정 모델로 폴백 중 → 심볼 기반으로 교정.
- **구조 팝업** (`mod+Shift+O`): Monaco 내장 quickOutline(퍼지 검색·키보드 내비·심볼 아이콘) 활성화. 현재는 provider 부재로 잠겨 있다.
- **diff 접힘 영역 브레드크럼**: 변경 없는 영역 접힘 바에 "그 안의 심볼 이름" 라벨 표시.

TS/JS는 워커가 이미 아웃라인을 제공하므로(§2.1) **파이썬만 공백**이다. 상단 브레드크럼 바(파일 경로 옆 심볼 내비)는 standalone Monaco에 없음을 실측으로 확정했다(§2.3) — 범위에서 제외.

## 2. 현황(근거)

### 2.1 TS/JS 아웃라인은 이미 켜져 있고, 파이썬은 provider가 없다
- `src/components/diff/monaco-setup.ts:47` `documentSymbols: true` — tsModeNoDefs(:44-58)는 definitions만 끄고 아웃라인은 유지. 실제 등록: `node_modules/monaco-editor/esm/vs/language/typescript/tsMode.js:157-161` `modeConfiguration.documentSymbols`가 true면 `registerDocumentSymbolProvider(..., new OutlineAdapter(worker))`. 어댑터는 TS 워커의 `getNavigationTree`를 DocumentSymbol 트리로 변환(`esm/vs/language/typescript/languageFeatures.js:696-722`).
- 파이썬은 Monarch 토크나이저만 패치되어 있다(`monaco-setup.ts:367-427` patchedPython — 삼중따옴표 상태 `:411-425`, def/class 이름 분류 `:383-384`). 심볼 provider는 어디에도 없다: `goto-definition.ts:219-222`는 Hover/Definition만 등록.

### 2.2 스티키 스크롤 — 기본 켜짐, 파이썬은 들여쓰기 폴백으로 동작 중
- 기본값: `esm/vs/editor/common/config/editorOptions.js:1361` `{ enabled: true, maxLineCount: 5, defaultModel: 'outlineModel', ... }` — 앱 소스에 `stickyScroll` 설정이 없어(grep 0건) `FILE_OPTIONS`(`DiffViewer.tsx:46-56`) 에디터에 기본값 그대로 적용 = **이미 켜져 있다**.
- 폴백 체인: `editorOptions.js:1379` "outline model이 없으면 folding provider model → indentation model" 문서화. 구현: `esm/vs/editor/contrib/stickyScroll/browser/stickyScrollModelProvider.js:47-57`(switch fall-through로 outline→syntaxFolding→indentation 후보 push) + `:80-96`(순서대로 첫 VALID 채택).
- 파이썬 언어 설정은 `folding: { offSide: true }`(`esm/vs/basic-languages/python/python.js:107-109`) — 구문 folding provider가 없으므로 현재 **indentation 모델**로 스티키가 그려진다(데코레이터·다중행 시그니처·빈 줄에서 경계 부정확).
- 갱신 디바운스는 소비자 측에 이미 있다: sticky `Delayer(300)`(`stickyScrollModelProvider.js:45`).

### 2.3 구조 팝업·브레드크럼 — Monaco 0.55 standalone 실측
- **quickOutline은 번들에 포함**: `esm/vs/editor/editor.main.js:156`이 `standaloneGotoSymbolQuickAccess.js`를 import. 액션 정의: `esm/vs/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js:44-67` — id `editor.action.quickOutline`(:45), **`EditorAction` 상속(:44) — Action2가 아니라서 goto 계열과 달리 `editor.getAction()`이 null이 아니다**. 기본 키 `CtrlCmd+Shift+KeyO`(:54, mac은 CtrlCmd=Cmd 자동), 발동 조건 `kbExpr: EditorContextKeys.focus`(:53).
- **precondition이 `hasDocumentSymbolProvider`(:51)** — 파이썬은 provider가 없어 지금은 액션이 잠겨 있고, provider 등록만으로 풀린다. 팝업 UI는 quickAccess 위젯(`esm/vs/platform/quickinput/browser/quickInputController.js:112` `.quick-input-widget`)이 에디터 컨테이너에 부착되며, 대상 에디터는 **포커스된 코드 에디터**다(`standaloneGotoSymbolQuickAccess.js:35-37` `getFocusedCodeEditor()`).
- **아웃라인 소비자 공용 캐시**: `esm/vs/editor/contrib/documentSymbols/browser/outlineModel.js:204` `LRUCache(15, 0.7)` + `:205` 디바운스 min 350ms + `:217-218` `versionId` 비교 — 같은 버전의 모델에 provider가 중복 호출되지 않게 Monaco가 이미 막아 준다.
- **diff 접힘 영역 브레드크럼도 번들에 포함**: `esm/vs/editor/contrib/diffEditorBreadcrumbs/browser/contribution.js:61-63`이 `HideUnchangedRegionsFeature.setBreadcrumbsSourceFactory`를 설정하고, `:46-54`가 접힘 범위에 걸친 심볼명을 라벨로 반환(내용 변경 100ms 디바운스 `:34`). 앱 diff 뷰는 `hideUnchangedRegions` 사용 중(`DiffViewer.tsx:63`, 기본 접힘 `src/stores/ui.ts:156`) — provider만 생기면 파이썬 diff의 접힘 바에 심볼명이 뜬다.
- **상단 브레드크럼 바는 없다**: `esm/vs/editor/contrib/` 59개 디렉터리 실측 — breadcrumbs 위젯 없음(diffEditorBreadcrumbs만 존재). VS Code workbench 전용 기능으로 standalone에 미포함 — 재구현은 범위 밖(§3.6).

### 2.4 등록 관례·키·E2E 기반
- provider 등록 관례: `goto-definition.ts:167-171` `registered` 플래그로 1회 등록(HMR·재마운트 방지), 대상 언어 배열 `LANGS`(:162-165), 뷰어 마운트 effect에서 호출(`DiffViewer.tsx:144-146`).
- API: `node_modules/monaco-editor/monaco.d.ts:6741` `registerDocumentSymbolProvider`, `:8057-8066` `DocumentSymbol`(name/detail/kind/range/selectionRange/children), `:8024-8051` `SymbolKind`(Class=4, Method=5, Constructor=8, Function=11), `:965` `editor.getEditors()`.
- 키 현황: `Ctrl+Shift+O`는 앱 미사용 — `KeyboardShortcuts.tsx` 실측(F5 `:50`, Ctrl+Shift+D/E/W `:60`, Ctrl+W `:83`, K/T/\` `:95-116`, GlobalShortcuts mod+Shift+A `:16`), 터미널 화이트리스트(`terminal-engine.ts:190-198`)에도 없음. `platform.ts:8-10` `isMod`, `:13` `modLabel`.
- 파서 입력 상한: 뷰어는 1.5MB 초과 파일을 표시하지 않는다(`DiffViewer.tsx:365-369`) — 파서가 다룰 최악 입력이 자연히 캡된다.
- E2E 기반: dev에서 `window.__monaco` 노출(`monaco-setup.ts:437-439`), `window.__gpv`로 스토어 구동(`tests/e2e/suites/14-frontend-dom.mjs:18,25-27`), 합성 keydown 디스패치 전례(`:71-73`), IPC 직접 검증 전례(`suites/10-codenav.mjs`). 스위트는 01~19 — 신규는 20번.

## 3. 설계

### 3.1 파서 방식 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **정규식+들여쓰기 라인 스캐너(프론트, 동기)** | **채택** | 파이썬은 오프사이드 규칙이라 스코프=들여쓰기 — `DocumentSymbol.range`의 끝줄 계산에 들여쓰기 분석이 **어차피 필수**다. 이름 추출은 `def`/`class` 줄 정규식 한 개면 충분. 의존성 0, 1.5MB 캡(§2.4) 내 라인 스캔은 수 ms~수십 ms 수준(단순 문자열 연산 — 수치는 구현 시 실측). |
| Monarch 토큰 재사용(`monaco.editor.tokenize`) | 기각 | Monarch는 **라인 단위 플랫 토큰 스트림** — 함수색/키워드색 분류만 있고 중첩·스코프·범위(끝줄) 정보가 없다(patchedPython의 def/class 규칙 `monaco-setup.ts:383-384`도 이름을 "색"으로만 표시). 끝줄은 결국 들여쓰기 분석이 필요해 토큰화는 이름 추출용 우회일 뿐이고, `tokenize`는 전체 재토큰화라 대형 파일에서 스캐너보다 느리다. 삼중따옴표 스킵 로직도 스캐너에 동일 개념으로 이식 가능(:411-425). |
| tree-sitter(WASM) 정식 파서 | 기각 | wasm 로딩·의존성 추가 대비 이득 없음 — 아웃라인은 def/class 헤더만 필요하고 표현식 파싱이 필요 없다. YAGNI. |
| 백엔드(Rust) 파싱 IPC | 기각 | 편집 중 내용이 프론트 모델에만 있어 매 갱신마다 파일 전문을 IPC로 왕복해야 한다 — WebView2 동시 invoke 유실 규약(lane·게이트)에 순수 CPU 경량 작업을 태울 이유가 없다. 오프라인 로컬 계산이 원칙. |
| Pyright/LSP 서버 | 기각 | 서버 설치·프로세스 수명 관리가 필요(외부 도구 러너는 15의 계약 — 아웃라인 하나에 과잉). 자동 바이너리 다운로드는 전 문서 공통 비채택. |

### 3.2 파서 동작 정의 (`src/components/diff/python-outline.ts` 신설)

한 번의 라인 순회로 심볼 트리를 만든다:

1. **스킵 상태**: 삼중따옴표 문자열(접두사 `[bBfFrRuU]{0,3}` 포함— patchedPython과 동일 개념) 안의 줄, `#` 주석 줄, 빈 줄은 매치 대상에서 제외. 같은 줄에서 열리고 닫히는 `"""x"""`는 상태 진입 없음.
2. **연속줄 가드**: 괄호 깊이(`(`/`[`/`{` − 닫힘)를 문자열 밖에서만 누적 — 깊이>0인 줄은 들여쓰기 판정(심볼 닫기)에 참여시키지 않는다. 다중행 `def foo(\n a,\n):` 시그니처가 심볼을 조기 종료시키는 것을 막는다.
3. **매치**: `^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)` / `^(\s*)class\s+([A-Za-z_]\w*)`. 데코레이터 줄(`@…`)은 심볼로 잡지 않고 통과(range는 def/class 줄부터 — VS Code는 데코레이터 포함이지만 스티키/팝업 착지에는 정의 줄이 더 유용, 단순화 채택).
4. **중첩**: (들여쓰기 폭, 심볼) 스택 — 새 심볼의 들여쓰기 ≤ 스택 top이면 pop(그 심볼들의 endLine 확정), 남은 top이 부모. 들여쓰기 폭은 탭=콘텐츠 관례상 스페이스 환산 없이 문자열 prefix 길이 비교(탭/스페이스 혼용 파일은 §6 위험).
5. **endLine**: "자기보다 들여쓰기가 같거나 얕은 다음 코드 줄"의 직전 줄, 트레일링 빈 줄 제외. EOF에서 스택 전체 flush.
6. **SymbolKind 매핑**(monaco.d.ts:8024-8051): `class`→Class(4) · 부모가 class인 `def`→Method(5), 그중 `__init__`→Constructor(8) · 그 외 `def`→Function(11). `selectionRange`=이름 토큰, `range`=정의 줄~endLine.
7. **캐시**: `model.uri.toString()+':'+model.getVersionId()` 키 1건(마지막 결과만). Monaco의 OutlineModelService가 상위에서 LRU+디바운스(§2.3)를 하므로 이 캐시는 sticky(300ms)·diff 브레드크럼(100ms)·quickOutline이 **다른 타이밍에 같은 버전을 조회**할 때의 중복 계산만 막으면 된다 — 자체 디바운스는 두지 않는다(소비자가 이미 함, §2.2·§2.3 실측).

### 3.3 등록 위치 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **`python-outline.ts` 신설 + `registerPythonOutline()` 1회 가드, DiffViewer effect에서 호출** | **채택** | goto-definition의 검증된 관례 미러(§2.4). 언어 기준 등록이라 뷰어 본 모델뿐 아니라 go-to-def 미리보기 모델(`gitpervisor-def` 스킴, `goto-definition.ts:88-104`)에도 자동 적용. |
| `goto-definition.ts`에 추가 | 기각 | 그 파일은 "백엔드 find_definition 브리지"가 책임 — 아웃라인은 순수 로컬 파싱으로 결이 다르다. 파일 분리가 후속(11 등) 재사용에도 유리. |
| `monaco-setup.ts`에 추가 | 기각 | setup은 로더·워커·테마·토크나이저(전역 1회 부트스트랩) — 기능 provider가 섞이면 파일이 비대해진다. 등록 시점도 뷰어 첫 마운트면 충분. |

### 3.4 구조 팝업 UI — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **Monaco 내장 quickOutline(quickAccess 위젯)** | **채택** | UI 코드 0줄 — provider 등록만으로 precondition(:51)이 풀려 활성화. 퍼지 매칭·키보드 내비·심볼 아이콘·선택 시 해당 범위 하이라이트/착지가 내장. 키도 이미 `CtrlCmd+Shift+O`(:54)로 우리 배정과 일치. `EditorAction`이라 `getAction()` 호출 가능(§2.3) — Action2 함정 없음. |
| 09 QuickPick 재사용 자체 팝업 | 기각 | 09는 앱 전역(파일 열기) 프리미티브 — 에디터 내부 심볼 착지·미리보기 하이라이트·range 스크롤은 내장 위젯이 이미 제공하므로 중복 구현이 된다. 시각 일관성 부족은 테마 colors 보정으로 완화(§6). 13(전 프로젝트 심볼 검색)과 달리 이 팝업은 "현재 에디터" 스코프라 에디터 부착형이 오히려 맞다. |

### 3.5 키 라우팅 — `mod+Shift+O`

- **에디터 포커스 중**: Monaco 내장 바인딩(`kbExpr: EditorContextKeys.focus`)이 그대로 처리 — 앱 코드 0줄.
- **뷰어는 보이지만 에디터 비포커스**(파일트리·헤더 클릭 직후): `KeyboardShortcuts.tsx`에 분기 1개 추가 — `isMod(e) && e.shiftKey && k === "o"` → `monaco.editor.getEditors()`(monaco.d.ts:965)에서 DOM에 부착된 에디터를 찾아 `ed.focus()` 후 `ed.getAction("editor.action.quickOutline")?.run()`. quickAccess는 포커스된 에디터를 대상으로 하므로(§2.3 `:35-37`) focus 선행이 필수. provider 없는 언어(rust 등)는 precondition이 막는다 — 조용히 무시(무해).
- **터미널 포커스 중**: 화이트리스트 통과 **비채택** — 터미널 탭이 활성인 상태에선 뷰어(아웃라인 대상)가 보이지 않아 의미가 없고, 키를 PTY에 그대로 둔다(기존 목록 `terminal-engine.ts:190-198` 불변).
- 충돌: 앱 내 미사용(§2.4). Chromium의 Ctrl+Shift+O(북마크 관리자)는 탭 UI 없는 WebView2에 없을 것으로 판단(검증 필요 — E2E에서 keydown 도달로 확인). mac Cmd+Shift+O 시스템 예약 없음(검증 필요).

### 3.6 범위 절단 (YAGNI)

- **v1**: 파이썬 파서+provider + 키 라우팅 분기 + (선택) 테마 quickInput 색 보정 + E2E.
- **하지 않는 것**: ① 상단 브레드크럼 바 재구현(standalone 미포함 실측 — 스티키 스크롤이 같은 정보의 90%를 대체), ② 사이드바 아웃라인 트리 패널(요구 없음), ③ 변수/모듈 상수 심볼(def/class만 — 팝업 노이즈 증가), ④ rust/go 등 타 언어 정규식 아웃라인(TS/JS는 워커가 이미 제공, 나머지는 요구 발생 시 같은 패턴으로 추가), ⑤ 워커 스레드 파싱(1.5MB 캡 + 소비자 디바운스로 불필요).

## 4. 계약(타입·커맨드·이벤트)

**백엔드 변경 없음** — Tauri 커맨드/이벤트/Rust 신규 0. 전부 프론트엔드. **신규 키: `mod+Shift+O`(구조 팝업 — Monaco 내장 바인딩과 동일 키라 별도 등록은 비포커스 폴백뿐).**

```ts
// src/components/diff/python-outline.ts (신설)
/** 파서 순수 함수 — provider와 분리 export(E2E가 직접 단언, §5.5). */
export interface PySymbol {
  name: string;
  kind: monaco.languages.SymbolKind;   // Class(4)|Method(5)|Constructor(8)|Function(11)
  startLine: number;                    // 1-based, def/class 줄
  nameColumn: number;                   // selectionRange용 이름 시작 열
  endLine: number;                      // 스코프 마지막 줄(§3.2-5)
  children: PySymbol[];
}
export function parsePythonSymbols(text: string): PySymbol[];

/** provider 1회 등록(goto-definition.ts:167 registered 가드 미러). "python"에만 등록. */
export function registerPythonOutline(): void;
// 내부: monaco.languages.registerDocumentSymbolProvider("python", {
//   displayName: "gitpervisor-python",
//   provideDocumentSymbols(model) { /* versionId 캐시 → parsePythonSymbols → DocumentSymbol[] 변환 */ },
// });
```

```ts
// src/components/diff/DiffViewer.tsx — 기존 effect(:144-146)에 1줄 병기
useEffect(() => { registerGotoDefinition(); registerPythonOutline(); }, []);
```

```ts
// src/components/KeyboardShortcuts.tsx — 비포커스 폴백(§3.5). 기존 if (!e.ctrlKey) 블록(:55)은
// mod 통일 이행 전이므로 이 분기는 isMod로 검사해 mac도 커버.
if (isMod(e) && e.shiftKey && !e.altKey && k === "o") {
  const ed = monaco.editor.getEditors().find((e) => e.getDomNode()?.isConnected);
  if (ed) { e.preventDefault(); ed.focus(); void ed.getAction("editor.action.quickOutline")?.run(); }
}
```

```ts
// dev 전용 노출(E2E) — monaco-setup.ts:437 __monaco 패턴 미러. release 미포함.
if (import.meta.env.DEV)
  (window as { __gpvPyOutline?: typeof parsePythonSymbols }).__gpvPyOutline = parsePythonSymbols;
```

## 5. 단계(구현 순서)

1. **파서** — `python-outline.ts` `parsePythonSymbols`: 삼중따옴표/주석 스킵 → 괄호 깊이 가드 → def/class 매치 → 들여쓰기 스택 → endLine 확정(§3.2). (~120 LOC)
2. **provider 등록** — DocumentSymbol 변환 + versionId 캐시 + `registerPythonOutline` 1회 가드, DiffViewer effect 1줄. (~40 LOC)
3. **키 라우팅** — KeyboardShortcuts에 `mod+Shift+O` 비포커스 폴백 분기(§3.5). (~10 LOC)
4. **테마 보정(선택)** — quickInput 위젯 색이 테마 6종과 어긋나면 `defineTheme` colors에 `quickInput.background`(색 id 실존: `esm/vs/platform/theme/common/colors/quickpickColors.js:11`) 등 4~6키 × 6테마 추가. (~30 LOC)
5. **E2E** — `tests/e2e/suites/20-python-outline.mjs` 신설(~100 LOC):
   - 픽스처에 중첩 `.py` 작성(`fix.writeFile` — 10-codenav.mjs 전례): 데코레이터 달린 클래스 + `__init__` + async 메서드 + 최상위 함수 + 독스트링 안의 가짜 `def`.
   - **파서 단위 단언**: `cdp.eval`로 `window.__gpvPyOutline(src)` 호출 — 트리 구조(클래스 자식에 메서드), kind 매핑, 독스트링 `def` 미검출, endLine 범위를 직접 검증.
   - **뷰어 통합**: `__gpv.ui.getState().selectDiff({mode:"file",path:...})`로 열고 → 에디터 포커스 후 `Ctrl+Shift+O` keydown 디스패치(14-frontend-dom.mjs:71 패턴) → `.quick-input-widget`(quickInputController.js:112) 출현·심볼명 행 존재 단언 → Escape로 닫기.
   - **스티키**: 긴 파일을 메서드 중간으로 `revealLine` 후 `.sticky-widget`(stickyScrollWidget.js:68) 내 텍스트에 클래스/메서드명 포함 단언.
   - 원상복구: 선택/탭 원복(14-frontend-dom.mjs 관례).

규모: **S~M(1~2일)** — 프론트 ~200 LOC + E2E ~100 LOC. 백엔드 0. 파서 엣지케이스 검증이 변수.

## 6. 위험과 완화

| 위험 | 설명 | 완화 |
|---|---|---|
| 정규식 파서 오탐/누락 | 한 줄 `if x: def`류는 없지만(문법 불가) 탭/스페이스 혼용 파일은 들여쓰기 폭 비교가 왜곡될 수 있고, 문자열 연결로 만든 코드 등 극단 케이스는 오차 존재 | 아웃라인은 내비게이션 보조 — 오차의 피해가 "심볼 하나 어긋남"에 그친다. 삼중따옴표·주석·괄호 깊이 가드(§3.2)로 흔한 케이스를 커버하고 엣지는 E2E 픽스처로 고정 |
| quickInput 위젯 테마 불일치 | 위젯은 에디터 테마 색을 쓰지만 우리 6종 테마는 quickInput 계열 색을 정의 안 함 — 기본 파생색이 튈 수 있다 | 단계 4에서 테마당 colors 4~6키 보정(색 id 실존 확인됨). 실제 어긋남 여부는 구현 중 육안+E2E 스크린샷으로 판정 |
| 위젯 클리핑 | quickAccess 위젯은 에디터 컨테이너에 부착(§2.3) — 뷰어 상위의 overflow/stacking 컨텍스트에 잘릴 가능성 | E2E에서 위젯 rect가 뷰포트 안인지 단언. 잘리면 에디터 옵션 `overflowWidgetsDomNode`류 재부착 검토(검증 필요) |
| WebView2 키 예약 | Ctrl+Shift+O가 WebView2 자체 액셀러레이터일 가능성(Chrome에선 북마크 관리자) — 북마크 UI가 없는 WebView2에선 미예약으로 추정(검증 필요) | E2E의 실 keydown 도달 검증으로 확정. 예약이면 `Ctrl+O` 계열 대체 검토 후 키 표 갱신 |
| diff 모드 착지 한계 | quickOutline은 포커스된 코드 에디터 기준 — side-by-side diff에서는 modified 쪽 에디터에 아웃라인이 뜨고 스티키는 각 pane 옵션에 따름(diff 에디터 내 세부 동작 검증 필요) | v1 보장 범위는 파일뷰(단일 Editor). diff 브레드크럼(§2.3)은 provider만으로 동작. diff 내 스티키/팝업은 E2E 관찰 후 문서화 |
| 대형 파일 재파싱 비용 | 수천~수만 줄 편집 중 keystroke마다 파싱 우려 | 소비자 디바운스 실측(sticky 300ms·breadcrumb 100ms·OutlineModelService min 350ms) + versionId 캐시(§3.2-7)로 버전당 최대 1회. 1.5MB 캡(§2.4)이 상한. 구현 시 10k줄 파일 파싱 시간 실측해 5ms↑면 상한 가드 추가 |
