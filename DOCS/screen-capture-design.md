# 화면 영역 캡쳐 · 녹화 — 기능 설계서

> 상태: 설계(Design) · 대상: gitpervisor (Tauri 2 + React 19 + TS) · 1차 플랫폼: **Windows (WebView2)**
> 산출물 성격: `/sc:design` — 구현 코드가 아니라 지연 예산·아키텍처·계약(IPC/좌표계)·단계 계획.
> 자매 설계서: `DOCS/image-annotation-design.md`(정지 캡쳐의 **인계 대상**),
> `DOCS/video-editor-design.md`(녹화 결과의 **인계 대상** — 이미 구현됨).
> 근거: 2026-08-27 이 개발기에서 직접 측정. §2.3·§2.4의 숫자는 전부 실측이며 방법을 명시한다.

---

## 0. 요구사항

**"윈도우 기본 캡쳐(Win+Shift+S)가 너무 느리다. 하이엔드급 영역 캡쳐가 필요하다. 화면 녹화도 필요하다."**

"하이엔드"를 셋으로 번역한다. 이 셋이 수용 기준이 된다.

| # | 번역 | 측정 가능한 목표 |
|---|---|---|
| G1 | **즉시성** | 단축키 → 선택 가능 상태까지 **100ms 이내** |
| G2 | **정밀성** | 픽셀 단위 조준(루페·좌표·HEX), 창 경계 자동 스냅, 선택 후 미세 조정 |
| G3 | **끝맺음** | 찍고 나서 할 일(복사·주석·자르기·GIF·레포 저장)이 **같은 흐름 안에서** 끝난다 |
| G4 | **녹화가 프레임을 안 흘린다** | 모니터 전체 **60fps 유지**, 목표 대비 프레임 드롭 ≤ 5% |

### 0.1 확정된 결정 (사용자 답변, 2026-08-27)

| 질문 | 확정 | 설계 반영 |
|---|---|---|
| 기본 단축키 | **`Ctrl+Shift+X`** | §5.4. 등록 실패는 설정에 에러로 노출(R1) |
| 기본 동작 | **클립보드 직행** | §4.7. 픽셀이 프론트를 거치지 않는 최단 경로 |
| 저장 위치 | **`…\Pictures\Screenshots`** | §5.4 — 사용자 경로를 하드코딩하지 않고 `FOLDERID_Screenshots`로 해석한다 |
| 프리워밍 | **권장대로(기본 끔)** | §4.4. 지연 프리워밍 + 유휴 파괴 + health 연동 |
| 화면 녹화 | **범위에 포함** | §4.1b·§4.8·§5.5 — 이 결정이 §4.1의 백엔드 판단을 **반쯤 뒤집었다**(R5) |

### 0.2 왜 범용 툴(ShareX/Snipaste/OBS)이 아니라 이 앱에 넣나

답이 없으면 만들 이유가 없다. 이 저장소에서만 성립하는 답이 셋이다.

1. **후처리가 이미 다 있다.** 정지 이미지는 `ImageEditor`(주석 9종·클립보드·png/jpeg/webp/avif), 동영상은 `commands/video.rs`(구간 추출·배속·크롭·**GIF 변환**)가 **이미 구현돼 있다**(`DOCS/video-editor-design.md`, P1~P4 완료). 캡쳐·녹화는 그 앞단 하나가 비어 있을 뿐이다.
2. **레포를 안다.** 결과물을 현재 프로젝트에 저장하면 그 순간 Changes 패널에 뜨고 커밋 대상이 된다. 범용 툴은 "어느 레포"를 모른다. *버그 재현 GIF를 찍어 → 구간 자르고 → GIF로 뽑아 → 레포에 넣고 → PR에 붙인다* 가 한 창에서 끝난다.
3. **이미 떠 있다.** 상주 프로세스가 있다는 것이 G1의 전제다 — 캡쳐 툴 지연의 대부분은 "프로세스를 깨우는 시간"이다.

---

## 1. 결론 — 4줄 요약

1. **정지 캡쳐 지연의 주범은 캡쳐가 아니라 창 생성과 캡쳐 범위다.** 실측: WebView2 창 신규 생성은 내용이 보일 때까지 **1367ms**, 가상 데스크톱 전체(5대 8960×3251) BitBlt는 **299ms**. 커서가 있는 모니터 1대(2560×1440)만 잡으면 **38ms**다. → **오버레이를 미리 만들어 숨겨 두고**, **커서 모니터 1장만** 잡는다.
2. **픽셀은 IPC를 건너지 않는다.** 프리즈 프레임 원본은 Rust 메모리에 남고 오버레이에는 표시용 JPEG 0.4MB(인코드 12ms)만 보낸다. 최종 크롭·클립보드·HEX는 원본 버퍼에서 뜬다.
3. **녹화 백엔드는 ffmpeg `ddagrab`(GPU) 하나로 끝난다 — 신규 네이티브 캡쳐 코드 0.** 실측: ddagrab+NVENC는 2560×1440 전체를 **59fps** 유지, gdigrab+libx264는 같은 조건에서 **23fps**(61% 드롭). ffmpeg 발견·다운로드·spawn·취소 인프라는 `commands/video.rs`에 **이미 있다**.
4. **캡쳐 후는 새로 만들지 않는다.** 정지는 `ImageEditor`, 녹화는 기존 비디오 편집기로 인계한다. 이번 작업의 유일한 기존 코드 변경은 **에디터 입력 계약을 "레포 경로"에서 "소스 유니온"으로 넓히는 것**뿐이다(§5.3).

---

## 2. 현황 실측

### 2.1 이미 있는 것 (재사용)

| 자산 | 위치 | 이번에 쓰는 방식 |
|---|---|---|
| `ImageEditor` + 주석 9종 | `src/components/image/ImageEditor.tsx` | 정지 캡쳐의 인계 대상. §5.3 계약 확장만 |
| `encodeCanvas` / `bytesToBase64` | `src/lib/image-codec.ts` | 저장 포맷 인코딩 |
| `writeImage`(클립보드) | `plugin-clipboard-manager` | `clipboard-manager:allow-write-image` **이미 허용됨** |
| `write_file_bytes` | `commands/tree.rs:297` | "레포에 저장". `resolve_in_repo` 컨테인먼트 기존 |
| **ffmpeg 발견 체인** | `commands/video.rs:132` `find_ffmpeg` | 명시경로 → PATH → 관리설치본. **녹화가 그대로 쓴다** |
| **ffmpeg 온디맨드 다운로드** | `video.rs:958` `ffmpeg_spec` | Windows x64 = gyan.dev **9.0.1** → `ddagrab` 포함(6.0+ 필요) |
| **ffmpeg 프로세스 회수/취소** | `video.rs:60` `video_kill_all`, `:853` `video_export_cancel` | 녹화 중지·앱 종료 정리에 그대로 |
| **비디오 편집기** | `video.rs:659` `video_export`, `src/components/video/*` | 녹화 결과 인계 — 구간 자르기·배속·크롭·**GIF** |
| `WebviewWindowBuilder` 보조창 패턴 | `lib.rs:140`(sysmon), `:177`(aggregate) | 오버레이 창 골격 |
| `windows-sys 0.59` | `Cargo.toml` | `Win32_Graphics_Gdi`·`Win32_Foundation`·`Win32_UI_WindowsAndMessaging` **이미 켜짐** → BitBlt에 신규 feature 0 |
| `image 0.25`(png) | Windows dep | 캡쳐 버퍼 → PNG |
| `clipboard-win 5` | Windows dep | 네이티브 클립보드 이미지 쓰기 |
| 루프백 프리뷰 서버 | `commands/preview.rs:199` | 프레임 무-base64 전달의 **대안**(§4.5) |
| `tauri-plugin-dialog` | `Cargo.toml` | "다른 이름으로 저장" |

### 2.2 새로 필요한 것

| 항목 | 성격 | 비고 |
|---|---|---|
| 캡쳐 커맨드 6개 | 신규 `commands/capture.rs` | §5.1 |
| 녹화 커맨드 4개 | 신규 `commands/record.rs` | §5.5. ffmpeg 인자 조립 + 상태 |
| 오버레이 창 `capture` | 신규 라벨 | `capabilities/default.json`의 `windows` 배열 추가 |
| 녹화 테두리 창 `rec-frame` | 신규 라벨 | 클릭 통과(`set_ignore_cursor_events`) |
| 전역 단축키 | **신규 플러그인** `tauri-plugin-global-shortcut` | 현재 미도입(확인함) |
| 스크린샷 폴더 해석 | 신규 (Windows) | `SHGetKnownFolderPath(FOLDERID_Screenshots)` |
| `windows-sys` feature 추가 | `Win32_UI_Input_KeyboardAndMouse`, `Win32_Graphics_Dwm`, `Win32_UI_Shell_Common` | M2 |

### 2.3 실측 — 정지 캡쳐

**모니터 구성이 설계를 지배한다.** 이 머신은 **5대**다.

```
virtual screen: 8960x3251 at (-2560, 0)     ← 원점이 음수다
  DISPLAY1 1707x1067      DISPLAY2 2560x1440
  DISPLAY3 1920x1080      DISPLAY9 1920x1080
  DISPLAY4 2560x1440 (primary)
```

| 측정 | 값 | 방법 |
|---|---|---|
| 가상 데스크톱 전체 BitBlt | **282 / 291 / 299 / 299 / 309 ms** (6회) | .NET `Graphics.CopyFromScreen` |
| 2560×1440 1대 BitBlt | **37.6 ~ 42.9 ms** | 〃 |
| 1920×1080 1대 BitBlt | **24.1 ~ 30.3 ms** | 〃 |
| 1707×1067 1대 BitBlt | **18.8 ~ 20.7 ms** | 〃 |
| 2560×1440 JPEG 인코드 | **12 ~ 28 ms / 0.39 ~ 0.42 MB** | `Bitmap.Save(Jpeg)` |
| 8960×3251 PNG 인코드 | **667 ms / 9.75 MB** | `Bitmap.Save(Png)` |
| 8960×3251 원시 BGRA | **111.1 MB** | 계산 |
| WebView2 창 신규 생성 | **타깃 184ms / readyState complete 1042ms / 내용 렌더 1367ms** | dev 앱에 CDP로 붙어 `open_sysmon_window` 호출~내용 렌더 계측 |

> **측정 주의 2건.** (a) WebView2 수치는 **dev 빌드 + vite 개발서버** 값이라 릴리스에서는 줄어든다 — 그래도 수백 ms라 결론(프리워밍)은 안 바뀐다. (b) BitBlt는 DPI-비인식 PowerShell에서 잰 것이라 `DISPLAY1 1707×1067`은 가상화 좌표다. **DPI 인식 프로세스에선 그 모니터 실측이 커진다** — R3.

### 2.3.1 정정 — M1 구현 중 앱에서 다시 잰 값 (2026-08-27)

위 (b)의 주의가 그대로 현실이 됐다. **§2.3의 픽셀 수는 과소평가였다.**

| 정정 항목 | 설계 초안 | 실제 |
|---|---|---|
| 주 모니터 해상도 | 2560×1440 | **3840×2160** (150% 배율 — DPI 인식 프로세스가 보는 값) |
| 그 모니터 BitBlt | 38ms 추정 | **186ms** (앱 로그, 디버그 빌드) |
| 1920×1080 BitBlt | — | **49~88ms** (앱 로그, 디버그 빌드) |

그리고 **인코더 가정이 틀렸다.** §2.3의 JPEG 12~28ms는 .NET `Bitmap.Save` = GDI+/WIC(OS 코덱, SIMD)로 잰 값인데, 구현은 순수 Rust `image` 크레이트를 쓴다. 릴리스 마이크로벤치(고대비 합성 이미지 = 최악의 입력):

| 프레임 | 박스 축소 | **JPEG 인코드** | 출력 |
|---|---:|---:|---:|
| 1920×1080 | 17ms | **91ms** | 1.75MB |
| 2560×1440 | 29ms | **159ms** | 3.11MB |
| 3840×2160 → 1920×1080 (1/2 축소) | 18ms | **120ms** | 2.27MB |
| 3840×2160 (원본) | 66ms | **357ms** | 6.99MB |

같은 급의 프레임을 GDI+가 12~28ms / 0.39MB로 처리한 것과 비교하면 **순수 Rust 인코더가 5~10배 느리다**(합성 입력이라 실제 화면보다 불리한 쪽으로 치우친 값이다 — 실제 데스크톱은 훨씬 평탄해 몇 배 싸다).

**대응(구현됨).** 프리뷰 긴 변이 2600을 넘으면 정수배로 축소한다 → 4K만 절반이 되고 2560 이하는 그대로다. 3840×2160을 원본 해상도로 인코딩하면 그것만으로 예산의 3배를 쓴다.

**다음 수(미구현).** 이걸로도 부족하면 **WIC**(Windows 이미지 코덱)로 인코딩한다. 순수 Rust 인코더를 유지한 채 해상도를 더 깎는 것보다 그쪽이 옳다 — 깎으면 조준용 그림이 흐려지고, 그건 G2를 직접 깎아먹는다.

### 2.4 실측 — 녹화 (ffmpeg 8.0 gyan.dev, 각 4초)

| 캡쳐 방식 | 인코더 | 대상 | 목표 | **실제 fps** | speed |
|---|---|---|---|---:|---:|
| **`ddagrab`(GPU)** | `h264_nvenc p1` | 2560×1440 모니터 전체 | 60 | **59** | 0.995x |
| **`ddagrab`(GPU)** | `h264_nvenc p1` | 1280×720 영역 + 커서 | 60 | **59** | 0.989x |
| `gdigrab`(CPU) | `libx264 veryfast` | 2560×1440 모니터 전체 | 60 | **23** | 0.964x |
| `gdigrab`(CPU) | `libx264 veryfast` | 1280×720 영역 | 60 | **52** | 0.978x |

`gdigrab`는 모니터 전체 60fps에서 **프레임의 61%를 흘린다**. 720p로 줄여도 60을 못 지킨다. 반면 `ddagrab`는 전체 해상도에서도 59fps를 유지하고, **영역 지정(`offset_x`/`offset_y`/`video_size`)과 커서 합성(`draw_mouse=1`)을 입력 단계에서 직접 지원**한다 — 크롭 필터로 CPU 왕복을 만들 필요가 없다.

이 개발기 ffmpeg 빌드 configuration에 `--enable-d3d11va --enable-nvenc --enable-amf --enable-libvpl --enable-mediafoundation`이 있어 ddagrab + 하드웨어 인코더 3종이 모두 가능하다. 관리 설치본(gyan.dev 9.0.1)도 같은 구성이다.

---

## 3. 지연 예산 (G1: 100ms)

단축키를 누른 순간부터 "드래그를 시작할 수 있는 상태"까지.

| 단계 | 예산 | 근거 | 이 예산을 지키는 결정 |
|---|---:|---|---|
| 전역 단축키 → Rust 핸들러 | 5ms | OS 훅 | — |
| 커서 위치 → 대상 모니터 판정 | 1ms | `GetCursorPos` + 모니터 열거 | — |
| **프리즈 캡쳐(1대)** | **40ms** | 실측 37.6~42.9ms | **D1** 커서 모니터만 |
| **표시용 JPEG 인코드** | **15ms** | 실측 12~28ms | **D2** PNG(667ms) 아님 |
| IPC(0.53MB base64) + webview 디코드 | 25ms | 추정 | **D3** 원시 BGRA(14.7MB) 아님 |
| **오버레이 창 표시** | **10ms** | `show()` + `set_focus()` | **D4** 프리워밍(신규 생성이면 1367ms) |
| 합계 | **~96ms** | | |

D1~D4 중 하나라도 빠지면 예산이 무너진다. **D4가 없으면 예산의 14배**다 — 사용자가 지금 불평하는 그 지연과 같은 종류의 문제이고, 그걸 재현하지 않는 것이 이 설계의 핵심이다.

---

## 4. 아키텍처

### 4.1a 정지 캡쳐 백엔드 — GDI `BitBlt`

| 방식 | 지연 | 초기화 | 커버리지 | 판정 |
|---|---|---|---|---|
| **GDI `BitBlt` + `GetDIBits`** | 20~43ms/1대 (실측) | **없음** | DRM 보호 창은 검게, 보안 데스크톱 불가 | **채택** |
| DXGI Desktop Duplication | 프레임 5~15ms | D3D11 디바이스 + 출력별 세션 **50~150ms** | RDP·보안 데스크톱 실패 | 비채택 |
| Windows.Graphics.Capture | 중간 | WinRT 초기화 | HDR·DPI 정확, 일부 버전 노란 테두리 | 보류 |

**근거.** Duplication의 이점은 *연속* 캡쳐에서 나온다. 단축키당 1프레임이면 세션 초기화(50~150ms)가 프레임 이득(25ms)을 즉시 잡아먹는다. BitBlt 40ms는 예산 안이다 — **더 빠르게 만들 이유가 아직 없다.**

### 4.1b 녹화 백엔드 — ffmpeg `ddagrab` (R5 뒤집기)

> **이 문서 초안의 R5는 "연속 캡쳐(녹화)를 하게 되면 그때 재검토"였다. 그 조건이 같은 날 발생했고, 재측정 결과 녹화 경로에 한해 뒤집는다.** 정지 캡쳐는 그대로 BitBlt다 — 두 작업의 비용 구조가 반대이기 때문이다(단발은 초기화가 지배, 연속은 프레임당 비용이 지배).

```
ffmpeg -f lavfi -i "ddagrab=output_idx=N:framerate=60:offset_x=X:offset_y=Y:video_size=WxH:draw_mouse=1" \
       -c:v <hwenc> -preset <p> -pix_fmt yuv420p -movflags +faststart out.mp4
```

**이 선택의 진짜 가치는 성능이 아니라 코드량이다.** ddagrab은 ffmpeg 입력 장치이므로 **신규 Rust 캡쳐 코드가 0**이고, 발견·다운로드·spawn·취소·앱종료 회수가 전부 `commands/video.rs`에 이미 있다. 녹화는 "인자 문자열 조립 + 상태 기계"로 줄어든다.

**인코더 선택 체인** — 런타임 결정:

```
h264_nvenc (NVIDIA) → h264_qsv (Intel) → h264_amf (AMD) → libx264 veryfast (CPU 폴백)
```

`ffmpeg -encoders`에 이름이 있어도 실제로는 실패하는 조합이 흔하다(드라이버·GPU 세대). **1초짜리 시험 인코딩으로 검증한 결과를 캐시한다** — 30분짜리 녹화가 끝난 뒤에 실패를 알게 되는 것이 최악이다.

**ddagrab 실패 시 폴백**: RDP 세션·다중 GPU·일부 가상 디스플레이에서 실패한다. 그때는 `gdigrab`으로 내려가되 **조용히 내려가지 않는다** — "GPU 캡쳐를 쓸 수 없어 CPU 캡쳐로 녹화합니다. 60fps가 안 나올 수 있습니다"를 표시한다(실측 23fps).

### 4.2 캡쳐 범위 — 커서 모니터 1장

전체를 잡으면 **299ms**로 예산 3배 초과다. 5대 구성에서 차이는 8배.

```
단축키 → GetCursorPos → 그 점을 포함하는 모니터 M 판정 → M만 BitBlt
```

**모니터 경계를 넘는 선택**(M3): 오버레이를 띄운 **직후** 백그라운드가 나머지를 순차 캡쳐한다(~260ms, 임계 경로 밖). 드래그가 가장자리에 닿으면 이웃 오버레이를 `show()`한다 — 사람이 다른 모니터까지 끄는 시간(>300ms)이 프리페치보다 길어 체감 대기 0이다. 아직 안 끝난 영역은 "준비 중" 셰이딩으로 표시한다(조용한 빈 화면 금지).

### 4.3 좌표계 — 단일 진실은 "가상 데스크톱 물리 픽셀"

`image-annotation-design.md`가 `oriented px` 하나로 통일한 것과 같은 원칙이다.

```
capture space  = 가상 데스크톱 물리 픽셀, 원점은 OS가 정한 값 (이 머신: (-2560, 0))
overlay CSS px = capture space ÷ monitor.scale_factor()
ddagrab 인자    = capture space 를 그 output 의 로컬 좌표로 환산 (output_idx 기준 상대)
```

**원점이 (0,0)이라고 가정하면 안 된다.** 이 머신의 가상 화면은 x=−2560에서 시작한다. 부호 없는 타입이나 "화면 왼쪽 위=0,0" 계산은 왼쪽 모니터에서 통째로 어긋난다.

**DPI는 모니터마다 다르다.** 캡쳐 프로세스는 per-monitor DPI aware v2여야 하고(Tauri 기본), 오버레이는 자기가 올라간 모니터의 `scale_factor()`만 쓴다. 전역 배율 하나를 쓰면 혼합 DPI에서 사각형이 밀린다.

**ddagrab의 `output_idx`는 우리가 쓰는 모니터 순서와 같다는 보장이 없다.** DXGI 출력 열거 순서와 Windows 모니터 열거 순서는 별개다 — 매핑을 실측으로 확정하고(테스트에 고정), 추측하지 않는다.

### 4.4 오버레이 창

| 속성 | 값 | 이유 |
|---|---|---|
| 라벨 | `capture` (싱글턴) | sysmon/aggregate와 같은 패턴 |
| 생명주기 | **생성 후 숨김 유지**, 캡쳐 때 `set_position`→`show`→`set_focus` | 신규 생성 1367ms 회피 |
| 장식 | `decorations(false)`, `always_on_top(true)`, `skip_taskbar(true)` | |
| 크기 | 대상 모니터의 물리 크기 | |
| 배경 | **불투명**(프리즈 JPEG를 깐다) | 투명이면 아래가 **살아 움직인다** |
| 커서 | `crosshair` | |

**프리즈는 부수 효과가 아니라 목표다.** 살아 있는 화면 위에서 선택하면 (a) 애니메이션·툴팁이 튀어들어와 원하는 순간을 못 잡고 (b) 확정 시점과 표시 시점의 픽셀이 달라진다. 프리즈는 "본 대로 찍힌다"를 구조적으로 보장한다.

**프리워밍의 대가와 완화 (사용자 확정: 기본 끔).** 숨긴 WebView2 1개 ≈ 40~90MB 상주. 이 저장소는 2026-08 systemd-oomd 강제 종료 이력이 있고 이 개발기는 평소 여유 메모리가 4~8%다(`health` 로그).

- 기본은 **지연 프리워밍** — 첫 캡쳐 때 만들고(첫 회만 느림) 이후 숨겨 유지.
- **유휴 10분이면 파괴.**
- 설정 `captureKeepWarm`(기본 `false`)로 상시 유지 선택 가능.
- health 레벨이 `warn` 이상이면 프리워밍을 자동 해제(R2).

### 4.5 픽셀 경로 — 원본은 Rust에, 표시본만 프론트에

```
BitBlt ──> [Rust] CaptureSession { bgra, w, h, origin, scale }   ← 원본. IPC를 건너지 않음
                       ├─ JPEG q85 ──> base64 ──> IPC ──> <img>   ← 표시 전용 0.4MB
                       ├─ crop(rect) ──> 클립보드 직행             ← 기본 동작(사용자 확정)
                       ├─ crop(rect) ──> PNG base64 ──> 편집기
                       └─ pixel(x,y) ──> "#RRGGBB"                ← 루페 색상
```

표시본이 손실 압축이어도 결과 품질은 안 떨어진다 — **최종 크롭은 항상 무손실 원본에서** 뜬다. 표시본은 조준용이고 q85면 충분하다.

**base64 대신 루프백 서버(대안).** `preview.rs`에 토큰 인증 127.0.0.1 서버가 이미 있어 프레임을 URL로 줄 수 있다(base64 33% 팽창 제거 + 네이티브 디코드). 다만 현 CSP의 `img-src`는 `'self' data: blob: https:`뿐이라 **CSP를 넓혀야 한다**. 0.4MB base64가 예산 안이므로 **M1은 base64.** 측정해서 병목이면 그때 CSP를 건드린다.

**세션 수명.** 모니터 1대 = 14.7MB. 오버레이가 닫히면 즉시 해제하고, 별도로 **60초 TTL 워치독**을 둔다 — 오버레이가 비정상 종료돼도 버퍼가 영구 잔류하지 않게. ("정리 경로가 하나뿐이면 언젠가 샌다"는 이 저장소가 비싸게 배운 교훈이다 — `DOCS/process-leak-postmortem.md`.)

### 4.6 선택 UI 사양

| 기능 | 단계 | 비고 |
|---|---|---|
| 드래그 영역 선택 + 바깥 딤 + 실시간 `W×H` | M1 | |
| `Esc` 취소 / `Enter` 확정 / 우클릭 취소 | M1 | 계층형 Esc: 선택 중 → 선택 해제, 선택 없음 → 오버레이 닫기 |
| **루페**(8~16배) + 커서 좌표 + 중앙 픽셀 HEX | M2 | 원본 버퍼의 실제 색. `C`로 HEX 복사 |
| **창 자동 감지** — 커서 아래 창 하이라이트, 클릭 1회로 그 창 캡쳐 | M2 | `EnumWindows` + `DwmGetWindowAttribute(EXTENDED_FRAME_BOUNDS)`. `GetWindowRect`를 쓰면 그림자 여백이 붙는다 |
| 선택 후 8핸들 리사이즈 + 드래그 이동 | M2 | |
| 방향키 1px / `Shift`+방향키 10px | M2 | 마우스로 못 하는 정밀도 = G2의 핵심 |
| 비율 스냅(`Shift` 정사각) | M2 | |
| 지연 캡쳐(3초/5초) | M2 | 메뉴를 펼친 상태를 찍는 유일한 방법 |
| 마지막 영역 재캡쳐 | M3 | |
| 모니터 경계 넘는 선택 | M3 | §4.2 |
| 결과 핀(pin) 창 | M3 | 라벨 `pin-<id>` |
| 커서 포함 옵션 | M3 | BitBlt은 커서를 안 담는다 → `GetCursorInfo`+`DrawIconEx` 합성 |

### 4.7 결과 라우팅 (G3)

**기본 동작은 클립보드 직행**(사용자 확정). 확정 시 오버레이 하단 액션 바에서 다른 경로도 고를 수 있다.

| 동작 | 경로 | 비고 |
|---|---|---|
| **클립보드 복사** (기본) | Rust crop → `clipboard-win`/`arboard` 직행. **IPC 미경유** | 가장 빠름 |
| 파일로 저장 | `…\Pictures\Screenshots\Screenshot 2026-08-27 113618.png` | §5.4. 다이얼로그 없이 바로 — 토스트에 "폴더 열기" |
| 주석 편집기로 | crop → PNG → `ImageEditor` 인계(§5.3) | |
| 레포에 저장 | 현재 프로젝트 + 상대경로 → 기존 `write_file_bytes` | 저장 즉시 Changes에 뜬다 |
| 다른 이름으로 저장 | Rust가 다이얼로그를 열고 직접 쓴다 | §5.2 |

### 4.8 녹화 흐름 (G4)

```
단축키(Ctrl+Shift+Alt+X) → §4.2~4.6 과 동일한 오버레이로 영역 선택
   → 오버레이 닫힘, 그 자리에 얇은 테두리 창(rec-frame, 클릭 통과) + 컨트롤 바
   → ffmpeg ddagrab 시작 (3·2·1 카운트다운 후)
   → [경과시간 · 파일크기 · 남은 디스크] 실시간 표시
   → 정지 → mp4 완성 → 토스트 "편집기에서 열기 / 폴더 열기 / GIF로 변환"
```

**영역 선택 UI를 캡쳐와 공유한다** — 녹화 전용 선택 UI를 따로 만들지 않는다. 오버레이는 `mode: "capture" | "record"`만 다르다.

**중지는 kill이 아니라 `q`다.** ffmpeg 프로세스를 죽이면 moov atom이 안 써져 **mp4가 재생 불가로 깨진다.** stdin에 `q`를 보내 정상 종료시키고, 응답이 없으면 3초 뒤에만 kill한다(그때는 깨진 파일임을 알린다). 앱 종료 시에도 같은 경로를 타야 하므로 `video_kill_all`과 별도로 "녹화 우선 정상종료" 단계를 `shutdown_children`에 끼운다.

**무한 증가 방어.** 실측 190KB/s(정지 화면, 2560×1440 60fps nvenc p1) — 움직이면 수 배가 된다. 이 저장소는 무한 증가로 이미 여러 번 데었다(로그 prune, 프로세스 누수). 따라서:

- 기본 최대 길이 **10분**, 기본 최대 크기 **2GB** — 도달하면 자동 정지하고 알린다(조용히 계속하지 않는다).
- 대상 드라이브 여유가 **1GB 미만**이면 시작을 거부하고, 녹화 중 1GB 아래로 내려가면 정지한다.

**클릭 통과 테두리 창.** `set_ignore_cursor_events(true)`로 마우스를 통과시킨다 — 안 그러면 녹화 대상 앱을 조작할 수 없다. 테두리 자체는 ddagrab이 잡는 영역 **바깥**에 그려야 결과물에 안 찍힌다(경계 1px 오차가 그대로 보인다 — 수용 기준에 넣는다).

**오디오.** Windows ffmpeg에는 **WASAPI 루프백 입력 장치가 없다.** `Stereo Mix`는 최신 오디오 드라이버에서 대개 비활성/부재고, `virtual-audio-capturer`는 별도 설치가 필요하다. 따라서:

- **M-R1: 무음.** 개발자가 버그 재현을 남기는 용도에 오디오는 대개 불필요하고, GIF로 뽑으면 어차피 버려진다.
- **M-R2: 마이크만** — `-f dshow -i audio="<장치명>"`은 추가 설치 없이 동작한다.
- **시스템 오디오는 별도 검토.** 외부 설치를 요구하는 기능을 조용히 넣지 않는다.

---

## 5. 계약

### 5.1 정지 캡쳐 커맨드 (신규 `commands/capture.rs`)

```rust
/// 프리즈 캡쳐 시작. 커서 모니터 1장을 잡고 표시용 JPEG를 함께 준다.
/// 원본 BGRA는 세션에 남고 IPC로 나가지 않는다.
#[tauri::command(async)]
async fn capture_begin(app: AppHandle, mode: CaptureMode) -> Result<CaptureSession, IpcError>;

/// 확정 영역을 잘라 클립보드로 직행 — 기본 동작. 픽셀이 프론트를 안 거치는 최단 경로.
#[tauri::command(async)]
async fn capture_to_clipboard(id: String, rect: RectPx) -> Result<(), IpcError>;

/// 확정 영역을 잘라 PNG base64로 — 편집기 인계·레포 저장용.
#[tauri::command(async)]
async fn capture_crop(id: String, rect: RectPx) -> Result<String, IpcError>;

/// 확정 영역을 설정된 스크린샷 폴더에 바로 저장. 반환은 파일명(토스트 표시용).
#[tauri::command(async)]
async fn capture_save_default(app: AppHandle, id: String, rect: RectPx) -> Result<String, IpcError>;

/// 루페 색상 — 원본 버퍼의 실제 픽셀(표시용 JPEG를 읽으면 압축 오차가 섞인다).
#[tauri::command(async)]
async fn capture_pixel(id: String, x: i32, y: i32) -> Result<String, IpcError>; // "#RRGGBB"

/// 커서 아래 창 경계 후보(M2). z-order 순, DWM 확장 프레임 기준.
#[tauri::command(async)]
async fn capture_window_rects(id: String) -> Result<Vec<RectPx>, IpcError>;

/// 세션 해제. 오버레이 종료 시 호출 + 60초 TTL 워치독이 이중으로 지운다.
#[tauri::command(async)]
async fn capture_end(id: String) -> Result<(), IpcError>;
```

```ts
type CaptureMode = { kind: "cursorMonitor" } | { kind: "monitor"; index: number };

interface CaptureSession {
  id: string;
  /** 가상 데스크톱 물리 픽셀. x·y는 음수일 수 있다(§4.3). */
  monitor: { x: number; y: number; w: number; h: number; scale: number };
  /** 표시 전용 JPEG(q85) base64. 최종 결과는 여기서 뜨지 않는다. */
  previewJpeg: string;
}

interface RectPx { x: number; y: number; w: number; h: number } // capture space
```

### 5.2 "다른 이름으로 저장" — 경로가 JS를 왕복하지 않는다

`write_file_bytes`는 `resolve_in_repo` 컨테인먼트가 걸려 레포 밖으로 못 쓴다(의도된 것). **"프론트가 준 절대경로에 쓴다"는 커맨드를 만들면 안 된다** — 앱 전체의 파일 쓰기 표면을 임의 경로로 넓히는 것이다.

대신 **Rust가 다이얼로그를 열고, 다이얼로그가 돌려준 경로에 그 자리에서 쓴다.** 기본 저장(`capture_save_default`)도 같은 원칙이다 — 대상 폴더는 설정값이고, 파일명은 Rust가 만든다(프론트가 경로를 정하지 않는다).

### 5.3 `ImageEditor` 입력 계약 확장 — 이번 작업의 유일한 기존 코드 변경

```ts
// 현재 (src/stores/ui.ts:161)
openImageEditor: (path: string, repoId?: string) => void;

// 확장
type EditorSource =
  | { kind: "repo"; path: string; repoId: string | null }        // 기존 — 동작 불변
  | { kind: "capture"; pngBase64: string; suggestedName: string };

openImageEditor: (src: EditorSource) => void;
```

캡쳐 결과는 아직 파일이 아니다. 임시 파일로 우회하면 (a) 레포 밖이라 기존 저장 경로가 안 먹고 (b) 지울 책임이 생긴다. `kind:"repo"`는 지금처럼 원본을 덮어쓰고, `kind:"capture"`는 저장 위치가 없으므로 저장 버튼이 §4.7 라우팅으로 분기한다.

> **선행 조건.** `image-annotation-design.md`의 **D1**(임베디드 저장소 라우팅 결함)이 아직 열려 있다면 같은 커밋에서 처리한다 — 둘 다 `openImageEditor`의 인자 계약을 건드린다.

### 5.4 설정 (`Settings`)

| 키 | 기본값 | 비고 |
|---|---|---|
| `captureHotkey` | **`Ctrl+Shift+X`** | 전역. 등록 실패를 조용히 넘기지 않는다(R1) |
| `recordHotkey` | `Ctrl+Shift+Alt+X` | 〃 |
| `captureDefaultAction` | **`clipboard`** | `clipboard` \| `saveFile` \| `editor` \| `repo` |
| `captureSaveDir` | **`FOLDERID_Screenshots`로 해석** (이 머신: `C:\Users\GreatHoon\Pictures\Screenshots`) | **사용자 경로를 하드코딩하지 않는다** — 다른 사용자·다른 플랫폼에서 깨진다. Known Folder가 없으면 `Pictures\Screenshots`, 그것도 없으면 홈 |
| `captureFileNameFormat` | `Screenshot yyyy-MM-dd HHmmss` | Windows 기본 스크린샷 명명과 같은 형태 |
| `captureRepoDir` | `docs/screenshots` | "레포에 저장"의 기본 하위 경로 |
| `captureKeepWarm` | **`false`** | 상시 프리워밍(§4.4) |
| `captureIncludeCursor` | `false` | M3 |
| `recordFps` | `60` | 30 \| 60 |
| `recordEncoder` | `auto` | `auto` \| `nvenc` \| `qsv` \| `amf` \| `cpu` |
| `recordMaxMinutes` | `10` | 자동 정지 |
| `recordMaxMB` | `2048` | 자동 정지 |
| `recordAudioDevice` | `null` | M-R2. 마이크만 |

### 5.5 녹화 커맨드 (신규 `commands/record.rs`)

```rust
/// 녹화 시작. ffmpeg(ddagrab) 프로세스를 띄우고 job id를 준다.
/// 인코더 선택 체인(§4.1b)과 ddagrab→gdigrab 폴백 판정을 여기서 한다.
#[tauri::command(async)]
async fn record_start(app: AppHandle, rect: RectPx, opts: RecordOpts) -> Result<RecordJob, IpcError>;

/// 정지 — stdin 에 `q`. **kill이 아니다**(moov atom 미기록 → 재생 불가 mp4).
#[tauri::command(async)]
async fn record_stop(app: AppHandle, job_id: String) -> Result<RecordResult, IpcError>;

/// 진행 상태(경과·바이트·드롭 프레임·남은 디스크). 이벤트 `record://progress` 로도 흘린다.
#[tauri::command(async)]
async fn record_status(job_id: String) -> Result<RecordProgress, IpcError>;

/// 인코더 가용성 — 이름 존재가 아니라 **1초 시험 인코딩** 결과를 캐시해 돌려준다.
#[tauri::command(async)]
async fn record_encoder_probe(app: AppHandle) -> Result<Vec<EncoderInfo>, IpcError>;
```

```ts
interface RecordOpts { fps: 30 | 60; encoder: "auto" | "nvenc" | "qsv" | "amf" | "cpu";
                       drawMouse: boolean; audioDevice: string | null }
interface RecordJob { jobId: string; outPath: string; encoder: string; capture: "ddagrab" | "gdigrab" }
interface RecordProgress { elapsedMs: number; bytes: number; droppedFrames: number; diskFreeMB: number }
interface RecordResult { outPath: string; durationMs: number; bytes: number; truncated: boolean }
```

---

## 6. 리스크 레지스터

| # | 리스크 | 근거 | 완화 |
|---|---|---|---|
| **R1** | **전역 단축키가 조용히 안 먹는다** | (a) 다른 앱이 선점 (b) **UIPI** — 관리자 권한 창이 포커스면 일반 권한 프로세스에 키가 안 온다 | 등록 실패를 설정에 **에러로 표시**(토글이 켜진 채 안 먹는 상태 금지). UIPI 제약은 힌트에 명시 — 고칠 수 없고 숨기면 "가끔 안 되는 기능"이 된다 |
| **R2** | 프리워밍 메모리가 OOM 재점화 | 숨긴 WebView2 40~90MB. 이 개발기 여유 4~8% 상시 | 기본 끔 + 지연 프리워밍 + 유휴 10분 파괴 + health `warn` 이상 자동 해제 |
| **R3** | **혼합 DPI에서 사각형이 밀린다** | 이 머신은 배율이 섞여 있다(§2.3 주의 b) | 좌표계 물리 픽셀 단일화, 모니터별 `scale_factor()`. **수용 기준에 혼합 DPI 케이스 포함** |
| **R4** | 가상 화면 원점이 음수 | 실측 `(-2560, 0)` | 부호 있는 타입, 원점 0 가정 금지. 회귀 테스트에 음수 원점 |
| **R5** | ~~Duplication으로 갈아탈 유혹~~ → **해소·분리** | 녹화 요구가 실제로 들어왔고 재측정함 | **정지=BitBlt, 녹화=ddagrab**으로 분리 확정(§4.1a/b). 두 작업의 비용 구조가 반대라 백엔드가 갈리는 것이 정상이다 |
| **R6** | DRM 보호 창이 검게 나온다 | GDI·DDA 공통 한계 | 고칠 수 없다. 검은 영역이 크면 "보호된 콘텐츠는 캡쳐되지 않습니다" 안내 — 사용자가 자기 GPU 탓을 하게 두지 않는다 |
| **R7** | 캡쳐 버퍼 잔류 | 1대 14.7MB, 5대 111MB | 오버레이 종료 시 해제 + 60초 TTL 워치독. 정리 경로 이중화 |
| **R8** | 오버레이가 자기 자신을 찍는다 | 흔한 실수 | 구조적으로 불가 — **오버레이를 띄우기 전에** 캡쳐한다. 순서를 뒤집는 리팩터를 금지하는 주석을 남긴다 |
| **R9** | 저장 커맨드가 파일 쓰기 표면을 넓힌다 | 임의 절대경로 쓰기 | 경로가 JS를 왕복하지 않는다(§5.2) |
| **R10** | **하드웨어 인코더가 이름만 있고 실패** | 드라이버·GPU 세대에 따라 흔함 | 1초 시험 인코딩으로 검증·캐시(§4.1b). 30분 녹화 끝에 실패를 알게 되는 일 금지 |
| **R11** | **ffmpeg를 kill해 mp4가 깨진다** | moov atom 미기록 | 정지는 stdin `q`. 3초 무응답 시에만 kill하고 **그때는 깨졌다고 알린다**. 앱 종료 경로에도 같은 단계(§4.8) |
| **R12** | 녹화가 디스크를 채운다 | 실측 190KB/s(정지 화면), 동적 화면은 수 배 | 최대 길이/크기 자동 정지 + 여유 1GB 가드(§4.8) |
| **R13** | `ddagrab output_idx` ↔ 모니터 매핑이 어긋난다 | DXGI 출력 열거 순서 ≠ Windows 모니터 순서 | 실측으로 매핑 확정 + 테스트 고정. 추측 금지(§4.3) |
| **R14** | 테두리 창이 녹화에 찍힌다 | 1px 오차가 그대로 보인다 | 테두리를 캡쳐 영역 **바깥**에 그린다. 수용 기준에 포함 |
| **R15** | ffmpeg가 없다 | 발견 실패 시 | 기존 `video_tool_status` 안내 UI 재사용 — **다운로드는 명시적 클릭으로만**(`commands/lsp.rs:271` 정책 유지) |

---

## 7. 단계 계획

### M1 — 정지 캡쳐, 속도만 (G1) · **구현됨** (2026-08-27)

전역 단축키 → 커서 모니터 프리즈 → 오버레이 → 드래그 → **클립보드**. 그 외 없음.

**구현 위치**: `src-tauri/src/commands/capture.rs`(BitBlt·프리뷰·크롭·세션), `src-tauri/src/lib.rs`
(`ensure_capture_overlay` / `register_capture_hotkey` / 플러그인), `src/CaptureOverlay.tsx`(선택 UI),
`src/main.tsx`(라벨 라우팅), `capabilities/default.json`(`capture` 창).
검증: Rust 단위 3건(크롭 스트라이드·알파·경계) + e2e `tests/e2e/suites/31-capture.mjs` 9건.

**설계에 없던 결정 3건** — 전부 구현 중 실측·테스트가 강제했다.

| # | 결정 | 왜 |
|---|---|---|
| I1 | **오버레이는 프론트가 "그렸다"고 알린 뒤에 띄운다**(`capture_overlay_ready`) | 백엔드가 바로 띄우면 첫 캡쳐엔 웹뷰 로딩 중 **검은 전체화면**, 두 번째부터는 React가 새 프레임을 칠하기 전 **직전 캡쳐 잔상**이 보인다. 후자가 특히 나쁘다 — 방금 찍은 것과 다른 그림이다. 프론트가 신호를 못 보내는 경우를 위해 1.5초 폴백이 있다 |
| I2 | **선택 중 단축키를 다시 누르면 무시**한다 | 오버레이가 화면을 덮은 상태에서 재캡쳐하면 그 오버레이가 프레임에 찍힌다(R8의 다른 얼굴) |
| I3 | **세션은 모든 단계가 성공한 뒤에만 소모**한다 | 처음엔 세션을 먼저 꺼내고 크롭했는데, 범위 밖 사각형 하나에 **방금 찍은 화면이 사라졌다**(다시 찍을 수도 없다 — 화면이 이미 바뀌었다). e2e ⑤가 이 순서를 고정한다 |
| I4 | **클립보드 쓰기는 8회 재시도**하고, 그래도 실패하면 세션을 살려 둔 채 안내한다 | Windows 클립보드는 다른 프로세스가 잡고 있으면 프로세스를 가리지 않고 막힌다. 이 개발기에서 **AnyDesk가 켜져 있는 동안 `clip.exe`조차 "액세스가 거부되었습니다"로 죽었다**(우리 코드와 무관하게 시스템 전체가 그랬다). 한 번 실패로 포기하면 방금 찍은 화면을 버리는 셈이다 |

**미검증 2건** — 이 개발기에서 확인이 불가능했다.

1. **클립보드 확정 경로의 실물 검증.** 위 I4의 이유로 이 머신의 클립보드가 잡혀 있어 e2e ⑥⑦이 스킵된다(코드 실패와 구분해 스킵으로 표시한다). 크롭 좌표·크기 자체는 Rust 단위 테스트가 본다.
2. **릴리스 빌드 지연.** §3의 예산 검증은 dev(디버그) 빌드에서 못 한다 — 픽셀 루프가 5~10배 느리다. 설치본에서 `[capture] … 캡쳐 Nms · 프리뷰까지 Nms` 로그로 재실측해야 M1 수용기준 1을 판정할 수 있다.

**검증된 것.** 오버레이가 커서 모니터를 정확히 덮고(3840×2160 창 = 2560×1440 CSS @ dpr 1.5), CSS 760×400 드래그가 **1140×600 프레임 픽셀**로 환산됐다 — 배율 1.5가 정확히 반영됐다(수용기준 3의 절반). 세션 해제는 확정·취소·TTL 세 경로 모두 확인.

1. 단축키 → 선택 가능까지 **p50 ≤ 100ms, p95 ≤ 150ms**(프리워밍 상태, 2560×1440). Rust 로그 타임스탬프로 계측.
2. 첫 캡쳐(프리워밍 전)도 **≤ 1.5s** — 최악이어도 지금 체감보다 나쁘지 않다.
3. **혼합 DPI**: 배율이 다른 두 모니터 각각에서, 선택 사각형과 결과 이미지의 픽셀 경계가 **정확히 일치**.
4. **음수 원점**: 주 모니터 왼쪽 모니터에서도 좌표가 안 어긋난다.
5. `Esc` 후 세션 버퍼 즉시 해제(RSS 확인).

### M2 — 정밀 + 끝맺음 (G2·G3)

루페·HEX·창 자동 감지·핸들 리사이즈·방향키·지연 캡쳐, 결과 라우팅 5종, `ImageEditor` 인계(§5.3).

1. 루페 HEX가 **원본 버퍼 값과 일치**(표시용 JPEG에서 읽으면 틀린다 — 테스트로 고정).
2. 창 자동 감지가 **DWM 확장 프레임** 기준 — 그림자 여백이 안 붙는다.
3. "레포에 저장" 후 Changes에 **즉시** 뜬다.
4. 에디터 인계 시 `kind:"repo"` 기존 동작 **불변**(회귀).
5. 기본 저장이 `Pictures\Screenshots`에 Windows 기본과 같은 형태의 파일명으로 떨어진다.

### M-R1 — 녹화 최소 (G4)

영역 선택(M1 오버레이 공유) → ddagrab 녹화 → 정지 → mp4 → 비디오 편집기 인계. **무음.**

1. 2560×1440 60fps에서 **드롭 ≤ 5%**(실측 ddagrab 59/60 = 1.7%).
2. `record_stop` 후 mp4가 **정상 재생**된다(moov atom — R11).
3. ddagrab 실패 환경에서 gdigrab으로 내려가되 **성능 저하를 알린다**.
4. 인코더 시험 인코딩이 실제 가용성과 일치(R10).
5. 테두리 창이 결과물에 **안 찍힌다**(R14).
6. 최대 길이/크기 도달 시 자동 정지하고 알린다.
7. 앱을 그냥 종료해도 녹화 중이던 파일이 **안 깨진다**.

### M-R2 — 녹화 편의

마이크 오디오, 일시정지/재개, 카운트다운, 진행 표시 고도화, "GIF로 변환" 원클릭(기존 `video_export` 호출).

### M3 — 확장

모니터 경계 넘는 선택, 결과 핀 창, 커서 포함, 마지막 영역 재캡쳐.

### DoD (공통)

- `npm run tauri build`로 릴리스 번들이 나오고 **설치본에서** 동작한다(dev와 설치본의 런치 환경변수 차이는 이 앱의 상습 함정 — `CLAUDE.md`).
- e2e 회귀 추가: 세션 해제, 혼합 DPI 좌표, 음수 원점, ffmpeg 부재 시 안내.
- `capabilities/default.json`에 `capture`·`rec-frame` 창과 신규 권한이 등록돼 있다.
- Windows 외 플랫폼에서 **조용히 죽지 않는다** — 미지원이면 그렇게 말한다.

---

## 8. 비목표

| 항목 | 이유 |
|---|---|
| **스크롤 캡쳐** | 대상 앱마다 스크롤 방식이 달라 휴리스틱 덩어리가 된다. 캡쳐 기능 전체보다 복잡해진다 |
| **시스템 오디오(루프백) 녹음** | Windows ffmpeg에 WASAPI 루프백 입력이 없다. `virtual-audio-capturer` 등 **외부 설치를 요구하는 기능을 조용히 넣지 않는다**(§4.8). 마이크는 M-R2 |
| **웹캠 오버레이 / 화면+캠 합성** | OBS의 영역. 개발 기록용 녹화에 불필요 |
| **OCR / 번역 / 클라우드 업로드** | 캡쳐 툴에 무관한 기능이 붙는 전형적 경로. 필요해지면 별도 설계 |
| **DRM 보호 화면 캡쳐** | OS가 막는다. 우회를 시도하지 않는다 |
| **크로스 플랫폼 동시 출시** | 1차 Windows. macOS는 `CGDisplayCreateImage` + 화면 기록 권한, Linux는 X11/Wayland 분기(Wayland는 포털 필수) — **캡쳐 계층만 다시 쓰는 수준**이고 오버레이·선택 UI·결과 라우팅·ffmpeg 인코딩은 그대로 재사용된다. 녹화는 `x11grab`/`kmsgrab`으로 대응 가능 |
