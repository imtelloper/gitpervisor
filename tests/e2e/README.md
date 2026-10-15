# gitpervisor E2E 테스트

실행 중인 **디버그 빌드**에 Chrome DevTools Protocol(원격 디버깅 포트 `29222`)로 붙어,
`window.__TAURI_INTERNALS__.invoke(...)` 로 모든 Tauri 커맨드(~60개)를 직접 구동해
전체 기능을 검증하는 런타임 E2E 스위트입니다. (기존 `scripts/verify-*.mjs` 패턴을 일반화)

## 실행

```bash
# 기본: 드라이버가 .dev identifier 로 앱을 직접 빌드·실행하고 샤드마다 데이터를 가른다(앱 3개 병렬)
npm run test:e2e                              # = node tests/e2e/shard.mjs
GPV_E2E_ONLY=25 node tests/e2e/shard.mjs 1    # 스위트 하나만, 깨끗한 새 앱 하나에서

# 이미 떠 있는 내 디버그 앱(npm run dev:app)에 붙을 때 — 포트를 꼭 준다
GPV_E2E_PORT=29222 node tests/e2e/run.mjs
```

러너(`run.mjs`)는 `GPV_E2E_PORT` 가 없으면 바로 실패한다 — 포트를 스캔하면 남의 dev 앱에 픽스처를
심을 수 있기 때문이다(2026-09-16). `suites/` 에 파일을 추가하면 `run.mjs` 의 `SUITES` 에도 넣어야 한다 —
빠뜨리면 러너 자체 검사가 빨갛다.

> 별도 의존성 없음 — Node 18+ 의 내장 `fetch`/`WebSocket` 만 사용합니다.
> 종료 코드: 전부 통과 시 `0`, 한 건이라도 실패 시 `1` (CI 연동 가능).

## 안전성 (사용자 데이터 보호)

- 모든 git 변경 테스트는 **임시 디렉토리의 격리된 픽스처 레포 + 로컬 bare 원격**에서만 수행됩니다.
  사용자의 실제 등록 프로젝트는 **읽지도 쓰지도 않습니다**.
- 시작 시 `설정/프로젝트 목록/DB 연결/메모`를 **스냅샷**하고, 끝나면 추가분을 제거하고 **원복**합니다.
  마지막 "정리 · 사용자 상태 복원 검증" 스위트가 원상복구를 직접 확인합니다.
- 네트워크가 없으면 API 클라이언트 네트워크 테스트는 자동 **SKIP**,
  로컬 DB 서버가 없으면 DB CRUD 는 자동 **SKIP** 됩니다(연결 메타 저장/삭제/오류분류는 항상 검증).

## 커버리지 (커맨드 → 스위트)

| 스위트 | 커맨드 |
|---|---|
| `01-system` | `check_git`, `sys_metrics`, `get_settings`, `set_settings` |
| `02-projects-tree` | `list_projects`, `add_project`, `remove_project`, `list_dir`, `list_project_roots`, `open_in`, `write_file` |
| `03-status-changes` | `get_statuses`, `stage_files`, `unstage_files`, `discard_files`, `commit`, `get_file_diff`, `get_file_diffs` |
| `04-sync-history` | `push`, `pull`, `fetch`, `get_branches`, `get_log`, `get_commit_detail` |
| `05-notes` | `get_notes`, `add_memo`, `update_memo`, `delete_memo` |
| `06-terminal` | `term_open`, `term_write`, `term_resize`, `term_paste`, `term_close` |
| `07-browser` | `browser_open/navigate/back/forward/reload/stop/set_bounds/set_visible/focus/blur/close/scan_dev_ports` |
| `08-apiclient` | `http_request`, `http_cancel` |
| `09-db` | `db_list_connections`, `db_save_connection`, `db_connect`, `db_disconnect`, `db_databases`, `db_delete_connection`; `db_tables`/`db_query`/`db_table_meta`/`db_explain`/`db_procedures`/`db_proc_params`/`db_update_cell`/`db_delete_row`/`db_insert_row` (등록+가드 검증; 풀 CRUD 는 로컬 DB 서버 있을 때만) |
| `10-codenav` | `find_definition` (정의 점프 — git grep -P 휴리스틱) |
| `11-disk` | `get_target_sizes`, `clean_target` (cargo target 측정·정리 — 격리 픽스처에서만) |

> 모든 부정(오류 기대) 단언은 `E2E_TIMEOUT` 을 실패로 간주하지 않도록 실제 오류코드를 검사해 false-pass 를 막습니다.

## 구조

```
tests/e2e/
  run.mjs            # 오케스트레이터: 연결→스냅샷→픽스처 추가→스위트 직렬 실행→복원→요약
  lib/
    cdp.mjs          # CDP 클라이언트(invoke / try / openChannel) — 공유 플러밍
    report.mjs       # 초경량 리포터(suite/check/skip/summary, 종료코드)
    git-fixture.mjs  # 임시 레포 + bare 원격 생성/시드/정리
  suites/01..09      # 기능별 스위트 (export name, run(ctx))
```
