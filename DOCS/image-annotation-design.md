# 이미지 주석(마크업) 편집 — 기능 설계서

> 상태: 설계(Design) · 대상: gitpervisor (Tauri 2 + React 19 + TS) · 1차 플랫폼: **Windows (WebView2)**
> 산출물 성격: `/sc:design` — 구현 코드가 아니라 아키텍처·계약(타입/좌표계/렌더 파이프라인)·단계 계획. 시그니처 스케치는 포함, 본문 구현은 제외.
> 자매 설계서: `DOCS/api-client-design.md`(§번호·옵션비교표·리스크 레지스터 Rn·Phase 수용기준·DoD 체계 차용).
> 근거: 2026-08-05 코드베이스 실측. 인용된 파일:라인은 모두 직접 확인했다.

---

## 0. 요구사항

**"보고 있는 이미지 위에 Figma처럼 그림 그리고, 도형 넣고, 텍스트 넣는다."**

사용자 확정 결정 3건:

| 결정 | 선택 | 귀결 |
|---|---|---|
| 재편집 범위 | **세션 내 재편집 + 저장 시 평탄화(flatten)** | 벡터 사이드카 영속 없음 → 레포에 새 파일 0, git 변경목록 노이즈 0 |
| 배치 | **기존 `ImageEditor` 모달 확장 + 뷰어에 진입 버튼** | 신규 최상위 컴포넌트 0, 크롭·회전·색보정과 같은 저장 파이프라인 공유 |
| 추가 도구 | **모자이크/블러 · 형광펜 · 번호 뱃지 · 클립보드 복사** 전부 채택 | 도구 9종 + 저장 경로 1개 추가 |

---

## 1. 결론 — 3줄 요약

1. **좌표계는 `oriented px` 하나로 통일한다.** 회전/반전이 적용된 원본 해상도 공간. 프리뷰는 여기에 `scale(s)`, 출력은 `translate(-crop) ∘ scale(out/src)` 만 곱한다. 주석 데이터는 화면 배율·프리뷰 다운스케일과 무관하다.
2. **렌더러는 `renderScene()` 단 하나다.** 프리뷰와 저장이 같은 함수를 호출하고 변환 행렬만 다르다 → WYSIWYG가 구조적으로 보장된다(두 렌더러 드리프트 원천 차단).
3. **캔버스를 2장으로 쪼갠다.** 색보정 CSS 필터가 주석까지 물들이는 것을 막고(§4.3), 커밋된 객체 캐시로 드래그 중 재페인트 비용을 상수화한다.

---

## 2. 현황 실측 — 재사용할 것과 고쳐야 할 것

### 2.1 이미 있는 것 (재사용)

| 자산 | 위치 | 역할 |
|---|---|---|
| `ImageEditor` 모달 | `src/components/image/ImageEditor.tsx` | 회전·반전·크롭·리사이즈·색보정·포맷·저장. **여기에 주석 팔레트를 얹는다** |
| `buildOriented()` | `ImageEditor.tsx:43-67` | 회전+반전 적용 원본 해상도 캔버스 — 주석 좌표계의 기준면 |
| `renderOutput()` | `ImageEditor.tsx:271-292` | 크롭→리사이즈→필터 출력 캔버스. 주석 합성 지점 |
| `encodeCanvas()` | `src/lib/image-codec.ts:70` | png/jpeg/webp 네이티브, avif wasm 폴백 |
| `useSaveImage()` | `src/queries/index.ts:841-853` | base64 → `write_file_bytes`, 트리·status·diff·`file-image` 캐시 무효화 |
| `write_file_bytes` | `src-tauri/src/commands/tree.rs:132-169` | `resolve_in_repo` 컨테인먼트 + 심볼릭/디렉토리 거부 + 64MB 상한 |
| `selectBlockingOverlay` | `src/stores/ui.ts:192-199` | `imageEditorPath` 이미 포함 → 네이티브 자식 webview 점유 처리 완료 |
| `__gpv` dev 노출 | `src/main.tsx:43-47` | E2E가 상태를 직접 구동하는 관례 |

**백엔드 변경 0.** 신규 Rust 커맨드 없음, 신규 FS 표면 없음 — 주석은 전부 프론트 캔버스 작업이고 저장은 기존 `write_file_bytes` 한 경로로만 나간다.

### 2.2 지금 깨져 있는 것 (이번에 고친다)

| # | 결함 | 근거 | 영향 |
|---|---|---|---|
| **D1** | **임베디드 저장소 이미지가 엉뚱한 레포로 라우팅된다** | `openImageEditor(path)`는 경로만 받고(`ui.ts:384`) 에디터는 `selectedProjectId`를 쓴다(`ImageEditor.tsx:72`). 그런데 뷰어는 `diffRepoId ?? projectId`로 라우팅한다(`ViewerTab.tsx:31`) | 중첩 repo(`<outerId>::<rel>`) 안 이미지를 편집·저장하면 **바깥 레포 기준 상대경로로 써서 다른 파일을 만들거나 덮어쓴다** |
| **D2** | `ctx.filter`가 초기화되지 않는다 | `renderOutput()`이 `ctx.filter = filterStr`를 설정한 뒤(`:289`) 복구하지 않음 | 현재는 그 뒤에 그리는 게 없어 무해. **주석을 그리는 순간 밝기·대비·채도가 마크업까지 먹는다** — 반드시 선행 수정 |
| **D3** | 비-라운드트립 포맷이 조용히 변환된다 | `isImage()`는 svg/gif/bmp/ico를 포함(`language-map.ts:78-83`)하지만 `FORMATS`는 png/jpeg/webp/avif뿐(`image-codec.ts:10-15`) | `.svg` 열면 `formatOfPath`가 null → png 기본값 → "저장"이 **인접 `.png`를 만든다**(벡터 무음 래스터화). gif는 첫 프레임만 |
| **D4** | Esc가 무조건 모달을 닫는다 | `ImageEditor.tsx:365-372` — prompt/confirm만 예외 | 도구 사용 중 Esc가 **작업물째 날린다**. 계층형 Esc 필요(§5.4) |

D1·D2는 **M1 필수**(정확성), D3·D4는 M1 UX 필수.

---

## 3. 좌표계 — 이 기능의 심장

버그가 사는 곳은 전부 여기다. 공간을 4개로 명명하고 변환을 단방향으로 고정한다.

```
natural px      원본 이미지 픽셀 (img.naturalWidth × naturalHeight)
   │ buildOriented(rotation, flipH, flipV)          ← 기존 :43
   ▼
oriented px     ★ 주석의 정본 좌표계 ★                 크기: oriented.width × height
   │ ├─ 프리뷰: scale(s),  s = min(1, 1800 / max(w,h))   ← MAX_PREVIEW :38
   │ │            ▼ preview px  (백킹 스토어)
   │ │            │ CSS object-fit
   │ │            ▼ css px      (포인터 이벤트가 오는 곳)
   │ └─ 출력:   translate(-crop.x, -crop.y) → scale(outW/sw, outH/sh)
   │              ▼ output px
   ▼
encode → bytes → write_file_bytes
```

### 3.1 왜 `oriented px`인가 (옵션 비교)

| 정본 공간 | 회전/반전 시 | 크롭 시 | 히트테스트 | 판정 |
|---|---|---|---|---|
| natural px (회전 전) | 데이터 불변(장점) | 소스 사각형 | **매 이벤트마다 역회전 행렬** | 텍스트가 반전 시 거울로 뒤집힘, 코드 복잡 |
| **oriented px** | 델타 아핀 1회 적용 | **소스 사각형 — 자동 클리핑** | `p / s` 나눗셈 하나 | **✅ 채택** |
| output px (크롭·리사이즈 후) | — | 크롭 바꿀 때마다 주석이 붕 뜸 | 단순 | ❌ 크롭이 주석을 배신 |
| 정규화 0~1 | 비율 왜곡 시 선 두께 이방성 | — | — | ❌ 선 두께·폰트 크기 정의 불가 |

`oriented px` 채택의 결정적 이점 3가지:

- **크롭이 공짜다.** 출력은 `drawImage(base, sx,sy,sw,sh, 0,0,outW,outH)`이므로 주석에 같은 `translate ∘ scale`만 걸면 크롭 밖 주석은 **캔버스 경계에서 자동으로 잘린다**. 클리핑 코드 0줄.
- **리사이즈가 공짜다.** 같은 `scale`이 선 두께·폰트 크기에 함께 걸려 상대적 크기가 보존된다.
- **히트테스트가 나눗셈 하나다.** 기존 `eventToOriented()`(`ImageEditor.tsx:184-192`)가 이미 css px → oriented px 환산을 하고 있다. **그대로 재사용한다.**

### 3.2 회전·반전 — 유일하게 데이터를 변형하는 연산

`oriented` 공간의 크기 자체가 바뀌므로 주석 기하를 델타 아핀으로 옮긴다. 이전 크기 `(W,H)` 기준:

| 연산 | 점 변환 | 신규 크기 | 객체 `rot` |
|---|---|---|---|
| +90° (CW) | `(x,y) → (H − y, x)` | `(H,W)` | `+90` |
| −90° (CCW) | `(x,y) → (y, W − x)` | `(H,W)` | `−90` |
| flipH | `(x,y) → (W − x, y)` | `(W,H)` | `−rot` |
| flipV | `(x,y) → (x, H − y)` | `(W,H)` | `−rot` |

**규칙 R-ROT (명시적 결정)**

- **회전 시 텍스트·뱃지는 이미지와 함께 돈다**(`rot += 90`). 주석은 "그림의 일부"이므로 내용에 붙어 있는 것이 WYSIWYG다. macOS 미리보기·Snagit 동일. 세로 사진을 가로로 돌리면 라벨도 눕는다 — **의도된 동작**.
- **반전 시 글자는 거울로 뒤집지 않는다.** 앵커 위치만 미러링하고 `rot → −rot`으로 가독성을 유지한다. 뒤집힌 글자를 원하는 사용자는 없다.
- 사각형·타원은 90° 배수 회전·반전에서 **축 정렬이 보존**되므로 `rot`은 0으로 남고 `x,y,w,h`만 재계산한다.
- 회전/반전은 **히스토리 스냅샷을 남긴다**(§5.3). 안 그러면 undo가 주석을 이전 공간으로 되돌려 어긋난다.

> 기존 코드는 `oriented`가 바뀌면 크롭과 출력 크기를 초기화한다(`ImageEditor.tsx:136-142`). 이 효과에 **주석 델타 변환을 함께 태운다** — 순서 보장이 되고 분기가 한 곳에 모인다.

---

## 4. 렌더 파이프라인

### 4.1 단일 렌더러 계약

```ts
// src/lib/annotate/render.ts
export interface SceneTransform {
  /** oriented px → 대상 캔버스 px. crop 원점 이동 + 배율. */
  tx: number; ty: number; sx: number; sy: number;
}

/**
 * 대상 ctx에 주석 객체를 그린다. 이미지는 호출부가 이미 그려 둔 상태여야 한다
 * (모자이크가 그 픽셀을 샘플링하기 때문).
 * ctx.filter 는 반드시 "none" 이어야 한다 — 색보정은 이미지에만 적용된다.
 */
export function renderScene(
  ctx: CanvasRenderingContext2D,
  objects: readonly AnnoObject[],
  t: SceneTransform,
  opts?: { skipId?: ObjId },   // 텍스트 편집 중인 객체는 textarea가 대신 보여준다
): void;
```

| 호출부 | `t` | ctx 상태 |
|---|---|---|
| 프리뷰 오버레이 캔버스 | `{tx:0, ty:0, sx:s, sy:s}` | filter none (별도 캔버스라 CSS 필터 밖) |
| `renderOutput()` | `{tx:−crop.x, ty:−crop.y, sx:outW/sw, sy:outH/sh}` | **`ctx.filter = "none"` 복구 후** (D2) |
| 클립보드 복사 | `renderOutput()` 재사용 | 동일 |

호출부가 둘뿐이고 둘 다 같은 함수를 부른다. **"프리뷰와 저장 결과가 다르다"는 클래스의 버그가 구조적으로 불가능해진다.**

### 4.2 출력 합성 순서

```
out = canvas(outW × outH)
 ① jpeg면 흰 배경 채움                      (기존 :285-288 유지)
 ② ctx.filter = filterStr
    drawImage(oriented, sx,sy,sw,sh → 0,0,outW,outH)
 ③ ctx.filter = "none"                      ← D2 수정
 ④ renderScene(ctx, objects, t)             ← 신규
 ⑤ encodeCanvas(out, format, quality)
```

색보정은 ②에만, 주석은 ④에만. **밝기를 낮춰도 빨간 화살표는 빨간 화살표로 남는다** — 이게 옳은 동작이다.

### 4.3 프리뷰 — 캔버스 2장 스택

현재 프리뷰는 캔버스 1장에 CSS `filter`를 걸어 슬라이더마다 재래스터를 피한다(`ImageEditor.tsx:410`). 주석을 같은 캔버스에 그리면 **필터가 마크업까지 먹는다**. 따라서:

```
<div class="relative">                          ← 두 캔버스의 공통 배치 컨테이너
  <canvas baseRef   style="filter: brightness()..." />   ← 이미지. oriented/crop 변경 시만 재그림
  <canvas annoRef   class="absolute inset-0" />          ← 주석 + 크롭 오버레이 + 드래프트. 필터 없음
  <textarea? />                                          ← 텍스트 입력 중에만 (§5.5)
</div>
```

포인터 이벤트는 **위쪽 `annoRef`가 받는다**(기존 핸들러 이관). 두 캔버스는 백킹 스토어 크기·CSS 크기가 항상 동일해야 하므로 크기 계산을 한 곳(`paint()` 확장)에 둔다.

### 4.4 드래그 중 성능 — 커밋 레이어 캐시

펜 드래그는 포인터 이벤트가 초당 100회 이상 온다. 매번 전체 객체를 다시 그리면 객체가 쌓일수록 느려진다.

```
committedRef : OffscreenCanvas-like  (문서 변경 시에만 renderScene 전체 실행)
annoRef 매 프레임 = drawImage(committedRef) + 드래프트 1개 + 선택 핸들
```

- 재페인트는 **rAF 코얼레싱**(프레임당 1회, 이미 예약됐으면 스킵).
- 펜 점 데시메이션: 직전 점과 **1.5 oriented px 미만이면 버린다**. 스냅샷 메모리와 렌더 비용을 동시에 잡는다.
- 렌더는 midpoint 이차 베지어로 부드럽게(점 배열 그대로 폴리라인으로 그리면 각져 보인다).

결과: 커밋된 객체 수와 무관하게 드래그 프레임 비용이 상수. 프리뷰 상한 1800px(`:38`)는 그대로 유효하다.

---

## 5. 데이터 모델과 상호작용

### 5.1 객체 모델 (`src/lib/annotate/types.ts`)

```ts
export type ObjId = string;                      // crypto.randomUUID()
export type Tool =
  | "select" | "pen" | "highlight" | "line" | "arrow"
  | "rect" | "ellipse" | "text" | "badge" | "mosaic";

interface Common {
  id: ObjId;
  stroke: string;        // #rrggbb
  strokeWidth: number;   // oriented px
  opacity: number;       // 0–1
  rot: number;           // deg, 앵커/중심 기준. v1은 회전 델타로만 생김(핸들 없음)
}

export type AnnoObject =
  | Common & { kind: "pen" | "highlight"; pts: number[] }         // flat [x0,y0,x1,y1,…]
  | Common & { kind: "line" | "arrow"; x1,y1,x2,y2: number; head: "end" | "both" }
  | Common & { kind: "rect"; x,y,w,h: number; fill: string | null; radius: number }
  | Common & { kind: "ellipse"; x,y,w,h: number; fill: string | null }
  | Common & { kind: "text"; x,y: number; text: string; fontSize: number; fontFamily: string }
  | Common & { kind: "badge"; x,y: number; n: number; fontSize: number; fill: string }
  | Common & { kind: "mosaic"; x,y,w,h: number; mode: "pixelate" | "blur"; strength: number };

/** 히스토리에 스냅샷되는 편집 문서 전체 */
export interface EditorDoc {
  objects: AnnoObject[];
  rotation: number; flipH: boolean; flipV: boolean;
  crop: Rect | null; outW: number; outH: number;
  brightness: number; contrast: number; saturate: number;
}
```

- `pts`를 **평탄 number 배열**로 두는 이유: 스냅샷 복사가 얕은 참조 공유로 끝나고(§5.3), 델타 아핀 적용이 루프 하나다.
- 객체는 **불변**으로 갱신한다(변경된 객체만 새 참조). 스냅샷 50장이 실제로 복제하는 것은 변경분뿐이다.
- `rot`은 v1에서 **회전 델타로만** 생긴다. 회전 핸들 UI는 v2 — 데이터·렌더는 미리 지원하므로 추가는 순증(YAGNI 준수).

### 5.2 도구 9종

| 도구 | 키 | 생성 | 속성 |
|---|---|---|---|
| 선택 | `V` | — | — |
| 펜 | `P` | drag → `pts` | 색·두께 |
| 형광펜 | `H` | drag → `pts` | 색·두께 · **`opacity 0.35` + `lineCap:"butt"` + `globalCompositeOperation:"multiply"`** |
| 직선 | `L` | drag | 색·두께 (Shift = 15° 스냅) |
| 화살표 | `A` | drag | 색·두께 · 머리 크기 = `4 × strokeWidth` |
| 사각형 | `R` | drag | 선·채움·모서리 반경 (Shift = 정사각) |
| 타원 | `O` | drag | 선·채움 (Shift = 정원) |
| 텍스트 | `T` | click → textarea | 색·크기 |
| 번호 뱃지 | `N` | click, `n` 자동 증가 | 색·크기 · 원 반지름 = `0.9 × fontSize` |
| 모자이크/블러 | `M` | drag | 모드·강도 |

**형광펜**이 `multiply` 블렌드인 이유: 알파만 낮추면 겹치는 획마다 진해져 실제 형광펜과 다르게 보인다. `multiply`는 흰 배경 위 텍스트를 가리지 않고 색만 입힌다.

**모자이크/블러 구현** — `renderScene`은 이미지가 그려진 뒤에 호출되므로 대상 ctx 자신에서 샘플링한다:

```
pixelate: 영역 → 스크래치 캔버스(w/cell × h/cell) → imageSmoothingEnabled=false 로 되그림
blur:     ctx.filter = `blur(${strength}px)` 로 영역을 자기 자신에 되그림 → filter 복구
```

`getImageData` 불필요(taint 걱정 없음 — data: URL 이미지는 동일 출처라 어차피 오염되지 않는다). **프리뷰와 출력의 배율이 달라도 `cell`/`strength`에 `sx`를 곱하므로 시각적 결과가 일치한다.**

### 5.3 히스토리

- 스택 = `EditorDoc` 스냅샷 배열, 상한 **50**, 초과 시 앞에서 버림.
- **커밋 시점에만 push**: pointerup, 텍스트 확정, 삭제, z-order 변경, 복제, 회전/반전, 크롭 확정, 슬라이더 `onPointerUp`(드래그 중 매 틱 아님).
- `Ctrl+Z` undo / `Ctrl+Shift+Z`·`Ctrl+Y` redo. 새 커밋은 redo 스택을 버린다.
- **문서 전체를 스냅샷하는 이유**: 회전이 주석 기하를 변형하므로(§3.2) 주석만 되돌리면 공간이 어긋난다. 전체 스냅샷은 크기가 무시할 만하고(이미지 픽셀은 문서에 없다) 이 클래스의 버그를 통째로 없앤다.

### 5.4 Esc 계층 (D4 수정)

기존 `ImageEditor.tsx:365-372`을 다음 순서로 교체한다. **첫 번째로 참인 항목만 실행하고 멈춘다**:

1. `prompt`/`confirm`이 위에 있으면 → 아무것도 안 함(그쪽이 처리)
2. 텍스트 편집 중 → 편집 확정
3. 드래그 중인 드래프트가 있으면 → 드래프트 취소
4. `tool !== "select"` → `select`로 복귀
5. 선택이 있으면 → 선택 해제
6. 크롭 모드면 → 크롭 모드 해제
7. **주석이 하나라도 있고 저장하지 않았으면** → "닫으면 주석이 사라집니다" 확인 후 닫기
8. 그 외 → 즉시 닫기

7번이 평탄화 모델의 안전장치다. 세션을 닫으면 벡터가 사라지므로(사용자 결정), 실수로 닫아 작업을 잃는 경로를 막는다. 창 X 버튼·배경 클릭도 같은 판정을 거친다.

### 5.5 텍스트 입력 — DOM textarea 오버레이

캔버스는 IME를 받을 수 없다. **한글 입력이 되려면 실제 focus 가능한 DOM 요소가 필요하다.**

- 텍스트 도구로 클릭 → 그 위치에 투명 배경 `<textarea>`를 절대배치, 즉시 focus.
- 편집 중인 객체는 `renderScene(..., {skipId})`로 캔버스에서 **뺀다** — textarea가 대신 보여준다(이중 표시 방지).
- 확정: blur · `Ctrl+Enter` · `Esc`. 내용이 비면 객체를 삭제한다.
- **폰트 일치 계약**: textarea의 CSS와 캔버스 `ctx.font`가 **같은 family 문자열**을 쓴다. 앱 기본 스택 재사용. 미세한 메트릭 차는 편집 중에만 보이고 확정 후에는 캔버스가 정본이다.
- 편집 중에는 전역 단축키·모달 Esc가 키를 가로채면 안 된다 → textarea focus 상태를 상위 키 핸들러의 가드 조건에 넣는다.

### 5.6 선택·조작

- 히트테스트는 **렌더와 같은 `Path2D` 빌더**를 쓴다(기하 정의 단일 소스). `ctx.setTransform(객체 로컬→oriented)` 후 `isPointInPath` / `isPointInStroke` — CTM을 존중하므로 `rot`이 공짜로 처리된다.
- 스트로크 허용오차: 히트테스트용 `lineWidth = max(strokeWidth, 10 / s)` — 얇은 선도 손가락으로 집을 수 있게.
- **위에서부터(마지막 그린 것부터)** 순회, 첫 히트 채택.
- v1 조작: 클릭 선택 · `Shift+클릭` 추가 선택 · 드래그 이동 · **8핸들 리사이즈**(Shift = 비율 고정) · `Delete`/`Backspace` 삭제 · `Ctrl+D` 복제(+8,+8) · `[` `]` z-order.
- 마퀴(고무줄) 다중 선택, 회전 핸들, 정렬·분배 → **v2**(YAGNI).
- 선택 핸들·바운딩 박스는 `annoRef`에 **매 프레임 마지막에** 그린다. 출력 경로(`renderScene`)에는 없다 — 화면 크롬은 절대 파일에 들어가지 않는다.

---

## 6. 저장 — 평탄화와 비가역성

### 6.1 저장 동작

기존 두 버튼(`저장` / `다른 이름으로`)을 유지하되 주석이 있을 때만 계약을 강화한다.

| 상황 | `저장` | `다른 이름으로` 기본값 |
|---|---|---|
| 주석 0개 (기존 동작) | 원본 in-place 덮어쓰기(포맷 동일 시) | `<stem>.<ext>` |
| **주석 ≥1개** | **`askConfirm` 경유** — "주석이 이미지에 합쳐져 원본을 덮어씁니다. 벡터 편집 정보는 남지 않습니다." (danger) | **`<stem>-annotated.<ext>`** |

평탄화 모델에서 원본 덮어쓰기는 **되돌릴 수 없는 데이터 손실**이다(원본 픽셀도, 벡터 문서도 사라진다). 기존 크롭·회전과 달리 확인을 요구하는 근거가 여기 있다. 다른 이름 기본값을 `-annotated`로 두어 **안전한 쪽이 기본 경로**가 되게 한다.

### 6.2 클립보드 복사

푸터에 `복사` 버튼 추가. `renderOutput()` → `encodeCanvas(out, "png")` → `writeImage(bytes)`.

- API 확인 완료: `@tauri-apps/plugin-clipboard-manager@2.3.2`가 `writeImage(image: string | Image | Uint8Array | ArrayBuffer | number[])`를 노출한다(`dist-js/index.d.ts:52`).
- **권한 추가 필요**: `src-tauri/capabilities/default.json`에 현재 `clipboard-manager:allow-write-text`·`allow-read-text`만 있다(`:16-17`). **`clipboard-manager:allow-write-image`를 추가해야 한다.**
- 항상 PNG로 인코딩한다(투명 보존 + 플러그인이 PNG를 디코드해 OS 클립보드에 넣는다). 사용자가 고른 출력 포맷은 파일 저장에만 적용된다.
- 메모리 [[tauri-cdp-ui-verification]]: **클립보드는 CDP로 검증 불가** → 수동 검증 항목으로 분류(§9).

### 6.3 비-라운드트립 포맷 경고 (D3)

헤더 경로 옆에 경고 칩을 띄운다. 조용한 변환을 막는 것이 목적이다.

| 원본 | 칩 문구 |
|---|---|
| `.svg` | `SVG → PNG 래스터화되어 저장됩니다` |
| `.gif` | `첫 프레임만 편집·저장됩니다` |
| `.bmp` `.ico` | `PNG로 저장됩니다` |

SVG는 내재 크기가 없으면 Chromium이 300×150으로 디코드한다 — 칩과 함께 실제 디코드 크기를 그대로 노출해 사용자가 알아차리게 한다(별도 보정 없음, v1 범위 밖).

---

## 7. 진입점 — "보고 있는 이미지"

### 7.1 뷰어에서 바로 편집

`ImageView`는 이미 상단 8px 툴바에 `실제 크기` 토글을 갖고 있다(`ImageView.tsx:35-42`). 여기에 `편집` 버튼을 추가한다.

```
ImageView 툴바:  [ 편집 ]  [ 실제 크기 / 화면 맞춤 ]
                    └→ openImageEditor(path, projectId)
```

`DiffViewer`는 이미지 여부를 알고(`isImageView`, `DiffViewer.tsx:144`) `ImageView`에 `projectId`를 넘긴다(`:571-572`). **그 `projectId`가 정답**이다 — 임베디드 저장소면 합성 id가 이미 들어와 있다.

### 7.2 D1 수정 — `openImageEditor`에 repoId를 싣는다

```ts
// stores/ui.ts
imageEditorPath: string | null;
imageEditorRepoId: string | null;                       // ← 신규
openImageEditor: (path: string, repoId?: string) => void;
```

- `ImageEditor`는 `imageEditorRepoId ?? selectedProjectId`를 쓴다.
- 호출부 2곳: `ImageView`(신규, `projectId` 전달) · `FileTreePanel.tsx:878`(자신의 `projectId` 전달).
- `selectProject`가 `imageEditorPath`를 null로 만드는 곳(`ui.ts:257`)에서 **`imageEditorRepoId`도 함께 null로** — 안 하면 다음 편집이 스테일 repoId를 물고 간다.
- `closeImageEditor`도 동일.

이 수정이 없으면 중첩 저장소 이미지를 편집할 때 **바깥 레포 루트 기준으로 파일을 쓴다.** `write_file_bytes`의 `resolve_in_repo`는 "레포 밖 탈출"만 막고 "잘못된 레포 안의 잘못된 경로"는 막지 못한다 — 백엔드가 잡아줄 수 없는 종류의 결함이다.

### 7.3 기존 진입점

파일 트리 컨텍스트 메뉴 `이미지 편집`(`FileTreePanel.tsx:874-881`)은 라벨·동작 그대로 유지한다.

---

## 8. 파일 구성과 규모

| 파일 | 신규/수정 | 대략 LOC | 내용 |
|---|---|---|---|
| `src/lib/annotate/types.ts` | 신규 | ~90 | 객체 모델·도구·기본 속성값 |
| `src/lib/annotate/geometry.ts` | 신규 | ~170 | Path2D 빌더, bbox, 히트테스트, 회전/반전 델타 아핀, 변환 헬퍼 |
| `src/lib/annotate/render.ts` | 신규 | ~190 | `renderScene`, 화살촉, 모자이크/블러, 텍스트 레이아웃, 형광펜 블렌드 |
| `src/lib/annotate/history.ts` | 신규 | ~50 | 스냅샷 스택(상한 50) |
| `src/components/image/AnnotationLayer.tsx` | 신규 | ~270 | 오버레이 캔버스, 포인터 상호작용, 핸들, textarea 오버레이, rAF·커밋 캐시 |
| `src/components/image/AnnotationToolbar.tsx` | 신규 | ~150 | 도구 팔레트 + 속성 패널(색·두께·채움·폰트·강도) |
| `src/components/image/ImageEditor.tsx` | 수정 | ~130 변경 | 캔버스 2장 분리, `renderOutput` ④단계, D2·D4 수정, 저장 확인, 복사 버튼, 포맷 경고 칩 |
| `src/components/diff/ImageView.tsx` | 수정 | ~15 | `편집` 버튼 |
| `src/stores/ui.ts` | 수정 | ~10 | `imageEditorRepoId` (D1) |
| `src-tauri/capabilities/default.json` | 수정 | 1 | `clipboard-manager:allow-write-image` |
| `tests/e2e/suites/30-image-annotate.mjs` | 신규 | ~210 | §9 |

**합계 약 1,290 LOC · 규모 L · 백엔드 Rust 변경 0줄.**

`ImageEditor`는 이미 679줄이다. 주석 로직을 그 안에 인라인하면 1,300줄이 넘어간다 — 그래서 상호작용을 `AnnotationLayer`로, 순수 로직을 `lib/annotate/*`로 분리한다. **순수 함수 분리는 E2E 가치도 있다**: 기하·렌더 계약을 DOM 없이 단언할 수 있다.

---

## 9. 단계 계획과 수용 기준

### M1 — 주석 코어 (셋 중 유일한 필수. 이것만으로 출시 가능)

범위: types/geometry/render/history · 펜·직선·화살표·사각형·타원·텍스트 · 선택/이동/삭제/undo·redo · 평탄화 저장(+비가역 확인) · **기하 정합**(회전·반전 델타 변환, 크롭 자동 클리핑, 리사이즈 스케일) · Esc 계층 · 뷰어 진입 버튼 · **D1·D2 수정**.

수용 기준:
- [ ] 프리뷰에서 그린 것과 저장된 파일이 **픽셀 좌표 기준 일치**(E2E 픽셀 단언, §9.4)
- [ ] 밝기 50%로 낮춰도 빨간 사각형의 저장 결과 RGB가 변하지 않는다 (D2)
- [ ] 주석을 그린 뒤 90° 회전 → 주석이 이미지 내용에 붙어 함께 돈다. undo → 정확히 복원
- [ ] 주석을 그린 뒤 크롭 → 크롭 밖 주석이 출력에서 사라진다(선이 잘린다)
- [ ] 리사이즈 50% → 선 두께·폰트가 함께 절반
- [ ] 임베디드 저장소(`<outer>::<rel>`) 이미지 편집·저장이 **그 저장소 안**에 쓴다 (D1)
- [ ] 텍스트 도구로 **한글 입력**이 정상 확정된다(IME)
- [ ] Esc 7계층이 순서대로 동작, 주석 있는 채로 닫으면 확인 다이얼로그

### M2 — 도구 확장

범위: 형광펜 · 번호 뱃지 · 모자이크/블러 · 8핸들 리사이즈 · z-order · 복제 · 클립보드 복사(+capability).

수용 기준:
- [ ] 모자이크 영역의 저장 결과가 **프리뷰와 동일한 셀 크기**로 보인다(배율 보정 검증)
- [ ] 형광펜 획을 겹쳐 그어도 겹친 부분이 검게 뭉치지 않는다
- [ ] 번호 뱃지가 클릭 순서대로 1,2,3… 증가하고 삭제 후 새로 찍으면 이어서 증가
- [ ] `복사` 후 외부 앱(메모장/이슈 편집기)에 이미지가 붙는다 — **수동 검증**(CDP 불가)
- [ ] 리사이즈 핸들 8방향 + Shift 비율 고정

### M3 — 마감·검증

범위: 커밋 레이어 캐시 · rAF 코얼레싱 · 점 데시메이션 · 비-라운드트립 포맷 경고(D3) · 키맵 정리 · E2E 30 · 실앱 CDP 검증.

수용 기준:
- [ ] 객체 200개 상태에서 펜 드래그가 60fps 근처를 유지(커밋 캐시 효과 실측)
- [ ] 4000×3000 이미지에서 펜 스트로크 1회 점 개수가 데시메이션으로 상한 내
- [ ] `.svg` 열면 경고 칩 표시, 저장이 인접 `.png`를 만든다는 사실이 사용자에게 보인다
- [ ] `tests/e2e/suites/30-image-annotate.mjs` 통과 + 기존 스위트 회귀 0

### 9.4 E2E 전략 — 픽셀 단언

기존 `tests/e2e`(CDP로 커맨드 직접 구동, 격리 픽스처, 상태 복원) 관례를 따른다. 스크린샷 비교는 취약하므로 **결정적 픽셀 단언**을 쓴다:

```
① 픽스처 레포에 알려진 단색 PNG 생성 (예: 200×200 흰색)
② __gpv 로 편집기를 열고 도구/속성/객체를 직접 주입 (DEV 전용 노출 — main.tsx:43 관례)
③ 프리뷰 annoCanvas 에서 특정 좌표 픽셀 샘플 → 기대색 단언
④ 저장 실행 → readFileBase64 로 다시 읽어 <img> 디코드 → 같은 좌표 픽셀 단언
⑤ ③과 ④가 같은 색 ⇒ WYSIWYG 계약 통과
```

- 노출 훅: `window.__gpv.imageEditor = { getDoc, setDoc, setTool, renderOnce }` — `import.meta.env.DEV` 가드. `__gpvLsp`·`__gpvPyOutline` 전례와 동일.
- 회전·크롭·리사이즈 각각에 대해 **좌표 변환 단언**을 별도 케이스로 둔다(§3이 이 기능의 버그 밀집 지역이므로).
- 클립보드는 CDP로 검증 불가 → 수동 체크리스트로 분리.

---

## 10. 리스크 레지스터

| # | 리스크 | 확률·영향 | 완화 |
|---|---|---|---|
| **R1** | 프리뷰↔출력 좌표 불일치(가장 흔한 실패 모드) | 중·**높음** | 단일 `renderScene` + 변환만 주입(§4.1). E2E 픽셀 단언으로 계약 고정(§9.4) |
| **R2** | 색보정 필터가 주석을 물들임 (D2) | **높음**(현재 코드 그대로면 확정 발생)·중 | `ctx.filter="none"` 복구를 파이프라인 ③단계로 명문화 + 수용 기준 단언 |
| **R3** | 임베디드 저장소 오라우팅 (D1) — 엉뚱한 파일 덮어쓰기 | 중·**높음**(데이터 손실) | `imageEditorRepoId` 도입(§7.2). 백엔드는 이걸 못 잡는다 |
| **R4** | 평탄화 저장으로 원본 소실 | 중·**높음** | 주석 있을 때 in-place 저장에 `askConfirm`, `다른 이름` 기본값을 `-annotated`로(§6.1), Esc 7계층 경고(§5.4) |
| **R5** | 한글 IME 미동작 | 중·중 | 캔버스 직접 입력 금지, DOM textarea 필수(§5.5). 앱은 이미 `GTK_IM_MODULE` 보정을 갖고 있다(CLAUDE.md) |
| **R6** | 거대 이미지 + 다수 객체에서 드래그 끊김 | 중·중 | 커밋 레이어 캐시 + rAF 코얼레싱 + 점 데시메이션(§4.4). 프리뷰 상한 1800px 유지 |
| **R7** | 회전 후 undo가 주석을 어긋난 공간으로 복원 | 중·중 | 문서 전체 스냅샷(§5.3). 주석만 스냅샷하면 확정 발생 |
| **R8** | `writeImage` 권한 누락으로 복사 실패 | 중·낮음 | capability 추가를 M2 체크리스트 항목으로 고정(§6.2). 실패 시 에러 토스트 |
| **R9** | SVG/GIF 무음 변환 (D3) | 중·중 | 경고 칩(§6.3). v1은 변환을 막지 않고 **알린다** |
| **R10** | `ImageEditor`가 1,300줄로 비대해짐 | 높음·낮음 | 상호작용/순수로직 분리(§8). 순수 함수는 DOM 없이 검증 가능 |
| **R11** | 텍스트가 캔버스와 textarea에 이중 표시 | 중·낮음 | `renderScene(..., {skipId})` 계약(§4.1) |

---

## 11. 명시적 비범위 (v2 이후)

| 항목 | 이유 |
|---|---|
| 벡터 문서 영속(재편집) | 사용자 결정 — 평탄화 채택. 필요해지면 앱 데이터 폴더 + 파일 해시 키로 추가(레포 오염 0 유지가 조건) |
| 레이어 패널·그룹·컴포넌트 | Figma의 문서 모델. 스크린샷 마크업 용도에 과함(YAGNI) |
| 회전 핸들·마퀴 선택·정렬/분배 | `rot`은 모델·렌더에 이미 있어 순증 추가 가능 |
| 곡선 화살표·말풍선·스탬프·아이콘 | 도구 9종으로 요구를 덮는다. 추가는 `kind` 한 줄 + 빌더 하나 |
| 잘라내기/붙여넣기로 외부 이미지 삽입 | 이미지 합성은 별개 기능 |
| SVG를 벡터로 유지한 채 편집 | 캔버스 래스터 파이프라인과 근본적으로 다른 아키텍처 |
| 애니메이션 GIF 편집 | 캔버스는 첫 프레임만 디코드(기존 제약과 동일) |

---

## 12. 열린 질문 (미응답 시 기본값으로 진행)

| 질문 | 설계 기본값 |
|---|---|
| 90° 회전 시 텍스트도 함께 눕는 것(R-ROT)에 동의하는가 | **함께 눕는다** — 주석은 그림의 일부, macOS 미리보기 동일 |
| 주석 있는 상태의 `저장`이 확인을 요구하는 것이 번거롭지 않은가 | **확인 요구** — 평탄화는 비가역 |
| 기본 색상 | 강조용 빨강 `#FF3B30`. 팔레트 8색 + 최근 사용 기억(세션) |
| 도구 단축키가 전역 단축키와 충돌하는가 | 모달 안에서만 활성 · 단일 글자 키 · textarea focus 시 비활성. 충돌 없음 |
| 모자이크 기본 모드 | `pixelate`(블러는 원본 추정 공격에 상대적으로 약하다) |
| 번호 뱃지가 삭제 후 번호를 재정렬해야 하는가 | **재정렬 안 함**(계속 증가) — 재정렬은 기존 설명 캡션과 어긋난다 |
