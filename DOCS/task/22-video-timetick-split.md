# 태스크 22 — 동영상 타임틱 분할 (틱 N개 → 세그먼트 N+1개를 폴더에 순차 저장)

> 상태: **구현 완료 · e2e 33(18 pass) · 실기 검증 통과** (2026-09-02, 미커밋) · 구현 결과와 이탈은 §8 ·
> 근거: 코드 실측 2026-09-02 · 상위 설계: `DOCS/video-split-redock-notify-design.md` §1 (F1) ·
> 선행 설계: `DOCS/video-editor-design.md`(플레이어·내보내기 파이프라인, 구현 완료)

## 1. 요구사항

동영상 플레이어에서 **타임틱을 여러 개** 세우고, 각 틱을 경계로 영상을 **한꺼번에 분리**해 **폴더 안에
따로** 저장한다.

받아들이는 조건:
- 틱 N개 → 파일 N+1개. 원본 옆 하위 폴더에 `part-01, part-02, …` 순서로.
- 틱은 타임라인에서 보이고, 드래그로 옮기고, 지울 수 있다. 줌/팬 상태에서도 좌표가 맞는다.
- 진행률과 취소가 있다. 취소해도 이미 완성된 파일은 남는다.
- 기본은 무손실(빠름), 선택으로 정확한 지점 분할(재인코딩).
- 편집 패널을 닫거나 다른 파일로 갔다 와도 진행 중인 분할이 사라지지 않는다.

## 2. 현황(근거)

### 2.1 플레이어·타임라인 (`src/components/video/VideoPlayer.tsx`, 1069줄)

- 구간 상태 `inPt`/`outPt`(`:74-75`), 파일 전환 시 전부 리셋하는 효과(`:104-118` — `setInPt(null)`
  `:112`), `markIn`/`markOut`(`:243-252`), ExportPanel용 안정 콜백 블록(`:270-285`, `useCallback` —
  "재생 중 rAF 60fps 리렌더가 memo 패널까지 번지지 않게" 계약).
- 단축키 `switch`(`:295-352`): `i/o/r/m/f/-/=/,/./0-9/Escape/Space/k/←→`. **`t`는 비어 있다.** 입력 요소
  포커스 시 무시(`:289-290`), 수정자 조합은 전역에 양보(`:294`).
- `Timeline`(`:659-1046`): props `duration/time/playing/inPt/outPt/onSeek/onDragIn/onDragOut/onInteract`
  (`:669-679`). 줌 창 `view`(`:686`), 좌표 헬퍼 `pct`/`visible`/`fullPct`(`:713-717`), `posToTime`(`:719-728`).
  드래그 킷 `trackPointer`(`:799-824`, window 리스너 + pointerup 유실 자가복구) →
  `startDrag("seek"|"in"|"out")`(`:826-832`). 배지 스타일 `badgeCls`(`:853`), 가장자리 앵커 `shift()`
  (`:859-865`), In/Out 배지 겹침 판정 `tight`(`:867-873`, 56px 기준 — **2개 전용**).
  미니맵(`:905-946`)에 In/Out 1px 라인(`:913-920`). In 마커(`:981-1002`)·Out 마커(`:1004-1023`)는
  `{선 div(top-6 h-7 w-2, 드래그) + 배지 div(badgeCls, 드래그)}` 쌍. 플레이헤드는 그 뒤 `z-20`.
- 타임라인 사용처(`:483-496`), ExportPanel 마운트(`:594-611`, `key={path}`로 파일 전환 시 패널 상태 리셋).
- 색 토큰: `add`(초록, In)·`danger`(빨강, Out)·**`warn`(앰버 `#d6ae58`)** 은 미사용 — 틱 색으로 쓴다.

### 2.2 내보내기 패널 (`src/components/video/ExportPanel.tsx`, 456줄)

- `memo` 컴포넌트(`:48`). props에 `inPt/outPt/onClearRange/getTime`(`:68-75`). 상태: format/quality/
  maxHeight/speed/removeAudio/name/`jobId`/`progress`(`:82-90`). `range`(`:92-98`, ms 변환), `mode`
  판정(`:102-105`), 접미사 자동 이름(`:108-120`, 항상 `.mp4`), 자기 jobId 진행·종결 구독(`:126-157`).
- ffmpeg/ffprobe 미발견·프로브 실패·로딩 게이트(`:160-194`). `dir`/`nothingToDo`/`nameInvalid`
  (`:195-197`, `/[\\/]|\.\./`). `buildSpec`(`:199-213`), `doExport`(`:215-238` — `ALREADY_EXISTS` →
  `askConfirm` → `overwrite:true` 재호출), `busy = jobId != null`(`:268`).
- 마크업: 1행 옵션(`:272-359`), 2행 형식·파일명·프레임·[내보내기]/[취소](`:362-420`), 안내 문구
  (`:423-440`), 진행 바(`:441-453`).
- 로컬 `splitPath(path) → { dir, stem }`(`:31-37`). (`lib/format.ts:9`의 `splitPath`는 `{dir, base}`라
  다른 함수 — 이름만 같다.)

### 2.3 백엔드·IPC (변경 없음)

- `ExportSpec`(`src-tauri/src/commands/video.rs:402-418`): `src_rel/out_rel/overwrite/range/mode/speed/
  crop/crf/max_height/remove_audio/duration_ms/has_audio`. `validate_spec`(`:468-506`): `range.start <
  end`(`:475-479`), copy 모드는 speed/crop/crf/max_height/gif 금지(`:490-501`), 출력 확장자는
  `muxer_for_ext` 지원 목록 **mp4/m4v/mov/gif/m4a/mp3** 만.
- `video_export`(`:660-684`): AlreadyExists를 제외한 **모든** 결말에 `video://export-finished` emit
  (`:655-658` 계약). `.tmp` 기록 후 rename. 진행 `video://export-progress`(정수 % 변화 시). 취소
  `video_export_cancel`(`:854`, 멱등). **동시 실행 제한 없음** — 직렬화는 UI 몫.
- IPC 래퍼(`src/lib/ipc.ts`): `VideoExportSpec`(`:298-311`), `VideoExportProgress`(`:313-320`),
  `VideoExportFinished`(`:321-328`), `createDir`(`:995-996` → `tree.rs:97-113`, **단일 레벨**, 기존재 시
  `ALREADY_EXISTS`), `videoToolStatus`(`:1079`), `videoProbe`(`:1096`), `videoExport`(`:1100`, 6h 타임아웃,
  "재시도 절대 금지"), `videoExportCancel`(`:1103`).
- **invoke 응답 유실(Windows)**: `ipc.ts:1098-1099`·ExportPanel `:126-127` 주석 — 종결은 **이벤트가 진실**,
  프라미스는 보조. 배치 루프도 같은 규약을 따라야 한다.
- `src/lib/events.ts:93-105`: `export-finished`마다 토스트 1개 + `dir/statuses/video-probe/file-image`
  무효화. 배치 N개면 토스트 N개.
- `resolve_in_repo`(`tree.rs:1677`)는 **부모 폴더가 존재해야** 통과 → 폴더를 먼저 만든다.
- e2e: 동영상 관련 스위트 없음. 하네스는 `run({ cdp, report, fix })`, `fix.repo`(절대경로)·
  `fix.projectId`(`15-tree-fileops.mjs:13-15`, `run.mjs:116 createFixture`). `window.__gpv = { ui, terminals }`
  (`main.tsx:48-52`, DEV). 이 머신엔 `C:\ffmpeg\bin`이 PATH에 있어 앱이 자동 발견한다.

## 3. 설계

### 3.1 분할 실행 방식

| 대안 | 평가 |
|---|---|
| **A. 세그먼트당 기존 `video_export` 순차 호출** (채택) | 백엔드 0줄. 진행률·취소·tmp+rename·검증·에러 보고 전부 상속. copy는 I/O 바운드라 세그먼트당 수 초 |
| B. ffmpeg `-f segment -segment_times` 1회 | 신규 args·진행률 파싱·부분 실패 처리 전부 신규. `-c copy`면 어차피 키프레임 스냅이라 정밀도 이득 없음 |
| C. N개 동시 실행 | 동시 ffmpeg N개는 프로세스 위생 원칙(OOM 사건 이후)과 어긋난다 |

### 3.2 배치 상태의 위치 — 스토어

| 대안 | 평가 |
|---|---|
| ExportPanel 로컬 state | `editOpen` 토글·파일 전환(`key={path}`)에 언마운트 → 루프는 프라미스라 계속 돌지만 진행률·취소 버튼이 사라진다 |
| **신규 `stores/videoSplit.ts`** (채택) | 배치 1개가 앱 전역 상태. 패널은 렌더만. `events.ts`가 토스트 억제 여부를 여기서 묻는다 |

### 3.3 종결 판정 — 이벤트와 프라미스의 경주

세그먼트 하나의 끝은 `videoExport` 프라미스 **또는** `export-finished` 이벤트 중 먼저 온 쪽으로 판정한다.
`ALREADY_EXISTS`는 이벤트 없이 프라미스 거부로만 온다(백엔드 계약). 이벤트 쪽은 `ok/cancelled/error`를
그대로 결과로 쓴다. 스토어가 `waiters: Map<jobId, resolve>`를 들고, `events.ts`가 `advance(payload)`로
깨운다.

### 3.4 출력 규약

- 폴더: `<dir><stem>.split/`(이름 편집 가능, `nameInvalid` 규칙 재사용). `createDir` 1회, `ALREADY_EXISTS`
  무시(재사용).
- 파일: `<stem>.part-01.mp4`. 0패딩 폭 = `max(2, String(total).length)`. **확장자는 두 모드 모두 mp4** —
  기존 단일 내보내기가 copy도 `.mp4`로 remux 하는 것과 동일(`ExportPanel.tsx:119`), 그리고 `muxer_for_ext`가
  원본 컨테이너(webm/ogv)를 출력으로 지원하지 않는다.
- 모드: 기본 `copy`(crf null). "정확한 지점에서 분할(재인코딩)" 체크 → `encode` + `crf: 23`(기존 표준).
- 세그먼트: `planSegments(ticks, durationSec)` — 정렬 → `(0, dur)` 밖 제거 → 이웃과 100ms 미만 간격 제거
  → 경계 `[0, …, dur]`의 인접 쌍 → `{startMs, endMs}`. 첫 세그먼트는 `range: {0, t1}` 로 명시(전체가
  아니라 구간이므로 `range`를 항상 넣는다).
- 덮어쓰기: 첫 `ALREADY_EXISTS`에서 `askConfirm` 1회("기존 분할 결과를 덮어쓸까요?"). 확인 → 그 세그먼트부터
  `overwrite:true`. 취소(`onCancel`) → 배치 중단(완료분 유지).
- 취소: `videoExportCancel(currentJobId)` + `cancelled=true`. 현재 잡의 종결(cancelled 이벤트)을 기다린 뒤
  루프 종료 — 완료분 유지.
- 실패: 비-취소 오류 → 중단. 요약 토스트 error.
- 요약 토스트(스토어가 1개): 성공 "N개로 분할 저장 — <폴더>/" · 취소 "k/N개 저장 후 중단" ·
  실패 "part-0k에서 실패: <원인> · k-1개 저장됨". 종료 시 `dir/statuses/video-probe` 무효화 1회.

### 3.5 틱 UI

- 상태 `ticks: number[]`(초, **미정렬** — 드래그 중 인덱스 안정. 정렬은 `planSegments` 안에서만).
  `VideoPlayer` 로컬. 파일 전환 리셋 효과(`:104-118`)에 `setTicks([])` 추가. `clearRange`(In/Out)와는
  **무관** — 별도 `clearTicks` `useCallback`.
- 추가: 키 `t`/`T` → 현재 위치. 이미 100ms 이내 틱이 있으면 무시.
- 마커: In/Out 마커 블록(`:981-1023`) 뒤, 플레이헤드 앞에 `ticks.map`. 선 `bg-warn`(top-6 h-7 w-2, 드래그),
  배지 `border-warn text-warn`(`badgeCls` + `shift(pct(t))`, 드래그, **우클릭 = 삭제**(`onContextMenu`
  preventDefault)). 배지 텍스트 `fmtTime(t)`. 배지 **겹침 규칙(N개 일반화)**: 자기보다 시간이 작은 다른
  마커(In/Out/틱) 중 56px 이내가 있으면 배지 생략(선·드래그·우클릭은 유지, `title`에 시간) — 줌으로 풀린다.
  기존 `tight`(In/Out 쌍)는 그대로 둔다.
- 미니맵(`:913-920`) 뒤에 틱 1px 라인 `bg-warn`.
- 드래그: `startTickDrag(i)` = `trackPointer(e, x => onDragTick(i, clamp(posToTime(x), 0, duration)))`.
  `startDrag`의 문자열 유니언은 건드리지 않는다.

### 3.6 패널 UI (ExportPanel 3행 — `ticks.length ≥ 1`일 때만)

```
분할  틱 3개 → 4개 파일   폴더 [ <stem>.split      ]  ☐ 정확한 지점에서 분할(재인코딩)   [틱 지우기]  [분할 저장]
      ▓▓▓▓▓▓▓░░░░░░░░ 2/4 · part-03 · 41%                                                     [취소]
```
- `busy`(단일 내보내기)와 배치 진행 중은 **상호 배타** — 둘 다 상대를 disabled.
- 폴더명은 `key={path}` 리마운트로 파일마다 기본값 복귀(기존 이름 필드와 같은 수명).
- copy 모드 안내 문구는 기존 `:424-428`과 동일 문장 재사용.

## 4. 계약

Tauri 커맨드/이벤트/Rust 변경 **없음.**

```ts
// src/stores/videoSplit.ts (신규)
import { create } from "zustand";
import type { VideoExportFinished, VideoExportProgress, VideoExportSpec } from "../lib/ipc";

export interface SplitSegment { startMs: number; endMs: number }

/** 순수 함수 — 정렬·클램프·100ms 병합·경계쌍. 유닛/e2e에서 직접 검증. */
export function planSegments(ticksSec: number[], durationSec: number, minGapMs = 100): SplitSegment[];
/** `<stem>.part-01.mp4` — 0패딩 폭 max(2, digits(total)). */
export function partName(stem: string, index1: number, total: number): string;

export interface SplitBatch {
  projectId: string;
  srcRel: string;
  folderRel: string;          // dir + folder (레포 상대)
  total: number;
  done: number;               // 완성된 세그먼트 수
  currentIndex: number;       // 1-based, 표시용
  currentJobId: string | null;
  currentPct: number;         // 현재 잡 0-100
  jobIds: Set<string>;        // owns()용
  cancelled: boolean;
  error: string | null;
}

export interface SplitOptions {
  folder: string;             // 폴더명(검증 완료된 값)
  mode: "copy" | "encode";
  stem: string;
  durationMs: number;         // probe 값 그대로 — 백엔드가 range 길이를 분모로 쓴다(아래 확인 완료)
  hasAudio: boolean;
}

interface VideoSplitState {
  batch: SplitBatch | null;
  /** 배치 시작. 이미 진행 중이면 no-op. 완료/중단 시 batch=null + 요약 토스트 + 쿼리 무효화. */
  start(projectId: string, srcRel: string, dir: string, segments: SplitSegment[], opts: SplitOptions): Promise<void>;
  cancel(): void;
  owns(jobId: string): boolean;
  /** events.ts 전용 — 종결 이벤트를 현재 세그먼트 결과로 반영(대기 중인 start 루프를 깨운다). */
  advance(ev: VideoExportFinished): void;
  /** 스토어가 배치 중에만 구독하는 진행 이벤트 처리. */
  progress(ev: VideoExportProgress): void;
}
export const useVideoSplit = create<VideoSplitState>(…);
```

**진행률 분모(확인 완료)**: 백엔드 `expected_out_us`(`video.rs:601-608`)가 `range`가 있으면
`end_ms - start_ms`를, 없을 때만 `spec.duration_ms`를 분모로 쓴다. 세그먼트마다 `range`를 넣으므로
`durationMs`는 **probe 값을 그대로** 넘기면 되고, 각 세그먼트의 %는 100까지 간다. 별도 보정 없음.

```ts
// start() 루프 골격
await ipc.createDir(projectId, folderRel).catch((e) => { if (!(isIpcError(e) && e.code === "ALREADY_EXISTS")) throw e; });
const unProg = await listen<VideoExportProgress>("video://export-progress", (e) => get().progress(e.payload));
let overwrite = false;
try {
  for (let i = 0; i < segments.length; i++) {
    if (get().batch?.cancelled) break;
    const jobId = crypto.randomUUID();
    set(b => ({ ...b, currentIndex: i + 1, currentJobId: jobId, currentPct: 0, jobIds: new Set(b.jobIds).add(jobId) }));
    const spec: VideoExportSpec = { srcRel, outRel: `${folderRel}/${partName(stem, i + 1, segments.length)}`, overwrite,
      range: segments[i], mode, speed: null, crop: null, crf: mode === "encode" ? 23 : null, maxHeight: null,
      removeAudio: false, durationMs, hasAudio };
    const outcome = await runOne(projectId, jobId, spec);   // §3.3 경주: {kind:"ok"|"cancelled"|"exists"|"error", error?}
    if (outcome.kind === "exists") {
      if (overwrite) { fail("덮어쓰기 실패"); break; }
      const ok = await confirmOverwrite();                  // askConfirm을 Promise<boolean>로 (onConfirm/onCancel)
      if (!ok) { set(cancelled); break; }
      overwrite = true; i--; continue;
    }
    if (outcome.kind === "cancelled") break;
    if (outcome.kind === "error") { fail(outcome.error); break; }
    set(b => ({ ...b, done: b.done + 1 }));
  }
} finally { unProg(); summarize(); invalidate(); set({ batch: null }); }
```

```ts
// src/lib/events.ts — 종결 리스너(:93) 첫 줄
if (useVideoSplit.getState().owns(e.payload.jobId)) { useVideoSplit.getState().advance(e.payload); return; }
```

```ts
// VideoPlayer.tsx — 추가 props/콜백
const [ticks, setTicks] = useState<number[]>([]);
const addTick = () => { const t = videoRef.current?.currentTime ?? time; setTicks(p => p.some(x => Math.abs(x - t) < 0.1) ? p : [...p, t]); };
const clearTicks = useCallback(() => setTicks([]), []);
// Timeline props 추가
ticks: number[]; onDragTick: (i: number, t: number) => void; onRemoveTick: (i: number) => void;
// ExportPanel props 추가
ticks: number[]; onClearTicks: () => void; probe(durationMs, hasAudio)는 이미 있음
```

```ts
// src/main.tsx — DEV 노출에 추가(e2e 33용)
__gpv = { ui, terminals, videoSplit: useVideoSplit, planSegments };
```

## 5. 단계(구현 순서)

1. **`stores/videoSplit.ts`**: `planSegments`·`partName`(순수) → 스토어·루프·경주·요약 토스트. `progress`
   분모 확인(§4 주의).
2. **`events.ts`**: 첫 줄 위임.
3. **`VideoPlayer.tsx`**: `ticks` 상태·리셋·`T` 키·`clearTicks`; `Timeline`에 마커·미니맵·드래그·우클릭·겹침 규칙.
4. **`ExportPanel.tsx`**: 3행 분할 섹션 + 상호 배타 busy + 진행/취소.
5. **`main.tsx`** DEV 노출 + **e2e 33**(§7).
6. **실기 검증**(§7).

규모: **M** — 신규 스토어 ~180 LOC, VideoPlayer ~90 LOC, ExportPanel ~80 LOC, e2e ~80 LOC.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| 키프레임 스냅 | copy 모드는 각 세그먼트 시작이 직전 키프레임으로 당겨져 인접 세그먼트가 겹칠 수 있다 | 기존 클립 내보내기와 동일 한계·동일 안내 문구. 정확성은 encode 체크 |
| 원본 컨테이너 | webm/ogv(vp9·opus·theora·vorbis)를 mp4로 copy remux 하면 muxer가 거부할 수 있다 | 기존 단일 내보내기와 같은 한계(video-editor-design P5 후속). 실패 시 요약 토스트에 원인 그대로 + "재인코딩으로 다시 시도" 안내 |
| invoke 응답 유실 | Windows에서 `videoExport` 프라미스가 안 돌아오면 루프가 멈춘다 | §3.3 경주 — 이벤트가 진실. 두 신호 모두 없으면 6h 타임아웃(기존) |
| 토스트 누락 | `owns()`가 true인데 배치가 이미 정리돼 `advance`가 대기자를 못 찾음 | `jobIds`는 배치 종료 후에도 짧게 보존하지 않는다 — 대신 `advance`는 대기자가 없으면 무시하고, 종결은 프라미스 쪽이 이미 처리한 경우다(경주 특성상 정상) |
| memo 패널 리렌더 | `ticks` 배열은 틱이 바뀔 때만 새 참조, `onClearTicks`는 useCallback | 재생 중 60fps 리렌더가 패널로 번지지 않음(기존 계약 유지). `Timeline`은 원래 매 프레임 그린다 |
| 배지 난립 | 틱 10개가 붙어 있으면 배지가 겹친다 | §3.5 겹침 규칙(왼쪽 이웃 56px 이내면 배지 생략) + 줌 |
| `T` 키 충돌 | 전역 단축키는 수정자 조합만, 플레이어 `switch`에 `t` 없음 | 없음. 입력 요소 포커스 시 무시(기존 가드) |
| 편집 패널 닫힘 | 진행 중 `editOpen=false` | 스토어라 계속 돈다. 패널을 다시 열면 진행 표시 복귀(§7-4) |
| 동시 배치 | 다른 파일에서 또 [분할 저장] | `start`가 `batch != null`이면 no-op + 버튼 disabled("다른 분할이 진행 중") |

## 7. 검증

### 7.1 e2e `tests/e2e/suites/33-video-split.mjs` (신규)

```
1. tool = invoke("video_tool_status") — found && probeFound 아니면 r.skip.
2. fixture 레포에 테스트 영상 생성(6초, 키프레임 1초 간격):
   execFileSync("ffmpeg", ["-y","-f","lavfi","-i","testsrc=duration=6:size=320x240:rate=30",
     "-f","lavfi","-i","sine=frequency=440:duration=6","-g","30","-pix_fmt","yuv420p","-shortest", join(fix.repo,"e2e-split.mp4")])
3. segs = cdp.eval(`window.__gpv.planSegments([2, 4, 4.05], 6)`) → length 3(4.05는 병합), [0,2000],[2000,4000],[4000,6000].
4. cdp.eval(`window.__gpv.videoSplit.getState().start("${fix.projectId}", "e2e-split.mp4", "", segs,
     { folder: "e2e-split.split", mode: "copy", stem: "e2e-split", durationMs: 6000, hasAudio: true })`)
5. batch == null 될 때까지 폴링(최대 60s). 폴더에 part-01~03.mp4 존재.
6. ffprobe -v error -show_entries format=duration -of csv=p=0 각 파일 → 합 ∈ [5.5, 7.0](copy 키프레임 오차 허용).
7. 재실행(덮어쓰기): start 다시 → ConfirmHost가 떠 있는지 `document.body.textContent.includes('덮어쓸까요')`
   → __gpv.ui.getState().confirm.onConfirm() → 완료 → 파일 mtime 갱신.
8. 취소: 세그먼트 6개짜리(틱 5개) encode 모드로 start → 첫 progress 후 cancel() → batch null, 파일 수 < 6,
   `term`이 아니라 ffmpeg 프로세스가 남지 않았는지(tasklist | findstr ffmpeg == 0).
9. 정리: 생성 파일·폴더 삭제(fixture는 스위트마다 새로 만들지 않으면).
```

### 7.2 실기(디버그 앱)

1. 실제 영상(1분 이상, h264 mp4) 열기 → 재생 중 `T` 3회 → 앰버 마커 3개 + 배지. 휠 줌 → 팬 → 마커
   위치가 눈금과 일치. 배지 드래그 → 시간 변경. 배지 우클릭 → 삭제. 미니맵에 앰버 라인.
2. 편집 패널 → "분할 · 틱 2개 → 3개 파일" → [분할 저장] → 진행 바가 `1/3 → 2/3 → 3/3` 단조 증가,
   `%`가 각 세그먼트에서 100까지 간다(분모 확인). 완료 토스트 1개. 파일 트리에 `<stem>.split/` 폴더와
   part 3개가 보이고 git 상태에 untracked로 잡힌다.
3. `ffprobe`로 세 파일 길이 합 ≈ 원본. encode 체크 후 재실행(덮어쓰기 확인 1회) → 경계가 틱 시각과
   ±1프레임.
4. 진행 중 편집 패널 닫기 → 다른 파일 클릭 → 되돌아와 패널 열기 → 진행 표시가 이어져 있고 [취소]가 산다.
5. 취소 → "k/N개 저장 후 중단" 토스트, 완료분 유지, `.tmp` 없음, 작업관리자에 ffmpeg 없음.
6. 단일 [내보내기]와 [분할 저장]이 서로 disabled 되는지.
7. 다크·라이트 테마에서 앰버 배지 대비(`warn` 토큰은 테마별 값 존재 — `styles.css:21`, `:56`).

## 8. 구현 결과(2026-09-02)

§5 단계 1~6 전부 구현. `npx tsc --noEmit` exit 0. Rust·IPC 변경 0, 신규 의존성 0.

### 8.1 설계 대비 이탈(4건)

| # | 이탈 | 이유 |
|---|---|---|
| 1 | `setSplitQueryClient(qc)` 모듈 함수 추가 — `events.ts`의 `attachRepoEvents` 초입에서 1회 주입 | 이 저장소엔 전역 QueryClient 싱글턴이 없다(`main.tsx`가 지역 생성). 스토어는 React 밖이라 훅으로 얻을 수 없다. `VideoSplitState` 인터페이스는 §4 계약 그대로 |
| 2 | 분할 행 노출 조건 `ticks.length > 0 \|\| 진행 중` | §3.6의 "틱 ≥1일 때만"으로는 §7.2-4(파일 전환 후 복귀 시 진행·취소 유지)가 불가능 — 파일 전환이 `VideoPlayer`를 리마운트해 틱이 비기 때문. 실측: 복귀 후 틱 0개인데 `1/3 · part-02 · 0%`와 [취소]가 살아 있음 |
| 3 | copy 안내 문구를 복제하지 않고 기존 조건에 `\|\| (showSplit && !splitEncode)`를 더함 | 같은 문장이 두 번 보이는 것 방지 |
| 4 | "틱 N개 → N+1개 파일" 대신 `planSegments` 결과 개수 표기 | 100ms 병합·범위 밖 제거로 걸러지면 N+1이 거짓이 된다 |
| 5 | `tests/e2e/run.mjs`의 `SUITES`에 33 등록(+1줄) | 파일 목록 밖이지만 러너 안에서 33을 돌리는 데 필수 |

### 8.2 e2e 33 — 18 pass / 0 fail(단독·전체 러너 동일)

테스트 영상 생성 / `planSegments` 병합·경계·범위 밖 제거 / batch 생성·정리 / part-01~03 생성 / **요약 토스트 1개만** /
길이 합 6.30s∈[5.5,7.0] / 덮어쓰기 확인 1회 → mtime 3개 갱신 / 두 번째 `start` no-op / 덮어쓰기 거부 시 완료분 유지 /
취소 → 1/6개 저장·`.tmp` 0·"1/6개 저장 후 중단"·ffmpeg 잔존 0.

### 8.3 실기 관측값(60초 1280×720 h264+aac, 키프레임 2초)

| 항목 | 관측값 |
|---|---|
| `T` 3회 | 선 3 + 배지 3, `0:12.0 / 0:25.0 / 0:41.0` |
| 줌·팬 좌표 | 전체보기·×1.3 줌·팬 후 모두 12/25/41(오차 0.00s), 미니맵 앰버 라인 3 |
| 배지 드래그 / 우클릭 | `0:12.0 → 0:30.0`, 배열 순서 `[30, 25, 41]` 유지 / 우클릭으로 삭제 |
| 겹침 규칙 | 30s 틱이 25s 틱과 54px → 배지 생략, 25s 삭제 시 복귀 |
| 진행 | `1/0 → 1/1@100 → 2/1 → 2/2@100 → 3/2 → 3/3@100` 단조. 백엔드 잡별 max % = 100/100/100(분모 보정 없음 확인) |
| copy 길이 | 25.01 / 17.02 / 20.02 = 62.04s(원본 60s, 키프레임 스냅) · 완료 토스트 1개 · git `?? clip.split/` |
| encode 재실행 | 덮어쓰기 확인 1회 → 25.000 / 16.000 / 19.000(틱과 0프레임 오차) |
| 패널 닫기 → 다른 파일 → 복귀 | 배치 생존, 진행 표시·[취소] 유지 |
| 취소 | "2/6개 저장 후 중단", part-01·02만, `.tmp` 0, **ffmpeg 프로세스 0**(배치 중엔 항상 1개 — 동시 실행 없음) |
| 상호 배타 | 분할 중 [내보내기] disabled / 단일 내보내기 중 [분할 저장] disabled, 종료 후 복구 |
| 테마 대비 | darcula 6.61:1, light 4.65:1(둘 다 AA) |

### 8.4 알려진 한계·후속

- 마지막 세그먼트의 `export-finished` 이벤트가 프라미스보다 **늦게** 도착하고 그 사이 배치가 정리되면
  `owns()`가 false라 일반 경로가 "내보내기 완료" 토스트를 하나 더 띄울 수 있다(이론상 경주 — 실측
  수십 회에서 미발생. Rust는 이벤트를 응답보다 먼저 emit한다). → 봉합됨(recentlyOwned 10초 기억).
- webm/ogv 원본의 copy 모드는 mp4 muxer 거부 가능(기존 단일 내보내기와 동일 한계).
