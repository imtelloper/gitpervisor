# PDF 읽기·편집 — 기능 설계서

> 상태: 설계(Design) + **M0 스파이크 완료(부록 A)** + **M1 읽기 뷰어 완료 — v0.7.0(부록 B)** (2026-09-14) · `/sc:design` 산출물 · 대상: gitpervisor (Tauri 2.11.2 + React 19 + TS)
> 1차 플랫폼: **Windows (WebView2)**, 3 OS 동일 코드 경로가 설계 조건.
> 자매 설계서: `DOCS/image-annotation-design.md`(주석 엔진 원 설계), `DOCS/pro-image-editor-design.md`(현 엔진 상태),
> `DOCS/task/50-image-fonts-opentype.md`(폰트 바이트 경로 — 이 문서의 선행 계약), `DOCS/media-viewer-design.md`(뷰어 분기 관례).
> 근거: 2026-09-14 실측. 코드 인용은 직접 열어 확인했고, 라이브러리 사실은 `npm pack`으로 받은
> **pdfjs-dist 6.3.289 · @cantoo/pdf-lib 2.11.0** 패키지 소스에서 확인했다. 추정인 곳은 "추정", 실기 확인이
> 필요한 곳은 스파이크 항목(S0-n)으로 적었다.

---

## 0. 요구사항 재정의

요청: **"PDF도 읽고 편집도 가능하게. PDF Expert처럼 PDF 안에 도형 삽입·텍스트 넣기 등."**

"PDF Expert 파리티"는 완료 판정이 불가능하다. 이 설계는 요청을 **판정 가능한 다섯 문장**으로 좁힌다.

| # | 문장 | 판정 |
|---|---|---|
| **P1 읽기** | 레포 안 PDF를 앱에서 연다 — 연속 스크롤·줌·텍스트 선택/복사·검색·목차·썸네일·링크 | e2e + 실기 |
| **P2 마크업** | 사각형·타원·직선·화살표·텍스트 상자·펜·형광펜을 페이지에 넣고, 선택·이동·크기조절·삭제·undo 한다 | e2e |
| **P3 호환** | 저장한 PDF가 **다른 뷰어(Edge/Chrome/Acrobat/macOS 미리보기)에서 같은 모양**으로 보이고, **이 앱에서 다시 열면 다시 편집된다** | 왕복 e2e + 수동 교차 확인 |
| **P4 무손실** | 저장이 원본의 기존 내용(전자서명·폼·다른 앱의 주석·메타데이터)을 망가뜨리지 않는다 | 픽스처 e2e |
| **P5 페이지** | 페이지 회전·삭제·순서 변경·빈 페이지/다른 PDF 삽입·추출 | e2e |

**기존 본문 텍스트를 직접 고치는 기능(PDF Expert의 "Edit Text")은 넣지 않는다**(§12). 요청의 "텍스트 넣기"는
새 텍스트 상자로 충족한다.

---

## 1. 결론 — 3줄

1. **렌더는 pdf.js 6.3 legacy 빌드의 `PDFViewer` 컴포넌트, 쓰기는 `@cantoo/pdf-lib`의 증분 업데이트다.**
   둘 다 순수 JS라 3 OS가 같은 코드로 돌고, 네이티브 바이너리·CSP 변경·신규 Rust 크레이트가 모두 없다.
2. **편집 결과는 표준 PDF 주석 + appearance stream(AP)으로 저장한다.** 이미지 편집기의 "평탄화"와 정반대인데,
   PDF에서는 주석이 표준 개념이라 다른 뷰어에서 똑같이 보이면서 지우거나 다시 편집할 수 있기 때문이다.
   평탄화는 내보내기 옵션(M3)으로만 둔다.
3. **편집 UI는 이미지 주석 엔진을 재사용한다.** 순수 모듈(노드 타입·기하·벡터 경로·텍스트 레이아웃·히스토리)과
   `AnnotationLayer`를 쓰되 prop 계약만 넓힌다(A1 backing·viewport, A2 bounds·background, A4 ToolRail tools — A3는 엔진 변경 없음).
   `ImageEditor.tsx`는 재사용하지 않는다. **스파이크 S1이 게이트 4개를 모두 통과해 채택으로 확정했다**(§8.2·부록 A).

---

## 2. 현황 실측

### 2.1 지금 PDF는 어떻게 되는가

- `src`에 PDF를 다루는 코드는 0건이다(`grep -ri pdf src` 결과 없음). Rust에는 브라우저 인자 `msPdfOOUI` 끄기 한 곳뿐이다(`lib.rs:159`).
- `DiffViewer`의 분기는 이미지 → 미디어 → Office → diff 순이다(`DiffViewer.tsx:725-752`). PDF는 어디에도 걸리지 않아
  `diff?.isBinary` → **"바이너리 파일"**로 끝난다.
- 그 과정에서 `useDiff`가 **PDF에 대해 git diff를 스폰한다.** 미디어·Office만 게이트하기 때문이다(`queries/index.ts:508-513`).

### 2.2 재사용할 자산

| 자산 | 위치 | 이 설계에서의 역할 |
|---|---|---|
| 뷰어 분기 관례 | `DiffViewer.tsx:252-261, 725-731` | `isPdfView` 분기를 `isImageView` 옆에 추가 |
| `useDiff` 미디어 게이트 | `queries/index.ts:508-513` | `isPdf` 추가 (git spawn 낭비 제거) |
| 파일 stamp 규약 | `diff.rs:233-252 stamp_of` · `tree.rs:369-420 expected_stamp` | 외부 변경 감지·**증분 append의 전제조건**(§7.3) |
| 노드 모델 | `lib/annotate/types.ts` · `schema.ts` · `tree.ts` | PDF 페이지 위 객체. 정규화 규칙 그대로 |
| 기하·히트·핸들 | `lib/annotate/geometry.ts` | 선택·리사이즈·90° 회전 델타(페이지 회전 시 재사용) |
| 벡터 경로 | `lib/annotate/vector/path.ts:187-208 toPathCmds` · `convert.ts:103-140 toPathObject` · `outline.ts` | **AP 콘텐츠 스트림 생성원.** M/L/C/Z → m/l/c/h 1:1 |
| 렌더러 | `lib/annotate/render.ts:106 renderScene` | 화면 오버레이. 변환만 주입 |
| 상호작용층 | `components/image/AnnotationLayer.tsx` | 활성 페이지 1장에만 마운트(§8.2) |
| 텍스트 입력(IME) | `components/image/annotation/textEdit.tsx:109-143` · `shortcuts.ts:354-356` | 한글 조합 가드까지 그대로 |
| 히스토리 | `lib/annotate/history.ts` | 문서 단위 스냅샷 |
| 문서 창 | `lib/floating.ts:101 openDocWindow` · `DocWindow.tsx` | "새 창으로 열기" 무변경 |
| 외부 변경 무효화 | `lib/events.ts:83,147` (`file-image` 쿼리 무효화) | **M1에서 쓰지 않았다** — 워처가 `build/` 같은 무시 경로를 버려 이벤트가 오지 않는다. `file_stamp` 폴링으로 대체(§7.3) |
| FNV-1a | `lib/floating.ts:143 fnv16` | AP 해시(§6.3) — `crypto.subtle` 미사용 원칙 유지(pro 설계 D-G) |

### 2.3 막는 것과 한계

| # | 사실 | 근거 | 설계 귀결 |
|---|---|---|---|
| **F1** | 큰 바이너리 IPC가 전부 base64다. 읽기 25MB, 쓰기 64MB | `diff.rs:228` · `tree.rs:413` | PDF는 raw IPC 신설(§9). `ipc::Response`는 태스크 50 설계와 **같은 첫 사용**이다 |
| **F2** | `write_file_bytes`가 **비원자적**이다 — `tokio::fs::write` 직행 | `tree.rs:417` | 쓰다 죽거나 디스크가 차면 원본 PDF가 깨진다. PDF 쓰기는 tmp→rename(§9) |
| **F3** | pdf.js가 편집 중인 기존 주석을 캔버스에서 숨기는 경로는 **내부 편집기 전용**이다 | `pdf.mjs:6944` — `AnnotationStorage.setValue`가 `value instanceof AnnotationEditor`일 때만 `#editorsMap`에 넣고, `modifiedIds`(`:7071`)는 그 맵에서만 나온다 | 공개 API로 "이 주석은 그리지 마"가 불가능 → 작업 사본 방식(K6) |
| **F4** | pdf.js 6.3 **modern 빌드는 `Map.prototype.getOrInsertComputed`를 폴리필 없이 17곳에서 쓴다** | `build/pdf.mjs:2470` 외. `legacy/build/pdf.mjs:5263`에만 core-js 폴리필이 있다 | WKWebView(macOS 버전 종속)·WebKitGTK에서 modern 빌드는 즉시 죽을 수 있다 → **legacy 빌드 고정**(K1). **M0 보정**: 이 API는 Safari 26.2·Chrome/Edge 145·Firefox 144부터 있고 Baseline 2026-02다([caniuse](https://caniuse.com/mdn-javascript_builtins_map_getorinsertcomputed)). modern 빌드를 실제로 돌려 본 것은 WebKit 26.6(Playwright Windows 포트, S0-2 대리)뿐이고 거기서는 동작했다(`getOrInsertComputed` 존재 확인). Chromium 계열에서는 modern을 돌리지 않았다(S0-1 Edge 153은 legacy만, WebView2 152 스파이크 앱은 pdf.js 미사용) — WebView2 152는 caniuse 기준(145+)으로 지원한다고 추정할 뿐이다. 위험 범위는 **WebKit/Safari 26.2 미만 전체**다: macOS 13 이하 전부, Safari/WebKit이 26.2 미만인 macOS 14·15·26(26.0·26.1 포함), 구형 배포판 WebKitGTK. Tauri 기본 최소 macOS가 10.13이라 결정은 유지한다 |
| **F5** | 앱 CSP에 `'wasm-unsafe-eval'`이 없다 | `tauri.conf.json:15` | pdf.js의 JPX·JBIG2 wasm이 막힌다. 다만 **pdf.js가 스스로 JS 폴백한다**(`pdf.worker.mjs` `WasmImage#instantiateWasm` catch → `#getJsModule`). `useWasm:false`로 시도 자체를 끈다 → CSP 변경 0 |
| **F6** | 시스템 폰트 바이트를 프론트가 쥘 경로가 없다. 태스크 50은 **설계만** 있다 | `DOCS/task/50-image-fonts-opentype.md:3,49-55,127-128` | 한글 텍스트 상자 저장의 선행조건. 50의 1단계(Rust `font_list`/`font_read` + `fonts.ts`)를 공유 선행작업으로 끌어온다(K10) |
| **F7** | `AnnotationLayer` 백킹은 **원본 해상도 이하로 고정**이고, 줌은 CSS transform이며 2배 이상이면 `pixelated`다 | `ImageEditor.tsx:1147-1150`(`Math.min(1, MAX_PREVIEW/…)`) · `AnnotationLayer.tsx:1043-1044`(어댑터 적용 후, `backing!=="display"` 조건 추가) | PDF는 400% 확대가 일상이다. 그대로 쓰면 도형·글자가 계단진다 → 백킹 모드 prop + viewport 창 백킹(§8.2 A1. display 백킹을 페이지 전체에 걸면 400%·DPR 1.5에서 ≈382MiB, viewport면 ≈57MiB — S1) |
| **F8** | `AnnotationLayer`가 창 단위 싱글턴 스토어와 모듈 전역 `pointerHits`에 묶여 있다 | `stores/imageEditor.ts:217` · `annotation/pointer.ts:236-250, 562`(어댑터 적용 후) | 페이지마다 동시 마운트 불가 → **활성 페이지 1장 규칙**(§8.2) |
| **F9** | pdf.js `pdf_viewer.mjs`는 `PDFThumbnailViewer`·사이드바를 export하지 않는다 | `web/pdf_viewer.mjs:9832` export 목록 | 썸네일·목차 패널은 직접 만든다(작다) |

---

## 3. 핵심 결정표

| # | 결정 | 선택 | 탈락한 대안과 이유 |
|---|---|---|---|
| **K1** | 렌더 엔진 | **`pdfjs-dist@6.3.289` legacy 빌드 + `PDFViewer` 컴포넌트.** 버전은 정확히 고정한다 | (a) *WebView2 내장 PDF 뷰어를 iframe으로* — Windows 전용이고 WebKitGTK는 못 그리며 편집층을 얹을 수 없다. (b) *PDFium(pdfium-render)* — 5개 타깃에 네이티브 바이너리를 번들해야 하고 렌더 비트맵을 IPC로 날라야 한다. (c) *MuPDF* — AGPL이라 MIT 앱과 충돌. (d) *modern 빌드* — F4. (e) *페이지 가상화 자체 구현* — `PDFViewer`가 가상화·HiDPI·detail canvas·텍스트 레이어·링크·검색을 이미 한다. 공식 "components" 사용법이다 |
| **K2** | 쓰기 엔진 | **`@cantoo/pdf-lib@2.11.0`**(MIT, 2026-09-11 갱신) + fontkit | (a) *원본 `pdf-lib@1.17.1`* — 2022-05 이후 멈췄고 증분 저장이 없다. (b) *pdf.js `saveDocument()`* — 자체 `AnnotationEditor` 인스턴스만 직렬화한다. 편집기 종류가 FREETEXT/HIGHLIGHT/STAMP/INK/SIGNATURE/COMMENT뿐이라(`pdf.mjs:56-66`) **도형이 없다**. (c) *Rust lopdf* — AP 생성·폰트 서브셋·xref를 전부 직접 짜야 한다 |
| **K3** | 저장 형태 | **표준 주석 사전 + AP 스트림.** AP가 모양의 정본이고, 표준 키는 다른 앱의 재편집용 최선 노력이다 | (a) *평탄화(페이지 콘텐츠에 굽기)* — 이 앱에서도 다른 앱에서도 다시 편집·삭제할 수 없다. 이미지는 주석 개념이 없어 평탄화가 맞았지만 PDF는 다르다. (b) *AP 없는 주석(NeedAppearances 의존)* — 뷰어마다 모양이 달라 P3가 깨진다 |
| **K4** | 저장 방식 | **증분 업데이트**(원본 바이트 + 추가분 append). Rust가 tmp 복사 → append → fsync → rename으로 원자적으로 교체한다 | *전체 다시 쓰기를 기본으로* — ① 전자서명이 무효화되고 ② pdf-lib가 모르는 구조를 재직렬화하는 위험이 있으며(P4) ③ 100MB 파일을 IPC로 왕복한다. **대가**: 지운 주석이 파일 안 이전 리비전에 남는다 → "정리 저장"(전체 다시 쓰기) 옵션과 안내 문구(§7.4) |
| **K5** | 편집 좌표계 | **page space 하나** = pt 단위, 좌상단 원점 y-down, `/Rotate` 적용, pdf.js `page.getViewport({scale:1})`와 동일. 변환 행렬의 출처는 `PageViewport` 하나뿐이다 | (a) *PDF user space(y-up) 그대로* — 엔진 전체가 y-down이라 모든 기하 호출에 뒤집기가 들어간다. (b) *`/Rotate` 적용 전 공간* — 회전된 페이지에서 오버레이를 CSS로 돌려야 하고 포인터→문서 환산(`pointer.ts:85-99 clientToDoc`·`:356-383`, 어댑터 적용 후)이 깨진다 |
| **K6** | 기존 주석과 편집 객체의 이중 표시 | **작업 사본.** 편집 가능한 주석을 `/Annots`에서 뺀 증분을 만들어 pdf.js에 다시 로드하고, 그 주석들은 오버레이가 그린다. 원본 파일은 건드리지 않는다 | (a) *pdf.js `modifiedIds`* — F3, 공개 경로 없음. (b) *`annotationMode: DISABLE`* — 폼 필드·링크 외 모르는 주석까지 전부 사라진다. (c) *`operationsFilter`로 `beginAnnotation` 구간 건너뛰기* — `PDFPageView` 내부의 `render` 호출을 패치해야 한다. 6.3에 막 생긴 필터라(`api.d.ts:486`) 계약이 불안정하다 |
| **K7** | 재편집 식별 | 우리가 쓴 주석에 **`/NM`(uuid) + `/GPV_Node`(노드 JSON) + `/GPV_APHash`(AP 원시 바이트 FNV-1a)**를 붙인다. 해시가 맞으면 무손실 복원, 다르면 표준 키로 가져오거나 잠근다(§6.3) | *`/GPV_Node`만* — 다른 앱이 색·위치를 고친 뒤에도 옛 JSON으로 되돌린다(조용한 데이터 손실). *`/M` 수정일 비교* — 갱신하지 않는 앱이 있다 |
| **K8** | 편집 UI 엔진 | **`AnnotationLayer` 재사용 + 좁은 어댑터 4개(§8.2), 활성 페이지 1장 규칙.** **S1 게이트 4개 통과로 채택(2026-09-14)** | (a) *`ImageEditor.tsx` 재사용* — 4,061줄에 이미지 로드·크롭·색보정·평탄화 저장이 얽혀 있다. (b) *페이지마다 상주 마운트* — F8, 그리고 페이지당 백킹 2장. (c) *PDF 전용 상호작용층 신규* — 선택·8핸들·마퀴·nudge·HUD·텍스트 편집을 다시 짠다(추정 800줄 이상). S1 통과로 폴백은 쓰지 않는다 |
| **K9** | 도구·스타일 범위 | **PDF 주석으로 표현되는 부분집합만** 노출한다. 단색 채움 1 · 단색 선 1 · 두께 · 대시 · 캡/조인 · 불투명도 · 블렌드는 형광펜의 multiply 하나 | 프레임·컴포넌트·스타일 라이브러리·효과·그라디언트·마스크·블렌드 19종·제약은 숨긴다(AP로 그릴 수는 있지만 요구가 없고 쓰기 코드가 배로 는다). **모자이크·블러는 제외한다** — 픽셀을 덮어도 아래 텍스트가 추출·검색되므로 PDF에서는 "가림"이 거짓말이 된다(§12) |
| **K10** | 텍스트 폰트 | **태스크 50 §3.3의 `font_list`/`font_read` 계약을 선행 구현한다.** 같은 바이트를 화면용 `FontFace`와 저장용 `embedFont(subset)`에 모두 쓴다. 후보는 §6.4 5~7항대로 고른다: OS/2 `fsType`이 임베드를 금지한(Restricted License) 폰트는 라이선스 때문에 빼고, 가변 폰트도 빼며(기본 마스터가 박힌다), 남은 폰트는 **실제 서브셋 임베드 시도**(빈 문서에 "가A"를 `save()`까지)를 통과해야 한다(S0-4). `fsType` 통과가 임베드 성공을 보장하지는 않는다(굴림: editable인데 `Cannot decode glyph 0`) | (a) *한글 폰트 번들* — 설치파일이 2~5MB 는다. 한글 폰트가 없는 Linux라는 드문 경우를 위한 비용이라 v1에서는 안내 문구로 대신한다(Q4). (b) *Standard 14 폰트* — 한글 글리프가 없다. (c) *화면은 CSS 폰트, 저장은 다른 폰트* — 줄바꿈 위치가 달라져 P3가 깨진다 |
| **K11** | 파일 IO | **raw IPC 커맨드 3개**(§9): `file_stamp`, `read_file_raw`(→ `ipc::Response`), `write_file_raw`(raw 요청 본문, `append`/`replace`, tmp→rename) | (a) *`read_file_base64`* — F1. (b) *프리뷰 루프백 서버 + pdf.js Range 로딩* — CSP `connect-src`와 CORS 헤더를 새로 열어야 하고, 편집은 어차피 전체 바이트가 필요하다. 거대 PDF 보기 수요가 실측되면 올린다(§12). (c) *기존 `write_file_bytes`* — F1·F2 |
| **K12** | 스크립트·eval·wasm | `useWasm:false` · `enableXfa:false` · 스크립팅 매니저 미사용 | **`isEvalSupported`는 6.3.289 `getDocument`에 없는 옵션이라 넘기지 않는다**(M1 확인 — 설계 초안의 `isEvalSupported:false`는 무효). eval은 앱 CSP가 막는다. **CVE-2024-4367**(폰트 행렬을 통한 임의 JS 실행, pdf.js 4.2.67에서 수정)은 버전 고정으로 피한다. `qcms`(ICC 색 관리)는 JS 폴백이 없어 ICC 프로파일이 무시된다(추정 영향: 일부 이미지 색이 약간 다름) |
| **K13** | 배치 | **`DiffViewer` 분기에 lazy `PdfView`를 인라인으로 둔다.** 상단 모드 탭은 `[보기 │ 주석 │ 페이지]`. 모달이 아니다 | *이미지 편집기처럼 모달/별도 편집 창* — PDF는 읽으면서 표시하는 도구라 뷰어와 편집기가 한 화면이어야 한다(PDF Expert도 같은 창의 모드 탭이다). 새 창은 기존 `openDocWindow` 경로를 그대로 쓴다 |

---

## 4. 전체 구조

```
DiffViewer (isPdf) ──lazy──▶ PdfView
                              │
   ┌──────────────────────────┼──────────────────────────────────────┐
   │ 읽기 경로 (M1)            │ 편집 경로 (M2~)                        │
   │                          │                                      │
   │ file_stamp ─┐            │  주석 탭 첫 진입                        │
   │ read_file_raw ─▶ bytes ──┼─▶ [pdf-lib lazy] import.ts            │
   │     │                    │     ├ 편집 가능 주석 → PdfDoc(노드)     │
   │     ▼                    │     └ /Annots에서 제거 → 증분 inc₀      │
   │ pdf.js getDocument       │  pdf.js 재로드(bytes ⧺ inc₀)  ← K6     │
   │     ▼                    │     ▼                                │
   │ PDFViewer (가상화)        │  PdfPageOverlays                     │
   │  ├ page canvas           │   ├ 정적 오버레이: renderScene         │
   │  ├ textLayer (선택·복사)   │   └ 활성 페이지: AnnotationLayer      │
   │  └ annotationLayer(링크·폼)│                                      │
   │ PdfFindController        │  Ctrl+S → save.ts                    │
   │ 썸네일 · 목차              │   file_stamp 확인 → read_file_raw     │
   └──────────────────────────┤   → load(forIncrementalUpdate)       │
                              │   → write.ts(변경분만)               │
                              │   → saveIncremental(snapshot)→fixSize│
                              │     = incₙ                           │
                              │   → write_file_raw(append, stamp)    │
                              │      Rust: copy→append→fsync→rename  │
                              └──────────────────────────────────────┘
```

`commit()`은 원본 ⧺ 증분 전체를 돌려주므로 저장 경로에 쓰지 않는다(§7.1 L1). `/Size` 보정(`fixSize`)은 L3.

**메모리 원칙**: 메인 스레드는 원본 바이트를 들고 있지 않는다. pdf.js에 넘긴 버퍼는 워커로 이전(transfer)되고,
편집 진입과 저장 때만 디스크에서 다시 읽는다(stamp로 같은 파일임을 보장). 저장은 드문 작업이라 재읽기 비용이
상주 사본(파일 크기 1배)보다 싸다.

---

## 5. 좌표계 (K5)

```
PDF user space   pt(×/UserUnit), y-up, 원점 임의, /MediaBox·/CropBox, /Rotate
   │  PageViewport(scale=1, rotation=page.rotate).transform  ─ pdf.js가 계산, 우리는 역행렬만 쓴다
   ▼
page space ★정본★   pt, 좌상단 원점, y-down, /Rotate 적용 = 사용자가 보는 방향
   │  SceneTransform { tx:-viewport.x, ty:-viewport.y, sx:k, sy:k },
   │    k = round(W × settled줌 × 96/72 × devicePixelRatio) / W   (W = 페이지 폭 pt)
   │    viewport = 보이는 영역(+여백) ∩ 페이지를 백킹 px 격자로 바깥 스냅한 문서 단위 사각형 — PDF는 필수(§8.2 A1)
   ▼
backing px (오버레이 캔버스 = viewport 영역만)
   ── settle 뒤 페이지 CSS px = 백킹 / devicePixelRatio (소수 CSS 크기면 합성기 재샘플로 흐려진다, S1 게이트 1)
   ── 줌 도중에는 백킹·viewport를 마지막 settle 값으로 고정(VP-2)
```

- **변환의 출처는 `PageViewport` 하나다.** `convertToViewportPoint`/`convertToPdfPoint`와 그 행렬만 쓰고
  `/CropBox`·`/Rotate`·`/UserUnit`를 직접 해석하지 않는다. 한 곳에서 계산하는 것이 이 클래스의 버그를 막는다.
- **AP 스트림은 항상 `/Matrix` 항등, `/BBox` = user space `/Rect`로 쓴다.** 내용은
  `q <page→user 행렬> cm … Q`로 감싸고 그 안에서 page space 좌표를 그대로 쓴다. 그러면 `/Rotate`나 `NoRotate`를
  뷰어가 어떻게 해석하든 모양이 같다.
- **텍스트는 y-down 공간에서 `1 0 0 -1 x baseline Tm`으로 글리프를 바로 세운다.** 경로는 뒤집혀도 모양이 같지만
  글리프는 뒤집히기 때문이다.
- **페이지 회전(M4)은 이미지 회전과 같은 문제다.** page space 크기가 (W,H)→(H,W)로 바뀌므로 그 페이지 노드에
  `geometry.ts`의 90° 델타 아핀을 적용한다. 이미지 편집기가 이미 겪고 해결한 코드 경로다(`geometry.ts:513-531`).

---

## 6. 데이터 모델

### 6.1 문서 봉투

```ts
// src/lib/pdf/model.ts
export interface PdfPage {
  key: string;             // 원본 페이지 객체 참조 "12 0 R" | 삽입 페이지 "new:<uuid>" — 순서가 바뀌어도 불변
  w: number; h: number;    // page space 크기(pt, /Rotate 적용 후)
  rotate: 0 | 90 | 180 | 270;
}
export interface PdfMarkup {           // 텍스트에 붙는 마크업(M3) — 노드 트리 밖. 이동·리사이즈 없음
  id: string; pageKey: string;
  subtype: "Highlight" | "Underline" | "StrikeOut";
  quads: number[];                     // page space, 사각형당 8개
  color: string; opacity: number;
}
export interface PdfDoc {              // 히스토리 스냅샷 단위
  v: 1;
  pages: PdfPage[];                    // 표시 순서 = 배열 순서
  nodes: Record<string, Node[]>;       // pageKey → annotate/types.ts 의 Node[] (page space)
  markups: PdfMarkup[];
}
```

**dirty 판정은 스냅샷에 넣지 않고 참조 비교로 한다.** 엔진은 이미 "변경된 객체만 새 참조"로 불변 갱신한다.
세션 장부 두 개를 히스토리 **밖에** 둔다.

```ts
refs:  Map<id, string>   // 파일 안 객체 참조("45 0 R"). 가져오기·저장 때 갱신
saved: Map<id, Node | PdfMarkup>   // 마지막 가져오기/저장 시점의 객체 참조
// 저장 시:  new     = 현재에 있고 refs에 없음
//          changed = 현재 객체 !== saved.get(id)
//          deleted = saved에 있고 현재에 없음 (refs 있는 것만 /Annots에서 제거)
```

undo로 원래 값에 되돌아가도 참조가 달라 "changed"로 잡힌다. 같은 내용을 한 번 더 쓸 뿐이라 무해하다.
dirty 플래그를 스냅샷에 넣으면 undo/redo마다 플래그 정합성을 따로 지켜야 하는데, 이 방식은 그 문제가 없다.

### 6.2 노드 → PDF 주석 매핑 (M2)

| 노드 kind | `/Subtype` | 표준 키(다른 앱 재편집용) | AP 생성원 |
|---|---|---|---|
| `rect` | `Square` | `/Rect /C /IC /BS<</W /D>> /CA` | `toPathObject` → `toPathCmds` |
| `ellipse` | `Circle` | 동일 | 동일(κ 4정점) |
| `line` | `Line` | `/L /LE[/None /None] /BS /C /CA` | 동일 |
| `arrow` | `Line` | `/LE[/None /OpenArrow]`(머리 모양에 따라 `ClosedArrow`) | 몸통 + 화살촉 경로(`paint.ts:499-512`의 머리 기하를 export해서 공유) |
| `pen` | `Ink` | `/InkList`(user space 점열) `/BS /C /CA` | `toPathObject`(3차 곡선 피팅) |
| `highlight`(자유 형광펜) | `Ink` | 동일 | 동일 + ExtGState `/BM /Multiply /CA 0.35` |
| `text` | `FreeText` | `/Contents`(논리 텍스트) `/DA`(`/GpvF n Tf r g b rg`) `/Q` `/Rotate` | 임베드 폰트 서브셋, 줄마다 `Tj`(§6.4) |
| 이미지 채움 `rect`(M3) | `Stamp` | `/Rect` | 이미지 XObject(`embedPng`/`embedJpg`) |

- **공통**: `/NM` uuid, `/F 4`(Print), `/M` 수정일, `/P` 페이지 참조, `/GPV_Node`, `/GPV_APHash`.
- **ExtGState**: `/CA` 불투명도, 형광펜만 `/BM /Multiply`. 선 정렬은 PDF에 없으므로 PDF 모드에서 `strokeAlign`을 center로 고정한다.
- **폰트를 `/AcroForm /DR`에 넣지 않는다.** 카탈로그에 `AcroForm`을 새로 만들면 일부 뷰어가 문서를 폼으로 취급한다.
  대가로 Acrobat이 텍스트 상자를 **재편집할 때** Helvetica로 대체할 수 있다. 표시는 AP가 정본이라 영향이 없다.

### 6.3 가져오기 규칙 (K7)

주석마다 첫 번째로 참인 규칙 하나만 적용한다.

| 순서 | 조건 | 결과 |
|---|---|---|
| 1 | `/GPV_Node` 있음 **그리고** `FNV(AP /N 원시 바이트) == /GPV_APHash` | JSON으로 **무손실 복원**(편집 가능) |
| 2 | 지원 subtype **그리고** 무손실 판정 통과(아래) | 표준 키에서 노드 생성(편집 가능). 우리 JSON이 있었다면 버린다(다른 앱이 고친 뒤다) |
| 3 | 그 외(Text 메모·Widget·Link·Popup·FileAttachment·Redact·Polygon·Caret·타 앱 Stamp·리치텍스트 FreeText …) | **건드리지 않는다.** pdf.js가 원래대로 그리고, 선택되지 않는다 |

무손실 판정(표준 키 가져오기 허용 조건):

| subtype | 허용 | 거부(→ 규칙 3) |
|---|---|---|
| Square / Circle | 실선·대시 `/BS` | 구름 테두리 `/BE` |
| Line | `/LE` ∈ {None, OpenArrow, ClosedArrow} | 지시선 `/LL`·캡션 `/Cap` |
| Ink | 항상 | — |
| FreeText | 평문 | `/RC` 리치텍스트, `/IT /FreeTextCallout` |
| Highlight / Underline / StrikeOut (M3) | `QuadPoints` | — |

- 가져온 주석의 `/Popup` 자식과 `/IRT` 답글 체인은 **파일에 그대로 둔다.** 수정할 때는 사전 키를 **패치**한다
  (`/Rect`·`/C`·`/AP` 등만 바꾸고 `/T` 작성자·`/Popup`·모르는 키는 보존한다). 삭제할 때는 그 `/Popup`과
  답글 체인을 함께 제거한다(Acrobat의 동작과 같다).
- **작업 사본**(K6)은 규칙 1·2에 해당하는 주석만 뺀다. 문서에 그런 주석이 없으면(가장 흔한 경우) 작업 사본도,
  pdf.js 재로드도, pdf-lib 로드도 하지 않는다. 판정은 먼저 pdf.js
  `getAnnotationsByType(지원 타입 집합, ∅)`(`api.d.ts:987`)로 싸게 한 뒤, 후보가 있을 때만 pdf-lib를 연다.

### 6.4 텍스트 — 화면과 저장이 같은 줄바꿈

1. `font_read`로 받은 바이트 하나를 두 곳에 쓴다.
   - 화면: `new FontFace("gpv-pdf-<fnv>", bytes)` 등록 → 노드 `fontFamily`
   - 저장: `pdfDoc.embedFont(bytes, { subset: true })`
2. **줄바꿈은 `text-layout.ts`가 한 번만 계산하고, 그 결과 줄들을 AP에 명시적으로 쓴다.** PDF 쪽이 다시 줄바꿈하지 않는다.
3. **커닝을 끈다.** 캔버스 `ctx.fontKerning = "none"`. PDF `Tj`는 GPOS 커닝을 적용하지 않으므로,
   화면에서 켜 두면 긴 줄의 끝이 어긋난다.
4. `/Contents`에는 소프트 줄바꿈 없는 논리 텍스트를 넣는다. 다른 앱은 `/Rect` 폭에 맞춰 스스로 다시 줄바꿈한다.
5. 기본 폰트는 `font_list`에서 **한글 글리프가 있고, `fsType`이 Restricted License가 아니며, 가변 폰트가 아니고, 아래 임베드 사전 검사를 통과한** 첫 항목이다.
   후보: `Pretendard → Malgun Gothic → Noto Sans KR(정적) → Apple SD Gothic Neo → Noto Sans CJK KR`.
   없으면 텍스트 도구에 "한글 임베드 가능한 폰트가 없습니다"를 표시하고 라틴 폰트로만 허용한다.
6. **기술적 임베드 가능 여부는 메타데이터가 아니라 실제 시도로 판정한다(S0-4 실측).** 폰트를 처음 고를 때 빈 문서에
   `embedFont(bytes, {subset:true})` + `"가A"` 한 번을 `save()`까지 돌려 성공한 폰트만 목록에 남긴다(폰트당 1회 캐시).
   fsType 비트는 이 판정을 대신하지 못한다 — 실패한 굴림도 fsType은 "editable"(임베드 허용)이었다(바탕·Cambria의 fsType은 재지 않았다).
   `fsType`은 라이선스 거부에만 쓴다 — pdf-lib·fontkit은 `fsType`을 검사하지 않는다.
7. **가변 폰트는 후보에서 뺀다.** pdf-lib 서브셋은 인스턴스를 만들지 않고 **기본 마스터**를 그대로 넣는다.
   `NotoSansKR-VF.ttf`는 기본 마스터가 `NotoSansKR-Thin`이라, 화면(Regular)과 저장본의 잉크량이 **0.45배**로 갈렸다.

> **S0-4 결과(2026-09-14, 이 머신 Windows 11)** — 글리프 렌더는 증분 FreeText AP 경로로 임베드한 뒤 PDFium·pdf.js 두 렌더러로 확인했다.
> ToUnicode 추출, TTC face 선택(MicrosoftYaHei), 바탕·Cambria 실패는 새 문서 `drawText` 경로에서만 시험했다.
>
> | 폰트 | 형식 | 결과 | 서브셋 증분 | FreeType 기준 NCC | pdf.js↔PDFium NCC |
> |---|---|---|---|---|---|
> | Malgun Gothic | TTF(glyf) | ✅ ToUnicode 추출 원문 일치 | 7.4KB | 0.94 / AP 0.89 | 0.93 |
> | Pretendard | OTF(**CFF**) | ✅ 원본 pdf-lib의 CFF 깨짐 **재현 안 됨** | 26.6KB | 0.98 / AP 0.95 | 0.97 |
> | MicrosoftYaHei | **TTC** `postscriptName` 선택 | ✅ face 선택 동작 | — | — | — |
> | Gulim · Batang(TTC), Cambria | glyf + **EBDT/EBLC 비트맵** | ❌ `Cannot decode glyph 0`. 단일 TTF로 추출해도 같다 → TTC 문제가 아니라 비트맵 테이블 동반 폰트의 문제 | — | — | — |
> | Noto Sans KR VF | 가변 TTF | ⚠️ 임베드는 되나 Thin 마스터 | 3.5KB | Regular 대비 잉크 0.45 | 0.96 |
>
> Apple SD Gothic Neo(macOS TTC)는 이 머신에 없어 **미검증**이다 — 6번 사전 검사가 실패를 흡수한다.

---

## 7. 저장

### 7.1 파이프라인 (M2)

```
Ctrl+S
 ① now = file_stamp()            ≠ openedStamp → "외부에서 바뀜" 확인(§7.3)
 ② bytes = read_file_raw()
 ③ doc = PDFDocument.load(bytes, { forIncrementalUpdate: true, updateMetadata: false })
 ④ write.ts: new/changed → 주석 객체 생성·패치(AP 포함), deleted → /Annots에서 제거(+Popup·IRT)
 ⑤ inc = fixSize(bytes, await doc.saveIncremental(doc.context.snapshot))
 ⑥ newStamp = write_file_raw(mode:"append", expectedStamp: now, baseLen: bytes.length, body: inc)
 ⑦ refs·saved 갱신, openedStamp = newStamp, 트리·status 캐시 무효화
```

**pdf-lib(@cantoo 2.11.0) 사용 계약 — S0-5에서 실측으로 확정한 세 가지. 어기면 겉으로는 멀쩡한 파일이 나온다.**

| # | 계약 | 근거(실측) |
|---|---|---|
| **L1** | 증분만 필요하면 **`saveIncremental(doc.context.snapshot)`**을 쓴다. `commit()`은 증분이 아니라 **원본 ⧺ 증분 전체**를 돌려준다 | `cjs/api/PDFDocument.js:1770-1774`. 스파이크 1회차가 이걸 모르고 원본을 두 번 붙였다. 두 경로의 증분은 **바이트 동일**(서명·95MB 픽스처로 확인)하다. `commit()`은 `원본 ⧺ 증분` 새 버퍼를 만들어 파일 크기만큼 사본을 하나 더 만든다(소스 확인). 두 API의 메모리를 같은 기준으로 비교한 실측은 없다. 스파이크의 380MB·190MB는 `external+arrayBuffers`로 ArrayBuffer를 두 번 센 값이다. 게다가 380MB는 commit 전(load 직후)에 입력 사본까지 넣어 잰 값이고, 190MB는 입력이 이미 있는 시점을 기준으로 잰 값이다. 보정하면 load 후 외부 버퍼 ≈ 입력 95MB + 스트림 사본 95MB(`cjs/core/parser/PDFObjectParser.js:205` `slice`), load+`saveIncremental` 추가분은 ≈95MB다. commit 경로를 끝까지 돈 프로세스의 RSS 피크는 기준 78MB 대비 +286MB(파일 크기의 약 3배)였다 |
| **L2** | **기존 페이지에 `PDFPage` 헬퍼(`page.node.addAnnot`·`drawText` 등)를 쓰지 않는다.** `/Annots`를 직접 조작한다. 배열이 간접 객체면 그 배열만, 페이지 사전 안에 직접 들어 있으면 페이지 사전만 바뀐다 | `addAnnot` → `normalizedEntries()` → `normalize()`(`cjs/core/structures/PDFPageLeaf.js:141-171`)가 **콘텐츠 스트림을 q/Q로 감싸고** 빈 `/XObject`·`/ExtGState`를 넣는다. 서명 문서라면 "주석 추가"가 "페이지 내용 변경"이 된다 |
| **L3** | 증분 trailer의 `/Size`가 직전 리비전보다 작으면 **직전 값으로 올린다**(`fixSize`) | `saveIncremental`은 xref 형식이 아니라 **헤더 버전**으로 writer를 고른다(`cjs/api/PDFDocument.js:1689,1698` — 헤더 1.5 미만이거나 PDF/A-1이면 `PDFWriter`, 그 밖에는 `PDFStreamWriter`). `PDFWriter.createTrailerDict`(`cjs/core/writers/PDFWriter.js:138-146`)는 "번호가 가장 큰 객체가 출력에서 빠졌으면 그건 XRef 스트림"이라 가정하고 1을 뺀다. 그래서 새 객체 없이 기존 객체만 고친 증분에서 `/Size`가 1 작아진다(naive 기준 16→17→**16**). `PDFStreamWriter`는 `/Size`를 `largestObjectNumber+1`로 덮어써서(`cjs/core/writers/PDFStreamWriter.js:115`) 영향이 없다. S0-5의 클래식 xref 픽스처 3종은 전부 `%PDF-1.3`이라 `PDFWriter` 경로만 탔다. **헤더가 1.5 이상인 클래식 xref 파일에 xref 스트림 증분이 붙는 경로는 검증하지 않았다.** qpdf는 경고를 내고, pyHanko 엄격 모드는 **파일 읽기 자체를 거부**한다. 업스트림 이슈 보고 대상 |

pdf-lib 줄 번호는 `@cantoo/pdf-lib@2.11.0` **CJS 빌드(`cjs/…`) 기준**이다. 앱이 번들하는 ESM 빌드(`es/…`)에서는 2~3줄 앞이다(`PDFDocument.js:1768-1772` · `PDFPageLeaf.js:138-168` · `PDFWriter.js:136-144`).

**S0-5 판정 매트릭스**: 문서 4종(클래식 xref·xref 스트림·선형화·전자서명) × 동작 4종(추가·다시 열어 수정·작업 사본 제거·삭제) = 16건, L1~L3 적용.
- 원본 접두사 바이트 동일: 16/16
- qpdf `check_pdf_syntax` 경고: 0
- PDFium은 16건 모두 주석 목록 증감과 테두리 색(추가 빨강→수정 파랑, 삭제 시 흰색)을 기대대로 봄. pdf.js는 그중 4건(서명·추가, 서명·수정, xref 스트림·작업 사본 제거, 선형화·삭제)만 렌더해 같은 좌표의 색을 확인(산출물 `pdfspike/out/s01/report.json`)
- 증분 크기 0.4~0.9KB(추가 시 카탈로그·페이지·주석·AP 4객체)

같은 16건을 L2·L3 **없이** 돌리면(naive: `page.node.addAnnot` 사용, `/Size` 보정 없음) 결함이 둘 다 재현된다. 콘텐츠 q/Q 래핑은 문서 4종의 추가 단계에서 4건 생긴다. 이어지는 작업 사본 제거·삭제 증분 8건도 이미 래핑된 `/Contents` 배열이 담긴 페이지 사전을 다시 쓰므로, 스크립트 플래그(`pageContentsTouched`)로는 12건이다. `/Size` 역행은 6건이다: 클래식 xref 문서 3종(기본·선형화·서명, 모두 `%PDF-1.3`) × 작업 사본 제거·삭제. 이 6건에서 qpdf 경고가 나고, 그중 서명 문서 2건은 pyHanko 엄격 모드가 읽기를 거부한다. xref 스트림 문서는 0건이다. 검사가 결함을 실제로 잡는다는 대조군이다. 산출물: 스크래치 `pdfspike/out/s05/report.json`(pageContentsTouched·sizes) · `validate.json`(qpdf·pyHanko).

- **⑥의 stamp와 baseLen은 선택이 아니라 정합성 조건이다.** 증분의 xref 오프셋과 `/Prev`는 **읽은 바이트 길이를
  기준으로 한 절대값**이다. 다른 내용 뒤에 붙이면 파일이 조용히 깨진다. 이미지의 `expected_stamp`
  (덮어쓰기 방지)보다 한 단계 강한 계약이다.
- 두 번째 저장부터는 파일이 `원본 ⧺ inc₁`이다. 같은 절차를 반복하면 `⧺ inc₂`가 붙는다. ⑦에서 `refs`를 갱신하므로,
  inc₁에서 만든 객체는 두 번째 저장에서 **새로 만들지 않고 같은 참조를 패치**한다(중복 주석 방지).
- 작업 사본 증분 inc₀(K6)은 **표시 전용이고 파일에는 절대 들어가지 않는다.** 저장은 항상 디스크에서 새로 읽은 바이트에서 시작한다.

### 7.2 다른 이름으로 저장 · 정리 저장 (M3)

| 동작 | 모드 | 내용 |
|---|---|---|
| 다른 이름으로 저장 | `replace`, `overwrite:false` | `원본 ⧺ inc`를 새 경로에 쓴다 |
| **정리 저장**(이전 리비전 제거) | `replace` | `doc.save({ rewrite: true })`(`PDFDocumentOptions.d.ts:16`)로 전체를 다시 쓴다. 지운 주석이 파일에서 **실제로** 사라진다. 서명 문서에서는 막고 사유를 표시한다 |
| 평탄화 내보내기 | `replace`, 새 경로 | 각 주석의 AP를 페이지 콘텐츠에 `q cm /Xn Do Q`로 붙이고 주석을 제거한다(추정 ≈40줄). 기본 이름 `<stem>-flattened.pdf` |

### 7.3 외부 변경

이 앱은 개발 도구다. **LaTeX·pandoc·보고서 빌드가 레포 안 PDF를 계속 다시 쓴다.**

**감지는 이벤트가 아니라 `file_stamp` 폴링이다(M1 확정).** 파일 워처는 `.gitignore`·`build/` 같은 경로를 버리므로
`repo://changed` 무효화로는 LaTeX 산출물 재기록을 못 잡는다(스위트 61 C4가 `build/` 아래 파일로 이를 단언한다).
규칙(`PdfView.tsx`):

- 1.5초 `setTimeout` 체인. 컨테이너 폭 0(숨은 탭)·`visibilityState=hidden`이면 읽지 않고, 다시 보이면(ResizeObserver·`visibilitychange`) 즉시 한 번 돈다.
- stamp가 바뀌면 `read_file_raw` → 다시 `file_stamp`로 읽는 사이 바뀌지 않았는지 확인 → **끝 1KB에 `%%EOF`가 없고 mtime이 3초 안이면 미룬다**(쓰다 멈춘 파일).
- 새 문서를 연 뒤 `setDocument`로 제자리 교체(리마운트 없음). 채택되지 않은 로딩 태스크는 전부 `destroy`한다.
- 읽기·로드 실패는 그 stamp를 기록해 같은 판을 다시 읽지 않는다 — 다음 재기록이나 [다시 시도]에서 풀린다.

| 상태 | 외부 변경 감지 시 |
|---|---|
| 편집 없음 | **자동 재로드.** 페이지 번호·줌·스크롤 비율을 보존한다(M1) |
| 편집 있음(dirty) | 배너: "파일이 외부에서 바뀌었습니다 — [다시 불러오기(편집 버림)] [계속 편집]". 계속 편집한 뒤 저장하면 ①에서 확인창을 한 번 더 띄운다 |

"계속 편집 후 저장"을 허용하는 경우: 새 파일에서 ②~⑥을 수행한다. 원본 참조(`refs`)가 새 파일에 여전히
그 주석을 가리키는지는 보장되지 않는다(외부 도구가 파일을 통째로 다시 만들었을 수 있다). 따라서 **이때는
`refs`를 비우고 전부 신규 주석으로 쓴다.** 원본 주석이 두 번 보이는 것은 사용자가 확인창에서 받아들인 결과다
(문구에 명시한다).

### 7.4 서명·암호·권한

| 문서 | v1 동작 | 근거 |
|---|---|---|
| 전자서명 있음(`/Sig` 필드) | 편집·증분 저장 허용. 첫 저장 전 1회 안내: "서명 이후 변경으로 표시됩니다". 정리 저장 비활성 | 증분은 서명된 리비전을 보존하고, 전체 다시 쓰기는 서명을 무효화한다. **S0-5 실측**: pyHanko 0.37 검증에서 서명은 `intact·valid·trusted`, 커버리지 `ENTIRE_REVISION`이 유지되지만 변경 수준은 `OTHER`(최종 판정 False)다. **대조군으로 PDFium 자체 증분 저장(Chrome·Edge 엔진)으로 사각형 주석을 넣어도 똑같이 `OTHER`**가 나온다. 단 대조군은 AP·`/NM`·`/BS` 없는 최소 사전을 페이지 `/Annots`에 인라인으로 넣고 객체 1·2·3·8·9를 다시 썼고, 우리 증분은 AP·주석을 간접 객체로 추가하고 1·3만 다시 썼다 — **같은 주석이 아니다.** 그래도 서로 다른 두 쓰기 방식이 같은 판정을 받았으므로, pyHanko 기본 정책이 승인 서명 뒤의 주석 추가 자체를 허용 변경으로 분류하지 않는다고 보는 것이 가장 단순한 설명이다(우리 증분 고유 결함 가능성을 완전히 배제하지는 못한다). Acrobat 판정은 미검증(수동) |
| 암호화(사용자 암호) | pdf.js 암호 입력으로 **읽기만** 한다 | pdf-lib 포크의 암호화 문서 **증분** 저장이 새 객체를 문서 키로 암호화하는지 미검증 |
| 권한 제한(소유자 암호, 수정 금지) | 읽기만. "문서가 편집을 제한합니다" | 제한 플래그를 존중한다. 암호화 문서이기도 해서 위 규칙과 같다 |
| XFA 폼 | 정적 렌더만(`enableXfa:false`), 편집 비활성 | XFA는 pdf-lib 증분과 상호작용이 불명확하다 |

---

## 8. 화면과 상호작용

### 8.1 레이아웃

```
┌ PdfView ──────────────────────────────────────────────────────────────────┐
│ [보기│주석│페이지]   ◀ 3 / 42 ▶   − 125% +  맞춤▾   ⌕   ● 저장 안 됨 [저장] ⋯ │
├────────┬───────────────────────────────────────────────────┬──────────────┤
│ 썸네일  │ PDFViewer 연속 스크롤                                │ (주석 모드)   │
│ │ 목차  │  ┌ .page ───────────────┐                          │ 속성: 색·선·  │
│        │  │ canvas (pdf.js)       │                          │ 채움·두께·    │
│        │  │ textLayer             │  ← 보기: 텍스트 선택       │ 불투명도·     │
│        │  │ annotationLayer(링크) │                          │ 폰트·크기     │
│        │  │ overlay canvas        │  ← 노드 있는 페이지만      │              │
│        │  │ [활성] AnnotationLayer │  ← 포인터 아래 페이지 1장   │              │
│        │  └───────────────────────┘                          │              │
│ 주석 모드 도구: V 선택 · Space 손 · T 텍스트 · R 사각 · O 타원 · L 직선 · A 화살표 │
│              · Shift+P 펜(연필) · H 형광펜 · (M3) 텍스트 마크업 · 이미지 · 서명   │
└────────┴───────────────────────────────────────────────────┴──────────────┘
```

P(베지어 펜 `vpen`)는 PDF 모드에 없다 — §8.2 A4.

- **보기 모드**: 텍스트 레이어가 맨 위에 있어 선택·복사가 된다. 오버레이는 표시만 하고 포인터를 통과시킨다.
- **주석 모드**: 활성 페이지의 `AnnotationLayer`가 포인터를 받는다. 텍스트 마크업 도구(M3)일 때만 텍스트 레이어를
  위로 올려 선택을 받고, 선택 영역의 `Range.getClientRects()`를 page space quad로 바꾼다.
- 도구 키·단축키 표는 `shortcuts.ts`를 재사용한다. **PdfView에 포커스가 있고 주석 모드일 때만** 활성화한다.
- `Ctrl+S` 저장, `Ctrl+F` 검색(`PDFFindController`), `Ctrl+휠` 커서 고정 줌(`PDFViewer`의 `currentScale` +
  스크롤 보정), `+ − 0` 줌/맞춤.
- **Esc 계층**은 이미지 편집기 순서를 따른다: 텍스트 편집 확정 → 드래프트 취소 → 도구를 선택으로 → 선택 해제 → 검색바 닫기.
  PDF 뷰는 모달이 아니므로 "닫기" 단계가 없다.

### 8.2 `AnnotationLayer` 재사용 — 어댑터 4개와 활성 페이지 규칙 (K8)

| # | 어댑터 | 내용 | 이미지 편집기 영향 |
|---|---|---|---|
| **A1** | 백킹 모드 + **뷰포트 창** | prop `backing?: "image" \| "display"`(기본 `"image"`)와 **`viewport?: {x,y,width,height}`(문서 단위)**. `display`면 호출부가 백킹을 디바이스 px로 맞추고 `pixelated`를 끈다. **캔버스 CSS 박스의 크기(=백킹/dpr)와 원점도 디바이스 px에 놓는 것이 호출부 계약이다.** `viewport`는 백킹 px 격자로 바깥 스냅한다(`viewport.x = floor(x·scale)/scale`, `backW = round(viewport.width×scale)`). 엔진(`vpBox`)은 받은 값을 그대로 배치할 뿐 스냅하지 않는다. S1 반증: transform으로 원점을 0.5 디바이스 px 밀면 단면 4/7이 나와 흐림으로 판정됐다. pdf.js 페이지 div(가운데 정렬·margin·border)의 원점이 디바이스 px에 놓이는지는 확인하지 않았다 → M2에서 게이트 1을 실제 PdfView로 옮길 때 함께 단언한다. `viewport`가 있으면 백킹은 **보이는 영역(+여백)만** 덮는다 — 씬 변환 `tx=-viewport.x`, 캔버스 CSS 박스를 그 영역에 배치, client→doc 환산에 원점 가산(엔진 경로는 `pointer.ts` `clientToDoc` 한 곳. 단 `GradientEditor.orientedPerCss`는 rect 원점=문서 원점 전제라 viewport에서 배율이 틀리고(리뷰 VP-5, 미수정), `flushCursor`의 범위 판정은 여전히 `bounds`라 viewport 박스 밖에서 클램프된 픽셀색을 낸다(VP-4, 미수정)), 캐시 키에 원점 포함, viewport 변경 커밋에서 동기 페인트(VP-1). **PDF는 viewport 필수** — 400%·DPR 1.5·형광펜 1개에서 힙 캔버스 합계 page ≈382MiB vs viewport ≈57MiB(활성 백킹만 32.1MP vs 3.7MP · 스크롤 영역 ≈1374×850css 기준, viewport 몫은 창 면적에 비례, S1) | `backing`·`viewport` 미지정이면 모든 식이 종전과 같다(스파이크 통합 단계에서 줄 단위 대조, e2e 202/0/0). e2e 35 "백킹은 줌과 무관하게 불변"은 `image` 모드의 계약으로 남는다 |
| **A2** | 배경 없음 | `oriented: HTMLCanvasElement` → `bounds: {width, height}` + 선택 `background?`. 클램프·스냅 경계·가이드 삭제 한계는 `bounds`를 쓰고, 포인터 환산은 `viewport`가 있으면 그 영역, 없으면 `bounds`를 쓴다(A1 `clientToDoc`). **`pointer.ts`의 `oriented` 참조 9줄도 함께 바뀐다**(A1 포함 pointer.ts 전체 diff 49줄, S1) | 호출부 1곳이 `oriented`를 두 prop에 넘긴다(같은 참조) |
| **A3** | ~~크롭·Chrome 선택화~~ → **엔진 변경 없음** | 호스트가 `cropMode={false}`·no-op 크롭 콜백을 넘긴다. **ChromeOverlay는 필수** — 선택 상자·핸들·HUD는 거기서만 그려진다(`ChromeOverlay.tsx:630-649`). 페이지 가장자리 핸들이 잘리지 않게 여백 래퍼(`-inset-6`)에 두고 rulers·pixelGrid는 끈다 | 0 |
| **A4** | 도구 필터 | `ToolRail`에 `tools?: readonly RailItem["id"][]`. 지정하면 그 목록만 그 순서로, 플라이아웃 없이 둔다(형광펜은 원래 플라이아웃 전용이라 이 방식이어야 레일에 올라온다). PDF 목록: `select, hand, text, rect, ellipse, line, arrow, pen(연필 Shift+P), highlight` — `vpen`(P)은 없다 | 미지정이면 DOM·title·클래스 동일(e2e 30·53 초록) |

**활성 페이지 1장 규칙 (F8 대응)**

- 활성 전환은 세 경로다. ① `pointerenter`/`pointermove` — **`buttons===0 && !textEditing`일 때만**(드래그·텍스트 입력 중 전환 금지).
  ② `onPointerDownCapture` — 가드에 막혀 비활성으로 남은 페이지를 누르면 그 자리에서 활성화한다(LC-2. 이 누름 자체는 새 레이어로
  전달되지 않는다 — 활성화와 텍스트 확정만 한다). ③ API `switchTo(i)`.
- 전환 절차(순서가 계약이다): 텍스트 편집 중이면 **`layerRef.handleEscape()`로 먼저 확정**(onBlur에 기대지 않는다 — 언마운트 중
  React는 이벤트를 쏘지 않는다) → 스토어 `select([])`·`setHover(null)`·`setTextEditing(false)`·디자인 모드 → `flushSync`로 활성 변경.
  `onCommit`은 **렌더 시점 페이지에 바인딩**한다. 주석 모드 진입 때만 `reset()` 1회(도구가 select로 돌아가므로 전환마다 부르지 않는다).
- 드래그 중에는 포인터 캡처로 원래 페이지에 머문다. **객체를 페이지 사이로 옮기는 기능은 넣지 않는다**(§16).
- 활성이 아닌 페이지는 **노드가 있고 뷰포트(+여백)와 겹칠 때만** 정적 오버레이 캔버스 1장을 두고 `renderScene`으로 그린다(LC-4 컬링).
- 모듈 전역(`render.ts:79-102` 레이어 풀, `scene.ts:61-72` 씬 슬롯)은 누수는 없지만(S1 게이트 4, page 전략·200%에서만 측정), **활성 레이어와 정적 오버레이의 백킹
  크기가 다르면 그릴 때마다 풀을 해제·재할당**한다(`poolFor` 크기 교대). 형광펜 multiply가 백킹 크기 격리 레이어를 빌리므로
  비용이 커질 수 있다 → R16. `pointerHits` 전역은 소비자가 1개라 안전하다.
- 주석 모드 키는 PDF 전용 `useEditorKeys` 맵 + `blocked` 게이트(`!annotating || !focusWithin || imageEditorPath || prompt/confirm`)로 좁힌다.
  `useEditorKeys`는 consume 행을 액션 없이도 삼키므로(`useEditorKeys.ts:110-115`) 게이트가 없으면 앱 전역 단축키가 죽는다.

**S1 스파이크 게이트** — 아래를 전부 만족하면 K8을 채택하고, 하나라도 실패하면 PDF 전용 상호작용층(폴백)으로 간다.

1. 400% 줌에서 두께 1pt 직선이 계단 없이 그려진다(백킹 px = 디바이스 px).
2. A1~A4 적용 후 e2e **30·34·35·53** pass 수가 기준선과 같다.
3. 어댑터 diff가 `AnnotationLayer.tsx`·`annotation/pointer.ts`·`ToolRail.tsx`·호출부 합계 **≤250줄**이다.
4. 활성 페이지 전환 100회 뒤 캔버스 수가 증가하지 않는다(누수 없음).

> **S1 결과(2026-09-14) — 4개 모두 통과, K8 채택.** 스파이크 브랜치 `spike/pdf-m0`의 DEV 하니스(`src/components/pdf/PdfAnnotateSpike.tsx`,
> 가짜 A4 3장 — pdf.js는 S0-1에서 따로 검증)와 게이트 스위트 `tests/e2e/suites/62-pdf-spike.mjs`(31 checks). 모든 회차는
> 앞뒤 `performance.timeOrigin`이 같아 **리로드 없는 유효 회차**다.
>
> | 게이트 | 결과 | 반증(이게 빨개져야 검사가 유효하다) |
> |---|---|---|
> | 1 선명도 | DPR 1.5·400%: page 백킹 4760×6736 = CSS×DPR(오차 0), viewport 2349×1563(오차 0), `imageRendering:auto`. 1pt 사선 스크린샷에서 행별 첫 잉크 x가 같은 최대 연속 행 수 page·viewport **1**. 열 단면 중앙값 부분/완전 커버 px **2/7**. 단, 하니스(`PdfAnnotateSpike.tsx`의 `pageLayout`·`geoOf`)는 페이지 css 박스를 백킹/dpr로 맞추고, 여백·간격·viewport를 디바이스 px/백킹 px 격자로 스냅해 캔버스 원점이 정수 디바이스 px에 놓인 조건이다. 이 스냅 코드는 A.4에서 버릴 하니스에만 있다 | image 백킹 계단 **8**·단면 16/0(계단) · 쌍선형 강제 20/0 · 반 디바이스 px 원점 4/7(둘 다 흐림) → 전부 불합격 판정 |
> | 2 회귀 | 30=95 · 34=30 · 35=13 · 53=56 · 정리 8 → **202/0/0**(기준선과 동일, 수정 후 2회차도 동일) | 기준선 1회차는 문서 저장으로 리로드돼 무효 처리했다 — 검사가 리로드를 잡는다 |
> | 3 diff | AnnotationLayer +/− 93 · pointer.ts 49 · ToolRail 21 · ImageEditor 3 = **166줄** | — |
> | 4 누수 | page 전략·200%(형광펜·사각형 노드)에서 전환 100회(실제 재마운트 100, 오활성 0) 후 강제 GC·풀 유휴 뒤 힙 캔버스 **6개/20.0MP → 6개/20.0MP**(viewport 전략·400%는 게이트 4로 재지 않음) | 요소로 붙잡은 64² 3장 → +3·+12,288px 정확히 검출 · **컨텍스트로만** 붙잡은 3장도 합집합 질의로 +3 검출(요소만 세면 놓칠 수 있다) |
>
> 추가로 스파이크가 고정한 계약(고장 상태를 실제로 재서 빨개짐을 확인한 반증은 VP-1·V2a(VP-1의 옛 원점 비트맵 판정을 공유)·LC-3·LC-4뿐이다. VP-2·VP-3·V2c는 라이브 문서 높이 ≥ 고정 영역×2·원점 ≥5pt 같은 전제만 단언해 헛통과를 막은 추론 반증이다. LC-2는 확정 지표만 LC-3 반증과 같고, buttons≠0 가드 쪽에는 반증이 없다): 스크롤 직후 rAF 전 같은 커밋에서 새 원점 픽셀(VP-1) · 줌 중 viewport·백킹 고정(VP-2) ·
> 실제 CDP 드래그 rect가 page·viewport 두 전략에서 `{120,120,56,40}`로 동일(VP-3) · 원점만 바뀐 스크롤 뒤 캐시 무효화(V2a) ·
> 커서 픽셀 판독 원점 보정(V2c) · 텍스트 입력 중 다른 페이지 누름 → 원래 페이지에 확정(LC-2·LC-3, 확정 생략 경로는 텍스트 유실로 빨개짐) ·
> 화면 밖 비활성 페이지 캔버스 0(LC-4). 리뷰 4관점 → 지적 15건 → 중 이상 9건을 반박자 2명씩 검증 → **8건 확정·수정**(1건 반박).

### 8.3 닫기·전환 가드

- dirty 상태에서 파일 전환, 탭 닫기, doc 창 X를 누르면 확인창을 띄운다. doc 창은 이미지 편집기가 이미 겪은 함정 C를
  그대로 따른다: `onCloseRequested`로 확인한 뒤 `destroy()`. `close()`를 쓰면 확인창이 무한히 다시 뜬다
  (`pro-image-editor-design.md` 부록 C).
- 탭 닫기·파일 전환 경로에 가드를 걸 정확한 지점은 구현 시 `ViewerTab`에서 찾는다. 기존 코드 파일은 가드 대신
  `gp:file-draft` 복구를 쓰므로(`DiffViewer.tsx` recoveredDraft) 선례가 없다 — **미확인**.
- 세션 간 초안 복구(사이드카)는 M3의 `persist.ts` 어댑터로 한다. 봉투의 `imageStamp`를 PDF stamp와 `pages`로
  바꾸고, stamp가 다르면 복구하지 않는다(pro 설계 부록 D의 교훈).

### 8.4 링크·보안

- 외부 링크는 `.annotationLayer a[href]`에서 클릭을 가로채 **항상** `preventDefault` 한 뒤, 스킴이 `http`·`https`·`mailto`일
  때만 Rust 커맨드 `open_external_url`(`commands/browser.rs`)로 연다. **웹뷰가 절대 이동하지 않게 한다.** 내부 링크(목적지)는 `PDFLinkService`가 처리한다.
  (M1 확정) 문서 창에는 `on_new_window`가 없어 `window.open`이 조용히 막히므로 opener 플러그인 대신 전용 커맨드를 두었고,
  스킴 허용목록을 신뢰 경계(Rust)에서 다시 검사한다. Windows `ShellExecuteW`는 프로토콜 핸들러 명령줄의 `%1`에 URL을 원문 치환하므로
  `mailto:a@b" /a "C:/secret` 같은 인자 주입을 막으려고 `"`·공백·제어문자·비ASCII를 `%XX`로 바꾼다(`escape_for_shell_handler`, 기존 `open_external` 호출자 전부에 적용).
- `/Launch` 액션, 첨부파일, JavaScript는 노출하지 않는다(K12).
- 경로 컨테인먼트는 `resolve_in_repo`와 심볼릭 링크 거부를 그대로 재사용한다(§9).

---

## 9. Rust·IPC 계약

```rust
// src-tauri/src/commands/raw_file.rs (신규 모듈 — tree.rs 의 resolve_in_repo · diff.rs 의 stamp_of 재사용)

/// 읽기 전 메타 → stamp. 없거나 못 읽으면 None.
#[tauri::command]
pub async fn file_stamp(state, project_id: String, rel_path: String) -> Result<Option<String>, IpcError>;

/// raw 바이트. 크기를 먼저 보고(> 256MB면 Io) 읽는다 — read_file_base64 의 순서 그대로.
#[tauri::command]
pub async fn read_file_raw(state, project_id: String, rel_path: String) -> Result<tauri::ipc::Response, IpcError>;

/// 본문은 InvokeBody::Raw 여야 한다(아니면 거절). 인자는 헤더로 받는다:
///   x-gpv-project, x-gpv-path-b64   ← 헤더 값은 ASCII만 허용 → 경로는 UTF-8 base64
///   x-gpv-mode: append | replace
///   x-gpv-expected-stamp        ← append면 필수
///   x-gpv-base-len              ← append면 필수, 현재 파일 길이와 일치해야 함
///   x-gpv-overwrite: 0 | 1      ← replace 전용
/// append : stamp·길이 확인 → 같은 폴더 `.<name>.gpv-tmp-<rand>` 로 copy → 본문 append → sync_all → rename
/// replace: tmp 에 본문 write → sync_all → rename
/// 어느 단계든 실패하면 tmp 를 지운다. 성공하면 새 stamp 를 돌려준다.
#[tauri::command]
pub async fn write_file_raw(state, request: tauri::ipc::Request<'_>) -> Result<Option<String>, IpcError>;
```

- **rename은 같은 폴더 안에서만 한다**(볼륨이 다르면 원자성이 없다). Windows에서 다른 프로그램(Acrobat 등)이 파일을
  잡고 있으면 `os error 32`(공유 위반)가 난다. 이때 "다른 프로그램이 이 파일을 열고 있어 저장하지 못했습니다"로 돌려주고 tmp를 지운다(`os error 5`는 현재 일반 "파일 저장 실패" 메시지).
- 256MB 상한은 pdf.js 워커 사본 + pdf-lib 파싱 그래프 + 페이지 캔버스를 합친 메모리 기준이다. S0-3 실측(아래)으로는
  100MB 왕복이 문제없어 **상한을 유지**한다. 256MB 문서의 저장 순간 추가 메모리는 `saveIncremental` 경로에서 파일 크기의 약 2배
  (읽은 입력 + load의 스트림 사본, 이미지 위주 문서 기준) ≈512MB로 추산한다. 스파이크 계측값의 이중 합산을 보정한 추정이고 저장 순간 피크는 M2에서 다시 잰다(§14).
- **구현 위치**: 위 계약이 스파이크 구현(`spike/pdf-m0`의 `commands/raw_file.rs`)과 같다. 경로 헤더를 base64로 한 것은 이미 쓰는 `base64` 크레이트만으로 되고 새 의존성이 없어서다.

> **S0-3 결과(2026-09-14, WebView2 152, 스파이크 앱)** — 병행 세션의 릴리스 빌드와 CPU를 나눠 쓴 상태라 시간은 상한값이다.
> 무결성은 페이지의 '성공' 응답이 아니라 **SHA-256 대조**로 판정했다 — 쓰기는 Node가 디스크 파일을 해시했고, 읽기는 페이지가 받은 바이트의 digest를 Node 계산값과 비교했다.
>
> | 동작 | 결과 |
> |---|---|
> | `read_file_raw` 100MB | 1.74s · `ArrayBuffer` 수신 · 페이지 안 SHA-256 = Node 계산값 |
> | 같은 20MB: `read_file_base64` vs `read_file_raw` | 1.70s vs **0.36s (4.8배, 3회 4.8~5.8배)** · base64는 문자열 2,796만 자 |
> | `write_file_raw` replace 100MB | 3.99s · 디스크 SHA-256 일치 · tmp 잔존 0 |
> | append 1MB(한글 경로 `한글 문서.pdf`) | 52ms · `원본 ⧺ 본문` 바이트 일치 · 새 stamp 반환 |
> | append 길이 불일치 | `CONFLICT` · 파일 불변 · tmp 0 |
> | JSON 본문으로 호출 | "raw 본문이 필요합니다" 거절 |
> | JS 힙(usedJSHeapSize, 1회) | 읽기 전 46MB → 100MB 읽은 뒤 146MB → 종료 167MB · 프로세스 피크 메모리는 미측정 |
>
> `cargo test commands::raw_file` 6/6(추가·길이/stamp 불일치·대상 없음·새로쓰기 보호·한글 헤더). **WebKitGTK(Linux) 대용량 raw 본문은 이 머신에서 확인 불가** — R13 그대로.
- JS 쪽: `invoke("write_file_raw", inc, { headers })` · `invoke<ArrayBuffer>("read_file_raw", …)`. 등록은 `lib.rs`의
  `generate_handler!` 한 줄씩이다(`build.rs`에 앱 매니페스트가 없어 capability 추가는 불필요하다).
- `cargo test`(구현 6건): append 결과가 `원본 ⧺ 본문`과 바이트 일치·tmp 0, 길이·stamp 불일치 거부(파일 불변), 대상 없음 거부,
  replace 새로쓰기 보호, 헤더(한글 base64 경로 디코드·append 가드 누락·잘못된 모드 거부). 경로 탈출 거부는 `resolve_in_repo` 재사용에
  기대며 raw_file 테스트에는 없다(M2에서 추가).

---

## 10. 번들·빌드

| 항목 | 크기(실측) | 처리 |
|---|---|---|
| `legacy/build/pdf.min.mjs` | 519KB | `PdfView` lazy 청크 |
| `legacy/build/pdf.worker.min.mjs` | 1,317KB | `?url` import → 창당 `PDFWorker` 인스턴스 1개를 `getDocument({ worker })`로 공유하고 **절대 destroy 하지 않는다**(M1 확정). `GlobalWorkerOptions.workerPort`는 쓰지 않는다 — 태스크 `destroy()`가 공유 워커까지 죽여, 동시에 열리던 문서(StrictMode·분할 4칸·Git 모달)가 `the worker is being destroyed`로 실패한다. 분할 창에서도 1개 |
| `legacy/web/pdf_viewer.mjs` + `.css` | 468KB + 164KB | lazy 청크 |
| `cmaps/` | 1.5MB | **필수.** 폰트를 임베드하지 않은 한글 PDF가 `Adobe-Korea1-*.bcmap` 없이는 빈칸·깨진 글자로 나온다 |
| `standard_fonts/` | 820KB | 비임베드 Standard 14 폰트용 |
| `wasm/*_nowasm_fallback.js` 2개 | 597KB | `useWasm:false`라 `.wasm`은 복사하지 않는다 |
| `@cantoo/pdf-lib` esm min | 614KB | **편집 진입·저장 때만** lazy import |
| fontkit | 태스크 50과 공유 | — |

- 정적 자산은 `scripts/copy-pdfjs-assets.mjs`가 `public/pdfjs/`로 복사한다. npm `predev`·`prebuild` 훅이라
  `beforeDevCommand`/`beforeBuildCommand`(`tauri.conf.json:7,9`)가 자동으로 거친다. `public/pdfjs/`는 `.gitignore`에 넣는다.
- **`DocWindow.tsx`의 lazy 원칙을 지킨다**(`:21-30` — 정적 import 한 줄이 Monaco를 메인 청크에 인라인시켜 4.41MB가
  된 사건). `PdfView`는 `DiffViewer` 안에서도 `lazy()`여야 한다.
- 설치파일 증가: 약 6MB(추정 합계).
- **플랫폼 차이(S0-2)**: pdf.js는 `cMapUrl`·`cMapPacked`·`standardFontDataUrl`·`wasmUrl`이 **모두** 있고 URL이 http(s)일 때만
  워커 fetch를 쓴다(`legacy/build/pdf.mjs:22004`, 판정 함수 `:7690 isValidFetchUrl`). Windows(`http://tauri.localhost`)는 워커 fetch,
  macOS/Linux(`tauri://localhost`)는 cMap·표준 폰트를 메인 스레드에서 fetch해 넘기는 방식으로 갈린다.
  **JPX·JBIG2 JS 폴백은 이 분기와 무관하게 워커가 `import(wasmUrl + "*_nowasm_fallback.js")`로 직접 불러온다**
  (`legacy/build/pdf.worker.mjs:15545-15556`, `useWasm:false`면 `:15585-15586`에서 곧바로). 그래서 `useWasm:false`여도 `wasmUrl`은 필수다.
  빠뜨리면 모든 플랫폼에서 워커 fetch가 꺼진다. import가 실패해도 경고 한 줄만 남고(`stopAtErrors` 기본 false) 해당 이미지가 조용히 빠진다.
  두 경로 모두 실기로 확인한다.
- **`pdf_viewer.mjs`는 `globalThis.pdfjsLib`에서 API를 꺼낸다**(`legacy/web/pdf_viewer.mjs:5101`). 로더(`pdfjs.ts`)는
  뷰어 모듈을 import하기 **전에** `globalThis.pdfjsLib = await import(".../pdf.mjs")`를 넣어야 한다. 순서가 바뀌면 모듈 평가 시점에 죽는다.
- `@cantoo/pdf-lib`의 ESM 빌드는 JSON을 import 속성 없이 불러온다(`es/packages/standard-fonts/*.json`). Vite 번들은
  이를 처리하지만 **Node ESM에서는 `ERR_IMPORT_ATTRIBUTE_MISSING`으로 죽는다** — Node 테스트·스크립트는 CJS 빌드(`createRequire`)로 부른다.

> **S0-1 결과(2026-09-14)** — 앱 CSP(`tauri.conf.json:15`)를 **그대로** 헤더로 건 페이지를 Edge 153 headless(WebView2 런타임 152와 같은 Chromium 계열)로 구동.
> 위반은 `report-uri`로 서버에서 셌고, **양성 대조군(의도적 eval)이 보고 1건을 만들어** 수집 경로가 살아 있음을 먼저 확인했다.
>
> | 케이스 | 결과 | 대조군 |
> |---|---|---|
> | 비임베드 한글(UniKS-UCS2-H · KSCms-UHC-H) + cMap | 텍스트 "가나다 한글검색" 추출·잉크 6,568px·해당 `.bcmap` 요청 | **cMap 끄면 텍스트 "" · 잉크 0** · "Ensure that the `cMapUrl`" 경고 |
> | JPX 이미지 `useWasm:false` | 빨강/파랑 픽셀 정확 · `openjpeg_nowasm_fallback.js`만 요청 · CSP 위반 0 | `useWasm:true`면 `.wasm` 요청 → **`script-src ← wasm-eval` 위반 1건** → 같은 폴백으로 그림 |
> | `PDFViewer`(legacy) + `PDFFindController` | 텍스트 레이어 span 3개 "가나다 한글검색" · "한글검색" 1건 | 없는 단어 → `NOT_FOUND` |
> | 정상 11건 + 위반이 없어야 할 대조군 3건(B·B2·E2) | **CSP 위반 0건** | 위반 유발 대조군 P(eval)·D(wasm)는 각 1건 |
>
> 1회차는 드라이버가 `/json/new?<url>` 뒤 쿼리를 잘라 **대조군 3개가 본 케이스와 똑같이 나왔다**(헛통과). 파라미터 에코를 결과에 넣고 `Page.navigate`로 바꿔 재실행했다.
> 앱 안의 실제 WebView2(창 CSP·`http://tauri.localhost` 워커 fetch 경로)에서의 재확인은 M1 수용 기준(§12 M1 마지막 항목)으로 넘긴다.

---

## 11. 파일 구성과 규모

| 파일 | 신규/수정 | 대략 LOC | 단계 |
|---|---|---|---|
| `src-tauri/src/commands/raw_file.rs`(신규) · `commands/mod.rs`(+2) | 신규/수정 | ≈310(cargo test 6개 포함, 스파이크 실측 306+2) | M1 읽기 / M2 쓰기 |
| `src-tauri/src/lib.rs` | 수정 | +3 | M1 |
| `src/lib/ipc.ts` | 수정 | +30 | M1 |
| `src/lib/language-map.ts` · `queries/index.ts` | 수정 | +6 | M1 |
| `scripts/copy-pdfjs-assets.mjs` · `package.json` · `.gitignore` | 신규/수정 | +35 | M1 |
| `src/lib/pdf/pdfjs.ts` — 로더·옵션·공유 워커 | 신규 | ≈70 | M1 |
| `src/components/pdf/PdfView.tsx` — 셸·툴바·모드 탭·재로드 | 신규 | ≈380 | M1 |
| `src/components/pdf/PdfThumbs.tsx` · `PdfOutline.tsx` · `PdfFindBar.tsx` | 신규 | ≈280 | M1 |
| `src/components/diff/DiffViewer.tsx` | 수정 | +8 | M1 |
| `src/lib/pdf/space.ts` — viewport 행렬·quad | 신규 | ≈70 | M2 |
| `src/lib/pdf/model.ts` — 봉투·장부·diff | 신규 | ≈120 | M2 |
| `src/lib/pdf/import.ts` — 규칙 1~3·작업 사본 | 신규 | ≈230 | M2 |
| `src/lib/pdf/write.ts` — 사전·AP·ExtGState·폰트 | 신규 | ≈360 | M2 |
| `src/lib/pdf/save.ts` — 파이프라인 §7.1 | 신규 | ≈140 | M2 |
| `src/components/pdf/PdfPageOverlays.tsx` — 정적 오버레이·활성 페이지 | 신규 | ≈260 | M2 |
| `AnnotationLayer.tsx` · `annotation/pointer.ts` · `ToolRail.tsx` · `ImageEditor.tsx`(호출부) · `paint.ts`(머리 기하 export) | 수정 | 스파이크 실측 166(93·49·21·3) + paint.ts, 합계 ≤250(S1 게이트) | M2 |
| 태스크 50 1단계(`fonts.rs`·`fonts.ts`) | 신규 | 50 설계서 기준 ≈290 | M2 선행 |
| `src/lib/annotate/history.ts` | 수정 | 문서 타입 제네릭화 ≈20 | M2 |
| M3: 마크업·이미지·서명·정리 저장·평탄화·persist 어댑터 | 신규/수정 | ≈650 | M3 |
| M4: `PdfPagesGrid.tsx` + 페이지 연산 | 신규 | ≈420 | M4 |
| `tests/e2e/suites/61-pdf.mjs` + 픽스처 생성 (스파이크 62의 게이트 단언을 실제 PdfView 위로 이전·흡수, `PdfAnnotateSpike.tsx`·`62-pdf-spike.mjs`는 삭제) | 신규 | ≈500 | M1~M4 누적 |

**M1 ≈1,100(`raw_file.rs` 실측 전체를 M1에 셈) · M2 ≈1,750(폰트 선행 포함) · M3 ≈650 · M4 ≈420.** 규모 XL. 각 단계는 **그것만 머지해도 출시 가능**하다.

---

## 12. 단계 계획과 수용 기준

### M0 — 스파이크 (코드는 버려도 된다, 1~2일)

| # | 질문 | 통과 기준 |
|---|---|---|
| S0-1 | legacy 빌드 + `PDFViewer`가 WebView2에서 CSP 변경 없이 뜨는가 | 한글 비임베드 폰트 PDF가 cMap으로 정상 표시되고, JPX 이미지 PDF가 JS 폴백으로 표시되며, 콘솔에 CSP 위반이 0건 |
| S0-2 | macOS/Linux 동일 동작 | 같은 픽스처 3종 표시(macOS는 CDP 불가 → 수동) |
| S0-3 | raw IPC 대용량 | 100MB 왕복: WebView2·WebKitGTK에서 `read_file_raw`·`write_file_raw` 성공, 시간·피크 메모리 기록 → §9 상한 확정 |
| S0-4 | 폰트 서브셋 임베드 | Malgun Gothic(TTF)·Noto Sans CJK(OTF/CFF)·Apple SD Gothic Neo(TTC)로 "가나다 ABC" FreeText를 증분 저장 → pdf.js·Edge·Acrobat Reader에서 글리프 정상 |
| S0-5 | 증분 저장 정합성 | 서명 PDF·xref 스트림 PDF·선형화 PDF에 주석 1개 증분 저장 → `qpdf --check` 통과, 서명 유효(서명 리비전 기준) |
| S1 | 엔진 재사용 | §8.2 게이트 4개 |

**M0 판정은 부록 A.** 요약: S1 통과 · S0-1 통과(Edge 153 대리, 앱 WebView2 재확인은 M1) · S0-3·S0-4·S0-5 조건부 통과(우회·제외 규칙 확정) · S0-2는 WebKit 대리 확인만(실기 미수행).

### M1 — 읽기 (P1)

범위: `isPdf` 분기 · lazy `PdfView` · raw 읽기 · `PDFViewer`(연속 스크롤·줌·맞춤) · 텍스트 선택/복사 · `Ctrl+F` 검색 ·
썸네일 · 목차 · 내부/외부 링크 · 암호 입력 · 외부 변경 자동 재로드 · `useDiff` 게이트 · 문서 창 넓게 열기.

- [x] 레포 안 PDF를 열면 첫 페이지가 그려진다. git diff 스폰 0회(invoke 로그로 단언)
- [x] 비임베드 한글 폰트 픽스처의 텍스트 레이어에서 "가나다"를 **검색으로 찾는다**(cMap 동작의 대리 지표가 아니라 직접 단언)
- [x] 외부 링크 클릭 후 **웹뷰 URL이 바뀌지 않는다**, `javascript:` 링크는 아무 일도 없다
- [x] 파일을 외부에서 다시 쓰면 3초 안에 재로드되고 현재 페이지 번호가 유지된다 — 단독 실행 통과, 전체 스위트 1회에서 지연 실패(부록 B.2)
- [x] 암호 PDF: 틀린 암호는 재입력을 요구하고, 맞으면 표시된다
- [x] 200페이지 PDF를 끝까지 스크롤한 뒤 페이지 캔버스 수가 `DEFAULT_CACHE_SIZE`(10, `pdf_viewer.mjs:13109`) + 보이는 페이지 수 이내
- [x] 앱 안 WebView2(`http://tauri.localhost`)에서 비임베드 한글·JPX(`useWasm:false`) 픽스처를 열 때 CSP 위반 0건(`securitypolicyviolation` 수집 + 의도적 위반 양성 대조 1건)이고 JPX 픽셀 색이 일치한다 — S0-1은 Edge 153 headless 대리였다

### M2 — 주석 코어 (P2·P3·P4)

범위: K6 작업 사본 · 가져오기 규칙 1~2 · 사각형·타원·직선·화살표·텍스트·펜·형광펜 · 선택/이동/리사이즈/삭제/undo ·
증분 저장 · 서명 안내 · 암호·권한 읽기 전용 · 닫기 가드 · 폰트 선행.

- [ ] **왕복 픽셀 단언(P3의 핵심)**: 도형 7종을 그린다 → 오버레이 픽셀 샘플 → 저장 → pdf.js로 **새로** 열어 같은 좌표 샘플 → 허용오차 내 일치(§13)
- [ ] 저장 → 다시 열기 → 7종 모두 **선택·이동 가능**(규칙 1 복원). 좌표 ±0.5pt
- [ ] 다른 앱 수정 모사: 우리 주석의 `/C`를 pdf-lib로 바꾼 파일을 열면 규칙 2로 가져오고, 색은 **바뀐 색**이다(해시 검증 동작)
- [ ] 리치텍스트 FreeText·Text 메모·Widget이 있는 픽스처: 저장 전후 해당 객체 사전이 **바이트 동일**(P4)
- [ ] 두 번 저장: 두 번째 저장 후 주석 수가 늘지 않는다(`refs` 갱신)
- [ ] `/Rotate 90` 페이지에서 텍스트 상자를 넣으면 화면에서 똑바로 보이고, 저장본을 pdf.js로 그려도 똑바로 보인다
- [ ] 한글 IME로 "안녕하세요" 입력 → 저장 → 텍스트 레이어 추출값 일치
- [ ] 외부 변경 후 저장: `CONFLICT` 확인창이 뜨고, 취소하면 파일 바이트가 불변
- [ ] append 도중 강제 실패(테스트 훅): 원본 바이트 불변, tmp 파일 0개
- [ ] e2e 30·34·35·53 기준선 유지 + S1 게이트 단언(선명도·VP-1~3·LC-2~4·전환 누수, 62에서 61로 이전) 초록

### M3 — 확장

범위: 텍스트 하이라이트/밑줄/취소선(`PdfMarkup`) · 이미지 삽입(Stamp) · 서명(그려서 앱 데이터에 저장 → Ink로 배치) ·
다른 이름으로 저장 · 정리 저장 · 평탄화 내보내기 · 초안 사이드카(persist 어댑터).

- [ ] 텍스트 선택 → 하이라이트 → 저장본을 Edge에서 열면 같은 영역에 하이라이트(수동), pdf.js 재로드 픽셀 단언(자동)
- [ ] 정리 저장 뒤 파일에서 지운 주석의 `/NM` 문자열 검색 결과가 0건(증분 저장 뒤에는 1건 이상임을 함께 단언 — 검사가 헛돌지 않게)
- [ ] 평탄화 결과에 `/Annots`가 없고 픽셀은 평탄화 전과 일치
- [ ] 앱을 강제 종료한 뒤 다시 열면 초안 배너가 뜨고, 파일 stamp가 바뀌었으면 뜨지 않는다

### M4 — 페이지 관리 (P5)

범위: `[페이지]` 모드는 전체 썸네일 그리드다. 드래그 순서 변경·90° 회전·삭제·빈 페이지 삽입·다른 PDF 삽입·선택 페이지 추출.
변경은 연산 목록으로 쌓았다가 모드를 나갈 때 한 번에 적용하고 pdf.js를 재로드한다. 페이지마다 재로드하면 큰 문서에서 느리다.

- [ ] 순서 변경 후 저장 → 다시 열기 → 페이지의 노드가 **같은 페이지 콘텐츠를 따라간다**(`pageKey` 불변 검증)
- [ ] 회전 후 노드가 페이지 내용에 붙어 함께 돈다, undo가 정확히 복원(이미지 편집기 R7과 같은 단언)
- [ ] 삭제한 페이지의 노드가 사라지고 undo로 돌아온다
- [ ] 추출: 새 파일의 페이지 수·크기 일치, 원본 바이트 불변

---

## 13. 검증 전략

기존 e2e 관례(CDP 구동, 격리 픽스처, `__gpv` dev 노출)를 따른다. 새 스위트는 `61-pdf.mjs`다. 스파이크 스위트 `62-pdf-spike.mjs`의
게이트 단언은 M2에서 실제 PdfView 위로 옮겨 61에 합치고, 62와 하니스는 지운다(부록 A.4).

- **픽스처는 pdf-lib로 테스트 안에서 생성한다**: 흰 A4, `/Rotate 90`, 비임베드 한글 폰트, 리치텍스트 FreeText, 서명 필드,
  xref 스트림. 바이너리 픽스처를 레포에 커밋하지 않는다. 비임베드 폰트 PDF만 생성이 까다로우면
  `tests/e2e/fixtures/`에 작은 파일 1개를 둔다.
- **왕복 픽셀 단언**
  1. 편집 후 페이지 캔버스 위에 형광펜 캔버스를 multiply로, 활성 오버레이를 일반 합성으로 겹쳐(화면과 같은 합성) 좌표 N개를 샘플한다.
     형광펜이 도형과 겹치는 점을 1개 이상 넣는다(/Annots 순서 검증).
  2. 저장한다.
  3. **별도 `getDocument`**로 저장본을 열어 같은 배율로 오프스크린 렌더한다.
  4. 같은 좌표를 샘플한다.
  5. RGB 차이 ≤ 24 이내에서 일치해야 한다(안티앨리어싱 차이 허용). 도형 **내부** 점과 **외곽 밖** 점을 함께 샘플해,
     "아무것도 안 그려도 통과"하는 헛단언을 막는다(메모리: 결함이 있어도 통과하는 단언).
- **구조 단언**: 저장본을 pdf-lib로 열어 `/Annots` 수, `/Subtype`, `/NM`, `/AP /N` 존재를 확인한다. 증분이면
  `startxref`가 2개 이상이고 **파일 앞부분이 원본과 바이트 동일**하다.
- **`__gpv.pdf` 노출**: `getDoc` · `setDoc` · `setTool` · `save` · `renderPageToCanvas` — `import.meta.env.DEV` 가드.
- **수동 교차 확인(자동화 불가)**: Edge·Acrobat Reader·macOS 미리보기에서 M2 저장본 1개씩 열어 모양 확인,
  macOS 전체 흐름(WKWebView는 CDP 불가).

---

## 14. 메모리 예산 (A4 · DPR 1.5 · 창 1개, `w·h·4` 계산)

| 항목 | 100% 줌 | 200% 줌 | 근거 |
|---|---|---|---|
| 페이지 캔버스 1장 | 1191×1684 = 8.0MB | 2382×3368 = 32.1MB | 595×842pt × 96/72 × zoom × 1.5 |
| 버퍼 최대 10장 | 80MB | 321MB | `DEFAULT_CACHE_SIZE = 10` |
| 정적 오버레이 | 노드 있는 페이지만 ×1 | 동일 | §8.2 |
| 활성 `AnnotationLayer` | +2장 = 16MB | +64MB | 씬 + 커밋 캐시(`AnnotationLayer.tsx:1000-1047`, 어댑터 적용 후) — **page 백킹 기준. PDF는 viewport 백킹이라 줌과 무관하게 뷰포트 크기에 묶인다** |
| 오버레이 전체(**S1 실측, 400%·DPR 1.5·형광펜 1개**) | — | — | page 백킹: 힙 캔버스 7개 Σ100.2MP **≈382MiB**(활성 2장 64.1MP + 힙−하니스 DOM 36.1MP: 형광펜 격리 레이어 ≈32MP·스크래치·앱의 다른 캔버스 ≈4MP). viewport 백킹: 7개 Σ15.0MP **≈57MiB**(활성 7.3MP + 기타 7.7MP). 스크롤 영역 ≈1374×850css 기준 |
| pdf.js 워커 | 파일 크기 × ~1 + 파싱 객체 | — | 추정 |
| pdf-lib(편집 진입·저장 순간만) | 파일 크기 × **~2**(`saveIncremental`, 읽어 들인 입력 바이트 포함) / × ~3(`commit`) | — | **S0-3 실측(Node)**: 95MB 이미지 PDF 증분 load 54ms · `commit` 30ms(`saveIncremental`만 따로 잰 시간은 없다. commit이 이를 포함하므로 상한값). commit 경로 RSS(load 후·commit 후 두 지점 최대) +286MB ≈ 입력 95 + load가 스트림을 `slice`로 복사한 95(`PDFObjectParser.js:205`) + commit이 만든 전체 사본 95(`PDFDocument.js:1772`). 스파이크가 기록한 외부 버퍼 +380MB/+190MB는 `external`에 이미 포함된 `arrayBuffers`를 한 번 더 더해 2배로 부푼 값이다. 게다가 380은 commit **전**(load 직후, 입력 포함), 190은 다른 실행에서 입력을 뺀 load+`saveIncremental` 증가분이라 두 API를 비교한 수치가 아니다. 2,000페이지 객체형(1.8MB)은 load 414ms · 힙 +12MB — **시간은 객체 수, 메모리는 스트림 바이트**가 지배한다 |

- **200% 줌 버퍼 321MB는 과하다.** `maxCanvasPixels`를 16MP(=64MB/장)로 두고 `enableDetailCanvas:true`(6.3 기본)로
  확대 시 뷰포트 근처만 선명하게 그린다. 버퍼 크기 조정은 실측 뒤에 한다.
- doc 창마다 별도 WebView2라 **창 수가 곱셈 요인**이다(이미지 편집기 §6.3과 같다).

---

## 15. 리스크 레지스터

| # | 리스크 | 확률·영향 | 완화 |
|---|---|---|---|
| **R1** | 화면 오버레이와 저장된 AP의 모양이 다르다(렌더러 2개) | 중·**높음** | 기하 출처는 `toPathCmds` 하나(K3, §6.2). 텍스트는 같은 폰트 바이트 + 명시적 줄 + 커닝 끔(§6.4). 왕복 픽셀 단언(§13) |
| **R2** | 증분이 다른 내용 뒤에 붙어 파일이 조용히 깨진다 | 낮음·**최상** | stamp + baseLen 필수(§7.1, §9). Rust에서 불일치를 거절하고 `cargo test`로 고정 |
| **R3** | 저장 도중 실패로 원본 PDF가 손상된다 | 낮음·**최상** | tmp → fsync → 같은 폴더 rename(§9). 강제 실패 e2e |
| **R4** | 다른 앱이 고친 주석을 옛 JSON으로 되돌린다 | 중·높음 | AP 해시(K7). 불일치면 표준 키 가져오기 |
| **R5** | 한글 폰트 임베드가 실패하거나 모양이 달라진다 — **EBDT/EBLC 비트맵 테이블을 가진 폰트(굴림 등, S0-4 표 참조)는 서브셋이 `Cannot decode glyph 0`로 실패하고, 가변 폰트는 기본 마스터(Thin)로 박힌다**(S0-4). CFF(Pretendard)·TTC face 선택은 정상이었다 | 중·높음 | 폰트마다 실제로 임베드해 보고 후보를 판정하며(fsType으로는 판정 불가), 가변 폰트는 제외한다(§6.4 6·7항). Apple SD Gothic Neo(TTC)는 미검증 — 사전 검사가 흡수. 비트맵 테이블이 원인이라는 것은 추정(구성 비교로만 확인) |
| **R6** | modern 빌드를 실수로 import하면 **WebKit/Safari 26.2 미만**(Safari 18 이하·26.0/26.1, macOS 버전과 무관)이나 구형 WebKitGTK에서 즉사한다 | 중·높음 | `pdfjs.ts` 한 곳에서만 import하고 경로를 `legacy/`로 고정. 버전은 정확히 고정한다(`^` 금지). **최신 엔진에서는 modern도 돌아가므로(WebKit 26.6 실측, WebView2 152는 caniuse 기준 추정 — 미실측) 이 머신의 e2e로는 실수를 못 잡는다** — 코드 리뷰 체크 항목으로 둔다 |
| **R7** | 비임베드 한글 PDF가 빈칸으로 보인다 | 높음(cMap 누락 시 확정)·높음 | cMap 복사를 빌드 훅에 둔다(§10). M1 수용 기준이 **검색으로 직접 단언**한다 |
| **R8** | 작업 사본 재로드로 화면이 깜빡이고 대용량에서 느리다 | 중·중 | 편집 가능 주석이 있을 때만(§6.3), 주석 모드 첫 진입 1회. 스크롤·줌 복원 |
| **R9** | 지운 주석이 이전 리비전에 남아 민감 정보가 샌다 | 중·높음 | 삭제 시 1회 안내 + 정리 저장(§7.2). 가림 목적 모자이크는 아예 제공하지 않는다(K9) |
| **R10** | `AnnotationLayer` 어댑터가 이미지 편집기를 회귀시킨다 | 중·높음 | 모든 어댑터의 기본값이 기존 동작이다. S1 게이트 + e2e 30·34·35·53 상시 |
| **R11** | 활성 페이지 전환 시 텍스트 편집 중 입력이 유실된다 | 중·중 | 전환 전에 확정 먼저(§8.2). IME 조합 중에는 전환을 보류한다(`isComposing`) |
| **R12** | 대형 PDF에서 메모리가 폭증한다 | 중·중 | 256MB 상한 + `maxCanvasPixels` + detail canvas(§14) + **오버레이 viewport 백킹(S1: 382→57MiB)**. pdf-lib은 `saveIncremental`로 `commit` 대비 원본 크기 버퍼 1벌을 아낀다(파일×~2 vs ×~3, 코드 기준 + S0-3 보정 추정, 저장 순간 피크는 M2 재계측) |
| **R13** | WebKitGTK 대용량 raw 요청 본문 미지원 | 중·중(Linux) | **S0-3에서 WebView2만 확인(100MB 왕복 정상), Linux는 확인 불가로 남음.** 실패하면 Linux만 청크 전송(1회 invoke당 8MB, 임시 파일 누적 후 rename) |
| **R14** | 링크가 웹뷰를 외부 사이트로 이동시킨다 | 낮음·높음 | 클릭 가로채기 + 스킴 허용목록(§8.4), M1 단언 |
| **R15** | pdf.js 6.x의 `PDFViewer` 옵션이 마이너 업데이트에서 바뀐다 | 중·중 | 정확한 버전 고정. 업데이트는 61 스위트 통과를 조건으로 별도 커밋 |
| **R16** | 레이어 풀이 크기 교대로 매 페인트 해제·재할당된다(누수 아님, 비용) | 중·중 | S1에서 발견(`render.ts:81-89 poolFor`). 정적 오버레이를 활성 레이어와 같은 백킹 규칙·크기 버킷으로 맞추거나, 풀을 호스트 인스턴스별로 쪼갠다. M2에서 400% 스크롤 중 할당 봉우리를 계측(강제 GC 없이) |
| **R17** | 형광펜이 화면(투명 오버레이 위 일반 합성)과 저장본(AP `/BM /Multiply`)에서 다르게 보인다 | 높음(검은 글자 위)·중 | 투명 배경 위 multiply는 일반 합성과 같다(W3C 합성식, 추정). §13 왕복 단언 RGB≤24가 검은 글자 위에서 깨진다(산술 추정). Q8에서 결정 |
| **R18** | 스냅 토글(`snap`·`snapPixel`·`grid`)이 이미지 편집기 사용자 설정을 공유한다 | 중·낮음 | `pointer.ts:394-409,443-447`(어댑터 적용 후)이 스토어를 직접 읽는다. PDF에서 snapPixel은 1pt 반올림이 된다. M2에서 호스트별 덮어쓰기 경로(토글 핸들 주입)를 둔다 |
| **R19** | pdf-lib 결함(L2 페이지 정규화·L3 `/Size` 역행)이 업스트림에서 고쳐지거나 동작이 바뀐다 | 중·높음 | 우회 코드에 반증 테스트를 붙인다(S0-5 naive 대조군이 그대로 테스트가 된다). 업스트림 이슈 보고. 버전 정확히 고정 |

---

## 16. 명시적 비범위

| 항목 | 이유 |
|---|---|
| **기존 본문 텍스트 직접 수정**(PDF Expert "Edit Text") | 콘텐츠 스트림 파싱, 폰트 서브셋에 없는 글리프, 재배치까지 풀어야 한다. PDFium·MuPDF급 엔진이 필요하다. 흰 사각형 + 텍스트 상자로 흉내 내는 것은 원문이 남아 R9와 같은 거짓말이 된다. 요구가 확정되면 별도 설계 |
| **진짜 가리기(Redaction)** | 아래 텍스트·이미지 픽셀을 실제로 제거해야 한다. pdf.js·pdf-lib로는 신뢰할 수 있게 불가능하다. 모자이크·블러를 PDF에서 빼는 이유와 같다(K9) |
| 폼 입력(AcroForm 채우기·저장) | 요구가 없다. pdf.js 폼 레이어는 M1에서 **표시**만 한다. 추가 시 pdf-lib 폼 API로 증분 저장 |
| 스티키 노트(Text 주석)·말풍선·구름 테두리·스탬프 라이브러리 | 요구 목록 밖이다. 매핑 규칙(§6.2)에 subtype 한 줄 + AP 빌더 하나로 추가된다 |
| 페이지 사이로 객체 드래그 이동 | 활성 페이지 1장 규칙과 충돌한다. 복사 → 다른 페이지에 붙여넣기로 대체 |
| 거대 PDF의 Range 스트리밍 보기(>256MB) | CSP `connect-src`·CORS 추가가 필요하다. 실사용 보고가 오면 프리뷰 루프백 서버(Range 206 이미 지원)로 올린다 |
| 인쇄 | "외부 앱으로 열기"(기존 `ipc.openIn`)로 넘긴다 |
| 폴더 창(태스크 66)에서 PDF 인앱 열기 | 폴더 창은 레포 밖 경로라 `resolve_in_repo` 계약 밖이다. 현행대로 "기본 앱으로 열기" |
| PDF 비교(diff)·OCR·전자서명 **생성**·암호 설정 | 요구가 없다. 서명 생성은 인증서 관리라는 별도 신뢰 경계다 |
| 여러 PDF 병합 전용 화면 | M4의 "다른 PDF 삽입"이 같은 일을 한다 |
| pdf.js 6.3 실험 API(`pagesMapper`·`extractPages`) | 6.3에 막 들어온 계약이다(`api.d.ts:879,1140`). 페이지 연산은 pdf-lib로 한다 |

---

## 17. 열린 질문 (답이 없으면 기본값으로 진행)

| # | 질문 | 설계 기본값 |
|---|---|---|
| **Q1** | 저장 형태: 주석(다시 편집 가능)인가, 평탄화(페이지에 굽기)인가 | **주석.** 평탄화는 M3 내보내기 옵션 |
| **Q2** | 단계 우선순위 | **M1 → M2 → M4 → M3.** 페이지 관리가 텍스트 마크업보다 PDF Expert 체감에 가깝다고 본다. 반대라면 M3과 M4를 바꾼다(서로 독립) |
| **Q3** | 저장 시점: 명시 저장(`Ctrl+S`)인가, 자동 저장(PDF Expert 방식)인가 | **명시 저장.** 사용자 문서를 조용히 바꾸지 않는다. 대신 M3 초안 사이드카로 유실을 막는다 |
| **Q4** | 한글 폰트가 없는 환경(일부 Linux)을 위해 폰트를 번들할까 | **아니다.** 안내 문구만. 보고가 오면 OFL 폰트 1종(+2~5MB) |
| **Q5** | 텍스트 상자·도형 기본색 | 텍스트 **검정** 14pt, 도형·펜 **빨강 `#FF3B30`**(이미지 편집기와 동일), 형광펜 노랑 |
| **Q6** | 서명 문서에 주석을 넣는 것을 막을까 | **막지 않는다.** 증분이라 서명 리비전은 유효하고, 첫 저장 전 1회 안내만 한다 |
| **Q7** | 지운 주석이 이전 리비전에 남는 것을 기본적으로 정리할까 | **아니다.** 증분이 기본(K4). 삭제가 있는 저장에서만 "정리 저장" 제안 칩을 띄운다 |
| **Q8** | 형광펜 화면·저장 불일치(R17)를 어떻게 푸나 | **형광펜 노드만 CSS `mix-blend-mode:multiply` 전용 오버레이 캔버스에 그린다.** 활성 레이어는 씬 하나로 렌더·히트·선택을 함께 하고(`AnnotationLayer.tsx` `scene` prop), 드래프트·드래그 라이브 노드를 내부 ref로 메인 캔버스에 매 프레임 그리므로(`paintNow`) 호스트만으로는 안 된다. 그래서 **어댑터 A5**(`AnnotationLayer` 안에서 형광펜 노드를 커밋 캐시·라이브 경로 모두 multiply 전용 캔버스로 보냄, 히트·선택은 그대로)를 §8.2와 §11 수정 행(≤250줄, S1 사용 166줄)에 넣는다. 정적 오버레이도 같은 규칙이다. z-order는 "형광펜은 항상 다른 도형 아래"로 고정하고(PDF Expert도 마크업은 도형 밑), 화면·히트·저장 순서가 같도록 **씬 노드 순서에서 형광펜을 앞에 두고**, 저장 때 /Annots도 [타 앱 주석(원래 순서) → 형광펜 Ink → 우리 다른 주석] 순으로 쓴다(§6.2 공통 규칙에 추가). §13 왕복 단언 1단계는 형광펜 캔버스를 multiply로 합성한 결과를 샘플한다. 대안: pdf.js 페이지 캔버스를 `background`로 넘겨 씬에서 합성 — 1px=문서 1단위 계약(`render.ts:136-137`) 때문에 배율 변환이 추가로 필요해 기각 |
| **Q9** | 페이지 전환을 `key` 재마운트로 할까, 레이어 인스턴스 1개를 portal로 옮길까 | **M2는 key 재마운트**(S1 page 전략·200%에서 누수 0 확인). 400% 경계 이동마다 백킹 재할당 가비지가 생기므로(LC-5) 스크롤 체감이 나쁘면 portal 방식으로 바꾼다 |

---

## 18. 미검증 영역 — 정직 고지

- **M0 이후에도 남은 미검증(이 머신에서 수행 불가)**:
  - **실제 WKWebView(macOS)·WebKitGTK(Linux) 앱 안 동작** — S0-2는 Playwright WebKit 26.6(Windows 포트, 같은 JavaScriptCore·WebCore)으로
    **대리** 확인만 했다(S0-1·S0-2는 둘 다 `http://127.0.0.1`). `tauri://` 비 http 경로에서 cMap·표준 폰트의 메인 스레드 fetch와
    **워커의 `tauri://` 동적 import(JPX·JBIG2 폴백)**는 미검증이다.
  - **WebKitGTK 대용량 raw IPC 요청 본문(R13).** WSL에 Ubuntu 24.04(WebKitGTK 후보 2.52.3)가 있어 검증 가능하지만, 빌드 패키지
    약 1GB를 사용자 WSL에 root로 설치해야 해서 하지 않았다.
  - Apple SD Gothic Neo(TTC) 임베드, Acrobat의 서명 후 주석 판정, Acrobat·macOS 미리보기에서 AP 모양.
- ~~`@cantoo/pdf-lib`의 증분 저장이 xref 스트림·객체 스트림 파일에서 온전한지~~ → **S0-5에서 확인**(L1~L3 조건부). 하이브리드 참조 파일은 여전히 미검증.
- ~~pdf-lib 메모리 추정~~ → S0-3 실측(§14, 시간·commit 경로 RSS. 외부 버퍼 수치는 계측 결함으로 보정 추정이고 저장 순간 피크는 M2 재계측). pdf.js 워커 메모리는 여전히 추정.
- pdf.js가 우리 FreeText AP를 그대로 그리는지 → **S0-1·S0-4에서 그대로 그렸다**(pdf.js↔PDFium NCC 0.93~0.97).
- S0-3 시간은 병행 세션 빌드와 CPU를 나눈 3회(부하 37~96%)의 범위다: read 100MB 1.74~2.22s · write 100MB 3.99~5.97s · raw 20MB 0.29~0.36s vs base64 1.66~1.87s.
- **범위 밖 발견(별도 확인 권장)**: 앱 CSP에 `'wasm-unsafe-eval'`이 없고 Tauri가 이를 주입하지 않으므로, 이미지 편집기의
  **AVIF 저장**(`image-codec.ts:86-110`의 `@jsquash/avif` wasm 폴백)이 릴리스 빌드에서 실패할 가능성이 있다.
  WebView2는 캔버스 AVIF 인코딩을 지원하지 않아 항상 wasm 경로다(`DOCS/task/52-image-export.md:59`).
  e2e에 AVIF 케이스가 0건이다. **추정이며 실기로 확인하지 않았다.**

---

## 부록 A — M0 스파이크 판정 (2026-09-14)

작업 위치: 워크트리 `F:\gitpervisor-pdf`, 브랜치 **`spike/pdf-m0`**(미커밋). 라이브러리 검증 스크립트·픽스처·로그는 세션 스크래치
`pdfspike/`(레포 밖). **주의**: `fixtures/`는 11:42에 다시 생성돼(pikepdf ID·서명 키가 매번 바뀜) 11:31~11:38에 만든
`out/s04`·`out/s05` 산출물의 원본과 바이트가 다르다. 재현하려면 `make_fixtures.py` → `s04-fonts.mjs`·`s05-incremental.mjs` →
`validate_s04.py`·`validate_s05.py`를 순서대로 다시 돌린다. 앱 검증은 identifier `com.greathoon.gitpervisor.spike`로 데이터 디렉터리를 분리한 디버그 앱에서 했다.

### A.1 항목별 판정

| # | 판정 | 핵심 증거 | 설계에 반영한 것 |
|---|---|---|---|
| **S0-1** pdf.js·CSP | ✅ 통과(Edge 153 대리 — 앱 WebView2 재확인은 M1 수용 기준) | Edge 153(Chromium)에 앱 CSP 그대로: 비임베드 한글(UCS2·UHC) cMap 추출·렌더, JPX `useWasm:false` JS 폴백, PDFViewer 텍스트 레이어·한글 검색, 정상 11건(+비위반 대조군 3건) CSP 위반 0. 대조군(cMap 끔→텍스트 0, wasm 켬→`wasm-eval` 위반, CSP 양성 대조) 전부 기대대로 | §10 결과 표, `globalThis.pdfjsLib` 순서 계약 |
| **S0-2** macOS·Linux | ⚠️ 대리만 | Playwright **WebKit 26.6**(Windows 포트)에서 legacy 빌드 전 케이스 통과, cMap 대조군 동일. WebKit은 워커 wasm 차단을 `report-uri`로 보고하지 않고 콘솔에만 남긴다. modern 빌드도 26.6에선 동작(`getOrInsertComputed` 존재) | F4·R6 근거 보정(구형 엔진 한정) · §18 |
| **S0-3** raw IPC | ⚠️ 조건부(WebView2만) | 100MB read/write SHA-256 일치, 20MB raw가 base64 대비 4.8~5.8배(3회), append 한글 경로, CONFLICT 시 파일 불변·tmp 0, `cargo test` 6/6. **통과 기준의 피크 메모리는 기록하지 않았다**(JS 힙 usedJSHeapSize 1회만: 읽기 전 46MB → 100MB 읽은 뒤 146MB → 종료 167MB, WebView2 프로세스 피크 미측정) · **WebKitGTK 미확인**(R13). pdf-lib 95MB: 증분 load 54ms·`commit` 30ms, 입력 포함 파일×~2(`saveIncremental`, 보정 추정) / ×~3(`commit`, RSS +286MB). 스크립트의 외부 버퍼 수치(+380/+190MB)는 `external+arrayBuffers` 이중 합산이라 쓰지 않는다 | §9 결과·구현 위치(`raw_file.rs`)·헤더 `x-gpv-path-b64` · §7.1 L1 · §14 |
| **S0-4** 한글 폰트 | ⚠️ 조건부 | Malgun(TTF)·Pretendard(CFF) 정상(두 렌더러), TTC face 선택 정상. **EBDT/EBLC 동반 폰트(굴림·바탕) 임베드 실패**, **가변 폰트는 기본 마스터(Thin)로 박힘** | §6.4 5~7항: 실제 임베드 시도로 판정 · 가변 폰트 제외 |
| **S0-5** 증분 저장 | ⚠️ 조건부 | 4종 문서×4동작 16건: 원본 접두사 동일·qpdf 경고 0·PDFium 16/16·pdf.js 4/16 기대대로. **pdf-lib 결함 2(페이지 정규화 · `/Size` 역행)와 API 함정 1(`commit` 전체 반환)** — 우회 없이 돌린 대조군에서 결함이 재현된다. 서명 유지(intact·valid), pyHanko 변경수준 `OTHER`는 PDFium 대조군도 동일 | §7.1 L1~L3 · §7.4 · R19 |
| **S1** 엔진 재사용 | ✅ 통과 | 게이트 4개(§8.2 결과 표). viewport 백킹이 400% 메모리를 382→57MiB로 줄임. 리뷰 확정 8건 수정 | §8.2 A1(viewport)·A3(엔진 변경 0)·전환 절차 · §14 · R16~R18 · Q8·Q9 |

**M0 결론: M1 착수 가능.** 설계의 뼈대(pdf.js legacy + pdf-lib 증분 + 표준 주석 AP + AnnotationLayer 재사용)는 유지되고,
M0이 바꾼 것은 전부 "어떻게"의 계약이다: pdf-lib 사용 규칙 3개, 폰트 판정 규칙 2개, 오버레이 viewport 백킹, 전환 절차.

### A.2 업스트림 보고 대상 (`@cantoo/pdf-lib` 2.11.0)

1. `PDFPageLeaf.normalize()`가 `addAnnot`/`removeAnnot`처럼 **페이지 콘텐츠와 무관한 조작에서도** 단일 스트림 `/Contents`를 배열로 바꿔 q/Q 스트림으로 감싸고,
   상속 `/Resources`를 페이지로 끌어와 빈 `/Font`·`/XObject`·`/ExtGState`를 넣어 증분 업데이트에서 페이지 콘텐츠를 바꾼다(`cjs/core/structures/PDFPageLeaf.js:141-171`).
   재현: `load(forIncrementalUpdate)` → `getPage(0).node.addAnnot(ref)` → `commit()` 증분에 `/Contents [q원본Q]`.
2. `PDFWriter.createTrailerDict`(`cjs/core/writers/PDFWriter.js:138-146`)가 `PDFWriter` 경로(헤더 1.4 이하 또는 PDF/A-1)에서 새 객체를 만들지 않는 증분의
   trailer `/Size`를 직전 리비전보다 1 작게 쓴다(`PDFStreamWriter` 경로는 `:115`에서 덮어써 영향 없음).
   재현: `%PDF-1.3` 문서에서 주석 제거만 커밋 → `12→16→17→16`(L2 적용 시 `12→14→15→14`). qpdf 경고, pyHanko strict 거부.
3. (문서화 요청) `commit()`이 전체 바이트를 돌려준다는 점과 `saveIncremental(snapshot)`과의 관계.

### A.3 이 스파이크에서 얻은 운영 교훈

- **워크트리 dev 앱에서는 `DOCS/*.md` 저장도 두 창을 전체 리로드한다** — e2e 기준선 1회차가 이것으로 무효가 됐고
  (스위트 30이 `__gpv`를 잃고 34·35·53이 "dev 빌드 아님" skip으로 **다른 얼굴로** 나왔다), 회차 앞뒤 `performance.timeOrigin` 비교로 판정했다.
- 스파이크의 대조군이 **세 번** 헛통과를 잡았다: CDP `/json/new?<url>` 쿼리 절단(S0-1 대조군 3개가 본 케이스와 같은 값), `commit()` 이중 연결(S0-5),
  계단 지표가 쌍선형·반 픽셀 흐림을 못 보는 것(S1). 모두 "고장 났다면 빨개지는가"를 **실제로 고장 내서** 확인한 결과다.

### A.4 다음 단계(M1 착수 전)

1. `spike/pdf-m0`를 main(8ab85eb 이후) 위로 올리고, **스파이크 코드 중 제품으로 남길 것**(raw_file.rs, A1·A2·A4 어댑터, 스위트 62의 게이트 단언)과
   **버릴 것**(`PdfAnnotateSpike.tsx` 가짜 페이지 하니스)을 가른다. 게이트 단언은 M2의 실제 PdfView 위로 옮겨 상시 회귀로 둔다.
2. Q8(형광펜 합성)·Q9(재마운트 vs portal) 확정.
3. 선택: WSL Ubuntu 24.04에 Tauri 빌드 의존성을 설치해 R13(WebKitGTK raw IPC)과 실제 WebKitGTK 동작을 확인(사용자 승인 필요 — 시스템 패키지 설치).

---

## 부록 B — M1 읽기 뷰어 결과 (2026-09-14)

M0 코드(raw IPC·어댑터·스파이크 하니스 62)와 함께 v0.7.0으로 나간다. 스파이크 하니스(`PdfAnnotateSpike.tsx`·스위트 62)는 M2에서 실제 PdfView 위로 옮긴 뒤 지운다.

### B.1 구현과 M1에서 확정한 계약

| 영역 | 파일 | 확정한 것 |
|---|---|---|
| 로더 | `src/lib/pdf/pdfjs.ts` | `pdfjs-dist` **6.3.289 정확 고정** · legacy 빌드 · 창당 `PDFWorker` 1개 `getDocument({worker})`(§10) · `isEvalSupported` 없음(K12) · DEV `__gpv.pdfOpts` 반증 입력은 prod에서 분기째 제거 |
| 자산 | `scripts/copy-pdfjs-assets.mjs` · `predev`/`prebuild` | `public/pdfjs/`(gitignore)에 cmaps·standard_fonts·nowasm 폴백 복사 · `optimizeDeps.exclude`에 pdfjs-dist(첫 PDF에서 재최적화 full reload 방지) |
| 뷰어 | `src/components/pdf/PdfView.tsx` · `PdfFindBar` · `PdfThumbs` · `PdfOutline` · `pdf.css` | `annotationMode ENABLE` · `annotationEditorMode DISABLE`을 **재로드에도** 유지(`enablePermissions` + `MODIFY_CONTENTS`만 뺀 `getPermissions`) · `PDFViewer`에 `abortSignal` 안 넘김(TextLayerBuilder static selection 리스너) · Ctrl+휠 커서 기준 확대 · Ctrl+A는 문서 전체 복사 |
| 외부 변경 | `PdfView.tsx` | 1.5초 stamp 폴링 · `%%EOF`/3초 게이트 · 채택 안 된 로딩 태스크 전부 destroy(§7.3) |
| 링크 | `commands/browser.rs` | `open_external_url` · 스킴 재검증 · 핸들러 인자 주입 이스케이프(§8.4) |
| 라우팅 | `language-map.ts` `isPdf`/`opensInOwnViewer` · `queries/index.ts` · `main.tsx` · `DiffViewer.tsx` | PDF는 `useDiff`·변경 프리페치·문서 창 프리페치에서 제외(git diff 스폰 0) · `DiffViewer` 안 lazy · 직전 파일 placeholder의 상태 배지·정의 예열을 PDF에서 건너뜀 |
| 문서 창 | `floating.ts` | PDF는 1180×860으로 연다 |

M1 리뷰(보안·수명·렌더·접근성 렌즈, 확정 14건·반박 0)가 고친 제품 결함:

- **SEC-1** `mailto:a@b" /a "C:/secret` 링크가 Windows 메일 핸들러 명령줄에 인자를 끼워 넣음 → `escape_for_shell_handler`(Rust 단위 테스트 2개).
- **LC-1** 제자리 재로드 1회 뒤 pdf.js가 편집 모드를 NONE으로 되돌려 `AnnotationEditorUIManager`가 생김(이미지 dragover 가로채기·textarea Backspace 차단) → 권한 경로로 DISABLE 유지.
- **LC-2** 썸네일로 그린 페이지의 오퍼레이터 리스트·ImageBitmap이 사이드바를 닫아도 남음 → 썸네일 페이지 `cleanup()`.
- Ctrl+휠 확대가 커서가 아닌 좌상단 기준 · Ctrl+A가 보이는 페이지만 복사(`hiddenCopyElement` 제거) · 파일 전환 시 직전 상태 배지 누수 · 좁은 폭 툴바 넘침 · 페이지 입력칸·목차 토글·사이드바 탭 접근성 이름 · pdf.js 영어 오류 문구 → 한글.
- **썸네일·목차 클릭 뒤 옛 페이지로 되감김**(6회 중 3회): 원인 둘 — pdf.js 내부 `textlayerrendered` 핸들러의 `div.focus()`가 스크롤을 옮기고(외부 리스너보다 먼저 돈다), 리사이즈 뒤 프리셋 재대입이 스크롤 이벤트로 늦게 갱신되는 `_location`으로 되감는다.
  `pagerender`(텍스트 레이어 렌더보다 동기적으로 먼저 발화)에서 텍스트 레이어 div의 `focus`를 `preventScroll:true`로 감싸고, 재대입 전에 `update()`로 `_location`을 맞춰 8/8.
  `overflow-anchor:none`·포커스 해제·`textlayerrendered`에서 감싸기는 계측으로 효과 없음을 확인했다.

### B.2 검증

| 실행 | 결과 | 비고 |
|---|---|---|
| 스위트 61 단독(최종 수정 뒤 2회) | **87 pass / 0 fail / 1 skip** ×2 | skip = C7(dev 창에는 CSP가 없어 prod 모드 전용) · 정리 8건 포함 |
| 회귀 스위트(3회차) | 03=13 · 30=95 · 34=30 · 35=13 · 53=56 · 51=27 · 62=31 전부 통과 | 52 ×4 · 60 ×1 실패는 화면 잠금(LogonUI) 중 클립보드 — 기준선과 같은 환경 요인 |
| **전체 e2e** | **1376 pass / 9 fail / 19 skip** | 회차 앞뒤 main `timeOrigin` 동일(리로드 없음) · 화면 잠금 상태 |
| C7 prod 모드 | **14 pass / 0 fail / 0 skip** | 아래 B.2.1 |

전체 e2e 실패 9건 판정:

- **5건 — 클립보드(52 ×4, 60 ×1)**: 화면 잠금 중 `The native clipboard is not accessible`(앱 로그 동일 시각). 기준선 1281/5/12의 5건과 같다.
- **1건 — 14 `Ctrl+Shift+↓: 선택 프로젝트 이동`**: 이 워크트리 앱(identifier `.spike`)의 `projects.json`이 비어 있어 목록에 픽스처 하나뿐이다 — 아래로 옮길 대상이 없다. 단독 재실행에서도 같은 값(`A→A`)으로 재현되고, `↑ 원위치 복귀`는 움직이지 않았으니 공허 통과다. 사용자 프로젝트가 있는 dev 앱 기준선에서는 통과하던 항목이다. **환경 요인.**
- **3건 — 61 C4 외부 재기록 재로드와 그 부가 2건**: 전체 실행에서만 1회. 상태는 `read 1→2 · reload 0 · text 'P7-REV-A'`였고, 이어진 C4-b에서 숨김 동안 `read 2` 그대로 → 보이자 `read 3 · reload 1 · 'P7-REV-CCC'`.
  즉 BB 판을 한 번 읽은 뒤 폴링이 멈춰 있다가(`busy`), 다음 판이 들어오며 풀렸다 — `read_file_raw` 또는 뒤따르는 `file_stamp` 응답이 수 초 이상 늦었고 그 사이 파일이 CCC로 바뀌어 BB 판이 "읽는 사이 바뀜"으로 버려진 모양과 맞는다.
  반증 시도: 단독 61 ×2 통과(820ms·412ms) · 문서 창에서 40회 연속 재기록 스트레스 **40/40 재로드**(ipc 거절 0, 800ms 넘는 응답 0).
  **추정: 전체 스위트 부하에서 메인 창 IPC(동시 8슬롯, `file_stamp`는 background 레인이라 프리페치 뒤에 줄 선다) 지연.** 오류 문구·거절을 직접 잡지는 못했다 — 다음에 재현되면 C4 실패 상세에 이번에 추가한 `read·status·error·vis`가 찍힌다.

#### B.2.1 C7 — 앱 WebView2 CSP·JPX (prod 모드)

스위트 61 머리 주석의 절차대로 custom-protocol 디버그 빌드(identifier `com.greathoon.gitpervisor.e2eprod`, target `src-tauri/target/e2e-prod`)를
띄워 `GPV_E2E_ONLY=61`로 돌렸다. 창 origin `http://tauri.localhost`(엉뚱한 앱에 붙지 않았다는 단언 포함).

- 비임베드 한글(`KSCms-UHC-H`) 문서 창 textLayer에 `가나다` — cMap 서빙 경로 동작.
- JPX(`useWasm:false`) 1쪽 픽셀: 빨강 (220,20,20) · 파랑 (20,20,220) · 이미지 밖 흰색 — nowasm 폴백이 CSP 아래에서 돈다.
- 두 문서 모두 페이지 CSP 위반은 **의도적 eval 양성 대조 1건뿐**, 워커는 페이지 스레드로 폴백하지 않았다(`globalThis.pdfjsWorker` 없음 + 번들이 그 전역을 만든다는 반증).
- DEV 훅 누출 0: `dist/assets/*.js`에 `pdfOpts`·`byPath` 0건(같은 grep이 `getDocument`는 찾는다), prod 문서 창 `typeof window.__gpv === 'undefined'`.
- 워커 컨텍스트의 CSP 위반은 판정하지 않았다(수집 수단 없음) — JPX 픽셀과 nowasm 서빙으로 대체했다.

### B.3 범위 밖으로 뒀던 기존 결함 (M1 이전 코드) — **2026-09-16 전부 수정**

셋 다 "조용히 실패"라 e2e 가 못 잡고 있었다. 수정마다 **되돌리면 빨개지는** 단언을 함께 넣었고, 실제로 세 곳을 되돌려 정확히 그 셋만 빨개지는 것을 확인했다.

1. **정의 예열이 placeholder로 먼저 돌았다** — `DiffViewer.tsx` 예열 effect가 새 파일 첫 렌더에서 `keepPreviousData` placeholder(직전 파일 내용)로 돌아 `warmedKeyRef`를 소진했다. 새 파일의 import는 첫 방문에 **영영** 예열되지 않고(기능이 꺼져 있던 셈), 직전 파일 import를 새 확장자 키로 헛조회했다 — `def_query` 미지원 확장자면 심볼당 pathspec 없는 레포 전체 `git grep`이 최대 20개.
   → `isPlaceholderData`를 게이트에 추가. 캐시 히트는 placeholder가 아니라 그대로 돌고, 신규 fetch는 건너뛰는 게 아니라 **미뤄진다**. 가드: 61 `placeholderBlock` 첫 방문 단언.
2. **Monaco `editor.addCommand` 등록 누수** — 반환이 커맨드 id 문자열뿐이라 해제할 길이 없는데 등록은 모듈 전역(CommandsRegistry·`_dynamicKeybindings`)에 쌓이고, 핸들러가 에디터를 붙잡아 dispose된 에디터와 분리된 DOM 서브트리가 남았다(옆 패널 PdfView도 그 안에 딸려 남았다).
   → keybindings를 가진 `addAction`(IDisposable) + `onDidDispose`로 교체(`DiffViewer.tsx`·`MonacoBox.tsx`·`DbWorkspace.tsx`). 덤으로 `when`이 그 에디터로 한정돼 다른 Monaco에서 누른 Ctrl+S가 남의 에디터를 저장하던 경로도 막혔다. 가드: 51 ⑧ 전역 동적 키바인딩 계수(리마운트 전제 동반).
3. **뷰어 탭 메뉴가 탭의 저장소를 버렸다**(추정이 아니라 확인됨) — `ViewerFileTabs.tsx`의 '새 창으로 열기'만 outer id로 열어, 바깥 레포에 같은 상대경로 파일이 있으면 **조용히 그 파일**이 떴다.
   → 탭 클릭·뷰어와 같은 `repoId ?? outerId`. 함께 `DocWindow.tsx`의 `repo://changed` 비교를 outer 기준으로 넓혔다(워처는 최상위 프로젝트 단위로만 emit해서 합성 id 창이 외부 변경을 못 받고 있었다). 가드: 34 — 창 개수가 아니라 **그 창이 읽은 본문**으로 판정.

### B.4 확인하지 못한 것

- macOS·Linux 실기(S0-2는 WebKit 대리만) · WebKitGTK raw IPC(R13).
- SEC-1의 OS 단계(실제 메일 핸들러 명령줄) — Rust 단위 테스트만 있다.
- Acrobat Reader 표시(M1은 읽기 전용이라 파일을 쓰지 않는다 — M2 저장부터 해당).
