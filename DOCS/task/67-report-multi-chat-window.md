# 태스크 67 — 리포트: 다중 프로젝트 종합 요약(날짜별 3줄) · 우측 AI 채팅(수정본 저장) · 별도 창

> 상태: **구현·검증 완료(미커밋)** (2026-09-11 · 상세 §8) · 대상: gitpervisor · 근거: 코드 실측 2026-09-11(HEAD f009ac4) · **선행: 60(리포트 뷰)·59(`lib/llm.ts chat`)** ·
> 선례: 폴더 창(66 — `doc-*` 창 재활용, Rust 0줄), 뷰어 탭 우클릭 메뉴(`ViewerFileTabs.tsx:51-56`), 번역 카드 스트리밍(61 `TranslateCard.tsx:70-83`) ·
> 규모 **M**(Rust 8줄 + 프론트 신설 1 · 수정 7). 세 요구를 한 태스크로 묶는다 — 셋 다 `components/report/*`를 만지고, B·C가 A의 카드 일반화를 전제한다.

## 1. 요구사항

1. **A. 여러 프로젝트를 골라 종합 리포트.** 요약은 **날짜마다 "내가 한 일" 정확히 3줄**로 나온다(일간·주간·월간 공통).
2. **B. 우측 AI 채팅 패널.** 요약이 시원찮으면 채팅으로 **수정본을 받아 요약으로 저장**하고, 리포트와 무관한 대화도 할 수 있다(첨부 스크린샷 — 우측 도킹, 상단 새 대화·닫기, 하단 입력).
3. **C. 타이틀바 [리포트] 우클릭 → "새 창으로 열기"** → 리포트가 별도 OS 창(float 모드)에 뜬다.

받아들이는 조건:
- A: 상단 프로젝트 선택이 다중 체크(전체 / N개). 2개 이상이면 맨 위에 **종합 카드** 1장 + 아래 개별 카드. 종합 카드의 카운트 = 합. 요약 본문은
  `## 한 줄 요약 / ## 날짜별(### 날짜마다 불릿 3개) / ## 다음 할 일`. 선택은 `gp:report-scope`로 기억.
- B: 카드의 [AI에게 묻기] → 패널이 그 카드(요약 + 근거)를 컨텍스트로 연다. 스트리밍·취소. 어시스턴트 답변마다 [요약으로 저장] → 카드 본문이 즉시 바뀐다.
  LLM 미준비면 `llmReadyReason` 문구. 다른 생성이 진행 중(59 `BUSY`)이면 "끝나면 다시 보내세요"(자동 재시도 없음).
- C: 우클릭 메뉴 항목 1개. 창은 싱글턴(두 번 눌러도 1개), 메인의 리포트 뷰는 닫힌다(공간 회수). 별도 창에서 생성·저장한 요약이 메인 창에도 보인다(역방향도).

## 2. 현황(근거)

- 스코프는 단일 `<select>`(`ReportView.tsx:37, :100-111`) — `scope === "all" | projectId`. 카드는 `scoped.map(p => <ReportCard project={p}/>)`(`:179-194`).
  카드가 프로젝트 **1개**를 전제한다: `useCommitsBetween(project.id)`·`usePrompts(project.path)`(`ReportCard.tsx:46-56`), 키 `reportKey(project.id, …)`(`:63`).
- 프롬프트 조립 `buildMessages`(`lib/report.ts:154-194`): 커밋 줄에 **날짜가 없다**(`- sha7 subject — body`), 프롬프트만 `[MM-DD HH:MM]`. 예산은
  `8192` 하드코딩(`:104-105`) — 설정 `llmContext`(`ipc.ts:258`, 2048..32768)를 안 본다. 형식은 `## 한 줄 요약 / ## 한 일 / ## 진행 중·막힌 것 / ## 다음 할 일`(`:181-182`).
- AI 대화 UI **0건** — `role: "assistant"` 메시지를 만드는 곳이 없다(grep). `chat(messages, onToken, opts)`(`llm.ts:55-77`)는 이미 히스토리 배열을 받는다.
  `BUSY` 코드(`ipc.ts:875-877`)는 61이 3초 폴링으로 흡수한다.
- 별도 창: 모아보기는 전용 라벨 + Rust 커맨드(`lib.rs:464-488`, PTY 소유권 때문). 폴더 창(66)은 **`open_doc_window`를 그대로** 타고 localStorage 항목의
  `folder` 필드로 `DocWindow`가 분기한다(`floating.ts:156-180`, `DocWindow.tsx:44-54`). `doc-*`는 이미 `is_secondary_window`(`lib.rs:653-657`)라 메인과 수명을 같이 한다.
- 우클릭 메뉴 골격: `ViewerFileTabs.tsx:51-56`(로컬 state + `useOccludesWebview` + Esc) · `:120-126`(백드롭) · `:165-166`("새 창으로 열기" 어휘).
  `AggregateButton`은 메뉴 없이 우클릭 즉시 창(`TitleBar.tsx:266-269`).
- 요약 저장은 Rust 단일 state(`report.rs:400-437`) — 창이 몇 개든 `reports.json`은 한 프로세스가 쓴다. 다만 `["reports"]`가 `staleTime: Infinity`(`queries/index.ts:1251-1257`)라
  **다른 창의 저장을 이 창은 모른다.**
- 별도 창(`DocWindow`)에는 `SettingsDialog`가 없다 — 카드의 "설정 열기"(`ReportCard.tsx:229`)는 그 창에서 무반응이 된다(`openSettings`는 창별 스토어).

## 3. 설계

### 3.1 A — 다중 선택 · 종합 카드 · 날짜별 3줄

**스코프 선택** (`ReportView.tsx`, 내부 `ScopePicker`): `<select>` → 버튼 `프로젝트 N개 ▾`(전체면 `전체`) + 드롭다운 체크리스트(맨 위 "전체" 토글, 아래 프로젝트 체크).
`FavoritesButton`(`TitleBar.tsx:114-`)의 열림·바깥 클릭 골격 복제, `useOccludesWebview(open)`. 상태 `scope: "all" | string[]`, 저장 `gp:report-scope`(JSON).
초기값: 저장값 → 없으면 `[selectedProjectId]`(메인) / `"all"`(별도 창 — `selectedProjectId`가 없다). 등록 해제된 id는 렌더 시 걸러 낸다(`all.filter`).

**카드 일반화** (`ReportCard.tsx`): `project: Project` → `projects: Project[]`. 데이터는 `useQueries`로 —
`useCommitsBetweenMany(projects, …)`(신설, 키는 `useCommitsBetween`과 **같은** `["commits-between", id, since, until, mine]`)와 기존 `usePromptDumps`(키가 `usePrompts`와 같다).
같은 키라 개별 카드와 종합 카드가 IPC를 두 번 안 태운다. `list`/`items`는 프로젝트별 배열을 그대로 들고(`sources: {project, commits, prompts}[]`), 헤더 카운트는 합.
`loading = queries.some(isPending)`, `empty = 전부 0`. 종합 헤더: `ProjectLogo` 3개까지 겹쳐 그리고 "종합 · N개 프로젝트", 스트라이프는 `NO_COLOR`.

**저장 키** (`lib/report.ts`): `scopeKey(projects)` = 1개면 `id`, 2개 이상이면 `multi:<fnv16(sorted ids join "+")>`. `fnv16`은 `floating.ts:136-147 folderWindowId`의 해시를
`export function fnv16(s)`로 이름만 바꿔 공유(폴더 창은 그대로 그것을 부른다). `reportKey(scopeKey, period, since)` — 기존 함수·`reports.json` 형식 불변.
입력 해시 `inputHash`는 프로젝트별 sha·at를 **id 순으로 이어 붙여** 계산(순서가 흔들리면 "입력이 바뀜"이 헛뜬다).

**뷰 구성**: `scoped.length >= 2`이면 `<ReportCard projects={scoped}/>`를 맨 위에, 그 아래 `scoped.map(p => <ReportCard projects={[p]}/>)`.
"모두 생성" 배치는 **개별 카드만**(기존 큐 그대로) — 종합은 수동. 종합을 큐에 넣으면 개별 N개 뒤에 종합이 한 번 더 도는 셈이라 시간이 두 배다(§7).

**프롬프트 — 날짜별 그룹** (`buildMessages` 재작성):
```
system: 너는 개발자의 작업 일지를 쓰는 비서다. 아래 커밋과 프롬프트를 근거로 {언어}로 {기간 라벨} 작업을 요약해라.
        형식: ## 한 줄 요약 / ## 날짜별 — 활동이 있는 날짜마다 "### YYYY-MM-DD (요일)" 아래 불릿 **정확히 3개**(각 1문장, 그 날 한 일,
        커밋 해시 7자리 인용{, 여러 프로젝트면 [프로젝트명] 접두}) / ## 다음 할 일 (3개 이하).
        근거 없는 내용은 쓰지 마라. 프롬프트는 사용자가 AI에게 한 요청이다.
user:   프로젝트: {names} ({since}~{until})

        ### 2026-09-08 (월)
        커밋 3건
        - [gitpervisor] 4232f78 릴리스: v0.5.3 — …
        프롬프트 12건
        - [15:54] 야 나는 여러 프로젝트 선택해서도 …
        …외 4건

        ### 2026-09-09 (화)
        …
```
- 날짜: 커밋 `authoredAt`(`%aI`, 오프셋 포함) → `ymd(new Date(…))`, 프롬프트 `at`(UTC) → 같은 변환 — 둘 다 **로컬 날짜**(`report.rs` 헤더 주석의 원칙, 프론트도 로컬).
  `[프로젝트명]` 접두는 `sources.length > 1`일 때만.
- "진행 중·막힌 것" 섹션은 뺀다 — 날짜당 3줄이 그 자리를 대신한다. `## 한 줄 요약`은 유지(e2e 48 ④의 폴링 문자열).
- **예산**: `ctx = settings.llmContext`(기본 8192), `maxTokens = maxTokensFor(period)` = `{day: 768, week: 1536, month: 2048}`(월간 최대 31일 × 3줄 ≈ 1,900 토큰),
  `CHAR_BUDGET = max(1500, (ctx − maxTokens − 400) × 1.5)`. 활동 날짜 수로 **균등 분배**(`perDay = CHAR_BUDGET / days`), 날짜 안에서 커밋 50% 우선·나머지 프롬프트 —
  기존 `fit()`을 날짜 단위로 부른다("…외 N건"은 날짜마다). 전체 건수 상한 60/80(최신순)은 그 전에 적용. 오래된 날짜가 통째로 사라지지 않게 하려는 배분이다
  — 기존 "최신순 전체 예산"은 월간 앞쪽 날짜를 먹어 치운다.
- `ReportCard`가 `settings.llmContext`와 `maxTokensFor(period)`를 `chat` 옵션에 넘긴다(지금은 1024 고정 `:134`).
- 저장돼 있던 옛 형식 요약은 그대로 보이고 [다시 생성]으로 새 형식이 된다 — 마이그레이션 없음.

### 3.2 B — 우측 AI 채팅 패널 (`components/report/ReportChat.tsx` 신설)

**배치**: `ReportView` 루트를 `flex-row`로 — 좌 기존 내용(`flex-1 min-w-0`), 우 `<aside className="w-[min(380px,45%)] shrink-0 border-l border-edge">`.
열림 `gp:report-chat-open`. 리포트 뷰 안의 일반 레이아웃이라 점유 계약 대상이 아니다(60과 같은 층 — 00-INDEX §11.3).
타이틀바에 아이콘을 늘리지 않는다 — 열기는 카드 버튼과 뷰 상단 바 우측의 `MessageSquare` 토글(패널이 닫혀 있을 때만 보인다).

**상태**(`ReportView` 로컬, 창별): `chatCtx: {key, title, sources, period, since, until, body, hash} | null`, `messages: ChatMsg[]`(system 제외), `busy`, `note`.
카드 [AI에게 묻기](`MessageSquare`, 헤더 우측 [요약 생성] 왼쪽) → `onAsk(ctx)` → `chatCtx` 교체 + `messages = []` + 패널 열림. **다른 카드에서 누르면 대화가 초기화**된다
(패널 헤더 칩이 "gitpervisor · 2026-09-08"처럼 컨텍스트를 보여 주므로 오해가 없다). 상단 ⊕ 새 대화 = `messages = []`(컨텍스트 유지), ✕ = 패널 닫기(컨텍스트·대화 유지).
컨텍스트 없이 열면 빈 상태 "카드의 [AI에게 묻기]를 누르면 그 리포트를 두고 대화합니다 — 그냥 물어봐도 됩니다"(일반 대화 허용, system은 첫 문장만).

**메시지 조립**(`lib/report.ts chatMessages(ctx, history, userText, language)` — 순수 함수):
```
system: 너는 개발자의 작업 리포트를 돕는 비서다. {언어}로 답해라. 근거 없는 내용은 쓰지 마라.
        사용자가 요약의 수정을 요청하면 **요약 전체를 같은 형식(## 한 줄 요약 / ## 날짜별 / ## 다음 할 일)으로 다시 써라** — 부분만 주지 마라.
        ### 현재 요약
        {body ≤ 3,000자}
        ### 근거
        {buildMessages의 user 블록 — 예산 CHAR_BUDGET × 0.5}
history: 최근 8개(user/assistant 번갈아) — 그 이전은 버린다(ponytail: 슬라이딩 윈도, 요약 압축은 업그레이드 경로)
user:    입력
```
호출: `chat([...], onToken, {maxTokens: maxTokensFor(period), temperature: 0.3, signal, onProgress})`. 스트리밍은 마지막 assistant 메시지를 제자리 갱신
(`TranslateCard`의 `setOut(p => p + d)`와 같은 방식), 진행 문구는 `onProgress`(모델 로드 20~60초 — 59 §6). [취소] = abort.
`BUSY` 거절 → 마지막 assistant 자리에 "다른 생성이 진행 중입니다 — 끝나면 다시 보내세요", 입력창의 글은 유지(사용자가 보고 있으니 61의 폴링은 넣지 않는다).

**수정본 → 요약으로 저장**: 각 assistant 메시지 하단 [요약으로 저장](`Save`). `/^## /m`이 있을 때만 활성(그 외 툴팁 "요약 형식이 아닙니다 — '요약을 다시 써 줘'라고 요청하세요").
저장 = `useSetReport().mutate({key: ctx.key, record: {text, generatedAt: now, inputHash: ctx.hash, model}})` — 입력은 안 바뀌었으니 해시는 카드 것을 그대로.
**카드가 즉시 바뀌어야 한다**: `ReportCard.body = text || saved?.text`(`:105`)라 카드에 스트리밍 잔여 `text`가 남아 있으면 옛 본문이 계속 보인다 →
`ReportCard`에 `useEffect(() => setText(""), [saved?.generatedAt])` 1줄(저장본이 새로 오면 로컬 텍스트를 비운다). 이 효과가 없으면 "저장했는데 안 바뀐다"가 된다.

**입력**: `textarea` 3줄 고정, Enter 전송·Shift+Enter 줄바꿈, 빈 문자열 무시. 렌더: assistant는 `MarkdownView`, user는 `whitespace-pre-wrap`. 스크롤은 새 토큰마다 바닥 고정(사용자가 위로 올렸으면 유지 — `scrollTop + clientHeight ≥ scrollHeight − 24`일 때만).
LLM 미준비: 패널 본문에 `llmReadyReason` + [설정 열기] — **별도 창에서는 버튼 대신 "메인 창의 설정 › AI에서 준비하세요"**(`IS_DOC_WINDOW` 분기; 카드의 "설정 열기"도 같은 분기를 탄다 — §2 마지막 항목).
대화는 저장하지 않는다(창을 닫으면 사라진다 — §7).

### 3.3 C — 우클릭 "새 창으로 열기" · 별도 창

**메뉴** (`TitleBar.tsx ReportButton`): `onContextMenu` → `setMenu({x, y})`, `useOccludesWebview(!!menu)`, Esc·백드롭 클릭 닫기, 항목 1개 `ExternalLink` "새 창으로 열기"
— `ViewerFileTabs.tsx:51-56, :120-126` 골격을 그대로. 우클릭 즉시 열기(모아보기 방식)가 더 짧지만 요구가 "우클릭하고 새창으로 열기 클릭"이고, 파일트리·뷰어 탭의 같은 어휘와 맞다.
항목 클릭 → `openReportWindow()` + `useUi.setState({reportOpen: false})`.

**창** (`lib/floating.ts openReportWindow`): 폴더 창(66)과 같은 경로 — `docs["report"] = {projectId: "", path: "작업 리포트", report: true}` 적고
`invoke("open_doc_window", {docId: "report", title: "작업 리포트", origin, size: [1240, 820]})`. 라벨 `doc-report` **고정 id → 싱글턴**(Rust가 있으면 포커스만, `lib.rs:517-520`).
`DocTarget.report?: true` — `edit`·`folder`처럼 **옵셔널**(옛 localStorage 항목 호환). Rust 변경 없음: `doc-` 접두라 `is_secondary_window`·Destroyed 훅 모두 이미 맞다.

**분기** (`DocWindow.tsx:44-54`): `target?.report` → `<ReportWindow/>` = `FloatTitleBar title="작업 리포트" badge="리포트"` + `lazy(() => import("./components/report/ReportView"))`
(폴더 창과 같은 이유 — 정적 import면 리포트 청크가 모든 doc 창에 딸려 간다) + `<Toasts/>`(`useSetReport`의 오류 토스트). 테마 효과(`settings.theme → dataset.theme`) 1줄.
`ReportView`는 prop 없이 그대로 — 스코프는 `gp:report-scope`가 창 간 공유, 기간은 일간·오늘(§7). 별도 창엔 `selectDiff` 경로가 없어 "파일 열면 닫힘" 규칙은 무관.

**창 간 요약 동기화**: `report_set`·`report_delete`(`report.rs:400-437`)가 저장 뒤 `app.emit("report://changed", {key, record: Option<ReportRecord>})`(`tauri::Emitter`).
`useReports`(`queries/index.ts:1251`) 안에서 `listen`하여 `setQueryData(["reports"], old => record ? {...old, [key]: record} : omit)` — 훅 안 구독이라 창(QueryClient)마다 따로 붙고,
리포트 뷰가 없는 창은 훅이 없어 리스너도 없다. 보낸 창도 자기 이벤트를 받아 같은 값을 한 번 더 놓는다(멱등). 리스너 정리는 `DocWindow.tsx:111-129`의 `disposed` 패턴.

**메인 창 상태**: 창 열림을 추적하지 않는다 — 모아보기의 `aggregateWindowOpen`은 PTY 소유권(소비자 1개) 때문이었고 리포트는 읽기 데이터라 **두 곳에 떠 있어도 무방**하다.
메인 [리포트] 클릭은 언제나 메인 안에서 연다.

## 4. 변경 목록

| 파일 | 변경 | 규모 |
|---|---|---|
| `src/lib/report.ts` | `scopeKey`·`maxTokensFor`·날짜별 `buildMessages`(sources·ctx)·`chatMessages` | ≈ +130 / −40 |
| `src/lib/floating.ts` | `DocTarget.report?`·`openReportWindow`·`fnv16` export(이름만) | ≈ +25 |
| `src/components/report/ReportView.tsx` | `ScopePicker`·`gp:report-scope`·종합 카드·`flex-row` + 채팅 상태·슬롯 | ≈ +120 |
| `src/components/report/ReportCard.tsx` | `projects[]`·`useQueries`·[AI에게 묻기]·저장 감지 효과·doc 창 안내 분기·`maxTokensFor` | ≈ +60 / −20 |
| `src/components/report/ReportChat.tsx` | 신설 | ≈ +220 |
| `src/components/TitleBar.tsx` | `ReportButton` 우클릭 메뉴 | ≈ +45 |
| `src/DocWindow.tsx` | `report` 분기(`ReportWindow`) | ≈ +25 |
| `src/queries/index.ts` | `useCommitsBetweenMany`·`useReports` 이벤트 구독 | ≈ +35 |
| `src-tauri/src/report.rs` | `report_set`/`report_delete` emit | ≈ +8 |
| `src/main.tsx` | DEV `__gpv.report = {buildMessages, chatMessages}`·`openReportWindow` 노출 | +2 |
| `tests/e2e/suites/48-report.mjs` | ⑦~⑪ 추가 | ≈ +110 |

## 5. 검증

### 5.1 e2e 48 확장(기존 ①~⑥ 뒤)
7. 두 번째 임시 레포(오늘 커밋 1) 등록 → 스코프 드롭다운에서 둘 체크 → 카드 **3장**, 맨 위 헤더 "종합 · 2개 프로젝트", 카운트 "커밋 2 · 프롬프트 2"(합). `localStorage["gp:report-scope"]`에 두 id.
8. `__gpv.report.buildMessages({sources: 2개, period: "week", …})` — LLM 없이 조립만: user에 `### <today>` 섹션, 커밋 줄 `[<repo명>]` 접두, system에 "정확히 3개"; `sources` 1개면 접두 없음. `ctx: 2048`이면 예산이 1,500 밑으로 안 내려감(`…외 N건` 등장).
9. 종합 카드 [AI에게 묻기] → `aside` 등장, 헤더 칩에 "종합" · 기간. LLM 미준비면 이유 문구 존재 단언 후 skip. 준비 시(47과 같은 게이트) "한 줄로 요약해" 전송 → assistant 메시지 폴링 120s → [요약으로 저장] 활성 여부가 `/^## /m`과 일치. 저장 → 카드 본문 = 그 답변(스트리밍 잔여 없음).
10. `__gpv.openReportWindow()` → `getAllWebviewWindows()`에 `doc-report`(34의 창 단언 방식), 메인 `reportOpen === false`. 한 번 더 호출 → 여전히 1개. finally에서 그 창 `close()`.
11. 원시 `invoke("report_set", {key: "e2e|day|<today>", …})` → 메인 `queryClient.getQueryData(["reports"])`에 그 키 폴링 5s(이벤트 경로). `report_delete` → 사라짐.

### 5.2 실기
- 1240×820 창: 채팅 열린 상태의 카드 폭, 720px까지 좁혔을 때 `min(380px,45%)`가 카드를 짓누르지 않는지.
- 월간 × 프로젝트 5개 종합: 조립 문자열 길이가 예산 안인지(콘솔), 응답 `truncated`(`ChatDone.truncated`)가 뜨는지 — 뜨면 `maxTokensFor.month` 상향 또는 §7 맵-리듀스.
- 4B 모델의 "정확히 3줄" 준수율 10회 — 2회 이상 어기면 system 문구 조정(후처리로 줄 수를 맞추지 않는다 — 내용을 지어내게 된다).
- 별도 창에서 요약 생성 → 메인 카드가 바뀌는지, 반대 방향도. 별도 창 LLM 미준비 문구가 버튼 없이 뜨는지.
- 채팅 중 카드 [요약 생성]을 누르면 `BUSY` 문구가 채팅에, 반대로 채팅 중 카드 버튼은 기존대로 오류 note.

## 6. 위험

- **3줄 강제는 모델 순종 문제** — 1.7B는 지키지 않는다(60 §8 "요약 품질 주의"). 활동이 커밋 1개뿐인 날은 억지 3줄이 나올 수 있다(§7).
- **월간 종합의 예산**: 31일 × 5프로젝트면 날짜당 ≈ 300자 — 제목만 남고 "…외 N건"이 매 날짜에 붙는다. 맵-리듀스(프로젝트별 저장 요약 → 종합)는 60 §3.3과 같은 업그레이드 경로.
- 채팅 저장이 카드의 로컬 `text`에 가려진다 → §3.2의 효과 1줄이 없으면 재현된다(정적 검증으론 안 보이는 유형 — e2e ⑨ 마지막 단언).
- `chatMessages`의 근거 블록 + 히스토리 8개가 `llmContext` 2048 설정에서는 넘친다 → `CHAR_BUDGET × 0.5`도 `max(800, …)`로 바닥.
- `report://changed`는 전 창 브로드캐스트 — 페이로드에 `record` 전체(≈2KB)를 싣는다. 3,000건 상한과 무관하게 건당 1회라 무시할 크기.
- `open_doc_window`의 `title`은 생성 시점 고정(`DocWindow.tsx:77` 주석) — "작업 리포트"로 충분.
- `fnv16` 충돌은 "다른 조합이 같은 저장 키를 쓴다" — 32bit×2로 실사용 조합 수에서 무시. 충돌해도 결과는 요약이 뒤바뀌는 것이 아니라 "입력이 바뀜" 뱃지(해시가 다르다).

## 7. 열린 질문

| 질문 | 기본값 |
|---|---|
| 우클릭 메뉴(1항목) vs 모아보기처럼 우클릭 즉시 열기 | 메뉴(요구 문구·파일트리 어휘). 모아보기도 메뉴로 통일은 범위 밖 |
| 날짜당 "정확히 3줄" vs "3줄 이하"(활동이 적은 날) | 정확히 3줄(요구). 억지 문장이 보이면 "활동이 적은 날은 3줄 이하"로 완화 — 문구 1곳 |
| 종합 카드도 "모두 생성" 배치에 포함 | 제외 — 개별 뒤 종합 1회 수동 |
| 채팅 대화 영속(`chats.json`) | 메모리(창 닫으면 소멸). 저장할 가치가 있는 건 [요약으로 저장]이 이미 담는다 |
| 채팅 프리셋 칩("더 짧게"·"존댓말"·"영어로") | 후속 — placeholder 예문 1줄로 대신 |
| 별도 창 초기 기간·기준일(메인 상태 승계) | 일간·오늘. 승계는 `DocTarget.report`를 객체로 바꾸면 +6줄 |
| 종합 카드 저장 키에 프로젝트 이름 대신 해시 | 해시(`reports.json` 키 길이·이름 변경 무관) |

## 8. 구현 결과 (2026-09-11)

**구현 완료 · e2e 통과(미커밋).** A·B·C 셋 다 설계대로다 — 다중 선택 종합 카드, 우측 채팅(수정본 저장),
[리포트] 우클릭 → 별도 창. 아래는 파일별 요약과, **설계와 어긋난 지점 · 검증에서만 잡힌 것**이다.

- `src/lib/report.ts` — `scopeKey`·`maxTokensFor`·`chatMessages` 신설, `buildMessages`를 날짜 섹션 조립으로
  재작성(`evidenceBlock`), `inputHash`가 `ReportSource[]`를 받는다.
- `src/components/report/ReportCard.tsx` — `project` → `projects: Project[]`, `useCommitsBetweenMany`,
  [AI에게 묻기], 저장본 도착 시 로컬 `text` 비우기(§3.2의 1줄), doc 창 안내 분기.
- `src/components/report/ReportChat.tsx` (신설) — 스트리밍·취소·BUSY·[요약으로 저장]·컨텍스트 칩.
- `src/components/report/ReportView.tsx` — `ScopePicker`(다중 체크), `gp:report-scope`, 종합 카드 슬롯,
  `flex-row` + 채팅 패널, `chatCtx`·`messages` 보유.
- `src/components/TitleBar.tsx` — `ReportButton` 우클릭 메뉴 1항목(`ViewerFileTabs` 골격).
- `src/lib/floating.ts` — `DocTarget.report?`·`openReportWindow`·`fnv16` export(이름만).
- `src/DocWindow.tsx` — `report` 분기(`ReportWindow`: `FloatTitleBar` + lazy `ReportView` + `Toasts`).
- `src/queries/index.ts` — `useCommitsBetweenMany`, `useReports` 안의 `report://changed` 구독.
- `src-tauri/src/report.rs` — `report_set`/`report_delete`가 `report://changed` 브로드캐스트.
- `src-tauri/src/commands/settings.rs` — `set_settings`가 `settings://changed` 브로드캐스트(**설계에 없던 파일**, 아래).
- `src/main.tsx` — DEV `__gpv.report`·`openReportWindow` 노출 + 리포트 창 diff 프리페치 제외.
- `tests/e2e/suites/48-report.mjs` — ⑦~⑪ 추가(+≈470줄).

### 설계와 다른 점

| 다른 점 | 이유 |
|---|---|
| **커밋 날짜 버킷은 `authoredAt.slice(0,10)`(오프셋 날짜)** — §3.1은 `ymd(new Date(…))`(로컬)라고 적었다 | 설계가 근거로 든 "`report.rs` 헤더 주석의 원칙"이 실제로는 **정반대**다: 커밋은 `%aI` 오프셋의 날짜로 세고(`date_naive()`), 로컬 변환은 전사 프롬프트에만 한다. 로컬로 버킷하면 UTC로 찍힌 커밋(CI·해외 협업자)이 **기간 밖 날짜 머리글**을 만들고 잔디·카드 카운트와 하루씩 어긋난다. 설계의 *의도*(Rust와 같은 날짜계)를 따르고 수단만 고쳤다 |
| `group()`의 "최소 1줄" 바닥 제거 + 합이 넘으면 **오래된 날짜부터 섹션을 접는다**(`…이전 N일 생략`) | §3.1은 "기존 `fit()`을 날짜 단위로 부른다"였는데, 그 바닥은 전역 2회짜리였다. 날짜마다 부르면 바닥이 **날짜 수 × 2**로 곱해져 예산이 깨진다(아래 표 1번) |
| `chatMessages(ctx, history, userText, language, llmCtx)` — §3.2의 4인자와 다르다 | §6의 "ctx 2048에서 바닥 800자"가 성립하려면 설정값이 필요하다. 호출자는 `ReportChat` 하나 |
| `set_settings`에 `settings://changed` emit 추가(§4 변경 목록에 없는 파일) | 별도 창의 `settings`가 창을 연 시점에 얼어붙어, §3.2가 그 창에 띄우라고 정한 "메인 창의 설정 › AI에서 준비하세요"가 **막다른 길**이었다(아래 표 2번) |
| 전체 건수 상한(60/80)을 날짜 분배보다 **먼저** 적용 — 설계 그대로 두었다 | 바쁜 달에는 §3.1이 막으려던 "오래된 날짜 통째 소실"이 그대로 난다(미해결, 아래) |

### 검증에서 잡힌 것 (리뷰 확정 지적 → 수정)

**정적 검증(tsc·cargo test·컴파일)으로는 하나도 안 보이는 유형 — 전부 실행 경로·시점·다중 창 문제다.**

| 지적 | 수정 |
|---|---|
| (중) **날짜별 예산 바닥이 날짜 수만큼 곱해져 `CHAR_BUDGET`을 넘긴다.** `group()`이 예산이 음수여도 첫 줄을 남기는데 그걸 날짜마다 커밋·프롬프트 2회 부른다. 실측: 기본 ctx 8192·월간 30일이면 예산 8,616자에 13,000자 — `n_ctx` 자체를 넘겨 서버가 400으로 거절하거나 앞쪽(오래된 날짜)을 자른다. §3.1의 목적이 정반대로 뒤집힌다 | 바닥 제거(`kept.length > 0`) → 한 줄도 못 실으면 `커밋 N건 (내용 생략)`. 그래도 합이 넘으면 **오래된 날짜부터 섹션을 접는다**. e2e ⑧에 활동 10일·ctx 2048 입력으로 `길이 ≤ 1,500 × 1.1` **상한** 단언 추가(실측 602자, 수정 전 ≈3,700자) |
| (중) **별도 리포트 창의 `settings`·`projects`가 창을 연 시점에 얼어붙는다.** `staleTime: Infinity`인데 `settings://changed` 구독은 메인 전용 `attachRepoEvents`에만 있고, Rust `set_settings`는 애초에 emit을 안 했다. 모델을 고르고 돌아와도 그 창은 계속 "…모델을 고르세요" | `set_settings`가 emit(1줄, `server.rs`의 Vulkan 폴백과 같은 패턴) + `ReportWindow`가 `listen` → `["settings"]` 무효화. 프로젝트 목록은 이벤트가 없어 **창 포커스 복귀 시** `["projects"]` 무효화. 실기 확인: 메인에서 테마 변경 → 별도 창이 따라옴 |
| (중) **[요약으로 저장] 뒤에도 채팅의 "### 현재 요약"이 저장 전 본문으로 고정.** `ChatContext.body`가 [AI에게 묻기]를 누른 순간의 스냅샷이라, ⊕ 새 대화로 "존댓말로 바꿔 줘"를 시키면 모델이 **옛 본문**을 다시 써서 방금 저장한 것을 되돌린다 | `ReportChat`이 `useReports()`로 저장본을 읽어 `body`만 갈아 끼운다 — 카드가 정본으로 삼는 것과 같은 출처 |
| (낮음) **BUSY·오류·"취소됨" 문구가 assistant 턴으로 히스토리에 실려 모델에 간다.** 4B 모델이 자기가 그렇게 답했다고 믿고 되풀이한다 | 그 문구를 `notices` ref에 적어 두고, **모델에 보낼 때만** 그 assistant 턴과 짝인 직전 user 턴을 걷어 낸다(화면 목록은 그대로 — 사용자가 본 것을 지우지 않는다) |
| (낮음) **⊕ 새 대화가 스트리밍 중에도 눌리며 진행 중 답변을 끊지 않는다.** 델타는 빈 배열에 버려지는데 스피너·[취소]는 남고 LLM 슬롯을 계속 문다 | ⊕가 `abortRef.current?.abort()`를 먼저 부른다(컨텍스트 교체가 이미 하던 것과 같은 이유) |
| (낮음) **단일 프로젝트도 해시 문자열이 바뀌어 v0.5.3 저장본 전부에 "입력이 바뀜"이 헛뜬다** — `inputHash`가 프로젝트 id를 앞에 붙였다 | 2개 이상일 때만 id 접두 — 1개면 60의 문자열과 바이트 단위로 같다 |
| (낮음) **커밋 날짜 버킷이 Rust 필터와 어긋나 기간 밖 날짜 머리글이 생긴다** | 위 "설계와 다른 점" 1번 |
| (낮음) **`ScopePicker`가 등록 해제된 id를 세고 비교한다** — "프로젝트 3개"인데 카드는 2장, 전부 골라도 "전체"로 안 접힌다 | `ids`를 `all` 기준으로 한 번 걸러 라벨·비교 모두 그 값으로. 실기 확인: 저장값 2개(1개는 등록 해제) → 라벨 "프로젝트 1개" · 카드 1장 |
| (낮음) **리포트 창도 뜰 때마다 실패할 diff 프리페치 IPC를 태운다**(`projectId`가 빈 문자열) | `main.tsx`의 폴더 창 가드에 `!t.report` 추가 |
| (낮음) **`["reports"]` 최초 로드 중 도착한 `report://changed`가 버려진다** — 그 스냅샷이 쓰기 이전이면 그 창엔 영영 없다("모두 생성" 중에 리포트 창을 여는 순서) | `old`가 없으면 **다시 읽는다**(`invalidateQueries` — 진행 중 fetch를 취소하고 재조회) |
| (낮음) **`MAX_REPORTS` 초과로 퇴거된 키는 이벤트가 없어 다른 창 캐시에 유령으로 남는다** | 퇴거 키마다 `emit_changed(&app, &k, None)`(리스너의 `record: null` 분기가 이미 처리한다) |
| (e2e) **⑨ 채팅이 실패해도 "답변"으로 통과** — 오류·BUSY 문구가 assistant 자리에 앉고 저장 버튼까지 달고 나와, 전송 경로가 통째로 고장 나도 pass+skip으로 초록 | 답변 텍스트가 안내·오류 문구(`NOT_AN_ANSWER`)가 아님을 단언, skip 사유에 실제 텍스트 앞 80자를 남긴다 |
| (e2e) **⑧이 날짜 1개짜리 입력만 써 §3.1의 핵심 변경(날짜별 균등 분배)을 전혀 재현하지 않는다** — `perDay = budget`으로 되돌리거나 `.sort()`를 빼도 전부 통과 | 두 날짜 × 20건 입력 추가: 두 섹션이 **모두** 남고 각각 "…외 N건"이 붙으며 **오래된 날짜가 먼저**임을 단언 |
| (e2e) **사용자의 `gp:report-scope`·`gp:report-chat-open`을 저장하지 않고 지운다 — 원복이 아니라 소거** | ③ 직전에 읽어 두고 finally에서 되돌린다(14의 `gp:project-colors`, 40의 `gp:ie:toggles`와 같은 처리) |
| (구현 중) 개별 카드에 넘기는 `projects={[p]}`가 렌더마다 새 배열이라 `sources` 메모가 매번 깨지고 입력 해시 SHA-1이 렌더마다(채팅 스트리밍 중엔 토큰마다 N장) 다시 돈다 | `singles` `useMemo`로 고정 |
| (구현 중) 사이드바 `ProjectItem`도 `data-project-id`를 달고 있어 e2e가 체크박스 대신 그 `div`를 잡는다 | 셀렉터를 `input[data-project-id=…]`로 |

### e2e 결과

- `GPV_E2E_ONLY=48` → **47 pass / 0 fail / 0 skip**(+ teardown 8 = 55, ALL GREEN). LLM이 준비돼 있어
  ⑨의 생성·전송·저장 경로까지 skip 없이 돌았다.
- 회귀 `GPV_E2E_ONLY=14,34,60` → **125 pass / 0 fail / 1 skip**(ALL GREEN). skip 1건은 14의
  "숨김 셀 칩 메뉴 — 개별 칩 없음(탭 모으기 모드)"으로, 사용자의 터미널이 탭 모으기 모드라 나는
  환경 조건부 항목이다(기준선 그대로).
- Rust `cargo test --lib` → **269 passed / 0 failed / 2 ignored**. `npx tsc --noEmit` 0.

### 실기로 확인한 것

- 메인 리포트 뷰: 2개 체크 → 종합 1 + 개별 2, 종합 카운트 = 합, "모두 생성" 등장.
- 종합 카드 [AI에게 묻기] → 우측 패널, 칩 "종합 · 2개 프로젝트 · 날짜", ⊕/✕, 하단 3줄 textarea.
- 별도 창 1240×820 · 720px(채팅 열림): `min(380px,45%)`가 카드를 짓누르지 않고 문서 가로 스크롤 없음.
- **메인에서 설정을 바꾸면 별도 창이 따라온다**(테마로 관측 — emit → listen → 무효화 → 재조회 → 렌더 전 구간).
- **등록 해제된 id가 저장값에 섞여 있어도** 라벨("프로젝트 1개")과 카드 수(1)가 일치한다.
- BUSY 양방향(카드 생성 중 채팅 전송 / 채팅 중 카드 [요약 생성]) — 로컬 llama 경로에서만.

### 미검증 · 남은 것

- **전체 건수 상한(60/80)이 날짜 분배보다 먼저 적용된다** — 바쁜 달에는 §3.1이 막으려던 "오래된 날짜 통째
  소실"이 그대로 난다. 실측(2026-08-12~09-11, 프로젝트 5개, 커밋 181·프롬프트 1,312): 날짜 섹션이 31개가
  아니라 **7개**만 남고 예산은 한참 남는다(구속하는 건 예산이 아니라 60/80). 설계가 "상한은 그 전에 적용"이라
  못박아 두어 그대로 뒀다 — 고치려면 상한도 날짜별로 나누거나 §7의 맵-리듀스로 간다.
- 4B 모델의 "날짜당 정확히 3줄" 준수율 10회 측정(§5.2)은 하지 않았다. e2e ⑨에서 관측된 1회는 형식을 지켰다.
- 외부 서버(OpenAI 호환) 경로가 BUSY 대신 다른 코드를 주는지 미검증.
- `gp:report-chat-open`은 별도 창이 **항상** 물려받지는 않는다(WebView2 프로세스 간 DOM storage 전파 지연으로
  보인다). `gp:report-scope`는 정상 전달된다. §3.3의 "초기값만 공유"와 모순은 아니나 보장되지 않는다.
- `usePrompts`·`useCommitsBetween`(`queries/index.ts`)은 호출자 0인 죽은 코드다(설계 변경 목록에 삭제가 없어 남겼다).
- `lib/floating.ts`의 `DOC_MAX` 잘라내기 블록이 3벌로 복제돼 있다 — `saveDoc(id, target)` 하나로 접을 수 있으나
  기존 두 함수를 건드리는 리팩터라 범위 밖.
- 종합 카드를 "모두 생성" 배치에서 제외한다는 결정은 코드로만 확인했고 e2e 단언이 없다(§5.1에도 항목이 없다).
