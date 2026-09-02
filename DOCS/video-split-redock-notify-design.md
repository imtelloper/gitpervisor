# 4건 기능 배치 — 상세 태스크 설계

> 상태: **4건 전부 구현·검증 완료(2026-09-02, 미커밋)** — 2026-08-28 초안 · 2026-09-02 현재 코드로 전면 재검증 후
> 태스크 문서 20·21·22로 구현(각 문서 §8에 결과), F2는 `aggregate-window-redock-memo-design.md` §8 · `/sc:design` 산출물
>
> 요구 4건:
> - **F1** 동영상 플레이어에 타임틱을 여러 개 세우고, 각 틱 기준으로 영상을 한꺼번에 분리해
>   폴더 안에 따로 저장
> - **F2** 분리(Float)시킨 터미널을 다시 모아보기 쪽으로 편입
> - **F3** 새 버전이 나오면 우측 하단에 업데이트 알림
> - **F4** 처음 설치해 사용해본 사용자에게 우측 하단에 GitHub star 부탁 알림
>
> **상세 태스크 문서**(구현 단위 — `/sc:implement`·`implementer` 입력):
> `DOCS/task/20-update-notify.md`(F3) · `DOCS/task/21-github-star-prompt.md`(F4) ·
> `DOCS/task/22-video-timetick-split.md`(F1) · 인덱스 `DOCS/task/00-INDEX.md` §6.
>
> **재검증에서 바뀐 것(초안 대비)**
> - **F2는 구현 완료·실기 검증 통과(2026-09-02, 미커밋).** 후속 설계 `aggregate-window-redock-memo-design.md`
>   §1·§2 경로로 구현됐고 검증 내역은 그 문서 §8. 절차에 **결함 1건 정정**이 구현에 반영됐다 — 우회 등록은
>   창의 대표 paneId **하나만**(§2.2). 이 문서의 §2는 기록용이다.
> - **F4의 신규 Rust 커맨드(`open_url`)는 불필요한 것으로 정정.** 메인 웹뷰의 `window.open`이 이미
>   `on_new_window` 핸들러를 거쳐 http/https만 OS 브라우저로 위임된다(§4). 초안의 "프론트에서 외부
>   URL을 여는 경로가 0"은 틀렸다.
> - **F1·F3은 미착수.** 근거 줄번호를 현재 코드로 갱신했고 결론은 유지. F1은 배치 상태를 컴포넌트가
>   아니라 스토어에 두도록 1건 보강(§1.2).
>
> 네 기능은 서로 독립이다 — 태스크 번호는 기능별이고 어떤 순서로도 착수 가능. 권장 순서는 §6.

---

## 0. 결정 요약

| # | 기능 | 핵심 결론 | 근거 |
|---|---|---|---|
| F1 | 타임틱 분할 | **백엔드 무변경.** 분할 = 기존 `video_export`(copy 기본)를 세그먼트 수만큼 **순차** 호출. 출력은 원본 옆 `<stem>.split/` 폴더. 배치 상태는 신규 스토어 `videoSplit`에 | ExportSpec에 range가 이미 있다(video.rs:404-418). `-f segment` 방식은 진행률·취소 모델을 통째로 우회해 기각(§1.2). 컴포넌트 상태에 두면 편집 패널을 닫는 순간 취소 버튼을 잃는다 |
| F2 | 분리 → 모아보기 편입 | **구현 완료.** "편입" = 메인 스토어에 pane을 되돌려 넣기 — 위임 프로토콜·PTY-kill 우회·플로팅 창 `redock()`·e2e 13(17 pass)·실기 검증까지 끝남 | 모아보기는 `gp:terminals`를 읽기만 하므로 스토어 복귀 → storage 이벤트 → 셀 자동 편입(AggregateTerminals.tsx:230-251)이 전부 기존 경로 |
| F3 | 업데이트 알림 | **신규 기능이 아니라 기존 토스트 3가지 약점 수리**: 6초 소멸 → persistent 옵션, 설정 딥링크 부재 → `settingsCategory`, 시작 시 1회 체크 → 12h 주기 재확인 | 토스트는 이미 우측 하단에 뜬다(updater.ts:76-80, Toast.tsx:12). 이 앱 사용자는 설치본을 상시 켜 둔다(CLAUDE.md) — 시작 시 1회 체크로는 새 릴리스를 영영 모른다 |
| F4 | star 부탁 | 우측 하단 **persistent 카드**(HealthBanner 패턴), **3번째 실행에 1회**. 플래그는 localStorage(`gp:star-asked`), 링크는 **`window.open` → 기존 `on_new_window` 위임**. **Rust 변경 0** | "한 번만 보여주기"의 선례가 전부 localStorage다(§4.1). 메인 창 빌더의 `on_new_window`(lib.rs:773-778)가 http/https를 `open_external`로 넘기고 Deny 한다 — 프론트에서 부를 수 있는 검증된 경로가 이미 있다 |

**플래그 저장 원칙(공통)**: 사용자가 설정 UI에서 되돌릴 필요가 없는 1회성 플래그는
localStorage `gp:*` 키로 간다. settings.json에 필드를 추가하면 `git/types.rs` 구조체 +
`ipc.ts` 타입 + `settings-index.ts` + 섹션 UI + e2e 29의 완전성 가드
(`29-settings-ux.mjs:80-86`)까지 5곳이 연쇄된다.

**백엔드 신규 커맨드: 0개.** F2의 `float_redock_begin`은 워킹트리에 이미 있고(lib.rs:279, 등록 :874),
F4는 위와 같이 불필요해졌다. F1·F3은 처음부터 Rust 무변경.

---

## 1. F1 — 동영상 타임틱 분할

### 1.1 현황(근거 — 2026-09-02 확인)

- **타임라인은 전부 div다** — canvas 없음. `VideoPlayer.tsx:659-1046`의 `Timeline`이
  DVR식 눈금자(줌·팬·미니맵 포함). 재사용할 부품:
  - 좌표 헬퍼 `pct/visible/fullPct/posToTime`(:713-728)
  - 드래그 킷 `trackPointer`(:799-824) + `startDrag("seek"|"in"|"out")`(:826-832) —
    `"tick:<i>"` 모드 추가는 소규모 확장
  - In/Out 마커(:981-1023)의 `{line div + badge div}` 패턴, `badgeCls`(:853)·`shift()`(:859)
  - 미니맵(:905-946)이 이미 In/Out을 1px 라인으로 그린다 — 틱도 같은 자리
- **단일 구간 트림은 이미 있다**: `inPt`/`outPt` 한 쌍(:74-75, 키 `I`/`O`) → ExportPanel 클립
  내보내기. 다중 마커·분할·concat은 코드에 없다(concat은 video-editor-design.md에서 명시 보류).
- **내보내기 파이프라인 완비**: `video_export(jobId, ExportSpec{range, mode:"copy"|"encode",…})`
  (video.rs:660) → `.tmp` 기록 후 rename, 진행률 `video://export-progress`(정수 % 변화 시만),
  종료 `video://export-finished`(AlreadyExists 제외 모든 결말 — :655-658 계약), 취소
  `video_export_cancel`(:854). **동시 실행 제한은 어디에도 없다** — 직렬화는 ExportPanel의 단일
  `jobId` busy 상태가 유일(UI 레벨, :268).
- **저장 위치는 OS 다이얼로그 없이 원본 옆** — 의도된 결정(video-editor-design.md 오픈이슈 ③,
  산출물이 워크트리에 남아 대시보드에 보이게). `resolve_in_repo`(tree.rs:1677)는 **부모 폴더가
  이미 존재해야** 통과 → 새 하위 폴더는 `ipc.createDir`(ipc.ts:995 → tree.rs:97, 단일 레벨,
  기존재 시 `ALREADY_EXISTS`)로 먼저 만든다.
- `events.ts:93-105`가 `export-finished`마다 토스트 + 쿼리 무효화를 한다 — 배치로 N번 돌리면
  토스트 N개가 쏟아진다. ExportPanel은 자기 jobId만 구독(:126-157)하고 토스트는 안 띄운다(계약).
- 키보드(:288-353): `T`, `X`, `Delete`, `[`, `]` 등이 비어 있다. 수정자 조합은 전역에 양보(:294).

### 1.2 설계

**분할 실행 방식 비교**

| 방식 | 판단 |
|---|---|
| (a) **세그먼트당 기존 `video_export` 순차 호출** ✅ | 백엔드 0줄. 진행률·취소·tmp+rename·에러 보고 전부 상속. copy 모드는 I/O 바운드라 세그먼트당 수 초 |
| (b) ffmpeg `-f segment -segment_times` 1회 실행 | 기각 — 신규 args·신규 진행률 파싱·부분 실패 처리 전부 새로 써야 하고, `-c copy`면 어차피 키프레임 스냅이라 정밀도 이득도 없다 |
| (c) N개 동시 실행 | 기각 — 동시 ffmpeg N개는 이 앱의 프로세스 위생 원칙(OOM 사건 이후)과 어긋난다. 순차 1개씩 |

**배치 상태의 위치 — 컴포넌트가 아니라 스토어**(재검증 보강)

ExportPanel은 편집 패널(`editOpen`) 안에 산다. 배치 루프를 컴포넌트 클로저에 두면 패널을 닫거나
파일을 바꾸는 순간 진행률·취소 버튼이 사라진다(루프 자체는 프라미스라 계속 돌지만 손댈 수 없다).
그래서 **신규 `stores/videoSplit.ts`**(zustand, 소형)에 둔다:

```ts
interface SplitBatch {
  projectId: string; folderRel: string;
  total: number; done: number;              // 완료 세그먼트 수
  currentJobId: string | null; currentPct: number;
  jobIds: Set<string>;                      // events.ts가 토스트를 거를 때 참조
  cancelled: boolean; error: string | null;
}
start(projectId, srcRel, segments, { folder, mode }) · cancel() · owns(jobId) · advance(payload)
```

- `start`가 순차 루프를 돈다: `createDir`(ALREADY_EXISTS 무시) → 세그먼트마다 `videoExport` →
  `done++`. 취소·실패 시 중단. 마지막에 **요약 토스트 1개**를 스토어가 직접 띄운다.
- `events.ts:93`의 종결 리스너 첫 줄에 `if (useVideoSplit.getState().owns(jobId)) { advance(payload); return; }`
  — 개별 토스트 억제 + 진행 반영. 쿼리 무효화는 배치 종료 시 스토어가 1회.
- ExportPanel은 이 스토어를 **렌더만** 한다. 단일 내보내기의 `busy`(:268)와 배치 진행 중은 상호 배타.

**동작 정의**

- 틱 상태: `ticks: number[]`(초, **정렬하지 않은** 배열 — 드래그 중 인덱스가 안정해야
  `"tick:<i>"` 모드가 성립. 정렬은 세그먼트 계산 시점에만). `VideoPlayer` 로컬 state, inPt/outPt와
  같은 수명(파일 전환 시 리셋, 영속 없음).
- 조작: 키 `T` = 현재 재생 위치에 틱 추가. 타임라인 마커(앰버 계열 — In 초록/Out 빨강과 구분)
  드래그 이동, 배지 우클릭 = 삭제. 미니맵 1px 라인. 분할 섹션에 "틱 모두 지우기".
- 세그먼트 계산: 경계 = `[0, …정렬된 틱, duration]` → 인접 쌍이 세그먼트. 틱은
  `(0, duration)` 클램프, 100ms 미만 간격은 병합(무의미 세그먼트 방어).
- 출력: 폴더 `<stem>.split/`(이름 편집 가능, `/ \ ..` 금지 — ExportPanel `nameInvalid`(:197) 규칙
  재사용). 파일명 `<stem>.part-01.<ext>`(0패딩 폭 = 세그먼트 수 자릿수, 최소 2).
  확장자: copy 모드 = 원본 컨테이너 유지, encode 모드 = mp4.
- 모드: 기본 **무손실 복사**(키프레임 스냅 경고 문구 기존 것 재사용), 체크 하나로
  "정확한 지점에서 분할(재인코딩)" = encode.
- 진행률: 집계 = `(done + currentPct/100) / total`. "3/7 · part-03 인코딩 중" 표기.
- 취소: `video_export_cancel(currentJobId)` + `cancelled=true`로 루프 중단. **이미 완성된
  세그먼트는 남긴다**(정직 표기: "3/7개 저장 후 중단").
- 실패: k번째에서 비-취소 오류 → 중단, 요약 토스트 error("part-04에서 실패: <원인> · 3개 저장됨").
- 덮어쓰기: 폴더 `createDir`의 `ALREADY_EXISTS`는 무시(재사용). 세그먼트 export에서
  `ALREADY_EXISTS` 첫 발생 시 `askConfirm` 1회("기존 분할 결과를 덮어쓸까요?") → 이후 전 잡
  `overwrite:true`. 거부 시 배치 중단(완료분 유지).
- In/Out 구간과의 관계: **v1은 무관** — 분할은 전체 길이 기준(§7 오픈이슈 ①).

### 1.3 태스크

| # | 내용 | 파일 | 완료 기준 |
|---|---|---|---|
| T1.1 | 틱 상태 + 타임라인 마커(추가 `T`·드래그 `"tick:<i>"`·우클릭 삭제·미니맵 라인). In/Out 2개 전용인 배지 겹침 휴리스틱(:867-873)을 N개 일반화 | `VideoPlayer.tsx` | 틱 3개 추가·드래그·삭제가 줌/팬 상태에서도 좌표 정확. 파일 전환 시 리셋 |
| T1.2 | `stores/videoSplit.ts`(§1.2 인터페이스) + `events.ts` 종결 리스너 첫 줄 위임 | `stores/videoSplit.ts`(신규), `lib/events.ts` | 배치 중 개별 토스트 0개, 종료 시 요약 1개. 취소 시 루프 중단 + 완료분 유지 |
| T1.3 | ExportPanel "분할" 섹션(틱 ≥1일 때 노출): 폴더명·모드·세그먼트 수·실행/취소·진행 표기. 단일 내보내기와 상호 busy 배타 | `ExportPanel.tsx` | 틱 3개 → 파일 4개 생성, 진행률 단조 증가, 편집 패널을 닫았다 열어도 진행 중 상태 유지 |
| T1.4 | 검증: 실제 영상으로 분할 — `ffprobe`로 각 세그먼트 길이 합 ≈ 원본(±키프레임 오차), encode 모드는 경계 정밀. 취소·덮어쓰기·폴더 기존재·패널 닫기 중 진행 각 1회 실측 | (검증) | 정적 검증만으로 통과 금지(CLAUDE.md) |

### 1.4 한계

- copy 모드는 각 세그먼트 시작이 직전 키프레임으로 당겨진다 → **경계가 프레임 단위로
  정확하지 않고 인접 세그먼트에 중복 구간이 생길 수 있다.** 기존 클립 내보내기와 동일한
  한계이고 UI 경고도 같은 문구를 쓴다. 정확성이 필요하면 encode 모드.
- 틱은 저장되지 않는다 — 파일을 떠나면 사라진다. 영속이 필요해지면 그때 설계(YAGNI).
- 배치는 앱 재시작을 넘기지 못한다(진행 중 종료 시 현재 세그먼트의 `.tmp`는 백엔드가 정리,
  완료분은 남는다).

---

## 2. F2 — 분리 터미널을 모아보기로 편입

> **구현 완료·실기 검증 통과(2026-09-02, 미커밋).** 설계 근거·대안 비교는
> `aggregate-window-redock-memo-design.md` §1(위임)·§2(되돌리기), 검증 내역과 구현 중 드러난 결함 수정은
> 같은 문서 §8이 원본이다. 이 절은 **구현 현황 표와 최종 절차의 기록**이다.

### 2.1 구현 현황(워킹트리, 2026-09-02 미커밋 — 전부 완료)

| 항목 | 상태 | 위치 |
|---|---|---|
| 위임 프로토콜 `TerminalsCmd`·`sendTerminalsCmd`(emitTo "main") | ✅ | `stores/terminals.ts:40-51` |
| `openTerminal(projectId, ids?)` — 살아 있는 paneId를 담은 새 탭 | ✅ | `:298-304` |
| aggregate 가드 3개(openTerminal/floatPane/closePane → 메인 위임) | ✅ | `:301, :411, :465` |
| 메인 `terminals://cmd` 리스너 | ✅ | `:552-562` |
| Rust `AppState.redock_skip` | ✅ | `state.rs:34` |
| `float_redock_begin(term_ids)` 커맨드 + 등록 | ✅ | `lib.rs:279-289`, `:874` |
| `close_unless_redocking` — Destroyed **풀 분기**(:999)·**float 분기**(:1013) 모두 | ✅ | `lib.rs:300-310` |
| 유닛테스트 `redock_skip_is_consumed_once`(1회성 소비) | ✅ | `lib.rs:1102-1115` |
| 별도 창 `<ConfirmHost />` | ✅ | `AggregateWindow.tsx:52` |
| `FloatTitleBar` `actions` 슬롯 | ✅ | `FloatTitleBar.tsx` `actions?: ReactNode` |
| 플로팅 창 "메인으로 되돌리기" 버튼 + 절차(대표 id만 등록) | ✅ | `FloatingTerminal.tsx` `redock()` |
| e2e 13 redock 케이스 + 1회성 회귀 가드 + 풀 라벨 인식 | ✅ | `13-float-window.mjs`(17 pass 실측) |
| 실기 검증 | ✅ | 풀 창·비풀 창 두 경로, 분할 2 pane 창, 되돌린 세션 에코·ConPTY 실폭 — `aggregate-window-redock-memo-design.md` §8 |

핵심 환원은 그대로다: **"모아보기로 편입" = 메인 스토어에 pane을 되돌려 넣는다.** 메인이
`openTerminal(projectId, {paneId})`로 새 탭을 만들면 영속 → storage 이벤트 → 보이는 쪽(워크스페이스
탭 / 메인 안 모아보기 / 별도 창)이 셀을 마운트하며 `createTerminal` → `sessionExists` → attach.
후반부는 전부 기존 코드고 이미 위임 명령이 그 경로를 탄다.

### 2.2 최종 절차 — 플로팅 창 쪽(구현됨: `FloatingTerminal.tsx` `redock()`)

**절차**(버튼 "메인으로 되돌리기" 클릭 시):

```
1. panes = collectPanes(tab.layout)                       — 분할로 늘린 pane 포함
2. await invoke("float_redock_begin", { termIds: [paneId] })   ← 대표 id 하나만(아래). 창 닫기 전 완료 필수
3. panes.forEach(detachTerminalKeepPty)                   — xterm 위생(창이 곧 죽으므로 필수는 아님)
4. panes.forEach(p => sendTerminalsCmd({ op:"openTerminal", projectId, paneId:p }))
5. useTerminals.setState({ terminals: [] })               — 기존 효과(:165-167)가 창을 닫고,
                                                            beforeunload(:153-162)는 빈 목록을 돌아 dispose 없음
```

**정정 — 우회 등록은 대표 paneId 하나만.** 초안(과 후속 설계 B3)은 `panes` 전부를 넘기게 돼 있었다.
그런데 Destroyed 훅이 `close_unless_redocking`에 넘기는 id는 **창당 하나**다 — 풀 창은
`FLOAT_POOL.claims[label]`(:999), 비풀 창은 라벨 접미사(:1013). 둘 다 이 창의 대표 paneId
(`fixedPaneId` 또는 claim으로 받은 `paneId` state)와 같다. 분할로 늘린 pane의 id는 Rust가 **한 번도
조회하지 않으므로** `redock_skip`에 영구히 남고, 나중에 사용자가 그 pane을 메인에서 다시 분리했다가
**진짜로** 닫으면 그때 Destroyed가 skip을 발견해 PTY를 살려 둔다 → 고아 셸(2026-08 누수 유형).
`take_redock_skip`의 주석이 경고하는 바로 그 경로다. 분할 pane의 PTY가 살아남는 데는 등록이 필요
없다 — 그것들은 beforeunload dispose로만 죽는데 5단계에서 목록이 비어 있다.

- **범위 = 창 단위**: 창의 모든 pane을 되돌린다. pane마다 **새 탭 1개**("터미널 N") — 원위치
  복귀가 아닌 이유는 후속 설계 §2.2(float 시점에 위치 정보를 버린다). §7 ③.
- **버튼**: `FloatTitleBar`에 `actions?: ReactNode` 슬롯(창 컨트롤 :37-49 왼쪽). 라벨은
  "메인으로 되돌리기" — 모아보기가 열려 있으면 자동으로 거기 나타나고, 닫혀 있으면 워크스페이스
  탭으로 간다. "모아보기로"라고 쓰면 모아보기가 닫혀 있을 때 거짓말이 된다. 풀 창은 `tab`이
  생기기 전(claim 전)엔 렌더 자체가 없어(:169) 버튼도 없다.
- **크기**: 되돌아온 쪽은 **새 xterm 인스턴스**라 fit이 80×24에서 바뀌며 `onResize` →
  `term_resize`가 나간다. CLAUDE.md의 같은-크기 함정은 *기존 인스턴스 재부착*(별도 창 닫힘) 경로다.
  그래도 검증에서 `#2b` 방식(`14-frontend-dom.mjs:142-188`)으로 실폭을 본다.
- **메인 창이 없을 때**(종료 중): `emitTo("main")`이 실패하고 창은 닫힌다. PTY는 skip으로 살아
  있지만 메인 종료의 `shutdown_children`이 전부 거둔다 — 별도 처리 없음.

### 2.3 태스크(전부 완료 — 기록)

| # | 내용 | 파일 | 완료 기준 |
|---|---|---|---|
| T2.1 | `FloatTitleBar` `actions` 슬롯 | `components/FloatTitleBar.tsx` | 기존 3 사용처(플로팅·모아보기 창·sysmon) 무영향 |
| T2.2 | 되돌리기 버튼 + 절차 1~5(대표 id만 등록) | `FloatingTerminal.tsx` | 클릭 → 창 닫힘, `term_project(paneId)` non-null(PTY 생존), 메인에 pane 수만큼 새 탭 |
| T2.3 | e2e 13에 redock 케이스: float → `float_redock_begin` → 창 close → `term_project` non-null + `terminals://cmd` 수신 후 메인 `__gpv.terminals`에 paneId 존재 | `tests/e2e/suites/13-float-window.mjs` | 단언 통과. 별도 창 webview 구동이 어려우면 메인에 `terminals://cmd`를 직접 emit(같은 코드 경로) |
| T2.4 | 실기: **풀 창·비풀 창 두 경로**(연속 2회 분리하면 두 번째가 비풀) × 되돌린 세션 위치 3가지(워크스페이스 / 메인 안 모아보기 / 별도 창) + 입력 에코 + ConPTY 실폭 + 분할 2개짜리 창 되돌리기 후 그 pane 재분리→진짜 닫기 시 PTY 종료 확인(정정 사항 회귀) | (검증) | 실측 |

### 2.4 한계

- **스크롤백은 이전되지 않는다** — 기존 창 이동(모아보기·Float)과 동일한 알려진 한계
  (terminal.rs `term_attach` 주석). 이번 범위에서 확장하지 않는다.
- 분리 창에서 늘린 pane까지 전부 편입되므로, "이 pane만"을 원하면 편입 후 다시 분리해야 한다 —
  pane 단위 편입은 수요가 확인되면.

---

## 3. F3 — 업데이트 알림(우측 하단)

### 3.1 현황(근거 — 2026-09-02 확인, 변동 없음)

- **알림 자체는 이미 있다.** `updater.ts:76-80` — 새 버전 발견 시
  `pushToast("info", "새 버전 v… — 설정에서 업데이트", {label:"설정 열기", …})`.
  토스트는 우측 하단이다(Toast.tsx:12, `absolute bottom-8 right-4 z-50`). 문제는 셋:
  1. **6초 자동 소멸**(ui.ts:473 하드코딩) — 시작 4초 뒤에 떠서 10초 만에 사라진다.
  2. **"설정 열기"가 업데이트 탭으로 못 간다** — `SettingsDialog.tsx:71`의 category가
     로컬 state, 항상 `"general"` 초기화. 딥링크 인자 없음. 카테고리 id `"update"`는 있다
     (settings-index.ts:32).
  3. **체크가 시작 4초 후 1회뿐**(App.tsx:76-83, dev 가드 + autoCheck 가드) — 이 앱은
     설치본을 상시 켜 두는 사용 패턴이라(CLAUDE.md) 재시작 전까지 새 릴리스를 모른다.
- 설치 흐름·상태머신·권한은 완비: `downloadAndInstall`(updater.ts:101-149) →
  `prepare_relaunch` → install. 엔드포인트·passive 모드는 tauri.conf.json:21-25.
- 토스트는 액션 버튼 1개·수동 X 닫기 지원, duration 제어만 없다(`pushToast(kind, message, action?)`, ui.ts:153-157).

### 3.2 설계

최소 수리 3건 — 신규 컴포넌트 없음:

- **persistent 토스트**: `pushToast(kind, msg, action?, opts?: {durationMs?: number | null})`
  — `null`이면 수동 닫기 전까지 유지. 기본값 6000 유지로 기존 호출부 전원 무영향.
- **설정 딥링크**: `useUi.settingsCategory: SettingsCategory | null` 추가 →
  `setSettingsOpen(true)`와 함께 지정하면 SettingsDialog의 열기 효과(:86-95)가 초기 카테고리로
  소비하고 null로 되돌린다(1회성). 업데이트 토스트 액션 = "업데이트 열기" → 업데이트 탭 직행.
- **주기 재확인**: App.tsx 초기 체크 옆에 `setInterval` 12시간 silent 체크(동일 dev·autoCheck
  가드 — **dev 가드를 빼면 dev 창의 "설치"가 설치본을 갈아엎는다**, CLAUDE.md). **중복 알림 방지**:
  updater 스토어에 `notifiedVersion` — 같은 버전은 세션당 1회만 토스트. 사용자가 X로 닫으면 그
  세션엔 다시 안 뜬다(다음 실행 또는 더 새 버전에서 재알림). 수동 "지금 확인"도 같은 규칙.

버전별 영구 무시("이 버전 건너뛰기")는 만들지 않는다 — 요구에 없고, persistent 토스트 +
세션당 1회로 충분(YAGNI).

### 3.3 태스크

| # | 내용 | 파일 | 완료 기준 |
|---|---|---|---|
| T3.1 | `pushToast`에 `durationMs`(기본 6000, `null`=수동 닫기까지) | `stores/ui.ts` | 기존 호출부 동작 불변(타입 통과), persistent 토스트가 안 사라짐 |
| T3.2 | `settingsCategory` 딥링크 + updater 토스트를 persistent·"업데이트 열기"로 교체 | `stores/ui.ts`, `SettingsDialog.tsx`, `stores/updater.ts` | 토스트 액션 클릭 → 설정이 업데이트 탭으로 열림, 다음 일반 열기는 general |
| T3.3 | 12h 주기 silent 재확인 + `notifiedVersion` 중복 방지 | `App.tsx`, `stores/updater.ts` | 수동 "지금 확인" 2회 연속 시 토스트 1회만. 인터벌에도 dev 가드 |
| T3.4 | 검증: 구버전 설치본에서 설정 › "지금 확인"으로 실기 재현, e2e 29에 딥링크 단언 추가 | (검증) | 딥링크·persistent 실측 |

---

## 4. F4 — GitHub star 부탁 알림

### 4.1 현황(근거 — 2026-09-02 확인)

- **첫 실행 추적이 없다.** `session.json`은 매 실행 덮어쓰기라 판별 불가, `first_run`·
  `launch-count`류 코드 전무(grep 0건).
- **"한 번만 보여주기"의 선례는 전부 localStorage**: `gp:prev-session-seen`
  (HealthBanner.tsx:49-50), `gp:update-autocheck`(updater.ts:23 — 백엔드 Settings 스키마를
  건드리지 않는다고 주석에 명시), 오늘 추가된 `gp:memo-active:*`·`gp:memo-size`도 같다.
- **persistent 우측 하단 카드의 정확한 선례 = HealthBanner**(`fixed bottom-8 right-4 z-40`,
  :105, 자동 소멸 없음, 카드별 X, 액션 버튼 여러 개, `role="alert"`). 토스트(z-50)와 같은 구석을
  공유한다는 주석이 양쪽에 있다(Toast.tsx, HealthBanner.tsx:102-104).
- **외부 URL 열기 — 초안 정정.** 메인 창 빌더(lib.rs:749)의 `.on_new_window`(:773-778)가
  `window.open`을 가로채 **http/https만** `commands::open_external`(browser.rs:146 Windows
  `ShellExecuteW` · :167 macOS `open` · :173 Linux `xdg-open`, 뒤 둘은 `spawn_launcher` 경유로
  앱 cgroup 밖)로 넘기고 `Deny`를 돌려준다. 즉 **프론트에서 `window.open(url)` 한 줄이면 검증된
  경로로 기본 브라우저가 뜬다.** 신규 커맨드·capability·opener 크레이트(현재 JS 패키지만 있고
  Rust 크레이트 없음 — 호출하면 런타임 실패) 전부 불필요. 단, 현재 `src/`에 `window.open` 호출은
  0건이라 **실기 검증이 필수**(§4.3).
- 저장소 URL: `https://github.com/imtelloper/gitpervisor`(tauri.conf.json:22의 updater 엔드포인트와
  같은 레포. 코드 내 상수 없음 — 신규 정의).

### 4.2 설계

- **노출 시점: 3번째 실행에 1회.** `gp:launch-count`(App 마운트 시 증가 — 메인 창에만 마운트되므로
  보조 창은 세지 않는다; StrictMode 이중 실행은 모듈 플래그로 1회 보장) ≥ 3이고 `gp:star-asked`가
  없으면 표시. 근거: 첫 실행 직후는 "사용해본" 상태가 아니고, 온보딩 중 알림은 닫힘만 당한다.
  (§7 오픈이슈 ②)
- **UI: `StarPrompt.tsx` 카드** — HealthBanner와 동일 스타일. 문구 예: "Gitpervisor가
  도움이 되었나요? GitHub ⭐ 하나가 큰 힘이 됩니다." 버튼 [GitHub에서 Star 남기기] [닫기].
  **어떤 상호작용이든 `gp:star-asked` 기록** — 두 번 조르지 않는다.
- **링크**: `window.open(GITHUB_REPO_URL, "_blank", "noopener")` — 반환값은 항상 null(Deny)이라
  쓰지 않는다. 상수는 `StarPrompt.tsx` 안에 두고 두 번째 사용처가 생기면 승격.
- **겹침 정리**: HealthBanner와 StarPrompt를 App.tsx의 공용 스택 컨테이너
  (`fixed bottom-8 right-4 z-40 flex flex-col gap-2`) 하나로 묶는다 — 동시 표시 시 세로로
  쌓이고, 토스트(z-50)는 지금처럼 그 위에 뜬다. HealthBanner는 위치 클래스만 잃는다.
- **비상 대안(선제 구현 안 함)**: 어느 OS에서든 `window.open` 경로가 안 뜨면 그때
  `open_url(url)` 커맨드(기존 `open_external` 3줄 래핑 + http/https 화이트리스트 — `on_new_window`와
  같은 이유로 `file:`·커스텀 스킴 차단)를 추가한다. 검증 전에 만들지 않는다.

### 4.3 태스크

| # | 내용 | 파일 | 완료 기준 |
|---|---|---|---|
| T4.1 | `StarPrompt.tsx` + 노출 조건(launch-count) + `gp:star-asked` + `window.open` 링크 | `components/common/StarPrompt.tsx`(신규) | localStorage 초기화 후 3회째 실행에 1회 노출, 상호작용 후 영구 미노출 |
| T4.2 | 공용 스택 컨테이너 + HealthBanner 위치 클래스 이동 | `App.tsx`, `HealthBanner.tsx` | 두 카드 동시 표시 시 겹침 없음, HealthBanner 단독 동작 불변 |
| T4.3 | 검증: 실기에서 localStorage 리셋 → 3회 실행 → 노출·클릭·**기본 브라우저가 뜨는지 Windows/Linux 각 1회**(macOS는 릴리스 전 1회) → 재실행 미노출. Linux는 브라우저가 앱 cgroup 밖에 뜨는지(`spawn_launcher` 경로) 확인 | (검증) | 실측. 어느 OS든 실패하면 §4.2 비상 대안으로 |

---

## 5. 변경 지점 총괄

| 파일 | F | 변경 |
|---|---|---|
| `src/components/video/VideoPlayer.tsx` | F1 | 틱 상태·마커·키 `T`·드래그 모드 |
| `src/stores/videoSplit.ts` | F1 | **신규** — 배치 오케스트레이터·토스트 억제 |
| `src/components/video/ExportPanel.tsx` | F1 | 분할 섹션(스토어 렌더) |
| `src/lib/events.ts` | F1 | 종결 리스너 첫 줄 위임(3줄) |
| `src/components/FloatTitleBar.tsx` | F2 | `actions` 슬롯 — **완료(워킹트리)** |
| `src/FloatingTerminal.tsx` | F2 | 되돌리기 버튼 + 절차 — **완료(워킹트리)** |
| `tests/e2e/suites/13-float-window.mjs` | F2 | redock 케이스 — **완료(17 pass)** |
| `src/stores/ui.ts` | F3 | `durationMs`·`settingsCategory` |
| `src/stores/updater.ts` | F3 | persistent 토스트·딥링크·`notifiedVersion` |
| `src/App.tsx` | F3, F4 | 12h 재확인 · 카드 스택 컨테이너 + StarPrompt 마운트 + launch-count |
| `src/components/settings/SettingsDialog.tsx` | F3 | 초기 카테고리 소비 |
| `src/components/common/StarPrompt.tsx` | F4 | **신규** |
| `src/components/common/HealthBanner.tsx` | F4 | 위치 클래스를 공용 스택으로 이동 |
| `tests/e2e/suites/29-settings-ux.mjs` | F3 | 설정 딥링크 단언 |

**Rust 변경: 0.** (F2의 Rust 몫은 워킹트리에 이미 있다 — `state.rs`, `lib.rs`.)
신규 파일 2개(`videoSplit.ts`, `StarPrompt.tsx`).

---

## 6. 구현 순서(권장)

0. **F2는 끝났다.** 워킹트리의 미커밋 변경(F2 + 모아보기 위임 + 메모장)을 먼저 커밋해 아래 작업과 diff를
   섞지 않는다.
1. **F3 → `DOCS/task/20-update-notify.md`** — 기존 코드 수리 수준, 반나절감.
2. **F4 → `DOCS/task/21-github-star-prompt.md`** — 선례 복제 + `window.open` 실기 확인.
3. **F1 → `DOCS/task/22-video-timetick-split.md`** — 프론트 전용이지만 타임라인 좌표계·배치
   오케스트레이션이 몸통. 가장 크다.

각 태스크 문서가 계약(§4)·단계(§5)·위험(§6)·검증(§7)을 구현 단위로 담는다. 이 문서의 §1·§3·§4
태스크 표(T1.x·T3.x·T4.x)는 요약이고, 충돌 시 태스크 문서가 우선한다.

---

## 7. 오픈 이슈(사용자 결정 — 없으면 기본값)

| # | 질문 | 기본값(결정 없으면 이대로 구현) |
|---|---|---|
| ① | F1: In/Out 구간이 설정된 상태의 분할 — 구간 안만 분할? | **전체 길이 분할**(구간 무시). 구간 내 분할은 수요 확인 후 |
| ② | F4: 노출 시점 — 3번째 실행 vs 첫 실행 즉시 | **3번째 실행**. "사용해본" 뒤에 조르는 게 전환율도 매너도 낫다 |
| ③ | F2: 분리 창에 분할 pane이 여럿일 때 — 전부 편입 vs 대표 1개 | **전부 편입**(창 단위 버튼, pane마다 새 탭) |
| ④ | F3: 재확인 주기 | **12시간**. 릴리스 빈도 대비 충분, 트래픽 무의미 수준 |
| ⑤ | F1: 분할 결과 폴더가 이미 있고 파일이 겹칠 때 | **1회 확인 후 전체 덮어쓰기**(잡별 N회 묻지 않는다) |
