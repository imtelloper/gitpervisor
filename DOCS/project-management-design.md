# 프로젝트 관리(자동 작업 기록) — 기능 설계서

> 상태: 설계(Design) · 대상: gitpervisor 0.4.0 (Tauri 2.11.2 + React 19 + TS) · 전 플랫폼
> 산출물 성격: `/sc:design` — 구현 코드가 아니라 아키텍처·데이터 모델·수집 계약·단계 계획. 시그니처 스케치는 포함, 본문 구현은 제외.
> 자매 설계서: `DOCS/task/04-git-remote-freshness.md`(배경 작업 예산·백오프 규약), `DOCS/image-annotation-design.md`(§체계·리스크 레지스터 형식), `DOCS/process-leak-postmortem.md`(**이 설계의 가장 강한 제약**).
> 근거: 2026-08-21 코드베이스 실측. 인용한 `파일:라인`은 전부 직접 확인했다.

---

## 0. 요구사항

사용자 원문:

> "내가 gitpervisor로 각 프로젝트 코드짜고 커밋하고 그러는거 좀 기록하고 프로젝트 관리를 하고 싶다.
>  **내가 열심히 코드짜고 일하면 알아서 다 기록되어서 보여주는** 그런식으로.
>  모아보기 옆에 프로젝트 관리 버튼 만들고, 그거 누르면 모아보기처럼 프로젝트 관리창 켜지면 되겠다."

해석 — 요구사항 3개로 분해한다.

| # | 요구 | 성공 판정 |
|---|---|---|
| **R-A** | **입력 0.** 사용자가 타이머를 켜거나 항목을 적지 않는다. 평소처럼 일하면 기록이 쌓인다 | 이 기능을 켠 뒤 사용자가 한 추가 행동 = 0회 |
| **R-B** | **기록의 대상은 "일한 것"**: 언제·어느 프로젝트에·얼마나·무엇을(커밋/AI 작업) | 하루를 되짚었을 때 "오늘 뭐 했지"에 답이 됨 |
| **R-C** | **진입은 모아보기와 동일한 관용구**: 타이틀바 버튼 → 메인 안 전체 패널, 우클릭 → 별도 창 | 모아보기를 아는 사용자가 설명 없이 씀 |

**범위 밖(명시적 제외)**: 이슈 트래커, 칸반 보드, 시간 청구서, 팀 공유, 서버 전송. 이 앱은 로컬 데스크톱 도구다 — 기록은 **한 대의 기계 안에서 끝난다**(§7 프라이버시).

---

## 1. 결론 — 4줄 요약

1. **새 감시 장치를 만들지 않는다.** 필요한 신호는 이미 전부 앱 안에서 발화하고 있다 — 워처는 `.git/HEAD`·`refs/**`를 이미 보고 있고(`watcher.rs:171-182`), 워크트리 변경도 이미 400ms 디바운스로 올라온다. 이 설계는 **이미 흐르는 이벤트에 기록기를 얹을 뿐**, 새 폴링 루프를 하나도 추가하지 않는다.
2. **시간 모델은 "세션"이 아니라 "5분 슬롯"이다.** 세션 상태기계(시작/유휴/종료)는 크래시·다중 창·시계 점프에서 전부 깨진다. 대신 신호가 닿은 5분 버킷을 멱등하게 UPSERT하고, 세션은 **읽을 때 인접 슬롯을 병합해 만든다.** 상태가 없으므로 깨질 것도 없다(§3.1).
3. **저장소는 SQLite 한 파일**(`activity.db`). `sqlx`가 이미 `sqlite` 피처로 트리에 있어 **새 크레이트 0개**다(`Cargo.toml:50`). 기존 JSON(read-modify-write)로는 시계열 누적이 매 쓰기마다 O(전체)가 된다.
4. **창은 `label="manage"` 싱글턴** — 모아보기의 검증된 레시피를 그대로 복사한다. 다만 **PTY 소유권 이전 문제가 없어 모아보기보다 훨씬 단순하다**(읽기 전용 뷰라 두 창이 동시에 떠도 무해).

---

## 2. 현황 실측

### 2.1 이미 있는 것 — "공짜 하트비트"

이 표가 이 설계의 근거 전부다. 오른쪽 열이 **추가 비용**이다.

| 신호 | 무엇을 알려주나 | 출처(실측) | 추가 비용 |
|---|---|---|---|
| 워크트리 파일 변경 | "지금 이 프로젝트에서 코드를 쓰고 있다" | `watcher.rs:71-79` — `repo://changed` emit, 400ms 디바운스, `node_modules`/`target` 등 18종 제외(`:233-253`) | **0** — 이미 발화 중 |
| `.git/HEAD` 변경 | 커밋·브랜치 전환·머지·리베이스 | `watcher.rs:258-278` `is_relevant()` 통과 목록에 `HEAD`·`ORIG_HEAD`·`MERGE_HEAD` 있음 | **0** |
| `.git/refs/**` 변경 | 커밋 생성, 원격 갱신 | `watcher.rs:175-181` — `refs`만 **Recursive**로 등록(`objects/`는 의도적 제외) | **0** |
| 앱 내 git 작업 | stage/commit/discard/push/pull/fetch 시각 | `commands/actions.rs:46`(commit), `commands/sync.rs:27,41,50` | **0** — 함수 끝에 한 줄 |
| 터미널 입력 확정 | "터미널에서 뭔가 시켰다" + **그 문장 자체** | `lib/prompt-capture.ts` → `stores/promptHistory.ts` (이미 localStorage 영속) | **0** |
| AI 에이전트 작업중/완료 | AI 턴의 시작·끝 (working→done 엣지) | `stores/agentActivity.ts:85-101` — 1.2s 간격 xterm 버퍼 스캔, 이미 상시 동작 | **0** |
| 커밋 메타데이터 | sha·저자·시각·제목·refs | `git/parse_log.rs` + `commands/log.rs:14`(`LOG_FORMAT`) | git log 1회/수확 |
| 미커밋 변경 수 | "커밋 안 한 게 쌓여 있다" | `git/types.rs` `RepoStatus.staged/unstaged/untracked` | 기존 `get_statuses` 재사용 |

**즉, "열심히 코드짜고 일하면"에 해당하는 신호는 이미 100% 앱 안을 흐르고 있다. 아무도 그걸 적어두지 않았을 뿐이다.**

### 2.2 없는 것 (이번에 만든다)

| 없는 것 | 만들 것 |
|---|---|
| 시계열 영속 저장소 | `src-tauri/src/activity/store.rs` — SQLite 1파일 |
| 신호 → 슬롯 집계기 | `src-tauri/src/activity/mod.rs` — 메모리 버퍼 + 60초 flush |
| 커밋 수확기 | `src-tauri/src/activity/harvest.rs` — refs 변경 트리거, 디바운스 |
| 프론트 신호 배치 보고 | `src/lib/activity-report.ts` — 30초 배치 1 invoke |
| 관리 화면 | `src/components/manage/**`, `src/ManageWindow.tsx` |
| 창 | `open_manage_window`(lib.rs), `label="manage"` |

### 2.3 이 설계가 반드시 지켜야 할 제약 — 2026-08 OOM 사건

`CLAUDE.md`와 `DOCS/process-leak-postmortem.md`가 못박은 사실:

> 배경 fetch가 6일간 2만 회 돌았고(P0-4), 재귀 watch가 184,001개 inotify(≈180MB)를 잡았고(P0-3), 자식 프로세스가 387개까지 쌓여 **systemd-oomd가 앱을 통째로 SIGKILL** 했다.

**"모든 프로젝트를 주기적으로 훑는 기록기"는 정확히 그 사건의 재현이다.** 그래서 이 설계는 다음을 **불변식**으로 둔다:

| 불변식 | 근거 |
|---|---|
| **I-1. 타이머가 git 프로세스를 낳지 않는다.** 주기 작업은 "메모리 버퍼 → SQLite UPSERT" 뿐이다 | 프로세스 폭주의 유일한 원인은 subprocess spawn이다. UPSERT는 spawn이 아니다 |
| **I-2. git 수확은 오직 3가지 트리거에서만.** (a) 워처가 그 레포의 refs 변경을 보고했을 때 (b) 앱 시작 시 1회(스태거) (c) 사용자가 관리 창을 열었을 때 | 전부 **사건 기반**이거나 **사용자 행동**이다. "그냥 5분마다"는 없다 |
| **I-3. 동시 수확 상한은 전역 세마포어 2.** `fetch_scheduler.rs:66-75`의 `FETCH_SEM`과 같은 이유로 **프로세스 전역 1개**여야 한다 | 사이클이 겹치면 상한이 곱해진다(그 파일 주석의 실제 사건) |
| **I-4. 새 파일 감시 0개.** 워처를 새로 걸지 않는다 — 기존 `repo://changed`에 얹는다 | inotify 하나 = 커널 메모리 ~1KB 고정 |
| **I-5. 기록 실패는 절대 사용자 작업을 막지 않는다.** 모든 기록 호출은 fire-and-forget, 오류는 로그만 | 커밋이 기록기 때문에 실패하면 그 순간 이 기능은 순손실이다 |

§4.5에 예산표로 정량화한다.

---

## 3. 데이터 모델 — 이 기능의 심장

### 3.1 왜 "세션"이 아니라 "5분 슬롯"인가

직관적 설계는 세션 상태기계다: 첫 신호에 세션을 열고, 15분 유휴면 닫는다. **이 앱에서는 그게 못 쓴다.**

| 세션 상태기계의 파탄 | 이 앱에서 실제로 일어나는 일 |
|---|---|
| 크래시 시 열린 세션이 유실되거나 무한대로 남는다 | systemd-oomd SIGKILL은 종료 훅을 **한 줄도** 안 돌린다(`health/session.rs:1-7`). 이미 겪은 실패 모드다 |
| 다중 창이 같은 세션을 두 번 연다 | 모아보기 별도 창이 터미널 소유권을 가져간다 — 신호 발생 창이 바뀐다(`lib/aggregate-window.ts § 소유권 이전`) |
| 시계 점프/절전 복귀에 세션 길이가 폭발 | 노트북 뚜껑을 닫으면 세션이 8시간짜리가 된다 |
| "지금 유휴인가"를 판정하려면 타이머가 필요 | I-1 위반 |

**슬롯 모델**: 시각을 300초 격자로 나누고, 신호가 닿은 칸을 켠다.

```
slot = floor(epoch_secs / 300) * 300          ← UTC 기준, 300의 배수

09:00  09:05  09:10  09:15  09:20  09:25  09:30
  ▓      ▓      ·      ▓      ▓      ▓      ·      ← 켜진 칸 = 활동
  └── 세션 A ──┘      └───── 세션 B ─────┘         ← 읽을 때 병합해서 만든다
  활동 시간 = 켜진 칸 5개 × 5분 = 25분
```

이것이 사는 이유:

- **멱등**. 같은 슬롯에 신호가 100번 와도 결과가 같다 → 재시도·중복 보고·다중 창이 전부 무해.
- **상태 없음**. "열린 세션"이라는 것이 존재하지 않으므로 크래시로 잃을 것이 없다. 최악의 손실은 **마지막 flush 이후 최대 60초**.
- **자연 유휴 처리**. 절전/자리 비움은 그냥 칸이 안 켜진다. 타이머도 유휴 판정도 필요 없다.
- **집계가 공짜**. 하루 = 288칸. `SUM`/`COUNT`가 곧 시간이다.
- **세션은 파생물**. 병합 규칙(빈 칸 ≤ N개면 이어붙임)을 나중에 바꿔도 **과거 데이터를 재계산할 필요가 없다**. 세션을 저장했다면 정책 변경 = 마이그레이션이다.

**대가(정직하게 명시)**: 5분 버킷은 **올림 편향**이다. 한 슬롯에 키를 한 번만 눌러도 5분이 잡힌다. 반대로 "코드를 읽으며 생각만 한 20분"은 조작 신호가 없으면 안 잡힌다. 따라서 이 수치는 **측정이 아니라 추정**이고, UI는 "활동 시간(추정)"으로 라벨하며 툴팁에 산식을 그대로 노출한다. 사용자를 속이지 않는 것이 정확도보다 중요하다.

### 3.2 스키마

`app_data_dir/activity.db` — WAL, `synchronous=NORMAL`.

```sql
-- ── 활동 슬롯: 이 기능의 기본 단위 ──────────────────────────────────────────
CREATE TABLE slot (
  project_id TEXT    NOT NULL,
  slot       INTEGER NOT NULL,           -- epoch초, 300의 배수(UTC)
  sources    INTEGER NOT NULL DEFAULT 0, -- 비트마스크(아래)
  edits      INTEGER NOT NULL DEFAULT 0, -- 이 슬롯의 워크트리 변경 이벤트 수(강도 표시용)
  ai_ms      INTEGER NOT NULL DEFAULT 0, -- 이 슬롯과 겹친 AI 작업 시간(ms)
  PRIMARY KEY (project_id, slot)
) WITHOUT ROWID;
CREATE INDEX slot_by_time ON slot(slot);

-- ── 커밋: 수확된 사실 ────────────────────────────────────────────────────────
CREATE TABLE commit_log (
  sha          TEXT PRIMARY KEY,
  project_id   TEXT    NOT NULL,
  authored_at  INTEGER NOT NULL,         -- epoch초
  author_name  TEXT    NOT NULL,
  author_email TEXT    NOT NULL,
  subject      TEXT    NOT NULL,
  refs         TEXT,                     -- 수확 시점 데코레이션 원문(%D)
  files        INTEGER NOT NULL DEFAULT 0,
  insertions   INTEGER NOT NULL DEFAULT 0,
  deletions    INTEGER NOT NULL DEFAULT 0,
  is_merge     INTEGER NOT NULL DEFAULT 0,
  mine         INTEGER NOT NULL DEFAULT 1  -- author_email == 그 레포의 user.email
);
CREATE INDEX commit_by_project_time ON commit_log(project_id, authored_at);
CREATE INDEX commit_by_time         ON commit_log(authored_at);

-- ── AI 턴: 무엇을 시켰고 얼마나 걸렸나 ───────────────────────────────────────
CREATE TABLE ai_turn (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT    NOT NULL,
  term_id    TEXT    NOT NULL,
  started_at INTEGER NOT NULL,           -- epoch ms
  ended_at   INTEGER NOT NULL,
  prompt     TEXT,                       -- 500자 절단, 설정으로 저장 끄기 가능
  UNIQUE (project_id, term_id, started_at)
);
CREATE INDEX ai_by_project_time ON ai_turn(project_id, started_at);

-- ── 메타 ─────────────────────────────────────────────────────────────────────
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- schema_version                       스키마 버전
-- watermark:<projectId>                마지막 수확한 커밋의 authored_at
-- backfill:<projectId>                 최초 백필 완료 표식
-- pruned_on                            마지막 프루닝 날짜(YYYY-MM-DD)
```

`sources` 비트마스크:

| 비트 | 이름 | 의미 | 발원 |
|---|---|---|---|
| 1 | `EDIT` | 워크트리 파일 변경 | Rust · watcher |
| 2 | `GIT` | `.git` HEAD/refs 변경 | Rust · watcher |
| 4 | `APP_OP` | 앱 내 git 작업(stage/commit/push/pull) | Rust · commands |
| 8 | `TERMINAL` | 터미널 입력 Enter 확정 | Front · prompt-capture |
| 16 | `AI` | AI 에이전트 작업 중 | Front · agentActivity |
| 32 | `INTERACT` | 앱 UI 조작(diff 스크롤·트리 클릭 등) | Front · 스로틀 리스너 |

**활동 슬롯 판정**: `sources != 0`. 즉 여섯 신호 중 **하나라도** 있으면 활동으로 센다.

> **왜 "창 포커스"는 신호가 아닌가.** 포커스만으로 세면 앱을 켜둔 채 자리를 비운 8시간이 노동으로 잡힌다. 반대로 조작을 전부 빼면 "diff를 40분 읽은 코드 리뷰"가 0분이 된다. 그래서 **포커스가 아니라 조작(`INTERACT`)** 을 신호로 삼는다 — 읽고 스크롤하면 잡히고, 자리를 비우면 안 잡힌다. 두 극단보다 엄격히 낫다.

### 3.3 저장소 선택 — 왜 SQLite인가

| 옵션 | 장점 | 치명점 | 판정 |
|---|---|---|---|
| **기존 JSON**(`state.rs` 패턴) | 코드 패턴 재사용, 손상 격리 이미 구현 | **쓰기마다 O(전체 파일)**. `save_json_at`은 전체 직렬화 후 원자적 rename(`state.rs:160`)이다. 1년치 수십만 슬롯을 60초마다 통째로 다시 쓴다 | ❌ |
| **JSONL 일별 파일** | append O(1), 사람이 읽을 수 있음, 프루닝 = 파일 삭제 | 집계마다 전체 스캔. "90일 프로젝트별 일별 커밋 수"에 90개 파일 파싱. 창 열 때마다 | ❌ |
| **SQLite (sqlx)** | 인덱스·GROUP BY·트랜잭션·UPSERT 멱등, 수년 데이터 무리 없음, **새 크레이트 0** (`Cargo.toml:50`에 `sqlite` 피처 이미 존재) | 두 번째 영속 패러다임 도입, 스키마 마이그레이션 책임 | ✅ **채택** |
| rusqlite 신규 도입 | 동기 API가 더 단순 | 새 크레이트 + 두 번째 sqlite 링크(sqlx가 이미 libsqlite3 번들) | ❌ |

**구현 제약(실측)**: `Cargo.toml:50`의 sqlx는 `default-features = false`라 **`macros` 피처가 없다.** 따라서 `sqlx::query!` 컴파일타임 매크로는 쓸 수 없고, `db.rs`가 이미 그러하듯(`db.rs:1508,1592`) 런타임 `sqlx::query(...).bind(...)`만 쓴다. `Any` 드라이버(`ensure_sql_drivers`, `db.rs:1376`)는 **거치지 않는다** — `SqlitePool`을 직접 연다. 사용자 DB 워크스페이스와 코드 경로가 섞이지 않아야 한다.

### 3.4 손상·실패 처리

`state.rs:115-158`의 격리 철학을 그대로 따른다 — 다만 한 가지를 더 얹는다:

- 열기/마이그레이션 실패 → `activity.db.corrupt`로 rename → 새로 생성 → `log::error!` + 토스트 1회.
- **부팅을 막지 않는다.** 기록은 부가 기능이다. `AppState`에 `activity: Option<ActivityStore>`로 들고, `None`이면 모든 기록 호출이 no-op이며 관리 창은 "기록을 사용할 수 없습니다" 안내를 띄운다.
- 쓰기 오류는 삼키지 않고 로그에 남기되 호출자에게 전파하지 않는다(I-5).

### 3.5 보존·프루닝

| 테이블 | 기본 보존 | 근거 |
|---|---|---|
| `slot` | 24개월 | 실사용 추정 하루 40~120행(전 프로젝트 합) → 2년 ≈ 9만행. 무시할 크기 |
| `commit_log` | 무제한 | 커밋 하나 ≈ 200바이트. 1만 커밋 = 2MB |
| `ai_turn` | 12개월. **`prompt`는 90일 후 NULL로 비운다** | 프롬프트는 가장 민감하고 가장 빨리 쓸모없어진다 |

프루닝은 **앱 시작 시, 하루 1회만**(`meta.pruned_on` 비교). `VACUUM`은 자동으로 돌리지 않는다(수백 ms 블로킹) — 설정에 "기록 정리" 버튼으로 수동 제공.

---

## 4. 수집 파이프라인

```
 [Rust]                                                    [Front]
  watcher.rs  ──repo://changed 콜백 안에서 분기──┐            agentActivity(1.2s 스캔)
    ├ 워크트리 경로 → EDIT                       │              └ working→done 엣지
    └ .git/HEAD·refs → GIT + refs-dirty 표시     │            prompt-capture(ptyWrite)
  actions.rs / sync.rs ──────── APP_OP ─────────┤              └ Enter 확정 줄
                                                │            UI 조작 리스너(스로틀)
                                                ▼                       │
                                   activity::note(project, sources)     │ 30초 배치
                                                │                       │ 1 invoke
                                   메모리 슬롯 버퍼(Mutex<HashMap>)  ◀───┘ activity_report
                                                │
                        flush: 60초 · 수확 직후 · 읽기 커맨드 진입 · 종료 훅
                                                ▼
                                        activity.db (UPSERT)
                                                ▲
                                   harvest.rs ──┘   refs-dirty → 3초 디바운스 → git log --numstat
                                                        (전역 세마포어 2, 프로젝트당 최소 간격 30초)
```

### 4.1 신호 → 슬롯 (Rust)

```rust
// src-tauri/src/activity/mod.rs
pub const SLOT_SECS: i64 = 300;

bitflags-스타일 상수: EDIT=1, GIT=2, APP_OP=4, TERMINAL=8, AI=16, INTERACT=32

/// 신호 1건 기록 — 절대 실패하지 않는다(I-5). 락은 HashMap 갱신 구간만.
pub fn note(project_id: &str, sources: u32, edits: u32);

/// 메모리 버퍼를 DB로 내린다. 버퍼가 비어 있으면 **DB를 열지도 않는다.**
pub async fn flush();
```

`watcher.rs`의 기존 콜백 안에서 분기한다 — 새 감시 없음(I-4):

```rust
// watcher.rs — 기존 relevant 판정(:69) 옆에 한 줄 추가
let mut src = 0;
for e in &events {
    for p in &e.paths {
        if !is_relevant(p) { continue; }
        if is_git_marker(p) { src |= GIT; } else { src |= EDIT; }
    }
}
if src != 0 {
    activity::note(&project_id, src, edit_count);
    if src & GIT != 0 { harvest::mark_dirty(&project_id); }   // §4.2
}
```

> **주의**: 이 콜백은 디바운서 이벤트 스레드다. `activity::note`는 **HashMap 갱신만** 하고 즉시 반환해야 한다. DB I/O를 여기서 하면 워처가 막히고, `watcher.rs:124-127` 주석이 경고하는 락 교착 계열의 문제로 되돌아간다.

앱 내 git 작업은 각 커맨드 끝에 한 줄:

```rust
// commands/actions.rs:46 commit(), sync.rs:27/41/50 push/pull/fetch
activity::note(&project_id, activity::APP_OP, 0);
```

### 4.2 커밋 수확

**트리거는 오직 refs 변경(I-2).** 커밋이 어디서 나든 — 앱의 커밋 버튼, 터미널의 `git commit`, Claude Code의 자동 커밋 — `.git/refs/heads/*`가 바뀌므로 워처가 잡는다(`watcher.rs:175-181`이 `refs`를 Recursive로 등록한 덕분이다).

```
refs 변경 → mark_dirty(project)
          → 3초 디바운스(연속 커밋·리베이스의 폭주 흡수)
          → 프로젝트당 최소 간격 30초 게이트
          → 전역 세마포어(2) 획득
          → git log 1회
          → INSERT OR IGNORE (sha PK가 중복을 흡수)
          → watermark 갱신 → flush()
```

수확 명령:

```
git log --all --since=<watermark - 2일> --max-count=500 --numstat
        --pretty=format:%x01%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D
```

- `%x01` 레코드 마커로 커밋 경계를 잡고, 그 뒤 `add\tdel\tpath` 줄을 합산한다. 바이너리는 `-\t-\tpath`(0으로 계산).
- **`--shortstat`을 쓰지 않는 이유**: gettext 번역 대상이라 로케일에 따라 문구가 바뀐다. `--numstat`은 기계 판독 포맷이라 번역되지 않는다.
- **`-z`를 쓰지 않는 이유**: 기존 `LOG_FORMAT`(`commands/log.rs:14`)은 `-z`와 한 쌍이지만 numstat과 섞이면 파싱이 모호해진다. 수확기는 **자체 파서**를 갖는다 — 로그 패널의 계약을 건드리지 않는다.
- `--since`에 **2일 겹침**을 준다: 시계 스큐·리베이스로 과거 시각의 커밋이 새로 생길 수 있다. sha가 PK라 중복 삽입은 무해하다.
- 500개 상한에 걸리면 로그를 남기고 `--until=<가장 오래된 수확분>`으로 **최대 5라운드** 이어받는다. **조용한 절단은 하지 않는다.**
- `mine` 판정: 레포별 `git config user.email`을 1회 조회해 캐시(프로세스 수명). 팀 레포를 pull하면 남의 커밋이 대량 유입되므로, 기록은 하되 UI 기본 필터는 `mine=1`이다.

`runner::run_git(Some(&repo), &args, READ_TIMEOUT_SECS)`를 그대로 쓴다 — 타임아웃·git 경로 오버라이드·플래그 인젝션 방어가 이미 그 안에 있다(`git/runner.rs:9,46-50`).

### 4.3 최초 백필 — "처음 켰는데 이미 채워져 있다"

기능을 처음 켜면 빈 화면이다. 그러면 아무도 두 번 열지 않는다. 그래서 **첫 실행에 지난 90일 커밋을 한 번 긁는다.**

- 프로젝트당 1회(`meta.backfill:<id>`), 앱 시작 후 **10초 지연 + 프로젝트마다 2초 스태거**(콜드스타트 IPC 폭주와 겹치지 않게 — `App.tsx:76`의 업데이트 확인이 4초 지연을 두는 것과 같은 이유).
- 세마포어 2 공유, 프로젝트당 최대 2000커밋.
- **슬롯은 백필하지 않는다.** 과거의 "활동 시간"은 알 수 없는 값이다. 지어내지 않는다 — 백필 이전 구간은 타임라인에 "커밋만 있음"으로 표시한다.
- 진행 상황은 관리 창 상단에 조용한 줄로("지난 90일 기록을 불러오는 중 3/12").

### 4.4 프론트 신호 배치 보고

WebView2 동시 invoke 유실 대응으로 이 저장소가 이미 쓰는 **배치 1회** 규약을 따른다(`DOCS/task/00-INDEX.md §3`).

```ts
// src/lib/activity-report.ts
type ActivityEvent =
  | { kind: "interact"; projectId: string; at: number }                    // epoch ms
  | { kind: "terminal"; projectId: string; at: number }
  | { kind: "ai"; projectId: string; termId: string;
      startedAt: number; endedAt: number; prompt?: string };

// 30초마다 / visibilitychange(hidden) / beforeunload 에 1회 invoke
ipc.activityReport(events)   // 최대 200건, 초과분은 버리되 log.warn (조용한 절단 금지)
```

수집 지점:

| 이벤트 | 어디에 얹나 | 왜 거기인가 |
|---|---|---|
| `interact` | `App` 루트에 `pointerdown`/`keydown` 캡처 리스너, 5분당 프로젝트별 1회로 스로틀 | 슬롯 하나당 1건이면 충분하다. 그 이상은 순수 낭비 |
| `terminal` | `prompt-capture.ts`의 Enter 확정 지점(이미 `promptHistory`에 push하는 곳) | 캡처 지점이 이미 단 하나다 — `ptyWrite` |
| `ai` | `agentActivity` working→done 엣지 | `agent-notify.ts:56-`가 이미 같은 엣지를 소비한다 — 검증된 신호 |

**다중 창 중복 방지**: 모아보기 별도 창이 터미널을 가져가면 신호도 그 창에서 난다(`stores/promptHistory.ts:51-56`이 같은 이유로 read-modify-write를 한다). 슬롯은 멱등 UPSERT라 중복이 무해하고, `ai_turn`은 `UNIQUE(project_id, term_id, started_at)`가 흡수한다. **어느 창이 보고하든 결과가 같다** — 창별 소유권 규칙을 새로 만들 필요가 없다.

**AI 턴 ↔ 프롬프트 연결**: 턴 시작 시각 직전의 `promptHistory` 항목을 그 턴의 프롬프트로 본다. 완벽하지 않다(사용자가 Enter 후 다른 걸 입력할 수 있다) — `prompt-capture.ts:18-20`이 자기 한계를 적어 둔 것과 같은 성격이다. "무엇을 시켰는지 돌아보는 목록"이 목표지 감사 로그가 아니다.

### 4.5 예산표 — 왜 이것이 2026-08을 재발시키지 않는가

| 자원 | 이 기능의 상한 | 비교 대상 |
|---|---|---|
| **새 프로세스 spawn** | refs 변경당 `git log` 1회, 프로젝트당 최소 간격 30초, 전역 동시 2 | 배경 fetch는 5분마다 **전 프로젝트** fetch였다(P0-4). 이건 사건 기반이라 **커밋하지 않으면 0회** |
| **하루 예상 git 호출** | 커밋 40회 × 1 + 시작 1회 = **≈ 41회** | 배경 fetch 5분 주기 × 12프로젝트 = **3,456회/일** |
| **새 inotify watch** | **0개** (기존 워처 콜백에 얹음) | P0-3은 184,001개였다 |
| **주기 타이머** | 60초 flush 1개(메모리→SQLite). 버퍼 비면 no-op | 프로세스를 낳지 않는다 |
| **메모리** | 슬롯 버퍼 = 활성 프로젝트 수 × 상수(수십 바이트) | 상시 O(1) |
| **디스크** | 슬롯 ≈ 40행/일, 커밋 ≈ 200B/건 → **연간 수 MB** | — |

`fetch_scheduler.rs`가 겪은 "사이클 겹침으로 상한이 곱해지는" 함정(`:66-72` 주석)을 그대로 피한다: 세마포어는 **`OnceLock` 전역 1개**, 디바운스 상태도 전역 1개.

---

## 5. IPC 계약

### 5.1 커맨드

읽기는 **화면당 배치 1회**가 원칙이다(동시 invoke 유실 회피).

```rust
/// 대시보드 1회분 — 요약·일별·프로젝트별을 한 번에.
#[tauri::command(async)]
pub async fn activity_overview(days: u32) -> Result<Overview, IpcError>;

/// 타임라인 — 슬롯을 병합해 세션으로, 커밋·AI턴을 조인.
#[tauri::command(async)]
pub async fn activity_timeline(
    from: i64, to: i64, project_id: Option<String>,
) -> Result<Timeline, IpcError>;

/// 프로젝트 상세 리포트.
#[tauri::command(async)]
pub async fn activity_project(project_id: String, days: u32) -> Result<ProjectReport, IpcError>;

/// 프론트 신호 배치 수신(§4.4).
#[tauri::command(async)]
pub async fn activity_report(events: Vec<ActivityEvent>) -> Result<(), IpcError>;

/// 마크다운/CSV 내보내기 문자열 생성(파일 저장은 프론트가 기존 다이얼로그로).
#[tauri::command(async)]
pub async fn activity_export(from: i64, to: i64, format: String) -> Result<String, IpcError>;

/// 기록 삭제 — 프로젝트 지정 또는 전체, 시점 이전.
#[tauri::command(async)]
pub async fn activity_purge(project_id: Option<String>, before: Option<i64>) -> Result<u64, IpcError>;
```

> **전부 `#[tauri::command(async)]`.** `Cargo.toml:136-142`가 못박은 대로, 동기 커맨드의 패닉은 Windows에서 WebView2 COM 콜백 경계를 넘어 **프로세스를 abort시킨다**. 기록기 버그가 앱을 죽이면 안 된다. `lib.rs`의 `hot_commands_stay_async` 테스트에 이 커맨드들을 추가한다.

### 5.2 타입 (TS 계약)

```ts
export interface Overview {
  from: number; to: number;                    // epoch초
  totals: {
    activeMinutes: number; commits: number;
    insertions: number; deletions: number;
    aiTurns: number; aiMinutes: number;
  };
  days: Array<{ day: string; activeMinutes: number; commits: number; aiMinutes: number }>;
  projects: ProjectRow[];
}

export interface ProjectRow {
  projectId: string;
  activeMinutes: number;
  commits: number;
  insertions: number; deletions: number;
  aiTurns: number; aiMinutes: number;
  lastActiveAt: number | null;
  lastCommitAt: number | null;
  spark: number[];                             // 최근 N일 일별 커밋 수
  health: "active" | "slowing" | "dormant" | "uncommitted";
}

export interface Session {                     // 슬롯 병합 결과(저장되지 않는 파생물)
  projectId: string;
  start: number; end: number;                  // epoch초
  activeMinutes: number;
  sources: number;                             // OR 누적
  commits: CommitRow[];
  aiTurns: number; aiMinutes: number;
}

export interface Timeline { from: number; to: number; sessions: Session[] }
```

**세션 병합 규칙**(읽기 시점 계산): 같은 프로젝트의 슬롯을 시간순으로 훑어, **빈 칸이 2개(=10분) 이하면 이어붙인다.** `end`는 마지막 켜진 슬롯의 끝이다 — 유휴 여유분을 더하지 않는다(그러면 모든 세션이 10분씩 부풀어 오른다).

**`health` 판정**(관리의 핵심 — 자동 산출):

| 값 | 조건 | UI |
|---|---|---|
| `active` | 최근 3일 내 활동 있음 | ● 초록 |
| `slowing` | 최근 활동 4~14일 전 | ● 노랑 |
| `dormant` | 15일 이상 무활동 | ◌ 회색 |
| `uncommitted` | 미커밋 변경 존재 + 마지막 커밋 3일 이상 경과 | ⚠ 주황 — **"커밋 안 한 작업이 N일째 쌓여 있음"** |

`uncommitted`는 다른 상태보다 **우선한다**. 이 한 줄이 이 기능에서 실제로 사람을 구하는 부분이다.

---

## 6. UI

### 6.1 진입점

`TitleBar.tsx:63-67`의 우측 버튼 줄에 **모아보기 바로 옆**으로 넣는다(요구 R-C):

```
[📊 관리] [▦ 모아보기] [🕘 히스토리] [📝 메모장] [SysMonitor]   ← 좌→우
```

> 현재 순서는 `모아보기 · 히스토리 · 메모장`이다(`TitleBar.tsx:64-66`). "모아보기 옆"은 왼쪽·오른쪽 둘 다 가능한데 **왼쪽**을 택한다: 모아보기·히스토리·메모장은 전부 *터미널 문맥*의 도구라 한 덩어리로 붙어 있는 편이 낫고, 관리는 성격이 다른 최상위 뷰이기 때문이다. (사용자 선호가 다르면 오른쪽으로 옮기는 데 드는 비용은 한 줄이다 — §10 열린 질문 Q1.)

`AggregateButton`(`TitleBar.tsx:94-125`)의 상호작용을 그대로 미러한다:

| 동작 | 결과 |
|---|---|
| 좌클릭 | 메인 창 안에서 전체 패널 토글 (`useUi.manageOpen`) |
| 우클릭 | 별도 창(`label="manage"`)으로 띄우기 |
| 별도 창이 떠 있을 때 좌클릭 | 그 창으로 포커스(백엔드 싱글턴) |
| 단축키 | **`mod+Shift+M`** (mac ⌘⇧M / 그 외 Ctrl+Shift+M) |

`mod+Shift+M`은 비어 있음을 실측 확인했다 — 현재 점유: `mod+Shift+A`(모아보기), `mod+P`(퀵오픈), `mod+Shift+F`(파일내검색), `mod+Alt+N`, `Ctrl+Shift+D/E/W`, `Ctrl+W/K/T/\``, `F5`, `F11` (`KeyboardShortcuts.tsx:18,63,70,77,84,107`).

**모아보기 버튼과 다른 점 하나**: 모아보기는 열린 터미널이 없으면 버튼 자체를 숨긴다(`TitleBar.tsx:101`). 관리 버튼은 **항상 보인다** — 메모장 버튼과 같은 이유다(`TitleBar.tsx:164-168`의 주석: 문맥 의존이 없으므로 항상 표시).

### 6.2 창 아키텍처

`open_aggregate_window`(`lib.rs:172-197`)를 그대로 복사한다 — async 커맨드 + `run_on_main_thread` + `WebviewUrl::External(origin)` + `browser_args()` + `decorations(false)`. 이 레시피는 sysmon·모아보기·플로팅 터미널에서 세 번 검증됐다.

체크리스트(빠뜨리면 조용히 깨지는 것들):

| 항목 | 이유 |
|---|---|
| `AUX_WINDOW_LABELS`에 `"manage"` 추가 (`lib.rs:223`, `[&str; 2]` → `[&str; 3]`) | **필수.** 안 넣으면 메인 창이 사라져도 이 창만 남아 **앱이 종료되지 않는다**(macOS는 Dock에도 잔류) |
| 라벨이 `float-`로 시작하지 않을 것 | `is_secondary_window`(`lib.rs:230`) — float 분기는 PTY를 종료시킨다. `"manage"`는 안전하며, `lib.rs:719` `secondary_window_labels` 테스트에 케이스를 추가한다 |
| `main.tsx`에 `label === "manage"` 분기 | 자체 `QueryClient`(`retry:false`, **`refetchOnWindowFocus:false`**) |
| `FloatTitleBar title="프로젝트 관리" badge="관리"` | 커스텀 타이틀바(OS 데코 없음) |
| 테마 재적용 effect | `AggregateWindow.tsx:36-40`과 동일 — 보조 창도 저장된 테마를 따라야 한다 |

**모아보기보다 단순한 이유(명시)**: 모아보기는 PTY 출력 소비자가 하나뿐이라 **소유권 이전** 장치가 필요했다(`lib/aggregate-window.ts` 전체가 그 설명이다). 관리 창은 **읽기 전용**이라 그런 게 없다 — 메인의 인라인 패널과 별도 창이 동시에 떠 있어도 각자 자기 쿼리를 돌릴 뿐 서로를 방해하지 않는다. `lib/manage-window.ts`는 `open` + `announce`/`watch`(버튼 하이라이트용)만 갖는 축약판이다.

**인라인 모드 배치**(`App.tsx:131-152`):

```tsx
{manageOpen ? (
  <ProjectManager />
) : aggregateOpen ? (
  <AggregateTerminals />
) : selected && pathMissing ? ( ... ) : ...}
```

- `manageOpen`과 `aggregateOpen`은 **상호배타**다(둘 다 `<main>` 전체를 차지). 한쪽을 켜면 다른 쪽을 끈다.
- **`selectBlockingOverlay`(`ui.ts:206-214`)에는 넣지 않는다.** 그건 "네이티브 자식 webview 위에 떠야 하는 모달" 목록이고, 관리 패널은 모달이 아니라 영역 교체다. 워크스페이스가 언마운트되면 `BrowserPane`의 정리(`BrowserPane.tsx:157-159` `releaseBrowser`)가 네이티브 webview를 hide/dispose하므로 가려질 일이 없다 — 모아보기가 이미 같은 경로다.

### 6.3 화면 구성

탭 3개. 상단에 기간 선택(오늘/7일/30일/90일)과 내보내기.

```
┌ 프로젝트 관리 ─────────────────────────── [오늘 7일 30일 90일] [⤓ 내보내기] ─┐
│  대시보드 │ 타임라인 │ 프로젝트                                                │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  이번 주   활동 14시간 20분(추정)   커밋 37   +8,412 / −2,105   AI 128턴 6h3m │
│                                                                              │
│   월 ▃▃▃    화 ▅▅▅▅▅   수 ▇▇▇▇▇▇▇  목 ▆▆▆▆▆▆  금 ▂▂   토 ▁    일 ·          │
│      ●●        ●●●●       ●●●●●●●     ●●●●        ●                          │
│      └ 막대 = 활동 시간, 점 = 커밋                                            │
│                                                                              │
│  ┌ 프로젝트 ──────────────────────────────────────────────────────────────┐  │
│  │ ● gitpervisor         8h12m  22커밋  AI 71턴   12분 전   ▁▂▅▇▆▃▁       │  │
│  │ ● nexus-application   4h30m  11커밋  AI 40턴   3시간 전  ▁▁▃▅▂▁▁       │  │
│  │ ⚠ aickyway-web        1h38m   4커밋  AI 17턴   2일 전    ▁▁▁▂▁▁▁       │  │
│  │      └ 커밋 안 한 변경 6개가 4일째 쌓여 있습니다            [열기]      │  │
│  │ ◌ old-toy-project        —      —       —      21일 전    휴면          │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

**타임라인 탭** — 날짜별 세로 흐름. 이것이 "오늘 뭐 했지"에 답하는 화면이다.

```
  8/21 (목)                                        활동 5h40m · 커밋 6 · AI 23턴
  ─────────────────────────────────────────────────────────────────────────────
   09 ┃ ▓▓▓▓▓▓▓▓▓▓   gitpervisor            09:15 – 10:05  (50분)
      ┃   ● 09:41  기능: 터미널 모아보기 셀 확대(줌) 토글        +212 / −48
      ┃   ✦ AI 8턴 (24분)  "모아보기 셀에 줌 토글 넣어줘"
   10 ┃ ····
   11 ┃ ▓▓▓▓▓▓       nexus-application      11:20 – 11:55  (35분)
      ┃   ✦ AI 4턴 (18분)  "결제 실패 로그 원인 찾아줘"
   14 ┃ ▓▓▓▓▓▓▓▓▓▓▓▓ gitpervisor            14:00 – 15:20  (1시간 20분)
      ┃   ● 14:52  수정: 첫 term_resize 유실로 PTY가 80x24로 박제
      ┃   ● 15:18  기능: 파일트리 dmg 더블클릭 실행 허용
  ─────────────────────────────────────────────────────────────────────────────
```

막대의 색은 `sources`에서 온다 — AI가 돈 구간과 손으로 친 구간을 구분해 칠한다. "AI가 일한 시간"과 "내가 일한 시간"이 한눈에 갈린다.

**프로젝트 탭** — 한 프로젝트 상세: 일별 히트맵(GitHub 잔디 형태), 최근 커밋 목록, AI 턴 목록(프롬프트 포함), 기존 프로젝트 메모(`get_notes` 재사용 — 새 저장소를 만들지 않는다).

**내보내기** — 마크다운. 주간 회고·업무 보고에 그대로 붙일 수 있는 형태:

```markdown
## 2026-08-17 ~ 2026-08-23  주간 활동
활동 14시간 20분(추정) · 커밋 37 · +8,412 / −2,105 · AI 128턴

### gitpervisor — 8시간 12분, 22커밋
- 08-21  기능: 터미널 모아보기 셀 확대(줌) 토글  (+212/−48)
- 08-20  수정: 첫 term_resize 유실로 PTY가 80x24로 박제  (+31/−12)
```

### 6.4 빈 상태

첫 실행은 백필이 돌기 전이므로 잠깐 비어 있다. 빈 화면을 그냥 두지 않는다:

> **아직 기록이 없습니다.**
> 평소처럼 코드를 쓰고 커밋하면 여기에 저절로 쌓입니다. 따로 켜거나 적을 것은 없습니다.
> _지난 90일 커밋을 불러오는 중… (3/12)_

---

## 7. 설정과 프라이버시

`Settings`(`git/types.rs`)에 4개 추가. 구조체에 `#[serde(rename_all="camelCase", default)]`가 이미 걸려 있어 **기존 `settings.json`이 그대로 읽힌다**(`Default` impl에도 값을 넣는다).

| 키 | 기본값 | 의미 |
|---|---|---|
| `activityEnabled` | `true` | 끄면 기록·수확이 전부 no-op |
| `activityStorePrompts` | `true` | AI 턴의 프롬프트 본문 저장 여부 |
| `activityRetentionMonths` | `24` | 슬롯 보존 기간 |
| `activityBackfillDays` | `90` | 최초 백필 범위 |

설정 › **기록** 섹션에 위 4개 + 두 버튼: **[기록 정리]**(프루닝 + VACUUM), **[전체 기록 삭제]**(확인 다이얼로그, `danger`).

**프라이버시 원칙 — 문서와 UI에 같은 문장으로 명시한다:**

- 기록은 `app_data_dir/activity.db` **로컬 파일 하나**에만 저장된다. **어디로도 전송하지 않는다.** 이 기능은 네트워크를 쓰지 않는다.
- 프롬프트 본문에는 사용자가 터미널에 친 문장이 들어간다 — 토큰·비밀번호를 친 적이 있다면 그것도 들어갈 수 있다. 그래서 (a) 500자 절단 (b) 90일 후 자동 비움 (c) 설정에서 저장 끄기 (d) 즉시 전체 삭제를 모두 제공한다.
- 커밋 본문(`%b`)은 저장하지 않는다 — 제목만으로 충분하고, 본문은 필요할 때 git에서 읽으면 된다. **원본이 있는 데이터를 복사해 두지 않는다.**

---

## 8. 단계 계획

### M1 — 기록 파이프라인 + 대시보드 (핵심 가치 전부)

| 산출물 | 내용 |
|---|---|
| `activity/store.rs` | SQLite 열기·마이그레이션·손상 격리·프루닝 |
| `activity/mod.rs` | 슬롯 버퍼, `note()`, `flush()`, 60초 타이머 |
| `activity/harvest.rs` | refs 트리거 수확 + 디바운스 + 세마포어 + 백필 |
| 훅 3곳 | `watcher.rs` 콜백, `actions.rs` commit, `sync.rs` push/pull/fetch |
| 커맨드 | `activity_overview`, `activity_report` |
| 프론트 | `activity-report.ts`(3신호 배치), `ProjectManager`(대시보드 탭), 타이틀바 버튼, `mod+Shift+M`, `label="manage"` 창 |

**수용 기준**
1. 터미널에서 `git commit` → **10초 안에** 관리 화면에 그 커밋이 뜬다(앱을 재시작하지 않고).
2. 30분간 한 프로젝트에서 편집 → 활동 시간이 실제 작업 시간의 ±10분 안에 든다.
3. 앱을 `kill -9` → 재시작 시 **마지막 60초를 제외한** 기록이 남아 있다.
4. 커밋 없이 8시간 앱을 켜 두면 **git 프로세스가 0회** 뜬다(`ps` 관찰 또는 로그 카운터).
5. `activity.db`를 손으로 깨뜨려도 앱이 정상 부팅하고, 관리 화면만 안내를 띄운다.

### M2 — 타임라인 + 프로젝트 상세 + 내보내기

- `activity_timeline`, `activity_project`, `activity_export`.
- 세션 병합, 색으로 AI/수동 구분, 히트맵, AI 턴+프롬프트 목록, 마크다운 내보내기.
- 설정 › 기록 섹션.

**수용 기준**: 임의의 지난 날짜를 열면 그날의 세션·커밋·AI 턴이 시간순으로 재구성된다. 주간 마크다운이 편집 없이 회고에 붙일 수 있는 품질이다.

### M3 — 관리 신호 (선택)

- `uncommitted` 정체 경고를 **사이드바 프로젝트 항목에도** 배지로(관리 창을 안 열어도 보이게).
- 주간 목표(커밋 수 또는 활동 시간) + 진행률.
- **명시적 제외**: 칸반, 이슈, 하위 작업. 그건 다른 제품이다(YAGNI).

---

## 9. 리스크 레지스터

| # | 위험 | 영향 | 완화 |
|---|---|---|---|
| **R1** | 워처 콜백에서 기록 호출이 무거워 워처가 밀린다 | 파일 변경 반영 지연 — 앱 핵심 기능 저하 | `note()`는 HashMap 갱신만. DB I/O 금지. 벤치가 아니라 **구조로** 보장(함수에 DB 핸들을 주지 않는다) |
| **R2** | 팀 레포를 pull하면 남의 커밋 수천 개가 유입 | 기록이 남의 활동으로 오염, 수확 시간 폭증 | `--max-count=500` + 라운드 5회 상한 + `mine` 플래그 + UI 기본 필터 `mine=1` |
| **R3** | 5분 슬롯의 올림 편향으로 시간이 부풀어 보인다 | 사용자가 수치를 불신 → 기능 폐기 | UI에 "(추정)" 명시 + 툴팁에 산식 노출 + 세션 `end`에 유휴 여유분 미가산 |
| **R4** | 프롬프트에 비밀정보가 들어간다 | 로컬 파일에 잔류 | 500자 절단·90일 자동 비움·저장 끄기·즉시 삭제(§7). 전송 경로 자체가 없음 |
| **R5** | SQLite가 두 번째 영속 패러다임이 되어 유지보수가 갈린다 | 인지 부담 | 사용자 설정·프로젝트 목록은 **JSON 그대로**. SQLite는 **활동 시계열 전용**이며 경계를 문서에 못박는다 |
| **R6** | 리베이스·amend로 옛 sha가 고아가 되어 기록에 유령이 남는다 | 커밋 수가 실제보다 많아 보임 | 사실로 인정하고 표시한다("수확 시점 기준"). 도달 가능성 재검증은 전 커밋 순회라 I-2 위반 — 하지 않는다 |
| **R7** | 중첩(임베디드) 저장소 활동이 바깥 프로젝트로 뭉뚱그려진다 | 세밀도 손실 | v1은 최상위만(태스크 04의 선례와 동일). 워처가 중첩 `.git`을 감시하지 않으므로(`watcher.rs:196`이 `.git`을 이름으로 건너뜀) 수확 자체가 불가 — 문서에 한계로 명시 |
| **R8** | 절전/시계 변경으로 슬롯 시각이 뒤엉킨다 | 타임라인 왜곡 | 슬롯 키는 **UTC epoch**. 표시만 로컬 변환. `CLAUDE.md`가 경고한 "로그는 UTC, session.json은 KST" 혼선을 반복하지 않는다 |
| **R9** | `manage` 창을 `AUX_WINDOW_LABELS`에 빠뜨린다 | **앱이 종료되지 않는다** | `lib.rs:719` `secondary_window_labels` 테스트에 케이스 추가(회귀를 테스트로 고정) |
| **R10** | 30초 배치 보고가 WebView2에서 유실 | 활동 일부 누락 | 슬롯은 멱등이므로 **다음 배치가 같은 슬롯을 다시 켠다**. 보고 실패 시 큐를 비우지 않고 유지(최대 200건) |

---

## 10. 열린 질문 — 사용자 결정 필요

| # | 질문 | 미응답 시 기본값 |
|---|---|---|
| **Q1** | 관리 버튼을 모아보기 **왼쪽**? 오른쪽? | 왼쪽(§6.1 근거) |
| **Q2** | 활동 시간 산정에 "앱 조작(`INTERACT`)"을 포함할지. 포함하면 diff를 읽기만 한 시간도 잡히고, 빼면 코드 리뷰가 0분이 된다 | **포함** |
| **Q3** | AI가 도는 동안(사용자는 대기) 시간을 내 활동으로 셀지 | **센다 — 단 타임라인에서 색으로 구분.** 총합에는 포함하고 "AI 시간"을 별도 지표로 병기 |
| **Q4** | 최초 백필 범위 90일이 적절한지(길수록 첫인상은 좋고 첫 실행이 느려진다) | 90일 |
| **Q5** | 프롬프트 본문 저장 기본값 ON이 괜찮은지 | ON(끄기·삭제 제공) |
| **Q6** | 팀 레포에서 남의 커밋도 보고 싶은지 | 기록은 하되 **기본 숨김**(토글 제공) |

---

## 11. DoD / 테스트 계획

**Rust 단위 테스트**

| 테스트 | 무엇을 고정하나 |
|---|---|
| `slot_key_is_utc_aligned` | `slot = floor(epoch/300)*300`, 음수·경계 |
| `note_is_idempotent_within_slot` | 같은 슬롯 100회 → 행 1개, `sources` OR 누적 |
| `session_merge_bridges_two_empty_slots` | 빈 칸 2개는 잇고 3개는 자른다 |
| `session_end_has_no_idle_padding` | 세션 끝 = 마지막 슬롯의 끝 (R3) |
| `numstat_parser_handles_binary_and_rename` | `-\t-\tpath`, 따옴표 경로 |
| `harvest_respects_min_interval` | 30초 이내 재트리거 시 git 호출 0회 (I-2) |
| `manage_label_is_aux_and_not_float` | `secondary_window_labels`(`lib.rs:719`) 확장 — R9 회귀 고정 |
| `activity_commands_stay_async` | `hot_commands_stay_async` 확장 — Windows abort 방어 |
| `corrupt_db_is_quarantined_and_app_boots` | 깨진 파일 → `.corrupt` 이동 + `None`으로 계속 |

**E2E**(`tests/e2e/` 관례를 따름): 픽스처 레포에 커밋 → `repo://changed` → 10초 내 `activity_overview`에 반영.

**수동 검증(정적 검증만으로 통과시키지 않는다 — `CLAUDE.md` § 검증)**
1. 설치본을 GNOME 메뉴에서 띄우고 8시간 방치 → cgroup 프로세스 수 증가 0, `git` 호출 로그 0.
2. 하루 실사용 후 타임라인이 기억과 일치하는지 눈으로 대조.
3. `kill -9` 후 재시작하여 손실 구간이 60초 이내인지 확인.

---

## 12. 파일 지도

```
src-tauri/src/
  activity/
    mod.rs          슬롯 버퍼·note()·flush()·60초 타이머·비트마스크 상수
    store.rs        SQLite 열기/마이그레이션/UPSERT/질의/프루닝/손상 격리
    harvest.rs      refs 트리거 수확·디바운스·세마포어·백필·numstat 파서
    types.rs        Overview / Timeline / Session / ProjectRow / ActivityEvent
  commands/activity.rs   커맨드 6종 (전부 async)
  watcher.rs        [수정] 콜백에서 EDIT/GIT 분기 + note() + mark_dirty()
  commands/actions.rs, sync.rs   [수정] APP_OP 한 줄씩
  state.rs          [수정] AppState에 activity: Option<ActivityStore>
  lib.rs            [수정] open_manage_window, AUX_WINDOW_LABELS, invoke_handler
  git/types.rs      [수정] Settings 4개 필드 + Default

src/
  ManageWindow.tsx              별도 창 루트(AggregateWindow.tsx 대칭)
  lib/manage-window.ts          open/announce/watch (aggregate-window.ts 축약판)
  lib/activity-report.ts        프론트 신호 배치 보고
  components/manage/
    ProjectManager.tsx          탭 셸(대시보드/타임라인/프로젝트)
    Dashboard.tsx  Timeline.tsx  ProjectDetail.tsx  ExportDialog.tsx
    Sparkline.tsx  DayBars.tsx  Heatmap.tsx         (의존성 없는 인라인 SVG)
  components/TitleBar.tsx       [수정] ManageButton
  components/KeyboardShortcuts.tsx  [수정] mod+Shift+M
  stores/ui.ts                  [수정] manageOpen / manageWindowOpen / toggleManage
  App.tsx                       [수정] manageOpen 분기
  main.tsx                      [수정] label === "manage" 분기
  queries/index.ts              [수정] useActivityOverview 등
```

**신규 크레이트 0개. 신규 파일 감시 0개. 신규 주기 git 호출 0개.**
