# 태스크 39 — 렌더러 v2: 캔버스 병합·격리·블렌드 19·마스크·페인트/효과 스택·모자이크 통합·조정 ctx.filter

> 상태: 설계(Design) · 대상: gitpervisor · 근거: 코드 실측 2026-09-04(워킹트리) · 선행: 태스크 37(`Fill/Effect/BlendMode`·render shim), 38(`resolveScene`·`visualBounds`),
> `DOCS/image-annotation-design.md` §4(단일 렌더러·캔버스 2장 — 후자를 이 문서가 폐기), `DOCS/pro-image-editor-design.md` §8(블렌드·효과 기각 근거 — 사용자 결정으로 대체) ·
> 시안: `designs/image-editor-figma-v2.pen` ①(채우기·선·효과 스택·블렌드)④(블렌드 16+·그라디언트 4·효과 편집)⑦(마스크) · 상위: `00-INDEX.md` §10 — **M1 몸통(XL).**

## 1. 요구사항

시안 ① 인스펙터 `채우기: F0398B 12% · 선형 그라디언트 135° · 이미지·채우기 · 스타일`(다중 채우기), `선: 3B82F6 · 두께 2 · 안쪽 · 대시 8·간격 4`, `효과: 드롭 섀도 0·4·12·25% · 이너 섀도 0·2·6·20% · 레이어 블러 반경 4 · 배경 블러 반경 12`,
`모양 100% · 표준`, ④ `블렌드 모드: 패스스루·표준·어둡게·곱하기·색상 번·선형 번·밝게·스크린·색상 닷지·선형 닷지·오버레이·소프트 라이트·하드 라이트·차이·제외·색조·채도·색상·광도`(19),
`그라디언트: 선형·방사·원뿔·다이아 · 스톱 · 각도 135° · 스케일`, ③ `선 캡 둥근 · 조인 둥근 · 마이터 4 · 시작 없음·끝 화살표 · 채우기 규칙 짝수-홀수`, ⑦ `마스크 모양/알파 · 반전 · 벡터 모양으로 이미지 자르기`,
① 레이어 `고객사명 모자이크[마스크] · 하이라이트 · 흐림 영역`.

받아들이는 조건:
- 위 속성 전부가 **프리뷰와 저장에서 같은 픽셀**로 그려진다 — 렌더 진입은 `renderScene` 하나(INDEX §10.4 공통 준수).
- 그룹 불투명도·비패스스루 블렌드·효과·마스크가 있는 컨테이너는 **격리 합성**된다(자식끼리 먼저 합쳐지고 한 번에 얹힌다).
- 기존 가림 계약이 유지된다: e2e 30 (j) 셀 격자 배율 불변, (r) 가장자리 알파 감쇠 누수 0, (s) 반투명 원본 누수 0.
- 조정(밝기·대비·채도 3필드)은 이미지에만 걸리고 주석에는 물들지 않는다(원 설계 D2).
- 이 태스크만 머지해도 쓸 수 있다: 37의 render shim이 사라지고 문서에 든 값이 전부 보인다. UI는 45가 붙인다.

## 2. 현황(근거)

- **캔버스 2장 구조**(원 설계 §4.3): 베이스 `<canvas ref={previewRef}>`에 이미지를 그리고(`ImageEditor.tsx:450-456`) CSS `filter: filterStr`(`:363`, `:1080-1085`)로 조정을 걸며, 주석은 투명 오버레이 `[1]`에 그린다(`AnnotationLayer.tsx:806-818`). 배경이 필요한 효과는 **재구성**한다 — 형광펜 multiply는 `PreviewBackdrop`(`render.ts:41-60`)을 받아 `drawHighlightOnBackdrop`(`:176-230`, 55줄·4단계 마스킹·`hlScratch` `:141-155`)으로, 모자이크는 `seedMosaicSources`(`AnnotationLayer.tsx:892-911`)가 클립 안에 원본을 먼저 심는다. 노드 종류가 늘 때마다 이 재구성이 **종류마다** 복제된다. pro 설계 §8이 블렌드를 기각하며 "선행조건: 프리뷰 캔버스 병합"이라 적은 자리다.
- **커밋 캐시는 오프스크린**: `ensureCache`(`:219-258`)가 `document.createElement("canvas")`(`:232`)로 캐시를 만들고 `paintNow`가 `[1]`에 블릿한다. e2e 30/34/35는 `canvases()[0]`=베이스·`[1]`=주석을 전제한다(34 `:88` `cs.length>=2 && cs[1].width>0`, `:100-105 A.px`가 `[1]`, 35 `:51-67 backing()`이 `[0][1]` 크기 `[200,200,200,200]` `:312-317`).
- **알파 0 단언은 두 개뿐**: `30:738-743` (a) "주석 밖은 투명(오버레이 분리, §4.3)" `aOut[3]===0`, `30:840-846` (c) `afterTL[3]===0`. 그 외 30·34·35의 프리뷰 픽셀 단언은 색(RED·흰색)만 본다(grep) — 병합 시 바뀌는 계약은 이 둘이다.
- **렌더 진입이 하나가 아니다**: 프리뷰 `renderScene`(`render.ts:62-75`) + 베이스 `drawImage`(`ImageEditor.tsx:456`) + 출력 `renderOutput`(`:660-691`: `ctx.filter = filterStr` → `drawImage` → `ctx.filter="none"` → `renderScene`). 조정 필터 복구(D2)가 두 곳(`:679-682` 출력, CSS 프리뷰)에 갈려 있다. 40의 디테일 캔버스·타일 출력이 붙으면 넷이 된다.
- **모자이크는 이미 "배경 의존 효과"의 정답을 갖고 있다**: `drawMosaic`(`render.ts:349-417`) — 클립 후 `globalCompositeOperation="copy"`(`:369`, 알파 있는 원본 누수 차단), 블러는 가장자리 복제 3σ 패딩 스크래치(`:390-404`), 픽셀화 셀은 oriented 기준(배율 불변). e2e 30 (r-1~3)(s-1)(j-1~4)가 지킨다. 배경 블러·픽셀화 효과는 **같은 기제**여야 한다.
- 캔버스 2D에 없는 블렌드: `linear-burn`(규격 부재). `linear-dodge`는 `lighter`. 나머지 17은 `globalCompositeOperation` 값과 1:1.
- 스크래치 수명: `hlScratch`·`mosaicScratch` 모듈 전역 + `releaseScratch`(`:321`) — P0에서 언마운트 해제만 붙였다. 격리 레이어가 노드마다 생기면 풀과 **바이트 상한**이 필요하다(심사 blocker: 축별 예산 합산 시 정상 상태 ≈345MB — 개수 상한 `POOL_MAX 6`은 4K에서 44MB).
- `ctx.beginLayer()/endLayer()`(Canvas 2D Layers) 가용 여부 — 이 저장소에서 미검증(추정: Chromium 152 가용). 참이면 격리 레이어 풀의 대부분이 필요 없다.

## 3. 설계

### 3.1 프리뷰 캔버스 병합 — **[0] 커밋 캐시(DOM, hidden) · [1] 불투명 씬**

| 대안 | 평가 |
|---|---|
| **A. 씬 캔버스 `[1]`이 이미지+노드의 불투명 합성. 오프스크린 커밋 캐시를 `[0]`으로 DOM에 올린다(`visibility:hidden`)** (채택) | 출력과 **같은 `renderScene` 호출**. `PreviewBackdrop`·`drawHighlightOnBackdrop`·`hlScratch`·`seedMosaicSources`·`previewBackdrop`·베이스 캔버스·CSS filter 전부 삭제(−≈200줄). e2e `[0]/[1]` 인덱스·백킹 크기·포인터 대상 계약 유지 — 바뀌는 단언은 (a)(c) 둘 |
| B. 2장 유지 + 블렌드/배경 블러/격리 그룹마다 배경 재구성 | 형광펜 55줄을 노드 종류마다 복제, 문서화된 AA 편차(`:171-174`)가 전 블렌드로 번진다. 중첩 격리 그룹 안의 블렌드는 그룹 레이어가 투명이라 프리뷰와 출력이 **다른 코드 경로** |
| C. `[0]` 베이스 유지 + `[1]`에도 이미지 | `[0]`이 완전히 덮여 4K에서 7.3MB 죽은 무게 |

이미지는 `opts.image`(37의 `oriented` 캔버스)로 렌더러가 그린다. 조정은 그 `drawImage` 앞뒤 `ctx.filter = filterStr / "none"` **한 곳**(D2가 한 곳이 된다). `hidden` 캔버스는 `getImageData`를 막지 않는다(규격) — 34 `A.px`가 곧 증명.

### 3.2 단일 진입 `renderScene(ctx, scene, t, opts)`

```
opts.image     oriented 캔버스(조정·직선화 적용 전 원본). 없으면 노드만(투명 배경 — 썸네일·에셋 미리보기)
opts.background 'image' | 'transparent' | '#fff'(jpeg 출력)
opts.skipId    텍스트 편집 중 객체(49 textarea 오버레이가 대신 보여준다)
opts.nodeIds   부분 렌더(52 레이어별 내보내기)
opts.window    oriented px 사각형 — 40 디테일·타일이 준다. 생략 = 전체
```
순서: 배경 → `applyMask(imageMask)`로 이미지 클립 → `scene.nodes`를 `scene.containers` 범위와 함께 순회. 리프는 `paintNode`(페인트 → 선 → 효과), 컨테이너는 격리 여부 판정 후 자식 재귀. 화면 크롬은 여기 **없다**(43 SVG).

### 3.3 격리 합성 — 착수 프로브 1줄로 분기

`isolationNeeded(c) = c.opacity<1 || c.blend!=='pass-through' || c.effects.some(visible) || c.mask`. 아니면 자식을 부모 ctx에 바로 그린다(비용 0).

| 경로 | 조건 | 구현 |
|---|---|---|
| **P1 `beginLayer/endLayer`** | 착수 첫 프로브 `'beginLayer' in CanvasRenderingContext2D.prototype` 참 | `ctx.beginLayer({filter, …})` — 브라우저가 현재 clip 경계 크기로 레이어를 잡는다. `globalAlpha`·gCO·필터를 한 호출에. `layers.ts`는 배경 샘플링(모자이크·배경 블러)용 스크래치만 |
| **P2 `layerPool`** | 거짓 | `visualBounds(scene,id)`(38) 크기 스크래치를 풀에서 빌려 자식을 그리고 `globalAlpha`+gCO로 한 번 얹는다. **상한은 바이트** `≤ 2×백킹`(개수 아님 — 4K 백킹 7.3MB → 14.6MB), 유휴 5s 해제, 초과 시 임시 할당 + `console.warn`(`ponytail:` 천장) |

프로브 결과는 40의 실측표 첫 행에 기록한다. Mac(WKWebView)은 `ctx.filter`와 같은 기존 결함 범주(INDEX §10.5).

### 3.4 블렌드 19

`normal … luminosity` 17 = `globalCompositeOperation` 동일 문자열. `linear-dodge` = `'lighter'`. **`linear-burn` = invert∘lighter∘invert**: 배경 영역을 `filter:invert(1)`로 스크래치에 복사 → 소스를 `invert(1)`+`lighter`로 얹음 → `invert(1)`+`copy`로 되돌림. 불투명 배경에서 `(1−As)·B + As·max(0,S+B−1)` — 정확. 투명 PNG 위에서는 Figma와 다르다(`occlusionIntegrity`가 저장 전 경고, INDEX §10.5). `pass-through`는 컨테이너 전용(37 정규화가 리프를 `normal`로).

### 3.5 마스크·클립 — `applyMask` 한 함수

- `imageMask`(37 `EditorDoc.imageMask`): 이미지를 그린 직후 마스크 노드의 `buildObjectPath`로 `clip`(shape) 또는 알파 `destination-in`(alpha), `invert`면 evenodd 보조 사각형.
- 컨테이너 마스크(38 `containers[].mask` — 뒤 형제 범위): 범위 렌더를 격리 스크래치에 그린 뒤 마스크 노드 알파로 `destination-in`. shape 모드는 채우기 알파, alpha 모드는 노드 자체 픽셀 알파. 마스크 노드 자신은 그리지 않는다.
- 프레임 `clipsContent`: rect+4반경 `clip`.

### 3.6 페인트 — `paint.ts`

| 항목 | 구현 |
|---|---|
| 단색 | `fillStyle` + `globalAlpha=opacity·fill.opacity` |
| 선형/방사/원뿔 | `createLinearGradient/createRadialGradient/createConicGradient`, 스톱 `pos/color/opacity`, `angle`·`scale`은 bbox 기준 `DOMMatrix`로 패턴 변환 |
| **다이아** | canvas 미지원 → bbox를 중심 기준 4삼각형으로 `clip`하고 각 삼각형에 중심→변 중점 선형 그라디언트(L∞ 거리라 삼각형 안에서 정확히 선형) |
| 이미지 페인트 | `imageStore.get(assetId)`(37 `doc.assets` 위 디코드 캐시, `WeakMap<assets, Map<id,ImageBitmap>>`) → `createPattern` + `DOMMatrix`로 `fill/fit/stretch`. 미로드면 회색 플레이스홀더, 출력 전 `ensureAssets(doc)` await(52 계약) |
| 다중 채우기 | 아래→위 순서로 `fill` 반복, 각자 `blend`(gCO)·`visible` |
| 선 정렬 | `inside` = `clip(path)` 후 `lineWidth=2w`, `outside` = 큰 사각형∪path evenodd `clip` 후 `2w`, `center` = `w`. 열린 경로(펜·선·화살표·열린 path)는 center 강제(Figma 동일). 스크래치 0 |
| 대시·캡·조인·마이터 | `setLineDash(dash·t.sx)`·`lineCap`·`lineJoin`·`miterLimit` |
| 화살촉 | 현행 `drawArrowHead`(`render.ts:232-260`) 재사용. `path`는 끝 정점의 in/out 핸들 접선(46 `pathEndTangents`) |
| 4반경 | `roundRectPath`(`geometry.ts:165`)를 `[tl,tr,br,bl]`로 확장(38이 시그니처, 여기서 렌더) |

### 3.7 효과 — `effects.ts`(모자이크와 **같은 함수**)

| 효과 | 구현 |
|---|---|
| 드롭 섀도 | 노드 레이어를 얹을 때 `shadowColor/shadowBlur/shadowOffsetX/Y`(1드로우). shadow 속성은 CTM을 안 타므로 `t.sx`를 곱한다. `spread`는 노드 경로를 `lineWidth=2·spread·round join`으로 stroke한 팽창 알파를 그림자 소스로(민코프스키 합 — 벡터·텍스트 정확, 이미지 페인트는 bbox 배율 근사) |
| 이너 섀도 | 3블릿: 그림자색 채움 → 노드 알파 (dx,dy) 오프셋 `destination-out` → `filter:blur` → 노드 레이어에 `source-atop` |
| 레이어 블러 | 격리 레이어에 `filter:blur((R/2)·s)` |
| **배경 블러 · 픽셀화** | `sampleBackdrop`(격리 스택에서 아래 픽셀 되읽기) → `backgroundBlur`/`pixelate` — `drawMosaic`의 `copy` 합성(`:369`)·3σ 가장자리 복제(`:390-404`)·oriented 셀 격자(`:409-410`)를 **이관**한 함수. `mosaic` kind 분기는 그대로 두고 이 함수를 부른다 — (r)(s)(j) 단언 무변경 |
| 흐림 반경 규약 | 섀도 `B` → `shadowBlur=B·s`(σ=B/2, CSS box-shadow 동일), 블러 `R` → `blur((R/2)·s)`. `effectReach`(38)도 같은 상수(1.5B / 1.5R) — 상수 한 곳 |

`highlight` 특수 경로 삭제: 37 정규화로 `blend:'multiply'`·`opacity .35`인 pen이 되어 일반 경로가 그린다(픽셀 동치는 e2e 30 (i) 형광펜 단언이 검증).

### 3.8 텍스트

`drawText`(`render.ts:263`): `layout.outline`(50 fontkit 글리프 패스)이 있으면 `fill(path)`, 없으면 `runs`를 `fillText`(49 `layoutText` v2). 이 태스크는 37 shim(첫 fill만)을 지우고 페인트 스택·선·효과를 텍스트에도 적용한다.

### 3.9 만들지 않는 것

- 디테일 캔버스·타일 출력·메모리 실측표(→ 40), SVG 크롬(→ 43), 텍스트 레이아웃(→ 49)·OpenType(→ 50), 패스 기하·불리언(→ 46), `ImageNode` kind(이미지는 `opts.image` + `Paint.image`), 노드별 래스터 캐시(상한 없음 — pro §8), 더티 사각형·워커·OffscreenCanvas(정상 프레임이 이미 블릿 1회), WebGL(INDEX §10.5).

## 4. 계약 (소유: 39 · `render.ts`, `paint.ts`, `effects.ts`, `layers.ts`, `imageStore.ts`)

```ts
// render.ts — 유일한 렌더 진입(프리뷰 백킹·디테일·출력 타일·내보내기·썸네일 전부)
export interface RenderOpts { image?: CanvasImageSource; background?: 'image' | 'transparent' | string; skipId?: ObjId; nodeIds?: readonly ObjId[] /* 생략 = 전부, [] = 노드 0(배경만 — 52 '주석 레이어 포함' OFF) */; window?: Rect }
export function renderScene(ctx: CanvasRenderingContext2D, scene: Scene, t: SceneTransform, opts?: RenderOpts): void;
export function applyMask(ctx, scene, mask: MaskScope | EditorDoc['imageMask'], t): void;
export function occlusionIntegrity(scene: Scene): { warnings: string[] };   // 반투명 그룹 안 가림·linear-burn 투명 배경 등 구조적 누수 경고(저장 전)
export function releaseScratch(): void;                                       // → layerPool.releaseAll + 스크래치 해제

// paint.ts
export function fillPaint(ctx, node: GeomNode, path: Path2D, t, store: ImageStore): void;   // fills[] 아래→위
export function strokePaint(ctx, node: GeomNode, path: Path2D, t, store: ImageStore): void; // strokes[] + 정렬·대시·캡·조인·화살촉
export function gradientOf(ctx, paint: Paint, bbox: Rect, t): CanvasGradient | CanvasPattern;

// effects.ts
export function dropShadow(ctx, layer: CanvasImageSource, e: Effect, t): void;
export function innerShadow(ctx, path: Path2D, e: Effect, t, pool: LayerPool): void;
export function layerBlur(ctx, layer, radius: number, t): void;
export function sampleBackdrop(stack: LayerStack, rect: Rect): CanvasRenderingContext2D;   // 격리 스택에서 아래 픽셀
export function backgroundBlur(ctx, rect: Rect, radius: number, t, stack): void;             // drawMosaic blur 분기 이관(copy·3σ 복제)
export function pixelate(ctx, rect: Rect, cell: number, t, stack): void;                     // drawMosaic pixelate 분기 이관(oriented 격자)
export const BLUR_SIGMA = { shadow: (b: number) => b / 2, blur: (r: number) => r / 2 };

// layers.ts
export interface LayerPool { acquire(w: number, h: number): CanvasRenderingContext2D; release(ctx): void; releaseAll(): void; bytes(): number }
export function layerPool(maxBytes: number): LayerPool;                                         // maxBytes = 2 × 백킹 바이트
export const HAS_LAYERS = 'beginLayer' in CanvasRenderingContext2D.prototype;                   // 착수 프로브 — 40 실측표 1행

// imageStore.ts
export interface ImageStore { get(assetId: AssetId): ImageBitmap | null; ensure(doc: EditorDoc): Promise<void> }
export function imageStore(doc: EditorDoc): ImageStore;                                          // WeakMap<doc.assets, …>
export function ensureAssets(doc: EditorDoc): Promise<void>;                                     // = imageStore(doc).ensure(doc) — renderOutput/내보내기(40·52) 전 await
```

소비자 변경: `AnnotationLayer` `ensureCache/paintNow` → `renderScene(cacheCtx, scene, t, {image: oriented, background:'image', skipId})`; `[0]`=캐시 캔버스 DOM 마운트(`visibility:hidden`), `[1]`=씬(라이브 객체는 캐시 위에 재렌더 — 종전 샌드위치 유지). `ImageEditor` 베이스 캔버스·`previewRef`·`filterStr` CSS 삭제, `renderOutput`은 40이 타일로 위임하기 전까지 `renderScene(out, scene, tCrop, {image: oriented, background: opaqueBg ? '#fff' : 'image'})`.

## 5. 단계

0. **프로브**: `HAS_LAYERS` 실측(dev·설치본 WebView2, Linux WebKitGTK) → 40 실측표 1행. 결과가 P1이면 `layers.ts`는 배경 샘플링 스크래치만(≈40줄), P2면 풀(≈120줄).
1. `paint.ts` 신규(≈350) + `geometry.ts roundRectPath` 4반경(+15) — 37 shim 위에서 먼저 동작(리프 채우기/선만 교체, 캔버스 구조 무변경). e2e 30 (u-1~u-6) 페인트 픽셀 단언.
2. `effects.ts` 신규(≈280) + `drawMosaic` 본문 이관(`render.ts` −60/+20). (r)(s)(j) 단언 무변경으로 통과 = 이관 증명.
3. **캔버스 병합**: `render.ts` `renderScene` v2(트리 재귀·격리·블렌드·마스크·`opts.image`; `PreviewBackdrop/drawHighlightOnBackdrop/hlScratch` −95), `AnnotationLayer`(`seedMosaicSources/previewBackdrop/sceneTransform` −50, 캐시 DOM 마운트·재배선 +60), `ImageEditor`(베이스 캔버스·CSS filter −30, `renderOutput` 위임 −25/+10). e2e 30 (a)(c) 2단언 재기술.
4. shim 삭제(37 `primaryFill/primaryStroke`) + `drawText` 페인트 스택. e2e 30 (t)(u) 나머지.

규모 **XL**: 프론트 ≈ +900/−260 · Rust 0 · 신규 의존 0. 커밋 4개, 각 커밋 뒤 30/34/35 초록.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| 조정 슬라이더가 틱마다 전체 재렌더 | 종전 CSS 필터는 무료였다. 4K 백킹 7.3MB 블릿 + 노드 N | 캐시 키에 `filterStr` 포함(현행 `:224`)이라 커밋 캐시 재구축은 슬라이더 **틱마다**. 40 실측; 초과 시 "이미지 레이어만 재그리기"(배경 의존 노드 없으면 노드 레이어 재사용) 규칙 |
| `beginLayer` 미가용 + 풀 바이트 초과 | 깊은 격리 중첩 | 임시 할당 + `console.warn`, 40 실측표에 깊이별 바이트 |
| `linear-burn` 투명 배경 편차 | Figma와 다른 결과 | `occlusionIntegrity` 경고 + INDEX §10.5 명시. 불투명 배경(스크린샷)에서는 정확 |
| 반투명 그룹 안의 모자이크가 새어 보임 | 격리 레이어 알파<1이면 아래 원본이 비친다 | `occlusionIntegrity`가 가림 노드의 조상 opacity<1·blend≠normal을 경고. (s) 단언은 루트 레벨 유지 |
| `[0]` hidden 캐시가 `getImageData`를 막음 | 34 `A.px`·30 `annoPx` | 규격상 막지 않는다 — 3단계 첫 실행에서 34 `A.px` 통과가 증명. 막히면 `opacity:0`으로 전환 |
| 형광펜 특수 경로 삭제로 픽셀 변화 | multiply를 일반 경로가 그림 | 동일 gCO·alpha — e2e 30 (i) `HL_ON_WHITE (255,237,166)`·교차점 값이 회귀 안전망 |
| Mac `ctx.filter`/`beginLayer` | WKWebView 미지원(추정) | 기존 `render.ts:401`·`ImageEditor:679`가 이미 의존 — 새 위험 아님, 실기 항목 |
| 이미지 페인트 로드 전 출력 | 회색 플레이스홀더가 저장됨 | `ensureAssets` await 없이는 `renderOutput` 호출 금지(52 계약) |

## 7. 검증

- **e2e 30 재기술 2건**: (a) "주석 밖은 투명" → `isWhite(aOut)`(원본 흰색 픽스처), (c) `afterTL[3]===0` → `isWhite(afterTL)`.
- **e2e 30 신규 (t)(u)**: (t-1) 다중 채우기 2겹(빨강 100% 위 파랑 50%) → 프리뷰 픽셀 == `readSaved` 픽셀 ±1(프리뷰==저장 델타 0); (t-2) 그룹 `opacity .5` 안 빨강 → 흰 배경 위 (255,128,128)±2; (t-3) `multiply` rect 위 검정 반 픽스처 → 검정 유지·흰 쪽 색 곱; (t-4) `linear-burn` 불투명 배경 → 공식값 ±2; (t-5) 마스크: 원 마스크 아래 사각형 → 원 밖 픽셀 흰색·안 빨강; (t-6) 드롭 섀도 `0·4·12·25%` → 노드 아래 4px 지점 회색 ∈(180,240), 노드 위쪽 흰색; (t-7) 이너 섀도 → 노드 안 가장자리 어둡고 중심 원색; (t-8) 배경 블러 rect → (r)와 같은 인접 델타 기준; (t-9) 선 정렬 inside/outside → 경로 바깥/안쪽 1px 픽셀; (u-1~u-6) 그라디언트 4종 스톱 중간값·이미지 페인트 3모드·4반경 코너 픽셀·대시 간격·화살촉.
- **회귀**: (j)(r)(s)(i) 무변경 통과, 34(32)·35(13) 무변경(`[0]` 백킹 크기 유지 → 35 (a) `[200,200,200,200]`).
- **컴파일**: `renderScene(ctx, doc.objects, …)` 삽입 시 TS 에러.
- **실기/40 인계**: `HAS_LAYERS` 값, 4K 조정 슬라이더 틱 시간, 격리 깊이 3에서 풀 바이트 — 40 실측표.
