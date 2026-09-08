# 태스크 40 — 렌더 윈도·디테일 캔버스·타일 출력·샌드위치 캐시·메모리 원장 실측

> 상태: 설계(Design) · 대상: gitpervisor · 근거: 코드 실측 2026-09-04(워킹트리) · 선행: 태스크 39(`renderScene(ctx, scene, t, opts.window)`), 38(`effectReach/visualBounds`),
> `DOCS/pro-image-editor-design.md` §6.3(4K 메모리 예산 121/154MB)·§8(뷰포트 렌더 기각 근거 "클램프 사고" — 이 문서가 푼다), `DOCS/windows-lowmem-postmortem.md` §E(압박 시 자동 감축),
> `CLAUDE.md`(OOM 이력) · 시안: `designs/image-editor-figma-v2.pen` ⑦(픽셀 그리드 400%·픽셀 미리보기 끄기/1x/2x)⑥(배율 1x/2x/0.5x/너비 1200·예상 용량) · 상위: `00-INDEX.md` §10 — **M1 마감(M).**

## 1. 요구사항

시안 ⑦ `픽셀 미리보기 끄기 · 1x · 2x`, `픽셀 그리드 400% · 1px 단위 스냅`, ⑥ `배율 1x · 2x · 0.5x · 너비 1200 · 크기 5760×3210 · 예상 용량 14.2 MB`, `레이어별 파일 분리`, `잘라내기 여백 0`,
상태바 `실행 취소 12단계`(히스토리 구조가 이 태스크 뒤에도 불변임을 확인).

받아들이는 조건:
- 확대하면(화면 배율 > 백킹 배율) **원본 픽셀**이 보인다 — 1800px 백킹의 업스케일 흐림이 아니라. 픽셀 미리보기 1x/2x는 정수 배율 픽셀을 그대로 보여준다.
- 프리뷰 백킹(`previewScale/backW/backH`, MAX_PREVIEW=1800)은 **불변**이다(e2e 35 (a) `[200,200,200,200]`).
- 뷰포트 일부만 렌더해도 가림(모자이크/블러)·효과 결과가 **스크롤 위치와 무관**하다 — pro 설계 §8이 기각한 "클램프 사고"가 단언으로 막힌다.
- 2x·3x 내보내기의 작업 메모리가 출력 크기에 비례해 늘지 않는다(타일).
- **메모리 원장 하나**: 4K 기준 정상·확대 300%·2x 저장 세 시점의 실측 표와 상한이 이 문서에 있고, 다른 태스크는 여기 합산한다(축별 예산 합산 금지 — 심사 blocker).

## 2. 현황(근거)

- **백킹은 상한 1800**: `ImageEditor.tsx:64 MAX_PREVIEW`, `:372-374 previewScale = min(1, 1800/max(w,h))`, `:375-376 backW/backH`. 4K는 백킹 1800×1013 = 7.3MB, 화면 배율이 그 위로 올라가면 CSS 업스케일(`:1085 imageRendering: screenScale >= 2 ? "pixelated" : "auto"`) — 원본 픽셀은 **어디에도 없다**.
- **줌은 CSS transform 한 겹**: `:226 view`, `:231 boxRef`(변환 없는 앵커), `:1071-1076 transformOrigin "0 0"` 래퍼, `:397 displayScale = dispW/oriented.width`, `:400 screenScale = displayScale·view.scale`. e2e 35 (a)(a-1)(a-2)·(b-1)(b-2)가 "백킹 불변 + 커서 고정"을 이름 붙여 지킨다(`35:312-317`).
- **출력은 전면 1회**: `renderOutput`(`:660-691`) — `out.width = outW`(`MAX_OUTPUT_DIM 16384` 가드 `:66`)로 출력 캔버스를 통째로 만들고 `renderScene` 1회. 2x(5760×3210)면 출력 74MB + 렌더 중 스크래치. 3x는 출력 166MB. pro §6.3 예산이 "저장 피크 154MB"인 이유다.
- **클램프 사고**(pro §8 뷰포트 렌더 기각 근거): `drawMosaic`의 `Math.max(0,…)/Math.min(canvas.width,…)`(`render.ts:359-362`)는 **캔버스 경계** 클램프다. 캔버스가 이미지 전체를 덮을 때만 그 경계가 진짜 이미지 가장자리다. 뷰포트만 그리면 경계가 이미지 한가운데를 지나고 팬할 때마다 움직여 가림 결과가 스크롤마다 달라진다 — e2e 30 (r)이 기록한 사고의 뷰포트판. 39가 `sampleBackdrop`을 격리 스택에서 하도록 바꿔도 **윈도 경계** 문제는 남는다.
- **커밋 캐시는 1장**: `AnnotationLayer.tsx:219-258 ensureCache` — 커밋 객체 전부를 한 장에, 라이브 객체는 매 프레임 그 위에(`:260-298 paintNow`). 캐시 키 `:224`에 `filterStr`이 있어 조정 슬라이더 틱마다 재구축(39 위험 1행).
- **압박 감축 훅이 이미 있다**: `health://level`이 warn 이상이면 `webview_guard.rs:210-250 set_memory_target_low`가 모든 웹뷰에 `SetMemoryUsageTargetLevel(LOW)`, 풀 창 회수, PTY 예산 강등(postmortem §E). `on_health_level`은 **전이 시점에만** 발화한다. 내보내기 게이트는 여기 붙일 자리가 있다.
- 사건 머신(postmortem §0-§3): RAM 7.7GB·물리 93~94%에서 WebView2 렌더러 크래시. 편집기 창은 doc 창마다 별도 WebView2(창당 곱셈 요인, pro §6.3).
- 실측 스크립트 관례: `scripts/verify-*.mjs`(CDP로 실행 중 앱에 붙는다), e2e 러너 결과는 부하 낮을 때만 신뢰(메모리 `e2e-baseline-failures`).

## 3. 설계

### 3.1 확대 시 원본 픽셀 — 화면 공간 디테일 캔버스 `[2]`

| 대안 | 평가 |
|---|---|
| **A. 백킹 `[0][1]`은 그대로. transform 밖에 뷰포트 크기 캔버스 `[2]`를 두고, `screenScale > previewScale`이거나 픽셀 미리보기가 켜지면 가시 oriented 사각형을 `opts.window`로 같은 `renderScene`을 부른다** (채택) | 백킹 불변(35 ①)·30 좌표 리터럴·캐시 키 전부 무영향. 디테일은 화면 픽셀 1:1(dpr 반영)이라 400%에서도 원본 픽셀. 확대 중 `[1]`은 `opacity:0`(포인터는 계속 `[1]`이 받는다 — e2e 합성 포인터·cursor 계약 유지), 박스 z 2 > 디테일 1이라 textarea가 위에 남는다 |
| B. 백킹에 줌 곱하기 | 35 (a)가 이름으로 막는다. 캐시 키가 배율을 물어 휠 노치마다 전량 재렌더, 30 좌표 40여 곳 어긋남 |
| C. 뷰포트 렌더로 교체(백킹 폐기) | 같은 이유 + 캐시·히스토리·e2e 전제 전부 |
| D. `renderOutput` 캔버스를 그대로 표시(interaction 축 제안) | 4K 33MB 상시 + 비정수 배율 무아레. 기각 |

- 입력: `view`(줌·팬)·`pixelPreview: 0|1|2`(42 UI 스토어)·`devicePixelRatio`. 윈도 = 가시 oriented 사각형, 디바이스 배율 = `screenScale·dpr`(픽셀 미리보기 n이면 `n`으로 고정 — 정수 배율 픽셀).
- **상한 `MAX_DETAIL_PX = 8,000,000`(32MB)**: 뷰포트×dpr×배율이 넘으면 배율을 한 단계 강등(2x→1x→백킹)하고 상태바에 힌트. 맞춤 상태 4K 2x(133MB)를 막는 선.
- rAF 코얼레싱(기존 `schedule` 관례), 창 리사이즈·dpr 변경은 기존 stage `ResizeObserver`(`:381-390`) 재사용해 재할당.
- 픽셀 미리보기 `끄기`는 디테일 캔버스 자체를 내린다(`[2]` DOM 유지·`width=0` — 35의 `canvases()` 길이 계약: `[0][1]`만 백킹 크기 단언이라 `[2]` 추가는 무영향, `cs.length>=2` 조건 유지).

### 3.2 렌더 윈도 — `renderRegion`이 "클램프 사고"를 구조적으로 없앤다

```
renderRegion(scene, win: Rect, devScale, opts):
  reach = effectReach(root)                       // 38 — 그림자·블러·픽셀화 셀·배경 블러 반경 중 최대
  work  = expand(win, reach) ∩ imageBounds        // 작업 캔버스 = 윈도 ⊕ reach, 이미지 밖은 안 만든다
  renderScene(workCtx, scene, tOf(work, devScale), {...opts, window: work})
  blit(workCtx, win − work.origin)                // 윈도만 화면/타일로
```
배경 의존 효과의 `Math.max(0,…)` 클램프는 이제 **작업 캔버스 경계**에 걸리는데, 그 경계는 어떤 가시 픽셀에서도 `reach` 이상 떨어져 있거나 **이미지 경계**(가장자리 복제가 맞는 곳)뿐이다. `win == imageBounds`면 확장 없이 직접 그린다(프리뷰 백킹·1x 출력 = 종전 경로, 비트 동일).

이걸 가정이 아니라 **단언**으로 만든다 — e2e 35 (d-2) "윈도 불변": 두 윈도(서로 다른 팬 위치)의 겹침 픽셀 델타 0.

### 3.3 출력 타일링 — `renderOutput(scene, {crop, outW, outH, nodeIds, background, tileDevicePx})`

2048² 디바이스 px 타일 + `reach` 확장으로 작업 메모리 ≈17~20MB **상수**. 2x 출력 = 출력 캔버스 74MB + 20MB(종전 방식이면 +74MB), 3x = 166 + 20. `renderOutput`(`ImageEditor.tsx:660-691`)은 이 함수로 위임(39 §4 소비자 변경의 마지막 줄). `nodeIds`는 52 레이어별 파일, `trim`(잘라내기 여백)은 `visualBounds` 합집합으로 `crop` 대체.

`estimateRenderBytes(scene, target): {peak, output, work}` — 출력 캔버스 + 타일 + 인코더 리드백(`toBlob` 시 1×출력 사본, export 축 실측이 정본) 합. **내보내기·배율 게이트의 단일 출처**(52가 소비, ⑥ `예상 용량`의 분모).

### 3.4 샌드위치 캐시 3장

커밋 캐시 1장(`:219-258`) → `아래(라이브 선택 아래 커밋) / 라이브 / 위(라이브 위 커밋)` 3장 고정. 드래그 프레임 = 블릿 2 + 라이브 N. **위 캐시는 위쪽에 배경 의존 노드(모자이크·배경 블러·비표준 블렌드)가 없을 때만** 재사용(있으면 종전처럼 매 프레임 재렌더 — 정확성 우선). 더티 사각형·노드별 래스터 캐시·워커·OffscreenCanvas는 넣지 않는다(pro §8·INDEX §10.5 — 정상 프레임이 이미 블릿 1회, 폰트·Path2D·히트 스크래치가 메인 스레드 귀속).

### 3.5 메모리 원장 — 이 문서 §7 표 하나

상한(바이트, 개수 아님): `layerPool ≤ 2×백킹`(39) · fontkit LRU ≤ 24MB(50) · 디테일 8MP(§3.1) · 에셋 16MB/16MP(41) · 직선화 `|θ| > 15°`는 `constrainToImage` 강제(48 — 45° 극단 oriented +39MB) · 내보내기 게이트 = `estimateRenderBytes.peak`. **`health://level` warn 이상이면 2x 이상 내보내기 거부**(`on_health_level` 전이 시 플래그, 프론트 `useHealth` 값 확인 — 압박 감축 훅 §E와 같은 신호).

목표(4K 3840×2160, 창 1개, private bytes): 정상 ≤ 200MB · 확대 300% ≤ 230MB · 2x 저장 피크 ≤ 450MB(인코더 리드백 133MB 포함 — export 수치 정본, render 축의 278MB는 리드백 누락). 실측이 목표를 넘으면 상한 상수를 내리고 표를 갱신한다 — 상수 한 곳.

### 3.6 `occlusionIntegrity` → 저장 확인창

39의 `occlusionIntegrity(scene)` 경고(반투명 그룹 안 가림·`linear-burn` 투명 배경)를 평탄화·내보내기 확인창에 한 줄로 띄운다(41 확인 문구 뒤에 추가). 차단은 아니다.

### 3.7 만들지 않는 것

- 무한 캔버스·뷰포트 문화(캔버스 경계 = 이미지 경계 계약 유지), 노드별 캐시, 더티 사각형, 워커 렌더, WebGL, GPU 메모리 계측(WebView2 GPU 프로세스 텍스처는 private bytes 밖 — 실기 관찰 항목으로만), 조정 슬라이더 최적화(§7 실측 뒤 39 위험 1행 규칙 적용 여부 결정).

## 4. 계약 (소유: 40)

```ts
// render.ts (39 파일에 추가)
export function renderRegion(scene: Scene, win: Rect, devScale: number, opts: RenderOpts & { into?: CanvasRenderingContext2D }): CanvasRenderingContext2D;
export function renderOutput(scene: Scene, o: { crop: Rect | null; outW: number; outH: number; nodeIds?: readonly ObjId[] /* [] = 배경만(39 RenderOpts) */; background: RenderOpts['background']; tileDevicePx?: number /* 2048 */; trim?: boolean; image: CanvasImageSource; colorSpace?: 'srgb' | 'display-p3' /* 출력 캔버스 생성 인자만 — 타일 스크래치는 sRGB 고정(52 §3.4) */ }): HTMLCanvasElement;
export function estimateRenderBytes(scene: Scene, o: { outW: number; outH: number; format: ImgFormat }): { peak: number; output: number; work: number };
export const MAX_DETAIL_PX = 8_000_000;

// src/components/image/DetailCanvas.tsx
export interface DetailCanvasProps { scene: Scene; image: CanvasImageSource; view: View; fit: number; previewScale: number; pixelPreview: 0 | 1 | 2; stage: { w: number; h: number }; onDemote?(level: 0 | 1 | 2): void }
// z-index: 크롬(43) 3 > 박스(transform 래퍼) 2 > 디테일 1. 활성 시 씬 캔버스 [1] opacity 0 (포인터 대상 유지)

// AnnotationLayer 캐시
type SandwichCache = { below: HTMLCanvasElement; above: HTMLCanvasElement | null /* 위쪽에 배경 의존 노드 있으면 null */; key: string }
```

e2e 훅: `window.__gpv.imageEditor.renderRegion(win, devScale): ImageData` · `detail(): { active: boolean; level: 0|1|2; w: number; h: number }` · `estimate(outW, outH, fmt)`.
실측 스크립트: `scripts/verify-image-editor-4k.mjs`(CDP 29222 — `sys_process_snapshot`으로 편집기 창 프로세스 private bytes를 정상/300%/2x 저장 3시점에 채집, 부하 낮은 상태만 채택).

## 5. 단계

1. `renderRegion` + `estimateRenderBytes`(`render.ts` +≈120) — 윈도==이미지 경로가 종전과 비트 동일함을 30/34/35로 확인.
2. `DetailCanvas.tsx` 신규(≈140) + `ImageEditor` 마운트·`pixelPreview` 상태·`[1]` opacity 전환(+40). e2e 35 (d-1~d-6).
3. `renderOutput` 타일 루프(+60) + `ImageEditor.renderOutput` 위임(−25/+10). e2e 30 (w-1)(w-2): 1x 저장본 비트 동일(타일 경계 델타 0), 2x 저장본 픽셀 == 프리뷰×2 위치.
4. 샌드위치 캐시(`AnnotationLayer` +≈70). e2e 30 (s-2): 모자이크 위에서 드래그 중 프리뷰 == 커밋 후.
5. `scripts/verify-image-editor-4k.mjs`(≈120) + §7 표 채움 + `health` 게이트(프론트 +10).

규모 **M**: 프론트 ≈ +560/−30 · Rust 0 · 스크립트 ≈120.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| 확대 드래그 중 이중 렌더 | 백킹 라이브 + 디테일 윈도 | 백킹은 커밋 시에만, 드래그 중엔 디테일 윈도만 라이브 재렌더. 실측 프레임 시간 표에 기록 |
| 디테일 강등 UX | 큰 창·2x·고dpr에서 조용히 1x | 상태바 힌트 텍스트(42) + `detail().level` 훅 단언 |
| 윈도 불변이 깨지는 효과 | `reach` 계산이 어떤 효과를 빠뜨림 | `effectReach`(38)가 효과 종류 전부를 열거(exhaustive switch, default 없음) + (d-2) 겹침 델타 0 단언이 잡는다 |
| 인코더 리드백을 못 셈 | `toBlob`이 내부 사본을 만든다 | export 실측(133MB@2x)을 정본으로 `estimateRenderBytes`에 상수 포함, §7 표로 검증 |
| private bytes ≠ 체감 | GPU 텍스처는 별도 프로세스 | 스크립트가 GPU 프로세스 행도 함께 찍는다(관찰만, 상한 없음) |
| `health` 게이트 오탐 | warn이 편집기와 무관한 원인 | 거부가 아니라 확인창("메모리 압박 — 그래도 2x 내보내기") 1회 |

## 7. 검증

- **e2e 35 신규 (d)**: (d-1) `view.scale=4` → `detail().active && level>=1`, 디테일 캔버스 픽셀 == `readSaved`(원본 픽셀); (d-2) **윈도 불변**: 팬 두 위치에서 `renderRegion` 겹침 영역 ImageData 델타 0(모자이크·배경 블러·그림자 포함 픽스처); (d-3) `pixelPreview=2` 200px 픽스처 → 디테일 `w===400`·정수 배율; (d-4) 상한: 큰 뷰포트 합성(`stage` 훅) → `level` 강등; (d-5) 백킹 `[0][1]` 크기 불변(35 (a) 재확인); (d-6) 디테일 활성 중 포인터 합성 → 선택 동작(`[1]`이 받는다).
- **e2e 30 신규**: (w-1) 1x 저장본 == 타일 경계 델타 0(2048 경계를 걸치는 4K 픽스처는 무거워 200px 픽스처에 `tileDevicePx: 64`로 강제); (w-2) 2x 저장본 픽셀 위치 = 프리뷰×2; (s-2) 샌드위치 캐시 정확성.
- **프로브 실측(2026-09-07, dev 앱 WebView2 / Chrome 152.0.0.0 · Windows 11)**:
  `'beginLayer' in CanvasRenderingContext2D.prototype` = **false** → 39 §3.3 은 **P2(layerPool) 경로**로 확정.
  `globalCompositeOperation = 'linear-burn'` **거부**(값이 안 바뀜) → 39 §3.4 invert∘lighter∘invert 필요.
  표준 블렌드 17종 + `lighter` 전부 수용 · `createConicGradient` 있음(원뿔 그라디언트 직접 지원) ·
  분리(비부착) 캔버스에서 `ctx.filter` 동작. 나머지 행(메모리·프레임 시간)은 4K 실기에서 채운다.
- **실측표(이 절에 채운다)**: 4K PNG 열기 — 정상 / 300% 확대 / 2x 저장 피크 — private bytes·프레임 시간(조정 슬라이더 틱·드래그)·`HAS_LAYERS` 값·격리 깊이 3 풀 바이트. 목표 ≤200/≤230/≤450MB. 부하 낮은 상태 3회 중앙값.
- **회귀**: 30(91)·34(32)·35(13) 무변경 통과(윈도==이미지 경로 비트 동일).
