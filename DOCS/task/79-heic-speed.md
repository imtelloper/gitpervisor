# 태스크 79 — HEIC 를 최대한 빠르게(썸네일·사진 뷰어)

> 상태: **구현 완료** (2026-11-06) · 근거: 실측 3갈래(이 기계: Core Ultra 9 275HX 24코어, ffmpeg 8.0 gyan, iPhone 13 HEIC 44장)

## 1. 증상
설치본 v0.16.0 폴더 창: HEIC 썸네일이 한참 아이콘으로 남고, 사진 뷰어가 "읽는 중…"에 오래 머문다.

## 2. 원인(실측)
| 원인 | 수치 |
|---|---|
| ffmpeg 가 48개 타일 디코더마다 프레임 스레드 풀을 만든다(한 장에 최대 798 스레드) | `-threads 1 -filter_complex_threads 1` 이면 **바이트 동일** 출력으로 @192 455→136ms, @4096 504→241ms |
| 썸네일(≤320)도 4032×3024 그리드 전체를 푼다 | 파일 안 320×240 썸네일 스트림(의존 아님 — `grid_rotation` 이 이미 찾는 그 스트림)만 풀면 ffmpeg 80ms(회전 자동·같은 방향). Windows WIC `GetThumbnail` 은 14~22ms |
| 뷰어·OCR·편집기가 썸네일과 **한 줄(Semaphore 3, FIFO)** 에 선다 + 필름스트립이 128px(그리드는 192)로 25장을 새로 푼다 | 폴더 열고 바로 사진을 열면 뷰어 대기 9.7~14.3s → 전용 줄이면 0.42~0.50s |
| `favRead` 가 `call`(8초 × 3회) — 8초 넘으면 같은 4096 해독을 **또** 줄 세운다 | 실측 9.7s 대기 = 재시도 발생 구간 |
| ffprobe 를 호출마다 다시 돈다(≈90ms) | 썸네일 뒤 뷰어가 같은 파일을 또 probe |
| 뷰어는 해독 중 글자만 보여 주고, 이웃을 미리 읽지 않으며, ←/→ 로 넘긴 뒤에도 버린 해독이 끝까지 돈다 | — |
| 하드웨어 디코딩 | cuda 1.5s · dxva2 1.25s · d3d11va 6.6s — 전부 느림 → 쓰지 않는다 |
| (덤) 다시 저장된 HEIC 4/44 는 Exif 항목이 파일 끝(96% 지점)에 있어 `EXIF_SCAN_BYTES`(앞 1MiB)로 못 찾는다 | 정보 패널에 촬영 정보가 비어 보인다 |

## 3. 설계

### B1. ffmpeg 경로(세 OS 공통) — `still_image.rs`
- `still_args` 의 `-i` 앞에 `-threads 1 -filter_complex_threads 1`.
- **썸네일(max_edge ≤ 320)은 내장 썸네일 스트림만**: probe 에서 의존 아닌 영상 스트림(그리드 타일이 아닌 것) 중 긴 변이 가장 큰 것을 고르고
  긴 변 ≥ max_edge 면 `-map 0:<idx> -vf scale…` (transpose 넣지 않는다 — ffmpeg 가 display matrix 로 이미 돌린다). 없거나 작으면 지금 그리드 경로.
- **probe 캐시**: (경로, mtime, 크기) → probe 결과, 프로세스 메모리 LRU 256개.
- **두 줄**: 썸네일 줄 `clamp(코어/4, 3, 6)` · 보기 줄(뷰어·OCR·편집기) 2. `still_to_jpeg` 에 `lane: StillLane { Thumb, View }` 인자.

### B2. Windows 네이티브 썸네일 — `still_image_wic.rs`(신규, `#[cfg(windows)]`)
- HEIC/HEIF/AVIF 썸네일(≤320)은 **WIC 가 먼저**: `CreateDecoderFromFilename` → `GetFrame(0)` → `GetThumbnail()`(이미 바로 선 방향) →
  긴 변이 max_edge 보다 크면 `IWICBitmapScaler`(Fant) → `WICConvertBitmapSource(24bppBGR)` → `CopyPixels` → BGR→RGB → `image` JPEG(q≈85).
  썸네일이 없거나 max_edge 보다 작으면 실패로 보고 ffmpeg 로.
- 실패(HEVC 확장 없음 등)는 **세션 동안 기억**하고 곧장 ffmpeg 로(`AtomicBool`). COM 은 호출 스레드에서 `CoInitializeEx(MTA)` — `pc_care/scheduled_tasks.rs` 의 ComGuard 패턴.
  blocking 작업이라 `spawn_blocking`. 썸네일 줄 세마포어 안에서 돈다.
- 기능: `windows` 0.61 에 `Win32_Graphics_Imaging` 추가(이미 Com·Foundation 있음). 새 크레이트 없음.
- **ffmpeg 가 없어도** Windows 에서 HEIC 썸네일이 뜬다(HEIF·HEVC 확장이 있으면). 큰 그림(뷰어)은 이번엔 ffmpeg 그대로(WIC 291~570ms ≈ 개선된 ffmpeg 241+90ms — 이득 없음).
- macOS ImageIO·Linux libheif 는 이번 범위 밖: 두 OS 는 B1(내장 썸네일 스트림·스레드 플래그·두 줄)로 3~4배 빨라진다. 맥 실기가 없어 네이티브 경로는 검증할 수 없다.

### B3. 프론트
- `ipc.favRead`: `attempts: 1`, 시한 60초(OCR 과 같다) — 재시도가 같은 해독을 또 줄 세우지 않게.
- 필름스트립 썸네일 변을 그리드 기본(192)과 같게 — 같은 캐시를 쓴다(새 해독 0).
- 사진 뷰어: 해독 중엔 **이미 있는 썸네일**(320, 내장 스트림이라 싸다)을 화면 맞춤으로 먼저 보여 주고(살짝 흐리게) 큰 그림이 오면 바꾼다. "읽는 중…" 은 그 위 작은 표시로.
- **최신 것만**: 뷰어의 큰 그림 요청은 동시에 하나 — 진행 중이면 마지막 요청만 기억했다가 끝나면 보낸다(←/→ 연타가 버릴 해독을 쌓지 않게).
- **이웃 미리 읽기**: 지금 그림이 뜬 뒤 다음(진행 방향) 한 장을 미리 읽고, 메모리 LRU(6장)에 둔다 — 되돌아가기·다음 장은 즉시.

### B4. (덤) Exif 가 파일 끝에 있는 HEIC — `exif.rs`
- 앞 1MiB 에서 못 찾으면 HEIF(ISOBMFF) 면 끝 1MiB 도 찾는다.

## 4. 작업 분할
| 묶음 | 파일 |
|---|---|
| **BE** | `still_image.rs`(B1) · `still_image_wic.rs`(신규, B2) · `favorites.rs`(줄 지정·WIC 우선·ffmpeg 없을 때 썸네일은 WIC) · `exif.rs`(B4) · `Cargo.toml`(feature 하나) |
| **FE** | `lib/ipc.ts`(favRead) · `folder/Filmstrip.tsx` · `folder/PhotoViewer.tsx`(+ 필요하면 작은 훅) · `lib/fav-thumb.ts`(필요 시) |

## 5. 검증
cargo test(인자 조립·스트림 고르기·probe 캐시·두 줄) · tsc · dev 앱에서 같은 폴더(HEIC 44장)를 **처음 열 때**(dev 앱 썸네일 캐시는 설치본과 따로) 전체 썸네일이 뜨는 시간,
사진 열기 → 큰 그림까지 시간, ←/→ 연타 뒤 마지막 사진 시간을 바꾸기 전 v0.16.0 과 숫자로 비교 · WIC 실패 시 ffmpeg 로 넘어가는지(강제 실패 테스트 훅).

## 6. 결과(2026-11-06, dev 앱 · 받은 폴더 50장을 처음 여는 상태)
| 항목 | 전 | 후 |
|---|---|---|
| 화면 썸네일 20칸 전부 | 13.9s | **1.2s** |
| 폴더를 열자마자 사진 열기 → 큰 그림 | 2.1s | **1.0s** |
| → 5연타 뒤 마지막 사진 | 11.2s | **1.7s** |
| 끝까지 스크롤 | 60s 넘게 2칸 실패로 남음 | 3.1s 안에 HEIC 전부(남은 2칸은 0바이트 빈 .jpeg — 정상) |

단품(디버그 빌드): WIC 썸네일 34~41ms(첫 호출 코덱 적재 ~230ms) · ffmpeg 내장 썸네일 스트림 ~80ms(+probe 90ms, 캐시되면 0) · 4096 그리드 236~274ms.
사진 뷰어는 열자마자(0.12s) 흐린 썸네일을 큰 그림 자리에 띄우고 원본이 오면 바꾼다(같은 구도 — 화면으로 확인).

검토(2관점, 5건, 높음 0)에서 고친 것: 인물 모드 HEIC 의 흑백 깊이 맵(≈768px)을 썸네일로 고르던 것(흑백 제외 + 칸을 채우는 가장 작은 스트림) ·
이름만 .heic 인 MP4·MOV 하나가 세션 내내 WIC 를 끄던 것(알려진 HEIF·AVIF 브랜드만 + 끄기 전에 HEIF 디코더 등록 여부 확인) · 세로 JPEG 의 누운 대역
(대역·미리 읽기는 HEIC·HEIF·AVIF 만) · 뷰어 캐시를 장 수(6)와 무게(base64 64MB)로 함께 제한.

미실측: HEVC 확장이 없는 Windows(WIC 실패 → ffmpeg 폴백 경로는 강제 실패 훅으로만 확인), macOS·Linux 실기. e2e 60 은 회차 시작 때 설치본이 응답하지 않아
드라이버가 스스로 멈춰 못 돌렸다(설치본 멈춤은 이 변경과 무관 — 설치본은 v0.16.0, 12:52 부터 WebView 송신 실패).
