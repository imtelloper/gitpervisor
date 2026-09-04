# 태스크 47 — 펜 도구(P)·곡률 토글·노드 편집 모드(스크림·앵커/핸들·5모드·연산·스냅·키보드)

> 상태: 설계(Design) · 대상: gitpervisor · 근거: 코드 실측 2026-09-04(워킹트리) · 선행: 태스크 37(`PathNode/PathVert`·`GeomNode`·AnnotationLayer 4모듈 분할),
> 38(`hitTest/selectBox/objectFrame`·`tree.indexOf`), 41(`onCommit(next,label)`·`HISTORY_LIMIT 200`), 42(`useImageEditorUi.mode`·`EDITOR_SHORTCUTS`·툴 id `vpen`),
> 43(`ChromeState.extra`·`snap.ts`), 46(`vector/path.ts`·`toPathObject`) · `DOCS/image-annotation-design.md` §5.2(도구)·§5.4(Esc 계층)·§5.6(히트·nudge),
> `DOCS/pro-image-editor-design.md` §8(벡터 편집 기각 — 사용자 결정으로 대체) · 시안: `designs/image-editor-figma-v2.pen` ③(펜·노드 편집)⑧(Var 벡터 편집) ·
> 상위: `00-INDEX.md` §10 — **M4 벡터 레인 2번째(46 뒤), 크롭(48)·텍스트(49) 레인과 병렬. 규모 XL.**

## 1. 요구사항

시안 ③ 워크스페이스 — 펜 · 노드 편집. 라벨 인용(인벤토리 `mockup-inventory.md` 프레임 ③ 116개 중 이 태스크 몫):

- 레일 `펜`(P)·`곡률`(.pen `Tool 곡률` :613) — 캔버스 위 커서 힌트 `클릭 = 코너 · 드래그 = 곡선`(`Pen Cursor`/`Cursor Hint` :17265-17306), 드래프트 중 점선 `Preview Segment`(:17190, 4px 대시 ×8).
- 모드 배너 `벡터 편집 모드 · Esc 로 편집 종료`(:15333/:15350), 아트보드 라벨 `장비별 현황판 대시보드.png · 벡터 레이어 편집 중`(:17043-17053), 전면 `Isolation Scrim`(:17023, `#0B0B0DBF`).
- 컨텍스트 바 `벡터 편집 · 지시선 벡터` + `노드 · 없음 · 코너 · 대칭 · 비대칭 · 자동`(`Node Type` :15445-15571) + `노드 추가 · 노드 삭제 · 패스 닫기 · 패스 열기 · 방향 반전`(:15591-15711) + `픽셀에 스냅 · 오브젝트에 스냅`(:16011/:16055) + `편집 완료 ⏎`(:16073). `평탄화 · 윤곽선화`(:15882/:15926)는 46이 채운다.
- 캔버스 크롬: `Anchor`(11×11 정사각, 테두리 1.5 — :17130) · `Anchor 선택`(채움 — :17145) · `Handle Line A` + `Handle`(11px 원 — :17087-17123) · 골격 `Vector Path`(:17066, accent 3px) · HUD `Node Info` = `노드 4 · 세그먼트 3 · 선택 1 · 미러 대칭`(:17321-17450).
- 인스펙터 `Sec 노드`(:18219): `열린 패스` · `X 550 · Y 550` · `코너/대칭/비대칭/자동` · `핸들 in −60, −80 · 핸들 out 60, 80`(:18262-18515).
- 상태바 `노드 1개 선택 · 대칭 핸들`(:20181), 레이어 행 뱃지 `노드 편집`(:2150, 44가 그린다), 히스토리 항목 `지시선 벡터 노드 편집`(⑤, 41 라벨).
- ⑧ `Var 벡터 편집`(:47190): `코너 · 대칭 · 비대칭 · 자동 · 편집 완료 ⏎`(:47324-47600).

받아들이는 조건:
- 펜: 클릭 = 코너 정점, 드래그 = 곡선(대칭 핸들), Alt 드래그 = 들어오는 핸들 고정, Shift = 15° 스냅, 첫 정점 위 클릭 = 닫기, Enter/Esc/더블클릭 = 열린 채 완료. 완료가 **히스토리 1칸**이고 곧바로 노드 편집 모드로 들어간다(시안 ③은 펜 직후 상태). 드로잉 중 Backspace/Ctrl+Z 는 드래프트의 마지막 정점만 지운다(문서 히스토리 불변).
- 곡률 = 레일 토글. 켜면 펜 클릭이 `auto` 정점을 만들어 이웃에서 핸들이 계산된다. 별도 도구 상태가 아니다(INDEX §10 42행 판정).
- 노드 편집: 정점·핸들·세그먼트 드래그, 노드 마퀴(Shift 누적), 5모드(없음/코너/대칭/비대칭/자동), 추가/삭제/닫기/열기/반전, 픽셀·오브젝트 스냅, Delete·Esc 계층·Enter·방향키 1/10px·Ctrl+A·Ctrl+클릭/더블클릭 정점 = 코너↔대칭. 드래그 1회·버튼 1회·keydown 1회 = 히스토리 1칸. 모드 진입/종료·노드 선택은 히스토리에 안 쌓인다.
- 스크림·앵커·핸들·러버밴드·HUD 는 **저장 파일에 샐 경로가 없다**(SVG 크롬). 편집 중인 객체는 확대(디테일 캔버스 [2] 활성)에서도 스크림 위로 온전히 보인다.
- 문서 undo/redo 로 편집 객체가 사라지면 모드가 스스로 종료된다. `연결 · 끊기 · 도형 삽입`은 시안에 없어 **제외**(INDEX §10.3 47행).
- 이 태스크만 머지해도 쓸 수 있다: 46의 `path` 노드가 있으면 펜으로 만들고 노드를 편집·저장·복원(41)할 수 있다. 46 없이는 컴파일되지 않는다(`PathNode` 렌더가 46).

## 2. 현황(근거)

- **베지어 펜 도구가 없다**: `types.ts:14-24 Tool` 10종(`select pen highlight line arrow rect ellipse text badge mosaic`), `AnnotationLayer.tsx:88-99 TOOL_KEYS`의 `p`는 자유곡선 `pen`. `makeDraft`(`:1155-1214`)는 도구별 드래프트를 한 제스처(down→move→up)로 만들고 `default: null`(`:1211`) — 클릭을 **여러 번** 쌓아 하나의 객체를 만드는 도구는 `DragState`(`:119-134` crop/draw/marquee/move/resize)에 자리가 없다. 42가 `Tool`에 `'vpen'`을 넣고 P 를 재배정한다(INDEX §10.3 42행) — 도구 동작은 여기.
- **드래그는 이미 "base 에서 재계산"이다**: `applyDragAt`(`:536-563`) — move 는 `d.base.map(translateObject)`(`:556-560`), resize 는 `resizeObject(d.base, …)`(`:562`), pointerup 이 마지막 좌표를 같은 함수로 한 번 더 반영(`:585`)한 뒤 `commitObjects` 1회(`:610-616`). 정점·핸들 드래그도 같은 틀에 `base: PathNode` 를 두면 누적 드리프트가 구조적으로 0이다.
- **히트 우선순위 선례**: `onPointerDown`(`:395-498`)은 단일 선택의 핸들 8점 좌표 비교(`hitHandle` `:1144-1152`, `HANDLE_GRAB_CSS 10` `:63`)를 **객체 히트보다 먼저** 본다(`:411-425`) → `hitTestIndex`(`:426`) → 빈 곳 마퀴(`:427-436`). 노드 편집의 "핸들 → 앵커 → 세그먼트 → 노드 마퀴"는 이 순서의 확장이다. 세그먼트 판정은 `geometry.ts:408-433 hitTestIndex`의 `isPointInStroke`(`lineWidth = max(strokeWidth, 10/s)` `:415,:424`)와 같은 허용오차를 쓰되, 삽입 위치(`seg,t`)까지 필요하므로 46의 `projectToSubPath` 하나로 판정과 투영을 함께 한다.
- **편집 객체를 캐시에서 빼는 기제가 있다**: `ensureCache`(`:219-231`)가 `liveRef`·`editingRef`의 id 를 `excluded`에 넣고 캐시 키에 포함(`:224`), `paintNow`(`:278-290`)가 라이브 객체를 매 프레임 위에 그린다. 노드 편집 중 객체는 그냥 `liveRef`에 두면 된다 — 새 코드 0. 39 뒤에도 `[1]` 씬 캔버스의 "커밋 캐시 + 라이브 재렌더" 구조는 유지된다(39 §4 소비자 변경, 40 §3.4 샌드위치).
- **화면 크롬은 캔버스에 그린다(43 전)**: `drawSelection`(`:914-973`, `k = scale/displayScale` `:930`)·`drawHud`(`:1009-1076`, 11px·`rgba(20,20,24,.85)`)·`drawMarquee`(`:1096-1114`). 43이 전부 SVG `ChromeOverlay`로 옮기고 `ChromeState.extra: ChromePrim[]` 슬롯을 준다 — 확대 시 디테일 캔버스 `[2]`가 `[1]` 위에 뜨므로(40 §3.1) 캔버스 크롬은 **노드를 편집하려고 확대하는 순간** 가려진다. 이 태스크의 크롬은 처음부터 `extra` 프리미티브다.
- **키보드**: `AnnotationLayer.tsx:639-720` window 버블 리스너 — 입력 요소·prompt/confirm 가드(`:643-654`), Delete(`:677-683`), `[`/`]`(`:684-689`), Arrow + `ev.repeat` 무시(`:690-711`, K5), 도구 키(`:712-716`). 42가 이 리스너를 `EDITOR_SHORTCUTS` 표 + window **capture** 리스너 1개로 흡수한다(INDEX §10.4) — 47은 **행을 추가**하고 액션 핸들러를 `AnnotationLayerHandle`에 둔다. 리스너를 새로 달지 않는다.
- **Esc 계층**: 레이어 `handleEscape`(`:727-756`: 텍스트 확정 → 진행 중 드래그 취소 → select 복귀 → 선택 해제) → 에디터(`ImageEditor.tsx:912-929`: 크롭 해제 → 닫기). 노드 편집의 "펜 드래프트 → 노드 선택 해제 → 모드 종료"는 레이어 계층 안에 끼운다(`ImageEditor.tsx:918`이 `handleEscape()` 반환값으로 멈추는 구조 그대로).
- **더블클릭**은 텍스트만(`:620-631`). undo/redo 는 선택을 비운다(`ImageEditor.tsx:272-286`, 41이 "존재 id 필터"로 바꾼다).
- **히스토리**: `history.ts:10 HISTORY_LIMIT = 50`(41 → 200), `commit(next)` 라벨 없음(41 → `commit(next,label)`). 정점마다 커밋하면 20정점 펜이 20칸 — 펜 완료 1칸이어야 하는 근거.
- **패스 모델**(37 §4): `PathVert{x,y,inX,inY,outX,outY,mode:'corner'|'mirrored'|'asymmetric'|'auto'}` 상대 핸들·`(0,0)=없음`, `PathNode{kind:'path';subpaths:{verts,closed}[];fillRule}`. 시안 `Node Type`의 **`없음`은 모드가 아니라 "양 핸들 (0,0)"**이다 — 37은 4모드이고 이 문서는 37을 따른다(§3.3). `src/lib/annotate/`에는 아직 `vector/` 디렉터리가 없다(ls: geometry/history/render/types 4파일) — `path.ts`·`convert.ts`는 46이 만든다.
- **e2e 헬퍼**: `30:315-369 pointerSeq`는 `opts.shift`만 받고(`:328`) alt/ctrl·dblclick 이 없다. `A.key`(`:396-406`)는 shift/repeat 만. 39 스위트(46 신설)의 헬퍼에 `alt`·`ctrl`·`dblclick` 을 더한다. 제품 DEV 훅은 `window.__gpv.imageEditor`(`ImageEditor.tsx:951-964`) — `__gpvAnno`는 스위트가 설치하는 헬퍼 객체다(`30:503`).

## 3. 설계

### 3.1 펜 드래프트 — 정점을 쌓는 제스처는 `DragState`가 아니라 `PenDraft`

| 대안 | 평가 |
|---|---|
| **A. `penDraftRef: PenDraft`(정점 배열·닫힘·커서·대상)를 따로 두고 pointerdown/move/up 은 "정점 하나의 핸들 드래그"만 `DragState`에 싣는다** (채택) | 한 정점의 down→drag→up 은 기존 제스처 틀과 같고(`base`에서 재계산), 정점 누적은 그 밖의 상태다. 완료 시 `PathNode` 하나로 `onCommit(…, '펜 경로 생성')` 1회 |
| B. `DragState.draw` + `draftRef`(자유곡선 `pen`처럼 `appendPenPoint` `:550`) | 자유곡선은 버튼을 뗄 때 끝나지만 펜은 뗀 뒤에도 이어진다 — `onPointerUp`(`:603-608`)이 즉시 커밋해 버린다 |
| C. 정점마다 커밋 | 20정점 = 20칸(HISTORY_LIMIT), K5 와 같은 이유로 탈락 |

입력 의미(정점 = `PathVert`, 상대 핸들):

| 입력 | 결과 |
|---|---|
| 클릭(이동 < `MIN_DRAG` 3 `:65`) | `mode:'corner'`, 핸들 0. 곡률 토글 ON 이면 `'auto'`(`settleAuto` 로 이웃에서 계산) |
| 누른 채 드래그 | `out = pt − 앵커`, `in = −out`, `mode:'mirrored'` |
| Alt 드래그 | `out`만 갱신, `in` 불변 → `in≠0` 이면 `'asymmetric'`, 아니면 `'corner'` |
| Shift | 직전 정점 기준 `snapAngle(…, SHIFT_SNAP_DEG 15)`(`geometry.ts:88-102`) — 드래그 중엔 핸들 각도에 적용 |
| 첫 정점 호버(`HANDLE_GRAB_CSS/displayScale` 안)·클릭, 정점 ≥ 2 | `closed:true` → 완료. 호버 중 첫 앵커를 채움으로 강조 |
| Enter / 더블클릭 / Esc(정점 ≥ 2) | 열린 채 완료. Esc 에 정점 < 2 면 폐기(커밋 0) |
| Backspace / Ctrl+Z(드래프트 중) | 마지막 정점 제거. 정점 0 이면 드래프트 폐기. `handleUndo()` 가 소비해 문서 undo 로 가지 않는다 |
| 완료 | 정점 ≥ 2 면 `PathNode`(`DefaultPaint`의 strokes/strokeWidth, `fills:[]`, `fillRule:'nonzero'`) 커밋 1회 → 선택 → `enterNodeEdit(id)`. 도구는 `vpen` 유지 |

노드 편집 중 `vpen` 으로 **빈 곳** 클릭 = 같은 객체에 새 서브패스 드래프트(`target:{kind:'append', id}`), 완료 시 `subpaths` 에 추가 1커밋 — 드래프트 코드가 같고 46의 `짝수-홀수`(구멍)가 이 경로로만 만들어진다. 세그먼트 위 클릭 = 정점 삽입(§3.4).

프리뷰(크롬): 마지막 정점 → 커서 러버밴드 + "커서를 다음 코너 정점으로 가정한" 세그먼트를 4px 대시로(`Preview Segment`), 커서 옆 힌트 `클릭 = 코너 · 드래그 = 곡선`(드래프트가 비어 있거나 도구 진입 직후 3초, 이후 숨김). 드래프트 자체의 확정 부분은 `PathNode` 로 만들어 **라이브 객체로 렌더**(`liveRef`) — 프리뷰가 커밋 결과와 같은 픽셀이다.

### 3.2 모드는 UI 스토어, 세션은 레이어

`mode.kind === 'nodeEdit'`(42 `useImageEditorUi.mode: {kind:'nodeEdit'; id}`)가 정본이고, 정점 선택·드래그 base·펜 드래프트·스냅 인덱스는 `AnnotationLayer` 안의 `NodeEditSession`(ref)이다. 문서(`EditorDoc`)에는 아무것도 넣지 않는다 — 넣으면 Ctrl+Z 가 "편집 모드에서 튕겨 나온다"(스냅샷이 UI 상태를 되돌린다). 42 계약대로 레이어는 스토어를 **읽기만** 하고 쓰기는 `onModeChange(m)` prop(`onToolChange` `:179` 와 같은 꼴)으로 ImageEditor 가 한다.

진입: 선택 도구로 `path` 더블클릭(38 `hitTest(scene,…,{deep:true})`) · 단일 `path` 선택 + Enter · 45 컨텍스트 바 `노드 편집` · 펜 완료. `path` 가 아닌 노드는 진입하지 않는다 — 46의 `패스로`(`toPathObject` 1커밋) 뒤 진입(§3.7).
종료: Enter/`편집 완료 ⏎` · Esc(노드 선택이 없을 때) · 도구가 `select`/`vpen` 밖으로 바뀔 때(42가 `setTool` 에서 `mode→design`) · `props.objects` 에서 `tree.indexOf(objects,id) < 0`(undo/삭제) — 레이어 effect 가 감지해 `onModeChange({kind:'design'})`. 종료는 커밋이 아니다.

### 3.3 정점 연산은 순수 모듈 `vector/edit.ts`, 출구는 `settleAuto` 한 곳

| 연산 | 규칙 |
|---|---|
| `setVertMode(o, refs, m)` | `none` → 양 핸들 0·`corner`(시안 `없음` = 표시값 `vertModeUi`: 양 핸들 0 이면 `'none'`). `corner` → 모드만. `mirrored` → `out≠0` 이면 `in=−out`, `in`만 있으면 `out=−in`, 둘 다 0 이면 Catmull-Rom 시드 `out=(P[i+1]−P[i−1])/6`. `asymmetric` → 방향만 반대로 맞추고 길이 유지(없는 쪽은 시드). `auto` → `settleAuto` |
| `moveVerts(o, refs, dx, dy)` | 앵커만 이동 — 핸들이 상대값이라 따라온다(37 §3.2 판정 근거 그대로) |
| `moveHandle(o, ref, side, to, {alt})` | `v = to − 앵커`. `mirrored` → 반대편 `−v`, `asymmetric` → 반대편 방향만 `−v̂`·기존 길이, `corner` → 반대편 불변. **Alt → 반대편 불변 + 모드 `corner`**(Figma "break"). `auto` 정점의 핸들을 잡으면 `mirrored` 로 승격 후 규칙 적용 |
| `insertVert(o, sub, seg, t)` | de Casteljau 분할 — 곡선 모양 불변. 새 정점 `asymmetric`(공선·길이 다름이 정확한 결과), 직선 세그먼트면 `corner`·핸들 0 |
| `deleteVerts(o, refs)` | 서브패스 정점 < 2 → 서브패스 제거, 전부 비면 `null`(호출자가 객체 삭제 커밋) |
| `setClosed(o, sub, closed)` · `reverseSub(o, sub)` | 반전은 순서 뒤집기 + `in/out` 교환(`heads.start/end` 가 뒤바뀌는 것이 시안 `방향 반전`의 의미) |
| `settleAuto(o, refs)` | `auto` 정점의 `in/out` 을 `±(P[i+1]−P[i−1])/6` 로 **물질화**(열린 끝은 0). 렌더러(46 `pathToPath2D`)는 `auto` 를 몰라도 된다 — 핸들 값이 문서에 있다 |

**모든 mutator 가 `settleAuto(next, 영향 정점 ∪ 이웃)` 을 거쳐 반환한다**(`edit.ts` 안의 래퍼 하나). 이웃 이동 시 auto 핸들 재계산을 빠뜨리면 곡선이 안 따라오는 결함(INDEX §10 47행 위험)을 출구 하나로 막는다.

| 대안 | 평가 |
|---|---|
| 렌더 시 `auto` 를 해석 | 46 렌더·38 bbox·43 스냅·46 불리언 전부가 이웃을 봐야 한다 — 소비자 4곳에 같은 수식 |
| **문서에 물질화 + 편집 출구 한 곳** (채택) | 문서가 자기완결(사이드카 41·불리언 46·윤곽선화 46이 값만 읽는다) |

### 3.4 세션 — 히트 우선순위와 드래그(`annotation/nodeEdit.ts`)

pointerdown(모드 `nodeEdit`, 도구 `select`|`vpen`), 허용오차 `tol = HANDLE_GRAB_CSS / displayScale`:

1. **핸들 노브** — 선택 정점과 그 양옆 이웃의 `in/out` 끝점(원, `tol`). 핸들이 앵커 위에 겹칠 수 있어 **앵커보다 먼저**(e2e (o) 회귀 단언).
2. **앵커** — 모든 정점(정사각, `tol`). Shift = 누적 토글, Ctrl+클릭 = 코너↔대칭 토글(커밋 1), 아니면 단일 선택 → `DragState {mode:'vert'; refs; base}`.
3. **세그먼트** — 46 `projectToPath(o, pt)` 의 `dist ≤ max(strokeWidth/2, tol)`. 도구 `vpen` 이면 `insertVert(seg, t)` 커밋 1 + 새 정점 선택, `select` 면 양 끝 정점 선택 + `vert` 드래그(굽히기는 시안 밖 — `ponytail:` 주석).
4. **빈 곳** — `vpen` 이면 새 서브패스 드래프트(§3.1), `select` 면 **노드 마퀴**(`{mode:'vmarquee'; keep}` — Shift 누적은 `:126 keep` 관례). 다른 객체는 집히지 않는다(격리).

드래그 적용은 `applyDragAt` 의 분기 하나: `liveRef = [moveVerts(d.base, …) | moveHandle(d.base, …)]` — **항상 `d.base`(pointerdown 시점 `PathNode`)에서** 계산, pointerup 에 `onCommit(objects.map(replace), '노드 이동' | '핸들 조정')` 1회. 37 분할 뒤 `pointer.ts` 에는 진입 3줄(`if (session) return nodeEdit.onDown(…)`)만 들어가고 본체는 이 파일이다 — 48(크롭)과 같은 파일을 만지는 면적을 3줄로 묶는다.

스냅: 드래그 시작에 43 `buildSnapIndex(scene, new Set([editId]), guides, {gridPx, pixel: toggles.snapPixel, objects: toggles.snapObjects, guides: toggles.snapGuides, canvas})` 1회, 매 move `snapPoint(idx, 앵커, tol)` 의 `dx,dy` 를 더하고 `lines` 는 `ChromeState.smartGuides` 로. 핸들 드래그는 **픽셀 스냅만**(`Math.round`). `픽셀에 스냅 · 오브젝트에 스냅` 토글은 42 `toggles.snapPixel/snapObjects` 그대로 — 노드 전용 스냅 상태를 두지 않는다(같은 값에 두 이름 금지).

문서 undo 로 정점 수가 줄면 `sel` 은 범위 안 정점만 남긴다(41의 "존재 id 필터"와 같은 규칙).

### 3.5 크롬 — 전부 `ChromeState.extra` 프리미티브(43), 캔버스 드로우 0

| 요소 | 프리미티브 | 비고 |
|---|---|---|
| 스크림 | `{k:'scrim'; color:'#0B0B0D'; alpha:.75; cutoutD; cutoutStrokeCss}`(43 §4 `ChromePrim`) | 시안 `#0B0B0DBF`. **편집 객체 모양(46 `pathToSvgD` + `strokeWidth`)을 SVG mask 로 뚫는다** — 객체는 `[1]`/`[2]` 의 진짜 렌더가 그대로 보이고 나머지가 어두워진다. 효과(그림자)는 구멍 밖이라 함께 어두워진다(문서화) |
| 아트보드 라벨 | `text` `<파일명> · 벡터 레이어 편집 중` | 객체 AABB 좌상단 위 |
| 골격선 | `path`(d = `pathToSvgD`, accent 1.5 css px) | 스크림 구멍 경계에 얹는 안내선 — 시안 `Vector Path` |
| 앵커 | `rect`(rot 0) 11 css px, 테두리 1.5, 선택 = 채움 | 정점 수만큼. `ponytail:` 정점 2,000 초과 시 뷰포트 밖 컬링 |
| 핸들 | `line` + `circle` 11 css px | 선택 정점 + 양옆 이웃만(시안: 선택 정점의 두 핸들) |
| 러버밴드·프리뷰 세그먼트 | `line` 대시 4/4 · `path` 대시 | 펜 드래프트 중 |
| HUD | `text` `노드 N · 세그먼트 M · 선택 K · 미러 <모드>` | 객체 AABB 우하단, `drawHud`(`:1064-1069`) 배치 규칙 승계 |
| 커서 힌트 | `text` `클릭 = 코너 · 드래그 = 곡선` | 커서 우하단 |

`paintNow` 끝에서 `chromeRef.update({...s, extra: nodeChrome(session, view)})` — 43의 rAF 직접 DOM 갱신 규칙. 포인터·커서는 종전대로 `[1]` 이 받는다(`vpen`/노드 편집 = `cursor-crosshair` 클래스 `:813-817` 그대로).

| 대안 | 평가 |
|---|---|
| 캔버스 `[1]` 에 스크림 `fillRect` + 라이브 객체 재렌더 | 확대 시 `[2]` 가 위를 덮어 스크림이 사라지고, 40 `renderRegion` 에 "커밋과 라이브 사이" 훅이 필요해진다. INDEX §10.4 "캔버스 크롬 0건" 위반 |
| SVG 스크림, 구멍 없음(객체도 어두워짐) + 골격선만 | 편집 중 객체 색을 못 본다. 구멍은 `<mask>` 하나 — 비용 SVG path 1개 |

### 3.6 키·명령 — 42 표에 행 추가, 핸들러는 `AnnotationLayerHandle`

| 행(`when`) | 동작 |
|---|---|
| `Enter`(`nodeEdit`·펜 드래프트) | 드래프트 있으면 완료, 없으면 종료 — `handleEnter()` |
| `Escape`(계층) | 텍스트 확정 → **펜 드래프트 완료/폐기** → 진행 중 드래그 취소 → **노드 선택 해제** → **`nodeEdit` 종료** → select 복귀 → 선택 해제(기존 `:727-756` 확장) |
| `Delete`/`Backspace`(`nodeEdit`) | `deleteVerts` 커밋 1(`'노드 삭제'`); 객체가 비면 객체 삭제 커밋 |
| `Arrow`/`Shift+Arrow`(`nodeEdit`) | `moveVerts(±1/±10)` keydown 1 = 커밋 1, `ev.repeat` 무시(`:695-698` K5) |
| `Ctrl+A`(`nodeEdit`) | 전체 정점 선택(문서 불변) |
| `Ctrl+Z`(펜 드래프트) | `handleUndo()` 가 마지막 정점 제거로 소비 — ImageEditor 의 undo 액션이 `if (layerRef.current?.handleUndo()) return;`(`:918` `handleEscape` 와 같은 꼴) |
| Ctrl+클릭 / 더블클릭 정점 | 코너↔대칭 토글(포인터, 표 밖). 디자인 모드의 Ctrl+클릭(리프 관통 선택)과는 모드가 달라 충돌 없음 — 툴팁 표기 |

컨텍스트 바 버튼 = 같은 핸들 API(`nodeOp`·`setNodeMode`). `노드 추가` 버튼 = 인접한 선택 정점 2개 사이 `t=.5` 삽입(아니면 비활성) — 세그먼트 클릭 삽입(§3.4)의 버튼판.

### 3.7 만들지 않는 것

- `연결 · 끊기 · 도형 삽입`(시안 밖, INDEX §10.3), 세그먼트 드래그로 굽히기(핸들 비례 조정 — `ponytail:` 상향 경로), 펜 커서 이미지(`cursor:url()` — crosshair 유지), 정점별 반경(Figma 코너 라운딩 — 시안 ③ 라벨 없음).
- `path` 외 노드의 직접 노드 편집 — 46 `toPathObject` 로 변환 후(45 컨텍스트 바 `패스로`).
- 인스펙터 `선 · 채우기 · 불리언 · 평탄화/윤곽선화/패스 분리`(46 `PathInspectorSection`), 레이어 뱃지·모드 배너 렌더(44·42), 스냅 인덱스·스마트 가이드 표시(43), 히스토리 라벨 폴백(41 `describeChange`).
- 노드 전용 스냅 상태(`setNodeSnap`) — 42 토글 재사용으로 대체.

## 4. 계약 (소유: 47 · `src/lib/annotate/vector/edit.ts`, `src/components/image/annotation/nodeEdit.ts`, `annotation/pen.ts`, `NodeContextBar.tsx`, `NodeInspectorSection.tsx`)

```ts
// vector/edit.ts — 순수. 입력·출력은 37 PathNode(불변 갱신). 모든 mutator 는 settleAuto 를 거친다.
export type VertRef = { sub: number; vert: number };
export type NodeModeUi = PathVert['mode'] | 'none';                       // 'none' = 양 핸들 (0,0) (37 은 4모드)
export function vertModeUi(v: PathVert): NodeModeUi;
export function setVertMode(o: PathNode, refs: readonly VertRef[], mode: NodeModeUi): PathNode;
export function moveVerts(o: PathNode, refs: readonly VertRef[], dx: number, dy: number): PathNode;
export function moveHandle(o: PathNode, ref: VertRef, side: 'in' | 'out', to: { x: number; y: number }, opts: { alt: boolean }): PathNode;
export function insertVert(o: PathNode, sub: number, seg: number, t: number): { obj: PathNode; ref: VertRef };   // de Casteljau
export function deleteVerts(o: PathNode, refs: readonly VertRef[]): PathNode | null;
export function setClosed(o: PathNode, sub: number, closed: boolean): PathNode;
export function reverseSub(o: PathNode, sub: number): PathNode;
export function settleAuto(o: PathNode, refs?: readonly VertRef[]): PathNode;   // auto 핸들 물질화(Catmull-Rom /6)
export function vertCount(o: PathNode): number;  export function segmentCount(o: PathNode): number;

// annotation/pen.ts — 펜 드래프트(문서 밖)
export interface PenDraft { target: { kind: 'new' } | { kind: 'append'; id: ObjId }; verts: PathVert[]; cursor: { x: number; y: number } | null; dragging: VertRef | null }
export function penDown(d: PenDraft | null, pt, mods: { shift; alt }, o: { curvature: boolean; tol: number }): { draft: PenDraft; close: boolean };
export function penDrag(d: PenDraft, pt, mods): PenDraft;           // 마지막 정점 out/in
export function penPop(d: PenDraft): PenDraft | null;               // Backspace / Ctrl+Z
export function penFinish(d: PenDraft, closed: boolean, paint: DefaultPaint): PathNode | { sub: PathNode['subpaths'][number] };
export function penPreview(d: PenDraft): ChromePrim[];              // 러버밴드·Preview Segment·힌트

// annotation/nodeEdit.ts — 세션(AnnotationLayer ref)
export interface NodeEditState { id: ObjId; nodeCount: number; segmentCount: number; selected: VertRef[]; mode: NodeModeUi | 'mixed' | null;
  anchor: { x: number; y: number } | null; handleIn: [number, number] | null; handleOut: [number, number] | null; open: boolean; draft: { verts: number } | null }
export type NodeOp = 'add' | 'delete' | 'close' | 'open' | 'reverse' | 'select-all' | { nudge: [number, number] };
export type NodeHit = { kind: 'handle'; ref: VertRef; side: 'in' | 'out' } | { kind: 'vert'; ref: VertRef } | { kind: 'seg'; sub: number; seg: number; t: number } | null;
export function hitNodeEdit(o: PathNode, sel: readonly VertRef[], pt, tol: number): NodeHit;          // 핸들 → 앵커 → 세그먼트(46 projectToPath)
export function nodeChrome(o: PathNode, st: NodeEditState, draft: PenDraft | null, hoverFirst: boolean): ChromePrim[];   // §3.5 표
export const SCRIM = { color: '#0B0B0D', alpha: 0.75 }; export const ANCHOR_CSS = 11; export const KNOB_CSS = 11;

// AnnotationLayerHandle 확장(기존 handleEscape/renderOnce/setCropPreview 유지)
enterNodeEdit(id: ObjId): boolean;  exitNodeEdit(): void;  getNodeEditState(): NodeEditState | null;
nodeOp(op: NodeOp): void;  setNodeMode(mode: NodeModeUi): void;  selectVerts(refs: readonly VertRef[]): void;
handleEnter(): boolean;  handleUndo(): boolean;
// AnnotationLayerProps 추가: mode: Mode(42) · onModeChange(m: Mode) · onNodeEditChange(s: NodeEditState | null) · toggles(42 curvature/snapPixel/snapObjects/snapGuides)

// UI (45 가 마운트)
export function NodeContextBar(p: { state: NodeEditState; api: AnnotationLayerHandle; toggles; setToggle }): JSX.Element;   // 이름 · 5모드 · 추가/삭제/닫기/열기/반전 · 스냅 2 · 편집 완료 ⏎ (평탄화/윤곽선화 슬롯은 46)
export function NodeInspectorSection(p: { state: NodeEditState; api: AnnotationLayerHandle; onCommit }): JSX.Element;      // 열린 패스 · X/Y · 모드 4 · 핸들 in/out (NumField 는 45)
export function nodeStatusText(s: NodeEditState): string;   // '노드 1개 선택 · 대칭 핸들' | '노드 4 · 세그먼트 3' — 42 상태바가 부른다
```

요구(다른 태스크 소유): 42 `Tool` 에 `'vpen'`(P)·`toggles.curvature`·`Mode.nodeEdit`·표 행(§3.6)·`setTool` 이 `select|vpen` 밖으로 갈 때 `mode→design` → 태스크 42 §4 · 43 `ChromePrim` 의 `scrim(cutoutD)`(반영됨)·`rect`(정사각 앵커)·`circle`/`path`/`text` 와 `snapPoint` → 태스크 43 §4 · 46 `projectToPath(o, pt): {sub; seg; t; dist}`·`pathToSvgD(subpaths)`(반영됨 — `pathToPath2D` 와 같은 순회) → 태스크 46 §4 · 41 라벨 `'펜 경로 생성' | '노드 이동' | '핸들 조정' | '노드 추가' | '노드 삭제' | '패스 닫기' | '패스 열기' | '방향 반전' | '노드 모드 <라벨>'` → 태스크 41 §4 · 44 레이어 행 뱃지 `노드 편집`(`mode.id === row.id`) → 태스크 44.

e2e 훅(`window.__gpv.imageEditor`, `:951-964` 옆): `nodeEdit(): NodeEditState | null` · `enterNodeEdit(id)` · `nodeOp(op)` · `setNodeMode(m)` · `selectVerts(refs)`.

## 5. 단계

1. **`vector/edit.ts`**(신규 ≈260) — §3.3 표 전부 + `settleAuto` 래퍼. 46 `path.ts` 위에서만 컴파일된다(`PathNode` 타입은 37).
2. **`annotation/nodeEdit.ts`**(신규 ≈380) + `AnnotationLayer` 배선(≈+120: 세션 ref·`DragState` `vert|handle|vmarquee`·`applyDragAt` 분기·`liveRef` 등록·handle API·Esc/Enter/Undo 계층·objects effect 로 자동 종료·`chrome.extra`) + `pointer.ts` 진입 3줄 + ImageEditor(≈+40: `mode`/`onModeChange`/`onNodeEditChange` 브릿지, undo 액션의 `handleUndo` 선점, 훅 5개). 45 전이라도 `__gpv` 훅으로 e2e (m)~(r) 가 돈다.
3. **`annotation/pen.ts`**(신규 ≈180) + `AnnotationLayer`(≈+70: `vpen` 분기·드래프트 라이브 렌더·첫 정점 호버·완료→진입). e2e (i)~(l).
4. **UI**: `NodeContextBar.tsx`(≈150)·`NodeInspectorSection.tsx`(≈90)·`nodeStatusText`(+15) — 45 셸이 오기 전엔 ImageEditor 우측 aside(`:1121`)에 임시 마운트(46과 같은 자리 규칙). e2e (s)(t).
5. **e2e** `39-image-vector.mjs` 에 절 추가(≈300, 헬퍼 `alt/ctrl/dblclick` +20). `run.mjs` 변경 없음(46이 등록).

규모 **XL**: 프론트 ≈ +1,400 · Rust 0 · 신규 의존 0(펜은 3차 베지어를 직접 만든다 — 46의 `fit-curve` 는 자유곡선 변환용).

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| auto 핸들 스테일 | 이웃 정점 이동·삭제·삽입 뒤 auto 정점 곡선이 안 따라옴 | `edit.ts` 모든 mutator 가 `settleAuto` 출구 하나를 지난다. e2e (r) 이웃 이동 뒤 핸들 값 재계산 단언 |
| 핸들이 앵커 위에 겹침 | 짧은 핸들·겹친 정점에서 엉뚱한 것이 잡힘 | 핸들 우선(§3.4 1번) + e2e (o) 회귀 |
| `pointer.ts` 를 47·48 이 동시에 편집 | 37 분할 모듈 경합 | 47 은 진입 3줄만(본체 `nodeEdit.ts`), 48 은 크롭 히트·드래그 분기 +≈120(48 §5.2) — 두 편집은 순차 머지(48 → 47 권장, 3줄이 뒤) |
| 스크림이 확대에서 안 보임 | 캔버스 크롬이었다면 `[2]` 가 덮는다 | SVG 프리미티브만(§3.5). e2e (p) 는 `view.scale=3` 에서도 `[data-chrome=extra]` 안 앵커/스크림 DOM 존재 단언 |
| Ctrl+Z 가 드래프트 정점 대신 문서를 되돌림 | 42 캡처 디스패치가 `undo` 액션으로 바로 감 | ImageEditor `undo` 핸들러 첫 줄 `handleUndo()` 선점 — `handleEscape` 와 같은 패턴(`:918`) |
| Ctrl+Alt 계열과 한/영 키(우측 Alt) | 42 공통 위험 | 이 태스크의 키는 Ctrl+A·Ctrl+Z·Ctrl+클릭뿐 — Alt 는 드래그 수식키로만 |
| 정점 수천 개(펜→패스 변환 46)에서 앵커 SVG N개 | 프레임당 DOM 갱신 N | 뷰포트 밖 앵커 컬링(`ponytail:` 2,000 초과 시), 핸들은 선택+이웃만 |
| undo 가 편집 객체를 지움 | 세션이 죽은 id 를 든다 | `props.objects` effect: `tree.indexOf < 0` → 종료, 정점 수 감소 → `sel` 클램프. e2e (q) |
| 마스크 구멍이 효과까지 밝히지 못함 | 그림자·블러가 스크림 아래 | 문서화. 편집 대상은 기하라 구멍이 stroke 폭이면 충분 |
| 펜 완료 직후 `vpen` 유지가 "빈 곳 클릭 = 새 서브패스" 와 겹침 | 사용자가 새 객체를 기대 | Esc 로 모드를 나가면 다음 클릭은 새 객체(§3.1 표) — 힌트 텍스트에 표기 |

메모리(40 원장 합산용): 세션 상태 수 KB, 스냅 인덱스는 43 것 재사용, 새 캔버스 0(SVG). 4K 예산 증분 0.

## 7. 검증

- **e2e 39 추가 절 "펜·노드 편집"**(46 스위트, 헬퍼 `pointerSeq(opts.alt/ctrl)`·`dblclick`): (i) `setTool('vpen')` → 3점 클릭 → Enter → `objects.length===1`·`kind==='path'`·정점 3·`closed===false`·전부 `corner`·`history.entries()` +1 정확히·`nodeEdit().id` 가 그 id(자동 진입). (j) 2번째 점을 누른 채 (40,0) 드래그 → `mode==='mirrored'`·`out=(40,0)`·`in=(−40,0)` ±0.5; Alt 드래그 → `in=(0,0)`·`corner`. (k) 첫 정점 위 클릭 → `closed===true`; 정점 1개에서 Esc → `objects.length===0`·히스토리 불변. (l) 드래프트 중 `A.key('z',{ctrl})` → `nodeEdit().draft.verts` −1, `history.entries()` 불변. (m) `path` 더블클릭 → `nodeEdit().id`; 앵커 클릭 → `selected.length===1`; Delete → `nodeCount` −1·히스토리 +1; Enter → `nodeEdit()===null`. (n) 정점 드래그 (+30,+20) → 좌표 델타 ±0.5; `toggles.snapPixel` ON 이면 정수; Ctrl+Z 1회로 원위치. (o) 핸들 노브를 다른 앵커 위에 겹치게 `setDoc` 뒤 그 지점 드래그 → 핸들만 이동·앵커 불변. (p) 노드 편집 중 `saveAs` → 앵커·스크림 좌표 픽셀 == 배경(`readSaved`), `view.scale=3` 에서 `svg [data-chrome="extra"]` 존재·앵커 `rect` 수 == 정점 수·핸들 `circle` 수 == (선택+이웃)×2 이하. (q) undo 로 객체 소멸 → `nodeEdit()===null`; 컨텍스트 바 텍스트 `/노드 \d+ · 세그먼트 \d+ · 선택 \d+/` 갱신. (r) `toggles.curvature` ON 클릭 3점 → 가운데 정점 `auto`·핸들 ≠ 0; 이웃 정점 이동 → 가운데 핸들 값 변경(settleAuto). (s) `toggles.snapObjects` ON, 옆에 rect(40,40,60,60) → 정점을 x=42 로 드래그 → `x===40`. (t) `setNodeMode('none')` → 양 핸들 0·`corner`; `'mirrored'` → `in===−out`; `reverse` → 정점 순서 반전·`in/out` 교환; `close`/`open` 왕복; `nodeStatusText` 가 `노드 1개 선택 · 대칭 핸들`.
- **회귀**: 30(91)·34(32)·35(13) 무변경 통과(`vpen`·모드 코드 경로는 기존 스위트가 밟지 않는다; P 키 재배정에 따른 30 `activeTool` 헬퍼 수정은 42 몫). 46 (a)~(h) 무변경.
- **컴파일**: `edit.ts` 함수는 `PathNode` 만 받는다 — `RectObject` 를 넣으면 TS 에러(리뷰 체크리스트).
- **실기**: 펜으로 닫힌 도형·열린 지시선 그리기 → 확대 300% 에서 앵커·핸들 크기 불변(css px) · 스크림 구멍으로 객체 색이 보임 · 저장 파일에 크롬 없음 · Esc 계층 순서 · 한글 IME 상태에서 P/Enter/Delete 동작(42 `e.code`).
