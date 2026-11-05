# 태스크 76 — 사진 뷰어·편집 (Windows 사진 앱 수준)

> 상태: **구현 완료 · Rust 528 · e2e 이미지 17개 스위트 통과 · dev 앱 실동작 확인** (2026-11-05, §6) · 대상: gitpervisor ·
> 근거: 코드 실측 2026-11-05(main `83a1a63` + 워킹트리) ·
> 선행: 태스크 66(즐겨찾기 폴더 창), 68(이미지 OCR), 42/48/51(이미지 편집기), v0.15.1(폴더 창 다중 선택·Delete·라이트박스 회전)

## 1. 요구사항

사용자 요청(2026-11-05): 폴더 창에서 사진을 크게 볼 때 **Windows 사진 앱처럼** 기능을 다양하게. 스크린샷 두 장이 기준이다.

**뷰어(스크린샷 1)**
- 위: [편집] · 회전 · 삭제 · (인쇄·공유) · ⋯ 더보기 · 가운데 파일 이름 · [다른 프로그램으로 열기 ▾]
- 아래: 필름스트립 토글 · 슬라이드쇼 · 형식(JPEG) · 해상도(3024×4032) · 파일 크기(4MB) · 정보(i) · 글자 인식 ·
  맞춤 · 배율(35% ▾) · 축소 · 배율 슬라이더 · 확대 · 전체 화면

**편집(스크린샷 2)**
- 위: 확대 · 축소 · 1:1 · 다시 설정 · 실행 취소 · 다시 실행 · 도구(자르기 · 조정 · 필터 · 그리기 · 지우기 · 배경) ·
  [저장 옵션 ▾](저장·사본으로 저장) · [취소]
- 자르기: 각도 보정 슬라이더(0°) · 왼쪽/오른쪽 90° 회전 · 비율(자유 …) · 좌우/상하 뒤집기

받아들이는 조건: 위 항목 가운데 **AI 기능(지우기·배경 흐림)·인쇄·공유를 뺀 전부**가 폴더 창 사진에서 동작한다 —
즐겨찾기 폴더(프로젝트 밖)와 프로젝트 폴더 모두. 세 OS.

## 2. 현황(근거)

- **라이트박스** `components/folder/Lightbox.tsx` — 원본을 `fav_read`(base64)로 읽어 `<img>` 하나. 있는 것: ←/→,
  n/N, Esc, Delete(휴지통), 보기 회전(R), [편집](프로젝트 폴더에서만). 줌·팬·정보·필름스트립 없음.
  키보드는 쓰는 쪽(FolderWindow·FolderPeek)이 건다.
- **폴더 창** `FolderWindow.tsx` — `DocWindow` 의 `folder` 분기로 **따로** 그려진다(`DocWindow.tsx:62`) — 이미지 편집기
  호스트(`FileDocWindow` 의 `<ImageEditor/>`)가 이 창엔 없다. 즐겨찾기 모드는 절대경로만 있고 `projectId` 가 없다.
- **fav_* 커맨드** `commands/favorites.rs` — `fav_list/read/open/delete(배열)/rename`, 썸네일 스킴. 전부 `allowed()`
  (즐겨찾기 루트 + 등록 프로젝트 루트, `.git` 거부) 게이트. **쓰기 커맨드가 없다.** HEIC 등은 `still_image.rs`(ffmpeg).
- **이미지 편집기** `components/image/ImageEditor.tsx`(4170줄) — 사진 앱 편집보다 넓다: 자르기(자유·원본·1:1·3:2·4:3·
  16:9·사용자), 각도 보정, 90° 회전, 뒤집기, 주석 22종, 지우개·모자이크·흐림, 실행 취소/다시 실행·히스토리, 다시 설정,
  줌(맞춤·100%), 제자리 저장·다른 이름 저장, 형식(PNG/JPG/WebP/AVIF)·품질. **모자란 것: 보정이 밝기·대비·채도 3개뿐
  (`filterStr`, ImageEditor.tsx:1173 — 캔버스 CSS 필터), 필터 프리셋 없음.**
  프로젝트 결합은 셋뿐이다: 읽기 `ipc.readFileBase64(projectId, path)`(:1088), 저장 `useSaveImage` →
  `write_file_bytes(project_id, rel, b64, overwrite, expected_stamp)`(tree.rs:489), 자동저장 사이드카
  (`image_doc_*` — 전부 `if (!projectId || !relPath) return` 가드, 선택적). e2e 30 이 편집기 버튼 문구·마운트에 기댄다.
- **OCR** `commands/ocr.rs` — `ocr_image(project_id, rel_path)` 는 프롤로그(읽기·디코드) 뒤 `recognize_two_pass(img)`
  (pub(crate)). 결과 패널 `OcrPanel` 은 `diff/ImageView.tsx` 안 비공개 함수.
- **클립보드 이미지** `lib/clipboard.ts copyImage(pngBytes)` 있음. **EXIF 파서 없음**(크레이트도 없음).
  **전체 화면 권한 없음**(`capabilities/default.json` 에 `set-fullscreen` 없음).

## 3. 설계

### D1. 뷰어 = 라이트박스를 키운다 (`PhotoViewer`)
`Lightbox` 를 `PhotoViewer`(폴더 창·타이틀바 미리보기 공용, props 로 기능을 켠다)로 확장한다. 새 파일로 나누되
(뷰어 본체 / 줌·팬 훅 / 정보 패널 / 필름스트립) **키 처리 규약은 그대로** — 이동·닫기·삭제는 쓰는 쪽, 뷰어 내부 상태
(줌·회전·패널·슬라이드쇼)에 딸린 키는 뷰어가 받는다.

배치(사진 앱과 같은 자리):
- 위 줄: [편집] · ↺ · ↻ · 🗑 · 📋(이미지 복사) · ⋯(좌우 뒤집기·상하 뒤집기(보기) · 회전한 대로 저장 · 경로 복사 ·
  이름 바꾸기 · 탐색기에서 보기) · 가운데 이름 · n/N · [다른 프로그램으로 열기 ▾](기본 앱 · 탐색기) · ✕
- 아래 줄: 필름스트립 토글 · ▶ 슬라이드쇼 · 형식 · W×H · 크기 · ⓘ 정보 · 글자 인식 · 맞춤 · 배율 % ▾(맞춤/25/50/100/200/400) ·
  − · 슬라이더 · + · 전체 화면

### D2. 줌·팬
- 상태 `{ mode: "fit" | "free", scale, x, y }`. "fit" 은 창 크기가 바뀌어도 맞춤을 유지한다. 장을 넘기면 fit 으로.
- 휠 = 커서 기준 확대/축소(사진 앱 기본), 드래그 = 이동(확대 시), 더블클릭 = 맞춤 ↔ 100%, `+`/`-`/`0`(맞춤)/`1`(100%).
- 범위 1%~1600%. 회전·뒤집기(보기)는 같은 변환에 합친다(`translate · scale · rotate · scaleX/Y`).

### D3. 하단 정보
형식(내용 스니핑 우선, 없으면 확장자) · 원본 해상도(디코드한 natural 크기; HEIC 는 변환본 = 원본 크기) · 파일 크기(목록의 `size`).

### D4. 필름스트립
아래 줄 위에 높이 ~72px 띠. 썸네일은 그리드와 같은 `favThumbUrl(…, 128)` 스킴(캐시 공유). 현재 장 강조·자동 스크롤,
클릭하면 이동. 켜짐 여부는 기억(localStorage).

### D5. 슬라이드쇼
3초 간격, 끝에서 멈춤(순환 없음 — 태스크 56 규약). Space 로 시작/정지, 다른 조작(이동·줌·편집)을 하면 정지.

### D6. 정보 패널 — `fav_image_info(path)` (신규, Rust)
`{ format, width, height, bytes, modifiedMs, exif: { takenAt?, make?, model?, lens?, exposure?, fNumber?, iso?,
focalLength?, orientation?, gpsLat?, gpsLon? } }`. EXIF 는 **최소 파서를 직접 쓴다**(새 크레이트 없음): 앞 1MB 에서
TIFF 헤더(`II*\0`/`MM\0*`)를 찾아 IFD0 → ExifIFD(0x8769) → GPS(0x8825) 의 필요한 태그만. JPEG(APP1)·HEIC(Exif 항목)
모두 같은 방법으로 잡힌다(실측: HEIC 안 Orientation 3/6 이 ffprobe 회전과 일치). 오프셋·개수는 범위 검사 — 깨진 EXIF 는
"없음"이지 오류가 아니다. 경로·폴더·수정 시각과 함께 오른쪽 패널(경로 복사 버튼).

### D7. 글자 인식 — `fav_ocr_image(path)` (신규, Rust)
`allowed()` → 바이트(웹뷰가 못 그리는 형식은 `still_to_jpeg`) → 기존 `decode_rgba` + `recognize_two_pass`. 결과 패널은
`ImageView` 의 `OcrPanel` 을 **그대로 옮겨** `diff/OcrPanel.tsx` 로 공유한다(로직 변경 없는 이동). 줄에 호버하면 그림
위 상자(이미지 뷰어와 같음 — 줌·회전 변환을 따라간다).

### D8. 전체 화면
창 API `getCurrentWindow().setFullscreen()` + 권한 `core:window:allow-set-fullscreen`·`allow-is-fullscreen`.
F11·버튼. 전체 화면에서 Esc 는 먼저 전체 화면을 끈다.

### D9. 이미지 복사
보이는 그대로(보기 회전·뒤집기 포함) 캔버스 → PNG → `copyImage`. 뷰어가 열려 있을 때 Ctrl+C = 이미지 복사
(목록에서는 종전대로 경로 복사).

### D10. 편집 — 기존 이미지 편집기를 **경로 모드**로 연다
새 편집기를 만들지 않는다(사진 앱 편집 기능의 상위집합이 이미 있다). 결합 셋만 끊는다:
- 스토어: `openImageEditorAbs(absPath)` — `imageEditorPath` 에 절대경로, `imageEditorAbs: true`(닫으면 false).
- 읽기: `favRead(path)` (응답에 `stamp` 추가 — `diff.rs stamp_of` 와 같은 값).
- 저장: **`fav_write_image(path, base64, overwrite, expected_stamp) -> stamp`** (신규, Rust) — 상위 폴더 `allowed()`,
  이름 성분 검사(트리와 같은 규칙), 64MB 상한, 심볼릭 링크 거부, 원자적 쓰기(`write_atomic`), `expected_stamp` 불일치면
  `Conflict`, 있는데 `overwrite=false` 면 `AlreadyExists` — `write_file_bytes` 와 **같은 오류 계약**이라 편집기의
  덮어쓰기·외부 변경 확인 흐름이 그대로 돈다.
- 경로 계산: 편집기의 dir/base 분해가 `\` 도 구분자로 다루게(절대경로 Windows).
- 자동저장 사이드카·프로젝트 이름 표시: 경로 모드에선 끈다(가드가 이미 null 을 받는다).
- 폴더 창이 `<ImageEditor/>`(lazy)와 `<ConfirmHost/>` 를 단다. [편집]은 **두 모드 모두** 이 창 안에서 연다(프로젝트
  폴더도 `allowed()` 가 받는다). 저장하면 목록·썸네일·뷰어가 새 파일을 보인다(목록 다시 읽기 — 스탬프가 바뀌어 썸네일
  키도 바뀐다).

### D11. 회전한 대로 저장
⋯ 메뉴. 보기 회전·뒤집기를 파일에 굽는다 — 캔버스로 그려 **같은 형식**으로 인코딩(JPEG 품질 0.92)해 `fav_write_image`
(overwrite, expected_stamp). JPEG 는 다시 압축되므로 확인창을 띄운다. 웹뷰가 못 그리는 형식(HEIC 등)은 메뉴를 끈다
(같은 형식으로 쓸 인코더가 없다 — 편집기에서 다른 형식으로 저장하라고 안내).

### D12. 편집기 보정 확장 + 필터 프리셋
조정 탭에 **노출 · 밝은 영역 · 어두운 영역 · 따뜻함 · 색조 · 비네트** 슬라이더(기본 0 = 변화 없음)와 **필터 프리셋**
(원본·흑백·세피아·선명하게·따뜻하게·차갑게·빈티지·페이드 등 8종 + 강도). 미리보기와 저장 결과가 같아야 한다
(같은 렌더 경로). 문서 스키마에 필드를 더하되 옛 문서(필드 없음)는 기본값으로 읽는다. 다시 설정·실행 취소에 포함.
e2e 30 이 기대는 기존 버튼 문구·DOM 은 그대로.

## 4. 작업 분할(파일 소유)

| 묶음 | 내용 | 소유 파일 |
|---|---|---|
| **A 뷰어** | D1~D9 | `components/folder/PhotoViewer*.tsx`(신규)·`Lightbox.tsx`·`FolderWindow.tsx`(뷰어 배선)·`FolderPeek.tsx`(필요 시)·`diff/OcrPanel.tsx`(이동)·`diff/ImageView.tsx`(이동분만)·`favorites.rs`(info·ocr 커맨드 **추가만**)·`ocr.rs`(헬퍼 공개만)·`capabilities/default.json`·`i18n/text-folder.ts` |
| **C 보정·필터** | D12 | `components/image/inspector/AdjustTab.tsx`·`lib/annotate/*`·`ImageEditor.tsx`(보정 렌더 경로만)·`i18n/text-image-*.ts` |
| **B 경로 모드** | D10·D11 | `ImageEditor.tsx`(읽기·저장·경로 계산)·`stores/ui.ts`·`favorites.rs`(fav_write·stamp **추가만**)·`FolderWindow.tsx`(편집기 마운트)·`PhotoViewer`(회전 저장 메뉴) |

A ∥ C 를 먼저, B 를 뒤에(B 는 A 의 폴더 창·뷰어와 C 의 편집기를 함께 건드린다). 공유 파일(`lib.rs` invoke 목록·`ipc.ts`)은
추가만 한다.

## 5. 검증
- Rust: EXIF 파서(JPEG·HEIC 바이트 조각·깨진 오프셋), `fav_write_image` 게이트(루트 밖·`.git`·이름 성분)·충돌·덮어쓰기,
  `fav_ocr_image` 게이트 — `cargo test --lib`.
- TS: `tsc --noEmit`.
- 앱(CDP, dev 앱): 휠 줌·드래그·더블클릭·슬라이더·맞춤, 필름스트립 이동, 슬라이드쇼 진행, 정보 패널 EXIF(실제 iPhone 사진),
  OCR, 이미지 복사, 즐겨찾기 폴더 사진 [편집]→자르기→저장→파일 바뀜·썸네일 갱신, 사본 저장, 회전 저장.
- e2e: 30(이미지 편집기)·60(즐겨찾기 폴더) 단독 실행.
- 미실측: macOS·Linux(전체 화면·OCR 엔진·웹뷰 canvas filter 지원 — WebKitGTK 의 `ctx.filter`).

## 6. 결과 (2026-11-05)

- **구현 위치**: 뷰어 `components/folder/PhotoViewer.tsx`·`usePhotoZoom.ts`·`PhotoInfoPanel.tsx`·`Filmstrip.tsx`(옛 `Lightbox.tsx`
  삭제), OCR 패널 `diff/OcrPanel.tsx`(ImageView 에서 이동), EXIF `commands/exif.rs`, 정보·OCR·쓰기 `favorites.rs`
  (`fav_image_info`·`fav_ocr_image`·`fav_write_image`, `fav_read` 에 `stamp`), 쓰기 검사 공용화 `tree.rs checked_write_bytes`,
  보정·필터 `lib/annotate/tone.ts`(+ types·schema·render·history·persist), 경로 모드 `stores/ui.ts openImageEditorAbs`·`ImageEditor.tsx`.
- **보정 렌더**: 옛 세 슬라이더(밝기·대비·채도)는 `ctx.filter` 그대로(저장된 사이드카가 같은 픽셀을 내야 한다), 새 슬라이더·필터는
  픽셀 패스(LUT·톤 곡선·CSS 명세 행렬·비네트) — 그려지는 해상도(프리뷰 ≤1800, 출력 타일 ≤2048)에서 돈다.
- **검증**: `cargo test --lib` 528/0 · `tsc` 0 · e2e 15·30·34~40·42·43·46·51·53·54·60·62 = 785/0(40 은 러너 순서 의존 수정 뒤 —
  `run.mjs` 가 픽스처 등록 뒤 프로젝트 목록 캐시를 무효화) · dev 앱 CDP: 형식·해상도·크기 표시, 휠 확대·1/0·더블클릭·드래그,
  EXIF(iPhone 13·ISO 125·촬영일), OCR(바로 선 글자), 이미지 복사, 필름스트립 이동·HEIC 원본 크기(3024×4032), 슬라이드쇼,
  전체 화면 켜고 끄기, 회전 저장(PNG 400×100→100×400), 즐겨찾기 폴더 사진 [편집]→흑백 필터→제자리 저장(픽셀 회색)→뷰어 복귀.
- **후속(같은 날)**: 경로 모드 편집은 자동저장(사이드카)이 없는 대신 저장 안 한 편집이 있으면 닫기 전에 묻고(제목 표시줄
  X·Esc·닫기 단축키·창 X — 기준은 "연 뒤 문서가 바뀌었나"), 제목 표시줄 "편집됨"도 같은 기준. JPEG 회전 저장·경로 모드 JPEG 저장은
  원본 EXIF(APP1)를 옮겨 심고 Orientation=1·썸네일(IFD1) 연결 끊기(`lib/jpeg-exif.ts`). 이미지 뷰어 OCR 도 EXIF 방향대로 세워
  읽는다(`ocr.rs decode_upright`, 폴더 뷰어와 공용). 타이틀바 미리보기 뷰어가 토스트를 덮던 z 순서 수정.
- **알려진 한계**: 옆으로 누운 글자는 OCR 이 못 읽는다(엔진 한계 — 사진 앱도 같은 방향으로 보인다). HEIC 편집 저장은 PNG 형제
  파일(원본 HEIC 는 덮지 않음, EXIF 없음). WebP 회전 저장·프로젝트 모드 편집 저장은 EXIF 를 잃는다. 옮겨 심은 EXIF 의 PixelX/Y
  Dimension·ColorSpace(Display P3 → sRGB 출력)는 원본 값 그대로다. 미실측: macOS·Linux(전체 화면·OCR 엔진·`ctx.filter`).
