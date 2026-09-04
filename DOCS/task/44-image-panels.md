# 태스크 44 — 좌측 패널: 레이어 트리(검색·필터·접기·드래그 순서·이름·눈/자물쇠·뱃지)·히스토리 탭·에셋 탭 슬롯

> 상태: 설계(Design) · 대상: gitpervisor · 근거: 코드 실측 2026-09-04(워킹트리) · 선행: 태스크 41(`DocHistory.entries/cursor/jumpTo`·`useImageDocPersist` 스냅샷),
> 42(`useImageEditorUi` 선택/호버·`LeftPanel` 탭 프레임·단축키 표·액션 맵), 38(`tree.ts`·`resolveScene`·`hitTest`·`buildObjectPath` 메모), 37(`NodeBase.name/visible/locked/mask/blend`) ·
> `DOCS/pro-image-editor-design.md` §8.2(레이어 패널 기각 근거 "잠금/숨김 3분기" — 38이 풀었으므로 이 문서가 패널을 만든다) ·
> 시안: `designs/image-editor-figma-v2.pen` ①(Left Panel · Layer Tree · Left Footer)④(Popover 타입 필터)⑤(Panel 히스토리 · Panel 에셋 탭) · 상위: `00-INDEX.md` §10 — **M2 마감.**

## 1. 요구사항

시안 ① 좌측 패널(폭 264): 탭 `레이어 · 에셋 · 히스토리`, 검색 `레이어 검색` + `타입 필터` 버튼, 헤더 `레이어 · 11` + 액션 4(eye · lock · folder-plus · trash-2),
트리 `주석 레이어[패스스루] › 불량 영역 강조 · 치수선 그룹 › 측정값 오차 ±0.2mm · 지시선 벡터[노드 편집] · 번호 뱃지 #3 · 고객사명 모자이크[마스크] · 하이라이트 · 센서 위치(Rename Input) · 배경 — 대시보드.png`,
`Drag Ghost(알람 Top5 지시선) · Drop Indicator`, 푸터 `2개 선택됨 · ⇧클릭 · 드래그로 순서 변경`. ④ `레이어 타입 필터: 타입 · 프레임 · 그룹 · 도형 · 텍스트 · 이미지 · 벡터 · 컴포넌트 · 숨김만 · 잠금만 · 재정의된 인스턴스 · 마스크 포함 · 초기화 · 적용`.
⑤ 히스토리 탭 `전체 · 내 작업 · 스냅샷 · 오늘 · 15:24 · 지시선 벡터 노드 편집(방금 · 현재) · 번호 뱃지 #3 이동(1분 전) · … · 오늘 · 14:50 · … · 어제 · 스냅샷 · 1차 검토본 · 이미지 열기 · 되돌리기 · 스냅샷 저장`, ⑤ `좌측 패널 탭 상태 · 에셋`(탭 슬롯 — 콘텐츠는 51).

받아들이는 조건:
- 문서 트리(37/38)가 **행 목록**으로 보인다 — 중첩 들여쓰기·접기·기본 이름(`name:null`이면 `사각형 3`·`번호 뱃지 #3`·`텍스트 "…"`)·타입 아이콘·뱃지(마스크·노드 편집·블렌드·인스턴스 상태)·눈/자물쇠·배경 행(최하단·잠금).
- 행 클릭·⇧클릭이 캔버스 선택과 **같은 상태**를 바꾸고, 캔버스 호버 ↔ 행 강조가 양방향이다. 잠금·숨김 노드도 패널에서는 선택된다(38 §7 (d)의 "패널 경로").
- 드래그로 순서·부모를 바꾼다(형제 사이·그룹 안으로) — 문서 재배열은 **`tree.ts` 함수 1회 커밋**이다(INDEX §10.4).
- 검색·타입 필터는 문서를 건드리지 않는 **뷰**다(다시 열면 초기화).
- 히스토리 탭은 41의 항목(라벨·시각·readonly·cursor)을 **그대로** 보여 주고 행 클릭이 `jumpTo`다. 스냅샷 저장/복원은 41 `persist`를 부른다.
- 이 태스크만 머지해도 쓸 수 있다: 42의 `LeftPanel` 프레임에 세 탭 콘텐츠가 들어가고, 30/34/35 초록.

## 2. 현황(근거)

- **레이어 목록 UI가 없다**: `src/components/image/`는 `AnnotationLayer.tsx`·`AnnotationToolbar.tsx`·`ImageEditor.tsx` 3파일. 편집기 우측 `<aside className="w-72 …">`(`ImageEditor.tsx:1121-1273`)에 주석/회전/크롭/크기/색 보정/포맷 섹션뿐, 객체 목록·이름·순서 UI 0. 순서 변경은 `[`/`]` 키의 배열 스왑 `reorder`(`AnnotationLayer.tsx:1256-1276`, 호출 `:687`)가 전부 — 38이 `tree.reorder`로 대체한다.
- **선택은 편집기 로컬 state**: `ImageEditor.tsx:219 selectedIds` → `AnnotationLayer` props `:1101 selectedIds`·`:1113 onSelectionChange`. 호버 상태는 없다. 42가 창별 `useImageEditorUi{selectedIds, hoverId, select, setHover}`로 옮긴다 — 패널은 그 스토어를 **읽고 쓰기만** 한다.
- **호버 히트는 금지돼 있었다**: `AnnotationLayer.tsx:501-506` "hitTestIndex 는 부르지 않는다(K4) — 객체마다 Path2D 를 새로 만들기 때문". 38 §3.3이 `buildObjectPath`를 `WeakMap<GeomNode,Path2D>` 메모로 바꾸므로 그 근거가 사라진다. 커밋 객체는 불변(`types.ts:7-8`)이라 참조가 곧 캐시 키.
- **히스토리는 깊이만 있다**: `history.ts:10 HISTORY_LIMIT=50`, `:39-41 depth`, `:46-54 commit(next)` 라벨·시각 없음, `:80-87 reset`. `undo/redo`(`ImageEditor.tsx:272-287`)는 `setSelectedIds([])`. 41이 `HistoryEntry{doc,label,at,readonly}`·`entries/cursor/jumpTo`·`persist.saveSnapshot/listSnapshots/loadSnapshot`을 정의한다 — 패널은 소비만. 리렌더 트리거는 `histVer`(`:204`, `applyDoc :241-250`이 커밋마다 증가, `:969-971` canUndo/canRedo가 같은 의존).
- **이름·표시·잠금 필드는 v1에 없다**: `types.ts:35-48 Common{id,stroke,strokeWidth,opacity,rot}`. 37 `NodeBase.name:string|null·visible·locked·mask·blend`, 정규화가 `name:null`을 채우고 "레이어 패널이 `defaultLayerName`으로 표시 → 44"(37 §3.3)라 적어 두었다. 38 `resolveScene`이 효과적 숨김/잠금을 해석하고 `hitTest`는 `flags.locked`를 통과한다.
- **포인터 드래그 관례가 이미 있다**: `FileTreePanel.tsx:700-830` — 5px 임계(`:712`), `elementFromPoint`→`closest("[data-tree-path]")`(`:719-723`), 자기 자손 안 거부(`:733-737`), 드롭 행 하이라이트 `DROP_HL` classList(`:456`, `:745-749`), 가장자리 auto-scroll `scrollTop ±10`(`:751-755`), 고스트(`:757-765`), Escape 취소(`:788-803`), 드래그 끝 click 1회 억제(`:777-783`), `pointercancel`/`blur` 정리(`:807-815`). 리스너는 `window`(`setPointerCapture` 없음)라 스크롤 컨테이너와 충돌하지 않는다. `DragGhost`(`:437-454`)는 **로컬 컴포넌트**(미export). 패널 폭 드래그는 `src/lib/use-panel-width.ts:8-46`.
- **HTML5 DnD**: `src-tauri/tauri.conf.json:13 windows: []` — 창은 전부 Rust 빌더. 메인 창만 `.disable_drag_drop_handler()`(`lib.rs:893`, 주석 `:889-892` "Windows(WebView2)에서 OS 핸들러가 HTML5 drag&drop 을 가로챈다"). **doc 창 빌더(`lib.rs:527-536`)와 플로팅 창 빌더(`:221-230`)에는 없다** — 제품 편집기가 사는 doc 창에서 HTML5 drop이 죽는다. interaction 축의 기각 근거("tauri.conf.json에 dragDropEnabled:false 없음")는 틀렸다. `src`에 `dragstart/onDragOver` 소비자는 현재 0건(grep) — 51의 에셋 카드 → 스테이지 드롭이 첫 소비자.
- **팝오버 프리미티브 없음**: `src/components/common/`은 Confirm/Prompt/QuickPick/EmptyState/ResizeHandle/Toast 등, 앵커 팝오버 0. 우클릭 메뉴 관례는 `ViewerFileTabs.tsx:121-131`(`fixed inset-0 z-50` 백드롭 + `innerWidth` 클램프). 45가 `Popover`를 정의하는데 44가 45보다 앞이다(INDEX 의존 `45←42,44`).
- **상대 시각 유틸**: `src/lib/format.ts:1-7 relativeTime` — `방금 전 / N초 전 / N분 전 / N시간 전`, 소비 6곳(StatusBar·MemoPanel·ProjectItem…). 시안 표기는 `방금`·`1분 전`.
- **e2e 전제**: `30:460-471 A.selCount`가 모달 안 `/^\s*(\d+)개 선택/`의 **가장 안쪽 마지막** 매치를 읽는다 — 푸터 `2개 선택됨`도 매치된다. `A.modal`은 `div.fixed.inset-0.z-50` + 텍스트 `이미지 편집`(30:34-36, 34:49-51). 합성 포인터 `A.pointerSeq`(30:315-330)는 `canvases()[1]` 전용. 스위트 번호: INDEX §10.4 "40 pro-ui"(42·43·44·45 공용).
- **시안 실측(.pen)**: Left Panel `264×fill`, Tabs h36, Search Row h38(필드 26 + `Btn 타입 필터` 26), Layers Header h30(`Title 레이어 · Count 11 · A eye · A lock · A folder-plus · A trash-2`), 행 h28(`Indent 13/depth · Chevron 11 · Type 12 · Name fs11 · Badge fs8 · Vis/Lock 12 op.45`, 선택 행 `$accent-soft`), `Rename Input` h22, `Drop Indicator` h2 `$accent`, `Drag Ghost` h28 op.75(`Grip · Type · Name`), Left Footer h32(`I · "2개 선택됨" · Hint "⇧클릭 · 드래그로 순서 변경"`). 히스토리: Filter Row h38(칩 3 + 아이콘), `Grp` h26(`C · "오늘 · 15:24"`), `H` 행 h34(`Rail 2 · I 13 · L · M · Cur "현재"`), Footer `Btn 되돌리기 · Btn 스냅샷 저장` h32. 타입 필터 팝오버 w236(`G1 타입 · Chk×7 · Sep · G2 · Chk×4 · Btn 초기화 · Btn 적용`, Chk h26). 아이콘 이름은 lucide(`lucide-react` 1.17 의존 — 위 26종 존재 확인).

## 3. 설계

### 3.1 행 데이터는 문서의 **뷰** — `layer-rows.ts`

| 대안 | 평가 |
|---|---|
| **A. `flattenLayers(doc, scene, collapsed)`가 `tree.childrenOf`로 역순 DFS(뒤가 위 = 패널 위)해 `LayerRow[]`를 만든다. 접기·검색·필터는 패널 로컬 state** (채택) | 문서(37)와 트리 연산(38) 위에 파생만 한다 — 새 자료구조 0. 검색·필터·접기는 다시 열면 초기화(Figma 동일) |
| B. `collapsed`·필터를 `EditorDoc`에 | undo에 접기 상태가 딸려가고 사이드카(41)에 UI 상태가 실린다 |
| C. 별도 `LayerNode{children}` 트리 유지(interaction 축 원안) | 평탄 DFS 배열이 정본(38 §3.1). 두 번째 트리는 동기화 버그의 자리 |

행 필드: `id · depth · node · name(node.name ?? defaultLayerName) · kind · hasChildren · collapsed · hidden(자기 또는 조상 `visible:false` — 표시 흐림용, DFS가 부모 값을 넘긴다) · locked(`scene.flags.get(id)?.locked` — 38의 효과적 잠금) · badges`. 마지막 행은 `__base`(`배경 — <파일명>`, 잠금 고정, 눈 없음). 인스턴스(37 자식 물질화)는 자식 행이 **펼쳐지지 않는다**(Figma 동일 — 안쪽 편집은 51 재정의 경로).

**기본 이름 `defaultLayerName(node, objects)`**: kind별 접두 + 같은 kind 안 문서 순서 번호(1-based). `rect 사각형 N · ellipse 타원 N · line 직선 N · arrow 화살표 N · pen 펜 N · highlight 형광펜 N · mosaic 모자이크 N · path 벡터 N · frame 프레임 N · group 그룹 N · instance 인스턴스 N(51이 컴포넌트 이름으로 대체) · badge 번호 뱃지 #<n> · text 텍스트 "<첫 20자>"`. 삭제 뒤 번호가 당겨지는 것은 Figma와 같다(문서에는 `name:null`만 저장). 41 §3.4 `describeChange`의 폴백 이름(`번호 뱃지 #3 이동`)이 **이 함수**를 import한다 — 41이 먼저 착수하면 이 함수 20줄만 선착.

**뱃지**: `mask`(node.mask≠null → `마스크`), `blend`(`blend!=='normal'` → 한국어 블렌드명, 그룹 기본 `pass-through`가 시안 `패스스루`), `nodeEdit`(42 `mode.kind==='nodeEdit' && mode.id===id` → `노드 편집`), `instance`(51 `instanceState(n, lib)` → `연결됨/재정의됨/분리됨`; 51 전에는 `인스턴스`).

### 3.2 검색·타입 필터 — `filterRows(rows, query, filter)`

- `query`: 이름 부분 일치(대소문자 무시). **매치 행 + 조상 행**만 남기고, query가 있으면 접기를 무시한다(호출자가 `collapsed`에 빈 Set을 넘긴다).
- `filter.types`(기본 7종 전부 on): kind → 타입 표 `frame→프레임 · group→그룹 · rect/ellipse/line/arrow/pen/highlight/badge/mosaic→도형 · text→텍스트 · fills에 type:'image'가 있는 노드 + 배경 행→이미지 · path→벡터 · instance→컴포넌트`. 상태 3(`숨김만·잠금만·재정의된 인스턴스`, 기본 off, AND)과 `마스크 포함`(기본 on — off면 `mask≠null` 제외). `재정의된 인스턴스` 판정은 51 `instanceState(n,lib)==='overridden'`을 `flattenLayers`의 `ctx.instanceState`로 받는다(51 전에는 인스턴스를 만드는 경로가 없어 0행 — 항목은 시안대로 둔다).
- 헤더 Count: 필터 없음 = `doc.objects.length`(배경 제외), 필터 중 = `매치/전체`.
- 팝오버 콘텐츠(`LayerTypeFilter`)는 **초안(draft)** 을 들고 `적용`에서만 패널 state에 쓴다, `초기화` = `DEFAULT_LAYER_FILTER`. 셸은 45 `Popover`(→ 45 §4). 44가 45보다 먼저 착수하면 `ViewerFileTabs.tsx:121-131` 관례(백드롭 div + 클램프)로 임시 마운트하고 45가 교체(diff ≈10줄) — 팝오버 프리미티브를 44가 새로 만들지 않는다.

### 3.3 이름 변경 · 눈/자물쇠 · 헤더 액션 — 전부 `applyDoc` 깔때기 1커밋

| 조작 | 구현 | 라벨 |
|---|---|---|
| F2 · 행 더블클릭 | 행 안 `<input>`(h22, 시안 Rename Input). Enter 확정, Esc 취소, blur 확정(textarea 규칙 `AnnotationLayer.tsx:827` 승계). 빈 문자열 = `name:null`(기본명 복귀) | `이름 변경` |
| 행 눈/자물쇠 | `patchNodes(objects,[id],{visible})` / `{locked}` — 노드 자기 필드만. 자손 전파는 38 `resolveScene`의 조상 규칙이 해 준다(자식 필드는 안 건드린다) | `숨김/표시` · `잠금/잠금 해제` |
| 헤더 eye/lock | 선택 전체에 `patchNodes`(선택 0이면 비활성) | 동일 |
| 헤더 folder-plus / trash-2 | 42 액션 맵의 `group`·`remove`(Ctrl+G·Delete와 **같은 핸들러**, → 42 §4) — 핸들러 본문은 38 `tree.group/remove` 1줄 | `그룹`·`삭제` |

`patchNodes`는 `objects.map`이라 순서를 바꾸지 않는다 — "재배열은 tree.ts만" 규칙(INDEX §10.4)과 무관. F2는 42 단축키 표의 `rename` 행(interaction-6 표)이 `LayerPanelHandle.startRename()`을 부른다(캔버스 포커스에서도 동작).

### 3.4 선택·호버 동기 — 42 스토어 하나

- 행 클릭 `select([id])`, ⇧/Ctrl+클릭 `select([id],{toggle:true})` — 캔버스 규칙(`AnnotationLayer.tsx:439-443` Shift 토글)과 같다. 범위 선택은 시안에 없어 넣지 않는다. **배경 행** 클릭 = `select(['__base'])` 단독(⇧/Ctrl 토글 무시, 노드 선택 시 해제) — 45 `image` 컨텍스트 바의 진입 조건(정합 검사 결정). 그룹 행 = 그룹 id(38 `topLevelAncestor` 단위와 일치), 자식 행 = 자식 id(깊은 선택). 배경 행 클릭 = `select([])`(캔버스 빈 곳과 동일; 45가 `'__base'` 선택 단위를 도입하면 그때 행이 그 id를 넣는다 → 45 §3.1).
- 캔버스 선택 변경 → 마지막 선택 행 `scrollIntoView({block:'nearest'})`.
- 호버: 행 `onPointerEnter/Leave` → `setHover(id|null)` 뒤 `layerRef.renderOnce()`(43 크롬은 스토어를 구독하지 않고 `paintNow`에서 `getState()`로 읽는다 — 43 §6); 캔버스 pointermove(37 분할 뒤 `annotation/pointer.ts`, 현 `updateHoverCursor :507-524`) → `hitTest(scene, x, y, scale)` → **값이 바뀔 때만** `setHover`. 행은 `useImageEditorUi(s => s.hoverId === id)`·`s.selectedIds.includes(id)` 셀렉터로 **그 행만** 리렌더. 캔버스 쪽 호버 아웃라인은 43 `ChromeState`가 `hoverId`를 읽어 그린다(→ 43 §4) — 44는 상태만 만든다. `:501-506` K4 주석은 "38 WeakMap 메모로 해제"로 갱신.

### 3.5 드래그 순서 변경 — `useLayerDrag` (FileTreePanel 관례 이식)

| 대안 | 평가 |
|---|---|
| **A. 포인터 이벤트 자체 구현 — `FileTreePanel.tsx:700-830` 흐름을 그대로 옮긴다(임계 5px·`elementFromPoint`·`window` 리스너·Escape·click 억제·auto-scroll)** (채택) | 저장소의 유일한 드래그 관례. 다중 선택·고스트·취소가 이미 검증돼 있다 |
| B. HTML5 DnD | doc 창에서 죽는다(§2). §3.7의 Rust 1줄 뒤에는 되지만, 행 드래그는 고스트·자동 스크롤·Escape를 어차피 직접 만든다 |
| C. dnd-kit | 신규 의존 ≈40KB — 이 앱 드래그는 전부 포인터(패널 폭·창·주석·파일트리) |

- 드래그 대상: 잡은 행이 선택 안에 있으면 선택 전체(문서 순 정렬), 아니면 그 행. 배경 행·인스턴스 자식은 불가.
- 드롭 판정(`dropTarget`): 포인터 아래 행 R(`closest("[data-layer-id]")`)의 rect에서 위 25% = **R 위**, 아래 25% = **R 아래**, 가운데 50%는 R이 그룹/프레임이면 **안으로**(자식 맨 위), 아니면 가까운 쪽. 순환(`tree.ancestorsOf(R)`에 드래그 id 포함)·인스턴스 안·배경 아래는 `null`(고스트 "여기로는 이동할 수 없습니다").
- 문서 인덱스 변환(뒤가 위): R의 부모 P, R의 `childrenOf(P)` 내 문서 순서 k → **R 위** = `k+1`, **R 아래** = `k`, **안으로** C = `childrenOf(C).length`. 커밋 `tree.reparent(objects, ids, parentId, index)` 1회(38 §4 — `index`는 이동 후 문서 순 형제 위치; 의미가 다르면 38에 맞춘다), 라벨 `순서 변경`.
- 표시: `Drop Indicator` = 2px 절대배치 div(행 경계, 들여쓰기 반영), 안으로 = 대상 행에 `DROP_HL` classList(FileTreePanel `:456`). `Drag Ghost` = `FileTreePanel`의 `DragGhost`(`:437-454`)를 `src/components/common/DragGhost.tsx`로 **승격**(두 번째 소비자) — 라벨 = 행 이름 또는 `N개 항목`, 대상 문구 `→ <부모 이름> 안`/`→ 최상위`. 드래그 중 리렌더는 고스트·인디케이터 ref 갱신뿐(React state 0 — FileTreePanel과 같은 이유).
- auto-scroll: 컨테이너 상하 28px에서 `scrollTop ±10`(`:751-755`). `window` 리스너라 포인터 캡처 충돌이 없다.

### 3.6 히스토리 탭 — 41 API의 표시

- 데이터: `entries`(41, 최신이 위)·`cursor`·`persist.listSnapshots()`. 필터 칩 `전체 / 내 작업 / 스냅샷` — `내 작업` = 자동 커밋 제외(`isAutoLabel(label)`: 51이 붙이는 `스타일 갱신`·`컴포넌트 갱신` 접두 — `ponytail: 문자열 접두 비교, 자동 라벨이 셋 이상이면 HistoryEntry 플래그로`), `스냅샷` = 명명 스냅샷만.
- 그룹 헤더: 날짜가 바뀌거나 직전 항목과 **10분 초과** 간격이면 새 그룹, 제목 `오늘 · HH:MM`/`어제 · HH:MM`/`M월 D일 · HH:MM`(그룹 최신 시각) — 시안 `오늘 · 15:24`(방금~5분 전)·`오늘 · 14:50`(32~41분 전)·`어제`가 이 규칙으로 나온다.
- 행(h34): 세로 Rail(현재 이후 = redo 가능 → op .5), 라벨, `relativeTime(at)`(`format.ts:1` — `방금 전`은 시안 `방금`과 한 글자 다르다, 유틸을 바꾸지 않는다), `현재` 배지(`i===cursor`), readonly(이전 세션 로그)는 `text-fg-dim` + 클릭 no-op(41). 클릭 = `jumpTo(i)`; 스냅샷 행 클릭 = `loadSnapshot(i)`(41이 `스냅샷 복원` 커밋).
- 푸터: `되돌리기` = 42 액션 `undo`(Ctrl+Z와 같은 핸들러), `스냅샷 저장` = `askPrompt`(기존 PromptHost, `ImageEditor.tsx:816` 관례) → `persist.saveSnapshot(name)` → 목록 재조회. 20개 상한 초과 토스트는 41.
- 갱신: `histVer` 의존으로 `ImageEditor`가 `{entries, cursor}`를 props로 내려준다(내부 배열 참조를 직접 구독하지 않는다). 상대 시각은 탭이 보일 때 60s 간격 `setInterval` 1개.

### 3.7 에셋 탭 슬롯 · Rust 1줄

- 에셋 탭: 42 `LeftPanel`의 `'assets'` 슬롯에 51 `AssetsPanel`(→ 51 §3.8)을 마운트. 51 전에는 `common/EmptyState`(`icon: Component, title: '로컬 컴포넌트가 없습니다'`) — 참인 문장만 보인다.
- `lib.rs open_doc_window` 빌더(`:527-536`)에 `.disable_drag_drop_handler()` 1줄(메인 `:893`과 같은 주석 인용) — 51의 에셋 카드 → 스테이지 HTML5 drop이 doc 창에서 살아난다. 플로팅 터미널 창(`:221-230`)은 HTML5 DnD 소비자가 없어 손대지 않는다.

### 3.8 만들지 않는 것

- 가상화 라이브러리: 행 28px × 6 DOM, 현실 상한 수백 행. 행에 `content-visibility:auto; contain-intrinsic-size:auto 28px` 인라인 2줄(화면 밖 행 레이아웃 생략). `ponytail: 3,000행 초과 실측이 나오면 scrollTop 창 렌더 40줄`.
- Shift 범위 선택·행 우클릭 메뉴·색 태그·검색어 하이라이트·키보드 화살표 탐색(시안에 없음), 세션 간 undo(INDEX §10.5), 히스토리 항목 diff 미리보기.
- 단축키(→ 42 표: Ctrl+G·Ctrl+Shift+G·Delete·F2 — Ctrl+Shift+H/L 은 시안에 없어 42 가 넣지 않는다, 눈/자물쇠 클릭이 대신), 캔버스 호버 아웃라인 그리기(→ 43), 에셋 콘텐츠·인스턴스 상태 판정(→ 51), 트리 연산 본체(→ 38), 히스토리 모델·스냅샷 영속(→ 41), 팝오버 프리미티브(→ 45).

## 4. 계약 (소유: 44)

```ts
// src/lib/annotate/layer-rows.ts — 순수(DOM 없음)
export type LayerType = 'frame'|'group'|'shape'|'text'|'image'|'vector'|'component';
export type LayerBadge = { kind:'mask' } | { kind:'blend'; label:string } | { kind:'nodeEdit' } | { kind:'instance'; state:'linked'|'overridden'|'detached'|null };
export interface LayerRow { id: ObjId|'__base'; depth: number; node: Node|null; name: string; type: LayerType; hasChildren: boolean; collapsed: boolean; hidden: boolean; locked: boolean; badges: LayerBadge[] }
export interface LayerFilter { types: ReadonlySet<LayerType>; hiddenOnly: boolean; lockedOnly: boolean; overriddenOnly: boolean; includeMasks: boolean }
export const DEFAULT_LAYER_FILTER: LayerFilter;                                   // 7종 on · 상태 off · includeMasks on
export type InstanceBadgeState = 'linked'|'overridden'|'detached';                 // 51 instanceState 반환값과 동일 철자
export function flattenLayers(doc: EditorDoc, scene: Scene, collapsed: ReadonlySet<ObjId>,
  ctx: { baseName: string; nodeEditId: ObjId|null; instanceState?: (n: InstanceNode) => InstanceBadgeState }): LayerRow[];   // instanceState 없으면 뱃지 state:null('인스턴스')
export function filterRows(rows: readonly LayerRow[], query: string, f: LayerFilter): LayerRow[];   // 매치 + 조상
export function defaultLayerName(node: Node, objects: readonly Node[]): string;                      // 41 describeChange 도 import
export function layerTypeOf(node: Node): LayerType;
export function patchNodes(objects: readonly Node[], ids: readonly ObjId[], patch: Partial<Pick<NodeBase,'name'|'visible'|'locked'>>): Node[];
export function dropTarget(rows: readonly LayerRow[], objects: readonly Node[], dragIds: readonly ObjId[], row: LayerRow, yRatio: number)
  : { parentId: ObjId|null; index: number; pos:'before'|'after'|'inside'; rowId: ObjId } | null;   // 순환·인스턴스 안·배경 아래 → null

// src/components/image/layers/LayerPanel.tsx
export interface LayerPanelHandle { startRename(id?: ObjId): void }
export interface LayerPanelProps {
  doc: EditorDoc; scene: Scene; baseName: string;
  onCommit(objects: Node[], label: string): void;                                  // ImageEditor patchDoc({objects},'commit',label) (41 라벨 계약)
  actions: { group(): void; remove(): void };                                      // 42 액션 맵의 같은 핸들러(Ctrl+G · Delete)
}
// 내부 state: query · filter · collapsed:Set · renamingId · filterOpen. 선택/호버는 useImageEditorUi(42 §4: selectedIds · hoverId · select(ids,{toggle?}) · setHover).
// DOM: <div role="tree"> 안 행 <div role="treeitem" data-layer-id={id} aria-level aria-expanded aria-selected style={{height:28}}>
// src/components/image/layers/LayerRow.tsx      — memo, 행 단위 셀렉터 구독
// src/components/image/layers/useLayerDrag.ts   — (containerRef, getRows, getObjects, onDrop(target, ids)) → onRowPointerDown
// src/components/image/layers/LayerTypeFilter.tsx — { value: LayerFilter; onApply(f) } (45 Popover 콘텐츠)
// src/components/image/panels/HistoryPanel.tsx  — { entries: readonly HistoryEntry[]; cursor: number; snapshots: {name;at}[]; onJump(i); onLoadSnapshot(i); onSaveSnapshot(); onUndo() }
// src/components/common/DragGhost.tsx           — FileTreePanel.tsx:434-454 이동·export ({ label; dest: string|null } 유지)
```

```rust
// src-tauri/src/lib.rs open_doc_window 빌더(:527-536): .disable_drag_drop_handler() 1줄 — 메인 창(:893) 주석 인용
```

e2e 훅(`window.__gpv.imageEditor`, 기존 `ImageEditor.tsx:951-964` 옆): `layers(): { rows: { id; depth; name; hidden; locked; badges: string[] }[]; count: number }` · `panel: { setQuery(q); setFilter(patch: Partial<LayerFilter>); toggleCollapsed(id); startRename(id) }`. 히스토리 훅은 41 `history.*` 그대로. 42 스토어(`getUi()`)로 `selectedIds/hoverId`를 읽는다.

## 5. 단계

1. **`common/DragGhost.tsx` 승격**(FileTreePanel −20/+2) + **Rust 1줄**(`lib.rs` +1, 다음 재빌드 배치에 편승). 15·34 회귀.
2. **`layer-rows.ts`**(≈130) + **`LayerRow`/`LayerPanel`**(≈140+≈220) — 행·검색·접기·선택·호버(패널 쪽)·이름 변경·눈/자물쇠·헤더 액션·푸터·배경 행. 42 `LeftPanel` `'layers'` 슬롯 마운트, `ImageEditor` props 배선(+25). e2e (L-1)~(L-5).
3. **`LayerTypeFilter`**(≈110) + **`useLayerDrag`**(≈170) + Drop Indicator. e2e (L-6)(L-7).
4. **캔버스 호버 배선**: pointer 모듈 +15(`hitTest`→`setHover`, K4 주석 갱신), 선택 시 `scrollIntoView` +6. e2e (L-8).
5. **`HistoryPanel`**(≈180) + `ImageEditor` 배선(`entries/cursor/snapshots` props, 스냅샷 저장 프롬프트, +30). e2e (H-1)~(H-4).
6. 에셋 탭 `EmptyState`(+6) · `__gpv` 훅(+20) · e2e `40-image-editor-pro-ui.mjs`에 (L)(H) 케이스 추가(42가 신설한 스위트; 42보다 먼저 착수하면 이 태스크가 신설 + `run.mjs` 1줄) · `00-INDEX` 행.

규모 **L**: 프론트 ≈ +1,050/−25 · Rust +1 · 신규 의존 0.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| `A.selCount` 이중 매치 | 푸터 `2개 선택됨`이 30의 `/^\s*(\d+)개 선택/`에 잡힌다(가장 안쪽 마지막 매치) | 값의 원천이 같은 `selectedIds.length`라 어느 쪽이 잡혀도 동일. e2e (L-3)가 두 문구 일치를 단언 |
| 호버 `setHover` 폭주 | 캔버스 pointermove마다 스토어 set → 전 행 셀렉터 실행 | 값이 바뀔 때만 set(전이당 1회). `hitTest`는 38 WeakMap 메모라 Path2D 생성 0 |
| `reparent` `index` 의미 불일치 | 38 시그니처만 있고 "이동 후/전" 의미가 문서에 없다 | §3.5 변환식은 "이동 후 문서 순 형제 위치"로 고정, e2e (L-7)가 결과 순서를 단언 — 어긋나면 변환식 한 곳만 고친다 |
| 드래그 중 스크롤 | 컨테이너 스크롤과 포인터 캡처 충돌 | `window` 리스너 + `scrollTop` 직접(FileTreePanel `:751-755`), 캡처 사용 안 함 |
| `content-visibility`와 rect | 화면 밖 행 `getBoundingClientRect` 0 | 드롭 판정은 `elementFromPoint`가 돌려준 **화면 안** 행의 rect만 읽는다 |
| 42 액션 맵 부재 | `group/remove/undo` 핸들러 이름이 42에서 다르게 나온다 | props 주입이라 이름만 맞춘다. 없으면 `ImageEditor`에 `tree.group/remove` 1줄 래퍼 |
| 45 `Popover` 선후 | 타입 필터 셸이 없다 | `ViewerFileTabs` 관례 백드롭으로 임시, 45가 교체(≈10줄) |
| 기본 이름 번호 밀림 | 삭제 뒤 `사각형 3`이 `사각형 2`가 된다 | Figma 동일. 저장은 `name:null`이라 문서 영향 0. 히스토리 라벨은 커밋 시점 문자열이라 불변 |
| 히스토리 `entries` 참조 | `DocHistory` 내부 배열 직접 구독 시 리렌더 누락 | `histVer` 의존(`ImageEditor.tsx:204`)으로 render 시 읽어 props로 전달 |
| 인스턴스 자식 행 | 37 물질화 자식이 행으로 새면 개별 선택된다 | `flattenLayers`가 instance 아래로 내려가지 않는다(e2e (L-9)) |

## 7. 검증

- **e2e 40 (L)**: (L-1) `setDoc` 리프 5개(rect·ellipse·text·badge n=3·mosaic) → `layers().rows` 6행(배경 최하단·`locked`), 이름 `사각형 1 · 타원 1 · 텍스트 "e2e" · 번호 뱃지 #3 · 모자이크 1`, DOM `[role=treeitem]` 6, 행 높이 28. (L-2) `group([a,b])`(38 훅) → 그룹 행 `depth 0`·자식 `depth 1`·뱃지 `패스스루`; `toggleCollapsed(g)` → 자식 행 DOM 0, `setQuery('타원')` → 접기 무시·타원+조상만. (L-3) 행 클릭 → `getUi().selectedIds===[id]`·`selCount()===1`, ⇧클릭 → 2·푸터 텍스트 `2개 선택됨`; 잠금 노드 행 클릭 → 선택됨(캔버스 클릭은 38 (d)대로 0). (L-4) F2 → `input` → `검사 영역` + Enter → `getDoc()` 노드 `name==='검사 영역'`·행 텍스트 갱신·히스토리 라벨 `이름 변경`; Esc → 무변경. (L-5) 행 눈 클릭 → `visible:false`·프리뷰 `[1]` 해당 좌표 원본색·저장본 동일·행 흐림; 헤더 자물쇠(선택 2) → 둘 다 `locked:true`; 헤더 휴지통 → 삭제·Ctrl+Z 복원. (L-6) 타입 필터 `텍스트`만 → 텍스트 행만, `숨김만` → 숨긴 행만, `초기화` → 전부, Count `1/5` 표기. (L-7) 행 2를 행 4 아래로 합성 포인터 드래그(`[data-layer-id]`에 pointerdown → window pointermove(임계 초과·대상 행 하단 25%) → pointerup) → `getDoc().objects` 순서 = 기대 순서(§3.5 변환식), 히스토리 1칸 `순서 변경`, Ctrl+Z 원복; 그룹 행 가운데로 드롭 → `parentId===g`; 그룹을 자기 자식 위로 드롭 → 무변경. (L-8) 캔버스 `pointermove`(객체 위) → `getUi().hoverId===id`·그 행 hover 클래스, React Profiler 커밋 대상 ≤2행; 빈 곳 → `null`. (L-9) `setDoc` instance(자식 2 물질화) → 행 1개·자식 행 0·뱃지 `인스턴스`.
- **e2e 40 (H)**: (H-1) 커밋 3회(생성·이동·이름 변경) → 히스토리 탭 행 4(`이미지 열기` 포함)·최신이 위·`현재` 배지가 0번 행; (H-2) 2번째 행 클릭 → `history.cursor()` 일치·`getDoc()`이 그 스냅샷과 딥이퀄·그 위 행 op .5(redo 가능), 새 커밋 → 흐린 행 제거; (H-3) `스냅샷 저장` → 프롬프트 `1차 검토본` → `스냅샷` 필터에 행 1, 객체 삭제 후 행 클릭 → 복원 + 라벨 `스냅샷 복원`; (H-4) `at`을 `Date.now()-25*60e3`로 합성한 항목 → 그룹 헤더 2개(`오늘 · HH:MM` ×2), readonly 항목 클릭 → `cursor` 불변; `되돌리기` → `cursor−1`.
- **회귀**: 30(91)·34(32)·35(13) 단언 수·pass 동일(패널은 `A.modal` 안에 있지만 `canvases()` 순서·`selCount` 값 불변). 15(45)·34: `DragGhost` 승격 뒤 파일트리 드래그 e2e 무변경.
- **Rust**: `cargo test` 기존 라벨 테스트 통과, doc 창 빌더 diff 1줄.
- **실기**: 4K 픽스처 펜 획 300개 → 패널 스크롤 60fps(Performance 트레이스 long task 0)·첫 렌더 <50ms; doc 창에서 51 스타일 카드 HTML5 drop이 `drop` 이벤트를 받는지(Rust 1줄 검증 — 51 착수 전에는 임시 `ondrop` 콘솔 로그로 1회); 그룹 3단 중첩에서 드래그 안으로/밖으로·Escape 취소·자동 스크롤.
