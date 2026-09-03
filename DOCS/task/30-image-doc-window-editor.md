# 태스크 30 — 이미지 더블클릭 → 별도 창에서 보기·편집

> 상태: **구현 완료 · 검증 통과(2026-09-03, 미커밋)** — 결과는 §8·§9 · 대상: gitpervisor ·
> 근거: 코드 실측 2026-09-03 · 선행: `DOCS/image-annotation-design.md`(편집기), v0.4.2 "파일 새 창"(`doc-*` 창)

## 1. 요구사항

png·webp·bmp 등 **이미지 파일을 더블클릭하면 별도 OS 창**으로 열려 보이고, 그 창 안에서 **지금의 편집 기능이 그대로**
동작해야 한다("지금 기능 그대로 float로 실행").

받아들이는 조건:
- 파일트리에서 이미지 더블클릭 → 새 창(기존 "새 창으로 열기"와 같은 `doc-*` 창)에 이미지 뷰어.
- 그 창의 [편집] → 이미지 편집기가 **그 창 안에서** 열리고 저장·다른 이름으로·복사·취소·Esc 계층이 메인과 동일.
- 별도 창에서 저장하면 메인 창의 파일트리·git 상태·**이미 열려 있던 같은 이미지**가 갱신된다.
- 메인 창을 닫으면 이미지 창도 함께 닫힌다(플로팅 터미널과 같은 수명).

## 2. 현황(근거)

- **뷰어는 이미 별도 창에서 된다.** `src/DocWindow.tsx`(139줄)가 `.md`는 `MarkdownDoc`, 그 외 전부 `<DiffViewer target={{mode:"file",path}}>`
  (`:62-68`)로 넘기고, `DiffViewer.tsx:637-642`가 `isImage(path)`면 `<ImageView projectId path/>`로 분기한다. 즉 `open_doc_window`로
  이미지를 열면 줌·팬·맞춤(`ImageView.tsx:113-177`)까지 그대로 보인다.
- **편집기는 메인 창에만 마운트돼 있다.** `App.tsx:44` lazy `ImageEditor`, `:203-207`에서 `imageEditorPath`가 있을 때만 렌더.
  `DocWindow.tsx`에는 `ImageEditor`·`Toasts`·`ConfirmHost`·`PromptHost` **어느 것도 없다**(파일 전체 확인). `useUi`는 창마다
  별개 인스턴스(`DocWindow.tsx:33-35` 주석, `ui.ts:473`)라, 별도 창의 [편집](`ImageView.tsx:228-234` → `openImageEditor(path, projectId)`)
  은 그 창의 스토어에 `imageEditorPath`만 세팅하고 **아무 것도 그리지 않는다**.
- 편집기 의존 호스트: `pushToast`(→`<Toasts/>`), `askConfirm`(→`<ConfirmHost/>`, `requestClose` `ImageEditor.tsx:668-681`·덮어쓰기),
  `askPrompt`(→`<PromptHost/>`, 다른 이름으로 `:636-651`), `useSaveImage`(→QueryClientProvider, doc 창엔 있음 `main.tsx:93`),
  `projectId = imageEditorRepoId ?? selectedProjectId`(`:143-148` — ImageView가 `projectId`를 넘기므로 doc 창에서도 정답).
  Esc·단축키는 `window` 리스너(`:719`)라 창 안에서만 동작. 모달 크기 `min(820px,94vh)×min(1180px,96vw)`(`:748`), 우측 패널 `w-72`.
- **더블클릭**: `FileTreePanel.tsx:600-611` `onDouble`은 `isRunnable(name)`(exe/bat/cmd/com/msi/dmg)일 때만 `runExecutable`,
  그 외 no-op. "새 창으로 열기"는 우클릭 메뉴(`:1234-1243`)에서만 `openDocWindow(projectId, path)`.
- **doc 창 열기**: `floating.ts:61-82` `openDocWindow` — `gp:doc-windows`에 `{id:{projectId,path}}` 기록(상한 20, 정리 없음) →
  `open_doc_window(docId, title, origin)`(`lib.rs:376-425`, 라벨 `doc-<id>` 검증, 900×760, 최소 420×300, 중복 라벨은 focus).
  `main.tsx:77-116` doc 분기: 전용 QueryClient + diff 프리페치 + `<DocWindow docId>`; **`attachRepoEvents`는 메인 분기에서만**
  (`:168`) — doc 창은 `repo://changed`를 듣지 않는다. capability `default.json:8-12`에 `doc-*` 있음.
- **수명**: `lib.rs:519` `AUX_WINDOW_LABELS = ["sysmon","aggregate"]`, `is_aux`(`:527`)는 `float-` 접두사 + AUX만 → doc 창은 메인이
  닫혀도 남는다(플로팅 터미널과 다르다).
- **저장 후 갱신**: `useSaveImage.onSuccess`(`queries/index.ts:965-970`)가 `dir/statuses/diff/file-image`를 무효화하지만 **그 창의
  QueryClient에만**. 메인은 Rust 워처의 `repo://changed`(`watcher.rs:82-86` 전 창 브로드캐스트)를 `events.ts:63-78`에서 받아
  `statuses/diff/log/branches/repo-files/dir`을 무효화하는데 **`file-image`는 목록에 없다** → 메인에 열려 있던 같은 이미지는
  옛 그림(staleTime Infinity)이 남는다.
- e2e: `30-image-annotate.mjs`는 `__gpv.ui.getState().openImageEditor(path, repoId)`로 편집기를 연다. doc 창 스위트는 없고,
  `cdp.mjs`의 `locate`는 타이틀 `/gitpervisor/i` + 라벨 `main`만 고른다 — doc 창은 타이틀이 파일명이라 아예 후보에 없다.

## 3. 설계

### 3.1 더블클릭 = 이미지에 한해 "새 창으로 열기"

| 대안 | 평가 |
|---|---|
| **A. `onDouble`에서 `isImage(name)`이면 `openDocWindow(projectId, path)`** (채택) | 우클릭 메뉴와 같은 함수. exe 실행 분기는 그대로 앞에 둔다 |
| B. 모든 파일 더블클릭을 새 창으로 | 요구는 이미지. 텍스트 파일은 뷰어 탭이 주 동선이라 습관을 바꾼다 |
| C. 단일 클릭을 새 창으로 | 탭 선택과 충돌 |

svg 포함(뷰어는 svg를 보여준다; 편집기의 svg 래스터화 경고 `roundTripWarning`은 기존대로 편집기 헤더가 표시).

### 3.2 doc 창에 편집기와 호스트를 마운트

`DocWindow.tsx`에 메인과 같은 조합을 넣는다: `Toasts`, `ConfirmHost`, `PromptHost`, `imageEditorPath && <Suspense><ImageEditor/></Suspense>`
(lazy — 편집기 청크는 메인과 동일 파일이므로 doc 창 번들에 인라인되지 않는다). 그러면 `ImageView`의 [편집] → 그 창의 `useUi` →
그 창의 `ImageEditor`가 뜬다. `selectBlockingOverlay`는 doc 창에 네이티브 자식 웹뷰가 없어 무관.

편집기 모달이 창(900×760)에 들어가나: 모달은 뷰포트 비례(`96vw×94vh`)라 들어간다. 다만 우측 패널 `w-72` 고정이라 stage가 좁다 →
**이미지로 여는 doc 창은 1180×860으로 연다**: `open_doc_window`에 선택 인자 `size?: [w,h]`(Rust, 기본 900×760 유지) — Rust 저장은
조율상 뒤로(§5). 그 전까지는 900×760에서도 동작한다(검증에서 두 크기 다 본다).

### 3.3 저장 후 갱신 — 워처 신호에 `file-image` 추가 + doc 창도 워처 구독

- 메인 `events.ts:63-78`의 `repo://changed` 무효화 목록에 `["file-image", projectId]`(프로젝트 한정)를 추가. 비용: 그 프로젝트의
  이미지 쿼리가 "stale" 표시만 되고 실제 재요청은 화면에 보이는 것만 — 워처는 이미 250ms 코얼레싱.
- doc 창: `DocWindow`에 `listen("repo://changed")` 1개 — 자기 `projectId`면 `["file-image", pid]`·`["diff", pid]` 무효화. 메인에서
  편집한 이미지가 열려 있는 별도 창에도 반영되게(양방향).
- `useSaveImage`의 자기 창 무효화는 그대로.

### 3.4 수명 — doc 창도 메인과 함께 닫힌다(Rust 1줄)

`lib.rs:527 is_aux`에 `label.starts_with(DOC_LABEL_PREFIX)` 추가. 플로팅 터미널·모아보기·sysmon과 같은 규칙("메인이 곧 앱").
Destroyed 훅엔 doc 분기가 필요 없다(PTY 없음). 테스트 `secondary_window_labels`(`lib.rs:1087`)에 `doc-x` 단언 추가.

### 3.5 만들지 않는 것

- 뷰어 탭·변경 목록에서의 더블클릭 → 새 창(요구는 파일트리·이미지).
- `gp:doc-windows` 항목 정리(상한 20으로 충분, 창 닫힘 감지 경로가 없다).
- 여러 이미지를 한 창에서 넘겨 보기.

## 4. 계약

```ts
// src/components/tree/FileTreePanel.tsx onDouble(:600-611)
if (isRunnable(name)) { …기존… ; return; }
if (isImage(name)) { openDocWindow(projectId, path); return; }

// src/DocWindow.tsx — 호스트 4개 + 워처 구독
const ImageEditor = lazy(() => import("./components/image/ImageEditor"));
… <Toasts/> <ConfirmHost/> <PromptHost/> {imageEditorPath && <Suspense fallback={null}><ImageEditor/></Suspense>}
useEffect(() => listen<{projectId:string}>("repo://changed", e => { if (e.payload.projectId === target?.projectId) { qc.invalidateQueries({queryKey:["file-image", pid]}); qc.invalidateQueries({queryKey:["diff", pid]}); } }), [pid]);

// src/lib/floating.ts
export function openDocWindow(projectId: string, path: string, opts?: { size?: [number, number] }): void;  // 이미지면 [1180, 860]
// src-tauri/src/lib.rs
async fn open_doc_window(app, doc_id: String, title: String, origin: String, size: Option<(f64, f64)>)  // 기본 (900, 760)
fn is_aux(label) — `doc-` 포함
```

e2e 보조: `tests/e2e/lib/cdp.mjs`에 `connectLabel(label: string)` 추가 — `/json` 페이지를 순회하며 라벨이 일치하는 페이지에 붙인다
(기존 `connect()`의 라벨 평가 로직 재사용, 타이틀 필터 없음). doc·sysmon 창 e2e의 공용 진입점.

## 5. 단계

1. **프론트**(지금): `FileTreePanel` 더블클릭, `DocWindow` 호스트·편집기·워처 구독, `events.ts` `file-image` 무효화, `floating.ts`
   `size` 인자(Rust가 받기 전엔 무시됨 — 인자 추가는 Tauri가 알 수 없는 키를 무시하므로 안전).
2. **Rust**(조율 신호 후, 31·33과 한 번의 재빌드): `open_doc_window` `size`, `is_aux` doc 포함 + 테스트.
3. e2e: `cdp.mjs connectLabel` + 신규 `34-image-doc-window.mjs`: 메인에서 `openDocWindow(fix.projectId, "e2e.png")` 호출(픽스처 png는
   30 스위트의 `solidPng` 헬퍼 재사용) → `getAllWebviewWindows`에 `doc-*` 등장 → `connectLabel(doc-…)`로 붙어 `.xterm` 아닌
   `<img>` 존재, `__gpv.ui.getState().openImageEditor(path, pid)` → `imageEditorPath` non-null + 모달 DOM(`role`/헤더 텍스트) 존재 →
   `__gpv.imageEditor.setDoc`로 사각형 1개 → `saveAs("e2e-doc.png")` → 파일 존재 + 메인 창 `["file-image"]` 쿼리 `isStale`/재요청 확인
   → doc 창 `close()`. 메인 종료 연동은 e2e에서 못 본다(메인을 닫을 수 없음) — `cargo test`의 라벨 테스트로.
4. 실기: 더블클릭 → 창 → 편집 → 저장 → 메인 뷰어에 반영, Esc 계층, 900×760·1180×860 두 크기.

규모: **S~M** — 프론트 ~90 LOC, Rust ~15 LOC, e2e ~120 LOC.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| 편집기 청크 중복 | doc 창에서 lazy import가 메인 청크로 인라인 | `DocWindow.tsx:11-19` 주석의 규칙대로 lazy 유지 — 빌드 후 `index-*.js` 크기 확인 |
| 창 크기에서 편집기 좁음 | 900×760에서 stage 축소 | Rust `size` 인자로 이미지는 1180×860, 그 전까지도 동작(모달이 뷰포트 비례) |
| 저장 경합 | 메인·doc 창이 같은 파일을 동시에 저장 | 기존과 동일(마지막 저장이 이긴다). 워처 무효화로 양쪽이 곧 같은 그림을 본다 |
| 워처 부재 프로젝트 | 워처가 없는 저장소는 `repo://changed`가 안 온다 | 기존 한계와 동일. `useSaveImage` 자기 창 무효화는 유지 |
| e2e 창 접속 | `connect()`는 main 전용 | `connectLabel` 신설 |

## 7. 검증

- e2e 34 통과, `cargo test` 라벨 테스트 통과, 실기 §5-4.

## 8. 구현 결과(2026-09-03)

검증 환경: dev 빌드(`tauri.dev.conf.json`, CDP 29222, 앱 exe 06:05 빌드) + vite 39090, Windows 11, 화면 배율 1.5.

### 8.1 e2e 34 격리 실행 — **15 pass / 0 fail** (4.0s)

`openDocWindow` 계약 구동 → doc 창 생성 → `connectLabel` 접속 → 뷰어(`<img>` 1개, `.xterm` 0) →
그 창의 편집기·호스트 3종 → '다른 이름으로' 저장 → 메인 캐시 무효화까지 전부 통과. 주요 관측값:

| 항목 | 관측 |
|---|---|
| 창 라벨 | `doc-f24d326d0df64a1a87d24ad0f634bc38` |
| 창 크기 | **1180×860**(뷰포트) — `open_doc_window`의 `size`가 실제로 먹는다 |
| 편집기 프리뷰 픽셀 | `rgba(255,59,48,255)` |
| 저장 파일 재디코드 | 200×200, (100,100) = `rgba(255,59,48,255)` |
| 메인 `["file-image", pid, path]` | 저장 후 `isInvalidated=true` |

### 8.2 실기(파일트리 **진짜 더블클릭**부터) — **17 pass / 0 fail**

| # | 검사 | 관측 |
|---|---|---|
| 1 | 트리 행 `div[data-tree-file="shot.png"]`에 `dblclick` 디스패치 → doc 창 | `doc-51d3149bbe2c…` 생성 |
| 2 | 창 크기 | physical 1770×1290 @scale 1.5 → **logical 1180×860**, 뷰포트 1180×860 |
| 3 | 뷰어 | `<img>` 200×200 흰색, `.xterm` 0 |
| 4 | [편집] 버튼 **실클릭** | 그 창에 편집기 마운트(`imageEditorPath="shot.png"`, 캔버스 2장) |
| 5 | 사각형 1개 → **[저장](in-place)** | "주석을 합쳐 저장" 확인이 **그 창에** 뜸 → 저장 |
| 6 | 저장 토스트 | doc 창 `저장됨 — shot.png` = true, **메인** = false |
| 7 | doc 저장 → 메인 뷰어 | 메인 `<img>` 픽셀 `rgba(255,59,48,255)`(빨강) |
| 8 | 메인 저장(초록) → doc 창 뷰어 | doc `<img>` 픽셀 `rgba(52,199,89,255)` — `DocWindow`의 `repo://changed` 리스너 동작 |
| 9 | Esc 계층 | 편집기 + '다른 이름으로' 프롬프트 → Esc → `prompt=false`, 프롬프트 DOM 제거, `imageEditorPath="shot.png"`·모달 유지 |
| 10 | doc 창 닫기 | 창 목록에서 제거, 메인 `check_git` ok·트리 DOM 유지, 로그 새 줄에 ERROR/WARN **0행** |

정리 후 상태: 창 `["main","float-pool-1"]`, `gp:doc-windows` 0개, 편집기·프롬프트·토스트 없음,
픽스처 프로젝트 제거·선택 복원.

### 8.3 설계와 달라진 것

- §3.2·§5-1은 "Rust가 `size`를 받기 전에는 900×760"을 전제로 e2e에 정보 출력만 남겼다. Rust 단계가
  이미 들어가 **1180×860이 실측**이므로 그 자리를 실제 단언으로 바꿨다
  (`tests/e2e/suites/34-image-doc-window.mjs`) — 기본값으로 되돌아가면 실패한다.
- `floating.ts`의 "`size`는 Rust가 아직 받지 않는다" 주석이 스테일이라 현재 계약(기본 900×760,
  420..3000 클램프)으로 고쳤다.
- §5-3의 e2e는 '다른 이름으로' 경로만 본다. 더블클릭 사용자의 기본 동선은 in-place [저장]이라
  실기에서 그쪽(주석 합치기 확인 → 덮어쓰기)까지 봤다.

### 8.4 미해결

- 같은 이미지를 두 번 더블클릭하면 창이 **두 개** 뜬다(`floating.ts`가 호출마다 새 uuid를 만든다).
  우클릭 "새 창으로 열기"의 기존 동작과 같고 §3.5(창 정리 없음)의 연장이라 그대로 뒀다.
- 메인 종료 시 doc 창 동반 종료는 e2e로 볼 수 없다. `is_secondary_window("doc-abc")` 단언
  (`lib.rs:1189`)과 위 #10(닫기 경로에서 메인 무손상)으로 대신한다. 이 세션에서 `cargo test`를
  재실행하지는 않았다(직전 Rust 단계에서 통과 확인, 재빌드 비용·메모리 압박 회피).
- 워처가 없는 저장소의 양방향 갱신은 §6 위험표 그대로 열려 있다 — 실기는 워처가 붙은 픽스처에서만 봤다.
