# 태스크 35 — 영상 파일 별도 창 열기(편집 포함) · 뷰어 파일 탭 우클릭 메뉴

상태: **구현 완료 · 검증 통과(미커밋)** (2026-09-03) · 선행: 태스크 30(이미지 별도 창) · 22(타임틱 분할)

## 1. 요구
- 파일트리에서 mp4·avi 등 **영상 파일 더블클릭 → 별도(`doc-*`) 창**에서 열린다. 편집(구간·타임틱 분할·
  내보내기)이 메인 뷰어와 **그대로** 된다 — 이미지(태스크 30)와 같은 경로.
- 뷰어 파일 탭(ViewerFileTabs) **우클릭 메뉴**: 닫기 · 다른 탭 닫기 · 새 창으로 열기.

## 2. 설계(최소 diff)
### 2.1 더블클릭 라우팅
- `FileTreePanel.tsx` 더블클릭 분기 `isImage(name)` → `isImage(name) || isVideo(name)`(오디오 제외).
  크기는 이미지와 같은 `[1180, 860]`.
- DocWindow는 이미 `DiffViewer → MediaView → VideoPlayer(+ExportPanel)`를 그린다. 추가 코드 없음.

### 2.2 doc 창의 내보내기 완료 처리
- `events.ts`의 `video://export-finished` 블록(+ `setSplitQueryClient`)을 `attachVideoEvents(qc)`로 뽑아
  `attachRepoEvents`(main)와 `DocWindow`(기존 repo://changed 리스너 옆) 양쪽에서 부른다.
- 이벤트는 **모든 창에 브로드캐스트**된다(Rust `emit`; `emit_to("main")`이면 `emit`으로). 그래서
  - 무효화(dir/statuses/video-probe/file-image)는 **모든 창**이 한다(멱등).
  - 토스트·분할 배치 `advance`는 **잡을 시작한 창만**: `videoSplit.owns(jobId)`(기존) + 단일 내보내기는
    `ExportPanel`이 invoke 직전 `markLocalVideoJob(id)`(events.ts의 모듈 Set)로 표시, 핸들러가 `delete`로 소비.
    다른 창은 무효화만 하고 조용히 끝낸다(창마다 토스트 호스트가 따로라 안 그러면 두 번 뜬다).

### 2.3 컨테이너 확장
- `language-map.ts` `VIDEO_EXT`에 `avi mkv wmv flv` 추가(`ts`는 TypeScript와 충돌 — 절대 추가 금지).
- `preview.rs` MIME: avi→`video/x-msvideo`, mkv→`video/x-matroska`, wmv→`video/x-ms-wmv`, flv→`video/x-flv`.
- WebView2가 못 푸는 컨테이너(avi 등)는 기존 `playError` 폴백("외부 앱으로 열기") 옆에
  **"mp4로 변환해 열기(ffmpeg)"** 버튼: `ipc.videoExport(projectId, id, { srcRel: path, outRel: <같은 폴더>/<stem>.mp4,
  mode: "encode", format mp4, 전체 구간 })`. 진행 중은 버튼 비활성+"변환 중…", 완료(ok)는 `openDocWindow(projectId, outRel,
  { size: [1180, 860] })`로 새 창에 mp4를 연다. 스펙 필드는 `VideoExportSpec`·ExportPanel `buildSpec`을 그대로 따른다
  (출력 파일이 이미 있으면 ExportPanel의 overwrite 규칙과 같은 처리 — 존재 시 ` (변환).mp4`로 회피해도 됨).

### 2.4 뷰어 탭 우클릭 메뉴
- `ViewerFileTabs.tsx` 로컬 상태 `menu: { x, y, tab } | null`. 탭 `onContextMenu`(preventDefault)로 연다.
- 메인 창은 네이티브 자식 webview가 있으므로 고정 오버레이는 **`useOccludesWebview(!!menu)`** 등록(FileTreePanel 메뉴와 동일 계약).
- `fixed inset-0 z-50` 백드롭(클릭·우클릭·Escape로 닫힘) + 메뉴 패널. 항목:
  - **닫기** → `closeViewerTab(tab.key)`
  - **다른 탭 닫기** → 같은 프로젝트의 나머지 탭 `closeViewerTab` 반복(스토어 추가 없음)
  - **새 창으로 열기** → `openDocWindow(projectId, tab.target.path)`(doc 창은 파일 보기 — diff 모드 탭도 파일로 연다)
- 공용 메뉴 컴포넌트가 `components/common`에 있으면 그것을 쓰고, 없으면 FileTreePanel의 MenuItem 스타일을 따른 인라인 15줄.

## 3. 검증
- `npx tsc --noEmit -p .` · Rust `cargo check`(preview.rs) — 저장 전 옆 세션(gitpervisor-8a)에 알림.
- e2e 34(`34-image-doc-window.mjs`)에 블록 추가: (a) 영상 더블클릭(또는 `__gpv.openDocWindow`) → `doc-*` 창에
  `<video>`·내보내기 패널 존재, `connectLabel`로 확인; (b) 탭 우클릭 → 메뉴 3항목, "새 창으로 열기" → 창 라벨 증가,
  "닫기" → 탭 감소. 영상 픽스처는 e2e 33(타임틱 분할)이 쓰는 것을 재사용.
- 실기: dev 앱에서 mp4 더블클릭 → 새 창 재생·구간 내보내기 완료 토스트가 **그 창에만** 뜨는지.

## 4. 구현 결과 (2026-09-03)

### 파일별 변경
| 파일 | 변경 |
|---|---|
| `src/components/tree/FileTreePanel.tsx` | 더블클릭 분기 `isImage(name) \|\| isVideo(name)`(import 1줄). 크기 `[1180, 860]` 그대로 |
| `src/lib/events.ts` | `video://export-finished` 블록 + `setSplitQueryClient`를 `attachVideoEvents(qc)`로 분리, `attachRepoEvents`가 첫 줄에서 호출. 모듈 Set `localVideoJobs` + `markLocalVideoJob(id)` export. 핸들러 순서 = `owns` → advance / `delete`가 false면 무효화만 하고 return(토스트 없음) / 그 외 기존대로. 무효화 4줄은 `invalidateVideoOutputs(qc)`로 묶음 |
| `src/DocWindow.tsx` | 기존 `repo://changed` effect 옆에 `attachVideoEvents(queryClient)` 1회 호출(`useRef` 가드 — StrictMode 이중 마운트에 리스너가 겹치지 않게) |
| `src/components/video/ExportPanel.tsx` | `doExport`의 `ipc.videoExport` 직전 `markLocalVideoJob(id)` |
| `src/components/video/VideoPlayer.tsx` | `playError` 폴백에 "mp4로 변환해 열기" 버튼(ffmpeg 있을 때만). `ipc.videoProbe`(실패 시 durationMs 0·hasAudio true) → `mode:"encode"` 전체 구간 export → 완료 시 `openDocWindow(projectId, outRel, {size:[1180,860]})`. 종결은 `video://export-finished` 자기 jobId 구독 + invoke 완주(ref 가드로 1회만). `overwrite:false`가 `ALREADY_EXISTS`면 `<stem> (변환).mp4`로 1회 회피 |
| `src/components/workspace/ViewerFileTabs.tsx` | 탭 `onContextMenu` → 로컬 `menu` state + `useOccludesWebview(!!menu)` + `fixed inset-0 z-50` 백드롭(클릭·우클릭·Escape로 닫힘). 항목 3개(닫기 / 다른 탭 닫기 / 새 창으로 열기), 스타일은 FileTreePanel `MenuItem` 클래스 인라인 복제 |
| `src/lib/language-map.ts` | `VIDEO_EXT`에 `avi mkv wmv flv`(`ts`는 제외) |
| `src-tauri/src/commands/preview.rs` | MIME 4줄(avi/mkv/wmv/flv) |
| `tests/e2e/suites/34-image-doc-window.mjs` | 영상 doc 창 블록 + 탭 우클릭 메뉴 블록(이미지 블록보다 **앞**에서 실행 — 저쪽은 중간 실패 시 `run()`을 return 한다) |

**Rust `emit_to` → `emit` 변경은 없었다.** `video.rs`의 `video://export-finished`(672행)·`video://export-progress`(775행)는 이미 `app.emit`(전 창 브로드캐스트)이라 설계 §2.2의 전제가 그대로 성립한다.

### 검증
- `npx tsc --noEmit -p .` — 오류 0.
- dev 워처 Rust 재빌드 `Finished dev profile ... in 1m 40s`(preview.rs 1회), 앱 재시작 후 CDP 29222 정상.
- e2e(격리 실행): **34 = 27 pass / 0 fail**(기존 15 + 신규 12), **33 = 18 pass / 0 fail**, **14 = 60 pass / 0 fail / 1 skip**(`#2b` 간헐 실패 없음).

### 실기 관측(CDP)
- 영상 doc 창: `readyState=4`, ExportPanel 렌더, 오디오 제거 내보내기 실행 →
  doc 창 토스트 `success:내보내기 완료 — e2e-doc.mute.mp4` / **메인 창 토스트 `""`** (격리 성립).
- avi(mpeg4) 폴백 실기: 본문 `이 형식은 재생할 수 없습니다`, 버튼 `["외부 앱으로 열기","mp4로 변환해 열기"]` →
  클릭 시 `변환 중…(disabled)` → 새 `doc-*` 창 생성 + `e2e-conv.mp4` 디스크 생성 + 그 창 `readyState=4`,
  토스트는 avi 창에만(`메인 창 토스트: ` 빈 문자열).
- 탭 우클릭 메뉴: `items=["닫기","다른 탭 닫기","새 창으로 열기"]`, 새 창으로 열기 → `doc-*` 생성,
  다른 탭 닫기 → 1개, 닫기 → 0개.

### 남은 것
- `markLocalVideoJob`으로 표시한 id는 `ALREADY_EXISTS`(덮어쓰기 확인 대화형 경로)에서만 종결 이벤트가 없어
  Set에 남는다. 사용자 클릭 수에 비례하는 UUID 문자열 몇 개라 실사용 누수는 아니다.
