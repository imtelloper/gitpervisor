# 태스크 55 — 터미널 세션 헤더 Git 버튼 → 그 프로젝트의 변경(Changes)·로그(Log) 모달

> 상태: **설계** (2026-09-07) · 대상: gitpervisor · 근거: 코드 실측 2026-09-07(워킹트리 기준) ·
> 선행: 태스크 23(세션 컨트롤 오버레이 병합), 30(보조 창의 DiffViewer 실증), 54(`ProjectLogo`) · **Rust 변경 0**

## 1. 요구사항

터미널 세션 위(헤더/오버레이)에 **Git 버튼**이 있고, 누르면 **그 세션의 프로젝트**의 변경 목록과 커밋 로그를
보여주는 **모달**이 뜬다. 모아보기(메인 안·별도 창)에서는 Changes·Log 패널이 아예 없으므로 이 모달이 유일한 동선이다.

받아들이는 조건:
- 버튼 위치: 모아보기 셀 헤더(`ThemeButton`·`PromptLogButton` 옆)와 워크스페이스 pane 호버 오버레이(같은 자리).
- 모달 = 헤더(로고 + 프로젝트명 + 탭 [변경 | 로그] + 닫기) + 본문. **변경 탭**: 변경 목록(스테이지/언스테이지/롤백/커밋 폼
  포함, 사이드바 패널과 동일 기능) + 클릭한 파일의 diff. **로그 탭**: 커밋 목록 + 커밋 상세 + 클릭한 파일의 diff.
- 모달 안에서 파일을 클릭해도 **메인 뷰어·뷰어 탭·모아보기 상태가 바뀌지 않는다**(모달 로컬 선택).
- Esc·배경 클릭·X로 닫힘. 모아보기의 브라우저 셀(네이티브 webview) 위에 그려진다.
- 별도 모아보기 창(`aggregate`)에서도 동작한다.

## 2. 현황(근거)

- **재사용할 조각은 전부 있다.** 변경: `ChangesPanel({projectId})`(`ChangesPanel.tsx:692-765`, 폭 핸들·접기·`CommitForm` 포함,
  outer+임베디드 섹션). 로그: `CommitList`·`CommitDetailPane`·`BranchesPane`(`LogPanel.tsx:35-37`이 3분할로 배치).
  diff: `DiffViewer({projectId, target})`(`DiffViewer.tsx:176-182`, lazy — `ViewerTab.tsx:12-37`·`DocWindow.tsx:126-129`가 호스트).
- **문제는 선택이 전역이라는 것.** 변경 행 클릭은 `selectDiff(target, projectId)`(`ChangesPanel.tsx:343`), 커밋 파일 클릭도
  `selectDiff({mode:"commit", sha, path})`(`CommitDetailPane.tsx:107-108`). `selectDiff`(`ui.ts:313-348`)는 뷰어 탭을 업서트하고
  **모아보기가 열려 있으면 닫아 버린다**(`:317-324`). 모달 안에서 그대로 쓰면 클릭 한 번에 모아보기가 사라진다.
  행 강조도 전역 `selectedDiff`를 본다(`ChangesPanel.tsx:301-302`, `CommitDetailPane.tsx:100-103`).
- 커밋 선택(`selectedCommitSha`·`selectCommit`, `ui.ts:110/163/485`)은 `CommitList`(`:53-54,:106`)와 `CommitDetailPane`(`:21`)이
  스토어로 통신한다 — 모달이 같은 스토어를 써도 부작용은 "하단 Log 패널의 선택 커밋이 같이 바뀐다"뿐이다.
- 모달 껍데기 선례: `MemoDialog.tsx:35-51`(`fixed inset-0 z-50 bg-black/50` + `h-[560px] w-[820px]` 박스 + Esc + 배경 클릭 닫기).
  범용 `<Modal>`은 없다(각 다이얼로그가 두 줄을 반복).
- **점유 계약**: 전체 화면 모달 상태는 `selectBlockingOverlay`(`ui.ts:231-238`)에 넣어야 네이티브 webview 위에 그려진다
  (`:226-227` — 빠뜨려 실제로 난 버그). 모아보기는 브라우저 셀을 품으므로 필수.
- 버튼 자리: 셀 헤더 `AggregateTerminals.tsx:1318-1320`(`ThemeButton`·`PromptLogButton`), pane 오버레이
  `PaneTree.tsx:125-132`(`LeafView`가 `tab`을 쥐고 있어 `tab.projectId` 접근 가능). 세션 버튼 컴포넌트들은
  `TermSessionControls.tsx`에 모여 있다(`ThemeButton`·`PromptLogButton`·`PromptSidePanel`, 16px 히트박스 관례 — 23 §열린 질문).
- 별도 모아보기 창: `AggregateWindow.tsx:48-49`에 `ConfirmHost`·`Toasts`, `main.tsx:104-115`가 `QueryClientProvider`로 감싼다.
  `useUi`는 창마다 별개 인스턴스. Monaco 기반 `DiffViewer`가 보조 창에서 도는 것은 doc 창(태스크 30)이 실증.
- 아이콘: `History`는 프롬프트 로그·Log 패널이 이미 쓴다. lucide `GitBranch`/`GitCommitHorizontal`은 미사용.

## 3. 설계

### 3.1 모달 로컬 선택 — 두 컴포넌트에 `onSelect`·`active` prop

| 대안 | 평가 |
|---|---|
| **A. `ChangesPanel`·`CommitDetailPane`에 optional `onSelect(target, repoId)`·`active` prop — 있으면 `selectDiff`·전역 강조 대신 사용** (채택) | 변경은 두 파일의 호출 지점 2곳 + 강조 계산 2곳. 사이드바·Log 패널(prop 없음)은 동작 불변. 모달이 `useState`로 `{target, repoId}`를 쥐고 `DiffViewer`에 넘긴다 |
| B. `selectDiff`에 "모아보기 닫지 않기·탭 업서트 안 하기" 플래그 | 전역 `selectedDiff`가 바뀌어 메인 뷰어가 뒤에서 따라 움직인다(모달 뒤 화면 변경). 요구 위반 |
| C. 모달에서 파일 클릭 시 모달을 닫고 메인 뷰어로 점프 | 모아보기가 닫힌다 — 모달을 만든 이유가 모아보기에서 보기 위함 |

`RepoChanges`·`NestedRepoSection`으로 prop을 내려보내는 경로: `ChangesPanel:749-756` → `RepoChanges:226-232`(+2 prop) →
`:343 (onSelect ?? selectDiff)(target, projectId)`, `:301-302 activeDiff = active ? (active.repoId === projectId ? active.target
: null) : (기존식)`. `CommitDetailPane`: `:107-108`·`:100-103` 같은 치환. 타입: `onSelect?: (target: DiffTarget, repoId: string)
=> void; active?: { target: DiffTarget; repoId: string } | null`.

### 3.2 모달 — `src/components/git/GitDialog.tsx`

- 스토어: `useUi.gitDialog: { projectId: string } | null`, `openGitDialog(projectId)`, `closeGitDialog()`.
  `selectBlockingOverlay`에 `|| !!s.gitDialog` **추가**(계약).
- 껍데기: `MemoDialog` 복제 — `fixed inset-0 z-50 flex items-center justify-center bg-black/50` / 박스
  `flex h-[min(780px,92vh)] w-[min(1240px,96vw)] flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-xl`.
  Esc는 `window keydown`(모달 열린 동안만). 열릴 때마다 로컬 `active`·탭을 초기화(`key={projectId}`로 리마운트).
- 헤더 `h-9 border-b px-3`: `<ProjectLogo projectId size={16}/>`(54) + 프로젝트명(`useProjects`) + 탭 버튼 2개
  (`aria-selected`, 활성 `border-b-2 border-accent`) + 우측 X.
- 본문(탭별, **hidden 마운트 아님** — 전환 시 리마운트; 모달 수명이 짧다):
  - 변경: `flex min-h-0 flex-1` → `<ChangesPanel projectId onSelect active/>`(자체 폭 핸들 288px 그대로) + 우측
    `flex-1`에 `active ? <Suspense><DiffViewer projectId={active.repoId} target={active.target}/></Suspense> : <EmptyState title="파일을 선택하세요"/>`.
  - 로그: `<CommitList projectId/>`(w-[380px]) + `<CommitDetailPane projectId onSelect active/>`(w-[300px]) + 우측 `DiffViewer`.
    `BranchesPane`는 **뺀다**(§7).
  - `active`는 탭별로 따로(변경/로그가 서로의 선택을 지우지 않게) — `useState<Record<"changes"|"log", Sel|null>>`.
- 마운트: `App.tsx:195-210` 호스트 형제로 `<GitDialog/>`, **`AggregateWindow.tsx:48-49`에도**. 두 창의 `useUi`가 별개라
  각 창이 자기 모달을 그린다(`openGitDialog`를 누른 창에서 뜬다 — 의도).

### 3.3 버튼 — `GitDialogButton({ projectId })` in `TermSessionControls.tsx`

```tsx
export function GitDialogButton({ projectId }: { projectId: string }) {
  const open = useUi((s) => s.openGitDialog);
  return (
    <button onClick={() => open(projectId)} title="Git 변경·로그 보기"
      className="rounded p-0.5 text-fg-dim hover:bg-raised hover:text-fg">
      <GitBranch size={12} />
    </button>
  );
}
```
- 셀 헤더: `AggregateTerminals.tsx:1320` `PromptLogButton` 뒤 `<GitDialogButton projectId={meta.projectId}/>`(터미널·브라우저 셀 모두 — 프로젝트 단위 기능).
- pane 오버레이: `PaneTree.tsx:128` `PromptLogButton` 뒤 `<GitDialogButton projectId={tab.projectId}/>`. `PaneControls`는
  `BrowserPane` 주소창이 재사용하므로(`:110`) 건드리지 않는다.
- `xterm` 포커스가 있는 채로 버튼을 누르면 xterm blur → 문제 없음(ThemeButton과 동일).

### 3.4 diff 대상 라우팅

`ChangesPanel`의 `onSelect(target, projectId)`에서 두 번째 인자는 **그 섹션의 저장소 id**(outer 또는 `<outer>::<rel>` 합성 id,
`:343` 주석)다. `DiffViewer projectId`에 그대로 넣는다 — `ViewerTab.tsx:31`이 `diffRepoId ?? projectId`를 넣는 것과 같다.
커밋 파일은 `onSelect({mode:"commit", sha, path}, projectId)`(outer).

## 4. 변경 목록

| 파일 | 변경 | 규모 |
|---|---|---|
| `src/stores/ui.ts` | `gitDialog` 상태·액션 2 + `selectBlockingOverlay` 1항 | ≈ +8 |
| `src/components/git/GitDialog.tsx` | 신설 | ≈ +130 |
| `src/components/changes/ChangesPanel.tsx` | `onSelect`·`active` prop 관통(3 컴포넌트) + 호출 2곳 | ≈ +18 |
| `src/components/log/CommitDetailPane.tsx` | 같은 prop 2개 | ≈ +8 |
| `src/components/workspace/TermSessionControls.tsx` | `GitDialogButton` | ≈ +14 |
| `src/components/AggregateTerminals.tsx` | 셀 헤더 2곳 | +2 |
| `src/components/workspace/PaneTree.tsx` | 오버레이 1곳 | +1 |
| `src/App.tsx`, `src/AggregateWindow.tsx` | 마운트 | +2 |
| `tests/e2e/suites/45-git-dialog.mjs` | 신설 | ≈ +90 |

## 5. 검증

### 5.1 e2e 45
1. 픽스처 프로젝트에 미커밋 변경 1개 만들기(03-status-changes 관례).
2. `__gpv.ui.getState().openGitDialog(fixtureId)` → `div.fixed.inset-0.z-50` 안에 프로젝트명·탭 "변경"/"로그"·"Changes" 헤더 존재.
3. 변경 행 클릭 → 모달 안 `.monaco-editor`(또는 이미지/EmptyState) 등장 폴링 10s; **전역 불변 단언**:
   `useUi.selectedDiff` 클릭 전후 동일, `viewerTabs.length` 동일, `aggregateOpen` 동일.
4. "로그" 탭 → 커밋 행 클릭 → 상세의 파일 행 클릭 → 모달 안 diff 갱신, 전역 불변 단언 반복.
5. 모아보기 열린 상태에서 2~4 반복 → `aggregateOpen === true` 유지.
6. 셀 헤더 `button[title="Git 변경·로그 보기"]` 클릭으로도 열림. Esc → 닫힘(`gitDialog === null`).
7. 브라우저 셀이 있는 모아보기에서 열었을 때 `useWebviewBlocked()`가 true(점유 계약) — `__gpv.ui`의 `selectBlockingOverlay` 직접 호출.

### 5.2 실기
- 모아보기 별도 창에서 버튼 → 그 창 안에 모달, Monaco diff 렌더, 커밋 폼으로 커밋 → 메인 사이드바 갱신(watcher).
- 브라우저 셀 위에 모달이 그려지고(가려지지 않고) 닫으면 webview 복귀.
- 1240px 모달에서 변경 탭 288+diff, 로그 탭 380+300+diff 가독성.

## 6. 위험

- `selectBlockingOverlay` 누락 = 모아보기 브라우저 셀 뒤에 모달이 숨는다. 5.1-7이 잡는다.
- `DiffViewer`가 전역 `selectDiff`를 부르는 경로(`DiffViewer.tsx:188`, `:580` — 정의 이동 등)가 모달 안에서 눌리면
  메인 뷰어가 바뀐다. v1은 수용(diff 안 정의 이동은 드물다), 필요하면 같은 `onSelect` 치환.
- 모달 두 개(메인·별도 창)가 같은 프로젝트를 동시에 열어 커밋 폼을 둘 다 쓰면 op 락으로 한쪽이 거절된다(기존 동작).

## 7. 열린 질문

| 질문 | 기본값 |
|---|---|
| 로그 탭에 `BranchesPane`(브랜치 전환·삭제) 포함 | 제외 — 요구는 "changes와 log". 포함 시 `w-[200px]` 1줄 |
| 모달 크기 기억(`gp:git-dialog-size`) | 없음 — 고정 `min(1240px, 96vw)` |
| 워크스페이스 pane 오버레이에도 버튼(사이드바 패널이 이미 있음) | 포함 — 동선 일관성, +1줄 |
| 모달 안 커밋 성공 시 자동 닫기 | 안 닫음 — 연속 작업 |

## 8. 구현 결과 (2026-09-07~08)

**구현 완료 · 정적 검증 통과(미커밋).** Rust 변경 0. 설계대로 A안 — 두 컴포넌트에 optional `onSelect`/`active`.

- `ui.ts` `gitDialog`/`openGitDialog`/`closeGitDialog` + `selectBlockingOverlay`에 편입(브라우저 셀 위 표시).
- `components/git/GitDialog.tsx` 신설(MemoDialog 껍데기, 탭별 로컬 선택, `BranchesPane` 제외), `TermSessionControls`의 `GitDialogButton`을 pane 오버레이·모아보기 두 셀 헤더에.
- `ChangesPanel`·`CommitDetailPane`에 `onSelect`/`active` 관통, `App`·`AggregateWindow` 마운트, e2e 45 신설.

**적대적 리뷰(2026-09-08 · 리뷰어 3렌즈 → 발견당 반박자 3)에서 확정돼 고친 것 — 이 태스크가 가장 많이 나왔다:**

| 지적 | 수정 |
|---|---|
| **(높음)** 모달이 `ChangesPanel`을 통째로 마운트하며 **두 번째 `CommitForm`이 전역 Ctrl+K에 바인딩**돼, 한 번 누르면 사이드바(프로젝트 A)와 모달(프로젝트 B)이 **둘 다 커밋**한다. `CommitForm`의 `bindShortcut`은 정확히 이걸 막으려고 있던 스위치다 | `ChangesPanel`에 `embedded` prop → `bindShortcut={!embedded}` |
| **(높음)** 모달 안 `DiffViewer`의 **"편집" 버튼이 전역 `selectDiff`** 를 부른다 → 메인 창에서는 열려 있는 모달 뒤로 **모아보기가 통째로 사라지고**, 별도 모아보기 창에서는 그 창의 낡은 `viewerTabs` 스냅샷이 `gp:viewer-tabs`에 통째로 기록돼 **메인 창이 그 뒤 연 탭이 재시작 후 전부 없어진다**(데이터 손실) | (a) `DiffViewer`에 `onOpenFile` prop → 모달은 로컬 `onSelect`로 라우팅(정의 이동 경로도 `DefContext.open`으로 함께 닫음). (b) `ui.ts`의 뷰어 탭 영속 구독을 **메인 창 전용**으로(`float-*`·`doc-*`·`aggregate` 제외) — (a)와 무관하게 성립해야 하는 가드 |
| **(중)** `DiffViewer`가 정의 이동·포매터 컨텍스트를 **모듈 전역**에 심는데 effect deps가 `[projectId, path]`뿐이라, 나중에 뜬 모달이 덮어쓴 뒤 **모달이 닫혀도 메인 뷰어가 복구되지 않는다** — Ctrl+호버 정의 검색과 Shift+Alt+F가 닫힌 모달의 프로젝트를 계속 가리킨다 | effect가 이전 값을 캡처하고 cleanup에서 복원(`restoreDefContext`/`restoreFormatContext`). 중첩에도 성립 |
| **(중)** 모달 로그 탭이 **창 전역 `selectedCommitSha`** 를 써서, 모달(B)과 하단 Log 패널(A)이 서로를 오염시키고 sha/프로젝트가 어긋나면 상세가 "커밋 상세 …"에서 영영 멈춘다 | `CommitList`·`CommitDetailPane`에 `selectedSha`/`onSelectCommit` optional prop(모달이 로컬 소유) + `CommitDetailPane`에 error 분기 |
| **(중)** 모달이 **사이드바의 영속 키**(`gp:changes-collapsed`/`-width`)를 공유해, 사이드바를 접어 둔 사용자는 모달에서 28px 스트립만 본다 | `embedded`면 접힘·폭 핸들 제거, 고정 288px |
| (낮음) 모달 안에서 시작한 드래그를 배경에서 놓으면 모달이 닫힌다 | 배경이 `pointerdown`도 자기에게서 시작했을 때만 닫는다 |
| **(높음, e2e)** 로그 탭 단계가 "최신 커밋에 `src/app.txt`가 있다"를 전제하는데 전체 회차에서는 04가 `ext.txt`만 건드린 외부 커밋으로 fast-forward해 **항상 실패**한다 | 상세의 **첫 파일 행**을 눌러 그 title을 읽는 방식으로 교체 |
| (중, e2e) 모아보기 유지 단언이 `'no-row'`를 성공으로 받고 자기 자신과 비교해 **공허하게 통과** | 클릭 성공을 별도 단언으로 세우고 기준값을 클릭 **전**에 캡처 |

**설계와 다른 점**: (1) §3.2의 "자체 폭 핸들 288px 그대로"를 버리고 모달에서는 폭 핸들을 뺐다 — 남기면 사이드바의 영속 폭을 모달이 바꾼다. (2) §6이 "v1 수용"으로 뒀던 정의 이동 경로도 같은 메커니즘 6줄로 함께 닫았다. (3) `RepoChanges`의 강조 분기를 `active`가 아니라 `onSelect` 유무로 갈랐다(모달이 아무것도 안 고른 상태에서 전역 강조가 새어 들어오지 않게).

**미검증(§5.2 실기)**: 별도 창에서의 모달·Monaco·커밋 폼, 브라우저 셀 위 가시성, 1240px 가독성, e2e 45 실제 회차. §5.1-7(점유 계약)은 `selectBlockingOverlay`가 `__gpv`에 없어 소스 단언으로 대체했다.
