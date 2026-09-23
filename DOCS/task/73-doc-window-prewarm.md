# 태스크 73 — 문서 창(git log 등) 뜨는 속도: 프리워밍 풀을 문서 창에도

> 상태: **구현 완료 · 실측·e2e 진행분은 §5** (2026-09-23) · 대상: gitpervisor ·
> 근거: 메인 세션 실측 2026-09-23(프로덕션 번들 + dev) + 코드 실측 ·
> 선행: 태스크 30(문서 창 `doc-*`), 13/25(플로팅 터미널 프리워밍 풀), 66·67(폴더·리포트 창), 45(git log 창) ·
> **Rust 변경**: `lib.rs` 한 파일(풀 배정 타입 + `open_doc_window` 풀 경로)

## 1. 요구사항

사이드바 프로젝트 우클릭 → **git log**(그리고 파일 뷰어·폴더·리포트 등 모든 문서 창)를 눌렀을 때
창이 **눈에 띄게 빨리** 떠야 한다.

받아들이는 조건:
- 클릭 → 커밋 목록이 그려질 때까지의 시간이 실측으로 줄어든다.
- 상주 메모리를 늘리지 않는다 — 숨김 창을 **하나 더** 만들지 않는다(풀 창 1개가 실측 273MB).
- 메모리 경보 정책(`float_pool_drain`)은 약해지지 않는다.
- 같은 문서를 두 번 열면 창이 하나여야 한다(지금 라벨 싱글턴이 하던 일).
- 문서 창이 닫힐 때 **PTY를 죽이지 않는다**(문서 창엔 PTY가 없다).

## 2. 현황(근거)

### 2.1 느린 곳은 git이 아니라 창 부팅이다 (측정)

메인 세션이 `open_doc_window` 호출부터 커밋 목록이 그려질 때까지를 CDP로 잼(2026-09-23):

| 구간 | 프로덕션 번들(vite build + preview, 디버그 Rust) | dev(vite) |
|---|---|---|
| ① 창 타겟 등장 | 119ms | 76ms |
| ② 첫 글자 렌더 | 333ms | 771ms |
| ③ 커밋 목록 완료 | **878ms** | 1026ms |

`get_log` IPC(`git log -z --format=… --max-count=100`)는 같은 조건에서 **46~96ms**다.
즉 비용의 대부분은 **새 WebView2 창에서 앱을 처음부터 부팅하는 것**이고, 데이터 조회는 범인이 아니다.

### 2.2 그 문제는 터미널 분리 창에서 이미 풀려 있다

`lib.rs`의 `FLOAT_POOL`:
- 숨김 창 1개를 미리 만들어 둔다(`spawn_float_pool_window` — `visible(false)`, 라벨 `float-pool-<seq>`).
- 그 창 프론트가 claim 리스너를 무장한 뒤 `float_pool_ready`로 신고한다(핸드셰이크 — 이벤트 유실 방지).
- 분리 클릭 → `ready.pop()` → `claims`에 배정 기록 → `float://claim` emit → `show()` → 백그라운드 리필.
- 메모리 경보(`health::Level::Warn` 이상)면 프리워밍을 **생략**하고(`spawn_float_pool_window` 입구),
  이미 대기 중인 미claim 창은 `float_pool_drain`이 회수한다(`webview_guard.rs:42`).

문서 창(`open_doc_window`)은 이 인프라를 전혀 쓰지 않고 매번 창을 새로 만든다 —
그래서 §2.1의 878ms를 통째로 낸다.

### 2.3 문서 창 쪽 계약(깨뜨리면 안 되는 것)

- 라벨 `doc-<docId>`가 **싱글턴 장치**다: 폴더 창(`fnv16(path)`)·리포트 창(`"report"`)·로그 창
  (`fnv16("log:"+projectId)`)은 결정적 id라, 다시 누르면 Tauri가 기존 창에 포커스만 준다
  (`lib/floating.ts:147` 주석, `lib.rs open_doc_window`).
- 라벨이 `float-`로 시작하면 Destroyed 훅의 float 분기가 라벨 뒷부분을 PTY paneId로 보고 세션을 죽인다
  (`lib.rs` DOC_LABEL_PREFIX 주석).
- 문서 창 빌더에는 `.disable_drag_drop_handler()`가 있다 — 없으면 WebView2 OS 핸들러가 HTML5 drop을
  가로채 이미지 편집기의 에셋 드롭이 죽는다(`ImageEditor.tsx:3609`).
- 프론트는 라벨로 자기 역할을 판정한다: `IS_DOC_WINDOW`(`lib/floating.ts`), `ROLE`
  (`stores/terminals.ts:38`), `SKIP_VIEWER_PERSIST`(`stores/ui.ts:940`).
- 문서 창의 데이터 프리페치는 **diff만** 있고 로그는 빠져 있었다(`main.tsx` — `!t.log` 조건).

## 3. 설계

### 3.1 풀 하나가 두 종류를 받는다

숨김 창 1개가 렌더러 1벌(273MB)이므로 **종류마다 풀을 두지 않는다.** `FLOAT_POOL`의 배정 장부를
문자열(paneId)에서 열거형으로 바꿔 한 풀이 둘을 구분한다:

```rust
enum PoolClaim {
    Float(String),            // paneId — 창이 닫히면 이 PTY를 종료
    Doc { doc_id: String },   // 문서 창 — 죽일 PTY가 없다
}
impl PoolClaim { fn pty_pane_id(&self) -> Option<&str> }     // Doc → None
fn pool_label_for_doc(claims, doc_id) -> Option<String>      // 문서 싱글턴 조회
```

`open_doc_window`의 순서:
1. `doc-<docId>` 창이 있으면 focus(기존 동작 — 폴백 경로로 만들어진 창).
2. **`claims`에 같은 docId가 있으면 그 창을 focus**(라벨 싱글턴이 하던 일을 장부가 대신한다).
   이걸 빼면 폴더·리포트·로그 창이 누를 때마다 하나씩 늘어난다.
3. 풀에 ready 창이 있으면 claim → `doc://claim {label, docId}` emit → `set_title` ·
   `set_min_size(420×300)` · `set_size(클램프된 w×h)` · `center` · `show` · focus → 백그라운드 리필.
4. ready가 없으면(앱 시작 직후·연타·메모리 경보 중) **기존 직접 생성 경로 그대로**.

`float_pool_ready`의 재신고(vite 리로드) 경로는 배정 종류에 따라 `float://claim` 또는 `doc://claim`을
재전송한다. Destroyed 훅의 풀 분기는 `PoolClaim::pty_pane_id()`가 Some일 때만 PTY를 정리한다.

### 3.2 라벨은 `float-pool-` 그대로 둔다

문서 창까지 받게 됐지만 라벨 문자열은 **바꾸지 않는다**: `float-` 접두사에 기대는 분기가 여럿이고
(`is_secondary_window`·종료 정리·`retitle_aux_windows`) e2e도 그 이름으로 창을 고른다. 대신
`lib.rs`의 풀 절 주석에 "왜 이름이 float-인지"를 남겼다.

라벨이 `float-`로 시작해도 **안전하다** — Destroyed 훅에서 풀 분기가 float 분기보다 먼저 걸리고,
거기서 `PoolClaim::Doc`은 PTY를 건드리지 않는다.

라벨 접두사가 달라지면서 생기는 두 자리는 따로 메웠다:
- `retitle_aux_windows`: 문서로 배정된 풀 창은 건너뛴다(그냥 두면 UI 언어를 바꾸는 순간 제목이
  파일 이름 → "터미널"로 덮인다).
- `IS_DOC_WINDOW`(`lib/floating.ts`): `let` + `markDocWindow()`. 풀 창은 **무엇이 될지 모른 채**
  부트하므로 라벨만으로는 판정할 수 없고, 읽는 쪽(ImageView·ImageEditor·ReportCard·ReportChat)은
  전부 렌더 시점에 읽는 lazy 청크라 ES 모듈 라이브 바인딩으로 새 값을 본다.
- `spawn_float_pool_window`에 `.disable_drag_drop_handler()` 추가 — 문서 창으로 배정될 수 있으므로
  `open_doc_window`와 같은 설정이어야 한다(§2.3). 터미널 창은 OS 파일 드롭을 쓰지 않아 잃는 것이 없다.

`ROLE`(`stores/terminals.ts`)은 풀 문서 창을 `"float"`으로 본다 — 문서 창은 `useTerminals`를 쓰지
않으므로 무해하고, `SKIP_VIEWER_PERSIST`는 이미 `float-`를 포함해 뷰어 탭 영속을 올바르게 건너뛴다.

### 3.3 프론트 — 풀 셸(main.tsx)

지금은 `isFloatPool`이면 `FloatingTerminal`을 풀 모드(paneId=null)로 렌더하고 그 컴포넌트가 claim을
기다렸다. 배정 결과에 따라 **QueryClient 구성과 프리페치가 갈리므로** 창 갈래를 고르는 `main.tsx`가
맡는다:

- 두 리스너(`float://claim`·`doc://claim`)를 **모두 무장한 뒤** `floatPoolReady()`를 부른다(핸드셰이크 순서).
- 배정되면 `floatWindowTree(paneId)` 또는 `docWindowTree(docId)`를 렌더. 두 트리는 라벨 경로
  (`float-<paneId>`·`doc-<id>`)와 **같은 함수**를 쓴다 — 갈라 두면 풀 경로만 캐시·프리페치가 빠져
  "빠르지만 느린 창"이 된다.
- `FloatingTerminal`의 prop은 `paneId: string`으로 좁혔고 풀 대기 코드는 제거했다(중복 제거).
- 대기 중 선로딩은 `lib/terminal-engine`(xterm) **하나만** 유지한다. 둘 다 당기면 숨김 창 하나가
  xterm + Monaco(~3MB)를 통째로 물고 있게 되는데, 이 태스크가 겨냥한 git log 창은 Monaco를 쓰지
  않는다 — 커밋 목록은 순수 DOM이고 Monaco는 파일을 고른 뒤에야 필요하다.

### 3.4 로그 창 데이터 프리페치

`docWindowTree`가 렌더 **전에** 첫 페이지 커밋 목록을 건다. `useLog`(`useInfiniteQuery`, CommitList)와
**같은 키·같은 인자**여야 하므로 `keys.log`와 `LOG_PAGE_SIZE`를 그대로 쓴다(어긋나면 조용히 두 번 읽는다 —
그래서 `LOG_PAGE_SIZE`를 export로 올렸다).

```ts
docQc.prefetchInfiniteQuery({ queryKey: keys.log(t.log), queryFn: () => ipc.getLog(t.log, { limit: LOG_PAGE_SIZE, skip: 0 }), initialPageParam: 0 })
```

**브랜치는 프리페치하지 않는다** — 설계 지시는 "(+브랜치)"였지만 로그 **창**은 `BranchesPane`을 그리지
않는다(`LogWindow.tsx`는 CommitList·CommitDetailPane·DiffViewer만, `BranchesPane`은 Git 모달의
`LogPanel.tsx:35` 전용). 프리페치하면 쓰이지 않는 git 호출이 한 번 더 도는 것뿐이다.
(`LogWindow`가 `repo://changed`에서 `["branches", …]`를 무효화하는 것은 그 자리에 남은 잔재다.)

## 4. 위험

- **e2e가 문서 창을 라벨로 찾는다.** 풀에서 나온 문서 창은 라벨이 `float-pool-N`이고, 더 중요하게는
  **클릭 전부터 `/json`에 있다**(숨김 창). `arr(labels).find(l => l.startsWith("doc-") && !before.includes(l))`
  꼴의 탐지는 어떤 프리워밍 방식에서도 성립하지 않는다 — 스위트 13이 터미널 쪽에서 이미 같은 문제를
  "새로 **보이게 된** 창"으로 풀었다(`13-float-window.mjs` `openFloat`). 영향 스위트: 34·38·45·48·50·60·61·64·68.
- 풀이 비어 있는 동안(앱 시작 직후·연타·메모리 경보 중)은 **기존 속도 그대로**다. 풀 크기는 1이므로
  문서 창을 연달아 열면 두 번째는 폴백이다(리필은 백그라운드로 곧 채운다).
- 터미널 분리와 문서 창이 **같은 풀 하나**를 나눠 쓴다 — 한쪽이 방금 가져갔으면 다른 쪽이 폴백이 된다.
  풀을 2개로 늘리는 것은 메모리 273MB짜리 결정이라 하지 않았다.
- `markDocWindow()`는 `export let` 재대입이다. 읽는 쪽이 모듈 최상위에서 값을 **복사**해 두면
  (`const x = IS_DOC_WINDOW`) 갱신을 못 본다 — 현재 4개 사용처는 전부 렌더 시점 읽기다.

## 5. 검증

### 5.1 정적

- `cargo test --lib`: **385 passed / 0 failed / 7 ignored**. 신규 2건
  (`pool_claim_closes_pty_only_for_terminal_windows`, `pool_doc_claim_is_singleton_per_doc`) —
  전자는 "문서 창을 닫을 때 PTY를 죽이면 안 된다"를, 후자는 문서 싱글턴 조회를 잰다.
- `npx tsc --noEmit`: 0. `vite build`: 성공(메인 청크 953.53 kB — Monaco 3.8MB는 여전히 분리).
- **공유 트리에서는 `npm run build`를 쓰지 마라.** `prebuild`(`scripts/copy-pdfjs-assets.mjs`)가
  `public/pdfjs`를 지우고 다시 복사하는데, 다른 세션의 vite dev가 그 디렉터리를 감시 중이면
  하위 디렉터리가 **삭제 보류(delete pending)** 로 남아 재생성이 EPERM으로 막힌다(실측 2026-09-23 —
  그 vite가 내려간 뒤에 복구됐다). 프론트 빌드만 필요하면 `npx vite build`.

### 5.2 실측 (dev 앱, CDP 29222, 부하 없음)

클릭(`openLogWindow`) → 커밋 목록 렌더 완료까지. 측정 스크립트는 m2를 고쳐 쓴다 — m2는 "새로 생긴
CDP 타겟"으로 창을 찾는데 **풀 창은 호출 전부터 타겟이 있어** 그걸로 찾으면 claim 직후 채워지는
보충 창을 잡는다. 그래서 풀을 먼저 채워 그 숨김 페이지에 **미리 붙고** DOM이 문서 창으로 바뀌는
시각을 잰다.

| | 경로 | ③ "로그 불러오는 중" | ④ **커밋 목록 완료** |
|---|---|---|---|
| **수정 후** | 풀 claim(`float-pool-N`) | **25ms** | **440ms** 중앙값/5회 (435·438·440·443·462) |
| **수정 전** | 직접 생성(`doc-<id>`) — 풀 분기를 끈 변이 빌드 | 554ms | **962ms** 중앙값/3회 (800·962·1455) |
| 참고 | 메인 세션 독립 측정(변경 전 dev) | — | 1026ms |

- **2.2배 · −522ms.** 변이 빌드 수치가 독립 기준선과 일치해 측정 방법이 같다는 것을 확인했다.
- **편차가 사라진 것도 결과다**: 풀 435~462ms(±13), 직접 생성 800~1455ms. 흔들리던 것이 창 부팅이었다.
- ③ 25ms = claim이 창에 닿는 시간. 남은 ~415ms는 dev vite의 `LogWindow` lazy 청크 로드·렌더다
  (프로덕션 번들은 청크가 이미 묶여 있어 더 짧을 것 — 이번엔 측정하지 않았다).

### 5.3 e2e

문서 창 탐지를 **"새로 보이게 된 창"** 으로 바꿨다(§4의 이유). 공용 헬퍼는 `tests/e2e/lib/cdp.mjs`의
`docWindowsBefore`·`newDocWindow`·`forgetDocTarget`, prod 번들용은 `connectDocWindowProd`
(설치본/prod 창에는 `/node_modules/@tauri-apps/api/...` 가 없어 라벨+DOM으로 가른다).

| 스위트 | 결과 |
|---|---|
| 45 git log | ALL GREEN 26/0 — 신규 풀 claim 단언 `프리워밍=float-pool-4 열린창=float-pool-4` |
| 34 이미지·영상 문서 창 | 32/0 |
| 38 이미지 스타일 | 36/0 (단독 2회) |
| 48 리포트 | 61/0 |
| 50 파일트리 모달 | 15/0 |
| 60 즐겨찾기 폴더 | 26/0 |
| 61 PDF | 86/1/3 — 남은 1건은 이 태스크와 무관(§5.5) |
| 64·68 자막 | 58/0/1(LLM 게이트 skip) · 14/0 |
| **전체 샤드** `node tests/e2e/shard.mjs` | **ALL GREEN 1614 pass / 0 fail / 17 skip · 벽시계 222s**(샤드 505/648/461). 설치본 감시 표본 123 · 최대 응답 13ms · 무응답 0회 |

전체 샤드를 돈 이유: 문서 창·프리워밍 풀은 공유 경로다(`is_secondary_window`·종료 정리·
`retitle_aux_windows`·Destroyed 훅). **61의 줌 빨강은 샤드에서는 나오지 않았다** — 샤드는 깨끗한
새 앱을 자기 크기로 띄우므로 §5.5의 "창 크기 의존" 가설과 맞는다.

**변이 검증**: `open_doc_window`의 풀 claim 블록을 `let claimed: Option<String> = None;`으로 바꿔
리빌드하면 45의 신규 단언만 빨개진다(`프리워밍=float-pool-1 열린창=doc-f6964cb3660e0f9b`), 나머지
16건은 초록. **같은 회차가 헬퍼의 양방향성도 증명한다** — 라벨이 `doc-*`인 경로에서도 탐지·싱글턴
단언이 전부 초록이다.

### 5.4 이 작업이 찾아낸 **빈 단언** 2건 (고쳤다)

`48 ⑩ 싱글턴`·`60 ⑤ 재클릭`이 `labels().filter(l => l === label).length === 1`로 세고 있었다.
**Tauri 라벨은 유일해서 그 값은 언제나 0 또는 1**이다 — 싱글턴이 깨져 `doc-<다른 id>` 창이 하나 더
떠도 초록이었다. 둘 다 "이 호출로 **새로 보이게 된 문서 창의 집합**"으로 바꿨고, 45의 같은 단언도
새로 썼다.

### 5.5 이 태스크와 무관한 기존 빨강 (고치지 않았다)

**`38 (51 n) 8MB 저장 거절`** — 오염 구간의 2회차에서 `{"ok":false,"code":null,"message":""}`
(단언은 `code === "IO"` 를 요구한다). 이후 **깨끗한 트리에서 5회 연속 초록**(단독 2회·배치 1회·
전체 샤드)이라 결함으로 확정하지 못했다. 코드를 읽어 둔 결론: Rust 쪽 상한은 견고하고 단위 테스트가
있다(`commands/library.rs` `parse_library` → `ErrorCode::Io`, `oversized_library_is_rejected`).
따라서 `code:null,message:""` 는 **커맨드에 닿기 전에 IPC 전송 단계에서 거절된 모양**이다 —
8MB 인자는 Tauri v2 의 커스텀 프로토콜 요청 본문으로 나가고, 그 단계 실패는 `IpcError` 가 아니라
빈 값으로 거절된다. `파일 보존=true` 였으므로 **안전 속성 자체는 지켜졌다**(마지막 성공본 유지).
재발하면 단언을 "파일 보존 + (code IO **또는** 전송 단계 거절)"로 넓히는 것이 맞지만,
이 태스크 범위가 아니라 손대지 않았다.

`61 (줌) Ctrl+휠(deltaY −120) → 커서 아래 텍스트 점의 이동 ≤ 8px` — 1.25→1.4에서 이동
`(-28.8, 0.2)px`. **2회 재현, 값이 완전히 동일**(간헐이 아니다). 이 태스크 탓이 아닌 근거:
그 단언은 **메인 창**의 PDF 뷰어에서, 그 스위트가 문서 창을 만들기 **전에** 돈다. 경로에 있는
`PdfView.tsx`·`lib/pdf/*`는 이 작업이 건드리지 않았고, 최근 그 파일을 만진 i18n 커밋(95c1975)의
변경도 버튼 라벨 문자열뿐이다(기하 코드 무변경). 원인 미확정 — 창 크기 의존일 가능성이 있다.

## 6. 열린 질문

- 풀 크기 1 유지 vs 문서 창 사용 빈도가 높은 사용자에게 2 — 메모리 273MB/창이라 실사용 빈도 데이터가
  먼저 필요하다.
- 문서 창용 선로딩(Monaco)을 "파일 뷰어를 최근에 열었으면"처럼 조건부로 당길 가치가 있는지.
