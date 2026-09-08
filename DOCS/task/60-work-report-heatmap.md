# 태스크 60 — 작업 리포트: 프로젝트별 일간/주간/월간 요약(커밋 + Claude 프롬프트 히스토리) + 잔디(활동 히트맵)

> 상태: **설계** (2026-09-07) · 대상: gitpervisor · 근거: 코드 실측 2026-09-07 · **선행: 59(LLM 계약 `lib/llm.ts`)** ·
> 선례: 모아보기 전체 뷰(`App.tsx:166`, `TitleBar.tsx:94-`), `claude_usage.rs`(트랜스크립트 경로 규약), `get_log`(`log.rs`) ·
> 규모 **L**(Rust 커맨드 3 + 뷰 1). 구현 시 히트맵 색은 `dataviz` 스킬을 먼저 읽는다(시퀀셜 팔레트·접근성).

## 1. 요구사항

1. 각 프로젝트의 **커밋 내용**과 **프롬프트 히스토리**를 바탕으로 로컬 LLM이 **일간·주간·월간 작업 요약**을 만든다.
2. **잔디**: 지난 1년의 날짜별 활동(커밋·프롬프트)을 GitHub 기여 그래프처럼 보여준다. 칸을 클릭하면 그 날(주·월)의 요약으로 간다.
3. 요약은 저장돼 다시 열면 즉시 보이고, 입력이 바뀌었으면 "다시 생성"을 제안한다.

받아들이는 조건:
- 타이틀바 버튼 → 전체 폭 "리포트" 뷰(모아보기와 같은 층). 상단: 프로젝트(전체/개별)·기간(일/주/월)·"내 커밋만" 토글. 중단: 히트맵.
  하단: 선택 기간의 프로젝트 카드(커밋 N·프롬프트 N·[요약 생성]·요약 본문 마크다운).
- 프롬프트 히스토리 = **Claude Code 트랜스크립트의 사용자 메시지**(§2). 앱 자체 PTY 히스토리는 제외(§3.1).
- LLM 미준비(59 `llmReadyReason`)면 카드에 이유 + "설정 열기"(`openSettings("ai")`); 히트맵·카운트는 LLM 없이도 보인다.
- 생성은 스트리밍으로 그려지고 취소 가능. 프로젝트 "전체"는 프로젝트별 요약을 순차 생성해 이어 붙인다(2차 요약 없음).

## 2. 현황(근거)

- **잔디·히트맵·일별 집계 0건**(`heatmap|contrib|잔디|calendar` grep — monaco·사이트 문구뿐).
- 커밋: `get_log(project_id, limit≤1000, skip, all_refs)`(`log.rs:20-48`, `LOG_FORMAT :14` — `%aI` ISO 시각 포함, `Commit{sha,
  parents, subject, body, authorName, authorEmail, authoredAt, refs}` `types.rs:141-152`). **since/until/author 필터 없음**, 통계(±줄) 없음.
  `useLog`(`queries/index.ts:625-638` 무한 쿼리), `["log"]`는 `repo://changed`에서 무효화(`events.ts:122`).
- 프롬프트: 앱의 `promptHistory`(`stores/promptHistory.ts`)는 **localStorage·termId 단위·200개/512KB 캡·터미널 닫으면 삭제**
  (`terminals.ts:12-16` `dropPane → clear`) — 월간 요약 입력으로 부적합. 반면 Claude Code는 `~/.claude/projects/<encoded>/*.jsonl`에
  세션 전사를 남기고, `claude_usage.rs:85-89 encode_project_dir`(`/ \ : .` → `-`)·`:108-153 last_agent_message`(최신 파일, `type`·
  `message.content[].text` 파싱)가 이미 그 규약을 안다. 전사의 `type:"user"` 줄에는 `timestamp`(ISO)·`cwd`·`sessionId`가 있고
  `message.content`는 문자열 또는 블록 배열(텍스트/`tool_result`)이다 (검증 필요 — 이 머신의 실제 파일로 확정; `isSidechain`·
  `isMeta` 플래그 존재 여부 포함).
- 전체 뷰 전환: `App.tsx:166` `aggregateOpen ? <AggregateTerminals/> : …`, 토글 `useUi.aggregateOpen/toggleAggregate`(`ui.ts:91,460`),
  타이틀바 `AggregateButton`(`TitleBar.tsx:94-`). 마크다운 렌더: `MarkdownView`(`react-markdown`+`remark-gfm`, `components/diff/MarkdownView.tsx`).
- 프로젝트 색: `useProjectColors()`(`lib/project-color.ts:255-268`) — 카드 스트라이프에 재사용. 로고: 54 `ProjectLogo`.
- 사이드 테이블 저장 선례: `notes.json`(`state.rs:19-22, :248-254`, `save_json`).

## 3. 설계

### 3.1 입력 소스

| 소스 | 채택 | 이유 |
|---|---|---|
| git 커밋(`--since/--until`, 기본 `--author=<repo user.email>`) | **예** | 정본. 작성자 필터는 "내 작업"의 정의 |
| Claude Code 전사의 사용자 프롬프트 | **예** | 지속·타임스탬프·프로젝트 경로 귀속. "프롬프트 히스토리"의 실체 |
| 앱 PTY 프롬프트 히스토리(`gp:prompt-history`) | 아니오 | 세션 한정·캡·삭제(§2). 넣으면 "어제 건 왜 없냐"가 된다. 지속화는 §7 |
| Claude 응답(assistant) | 아니오 | 토큰 예산. 프롬프트가 의도를, 커밋이 결과를 말한다 |

### 3.2 Rust 커맨드 3개 (`commands/report.rs`)

```rust
/// 날짜별 커밋 수 — `git log --since --until [--author=<email>] --format=%aI` 1회, 로컬 날짜로 버킷.
#[tauri::command] pub async fn git_activity(state, project_id, since: String, until: String, mine: bool)
    -> Result<Vec<DayCount /*{date:"YYYY-MM-DD", count}*/>, IpcError>
/// 기간 커밋(요약 입력) — get_log에 since/until/author를 더한 것. limit 200.
#[tauri::command] pub async fn commits_between(state, project_id, since, until, mine: bool) -> Result<Vec<Commit>, IpcError>
/// Claude Code 전사에서 사용자 프롬프트 — 파일 mtime ≥ since인 *.jsonl만 열고, type=="user"·텍스트 블록만·tool_result 제외·
/// timestamp 범위 필터. 캡 2,000건·각 500자. 함께 날짜별 개수도 돌려준다(히트맵 두 번째 시리즈).
#[tauri::command] pub async fn claude_prompts(project_path, since, until) -> Result<PromptDump{items: Vec<{at, text}>, days: Vec<DayCount>}, IpcError>
```
- `mine`의 이메일: `git config user.email`(레포 우선, 없으면 전역) — `git_activity`가 1회 조회해 `--author=<email>`(정확 일치가 아니라
  git의 부분 일치 — 같은 이메일 도메인 오매칭은 수용). 이메일이 없으면 `mine`은 무시(전체).
- 시각은 `%aI`(작성자 로컬 오프셋 포함) → 날짜 버킷은 **그 오프셋의 날짜**(`chrono` 파싱 후 `date_naive`). 전사 `timestamp`는 UTC(`Z`) →
  **로컬 시간대로 변환** 후 날짜(CLAUDE.md의 UTC/KST 함정 — 두 소스를 같은 날짜계로).
- `claude_prompts`는 `home_dir()/.claude/projects/<encode_project_dir(path)>/` — `claude_usage.rs`의 함수를 `pub(crate)`로 승격해 재사용.
  파일이 수백 MB일 수 있어 `BufRead::lines`로 스트리밍, 줄 파싱 실패는 skip.
- 세 커맨드 모두 `spawn_blocking`/`git::runner` 관례, 입력 날짜는 `YYYY-MM-DD` 정규식 검증(셸 인젝션 방지).

### 3.3 요약 생성(프론트, `lib/report.ts`)

```
system: "너는 개발자의 작업 일지를 쓰는 비서다. 아래 커밋과 프롬프트를 근거로 {언어}로 {기간 라벨} 작업을 요약해라.
         형식: ## 한 줄 요약 / ## 한 일 (불릿, 커밋 해시 7자리 인용) / ## 진행 중·막힌 것 / ## 다음 할 일 제안(3개 이하).
         근거 없는 내용은 쓰지 마라. 프롬프트는 사용자가 AI에게 한 요청이다."
user:   "프로젝트: {name} ({since}~{until})\n\n### 커밋 {n}건\n- {sha7} {subject} — {body 첫 줄 ≤120자}\n…\n\n### 프롬프트 {m}건\n- [{시각}] {text ≤300자}\n…"
```
- 토큰 예산: 컨텍스트 8192(59 기본) − 응답 1024 − 시스템 ≈ **6,500 토큰 입력**. 한글 ≈ 1.5자/토큰으로 계산해 **커밋 최대 60·프롬프트
  최대 80**에서 시작, 넘치면 오래된 것부터 잘라 "…외 N건" 한 줄. `ponytail:` 잘라내기 — 월간 대형 프로젝트는 맵-리듀스(주별 요약 →
  월 요약)가 업그레이드 경로.
- 호출: 59 `chat(messages, onToken, {maxTokens: 1024, temperature: 0.3, signal})`. 카드가 `useState(text)`에 누적, 완료 시 저장.
- 입력 해시 `sha1(커밋 sha 목록 + 프롬프트 at 목록)`(프론트 `crypto.subtle`) → 저장 레코드와 비교해 "입력이 바뀜 — 다시 생성" 뱃지.

### 3.4 저장 — `reports.json` 사이드 테이블

`app_data_dir/reports.json` = `Record<"<projectId>|<day|week|month>|<since>", { text, generatedAt, inputHash, model }>`.
커맨드 `report_get_all() -> map`, `report_set(key, rec)`, `report_delete(key)`(`notes.rs` 4함수와 같은 골격, `save_json`).
크기: 요약 1건 ≈ 2KB, 1년 일간×프로젝트 10개 = 7MB 상한 — 넉넉하나 **항목 3,000개 초과 시 오래된 것부터 삭제**(`report_set`에서).

### 3.5 뷰 — `components/report/ReportView.tsx`(+ `Heatmap.tsx`, `ReportCard.tsx`)

- 진입: `useUi.reportOpen`·`toggleReport`, 타이틀바 `ReportButton`(`CalendarDays` 아이콘, `AggregateButton` 옆, 프로젝트 0개면 숨김),
  `App.tsx:166` 삼항에 `reportOpen ? <ReportView/> :` 추가(모아보기보다 **뒤** — 모아보기 우선). `selectDiff`가 모아보기를 닫듯
  리포트도 닫는다(`ui.ts:320-324` 옆 `reportOpen:false` 1줄). `GlobalShortcuts`는 손대지 않는다(단축키 없음).
- 상단 바: 프로젝트 `<select>`(전체 + 등록순) · 기간 세그먼트(일/주/월) · "내 커밋만" 체크(기본 on, `gp:report-mine`) · 기준일 표시
  (`2026-09-07` / `9월 1주` / `2026-09`) + ◀▶.
- **히트맵**(`Heatmap.tsx`): 지난 365일(오늘 포함), 열=주(53)·행=요일(7, 월요일 시작 — 한국 관례), 셀 12px + gap 3px = 795px(1100px
  뷰에 여유). 값 = 선택 프로젝트(전체면 합) 커밋+프롬프트. 레벨 5단계(0·1-2·3-5·6-10·11+)를 `color-mix(in oklch, var(--accent) L%,
  var(--panel))`(L = 0/25/50/75/100) — 테마 6종·커스텀에서 자동 정합, 다크·라이트 대비는 구현 시 `dataviz` 팔레트 검증기로 확인.
  셀 `title="9월 3일 · 커밋 4 · 프롬프트 12"`(네이티브 title — 26의 호버 카드는 과함). 클릭 → 기준일 = 그 날, 기간은 현재 세그먼트
  유지. 오늘 셀 `ring-1 ring-accent`. 월 라벨 상단·요일 라벨 좌측(월·수·금만).
  데이터: `useQueries` — 프로젝트별 `git_activity`(`["activity", id, since, mine]`, staleTime 5분, `["log"]` 무효화 시 함께) +
  `claude_prompts(days만 사용 — items는 텍스트라 별도 키로 기간 요청 시에만)`.
  `ponytail:` 프롬프트 days는 전사를 전부 읽는다(1년치) — 느리면 파일 mtime 캐시.
- **카드**(`ReportCard.tsx`, 선택 기간 × 프로젝트): 헤더 `<ProjectLogo/>` + 이름 + 색 스트라이프(36 `color.stripe`) + "커밋 12 · 프롬프트
  38" · [요약 생성]/[다시 생성](입력 해시 불일치 뱃지)/[취소] · 생성 시각·모델. 본문 `MarkdownView`로 스트리밍 텍스트. 입력 0건이면
  "활동 없음" + 버튼 비활성. LLM 미준비면 `llmReadyReason` 문구 + "설정 열기". 커밋 해시 7자리는 클릭 시 `selectCommit(sha)`+
  `toggleLog`로 하단 Log 패널에 — 리포트를 닫아야 보이므로 v1은 **텍스트만**(§7).
- "전체" 프로젝트 + [모두 생성]: 카드 순서대로 직렬(59는 한 번에 한 요청). 진행 "3/10".

### 3.6 잔디 해석

"잔디 심기"를 **활동 히트맵 표시**로 본다. 커밋을 자동 생성해 GitHub 잔디를 채우는 기능(빈 커밋·자동 커밋)은 **하지 않는다** —
저장소 이력을 오염시키고 앱의 역할(관찰·정리)과 반대다. 다른 뜻이었다면 §7에서 결정.

## 4. 변경 목록

| 파일 | 변경 | 규모 |
|---|---|---|
| `src-tauri/src/commands/report.rs` | `git_activity`·`commits_between`·`claude_prompts` + `report_get_all/set/delete` | ≈ +260 |
| `src-tauri/src/claude_usage.rs` | `encode_project_dir`·`home_dir` `pub(crate)` | 2줄 |
| `src-tauri/src/state.rs`, `lib.rs` | `reports` 로드/세이브(`notes` 복제), 등록 6 | ≈ +30 |
| `src/lib/ipc.ts`, `src/queries/index.ts` | 바인딩·쿼리 훅 | ≈ +90 |
| `src/lib/report.ts` | 프롬프트 조립·예산·해시 | ≈ +90 |
| `src/stores/ui.ts` | `reportOpen`·`toggleReport`·`selectDiff` 닫기 | +6 |
| `src/components/report/{ReportView,Heatmap,ReportCard}.tsx` | 신설 | ≈ +420 |
| `src/components/TitleBar.tsx`, `src/App.tsx` | 버튼·분기 | +4 |
| `tests/e2e/suites/48-report.mjs` | 신설 | ≈ +110 |

## 5. 검증

### 5.1 e2e 48
1. 픽스처 레포에 날짜를 조작한 커밋 3개(`GIT_AUTHOR_DATE`: 오늘, 3일 전, 40일 전; 작성자 이메일은 러너 설정값) →
   `git_activity(since=1y)` → 3일(각 1), `mine=true`에서 다른 이메일 커밋(1개 추가)은 제외.
2. 가짜 전사: `~/.claude/projects/<encode(fixturePath)>/e2e.jsonl`에 `type:"user"` 3줄(오늘 2·어제 1, `tool_result` 블록 1줄은
   제외돼야) → `claude_prompts` items 3·days 2. **finally에서 그 파일만 삭제**(사용자 전사 보호 — 디렉토리는 남긴다).
3. `__gpv.ui.getState().toggleReport()` → 히트맵 `[data-day]` 셀 365개, 오늘 셀 `data-level ≥ 1`, title에 "커밋 1 · 프롬프트 2".
4. 오늘 셀 클릭 → 카드 "커밋 1 · 프롬프트 2". LLM 준비 시(47과 같은 게이트) [요약 생성] → 본문에 `## 한 줄 요약` 등장 폴링 120s,
   `report_get_all`에 키 존재. 미준비면 이유 문구 존재 단언 후 skip.
5. 커밋 1개 추가 → `["activity"]` 무효화(`repo://changed`) → 셀 갱신, 카드 "입력이 바뀜" 뱃지.
6. `selectDiff(파일)` → `reportOpen === false`.

### 5.2 실기
- 실제 프로젝트 26개·1년: 히트맵 첫 로드 시간(전사 총량이 수백 MB인 프로젝트 포함) — 3초 넘으면 §3.5 mtime 캐시.
- 월간 요약 품질(4B): 근거 없는 문장이 나오면 temperature 0.3→0.1, 프롬프트 문구 조정. 한/영 전환(`llmLanguage`).
- 배치 "모두 생성" 10개 — 중간 취소 시 나머지 카드가 "취소됨"으로 남고 생성된 것은 저장.

## 6. 위험

- **전사 형식 가정**(`type`·`message.content`·`timestamp`·`tool_result`) — 이 머신 파일로 첫 단계에 확정. Claude Code 버전에 따라
  필드가 바뀌면 파서가 조용히 0건을 낼 수 있다 → e2e 2가 고정 픽스처로 회귀 감지, 실파일은 실기.
- **개인정보**: 프롬프트 원문이 로컬 LLM에만 간다(외부 URL 모드는 사용자가 지정한 서버) — 설정 AI 페이지 안내문 1줄.
- 시간대: 두 소스를 로컬 날짜로 통일(§3.2). 러너는 KST.
- **커미터 날짜로 거르고 작성 날짜로 버킷한다** — `git log --since/--until`은 커미터 날짜 필터인데
  `git_activity`·`commits_between`은 `%aI`(작성 날짜)로 센다. git에 작성일 필터가 없어 그대로 둔다
  (`report.rs range_args` 주석에도 같은 내용). 리베이스·amend 뒤 둘이 갈린 커밋은 가져와 놓고
  요청 범위 **밖 날짜**에 찍히거나 경계에서 누락될 수 있다.
- 토큰 예산 초과 시 잘림 — "…외 N건"으로 가시화.

## 7. 열린 질문

| 질문 | 기본값 |
|---|---|
| "잔디 심기" = 히트맵 표시(§3.6) 맞는지 | 히트맵. 자동 커밋은 하지 않음 |
| 앱 PTY 프롬프트 히스토리를 지속화(프로젝트별 append 로그)해 비-Claude 셸 작업도 포함 | 후속 — `promptHistory.record`에 Rust append 1줄이면 가능하나 스코프 밖 |
| 히트맵 값에 프롬프트를 포함(기본) vs 커밋만 | 포함, 토글 없음. 툴팁이 둘을 나눠 보여준다 |
| 요약 본문의 해시 클릭 → Log 패널 점프 | v1 텍스트만 |
| 주 시작 요일 | 월요일 |
| 리포트 내보내기(.md 파일) | 후속 — `write_file_bytes`로 10줄 |

## 8. 구현 결과 (2026-09-07~08)

**구현 완료 · e2e 통과(미커밋).** 설계대로 — 프롬프트 입력은 Claude Code 전사, 잔디는 표시 전용(자동 커밋 없음).

- Rust `src-tauri/src/report.rs`(**최상위 모듈** — 피어 세션이 소유한 `commands/mod.rs`를 피했다):
  `git_activity`·`commits_between`·`claude_prompts` + `report_get_all/set/delete`, `reports.json`.
  `claude_usage.rs`의 `home_dir`·`encode_project_dir`를 `pub(crate)`로 재사용.
- 프론트: `lib/report.ts`(기간 계산·토큰 예산·입력 해시) · `components/report/{ReportView,Heatmap,ReportCard}.tsx`
  · 타이틀바 `ReportButton` · `events.ts`가 `["log"]` 무효화에 `["activity"]` 동반 · e2e 48.
- **전사 형식은 이 머신의 실파일로 확정했다**(§6의 최대 위험): `isSidechain`·`isMeta`(있을 때만),
  `timestamp`는 UTC `Z`, `message.content`는 문자열 또는 블록 배열. 실제 전사 하나에 같은 필터를 돌려
  프롬프트 21건 중 **meta·sidechain 9건, tool_result-only 164건이 제외**됐다 — 제외 규칙이 없으면
  입력의 89%가 도구 출력이다.

**설계와 다른 점**: CSS 토큰은 `--color-accent`/`--color-panel`(Tailwind v4 `@theme`이 만드는 실제 이름 —
설계의 `--accent`/`--panel`은 이 저장소에 없다). 프로젝트 select 기본값은 "전체"가 아니라 **지금 보던 프로젝트**
(전체는 프로젝트당 IPC 2건 × 1년치를 한꺼번에 띄운다). `--until`에 `T23:59:59`를 붙인다(날짜만 주면 git이
00:00으로 읽어 마지막 날이 통째로 빠진다).

**검증에서 잡힌 것 — 정적 검증으로는 절대 안 보이는 유형:**

| 지적 | 수정 |
|---|---|
| **(제품 버그) 잔디와 카드가 같은 날에 다른 수를 보인다** — 잔디 "커밋 1", 카드 "커밋 3". `git log --since/--until`은 **커미터 날짜**로 거르는데 이 모듈의 표시 기준은 `%aI`(작성 날짜)라, 작성일만 과거인 커밋(리베이스·amend·`GIT_AUTHOR_DATE` 조작)이 하루짜리 조회에 딸려 온다. §6에 "한계"로만 적어 뒀던 것이 실제로 화면에서 어긋났다 | `git_activity`·`commits_between` 둘 다 결과를 **작성 날짜로 다시 거른다**(`in_range`). 커미터 필터는 값싼 선거름으로 유지 — git에 작성일 필터가 없다. 회귀 테스트 2건 |
| (중) "모두 생성" 배치가 활동 없는 프로젝트에서 **영원히 멈춘다** — `generate()`의 이른 반환이 `try` 이전이라 `finally`의 `onFinish`를 안 타고, 대기열은 `onFinish`로만 전진한다 | `runNow` 효과가 생성 불가 카드를 **건너뛰며** `onFinish`를 부른다(수동 버튼은 그대로 — 그쪽이 대기열을 밀면 안 된다) |
| (중) 기간을 바꿔도 **떠난 기간의 토큰이 새 머리글 아래로 계속 쌓인다** — `ReportView`가 `key={p.id}`라 카드가 리마운트되지 않는다. 한 개뿐인 LLM 슬롯도 그동안 물고 있다 | `[key]` 효과가 진행 중 생성을 `abort`. 취소 사유가 "기간 이동"이면 "취소됨" 표시를 남기지 않는다 |
| (중) 데이터가 **아직 로딩 중인** 카드를 "활동 없음"으로 읽어 배치가 조용히 건너뛴다 | `loading`(두 쿼리의 `isPending`)을 분리해 `empty`에서 제외하고, 배치는 로딩 중이면 **기다린다**(deps에 `loading`) |
| (낮음) 한국어 프롬프트에 영어 언어명이 들어가 "Korean로 요약해라"가 된다 | `report.ts`에 한국어 라벨 맵(`langName`은 59 계약이라 그대로) |
| (e2e) 원시 invoke로 등록한 픽스처가 UI 캐시에 없어 `scoped`가 비고, 잔디·카드가 **전부 0**으로 보인다 | `add_project` 뒤 `["projects"]` 무효화 + 반영 대기(44가 같은 이유로 이미 갖고 있던 줄) |
| (e2e) 잔디 단언이 프롬프트만 기다리고 커밋을 단언해, activity가 늦은 회차에서 "커밋 0"으로 떨어진다 | 폴링 조건을 완성된 툴팁 문자열로 |

**미검증**: 요약 생성 자체(LLM 런타임·모델 미설치 — 59 §8 참조), "전체" 스코프의 1년 전송량(26개 프로젝트
첫 로드 체감), 배치 중간 취소, 토큰마다 마크다운 재렌더 체감.
