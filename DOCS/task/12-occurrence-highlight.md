# 태스크 12 — 같은 심볼 하이라이트 (파이썬)

> 상태: 설계(Design) · 대상: gitpervisor · 산출물 성격: 아키텍처/계약/단계/위험 (구현은 후속)
> 근거: 코드 실측 2026-07-06 (정적 + 실행 중 dev 빌드 CDP 런타임 실측) · 관련: [03-themes.md](03-themes.md)(테마 색 정의 관례), [11-find-references.md](11-find-references.md)(레포 전체 참조 검색 — 본 태스크는 "현재 파일 내 음영"으로 상보적)

## 1. 요구사항

뷰어에서 커서를 올린 단어의 **같은 파일 내 사용처를 음영으로 표시**한다(occurrence highlight).
TS/JS는 내장 워커(documentHighlights)로 이미 동작하므로, 파이썬(및 워커 없는 언어)에서도 같은 경험을 보장한다.

- 파일뷰(편집 가능)와 diff뷰(readOnly) 양쪽에서 동작해야 한다.
- 별도 단축키 없음 — 커서 이동만으로 발동/해제되는 수동적(passive) 기능.
- 대형 파일(뷰어 상한 1.5MB)에서도 입력 지연을 만들지 않아야 한다.

## 2. 현황(근거)

### 2.1 핵심 실측 — 전제 수정: 파이썬 하이라이트는 **이미 동작한다**

발주 전제("파이썬만 provider 부재")는 monaco 0.55(`package.json:37` `"monaco-editor": "^0.55.1"`) 기준 사실이 아니다. monaco 0.55는 **모든 언어(`'*'`)에 등록되는 텍스트 기반 폴백 provider를 내장**한다:

- `node_modules/monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/textualHighlightProvider.js:20-41` `TextualDocumentHighlightProvider` — selector `{ language: '*' }`(`:22`), 구현은 `model.findMatches(word.word, true, false, true, USUAL_WORD_SEPARATORS, false)`(`:36`) 즉 **단어 경계·대소문자 일치 텍스트 검색**, 결과 kind는 전부 `DocumentHighlightKind.Text`(`:39`).
- 등록: `textualHighlightProvider.js:70-71`(document/multiDocument 두 레지스트리에 `'*'`로), feature 선언: `wordHighlighter.js:794` `registerEditorFeature(TextualMultiDocumentHighlightFeature)`, standalone(=우리 번들) 인스턴스화: `standaloneServices.js:757-760`(초기화 시 등록된 editor feature 전부 createInstance).

**런타임 실측(2026-07-06, 실행 중 dev 빌드에 CDP 접속 — `window.__monaco`로 python 모델/에디터 생성 후 데코레이션 판독):**

| 시나리오 | 결과 |
|---|---|
| python 모델, 커서를 `foo`(4회 등장) 위에 | `wordHighlightText` 데코 **8개 = 4위치 × 2중복** — 동작 확인 |
| `readOnly: true` 에디터(diff뷰 조건) | 동일 동작(8개) — readOnly 무관 |
| 커서를 `return`(키워드, 2회) 위에 | 4개 = 2위치 × 2 — **키워드도 음영**(텍스트 폴백 특성) |
| `getOption(occurrencesHighlight)` / `(…Delay)` | `'singleFile'` / `0` |
| CSS 변수 `--vscode-editor-wordHighlightTextBackground` | `rgba(87,87,87,0.72)` = 기본 회색 `#575757B8` |

따라서 이 태스크의 실체는 "provider 신규 구현"이 아니라 **① 동작의 회귀 고정(E2E) ② 테마 6종 음영 색 정의 ③ 내장 동작의 한계 수용 여부 판정**이다.

### 2.2 옵션 기본값 — 앱은 아무것도 끄지 않았다
- `occurrencesHighlight` 기본값 `'singleFile'`: `esm/vs/editor/common/config/editorOptions.js:3232`. `occurrencesHighlightDelay` 기본 `0`: `:3240`. (참고: `selectionHighlight` 기본 true — `:3304` — 는 "선택 영역과 유사한 매치" 음영으로 본 기능과 별개.)
- 뷰어 에디터 옵션에 `occurrencesHighlight` 미설정 → 기본값 그대로 적용: `src/components/diff/DiffViewer.tsx:46-56` `FILE_OPTIONS`, `:58-73` `DIFF_OPTIONS`(readOnly diff뷰 포함).
- TS/JS의 시맨틱 하이라이트는 워커 경유로 유지 중: `src/components/diff/monaco-setup.ts:50` `documentHighlights: true`(tsModeNoDefs — definitions만 끈 교체 설정, `:74-75` 적용).

### 2.3 provider 선택 규칙 — 커스텀 등록은 내장을 "가린다"(병합 아님)
- `wordHighlighter.js:41-57` `getOccurrencesAtPosition`: 레지스트리를 **점수순으로 순회해 첫 비-null 응답에서 멈춘다**(`:46` 주석 — 빈 배열도 유효 결과로 간주, 다음 provider로 폴백하지 않음). 특정 언어 selector는 `'*'`보다 점수가 높으므로, python에 커스텀 provider를 등록하면 내장 폴백을 대체하게 된다 — 즉 커스텀 등록의 가치는 "내장과 다른 동작(토큰 필터링 등)"을 넣을 때만 발생한다.
- goto-definition의 `LANGS` 14종(`src/components/diff/goto-definition.ts:162-165`)은 hover/definition 전용 등록 범위다. occurrence highlight는 `'*'` 폴백이라 `languageOf`(`src/lib/language-map.ts:52-58`)가 배정하는 모든 언어(plaintext 포함)를 이미 커버한다 — "등록 언어 범위" 질문 자체가 소멸.

### 2.4 성능 상한 — 내장 캡 999 + 뷰어 1.5MB 상한으로 이미 유계
- `findMatches`의 기본 결과 캡: `esm/vs/editor/common/model/textModel.js:76` `LIMIT_FIND_COUNT = 999`, `:828`에서 기본 인자로 사용 — 내장 폴백(`textualHighlightProvider.js:36`)은 캡 인자를 안 넘기므로 999가 적용된다.
- 런타임 실측(1.5MB·29,413줄 python 모델, 단어 88,236회 등장): 기본 호출(캡 999) **0.9ms**, 캡 해제 시 25.8ms. 커서 이동은 50ms Delayer(`wordHighlighter.js:151`)로 묶이므로 체감 비용 없음.
- 뷰어는 1.5MB 초과 파일을 아예 렌더하지 않는다: `DiffViewer.tsx:365-370`("1.5MB를 초과하는 파일은 표시하지 않습니다") — 최악 입력이 위 실측 케이스로 유계.

### 2.5 스타일 현황 — 전 테마가 기본 회색에 의존 + 업스트림 이중 데코
- 색 토큰 기본값: `esm/vs/editor/contrib/wordHighlighter/browser/highlightDecorations.js:23` `editor.wordHighlightBackground`(dark `#575757B8` / light `#57575740`), `:24` `…StrongBackground`(쓰기 접근 — dark `#004972B8`), `:25` `…TextBackground`(텍스트 폴백용 — wordHighlightBackground로 폴백). 적용 CSS: `highlightDecorations.css:16,25,34`.
- kind→클래스 매핑: `highlightDecorations.js:45-57` Text→`wordHighlightText`, `:32-44` Write→`wordHighlightStrong`, `:76-79` Read→`wordHighlight`.
- 우리 테마 6종(`monaco-setup.ts` defineTheme colors 블록 — darcula `:115-129`, monokai `:154-170`, dracula `:196-211`, nord `:238-253`, light `:279-295`, solarized-light `:321-336`)에는 `editor.wordHighlight*` 키가 **하나도 없다** → 전부 기본 회색으로 렌더(§2.1 런타임 CSS 변수 실측과 일치). 테마 메타 레지스트리는 `src/lib/themes.ts:72-117`.
- **업스트림 이중 데코**: `wordHighlighter.js:636-643` `renderDecorations()`가 같은 하이라이트를 `deltaDecorations`(`:638`, static `storedDecorationIDs` 추적)와 `decorations.set`(`:642`, 에디터 데코 컬렉션)으로 **두 번** 적용한다 — §2.1의 "×2 중복" 원인. 반투명 색이 두 겹 쌓여 실효 알파가 커진다(기본 0.72 → 실효 1-(1-0.72)² ≈ 0.92, 거의 불투명). 언어 무관(TS도 동일)한 기존 렌더 특성이다.

### 2.6 E2E 인프라
- dev 빌드에서 `window.__monaco` 노출: `monaco-setup.ts:437-439` — 본 실측이 사용한 경로 그대로 E2E에서 재사용 가능.
- 스위트 등록은 명시 목록: `tests/e2e/run.mjs:14-34`(현재 19-themes까지 — `:33`). 스위트 형태 전례: `tests/e2e/suites/10-codenav.mjs:2-4`(`export const name` + `run({ cdp, report, fix })`). 페이지 평가는 `tests/e2e/lib/cdp.mjs:69-80` `eval()`.

## 3. 설계

### 3.1 provider 전략 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **내장 텍스트 폴백 수용(코드 0줄) + E2E 고정 + 테마 색 정의** | **채택** | §2.1 런타임 실측으로 파일뷰·diff뷰 모두 이미 동작. 캡 999(§2.4)·단어 경계·대소문자 일치 등 브리프가 요구한 설계 요소가 전부 내장돼 있음. 우리가 짤 코드와 기능이 동일한 재구현은 순수 낭비. |
| python 전용 커스텀 DocumentHighlightProvider(`findMatches` 기반) | 기각 | §2.3 — 등록하면 내장을 가리는데 동작은 같다(같은 findMatches 호출을 우리 손으로 반복). 내장과 "다르게" 만들 이유(토큰 필터링)는 3.2에서 별도 기각. |
| 워커 없는 모든 언어 공통 커스텀 provider(goto-definition LANGS 방식) | 기각 | 내장이 이미 `'*'`라 커버 범위조차 못 넓힌다(§2.3). 언어 목록 유지보수만 추가. |
| `occurrencesHighlight: 'multiFile'` 승격 | 기각 | 옵션 설명부터 Experimental(`editorOptions.js:3236`). 뷰어는 단일 에디터(파일 탭 전환식)라 다중 파일 동시 음영의 수혜 화면이 없음. |

### 3.2 읽기/쓰기 구분(kind)·토큰 필터링 — YAGNI 기각

| 후보 | 판정 | 근거 |
|---|---|---|
| 읽기/쓰기 kind 구분(Read/Write 음영 차등) | 기각 | 텍스트 검색으로는 대입 좌변/우변 판별이 불가능(정적 분석 필요 — LSP 급 작업). 내장 폴백도 전부 `Text` kind(`textualHighlightProvider.js:39`). TS 워커만 kind를 구분하며 그쪽은 이미 동작 — 파이썬에서 억지로 흉내내면 오판별이 더 해롭다. |
| 키워드/주석/문자열 내 매치 제외(Monarch 토큰 조회 필터) | 기각 | 커서가 키워드 위일 때도 음영되는 것(§2.1 실측)은 VS Code의 plaintext/텍스트 폴백과 동일한 표준 동작이고 실해가 없다(커서를 키워드에 두는 일 자체가 드묾). 필터를 넣으려면 커스텀 provider 등록이 필요해져 3.1 채택안이 무너진다 — 토큰 조회 비용 이전에 구조 비용으로 기각. 사용자 불만이 실재하면 후속. |
| `occurrencesHighlight` on/off 설정 노출 | 기각 | 현재 설정 다이얼로그에 에디터 동작 토글 카테고리가 없고 요구도 없음. |

### 3.3 테마 6종 음영 색 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **6종 테마에 `editor.wordHighlightBackground`·`…TextBackground`·`…StrongBackground` 명시 정의** | **채택** | 실측상 전 테마가 기본 회색 `#575757B8`인데(§2.5), 이중 데코(§2.5)로 실효 알파 ≈0.92 — 거의 불투명한 회색 상자가 구문색·선택색을 가린다. 특히 라이트 2종·solarized의 크림 배경에서 회색은 팔레트 이물. 테마당 3키 추가로 각 팔레트에 조화시키고, 알파를 "두 겹 중첩 후 실효 0.4~0.5"가 되도록 낮게 잡는다(단일 알파 20~30%). |
| 기본값 수용(정의 생략) | 기각 | 동작은 하지만 위 실효-불투명 문제와 테마 정합성 문제. 태스크의 남은 실질 가치가 바로 이 튜닝이다. |
| 이중 데코 자체를 패치(업스트림 동작 수정) | 기각 | monaco 내부(`wordHighlighter.js:636-643`) 몽키패치는 업그레이드마다 깨질 위험 > 이득. 색 알파 설계로 흡수 가능. |

**제안 값** (구현 시 실기 스크린샷 대비로 미세 조정 — 외부 테마 관례색은 로컬 소스로 확정 불가라 전부 "(검증 필요)"):

| 테마 | wordHighlightBackground(=Text 폴백) | StrongBackground(쓰기 — TS만 발동) | 근거 |
|---|---|---|---|
| gitpervisor-dark | `#34413466` | `#40332B66` | IntelliJ Darcula "identifier under caret" 관례색(검증 필요)의 저알파화 |
| gitpervisor-monokai | `#1C3F6866` | `#25517F66` | 자기 선택색(`monaco-setup.ts:161` `#1C3F68`) 계열 저알파 |
| gitpervisor-dracula | `#8BE9FD30` | `#BD93F930` | Dracula 공식 VS Code 테마의 wordHighlight 색 계열(검증 필요) |
| gitpervisor-nord | `#81A1C133` | `#81A1C14D` | Nord 공식 VS Code 포트 관례(검증 필요) |
| gitpervisor-light | `#3574F01A` | `#3574F02E` | 앱 accent(`themes.ts:106` `#3574f0`) 저알파 — 선택색 `#D4E2FF`(`monaco-setup.ts:286`)보다 옅게 |
| gitpervisor-solarized-light | `#B5890026` | `#CB4B1626` | Solarized yellow/orange 저알파 — 크림 배경(`#FDF6E3`) 위 회색 회피 |

원칙: **선택(selection)보다 옅고, lineHighlight보다 진하게** — 세 음영이 겹쳐도 층이 구분되게. `wordHighlightTextBackground`는 `wordHighlightBackground`로 폴백되므로(`highlightDecorations.js:25`) 별도 키는 생략(2키/테마도 가능하나 Strong 포함 3키 명시가 의도를 문서화).

### 3.4 범위 절단 (YAGNI)
- **v1**: 테마 6종 색 정의 + E2E 회귀 고정. 신규 코드 경로 0.
- **후속(요구 발생 시)**: ① 키워드/문자열 필터링 커스텀 provider(3.2), ② `editor.selectionHighlightBackground` 테마 튜닝(별개 토큰 — 본 태스크 범위 밖), ③ monaco 업그레이드로 내장 폴백이 사라질 경우 `textualHighlightProvider.js:24-41` 로직(~20줄)을 우리 provider로 복제 등록(§6 완화 경로).

## 4. 계약(타입·커맨드·이벤트)

**백엔드 변경 없음** — Tauri 커맨드/이벤트/Rust 신규 0. **신규 단축키 없음**(커서 이동으로 발동 — 기존 키맵과 충돌 불가). **신규 IPC 없음**(교차 계약의 grep류 IPC 관례 해당 없음).

```ts
// src/components/diff/monaco-setup.ts — 6개 defineTheme의 colors 블록에 각 3키 추가.
// 값은 §3.3 표. 예시(gitpervisor-dark, :115-129 블록):
colors: {
  // …기존 키 유지…
  "editor.wordHighlightBackground": "#34413466",       // 읽기(Read) — TS 워커 결과
  "editor.wordHighlightStrongBackground": "#40332B66", // 쓰기(Write) — TS 워커 결과
  "editor.wordHighlightTextBackground": "#34413466",   // 텍스트 폴백(파이썬 등) — Text kind
}
```

```js
// tests/e2e/suites/20-occurrence-highlight.mjs (신설) — run.mjs:14-34 목록에 등록.
// 10-codenav.mjs:2-4 형태(export const name / run({ cdp, report })). 픽스처 불필요(순수 프론트).
export const name = "같은 심볼 하이라이트 (occurrence highlight)";
// cdp.eval + window.__monaco(dev 노출, monaco-setup.ts:437-439)로:
//  1) python 모델·오프스크린 에디터 생성 → 커서를 4회 등장 심볼 위에 → 500ms 내
//     className /wordHighlight/ 데코가 서로 다른 range 4곳에 존재(개수 8 하드코딩 금지 — §6 중복 데코)
//  2) readOnly: true 에디터에서 1) 반복(diff뷰 회귀)
//  3) getComputedStyle의 --vscode-editor-wordHighlightTextBackground 가
//     기본 회색 rgba(87,87,87,…)이 아님(테마 색 반영 확인) — 테마 전환 1회 포함(19-themes 전례)
```

## 5. 단계(구현 순서)

1. **테마 색 6종 정의** — `monaco-setup.ts` 각 colors 블록에 3키 × 6테마(§3.3 표). 실기에서 python/TS 파일을 열어 6테마 × {커서 단어 음영, 드래그 선택, lineHighlight} 3층 대비를 육안 확인·조정. (~18 LOC)
2. **E2E 스위트 신설** — `tests/e2e/suites/20-occurrence-highlight.mjs` + `run.mjs` 등록 1줄(§4 계약의 3검증). 내장 폴백 소실(monaco 업그레이드)을 즉시 감지하는 회귀 앵커가 목적. (~70 LOC)
3. **문서 반영** — 00-INDEX 갱신. 후속 아이디어(키워드 필터·selectionHighlight 튜닝)는 §3.4에 남긴 대로 미착수.

규모: **S**(반나절 미만 — 사실상 색 튜닝 + 테스트). 백엔드 0, 신규 런타임 코드 경로 0.

## 6. 위험과 완화

| 위험 | 설명 | 완화 |
|---|---|---|
| monaco 업그레이드로 내장 폴백 소실/변경 | 기능이 우리 코드가 아닌 `TextualMultiDocumentHighlightFeature`(0.55 내장)에 의존 — 향후 버전에서 제거·동작 변경되면 파이썬 음영이 조용히 사라진다 | E2E(단계 2)가 업그레이드 시 즉시 실패 → 그때 `textualHighlightProvider.js:24-41` 동작을 복제한 자체 provider(~20줄)를 등록하는 폴백 경로를 §3.4에 예약 |
| 이중 데코 알파 중첩 | `wordHighlighter.js:636-643`이 같은 음영을 2회 적용(런타임 ×2 실측) — 색 설계는 "두 겹 실효 알파" 기준인데, 업스트림이 이를 수정하면 음영이 갑자기 옅어진다 | 단일 겹에서도 식별 가능한 하한(알파 ≥ 0x1A)으로 설계. E2E는 데코 존재만 검증하고 개수·색 강도를 고정하지 않음 |
| 키워드·문자열 내 매치 음영 | 텍스트 폴백 특성상 `return` 같은 키워드, 문자열/주석 속 동일 단어도 음영(§2.1 실측) — 시맨틱 기대와 어긋난다는 피드백 가능 | VS Code plaintext와 동일한 표준 동작으로 수용(§3.2). 불만 실재 시 Monarch 토큰 필터 provider 후속 |
| 색 튜닝의 주관성 | §3.3 제안값 중 외부 테마 관례색(Darcula/Dracula/Nord)은 미검증 — 실기에서 이질감 가능 | 단계 1에 6테마 육안 확인을 명시. 원칙(선택보다 옅고 lineHighlight보다 진하게)만 불변으로 두고 값은 조정 가능으로 취급 |
| 진짜 요구가 "시맨틱" 하이라이트였을 가능성 | 발주 의도가 스코프 인지(같은 변수만, 문자열 내 제외)라면 본 채택안은 미달 | 요구사항(§1)을 "사용처 음영"으로 정의하고 시맨틱 구분은 kind 기각(§3.2)에 명시 — 발주자 확인 질문으로 개방(요약의 openQuestions) |
