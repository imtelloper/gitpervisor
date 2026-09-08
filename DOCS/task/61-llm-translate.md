# 태스크 61 — 로컬 LLM 번역: 터미널·뷰어 선택 텍스트를 우클릭 → 번역 카드

> 상태: **설계** (2026-09-07) · 대상: gitpervisor · 근거: 코드 실측 2026-09-07 · **선행: 59(`lib/llm.ts`)** ·
> 선례: `PaneMenu`(`TerminalPane.tsx:158-286`)·`ChipMenu`(24), 호버 카드(26), `ConfirmHost` 창별 마운트 · **Rust 변경 0** · 규모 **S~M**

## 1. 요구사항

터미널이나 뷰어에서 텍스트를 선택하고 우클릭 → **"선택 영역 번역"** → 로컬 LLM이 번역한 결과가 카드로 뜬다.
한국어 ↔ 영어가 기본이고 방향은 자동(한글이면 영어로, 아니면 한국어로), 카드에서 뒤집을 수 있다.

받아들이는 조건:
- 진입: 워크스페이스·플로팅 pane `PaneMenu`, 모아보기 셀 `ChipMenu`(표시 중 터미널 셀), 뷰어 Monaco 컨텍스트 메뉴.
- 선택이 없으면 항목이 비활성(`aria-disabled`)이 아니라 **없다**(ChipMenu 관례).
- 결과는 스트리밍, 복사 버튼, Esc·바깥 클릭·X로 닫힘. 네이티브 webview 위에 그려진다(점유 등록).
- 원문 8,000자 초과는 앞 8,000자만 + "잘림" 표시. LLM 미준비면 카드 안에 이유 + "설정 열기".
- 다른 AI 요청(60 배치)이 진행 중이면 "대기 중…" 후 자동 실행(59 Busy 대응).

## 2. 현황(근거)

- xterm 선택: `term.getSelection()`/`hasSelection()` — `pasteIntoTerminal`·복사 폴백(`main.tsx:63 installTerminalCopyFallback`)이 이미 쓴다.
  `PaneMenu`는 `useTerminals()`를 직접 읽고(`:179`) 항목은 `MenuItem`; ChipMenu는 콜백형(컨테이너가 조건 판정 `AggregateTerminals.tsx:847`).
  `getTerminal(paneId)`(`lib/terminal.ts`)로 인스턴스 접근.
- Monaco: `DiffViewer.tsx`가 에디터를 만들고 액션을 등록한다(정의 이동 `:580` 부근). `editor.addAction({contextMenuGroupId})`로
  네이티브 컨텍스트 메뉴에 항목이 들어간다. `MarkdownView`(react-markdown)·`ImageView`는 Monaco가 아니다 — 마크다운 뷰는 DOM 선택
  (`window.getSelection()`)이라 v1 제외(§7).
- 창별 호스트 관례: `ConfirmHost`가 `App`·`AggregateWindow`·`DocWindow`·`SysMonitorWindow`에 각각 마운트(`useUi`는 창마다 별개).
  `FloatingTerminal.tsx:238`에는 `Toasts`만 있다.
- 고정 카드 선례: 26 호버 카드(`fixed z-50 role=tooltip`, `useOccludesWebview`), 위치 클램프 관례(24 §2.4).
- 언어: 59 `llmLanguage`(기본 "ko").

## 3. 설계

### 3.1 흐름

```
메뉴 클릭 → useUi.openTranslate({ text, x, y })          // 창별 스토어
  → <TranslateHost/>가 카드 렌더 → 방향 판정 → 59 chat() 스트리밍 → 카드에 누적
```
- 방향: `hangulRatio(text) = 한글 음절 수 / 공백 제외 문자 수`. **≥ 0.2 → 영어로**, 아니면 → `llmLanguage`(기본 한국어). 카드의
  "→ EN / → KO" 토글이 재요청.
- 프롬프트: system `"Translate the user's text into {target}. Keep code, file paths, commands, identifiers, numbers and formatting
  unchanged. Output only the translation, no preface."` / user = 원문. `maxTokens: min(2048, 원문 길이×2/1.5)`, `temperature: 0.1`.
- Busy: `chat`이 `ErrorCode::Busy`를 던지면 카드가 "다른 AI 작업이 끝나면 시작합니다…"를 보이고 **3초 간격 재시도**(최대 10분, 카드 닫으면 중단).
  `ponytail:` 폴링 — 59에 큐를 넣는 게 정석이나 소비자 2개에 큐는 과하다.

### 3.2 카드 — `components/common/TranslateCard.tsx` + `TranslateHost`

- `useUi.translate: { text: string; x: number; y: number; truncated: boolean } | null`, `openTranslate(req)`, `closeTranslate()`.
  **`selectBlockingOverlay`에는 넣지 않는다**(비차단 카드) — 대신 `TranslateHost`가 `useOccludesWebview(!!req)`(26과 같은 층).
- 모양: `fixed z-50 w-[min(520px,90vw)] max-h-[60vh] flex flex-col rounded-md border border-edge bg-panel shadow-xl`, 위치 = 메뉴 좌표에서
  `left: min(x, innerWidth-540)`, `top: y > innerHeight/2 ? undefined : y`, `bottom: y > innerHeight/2 ? innerHeight-y : undefined`
  (ChangesPanel 뒤집기 관례 `:547-557`). 헤더: `Languages` 아이콘 + "번역 → 영어/한국어" 토글 + 복사 + X. 본문: 원문(접힘, 3줄
  clamp, 클릭 펼침) / 구분선 / 번역(스트리밍, `whitespace-pre-wrap`, 진행 중 커서 `▍`). 푸터: 모델명·"잘림" 뱃지·취소.
- Esc·바깥 `mousedown`(카드 밖) → 닫기 + `AbortController.abort()`. 창 크기 변경 시 클램프 재계산 없음(닫힘 유도 안 함).
- 마운트: `App.tsx`(호스트 형제), `AggregateWindow.tsx`, **`FloatingTerminal.tsx`**(PaneMenu가 거기서도 열린다), `DocWindow.tsx`(뷰어 Monaco).
  각 창의 `useUi`가 자기 요청을 쥔다 — 별도 창의 카드는 그 창 안에.

### 3.3 진입점

- `PaneMenu`(`TerminalPane.tsx`): '붙여넣기' 뒤에 `MenuItem icon={<Languages size={14}/>} label="선택 영역 번역"` — 렌더 조건
  `getTerminal(paneId)?.term.hasSelection()`(메뉴가 열릴 때 1회 평가 — `PaneMenu`가 열린 순간의 선택). onClick →
  `openTranslate({ text: sel.slice(0, 8000), x, y, truncated: sel.length > 8000 })`. 좌표는 메뉴의 `x,y` props.
- `ChipMenu`: 컨테이너(`AggregateTerminals.tsx:829-883`)가 `onTranslate`를 `selected.has(id) && kind==="terminal" &&
  getTerminal(id)?.term.hasSelection()`일 때만 넘긴다(콜백형 관례). 그리드 셀 우클릭(`:639-644` 계열)으로 열린 경우가 실질 경로.
- Monaco(`DiffViewer.tsx` 에디터 생성 직후): `editor.addAction({ id: "gp.translate", label: "선택 영역 번역", contextMenuGroupId:
  "9_cutcopypaste", contextMenuOrder: 9, precondition: "editorHasSelection", run: (ed) => { const sel = ed.getModel()?.getValueInRange(
  ed.getSelection()); const pos = 마지막 마우스 좌표(에디터 `onContextMenu` 이벤트의 `event.posx/posy`); openTranslate(…) } })`.
  Monaco 컨텍스트 메뉴는 네이티브 DOM이라 `precondition`이 선택 없을 때 항목을 **비활성**으로 보인다 — Monaco 관례라 수용(요구
  "없다"는 앱 메뉴에 한함).

### 3.4 클립보드 복사

기존 복사 유틸(`FileTreePanel.tsx:552-557 copy(text, ok)`가 쓰는 `navigator.clipboard`/플러그인 경로)을 그대로 — `pushToast("복사했습니다")`.

## 4. 변경 목록

| 파일 | 변경 | 규모 |
|---|---|---|
| `src/stores/ui.ts` | `translate` 상태·액션 2 | +6 |
| `src/lib/translate.ts` | `hangulRatio`·프롬프트·`translateStream(text, target, onToken, signal)`(59 `chat` 래핑, Busy 재시도) | ≈ +60 |
| `src/components/common/TranslateCard.tsx` | 카드 + 호스트 | ≈ +150 |
| `src/components/workspace/TerminalPane.tsx` | PaneMenu 항목 | ≈ +10 |
| `src/components/AggregateTerminals.tsx` | ChipMenu prop·항목·컨테이너 조건 | ≈ +14 |
| `src/components/diff/DiffViewer.tsx` | Monaco 액션 | ≈ +16 |
| `src/App.tsx`, `AggregateWindow.tsx`, `FloatingTerminal.tsx`, `DocWindow.tsx` | 호스트 마운트 | +4 |
| `tests/e2e/suites/49-translate.mjs` | 신설 | ≈ +70 |

## 5. 검증

### 5.1 e2e 49
1. 터미널에 `echo hello world` 실행 → `__gpv.term.get(paneId).term.selectAll()` → `.xterm`에 `contextmenu` → 메뉴에 "선택 영역 번역" 존재.
   `clearSelection()` 후 다시 열면 **항목 없음**.
2. 클릭 → `div.fixed.z-50` 카드에 원문 포함, `useUi.translate.text` 길이 ≤ 8000. LLM 준비 시(47 게이트) 번역 본문 등장 폴링 60s
   (한글 포함 단언 — 원문이 영어), 토글 "→ EN" 클릭 → 재요청 후 본문 변경. 미준비면 이유 문구 단언 후 skip.
3. 8,001자 선택 → `truncated === true`, 카드에 "잘림".
4. Esc → `translate === null`. 카드가 열린 동안 `useWebviewBlocked()`가 true(점유).
5. 뷰어: 텍스트 파일 열고 Monaco `setSelection` → `editor.trigger("e2e", "gp.translate")` → 카드 열림.
6. finally: 카드 닫기, 탭 정리.

### 5.2 실기
- 모아보기 별도 창·플로팅 창에서 우클릭 → 카드가 **그 창 안**에, 브라우저 셀 위에 그려짐.
- 60 배치 진행 중 번역 → "대기 중" 표시 → 배치 사이에 끼어들어 실행.
- 긴 로그(에러 스택) 번역 시 코드·경로가 보존되는지 — 프롬프트 튜닝 항목.

## 6. 위험

- Busy 폴링과 60 배치의 경합으로 번역이 오래 기다릴 수 있다(배치 10개 × 30초). 카드가 대기 중임을 계속 보이므로 수용.
- Monaco `contextMenuGroupId` 문자열이 버전에 따라 다르다(0.55 `9_cutcopypaste` (검증 필요)) — 틀리면 항목이 끝에 붙을 뿐 동작은 한다.
- 한글 비율 0.2 기준의 오판(한글 주석 섞인 코드) — 토글 한 번으로 복구.

## 7. 열린 질문

| 질문 | 기본값 |
|---|---|
| 마크다운 뷰·메모장 textarea 선택도 진입점에 | 후속 — DOM `getSelection()` 1줄씩. v1은 터미널+Monaco |
| 대상 언어 목록 확장(일/중) | `llmLanguage` 값만 — 카드 토글은 ko/en 두 개 |
| 번역 결과를 터미널에 붙여넣기 버튼 | 없음 — 복사로 충분 |
| 단축키(예: Ctrl+Shift+T) | 없음 — 터미널 키 화이트리스트를 늘리지 않는다 |

## 8. 구현 결과 (2026-09-07~08)

**구현 완료 · e2e 통과(LLM 의존 단계는 미설치로 skip, 미커밋).** Rust 변경 0.

- `ui.ts` `translate` 상태(설계대로 **`selectBlockingOverlay`에는 넣지 않는다** — 비차단 카드라
  `useOccludesWebview`로 점유만 등록) · `lib/translate.ts`(한글 비율 자동 방향·8,000자 절단·Busy 3초 재시도)
  · `components/common/TranslateCard.tsx`(세로 뒤집기·Esc·바깥 mousedown·원문 3줄 clamp·복사·방향 토글).
- 진입 3곳: `PaneMenu`(선택 있을 때만 항목 렌더) · `ChipMenu`(컨테이너가 조건 판정하는 관례) ·
  Monaco `addAction`(`precondition: editorHasSelection`). 호스트는 4개 창에 마운트.
- e2e 49 신설.

**설계와 다른 점**: `ipc.ts`의 `ErrorCode` 유니온에 `"BUSY"` 추가(백엔드가 그렇게 직렬화하는데 유니온에 없어
문서가 요구한 `e.code === "BUSY"` 분기가 컴파일되지 않았다). `translateStream`에 5번째 선택 인자 `onStatus`
(모델 로드·대기 문구를 카드가 그려야 한다 — 59 계약이 "모든 호출자가 그려라"고 못 박고 있다).
Monaco 액션은 파일뷰 에디터에만(diff 에디터는 `ICodeEditor`라 `addAction`이 없다). 메뉴 하단 클램프를
항목이 그려질 때만 +32px. 카드 `left`에 `Math.max(8, …)`(플로팅 창 최소 폭 360에서 음수가 된다).

**검증**: `abort`가 재시도 루프(`sleep`이 abort에 깨진다)와 서버(`llm_cancel`)까지 끊는 것, `BUSY` 직렬화가
백엔드(`SCREAMING_SNAKE_CASE`)와 일치하는 것을 코드로 확인했다. 짧은 선택이 잘리지 않도록 `maxTokens`에
하한 64를 뒀다(2~5자 선택은 3~7토큰이 나온다).

**미검증(§5.2 실기)**: 실제 번역 스트리밍·방향 토글·Busy 대기 표시(런타임·모델 미설치 — 59 §8),
모아보기 별도 창·플로팅 창에서 카드가 그 창 안 브라우저 셀 위에 그려지는지, 긴 에러 스택에서 코드·경로 보존,
Monaco `contextMenuGroupId`가 이 버전에서 맞는지(틀려도 항목이 메뉴 끝에 붙을 뿐 동작은 한다).
