# 이미지 줌·동영상 재생 — 뷰어 확장 설계

> 상태: 설계(Design) · 2026-08-04 · `/sc:design` 산출물 · 대상: gitpervisor (Tauri 2 + React 19)
>
> 요구: ① 이미지 뷰어에 줌인/줌아웃 ② 동영상 파일 재생

---

## 0. 범위와 결정 요약

| # | 항목 | 결론 | 규모 | 위험 |
|---|---|---|---|---|
| A | 이미지 줌·팬 | `<img>`에 CSS `transform`(scale+translate). 커서 고정 줌, 드래그 팬 | small | low |
| B | 동영상 재생 | **기존 프리뷰 루프백 서버 재사용** + `<video controls>` | medium | medium |
| C | CSP `media-src` | **없으면 B가 통째로 막힌다** — 반드시 함께 넣는다 | trivial | — |
| D | 미디어 파일의 diff 낭비 | 이미지·동영상은 `useDiff`를 끈다 | trivial | low |

**핵심 판단 3가지**

1. **동영상용 백엔드는 이미 다 있다.** `preview.rs`가 Range 206(`:474`), `Accept-Ranges`(`:484`),
   `mp4`/`webm`/`mp3`/`wav` MIME(`:579-582`)을 지원하고, `preview_local_url`은 확장자를 제한하지
   않는다(`:145`의 `is_file()`만 본다). HTML 프리뷰 때 "WKWebView는 미디어를 Range 없이 재생하지
   못한다"는 이유로 넣어 둔 것이 그대로 쓰인다. **새 백엔드 커맨드가 필요 없다.**
2. **base64 경로(`read_file_base64`)는 동영상에 쓰면 안 된다.** 25MB 상한(`diff.rs:228`)도 문제지만,
   근본적으로 전체를 메모리에 올리고 data URL로 넘기는 구조라 **탐색(seek)이 불가능**하다.
   동영상은 반드시 HTTP Range 경로여야 한다.
3. **막는 것은 앱 CSP 하나다.** 현재 `default-src 'self'`이고 `media-src`가 없어
   `<video src="http://127.0.0.1:…">`가 차단된다. `img-src`·`frame-src`는 이미 열려 있는데
   미디어만 빠져 있다.

---

## 1. 현재 구조 (확인된 사실)

```
DiffViewer.tsx:144   const isImageView = isImage(target.path)   // 모드 무관, 워크트리 파일을 렌더
DiffViewer.tsx:571   {isImageView ? <ImageView …/> : … }        // diff/에디터보다 먼저 분기
ImageView.tsx        useFileImage → data:<mime>;base64,…  +  맞춤/실제크기 토글뿐
language-map.ts:65   IMAGE_EXT = png/jpg/jpeg/gif/webp/bmp/ico/avif/svg
diff.rs:228          MAX_IMAGE_BYTES = 25MB (base64 IPC 상한)
queries/index.ts:449 useDiff — enabled가 `!!projectId && !!target` 뿐 (이미지도 diff를 부른다)
```

프리뷰 루프백 서버(`preview.rs`)의 이미 가진 능력:

- `preview_local_url(project_id, rel_path)` → `http://127.0.0.1:PORT/파일?t=TOKEN`
- 파일의 **상위 폴더**를 루트로 서빙, 폴더별 토큰, dotfile 차단, 경로 탈출 봉쇄
- **단일 Range 206 + `Accept-Ranges: bytes`** ← 동영상 탐색의 전제
- 유휴 10분 자동 종료, 프로젝트 제거 시 폐기

---

## 2. [A] 이미지 줌·팬

### 2.1 상호작용 스펙

| 입력 | 동작 | 근거 |
|---|---|---|
| `Ctrl/⌘ + 휠` | **커서 위치 고정** 줌 | 트랙패드 핀치가 브라우저에서 `ctrl+wheel`로 오므로 핀치줌이 공짜로 붙는다 |
| 맨 휠 | 세로 스크롤(팬) | 확대 상태에서 문서처럼 훑는 기본 기대 |
| `Shift + 휠` | 가로 팬 | |
| 드래그 | 팬 (확대 시 `cursor: grab/grabbing`) | |
| 더블클릭 | 맞춤 ↔ 100% 토글 | 기존 토글의 자연스러운 계승 |
| `+` / `-` / `0` / `1` | 확대 / 축소 / 맞춤 / 100% | |
| 툴바 | `−` `[42%]` `+` · `맞춤` · `1:1` | 배율을 **숫자로 보여주는 것**이 핵심 — 지금은 상태를 알 수 없다 |

배율 범위 **0.05 ~ 16배**, 휠 1노치당 `×1.1`(지수 스텝이라 어느 배율에서든 체감이 균일).

### 2.2 커서 고정 줌 수학 (구현자가 그대로 쓸 식)

컨테이너 기준 커서 좌표 `c`, 이미지 오프셋 `o`, 배율 `s`일 때 **커서 아래의 이미지 점이 그대로
있어야** 한다. 그 조건이 다음 한 줄이다:

```
o' = c - (c - o) * (s' / s)
```

`transform-origin: 0 0`으로 두고 `transform: translate(o.x px, o.y px) scale(s)`를 쓴다.
(origin을 `center`로 두면 위 식이 컨테이너 크기에 의존해 지저분해진다.)

### 2.3 렌더링 결정

- **`width/height`가 아니라 `transform`** — 레이아웃 재계산 없이 GPU 합성으로 처리돼 큰 이미지에서도
  휠 줌이 끊기지 않는다.
- 컨테이너는 `overflow-hidden` + 자체 팬. 브라우저 스크롤바에 맡기면 위 좌표 수학과 이중으로
  움직여 어긋난다.
- `s > 2`면 `image-rendering: pixelated` — 아이콘·픽셀아트를 볼 때 흐려지지 않게. 벡터(SVG)는
  transform으로 확대해도 선명하므로 예외 없이 동일 경로.
- 기존 `checkerboard` 배경(투명 PNG 확인용)은 유지한다.
- 파일이 바뀌면 배율·오프셋을 맞춤으로 리셋(현재 `useEffect(…, [path])`와 동일한 자리).

### 2.4 변경 지점

| 파일 | 변경 |
|---|---|
| `components/diff/ImageView.tsx` | 토글 → 줌/팬 상태와 툴바로 교체 (이 작업의 대부분) |

**백엔드·라우팅 변경 없음.** 기존 `useFileImage`/data URL을 그대로 쓴다. 25MB 상한도 유지 —
줌은 이미 로드된 이미지의 표시 문제라 데이터 경로를 바꿀 이유가 없다(YAGNI).

---

## 3. [B] 동영상 재생

### 3.1 결론 — 루프백 서버 재사용

```
VideoView 마운트
  → ipc.previewLocalUrl(projectId, relPath)        // 기존 커맨드 그대로
  → <video src="http://127.0.0.1:PORT/파일?t=…" controls>
  → 브라우저가 Range로 필요한 구간만 요청 → preview.rs가 206으로 응답 → 탐색 동작
```

**컨트롤은 네이티브 `controls` 속성을 쓴다.** 재생/일시정지·탐색바·볼륨·전체화면·재생속도가 전부
따라오고, 커스텀 컨트롤은 이 요구에 비해 과하다(YAGNI).

자동재생 안 함(음소거 자동재생 정책에 얽히고, 파일을 열자마자 소리가 나면 놀란다).

### 3.2 ⚠️ CSP `media-src` — 없으면 통째로 막힌다

`tauri.conf.json`의 현재 CSP에 `media-src`가 없어 `default-src 'self'`로 폴백한다. 그러면
`127.0.0.1`의 미디어가 **차단되어 아무것도 재생되지 않는다.** `img-src`·`frame-src`는 이미 열려
있는데 미디어만 빠진 상태다.

```
media-src 'self' http://localhost:* http://127.0.0.1:*
```

`frame-src`가 이미 같은 형태로 열려 있으므로 노출 범위가 새로 넓어지지는 않는다.

### 3.3 코덱 — 플랫폼별로 갈린다 (설계의 가장 큰 불확실성)

재생 가능 여부는 **앱이 아니라 각 OS의 웹뷰 엔진**이 정한다:

| 플랫폼 | 엔진 | 대체로 되는 것 | 위험 |
|---|---|---|---|
| macOS | WKWebView(Safari) | mp4/mov (H.264·HEVC) | **WebM/VP9·AV1이 안 될 수 있다** |
| Windows | WebView2(Chromium) | mp4, webm(VP8/VP9), 대체로 av1 | 낮음 |
| Linux | WebKitGTK | GStreamer 플러그인 설치 상태에 **전적으로 의존** | 높음 |

→ **같은 파일이 Windows에선 되고 macOS에선 안 되는 상황이 정상적으로 발생한다.** 따라서:

- `<video onError>` 와 `onStalled`를 반드시 붙이고, 실패 시 **원인을 감추지 말 것**:
  > "이 형식은 현재 플랫폼의 웹뷰가 재생할 수 없습니다 (코덱 미지원)"
  > `[외부 앱으로 열기]` ← 기존 `ipc.openIn` 재사용
- 확장자 목록: `mp4`, `m4v`, `mov`, `webm`, `ogv`. **확장자는 컨테이너일 뿐 코덱을 보장하지 않으므로**
  "목록에 있으면 재생 시도, 실패하면 안내"가 유일하게 정직한 계약이다.
- `preview.rs`의 `content_type()`에 `mov`(`video/quicktime`), `m4v`, `ogv`가 없다 → 추가 필요.
  없으면 `application/octet-stream` + `nosniff`로 재생이 막힌다(§8의 `.xhtml`과 같은 부류의 실수).

### 3.4 유휴 종료와의 충돌 (놓치기 쉬운 지점)

프리뷰 서버는 **요청이 10분간 없으면 스스로 종료**한다(`IDLE_SECS = 600`). 그런데 동영상을
일시정지해 두면 요청이 끊긴다 → 10분 뒤 서버가 죽고 → 재생/탐색 재개 시 연결 거부.

대응(택1, **(a) 권장**):

- **(a) 실패 시 재발급** — `onError`에서 `previewLocalUrl`을 다시 호출해 새 URL로 교체하고
  `currentTime`을 복원한다. `stores/browser.ts`의 `remintPreview`와 같은 패턴이고, 서버가 죽는
  다른 원인까지 함께 덮는다.
- (b) 재생 중이 아닐 때도 주기적 HEAD 핑 — 단순하지만 "안 쓰는 서버를 살려 둔다"는 유휴 종료의
  취지를 정면으로 거스른다.

### 3.5 변경 지점

| 파일 | 변경 |
|---|---|
| `src-tauri/tauri.conf.json` | CSP에 `media-src` 추가 **(선행 필수)** |
| `src-tauri/src/commands/preview.rs` | `content_type()`에 `mov`/`m4v`/`ogv` 추가 |
| `src/lib/language-map.ts` | `isVideo()` + `VIDEO_EXT` 추가 |
| `src/components/diff/VideoView.tsx` | **신규** — 마운트 시 mint → `<video controls>` → 실패 시 재발급·안내 |
| `src/components/diff/DiffViewer.tsx` | `isVideoView` 분기를 `isImageView` 옆에 추가 |

---

## 4. [D] 미디어 파일의 diff 낭비

`useDiff`는 `enabled`가 `!!projectId && !!target`뿐이라(`queries/index.ts:449`) **이미지를 열 때도
git diff를 부른다.** 이미지는 결과를 쓰지도 않는다(`isImageView`가 그 앞에서 분기). 동영상은 파일이
GB 단위일 수 있어 더 낭비다.

→ `useDiff`에 `enabled: … && !isMedia(path)`를 더한다. 미디어 뷰는 `isBinary`/`tooLarge` 판정을
쓰지 않으므로 안전하다.

---

## 5. 구현 순서

1. **[C] CSP `media-src`** — 한 줄이지만 이게 없으면 [B]가 아예 동작하지 않아 디버깅이 미궁에 빠진다.
   (`aggregate` 창이 capability 누락으로 "드래그만 안 되는 것처럼" 보였던 것과 같은 부류다.)
2. **[A] 이미지 줌** — 프론트 단일 파일, 독립적이고 위험이 낮다.
3. **[B] 동영상** — MIME 추가 → `isVideo` → `VideoView` → 라우팅 순.
4. **[D] diff 게이팅** — 마지막에 정리.

---

## 6. 오픈 이슈 (사용자 결정 필요)

| # | 질문 | 선택지 | 권고 |
|---|---|---|---|
| ① | 맨 휠의 기본 동작 | (a) 팬/스크롤 (b) 줌 | **(a)** — 확대 상태에서 훑는 게 더 잦고, 핀치·`⌘휠`로 줌은 이미 된다 |
| ② | 오디오 파일(mp3/wav/m4a)도 지금 넣을까 | (a) 지금 (b) 나중 | **(a)** — 같은 서버·같은 배선에 `<audio>`만 바꾸면 되어 한계비용이 거의 0 |
| ③ | 동영상 첫 프레임 썸네일(poster) | (a) 없음 (b) 생성 | **(a)** — 생성하려면 ffmpeg 의존이 생긴다. 과하다 |
| ④ | 이미지도 루프백 서버로 통일할까 | (a) 현행 base64 유지 (b) 통일 | **(a)** — 이미지는 작고 지금 잘 된다. 25MB 넘는 이미지 요구가 실제로 생기면 그때 |

---

## 7. 하지 않기로 한 것 (그리고 이유)

- **커스텀 비디오 컨트롤** — 네이티브 `controls`로 충분하다. 만들면 전체화면·자막·속도까지 직접 떠안는다.
- **동영상 트랜스코딩** — ffmpeg 번들은 앱 크기와 배포 복잡도를 크게 올린다. 못 여는 형식은
  "외부 앱으로 열기"로 넘긴다.
- **이미지 회전·플립·주석** — 요구에 없다.
- **동영상 diff/버전 비교** — git이 바이너리로 취급하는 대상이라 의미가 없다.

---

## 8. 미검증 영역 — 정직 고지

- **코덱 지원표(§3.3)는 일반적으로 알려진 내용이며 이 앱에서 실측하지 않았다.** 특히 Linux
  WebKitGTK는 배포판·GStreamer 구성에 따라 크게 갈린다. 구현 후 플랫폼별 실파일 확인이 필요하다.
- macOS는 WKWebView라 CDP가 열리지 않아 **자동 GUI 검증이 불가능**하다(이 레포의 e2e는 CDP 전제).
  줌 상호작용과 재생은 수동 확인해야 한다.
- 큰 동영상에서 `preview.rs`의 커넥션당 스레드 모델(동시 64 상한)이 어떻게 버티는지 미측정.
  단일 재생은 커넥션이 몇 개뿐이라 문제없을 것으로 보나, 확인은 필요하다.
