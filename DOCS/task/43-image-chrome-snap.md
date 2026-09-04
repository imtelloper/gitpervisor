# 태스크 43 — SVG 크롬 오버레이·눈금자·가이드·스냅 엔진·스마트 가이드·Alt 측정·측정 도구·픽셀 그리드

> 상태: 설계(Design) · 대상: gitpervisor · 근거: 코드 실측 2026-09-04(워킹트리) · 선행: 태스크 40(디테일 캔버스 `[2]`·z 순서), 42(UI 스토어 `toggles`·모드·단축키 표·상태바),
> 38(`selectBox/hitTest/nodeAABB/buildObjectPath` WeakMap), 37(`EditorDoc.guides`·AnnotationLayer 4모듈 분할) · `DOCS/image-annotation-design.md` §4.3(캔버스 크롬 — 이 문서가 폐기)·K3(스냅 기각 — 사용자 결정으로 대체),
> `DOCS/pro-image-editor-design.md` §8(좌표 드리프트) · 시안: `designs/image-editor-figma-v2.pen` ①(눈금자·가이드·스마트 가이드·Alt 측정·치수 뱃지·줌 필)③(픽셀/오브젝트 스냅)⑦(스냅·가이드 섹션·픽셀 그리드·크롭 오버레이) · 상위: `00-INDEX.md` §10 — **M2 셋째 태스크(L).**

## 1. 요구사항

시안 라벨(`.pen` 노드명은 괄호):
- ① 눈금자 `0 · 100 · 200 · … · 1200`(`Ruler Row` h=22 · `Ruler Corner` 22×22 · `Ruler H` h=22 · `Ruler V` w=22, `$ruler #18181B`), 선택 범위 강조(`Ruler Sel Range`, `$accent-soft`), 가이드(`Guide V` x=560 · `Guide H` y=497, `$danger #EF4444` α.55), 치수 뱃지 `220 × 230`(`Dim Badge`, `$sel #3B82F6` 흰 글자), 스마트 가이드(`Smart Guide V/V2`, `$smart #F0398B`) + 간격 뱃지 `50 · 151 · 529`(`Gap Badge/Left/Right Badge`) + 툴팁 `Alt 호버 · 간격 50px · 좌 151 / 우 529`(`Measure Tooltip`), `Zoom Pill`(`Z minus · 70% · Z plus`, 캔버스 우하단), 상태바 `스냅 · 스마트 가이드 · 픽셀 그리드 · 눈금자 · 가이드 표시`, `센서 정렬 오차 확인`(측정 대상 객체 이름).
- ⑦ 인스펙터 `Sec 스냅 · 가이드`: `픽셀 그리드에 스냅 (1px) · 오브젝트에 스냅 · 가이드에 스냅 · 스마트 가이드 · 간격 표시 · 눈금자 표시 · 그리드 8px · 임계값 4px`. 인셋 `픽셀 그리드 400% · 1px 단위 스냅`(`Snap Cell` `$smart` 2px 테두리, `Guide Left/Mid` `$smart`, `Gap 46 · Gap 34`).
- ⑦ 크롭 오버레이 `3분할 · 4분할 · 황금비 · 대각선`(`Dim Top/Left/Right/Bottom · Crop Rect · Third V/H · Corner H/Edge H` 핸들 · `Crop Badge "2400 × 1600 · 3:2 · 직선화 1.4°"`).
- ③ 노드 편집 컨텍스트 바 `픽셀에 스냅 · 오브젝트에 스냅`(47이 이 태스크의 `snapPoint`를 부른다), 레일 `측정` 도구, ⑤ 컴포넌트 이름 `측정 라벨`(측정 도구 산출물 이름 관례).

받아들이는 조건:
- 화면 크롬(선택 상자·핸들·마퀴·HUD·호버·크롭 오버레이·가이드·스마트 가이드·측정·눈금자·픽셀 그리드)이 **어느 줌에서도 1px 선·8px 핸들**로 보이고, 40의 디테일 캔버스 `[2]`가 켜져도 가려지지 않는다.
- 크롬은 저장·내보내기 어디에도 새지 않는다 — 렌더 진입(`renderScene`, 39)과 완전히 분리된 DOM이다. e2e 30 (o-4)(p-5)가 그대로 성립한다.
- 드래그(이동·리사이즈·그리기 두 점·노드·크롭 핸들)가 가이드 › 오브젝트 › 그리드 순으로 **정확한 값**에 붙고, 임계값(기본 4 css px)은 줌에 따라 oriented px로 환산된다. Alt 드래그는 스냅을 끈다. 등간격 배치가 감지되면 간격 뱃지가 뜬다.
- 가이드는 문서(`EditorDoc.guides`, 37)에 살아 undo·사이드카(41)를 공짜로 탄다. 눈금자에서 끌어내 만들고, 끌어서 옮기고, 이미지 밖으로 끌어내거나 Delete로 지운다.
- Alt 홀드 호버가 선택과 호버 대상(없으면 캔버스 경계) 사이 거리를 보여 준다. 측정 도구는 두 점을 찍어 `측정 라벨` 그룹(선+텍스트)을 1커밋으로 만든다.
- 픽셀 그리드는 화면 배율 ≥ 400%에서만, 캔버스 메모리 0으로 그린다.
- 포인터·커서는 종전대로 씬 캔버스 `[1]`이 받는다 — e2e 30 `pointerSeq`(`:315-369`)·`cursor()`(`:390-393`)·34·35 헬퍼 무수정, 단언 수 91/32/13 불변.

## 2. 현황(근거)

- **크롬은 주석 캔버스 위에 백킹 해상도로 그려진다**: `AnnotationLayer.tsx:292-295 paintNow`가 캐시 블릿 뒤 `drawSelection`(`:914-973`)·`drawMarquee`(`:1096-1114`)·`drawHud`(`:1009-1076`)·`drawCropOverlay`(`:976-1000`)를 부른다. 크기 보정은 `k = scale / displayScale`(`:930`·`:1054`·`:1104`) — 백킹이 MAX_PREVIEW 1800(`ImageEditor.tsx:64`·`:372-376`)이라 4K를 400%로 확대하면 1px 선이 화면 4px 이상으로 뭉개지고, 40 §3.1이 그 확대 순간에 `[2]`를 `[1]` **위에** 띄우므로 캔버스 크롬은 편집하려고 확대하는 바로 그때 사라진다(`ImageEditor.tsx:1085`가 이미 `screenScale >= 2`에서 `pixelated`로 갈아타는 자리). 37 §3.5가 이 함수들을 `annotation/chrome.ts`로 옮겨 두고 "43이 SVG로 이전 후 삭제"라 적었다.
- **크롬 갱신 규칙은 이미 "React state 금지"다**: `AnnotationLayer.tsx:501-506 updateHoverCursor` 주석 — 매 mousemove 리렌더는 `useLayoutEffect` 의존성(`:308-323`)을 매번 돌려 `schedule`을 폭주시킨다. 호버 히트를 안 부른 이유(K4, `:504-505`)는 `buildObjectPath`가 호출마다 Path2D를 만들기 때문인데, 38 §3.3이 이를 `WeakMap` 메모로 바꿔 hover 히트 비용이 `isPointInPath` N회로 떨어진다.
- **스냅·가이드·눈금자·측정은 없다**: `grep snap|guide|ruler` — `snapAngle`(`geometry.ts:88-102`, Shift 15° 각도 스냅)뿐. `drawHud` 상단 주석(`:1002-1006`)이 원 설계 K3("스냅은 저항이다")를 근거로 수치 HUD를 대신 넣었다 — 사용자 결정(전문 기능 전부)으로 대체된 항목이지만 "임계 4px·Alt 해제·토글"로 K3의 우려는 흡수한다(§3.4).
- **드래그 갱신점은 하나다**: `applyDragAt`(`:536-563`) — move(`:556-561`, `translateObject` 델타), resize(`:562`), draw(`:546-555`, `makeDraft`/`appendPenPoint`)가 전부 여기서 라이브 객체를 만든다. 스냅을 끼울 자리가 한 곳이라는 뜻이고, 펜/형광펜은 `appendPenPoint`(`:550`) 경로라 자연히 제외된다.
- **좌표 프레임**: 줌은 CSS transform 한 겹(`ImageEditor.tsx:1071-1078`, `boxRef`가 변환 밖 앵커 `:231`), `screenScale = displayScale · view.scale`(`:400`), stage는 `checkerboard … p-4 overflow-hidden` flex 중앙 정렬(`:1054-1061`) + `ResizeObserver`(`:381-389`). 팬은 stage 가운데 버튼(`:424-446`), 휠은 stage non-passive(`:409-422`). 변환 안쪽 DOM은 줌을 두 번 먹는다(`AnnotationLayer.tsx:778-779` textarea가 `zoom`으로 되나눈다) — 크롬을 transform 안에 두면 같은 함정을 항목마다 반복한다.
- **오브젝트 AABB 계산 비용**: `objectAABB`(`geometry.ts:337-356`)는 text에서 `layoutText → measureText`(`:302-305`)를 부른다. 스냅 후보를 매 pointermove마다 전 객체에서 다시 뽑으면 텍스트 N개 × 60fps다 — 드래그 시작 시 1회 인덱스가 필요하다.
- **마퀴·HUD 관례**: 마퀴는 `objectAABB` 교차(`:597`), HUD 배경 `rgba(20,20,24,0.85)` 11px(`:1055-1073`), 핸들 `HANDLE_CSS 8`·집기 `HANDLE_GRAB_CSS 10`(`:61-63`), `SELECT_COLOR #4fa3ff`(`:67`). 시안 색은 `$sel #3B82F6`·`$smart #F0398B`·`$danger #EF4444`·`$ruler #18181B`(`.pen:48094-48137`). e2e는 크롬 색을 픽셀로 읽지 않는다(30·34·35 grep — `px(1,…)`는 주석 색·알파만).
- **e2e 계약**: 30 (o-4) `:1568` "저장본에 마퀴 사각형이 없다", (p-5) `:1644-1658` "저장본에 HUD 라벨이 없다(드래그 중 저장)", (p-1) `:1583-1589` SE 핸들 호버 `nwse-resize`. 35 `A.rect()`(`:58-63`)·`A.backing()`(`:51-55`)은 `canvases()[0][1]`만 본다 — SVG는 `canvas`가 아니라 개수 계약에 안 잡힌다. `A.modal()`(30 `:34-36`)은 `textContent`에 `/이미지 편집/`만 요구한다.
- **DEV 훅**: `ImageEditor.tsx:951-964` `window.__gpv.imageEditor = {getDoc,setDoc,setTool,renderOnce}` — 크롬 상태·스냅 함수 노출 자리.
- **e2e 번호**: INDEX §10.4 — 40 pro-ui(42 소유). 이 태스크의 단언은 40에 추가한다(작성 지시 "e2e 40 +").

## 3. 설계

### 3.1 크롬을 어디에 그리나 — **화면 공간 SVG 오버레이 하나 + CSS 픽셀 그리드**

| 대안 | 평가 |
|---|---|
| **A. stage 안 `absolute inset-0` `<svg>`(transform **밖**, `pointer-events:none`) + 픽셀 그리드는 `repeating-linear-gradient` div** (채택) | 화면 px 그대로 → 어느 줌에서도 1px·8px, `[2]` 위(z 3)라 확대 시에도 보인다. 캔버스 메모리 0, 저장 경로에 구조적으로 없다. 눈금자 라벨은 `<text>` |
| B. 씬 캔버스 `[1]`에 계속(현행) | 백킹 해상도라 확대 시 뭉개짐(§2), 40의 `[2]`가 덮는다. 픽셀 그리드 400개 선을 매 프레임 stroke |
| C. 별도 화면 캔버스 | 뷰포트×dpr(1920×1080×1.5² ≈ 19MB) 상주 + 매 프레임 전체 clear/redraw. SVG는 바뀐 속성만 다시 래스터 |
| D. transform 안쪽 DOM div | 줌을 두 번 먹는 함정(`AnnotationLayer.tsx:778-779`)을 항목마다 반복, 1px 선이 줌에 따라 굵어진다 |
| E. 픽셀 그리드를 SVG `<pattern>` | 큰 영역 타일링 재래스터 비용(추정). CSS 그라디언트는 컴포지터가 GPU에서 채운다 |

포인터·커서는 **옮기지 않는다**: `[1]`이 계속 받고(`hitHandle` 좌표 비교, `canvas.style.cursor`), SVG는 `pointer-events:none`. 예외는 눈금자 띠 두 줄뿐(`pointer-events:auto` — 가이드 끌어내기 §3.6). e2e 30 `pointerSeq`가 `canvases()[1]`에 디스패치하고 `cursor()`가 `[1].style.cursor`를 읽는 계약이 그대로 산다.

눈금자는 stage 가장자리에 **겹쳐** 그린다(Figma 동일). `fit`·`dispW/dispH`(`ImageEditor.tsx:391-397`)를 안 건드리므로 35 `rect()` 단언과 30 `pointerSeq`의 비례 좌표가 무영향이다. stage `p-4`(16px) 덕에 맞춤 상태에서 이미지 가장자리 6px만 눈금자 아래 들어간다 — 대안(눈금자 켜면 stage 패딩 22)은 토글마다 `fit`이 바뀌어 e2e 35의 줌 앵커 단언이 토글 기본값에 종속된다 → 탈락.

### 3.2 갱신 경로 — `ChromeOverlayHandle.update(state)`를 rAF 안에서, React state 0

`paintNow`(AnnotationLayer, 37 분할 뒤 남는 본체) 끝에서 `chrome.update(buildChromeState(...))` 한 번. `ChromeOverlay`는 `forwardRef`로 SVG 자식 요소 ref를 들고 **속성만 직접 쓴다**(`setAttribute`/`textContent`) — `useState` 0. 현행 "매 mousemove 리렌더 금지"(`:501-506`) 규칙의 연장이다. 항목별 요소는 고정 슬롯(핸들 8·마퀴 1·HUD 1·크롭 딤 4+선 6+핸들 8·눈금자 tick 풀)이고 개수가 가변인 것(선택 N·가이드·스마트 가이드·측정·extra)만 자식 배열을 diff 없이 `replaceChildren`한다 — 드래그 프레임에서 바뀌는 건 선택 N + 스마트 가이드 ≤ 4개뿐이라 DOM 쓰기 수십 회다.

**화면 변환은 산술로 끝난다** — `getBoundingClientRect` 0회:
```
screen = { scale: displayScale · view.scale,
           x: (stage.w − dispW) / 2 + view.x,      // stage 는 flex 중앙 정렬 + p-4 → 콘텐츠 박스 중앙 = (clientW − dispW)/2
           y: (stage.h − dispH) / 2 + view.y,
           w: stage.w, h: stage.h, ow, oh }
css(x,y) = (screen.x + x·screen.scale, screen.y + y·screen.scale)
```
`stage`는 기존 `ResizeObserver` 값(`:380-389`), `dispW/dispH`·`view`는 기존 state — ImageEditor가 `screen`을 prop으로 넘긴다. 눈금자·가이드는 **oriented px가 정본**이고 화면 px는 표시 시점에만 곱한다(좌표 드리프트 표면 0 — 줌 한 겹 계약 유지).

z 순서 상수는 한 곳: `STAGE_Z = { detail: 1, box: 2, chrome: 3 }`(`ChromeOverlay.tsx` export, 40 `DetailCanvas`·ImageEditor 박스가 import).

### 3.3 크롬 항목표

| 항목(`data-chrome`) | 원천 | 그리기 |
|---|---|---|
| `selection` | 42 `selectedIds` × 38 `selectBox(scene, ids)` | 리프 1개: 회전 상자(`rotate(rot cx cy)`) + 핸들 8(`8×8` css px, 흰 채움·`$sel` 테두리, 위치는 `handlePointsOf`와 같은 `rotatePoint(…, objectAnchor)`). 다중/컨테이너: 객체별 점선 AABB + 합집합 실선(핸들 없음 — 현행 규칙 `:941-943`) |
| `hover` | 42 `hoverId`(44 레이어 패널 ↔ 캔버스 호버 동기) | 1px `$sel` 실선 AABB |
| `marquee` | `DragState.marquee` | `rgba(59,130,246,.12)` 채움 + 점선 |
| `hud` | 선택 합집합·드래그 상태 | 시안 `Dim Badge`: 선택이 있으면 항상 `W × H`(합집합 아래 중앙, `$sel` 배경 흰 11px 글자). 드래그 중에는 종전 텍스트 규칙(`:1020-1051` — move `+dx +dy`, line `len px ∠deg`, resize/draw `W × H`) |
| `crop` | 42 `mode.crop` + 48 `CropSession`(그 전엔 기존 `cropRect`/`setCropPreview`) | 딤 4면(`rgba(0,0,0,.45)`) + `$sel` 사각형 + 오버레이 `none/thirds(4선)/quarters(6선)/golden(4선, φ 분할)/diagonal(2선)` + 핸들 8 + 뱃지(`2400 × 1600 · 3:2 · 직선화 1.4°` — 문구는 48이 준다) |
| `guides` | `doc.guides`(37) + 드래그 프리뷰 | `$danger` α.55 1px 전폭 선. 선택된 가이드는 α1·2px |
| `smart` | `SnapResult.lines` | `$smart` 1px, `from~to` 구간(캔버스 전폭이 아니라 두 객체 사이) |
| `measure` | Alt 호버(§3.7)·`SnapResult.gaps` | `$smart` 선 + 양끝 4px 틱(`Measure Gap`의 `d`) + 뱃지(`$smart` 배경 흰 글자 `50`) |
| `rulers` | 42 `toggles.rulers` + `screen` + 선택 합집합 | 22px 띠 2줄 + 모서리, `rulerTicks` 라벨, `Ruler Sel Range` 강조 |
| `extra` | 47(스크림·앵커·핸들·러버밴드)·48(추가 크롭 프리미티브)·45(그라디언트 핸들) | `ChromePrim` 5종(line/rect/circle/path/text, oriented 좌표·크기는 css px)을 그대로 요소로 |
| `pixel-grid`(div) | 42 `toggles.pixelGrid` && `screen.scale ≥ 4` | `repeating-linear-gradient` 2겹, `background-size: ${s}px ${s}px`, `background-position: ${screen.x}px ${screen.y}px`. 픽셀 스냅이 켜져 있으면 포인터 아래 셀 1개를 `extra` rect(`Snap Cell`, `$smart` 2px)로 |

캔버스 크롬 함수(`annotation/chrome.ts`의 `drawSelection/drawCropOverlay/drawHud/drawMarquee`)는 **삭제**한다. 남는 것은 포인터가 쓰는 `handlePointsOf/hitHandle/marqueeRect/rectsOverlap`뿐 — `pointer.ts`로 이동. 완료 뒤 `src/components/image/**`에 `strokeRect|fillText` 호출 0건(INDEX §10.4).

### 3.4 스냅 엔진 — `snap.ts`(순수, DOM 0)

| 결정 | 선택 | 탈락 |
|---|---|---|
| 후보 수집 시점 | **드래그 시작 시 `buildSnapIndex` 1회** — `resolveScene(doc).nodes`(hidden 제외, 38)의 `objectAABB` + 컨테이너 `nodeAABB` + 캔버스 `(0,0,ow,oh)` 경계·중심 + 가이드 + 그리드. 드래그 대상(서브트리 포함)은 제외. x/y 후보를 `Float64Array` 정렬 → 매 move 이진 탐색 O(log N) | 매 move 전 객체 재계산: text `measureText`(`geometry.ts:302-305`) × N × 60fps |
| 우선순위·임계 | 가이드 › 오브젝트 › 그리드, 동률은 거리. `tol = toggles.snapThresholdCss / screen.scale`(기본 4 css px — 시안 `임계값 4px`, 확대할수록 정밀). 어느 것도 안 맞고 `snapPixel`이면 `Math.round` | 고정 oriented 임계: 400%에서 16 css px가 끌려간다 |
| 스냅 축 | AABB의 좌·중·우 / 상·중·하 3×3(이동), 핸들·정점·펜 클릭은 점 1개(`snapPoint`) | 회전 객체의 로컬 모서리: Figma도 AABB로 스냅한다 |
| 해제 키 | **Alt 드래그** — Shift는 비율 고정(`AnnotationLayer.tsx:1322`)·15° 각도(`:1182`)에 이미 쓰인다(Figma는 Ctrl). 42 표에 행 추가 없음(포인터 이벤트의 `altKey`) | Ctrl: 42 Ctrl+클릭(리프 관통 선택)과 충돌 |
| 삽입 지점 | `applyDragAt` 한 곳: move → `snapRect(idx, 라이브 합집합 AABB, tol)`의 `dx,dy`를 델타에 더함; resize → 잡은 핸들 점 `snapPoint`; draw(rect/ellipse/mosaic/line/arrow/frame) → 현재 점 `snapPoint`; pen/highlight 제외(`appendPenPoint` 경로 그대로). 결과 `lines/gaps`는 크롬으로만 간다 — **문서에 남는 것은 좌표뿐** | 소비자별 스냅: 47 노드 드래그·48 크롭 핸들·45 그라디언트 핸들이 같은 `buildSnapIndex/snapPoint`를 부른다(이 축이 정의, vector 축 요구 `snapPoint` 흡수) |
| 그리드 | `toggles.grid: 0|8|16`(시안 `그리드 8px`) — oriented px 배수 선. 그리드 선 자체는 그리지 않는다(시안에 표시 없음, 픽셀 그리드와 별개) | — |

`SnapIndex`는 `DragState`에 붙어 드래그 수명만 산다(1k 객체 ≈ 6×8B×1k = 48KB).

### 3.5 스마트 가이드·등간격

- 선: `snapRect`가 채택한 후보마다 `SnapLine{axis,pos,from,to,kind}` — `from/to`는 주체와 후보 AABB의 다른 축 범위 합집합(시안 `Smart Guide V` h=300처럼 두 객체 사이만).
- 등간격(시안 `Gap Badge 50`): 주체와 수직축 범위가 겹치는 이웃 중 좌·우(상·하) 최근접 1개씩을 O(N) 스캔 → `|gapL − gapR| ≤ tol`이면 `dx`를 등간격으로 보정하고 `gaps` 2개(양쪽 간격, 뱃지 값). `ponytail: 등간격 O(N)/move — 1k 객체 <0.1ms(추정, 비교 6N회). 5k 넘으면 y-구간 트리`. `toggles.gapBadges`(시안 `간격 표시`) off면 감지는 해도 뱃지만 숨긴다 — 아니, 감지도 끈다(보이지 않는 스냅은 저항이다, K3).
- 표시 색 `$smart #F0398B`, 뱃지 = HUD와 같은 11px 상자.

### 3.6 눈금자·가이드

- `rulerTicks(scale, offsetCss, lengthCss)`: 화면 50 css px 이상인 최소 nice-number(1·2·5×10^k oriented px)를 major 간격으로, minor = major/5. 시안 70%에서 100px 간격 = 70 css ✓. 라벨은 oriented px 정수(`0 · 100 · …`), 0이 이미지 원점, 음수 구간(팬으로 이미지가 오른쪽으로 밀렸을 때)도 라벨링. 선택이 있으면 합집합 AABB 구간을 `$accent-soft`로 채운다(`Ruler Sel Range`).
- 눈금자 갱신은 `update` 안에서 `screen`·`stage`·선택이 바뀐 프레임에만(키 비교 1줄) — 팬·줌 프레임당 tick ≈ 30개 재작성.
- **가이드 = `doc.guides: {axis, pos}[]`**(37, oriented px). 히스토리·사이드카 공짜(41). `EMPTY_DOC = normalizeDoc({})`가 `guides:[]`를 채우므로(37 §4) 30 (q-2) 딥이퀄·`A.fresh()`는 무영향(INDEX §10 43행 위험은 37이 닫았다).
- 생성: 눈금자 띠(`pointer-events:auto`)에서 `pointerdown` → 띠 요소가 `setPointerCapture` → move마다 프리뷰 가이드(`guides[].preview`, `snapPoint`로 픽셀/오브젝트 스냅) → 이미지 사각형 안에서 `up`이면 `onGuideCommit(axis,pos)` → ImageEditor `patchDoc({guides:[…, g]}, 'commit', '가이드 추가')`; 띠 위나 stage 밖에서 up이면 취소.
- 이동·삭제: 기존 가이드는 씬 캔버스 `[1]`이 포인터를 받으므로 `pointer.ts onPointerDown`(select 도구·`guidesVisible`)이 **핸들 히트 다음, 객체 히트 전**에 4 css px 거리 판정 → `DragState.guide{axis,index,orig}` + 커서 `col-resize/row-resize`(`updateHoverCursor`에 분기 1개). up: 이미지 밖이면 `'가이드 삭제'` 커밋, 안이면 `'가이드 이동'` 커밋(드래그 1회 = 1칸). 클릭(<3px)은 선택(`selectedGuide` — AnnotationLayer 로컬 ref, UI 상태) → 42 `delete` 액션이 노드 선택이 비어 있을 때 `layerRef.deleteSelectedGuide()`를 먼저 부른다(반환 true면 소비).
- 표시 토글 `toggles.guidesVisible`(시안 `가이드 표시`) off면 그리지도 잡히지도 않고 스냅 대상에서도 빠진다. `toggles.snapGuides`(`가이드에 스냅`)는 스냅만 끈다.

### 3.7 Alt 측정·측정 도구

- **Alt 호버**: `pointer.ts onPointerMove`(드래그 없음)에서 `e.altKey && tool==='select' && selectedIds.length`이면 포인터 아래 객체를 **AABB 포함 판정**(`scene.nodes` 역순, Path2D 불필요 — Figma도 상자 기준으로 잰다)으로 찾아 `measureBetween(selUnion, targetAABB ?? null, canvas)` → 축마다 겹치지 않는 방향의 거리 선+뱃지(대상 없으면 캔버스 4변까지 — 시안 `좌 151 / 우 529`). Alt `keyup`(42 캡처 리스너가 `measure-hold` 액션으로 알림, `preventDefault` — Windows Alt 단독 메뉴 포커스 방지, Tauri 창엔 메뉴가 없어 무해하나 습관적으로 막는다)에 `altHoverRef=null; schedule()`. 상태바 X/Y(42)와 같은 mousemove 경로라 추가 리스너 0.
- **측정 도구**(`Tool 'measure'`, 42 레일): 첫 클릭 = 시작점(`DragState.measure{a}`), move = `extra`에 러버밴드 선+길이 라벨(스냅 `snapPoint`), 둘째 클릭 = 커밋: `line` 노드(`DefaultPaint` 선, `heads none`) + `text` 노드(`"${round(len)} px"`, 중점에서 법선 방향 8px) → 38 `tree.group([lineId,textId],'group')` → 그룹 `name:'측정 라벨'`(⑤ 컴포넌트 이름 관례, `name`은 `NodeBase` 필드라 `map`으로 쓴다 — `splice` 아님) → `onCommit(next, '측정 라벨 생성')` 1칸. Esc = 시작점 버림(handleEscape 계층 3, 기존 드래프트 취소와 같은 분기). 도구는 유지(다른 그리기 도구와 같은 규칙 `:603-608`).

### 3.8 픽셀 그리드·줌 필·스냅 섹션

- 픽셀 그리드: §3.3 표. `screen.scale < 4`면 `display:none`(시안 `픽셀 그리드 400%`) — `ImageEditor.tsx:1085`의 `pixelated` 규칙과 같은 배율 축.
- `Zoom Pill`: stage 우하단 `absolute` DOM(버튼 2 + `${round(screen.scale·100)}%`), `pointer-events:auto`. 42의 줌 액션(`zoom-in/zoom-out`, `zoomTo` — 42 §4)을 부른다. ≈25줄, 파일 추가 없이 ImageEditor stage 안.
- `SnapSection.tsx`(⑦ `Sec 스냅 · 가이드`): 토글 5 + `그리드` 셀렉트(끄기/8/16) + `임계값` NumField(1~16). 42 `toggles`/`snapThresholdCss`를 읽고 쓴다. 45가 조정 탭에 **마운트만** 한다(→ 태스크 45 §3.3). 상태바 토글 5개(①)는 42가 같은 `toggles`를 뒤집는다.

### 3.9 만들지 않는 것

- 캔버스 크롬 유지·별도 캔버스 눈금자·SVG pattern 픽셀 그리드(§3.1 탈락). 눈금자 켜짐에 따른 `fit` 변경.
- 노드 편집 핸들·스크림(→ 47), 크롭 세션·비율·직선화·핸들 드래그 로직(→ 48 — 여기는 `crop` 상태를 그리기만), 그라디언트 핸들 드래그(→ 45), 정렬/분배/간격 정리 연산(→ 45, `translateObject` 기반), 레이어 패널 호버 원천(→ 44).
- 회전 객체 로컬 모서리 스냅, y-구간 트리, 스냅 시 객체 자동 리사이즈(Figma의 "크기 스냅" — 시안 라벨 없음), 그리드 선 표시(시안 없음), 가이드 잠금/색(시안 없음).
- 단축키 표 행(Shift+R 눈금자·Ctrl+' 픽셀 그리드·Ctrl+Shift+' 픽셀 스냅·Alt 홀드) — 42 표가 소유, 액션 핸들러만 여기서 등록.

메모리: 상시 증가분 <1MB(SVG 요소 ≤ 수백 개, 스냅 인덱스 드래그 수명 48KB@1k, 픽셀 그리드 CSS 0) — 40 §7 원장 표에 '크롬' 행으로 합산(축별 예산 금지, INDEX §10.4).

## 4. 계약 (소유: 43 · `src/lib/annotate/snap.ts`, `src/lib/annotate/chrome.ts`, `src/components/image/ChromeOverlay.tsx`, `SnapSection.tsx`)

```ts
// src/lib/annotate/snap.ts — 순수(DOM 0). 47 노드 드래그·48 크롭 핸들·45 그라디언트 핸들이 같은 함수를 쓴다.
export type Guide = EditorDoc['guides'][number];                       // {axis:'x'|'y'; pos:number} — 37 소유, 별칭만
export interface SnapIndex { xs: Float64Array; ys: Float64Array; boxes: readonly Rect[]; guides: readonly Guide[]; gridPx: 0|8|16; pixel: boolean; canvas: Rect }
export function buildSnapIndex(scene: Scene, exclude: ReadonlySet<ObjId>, guides: readonly Guide[],
  opts: { gridPx: 0|8|16; pixel: boolean; objects: boolean; guides: boolean; canvas: Rect }): SnapIndex;   // 드래그 시작 1회 O(N log N)
export interface SnapLine { axis: 'x'|'y'; pos: number; from: number; to: number; kind: 'guide'|'object'|'canvas'|'grid' }
export interface SnapGap  { axis: 'x'|'y'; a: number; b: number; at: number; value: number }
export interface SnapResult { dx: number; dy: number; lines: SnapLine[]; gaps: SnapGap[] }
export function snapRect(idx: SnapIndex, r: Rect, tol: number, opts?: { gaps?: boolean }): SnapResult;    // 이동: 3×3 이진탐색 + 등간격 O(N)
export function snapPoint(idx: SnapIndex, p: { x: number; y: number }, tol: number): SnapResult;         // 핸들·정점·펜 클릭·가이드·크롭 핸들
export interface Measure { from: { x: number; y: number }; to: { x: number; y: number }; label: string; kind: 'alt'|'gap' }
export function measureBetween(a: Rect, b: Rect | null, canvas: Rect): Measure[];                        // Alt 호버 — 겹치지 않는 축 방향만

// src/lib/annotate/chrome.ts — 상태 타입 + 눈금자 산술
export const STAGE_Z = { detail: 1, box: 2, chrome: 3 } as const;                                        // 40 DetailCanvas · ImageEditor 박스가 import
export const CHROME_COLORS = { sel: '#3B82F6', smart: '#F0398B', guide: '#EF4444', ruler: '#18181B' } as const;
export interface ChromeScreen { scale: number; x: number; y: number; w: number; h: number; ow: number; oh: number }  // oriented → stage css px
export type ChromePrim =
  | { k: 'line'; x1: number; y1: number; x2: number; y2: number; color?: string; dash?: boolean }
  | { k: 'rect'; x: number; y: number; w: number; h: number; color?: string; fill?: string; rot?: number }
  | { k: 'circle'; cx: number; cy: number; rCss: number; color?: string; fill?: string }
  | { k: 'path'; d: string /* oriented 좌표 SVG d */; color?: string; fill?: string }
  | { k: 'text'; x: number; y: number; text: string; bg?: string }
  | { k: 'scrim'; color: string; alpha: number; cutoutD: string /* oriented 좌표 SVG d — <mask> 로 뚫는다 */; cutoutStrokeCss?: number };   // 47 노드 편집 격리 스크림
  // 좌표는 oriented px, 두께·반경은 css px. 정사각 앵커(47)는 rect(rot 0) 로 그린다 — 별도 종류 없음
export interface ChromeState {
  screen: ChromeScreen;
  selection: { box: { rect: Rect; rot: number; anchor: { x: number; y: number } }; handles: boolean }[];   // 38 selectBox + objectAnchor
  unionBox: Rect | null; hover: Rect | null; marquee: Rect | null;
  hud: { text: string; at: { x: number; y: number } } | null;
  crop: { rect: Rect; overlay: 'none'|'thirds'|'quarters'|'golden'|'diagonal'; label: string | null; handles: boolean } | null;
  guides: { axis: 'x'|'y'; pos: number; selected?: boolean; preview?: boolean }[];
  smartGuides: SnapLine[]; measures: Measure[];
  rulers: boolean; pixelGrid: boolean; extra: ChromePrim[];
}
export function rulerTicks(scale: number, offsetCss: number, lengthCss: number): { major: { css: number; label: string }[]; minorStepCss: number };

// src/components/image/ChromeOverlay.tsx — forwardRef, stage 안 absolute inset-0, z STAGE_Z.chrome, pointer-events:none(눈금자 띠만 auto)
export interface ChromeOverlayHandle { update(s: ChromeState): void }                                     // rAF 안에서 DOM 직접 갱신 — React state 금지
export interface ChromeOverlayProps { onGuideCommit(axis: 'x'|'y', pos: number): void; snapForGuide(axis: 'x'|'y', pos: number): number }
// SVG 그룹 data-chrome: selection · handles · hover · marquee · hud · crop · guides · smart · measure · rulers · extra ; 픽셀 그리드 div data-chrome="pixel-grid"

// AnnotationLayer(37 분할 뒤 본체) props 추가 · handle 확장
interface AnnotationLayerProps { /* 기존 전부 유지 */ chrome: React.RefObject<ChromeOverlayHandle>; screen: ChromeScreen;
  guides: readonly Guide[]; onGuidesChange(next: Guide[], label: string): void }                          // 이동/삭제 커밋
interface AnnotationLayerHandle { /* 기존 */ deleteSelectedGuide(): boolean }                            // 42 delete 액션이 먼저 부른다
// pointer.ts DragState 추가: { mode:'guide'; axis; index; orig } · { mode:'measure'; a: Point } · 모든 드래그에 snap?: SnapIndex
// pointer.ts 선점 훅(45 그라디언트 핸들·아이드로퍼 — 정합 검사 결정): export function registerPointerHit(fn: (pt: { x: number; y: number }, e: PointerEvent) => boolean): () => void;   // onPointerDown 에서 핸들 히트보다 먼저 호출, true 면 소비. 팝오버 열림에 등록·닫힘에 해제(반환 함수)
// applyDragAt(d, pt, mods:{shift; alt}) — alt 면 스냅 생략. e2e 40 pointerSeq 헬퍼에 opts.alt(altKey) 1줄(42 소유 스위트).

// 42 UI 스토어(→ 태스크 42 §4)에서 읽는 것: toggles{snap,smartGuides,gapBadges,pixelGrid,rulers,guidesVisible,snapObjects,snapGuides,snapPixel,grid:0|8|16}, snapThresholdCss(4), hoverId, mode, tool('measure' 포함)
// 42 액션 맵에 등록하는 핸들러(id 는 42 §3.4 표): 'view.rulers'(Shift+R) · 'view.pixelGrid'(Ctrl+') · 'view.snapPixel'(Ctrl+Shift+') · 'measure.hold'(Alt keydown/keyup) · 'delete'(가이드 우선)
// 38 에서 쓰는 것: resolveScene · selectBox · nodeAABB · objectAABB · hitTest(WeakMap Path2D) · tree.group   // 40: STAGE_Z 공유
// 48 이 채우는 것: ChromeState.crop{overlay,label,handles}(CropSession → 문자열·종류만 넘긴다)  · 47/45: ChromeState.extra
```

e2e/DEV 훅(`window.__gpv.imageEditor`, `ImageEditor.tsx:951-964` 옆): `chrome: { state(): ChromeState /* 마지막 update 인자 */; set(s: Partial<ChromeState>): void /* 테스트 전용 강제 update */ }`, `snap: { rect(r: Rect, tol: number): SnapResult; point(p, tol): SnapResult /* 현재 문서로 buildSnapIndex 뒤 */ }`, `rulerTicks(scale, off, len)`.

## 5. 단계

1. **`snap.ts` + `chrome.ts`**(신규 ≈260 + ≈90): 인덱스·`snapRect/snapPoint`·등간격·`measureBetween`·`rulerTicks`·타입·상수. DEV 훅 `snap.*`/`rulerTicks` 노출(+10). e2e 40 (c-1)(c-2)(c-8)(c-4)의 순수 함수 단언.
2. **`ChromeOverlay.tsx`**(신규 ≈320: SVG 슬롯·`update`·눈금자·픽셀 그리드 div·가이드 끌어내기) + ImageEditor 마운트·`screen` 산술·`STAGE_Z`·가이드 커밋·`Zoom Pill`(+≈55). `AnnotationLayer paintNow`가 `chrome.update` 호출(+≈50: `buildChromeState`), `annotation/chrome.ts` 삭제(−≈240, `handlePointsOf/hitHandle/marqueeRect/rectsOverlap`는 `pointer.ts`로 +40). `grep strokeRect|fillText src/components/image` 0건. 30/34/35 격리 실행 → 91/32/13.
3. **포인터 통합**(`annotation/pointer.ts` +≈150): `applyDragAt` 스냅 삽입(펜 제외), `DragState.guide`(히트·이동·삭제·선택)·`measure`(측정 도구), Alt 호버 측정, 커서 분기. 42 액션 핸들러 5개 등록(+15). `SnapSection.tsx`(신규 ≈80).
4. **e2e 40 +**(≈220, 42 소유 스위트에 추가·`pointerSeq` `opts.alt` +1줄): §7.

규모 **L**: 프론트 ≈ +1,030/−240 · Rust 0 · 신규 의존 0. 착수 순서는 42(스토어·레일 `measure`·단축키 표)와 40(`[2]`·z)이 머지된 뒤 — 그 전엔 2단계까지만 가능(토글은 상수).

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| 산술 `screen`과 실제 CSS transform 위치의 서브픽셀 차 | 컴포지터가 변환 레이어를 소수 px에 두면 크롬이 ≤0.5px 어긋난다 | 선택 상자·눈금자 단언 ±0.5px. 어긋남이 보이면 `boxRef.getBoundingClientRect`를 view 변경 프레임에만 1회 읽어 보정(현행 wheel 핸들러 `:416`과 같은 빈도) |
| 스냅이 펜 획을 격자에 끊음 | `applyDragAt` draw 분기에 일괄 삽입 시 | pen/highlight는 `appendPenPoint` 경로(`:548-550`)라 분기 자체가 다르다 — 스냅은 `makeDraft` 경로에만 |
| 눈금자 띠가 이미지 가장자리를 덮음 | 맞춤 상태에서 6px(§3.1) | Figma 동일. 사용자는 팬/줌. `toggles.rulers` off로 제거 |
| Alt 단독 키가 IME/메뉴를 건드림 | 한국어 키보드 오른쪽 Alt = 한/영(`HangulMode`) | 42 표기 '왼쪽 Alt'. `measure-hold`는 `e.code==='AltLeft'`만 |
| 가이드 히트가 객체 클릭을 가로챔 | 가이드 위 4px 안에 객체가 있을 때 | Figma 규칙(가이드 우선). 30/34/35는 가이드 0개라 무영향 |
| 등간격 스캔 O(N) | 5k 객체 × 60fps | `ponytail:` 천장 명시(§3.5). 인덱스에 y-정렬이 이미 있어 구간 트리 승격은 순증 |
| `hoverId` 갱신이 리렌더를 유발 | 44가 스토어를 매 move 갱신하면 구독자 전원 셀렉터 | 크롬은 스토어를 구독하지 않고 `paintNow`에서 `getState()`로 읽는다. 44가 `renderOnce()`로 프레임을 요청(→ 44 §3.4) |
| 42 스토어 미머지 상태 | `toggles` 없음 | 2단계까지는 상수 토글로 진행 가능, 3단계는 42 뒤 |
| SVG `textContent`가 30 `A.modal()` 판별에 영향 | 눈금자 라벨이 `textContent`에 섞임 | 판별식은 `/이미지 편집/` 포함 여부라 무영향(`30:34-36`) |

## 7. 검증

- **e2e 40 신규 (c)**: (c-1) rect A(40,40,60,60)·B(150,40,60,60) 주입, 스냅 on → B를 `pointerSeq`로 x≈42까지 드래그 → 커밋 후 `B.x === 40` 정확히; (c-2) 같은 드래그 `{alt:true}` → `42`; `toggles.snap=false` → `42`; (c-3) **크롬 비영속**: 드래그 중(up 전) `svg [data-chrome=smart] line` ≥1, up 뒤 0; 드래그를 연 채 `saveAs` → `readSaved` 가이드 좌표 픽셀 흰색, `px(1, 40, 20)`이 `#F0398B` 아님(캔버스 크롬 0); (c-4) 눈금자: `[data-chrome=rulers] text` 라벨 `'0','100','200'`의 x 간격 == `100·screen.scale` ±0.5; `wheel` 확대 후 재계산(간격 ≥50 css)·`pan(60,−40)` 후 라벨이 60px 이동; `rulerTicks(0.7,0,1200).major[1].label==='100'`; (c-5) 가이드: 눈금자 H 띠 `pointerdown` → y=100 위치로 move·up → `getDoc().guides` 딥이퀄 `[{axis:'y',pos:100}]`·히스토리 라벨 `/가이드 추가/`; Ctrl+Z → `[]`; 가이드 근처로 객체 드래그 → 스냅; 가이드를 stage 밖으로 드래그 → 삭제 커밋; (c-6) Alt 측정: A 선택 + `hover(180,70,{alt:true})`(B 위) → `[data-chrome=measure] text`에 `'50'`(A 우측 100 ↔ B 좌측 150); Alt keyup → 0개; 대상 없는 곳 → 캔버스 4변 거리 4개; (c-7) 픽셀 그리드: `view.scale`을 400%로 + 토글 on → `[data-chrome=pixel-grid]` `display !== 'none'` 이고 `backgroundSize === '${s}px ${s}px'`; 100%에서 none; (c-8) 등간격: A(20,40,40,40)·B(100,40,40,40)·C를 x≈178로 드래그 → `C.x === 180` 이고 드래그 중 `[data-chrome=measure] text` 두 개 모두 `'40'`; (c-9) 선택 상자: `[data-chrome=selection] rect`의 x,y,w,h == `selectBox` 화면 변환 ±0.5, 핸들 8개; 300% 확대 후 핸들 `getBBox().width === 8` ±0.5; (c-10) 측정 도구: `setTool('measure')` → 클릭 (40,40)·(140,40) → `objects.length` +3(group+line+text), 그룹 `name === '측정 라벨'`, text `'100 px'`, 히스토리 +1; Esc 뒤 첫 클릭만 → 객체 0; (c-11) 크롭 오버레이: `chrome.set({crop:{rect, overlay:'thirds', …}})` → `[data-chrome=crop] line` 4, `quarters` 6, `golden` 4, `diagonal` 2, 딤 rect 4·핸들 8; (c-12) HUD: rect 1개 선택 → `[data-chrome=hud] text === '60 × 60'`, 이동 드래그 중 `/^\+\d+\s+\+\d+$/`.
- **회귀**: 30(91)·34(32)·35(13) 단언 수·pass 동일, 헬퍼 무수정 — 특히 (o-4)(p-5)(p-1)·35 `rect/backing`. (p-5)는 이제 HUD가 SVG라 '저장본에 없음'이 구조적으로 성립한다.
- **정적 검사(리뷰 체크리스트)**: `grep -n "strokeRect\|fillText" src/components/image/` 0건; `ChromeOverlay.tsx`에 `useState` 0건; `pointer.ts` 외에서 `buildSnapIndex` 호출은 47/48/45 소유 파일뿐.
- **실기**: 4K 이미지 300%·400%에서 선택 상자·눈금자·픽셀 그리드가 1px로 보이고 디테일 캔버스 위에 뜬다(40 `detail().active` 상태에서); 가이드를 만들고 편집기를 닫았다 다시 열면 남아 있다(41); Alt 홀드 측정이 한국어 IME 상태에서도 동작(왼쪽 Alt); 프레임 시간 — 펜 300개 문서 드래그 중 `paintNow` 중앙값에 크롬 갱신이 1ms 이상 더하지 않음(40 §7 표에 '크롬' 열 추가).
