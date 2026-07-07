# 태스크 14 — 호버 독스트링/JSDoc (Quick Documentation)

> 상태: 설계(Design) · 대상: gitpervisor · 산출물 성격: 아키텍처/계약/단계/위험 (구현은 후속)
> 근거: 코드 실측 2026-07-06 · 관련: 독립 태스크(기존 find_definition/goto-definition 인프라의 확장 — 신규 커맨드·신규 키 없음)

## 1. 요구사항

뷰어의 호버/Ctrl+호버 시그니처 툴팁에 **정의의 문서 블록**을 함께 보여준다 — PyCharm Quick Documentation의 경량판.

- 파이썬: `def`/`class` 정의줄 아래의 독스트링(`"""`/`'''` 블록).
- TS/JS: 정의 위의 `/** … */` JSDoc 블록.
- 러스트: 정의 위의 `///` 독 코멘트 연속.
- 툴팁 구성: **코드블록(시그니처) + 본문(문서) + 힌트줄(이동 안내)** — 문서가 없으면 지금과 동일.
- 길이 상한 필수(장문 독스트링이 툴팁을 점령하지 않게), 독스트링 안의 마크다운 문자(`` ` ``, `*` 등)가 렌더를 깨지 않게.
- 다중 후보 시 첫 후보의 문서만(기존 호버 관례 유지).

## 2. 현황(근거)

### 2.1 백엔드 — 시그니처는 이미 추출하지만 문서는 버린다
- `src-tauri/src/commands/tree.rs:351-358` `DefMatch { path, line, column, signature }` — 문서 필드 없음. `#[serde(rename_all = "camelCase")]`.
- `tree.rs:363-457` `find_definition`: 심볼 검증(`:372-377`), git grep -P + 확장자 pathspec(`:388-401`), 매치당 `extract_signature(&repo, &rel, line_no, text)` 호출(`:432`), 결과 12건 캡(`:446-448`), 모듈 파일 폴백(`:454-456`, 그 안에서도 `extract_signature(repo, &rel, 1, &rel)` — `:509`).
- `tree.rs:591-635` `extract_signature`: **파일 전체를 이미 읽는다**(`:592` `std::fs::read_to_string`) — 위로 데코레이터/속성(`@`·`#[`) 연속 수집(`:604-615`), 아래로 `:`/`{`/`;`/`}` 종결 또는 8줄까지(`:617-628`), 1200자 캡+`…`(`:630-634`). **즉 독스트링(파이썬: 종결 `:` 직후 줄들)과 JSDoc/`///`(데코레이터 스캔이 멈춘 지점 위)이 이미 메모리에 있는데 반환하지 않는 것뿐이다.**
- 커맨드 등록: `src-tauri/src/lib.rs:302` `commands::find_definition`. git 타임아웃은 `src-tauri/src/git/runner.rs:9` `READ_TIMEOUT_SECS = 10`.

### 2.2 프론트 — HoverProvider 마크다운 구성
- `src/components/diff/goto-definition.ts:173-198` HoverProvider: 첫 후보만 사용(`:179` `matches[0]`), `contents`는 2개 엔트리 — 코드블록(`:193` `"```" + lang + "\n" + m.signature + "\n```"` — **고정 3-백틱 펜스**)과 힌트줄(`:181-184`, 다중 후보 수 표기 유지). 이 2-엔트리 세로 스택 렌더는 현행 동작으로 검증돼 있다.
- `src/lib/ipc.ts:83-88` `DefMatch` TS 인터페이스(path/line/column/signature) — `:680-685` `findDefinition`(lane 지원).
- 컨텍스트 주입: `src/components/diff/DiffViewer.tsx:144-149`(registerGotoDefinition + setDefContext), 임포트 예열 `:153-158`(warmDefinitionCache, background lane — goto-definition.ts:51-78).

### 2.3 캐시·미리보기 모델 — doc 추가의 파급 없음
- 심볼 캐시: `goto-definition.ts:29` `Map<string, Promise<DefMatch[]>>`, 키는 `projectId:ext:symbol`(`:35`), 상한 800(`:40`) — **DefMatch 배열째 저장하므로 doc 필드는 자동으로 실려 다닌다. 키·상한 변경 불요.**
- 미리보기 모델: `goto-definition.ts:88-104` `ensurePreviewModel`은 `m.path`만 사용(FIFO 40 — `:97`). DefinitionProvider(`:200-217`)는 path/line/column만 사용(`:209-215`). **둘 다 doc 무관.**

### 2.4 Monaco 마크다운 렌더 사실(로컬 소스 실측, monaco-editor 0.55)
- `node_modules/monaco-editor/monaco.d.ts:472-481` `IMarkdownString`: `isTrusted`/`supportHtml`은 opt-in — 기본은 비신뢰. `monaco.d.ts:7179-7183` `Hover.contents: IMarkdownString[]`.
- 렌더 산출물은 항상 새니타이즈된다: `esm/vs/base/browser/markdownRenderer.js:15`(domSanitize), `:313`("we always pass the output through dompurify"), `:428` `sanitizeRenderedMarkdown` — **독스트링 속 HTML은 보안 위협이 아니라 레이아웃 문제일 뿐이다.**
- 이스케이프 참조 구현이 monaco 내부에 있다: `esm/vs/base/common/htmlContent.js:108-111` `escapeMarkdownSyntaxTokens`(`/[\\`*_{}[\]()#+\-!~]/g` 백슬래시 이스케이프), `:115-125` `appendEscapedMarkdownCodeBlockFence`(코드 속 최장 백틱 런+1로 펜스 연장, 최소 3) — 둘 다 esm 딥 경로에서만 export(`:164`), 공개 `monaco` 네임스페이스엔 없음.

### 2.5 E2E 전례
- `tests/e2e/suites/10-codenav.mjs:6-15` 픽스처에 정의 파일 작성(`fix.writeFile`, untracked여도 `--untracked`가 잡음), `:18-22` `cdp.invoke("find_definition", …)`로 signature 내용까지 검증하는 전례.

## 3. 설계

### 3.1 문서 전달 방식 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **`DefMatch.doc: Option<String>` 필드 신설** | **채택** | 호버 렌더가 코드블록(시그니처)과 본문(문서)을 **다른 마크다운 엔트리**로 조립해야 한다(§2.2) — 합쳐진 문자열이면 프론트가 다시 쪼개야 함. 캐시·미리보기·DefinitionProvider 전부 무영향(§2.3). serde `Option`이라 문서 없는 매치는 페이로드 증가 0. |
| `signature`에 문서를 이어붙임 | 기각 | 코드블록 안에 문서가 들어가 모노스페이스+구문색이 잘못 입혀지고 줄바꿈이 코드로 렌더된다. 분리 렌더 불가. 기존 signature 소비처(E2E `:22` 정규식 검사 등)의 의미가 바뀐다. |
| 별도 `get_doc` IPC 커맨드 | 기각 | 호버당 invoke 2회(WebView2 동시 invoke 규약상 슬롯 낭비) + 백엔드가 같은 파일을 두 번 읽는다 — `extract_signature`가 이미 전체 내용을 갖고 있다(§2.1). 커맨드·등록·ipc 표면 증가도 과잉. |

### 3.2 백엔드 추출 위치 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **`extract_signature` → `extract_sig_doc`로 확장(반환 `(String, Option<String>)`)** | **채택** | 파일 read 1회 재사용(§2.1). 데코레이터 스캔의 상단 인덱스(`i`)와 시그니처 종결 인덱스(`j`)가 함수 안에 이미 있어 — 위(JSDoc/`///`)·아래(독스트링) 스캔의 출발점을 공짜로 얻는다. 호출부 2곳(`:432`, `:509`)만 수정. 언어는 `rel` 확장자로 판별(파라미터 추가 불요). |
| 별도 `extract_doc` 함수(재읽기) | 기각 | 같은 파일 IO 2회 — 큰 소스 파일에서 낭비. `j`(시그니처 끝) 재계산 중복. |
| 프론트에서 파싱(미리보기 모델 내용 활용) | 기각 | 호버 시점엔 대상 파일 내용이 프론트에 없다(미리보기 모델은 Ctrl+호버 DefinitionProvider에서야 생성 — `:209`). 호버만으로 `getDiff`를 부르는 건 3.1의 별도 커맨드안과 같은 낭비. |

**언어별 추출 규칙** (모두 `rel` 확장자 기준 디스패치):

| 언어 | 방향 | 규칙 |
|---|---|---|
| `.py`/`.pyi` | 아래 | 시그니처 하강 루프가 **`:` 종결로 끝난 경우에만**(8줄 캡 소진이면 스킵 — 시그니처 미완결) `j+1`부터 공백줄 ≤1개 건너뛰고, `"""`/`'''`(옵션 `r`/`u`/`b` 접두 허용)로 시작하는 줄부터 닫는 델리미터까지 수집. 한 줄 독스트링(여는 줄에 닫힘 포함) 지원. 델리미터 제거+공통 들여쓰기 제거. |
| `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` | 위 | 데코레이터 스캔 상단 `i`의 **바로 윗줄**이 `*/`로 끝나면 위로 `/**` 시작줄까지 수집(사이 공백줄 불허 — 무관 주석 오귀속 방지). `/**`·`*/`·행두 `*` 마커 제거. |
| `.rs` | 위 | `i`의 바로 윗줄부터 `///`로 시작하는 연속 줄 수집(속성 `#[…]`은 기존 스캔이 이미 `i` 위로 올려둠 — `:607`). `///` 마커 제거. |
| 그 외 | — | `None` (v1 범위 밖 — §3.5). |

공통 상한: **12줄 / 800자**(초과 시 `…` — signature의 1200자 캡(`:630-634`) 미러).

### 3.3 문서 본문 렌더링 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **이스케이프된 플레인 텍스트**(마크다운 토큰 백슬래시 이스케이프 + `  \n` 하드 줄바꿈) | **채택** | 독스트링은 마크다운이 아니다(파이썬 reST/Google style, JSDoc 태그) — 원문 렌더 시 `*args*`가 이탤릭으로, 백틱이 인라인 코드로 오렌더. 이스케이프하면 원문 그대로 보인다. 새니타이즈는 Monaco가 보장(§2.4)하므로 이스케이프는 보안이 아닌 **레이아웃 정확성** 목적. |
| 마크다운 원문 렌더 | 기각 | rustdoc(`///`)만 마크다운 관례 — 언어별 분기해도 파이썬/JSDoc 오렌더 문제가 남는다. 경량판 목표에 과잉. |
| 코드블록으로 감쌈 | 기각 | 모노스페이스+줄바꿈 없음(가로 스크롤)으로 산문 가독성 최악. 시그니처 블록과 시각 구분도 사라짐. |

**이스케이프 헬퍼 소스** — 대안 비교:

| 대안 | 판정 | 근거 |
|---|---|---|
| **로컬 미러 헬퍼(~5 LOC)** — `escapeMarkdownSyntaxTokens`(§2.4)와 같은 정규식 | **채택** | 정규식 1줄짜리 — 딥 임포트로 얻는 이득이 없다. monaco 버전업 시 내부 경로 변동 리스크 0. |
| `monaco-editor/esm/vs/base/common/htmlContent.js` 딥 임포트 | 기각 | export는 확인됨(`:164`)이나 내부 경로는 semver 보장이 없다. 딥 임포트 전례(monaco-setup.ts:6-11)는 대안이 없는 경우(문법 객체·워커)에 한정. |

**펜스 하드닝(동반 수정)**: 시그니처 코드블록의 고정 3-백틱 펜스(`goto-definition.ts:193`)는 시그니처에 ``` 가 포함되면 깨진다 — `appendEscapedMarkdownCodeBlockFence`(§2.4)의 규칙(최장 백틱 런+1, 최소 3)을 로컬 미러로 적용. 발생 빈도는 낮지만 doc 작업과 같은 함수를 만지므로 함께 처리.

### 3.4 호버 조립(변경 후)
- `contents`: `[코드블록(시그니처), (m.doc 있을 때만) 본문, 힌트줄]` — 힌트줄은 항상 마지막(현행 위치 유지, `:181-184` 문구 불변).
- 첫 후보만(`matches[0]`, `:179`) — 다중 후보 문서 병합 없음(기존 관례).
- 본문 변환: `escapeMd(m.doc)` 후 `\n` → `  \n`(마크다운 하드 브레이크로 원문 줄 구조 보존).

### 3.5 범위 절단 (YAGNI)
- **v1**: py/pyi 독스트링 + ts/js 계열 JSDoc + rs `///`, 첫 후보만, 12줄/800자 캡, 이스케이프 플레인 렌더.
- **비채택/후속**: ① 모듈 파일 폴백(`:509`)의 모듈 독스트링 — 폴백 시그니처가 이미 파일 첫 8줄을 보여줘 독스트링이 코드블록에 노출됨, doc은 `None` 유지. ② go/java/ruby 등 추가 언어. ③ rustdoc 마크다운 렌더. ④ reST/Google/JSDoc 태그 구조화 파싱. ⑤ 전용 Quick Doc 팝업·단축키(PyCharm Ctrl+Q류) — 호버는 마우스 주도라 이 태스크에 키 배정 없음. ⑥ `canIncreaseVerbosity`(monaco.d.ts:7193) 활용한 "더 보기".

## 4. 계약(타입·커맨드·이벤트)

**신규 IPC 커맨드/이벤트/단축키 0** — 기존 `find_definition` 응답 확장 + 프론트 렌더 변경뿐.

```rust
// src-tauri/src/commands/tree.rs — DefMatch 확장 (기존 :351-358)
pub struct DefMatch {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub signature: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>, // 독스트링/JSDoc/`///` 정제 텍스트, 12줄·800자 캡. 없으면 필드 생략.
}

// extract_signature(:591) 대체 — 반환에 doc 추가. 언어는 rel 확장자로 판별.
// 호출부 2곳(:432, :509)만 수정. :509(모듈 폴백)는 doc를 버린다(None — §3.5 ①).
// [교차 노트 — tree.rs 동시 수정 조정] 태스크 13(13-symbol-search.md)의 find_symbols도
// 이 함수를 재사용한다 — 13 선행 시 호출부는 3곳이며 find_symbols는 signature(.0)만
// 사용(doc 무시)이라 개명·반환 확장의 파급은 튜플 언패킹 1곳 추가뿐. 같은 파일의
// def_query는 11(ext_globs 분리)·13(sym_pat 일반화)이 수정(권장 순서: 11 → 13) —
// 본 태스크와 함수 겹침은 없으나 tree.rs 병합 시 인지 필요.
fn extract_sig_doc(repo: &Path, rel: &str, line_no: u32, fallback: &str) -> (String, Option<String>);
```

```ts
// src/lib/ipc.ts — DefMatch(:83-88) 확장. findDefinition(:680-685) 시그니처 불변.
export interface DefMatch {
  path: string;
  line: number;
  column: number;
  signature: string;
  doc?: string; // 정의 문서 블록(정제 텍스트). 백엔드가 skip_serializing이라 없으면 undefined.
}
```

```ts
// src/components/diff/goto-definition.ts — 호버 조립(:192-196) 변경 + 헬퍼 2개 신설.
/** 마크다운 토큰 백슬래시 이스케이프 — htmlContent.js:108 미러(로컬 구현). */
function escapeMd(text: string): string; // text.replace(/[\\`*_{}[\]()#+\-!~]/g, "\\$&")
/** 코드블록 펜스 — 내용의 최장 백틱 런+1(최소 3)로 연장. htmlContent.js:115 미러. */
function fencedBlock(lang: string, code: string): string;
// contents 조립 규칙:
//   [ { value: fencedBlock(lang, m.signature) },
//     ...(m.doc ? [{ value: escapeMd(m.doc).replace(/\n/g, "  \n") }] : []),
//     { value: hint } ]
```

## 5. 단계(구현 순서)

1. **백엔드 `extract_sig_doc`** — 기존 함수 개명·확장: py 하강 독스트링 스캔(§3.2 규칙, `:` 종결 시에만), ts/js 상승 `/**…*/` 스캔, rs 상승 `///` 스캔, 마커 제거·들여쓰기 정리·12줄/800자 캡. 호출부 2곳 수정 + `DefMatch.doc` 필드. (~80 LOC)
2. **`ipc.ts` DefMatch 확장** — `doc?: string` 1줄.
3. **프론트 호버 조립** — `escapeMd`/`fencedBlock` 헬퍼 + `contents` 3-엔트리 조립(문서 없으면 현행과 동일 2-엔트리). (~20 LOC)
4. **E2E — `tests/e2e/suites/10-codenav.mjs` 확장** — 기존 픽스처 패턴(`:6-15`)으로:
   - `defs.py`(def+`"""` 독스트링, 한 줄 독스트링, 독스트링 없는 def), `defs2.ts`(JSDoc 있는/없는 export function), `defs.rs`(`///` 연속 + `#[derive]` 사이 케이스) 작성.
   - `cdp.invoke("find_definition", …)`로 ① doc에 원문 문구 포함, ② 마커(`"""`·`/**`·`///`) 미포함(정제 확인), ③ 문서 없는 정의는 doc 필드 부재, ④ 30줄짜리 장문 독스트링 → 12줄/800자 캡·`…` 확인. (~35 LOC)
   - 호버 DOM 스모크(선택): `window.__monaco`(monaco-setup.ts:438) + `ed.trigger("keyboard", "editor.action.showHover")`(Monaco 0.55 Action2라 `getAction()` null — trigger 관례)로 `.monaco-hover` 내 문서 텍스트 출현 확인 — 렌더 타이밍 플레이크 시 백엔드 검증만 유지(베스트에포트, 검증 필요).

규모: **S**(반나절~1일) — Rust ~80 LOC + 프론트 ~25 LOC + 테스트 ~40 LOC. 신규 커맨드·마이그레이션 0.

## 6. 위험과 완화

| 위험 | 설명 | 완화 |
|---|---|---|
| 무관 주석 오귀속 | 정의 위의 일반 블록 주석/구획 주석을 문서로 오인 | 상승 스캔은 정의(또는 데코레이터 블록) **바로 윗줄**부터 공백줄 불허(§3.2) — 한 줄이라도 떨어져 있으면 미수집. JSDoc은 `/**` 시작만 인정(`/*` 제외) |
| 파이썬 독스트링 미검출 | 시그니처가 8줄 캡으로 안 닫힌 경우(초장문 파라미터) doc 스캔을 건너뜀 | 경량판으로 수용 — `:` 종결 확인 없이 스캔하면 함수 본문을 문서로 오인하는 더 나쁜 오탐이 생긴다. 캡 확장은 후속 |
| 델리미터 변형 미지원 | f-string 독스트링, 러스트 `/** */`·`//!` 등 희귀 변형 | v1 규칙 밖 — doc 없음으로 강등될 뿐 기존 동작(시그니처만)과 동일해 회귀 아님 |
| 호버 3-엔트리 렌더 검증 | contents 엔트리 추가 시 시각 간격/구분선이 어색할 가능성 | 2-엔트리 스택은 현행으로 검증됨(§2.2) — 같은 메커니즘의 1개 추가. E2E 호버 DOM 스모크(5.4)로 확인, 어색하면 본문을 힌트줄과 한 엔트리로 합치는 폴백(이스케이프는 유지) |
| E2E 기존 어서션 회귀 | signature 의미가 바뀌면 `:22` 정규식 검사 등이 흔들림 | signature는 불변(문서는 별도 필드 — §3.1 채택 근거). 캐시 키(`:35`)도 불변이라 프론트 회귀면 없음 |
