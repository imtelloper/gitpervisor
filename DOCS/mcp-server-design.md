# 로컬 MCP 서버 설계

설치된 Gitpervisor가 켜져 있으면 Claude Code·Cursor 같은 에이전트가 MCP로 앱의 정보(전 레포 상태·
교차 레포 검색·다른 터미널 출력·메모)를 읽는다. 2026-10-15.

## 1. 목표와 비목표

**목표**
- 에이전트가 **혼자서는 비싸거나 못 하는 것**만 도구로 연다 — 레포 수십 개 상태 일괄 조회,
  등록 레포 전체 검색, 옆 터미널의 출력 읽기, 프로젝트 메모.
- 세 OS 같은 코드. 설정 한 번 켜고 명령 한 줄 복사로 등록이 끝난다.

**비목표(1차)**
- 쓰기 도구(커밋·푸시·터미널 입력·메모 추가) — §6 2차.
- stdio 전용 클라이언트용 브리지 실행 파일 — §7.
- 별도 REST API — 소비자가 MCP 하나뿐이다.

## 2. 구조 — 앱 프로세스 안의 HTTP 서버

```
Claude Code / Cursor ── POST http://127.0.0.1:<mcpPort>/mcp (Bearer 토큰)
                              │
                     Gitpervisor 프로세스 (mcp.rs)
                              │ app.state::<AppState>()
                     기존 커맨드 함수 그대로(get_statuses·get_log·search_in_project …)
```

**왜 별도 프로세스(stdio)가 아닌가**
- 상태(프로젝트 목록·메모·터미널)는 실행 중인 앱 메모리에만 정본이 있다. 다른 프로세스가 `projects.json`을
  직접 읽으면 낡은 사본을 보고, 쓰면 "메모리 사본 통째 덮어쓰기"(CLAUDE.md)가 재발한다.
- 릴리스 빌드는 single-instance라 `gitpervisor.exe --mcp`는 첫 창으로 넘겨지고 바로 끝난다.

모양은 `llm/relay.rs`·`commands/preview.rs`와 같다 — 블로킹 accept + 연결마다 스레드 + 동시 연결 상한.
요청 머리 해석은 relay의 `parse_head`를 같이 쓴다.

## 3. 프로토콜 — Streamable HTTP의 최소 부분집합

| 요청 | 응답 |
|---|---|
| `POST /mcp` JSON-RPC 요청(id 있음) | `200 application/json` 단일 응답 |
| `POST /mcp` 알림(id 없음, `notifications/*`) | `202` 빈 본문 |
| `GET /mcp`(SSE 스트림 열기) · `DELETE` | `405` — 서버 발신 메시지가 없으므로 스트림을 열지 않는다(스펙 허용) |
| 배열(배치) | JSON-RPC `-32600` — 최신 스펙에서 빠졌다 |

- 메서드: `initialize` · `ping` · `tools/list` · `tools/call`. 그 밖은 `-32601`.
- 세션 id(`Mcp-Session-Id`)를 발급하지 않는다(무상태) — 도구가 전부 단발 조회다.
- `protocolVersion`: 클라이언트가 보낸 값이 아는 목록(`2025-11-25`·`2025-06-18`·`2025-03-26`·
  `2024-11-05`)에 있으면 그대로, 아니면 가장 최신을 돌려준다. 우리가 쓰는 부분(tools)은 이 버전들에서 같다.
- 도구 실패는 JSON-RPC 오류가 아니라 `result.isError: true` + 메시지(스펙 권장 — 모델이 읽고 고친다).

## 4. 보안

루프백이라도 같은 PC의 다른 프로세스·다른 사용자·브라우저(DNS rebinding)가 닿는다.

1. **기본 꺼짐.** 설정 › AI › MCP 서버에서 켠다.
2. **토큰.** `Authorization: Bearer <mcpToken>` 이 아니면 경로·본문을 보기 전에 401. 비교는 상수 시간.
   토큰은 켤 때 프런트가 만들고(128비트 ×2) `settings.json`에 둔다 — 같은 사용자 프로세스는 키링도
   읽을 수 있어 키링이 더 막아 주는 것이 없고, 화면에 보여 줘야(등록 명령 복사) 하기 때문이다.
   다른 사용자 계정은 `%APPDATA%`/`~/.local/share` ACL에 막힌다. [재발급] 버튼이 있다.
   **빈 토큰이면 서버를 띄우지 않는다**(손으로 고친 settings.json 등).
3. **`Origin` 헤더가 있으면 403.** MCP 클라이언트(비브라우저)는 보내지 않는다 — 브라우저발 요청을 통째로 막는다.
4. **`Host`는 `127.0.0.1:<포트>`·`localhost:<포트>`만.** DNS rebinding 2차 방어.
5. **1차는 읽기 전용.** 상태를 바꾸는 도구가 없다.
6. 본문 1MB·헤더 64KB·동시 연결 8 상한(relay와 같은 이유).

## 5. 도구(1차, 읽기 전용 7개)

`project` 인자는 프로젝트 **id 또는 이름**(대소문자 무시). 생략 가능한 도구는 생략 = 전체.

| 도구 | 인자 | 내용 | 재사용 |
|---|---|---|---|
| `list_projects` | — | id·이름·경로 | `state.projects` |
| `repo_status` | `project?` | 브랜치·upstream·ahead/behind·진행 중 작업(merge/rebase…)·staged/unstaged/untracked/conflicted 파일(종류별 30개까지 + 남은 수)·마지막 fetch·오류. 임베디드 저장소 포함 | `get_statuses` |
| `git_log` | `project`, `limit?`(20, 최대 100), `all_refs?` | sha·날짜·작성자·제목·refs | `get_log` |
| `search_code` | `query`, `project?`, `regex?`, `case_sensitive?`, `include?`(글롭) | `프로젝트:경로:줄: 본문`, 전체 200줄 상한 | `search_in_project`(검증·캡 그대로) |
| `list_terminals` | — | term id·프로젝트·셸·화면 마지막 줄 | `state.terminals` |
| `read_terminal` | `term_id`, `lines?`(100, 최대 2000) | 그 터미널의 화면 + 스크롤백 텍스트 | §5.1 |
| `read_memos` | `project?` | 프로젝트 메모(수정 시각 포함) | `state.notes` |

`repo_status` 전체는 레포 21개 기준 20~30초 걸릴 수 있다(`get_statuses` 머리 주석의 실측) — 도구 설명에
"가능하면 project를 지정하라"고 적는다.

정의·참조 찾기는 넣지 않는다 — 에이전트에게 이미 grep·LSP가 있어 가치가 작고 도구 목록만 길어진다.

### 5.1 터미널 출력 읽기

지금 Rust에는 출력 사본이 없다(펌프가 Channel로 보내고 끝). 그래서:

- 세션마다 **원시 출력 꼬리 256KB 링**을 둔다. 펌프의 `flush`가 Channel로 보내기 직전 한 번 복사한다
  (청크당 memcpy + 짧은 락 — 4ms 합치기 주기라 에코 지연에 영향 없다). 터미널 13개 ≈ 3.3MB.
- 읽을 때만 그 바이트를 **`vt100` 파서**에 현재 PTY 크기로 다시 흘려 화면 + 스크롤백을 텍스트로 만든다.
  ANSI를 단순 제거하면 안 되는 이유: Windows ConPTY는 평범한 셸 출력도 커서 이동(`CSI H`)으로 다시 그려서
  제거만 하면 줄이 뒤섞인다. 항상 파서를 돌려 두는 방식은 터미널마다 셀 격자 메모리(스크롤백 포함 수 MB)를
  상시 쥐므로 버렸다.
- 한계: 링이 시작되는 지점 이전 상태(예: 대체 화면 진입)를 모르면 TUI 화면이 일부 어긋날 수 있다.
  리사이즈 전 출력도 지금 크기로 다시 그린다. 둘 다 "읽기용 근사"로 충분하다.

## 6. 2차 후보(이번 범위 아님)

쓰기 도구는 **별도 토글**(`mcpAllowWrites`) 뒤에 둔다: `add_memo` → `stage`/`commit` → `terminal_input`
(사실상 임의 명령 실행 — 가장 마지막, 도구마다 확인 대화상자 검토).

## 7. 클라이언트 등록

- Claude Code: `claude mcp add --transport http gitpervisor http://127.0.0.1:<포트>/mcp --header "Authorization: Bearer <토큰>"`
  — 설정 화면에서 복사.
- Cursor 등 HTTP 지원 클라이언트: 같은 URL·헤더.
- stdio만 되는 클라이언트: `npx mcp-remote <URL> --header ...` 같은 범용 브리지를 쓴다. 우리 브리지를 만들지 않는다.

## 8. 설정·수명

| 필드 | 기본 | 비고 |
|---|---|---|
| `mcpEnabled` | false | |
| `mcpPort` | 47820 | 등록 명령에 박히므로 고정. dev 앱(.dev)과 둘 다 켜면 다른 값으로 |
| `mcpToken` | "" | 켤 때 프런트가 생성 |

- 시작: `setup`에서 설정을 보고 띄운다. `set_settings` 뒤마다 `mcp::apply`가 (켜짐·포트·토큰) 차이를 보고
  멈추거나 다시 띄운다. 멈춤 = 중단 플래그 + 자기 포트에 접속해 블로킹 accept를 깨운다.
- 바인드 실패(포트 사용 중)는 오류를 기억해 `mcp_status`로 설정 화면에 보인다.

## 9. 검증

- Rust 단위: 디스패치(initialize 버전 협상·tools/list·알 수 없는 메서드·알림 202), HTTP 문지기(토큰 없음 401·
  Origin 403·Host 불일치 403·GET 405), vt100 재생(커서 이동으로 다시 그린 줄이 올바른 텍스트로 나오는지).
- 실동작: dev 앱에서 켜고 `curl`로 initialize·tools/list·각 도구 호출, `claude mcp add`로 실제 등록해
  `claude mcp list` 연결 확인.
- 미실측: macOS·Linux(같은 코드지만 실기 확인 필요).

**2026-10-15 결과(Windows, dev 앱)**: 단위 4개 + 꼬리 링 1개 통과. curl로 401(토큰 없음)·403(Origin)·405(GET)·
initialize·알림 202·도구 7개 확인. CDP로 연 PTY(100×20)에 40줄을 찍고 `read_terminal` → 스크롤백 포함 47줄, 한글
넓은 글자 줄바꿈까지 화면과 같음. `claude mcp add` → `claude mcp list` "Connected", `claude -p`가 `repo_status`를
실제로 불러 브랜치·ahead·변경 수를 맞게 답함. 설정에서 끄면 포트가 즉시 풀리고, 켜 둔 채 재시작하면 setup에서 다시 뜸.
