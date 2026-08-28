# 디스크 용량 분석(TreeSize류) — 설계

> 상태: **M1+M2 구현 완료**(2026-08-28, 실측 검증 포함 — §4. 트리맵·할당 크기 포함) · `/sc:design` 산출물 · 대상: gitpervisor 리소스 모니터
>
> 요구: SSD가 꽉 찼을 때 "무엇이 먹고 있는지"를 리소스 모니터 안에서 TreeSize처럼 분석한다 —
> 드라이브/폴더 스캔 → 폴더별 크기 트리 + 최대 파일 Top-N. (근거 스크린샷: TreeSize Free,
> C:\ 993.7GB / 파일 4,301,664 / 폴더 649,580)

---

## 0. 결정 요약

| # | 항목 | 결론 | 근거 |
|---|---|---|---|
| A | 스캔 엔진 | **std 스레드 풀 병렬 walk, 신규 크레이트 0** | Windows에선 `DirEntry::metadata()`가 무비용(FIND_DATA에 포함) — 병목은 디렉터리 열거뿐이라 워커 N개면 충분. MFT 직독(WizTree식)은 관리자 권한+NTFS 한정이라 기각 |
| B | 데이터 상주 | **트리는 Rust arena에만, 프론트는 폴더 단위 질의** | 폴더 65만 개 ≈ arena ~60MB. 파일 430만 개는 저장하지 않는다 — 펼칠 때 그 폴더만 live read_dir(§3.3) |
| C | 진행률 | **Channel 1개(JSON), 250ms 스로틀** | `lsp_ensure`/`video_tool_ensure` 전례 그대로(ipc.ts:1009,1027). 스캔마다 **새 Channel**(재사용 금지 — CLAUDE.md 함정) |
| D | UI 위치 | **sysmon 창 안 뷰 전환(프로세스 ⇄ 디스크)** | 원문 "리소스 모니터에도". 새 창·새 라벨 불필요, `gp:sysmon` prefs에 `view` 필드만 추가(태스크 05 §3.6 핸드오프 확장) |
| E | 파괴적 액션 | **v1 읽기 전용** — "탐색기에서 열기"만 | 태스크 05 §3.5 kill 버튼과 동일 논리: 오클릭 대참사 경로. 삭제는 탐색기가 정답 |

---

## 1. 현황(근거)

- **리소스 모니터 인프라 완비**: 싱글턴 플로팅 창 `"sysmon"`(`SysMonitorWindow.tsx`),
  `Monitor` + `AppState.monitor: Mutex`(monitor.rs:122, state.rs), 2초 폴링 배치 커맨드
  `sys_process_snapshot`(monitor.rs:603). 게이지·부하색·테이블 스타일 재사용 가능.
- **볼륨 목록은 이미 있다**: `Monitor.disks: Disks`(monitor.rs:127, sysinfo) — 마운트 지점·
  총량·가용량. 60초 TTL 캐시(§DISK_LIST_TTL).
- **장시간 잡 + Channel 진행률 전례**: `lsp_ensure`(다운로드 270MB), `video_tool_ensure` —
  `Channel<String>`에 JSON, 프라미스는 완료 시 해소(ipc.ts:1004-1038). 취소 전례: video.rs
  oneshot. 파일트리의 `list_dir`(tree.rs)은 **단일 디렉터리** 열거라 이번 요구(볼륨 전체 집계)와
  목적이 다르다 — 코드 공유 없음, 혼동 금지.
- **같은 Channel 재사용 금지 / 동기 커맨드의 UI 스레드 실행 금지** — CLAUDE.md·Cargo.toml
  주석(:144-150)의 기존 함정. 스캔 커맨드는 전부 `(async)` + 전용 스레드.

---

## 2. 설계 대안 비교

### 2.1 스캔 엔진

| 방식 | 판단 |
|---|---|
| (a) 단일 스레드 재귀 read_dir | 기각 — 폴더 65만 개 순차 열거는 분 단위. TreeSize가 "고성능"인 이유가 병렬화다 |
| (b) **std 스레드 풀 병렬 walk** ✅ | 공유 작업 큐(`Mutex<VecDeque>` + Condvar) + 워커 N개(`available_parallelism` 캡 8). Windows는 열거가 곧 메타데이터라 syscall 추가 비용 0. ~150 LOC, 의존성 0 |
| (c) `jwalk`/`rayon` 크레이트 | 기각 — 우리는 **정렬된 순회가 필요 없다**(집계만 하면 됨). 크레이트의 가치(순서 보장 병렬 순회)를 안 쓰면서 의존성만 산다 |
| (d) NTFS MFT 직독(WizTree식) | 기각 — 관리자 권한 요구 + NTFS 한정 + 크로스플랫폼 전멸. 사용자 권한 앱의 선을 넘는다 |

**워커 알고리즘** (핵심만):

```
큐: VecDeque<(node_idx, PathBuf)>  ·  arena: Vec<DirNode>  ·  pending: usize (완료 감지)
워커 루프: 큐 pop → read_dir 1회
  - 파일: len 합산 + 전역 카운터(AtomicU64) + Top-N 파일 min-heap(스레드 로컬, 종료 시 병합)
  - symlink/정션(is_symlink): 재귀 안 함, 크기 0  ← 순환·이중계상 차단(§7)
  - 하위 폴더: arena에 노드 batch-push(폴더당 락 1회) + 큐에 잡 push
  - Err(권한 거부 등): skipped 카운터만 증가, 스캔은 계속
완료 후 단일 패스: arena를 역순 순회하며 bytes/files를 parent에 합산
  (자식은 항상 부모보다 뒤에 append되므로 역순 1회로 상향 집계 완결 — O(n), 재귀 없음)
```

- 긴 경로: Rust std가 Windows에서 `\\?\` 승격을 자동 처리 — MAX_PATH 이슈 없음.
- Defender: read_dir 열거는 파일 open이 아니라 실시간 검사를 유발하지 않는다
  (tree.rs의 git 스폰 병목과는 다른 종류의 작업).
- Unix/macOS: 같은 코드가 동작하되 엔트리당 stat 1회가 추가된다(느려질 뿐 정확).

### 2.2 크기 정의 — 논리 크기(len) 기본 + 할당 크기 병행 수집 (M2 구현됨)

표시 기본은 논리 크기. 할당 크기는 스캔 중 함께 집계해 툴팁·요약에 노출한다:
- **Windows**: 압축(0x800)·스파스(0x200) 속성 파일만 `GetCompressedFileSizeW` 1회 —
  일반 파일은 논리 크기와 동일 취급해 **파일당 추가 syscall을 없앤다**(383만 파일 방어).
  클러스터 반올림은 미반영(볼륨별 클러스터 조회 + per-file 핸들 비용 대비 무가치).
- **Unix**: `st_blocks × 512` — 홀·블록 반올림 실측(추가 비용 0, stat에 이미 있다).
- UI: 크기 셀 툴팁(`논리 X · 디스크 할당 Y`), 요약 줄은 0.5% 이상 차이날 때만 `(할당 Y)`.
- OneDrive 자리표시자(dehydrated)는 스파스라 할당 크기에선 실 점유로 잡힌다(논리 크기 한계 보완).

### 2.3 파일 목록 — 저장하지 않고 펼칠 때 읽는다

파일 430만 개를 arena에 들면 ~300MB+. 대신:
- **스캔 중**: 폴더별 파일 크기 **합계·개수만** 누적 + **전역 최대 파일 Top-100** min-heap
  (SSD 꽉참 시나리오의 최고 가치 — "[27 파일] 101.3GB" 같은 범인을 바로 지목).
- **펼칠 때**: `disk_children(rel)`이 그 폴더 1개만 live read_dir 해 파일 행을 만든다
  (Windows 무비용 메타데이터, 폴더 1개라 ms급). 하위 **폴더** 행은 스캔 캐시에서.
  파일 행은 1,000개 캡 + "외 N개"(수십만 파일 폴더 방어).
- 대가: 스캔 시점과 펼침 시점 사이 변경된 파일은 캐시된 폴더 합계와 어긋날 수 있다 —
  스냅샷 도구의 본질적 한계로 수용(TreeSize도 동일), §7 고지.

### 2.4 생명주기 — 스캔 1개, 결과는 창과 함께

- **동시 스캔 1개**(in-flight 가드) — 새 스캔 시작 = 이전 결과 폐기.
- 취소: `AtomicBool` 플래그(워커가 잡마다 확인). oneshot(video.rs)보다 단순하고 충분 —
  워커가 여럿이라 브로드캐스트 가능한 플래그가 오히려 맞다.
- sysmon 창 `Destroyed` 시(lib.rs 핸들러에 `"sysmon"` arm 추가): 진행 중 스캔 취소 +
  arena drop(~60MB 반환). 창을 다시 열면 재스캔 — "열어두고 곁눈질"하는 창이라 유지 이득이 작다.

---

## 3. 계약(타입·커맨드)

### 3.1 Rust — 신규 `src-tauri/src/disk_scan.rs` + `AppState.disk_scan`

`Monitor` 뮤텍스와 **분리**한다 — 스캔이 몇 분 걸리는 동안 2초 폴링(sys_metrics/snapshot)을
막으면 안 된다.

```rust
// state.rs
pub disk_scan: Mutex<DiskScanState>,   // 락은 짧게(질의·상태 전이만). 워커는 arena를
                                       // 완료 후 1회만 넣는다 — 스캔 중 부분 질의는 없다(§3.3)

// disk_scan.rs
pub enum ScanPhase { Idle, Scanning, Done, Cancelled, Error }

#[serde(rename_all = "camelCase")]
pub struct ScanStatus {            // disk_scan_status 응답 + Channel 진행 메시지 공용
    pub phase: ScanPhase,
    pub root: Option<String>,      // 스캔 대상 절대경로
    pub bytes: u64, pub files: u64, pub dirs: u64,
    pub skipped: u64,              // 권한 거부 등으로 못 들어간 폴더 수 — UI에 정직 표기
    pub elapsed_ms: u64,
    pub done: bool,                // Channel 마지막 메시지 판별
    pub error: Option<String>,
}

#[serde(rename_all = "camelCase")]
pub struct DirRow {                // disk_children의 폴더 행
    pub name: String,
    pub bytes: u64,                // 하위 전체 합산(스캔 캐시)
    pub files: u64, pub dirs: u64,
    pub modified: Option<i64>,     // epoch ms
}
#[serde(rename_all = "camelCase")]
pub struct FileRow { pub name: String, pub bytes: u64, pub modified: Option<i64> }

#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub bytes: u64,                          // 이 폴더 합산(부모 % 계산용)
    pub dirs: Vec<DirRow>,                   // bytes 내림차순 정렬 완료(Rust)
    pub files: Vec<FileRow>,                 // live read_dir, 내림차순, 1000 캡
    pub truncated_files: u32,                // "외 N개"
}

#[serde(rename_all = "camelCase")]
pub struct TopFile { pub path: String, pub bytes: u64, pub modified: Option<i64> }
```

```rust
// 커맨드 4개 — 전부 (async). 스캔 본체는 커맨드가 아니라 std::thread에서 돈다.
#[tauri::command(async)] fn disk_scan_start(path: String, on_progress: Channel<String>) -> Result<(), IpcError>
    // 가드: 이미 Scanning이면 에러. 경로 존재·디렉터리 검증. 이전 결과 폐기 후 워커 스폰.
    // 진행: 전용 리포터 스레드가 250ms마다 ScanStatus JSON을 채널로. 마지막 메시지 done=true.
#[tauri::command(async)] fn disk_scan_cancel()
#[tauri::command(async)] fn disk_scan_status() -> ScanStatus          // 창 재오픈 시 재동기화
#[tauri::command(async)] fn disk_children(rel: String) -> Result<DirListing, IpcError>
    // rel=""는 스캔 루트. 검증: 스캔 루트 밖 탈출 금지(정규화 후 prefix 확인 — tree.rs
    // validate_rel_dir와 같은 원칙, 코드는 스캔 루트 기준이라 별도).
#[tauri::command(async)] fn disk_top_files(limit: u32) -> Vec<TopFile>
```

드라이브 목록은 **신규 커맨드 없이** 기존 `sys_metrics`의 마운트 정보로 부족하므로,
`disk_scan.rs`에 `disk_roots() -> Vec<{mount, total, available}>` 1개 추가
(클릭 시 1회 호출 — `Disks::new_with_refreshed_list()` 직접, Monitor 락 불요).
임의 폴더 선택은 기존 `tauri-plugin-dialog`의 폴더 픽커 재사용.

### 3.2 프론트 — ipc.ts · queries · sysmon

```ts
// ipc.ts — lspEnsure 패턴 그대로
diskScanStart: (path: string, onProgress: (s: ScanStatus) => void) => { new Channel … }
diskScanCancel / diskScanStatus / diskChildren(rel) / diskTopFiles(limit) / diskRoots()
// diskChildren은 interactive lane(클릭 응답), status는 background lane
```

- `queries/index.ts`: `useDiskChildren(rel)` — **staleTime Infinity**(스캔 결과는 불변
  스냅샷), 키 `["disk", scanRoot, rel]`. 새 스캔 완료 시 `["disk"]` 전체 무효화 1회.
- 진행 상태는 react-query가 아니라 컴포넌트 로컬 state(Channel 콜백) — 폴링 아님.

### 3.3 스캔 중 질의는 막는다

부분 트리 질의(스캔 중 실시간 탐색)는 arena를 워커와 공유하는 락 설계를 요구한다 — v1 기각.
스캔 중엔 진행 게이지만, `disk_children`은 `Done` 전이면 에러. TreeSize도 스캔 완료 후
탐색이 본령이고, 진행 중 가치는 Top 게이지(bytes/files 카운터)로 충분하다.

### 3.4 UI — sysmon 창 뷰 전환

```
FloatTitleBar("리소스 모니터")
[프로세스] [디스크]  ← 헤더 좌측 세그먼트 토글, gp:sysmon prefs에 view 영속
─ 디스크 뷰 ─
  드라이브 칩(C:\ 993.7GB · 6.1GB 남음) … + [폴더 선택] + [스캔]/[중지]
  스캔 중: 진행 바(부하색 규약 재사용) + "4,301,664 파일 · 989.8 GB · 폴더 12,345 건너뜀 0"
  완료 후:
    테이블: 이름 | 크기 | %(부모 대비 바 — loadBar 재사용) | 파일 | 폴더 | 수정한 날짜
    행 펼침 = useDiskChildren(rel) — 파일트리 패널과 같은 지연 로딩 UX
    상단 토글: [트리] [큰 파일 Top 100]   ← Top 100은 경로 전체 표시 + 우클릭 "탐색기에서 열기"
```

- 프로세스 테이블 폴링은 `view === "proc"`일 때만 마운트 — 디스크 뷰에서 스냅샷 폴링 자동 중단.
- 헤더 totals 게이지(CPU/GPU/RAM)는 두 뷰 공통 유지(창의 정체성).
- 우클릭 메뉴: "탐색기에서 열기"(기존 `ipc.revealPath` 재사용) + "경로 복사"(기존 copy 패턴).
- 타이틀바 SSD Metric 클릭 → `gp:sysmon`에 `view:"disk"` 써두고 창 오픈(태스크 05 §3.6 확장).

### 3.5 트리맵 — M2 (구현됨)

백엔드 `disk_treemap(rel, depth) -> TreemapNode`(중첩 JSON): 레벨당 크기순 상위 24 +
루트 대비 0.05% 미만·예산(1500 타일) 초과분은 `other_bytes`("기타" 타일)로 접고, 직속 파일
몫(bytes − Σ자식)은 `own_bytes`("[N 파일]" 타일)로 노출한다. 프론트 `DiskTreemap.tsx`:
squarified 배치(~60 LOC) + div 렌더(2레벨 — 폴더 박스 헤더 + 내부 타일), 폴더 클릭 =
드릴다운(rel 교체 → depth 2 재조회), 브레드크럼 복귀, 우클릭 = 탐색기 열기. 색은 레벨1
인덱스별 hue 팔레트(hsla 반투명 — 테마 배경 위에서 동작).

---

## 4. 규모·성능 — 실측 (2026-08-28, 이 머신 C:\, dev 빌드)

| 항목 | 실측 | 비고 |
|---|---|---|
| **C:\ 전체 스캔** | **23.5초** — 938GB · 파일 3,828,119 · 폴더 633,869 · 접근불가 668 스킵 | 웜 캐시, 워커 8. 설계 추정(수십 초대) 적중. TreeSize Free 화면과 폴더별 수치 일치(Users 602.7GB — 차이는 스킵·symlink 정책) |
| `disk_children("")` | **11ms** | 완료 후 루트 질의(캐시 조회 + live read_dir) |
| Top 파일 | pagefile.sys 76GB · nqvm.db 30GB · hiberfil 25GB … | "SSD 꽉참" 범인이 바로 나온다 — 기능 목적 달성 확인 |
| arena 메모리 | 폴더 63만 규모(추정 60-80MB, 미계측) | 노드 수 상한 400만(초과 시 에러로 정직 중단). 창 닫으면 reset으로 반환(실측: Destroyed → phase idle 확인) |
| 스캔 시간(콜드) | 미실측 — 분 단위 가능 | 첫 스캔은 디스크 바운드. 진행 게이지·취소가 그래서 v1 필수 |
| UI 부하 | 0 | 스캔은 전용 스레드, 진행은 250ms 스로틀 Channel, 질의는 폴더 단위 |

---

## 5. 변경 지점

| 파일 | 변경 |
|---|---|
| `src-tauri/src/disk_scan.rs` | **신규** — 워커 풀·arena·Top-N heap·커맨드 5개 |
| `src-tauri/src/state.rs` | `disk_scan: Mutex<DiskScanState>` |
| `src-tauri/src/lib.rs` | 커맨드 등록 + `Destroyed("sysmon")` arm(취소+drop) |
| `src/lib/ipc.ts` | 래퍼 6개 + 타입 |
| `src/queries/index.ts` | `useDiskChildren` |
| `src/components/sysmon/SysMonitorWindow.tsx` | 뷰 토글 + 디스크 뷰 마운트 분기 |
| `src/components/sysmon/DiskUsageView.tsx` | **신규** — 드라이브 칩·진행·트리 테이블·트리맵·Top 100 |
| `src/components/sysmon/DiskTreemap.tsx` | **신규**(M2) — squarified 트리맵·드릴다운·브레드크럼(§3.5) |
| `src/components/sysmon/prefs.ts` | `view` 필드 |
| `src/components/SysMonitor.tsx` | SSD Metric 클릭 → view:"disk" 핸드오프 |
| `tests/e2e/suites/32-disk-usage.mjs` | **신규**(18 확장 대신 별도 스위트) — 픽스처 스캔 합계·자식 목록·Top 파일·`..` 가드·취소 검증(15건, 실기 통과) |

---

## 6. 구현 순서

1. **M1a — 엔진**: disk_scan.rs 워커 풀 + 역순 집계 + Top-N. 유닛 테스트: tempdir 픽스처로
   합계 정확성 · symlink 미재귀 · 권한 거부 시 skipped 증가·계속 진행 · 취소 즉시성 ·
   역순 집계와 재귀 합산 동치. **이 머신 C:\ 실측으로 §4 추정 검증.**
2. **M1b — UI**: 뷰 토글 + 진행 게이지 + 트리 테이블 + Top 100 + 탐색기 열기. e2e 스위트 32.
3. **M2 — 트리맵**(§3.5) + 할당 크기(§2.2) — 구현 완료(2026-08-28).

---

## 7. 한계·위험 — 정직 고지

- **하드링크는 중복 계상**된다(TreeSize 기본값도 동일). WinSxS 등 시스템 폴더가 실제보다
  크게 보일 수 있다 — 툴팁 고지로 충분.
- **symlink/정션은 크기 0**으로 스킵한다(순환·이중계상 차단이 우선). `C:\Users\…\Application
  Data` 같은 레거시 정션이 0으로 보이는 것은 의도된 동작.
- **OneDrive 자리표시자**는 논리 크기로 계상 — "디스크에서 안 먹는데 크게 보임" 가능(§2.2).
- **스냅샷과 live 파일 목록의 어긋남**(§2.3) — 폴더 합계는 스캔 시점, 파일 행은 펼침 시점.
- **권한 거부 폴더**(System Volume Information 등)는 못 센다 — skipped 카운터로 표기하되,
  TreeSize Free(사용자 권한)도 동일하게 못 세는 영역이라 도구 목적상 수용.
- **성능 추정치는 전부 미실측**(§4) — M1a 첫 검증 항목이 실측이다.

---

## 8. 오픈 이슈 (사용자 결정)

| # | 질문 | 결정 |
|---|---|---|
| ① | 삭제(휴지통) 액션 포함? | **제외 확정** — 읽기 전용 + 탐색기 열기(§0-E). 시스템 폴더 오삭제 경로를 앱이 열 이유가 없다 |
| ② | 트리맵 | **M2로 구현 완료**(§3.5) |
| ③ | 스캔 결과 창 닫은 뒤 유지? | **폐기 확정**(§2.4) — 60-80MB를 "혹시 다시 볼까 봐" 상주시키지 않는다 |
