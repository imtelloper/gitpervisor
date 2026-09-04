# 태스크 37 — 문서 모델 v2: 노드 유니온·정규화/업그레이드·직렬화 + AnnotationLayer 분할

> 상태: 설계(Design) · 대상: gitpervisor · 근거: 코드 실측 2026-09-04(워킹트리) · 선행: `DOCS/image-annotation-design.md` §5.1(v1 객체 모델),
> `DOCS/pro-image-editor-design.md` §4.1(스키마 미변경 결정 — 이 문서가 대체) · 시안: `designs/image-editor-figma-v2.pen` ①②③⑦(레이어 트리·
> 인스펙터 속성·벡터·마스크) · 상위: `00-INDEX.md` §10(37~52) — **M0. 이 트랙 전체의 타입을 이 문서 하나가 소유한다.**

## 1. 요구사항

시안이 노드에 붙여 놓은 속성을 **전부 담을 수 있는 문서 모델**과, 그 모델로 넘어가면서 **기존 편집기·e2e가 한 줄도 안 깨지는 경계**.

받아들이는 조건(시안 라벨 인용):
- ① 레이어 트리: `주석 레이어(그룹) › 불량 영역 강조 · 치수선 그룹 › 측정값 오차 ±0.2mm · 지시선 벡터[노드 편집] · 번호 뱃지 #3 · 고객사명 모자이크[마스크] · 하이라이트 · 센서 위치(숨김) · 배경 — 대시보드.png(잠금)` — 노드마다 **이름·표시·잠금·부모**가 있고 그룹/프레임이 중첩된다.
- ① 인스펙터 속성: `채우기 F0398B 12% · 선형 그라디언트 135° · 이미지 · 채우기 · 스타일 · 경고/핑크`(다중 채우기 스택), `선 3B82F6 100% · 두께 2 · 안쪽 · 대시 8 · 간격 4`(선 정렬·대시·캡), `효과: 드롭 섀도 0·4·12·25% · 이너 섀도 · 레이어 블러 반경 4 · 배경 블러 반경 12`(효과 스택), `모양 100% · 표준`(불투명도·블렌드), `반경 8 · ↖8 ↗8 ↘8 ↙8`(개별 모서리), `좌·상 고정`(제약), `마스크로 사용 (클리핑)`, `내보내기 1x/2x/3x · 접미사 · PNG/WebP`(노드 내보내기 행).
- ③ 벡터: `노드 X 550 Y 550 · 코너/대칭/비대칭/자동 · 핸들 in −60,−80 · out 60,80 · 채우기 없음 · 짝수-홀수` — 서브패스·정점·상대 핸들·채우기 규칙.
- ② 텍스트: `Pretendard · Regular · 크기 14 · 행간 150% · 자간 −0.2 · 문단 간격 8 · 들여쓰기 0 · 자동 폭/자동 높이/고정 · 밑줄/취소선/위첨자/아래첨자 · Aa/AA/aa · 말줄임 · 2줄 · 리가처/구식 숫자/고정폭 숫자/분수`.
- ⑦ `마스크 모양 마스크 / 알파 채널 · 마스크 반전 · 직선화 1.4°`, ① 눈금자 위 `가이드`.
- 위 전부가 **저장·복원·undo 가능한 문서 값**이어야 한다(렌더·UI는 뒤 태스크). 기존 v1 문서(`EditorDoc`/`AnnoObject` 7종)와 e2e 30·34·35의 `setDoc` 리터럴 21건이 **재작성 없이** 새 모델로 흡수된다.

## 2. 현황(근거)

- **v1 모델**: `src/lib/annotate/types.ts:35-48` `Common{id,stroke,strokeWidth,opacity,rot}` 위에 7종 — `PenObject(pts)` :51-54, `LineObject(x1..y2, head:'end'|'both')` :57-64, `RectObject(fill:string|null, radius:number)` :67-75, `EllipseObject` :78-85, `TextObject(text,fontSize,fontFamily)` :88-95, `BadgeObject(n,fontSize,fill)` :98-105, `MosaicObject(mode,strength)` :111-120, 유니온 :122-129, `EditorDoc{objects,rotation,flipH,flipV,crop,outW,outH,brightness,contrast,saturate}` :140-151. **이름·표시·잠금·부모·다중 페인트·효과·블렌드·경로·타이포·마스크·가이드 — 전부 없다.** 시안 ①②③⑦의 라벨 중 v1 필드가 받는 것은 `strokeWidth`·`opacity`·`radius(단일)`·`fontSize`·`fontFamily`뿐이다.
- **스타일 조작 경로가 도구 속성 하나에 묶여 있다**: `ToolStyle{stroke,strokeWidth,fill,radius,fontSize,mosaicMode,mosaicStrength}` `types.ts:223-241` → 새 객체는 `AnnotationLayer.tsx:1155-1208 makeDraft`가 `s.style.stroke/fill/strokeWidth/radius/fontSize/mosaicMode/strength`를 직접 박고(:1164-1208), 선택 객체 편집은 `ImageEditor.tsx:152-172 restyle`이 kind별 if 7개로 필드를 옮긴다(:626-642 `onStyleChange`가 호출). 소비자 4파일: `types.ts`·`ImageEditor.tsx`·`AnnotationLayer.tsx`·`AnnotationToolbar.tsx`(grep). 다중 채우기·선 스택은 이 구조에 **자리 자체가 없다**.
- **불변·스냅샷 규약**: `types.ts:7-8` "객체는 불변 갱신 — 바뀐 객체만 새 참조". `history.ts:46-54 commit`은 문서 참조를 그대로 스택에 넣는다(복사 0) — `objects` 배열은 커밋마다 새 배열(N×8B), 노드는 공유. 이 규약이 살아야 히스토리가 200으로 늘어도(→ 태스크 41) 비용이 배열 참조 복사뿐이다. `AnnotationLayer.tsx:219-258 ensureCache`는 `cacheSrcRef.current === s.objects` **참조 비교**로 커밋 캐시를 재사용한다 — 문서 형태가 바뀌어도 `objects`가 배열이고 커밋마다 새 참조라는 성질은 지켜야 한다.
- **exhaustive switch가 7곳**: `geometry.ts:197 buildObjectPath` · `:240 objectAnchor` · `:280 objectBBox` · `:377 hasInterior(default :385)` · `:392 hasOutline(default :396)` · `:494 transformObjects`(**default 없음**) · `:539 translateObject(default :558)`, `render.ts:103 drawObject`(highlight/pen/line/arrow/rect/ellipse/text/badge — mosaic은 :84 선분기), `AnnotationLayer.tsx:1226 isDraftUsable`·`:1352 scaleObject`. 새 kind가 들어오면 이 11곳이 컴파일 에러 또는 조용한 누락 둘 중 하나다 — 어느 쪽이 될지를 **이 태스크가 정해야** 한다(§3.4).
- **e2e 전제**: `30-image-annotate.mjs:519-571` 리터럴 팩토리 5종(`rectObj`·`hlObj`·`mosaicObj`·`blurObj`·`rotRectObj`)이 `{id,kind,stroke,strokeWidth,opacity,rot,…}` v1 형태로 `setDoc`(21회)에 들어간다. `A.fresh()`는 `objects.length===0 · rotation 0 · crop null · brightness 100 · !flipH · !flipV`만 본다. `getDoc()` 읽기는 `x/y/w/h/kind/n/fontSize/rotation/objects.length`뿐 — **`.stroke`/`.fill`을 읽는 단언 0건(grep)**. `34:171`에 `kind:"rect"` 리터럴 1건, 35는 포인터로만 그린다. ⇒ "리터럴이 들어가는 경계에서 완전한 노드로 채워지면" 세 스위트 **재작성 0줄**이 성립한다.
- **AnnotationLayer.tsx는 1,396줄 단일 파일**: 포인터 :395-638(`onPointerDown`~`onDoubleClick`), 키보드 :639-719, 핸들 :724, 텍스트 편집 :359(`finishEditing`)·:770-858(`editBox`·textarea), 화면 크롬 :914-1153(`drawSelection`·`drawCropOverlay`·`drawHud`·`drawMarquee`·`handlePointsOf`·`hitHandle`), 드래프트/변형 :1155-1396. 38·42·43·47·48이 전부 이 파일을 건드린다 — 분할 없이 시작하면 M2~M4가 같은 파일에서 충돌한다(INDEX §7.1의 "같은 파일 순차" 규칙이 4~5개 태스크에 걸린다).
- **사이드카 스키마는 아직 없다**: `parseImageDoc|DOC_VERSION|serializeImageDoc|normalizeNode` grep 0건. `pro-image-editor-design.md` §4.1 "직렬화하지 않으므로 버전 필드도 파서도 없다"가 현행 — 태스크 41(영속)이 파서를 요구하므로 여기서 정의한다.

## 3. 설계

### 3.1 진화인가 교체인가 — **진화**

| 대안 | 평가 |
|---|---|
| **A. 7종 kind·기하 필드는 그대로, 스타일만 `fills/strokes/effects/blend`로 옮기고 경계 함수 하나(`normalizeNode`)가 v1→v2를 채운다** (채택) | 기하(`pts`·`x1..y2`·`x,y,w,h`·`text`·`n`·`mode/strength`·`rot`)를 1비트도 안 바꾸므로 `geometry.ts`의 bbox/히트/변환과 `render.ts`의 경로 빌더가 **그대로**다. e2e 리터럴은 경계를 지나며 완전해진다 → 0줄 이행. `mosaic` kind가 남으므로 `drawMosaic`(render.ts:349, copy 합성·3σ 패딩)과 e2e 30 (j)(r)(s) 누수 단언이 그대로 산다 |
| B. Figma식 새 노드 모델로 교체(`Rectangle{fills…}`, `Vector`, …) + v1 변환기 | 기하 함수 11곳을 전부 다시 쓰고, e2e 픽스처·헬퍼(`px`·`midRunOf`·`readSaved` 좌표)를 새 좌표 규약으로 재작성. 얻는 것은 이름뿐 |
| C. v1 그대로 두고 `meta: {...}` 가방을 붙인다 | 렌더가 `meta`를 읽기 시작하는 순간 "문서엔 있는데 안 보이는" 상태가 영구화된다. 타입이 진실을 말하지 않는다 |

**리프 좌표는 세계 oriented px 하나**(중첩 행렬 0). 그룹은 기하가 없고 프레임만 세계 rect를 가진다. 그래서 `objectAABB`가 부풀 컨테이너가 **타입상 들어갈 수 없다** — `geometry.ts` 함수의 인자를 `GeomNode`(리프|Frame)로 좁혀 `objectAABB(group)`은 **컴파일 에러**다(§7의 증명 항목). 컨테이너 AABB는 `tree.nodeAABB`가 자손 합집합으로 파생한다(→ 태스크 38 §4).

### 3.2 노드 유니온 — kind 13종

`NodeBase`(공통) + v1 9 kind(pen·highlight·line·arrow·rect·ellipse·text·badge·mosaic) + `path`·`frame`·`group`·`instance`. 심사에서 통일된 규칙:

| 결정 | 선택 | 탈락 |
|---|---|---|
| 선(stroke) 모델 | **`strokes: Fill[]` + 노드 레벨 `strokeWidth/strokeAlign/dash/cap/join/miterLimit/heads`** — 두께·정렬은 노드에 하나 | 선마다 두께(`Stroke{paint,width,…}[]`): 시안 ①③에 사례 0건, `geometry.ts:283/291/298 objectBBox`·`:424 hitTestIndex`가 단일 두께를 전제. `strokeWidth` **이름을 v1 그대로** 두면 e2e 리터럴·`upgradeV1Object`가 필드 이동 없이 통과 |
| 페인트 판별자·필드명 | `type`(`'solid'|'linear'|'radial'|'angular'|'diamond'|'image'`), 알파 `opacity`, 스톱 위치 `pos` | `kind`/`alpha`/`at`/`offset` 혼용(축마다 달랐다) — 변환표가 생긴다 |
| 블렌드 enum | canvas `globalCompositeOperation` 철자 **케밥 19** + `'pass-through'`(group/frame만, 정규화가 리프를 `'normal'`로) | camelCase·`'passthrough'`: 렌더에서 매핑표 필요. 시안 ④ 목록은 패스스루+18 = **19** |
| 효과 | `{type:'drop-shadow'|'inner-shadow';x;y;blur;spread;color;opacity;visible}` · `{type:'layer-blur'|'background-blur';radius;visible}` | render 축의 `pixelate` 효과 kind: 모자이크는 kind로 남기고 `effects.ts`의 **함수**를 공유한다(→ 39). 타입 이관 0 |
| 반경 | `radius: [tl,tr,br,bl]` 4-tuple — 숫자 입력은 정규화가 4곳 복제 | 단일 숫자: 시안 ① `↖8 ↗8 ↘8 ↙8` 개별 입력 불가 |
| 제약 | `constraints:{h:'left'|'right'|'center'|'scale'|'stretch'; v:'top'|'bottom'|'center'|'scale'|'stretch'}` | `'leftright'`: Figma 표기 'left and right' = stretch |
| 화살촉 | `heads:{start;end:'none'|'arrow'}` — v1 `arrow.head:'end'|'both'`는 정규화가 `heads`로 채우고 **기하 필드로도 유지**(render shim 호환, 39가 제거) | `ArrowHead` 5종(triangle/circle/bar): 시안 ③ 엔드포인트는 `시작 없음 · 시작 화살표 · 끝 화살표`뿐 |
| 텍스트 | `TextNode = NodeBase & TextStyle & {kind:'text';x;y;w;h;text}` — `TextStyle`은 텍스트 축 필드(`lineHeight`/`letterSpacing` %, `resize`, `underline/strike` boolean, `textCase:'none'|'upper'|'lower'`, `features:{liga,onum,tnum,frac}`) | `textCase:'title'`, 페인트 `image:'tile'`: 시안에 없음(열린 질문에도 올리지 않음) |
| 마스크 | `NodeBase.mask:{mode:'shape'|'alpha';invert}|null`(형제 범위 규칙은 38 `maskScope`) + `EditorDoc.imageMask:{id;mode;invert}|null`(⑦ 벡터 모양으로 이미지 자르기) | 이미지 전용 `doc.mask` 단일: ①⑤의 `고객사명 모자이크[마스크]`·`마스크 적용` 히스토리는 형제 마스크 전제 |
| 인스턴스 | `InstanceNode{kind:'instance';componentId;overrides}` — **자식 물질화**(그룹과 같은 `objects` 평탄 슬라이스 — `children` 배열 없음, 38 §3.1 불변식 하나. 정합 검사 결정 2026-09-04; 자식 id `${inst}/${child}`), 렌더·히트·기하·히스토리 변경 0 | 렌더 시 확장(WeakMap): Scene 캐시·히트·마퀴·히스토리가 "문서에 없는 노드"를 다뤄야 한다(→ 51이 `diffInstance`로 재정의 파생) |
| 조정 | `brightness/contrast/saturate` **3필드 유지** | 8슬라이더(노출·색온도…)·필터 6: `.pen` 라벨 0건 — INDEX §10.3 열린 질문 |

### 3.3 정규화 경계 — `schema.ts`

모든 입력(setDoc 리터럴·사이드카 JSON·붙여넣기)은 `normalizeNode`를 지나 **완전한** `Node`가 된다. 내부 코드는 `?? 기본값` 방어를 하지 않는다(pro 설계 §8이 지적한 "렌더러가 `?? 기본값`으로 방어해야 한다" 비용을 경계 한 곳으로 몰아넣는다).

- `upgradeV1Object(o)`: `stroke + strokeWidth>0` → `strokes:[{type:'solid',color,opacity:1,visible:true,blend:'normal'}]`, `strokeAlign:'center'`, `cap/join:'round'`(render.ts 현행 :97-99 lineJoin/lineCap round); `fill` → `fills[0]`; `badge.fill` → `fills`(원 채움), `text.stroke` → `fills`(글자색 — render.ts:263 `drawText`가 stroke를 글자색으로 쓴다); `arrow.head` → `heads`; `radius:number` → 4-tuple; `highlight` → `blend:'multiply'`·`opacity` 유지(render.ts:104-110 multiply 관례); `opacity` → `NodeBase.opacity`; `name:null`(레이어 패널이 `defaultLayerName`으로 표시 → 44), `visible:true`, `locked:false`, `parentId:null`, `effects:[]`, `constraints:{h:'left',v:'top'}`, `mask:null`, `exportRows:[]`, `styleRefs:{}`.
- `normalizeDoc(input)`: v1 `EditorDoc`·`Partial<EditorDoc>` 허용, `v:2`·`assets:{}`·`guides:[]`·`imageMask:null`·`straighten:0` 채움. 미지 kind 서브트리는 `foreign`으로 이동(표시 안 함, 저장 시 원문 재방출), 알려진 kind의 미지 필드는 버린다.
- `parseImageDoc(json)`: `v > DOC_VERSION(2)` → `throw {code:'UNSUPPORTED_VERSION'}` — **읽지도 덮어쓰지도 않는다**(상위 버전 앱이 쓴 문서를 하위 앱이 조용히 깎는 사고 차단). `serializeImageDoc(env)`: `foreign` 원문 재방출.
- `applyPaintPatch(node, patch)` / `paintOf(node, slot)` / `DefaultPaint`: `restyle`(ImageEditor:152-172)과 `ToolStyle`을 대체한다. 도구가 드는 "다음 객체의 속성"은 `DefaultPaint{fills,strokes,strokeWidth,radius,fontSize,mosaicMode,mosaicStrength}`로, `makeDraft`(:1155)는 `DefaultPaint`에서 `fills/strokes`를 복사한다. `documentColors(doc)`: 문서에 쓰인 단색을 순서 보존 중복 제거(④ 색 피커 '문서 색상' 8칸 → 45).

### 3.4 exhaustive switch 11곳의 처리 원칙

- `geometry.ts` 5곳(`buildObjectPath`·`objectAnchor`·`objectBBox`·`transformObjects`·`translateObject`)과 `render.ts drawObject`·`AnnotationLayer isDraftUsable/scaleObject`: 인자를 **`GeomNode`로 좁힌다**. `path`·`frame` case는 **이 태스크가 항등/최소 구현 stub**으로 넣는다(`path`: 서브패스 정점 AABB·앵커=AABB 중심·`translate`는 정점 이동; `frame`: rect와 동일 기하). `group`·`instance`는 인자 타입에서 빠지므로 **컴파일 에러**(조용한 누락이 아니라 빌드 실패 — 38이 `tree.ts`로 다룬다).
- `hasInterior`(:377) → `fills.some(f=>f.visible)`, `hasOutline`(:392) → `strokes.some(s=>s.visible) && strokeWidth>0`. v1의 `o.fill !== null` 판정과 결과 동치(정규화가 `fill:null`을 `fills:[]`로 보낸다).
- **render shim**(39 전까지): `drawObject`는 `primaryFill(o)`/`primaryStroke(o)` = 첫 visible 항목의 단색만 쓴다. 그라디언트·이미지·2번째 이후 채우기·효과·블렌드(형광펜 multiply 제외)는 **그리지 않는다** — `ponytail: 39가 renderScene v2로 교체할 때까지의 천장. 문서엔 있는데 안 보이는 기간이 생긴다(§6)`. `AnnotationToolbar`는 `DefaultPaint`의 첫 항목만 보여 준다.

### 3.5 AnnotationLayer 4모듈 분할 (커밋0 — 행동 변화 0)

| 모듈 | 옮기는 것(현 줄) | 이후 소유 |
|---|---|---|
| `annotation/pointer.ts` | `onPointerDown/Move/Up/DoubleClick`·`applyDragAt`·`updateHoverCursor`·`toOriented`·`DragState`(:119-135, :339-638) | 38(씬 히트)·47(노드 편집)·48(크롭) |
| `annotation/keys.ts` | 키보드 effect(:639-719)·`reorder`(:1256) | 42(단축키 표로 흡수) |
| `annotation/chrome.ts` | `drawSelection`·`drawCropOverlay`·`drawHud`·`drawMarquee`·`handlePointsOf`·`hitHandle`·`marqueeRect`·`rectsOverlap`(:914-1153) | 43(SVG 크롬으로 이전 후 삭제) |
| `annotation/textEdit.ts` | `EditState`·`finishEditing`·`editBox`·textarea 마크업(:136-143, :359-393, :770-858) | 49(텍스트 엔진) |
| 남는 `AnnotationLayer.tsx` | 캐시·paintNow·schedule·imperative handle·`makeDraft`·`resizeObject`·`scaleObject`(≈420줄) | 38·39 |

순수 이동이다 — export 이름·시그니처·호출 순서 불변, `git diff --stat`에서 삭제/추가 줄 수가 같아야 한다. 분할 뒤 30/34/35를 **격리 실행해 기준선 기록**(현재 단언 91/32/13, INDEX R10).

### 3.6 만들지 않는 것

- 트리 연산·`resolveScene`·컨테이너 AABB(→ 38), 페인트/효과/블렌드/마스크 렌더(→ 39), 사이드카 I/O·자동저장(→ 41), 레이어 패널·인스펙터 UI(→ 44·45), 패스 렌더/불리언(→ 46), 스타일·컴포넌트 연산(→ 51).
- 시안에 없는 필드: `textCase:'title'`, 페인트 `image:'tile'`, 화살촉 5종, 조정 8슬라이더, `ImageNode` kind(이미지는 `fills[].type:'image'` 페인트로).
- 구조 공유 히스토리 라이브러리(immer 등): 커밋 비용이 배열 참조 복사뿐이라 불필요(5,000노드×200 = 8MB 천장, → 41).

## 4. 계약 (소유: 37 · `src/lib/annotate/types.ts`, `src/lib/annotate/schema.ts`)

```ts
// types.ts — 타 태스크는 import만. 같은 개념에 두 이름 금지.
export type BlendMode = 'pass-through'|'normal'|'darken'|'multiply'|'linear-burn'|'color-burn'|'lighten'|'screen'
  |'linear-dodge'|'color-dodge'|'overlay'|'soft-light'|'hard-light'|'difference'|'exclusion'|'hue'|'saturation'|'color'|'luminosity'; // 19
export type Paint =
  | { type:'solid'; color:string; opacity:number }
  | { type:'linear'|'radial'|'angular'|'diamond'; stops:{ pos:number; color:string; opacity:number }[]; angle:number; scale:number }
  | { type:'image'; assetId:string; mode:'fill'|'fit'|'stretch' };
export type Fill = Paint & { visible:boolean; blend:BlendMode };
export type Effect =
  | { type:'drop-shadow'|'inner-shadow'; x:number; y:number; blur:number; spread:number; color:string; opacity:number; visible:boolean }
  | { type:'layer-blur'|'background-blur'; radius:number; visible:boolean };
export interface ExportRow { scale:number|{ width:number }; suffix:string; format:'png'|'jpg'|'webp'|'avif'; quality:number; profile?:'srgb'|'display-p3' /* 정규화 'srgb' — 52 §3.4 */ } // 52가 소비
export interface NodeBase {
  id:ObjId; parentId:ObjId|null; name:string|null; visible:boolean; locked:boolean;
  opacity:number; blend:BlendMode; rot:number;
  fills:Fill[]; strokes:Fill[]; strokeWidth:number; strokeAlign:'inside'|'center'|'outside';
  dash:number[]|null; cap:'butt'|'round'|'square'; join:'miter'|'round'|'bevel'; miterLimit:number;
  heads:{ start:'none'|'arrow'; end:'none'|'arrow' }; effects:Effect[];
  constraints:{ h:'left'|'right'|'center'|'scale'|'stretch'; v:'top'|'bottom'|'center'|'scale'|'stretch' };
  mask:{ mode:'shape'|'alpha'; invert:boolean }|null; exportRows:ExportRow[];
  styleRefs:{ fill?:StyleId; stroke?:StyleId; text?:StyleId; effect?:StyleId };
}
// v1 9종: 기하 필드 그대로(pen/highlight pts · line/arrow x1,y1,x2,y2,head · rect x,y,w,h,radius:[tl,tr,br,bl] · ellipse x,y,w,h
//         · text → TextNode · badge x,y,n,fontSize · mosaic x,y,w,h,mode,strength). fill/stroke/strokeWidth(v1 의미)/opacity 는 NodeBase 로.
export interface PathVert { x:number; y:number; inX:number; inY:number; outX:number; outY:number; mode:'corner'|'mirrored'|'asymmetric'|'auto' } // 상대 핸들, (0,0)=없음
export interface PathNode extends NodeBase { kind:'path'; subpaths:{ verts:PathVert[]; closed:boolean }[]; fillRule:'nonzero'|'evenodd' }
export interface FrameNode extends NodeBase { kind:'frame'; x:number; y:number; w:number; h:number; radius:[number,number,number,number]; clipsContent:boolean }
export interface GroupNode extends NodeBase { kind:'group'; detachedFrom?:ComponentId }                       // 기하 없음 — AABB 는 tree.nodeAABB 파생(38)
export interface InstanceNode extends NodeBase { kind:'instance'; componentId:ComponentId; overrides:Record<ObjId,InstanceOverride /* 51 §4 */> } // 자식 = objects 평탄 슬라이스(children 배열 없음), 자식 id `${inst}/${child}` — id 에 '/' 허용
// normalizeNode 는 componentId/overrides/detachedFrom 을 보존한다(51 요청 — 정합 검사 결정)
export interface TextStyle { fontFamily:string; fontWeight:number; italic:boolean; fontSize:number; lineHeight:number/*%*/; letterSpacing:number/*%*/;
  paragraphSpacing:number; indent:number; align:'left'|'center'|'right'|'justify'; valign:'top'|'middle'|'bottom';
  resize:'auto-width'|'auto-height'|'fixed'; underline:boolean; strike:boolean; script:'none'|'super'|'sub';
  textCase:'none'|'upper'|'lower'; list:'none'|'bullet'|'number'|'check'; listLevel:number; truncateLines:number|null;
  features:{ liga:boolean; onum:boolean; tnum:boolean; frac:boolean } }                                            // 49·50이 소비
export type TextNode = NodeBase & TextStyle & { kind:'text'; x:number; y:number; w:number; h:number; text:string };
export type LeafNode = PenObject|LineObject|RectObject|EllipseObject|TextNode|BadgeObject|MosaicObject|PathNode;
export type GeomNode = LeafNode|FrameNode;   // geometry.ts·render.ts 가 받는 유일한 타입 — group/instance 는 컴파일 에러
export type Node = GeomNode|GroupNode|InstanceNode;
export interface EditorDoc {
  v:2; objects:Node[];                      // DFS 전순 · 자손은 컨테이너 바로 뒤 연속 · 뒤가 위(z) · 리프 좌표 세계 oriented px(불변식은 38 assertTreeInvariant)
  assets:Record<AssetId,{ mime:string; w:number; h:number; data:string }>; guides:{ axis:'x'|'y'; pos:number }[];
  imageMask:{ id:ObjId; mode:'shape'|'alpha'; invert:boolean }|null; straighten:number;
  rotation:number; flipH:boolean; flipV:boolean; crop:Rect|null; outW:number; outH:number; brightness:number; contrast:number; saturate:number;
}
export interface DefaultPaint { fills:Fill[]; strokes:Fill[]; strokeWidth:number; radius:[number,number,number,number]; fontSize:number; mosaicMode:MosaicMode; mosaicStrength:number } // ToolStyle 대체

// schema.ts
export const DOC_VERSION = 2;
export function normalizeNode(input:unknown):Node|null;          // 미지 kind → null(호출자가 foreign 으로)
export function normalizeDoc(input:unknown):EditorDoc;           // v1·Partial 허용, foreign 분리
export function upgradeV1Object(o:AnnoObjectV1):Node;
export interface ImageDocEnvelope { v:2; projectId:string; relPath:string; imageStamp:string|null; imageW:number; imageH:number; savedAt:number; doc:EditorDoc; foreign:unknown[]; log:{ at:number; label:string }[] }
export function serializeImageDoc(env:ImageDocEnvelope):string;
export function parseImageDoc(json:string):{ env:ImageDocEnvelope; warnings:string[] }; // v>2 → throw {code:'UNSUPPORTED_VERSION'}
export function applyPaintPatch(node:Node, patch:Partial<DefaultPaint>):Node;      // restyle 대체 · 직접 편집 시 styleRefs 자동 detach(51 §4)
export function paintOf(node:Node):DefaultPaint;                                     // 선택 노드 → 툴바 표시값
export function documentColors(doc:EditorDoc):string[];
```

e2e 페이지 훅(`window.__gpv.imageEditor`, 기존 :951-964 옆): `roundTrip(): boolean` — `parseImageDoc(serializeImageDoc(env))`의 `doc`이 현재 `docRef`와 깊은 동치인가. `EMPTY_DOC`(ImageEditor.tsx:101)은 `normalizeDoc({})` 결과로 정의한다.

## 5. 단계

1. **커밋0 — AnnotationLayer 4모듈 분할**(§3.5, 이동만 ≈ −900/+900줄). 30/34/35 격리 실행 → 91/32/13 기준선 기록.
2. **커밋1 — `types.ts` v2 + `schema.ts`**: types 246→≈520, schema 신규 ≈260(정규화 ≈120·업그레이드 ≈60·직렬화 ≈40·페인트 패치 ≈40). `ToolStyle`·`DEFAULT_STYLE` 삭제 → `DefaultPaint`·`DEFAULT_PAINT`. `EMPTY_DOC = normalizeDoc({})`.
3. **커밋2 — 소비자 이행**: `geometry.ts` 인자 `GeomNode` + path/frame stub(+≈60), `render.ts` shim `primaryFill/primaryStroke`(+≈40, `ponytail:` 주석), `ImageEditor.tsx` `restyle`→`applyPaintPatch`·`onStyleChange` `DefaultPaint`(≈ −20/+40), `AnnotationLayer` `makeDraft`(DefaultPaint 복사)·`scaleObject`/`isDraftUsable` path/frame 항등 stub(+≈30), `AnnotationToolbar` 첫 항목 표시(+≈20), `__gpv.imageEditor.roundTrip`. `tsc` 통과 = §3.4 원칙 증명.
4. **e2e** — 스위트 `42-image-doc-schema.mjs` 신설(INDEX §10.4 번호표 42): 아래 §7. `run.mjs` 등록 1줄.

규모 **L**: 프론트 ≈ +1,000/−950(이동 포함) · Rust 0 · 신규 의존 0.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| shim 기간 "문서엔 있는데 안 보임" | 커밋2~39 사이 그라디언트·2번째 채우기·효과·블렌드가 문서엔 저장되나 렌더 안 됨 | 39 전까지 툴바/인스펙터가 그 값을 **만들 수 없다**(45가 39 뒤). 사이드카(41)로 들어온 값만 해당 — `ponytail:` 천장 명시, 39 수용 기준에 "shim 삭제" |
| 정규화가 v1 리터럴을 다르게 해석 | `text.stroke`→fills(글자색) 같은 매핑이 틀리면 e2e 30 픽셀 단언(RED 등)이 깨진다 | 커밋2 뒤 30/34/35 단언 수·pass 수 기준선과 동일해야 머지. 매핑 표(§3.3)는 render.ts 현행 해석에서 도출 |
| `transformObjects`(:494)에 default 없음 | 새 kind 누락이 런타임에 조용히 `undefined` 반환 | 인자 `GeomNode` 좁힘으로 컴파일 에러화 + `path`/`frame` case 추가. 90° 회전 델타는 정점/rect에 v1 rect 규칙 재사용 |
| `foreign` 보존이 트리 불변식을 깨뜨림 | 미지 kind 서브트리를 빼면 `parentId` 사슬이 끊길 수 있다 | `normalizeDoc`이 서브트리 단위(`subtreeRange`)로 통째 이동 — 38의 `assertTreeInvariant`가 DEV에서 검증 |
| `strokeWidth` 이름 유지가 헷갈림 | v1 의미(단일 두께)와 `strokes[]` 공존 | 주석으로 "두께는 노드 하나, 색만 스택" 명시. 시안 ①③ 선 섹션 두께가 단일이라 UI도 같다 |
| 인스턴스 자식 id에 `/` | id 규약 변경 | `newObjId`는 uuid(`types.ts:244`), `/`는 uuid에 없으므로 충돌 0. 규약 주석 추가 |

## 7. 검증

- **e2e 42 (신규)**: (a) `setDoc(rectObj(...))`(v1 리터럴) → `getDoc().objects[0]`에 `fills.length===1 && fills[0].type==='solid' && fills[0].color==='#FF3B30' && strokes.length===0(강도 0) && parentId===null && visible===true`; (b) `hlObj` → `blend==='multiply' && opacity===0.35`; (c) `{kind:'arrow',head:'both',…}` → `heads.start==='arrow' && heads.end==='arrow'`; (d) `roundTrip()===true`(단색·그라디언트 스톱·효과·path·frame·group·텍스트 features 포함 문서); (e) `parseImageDoc` v=3 → `UNSUPPORTED_VERSION`; (f) 미지 kind → `foreign` 1건 보존·재직렬화 동일; (g) `normalizeDoc({})` 깊은 동치 `EMPTY_DOC`; (h) `documentColors` 순서·중복 제거.
- **회귀**: 30(91)·34(32)·35(13) 단언 수 동일·전부 pass — 커밋0 뒤·커밋2 뒤 두 번.
- **컴파일 증명**: `tsc` 통과 상태에서 `objectAABB({kind:'group',…} as Node)` 한 줄을 임시로 넣으면 **TS2345 에러**(리뷰 체크리스트, 코드에 남기지 않음).
- **실기**: 기존 이미지 편집 흐름(펜·화살표·모자이크·텍스트·저장) 육안 동일; DevTools에서 `getDoc()` 노드에 v2 필드가 채워짐.
