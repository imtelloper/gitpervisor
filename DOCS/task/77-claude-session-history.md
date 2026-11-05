# 태스크 77 — Claude 세션 기록 찾기·이어서 작업

> 상태: **구현 완료** (2026-11-05) · 대상: gitpervisor · 근거: `~/.claude/projects` 실측(2026-11-05)

## 1. 요구사항

터미널 세션 헤더(모아보기 셀·작업 화면 패널 버튼 줄)에 **세션 기록** 버튼. 누르면 지난 Claude Code 세션 목록이 뜨고,
골라서 **이어서 작업**(`claude --resume <id>`)할 수 있다. VS Code Claude 확장의 "Agent 세션 기록"(범위 탭·검색·정렬·
프로젝트별 묶음·펼치면 첫 프롬프트·최근 대화·재개 버튼)과 같은 일을 하되 **더 낫게**.

## 2. 데이터(실측)

- 위치: `<CLAUDE_CONFIG_DIR 또는 ~/.claude>/projects/<인코딩된 cwd>/<sessionId>.jsonl` — 인코딩은 `claude_usage.rs
  encode_project_dir`(구분자·콜론·점 → `-`). 이 기계: 최상위 jsonl 56개 1.1GB(최대 40MB), 서브에이전트
  `<sessionId>/subagents/agent-*.jsonl`(+ `.meta.json`) 728개 2.8GB.
- 줄 종류(JSON Lines, `type`): `ai-title`(`aiTitle` — Claude 가 붙인 제목, 반복 기록 → **마지막 것**), `user`(사람 프롬프트는
  `turnOrigin:"human"` / `promptSource:"typed"`, `message.content` 는 문자열 또는 블록 배열), `assistant`(`message.model`·
  `requestedModel`, 텍스트 블록), `session-owner`(`accountUuid`), 그리고 `attachment`·`api-request*`·`queue-operation` 등 잡음.
  모든 대화 줄에 `cwd`·`gitBranch`·`version`·`timestamp`.
- 기존 도구: `claude_usage.rs` 의 `home_dir`·`claude_config_dir`·`encode_project_dir`·`scan_lines_from_end`(끝에서부터 줄 읽기).

## 3. 설계

### D1. 백엔드 `src-tauri/src/claude_sessions.rs`(신규)
- **`claude_sessions_list() -> ClaudeSessionList`** (`#[tauri::command(async)]`, blocking 풀):
  `{ sessions: ClaudeSession[], scannedFiles: u32, scannedAtMs: i64 }`
  ```
  ClaudeSession { id, projectDir /* 인코딩 폴더 이름 */, title?: string, cwd?: string, gitBranch?: string, model?: string,
    version?: string, firstPrompt?: string /* ≤300자 */, lastPrompt?: string /* ≤300자 */, lastAgentText?: string /* ≤400자 */,
    messageCount: u32 /* user·assistant 대화 줄 */, humanPromptCount: u32, subagentCount: u32 /* subagents/*.jsonl 개수 */,
    startedAtMs?: i64, updatedAtMs: i64 /* 파일 mtime */, sizeBytes: u64 }
  ```
  - 읽기: **앞**(첫 256KB — cwd·첫 사람 프롬프트·시작 시각), **끝**(`scan_lines_from_end` — 마지막 ai-title·마지막 사람 프롬프트·
    마지막 에이전트 텍스트·모델·브랜치), **전체 바이트 훑기**(메시지 수 — JSON 파싱 없이 `"type":"user"`·`"type":"assistant"`
    부분 문자열 세기, `memchr::memmem` 가 있으면 그것). 사람 프롬프트에서 `<system-reminder>`·`<command-…>`·`[Image …]` 같은
    잡음 태그는 걷어 낸 요약을 쓴다. 제목이 없으면 첫 프롬프트 앞부분.
  - **캐시**: (경로, mtime, 크기) → 결과. 프로세스 메모리(static). 다시 열 때 바뀐 파일만 다시 읽는다(진행 중 세션만).
  - 빈 파일·사람 프롬프트 0개(시스템만 있는 세션)는 뺀다. e2e 임시 폴더(`gpv-e2e-…`)·스크래치패드 세션도 그대로 둔다(사용자 범위
    필터가 가른다).
- **`claude_session_detail(projectDir, id) -> ClaudeSessionDetail`**:
  `{ firstPrompt: string /* ≤4000자 */, recent: { role: "user"|"assistant", text, timestampMs? }[] /* 끝에서 텍스트 있는 대화
  8개, 각 ≤1500자 */, cwd?, gitBranch?, accountUuid?, subagents: { id, description? }[] /* meta.json */ }`.
- **`claude_session_reveal(projectDir, id)`**: 기록 파일을 탐색기에서 보여 준다(`open.rs reveal`).
- **보안**: `projectDir`·`id` 는 성분 하나여야 한다(구분자·`..` 거부, id 는 UUID 모양) — 경로는 서버가 `projects` 아래로만 조립.
- 사용자 문구는 `crate::i18n::text_*`. 테스트: 픽스처 jsonl(임시 폴더)로 목록·상세·캐시 무효화·잡음 태그 걷기·경로 성분 거부.

### D2. 프론트 — 세션 기록 대화상자
- **버튼**: `TermSessionControls.tsx` 에 `SessionHistoryButton({ termId, projectId })` — 모아보기 셀 헤더와 작업 화면 패널 버튼 줄
  (`PaneTree` controls) 둘 다. 아이콘은 프롬프트 기록(History)과 구별되는 것.
- **대화상자**(창 가운데, ~880px·80vh, 메인 창·모아보기 별도 창 모두에서 열린다 — 호스트를 두 곳에):
  - 머리: "Claude 세션 기록" · "세션 N개 · 파일 M개 스캔 · 방금 전" · 새로고침.
  - 범위: **이 프로젝트**(버튼을 누른 세션의 프로젝트 경로 = 세션 cwd) / **등록된 프로젝트**(앱에 등록된 모든 프로젝트) / **전체**.
    기본은 이 프로젝트, 결과가 없으면 등록된 프로젝트.
  - 검색(제목·프롬프트·마지막 대화·브랜치·경로, 한/영 대소문자 무시) · 정렬(최근 업데이트 / 시작 시각 / 메시지 수).
  - 목록: 프로젝트별 접히는 묶음(이름·개수). 행 = 제목(굵게) + 상대 시각 · 마지막 에이전트 대화 2줄 미리보기 · 칩(모델 · 메시지 N ·
    서브에이전트 N · 브랜치 · 크기). **이 앱의 터미널에서 지금 열려 있는 세션**이면 "열려 있음" 표시(알 수 있을 때만).
  - 행을 펼치면(상세는 그때 읽는다): **[새 탭에서 이어서]**(주) · [이 터미널에서 이어서] · [세션 ID 복사] · [기록 파일 위치] ·
    첫 프롬프트(복사) · 최근 대화(역할별 말풍선, 긴 건 접기) · 작업 경로·브랜치 · 서브에이전트 목록.
  - 키보드: 열리면 검색에 포커스, ↑↓ 이동, Enter 펼치기, Ctrl+Enter 새 탭에서 이어서, Esc 닫기.
- **이어서**: 세션 cwd 와 같은 경로의 **등록 프로젝트**가 있으면 그 프로젝트에 새 터미널(`openTerminal`) + 입력 예약
  `claude --resume <id>\r`(`queueInitialInput` — `CLAUDE_LAUNCH` 와 같은 방식). 없으면 버튼을 누른 터미널의 프로젝트에 새 터미널을
  열고 `cd "<cwd>"\r` 를 먼저 보낸다(cwd 가 사라졌으면 그 사실을 알리고 막는다). "이 터미널에서 이어서"는 현재 패널에 같은 입력.
  모아보기에서 눌렀으면 새 터미널도 모아보기에 보인다.

## 4. 작업 분할
| 묶음 | 파일 |
|---|---|
| **BE** | `src-tauri/src/claude_sessions.rs`(신규) · `lib.rs`(mod·invoke 등록·`hot_commands_stay_async` 목록) · `i18n/text_*.rs` · `claude_usage.rs`(헬퍼 `pub(crate)` 만) |
| **FE** | `src/components/sessions/*`(신규 대화상자) · `TermSessionControls.tsx`(버튼) · `PaneTree.tsx`·`AggregateTerminals.tsx`(버튼 배치) · 호스트(App·모아보기 창) · `stores/ui.ts`(열림 상태) · `lib/ipc.ts`(래퍼·타입 — 위 계약 그대로) · `i18n/text-*.ts` |

## 5. 검증
cargo test(픽스처) · tsc · dev 앱에서 실제 `~/.claude/projects` 로 목록·검색·범위·펼치기·새 탭에서 이어서(실제로 `claude --resume` 이
그 세션을 연다) · e2e 06·14(터미널·헤더 버튼).

## 6. 구현 결과(2026-11-05)

- 실측(이 기계, 디버그 빌드): 세션 파일 56개·1.2GB에서 54개 표시, 처음 스캔 0.1~1.0초(OS 캐시에 따라), 다시 열기 15~70ms,
  가장 큰 전사(121MB) 상세 22~32ms. 바뀐 파일만 다시 읽고(경로·mtime·크기 캐시), 큰 파일부터 최대 8개를 병렬로 읽는다.
- dev 앱에서 확인: 헤더 버튼 → 대화상자 → 범위·검색·펼치기, **Ctrl+Enter 로 지난 세션을 새 탭에서 실제로 `claude --resume`**.

설계와 다른 점:
- **사람 프롬프트 판정**: `turnOrigin` 이 없는 줄도(옛 버전·VS Code/SDK 호스트) tool_result 가 아니고 잡음 필터를 통과하면 사람
  프롬프트로 센다. `"human"` 만 세면 이 기계 세션 56개 중 7개(40MB 짜리 포함)가 빠졌다.
- **제목**: `custom-title`(사용자 `/rename`) > 마지막 `ai-title` > 첫 프롬프트 앞 80자.
- **읽기**: 앞 256KB 따로 읽기 대신 처음부터 끝까지 한 번 훑으며 첫 프롬프트·시작 시각·cwd·개수를 같이 얻고, 끝 스캔이 마지막
  에이전트 글·모델·브랜치를 준다.
- **최근 대화**: 끝 8개가 전부 Claude 말이면(에이전트가 길게 일한 세션) 마지막 사람 프롬프트를 더 거슬러 찾아 맨 앞에 넣는다.
- **`cwdExists`**(상세): 작업 폴더가 없어졌으면 이어서 버튼을 막고 이유를 보여 준다(Ctrl+Enter 도 막는다).
- **"열려 있음" 표시는 하지 않았다** — 앱이 패널별 Claude 세션 ID 를 모른다(`agentActivity` 는 작업/완료 상태뿐). 우리가 연
  재개만 기억하면 그 패널에서 Claude 를 끄는 순간 틀린 표시가 된다.
- 떠 있는 터미널 창(`float-*`)은 이 대화상자 호스트가 없어 버튼이 동작하지 않는다(GitDialog·FileTreeDialog 버튼과 같은 처지).
