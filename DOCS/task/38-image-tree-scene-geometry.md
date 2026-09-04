# 태스크 38 — 평탄 트리 연산·resolveScene·기하 골격(bounds 3종·씬 히트테스트·프레임/그룹)

> 상태: 설계(Design) · 대상: gitpervisor · 근거: 코드 실측 2026-09-04(워킹트리) · 선행: 태스크 37(노드 유니온·`GeomNode`),
> `DOCS/image-annotation-design.md` §3(oriented px 단일 좌표계), `DOCS/pro-image-editor-design.md` §8.2(그룹·잠금/숨김 위험 — 이 문서가 푼다) ·
> 시안: `designs/image-editor-figma-v2.pen` ①(레이어 트리)⑦(마스크)⑧(그룹·마스크·순서) · 상위: `00-INDEX.md` §10 — **M1 첫 태스크.**

## 1. 요구사항

시안 ⑧ `그룹 ⌘G · 그룹 해제 ⇧⌘G · 프레임으로 ⌥⌘G · 마스크로 사용 ^⌘M · 맨 앞으로 ⌥⌘] · 맨 뒤로 ⌥⌘[`, ① 레이어 트리의 `주석 레이어 › 치수선 그룹 › …`
중첩·`센서 위치(숨김)`·`배경(잠금)`·`고객사명 모자이크[마스크]`, ⑦ `마스크 잠금 · 함께 이동`, ① `좌·상 고정`(제약), ① 하단 `2개 선택됨 · ⇧클릭 · 드래그로 순서 변경`.

받아들이는 조건:
- 문서의 `objects: Node[]`(37)가 **트리**로 해석된다 — 그룹/프레임/인스턴스 안에 노드가 들어가고, 이동·삭제·순서 변경·그룹 해제가 트리 단위로 된다.
- **숨김 노드는 프리뷰·히트·저장 세 곳에서 동시에 사라지고, 잠금 노드는 히트만 안 된다.** 세 곳이 각자 판정하지 않는다.
- 그룹의 선택 상자·AABB가 자손 합집합이며, 그룹이 있어도 리프의 `objectAABB`·모자이크 샘플 영역·형광펜 스크래치가 **부풀지 않는다**.
- 마스크 노드는 같은 부모의 뒤 형제 전부를 가린다(Figma 규칙). `함께 이동` 잠금은 마스크와 피마스크가 한 단위로 움직인다.
- 이 태스크만 머지해도 기존 편집기가 그대로 동작한다(30/34/35 초록) — UI는 없고 **연산·해석·기하**만 들어간다.

## 2. 현황(근거)

- **객체 배열을 세 소비자가 각자 순회한다**: 프리뷰 `renderScene(ctx, objects, t)`가 선형 루프(`render.ts:62-75`), 히트 `hitTestIndex`가 역순 루프(`geometry.ts:408-434`, 호출 `AnnotationLayer.tsx:426`·`:627`), 저장 `renderOutput`이 같은 `renderScene`을 크롭 변환으로(`ImageEditor.tsx:660-691`). 숨김/잠금 필드가 생기면(37) 이 세 곳이 **각자** `if (!o.visible)`를 넣어야 하고, 하나라도 빠지면 "보이는 것 ≠ 저장된 것"이 된다 — pro 설계 §8.2가 레이어 패널을 기각한 바로 그 이유.
- **캐시는 배열 참조로 산다**: `AnnotationLayer.tsx:219-231 ensureCache`가 `cacheSrcRef.current === s.objects`로 커밋 캐시를 재사용한다. 문서를 트리로 만들되 `objects`가 **여전히 배열이고 커밋마다 새 참조**여야 이 캐시와 `history.ts:46-54`(문서 참조 스택)가 그대로 산다.
- **다중 선택 이동은 이미 "객체별 translate"다**: `AnnotationLayer.tsx:556-560` `d.base.map(o => translateObject(o, dx, dy))`. 그룹 이동 = 자손 전부에 같은 델타 — 새 수학이 아니다.
- **z-order 변경은 배열 스왑**: `reorder(objects, ids, dir)` `:1256-1276`(호출 `:687`, `[`/`]`). 트리에서는 "형제 사이"로만 움직여야 하고, 자손 슬라이스가 함께 움직여야 한다.
- **회전은 리프 기하에 굽는다**: `transformObjects`(`geometry.ts:484-532`)가 90°/반전을 정점·rect에 적용하고 text/badge만 `rot`을 누적한다. 그룹이 자체 각도를 가지면 `objectAABB`(`:337-356`, rot 적용 외접 사각형)가 컨테이너에서 "AABB의 AABB"로 부푼다 — 그 값을 `drawMosaic`(render.ts:349 샘플 영역)·`drawHighlightOnBackdrop`(:176 스크래치)·선택 상자가 신뢰한다.
- **히트는 위→아래 첫 적중**(`geometry.ts:416` 역순). 그룹이 있으면 "클릭 = 최상위 그룹 선택, 더블클릭 = 안으로"(시안 ① `⇧클릭`, Figma 관례)가 필요한데 지금은 리프만 있다.
- **마스크 개념 없음**: `types.ts`에 마스크 필드 0, 렌더는 클립을 모자이크 자기 사각형에만 건다(`render.ts:345-351`). 37이 `NodeBase.mask`·`EditorDoc.imageMask`를 정의하고, 범위 규칙·클립 계산은 여기.
- 심사 판정(정합성 blocker #1·#2): 다섯 축이 트리 자료구조를 4벌(중첩 `children`·평탄 맵·평탄 배열·`layerTree` 파생)로 가정했다 → **평탄 DFS 배열 + `parentId` 하나**로 통일, 렌더의 `walk(root)`는 `resolveScene(doc).nodes/containers` 위에서 동작. 마스크 모델 3벌 → **트리 형제 범위 마스크** 채택.

## 3. 설계

### 3.1 트리 표현 — 평탄 DFS 전순 배열 + `parentId`

| 대안 | 평가 |
|---|---|
| **A. `objects: Node[]` DFS 전순 · 자손은 컨테이너 바로 뒤 연속 슬라이스 · 뒤가 위(z)** (채택) | `objects.length`(e2e 30 `A.fresh`)·참조비교 캐시·히스토리 배열 공유·`renderScene` 선형 루프가 **전부 그대로**. 서브트리 = `[start, end)` 슬라이스라 이동/삭제/그룹이 `splice` 두 번 |
| B. 중첩 `children: Node[]` | 렌더·히트·마퀴·캐시·히스토리·e2e 헬퍼 전부가 재귀로 바뀐다. `objects.length===0` 계약이 "루트 자식 수"로 의미가 바뀐다 |
| C. 평탄 `Map<id,Node>` + `parentId` + 형제 순서 배열 | 순서가 두 곳(맵·배열)에 갈려 불변식 유지 비용이 배열 하나보다 크고, 히스토리 스냅샷이 맵 복제가 된다 |

불변식(`assertTreeInvariant`, DEV에서 `applyDoc` 뒤 매번): ① `parentId`가 가리키는 노드는 자기보다 앞에 있고 컨테이너(group/frame/instance)다 ② 자손은 컨테이너 바로 뒤에 연속이다(`subtreeRange`가 슬라이스) ③ 리프 좌표는 세계 oriented px ④ `blend:'pass-through'`는 컨테이너에만. **`objects`를 직접 `splice`하는 코드는 금지** — `tree.ts` 함수만이 재배열한다(INDEX §10.4 공통 준수).

### 3.2 잠금/숨김/마스크 해석 — `resolveScene(doc)` 한 곳

```
Scene = { nodes: GeomNode[]   // hidden(자기 또는 조상) 제외, 인스턴스 자식 포함, 문서 순서
        , flags: Map<id,{locked}>  // 자기 또는 조상 잠금
        , owner: Map<id, containerId|null>
        , containers: { id; range:[s,e); opacity; blend; effects; clip: Rect|null; mask: MaskScope|null }[]
        , imageMask: {id; mode; invert} | null }
```

프리뷰 캐시(`ensureCache`)·저장(`renderOutput`)·히트(`hitTest`)·마퀴·선택 상자가 **같은 `Scene`**을 소비한다. 숨김 = `nodes`에 없다(세 곳 자동 일치). 잠금 = `flags`(히트만 참조, 렌더·출력은 무시). 컨테이너의 `opacity/blend/effects`는 `containers`의 범위로 39가 격리 합성한다. `mask`: 마스크 노드 `m`의 범위 = 같은 부모의 **뒤 형제 전부**(`maskScope`) — 컨테이너 `range` 안에 `[m.index+1, parent.end)`로 기록.

**캐시는 단일 슬롯**(`{doc, scene}` 1개, `doc` 참조 동일 시 재사용). WeakMap이면 히스토리 200벌(→ 41)이 각자 Scene을 붙들어 메모리가 200배가 된다(INDEX §10.4).

### 3.3 기하 — 컨테이너는 기하가 없다

| 함수 | 규칙 |
|---|---|
| `objectBBox/objectAABB(GeomNode)` | 37 그대로. **group/instance는 타입 에러** — 부풀 자리가 없다 |
| `nodeAABB(objects,id)` (tree.ts) | 리프 → `objectAABB`, 프레임 → 자기 rect(`clipsContent`면 그것, 아니면 자손 합집합과 union), 그룹/인스턴스 → 자손 `objectAABB` 합집합 |
| `visualBounds(scene,id)` | `objectAABB ⊕ effectReach(node)`(그림자 x,y,blur,spread·레이어 블러 반경) ∩ 마스크 범위·프레임 clip — 39의 격리 스크래치 크기·43의 선택 크롬 여백이 쓴다 |
| `selectBox(scene,ids)` | 단일 리프: 회전 상자(`objectBBox`+`rot`), 다중/컨테이너: 축정렬 합집합 — 그룹 자체 회전각은 **보존하지 않는다**(INDEX §10.5 불가 항목). 회전은 `rotateNodes(objects,ids,deg,center)`가 리프에 굽는다(리프 규칙 확정 — 48 §3.2 해석: rect·ellipse·mosaic·text·badge 는 앵커를 center 기준 회전 이동 + `rot += deg`, line·arrow·pen·highlight·path 는 정점 회전) |
| `hitTest(scene,x,y,scale,{deep?,scope?})` | `scene.nodes` 역순, `flags.locked` 통과. 기본(`deep:false`)은 적중 리프의 **최상위 조상**(`topLevelAncestor`) 반환 — 클릭=그룹, 더블클릭·`scope` 지정=안으로(시안 ① `⇧클릭` 단위). 마스크 범위 밖 픽셀은 적중하지 않는다(마스크 클립 경로 `isPointInPath` 선검사) |
| `objectFrame/setObjectFrame(node)` | `{x,y,w,h,rot}` 읽기/쓰기 단일 진입(피벗 = `objectAnchor`) — 45 인스펙터 위치·크기 필드·47 노드 편집이 쓴다 |
| `applyConstraints(child, oldFrame, newFrame)` | 프레임 리사이즈 시 자식의 `constraints`(37 `h/v`)로 재배치 — `scale`은 비례, `stretch`는 양끝 고정 |
| `buildObjectPath` | `WeakMap<Node, Path2D>` 메모 — 히트가 매 pointermove마다 Path2D를 새로 만들던 것(K4가 hover 히트를 기각한 이유)이 사라져 43의 hover 커서·스냅이 히트를 부를 수 있다 |

### 3.4 트리 연산 — `tree.ts`

`indexOf(WeakMap 메모 O(1)) · parentOf · ancestorsOf · topLevelAncestor · childrenOf · subtreeRange · nodeAABB · reorder(ids,dir|'front'|'back')(형제 사이만, 자손 슬라이스 동반) · reparent(ids,newParent,index)(자기 자손으로 넣기 거부 — throw) · group(ids,'group'|'frame')(선택의 공통 부모 아래, 가장 위 항목 자리에 컨테이너 삽입, 프레임은 합집합 rect) · ungroup · remove(서브트리) · makeMask(ids)(그룹으로 감싸고 **가장 아래** 노드에 `mask` — 시안 ⑧ '마스크로 사용') · releaseMask · maskScope · translateSubtree(ids,dx,dy)(자손 `translateObject` — 현행 다중 이동과 동일 수학) · rotateNodes · countByKind · assertTreeInvariant`.

`AnnotationLayer`의 `reorder`(:1256)는 삭제하고 `tree.reorder`를 부른다(`[`/`]` 키 :687). `applyDragAt` move 분기(:556-560)는 선택이 컨테이너면 `translateSubtree`. 42·44가 그룹/해제/프레임/마스크 단축키·메뉴를 여기 함수에 1:1로 묶는다.

### 3.5 소비자 교체(이 태스크 안에서)

- `ensureCache`·`paintNow`(AnnotationLayer :219-298): `renderScene(ctx, resolveScene(doc), t, {...})` — 시그니처는 39 계약(`renderScene(ctx, scene, t, opts)`)을 **먼저** 잡고 본문은 shim(`scene.nodes`를 종전처럼 순회). 39가 본문을 교체.
- `renderOutput`(ImageEditor :660-691): 같은 `resolveScene(docRef.current)`.
- `hitTestIndex` 호출 2곳(:426·:627) → `hitTest(scene,…)`. 마퀴(`rectsOverlap`)·선택 상자(`drawSelection`)는 `scene.nodes`·`selectBox`.
- 인스턴스 자식은 37이 문서에 물질화하므로 `resolveScene`은 그냥 지나간다(51이 `diffInstance`로 재정의를 파생).

### 3.6 만들지 않는 것

- 레이어 패널·드래그 순서 UI(→ 44), 단축키(→ 42), 컨테이너 격리 합성·마스크 클립 **렌더**(→ 39 — 여기서는 범위·클립 rect만 계산), 스냅/스마트 가이드(→ 43), 인스턴스 재정의(→ 51), 프레임 그리기 도구(→ 42/45).
- 그룹 자체 회전각 보존, 중첩 변환 행렬 — 리프 세계 좌표 단일이 이 트랙의 전제(INDEX §10.4).

## 4. 계약 (소유: 38 · `src/lib/annotate/tree.ts`, `scene.ts`, `geometry.ts` 확장)

```ts
// tree.ts
export function indexOf(objects: readonly Node[], id: ObjId): number;
export function parentOf(objects, id): ObjId | null;
export function ancestorsOf(objects, id): ObjId[];
export function topLevelAncestor(objects, id): ObjId;
export function childrenOf(objects, parent: ObjId | null): ObjId[];
export function subtreeRange(objects, id): [start: number, endExclusive: number];
export function nodeAABB(objects, id): Rect;
export function reorder(objects, ids: readonly ObjId[], dir: 1 | -1 | 'front' | 'back'): Node[];
export function reparent(objects, ids, newParent: ObjId | null, index: number): Node[];   // 순환 → throw
export function group(objects, ids, kind: 'group' | 'frame'): { objects: Node[]; id: ObjId };
export function ungroup(objects, id): Node[];
export function remove(objects, ids): Node[];
export function makeMask(objects, ids): { objects: Node[]; maskId: ObjId };
export function releaseMask(objects, maskId): Node[];
export function maskScope(objects, maskId): [start: number, endExclusive: number];
export function translateSubtree(objects, ids, dx: number, dy: number): Node[];
export function rotateNodes(objects, ids, deg: number, center: { x: number; y: number }): Node[];
export function countByKind(objects): Record<Node['kind'], number>;
export function assertTreeInvariant(objects): void;                                          // DEV only

// scene.ts
export interface MaskScope { maskId: ObjId; range: [number, number]; mode: 'shape' | 'alpha'; invert: boolean }
export interface SceneContainer { id: ObjId; range: [number, number]; opacity: number; blend: BlendMode; effects: Effect[]; clip: Rect | null; mask: MaskScope | null }
export interface Scene { nodes: GeomNode[]; flags: Map<ObjId, { locked: boolean }>; owner: Map<ObjId, ObjId | null>; containers: SceneContainer[]; imageMask: EditorDoc['imageMask'] }
export function resolveScene(doc: EditorDoc): Scene;                                          // 단일 슬롯 캐시(doc 참조 동일 시 재사용)

// geometry.ts (37의 GeomNode 위에 추가)
export function visualBounds(scene: Scene, id: ObjId): Rect;
export function effectReach(node: GeomNode): number;
export function selectBox(scene: Scene, ids: readonly ObjId[]): { rect: Rect; rot: number };
export function hitTest(scene: Scene, x: number, y: number, scale: number, opts?: { deep?: boolean; scope?: ObjId | null }): ObjId | null;
export function objectFrame(node: GeomNode): { x: number; y: number; w: number; h: number; rot: number };
export function setObjectFrame(node: GeomNode, f: Partial<ReturnType<typeof objectFrame>>): GeomNode;
export function applyConstraints(child: GeomNode, oldFrame: Rect, newFrame: Rect): GeomNode;
// buildObjectPath: WeakMap<GeomNode, Path2D> 메모 (시그니처 불변)
```

e2e 훅: `window.__gpv.imageEditor.scene(): {nodeIds: string[]; lockedIds: string[]; containers: {id; range}[]}` (Scene 요약).

## 5. 단계

1. `tree.ts` 신규(≈320) + `assertTreeInvariant`를 `applyDoc`(ImageEditor :241) 뒤 DEV 호출(+3). 단위 검증은 e2e 훅으로(§7 (a)(b)).
2. `scene.ts` 신규(≈150) + `geometry.ts` 확장(+≈200: `visualBounds/effectReach/selectBox/hitTest/objectFrame/setObjectFrame/applyConstraints`, `buildObjectPath` WeakMap).
3. 소비자 교체(§3.5): `AnnotationLayer` ≈ −40/+60(ensureCache·paintNow·hitTest 2곳·move 분기·reorder 삭제), `ImageEditor` +6(renderOutput·훅), `render.ts` 시그니처 shim +15.
4. e2e `36-image-layer-tree.mjs` 신설 + `run.mjs` 1줄(35 뒤·31 앞).

규모 **L**: 프론트 ≈ +760/−40 · Rust 0 · 신규 의존 0. `geometry.ts`는 이후 **46 → 39** 순으로만 직렬 편집(INDEX §10.1 M4 주의).

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| `tree.ts` 밖 직접 `splice` | 불변식이 깨지면 순서·부모가 조용히 어긋난다 | DEV `assertTreeInvariant` 매 커밋 + 리뷰 규칙(INDEX §10.4). e2e (b) reparent 순환 throw |
| 세 소비자 중 하나가 `doc.objects`를 직접 읽음 | 숨김이 그 한 곳에서만 보인다 | `renderScene`·`hitTest` 시그니처가 `Scene`만 받는다 — `AnnoObject[]`를 넘기면 컴파일 에러. e2e (c) "그룹 숨김 → 프리뷰 α0·저장 흰색·클릭 selCount 0" 세 곳 일치 |
| 단일 슬롯 캐시 미스 폭주 | 드래그 중 `liveRef`가 매 틱 문서를 바꾸지는 않지만(라이브는 `objects` 밖), 슬라이더 `patchLive`는 커밋마다 새 doc | 캐시 키를 `doc.objects` 참조로 — 조정 슬라이더는 `objects`를 안 바꾸므로 히트 |
| 최상위 그룹 선택이 기존 e2e 클릭 계약을 바꿈 | 30/34/35는 그룹이 없어 `topLevelAncestor(id)===id` | 그룹 없는 문서에서 결과 동일. e2e (d) 더블클릭 진입 단언 |
| `buildObjectPath` WeakMap이 라이브 객체에 못 맞음 | 드래그 중 `liveRef`는 매 틱 새 객체 → 메모 미스 | 종전과 같은 비용(미스 = 현행). 커밋 객체는 불변이라 히트/hover에서 적중 |
| 마스크 범위 "뒤 형제 전부"가 사용자 기대와 다름 | Figma 규칙이지만 시안 라벨만으로는 범위 표시가 없다 | 44 레이어 패널이 범위 내 형제를 들여쓰기로 표시(⑤ `마스크` 뱃지) — 45 열린 질문에 올리지 않음(Figma 관례) |

## 7. 검증

- **e2e 36 (신규)**: (a) `setDoc` 리프 3개 → `group(ids)` 훅 → `objects.length===4`·컨테이너가 앞·`parentId` 3개 일치·`assertTreeInvariant` 통과; `ungroup` → 원복. (b) `reparent(그룹, 자기 자손)` → throw; `reorder(…,'front')` 뒤 자손 슬라이스가 함께 이동. (c) 그룹 `visible:false` → 프리뷰 `px` α 0 · `saveAs` 저장본 해당 좌표 흰색 · 클릭 `selCount()===0`(세 곳 일치). (d) 잠금 노드: 클릭 `selCount 0`, `scene().lockedIds` 포함, `setDoc`으로 선택 가능(패널 경로 대체). (e) `makeMask` → `maskScope` 범위가 뒤 형제 전부; 범위 밖 픽셀 클릭 미적중. (f) 그룹 이동(`translateSubtree` 훅) 뒤 자손 좌표 델타 동일. (g) 회전 그룹(`rotateNodes 90`) 뒤 `nodeAABB`가 자손 `objectAABB` 합집합과 일치(부풀림 0).
- **회귀**: 30(91)·34(32)·35(13) 단언 수 동일·pass — 그룹 없는 문서에서 `hitTest` 결과·선택 상자 픽셀이 종전과 동일(30 (l-1~l-3) 리사이즈 좌표 ±2px, 35 (c-1~c-4)).
- **컴파일 증명**: `renderScene(ctx, doc.objects, t)`·`objectAABB(groupNode)` 임시 삽입 시 TS 에러(리뷰 체크리스트).
- **실기**: 셋 이상 겹친 주석에서 클릭 순서(위 우선)·Ctrl+G 없이도 `setDoc` 그룹 문서 로드 후 이동/삭제.
