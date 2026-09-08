# 태스크 56 — 이미지 뷰어 ↑/↓ 키로 같은 폴더의 이전·다음 이미지 즉시 전환

> 상태: **설계** (2026-09-07) · 대상: gitpervisor · 근거: 코드 실측 2026-09-07(워킹트리 기준) ·
> 선행: 태스크 19(뷰어 탭·`activeDiffByProject`), 09(트리 `keys.dir` 캐시) · **Rust 변경 0**

## 1. 요구사항

파일 트리에서 이미지를 클릭해 뷰어에서 보고 있을 때 **↑/↓ 키**를 누르면 **같은 폴더의 이전/다음 이미지**로
바로 바뀐다. 트리를 다시 클릭할 필요가 없다.

받아들이는 조건:
- 순서는 트리 표시 순서(백엔드 자연 정렬)에서 이미지만 뽑은 순서. 끝에서는 멈춘다(순환 없음).
- 전환 시 줌·팬은 새 이미지의 "맞춤"으로 초기화(현행 `key={path}` 동작).
- **뷰어 탭이 늘어나지 않는다** — 현재 탭의 대상이 바뀐다(이미지 50장 넘기면서 탭 50개가 생기면 안 된다).
- 툴바에 `n / N` 표시. 폴더에 이미지가 1장이면 키는 무동작.
- 터미널·입력창에 포커스가 있을 때는 개입하지 않는다(↑↓는 셸 히스토리).

## 2. 현황(근거)

- 뷰어: `ImageView({projectId, path})`(`ImageView.tsx:25-53`) → `ZoomableImage key={path}`(`:46-51`). 박스는
  `tabIndex={0} onKeyDown`(`:252-265`) — **`+ - 0 1`만 처리**(`:160-167`), **아무도 `.focus()`를 부르지 않아** 클릭
  전엔 키가 안 먹는다(`src/components/diff`에 `focus()`는 Monaco 2곳뿐). 툴바 `:216-250`(편집·−·%·+·맞춤·1:1).
- 전역 키: 맨 ↑↓를 소비하는 곳 없음. `ProjectList.tsx:203-219`는 Ctrl+Shift+↑↓만. 트리는 키보드 내비게이션이
  **없다**(`FileTreePanel.tsx`에 `tabIndex`·`onKeyDown` 없음). xterm 화이트리스트는 Ctrl+Shift+↑↓만 통과시킨다
  (`terminal-engine.ts:362-364`) — 맨 화살표는 PTY로 간다(맞다).
- 선례: `VideoPlayer.tsx:670-730, :803-806` — `tabIndex={0}` + React `onKeyDown`에서 `ArrowLeft/Right`, 수식키 시 양보
  (`:689`), INPUT/TEXTAREA/BUTTON 가드(`:671-674`).
- 대상 표현: `selectDiff(target, repoId)`(`ui.ts:313-348`) — 탭을 키(`viewerTabKey`)로 **업서트**, 같은 키만 갱신·다른 키는
  **추가**(`:343-346`). `activeDiffByProject`도 갱신. `ImageView`의 `projectId`는 라우팅된 저장소 id(`ViewerTab.tsx:31`
  `diffRepoId ?? projectId`); 현재 repoId는 `useUi.selectedDiffRepoId`.
- 형제 목록: 트리는 폴더 단위 lazy — `useDir(projectId, relPath)`(`queries/index.ts:659-674`, `keys.dir = ["dir", projectId,
  relPath]`, `staleTime: Infinity`), `DirEntry{name, isDir, isIgnored}`(`ipc.ts:644-648`), 백엔드가 dirs-first 자연 정렬
  (`tree.rs:649-653`). 캐시 동기 조회 선례 `qc.getQueryState(keys.dir(…))`(`queries/index.ts:695`). `parentDir`는
  `FileTreePanel.tsx:416-420` 모듈 로컬(미export). `isImage`는 `language-map.ts:89-94`.
  주의: `useDir`의 `projectId`는 **outer** 프로젝트 id 기준 상대경로다(트리가 outer 루트) — 임베디드 저장소 파일을
  `repoId`로 열었을 때 `ImageView.projectId`는 합성 id고 `path`는 그 저장소 기준이라 `keys.dir(합성id, dir)`는 캐시에 없다.
  `list_dir`이 합성 id를 받는지는 (검증 필요) — 안 받으면 임베디드 이미지는 내비 비활성(§3.3).
- doc 창(`DocWindow.tsx:47`)은 경로가 창 수명 동안 고정(`docTarget` memo) — 별도 처리 없이는 ↑↓가 무의미.

## 3. 설계

### 3.1 키 입력 — 뷰어 박스에 포커스를 준다

| 대안 | 평가 |
|---|---|
| **A. `ZoomableImage` 마운트 시 `boxRef.current?.focus({preventScroll:true})` + 기존 `onKeyDown`에 ↑↓ 추가** (채택) | 이미 `tabIndex={0}`·핸들러가 있다. `key={path}`라 이미지가 바뀔 때마다 리마운트 → 포커스가 따라온다 → 연타 가능. 포커스가 박스에 있으니 터미널·입력창 가드가 **정의상** 필요 없다(그쪽에 포커스가 있으면 이 핸들러가 안 불린다). 덤으로 기존 `+ - 0 1`이 클릭 없이 동작한다 |
| B. `window` keydown 리스너 + activeElement·활성 탭·모아보기 가드 | 가드 4개, `ApiClientTab`이 같은 이유로 `tabIndex=-1` 방식을 택했다(`:46` 주석) |
| C. 트리에 키보드 내비게이션 신설 | 요구는 이미지 전환. 트리 전반의 키보드 내비는 별도 태스크 |

포커스 훔치기의 범위: 이미지가 **처음 열리거나 바뀔 때만**(리마운트 시점). `file-image` 재조회(저장 후 무효화)는
`path` 불변이라 리마운트되지 않는다 → 편집 중 터미널에서 포커스를 뺏지 않는다. 뷰어 탭이 `hidden`이면 `focus()`는
무효(브라우저 규칙) — 터미널 탭 활성 중 뒤에서 열린 이미지가 포커스를 가져가지 않는다.

### 3.2 형제 목록과 전환

`ZoomableImage`에 훅 하나:
```ts
const dir = parentDirOf(path);                      // language-map 또는 lib/path에 export(FileTreePanel 것과 통일)
const { data: entries } = useDir(projectId, dir);   // 캐시에 있으면 즉시, 없으면 1회 list_dir
const siblings = useMemo(() => (entries ?? []).filter((e) => !e.isDir && isImage(e.name)).map((e) => join(dir, e.name)), [entries, dir]);
const idx = siblings.indexOf(path);
const go = (d: 1 | -1) => { const next = siblings[idx + d]; if (next) replaceDiff({ mode: "file", path: next }); };
```
- `onKeyDown`: `ArrowDown`/`ArrowRight` → `go(1)`, `ArrowUp`/`ArrowLeft` → `go(-1)`; `e.ctrlKey||e.metaKey||e.altKey`면 양보
  (VideoPlayer `:689`). `preventDefault`(박스 스크롤 방지).
- 툴바 `%` 왼쪽에 `<span className="tabular-nums text-fg-dim">{idx+1} / {siblings.length}</span>`(siblings ≥ 2일 때만).
- `useDir`는 `refetchOnMount: "always"`(`:672`)라 트리가 이미 적재한 폴더도 마운트 시 백그라운드 재조회 1회가 간다 —
  `placeholderData: keepPreviousData`라 목록은 즉시 있다. 이미지 전환마다 리마운트 → 전환마다 `list_dir` 1회(background lane).
  수용: 폴더 하나 나열은 ms 단위. 거슬리면 `useQuery({...keys.dir, refetchOnMount:false})` 별도 훅.

### 3.3 탭이 늘지 않게 — `replaceDiff`

`selectDiff`는 다른 키를 **추가**한다(`:343-346`). 새 액션 하나:
```ts
// ui.ts — 현재 활성 뷰어 탭의 대상을 제자리에서 바꾼다(탭 수 불변). 활성 탭이 없으면 selectDiff와 동일.
replaceDiff: (target) => set((s) => {
  const repoId = s.selectedDiffRepoId; const outerId = s.selectedProjectId;
  if (!outerId || !s.selectedDiff) return {};
  const oldKey = viewerTabKey(s.selectedDiff, repoId, outerId);
  const key = viewerTabKey(target, repoId, outerId);
  const tab = { key, outerId, repoId, target };
  const i = s.viewerTabs.findIndex((t) => t.key === oldKey);
  const dup = s.viewerTabs.findIndex((t) => t.key === key);
  const tabs = i < 0 ? [...s.viewerTabs, tab]
    : s.viewerTabs.map((t, j) => (j === i ? tab : t)).filter((t, j) => !(dup >= 0 && dup !== i && j === dup));
  return { selectedDiff: target, activeDiffByProject: { ...s.activeDiffByProject, [outerId]: { target, repoId } }, viewerTabs: tabs };
}),
```
- 이미 열려 있던 이미지로 돌아가면 그 탭이 중복되지 않게 제거(`dup`) — 탭 바에 같은 파일 둘이 생기지 않는다.
- `gp:viewer-tabs` 영속은 기존 subscribe(`ui.ts:541-557`)가 그대로 처리.
- 임베디드 저장소: `repoId`가 합성 id면 `useDir(projectId=합성id)`가 (검증 필요). 실패하면 `siblings=[]` → 키 무동작·카운터
  미표시(우아한 비활성). 정확히 하려면 outer 상대경로로 변환해야 하는데 v1 범위 밖.

### 3.4 doc 창

범위 밖(§7). 넣는다면 `DocWindow`가 `useState(path)`를 쥐고 `DiffViewer`→`ImageView`에 `onNavigate` prop 1개를 내려 `replaceDiff`
대신 호출 — 3파일 6줄.

## 4. 변경 목록

| 파일 | 변경 | 규모 |
|---|---|---|
| `src/stores/ui.ts` | `replaceDiff` 액션 | ≈ +18 |
| `src/lib/language-map.ts`(또는 신규 `lib/path.ts`) | `parentDir`·`joinPath` export(`FileTreePanel.tsx:68-70, 416-420`의 로컬 복사본을 import로 교체) | ≈ +8/−8 |
| `src/components/diff/ImageView.tsx` | 포커스·`useDir`·siblings·↑↓·카운터 | ≈ +35 |
| `tests/e2e/suites/46-image-arrow-nav.mjs` | 신설 | ≈ +60 |

## 5. 검증

### 5.1 e2e 46
1. 픽스처 폴더 `imgs/`에 PNG 3개(a,b,c) 생성 → `dir` 무효화.
2. 트리에서 `imgs/b.png` 클릭(`[data-tree-file]`) → `document.activeElement`가 `.checkerboard` 박스(포커스 단언), 툴바 `2 / 3`.
3. 박스에 `keydown ArrowDown` 디스패치 → 폴링: `selectedDiff.path === "imgs/c.png"`, `viewerTabs.length` **불변**, 툴바 `3 / 3`.
4. `ArrowDown` 한 번 더 → 불변(끝). `ArrowUp` ×2 → `a.png`, 탭 수 불변, `activeDiffByProject[fixture].target.path === "imgs/a.png"`.
5. `Ctrl+ArrowDown` → 불변(양보).
6. 터미널 탭으로 전환 후 xterm 포커스 → `ArrowDown` → `selectedDiff` 불변(핸들러 미호출).
7. finally: 파일 삭제, 뷰어 탭 정리.

### 5.2 실기
- 트리 클릭 직후 마우스를 움직이지 않고 ↑↓ 연타 — 지연 없이 전환(`file-image`는 이미 프리페치? 아니면 첫 로드 스피너 —
  체감 확인, 느리면 다음 이미지 `prefetchQuery` 1줄 추가 §7).
- 이미지 저장(편집기) 후 무효화 시 포커스가 터미널에서 뺏기지 않음.

## 6. 위험

- 포커스 훔치기가 사용자 흐름을 방해할 가능성 — 범위를 리마운트 시점으로 한정했고 hidden 뷰어는 무효. 거슬리면 "트리 클릭
  직후에만" 조건(`document.activeElement === body`)을 1줄 추가.
- `replaceDiff`가 `selectDiff`와 탭 규칙을 갈라 갖는다 — 두 함수가 같은 `viewerTabKey`를 쓰므로 키 규칙은 한 곳. e2e 3·4가 탭 수를 단언.

## 7. 열린 질문

| 질문 | 기본값 |
|---|---|
| ←/→도 같이 | 포함(+1 조건, 충돌 없음) |
| doc 창(더블클릭 별도 창)에서도 ↑↓ | v1 제외 — §3.4 6줄이면 되니 원하면 같이 |
| 다음/이전 이미지 `file-image` 프리페치 | 실기 체감 뒤 결정 |
| 순환(마지막→첫) | 없음 |

## 8. 구현 결과 (2026-09-07)

**구현 완료 · 정적 검증 통과(미커밋).** Rust 변경 0.

- `ui.ts` `replaceDiff` — 활성 뷰어 탭을 **제자리 교체**(중복 키 제거 포함), `activeDiffByProject` 갱신. 탭 수 불변.
- `lib/path.ts` 신설 — `joinPath`/`parentDir`를 `FileTreePanel`의 모듈 로컬 사본에서 옮기고 import로 교체.
- `ImageView`: `useSiblingNav(projectId, path)` 훅(같은 폴더 이미지 목록 = 트리와 같은 `keys.dir` 캐시,
  `IS_DOC_WINDOW`면 비활성) + 마운트 시 박스 포커스 + ↑↓←→(수식키 양보) + 툴바 `n / N`.
- e2e 46 신설(`run.mjs`는 `31-capture.mjs` **앞**에 등록 — 그 스위트의 "항상 마지막" 불변식 유지).

**적대적 리뷰(2026-09-07)에서 확정돼 고친 것:**

| 지적 | 수정 |
|---|---|
| 디코드 실패·로드 실패 화면이 **맨 `EmptyState`** 라 툴바·포커스 박스·`onKeyDown`이 전부 사라진다 → 못 여는 파일 하나에서 내비가 끊겨 §1 "트리를 다시 클릭할 필요가 없다"가 깨진다 | 형제 목록·키 처리를 `useSiblingNav` 훅으로 뽑고, 로딩·읽기 실패·디코드 실패 **세 화면을 공용 `NavShell`**(포커스 박스 + `n / N`)로 감쌌다 |
| 전환 때마다 로딩 구간에서 포커스가 body로 떨어져 연타 중 키가 유실된다 | 같은 `NavShell`이 로딩 화면에도 포커스를 유지 |

**설계와 다른 점(구현 시 판단)**: 카운터를 `%` 왼쪽이 아니라 줌 그룹 **앞**에 뒀다(배율과 혼동 방지).
doc 창은 `projectId=null`로 쿼리 자체를 비활성해 내비를 끈다 — 막지 않으면 그 창의 별개 스토어만 바뀌고
공유 `gp:viewer-tabs`가 조용히 갈린다.

**미검증(§5.2 실기)**: 트리 클릭 직후 ↑↓ 연타 체감(프리페치 필요 여부는 §7 열린 질문), 이미지 저장 후 무효화
시 포커스 유지, 임베디드(합성 id) 저장소에서 `list_dir`이 그 id를 받는지(실패 시 우아하게 비활성).
