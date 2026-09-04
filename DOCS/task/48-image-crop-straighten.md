# 태스크 48 — 크롭 프로 모드: 8핸들·비율 7·오버레이 4·직선화(임의 각)·여백 자동 제거·영역 밖 삭제·적용/취소

> 상태: 설계(Design) · 대상: gitpervisor · 근거: 코드 실측 2026-09-04(워킹트리) · 선행: 태스크 42(`mode.crop`·`EDITOR_SHORTCUTS`·컨텍스트 바 슬롯), 43(`ChromeState.crop`·`snap.ts`),
> 38(`rotateNodes/translateSubtree/nodeAABB`), 37(`EditorDoc.straighten`), 39(`renderScene opts.image`), 40(메모리 원장) · `DOCS/image-annotation-design.md` §3.1(oriented px 단일 좌표계 — 직선화가 이 계약을 지키는 방식이 §3.2),
> `DOCS/pro-image-editor-design.md` §6.3(4K 예산 121/154MB — 직선화 증분은 40 원장에 합산) · 시안: `designs/image-editor-figma-v2.pen` ⑦(크롭 워크스페이스·조정 탭 크롭 섹션) ⑧(컨텍스트 툴바 '크롭' 변형) · 상위: `00-INDEX.md` §10 — **M4 크롭 레인(L, 46·47·49와 병렬, 파일 겹침 0).**

## 1. 요구사항

시안 ⑦ 상단 모드 배너 `크롭 모드 · ⏎ 적용 · Esc 취소`, 컨텍스트 바 `크롭 · 비율 · 자유 · 원본 · 1:1 · 3:2 · 4:3 · 16:9 · 사용자 · 오버레이 · 직선화 · 1.4° · 여백 자동 제거 · 취소 · 적용 ⏎`(⑧ '크롭' 변형도 같은 구성 `크롭 · 자유 · 1:1 · 3:2 · 16:9 · 직선화 · 1.4° · 취소 · 적용 ⏎` + 아이콘 노드 `flip-horizontal · flip-vertical · rotate-ccw · rotate-cw`),
캔버스 위 `크롭 중 · 3:2 · 2400 × 1600 · 3:2 · 직선화 1.4°`(배지)와 `.pen` 레이어 `Corner/Edge 핸들 · Dim Top/Left/Right/Bottom`, 조정 탭 크롭 섹션 `크롭 · 적용 전 · 3:2 가로 · 각도 · W 2400 · H 1600 · X 240 · Y 96 · 3분할 · 4분할 · 황금비 · 대각선 · 크롭 영역 밖 삭제`, 상태바 `크롭 2400 × 1600 · 3:2`.

받아들이는 조건:
- 크롭은 **모드**다(42 `mode.kind==='crop'`): 진입하면 현재 크롭(없으면 전체)이 8핸들 사각형으로 보이고, 핸들·이동·비율·오버레이·직선화·회전/반전을 몇 번이든 만진 뒤 **⏎ 적용 = 히스토리 1칸(`크롭 W×H`)**, Esc 취소 = 진입 시점 문서로 **정확히** 복귀(히스토리 불변).
- 직선화는 **임의 각(−45°..45°, 0.1° 단위)**이고 슬라이더를 아무리 왕복해도 주석 좌표가 밀리지 않는다(누적 델타 금지 — INDEX §10.4). θ=0이면 종전 코드 경로와 **비트 동일**해 e2e 30/34/35가 무변경으로 통과한다.
- 비율 7종(자유·원본·1:1·3:2·4:3·16:9·사용자 W:H)이 핸들 드래그·W/H 입력 모두에 걸린다. 오버레이 4종(3분할·4분할·황금비·대각선)은 화면 크롬이라 저장 파일에 절대 남지 않는다.
- `여백 자동 제거`는 단색 여백을 픽셀로 찾아 크롭 사각형을 그 안쪽으로 맞춘다. 직선화된 이미지의 투명 모서리는 `constrainToImage`(기본 ON)가 사각형을 **내접 영역**으로 묶어 저장 PNG 네 모서리가 α255다.
- `크롭 영역 밖 삭제`(기본 OFF)를 켜고 적용하면 크롭과 교차하지 않는 노드가 **같은 커밋**에서 사라진다. OFF면 종전처럼 출력에서만 잘린다(e2e 30 (d)).
- 이 태스크만 머지해도 쓸 수 있다: 45의 슬롯에 `CropContextBar`/`CropInspectorSection`이 붙고, 42의 `enter`/`esc` 행(`when:'crop'` 분기)이 `api.cropApply/cropCancel`을 부른다.

## 2. 현황(근거)

- **크롭은 "드래그 한 번 = 확정"이다**: `ImageEditor.tsx:207 cropMode` boolean, `:508-545 onCropDown/Move/Up` — down에서 시작점, move마다 `normalizeRect`로 라이브 사각형을 `layerRef.setCropPreview`(`AnnotationLayer.tsx:760-763`)에 넣고, up에서 `≥4px`면 `patchDoc({crop, outW, outH})` + `setCropMode(false)`(`:536-544`). 핸들·이동·비율·오버레이 — 전부 없다. 취소 경로는 `onCropCancel`(`:521-525`)이 AL `handleEscape`의 계층 3(`:733-747`)에서 불린다. 포인터는 AL이 받아 위임한다(`:401-404 dragRef={mode:"crop"}`, `:538-541`, `:587-590`).
- **오버레이는 캔버스 크롬**: `drawCropOverlay`(`AnnotationLayer.tsx:976-1000`)가 딤 4면 + 테두리(`SELECT_COLOR`)를 `paintNow`(`:295`)에서 그린다. 43이 SVG `ChromeState.crop`으로 옮긴다 — 48은 상태만 채운다.
- **방향 변환은 `buildOriented` 한 함수**: `ImageEditor.tsx:115-140` — `translate(w/2,h/2) → rotate(rotation) → scale(flip) → drawImage`. 90° 배수만 받으며 캔버스 크기는 `swap ? naturalH : naturalW`(`:121-123`). `oriented` 메모(`:366-369`)가 `[img, rotation, flipH, flipV]`에 묶여 있고, `useEffect(() => setView(IDENTITY_VIEW), [oriented])`(`:404`)가 방향 변경마다 줌을 맞춤으로 되돌린다. 프리뷰 백킹(`:372-376`)·출력(`:660-691 renderOutput`, `drawImage(base, sx, sy, sw, sh, …)`)·90° 델타(`:472-503 rotateBy/flipBy`, `transformObjects(d.objects, delta, oriented.width, oriented.height)`)는 **oriented 캔버스의 크기와 픽셀만 본다** — 그 캔버스가 어떻게 만들어졌는지는 모른다. 직선화를 여기 가장 안쪽에 넣으면 셋 다 무변경이다(§3.2).
- **회전 방향은 반전 홀수 개에 뒤집힌다**: `rotateBy`(`:472-484`) `mirrored = d.flipH !== d.flipV`·`delta = plus90 !== mirrored ? "rotCW" : "rotCCW"` — 실측 주석(`:469-471`). 직선화 Δ가 oriented 공간에서 보이는 부호도 같은 규칙이다(반사는 회전을 역으로 켤레화한다).
- **드리프트 0 선례**: `applyDragAt`(`AnnotationLayer.tsx:536-573`)는 `d.base`에서 매번 `translateObject(o, dx, dy)`를 다시 계산한다(누적 안 함). `patchLive/endLive`(`ImageEditor.tsx:261-271`)는 "첫 틱 commit, 나머지 replace"라 슬라이더 드래그 1회 = 1칸. `DocHistory.replace`(`history.ts:60-62`)는 스택을 건드리지 않고 `current`만 바꾼다 — 세션 라이브 문서를 두기에 정확히 맞는 원시 연산이다.
- **리사이즈 핸들 규약**: `resizeObject`(`AnnotationLayer.tsx:1283-1350`) 인덱스 0..7 = NW·N·NE·E·SE·S·SW·W(`west = 0|6|7`, `east = 2|3|4`, `north = 0|1|2`, `south = 4|5|6` `:1298-1301`), Shift 비율 고정은 "변 핸들이면 반대 축을 중심 기준 대칭 확대"(`:1320-1327`), 잡기 반경 `HANDLE_GRAB_CSS/displayScale`(`:63`, `:418`), 커서 `HANDLE_CURSORS[h]`(`:76`, `:520`), `hitHandle`(`:1144-1152`). 크롭 8핸들은 이 규약을 그대로 쓴다.
- **여백 자동 제거·내접 사각형 — 없다**. `getImageData`는 `drawMosaic`(`render.ts:378-405`)만 쓴다(스크래치 경계 복제 패딩). `oriented`는 `img.src` data: URL(`ImageEditor.tsx:259-260`)에서 만든 동일 출처 캔버스라 `getImageData`가 taint 없이 된다.
- **크기 가드**: `MAX_PREVIEW 1800`(`:64`)·`MAX_OUTPUT_DIM 16384`(`:66`)·`MAX_INPUT_PIXELS 100MP`(`:69`). 직선화는 oriented 캔버스를 최대 √2배(45°, 정사각)까지 키우므로 화소 상한이 **하나 더** 필요하다(§3.6).
- **e2e 접점**: 30 `A.cropOn = /영역을 드래그/`(`:473`)·`click(/크롭 선택/)`(`:1291`)은 툴바 라벨에 묶여 있다. 42는 그 문구를 유지한 채 조정 탭으로 옮기고(42 §3.8 — 헬퍼 무수정), 라벨을 바꾸는 것은 **이 태스크**이므로 헬퍼 2줄(`cropOn` → `/크롭 모드|영역을 드래그/`, `click(/크롭 \(C\)|크롭 선택/)`)은 48이 고친다(§4 허용 목록). 30 (k) 계층 3·6(`:1291-1318`)은 "Esc 한 번 = 드래그 취소, 두 번 = 모드 해제"를 단언하고, (d)(`:891-923`)는 `setDoc({crop})` 뒤 저장 파일이 100×100이고 크롭 밖 주석이 사라짐을 단언한다 — 둘 다 이 설계에서 의미가 유지된다(§7).
- 심사 판정(정합성 blocker 직선화·모드): 직선화 의미 3벌(document '주석 불변 중심 회전' / render `ImageNode.rot` / vector '캔버스 확장 + 주석 동반 회전') → **vector 안**. 크롭은 `Tool`이 아니라 42의 `Mode`(도구 키가 크롭을 조용히 끄는 현행 동작 `:920-924` 보존). 크롭 UI는 이 태스크가 컴포넌트, 45는 마운트만.

## 3. 설계

### 3.1 크롭 세션 — base 스냅샷 + `replace` 라이브 + 커밋 1

| 대안 | 평가 |
|---|---|
| **A. 모드 진입 시 `base = docRef.current` 스냅샷. 세션 중 모든 변경(핸들·비율·직선화·회전/반전)은 `applyDoc(live, 'replace')`. 적용 = `applyDoc(base,'replace')` 직후 `applyDoc(final,'commit','크롭 W×H')`. 취소 = `applyDoc(base,'replace')`** (채택) | `replace`는 스택 무변경(`history.ts:60-62`)이라 세션이 몇 틱이든 히스토리는 0칸. 적용 직전 `base`로 되돌려 놓고 커밋하므로 `past`에 쌓이는 것이 **base 정확히 1개** — undo 한 번에 세션 전체가 풀린다. 41 자동저장은 commit에서만 `markDirty`라 세션 중 디스크 쓰기 0 |
| B. `patchLive`(첫 틱 commit) 유지 | 취소를 `undo()`로 하면 라이브 문서가 `future`에 남아 redo가 크롭을 되살린다. 적용도 두 번째 커밋을 만든다 |
| C. 세션 상태를 문서 밖(ref)에만 두고 적용 때 한 번 반영 | 직선화는 `oriented`(`:366`)를 바꿔야 프리뷰가 도는데 그 메모는 `doc.straighten`을 읽는다 — 문서 밖에 두면 프리뷰 경로가 둘이 된다 |

세션 = `useCropSession(docRef, applyDoc, oriented, ui)` 훅(ImageEditor 쪽) — `CropSession`(§4) React 상태 + `baseRef`. **공유 계약의 `AnnotationLayerHandle.cropSet/…`은 이 훅의 `CropApi`로 옮긴다**: 세션은 `applyDoc`·`base`·`oriented`를 쥐어야 하는데 AL은 셋 다 없고, 지금도 크롭은 AL→ImageEditor 위임 구조다(`:505-545`). 메서드 이름·`CropSession` 형태는 계약 그대로라 42(키)·45(슬롯)의 소비 코드는 바뀌지 않는다.

모드 전이는 42 스토어 하나로: `useEffect(() => mode.kind==='crop' ? enter() : cancelIfActive(), [mode.kind])`. `cropApply/cropCancel`이 `setMode({kind:'design'})`을 부르고, 도구 키 등으로 모드가 밖에서 바뀌면 같은 effect가 취소한다(현행 "크롭 중 도구 키 = 조용히 해제" 승계). 닫기(`requestClose`·unmount)도 `cancelIfActive()`를 먼저 지나 41 `flush`가 라이브 문서를 쓰지 않게 한다.

### 3.2 직선화 — `buildOriented` 가장 안쪽 회전 + 캔버스 bbox 확장

| 대안 | 평가 |
|---|---|
| **A. `buildOriented(img, rotation, flipH, flipV, straighten)`: `translate → rotate(rotation) → scale(flip) → rotate(θ) → drawImage`, 캔버스 = `straightenedSize(nat, θ)`(회전 90/270이면 swap)** (채택) | oriented px는 여전히 "그 캔버스의 픽셀"이라 좌표계 계약(`types.ts:3-5`)·프리뷰 백킹·`renderOutput`·90° 델타·`transformObjects`·40 타일 전부 **무변경**. `θ===0`이면 `ctx.rotate`를 부르지 않아 종전과 비트 동일(e2e 30/34/35 무영향). 빈 모서리는 투명 — `constrainToImage`가 크롭을 내접 영역으로 묶는다 |
| B. `SceneTransform`에 회전 추가(document 안 — 주석 좌표 불변) | 이미지 픽셀만 돌고 주석은 제자리 → 사용자가 강조한 UI 요소와 주석이 어긋난다. 90° 회전이 `transformObjects`로 주석을 함께 옮기는 이유(`geometry.ts:484-532`)와 정면 충돌. `orientedToTarget/targetToOriented/applySceneTransform` 3곳 + 크롭 사각형이 별도 공간 |
| C. 렌더 시 `ImageNode.rot`로 라이브 회전(render 안) | 캔버스 밖으로 잘리는 모서리 + B와 같은 좌표 분리. 프리뷰 백킹·디테일·타일 셋이 각자 회전 |
| D. 슬라이더 틱마다 주석에 Δ 누적 | 50틱에 float 오차·`rot` 정규화 누적. INDEX §10.4 금지 |

주석은 **base에서 다시 계산**한다(`applyDragAt`의 `d.base` 패턴 `AnnotationLayer.tsx:556-560`):

```
Δ   = θ − base.straighten
det = base.flipH !== base.flipV ? −1 : +1          // rotateBy 의 mirrored 규칙(:475-477)
c₀  = center(straightenedSize(nat, base.straighten)),  c₁ = center(straightenedSize(nat, θ))
objects = translateSubtree(rotateNodes(base.objects, allTopIds, det·Δ, c₀), allTopIds, c₁−c₀)     // 38 §4
```
`rotateNodes`가 리프별 규칙(정점 회전 / rect·ellipse·mosaic·text·badge는 앵커 이동 + `rot += det·Δ`)을 이미 갖는다 — crop.ts에 기하 코드가 없다. 검산: `R_{a'}(r)·R_c(Δ) = R_c(Δ)·R_a(r)`(a' = R_c(Δ)a)이므로 정점 회전 + `rot` 유지와 앵커 이동 + `rot` 누적은 같은 픽셀을 낸다. `Δ=0`이면 `rotatePoint`가 항등 단락(`geometry.ts:328`)·`c₁−c₀=0`이라 **결과가 base와 동일 참조가 아니어도 값은 정확히 같다**(e2e (ac)는 `<1e-6`이 아니라 등치로 단언). 크롭 사각형은 `c₁−c₀`만큼 옮기고 §3.4 경계로 클램프 — 이미지가 돌고 사각형은 축정렬로 남는다(Lightroom·Figma 동일).

`oriented` 메모 의존성에 `straighten` 추가. `:404`의 줌 리셋은 `[img, rotation, flipH, flipV]`로 좁힌다 — 직선화 틱마다 맞춤으로 튀면 확대해서 수평을 맞추는 동작이 불가능하다. `resetAll`(`:569-597`)은 반전·회전을 걷어낸 뒤 `straightenObjects(objs, θ, 0, …, mirrored=false)`를 한 번 더 지나 `straighten: 0`(가장 안쪽이므로 가장 나중에 푼다).

### 3.3 8핸들·이동·새 사각형·비율 — `pointer.ts`(37 분할 모듈)

| 히트 순서(크롭 모드, pointerdown) | 드래그 상태 | 규칙 |
|---|---|---|
| ① 핸들 8점(`hitCropHandle`, tol `HANDLE_GRAB_CSS/displayScale`) | `cropResize{handle, base: Rect}` | `resizeCropRect(base, handle, pt, {aspect, bounds, shift})` — `resizeObject` 인덱스 규약. 대각 핸들은 반대 모서리 고정·w에서 h 파생, 변 핸들은 반대 축을 중심 기준 대칭(`:1320-1327` 규칙). Shift = `aspect==='free'`일 때만 1:1 임시 고정 |
| ② 사각형 안 | `cropMove{start, base}` | 크기 유지·`bounds` 안으로 클램프 |
| ③ 밖 | `cropDraw{start}` | 종전 `normalizeRect(st, p)`(`ImageEditor.tsx:515`) 경로 — 비율이 있으면 h 파생 |

드래그 중 라이브 사각형은 AL 내부 `cropPreviewRef`(현행 `:206`)에만 두고 `chrome.update`로 그린다(React 상태 0). up에서 `onCropRect(rect)` 1회 → `cropSet({rect})` → React 상태. 핸들 점은 43 `buildSnapIndex`(드래그 시작 1회)·`snapPoint(idx, pt, tol)`의 `dx,dy`로 보정(토글 `snapPixel/snapObjects/snapGuides` 존중, 기본 픽셀 스냅 = `Math.round` — 크롭 정수 규칙 `:536-541` 승계). 커서: 핸들 → `HANDLE_CURSORS[h]`, 안 → `move`, 밖 → `crosshair`(현행 `className` 고정 `:813-815`을 `updateHoverCursor` `:507-526` 확장으로). Esc 계층 3 = `dragRef=null; cropPreviewRef=undefined`(사각형이 세션 값으로 되돌아간다) — `onCropCancel` prop과 `setCropPreview` 핸들은 **삭제**(호출부 `:511,518,524,531,922`가 전부 사라진다).

세션 진입 시 사각형 = `doc.crop ?? bounds`(전체). 그래서 진입 직후 핸들이 바로 잡힌다. e2e 30 (k)의 `down(30,30)…esc…up`은 이제 전체 사각형의 **이동** 드래그(클램프로 0 이동)가 되고 Esc가 그것을 버리므로 `crop===null`·모드 유지 단언이 그대로 성립한다.

비율: `'original'` = 회전 반영 원본 비율(`rotation%180 ? natH/natW : natW/natH` — 직선화 bbox 비율이 아니다), 프리셋은 가로 기준. 세로 비율은 `{w:2,h:3}`(사용자) — 시안 라벨에 방향 토글이 없다. 인스펙터 헤더 `3:2 가로`는 `aspectLabel + (rect.w>=rect.h ? ' 가로' : ' 세로')`.

### 3.4 경계·내접 사각형·여백 자동 제거·영역 밖 삭제 — `crop.ts`

- `cropBounds(session, oriented)`: `constrainToImage && straighten!==0 ? maxInscribedRect(natW', natH', |θ|) : {0,0,ow,oh}`(정수 안쪽 반올림). 모든 클램프·`'original'`·자동 제거가 이 하나를 본다.
- `maxInscribedRect(w, h, deg, aspect?)` — 중심 대칭 폐형식. 비율 없음: `s=|sin|, c=|cos|`, 짧은 변 `short`·긴 변 `long`에 대해 `short ≤ 2·s·c·long`이면 `x=short/2, (wr,hr) = w≤h ? (x/s, x/c) : (x/c, x/s)`, 아니면 `cos2=c²−s², wr=(w·c−h·s)/cos2, hr=(h·c−w·s)/cos2`(회전 사각형 안 최대 축정렬 사각형의 알려진 해). 비율 `r`: 반폭 `a = min((w/2)/(c+s/r), (h/2)/(s+c/r))`, `(2a, 2a/r)` — 네 모서리를 역회전해 원본 사각형 안에 있을 조건 두 개. 결과는 bbox 캔버스 중심에 놓는다. 픽셀 루프 0.
- `autoTrimRect(canvas, bounds, tol=8)`: `bounds` 좌상단 픽셀을 기준색으로, 네 모서리가 기준색 ±tol(RGBA 채널별)이 아니면 `null`(토스트 "단색 여백을 찾지 못했습니다"). 위→아래 행 스트립 `getImageData(bx, y, bw, 1)`(4K 15KB)로 첫 비배경 행, 아래→위·좌→우·우→좌 열 스트립 동일. 전체 `getImageData`(4K 33MB)는 탈락. 결과는 `fitAspect`로 현재 비율에 맞춘 뒤 `cropSet({rect})`. 버튼 1회 동작 — 토글로 두면 직선화 틱마다 재스캔이 슬라이더를 막는다(계약의 `autoTrimMargins` 필드는 두지 않는다).
- `deleteOutside`(적용 시): 씬 리프(`resolveScene(live).nodes`) 중 `objectAABB`가 크롭과 교차하지 않는 id → `tree.remove`(38), 비어 버린 컨테이너는 `childrenOf(...).length===0`이면 같은 패스에서 제거. 라벨은 `크롭 W×H`(같은 커밋). 숨김 노드는 씬에 없어 남는다(정확성보다 "보이는 것만 지운다"가 예측 가능).
- 적용 결과: `rect === bounds && θ === base.straighten && !deleteOutside`면 `crop:null`·`outW/outH = oriented`로 두고 문서가 base와 같으면 커밋 없이 모드만 종료(빈 히스토리 칸 금지). 아니면 `{crop: rect, outW: rect.w, outH: rect.h, straighten: θ, objects, rotation, flipH, flipV}` 커밋.

### 3.5 세션 안 회전·반전 — `cropTransform(delta)`

컨텍스트 바의 `rotate-cw/ccw · flip-h/v`는 세션 라이브 문서에 `transformObjects`(`geometry.ts:484`)를 걸고 크롭 사각형도 같은 `transformPoint`로 두 모서리를 옮겨 `normalizeRect`(rect 케이스 `:512-516` 재사용). `base`는 그대로라 취소가 회전까지 되돌리고 적용은 1커밋이다. 45 조정 탭의 기존 `회전 · 반전` 버튼(`:1149-1167`, e2e 30 '오른쪽 90°' 계약)은 모드 밖에서 `rotateBy/flipBy`(`:472-503`) 그대로.

### 3.6 메모리 — 40 원장에 θ 행 추가(바이트 상한 하나)

3840×2160, `w·h·4` 실계산. 39 병합 뒤 백킹 캔버스는 `[0][1]` 2장:

| θ | oriented 캔버스 | Δ | 백킹 1장(1800 상한) | Δ×2 | 정상 상태 증분 |
|---|---|---|---|---|---|
| 0° | 3840×2160 = 33.2MB | — | 1800×1013 = 7.3MB | — | 0 |
| 5° | 4014×2487 = 39.9MB | +6.7 | 1800×1115 = 8.0MB | +1.5 | **+8.2MB** |
| 15° | 4269×3081 = 52.6MB | +19.4 | 1800×1299 = 9.4MB | +4.1 | **+23.5MB** |
| 45° | 4243×4243 = 72.0MB | +38.8 | 1800×1800 = 13.0MB | +11.3 | **+50.1MB** |

슬라이더 틱마다 새 oriented가 옛것이 회수되기 전에 생기므로 일시 +1 oriented(45°에서 +72MB). 출력: `constrainToImage` ON이면 내접 ≤ 원본이라 저장 피크 증분 0; OFF(|θ|≤15°만 허용)면 ≤ oriented. 규칙 둘 — (1) `|θ| > 15°`는 `constrainToImage` 강제 ON(토글 비활성 + 힌트, 40 §3.5 원장 규칙) (2) **`MAX_STRAIGHTEN_PIXELS = 40_000_000`**(oriented 160MB 천장): `straightenedSize(θ)` 화소가 넘으면 슬라이더 범위를 그 각도까지로 줄이고 힌트 `이미지가 커서 ±N°까지`. 4K는 45°(18MP)까지 전부 통과, 8K(33MP)는 ±5°에서 걸린다 — `ponytail: 상수 한 곳, 40 §7 실측 뒤 조정`. 4K 슬라이더 틱 비용(oriented 재생성 + AL 캐시 재구축 `:224` `props.oriented` 의존)은 40 실측표 항목.

### 3.7 만들지 않는 것

- `Tool`에 `'crop'`(42 결정 — 모드는 도구와 직교, `propTool: Tool = kind` 관례 `:621-624` 충돌 회피), 캔버스 크롬 드로우(43 SVG가 그린다 — 48은 `ChromeState.crop`·`hud`만 채운다), 스냅 인덱스 계산(43 `snap.ts`), `NumField`(45).
- 자동수평(각도 추정, export 축 제안) — `.pen` 라벨 0건(INDEX §10.3 열린 질문 45행에 이미 기각). 비율 방향 토글, 회전 크롭(사각형 자체 회전), 원근 보정 — 시안 밖.
- `autoTrimMargins` 토글 필드(§3.4 — 버튼 1회), 세션 간 비율/오버레이 기억(오버레이만 42 `toggles.cropOverlay` 1키 — 42 §4에 행 추가 요청).
- 이미지 밖(투명) 영역을 포함하는 크롭의 저장 경고 — `constrainToImage` 기본 ON + `|θ|>15°` 강제로 대체.

## 4. 계약 (소유: 48 · `src/lib/annotate/crop.ts`, `src/components/image/useCropSession.ts`, `CropContextBar.tsx`, `CropInspectorSection.tsx`)

```ts
// crop.ts — 순수(DOM 은 autoTrimRect 의 canvas 인자뿐)
export type CropAspect = 'free' | 'original' | '1:1' | '3:2' | '4:3' | '16:9' | { w: number; h: number };
export type CropOverlay = 'none' | 'thirds' | 'quarters' | 'golden' | 'diagonal';
export interface CropSession {
  rect: Rect;                     // oriented px, 정수, 항상 bounds 안
  aspect: CropAspect;             // 기본 'free'
  overlay: CropOverlay;           // 기본 42 toggles.cropOverlay ?? 'thirds'
  straighten: number;             // deg, −45..45, 0.1 단위 — live doc.straighten 과 동일 값
  constrainToImage: boolean;      // 기본 true, |straighten|>15 이면 강제 true
  deleteOutside: boolean;         // 기본 false
}
export const CROP_ASPECTS: readonly { id: CropAspect; label: string }[];   // 자유·원본·1:1·3:2·4:3·16:9·사용자
export const CROP_OVERLAYS: readonly { id: CropOverlay; label: string }[]; // 3분할·4분할·황금비·대각선(+none)
export const MAX_STRAIGHTEN_DEG = 45;
export const MAX_STRAIGHTEN_PIXELS = 40_000_000;

export function straightenedSize(w: number, h: number, deg: number): { w: number; h: number };   // ⌈w|cos|+h|sin|⌉ × ⌈w|sin|+h|cos|⌉; deg=0 → {w,h}
export function buildOriented(img: HTMLImageElement, rotation: number, flipH: boolean, flipV: boolean, straighten: number): HTMLCanvasElement; // ImageEditor.tsx:115-140 이관 + 최내측 rotate(θ). θ=0 비트 동일
export function straightenObjects(objects: readonly Node[], fromDeg: number, toDeg: number, size0: { w; h }, size1: { w; h }, mirrored: boolean): Node[]; // 38 rotateNodes+translateSubtree 합성
export function maxInscribedRect(w: number, h: number, deg: number, aspect?: number): Rect;      // bbox 캔버스 좌표, 중심 대칭 폐형식
export function autoTrimRect(canvas: HTMLCanvasElement, bounds: Rect, tol?: number): Rect | null; // 행·열 스트립 getImageData, 기준색 = bounds 좌상단
export function resizeCropRect(base: Rect, handle: number, pt: { x; y }, o: { aspect: number | null; bounds: Rect; shift: boolean }): Rect; // resizeObject 인덱스 0..7
export function fitAspect(rect: Rect, aspect: number | null, bounds: Rect): Rect;               // 중심 유지, 안쪽으로
export function aspectRatioOf(a: CropAspect, natW: number, natH: number, rotation: number): number | null;
export function cropBounds(s: Pick<CropSession,'straighten'|'constrainToImage'>, natW, natH, rotation, oriented: { w; h }): Rect;
export function cropLabel(s: CropSession, o?: { straighten?: boolean }): string;                 // '2400 × 1600 · 3:2' (+ ' · 직선화 1.4°')
export function maxStraightenFor(natW: number, natH: number): number;                            // MAX_STRAIGHTEN_PIXELS 로 슬라이더 범위

// useCropSession.ts — ImageEditor 안. 계약의 AnnotationLayerHandle.crop* 는 이 객체로 이동(§3.1)
export interface CropApi {
  enter(): void;                                        // mode.crop 진입 effect 가 부른다. base 스냅샷, rect = doc.crop ?? bounds
  cropSet(patch: Partial<CropSession>): void;           // straighten 변경 → straightenObjects + rect 재중심·클램프, applyDoc(live,'replace')
  cropTransform(delta: OrientDelta): void;              // 세션 안 회전/반전(§3.5)
  cropAutoTrim(): void;                                 // autoTrimRect → cropSet({rect}) | 토스트
  cropApply(): void;                                    // replace(base) → commit(final, `크롭 ${w}×${h}`) → setMode(design). 무변경이면 커밋 0
  cropCancel(): void;                                   // replace(base) → setMode(design)
  getCropSession(): CropSession | null;
}
export function useCropSession(deps: { docRef; applyDoc; oriented; img; ui: ReturnType<typeof useImageEditorUi.getState> }): { session: CropSession | null; api: CropApi };

// AnnotationLayer props 변경(cropMode/cropRect/onCropDown/Move/Up/Cancel 5개 → 2개)
crop: CropSession | null;                               // null = 크롭 모드 아님(doc.crop 딤 표시는 42/43 ChromeState 가 doc 에서)
onCropRect(rect: Rect): void;                           // 핸들·이동·새 사각형 드래그 up 1회
// AnnotationLayerHandle: setCropPreview 삭제. handleEscape 계층 3 이 cropResize/cropMove/cropDraw 를 버린다.
// pointer.ts DragState 추가: {mode:'cropResize'; handle; base: Rect} | {mode:'cropMove'; start; base: Rect} | {mode:'cropDraw'; start}

// 43 소비: paintNow 가 chrome.update({ ..., crop: { rect: live ?? session.rect, overlay, straightenDeg }, hud: { text: cropLabel(s,{straighten:true}), at: 상단 중앙 } })
// 42 소비: EDITOR_SHORTCUTS 의 `enter`/`esc` 행(42 §3.4 모드 그룹)이 mode.crop 에서 api.cropApply/cropCancel 을 부른다(Esc 계층 6 자리) — 별도 행 없음
// e2e 30 허용 수정(이 태스크): `A.cropOn` 정규식 1줄 · `click(/크롭 선택/)` 1줄 (§2)
//         상태바 문자열 = session ? `크롭 ${cropLabel(session)}` : ''
// 45 소비: ContextBar 'crop' 변형 = <CropContextBar session api onRotate onFlip/> · AdjustTab 크롭 섹션 = <CropInspectorSection session api doc onEnter onClear/>

export function CropContextBar(p: { session: CropSession; api: CropApi; maxDeg: number }): JSX.Element;
// 비율 칩 7(사용자 = NumField w:h 2개) · 오버레이 4 · 직선화 range(−maxDeg..maxDeg, step .1) + '1.4°' · 반전 2/회전 2 아이콘 · 여백 자동 제거 · 취소 · 적용 ⏎
export function CropInspectorSection(p: { session: CropSession | null; api: CropApi; doc: EditorDoc; onEnter(): void; onClear(): void }): JSX.Element;
// 세션 중: '적용 전' 칩 · '3:2 가로' · 각도 NumField · W/H/X/Y NumField(cropSet, blur/Enter 1회) · 오버레이 4 · '크롭 영역 밖 삭제' 토글 · 이미지 안으로 제한 토글
// 세션 밖: '크롭 (C)' 버튼(onEnter → setMode crop) + doc.crop 있으면 'W × H px' + '해제'(현행 clearCrop :547-550)
```

e2e 훅(`window.__gpv.imageEditor`, 기존 `:955` 옆): `getOrientedSize(): {w; h}` · `cropSession(): CropSession | null` · `crop: CropApi`(DEV) · `histDepth(): {past; future}`.

## 5. 단계

1. **crop.ts + 직선화 배관**(≈220 + ImageEditor ≈ −30/+25): `buildOriented` 이관·`straighten` 인자, `oriented` 메모 의존성, `:404` 줌 리셋 의존성 축소, `resetAll` straighten 해제, `straightenedSize/straightenObjects/maxInscribedRect/cropBounds/aspectRatioOf/fitAspect/resizeCropRect/cropLabel`. 30/34/35 격리 실행 → 기준선과 비트 동일(θ=0). e2e 39 (ab)(ac-1).
2. **세션·포인터**(`useCropSession.ts` ≈160, `pointer.ts` +≈120, AL ≈ +40/−40, ImageEditor ≈ −70/+40): 옛 `cropMode/onCropDown/Move/Up/Cancel/setCropPreview/cropStartRef/cropLiveRef` 삭제, `crop`/`onCropRect` props, 8핸들 히트·커서·스냅, `ChromeState.crop/hud` 채움, 42 액션 맵 `enter`/`esc`의 `when:'crop'` 분기 → `cropApply/cropCancel`, e2e 30 헬퍼 2줄(§2), 모드 effect. e2e 39 (z)(aa)(ac)(ae)(af) + 30 (k)(d) 통과.
3. **UI**(`CropContextBar.tsx` ≈140, `CropInspectorSection.tsx` ≈120): 45 슬롯 마운트, `cropAutoTrim`·`deleteOutside`·`cropTransform`, 상태바 문자열, `MAX_STRAIGHTEN_PIXELS` 힌트. e2e 39 (ad)(ag)(ah).
4. **원장·실기**: 40 §7 표에 §3.6 θ 행 + 4K 슬라이더 틱 시간 기록, 실기 §7.

규모 **L**: 프론트 ≈ +1,080/−110 · Rust 0 · 신규 의존 0. `geometry.ts` 무변경(46 → 39 직렬 편집 밖).

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| 직선화 틱마다 oriented 재생성 | 4K에서 40~72MB 캔버스 할당 + `drawImage` + AL 캐시 재구축이 매 틱 | 슬라이더 입력을 rAF로 코얼레싱(기존 `schedule` 관례), 40 실측표에 틱 시간 기록. 16ms 초과 시 `ponytail:` 후속 — 드래그 중엔 이전 oriented를 `ctx.rotate`로 회전해 그리고 up에서만 재생성 |
| 부호 오류(det) | 반전 홀수 개에서 이미지와 주석이 반대로 돈다 | `rotateBy`의 `mirrored` 규칙 재사용(코드 1곳) + e2e (ac-2) `flipH` 후 θ=10 → 주석 중심이 `R(−10°)` 위치 ±0.5px |
| 세션 중 앱 종료·창 X | 41 `flush`가 라이브 문서(replace 상태)를 사이드카에 쓴다 | `requestClose`·`onCloseRequested`·unmount 경로가 `cancelIfActive()` 선행. e2e (ai) 세션 중 `imageDocs.read` → base와 동일 |
| 초기 사각형 = 전체라 "드래그로 새 사각형"이 안 됨 | 종전 UX(빈 곳 드래그)는 사각형을 줄인 뒤에만 가능 | 핸들 8개가 항상 보이므로 Figma·Lightroom 관례와 같다. 30 (k)는 이동 드래그로 해석돼도 단언 유지(§3.3) |
| `constrainToImage` OFF에서 투명 모서리 저장 | 사용자가 의도적으로 껐을 때 PNG 모서리 α<255, JPEG는 흰색 | θ 절댓값 15° 이하에서만 허용, 토글 툴팁 '이미지 밖은 투명으로 저장됩니다'. 39 `background:'#fff'`(jpeg) 규칙 그대로 |
| `autoTrimRect`가 스크린샷 그림자·안티앨리어스 테두리에 걸림 | tol 8이 그림자 그라디언트를 배경으로 안 본다 | 결과가 `bounds`와 같으면 토스트 '제거할 여백이 없습니다'. tol은 상수 1곳 |
| `deleteOutside`가 그룹 일부만 지움 | 리프 단위 제거로 그룹이 반쪽 남는다 | 의도된 동작(Figma 동일). 라벨 `크롭 W×H` 1커밋이라 undo 1회 |
| 라벨 교체로 e2e 30 (k)가 깨짐 | `/영역을 드래그/`·`/크롭 선택/` 라벨이 사라진다 | 48 단계 3에서 헬퍼 2줄을 같은 커밋에 고친다(§2·§4). 42(모드·키)가 먼저 머지된다(deps 42,43) |
| 세션 중 `undo`(Ctrl+Z) | `replace` 상태에서 undo하면 base 이전으로 간다 | 42 표 `when:'crop'`에서 undo/redo 비활성(Figma 크롭 중 동일). 액션 맵이 `session && return` |

## 7. 검증

- **e2e 39 (`39-image-vector.mjs` 크롭 절, 46·47과 공유)**: (z) `setDoc({crop:{40,40,100,100}})` → `setMode(crop)` → `cropSession().rect` 동일; SE 핸들 `(140,140)→(180,180)` pointerSeq → `rect.w===140 && rect.h===140`; `cropSet({aspect:'16:9'})` → `h===round(w·9/16)`; `'original'` → 200px 픽스처에서 `w===h`; 안쪽 드래그 `+20,+20` → x,y +20·w,h 불변; 경계 밖으로 이동 → 클램프. (aa) `overlay:'thirds'` → `svg [data-chrome=crop] line` 4개(43 셀렉터), `'diagonal'` 2개; 적용 후 `saveAs` 픽셀에 `SELECT_COLOR` 계열 0(크롬 비영속 — SVG라 구조적). (ab) `setDoc({straighten:1.4})` → `getOrientedSize()` 딥이퀄 `straightenedSize(200,200,1.4)`(=205×205); `straighten:0` 복귀 → 저장 PNG 바이트가 직선화 전과 동일(비트 동일 증명). (ac-1) `rectObj(40,40,20,20)` + 세션 `cropSet({straighten:10})` → 객체 중심 == `R(10°)(c−c₀)+c₁` ±0.5; 50틱(`0→10→0` 반복) 후 `getDoc().objects` 딥이퀄 base·`histDepth()` 불변; `cropCancel()` → `getDoc()` 딥이퀄 base. (ac-2) `flipH` 상태에서 θ=10 → 중심 == `R(−10°)` 위치. (ad) 20px 흰 여백 + 빨강 중심 픽스처 → `cropAutoTrim()` → `rect` 딥이퀄 `{20,20,160,160}`; 흰 픽스처(여백 없음) → rect 불변 + 토스트. (ae) `deleteOutside:true` + 크롭 안/밖 rect 2개 → `cropApply()` → `objects.length===1`·`histDepth().past +1` 정확히·마지막 라벨 `/크롭 \d+×\d+/`; `false`면 2개 유지·저장 파일은 30 (d)와 같은 클리핑. (af) θ=10·`constrainToImage:true` 적용·저장 → PNG 네 모서리 α255·`rect` ⊂ `maxInscribedRect`; `constrainToImage:false`(|θ|≤15) → `rect` 전체 가능·저장 (0,0) α<255. (ag) `cropSet({straighten:20})` → `constrainToImage===true`로 강제, `cropSet({constrainToImage:false})` 무시. (ah) DOM: 세션 중 `[role=toolbar]`에 비율 칩 7·오버레이 4·range·`적용`·`취소`; 조정 탭 섹션에 `적용 전`·`3:2 가로`·W/H/X/Y·`크롭 영역 밖 삭제`; W 입력 `120`+Enter → `rect.w===120`; 상태바 텍스트 `/크롭 \d+ × \d+ · /`. (ai) 세션 중 `cropTransform('rotCW')` → `getOrientedSize()` 전치·`rect` 회전 대응·`cropCancel()` 뒤 rotation 복귀; 세션 중 `imageDocs.flush()` → 읽은 문서 딥이퀄 base.
- **회귀**: 30(91)·34(32)·35(13) — 단계 1 뒤 비트 동일(θ=0), 단계 2 뒤 42 헬퍼 위에서 전부 pass. 30 (k) 계층 3·6, (d) 크롭 클리핑, 34 in-place 저장, 35 백킹 불변 특히 확인.
- **컴파일 증명**: `setTool('crop')`·`layerRef.current.setCropPreview(null)` 삽입 시 TS 에러(리뷰 체크리스트).
- **실기**: 4K 스크린샷에서 직선화 슬라이더 드래그 프레임(40 표 기록), 200% 확대 상태에서 직선화 시 줌 유지, 반전 이미지 직선화 방향, 8K 이미지에서 슬라이더 범위 힌트, doc 창(1180×860)에서 컨텍스트 바 한 줄 수납(넘치면 `flex-wrap`).
