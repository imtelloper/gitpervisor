# 태스크 68 — 이미지 뷰어 글자 추출(OCR): OS 내장 엔진 3종을 커맨드 하나 뒤에

> 상태: **구현·검증 완료** (설계 2026-09-17 · 구현 2026-09-18, 미커밋) — 상세 §8 · 대상: gitpervisor ·
> 근거: 코드 실측 2026-09-17(워킹트리 97cbe6c) + 엔진 실측(이 머신 Windows 11 26200, 아래 §2.2)
> **Rust 변경 있음**(커맨드 1개 + 플랫폼 백엔드 3개) · npm 의존성 0 · CSP 변경 0 · 번들 크기 변화 0
> 검증: 전체 e2e **ALL GREEN 1472/0/18**(219s) · `cargo test --lib` 301 passed · `tsc --noEmit` 0.
> **macOS Vision 런타임만 미검증**(mac 부재) — 컴파일은 확인, §4.1 실기가 남아 있다.

## 1. 요구사항

**"이미지를 보고 있을 때 그 이미지의 글자를 뽑아서 복사할 수 있어야 한다. Windows 뿐 아니라 macOS·Linux에서도."**

받아들이는 조건:
- 뷰어(`ImageView`)에서 버튼 하나 → 인식된 글줄이 패널에 뜨고, 드래그 선택·`전체 복사`가 된다.
  한국어·영어 혼합 텍스트가 한 번에 나온다.
- 글줄에 마우스를 올리면 이미지 위 그 자리가 표시된다(어디를 읽었는지 확인).
- 세 OS 모두 **같은 버튼·같은 패널·같은 IPC 계약**. 엔진 차이는 Rust 안에서 끝난다.
- 엔진이 없는 환경(Linux에 tesseract 미설치, Windows에 한국어 OCR 팩 없음, macOS 12 이하)은 **무엇을
  설치하면 되는지**를 토스트로 알려 준다. 회색 버튼·무반응 금지(INDEX §10.4).
- 설치 파일 크기와 CSP는 건드리지 않는다.

## 2. 현황(근거)

### 2.1 코드베이스

- **"이미지 보기"는 세 곳이다.** ① `src/components/diff/ImageView.tsx:106-145` — `DiffViewer`가
  `isImage(target.path)`이면 여기로 온다(`DiffViewer.tsx:255, 835`). `useFileImage` → `ipc.readFileBase64`
  → `<ZoomableImage src="data:…">`. 헤더 한 줄(`:321-345`)에 `편집` 버튼 + 줌 버튼. **이 설계의 대상.**
  ② `ImageEditor`(편집 창, `stores/ui.ts:268` `openImageEditor`) — actions 맵·단축키 표·인스펙터 탭이
  있는 별개 세계. ③ 즐겨찾기 폴더 `Lightbox.tsx:8-41` — **절대 경로**(`fav_read`)라 `project_id+rel_path`
  커맨드 규약 밖. ②③은 §6 비범위.
- **뷰어의 이미지는 파일 원본 그대로다.** 회전·크롭 없음. `<img>`에 `transform: translate(x,y) scale(s)`
  (`ImageView.tsx:387-390`, `view = {scale,x,y}`). → 원본 픽셀 좌표의 상자를 **같은 transform을 준 형제
  div**에 그리면 겹친다. 좌표 변환 코드가 필요 없다.
- **파일 읽기 규약**: `commands/diff.rs:300-335` `read_file_base64` = `project_path` → `validate_rel_path` →
  metadata 크기 검사(25MB, `MAX_IMAGE_BYTES`) → 읽기. `commands/tree.rs:1812` `resolve_in_repo(repo, rel)`가
  canonicalize로 레포 밖을 막는다. 새 커맨드는 이 둘을 그대로 쓴다.
- **외부 CLI 실행 규약**: `tools/runner.rs:210` `find_on_path(name)`(60초 미스 캐시, 셸 스폰 없음) +
  `:287` `run_tool_stdin(bin, args, stdin, cwd, timeout)`. ffmpeg 미발견 문구 선례 `commands/video.rs:183-186`
  (`ErrorCode::ToolNotFound`, "…PATH에 설치하세요"). 프론트는 `TOOL_NOT_FOUND`면 토스트+액션
  (`diff/format-provider.ts:41-46`).
- **플랫폼별 커맨드 스텁 선례**: `proc_icons.rs:76-114` — 같은 이름·같은 시그니처를 `#[cfg(windows)]` /
  `#[cfg(not(windows))]`로 두 번 선언, `invoke_handler`엔 한 번 등록.
- **구조 테스트**: `lib.rs:1499` `hot_commands_stay_async`(HOT 목록의 커맨드는 `#[tauri::command(async)]`
  또는 `pub async fn`이어야 함), `:1548` `no_poison_propagating_unwraps`.
- **의존성**: `windows` 크레이트(WinRT 프로젝션)는 직접 의존이 아니지만 **`windows 0.61.3`이 tao 경유로
  이미 트리에 있고 `windows-core 0.61.2` 한 벌만 쓴다**(`cargo tree -i windows-core@0.61.2`: gitpervisor·
  tao·webview2-com·windows·wry 전부 같은 벌). `Cargo.toml:139-142`가 경고한 "같은 이름 다른 타입" 분리는
  일어나지 않는다. macOS는 `objc2 0.6.4`·`objc2-foundation 0.3.2`가 잠겨 있다. `image 0.25`(png/jpeg/gif/
  webp/bmp)는 Windows·non-Windows 양쪽에 같은 피처로 있다(`Cargo.toml:98-108, 130`).
- **WASM 선례 없음.** CSP(`tauri.conf.json:15`)에 `'wasm-unsafe-eval'`이 없고, pdf.js도 `useWasm:false`
  (`lib/pdf/pdfjs.ts:46-51`). `@jsquash/avif` WASM 경로는 릴리스에서 되는지 미확인
  (`DOCS/pdf-viewer-editor-design.md:786-789`). → 웹뷰 안 WASM OCR은 CSP 변경 + 미검증 경로.
- **클립보드**: 한글 복사는 반드시 `lib/clipboard.ts`의 `copyWithToast(text)` — WKWebView의
  `navigator.clipboard`가 비-ASCII를 깨뜨린다(`clipboard.ts:1-14`).
- OCR 관련 코드·크레이트·패키지: 없음. `DOCS/screen-capture-design.md:544`에 비범위로만 언급.

### 2.2 엔진 실측 (2026-09-17, 이 머신)

픽스처 4장을 GDI(TextRenderer, ClearType)로 렌더해 정답 텍스트와 함께 만들고, 공백 제거·NFC 정규화 후
문자 단위 Levenshtein으로 CER(문자 오류율)을 쟀다. 스크립트·이미지·결과는 세션 스크래치
`ocr-spike/`(render.ps1·cer.mjs·tjs/run.mjs·winocr.ps1).

| 이미지 | 내용 | tesseract.js 7.0 (kor+eng) | Windows.Media.Ocr (ko) |
|---|---|---|---|
| doc-ko-16 (1100×750, 흰 바탕, 맑은고딕 16px) | 릴리스 절차 산문 7줄, 영문 1줄, `latest.json`·`v0.8.1` 등 | **0.234** · 968ms | **0.053** · 288ms |
| doc-ko-24 (같은 글, 24px) | | **0.142** · 798ms | **0.021** · 292ms |
| ui-dark-13 (1200×520, `#1e1e1e` 바탕 `#d4d4d4`, 13px) | 메뉴 라벨·경로·커밋 줄·타임스탬프 | **0.177** · 504ms | **0.271** · 168ms |
| code-ko-13 (Consolas 13px, 다크, 한글 주석) | Rust 12줄 | **0.088** · 1119ms | **0.275** · 389ms |

읽는 법:
- **밝은 바탕 산문은 Windows 엔진이 쓸 만하다**(24px 2.1% = 338자 중 7자, 16px 5.3%). ko 엔진 한 번에
  영문 줄·`latest.json`·`darwin, linux`·`.app.tar.gz`는 정확했지만 같은 출력에서 `package.json`→`package•json`,
  `.sig`→`최g`, `v0.3.2`→`v飜32`, `커밋`→`거밋`도 나왔다(16px; 24px에선 `.`·대소문자 5건). **ko 한 패스로
  간다**는 결정의 근거는 이것이 아니라 다크 이미지의 en-US 실측이다: en-US 엔진은 한글을 전부 깨뜨린다
  (ui 0.448, code 0.479, 글자 절반 누락) → 2차 패스를 붙이려면 단어 상자로 줄별 병합이 필요하고 산문
  이미지의 en-US는 미측정. 이득이 안 보이는 복잡도라 안 한다(R8).
- 지연 시간은 단일 실행값이라 회차 간 최대 2배 차이가 있었다(ui-dark 168 vs 84ms, code 389 vs 194ms).
  표는 1회차. 배율 비교(§3.4 "×2는 1.4~1.9배")는 같은 회차 안에서만 했다.
- **tesseract는 어느 이미지에서도 못 쓴다.** 한글 사이의 ASCII(`package.json`→`09063961500`, `CI`→`C7`),
  들여쓰기 전부 소실, 코드의 `::`·`&`·`!` 파손. kor 단독은 더 나쁘다(ui-dark 0.431). PSM 6은 이미 기본값
  이라 무변화. 자산 8.5MB(worker 0.1 + core 3.9 + kor.gz 1.6 + eng.gz 3.0) + CSP `'wasm-unsafe-eval'` +
  워커 상주 60~100MB가 그 대가다.
- **13px 다크 스크린샷은 두 엔진 다 실패**(27%). 토큰 통째 누락(`main`, `return`), 경로 중간 소실,
  `_` 소실, `l`→`1`. Windows는 code 이미지에서 줄을 조각내 순서도 어긋났다. 16→24px에서 CER이 절반으로
  준 것이 유일한 지렛대 — **확대·반전 전처리 실측은 §3.4.**
- Windows 엔진 특성: `OcrLine`엔 상자가 없고 `OcrWord.BoundingRect`(f32 px, 좌상단 원점)만 있다. 줄 상자는
  단어 합집합. 신뢰도 없음. `OcrResult.Text`는 줄을 공백으로 이어 버리므로 **`Lines[i].Text`로 재조립**.
  `MaxImageDimension` 10000(이 빌드; Win10 구형 2600 보고 있음 → 런타임에 읽는다). 사용 가능 언어
  `en-US`, `ko`(태그가 `ko`라 `IsLanguageSupported(ko-KR)`로 매칭, 문자열 비교 금지).
- **macOS Vision은 이 머신에서 못 쟀다**(mac 없음). 문서상 `VNRecognizeTextRequest` Revision3 = macOS 13+
  에서 `ko-KR` 지원, `.accurate` 레벨. 품질은 Live Text와 같은 엔진이므로 Windows 이상으로 기대하되
  **§4.1 실기 검증 항목**으로 남긴다.

### 2.3 외부(문서 조사, 2026-09-17)

| 항목 | 사실 | 출처 |
|---|---|---|
| `objc2-vision` | 0.3.2(2025-10), `objc2 >=0.6.2,<0.8`·`objc2-foundation ^0.3.2` — 잠긴 버전과 호환. 피처 `VNRequest, VNRequestHandler, VNRecognizeTextRequest, VNObservation, VNTypes, objc2-core-foundation`; `objc2-foundation`에 `NSData, NSError` 추가 | docs.rs/objc2-vision/0.3.2 |
| Vision 입력 | `VNImageRequestHandler::initWithData_options`가 PNG/JPEG 바이트를 직접 받는다. `performRequests_error`는 동기, 백그라운드 스레드 호출이 Apple 샘플의 표준 | developer.apple.com …/vnimagerequesthandler |
| Vision 가용성 | 클래스는 macOS 10.15+, `supportedRecognitionLanguages()`는 **12+**, 한국어는 13+. 앱 최소 macOS는 Tauri 기본 10.13. **그 아래에서 Vision 심볼을 건드리면** objc2가 클래스 못 찾음 패닉(10.13~14) 또는 ObjC 예외로 abort(10.15~11 — `catch-all` 피처 미사용) → 언어 검사가 아니라 **OS 버전 검사가 먼저** | …/vnrecognizetextrequest/supportedrecognitionlanguages() (introducedAt 12.0) · objc2-0.6.4 `__macro_helpers/cache.rs:84`, `macros/mod.rs:983` |
| Vision 상자 | `boundingBox`는 정규화 [0,1], **원점 좌하단**. `y_px = (1 - y - h) · H` | …/vndetectedobjectobservation/boundingbox |
| Vision 순서 | 관측 결과 순서는 읽기 순서로 문서화돼 있지 않음 → Rust에서 (y, x) 정렬(§3.3) | — |
| `windows` 0.61 피처 | `Media_Ocr, Graphics_Imaging, Globalization, Foundation_Collections, Storage_Streams, Security_Cryptography` | docs.rs/crate/windows/0.61.3/features |
| WinRT 스레딩 | `OcrEngine`은 Agile. windows-core 0.61.2 팩토리 캐시가 `CO_E_NOTINITIALIZED`면 `CoIncrementMTAUsage` 후 재시도 → `spawn_blocking` 스레드에서 `RoInitialize` 불필요. `IAsyncOperation::get()`은 이벤트 대기(STA 아닌 스레드에서만) | windows-core-0.61.2/src/imp/factory_cache.rs:87-95 |
| 한국어 OCR 팩 | 케이퍼빌리티 `Language.OCR~~~ko-KR~0.0.1.0`. 설정 › 시간 및 언어 › 언어 및 지역 › 한국어 추가 시 함께 설치 | learn.microsoft.com …/features-on-demand-language-fod |
| Linux tesseract | Debian/Ubuntu `tesseract-ocr tesseract-ocr-kor`, Fedora `tesseract tesseract-langpack-kor`, Arch `tesseract tesseract-data-kor`. `tesseract stdin stdout -l kor+eng --psm 3 tsv` — `stdin`/`-`는 이미지를 std::cin에서 읽고(`pixReadMem`), `stdout`/`-`는 결과를 stdout으로. TSV는 **헤더 1줄** + 12열(`level page block par line word left top width height conf text`), level 4 = 줄, 5 = 단어(그 외 level은 `conf=-1`·빈 text), px 좌상단 원점 | tesseract `src/api/baseapi.cpp`(`ProcessPagesInternal`·`GetTSVText`), `src/api/renderer.cpp`; 패키지명은 각 배포판 검색 |
| leptess | libtesseract-dev·libleptonica·clang 빌드 의존 + 런타임 .so 번들 → CI ubuntu 잡·deb Depends·AppImage 전부 손댐 | github.com/houqp/leptess |

## 3. 설계

핵심 판단 셋: **엔진은 OS 것을 쓴다 · 커맨드는 하나다 · 붙는 곳은 뷰어 헤더 버튼 하나다.**

### 3.1 엔진 선택 — OS 내장 3종, 폴백 없음

| 대안 | 평가 |
|---|---|
| **A. Windows = `Windows.Media.Ocr` · macOS = Vision · Linux = 시스템 `tesseract` CLI** (채택) | 자산 0·CSP 0·npm 0. Windows 품질 실측 통과(산문). macOS는 같은 급 이상 기대. Linux는 사용자 1회 설치(패키지 한 줄). Rust ≈250줄, 백엔드당 50~60줄. |
| B. tesseract.js를 세 OS 웹뷰에서 | 한 경로라는 점만 장점. 실측 CER 0.09~0.23으로 **어느 이미지도 복사용으로 못 쓴다**(§2.2). +8.5MB, CSP `'wasm-unsafe-eval'`(WKWebView·WebKitGTK 지원은 확인됨), 워커 60~100MB 상주. 기각 |
| C. A + Linux에 tesseract.js 폴백 | Linux "무설치"를 얻는 대가가 B의 비용 전부. 품질은 CLI와 같은 tesseract. **열린 질문 Q1**로 넘긴다 — 사용자가 Linux 무설치를 원하면 그때 붙인다(프론트 전용 추가라 A를 안 바꾼다) |
| D. Linux에 `leptess` 인프로세스 | CI 빌드 의존·.so 번들·크래시가 앱을 죽임. 기각 |
| E. 로컬 LLM(태스크 59 llama-server)에 비전 모델 | 2.5GB 모델·GPU 의존·수 초. 스크린샷 한 장 복사에 과함. 기각 |
| F. RapidOCR/PaddleOCR ONNX(`ort`) | 한국어 인식 모델 ≈10MB + onnxruntime 플랫폼별 20~40MB, 새 네이티브 의존. 다크 13px 문제를 풀 가능성은 있으나 미실측. **Q2** |

Linux를 "설치 안내"로 두는 근거: 이 저장소는 이미 ffmpeg·포매터·LSP를 "있으면 쓰고 없으면 설치 안내/
관리형 다운로드"로 다룬다(`tools/runner.rs` 발견 순서 ①명시 ②로컬 ③PATH ④번들). tesseract는 정적
바이너리 배포가 없어 ④가 불가하고, ③만으로 충분하다.

### 3.2 계약 — `ocr_image` 하나, `OcrResult` 하나

```rust
// src-tauri/src/commands/ocr.rs
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct OcrBox { pub x: f32, pub y: f32, pub w: f32, pub h: f32 }   // 원본 이미지 px, 좌상단 원점
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct OcrLine { pub text: String, pub r#box: OcrBox }             // 줄 하나 — UI가 쓰는 건 이 둘뿐
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct OcrResult {
    pub engine: OcrEngineKind,          // "windows_ocr" | "apple_vision" | "tesseract_cli"
    pub languages: Vec<String>,         // 실제로 요청한 것: ["ko-KR"] / ["ko-KR","en-US"] / ["kor","eng"]
    pub lines: Vec<OcrLine>,            // 읽기 순서(§3.3)
    pub text: String,                   // lines.text 를 '\n' 으로 이음 — 클립보드는 이것만 쓴다
    pub warnings: Vec<String>,          // "글자가 작아 2배 확대해 다시 읽음", "10000px 한계로 축소함" …
}
// 단어 상자(Windows·tesseract)와 신뢰도(Vision·tesseract)는 Rust 안에서만 쓴다(줄 상자 합집합·글자 높이).
// IPC로 내보내지 않는다 — §3.6이 읽지 않는 필드를 엔진마다 None 으로 채우는 분기를 만들지 않기 위해.

#[tauri::command(async)]
pub async fn ocr_image(state: State<'_, AppState>, project_id: String, rel_path: String)
    -> Result<OcrResult, IpcError>
```

- 프롤로그는 `read_file_base64`(`diff.rs:302-335`)의 순서 — `project_path` → 경로 검증 → metadata 25MB 검사 →
  읽기 — 에서 경로 검증만 `resolve_in_repo`(`tree.rs:1812`, canonicalize로 레포 밖 차단)로 바꾼 것. 선례보다
  엄격하고 **경로 보안 경계는 새로 만들지 않는다.** `MAX_IMAGE_BYTES`는 private `const`라 `pub(crate)`로 연다
  (`diff.rs` +1). 디코드 전에 `ImageReader::into_dimensions`(헤더만)로 `w·h > OCR_MAX_PIXELS`면 거절(§3.3).
- 블로킹 호출은 `tokio::task::spawn_blocking` 안에서: 디코드·리사이즈, WinRT `.get()`, Vision `performRequests`.
  **Linux는 예외** — `run_tool_stdin`이 이미 async(tokio 프로세스)라 커맨드 본문에서 `.await`. HOT 목록
  (`lib.rs:1500`)에 `("commands/ocr.rs", "ocr_image")` 추가.
- 실패 코드:
  - `ToolNotFound` — 엔진/언어 없음. 메시지에 **설치 방법을 넣는다**(플랫폼별 문구 §3.5).
  - `Io` — 파일 없음·25MB 초과·`image` 크레이트가 못 여는 형식("OCR이 지원하지 않는 형식입니다 (png·
    jpeg·gif·webp·bmp)") · 엔진 내부 오류(HRESULT/NSError 문자열 포함).
- TS: `src/lib/ipc.ts` 이미지 블록(`:1297-1335`)에
  `ocrImage: (projectId, relPath) => call<OcrResult>("ocr_image", {projectId, relPath}, {timeoutMs: 60_000, attempts: 1})`.
  조회 커맨드라 `call`. 같은 인자 진행 중 호출은 합쳐진다(연타 방지가 공짜). `OcrResult`·`OcrLine`·`OcrBox`
  TS 타입을 **같은 커밋**에 둔다.

### 3.3 공통 파이프라인 — 디코드 · 1차 인식 · (작으면) 2배 재인식 · 정렬

```
bytes ─ image::load_from_memory ─▶ RgbaImage ─▶ engine(img, 1×) ─▶ lines₁
   ─▶ needs_upscale(lines₁)?  ── no ─▶ lines₁
         └ yes ─▶ resize ×2 (CatmullRom) ─▶ engine ─▶ lines₂ (상자 ÷ 2) · warning "글자가 작아 2배 확대해 다시 읽음"
   ─▶ order_lines ─▶ OcrResult
```

- **디코드는 `image` 크레이트 한 곳**(세 OS 동일). Vision은 원래 바이트를 직접 받을 수 있지만 2배 패스는
  픽셀이 바뀌므로 어차피 재인코드가 필요하다 → 두 패스 모두 PNG로 재인코드해 넘긴다(`image::codecs::png`
  — 피처 이미 있음). CLI도 같은 PNG 바이트를 stdin으로. 경로가 하나라 "1× 는 원본, 2× 는 재인코드" 분기가
  없다.
- 엔진별 입력: Windows `SoftwareBitmap::CreateCopyFromBuffer(CryptographicBuffer::CreateFromByteArray(bgra), Bgra8, w, h)`
  (RGBA→BGRA는 4바이트마다 `swap(0,2)`). macOS `NSData` PNG. Linux stdin PNG.
- **`needs_upscale(glyph_heights, w, h, limit) -> bool`** — 순수 함수(§3.4). 글자 높이 중앙값 ≤ 14px **이고**
  2배 결과가 엔진 한계(`limit`: Windows `MaxImageDimension`, 그 외 `u32::MAX`)·`OCR_MAX_PIXELS` 안일 때만 true.
  글자 높이 = Windows·tesseract는 단어 상자 높이, Vision은 줄 상자 높이(÷1.2 보정 없이 그대로 — 임계값이
  그만큼 여유 있다). `OCR_MAX_PIXELS = 50_000_000`은 `ocr.rs` 자체 상수다 — 편집기의 `MAX_INPUT_PIXELS`
  (`ImageEditor.tsx:270`)는 TS 상수라 Rust에서 못 쓴다. macOS·Linux엔 엔진 치수 한계가 없어 **이 상수만이**
  ×2 버퍼(50MP RGBA = 200MB + PNG 재인코드)를 막는다. 1× 패스 전 헤더 검사(§3.2)에도 같은 상수.
- **`order_lines(lines) -> Vec<OcrLine>`** — 순수 함수. `y` 기준으로 묶되 행 허용치 = 줄 높이 중앙값 × 0.5,
  같은 행 안은 `x` 오름차순. Windows·tesseract는 이미 읽기 순서지만 Windows가 code 이미지에서 조각을 뒤에
  붙인 실측(§2.2)이 있어 **모든 엔진에 적용**한다. `#[cfg(test)]`로 고정.
- 상자 좌표는 배율을 되돌려 **원본 px**로 통일. Vision은 정규화→px 변환을 `image_height` 기준으로.

### 3.4 전처리 — 실측: 2배 확대만, 그것도 작은 글자에만

같은 픽스처를 System.Drawing HighQualityBicubic으로 2배·3배, ColorMatrix로 반전, 조합 13장을 만들어
Windows 엔진(ko)으로 다시 쟀다(같은 세션 스크래치 `ocr-spike/variants/`, `winocr-variants.ps1`). CER:

| 이미지 (글자 px) | 원본 | ×2 | ×3 | 반전 | 반전+×2 | 반전+×3 |
|---|---|---|---|---|---|---|
| doc-ko-16 (16, 밝음) | **0.053** | 0.112 | 0.305 | — | — | — |
| ui-dark-13 (13, 다크) | 0.271 | 0.105 | 0.121 | 0.265 | **0.099** | 0.127 |
| code-ko-13 (13, 다크) | 0.275 | **0.097** | 0.142 | 0.363 | 0.127 | 0.144 |

읽는 법 — 규칙은 이 표에서 그대로 나온다:
1. **13px 다크 이미지는 ×2로 0.27 → 0.10.** 경로·해시·`main`·`3개`가 살아나고, code 이미지의 **줄 조각남·
   순서 어긋남이 사라진다**(원본 12줄 중 3조각 역순 → ×2는 소스 줄당 1줄, y 단조 증가). 그래도 0.05 목표엔
   못 미친다: 탭→법, `14:32`→`1432`, `session.json`→`sessionjson`, `::`→`: :`, 한 글자짜리 `}` 줄 미검출.
   **이것이 OS 엔진의 상한이다**(Q2).
2. **16px 밝은 산문은 ×2가 해친다**(0.053 → 0.112, ×3은 토큰을 통째로 버린다). → 무조건 확대 금지.
   임계값 14px: 실측점 13(이득)·16(손해) 사이. 100% DPI 스크린샷의 UI 글자(12~14px)는 확대, 150% DPI·문서
   (18px+)는 원본. 14~15px 구간은 미실측 — 상수 하나(`UPSCALE_MAX_GLYPH_PX = 14`)라 실기에서 조정한다.
3. **×3은 어디서도 ×2보다 못하다**(줄 분할 재발). **반전은 이득 0**(1×에서 무변화(ui) 또는 악화(code 0.363),
   ×2 위에서 ui는 −1 편집, code는 **+14 편집**). 회색조도 무변화. → 만들지 않는다.
4. 비용: ×2 패스는 1× 대비 1.4~1.9배(ui 83→116ms, code 194→366ms). 1차 패스가 이미 있으니 **재인식은
   작은 글자 이미지에서만 추가 100~200ms.** 글자 높이는 1차 결과의 상자에서 얻는 것이 픽셀 휴리스틱보다
   정확하고 코드도 짧다(두 패스 = 같은 함수 두 번).

tesseract.js도 같은 변형에서 ×2가 최선이었으나(ui 0.083, code 0.036; doc는 ×2+회색조 0.178 — 순수 ×2는 0.237로
원본 0.234보다 나쁨) 채택 엔진이 아니므로 수치만 남긴다. 확대는 `image::imageops::resize(&img, 2w, 2h, FilterType::CatmullRom)`(bicubic 상당).

한 가지 더 — 코드 스크린샷의 **들여쓰기는 어느 엔진도 텍스트로 주지 않는다.** 단어 상자 X 좌표로 복원할 수
있음을 확인했다(×2에서 첫 단어 X가 48/106/161 → 0/4/8칸, 셀 폭 ≈14.3px). 고정폭일 때만 맞고 "이건 코드다"
신호가 없어 **비범위(Q4)**.

### 3.5 플랫폼 백엔드

**Windows** — `#[cfg(windows)]`, `windows = { version = "0.61", features = [Media_Ocr, Graphics_Imaging,
Globalization, Foundation_Collections, Storage_Streams, Security_Cryptography] }`를 `[target.'cfg(windows)']`에.
```
Language::CreateLanguage("ko-KR") → OcrEngine::IsLanguageSupported(&lang)?
  ├ true  → TryCreateFromLanguage(&lang), languages=["ko-KR"]
  └ false → ToolNotFound "한국어 OCR 팩이 없습니다 — 설정 › 시간 및 언어 › 언어 및 지역 › 언어 추가 › 한국어
            (케이퍼빌리티 Language.OCR~~~ko-KR~0.0.1.0)"
MaxImageDimension() 읽어 초과 시 축소(§3.4의 배율과 합산) · CreateCopyFromBuffer(…, w as i32, h as i32)
RecognizeAsync(&bmp)?.get()? · Lines → 각 line: 단어 BoundingRect ÷ scale → box = 단어 합집합, text = line.Text()
```
ko 한 번만 돌린다(§2.2·R8). 사용자 프로필 언어로 떨어지는 폴백은 **두지 않는다** — 한국어 팩 없는 Windows에서
영어 엔진이 한글 이미지를 읽으면 쓰레기가 각주 하나 달고 나오는데, 그게 §1이 금지한 "무반응"이다. 팩 없음 =
설치 안내 토스트, 다른 두 OS와 같은 모양.

**macOS** — `#[cfg(target_os = "macos")]`, `objc2-vision = { version = "0.3", default-features = false,
features = ["std","VNRequest","VNRequestHandler","VNRecognizeTextRequest","VNObservation","VNTypes","objc2-core-foundation"] }`
+ `objc2-foundation` 피처에 `NSData`, `NSError`.
```
NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion({13,0,0})?   ← Vision 심볼을 건드리기 **전에**
  false → ToolNotFound "한국어 인식은 macOS 13 이상이 필요합니다"
req = VNRecognizeTextRequest::new(); setRecognitionLevel(Accurate); setUsesLanguageCorrection(true)
supported = req.supportedRecognitionLanguagesAndReturnError()?        ← 2차 가드(13+에서 안전)
  ko-KR ∉ supported → ToolNotFound "이 macOS의 Vision에 한국어가 없습니다 (지원: en-US, …)"
setRecognitionLanguages(["ko-KR","en-US"])
VNImageRequestHandler::initWithData_options(png, {}) . performRequests_error([req])?
results → topCandidates(1)[0]: text, boundingBox → px(y 뒤집기: y = (1 − y − h)·H)
```
OS 버전 검사가 먼저인 이유(§2.3 "Vision 가용성"): `supportedRecognitionLanguages`는 macOS 12+라 그걸로
게이트하면 10.15~11에서 ObjC 예외 → abort, 10.13~14에선 클래스 조회 패닉이다. `objc2-foundation` 피처에
`NSProcessInfo`를 더한다. 최소 macOS(10.13)는 안 올린다 — 이 검사 하나가 그 값을 대신한다.
`Retained<VN*>`는 `!Send` → 생성·실행·읽기를 **한 `spawn_blocking` 클로저 안**에서 끝내고 평범한 구조체만
반환. `Retained<VNRecognizeTextRequest>`→`NSArray<VNRequest>`는 `Retained::into_super` 두 번. 잠긴
`objc2 0.6.4`와 호환(§2.3).

**Linux** — `#[cfg(target_os = "linux")]`, 새 크레이트 없음.
```
path = find_on_path("tesseract") ?? ToolNotFound "tesseract가 없습니다 — Debian/Ubuntu: sudo apt install
       tesseract-ocr tesseract-ocr-kor · Fedora: sudo dnf install tesseract tesseract-langpack-kor ·
       Arch: sudo pacman -S tesseract tesseract-data-kor"
bin = ToolBin { path, source: ToolSource::Path }                       (runner.rs:76-79, 필드 pub)
run_tool_stdin(&bin, ["stdin","stdout","-l","kor+eng","--psm","3","tsv"], png, None, 60).await
  exit≠0 · stderr에 "Error opening data file" → ToolNotFound "tesseract 한국어 데이터(kor)가 없습니다 — …"
parse_tsv(stdout): 헤더 1줄 건너뜀 · conf=-1 행은 구조만 · level 4 → 줄(box) · level 5 → 단어(text, box)
                   · 줄 text = 단어 ' ' 이음
```
`parse_tsv`는 순수 함수 + 헤더·구조 행·조각 줄이 들어간 고정 문자열 테스트. `run_tool_stdin`이 타임아웃·
kill_on_drop을 이미 가진다. tesseract는 1~2초에 끝나므로 `spawn_launcher`(cgroup 위임)는 불필요 — `output()`이
회수한다.

**그 외 OS** — `#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]` → ToolNotFound.

### 3.6 뷰어 UI — `ImageView.tsx`만

```
┌ h-8 헤더: [✎ 편집] [T 글자 추출]            3 / 12   [−] 100% [+] [맞춤] ┐
├──────────────────────────────────────────┬───────────────────────────────┤
│  ZoomableImage (기존)                    │ OcrPanel  w-80                │
│   <img transform=…>                      │  ┌ 12줄 · Windows OCR · ko-KR │
│   <div transform=… pointer-events-none>  │  │ 릴리스는 태그 푸시에서…   │ ← hover → 왼쪽 상자 강조
│     └ hover 줄 상자 1개 (absolute, px)   │  │ 버전은 5곳(package.json…  │
│                                          │  │ …                          │
│                                          │  └ ⚠ 2배 확대함              │
│                                          │  [전체 복사]        [닫기]    │
└──────────────────────────────────────────┴───────────────────────────────┘
```

- `글자 추출` 버튼: `ZoomableImage` 헤더의 `편집` 옆(`ImageView.tsx:323`). 누르면 `ipc.ocrImage` → 로딩
  동안 비활성("추출 중…") → 결과를 `ZoomableImage` 로컬 state에. `key={path}`라 파일이 바뀌면 자동 초기화.
  두 번째 누름은 다시 돌린다(캐시 없음 — 0.1~0.4초).
- 패널: 줄마다 `<div className="select-text" onMouseEnter=…>`. 텍스트는 브라우저 기본 드래그 선택이
  여러 div를 가로질러 된다. `전체 복사`는 `copyWithToast(result.text)`. 엔진·언어·줄 수는 머리에 한 줄,
  `warnings`는 꼬리에.
- 강조 상자: `<img>`의 형제 `<div>`에 **같은 `transform` 문자열**을 주고 안에 `position:absolute;
  left:box.x; top:box.y; width:box.w; height:box.h` 하나. `pointer-events: none`. 줌·팬을 따라간다.
- 패널 폭: `w-80 max-w-[40%]`. 뷰어 분할(태스크 64 `SplitView`)엔 최소 폭이 없어 좁은 패널에서 이미지가
  실오라기가 될 수 있다 — 40% 상한 하나로 막는다. 아래로 쌓는 반응형은 만들지 않는다.
- 오류: `TOOL_NOT_FOUND` → `pushToast("error", errorMessage(e))` — 메시지에 설치 방법이 이미 있다.
  그 외 → `pushToast("error", "글자 추출 실패: …")`. `format-provider.ts:41` 패턴.
- 빈 결과(`lines.length === 0`) → 패널에 "인식된 글자가 없습니다". 오류 아님.
- 단축키·actions 맵·인스펙터: 없음(뷰어엔 그런 표가 없다 — `ImageView`는 `useEditorKeys` 밖).

### 3.7 파일 배치

| 파일 | 변경 | 규모 |
|---|---|---|
| `src-tauri/src/commands/ocr.rs` | 신설: 계약 구조체 · `ocr_image` · `needs_upscale` · `order_lines` · `#[cfg]` 백엔드 3 · `parse_tsv` · 테스트 | ≈ +280 |
| `src-tauri/src/commands/mod.rs` | `mod ocr; pub use ocr::*;` | +2 |
| `src-tauri/src/lib.rs` | `invoke_handler`에 `commands::ocr_image` · HOT 목록 1행 | +2 |
| `src-tauri/Cargo.toml` | `[cfg(windows)]` `windows` · `[cfg(macos)]` `objc2-vision` + `objc2-foundation` 피처 3개(`NSData`·`NSError`·`NSProcessInfo`) | +4 |
| `src-tauri/Cargo.lock` | 파생 | — |
| `src-tauri/src/commands/diff.rs` | `MAX_IMAGE_BYTES`를 `pub(crate)`로 | +0 (한 단어) |
| `tests/e2e/run.mjs` | `SUITES`에 54 등록(목록은 하드코딩, 글로브 아님) · 클립보드를 쓰므로 `GLOBAL_RESOURCE`에 `"/54-"` | +2 |
| `src/lib/ipc.ts` | `OcrResult`·`OcrLine`·`OcrBox` 타입 · `ocrImage` 래퍼 | +25 |
| `src/components/diff/ImageView.tsx` | 버튼 · 상태 · 강조 div · `OcrPanel`(같은 파일, 따로 바뀔 단위가 아님) | +110 |
| `tests/e2e/suites/54-image-ocr.mjs` | 신설(§4) | +120 |
| `DOCS/task/00-INDEX.md` | 68 행 | +1 |

## 4. 검증

등급 **큰 것**(CLAUDE.md 「검증」표: 새 IPC 커맨드·`ipc.ts`·새 서브시스템) → 마무리에 **전체 e2e 1회**
(`node tests/e2e/shard.mjs`). 개발 중엔 `GPV_E2E_ONLY=54`로 좁힌다. 여기에 **파일을 읽는 경로·외부 프로세스
실행**이 들어가므로 아래 자동 검사는 크기와 무관하게 지킨다.

**세 백엔드 컴파일 게이트.** 이 머신의 `cargo check`는 `#[cfg(windows)]`만 본다. macOS·Linux 백엔드는
(a) `rustup target add aarch64-apple-darwin` 후 `cargo check --target aarch64-apple-darwin`(objc2 계열은 바인딩뿐이라
통과 가능성이 높다 — 시도해 본다), (b) Linux 타깃은 vendored openssl 빌드 스크립트 때문에 호스트에서 막힐
수 있어 **CI `workflow_dispatch`**(`release.yml`, `tag` 입력에 `v0.0.0-dev`)의 3-OS 매트릭스가 컴파일 게이트다.
릴리스 태그 전에 한 번 돌린다.

- `cargo check`(Windows) · `cargo test --lib ocr` — `parse_tsv`(고정 TSV 문자열, 조각난 줄 포함) ·
  `order_lines`(뒤섞인 입력 → 읽기 순서; 두 단 배치는 y 우선 확인) · `needs_upscale`(중앙값 14 → true,
  15 → false, 2배가 `limit`·픽셀 상한을 넘으면 false, 줄 0개면 false) · 구조 테스트 2개 통과.
- `tsc --noEmit`.
- **e2e `54-image-ocr.mjs`**(53의 픽스처 패턴 — `cdp.eval`로 캔버스에 `fillText` 32px 흰 바탕 3줄
  `"릴리스는 태그 푸시에서 시작한다" / "latest.json 을 생성한다" / "2026-09-17 14:32"` → `write_file_bytes`
  → 뷰어에서 열기):
  1. `글자 추출` 클릭 → 패널 등장, 줄 수 ≥ 3, 결과 `text`에 `릴리스`·`latest`·`2026` 포함(느슨한 포함
     검사 — 엔진 오차 허용, 단 **완전 실패면 빨개진다**).
  2. **같은 `r.check` 안에서** `lines.length ≥ 3` **이고** 모든 상자가 `0 ≤ x, x+w ≤ naturalWidth` 안(빈 배열의
     `every`는 참이라 따로 두면 공허하다). 첫 줄 hover → 강조 div 1개 존재하고 그 `top`이 다음 줄 hover 때보다
     작다(순서·좌표 실검증).
  3. `전체 복사` → 클립보드를 52·60처럼 `cdp.try("term_paste")`로 폴링해 읽어 `text`와 같다
     (`52-terminal-copy.mjs:123`). 공용 헬퍼는 없다 — 스위트 로컬 함수. 잠금화면 감지·skip 선례는 **없다**;
     52·60과 같이 잠금 상태에선 이 단언이 빨개지는 것을 받아들인다(기준선 메모 참조).
  4. `process.platform === "linux"` 이고 `tesseract`가 PATH에 없으면 ①을 `TOOL_NOT_FOUND` 토스트 등장으로
     대체. macOS 12 이하도 같은 분기. 그 외 OS는 `r.skip`.
  5. 반증 절: `ocr_image`를 존재하지 않는 rel_path·레포 밖 경로(`../x.png`)로 `cdp.try` → 오류 코드.
  6. ×2 분기: 같은 세 줄을 **12px**로 그린 두 번째 픽스처 → `warnings`에 "2배"가 있고 `lines.length ≥ 1`.
     텍스트 일치는 단언하지 않는다(13px 실측 상한 0.10). 32px 픽스처는 **`lines.length ≥ 3` 과 함께 한
     `r.check`로** `warnings`가 비어 있어야 한다(줄 0개면 확대 판정이 false라 빈 warnings는 공허하다 —
     16px에서 ×2가 해친 실측의 회귀 검사).
- 개발 중: `GPV_E2E_ONLY=54 node tests/e2e/shard.mjs 1` + 이미지 뷰어 화살표 스위트 `46-image-arrow-nav`
  (태스크 56 것). 마무리: 전체 e2e 1회(위 등급).

### 4.1 실기 (자동화 불가)

- Windows: 실제 스크린샷(다크 테마 앱 화면, 150% DPI) 1장 · 문서 사진 1장. 결과 패널에서 드래그 선택 →
  다른 앱에 붙여넣기.
- **macOS: 반드시 실기.** 이 설계의 Vision 경로는 실측 0이다 — `cargo build` 통과 · ko-KR 인식 · 상자
  y 뒤집기(강조가 글줄 위에 오는지) · macOS 12 머신이 있으면 ToolNotFound 문구.
- Linux: tesseract 미설치 상태 토스트 → `apt install` → 재시도 성공. `tesseract-ocr-kor` 없이 `eng`만 있을 때
  "Error opening data file" 분기.

## 5. 위험

| # | 위험 | 대응 |
|---|---|---|
| R1 | 13px 다크 스크린샷은 ×2 재인식 후에도 CER ≈0.10(탭→법, `14:32`→`1432`) — 사용자가 "OCR이 고장"으로 읽는다 | 상한을 숨기지 않는다: warnings에 "글자가 작아 2배 확대해 다시 읽음"을 실제로 적어 왜 그런지 보이게. 주 용도가 이런 스크린샷이면 Q2(ONNX 엔진 스파이크) |
| R1b | `UPSCALE_MAX_GLYPH_PX = 14` 임계값의 14~15px 구간 미실측 — 16px에서 ×2가 해친 것이 실측이라, 경계 오판이 곧 품질 저하 | 상수 한 곳 + 단위 테스트가 경계값을 고정. 실기(§4.1) 150% DPI 스크린샷에서 확인 |
| R2 | macOS 경로 미실측 — 컴파일은 되는데 런타임에 좌표 뒤집힘·`ko-KR` 목록 형식 차이. macOS 12 이하는 Vision 심볼 접근 자체가 abort/패닉(§2.3) | 버전 게이트(`NSProcessInfo`, §3.5)를 Vision 접근 **앞에**. §4.1 실기 필수 — 13+ 머신 1대, 가능하면 12 이하 1대(ToolNotFound 문구까지) |
| R3 | `windows` 크레이트 피처 추가로 빌드 시간 증가 | 이미 tao가 같은 크레이트를 빌드 중 — 피처 6개는 바인딩 생성만. `cargo build` 시간 전후 비교 1회 |
| R4 | Windows 구형 빌드 `MaxImageDimension` 2600 | 런타임에 읽고 축소. 축소했으면 warnings에 적는다 |
| R5 | Linux에서 tesseract가 1~2초 걸리며 앱 cgroup 안에서 돈다 | `run_tool_stdin`의 타임아웃(60s)·kill_on_drop. 단발 프로세스라 누수 없음 |
| R6 | 큰 이미지(25MB 근처, 8K) 디코드·×2 확대 → 메모리(50MP RGBA = 200MB) | 헤더 검사로 `OCR_MAX_PIXELS` 초과는 디코드 전 거절, ×2는 같은 상수·엔진 한계 안에서만(초과분은 확대 생략 + warning). macOS·Linux엔 엔진 한계가 없어 이 상수가 유일한 방어 |
| R7 | `call`의 8초 기본 타임아웃 | 래퍼에 60s·attempts 1 명시(readFileRaw와 같음) |
| R8 | ko 단일 패스가 ASCII 토큰을 깨는 사례(`package•json`, `v飜32`, `.sig`→`최g`) — en-US 2차 패스+단어 상자 병합의 이득은 미실측(산문 이미지에 en-US를 안 돌렸다) | 지금은 단일 패스. 실기에서 버전 문자열·파일명 파손이 잦으면 doc 픽스처에 en-US를 돌려 병합 이득을 재고 결정 |

## 6. 하지 말 것 (비범위)

- 편집 창(`ImageEditor`) 통합 — actions 맵·단축키·인스펙터 탭 셋을 건드려야 한다. 뷰어에서 되면
  "편집 창에서도"는 별도 태스크(같은 `ipc.ocrImage` 재사용, 좌표는 `oriented` 기준으로 변환 필요).
- 즐겨찾기 `Lightbox` — 절대 경로 커맨드(`fav_*` 계열) 별도.
- 영역 지정 OCR · 인식 텍스트를 텍스트 노드로 삽입 · 이미지 전체 검색 인덱싱 · 열 때 자동 OCR · 결과 캐시.
- 언어 설정 UI — ko(+en) 고정. 다른 언어가 필요해지면 설정 한 줄(Q3).
- tesseract.js 폴백(Q1) · ONNX 엔진(Q2) · 코드 들여쓰기 복원(Q4).
- 반전·회색조·×3 전처리 — 실측에서 이득 0(§3.4). 만들지 않는다.

## 7. 열린 질문 — 사용자 결정

- **Q1. Linux 무설치가 필요한가?** 지금 설계는 `apt install` 한 줄을 요구한다. 무설치를 원하면 Linux에서만
  tesseract.js(+8.5MB 자산, CSP `'wasm-unsafe-eval'` 1줄, 프론트 전용 추가)를 붙인다. 품질은 CLI와 같은
  tesseract라 §2.2 수치 그대로다.
- **Q2. 다크 13px 스크린샷이 주 용도인가?** 그렇다면 OS 엔진으로는 §3.4 전처리 후에도 한계가 남을 수 있다.
  그때는 F(ONNX RapidOCR) 실측 스파이크가 다음 단계다.
- **Q3. 한국어·영어 외 언어**가 필요한가(일본어·중국어 스크린샷)? 설정 값 하나로 확장 가능하되 지금은 안 만든다.
- **Q4. 코드 스크린샷의 들여쓰기 복원**이 필요한가? 단어 상자 X로 복원 가능함은 확인했다(§3.4). 고정폭 판정
  신호("코드로 취급" 토글 등)가 필요해 UI가 하나 늘어난다.

---

## 8. 구현 결과 (2026-09-18)

설계대로 갔다. 계약(§3.2)·2패스 파이프라인(§3.3)·전처리 규칙(§3.4)·백엔드 3종(§3.5)·뷰어 UI(§3.6)
전부 그대로이고, 아래 셋만 구현하며 정해졌다.

### 8.1 설계와 달라진 것

- **`OCR_MAX_PIXELS`를 커맨드 프롤로그에서도 본다.** §3.3은 ×2 판정에만 썼는데, 헤더만 읽어
  (`ImageReader::new(Cursor)` → `into_dimensions`) 1× 디코드 **전에** 같은 상한으로 거른다.
  안 그러면 50MP짜리 200MB 버퍼를 일단 잡았다가 버린다.
- **`parse_tsv`가 한 줄의 단어를 `left` 오름차순으로 잇는다.** §3.5에는 "단어 ' ' 이음"만 있었다.
  tesseract가 방출 순서를 어긋나게 준 줄이 통째로 뒤섞이는 것을 막는다. 정상 출력에선 무연산.
- **`parse_tsv`·`flush_tsv_line`을 `#[cfg(target_os = "linux")]`로 가두지 않았다**
  (`#[cfg_attr(not(linux), allow(dead_code))]`). 가두면 개발·검증 머신이 Windows라 §4가 지정한
  `cargo test --lib ocr`에서 이 파서의 검증이 통째로 사라진다.

### 8.2 실측으로 드러난 것 — 교차 타깃 검사가 실제로 값을 했다

이 호스트에서 `cargo check --target aarch64-apple-darwin`은 **의존성 빌드 스크립트**에서 죽는다
(`objc2-exception-helper`의 `cc: error: unrecognized command-line option '-arch'` — Apple clang 부재).
Linux 타깃은 `gdk-pixbuf-sys`에서 죽는다(GTK 시스루트 없음). **둘 다 gitpervisor 크레이트에 닿기도
전이라 우리 코드에 대한 판정이 아니다.**

그래서 `vision_recognize`를 스크래치 크레이트(objc2-foundation·objc2-vision·image만 의존)에 그대로
복사해 같은 타깃으로 검사했더니 **진짜 API 오류 3건**이 나왔다: `NSArray::iter()`가
`NSEnumerator` 피처를 요구(→ `to_vec()`), `VNImageRequestHandler::alloc()`에 `use objc2::AnyThread`
누락, 그리고 같은 `iter()` 문제가 `results()`에도. **이 우회가 없었으면 셋 다 CI까지 갔다.**
Linux 쪽은 `tesseract_recognize`가 쓰는 것이 전부 플랫폼 중립이라 cfg 게이트를 잠시 풀어
호스트에서 타입 검사하고 복원했다.

`Cargo.lock`이 §2.3의 핵심 가정을 확인해 준다 — **새 `windows` 버전 항목이 생기지 않았다.**
tao 경유 0.61.3에 합쳐졌고 `windows-core`도 0.61.2 한 벌이다. 진짜 신규 크레이트는 `objc2-vision` 하나.

### 8.3 검증

| 검사 | 결과 |
|---|---|
| `cargo test --lib` 전체 | **301 passed / 0 failed** (그중 `ocr` 6개) |
| `tsc --noEmit` | 오류 0 |
| e2e 54 단독 | **13/13** — 실제 인식 결과 `릴리스느 태그 푸시에서 시작한다 / latest.json 을 생성한다 / 2026-09-17 1432` |
| 전체 e2e (`shard.mjs`, 3샤드) | **ALL GREEN 1472 pass / 0 fail / 18 skip · 219s** (기준선 1449/0/18) |
| 변이 검증 | `order_lines` 무력화·`flush_tsv_line` 단어 정렬 제거·`rename="box"` 변경 → 각각 해당 단언이 빨개짐 |

e2e 54가 실제로 재는 것: `ocr_image` 계약(엔진·언어·줄 수·텍스트 포함) · 상자가 원본 px 안이고
읽기 순서로 증가 · 32px는 확대 안 함 / 12px는 `2배` 경고 · 패널 렌더 · hover 강조가 정확히 1개이고
둘째 줄이 첫 줄보다 아래 · [전체 복사] 클립보드(센티널 선행) · [닫기] · 레포 밖 경로와 없는 파일 거부.

### 8.4 이 작업이 깨뜨렸다가 고친 것

**스위트 46의 형제 카운터가 `counter="null"`로 죽었다.** 46은 툴바를 `box.previousElementSibling`로
짚는데, §3.6의 패널을 붙이려고 이미지 박스를 `[이미지 | 패널]` 행으로 한 겹 감싸면서 그 관계가
끊겼다. 주변 검사(ArrowDown 이동·경로)는 전부 통과해서 **데이터가 아니라 셀렉터 문제**임이 드러났다.
툴바에 `data-image-toolbar`를 주고 46이 이름으로 짚게 고쳤다 — 위치로 짚으면 다음 레이아웃 변경에
또 깨진다. 이 저장소가 이미 `data-inspector-tab`으로 쓰는 방식이다.

### 8.5 이 작업과 **무관한** 실패 하나 (환경)

첫 전체 회차에서 PDF 3건(`(C2 자산) bcmap`·`(C2) Ctrl+F '가나다'`·`(부가) JPX`)이 깨졌는데 원인은
**`public/pdfjs/`가 비어 있던 것**이다. 이 폴더는 gitignore 대상이고 `scripts/copy-pdfjs-assets.mjs`가
채우는데, 그 스크립트는 npm `predev`/`prebuild` 훅에만 걸려 있고 **e2e 드라이버는 vite를 직접 띄워
그 훅을 건너뛴다**(`shard.mjs:443`). 서명이 확실하다 — 자산 검사 detail에서 `cmap`·`nowasm`·**일부러
없는 경로까지** 셋 다 `{"ok":true,"type":"text/html","bytes":735}`(SPA 폴백)였다. 스크립트를 돌려
복구했고 재회차는 ALL GREEN이다. **드라이버가 vite를 띄우기 전에 이 스크립트를 부르게 하는 것이
근본 수정이지만, 이 태스크 범위 밖이라 손대지 않았다.**
