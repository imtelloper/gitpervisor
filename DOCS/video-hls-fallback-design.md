# 웹뷰 미지원 코덱 — 온디맨드 HLS 트랜스코딩 폴백

> 상태: 구현 완료 · 2026-09-10 · 대상: gitpervisor (Tauri 2 + React 19)
>
> 계기: 1080p30 **AV1** mp4 강의 파일이 macOS(M1 Pro) 뷰어에서 통째로 재생 불가.

---

## 0. 문제

뷰어의 재생은 웹뷰 안의 `<video>`다. **디코더 목록을 웹뷰 엔진이 정하므로 앱이 자기 디코더를
끼워 넣을 수 없다.** macOS WebKit은 AV1을 하드웨어 디코더가 있는 기기(M3·A17 Pro 이상)에서만
켜므로, M1/M2/Intel 맥에서는 AV1이 통째로 막힌다.

M1 Pro에서 직접 잰 값:

| 확인 대상 | 결과 |
|---|---|
| `video.canPlayType('video/mp4; codecs="av01.0.08M.08"')` | `""` (불가) |
| `MediaSource.isTypeSupported(av01…)` | `false` |
| `VideoDecoder.isConfigSupported({codec:'av01…'})` (WebCodecs) | `supported: false` |
| `VTIsHardwareDecodeSupported(kCMVideoCodecType_AV1)` | `false` |
| `AVURLAsset.isPlayable` / 트랙 `isDecodable` (실파일) | `false` / `false` |
| H.264 · HEVC · VP9 · AAC | 전부 `probably` / `true` |

즉 **QuickTime·미리보기도 못 연다.** Movist/VLC가 되는 건 그들이 dav1d를 **번들해 자기 화면에
직접 그리기** 때문이다(`/Applications/Movist.app/Contents/Frameworks/libavcodec…dylib` 안에
`dav1d AV1 decoder by VideoLAN` 문자열이 있다). 파일이 특별한 게 아니다.

## 1. 왜 이 설계인가

검토한 세 갈래와 탈락 사유:

| 안 | 내용 | 판정 |
|---|---|---|
| A. 네이티브 재생 표면 | libVLC/mpv를 웹뷰 위 네이티브 뷰로 겹친다(Movist 방식) | **탈락** — `VideoPlayer.tsx`의 타임라인·구간반복·크롭이 전부 `HTMLVideoElement` 위에 서 있어 플랫폼마다 재작성. 얻는 건 코덱 하나 |
| B. **트랜스코딩 프록시** | ffmpeg가 디코딩하고 웹뷰엔 H.264만 준다 | **채택** |
| C. WASM 디코더 | dav1d.wasm + canvas | **탈락** — `SharedArrayBuffer`가 `false`(crossOriginIsolated 아님)라 멀티스레드 불가. 단일 스레드로 1080p는 실시간 미달이고, `<video>` 기반 UI를 통째로 버려야 한다 |

B 안에서 다시 두 갈래였다. **전체 변환**은 이미 있다(VideoPlayer의 "mp4로 변환해 열기") —
정확하지만 300MB 파일에 수 분을 기다리고 원본 옆에 사본을 남긴다. 그래서 **재생하는 구간만
그때그때 굽는** HLS를 얹었다. 즉시 시작하고, 탐색한 곳부터 만들고, 파일을 남기지 않는다.

**HLS를 고른 결정적 이유는 `<video>`를 버리지 않아도 되기 때문이다.** WKWebView는 HLS를
네이티브로 문다(`canPlayType('application/vnd.apple.mpegurl')` = `"maybe"`). `src`만 재생목록
URL로 바꾸면 타임라인·구간 반복·단축키가 전부 그대로 산다. MSE + fMP4 경로는 JS 로더를
새로 써야 한다.

## 2. 구조

```
VideoPlayer  ──(<video> error 2회)──▶  ipc.videoHlsUrl
                                            │
                                     hls.rs: 세션 등록(ffprobe 1회)
                                            │
   <video src="http://127.0.0.1:P/.hls/{sid}/index.m3u8?t=TOK">
                                            │
                     preview.rs 서버 ──▶ hls::route()
                                            ├─ index.m3u8 → VOD 재생목록(인라인)
                                            └─ {n}.ts     → ensure_segment(n) → 파일
                                                              └─ ffmpeg 1회 = 6초
```

- **서버는 새로 만들지 않는다.** 미디어 파일의 상위 폴더를 이미 `preview.rs`가 서빙하고 있어
  토큰 인증·유휴 종료·Range 응답을 그대로 얹는다(`ensure_server`로 공유).
- **경로 접두사가 `/.hls/`인 이유**: `resolve_request_path`가 `.`으로 시작하는 세그먼트를 무조건
  거부하므로(dotfile 차단), 레포에 `.hls` 폴더가 있어도 **충돌이 성립하지 않는다.**
  회귀 테스트 `dot_prefixed_paths_are_never_resolved_as_repo_files`가 이 성질을 고정한다.
- **세그먼트 URI에 토큰을 직접 박는다.** 미디어 서브리소스의 `Referer`는 엔진마다 달라 못 믿는다.

## 3. 반드시 지켜야 하는 것

- **`-output_ts_offset`을 빼면 안 된다.** 세그먼트를 독립 호출로 구우면 출력 타임스탬프가 매번
  0에서 시작한다. 재생기는 그걸 이어 붙이지 못한다. 실측으로 확인한 값:
  `0.ts` 첫 PTS `0.021`, `1.ts` `6.000000`, `500.ts` `3000.000000`.
- **`-muxdelay 0 -muxpreload 0`.** mpegts 머서 기본값(0.7+0.7초)이 경계마다 빈틈을 만든다.
- **완성 판정은 원자적 rename이다** (`N.ts.part` → `N.ts`). 쓰는 중인 파일을 길이만 보고 내보내면
  잘린 세그먼트가 재생기에 가고, 그건 **조용한 재생 정지**로 나타난다.
- **비트레이트를 원본 수치로 캡하면 안 된다.** 실측 파일이 1080p30 AV1 **354kbps**인데, 그대로
  상한을 삼으면 H.264도 354kbps로 굽는다 — AV1이 그 비트로 하던 일을 H.264는 절반도 못 한다.
  애초에 **원본이 더 효율적인 코덱이라서** 폴백이 필요한 상황이라, 계수를 빼먹으면 거의 항상
  틀린 쪽으로 틀린다. `codec_factor()`가 AV1 2.0 / HEVC·VP9 1.6을 곱한다.
- **크기는 짝수로 내린다.** yuv420p 크로마 서브샘플링이 홀수를 못 받아 인코더가 통째로 실패한다.
- **하드웨어 인코더를 쓴다**(macOS `h264_videotoolbox`). 이 폴백의 병목은 원본 **소프트웨어
  디코딩**이라, 인코딩까지 CPU로 하면 실시간을 못 따라가는 기기가 생긴다.

## 4. 실측 (M1 Pro · 1080p30 AV1 · 1시간 54분 · 300MB)

| 항목 | 값 |
|---|---|
| 세그먼트 1개(6초) 생성 | **1.4–1.6초** (실시간의 4배) |
| 3000초 지점 탐색 후 생성 | 1.39초 (앞에서부터 읽지 않는다) |
| WKWebView 재생 | `readyState:4`, `currentTime` 2.51→7.77→16.70, 오류 없음 |
| 경계(6s·12s) 통과 | 이상 없음 |
| 13초로 탐색 | 정상 |

선반입 2개(`PREFETCH`)면 재생이 생성보다 앞설 수 없다.

## 5. 함께 고친 것 — GUI로 띄운 앱은 `/usr/local/bin`을 못 본다

이 기계에 ffmpeg 8.0이 `/usr/local/bin`에 **설치돼 있었는데 앱은 못 찾고 있었다.** 편집·변환
기능이 통째로 비활성이었고 폴백도 같은 이유로 죽었을 것이다.

`find_on_path`는 프로세스의 `PATH`만 본다. Finder/독으로 띄운 macOS 앱의 `PATH`는 launchd가 주는
`/usr/bin:/bin:/usr/sbin:/sbin`뿐이라, 셸 프로필이 넣어 주던 Homebrew 경로가 통째로 빠진다.
CLAUDE.md의 **"dev는 되는데 설치본만 이상하다 = 런치 환경변수 차이"** 와 같은 부류다.

`find_ffmpeg`에 관례 경로 탐색(②′)을 넣었다: `/opt/homebrew/bin`, `/usr/local/bin`,
`/opt/local/bin`, `/snap/bin`, `~/.local/bin`, `~/bin`. Windows는 GUI 프로세스도 PATH를 온전히
물려받아 이 구멍이 없으므로 제외한다.

> 같은 구멍이 포매터·린터·LSP 발견에도 있다(`tools/runner.rs`의 `discover`). 이번엔 ffmpeg만
> 고쳤다 — 그쪽은 영향 범위가 훨씬 넓어 별도 판단이 필요하다.

## 6. 자원 관리

| 대상 | 규칙 |
|---|---|
| 세그먼트 캐시 | 세션당 1.5GiB, 초과 시 **가장 오래 안 쓴 것부터** 삭제(재생 중 구간은 mtime이 새것이라 살아남는다) |
| 세션 | 요청이 45분 끊기면 회수. 최대 4개, 초과 시 가장 오래 조용한 것부터 |
| 캐시 루트 | 프로세스당 1회 통째로 비운다 — 비정상 종료 잔재와 원본이 바뀐 파일의 낡은 조각을 한 번에 정리 |
| 동시 ffmpeg | 2개. **선반입은 상한에 걸리면 줄 서지 않고 포기**한다(대기열이 쌓이면 사용자가 탐색한 지점이 옛 선반입 뒤로 밀린다) |
| 종료 시 자식 | `hls_kill_all()`을 `shutdown_children`에 등록(unix는 `process_group(0)` + `killpg`) |

프론트의 keep-alive 핑은 HLS로 갈아탄 뒤 `videoHlsUrl`을 부른다 — 일시정지 중에는 세그먼트
요청이 없어 세션 시계가 그대로 흐르기 때문이다. `videoHlsUrl`은 멱등이고 내부에서 프리뷰 서버까지
함께 확보하므로 핑 하나로 둘 다 산다.

## 7. 검증 경계

macOS에서는 **레포의 CDP e2e 하네스를 쓸 수 없다** — `--remote-debugging-port`는 WebView2
전용이다(`lib.rs:166`). 그래서 이 기능은 다음으로 나눠 검증했다:

- 실파일 트랜스코딩·타임스탬프·WKWebView 재생 — 별도 하네스로 **실측**(§4)
- 라우팅·토큰 인증·MIME·dotfile 격리 — `preview.rs`의 소켓 레벨 통합 테스트
- 재생목록 산술·크기 짝수화·비트레이트 계수 — `hls.rs` 유닛 테스트
- **앱 UI에서의 폴백 발동(`onError` → `switchToHls`)** — Windows에서 e2e 스위트로 덮을 것
