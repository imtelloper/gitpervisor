# 태스크 46 — 패스 렌더·기하·변환(패스로)·불리언 4·평탄화·윤곽선화·패스 분리·다각형/말풍선 프리셋

> 상태: 설계(Design) · 대상: gitpervisor · 근거: 코드 실측 2026-09-04(워킹트리) · 선행: 태스크 37(`PathNode/PathVert` 타입·geometry path stub),
> 38(`resolveScene`·`hitTest`·`objectFrame`·`tree.remove/reparent`·`buildObjectPath` WeakMap), 39(`fillPaint/strokePaint` — 대시·캡·조인·정렬·fillRule),
> `DOCS/image-annotation-design.md` §4.4(펜 스무딩)·§5.6(히트), `DOCS/pro-image-editor-design.md` §8.2 :418(불리언 비범위 — **사용자 결정으로 대체**, INDEX §10) ·
> 시안: `designs/image-editor-figma-v2.pen` ③(패스 속성·불리언 미리보기)⑧(불리언·평탄화·윤곽선화 키)·툴 레일(`Tool 다각형`·`Tool 말풍선`) · 상위: `00-INDEX.md` §10 — **M4 첫 태스크(46 → 47 ∥ 48 ∥ 49).**

## 1. 요구사항

시안 ③ 인스펙터 `열린 패스`, `선 3B82F6 100% · 두께 2 · 가운데 · 대시 8 · 간격 4 · 둥근 캡 · 둥근 조인 · 마이터 · 시작 없음 · 시작 화살표 · 끝 화살표`,
`채우기 · 채우기 없음 · 짝수-홀수`, `불리언 연산 · 합 · 차 · 교 · 패스 분리`, 캔버스 하단 `불리언 미리보기 · 원본 · 합집합 · 차집합 · 교집합 · 제외`,
컨텍스트 바 `평탄화 · 윤곽선화`; ⑧ `불리언 연산 · 2개 이상 · ⌘E 로 평탄화 · 합집합 ⌥⌘U · 차집합 ⌥⌘S · 교집합 ⌥⌘I · 제외 ⌥⌘X · 평탄화 ⌘E · 윤곽선화 ⇧⌘O`;
① 레이어 `지시선 벡터`(화살촉 달린 열린 패스); 툴 레일 `Tool 다각형`·`Tool 말풍선`(.pen 노드명, 각 3건).

받아들이는 조건:
- `kind:'path'` 노드가 **그려지고·집히고·회전/반전/이동/리사이즈된다** — 37이 stub으로 둔 geometry/render path 케이스가 본체가 된다. 채우기 규칙 `짝수-홀수`, 열린 서브패스, 대시·캡·조인·마이터·정렬·화살촉이 프리뷰와 저장에서 같은 픽셀이다.
- 기존 도형(펜·형광펜·직선·화살표·사각형·타원·번호 뱃지)이 **패스로 바뀐다**. 시안에 `패스로` 라벨은 없다(.pen grep 0건) — Figma와 같이 **평탄화(Ctrl+E)를 도형 1개에 적용한 결과**가 '패스로'이고 별도 버튼은 두지 않는다.
- 2개 이상 선택에서 `합집합·차집합·교집합·제외` 4연산과 미리보기 스트립 5칸(원본+4), 선택 전체 `평탄화`, 선 객체 `윤곽선화`(선→채움 패스), 다중 서브패스 `패스 분리`. 전부 파괴적 1커밋(undo 1회 복원, 라벨 있음 → 41).
- 레일 `다각형`·`말풍선` 도구가 드래그로 패스 프리셋을 만든다. 노드 편집·펜 도구(P)·곡률은 47, 키 표는 42, 인스펙터 셸은 45, 텍스트 윤곽선화는 50.
- 이 태스크만 머지해도 쓸 수 있다: 인스펙터 섹션 2개(패스 속성·불리언)와 미리보기 스트립이 45 셸에 마운트되고, 단축키 6개가 42 표에 행으로 들어간다.

## 2. 현황(근거)

- **곡선 표현이 없다**: `types.ts:14-24` Tool 10종, `:122-129` 유니온 7종(`pen.pts` 평탄 배열 `:50-54`). 펜은 `geometry.ts:137-162 penPath`가 midpoint 이차 베지어로 **그릴 때만** 곡선을 만들고 문서에는 점만 있다 — 편집 가능한 앵커/핸들이 없다. 37 §4가 `PathVert{x,y,inX,inY,outX,outY,mode}`·`PathNode{subpaths:{verts,closed}[],fillRule}`을 정의하고 §3.4가 geometry path 케이스를 "정점 AABB·앵커=중심·translate=정점 이동" **stub**으로 둔다 — 베지어 극값·핸들 회전·캡/조인 히트가 여기 몫.
- **도형→패스 변환 없음**: `roundRectPath`(`geometry.ts:164-188`)는 `arcTo`, 타원은 `p.ellipse`(`:209-219`), 뱃지는 `p.arc`(`:228-232`) — Path2D 명령이지 정점이 아니다. 뱃지 숫자는 `render.ts:286-290`이 `fillText`로 원 위에 찍는다.
- **선 스타일은 고정**: `render.ts:98-101` `lineJoin/lineCap="round"` 하드코딩·대시 없음, 히트도 `geometry.ts:424-426`이 round 고정. 37이 `NodeBase.dash/cap/join/miterLimit/strokeAlign/heads`를 넣고 39 `strokePaint`가 그린다(→ 39 §3.6) — **path의 끝 접선**(화살촉 방향)만 이 태스크가 준다. 화살촉 기하는 `render.ts:240-260 drawArrowHead`(길이 `ARROW_HEAD_SCALE·w` `types.ts:204`, 좌우 π/7)가 정본 — 윤곽선화가 같은 삼각형을 다각형으로 쓴다.
- **bbox는 헐**: `objectBBox`(`geometry.ts:279-311`)가 펜을 점 AABB+`strokeWidth/2`(`:283`), 화살표를 헤드 pad(`:288-291`)로 잡는다. 펜은 제어점이 실점이라 헐로 충분했지만 3차 베지어 핸들은 곡선 밖으로 나가므로 극값이 필요하다(38 §3.3 `visualBounds`가 이 값 위에 선다).
- **변환 관례**: `transformObjects`(`:484-531`)는 점을 전부 옮기고 `rot`을 기하에 흡수(R-ROT, 반전은 `rot→−rot`), `translateObject`(`:534-561`)는 좌표만 더하고, `scaleObject`(`AnnotationLayer.tsx:1352-1396`)는 원점 기준 배율. **상대 핸들**이면 translate에서 핸들 무변경, rot/flip에서 핸들 벡터만 회전 — 절대 핸들이면 세 함수 전부 3점씩 손댄다.
- **드래프트 경로**: `makeDraft`(`AnnotationLayer.tsx:1155-1215`) tool별 switch(+`squareable :1217`), `isDraftUsable`(`:1226-1240`), `MIN_DRAG=3`(`:65`). 다각형·말풍선 케이스 없음. `Tool` 유니온은 42가 레일 23종으로 확장(`'polygon'`·`'callout'` id).
- **`drawObject` switch에 default 없음**(`render.ts:103-135`): path 케이스를 빠뜨리면 컴파일은 통과하고 **조용히 안 그린다** — INDEX 46행 위험, e2e (a)가 잡는다.
- **불리언·윤곽선화·평탄화·분리**: 저장소 grep 0건. `pro-image-editor-design.md:418`이 불리언을 비범위로 뒀으나 사용자 결정으로 대체됐다(INDEX §10). 곡선 라이브러리 0개(`package.json` deps: react/zustand/monaco/xterm/jsquash/… — 기하 라이브러리 없음).
- **시안 실측**(.pen 문자열 grep): `Tool 다각형` 3·`Tool 말풍선` 3(레일 노드), `평탄화` 3·`윤곽선화` 3·`패스 분리` 1·`불리언 연산` 2·`합집합/차집합/교집합` 각 2·`제외` 4·`열린 패스` 1·`채우기 없음` 1·`짝수-홀수` 1·`지시선 벡터` 5(+`지시선 벡터 노드 편집` 1)·`불리언 미리보기 · 합집합` 1. **`패스로` 0건, 다각형 `변 수` 0건, 노드 편집 `연결·끊기·도형 삽입` 0건**(INDEX §10.3 47행 제외 확정).
- **의존 실측**(`npm view`, 2026-09-04): `fit-curve@0.2.0` MIT · unpacked 206KB · dependencies 없음 · `main lib/fit-curve.js`(CJS — vite 프리번들 대상); `polygon-clipping@0.15.7` MIT · 350KB · deps `robust-predicates ^3.0.2`·`splaytree ^3.1.0` · ESM 엔트리 `dist/polygon-clipping.esm.js`. 둘 다 `node_modules` 미설치.
- **e2e 전제**: 30 헬퍼 `canvases :44-56`·`setDoc :80`·`readSaved :252`·`saveAs :290`·`pointerSeq :315-330`·`activeTool :436`·`selCount :460`, 단언 91. `run.mjs:19-52` SUITES. 벡터 스위트 번호 **39**(INDEX §10.4).

## 3. 설계

### 3.1 패스 모델 — 37의 노드+상대 핸들을 그대로 쓴다

타입은 37 소유(§4 `PathVert/PathNode`). 이 태스크의 결정은 "그 위에 무엇을 유틸로 두나"다.

| 대안(패스 표현) | 평가 |
|---|---|
| **A. `subpaths[].verts[]` 앵커+상대 핸들(`inX/inY/outX/outY`, (0,0)=없음)+`mode`** (37 채택) | `translateObject`는 앵커만(핸들 불변), 대칭은 `out=−in` 한 줄, 노드 편집(47)이 정점 인접을 O(1)로 본다. `transformObjects` R-ROT 규칙이 그대로 |
| B. SVG `d` 문자열 | 편집마다 파싱, 이웃 조회 불가 |
| C. `M/L/C/Q/Z` 커맨드 배열 | 렌더 친화지만 노드 편집이 세그먼트 양끝을 역추적. **내부 교환 형식으로만** 둔다(`fromPathCmds` — 50 `outlineText` 어댑터·라이브러리 링 변환) |
| D. 절대 핸들 좌표 | translate가 3점, 미러가 앵커 차감 |

`path.ts` 유틸: `pathToPath2D`(`auto` 모드는 `normalizeAuto`로 이웃 기반 핸들을 계산해 그린다 — 문서는 (0,0) 유지, 47이 편집 시점에 물질화), `flattenSubPath(sub, tol=0.25)`(적응 분할: 제어점–현 거리 ≤ tol), `pathBounds`(3차 극값 — 도함수 근, 제어점 헐 아님), `projectToSubPath`(평탄 폴리라인 최근접 → `{seg,t,x,y,dist}`), `splitCubic`(de Casteljau, 47 노드 삽입), `pathEndTangents`(열린 서브패스마다 시작/끝 접선 — 핸들이 있으면 핸들, 없으면 이웃 앵커 방향), `fromPathCmds`(Q는 C로 승격).

### 3.2 렌더·히트 — 캔버스 네이티브, 새 코드는 분기 하나

| 항목 | 구현 |
|---|---|
| 채우기 | 39 `fillPaint(ctx,node,path,t,store)` — `ctx.fill(path, node.fillRule)`(`짝수-홀수`). 열린 서브패스는 캔버스가 암묵 닫아 채운다(Figma 동일) |
| 선 | 39 `strokePaint` — `setLineDash/lineCap/lineJoin/miterLimit`, 정렬 inside/outside는 닫힌 서브패스만(열린 것은 center 강제, 39 §3.6). 46은 `paint.ts`에 **path 화살촉 분기 +15줄**: `pathEndTangents`의 각도로 `drawArrowHead` 호출(`heads.start/end`) |
| 히트 | 38 `hitTest` 경로 안 `buildObjectPath`(WeakMap) path 케이스 = `pathToPath2D`. `isPointInStroke`의 `lineCap/lineJoin/miterLimit`을 **노드 값**으로(현행 round 고정 `:425-426` → 37 기본값 round라 v1 결과 불변). 대시는 무시(간격 클릭도 선택, Figma 동일). 정렬 inside/outside는 center 띠로 판정 — 반폭 오차는 `10/s` 허용오차가 덮는다(문서화) |
| `hasInterior/hasOutline` | path: `fills.some(visible) && subpaths.some(closed)` / `strokes.some(visible) && strokeWidth>0` |
| 37 shim | `drawObject` path 케이스가 39 함수를 부르므로 shim 대상 아님(39가 shim을 지운 뒤 착수 — M1→M4 순서) |

대안 "윤곽선화 결과를 채워 그리기"(정확한 정렬 띠) — 탈락: 편집 프레임마다 불리언. "스크래치+destination-out"(outside) — 탈락: 같은 캔버스의 아래 객체를 지운다(39 §3.6이 evenodd clip으로 이미 해결).

### 3.3 기하 path 케이스 — `geometry.ts` +≈120

| 함수 | path 규칙 |
|---|---|
| `objectBBox` | `pathBounds` ⊕ pad, pad = `strokeWidth/2 × (join==='miter' ? miterLimit : 1)` + (heads 있으면 `ARROW_HEAD_SCALE·w/2`, `:288-291` 관례) |
| `objectAnchor` | bbox 중심(회전 피벗) |
| `transformObjects` | 앵커 `P(x,y)`; 핸들 벡터 회전 — rotCW `(dx,dy)→(−dy,dx)`, rotCCW `(dy,−dx)`, flipH `(−dx,dy)`, flipV `(dx,−dy)`; `rot`은 pen과 같은 `rotOfShape` |
| `translateObject` | 앵커만 `+dx,+dy` |
| `scaleObject`(AL) | 앵커 `sx/sy`, 핸들 `(dx·fx, dy·fy)` |
| `objectFrame/setObjectFrame`(38) | w/h 변경 = bbox 원점 기준 `scaleObject`; x/y = translate |
| `applyConstraints`(38) | 프레임 리사이즈 시 rect와 같은 규칙(bbox 기준) |

group/instance는 여전히 `GeomNode` 밖(37 §3.1 컴파일 차단).

### 3.4 변환 — `convert.ts toPathObject(node): PathNode | null`

| kind | 규칙 |
|---|---|
| pen·highlight | `fit.ts fitPolyline(pts, {maxErr:0.5, cornerDeg:30})` — 인접 방향 변화 >30°인 점에서 폴리라인을 자르고 구간별 `fit-curve`(Schneider 1990) → 코너는 `corner`, 나머지 `mirrored`/`asymmetric`(in·out 공선·등길이 판정 1e-3). midpoint 이차 베지어(`penPath`)와 시각 편차 ≤0.5px |
| line·arrow | 2정점 corner, `heads`는 NodeBase 값 그대로(37이 `head`→`heads` 채움) |
| rect | `radius` 4-tuple 전부 0이면 4정점, 아니면 모서리당 κ=0.5523 핸들 정점 2개(8정점) — `arcTo` 원호와 편차 ≤0.03% |
| ellipse | κ 4정점(`:209` `p.ellipse`와 축 4점·대각 4점 ±1px) |
| badge | 원 path(κ 4정점) — 숫자는 `badgeLabelNode(badge): TextNode`(글자색=`readableOn` 값, 중앙 정렬)로 **분리** — 평탄화·패스로가 함께 넣고, 불리언은 원만 쓴다(문서화) |
| text | `null` → 50 `outlineText`(fontkit 글리프) |
| mosaic·frame·group·instance | `null`(가림·컨테이너는 패스가 아니다) |

스타일은 NodeBase 필드 복사(`fills/strokes/strokeWidth/…/blend/opacity/name/parentId`), `fillRule:'nonzero'`. 형광펜은 `blend:'multiply'`가 그대로 옮겨진다.

프리셋: `polygonSubPath(rect, n)`(정N각형, AABB 내접, 첫 정점 −90°), `calloutSubPath(rect, radius)`(사각형 4모서리 κ + 아래변에 꼬리 3정점 — 밑변 폭 `min(w/4,24)`, 길이 `min(h/2,24)`, 좌측 25% 지점). `makeDraft`가 tool `'polygon'`(n=3, Figma 기본)·`'callout'`에서 `squareable` rect → 프리셋 → `PathNode` 드래프트. 꼬리 위치 조정은 47 노드 편집. `isRegularPolygon(node): number|null`(닫힌 단일 서브패스·전부 corner·변 길이·내각 동일 ±0.5px, N≤12)이 참이면 인스펙터 `모양`에 `변 수` NumField를 보이고 변경 시 같은 AABB로 재생성 — 이 라벨은 **시안에 없다**(작성 지시 항목, INDEX §10.3에 올린다).

### 3.5 불리언 — `boolean.ts booleanOp(objs, op, {tol:0.25, refit:true})`

| 라이브러리 | 평가 |
|---|---|
| **A. `polygon-clipping` 0.15.7** (채택) | MIT, Martinez-Rueda 스윕라인 + `robust-predicates`(퇴화·공선 입력 안정), 다중 다각형·구멍, n항 `union/intersection/difference/xor` API가 시안의 4연산과 1:1. ESM 40KB급(추정 — unpacked 350KB는 3빌드+맵) |
| B. `paper.js` 0.12 | 정확 베지어 불리언이지만 unpacked 12.3MB, `PaperScope/Project` 씬그래프를 하나 더 들여 `PathNode↔paper.Path` 이중 변환. 이 편집기의 산출물은 **픽셀**(`ImageEditor.tsx:660-691 renderOutput`)이라 0.25px 근사가 출력에서 구분 불가 — 정확 곡선 유지는 요구가 아니다 |
| C. `martinez-polygon-clipping` 0.8 | 같은 알고리즘 원조(36KB)지만 A가 후속으로 퇴화 케이스 수정을 흡수 |
| D. `clipper2-js` | Boost 라이선스, 1.86MB, 정수 좌표 스케일링, 미유지 포트(추정) |
| E. 자체 구현 | 베지어–베지어 교차(fat-line)·권선 분류·스티칭 — 수년 규모 |

파이프라인: 각 객체 `toPathObject` → 서브패스 `flattenSubPath(0.25)` → 링 배열(닫힌 것만; 열린 서브패스는 암묵 닫음) → 객체 영역 = 링들의 `xor`(evenodd 정확; nonzero는 단일 링·라이브러리 출력(외곽 CCW·구멍 CW)에서 동치 — `ponytail: 47 펜이 같은 방향으로 겹치는 다중 링 nonzero 패스를 만들면 xor가 겹침을 비운다. 권선수 계산이 필요해지면 그때`) → 연산: `union(all)` / `intersection(all)` / `difference(z 최하위, ...나머지)`(Figma: 아래 도형에서 위를 뺀다) / `xor(all)` → 결과 MultiPolygon 링마다 30° 코너 분할 + `fit-curve`(err 0.5px) 재피팅(공선 구간은 핸들 0 = 직선 유지) → `PathNode{subpaths, fillRule:'nonzero'}`. 스타일 = **z 최상위** 객체(⑧ 정렬 규칙 '마지막 선택 기준'과 일관), id 새로, 위치 = 최상위 소스의 자리(`[...objects, node]` 루트 끝 삽입 → 38 `reparent(objects,[id],parent,index)` — 직접 splice 없이 불변식 유지), 소스는 38 `remove`. 1커밋 라벨 `합집합/차집합/교집합/제외`, 결과 선택.

입력 게이트 `canBoolean(nodes)`: ≥2 이고 전부 변환 가능 리프(pen·highlight·line·arrow·rect·ellipse·badge·path). 텍스트·모자이크·컨테이너가 섞이면 버튼/키 비활성(45 `classifySelection`·42 `when`이 이 함수를 부른다).

### 3.6 평탄화(Ctrl+E) · 패스 분리

- `flattenObjects(objs): {path: PathNode; extras: TextNode[]} | null` — 선택을 `toPathObject`로 바꿔 **서브패스를 결합**한 단일 패스(클리핑 없음). 컨테이너는 38 `subtreeRange`의 리프로 펼친다(프레임 rect 자체는 제외 — 컨테이너). 뱃지 숫자는 `extras`로 뒤에 붙는다. 선택 1개 = **패스로**(id 유지 → 선택·`styleRefs` 보존), 2개 이상 = 새 id(위치 규칙 §3.5). 라벨 `평탄화`.
- `separateSubPaths(node): PathNode[]` — 서브패스마다 노드(첫 것은 id 유지, 나머지 새 id, 같은 부모·연속 인덱스). 라벨 `패스 분리`. 서브패스 1개면 no-op(버튼 비활성).

### 3.7 윤곽선화 — `outline.ts outlineStroke(node): PathNode`

선 → 채움 패스. 곡선 오프셋 라이브러리 없이 **같은 polygon-clipping `union`**으로 만든다: 서브패스 평탄화 → `dash`가 있으면 호장 기준으로 조각 분할(캔버스와 같이 조각마다 캡) → 조각마다 [세그먼트 사각형(폭 w)] ∪ [조인: round=원 n각형(사지타 ≤0.25px), miter=마이터 사각형(한계 초과 시 bevel), bevel=삼각형] ∪ [캡: butt 없음 / round 반원 / square 연장 사각형] ∪ [화살촉 삼각형(`drawArrowHead` 기하 그대로)] → `union` → 재피팅. `strokeAlign`은 닫힌 서브패스에서만 — inside = 띠(2w) ∩ 영역, outside = 띠(2w) − 영역(연산 1회 추가). 결과: `fills=[첫 visible stroke Fill]`, `strokes=[]`, `strokeWidth 0`, `dash null`, `heads none`, `fillRule 'nonzero'`, **id 유지**(제자리 치환). 라벨 `윤곽선화`. 게이트 `canOutline(node)`: 선이 보이고 `strokeWidth>0`인 path·line·arrow·pen·highlight·rect·ellipse. 텍스트는 50(`outlineText`)이 같은 액션 id `outline` 아래 kind로 분기한다(42 표 한 행).

| 대안 | 평가 |
|---|---|
| 곡선 오프셋(bezier-js 등) | 조인·캡·대시를 모르고 결과를 다시 union 해야 한다 |
| 래스터→벡터화(potrace) | 해상도 종속 |

### 3.8 UI 조각(콘텐츠만 — 셸은 45·키는 42)

- `BooleanPreviewStrip`: 선택 2개 이상·`canBoolean` 참일 때 76×60 오프스크린 캔버스 5개(원본+4연산)를 `renderScene(ctx, sceneOf(nodes), tFit)`로 그린다(39 진입 하나 — 썸네일도 같은 함수). `useMemo` 키 = 선택 노드 참조 배열(불변 객체라 참조 비교로 충분). 클릭 = 적용. 호버 라이브 프리뷰(매 프레임 불리언)는 탈락.
- `PathInspectorSection`(45 속성 탭 슬롯): 시안 ③ 순서대로 `선`(두께·정렬 안쪽/가운데/바깥·대시/간격·캡·조인·마이터·시작/끝 화살촉), `채우기`(없음/색 · 짝수-홀수/논제로), `불리언 연산`(합·차·교·제외, `canBoolean`), `평탄화 · 윤곽선화 · 패스 분리` 버튼, `모양`(`변 수` — 정다각형일 때만). 값 편집은 45 `NumField`·`applyPaintPatch`(37) 경유 — 드래그 1회 = 1칸. `노드 X/Y·핸들 in/out` 섹션은 47.
- 단축키: 42 `EDITOR_SHORTCUTS` 불리언 그룹 행 6개(id 는 42 §3.4 표 그대로 — `bool.union` Ctrl+Alt+U · `bool.subtract` Ctrl+Alt+S · `bool.intersect` Ctrl+Alt+I · `bool.exclude` Ctrl+Alt+X · `flatten` Ctrl+E · `outline` Ctrl+Shift+O, Mac ⌥⌘/⌘/⇧⌘ — 시안 ⑧ 글리프 그대로, `when` multi/hasSelection). 핸들러는 `ImageEditor` 액션 맵에 `vectorActions(docRef, ids)` 하나로 등록.

### 3.9 만들지 않는 것

- 펜 도구·곡률 토글·노드 편집 모드·앵커/핸들 크롬·노드 스냅(→ 47), 텍스트 윤곽선화(→ 50), 마스크(→ 38/39), 크롭 직선화(→ 48), 단축키 리스너·Tool 유니온 확장(→ 42), 인스펙터 셸·NumField(→ 45).
- 라이브(비파괴) 불리언 그룹: 시안 ⑧ `⌘E 로 평탄화`는 Figma의 "불리언 그룹 해체"가 아니라 이 앱에선 '결합' — 파괴적 4연산 + 미리보기 스트립 + undo 1회로 같은 사용자 결과. 트리(38)가 있으므로 후속 순증은 가능하나 시안 라벨이 없다.
- 정확 베지어 불리언(paper.js), 곡선 오프셋 라이브러리, 노드 편집 `연결·끊기·도형 삽입`(INDEX §10.3 제외), `패스로` 전용 버튼, 다각형 도구의 별도 상태 필드(문서 모델 무변경 — `isRegularPolygon` 파생).

## 4. 계약 (소유: 46 · `src/lib/annotate/vector/{path,fit,convert,boolean,outline}.ts`, `src/components/image/vector/*`)

```ts
// vector/path.ts  (타입 PathVert/PathNode/SubPath 는 37 import)
export type PathCmd = { c: 'M' | 'L'; p: [number, number] } | { c: 'C'; p: [number, number, number, number, number, number] } | { c: 'Q'; p: [number, number, number, number] } | { c: 'Z'; p: [] };
export function pathToPath2D(node: PathNode): Path2D;                                   // auto 핸들은 normalizeAuto 로 계산해 그린다
export function normalizeAuto(sub: SubPath): SubPath;                                   // mode 'auto' 정점의 in/out 을 이웃 기반으로 물질화(47 도 사용)
export function flattenSubPath(sub: SubPath, tol?: number /* 0.25 oriented px */): number[];  // 평탄 폴리라인 [x0,y0,…], closed 면 첫 점 반복 없음
export function pathBounds(node: PathNode): Rect;                                       // 3차 극값 정확 bbox(선 두께 미포함)
export function projectToSubPath(sub: SubPath, pt: { x: number; y: number }): { seg: number; t: number; x: number; y: number; dist: number };
export function projectToPath(node: PathNode, pt: { x: number; y: number }): { sub: number; seg: number; t: number; x: number; y: number; dist: number } | null;  // 서브패스 전부 중 최근접(47 세그먼트 히트)
export function pathToSvgD(subpaths: readonly SubPath[]): string;                       // pathToPath2D 와 같은 순회 — 47 스크림 cutoutD·골격선
export function splitCubic(sub: SubPath, seg: number, t: number): SubPath;              // 정점 삽입(47)
export function pathEndTangents(node: PathNode): { start: { x: number; y: number; angle: number }; end: { x: number; y: number; angle: number } }[]; // 열린 서브패스마다 1개
export function fromPathCmds(cmds: readonly PathCmd[]): SubPath[];                     // 50 outlineText 어댑터 · 링→정점. Q 는 C 로 승격
export function toPathCmds(node: PathNode): PathCmd[];

// vector/fit.ts
export function fitPolyline(pts: readonly number[], opts?: { maxErr?: number /* 0.5 */; cornerDeg?: number /* 30 */; closed?: boolean }): PathVert[];

// vector/convert.ts
export function toPathObject(node: GeomNode): PathNode | null;                          // §3.4 표. text/mosaic/frame → null
export function badgeLabelNode(badge: BadgeObject): TextNode;                           // 뱃지 숫자 분리
export function polygonSubPath(rect: Rect, n: number): SubPath;
export function calloutSubPath(rect: Rect, radius: [number, number, number, number]): SubPath;
export function isRegularPolygon(node: PathNode): number | null;                       // 변 수 N(3..12) 또는 null
export function canBoolean(nodes: readonly Node[]): boolean; export function canFlatten(nodes: readonly Node[]): boolean; export function canOutline(node: Node): boolean;

// vector/boolean.ts
export type BoolOp = 'union' | 'subtract' | 'intersect' | 'exclude';
export function booleanOp(objs: readonly GeomNode[], op: BoolOp, opts?: { tol?: number; refit?: boolean }): PathNode | null;  // z 순서 입력(앞=아래). 2개 미만·변환 불가 → null. 스타일 = 마지막(최상위)
export function flattenObjects(objs: readonly GeomNode[]): { path: PathNode; extras: TextNode[] } | null;
export function separateSubPaths(node: PathNode): PathNode[];

// vector/outline.ts
export function outlineStroke(node: GeomNode): PathNode | null;                        // canOutline 거짓 → null

// components/image/vector/BooleanPreviewStrip.tsx · PathInspectorSection.tsx
export function BooleanPreviewStrip(p: { nodes: readonly GeomNode[]; onApply(op: BoolOp): void }): JSX.Element | null;
export function PathInspectorSection(p: { node: PathNode; onLive(patch: Partial<DefaultPaint> & Partial<Pick<PathNode,'fillRule'|'subpaths'>>): void; onCommit(patch, label?: string): void; onOp(op: BoolOp | 'flatten' | 'outline' | 'separate'): void; canOp: Record<BoolOp | 'flatten' | 'outline' | 'separate', boolean> }): JSX.Element;

// ImageEditor 액션(42 액션 맵 등록 · 45 버튼 · e2e 훅이 같은 함수)
export function vectorActions(ctx: { doc: EditorDoc; ids: readonly ObjId[]; applyDoc(next: EditorDoc, mode: 'commit', label: string): void; select(ids: ObjId[]): void }): { run(op: BoolOp | 'flatten' | 'outline' | 'separate'): ObjId[] };
```

e2e 훅(`window.__gpv.imageEditor`, 37/41 옆): `vector.op(op, ids?): ObjId[]`(선택 생략 시 `selectedIds`) · `vector.can(op, ids?): boolean` · `vector.toPath(id): PathNode|null`.

다른 태스크 접점: 타입 → 37 §4 · `hitTest/buildObjectPath/objectFrame/subtreeRange/remove/reparent` → 38 §4 · `fillPaint/strokePaint`(fillRule·정렬·대시) → 39 §4(46은 `paint.ts` 화살촉 path 분기 +15만) · 라벨 커밋 `applyDoc(next,'commit',label)` → 41 §4 · Tool `'polygon'|'callout'`·단축키 행 6 → 42 §4 · 슬롯 마운트·`NumField`·`classifySelection` 게이트 → 45 §4 · 노드 편집이 `projectToSubPath/splitCubic/normalizeAuto` 소비 → 47 · `fromPathCmds` 소비 → 50.

## 5. 단계

1. **`path.ts` + `fit.ts` + geometry/render path 본체**(≈ +300 / +80 / geometry +120 / paint.ts +15 / AnnotationLayer `scaleObject` +10): 37 stub 교체. `package.json` +2(`fit-curve@0.2.0`, `polygon-clipping@0.15.7` — 1단계에서는 fit-curve만 쓰지만 함께 설치해 vite 프리번들 1회). e2e 39 (a)~(h).
2. **`convert.ts` + 드래프트**(≈ +200 / AnnotationLayer `makeDraft`·`isDraftUsable` +40): `toPathObject`·프리셋·`isRegularPolygon`·게이트 3종. e2e (i)~(l).
3. **`boolean.ts` + `outline.ts` + 액션**(≈ +220 / +220 / ImageEditor `vectorActions`·훅 +60): 4연산·평탄화·분리·윤곽선화, 42 표 행 6, 라벨. e2e (m)~(w).
4. **UI 조각**(`BooleanPreviewStrip` ≈90 · `PathInspectorSection` ≈200): 45 슬롯 마운트. e2e (x)~(z).
5. e2e `39-image-vector.mjs` 신설(≈380) + `run.mjs` 1줄(35 뒤·31 앞) + 40 §7 원장 행 1개(벡터 연산 일시 <1MB·스트립 상시 ≈0.1MB).

규모 **L**: 프론트 ≈ +1,950 · Rust 0 · 신규 의존 2(MIT, 합 unpacked 557KB · 번들 추정 ≤60KB). `geometry.ts`는 38 뒤·39/47 앞에 **이 태스크만** 편집(INDEX §10.1 M4 주의).

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| `drawObject`·`transformObjects` default 없음 | path 케이스 누락이 조용한 미렌더/`undefined` | 37이 인자를 `GeomNode`로 좁혀 컴파일 에러화; e2e (a) 픽셀 단언 |
| 공유 변(완전 중첩 동일 변) 입력에서 링 2개 | 라이브러리가 접한 변을 분리된 링으로 낼 수 있다(추정) | 입력 지터 없이 그대로 두고 e2e (m) `subpaths.length===1` 단언 — 실패 시 후처리 `union` 1회 재적용 |
| 재피팅이 교차 코너를 둥글림 | Schneider 피팅은 코너를 곡선으로 근사 | 30° 코너 분할이 1차 완화, 남는 오차 ≤0.5px는 픽셀 출력에서 비가시(픽셀 산출물 근거) |
| nonzero 다중 링 xor 해석 | 47 펜이 같은 방향 겹침 링을 그리면 겹침이 빈다 | `ponytail:` 천장 명시(§3.5), 변환기·라이브러리 출력에서는 동치. 47 수용 기준에 "nonzero 겹침 링 불리언" 항목 없음(시안 밖) |
| 큰 펜 획(수천 점) 불리언 시간 | 평탄화 점 수 × 스윕라인 | e2e (y) 200정점 곡선 ∪ rect ≤300ms(CI 2배 여유). 초과 시 tol 0.5로 강등 옵션 |
| `fit-curve` 2022 이후 미갱신·CJS | 알고리즘이 1990년 것이라 갱신 필요 없음; CJS는 vite가 프리번들 | 문제 시 300줄 벤더링(`ponytail:` 주석 경로) |
| Ctrl+Alt+글자가 한국어 키보드 오른쪽 Alt(한/영)와 겹침 | IME 토글 | 42 표기에 '왼쪽 Alt' + `e.code` 매칭(42 §3); 인스펙터 버튼이 항상 대안 |
| 히트 정렬 띠 반폭 오차 | inside/outside 선을 center 띠로 판정 | `10/s` 허용오차가 덮음, 문서화. 노드 편집(47)은 자체 세그먼트 히트 |
| 뱃지 불리언에서 숫자 소실 | 원만 변환 | 평탄화·패스로는 `extras`로 보존; 불리언은 도형 연산이라 의도(문서화) |
| `변 수` 시안 밖 | 라벨 없는 UI | INDEX §10.3 열린 질문(기본: 정다각형일 때만 표시). 아니오면 필드 1개 삭제·`isRegularPolygon` 유지 비용 0 |

## 7. 검증

- **e2e 39 (신규, 39-image-vector.mjs)** — 200px 흰 픽스처, `setDoc`/`pointerSeq`/`readSaved` 헬퍼(30 재사용):
  (a) fill 빨강 닫힌 path(사각형 한 변 3차 볼록) `setDoc` → `[1]` 내부 `RED`, 볼록부 안쪽 `RED`·바깥 흰색, 저장본 동일 좌표 동일(WYSIWYG) / (b) 같은 방향 중첩 사각형 2서브패스 `evenodd` → 중심 흰색, `nonzero` → 채움 / (c) 수평 path stroke 10 `dash [8,4]` → x=4 선색, x=10 흰색; x=10 클릭 `selCount()===1` / (d) 닫힌 사각 path w=10 `inside` → 변 바깥 3px 흰·안 3px 선색, `outside` 반대, `center` 양쪽 / (e) `heads.end='arrow'` 열린 path → 끝 접선 방향 `4·w` 지점 선색(`지시선 벡터`) / (f) `transformObjects rotCW` 후 정점 `(x,y)→(h−y,x)`, 핸들 `(dx,dy)→(−dy,dx)`; flipH 후 `rot→−rot`; `translateObject` 뒤 핸들 불변 / (g) `pathBounds` M0,0 C0,−100 100,−100 100,0 → `y === −75 ±0.01`(헐이면 −100) / (h) `objectAABB(path)`가 (g)+pad와 일치, 회전 리사이즈 핸들이 그 상자 위(30 (l) 방식) /
  (i) `toPath(ellipse 100×60)` 렌더 vs 원본 축 4점·대각 4점 ±1px; rect radius 20 → 정점 8 / (j) `toPath(pen)` 정점 ≤ 점 수/3, 렌더 잉크 차 ≤1px / (k) `setTool('polygon')` 드래그 → kind path·정점 3·closed; `isRegularPolygon===3`; `변 수` 6 입력 → 정점 6·AABB 동일 / (l) `setTool('callout')` 드래그 → 서브패스 1·꼬리 3정점이 아래변 밖 /
  (m) rect A(40,40,120,120)·B(100,100,120,120) → `vector.op('union')` → 객체 1·`subpaths 1`·정점 ≤10, A전용·B전용·겹침 전부 채움, 저장본 동일 / (n) `subtract`(아래 A − 위 B): 겹침 흰·A전용 채움·B전용 흰; `intersect`: 겹침만; `exclude`: 겹침 흰 + 양쪽 전용 채움 / (o) ellipse ∪ rect → 정점 ≤24, 원호 4점 ±1px 채움·바깥 1px 흰 / (p) 결과 fills == z 최상위 값, `parentId` == 공통 부모, undo 1회 → 원본 객체 수·id 복원, 히스토리 라벨 `합집합` / (q) `can('union')`: text 포함 선택 false, rect 1개 false / (r) `flatten` 3객체 → 1객체 `subpaths 3`, 5샘플 픽셀 전후 동일; rect 1개 flatten → 같은 id·kind path(패스로); badge flatten → path + text 노드 / (s) `separate` → 서브패스 수만큼 객체, 첫 id 유지 /
  (t) 수평 line w=10 round cap `outline` → `fills[0]`==선색·`strokeWidth 0`, 끝점 +4px 채움; butt → +1px 흰; `dash [8,4]` → x=10 흰 / (u) 닫힌 rect w=10 `inside` outline → 변 바깥 흰·안 채움; `outside` 반대 / (v) arrow outline → 화살촉 삼각형 안 채움 / (w) 200정점 자유곡선 ∪ rect `performance.now` ≤300ms /
  (x) 2개 선택 시 `BooleanPreviewStrip` 캔버스 5개 DOM, 1개 선택·text 포함 시 없음; 스트립 `합집합` 클릭 == `op('union')` 결과 / (y) path 선택 시 인스펙터 `선·채우기·불리언 연산·패스 분리` 라벨 DOM; 두께 12 입력+Enter → `strokeWidth 12` 1칸; `짝수-홀수` 토글 → `fillRule 'evenodd'`; `채우기 없음` → `fills []` / (z) Ctrl+Alt+U·Ctrl+E·Ctrl+Shift+O 디스패치(42 스코프 경유) → 각 연산 1회·`defaultPrevented`.
- **회귀**: 30(91)·34(32)·35(13)·36·37 단언 수 동일·전부 pass — path 없는 문서에서 픽셀·히트 결과 불변(히트 cap/join이 노드 기본값 round라 동치). 30 (i) 형광펜·(r)(s) 모자이크 무변경.
- **컴파일 증명**: `objectBBox(groupNode)`·`booleanOp([text])` 임시 삽입 시 TS 에러(리뷰 체크리스트).
- **실기**: 펜 획을 평탄화 → 노드 수·모양 육안, 두 도형 합집합 → undo, 화살표 윤곽선화 → 저장 PNG 동일, 다각형/말풍선 드래그, 한국어 키보드에서 왼쪽 Alt 조합 6개.
- **40 원장 행**: 벡터 연산 일시 메모리(폴리라인·링 배열) <1MB, 스트립 캔버스 5장 ≈91KB 상시(선택 중만) — 실측 뒤 표에 기록.
