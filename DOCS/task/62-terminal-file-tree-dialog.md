# 태스크 62 — 터미널 세션 헤더 파일 트리 버튼 → 그 프로젝트의 파일 트리 모달

> 상태: **설계** (2026-09-08) · 대상: gitpervisor · 근거: 코드 실측 2026-09-08(워킹트리 기준) ·
> 선행: 태스크 55(같은 자리의 Git 모달 — **이 설계의 원본**), 30(보조 창 DiffViewer) ·
> **Rust 변경 0**

## 1. 요구사항

터미널 세션 위(호버 오버레이/셀 헤더)에 **파일 트리 버튼**이 있고, 누르면 **그 세션의 프로젝트**
파일 트리가 모달로 뜬다.

받아들이는 조건:
- 버튼 자리: `ThemeButton`·`PromptLogButton`·`GitDialogButton` 옆 — pane 호버 오버레이
  (`PaneTree.tsx:127-137`)와 모아보기 셀 헤더 양쪽.
- 모달 = 헤더(프로젝트 로고 + 이름 + 닫기) + 파일 트리 본문. 사이드바 트리와 **같은 기능**
  (펼치기·새 파일/폴더·이름 바꾸기·삭제·드래그 이동·우클릭 메뉴·이미지 일괄 변환).
- **메인 뷰어·뷰어 탭·모아보기 상태를 바꾸지 않는다.** 파일 열기는 별도 문서 창으로 간다.
- Esc·배경 클릭·X로 닫힘. 네이티브 브라우저 webview 위에 그려진다.
- 별도 모아보기 창(`aggregate`)에서도 동작한다 — 거기엔 사이드바가 아예 없어 이 모달이 유일한 동선이다.

## 2. 현황(근거)

- **껍데기는 그대로 베낀다.** `GitDialog.tsx:24-60`이 배경 클릭 함정까지 해결해 둔 모달 셸이다
  (`pointerdown`과 `click`이 **둘 다** 배경에 떨어졌을 때만 닫는다 — 모달 안에서 시작한 드래그를
  배경에서 놓으면 click이 공통 조상인 배경으로 가기 때문). 상태는 `ui.ts:209-210,595-596`의
  `gitDialog`/`openGitDialog`/`closeGitDialog` 3종 세트.
- **점유 계약**: 전체 화면 모달은 `selectBlockingOverlay`(`ui.ts:262`)에 넣어야 네이티브 자식
  webview 위에 그려진다. 빠뜨려서 실제로 난 버그가 태스크 55에 기록돼 있다.
- **트리는 통째로 재사용 가능하다.** `FileTreePanel({projectId})`(`FileTreePanel.tsx:461`)는 이미
  `projectId`만 받는다. 다만 **패널 크롬이 붙어 있다**: `usePanelWidth`/`usePanelCollapsed`
  (`:462-463`), 고정 폭 래퍼와 "Files" 헤더(`:1134-1167`), `ResizeHandle`(`:1194`).
- **막힌 곳은 선택 라우팅 하나뿐이다.** 행을 클릭하면 `selectDiff({mode:"file", path})`를 부른다
  (`:569`, `:583`). 이 함수는 (a) `repoId`를 안 넘겨 **현재 선택된 프로젝트 기준으로 경로를 푼다**,
  (b) 뷰어 탭을 업서트하고, (c) 모아보기가 열려 있으면 **닫는다**(`ui.ts:346-` / 태스크 55 §2가
  같은 함정을 기록).
  → 다른 프로젝트의 터미널에서 이 모달을 열면 **엉뚱한 레포의 같은 경로 파일**이 뷰어에 뜨고
  모아보기가 사라진다. 그대로 두면 안 된다.
- 파일을 여는 부작용 없는 경로는 이미 있다: `openDocWindow(projectId, path)` — 트리 우클릭
  "새 창으로 열기"(`:1245-1252`)와 이미지·동영상 더블클릭(`:593-615`)이 쓰는 그 함수다.
  **저장소 id를 함께 넘기므로** 임베디드 저장소 경로도 올바르게 푼다.

## 3. 설계

### 3.1 상태 (`stores/ui.ts`)

`gitDialog`와 **완전히 같은 모양**으로 하나 더 만든다.

```ts
fileTreeDialog: { projectId: string } | null
openFileTreeDialog: (projectId: string) => void
closeFileTreeDialog: () => void
```

`selectBlockingOverlay`(`:262`)에 `!!s.fileTreeDialog`를 더한다. **이 줄을 빠뜨리면 모아보기의
브라우저 셀이 모달을 덮는다** — 태스크 55에서 실제로 났던 버그다.

영속화하지 않는다(`gitDialog`도 안 한다). 창별 `useUi`라 별도 모아보기 창은 자기 모달을 그린다.

### 3.2 버튼 (`workspace/TermSessionControls.tsx`)

`GitDialogButton`(`:167-178`)을 그대로 본떠 `FileTreeButton({ projectId })`. 아이콘은 lucide
`FolderTree`, size 12, 같은 클래스. 배치는 `PaneTree.tsx:127-137`의 `controls` 조각과 모아보기 셀
헤더 두 곳에 `<GitDialogButton>` 바로 옆.

`projectId`는 **`tab.projectId`**를 넘긴다(pane이 아니라 탭이 프로젝트를 소유한다 —
`GitDialogButton`이 이미 그렇게 받는다).

### 3.3 트리 재사용 — `variant` 프로프 (`tree/FileTreePanel.tsx`)

1,368줄을 복제하지 않는다. 프로프 두 개만 더한다.

```ts
FileTreePanel({
  projectId,
  variant = "panel",              // "panel" | "modal"
  onActivate,                     // 파일 활성화 훅 (기본: selectDiff)
})
```

`variant === "modal"`일 때만:
- 바깥 래퍼가 `style={{width}}`·`border-r`·`shrink-0` 대신 `h-full w-full` (`:1135-1138`)
- 헤더의 "Files" 자리에 `<ProjectLogo>` + 프로젝트명, **패널 접기 버튼 제거**
  (`:1160-1166` — 모달에는 접을 패널이 없다). 새 파일·새 폴더 버튼은 남긴다.
- `ResizeHandle`(`:1194`) 렌더 안 함
- `usePanelWidth`/`usePanelCollapsed` 훅은 **계속 호출한다**(훅 개수 고정 — 반환값만 안 쓴다).
  분기로 훅을 건너뛰면 같은 컴포넌트가 variant에 따라 훅 수가 달라져 React가 깨진다.
- `fitToContent`(`:508-526`)는 `resizeTo`가 no-op이 되므로 자연히 무해하다.

### 3.4 선택 라우팅 — §2의 함정 해소

`onActivate?: (path: string, name: string) => void`를 받아 `:569`·`:583`·`:877`의 `selectDiff`
호출을 **전부** 이 훅 경유로 바꾼다. 기본값은 지금 동작 그대로:

```ts
const activate = onActivate ?? ((path) => selectDiff({ mode: "file", path }));
```

모달은 이렇게 넘긴다:

```ts
onActivate: (path) => openDocWindow(projectId, path)
```

이유:
- **부작용이 없다** — 전역 `selectedDiff`·뷰어 탭·모아보기가 그대로다(요구사항).
- **경로가 올바르게 풀린다** — `openDocWindow`는 `projectId`를 함께 넘긴다. `selectDiff`는 안 넘겨서
  다른 프로젝트의 트리에서 부르면 틀린다.
- **모아보기 별도 창에서도 된다** — 그 창엔 뷰어가 없으므로 `selectDiff`는 애초에 갈 곳이 없다.

`onDouble`(`:593-615`)은 손대지 않는다 — 실행 파일 실행·이미지/동영상 별도 창은 이미 부작용 없는
경로이고 `projectId`를 넘긴다.

`ipc.runExecutable`은 그대로 둔다(트리의 "실행하기"는 모달에서도 같은 의미다).

### 3.5 모달 (`components/tree/FileTreeDialog.tsx`, 신규 ~50줄)

`GitDialog.tsx:24-60`을 복사하고 본문만 갈아 끼운다. 크기는 트리라 좁고 길게:
`h-[min(760px,90vh)] w-[min(520px,92vw)]`. `key={projectId}`로 프로젝트가 바뀌면 트리 상태를
초기화한다(GitDialog와 같은 규칙).

마운트 지점은 `GitDialog`와 같은 곳(메인 `App.tsx`, 별도 모아보기 창 루트) 두 군데.

### 3.6 스코프 밖 (하지 않는다)

- 사이드바 트리와 모달 트리의 **펼침 상태 공유**: `useTreeState`가 이미 프로젝트별 전역이라
  자동으로 공유된다. 별도 작업 없음 — 그리고 분리하지도 않는다(사용자가 사이드바에서 펼쳐둔 곳이
  모달에서도 펼쳐져 있는 게 자연스럽다).
- 모달 안 파일 미리보기 패널. 요구는 "볼 수 있게"이고, 보는 것은 문서 창이 한다.

## 4. 검증

- **e2e (신규, 스위트 14 계열)**:
  1. 터미널 pane 호버 → 파일 트리 버튼 클릭 → 모달이 뜨고 헤더 프로젝트명이 **그 탭의 프로젝트**다
     (선택된 사이드바 프로젝트가 다른 상태에서 확인 — §2의 함정 회귀 방지).
  2. 모달에서 파일 클릭 → `__gpv.ui.getState().selectedDiff`가 **변하지 않는다**.
  3. 모달에서 파일 활성화 → 문서 창(`doc-<id>`)이 뜨고 그 창이 **그 프로젝트의** 파일을 연다.
  4. `selectBlockingOverlay(__gpv.ui.getState())`가 모달 열림 동안 **true** (e2e 45 계약).
  5. Esc / 배경 클릭으로 닫힘. 모달 안에서 시작해 배경에서 놓은 드래그로는 **안 닫힘**.
- **회귀**: 사이드바 `FileTreePanel`(`App.tsx:166`)의 기존 동작 — 폭 조절·접기·클릭 시 뷰어 전환·
  드래그 이동. `variant` 기본값이 `"panel"`이라 호출부 변경이 없어야 한다.

## 5. 하지 말 것

- `selectBlockingOverlay` 등록을 빠뜨리지 마라(§3.1).
- 모달에서 `selectDiff`를 그냥 부르지 마라 — §2의 세 가지 부작용이 전부 살아난다.
- `FileTreePanel`을 복사해 모달 전용 트리를 만들지 마라. 1,368줄이 두 벌이 되면 우클릭 메뉴·드래그
  이동·이미지 변환이 한쪽에만 고쳐진다.
- `variant` 분기로 훅 호출을 건너뛰지 마라(§3.3).
