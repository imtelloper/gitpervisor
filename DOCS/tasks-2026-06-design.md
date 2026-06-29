# 기능 배치 설계서 — 2026-06

> 상태: 설계(Design) · 대상: gitpervisor (Tauri 2.11.2 + React 19 + TS) · 1차 플랫폼: **Windows (WebView2)**
> 산출물 성격: `/sc:design` — 구현 코드가 아니라 **아키텍처·계약(타입/커맨드/이벤트)·단계 계획·위험**. 시그니처/타입 스케치는 포함, 본문 구현은 제외(→ `/sc:implement`).
> 근거: 6개 영역 코드베이스 실측 조사(2026-06-29). 각 작업의 "현황"은 실제 파일·라인 인용에 기반.

## 0. 작업 목록과 한눈 요약

| # | 작업 | 규모 | 핵심 판단 | 주요 위험 |
|---|------|------|-----------|-----------|
| 1 | 파일트리에서 각종 확장명 파일 생성(.py/.html/.js/.css…) | **S** | `create_dir` 미러 → `create_file` 신설 | 윈도우 예약 디바이스명(CON, NUL…) |
| 2 | DB 연결 — 남은 엔진(PostgreSQL/MySQL/SQLite) 완성 | **L** | `sqlx` 단일 크레이트로 3엔진 통합 | 빌드시간·TLS 정렬·SQLite UI 변경 |
| 3 | PROJECTS 바에 폴더 용량 표시 | **S~M** | `disk.rs` `dir_size()`·배치 패턴 재사용 | 거대 트리(node_modules/.git) 워크 비용 |
| 4 | Slack/email로 AI 작업완료 알림 | **M** | 기존 working→done 엣지에 디스패처 추가 | 시크릿 보관·연타 스팸 레이트리밋 |
| 5 | 크래시 내성 + 에러로그 + 디버깅 대비 | **M** | 엔진단은 이미 대비됨 → 관측·복구 UX 보강 | 무한 로그 증가·자동재시작은 비채택 |
| 6 | 윈도우 알림 아이콘 누락 | **S** | AUMID/바로가기 등록 + 설치빌드 검증 | 토스트 아이콘 자동검증 불가(수동) |

**권장 순서**: 1 → 3 → 6 (싸고 독립적) → 5 (복원성 기반) → 4 (Slack 먼저, email 나중) → 2 (가장 큼, 분할 납품).
작업 간 의존성은 거의 없음(4는 기존 `agent-notify.ts` 엣지에 의존, 나머지는 자기완결).

---

## 1. 파일트리 — 각종 확장명 파일 생성

### 1.1 요구사항
파일트리 컨텍스트 메뉴/빈 영역에서 `.py`, `.html`, `.js`, `.css` 등 **임의 확장명의 새 파일**을 만든다. "새 폴더"와 대칭.

### 1.2 현황(근거)
- `src-tauri/src/commands/tree.rs`
  - `create_dir(project_id, rel_path)` — 부모 존재 필요, 단일 레벨, 중복 시 `ErrorCode::AlreadyExists`, `resolve_in_repo` 검증.
  - `write_file(...)` — **기존 파일만** 씀(신규 생성 안 함).
  - `write_file_bytes(..., overwrite)` — **신규 생성 가능**(base64, 64MB 한도, 이미지용).
  - 가드: `validate_rel_file`(빈경로/절대/Prefix/RootDir/ParentDir/`.git` 거부) + `resolve_in_repo`(부모 canonicalize 후 `starts_with(repo)`) + `is_dotgit_component`(CVE-2019-1352/1353 + 8.3 단축명).
- `src/components/tree/FileTreePanel.tsx`
  - `newFolder(m)` → `askPrompt` → `createDir.mutate(joinPath(baseDir, name))`. 컨텍스트 메뉴는 root/비root 모두 "새 폴더" 항목 보유. `validateName`이 `/ \ ..` 거부.
- `src/queries/index.ts` `useCreateDir` → `invalidate(["dir"])` + `["statuses"]` + 성공 토스트.

### 1.3 설계 — 신규 `create_file` 커맨드
`write_file_bytes`(base64 강제) 재사용 대신 **전용 커맨드**를 만든다(의미 명확·UI에서 base64 인코딩 불필요·`create_dir`와 대칭, `AlreadyExists` 코드를 프론트가 이미 처리).

빈 파일 생성을 기본으로 한다(확장자는 에디터(Monaco) 구문강조를 구동). **스타터 템플릿(html boilerplate 등)은 YAGNI — v1 비포함**, 필요 시 후속.

UX: 생성 직후 해당 파일을 뷰어로 자동 오픈(선택).

### 1.4 계약
```rust
// tree.rs — create_dir 미러. 빈 파일 생성, 부모 존재 필요, 심볼릭 비추적.
#[tauri::command]
pub async fn create_file(
    state: State<'_, AppState>, project_id: String, rel_path: String,
) -> Result<(), IpcError>;   // 중복 → ErrorCode::AlreadyExists
```
```ts
// ipc.ts
createFile: (projectId, relPath) => callMutating<void>("create_file", { projectId, relPath }),
// queries/index.ts
useCreateFile(projectId)  // invalidate(["dir"],["statuses"]) + 토스트 "파일을 만들었습니다" + (옵션) 뷰어 오픈
```
- `lib.rs` invoke_handler에 `commands::create_file` 등록.
- UI: root 메뉴와 폴더/파일 메뉴에 "새 파일" 항목 추가. `askPrompt` placeholder "파일 이름 (예: main.py)". 기준 폴더는 `newFolder`와 동일 로직.

### 1.5 보안 보강(권장)
`validate_rel_file`에 **윈도우 예약 디바이스명** 거부 추가: 파일 stem이 `CON/PRN/AUX/NUL/COM1..9/LPT1..9`(대소문자·확장자 무관)면 거부. `CON.txt` 같은 이름은 생성 시 행/오작동 유발. 폴더 생성에도 동일 적용.

### 1.6 단계·검증
1. `create_file` + 가드 보강 → 2. ipc/query/메뉴 배선 → 3. E2E(`tests/e2e/suites/15-tree-fileops.mjs` 확장: 정상 생성·중복→`ALREADY_EXISTS`·`../` 거부·`.git` 거부·예약명 거부).
- 규모 S: 백엔드 ~25 LOC, UI ~30 LOC.

---

## 2. DB 연결 — 남은 엔진(PostgreSQL / MySQL / SQLite) 완성

### 2.1 요구사항
DB 연결 추가에서 현재 막혀 있는 엔진(PostgreSQL·MySQL·SQLite)을 실제로 제어 가능하게 마저 구현.

### 2.2 현황(근거)
- `src-tauri/src/db.rs`
  - `enum DbEngine { Mongodb, Postgres, Mysql, Sqlite, Mssql }` — 5종 정의 완료.
  - **구현됨**: Mongodb(`mongodb="3"`), Mssql(`tiberius="0.12"`). `DbClient`에 `Mongo`/`Mssql` 변형.
  - **스텁**: `db_connect()`의 `_ => Err("아직 MongoDB·SQL Server만 지원합니다 …")` — PG/MySQL/SQLite 전부 동일 에러, 코드경로 없음.
  - 분기 커맨드(엔진별 match 필요): `db_connect`/`db_databases`/`db_tables`/`db_query`/`db_table_meta`/`db_explain`/`db_update_cell`/`db_delete_row`/`db_insert_row`/`db_procedures`/`db_proc_params`.
  - 영속: `connections.json`(메타) + OS 키링(`gitpervisor-db`, 비밀번호). `readOnly` 플래그 존재.
- **드라이버 크레이트 부재**: `sqlx`/`postgres`/`mysql`/`rusqlite` **전무** → 이게 미구현의 근본 원인.
- UI `src/components/db/ConnectionDialog.tsx`: ENGINES에 `postgres/mysql/sqlite`가 `soon:true`로 **disabled**("(곧 — M6.2)"). 호스트/포트/유저/비번 필드 + MSSQL Windows 인증 토글.
- E2E `09-db.mjs`: Mongo만(+로컬 가용 시 MSSQL).

### 2.3 설계 — `sqlx` 단일 크레이트로 3엔진 통합
3엔진을 **하나의 비동기 크레이트**로: `sqlx`(postgres+mysql+sqlite 동시 지원, 통합 Row/Column API, 동적 SQL 실행에 적합 — 컴파일타임 매크로 불필요).

- Cargo: `sqlx = { version="0.8", default-features=false, features=["runtime-tokio","postgres","mysql","sqlite","tls-native-tls","chrono","rust_decimal","uuid","json"] }`.
  - **TLS 정렬**: tiberius가 이미 `native-tls` → sqlx도 `tls-native-tls`로 통일(중복 TLS 스택·빌드 충돌 회피).
- `DbClient`에 `Pg(PgPool)`, `My(MySqlPool)`, `Sqlite(SqlitePool)` 변형 추가(풀 = 연결/해제·동시성에 견고).
- 엔진별 연결 빌더: `build_pg_client`/`build_mysql_client`/`build_sqlite_client`(`build_mongo_client`·`build_mssql_client` 패턴 미러).

### 2.4 엔진별 쿼리 매핑(커맨드 match 보강)
| 커맨드 | PostgreSQL | MySQL | SQLite |
|---|---|---|---|
| `db_databases` | `SELECT datname FROM pg_database WHERE NOT datistemplate` | `SHOW DATABASES` | 파일=단일 DB → `PRAGMA database_list` |
| `db_tables` | `information_schema.tables`(schema∉pg_catalog/information_schema) | `information_schema.tables WHERE table_schema=?` | `sqlite_master WHERE type IN('table','view')` |
| `db_query` | 동적 SQL → 통합 Row 매퍼 | 〃 | 〃 |
| `db_table_meta` | information_schema 컬럼/PK/인덱스 | 〃 | `PRAGMA table_info`/`index_list`/`foreign_key_list` |
| `db_explain` | `EXPLAIN <sql>`(읽기전용) | `EXPLAIN <sql>` | `EXPLAIN QUERY PLAN <sql>` |
| `db_update_cell`/`delete_row`/`insert_row` | PK 기준 파라미터 DML, 식별자 `"col"` | 〃 `` `col` `` | 〃 `"col"` |
| `db_procedures`/`proc_params` | 함수/프로시저 | 〃 | 없음 → 빈 배열 |

- **Row→셀 매퍼**(엔진별): int/float/text/bool/date·time/decimal/uuid/json/bytea·blob/NULL을 기존 결과 셰이프(컬럼 + 문자열화 셀)로 변환.
- **`readOnly` 강제**: 신규 엔진에도 update/delete/insert 차단 경로 적용(기존 MSSQL 경로와 동일하게 확인).

### 2.5 UI 변경
- ENGINES에서 엔진이 완성될 때마다 `soon:true` 제거(드롭다운 활성화).
- **SQLite UI 분기(필수)**: SQLite는 host/port/user/password가 아니라 **파일 경로**가 필요. `engine==="sqlite"`일 때 파일 경로 입력 + "찾아보기"(tauri dialog) 노출, host/port/유저/비번 숨김. 포트는 이미 0.

### 2.6 계약
신규 커맨드/타입/IPC **없음** — `DbEngine`·`DbConnection`·IPC 래퍼·결과 셰이프 전부 기존 그대로. 변경은 **Rust match 보강 + `DbClient` 변형 + 연결 빌더 + UI 활성화/SQLite 필드**에 국한.

### 2.7 단계·검증·위험
1. SQLite(네트워크·인증 없음, UI 파일경로) → 2. PostgreSQL → 3. MySQL. 엔진별 분할 납품.
- **E2E 이점**: SQLite는 파일 기반 → **임시 .db로 서버 없이 실통합 테스트 가능**(`09-db.mjs` 또는 신규 스위트). PG/MySQL은 가용 시에만(Mongo/MSSQL 패턴).
- 위험: ① `sqlx` 빌드시간·바이너리 증가(3 드라이버) → 필요 시 cargo feature로 토글. ② TLS 스택 정렬(위 2.3). ③ 동적 SQL 식별자 인용/인젝션 — DML은 파라미터 바인딩, 식별자는 엔진별 화이트리스트 인용.

---

## 3. PROJECTS 바 — 폴더 용량 표시

### 3.1 요구사항
좌측 PROJECTS 사이드바 각 프로젝트 바에 해당 폴더의 **디스크 사용량**을 표시.

### 3.2 현황(근거)
- `src-tauri/src/commands/disk.rs`
  - `dir_size(path) -> u64` — 스택 기반 수동 워크(외부 크레이트 없음), 심볼릭 스킵.
  - `get_target_sizes(project_ids)` — `spawn_blocking` + 프로젝트별 병렬, `TargetSize` 반환. **배치·논블로킹 패턴 검증됨**.
- `src/queries/index.ts` `useTargetSizes` — 배치 호출, `lane:"background"`, `staleTime:Infinity`, `keepPreviousData`. `useTargetSize(id)` 셀렉터.
- `src/lib/format.ts` `formatBytes()` 존재.
- `src/components/sidebar/ProjectItem.tsx` — 3행 구조(이름/상태/에이전트 · 브랜치/ahead·behind · 변경카운트). **3행(변경카운트) 옆이 배지 자리**.
- `Project { id,name,path,order,addedAt }`. `walkdir` 등 미사용.

### 3.3 설계 — `get_project_sizes` 미러
`get_target_sizes`를 미러해 **프로젝트 전체 디렉토리 크기**를 계산(`dir_size` 재사용).
```rust
#[tauri::command]
pub async fn get_project_sizes(
    state: State<'_, AppState>, project_ids: Vec<String>,
) -> Result<Vec<ProjectSize>, IpcError>;
struct ProjectSize { project_id: String, bytes: u64, error: Option<String> }
```
```ts
getProjectSizes: (ids) => call<ProjectSize[]>("get_project_sizes", { projectIds: ids },
  { timeoutMs: 120_000, attempts: 1, lane: "background" }),
useProjectSizes()/useProjectSize(id)   // useTargetSizes 미러: staleTime:Infinity, keepPreviousData
```
- UI: `ProjectItem` 3행에 `formatBytes(bytes)` 배지(HardDrive 아이콘, muted). 로딩 중엔 미표시.

### 3.4 위험·완화
- **거대 트리**(node_modules/.git/target — 수백만 파일, 수 초·수 GB) 전체 워크는 비쌈.
  - `lane:"background"`(클릭 양보) + `staleTime:Infinity`(세션당 1회) + `spawn_blocking` 병렬.
  - 컨텍스트 메뉴 "용량 새로고침"으로 수동 무효화(자동 폴링 금지).
  - 전량 포함(= "폴더 용량"의 의미). 상한/근사치는 과설계 → 미채택. 후속에서 last-size+mtime 캐시 영속 고려 가능.
- 규모 S~M: 백엔드 ~30 LOC(재사용), UI ~10 LOC.

---

## 4. Slack / email — AI 작업완료 알림

### 4.1 요구사항
터미널의 Claude가 한 턴을 끝내면 **Slack 또는 email**로 알림(원격에서도 작업 종료를 인지).

### 4.2 현황(근거)
- `src/stores/agentActivity.ts` — 1.2s 간격으로 xterm 뷰포트에서 `/esc to interrupt/i` 스캔 → working/done. `byProject`/`byTerminal` 상태.
- `src/lib/agent-notify.ts` `useAgentNotifications()` — **working→done 엣지에서 이미 OS 알림 발사**(project/terminal 모드). 트리거 포인트 2곳 존재.
- 설정: `notifyMode: "off"|"project-inactive"|"terminal"|"always"`(TS `ipc.ts` + Rust `git/types.rs`), `SettingsDialog.tsx`에 알림 섹션.
- 영속: `settings.json`(StoreExt). **`keyring` 크레이트 보유**(비밀번호). **`reqwest` 보유**(→ Slack 웹훅 그대로 사용).

### 4.3 설계 — 기존 엣지에 외부 디스패처 추가
**디스패치는 Rust에서**(email SMTP는 브라우저 불가, 시크릿은 서버측 보관). 프론트는 working→done 엣지에서 신규 커맨드 호출.

채널:
- **Slack**: Incoming Webhook URL에 `reqwest`로 `POST {"text": "..."}`. 인증=시크릿 URL뿐. **저비용·고가치 → 1순위**.
- **Email**: SMTP. 신규 크레이트 `lettre`(`tokio1-native-tls`로 TLS 정렬). 설정 多(host/port/user/from/to/TLS) → 2순위.

### 4.4 계약
```rust
// commands/notify.rs (신규)
#[tauri::command] pub async fn notify_external(app: AppHandle, title: String, body: String) -> Result<(), IpcError>; // 활성 채널로 팬아웃
#[tauri::command] pub async fn notify_test(app: AppHandle, channel: String /* "slack"|"email" */) -> Result<(), IpcError>;
```
설정 확장(`Settings`):
```
slackEnabled: bool          // 웹훅 URL은 키링(service "gitpervisor-notify", key "slack-webhook") — settings.json 평문 금지
emailEnabled: bool, smtpHost, smtpPort, smtpFrom, smtpTo, smtpTls   // SMTP 비번은 키링
```
- 프론트 `agent-notify.ts`: working→done 엣지에서 `notify_external(...)` 추가 호출(기존 OS 토스트는 유지). `notifyMode`로 게이팅(`off`면 전체 차단; `project-inactive`=창 비활성일 때만 — 원격 알림 의미와 부합) + 채널별 enable.
- UI: 알림 섹션에 Slack(enable + 웹훅 URL + "테스트 전송"), Email(enable + SMTP 필드 + 테스트) 추가.

### 4.5 위험·완화
- **시크릿**: 웹훅 URL·SMTP 비번 모두 **키링**(settings.json 평문 금지).
- **연타 스팸**: working↔done 빠른 반복 → 외부 채널은 **프로젝트당 최소 간격**(예 30s) 레이트리밋. 엣지 로직이 1차로 중복을 막지만 외부는 추가 가드.
- 규모: Slack 단독 S, email 포함 시 M. 분할 납품(Slack 먼저).
- 검증: `notify_test` 커맨드를 E2E/수동으로 호출(Slack은 실제 웹훅, email은 테스트 SMTP).

---

## 5. 크래시 내성 + 에러로그 + 디버깅 대비

### 5.1 요구사항(질문 포함)
"앱이 절대 꺼지면 안 되지만, 꺼져도 **어딘가 에러로그가 남고 그걸로 디버깅**돼야 한다 — **대비돼 있냐?**"

### 5.2 답: 엔진단은 이미 상당히 대비됨(근거)
- **Rust 패닉 훅**(`lib.rs:20-44`) — `set_hook`으로 전 스레드 패닉을 타임스탬프 + `Backtrace::force_capture()`와 함께 `panic.log`에 append, `log::error!`도 병행. 시작 시 설치. release에서 **`panic=unwind` 유지**(커맨드 패닉이 앱 전체를 죽이지 않음).
- **파일 로깅** — `tauri-plugin-log`(Info, 10MB), 콘솔+파일. 프론트 콘솔도 미러.
- **프론트** — `ErrorBoundary`(componentDidCatch→logFatal) + 전역 `error`/`unhandledrejection` → logError.
- **구조화 에러** — `error.rs` `IpcError`+`ErrorCode`, 모든 커맨드 `Result<T,IpcError>`.
- 로그 위치(Win): `%APPDATA%\Roaming\com.greathoon.gitpervisor\logs\`(`gitpervisor.log`, `panic.log`).

→ **"조용히 죽지 않는다"는 충족**. 빈틈은 **관측성·복구 UX·로그 증가 제어**.

### 5.3 설계 — 관측·복구 보강
1. **로그 접근 UI**: `open_logs_folder()` 커맨드(`tauri-plugin-opener`로 `app_log_dir` 열기) + 설정에 "로그 폴더 열기"/"패닉 로그 보기" 버튼.
2. **무한 증가 차단**: 현재 `RotationStrategy::KeepAll`(무한) → 시작 시 **로그 디렉토리 프루닝**(총량 예: 50MB 또는 최근 N개 초과 삭제). `panic.log`도 크기 상한·`panic.log.1` 회전.
3. **이전 크래시 감지 토스트**: 시작 시 `panic.log` mtime이 마지막 확인 마커보다 최신/신규 내용이면 배너/토스트 "이전 실행에서 오류 감지 — 로그 보기", 확인 시 마커 갱신.
4. **런타임 에러 경로 정렬**(`lib.rs:273`): 현재 로그만 → 패닉 훅처럼 `panic.log`에 타임스탬프/맥락 기록.
5. (옵션) 로그 레벨 토글(Info→Debug) 설정.

### 5.4 "절대 안 꺼짐"에 대한 정직한 입장
완전 무중단은 불가. **자동 재시작 슈퍼바이저는 비채택**(이중 실행·업데이트 루프·좀비 위험). 대신 **인프로세스 복원력 극대화**(`panic=unwind` 이미 적용, 단일창 종료가 플로팅 창 존재 시 앱을 죽이지 않도록 확인) + **모든 크래시를 진단가능**하게. 이 트레이드오프를 문서로 명시.

### 5.5 계약
```rust
open_logs_folder(app) -> Result<(), IpcError>;
read_crash_log(app, max_bytes: u64) -> Result<String, IpcError>;   // 인앱 뷰어용 tail
clear_crash_log(app) -> Result<(), IpcError>;
get_log_status(app) -> Result<LogStatus, IpcError>;  // { lastCrashAt?, panicLogBytes, logDir }
```
- Rust 시작 프루닝 함수 + 프론트 설정 버튼 + 시작 크래시 배너.
- 검증(E2E): `open_logs_folder`/`read_crash_log`/`get_log_status` 호출·반환 단언, 프루닝 후 총량 상한 확인.
- 규모 M(작은 조각 다수).

---

## 6. 윈도우 알림 — gitpervisor 아이콘 누락

### 6.1 요구사항
Windows 토스트 알림에 gitpervisor 아이콘이 안 보임 → 보이게.

### 6.2 근본 원인(근거)
- `src/lib/agent-notify.ts:29-36` `sendNotification({title, body})` — **icon 미지정**.
- **AUMID 미등록**: Windows 토스트 아이콘은 호출 앱의 **AppUserModelID(AUMID)** → Windows가 **시작 메뉴 바로가기**(AUMID 속성 + 아이콘 보유)에서 해석. **dev(`tauri dev`)는 설치 앱·바로가기가 없어 일반 아이콘** 표시.
- NSIS 설정(`tauri.conf.json`) 최소(`perMachine`+Korean) — 바로가기/AUMID 명시 없음.
- `icons/icon.ico` **유효·존재**(멀티해상도). 즉 아이콘 자산 문제 아님.

### 6.3 설계 — AUMID/바로가기 + 검증
1. **설치빌드 우선**: NSIS가 **시작 메뉴 바로가기(AUMID=identifier `com.greathoon.gitpervisor`, 아이콘=icon.ico)**를 만들도록 보장(Tauri NSIS 기본 동작이나 **설치 후 토스트로 실측 확인**). 필요 시 `nsis`에 `createDesktopShortcut`/바로가기 설정 보강.
2. **런타임 AUMID 정렬**: setup()에서 `SetCurrentProcessExplicitAppUserModelID(identifier)` 설정 — 동일 AUMID 바로가기가 있으면 dev에서도 아이콘 해석 가능성↑.
3. **명시 아이콘(벨트앤서스펜더)**: `sendNotification({ title, body, icon })` — 무시돼도 무해.
4. **문서화**: **dev 토스트는 일반 아이콘이 정상** — 실제 아이콘은 빌드+설치로 검증.

### 6.4 미해결(실측 필요)
- Tauri 2.11.2 notification 플러그인이 **런타임 AUMID 설정**을 존중하는지, NSIS 바로가기가 이미 AUMID를 세팅하는지 → **설치 빌드에서 직접 확인**.
- 토스트 아이콘은 **자동검증 불가(수동 시각 확인)**. 규모 S(코드<설정·검증).

---

## 7. 교차 관심사·테스트 전략

- **경로/시크릿 보안 일관성**: 작업 1은 `resolve_in_repo`/`is_dotgit_component` 재사용([[gitpervisor-fs-command-path-safety]] 메모), 작업 4는 키링([[gitpervisor-... db]] 패턴) — 새 평문 시크릿 도입 금지.
- **E2E(CDP, `tests/e2e/`)**: 직접 invoke 가능 → 작업 1(파일생성), 2(**SQLite 임시 .db 실통합**), 3(폴더용량), 4(`notify_test`), 5(로그 커맨드) 커버. 작업 6은 **수동 시각 확인**(설치빌드 토스트).
- **빌드 영향**: 작업 2(`sqlx`)·4(`lettre`)가 의존성·빌드시간 증가 → feature 게이트 검토.
- **납품 단위**: 각 작업 독립 커밋·피처 브랜치. 작업 2는 엔진별(SQLite→PG→MySQL), 작업 4는 채널별(Slack→email) 분할.

## 8. 완료 정의(DoD)
- [ ] 1: 임의 확장명 파일 생성·중복/`..`/`.git`/예약명 거부 E2E 통과, 생성 후 뷰어 오픈.
- [ ] 2: PG/MySQL/SQLite 연결·조회·메타·EXPLAIN·DML(readOnly 준수) 동작, UI 활성화, SQLite 파일경로 UI, SQLite E2E 통과.
- [ ] 3: 모든 프로젝트 바에 용량 배지, 백그라운드 비차단, 수동 새로고침.
- [ ] 4: working→done에서 Slack/email 발사(시크릿 키링, 레이트리밋), 설정 UI + 테스트 전송.
- [ ] 5: 로그 폴더 열기/패닉로그 보기, 로그 증가 상한, 이전 크래시 토스트, 런타임 에러 기록 정렬.
- [ ] 6: 설치빌드 토스트에 앱 아이콘 표시(수동 확인), dev 한계 문서화.
