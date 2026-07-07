# 태스크 16 — 실전 린트 마커 (ruff check / biome lint)

> 상태: 설계(Design) · 대상: gitpervisor · 산출물 성격: 아키텍처/계약/단계/위험 (구현은 후속)
> 근거: 코드 실측 2026-07-06 · 관련: [15-formatter.md](15-formatter.md)(외부 도구 러너 계약 재사용), [10-goto-definition 전례 — tests/e2e/suites/10-codenav.mjs]

## 1. 요구사항

뷰어 파일뷰에서 **진짜 린트 진단**을 Monaco 마커(밑줄 + 호버 메시지)로 표시한다.
TS 워커의 가짜 진단(단일 모델이라 import 해석 불가 → 전부 "모듈 없음" 오류, 실측 150개 — 그래서 전역 OFF)과 달리, ruff/biome은 **프로젝트 문맥이 불필요한 규칙 기반** 린터라 단일 파일 뷰어에서도 진단이 유효하다.

- 대상: py/pyi → `ruff check`, ts/tsx/js/jsx/mjs/cjs → `biome lint`. 그 외 확장자는 무시.
- 실행 시점: 파일뷰 열람 시 1회 + 저장 성공 후(디바운스). 파일 전환 시 마커 잔존 금지.
- 도구 미설치 시 **조용히 스킵**(오류·토스트 없음).
- 마커는 도구별 owner(`'ruff'`/`'biome'`) 분리 — 서로·향후 다른 진단원과 독립 교체.
- 읽기 전용 diff 모드(worktree/index/commit)는 v1 제외(§3.6에서 비교 후 절단).

## 2. 현황(근거)

### 2.1 TS 워커 진단은 의도적으로 꺼져 있다 — "빈 자리"가 이미 확보됨
- `src/components/diff/monaco-setup.ts:80-86` `tsDiagsOff`(noSemantic/noSyntax/noSuggestion 전부 true)를 typescript/javascript defaults에 적용. 사유 주석(`:76-79`): "뷰어는 파일을 단일 모델로만 알아서 import/tsconfig 해석이 불가능 … 여긴 린터가 아니라 코드 뷰어다". 즉 **진단 채널(마커 UI)은 비어 있고**, 규칙 기반 린터가 그 자리를 오탐 없이 채울 수 있다.
- `:44-58` `tsModeNoDefs`(definitions만 false) — 워커 기능을 선별적으로 끄는 전례. `:70-75` deprecated 스텁 구조 캐스트 관례.

### 2.2 마커 API는 번들에 실존 — owner 단위 교체·정리 지원
- `node_modules/monaco-editor/monaco.d.ts:1039` `setModelMarkers(model, owner, markers)` — **owner별 세트 교체** 시맨틱. `:1044` `removeAllMarkers(owner)`, `:1051-1055` `getModelMarkers(filter)`(E2E 검증 창구), `:1061` `onDidChangeMarkers`.
- `:78-83` `MarkerSeverity { Hint=1, Info=2, Warning=4, Error=8 }`. `:1475-1480` `IMarkerData` — `code?: string | { value, target: Uri }`로 규칙 문서 링크 부착 가능.

### 2.3 뷰어 모델 수명 — 파일 전환은 리마운트, 모델은 자동 폐기
- `src/components/diff/DiffViewer.tsx:113-116` `editorKey = ${projectId}:${mode}:${path}`(projectId 포함 — 프로젝트가 달라도 키 충돌 방지 주석), `:374-375` `<Editor key={editorKey}>` — **파일 전환 = 에디터 리마운트**(실측).
- `node_modules/@monaco-editor/react/dist/index.mjs:1`(압축 번들) — `keepCurrentModel:V=!1`(기본 false), 언마운트 경로에서 `o.current.getModel()?.dispose()` 실측. **모델이 파일 전환마다 폐기되므로 마커도 함께 사라진다** — "이전 파일 마커 잔존" 걱정은 구조적으로 해소, 명시 정리는 이중 방어로만 둔다.
- 뷰어 상한: `DiffViewer.tsx:365-370` 1.5MB 초과 파일은 표시 자체를 안 함 — 린트 입력 크기의 자연 상한.

### 2.4 실행 시점 앵커 — 마운트·저장·외부 변경 세 지점이 이미 코드에 있다
- 마운트: `DiffViewer.tsx:208-224` `onFileMount`(editorRef 확보, baseline 설정, `:219-221` Ctrl+S `addCommand`).
- 저장: `:168-183` `saveRef.current` — `writeFile.mutateAsync` 성공 시 baseline 갱신+토스트. `src/queries/index.ts:724-735` `useWriteFile` onSuccess가 statuses/diff invalidate. **저장 성공 시점 = 디스크와 버퍼가 일치하는 시점.**
- 외부 변경: `DiffViewer.tsx:197-206` 내용 동기화 효과 — 쿼리 데이터 변경 시(dirty 아니면) `ed.setValue(content)`로 교체(watcher 반영 겸용). 교체되면 기존 마커 위치가 무효 → 이 지점도 재실행 트리거여야 한다.
- 편집 가능 조건: `:104` `editable = isFileView && !isImageView`. diff 모드는 `:59` `readOnly: true`.
- 내용 출처: `src/queries/index.ts:435-445` `useDiff`(staleTime Infinity + keepPreviousData) — 열람 시점 내용 = 디스크 내용.

### 2.5 IPC·백엔드 관례(신규 커맨드가 따를 규약)
- `src/lib/ipc.ts:489-491` MAX_CONCURRENT 8·타임아웃 8s·재시도 3(읽기 전용 전제), `:499-500` background lane(큐 맨 뒤 — 사용자 클릭에 양보), `:506-521` single-flight(dedupKey = `cmd:JSON(args)` `:513` — **args가 작아야 키도 싸다**), 폴링류 규약 전례 `:755-761`(sysMetrics — background/attempts 1/짧은 타임아웃), lane 인자 전달 전례 `:680-685`(findDefinition).
- `src-tauri/src/commands/tree.rs:363-458` `find_definition` — 신규 grep류 커맨드의 관례 원형: 입력 검증(`:372-377` 심볼 화이트리스트 — 인젝션 방어), 결과 캡(`:446` 12건), 상대경로 forward-slash(`:425`), **도구 실패 시 조용히 빈 결과**(`:402-405`).
- 경로 안전: `tree.rs:695-712` `resolve_in_repo`(렉시컬 검증+상위 정규화 컨테인먼트) — 레포 파일을 인자로 받는 모든 커맨드의 필수 관문(메모리: FS 커맨드 경로 안전).
- 프로세스 실행: `src-tauri/src/git/runner.rs:107-114` `run_git` — "모든 git 실행의 단일 관문. 인자는 배열로만(셸 문자열 조합 금지)", `:9` READ_TIMEOUT_SECS 10초. **외부 린터도 같은 원칙의 러너를 써야 하며, 그 일반화가 [15-formatter.md]의 러너 계약이다.**
- 등록: `src-tauri/src/lib.rs:270-362` invoke_handler(find_definition `:302`), `src-tauri/src/commands/mod.rs:1-35` `mod`+`pub use` 관례.

### 2.6 프론트 코드내비 관례(컨텍스트 전달·캐시)
- `src/components/diff/goto-definition.ts:21-26` — 모델 URI는 `@monaco-editor/react`가 자동 생성(inmemory)이라 **모델만으로는 파일 경로를 모른다** → 모듈 변수 ctx로 projectId/ext 전달. 린트도 동일 제약(경로는 컴포넌트에서 함께 넘겨야 함).
- `:29-43` 심볼 캐시 Map(상한 800) — 결과 캐시 전례.
- 언어 판정: `src/lib/language-map.ts:2-10` ts/tsx/js/jsx/mjs/cjs/py 매핑 — 디스패치 확장자 집합과 일치.

### 2.7 E2E·dev 노출
- `src/components/diff/monaco-setup.ts:437-439` dev에서 `window.__monaco` 노출 — `getModelMarkers`로 DOM-레벨 검증 가능.
- `tests/e2e/lib/cdp.mjs:86` `invoke`, `:97-98` `try`(비throw). 픽스처 파일 생성 전례 `tests/e2e/suites/10-codenav.mjs:6`(`fix.writeFile`), 커맨드 직접 검증 `:18`. 스위트 등록 `tests/e2e/run.mjs:14-33`(현재 19번까지), 실행 `package.json:21` `test:e2e`.

### 2.8 로컬 검증 한계 — 외부 CLI 사실
- ruff·biome 모두 이 머신에 없음(실측: `node_modules/.bin`에 biome 없음, PATH에 ruff/biome 없음). **ruff/biome CLI 플래그·JSON 스키마·종료 코드에 관한 아래 서술은 전부 "(검증 필요)"** — 구현 1단계에서 실물로 확정한다.

## 3. 설계

### 3.1 실행 주체 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **백엔드 Rust 커맨드 `lint_file` + 15 러너 계약** | **채택** | 프로세스 spawn은 Rust 전용(WebView2에서 불가). 바이너리 발견·타임아웃·미설치 UX를 [15-formatter.md] 러너 계약이 이미 정의 — 중복 정의 금지(교차 계약). 경로 검증은 resolve_in_repo(§2.5) 재사용. |
| 프론트에서 셸 플러그인으로 직접 실행 | 기각 | tauri-plugin-shell 신규 도입 + capability 확대 — 러너 계약 이원화, 인자 조합이 JS로 넘어가 검증 우회 표면 증가. |
| 린터를 워커로 포팅(ruff WASM 등) | 기각 | 배포물 크기·유지보수 과잉. 사용자 프로젝트의 pyproject.toml/biome.json 설정 해석도 CLI가 정확하다. |

파이프라인: `lint_file(projectId, relPath)` → 15 러너로 도구 발견·실행(cwd=레포 루트 — 프로젝트 설정 파일이 자연 해석됨) → JSON 파싱 → 정규화 `LintDiag[]`(캡 500) → 프론트 `lint-markers.ts`가 `IMarkerData` 매핑 → `setModelMarkers(model, tool, …)`.

### 3.2 파일 전달 방식 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **실파일 경로(디스크의 그 파일을 그대로 린트)** | **채택** | v1 실행 시점(열람 시·저장 성공 후)은 **디스크=버퍼가 보장**된다(§2.4 — 열람 내용은 디스크에서 오고, 저장 성공 후 재실행). 파일 내용을 IPC로 안 실어 페이로드 0 — single-flight dedupKey(ipc.ts:513)도 `projectId+relPath`로 작게 유지. 도구가 실제 경로를 보므로 per-file 설정(ruff의 per-file-ignores 등) 해석도 정확. |
| stdin + `--stdin-filename`(ruff) / `--stdin-file-path`(biome) (검증 필요) | ~~후속~~ **[2026-07-07 구현 소급] ruff는 채택됨** | 구현에서 파이썬 on-type 린트로 조기 도입: `lint_file(content: Option<String>)`(`lint.rs:52`)이 버퍼를 ruff stdin으로 린트, `DiffViewer.tsx:273`이 python 타이핑 시 500ms 디바운스 트리거 — 미저장 구문 오류 실시간 빨간 밑줄 DOM 검증 완료. **biome은 stdin JSON이 깨져(내용 에코) 실측 기각** — ts/js는 저장 시 디스크 린트 유지. |
| 임시 파일 복사 후 린트 | 기각 | 정리(cleanup) 부담 + 임시 경로가 프로젝트 밖이라 설정 파일(pyproject.toml/biome.json) 해석이 깨진다. stdin 방식이 존재하는 이상 이점이 없다. |

### 3.3 도구 디스패치·명령줄 (외부 사실 — 검증 필요)

| 확장자 | 도구 | 명령(안) | 비고 |
|---|---|---|---|
| py, pyi | ruff | `ruff check --output-format json --no-cache <relPath>` | `--no-cache`: 사용자 레포에 `.ruff_cache/` 오염 방지(검증 필요). 위반 있으면 exit 1이 정상 — **종료 코드로 실패 판정하지 않고 stdout JSON 파싱 가능 여부로 판정**(spawn 실패·타임아웃·JSON 불가만 실패). |
| ts, tsx, js, jsx, mjs, cjs | biome | `biome lint --reporter=json <relPath>` | reporter 플래그·JSON 스키마는 버전별 차이 가능(검증 필요). biome JSON은 위치가 **바이트 span 오프셋**일 가능성 — 그 경우 백엔드가 파일을 읽어 오프셋→라인/열 변환(검증 필요). |
| 그 외 | — | 실행 안 함 | `tool: null` 반환 → 프론트 no-op. json/css(biome 지원)는 v1 절단(§3.8). |

도구 발견 순서·미설치 판정·실행 타임아웃은 [15-formatter.md] 러너 계약을 그대로 따른다. **경로 인자 준수(15 §3.2 계약 3항)**: `<relPath>`는 `resolve_in_repo`를 통과한 레포 상대 경로라서 인자로 허용되는 유일한 사용자 유래 문자열이며, 위치 인자로 넘길 때는 `--` 구분자 뒤에 두거나 선행 `-`를 `./` 접두로 중화해 플래그 오파싱(`-v.py` 등)을 방지한다(`--` 지원 여부는 도구별 검증 필요). 단 **자동 트리거 특성상 프로젝트-로컬 바이너리(node_modules/.bin 등) 사용 여부는 보수적으로**(§6 공급망 위험) — v1 기본은 PATH(전역 설치)만, 프로젝트-로컬은 15 계약의 옵트인(`formatter_project_local` — 15 §4/§6에 "열람=실행 위험 표면 확대" 명시) 결정에 종속.

### 3.4 심각도 매핑 (외부 사실 — 검증 필요)

| 도구 출력 | MarkerSeverity | 비고 |
|---|---|---|
| ruff 일반 위반(심각도 필드 없음 — 전부 동급) | Warning(4) | 스타일/버그 혼재 규칙을 전부 Error로 칠하면 빨간 도배 — 뷰어 성격상 Warning이 기본. |
| ruff 문법 오류(syntax-error — code null 또는 E999 계열) | Error(8) | 검증 필요. |
| biome `fatal`/`error` | Error(8) | biome은 진단별 severity 보유(검증 필요). |
| biome `warning` | Warning(4) | |
| biome `information` / `hint` | Info(2) / Hint(1) | Hint는 물결 없이 점선 — 노이즈 최소. |

`IMarkerData.code`에 규칙 코드(`F401`, `lint/suspicious/noDoubleEquals`)를, 규칙 문서 URL이 있으면 `{ value, target }` 형태(monaco.d.ts:1475-1480)로 넣어 마커 호버에서 규칙 링크를 제공한다.

### 3.5 실행 시점·마커 수명

- **트리거 3곳**(§2.4의 앵커와 1:1): ① `onFileMount` 직후 1회, ② 저장 성공(then 블록) 후 — 500ms 트레일링 디바운스(Ctrl+S 연타 대비; 동시 중복은 single-flight가 추가 방어), ③ 내용 동기화 효과의 `setValue` 직후(외부 디스크 변경 반영 시 구 마커 위치가 무효라 재계산).
- **정리**: 파일 전환은 리마운트 → 모델 dispose로 마커 자동 소멸(§2.3 실측). 이중 방어로 언마운트 cleanup에서 `setModelMarkers(model, owner, [])` 2회(ruff/biome) 호출 — 비용 0에 가깝고 keepCurrentModel 기본값이 바뀌는 회귀를 막는다.
- **비동기 경합**: 응답 도착 시점에 파일이 바뀌었을 수 있다 → 적용 직전 `model.isDisposed()` 가드(폐기된 모델에 setModelMarkers는 무의미·오류 위험).
- **편집 중(dirty)**: 마커 유지 — Monaco가 마커를 내부적으로 편집 추적해 위치를 이동시킨다(검증 필요; E2E/수동으로 확인, 어긋나면 dirty 진입 시 클리어로 폴백 §6). 저장 시 재계산이 진실.

### 3.6 diff 모드 스킵 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **파일뷰(mode:"file")만 린트** | **채택** | 편집·저장 루프가 있는 곳(:104 editable)이 린트 가치가 최대인 곳. 모델 1개·수명 명확. |
| diff 모드의 modified pane에도 표시 | 기각(v1) | 유용하긴 하다(커밋 전 검토 중 위반 발견). 그러나 readOnly(:59)라 고칠 수 없어 행동 유도가 끊기고, hideUnchangedRegions 접힘 영역의 마커는 보이지 않아 "위반 있는데 안 보이는" 혼란, DiffEditor는 모델이 2개(original/modified)라 수명 관리 분기 추가. "편집" 버튼(:307-315)으로 파일뷰 전환이 한 클릭이므로 v1 절단 — 후속 후보. |

### 3.7 미설치 UX — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **완전 침묵(tool:null → no-op)** | **채택** | 린트는 열람만으로 자동 실행되는 배경 기능 — 쓰지 않는 사용자에게 존재를 알릴 이유가 없다. find_definition의 "rg 미설치면 조용히 빈 결과"(tree.rs:362, :402-405)와 같은 결. 도구 상태의 명시적 노출(설치 여부 표시·안내)은 [15-formatter.md] 러너 계약의 도구 상태 UI에 위임 — 포매터는 명시 실행이라 "왜 안 되지"가 발생하는 곳이 거기다. |
| 파일 열람 시 1회 토스트 안내 | 기각 | py/ts 파일을 처음 연 모든 사용자에게 소음. "1회" 판정 상태를 localStorage에 늘리는 비용 대비 가치 낮음. |
| 뷰어 헤더에 린트 상태 뱃지(도구 없음=회색) | 후속 | 발견성은 가장 좋으나 헤더 밀도 증가 — 15의 도구 상태 UI가 자리 잡은 뒤 재평가. |

### 3.8 범위 절단 (YAGNI)

- **v1**: py→ruff / ts·js→biome, 파일뷰 전용, 열람+저장 트리거, owner 분리 마커, 캡 500, 침묵 스킵.
- **후속**: ① ~~on-type 린트~~ **[구현됨 — 파이썬만, §3.2 개정 각주]**, ② quick fix(코드 액션 — ruff `fix`/biome 수정 제안 적용), ③ diff 모드 marker(§3.6), ④ json/css biome 린트, ⑤ 문제 패널(프로젝트 전체 진단 목록), ⑥ 린트 on/off 설정. ~~자동 바이너리 다운로드는 전 문서 공통 비채택~~ **[2026-07-07 개정: "발견 우선+검증된 폴백"으로 — 00-INDEX §4.3, 15 §1 각주]**.

## 4. 계약(타입·커맨드·이벤트)

**신규 이벤트 없음. 신규 Tauri 커맨드 1개(`lint_file`).**

```ts
// src/lib/ipc.ts — 신규 타입·메서드
/** 린트 진단 1건 — 백엔드가 도구별 JSON을 정규화(라인/열 1-based). */
export interface LintDiag {
  line: number; column: number; endLine: number; endColumn: number;
  code: string | null;      // 규칙 코드 (예: "F401", "lint/suspicious/noDoubleEquals")
  message: string;
  severity: "error" | "warning" | "info" | "hint";
  url: string | null;       // 규칙 문서 링크 (마커 code.target)
}
export interface LintReport {
  tool: "ruff" | "biome" | null; // null = 비대상 확장자/도구 미설치/도구 실패 → 프론트 no-op
  diags: LintDiag[];
  truncated: boolean;            // 캡(500) 절단 여부
  durationMs: number;            // 진단·성능 로깅용
}
// 읽기 전용 — background lane(마커는 배경 장식, 클릭에 양보), 재시도 없음(다음 트리거가 자기치유).
lintFile: (projectId: string, relPath: string) =>
  call<LintReport>("lint_file", { projectId, relPath },
    { lane: "background", attempts: 1, timeoutMs: 15_000 }),
```

```rust
// src-tauri/src/commands/lint.rs (신설) — mod.rs에 `mod lint; pub use lint::*;`,
// lib.rs invoke_handler에 commands::lint_file 등록(§2.5 관례).
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct LintDiag { /* ipc.ts LintDiag 1:1 (line, column, end_line, …) */ }
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct LintReport { pub tool: Option<String>, pub diags: Vec<LintDiag>,
                        pub truncated: bool, pub duration_ms: u64 }

#[tauri::command]
pub async fn lint_file(
    state: State<'_, AppState>, project_id: String, rel_path: String,
) -> Result<LintReport, IpcError>;
// 1) project_path + resolve_in_repo(tree.rs:695) — 경로 탈출·.git 우회 차단(잘못된 경로만 Err).
// 2) 확장자 디스패치(§3.3) — 비대상이면 tool:None 즉시 반환.
// 3) 15 러너 계약으로 도구 발견·실행(cwd=레포 루트, 타임아웃 10초 = READ_TIMEOUT_SECS 미러,
//    인자 배열 조합 — runner.rs:107 원칙). 미설치/spawn 실패/타임아웃/JSON 파싱 불가 → tool:None
//    (find_definition 침묵 실패 전례 tree.rs:402-405).
// 4) 도구 JSON → LintDiag 정규화(심각도 매핑 §3.4, 경로는 단일 파일이라 불필요), 캡 500 + truncated.
```

```ts
// src/components/diff/lint-markers.ts (신설) — goto-definition.ts와 형제(co-locate).
/** lint_file 호출 → IMarkerData 매핑 → setModelMarkers(model, report.tool, …).
 *  적용 직전 model.isDisposed() 가드. report.tool=null이면 no-op. */
export function refreshLintMarkers(
  model: monaco.editor.ITextModel, projectId: string, relPath: string,
): Promise<void>;
/** owner 'ruff'/'biome' 마커 클리어 — 언마운트 이중 방어(§3.5). */
export function clearLintMarkers(model: monaco.editor.ITextModel): void;
```

```ts
// src/components/diff/DiffViewer.tsx — 연결 4곳(±15 LOC)
// ① onFileMount(:208-224) 말미: void refreshLintMarkers(model, projectId, path)
// ② saveRef(:168-183) 성공 then: 500ms 디바운스 후 재실행
// ③ 내용 동기화 효과(:197-206) setValue 직후: 재실행
// ④ 파일뷰 언마운트 cleanup: clearLintMarkers (모델 dispose가 원 방어 — §2.3)
```

## 5. 단계(구현 순서)

1. **외부 사실 확정(§2.8·§3.3·§3.4의 "검증 필요" 소거)** — ruff/biome 설치 후 실물로 JSON 스키마·플래그·종료 코드·`--no-cache`·biome span 오프셋 여부 확인, 파서 픽스처(JSON 샘플 파일)로 고정. (반나절)
2. **백엔드 `commands/lint.rs`** — 디스패치, 15 러너 호출, serde 파서 2종(ruff/biome), 정규화·캡·침묵 실패. mod.rs/lib.rs 등록 2줄. (~150 LOC + 파서 단위 테스트 ~60 LOC — JSON 픽스처 기반이라 도구 미설치 CI에서도 돈다)
3. **ipc.ts 계약** — LintDiag/LintReport/lintFile. (~30 LOC)
4. **프론트 `lint-markers.ts`** — 매핑(심각도→MarkerSeverity, code/url→code.target), isDisposed 가드, 디바운스. (~80 LOC)
5. **DiffViewer 연결 4곳**(§4 ④까지). (~15 LOC)
6. **E2E `tests/e2e/suites/20-lint.mjs`** — run.mjs SUITES(:14-33) 등록. (~70 LOC)
   - 커맨드 레벨: `fix.writeFile("bad.py", "import os\n")`(F401 유발) → `cdp.invoke("lint_file", …)` → `tool === "ruff"`면 diags에 F401·1-based 좌표 검증 / `tool === null`이면 "미설치 침묵 경로 정상"으로 기록(러너 머신 의존 분기 — 10-codenav의 존재/부재 이중 검증 패턴 미러).
   - 비대상 확장자(`.md`) → `tool: null`. 경로 탈출(`../x`) → `cdp.try`로 Io 오류 확인(15-tree-fileops 관례).
   - DOM 레벨(도구 설치 시): `__gpv`/스토어로 selectDiff 구동해 bad.py 파일뷰 오픈 → `window.__monaco.editor.getModelMarkers({ owner: "ruff" })` 폴링(dev 노출 monaco-setup.ts:437-439) → 파일 전환 후 소멸 확인.

규모: **M(2~3일)** — 백엔드 ~150 + 파서 테스트 ~60 + 프론트 ~125 + E2E ~70 LOC. 1단계(외부 사실 확정)가 선행 관문.

## 6. 위험과 완화

| 위험 | 설명 | 완화 |
|---|---|---|
| 프로젝트-로컬 바이너리 공급망 | 린트는 **파일을 열기만 해도** 자동 실행된다 — `node_modules/.bin/biome`을 자동 채택하면 신뢰 안 되는 레포를 열람하는 것만으로 그 레포가 심은 실행파일이 돈다(포매터의 명시 실행보다 위험 표면이 넓다) | v1 기본은 PATH(전역 설치) 도구만. 프로젝트-로컬 허용은 [15-formatter.md] 러너 계약의 옵트인 결정에 종속하되, 16은 자동 트리거임을 15 §6에 교차 명시 |
| CLI 출력 포맷 버전 변동 | ruff/biome은 릴리스가 잦아 JSON 스키마·플래그가 바뀔 수 있다(biome reporter는 메이저별 차이 가능성 — 검증 필요) | 파싱 실패는 침묵(tool:null — tree.rs:402-405 전례)이라 앱은 절대 깨지지 않는다. 파서는 JSON 픽스처 단위 테스트로 고정, 미지 필드는 serde 기본 무시 |
| 진단 폭주 | 생성 파일·미설정 레포에서 위반 수천 건 → IPC 페이로드·마커 렌더 부담 | 백엔드 캡 500 + truncated 플래그(find_definition 캡 전례 :446). 뷰어 1.5MB 상한(:365-370)이 입력도 제한 |
| 편집 중 마커 위치 어긋남 | dirty 상태에서 마커가 편집을 추적하지 못하면 엉뚱한 줄에 밑줄(추적 여부 검증 필요 — §3.5) | 확인 후 어긋나면 dirty 진입 시(onDidChangeModelContent 최초 1회) 해당 모델 마커 클리어로 폴백 — 저장 시 재계산 |
| 레포 오염 | ruff가 cwd에 `.ruff_cache/` 생성 시 사용자 레포에 untracked 쓰레기(변경 감시·상태 표시 노이즈) | `--no-cache`(검증 필요). 불가하면 캐시 디렉토리를 앱 데이터 폴더로 지정하는 환경변수/플래그 확인 |
| 도구가 느린 환경 | 콜드 스타트·거대 설정 해석으로 10초 근접 시 마커가 늦게 붙음 | background lane이라 UI 블로킹 없음. 타임아웃 시 침묵 — 다음 트리거(저장)가 재시도. durationMs 로깅으로 실측 후 조정 |
| 첫 대상 파일과 저장의 동시성 | 저장 직후 statuses/diff invalidate(queries :731-732)와 lint가 동시 진행 — 슬롯 경합 | lint는 background lane + attempts 1 — interactive 호출이 항상 우선(ipc.ts:499-500). 마커는 늦어도 무해 |
