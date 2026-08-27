# 동영상 플레이어 고도화·편집 — 설계

> 상태: **구현됨**(P1~P4, 2026-08-27) · `/sc:design` 산출물 · 대상: gitpervisor (Tauri 2 + React 19)
> 구현: `src-tauri/src/commands/video.rs` · `src/components/video/*` · P5(코덱 변환 폴백)는 후속.
> 구현이 설계와 다른 점: 구간 수치 입력 필드는 생략(프레임 스텝 `,`/`.` + `Shift+←→` 1초로 대체),
> webm 출력 생략(mp4/GIF/오디오만), Windows arm64 관리 다운로드 없음(PATH 안내).
>
> 요구: ① 구간 클립 추출 ② 배속(느리게/빠르게) ③ 무손실/저화질 저장 ④ ±5초 탐색
> ⑤ 구간 반복 ⑥ 특정 영역만 추출 — + 추천 기능 반영

---

## 0. 범위와 결정 요약

요구 6개는 **ffmpeg가 필요한 것과 아닌 것**으로 정확히 반 갈린다. 이 경계가 설계의 뼈대다.

| 계층 | 담는 것 | 요구 | ffmpeg | 규모 |
|---|---|---|---|---|
| **L1 플레이어** | 커스텀 컨트롤: 배속, ±5s, 구간(A-B) 반복, 프레임 스텝, 단축키 | ②(재생)④⑤ | **불필요** | medium |
| **L0 도구 준비** | ffmpeg/ffprobe 발견 체인 + 온디맨드 다운로드 | — | — | medium |
| **L2 내보내기** | 구간 클립(무손실/정밀), 배속 저장, 화질/해상도, 영역 크롭, 프레임 캡처, GIF, 오디오 추출 | ①②(저장)③⑥ | **필요** | large |

**핵심 판단 5가지**

1. **L1은 백엔드 변경 0으로 지금 바로 된다.** `<video>`의 `currentTime`/`playbackRate`/`timeupdate`만으로
   ②④⑤가 충족된다. 기존 `MediaView.tsx`의 mint/재발급/외부앱 골격은 그대로 두고 `controls` 속성만
   커스텀 컨트롤로 바꾼다. — 이전 설계(`media-viewer-design.md` §7)가 "네이티브 controls로 충분(YAGNI)"
   이라 했던 결정을 **명시적으로 뒤집는다**: A-B 반복·구간 핸들·±5s 버튼은 네이티브 컨트롤에 없다.
2. **ffmpeg는 번들하지 않고 발견 우선 + 온디맨드 다운로드.** 설치본 크기를 40~90MB 늘리지 않는다.
   이 앱 사용자는 개발자라 PATH에 ffmpeg가 이미 있는 경우가 많다 → `tools/runner.rs`의 발견 체인
   (명시 경로 → PATH → 관리 설치본)을 그대로 쓰고, 없으면 `lsp/acquire.rs`의 검증-다운로드 파이프라인으로
   받는다. **다운로드는 명시적 클릭으로만**("클릭이 곧 동의", `commands/lsp.rs:271` 정책 유지).
3. **하나의 '구간(A-B)' 상태가 ⑤반복과 ①추출 양쪽의 입력이다.** 타임라인에 In/Out 핸들 하나를 만들면
   반복 재생 범위이자 클립 추출 범위가 된다. 별도 UI 두 벌을 만들지 않는다.
4. **무손실과 정밀은 다른 물건이고, 정직하게 둘 다 노출한다.** 스트림 카피(`-c copy`)는 재인코딩이 없어
   빠르고 무손실이지만 **시작점이 직전 키프레임으로 스냅**된다(소스 GOP에 따라 최대 수 초). 배속·크롭·
   화질 변경은 스트림 카피와 양립 불가 → 그 옵션을 켜면 UI가 자동으로 재인코딩 모드로 전환하며 알린다.
5. **프레임 캡처는 캔버스로 못 한다.** 비디오 소스가 `http://127.0.0.1`(루프백)이라 앱 origin과 다르고
   preview.rs는 CORS 헤더를 보내지 않는다(`preview.rs:482-487`) → `drawImage(video)` 하면 캔버스가
   taint되어 `toDataURL`이 throw한다. 캡처·추출류는 전부 ffmpeg 경로다. (CORS를 여는 대안은 CSP
   `connect-src`까지 건드려야 해서 손해다.)

---

## 1. 현재 구조 (확인된 사실)

```
MediaView.tsx           previewLocalUrl → <video controls> · 유휴사망 시 1회 재발급 · 외부앱 폴백
preview.rs:455-487      단일 Range 206 + Accept-Ranges — 탐색은 이미 된다. CORS 헤더 없음
preview.rs:579-590      MIME: mp4/m4v/mov/webm/ogv (+오디오). mkv/avi 없음 → octet-stream+nosniff로 재생 불가
language-map.ts:102     VIDEO_EXT = mp4 m4v mov webm ogv — preview.rs MIME 맵과 짝 (한쪽만 고치면 침묵 파손,
                        preview.rs:646 테스트가 짝을 강제)
DiffViewer.tsx:145-147  isImage → ImageView, isPlayable → MediaView (diff 모드 무관, 워크트리 파일)
queries/index.ts:450    useDiff는 미디어 경로에서 disabled — 유지
KeyboardShortcuts.tsx   전역 단축키는 수정자 조합만 점유 — Space/화살표/JKL 등 맨 키는 비어 있다
lsp/acquire.rs          다운로드→sha 검증→압축해제→.tmp+rename 원자 설치→.ok 마커 (전체 파이프라인 완비)
tools/runner.rs:196     발견 체인: 명시 경로→(프로젝트 로컬)→PATH(60s 미스 캐시)→번들 폴백
sync.rs:60-105          장기 잡 골격: async 커맨드 + app.emit 진행 이벤트 + 종결 이벤트(ok/error)
http.rs:177-186,362     취소 킷: 프론트 생성 job id + AppState 레지스트리 + RAII 가드 + 멱등 cancel
git/runner.rs:248-347   스폰 규약: args 배열, CREATE_NO_WINDOW, process_group(0), kill_group
ImageEditor.tsx         전체화면 모달 + 크롭 드래그 사각형 + 접미사 저장 + ALREADY_EXISTS→덮어쓰기 확인
capabilities            dialog:default 있음 · tauri-plugin-fs 없음(파일 IO는 전부 커스텀 커맨드)
```

---

## 2. [L1] 플레이어 고도화 — ffmpeg 없이 되는 전부

### 2.1 구성

`MediaView.tsx`는 오디오 전용 + 비디오 라우팅만 남기고, 비디오는 신규 `VideoPlayer`로 뺀다.
mint/유휴사망 재발급/외부앱 폴백/자동재생 안 함 원칙은 전부 승계한다.

```
src/components/video/VideoPlayer.tsx     <video> + 커스텀 컨트롤 + 타임라인 + 단축키
src/components/video/Timeline.tsx        탐색바 + In/Out 구간 핸들 (A-B)
```

### 2.2 컨트롤·단축키 스펙

키는 **포커스된 플레이어 컨테이너**(tabIndex=0)에 바인딩한다 — window 리스너가 아니므로
Ctrl+W(탭 닫기) 등 전역 단축키와 충돌하지 않고, 맨 키(Space/화살표)는 전역에서 비어 있음이 확인됐다.

| 입력 | 동작 | 요구 |
|---|---|---|
| `Space` / `K` | 재생·일시정지 | |
| `←` / `→` | **−5초 / +5초** (버튼도 제공) | ④ |
| `Shift+←/→` | −1초 / +1초 (미세 조정) | |
| `,` / `.` | 프레임 스텝 (일시정지 상태, `currentTime ± 1/fps`) | 추천 |
| `I` / `O` | 구간 시작(In) / 끝(Out) 지정 — 영상 편집 관례 | ①⑤ |
| `R` | 구간 반복 토글 | ⑤ |
| `-` / `=` | 배속 한 단계 ↓/↑ | ② |
| `M` / `F` | 음소거 / 확대 보기 | |
| `0`~`9` | 0%~90% 지점으로 점프 | |

- **배속(②재생)**: `video.playbackRate`, 프리셋 `0.25 / 0.5 / 0.75 / 1 / 1.25 / 1.5 / 2 / 4`.
  `preservesPitch`가 기본 true라 음정은 유지된다. 현재 배속을 컨트롤 바에 숫자로 상시 표시.
- **구간 반복(⑤)**: In/Out이 설정되고 반복이 켜지면 `timeupdate`에서 `t ≥ out → currentTime = in`.
  `timeupdate`는 ~250ms 주기라 반복 지점 정밀도가 그 수준이다.
  <!-- ponytail: timeupdate 폴링, 정밀도가 문제되면 requestVideoFrameCallback으로 승급 -->
- **프레임 스텝**: 정확한 fps는 ffprobe(§4.1)가 있으면 그 값, 없으면 1/30 근사. HTML5에는
  프레임 정확 API가 없다는 한계를 그대로 안내한다(근사임을 툴팁에 명시).
- **확대 보기(F)**: OS 전체화면(`requestFullscreen`)은 WKWebView에서 신뢰할 수 없다 →
  **앱 내 확대**(fixed inset-0 오버레이)로 통일한다. 이 오버레이는 반드시
  `selectBlockingOverlay`(ui.ts:197-213)에 추가해야 한다 — 네이티브 자식 웹뷰 뒤에 깔리는
  실사고가 있었던 명시 계약이다.
- 오디오 파일은 현행 네이티브 `<audio controls>` 유지 (요구 없음, YAGNI).

### 2.3 타임라인과 구간(A-B) 핸들

- 탐색바: 클릭/드래그 시킹, 현재/전체 시간 표시(`mm:ss.t`).
- In/Out 핸들: 드래그 이동 가능, 구간을 강조색으로 칠한다. 수치 입력 필드(`mm:ss.ms`) 병행 —
  드래그만으로는 정밀 지정이 안 된다.
- 이 구간 상태가 §4의 내보내기 스펙에 그대로 들어간다(결정 3).

---

## 3. [L0] ffmpeg 준비 — 발견 우선, 다운로드는 동의 후

### 3.1 발견 체인 (`tools/runner.rs` 패턴 이식)

```
① 설정 명시 경로 (설정 › 코드 도구 › ffmpeg 경로)   — 지정 시 폴백 없음
② PATH (60s 미스 캐시, 셸 스폰 없이 직접 탐색)
③ 관리 설치본  <app_local_data_dir>/tools/ffmpeg-<ver>/
```

- **프로젝트 로컬 발견은 넣지 않는다** — 레포에 심긴 ffmpeg.exe를 실행하는 보안 구멍이 되고,
  ruff/biome과 달리 프로젝트 버전 일치라는 명분도 없다.
- ffprobe는 ffmpeg와 **같은 디렉터리에서만** 찾는다(관리 설치본은 둘 다 포함, PATH 발견 시 형제 확인).
- `video_tool_status` 커맨드 → `{ found: "explicit"|"path"|"managed"|null, version, path }`.
  편집 UI는 이 상태로 게이트한다: 없으면 편집 버튼이 안내 다이얼로그("ffmpeg 다운로드 ~40-90MB,
  설정에서 받기")를 띄운다. `ErrorCode::ToolNotFound`가 정확히 이 용도로 이미 있다(error.rs:26).

### 3.2 다운로드 (`lsp/acquire.rs` 파이프라인 재사용 + 확장 1건)

`ensure_native()`(acquire.rs:758-861)의 다운로드→sha256 검증→해제→`.tmp-` 형제+rename 원자 설치→
`.ok` 마커 파이프라인을 **루트 디렉터리를 인자로 받는 공유 함수로 뽑아** `tools/ffmpeg-<ver>/`에
설치한다. `NativeSpec` 모양(acquire.rs:310-440)에 ffmpeg 항목을 추가하는 것이 전부다.

| 플랫폼 | 공급원 (릴리스 태그·sha256 고정) | 형식 | 비고 |
|---|---|---|---|
| Windows x64 | gyan.dev essentials (ffmpeg+ffprobe 포함, ~40MB) | zip | sha256 공표됨 |
| Linux x64/arm64 | BtbN FFmpeg-Builds 또는 johnvansickle static | tar.xz | TarXz는 시스템 tar 경유(acquire.rs:817 기존 경로) |
| macOS x64/arm64 | martin-riedl.de (ffmpeg·ffprobe 분리 zip) | zip | **공급망 최약체 — sha256 핀 필수** |
| Windows arm64 | 관리 설치 미지원 — PATH/명시 경로만 | — | 공식 빌드가 사실상 없음 |

- **유일한 프로토콜 확장 — 스트리밍 다운로드**: 기존 acquire는 전신을 메모리에 버퍼한다
  (`.bytes().await`, acquire.rs:608). 40~90MB에 진행률 없는 "받는 중" 한 줄은 곤란하다 →
  reqwest `stream` 피처(이미 활성)로 임시파일에 흘리며 content-length 대비 % 를
  기존 `Channel<String>` 프로토콜에 `{"phase":"download","percent":N}`으로 추가한다.
- sha256 핀이 None이면 침묵 통과하는 기존 약점(acquire.rs:25-26)을 **ffmpeg에는 허용하지 않는다** —
  실행 파일을 인터넷에서 받아 실행하는 것이므로 전 플랫폼 핀 필수.
- GPL 빌드 법적 문제 없음: 별도 프로세스 호출(링크 아님)이고 앱이 재배포하지 않는다(사용자 클릭으로
  공급원에서 직접 수신).
- 설정 UI: CodeToolsSection에 LSP 행과 동일한 [상태 · 다운로드 버튼 · 명시 경로 입력] 행 추가
  (SettingsDialog.tsx:215-233의 busy/status 패턴 그대로).
- dev/설치본 분리: 관리 설치본도 identifier로 갈리는 `app_local_data_dir` 아래라 dev에서 재다운로드가
  생긴다 — LSP처럼 정션 공유 안내를 CLAUDE.md 절차에 한 줄 추가.

---

## 4. [L2] 내보내기 — `commands/video.rs` (신규)

### 4.1 `video_probe` — 모든 편집 기능의 전제

```
ffprobe -v quiet -print_format json -show_format -show_streams <file>
→ { durationMs, width, height, fps, vcodec, acodec, bitrateKbps, rotation }
```

- 짧은 타임아웃(10s, runner.rs READ_TIMEOUT 선례)의 일반 커맨드. 프론트는 react-query로 캐시.
- **rotation을 반영한 표시 기준 width/height를 돌려준다** — 크롭 좌표계(§4.4)와 UI가 이 값을 쓴다.
- 쓰임: 프레임 스텝 fps(§2.2), 크롭 좌표 매핑, 메타데이터 패널(§5), 내보내기 진행률 분모.

### 4.2 `video_export` — 단일 내보내기 커맨드

편집 조합이 전부 하나의 스펙으로 수렴한다. 커맨드를 작업별로 쪼개지 않는다.

```ts
// jobId는 프론트가 생성(uuid) — 응답 유실 시에도 취소 가능해야 한다(http.rs:6 정책)
videoExport(projectId, jobId, {
  srcRel: string,
  outRel: string,               // 같은 폴더 + 접미사 (§4.5)
  overwrite: boolean,
  range?: { startMs, endMs },   // ① 없으면 전체
  mode: "copy" | "encode",      // 결정 4
  speed?: number,               // ② 0.25~4 — encode 강제
  crop?: { x, y, w, h },        // ⑥ 표시 기준 px — encode 강제
  quality?: { crf: number, maxHeight?: number },  // ③ — encode 강제
  removeAudio?: boolean,
  container: "mp4" | "webm" | "gif" | "m4a" | "png",
})
```

**ffmpeg 인자 생성 규칙** (구현자가 그대로 쓸 것):

```
공통     : -ss {A} (입력 옵션 — 키프레임 고속 시킹) -i {src} -t {(B-A)/1000}
           ⚠ -to를 쓰지 마라: 입력 시킹 후 -to는 출력 타임스탬프 기준이라 구간이 어긋난다. -t(지속시간)로.
copy     : -c copy -avoid_negative_ts make_zero          (①③무손실 — 키프레임 스냅 고지)
encode   : -vf "crop={w}:{h}:{x}:{y},scale=-2:{maxH},setpts=PTS/{s}"
           -af "atempo={s}"                              (0.25x는 atempo=0.5,atempo=0.5 체인 — atempo 범위 밖)
           -c:v libx264 -crf {crf} -preset veryfast -pix_fmt yuv420p -c:a aac
mp4 출력 : -movflags +faststart
gif      : -vf "fps=12,scale={minOf 480}:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse"
           (팔레트 1패스 — 임시파일 없음)
m4a      : -vn -c:a copy (aac 소스) / -vn -c:a aac (그 외)
png      : -frames:v 1 -update 1                          (프레임 캡처 — §5)
음소거   : -an (copy 모드와 양립 가능 — 유일한 예외)
```

- **화질 프리셋(③)**: `무손실 복사(copy)` / `원본급 CRF 18` / `표준 CRF 23` / `압축 CRF 28`,
  해상도 `원본 / 1080p / 720p / 480p`. CRF 숫자를 감추고 한국어 라벨로 노출하되 툴팁에 명시.
- crop w/h/x/y는 **짝수로 내림** — yuv420p+libx264는 홀수 크기에서 실패한다.
- 재인코딩 시 ffmpeg가 회전 메타데이터를 자동 적용(autorotate)하므로 표시 기준 크롭 좌표와 일치한다.
  copy 모드는 회전 메타데이터가 그대로 보존된다.

### 4.3 잡 실행·진행률·취소 (선례 조합, 새 발명 없음)

- **커맨드 골격**: `sync.rs:60-105` — `#[tauri::command(async)]` 필수(동기 커맨드 패닉은 Windows에서
  프로세스 전체 abort, `hot_commands_stay_async` 테스트가 강제).
- **스폰**: `git/runner.rs:248-326` 모양 — args 배열, `stdin null`, `kill_on_drop`,
  `CREATE_NO_WINDOW`(win), `process_group(0)`(unix). 타임아웃은 두지 않는다(장시간 인코딩이 정상) —
  대신 취소와 종료 시 회수로 관리.
- **진행률**: `-progress pipe:1`로 stdout에 key=value 라인 → `out_time_us / 예상 출력 길이`
  (배속 시 `(B-A)/speed`)로 % 계산 → `app.emit("video://export-progress",
  { jobId, projectId, percent, outTimeMs, speedX })`, % 변화 시에만 발신(초당 몇 회 수준이라
  Channel/Pacer 불필요 — terminal.rs:113 판정 기준).
- **종결**: 결과와 별개로 `video://export-finished { jobId, ok, error, outRel }`를 **반드시** 발신 —
  Windows에서 invoke 응답이 유실돼도 UI가 이벤트만으로 복구한다(sync.rs:58 규약).
- **취소**: `http.rs` 킷 — `AppState.video_jobs: Mutex<HashMap<String, JobHandle{pid}>>`,
  RAII 가드로 모든 경로에서 제거, `video_export_cancel(jobId)`는 멱등, unix는 `kill_group`.
  락은 넣고 빼는 동안만 잡는다 — **await나 kill 중에 잡지 마라**(terminal.rs:232 교훈).
- **앱 종료 시 회수**: 실행 중 잡을 기존 종료 훅(terminal.rs:341 PTY 회수 경로)에 합류 —
  안 하면 ffmpeg가 앱 cgroup에 남는다(2026-08 oomd 사건 계열).
- **완료 후**: 산출물이 워크트리에 생기므로 `['dir'] ['statuses'] ['diff']` 쿼리 무효화
  (useSaveImage와 동일, queries/index.ts:884). OpGuard는 쓰지 않는다 — 기존 파일을 변경하지 않고
  새 파일만 쓰므로 git 오퍼레이션과 배타일 이유가 없다.
- 동시 내보내기는 레지스트리가 자연히 허용한다. UI는 플레이어당 1개 진행 표시 + 완료는 전역
  리스너(events.ts)가 토스트로 — 탭을 옮겨도 잡은 계속되고 완료 알림은 온다.

### 4.4 크롭 UI (⑥)

- 편집 바에서 "영역 선택" 토글 → 일시정지 → 영상 위 드래그로 사각형. **캔버스 불필요** —
  절대배치 div 4장(사방 dim) + 테두리 + 8핸들이면 된다(AnnotationLayer의 drawCropOverlay 개념만
  가져오고 구현은 div로 — 주석 편집기가 아니므로 캔버스 스택을 끌고 올 이유가 없다).
- 좌표 매핑: `<video>`는 `object-fit: contain`이라 레터박스가 생긴다 —
  `getBoundingClientRect()`와 `videoWidth/videoHeight`(표시 기준, §4.1 rotation 반영과 일치)로
  실좌표 환산, 짝수 내림. 수치(x,y,w,h)를 편집 바에 표시.

### 4.5 산출물 이름·저장 UX (이미지 편집기 규약 승계)

- **같은 폴더 + 접미사**, OS 저장 다이얼로그 없음(이미지 편집기와 동일한 의도된 결정 — 산출물이
  워크트리에 남아야 git 대시보드에서 의미가 있다):
  `name.clip.mp4` · `name.x2.mp4` · `name.crop.mp4` · `name.720p.mp4` · `name.gif` ·
  `name.m4a` · `name.frame-01m23s.png` — 복합 편집은 대표 접미사 하나(`clip` > `crop` > 배속 > 화질).
- 파일명은 내보내기 패널에서 수정 가능(경로 구분자·`..` 거부 — ImageEditor.tsx:636 검증 재사용).
- 충돌: `overwrite=false`로 시도 → `ALREADY_EXISTS` → `askConfirm("덮어쓰기")` → `overwrite=true`
  재시도 (ImageEditor.tsx:590-604 흐름 그대로).
- 백엔드는 `resolve_in_repo` 격리 검사 + 심링크 거부(tree.rs:316 규약)를 출력 경로에도 적용.
  ffmpeg가 디스크에 직접 쓰므로 `write_file_bytes`의 64MB 상한과 무관하다.

### 4.6 내보내기 패널 UI

플레이어 하단에 접이식 편집 바(별도 모달 아님 — 오픈 이슈 ① 참조):

```
[구간 00:12.3 ~ 00:47.8 ✕] [배속 1x▾] [화질 무손실 복사▾] [해상도 원본▾] [영역 선택 □] [♪ 오디오 제거 ☐]
[형식 mp4▾]  파일명 [demo.clip.mp4        ]                       [프레임 캡처] [내보내기 ▶]
── 진행: ████████░░ 82% · 2.3x · [취소]
```

- 무손실 복사 선택 중 배속/크롭/화질/해상도를 만지면 → "재인코딩으로 전환됩니다" 안내 후 자동 전환
  (결정 4). 무손실일 때는 "시작점이 키프레임 단위로 스냅됩니다" 상시 고지.
- 모든 문구 한국어, 테마 토큰(bg-panel/border-edge/text-fg-dim…)만 사용 — hex 금지.

---

## 5. 추천 기능 (요구 외 — 반영/보류 판정)

| 기능 | 판정 | 근거·비용 |
|---|---|---|
| **프레임 캡처 (PNG)** | ✅ 반영 | 이슈/PR에 붙일 스크린샷 — git 대시보드와 찰떡. `-frames:v 1` 한 줄. 캔버스 불가(결정 5)라 ffmpeg 경유 |
| **GIF 추출** | ✅ 반영 | PR·이슈에 붙일 데모 GIF — 이 앱 사용자(개발자)의 실사용 1순위 예상. 팔레트 1패스 필터 한 줄 |
| **오디오 추출 (m4a)** | ✅ 반영 | `-vn -c:a copy` — 형식 드롭다운에 한 항목 추가일 뿐 |
| **오디오 제거** | ✅ 반영 | `-an` 체크박스 하나. copy 모드와도 양립 |
| **메타데이터 패널** | ✅ 반영 | 코덱/해상도/fps/비트레이트 — §4.1 probe 결과 표시만. 내부적으로 어차피 필요 |
| **프레임 스텝** | ✅ 반영 | §2.2 — fps만 있으면 공짜 |
| **재생 불가 코덱 변환 폴백** | 🔷 P5 선택 | playError + ffmpeg 존재 시 "재생용 mp4로 변환" 제안 — 코덱 문제(이전 설계 §3.3)의 근본 해결. mkv/avi를 VIDEO_EXT+MIME에 추가하는 것과 세트 |
| 회전 90° | ⏸ 보류 | 레포 안 세로 폰 영상은 드묾. 필요 시 `transpose` 드롭다운 한 개 |
| 타임라인 호버 썸네일 | ⏸ 보류 | 스프라이트 생성 비용·캐시 관리가 효용 대비 큼 |
| 다중 구간 병합(concat) | ⏸ 보류 | UI·엣지케이스가 별도 설계감. 단일 구간이 요구의 전부 |

---

## 6. 변경 지점 요약

| 파일 | 변경 |
|---|---|
| `src/components/video/VideoPlayer.tsx` | **신규** — L1 전부 (컨트롤·타임라인·단축키·A-B·확대) |
| `src/components/video/ExportPanel.tsx` | **신규** — §4.6 편집 바 + 진행/취소 |
| `src/components/video/CropOverlay.tsx` | **신규** — div 기반 영역 선택 (§4.4) |
| `src/components/diff/MediaView.tsx` | 비디오 분기를 VideoPlayer로 위임, 오디오·mint 골격 유지 |
| `src/lib/language-map.ts` | (P5 시) VIDEO_EXT += mkv, avi |
| `src/lib/ipc.ts` | videoProbe / videoExport / videoExportCancel / videoToolStatus / videoToolEnsure |
| `src/lib/events.ts` | `video://export-finished` 전역 리스너 → 완료 토스트 |
| `src/stores/ui.ts` | 확대 보기 오버레이 상태 → `selectBlockingOverlay` 등록 (§2.2) |
| `src/components/settings/.../CodeToolsSection.tsx` | ffmpeg 행 (상태·다운로드·명시 경로) |
| `src-tauri/src/commands/video.rs` | **신규** — probe / export / cancel / tool_status (§4) |
| `src-tauri/src/lsp/acquire.rs` → 공유화 | ensure_native 파이프라인에 루트 디렉터리 인자화 + 스트리밍 다운로드(§3.2) |
| `src-tauri/src/state.rs` | `video_jobs` 레지스트리 |
| `src-tauri/src/lib.rs` | 커맨드 등록 + 종료 시 잡 회수 훅 |
| `src-tauri/src/commands/preview.rs` | (P5 시) MIME += mkv/avi — 짝 테스트 함께 |

---

## 7. 구현 순서

1. **P1 — 플레이어 (L1)**: 프론트 단독, ffmpeg 무관. ②(재생)④⑤가 즉시 충족되고 이 상태로 릴리스 가능.
2. **P2 — 도구 준비 (L0)**: 발견 체인 → status 커맨드 → 설정 행 → 스트리밍 다운로드. 편집 버튼 게이트까지.
3. **P3 — 내보내기 코어**: probe → export(copy/encode, 구간·화질) → 진행/취소/종결 이벤트 → 저장 UX.
   ①③ 충족.
4. **P4 — 확장 편집**: 크롭 UI(⑥) → 배속 저장(②) → 프레임 캡처·GIF·오디오(§5 반영분).
5. **P5 — 선택**: 재생 불가 코덱 변환 폴백 + mkv/avi 확장.

각 단계가 독립 릴리스 가능한 절단면이다. P1과 P2는 순서를 바꿔도 된다(의존 없음).

---

## 8. 오픈 이슈 (사용자 결정 필요)

| # | 질문 | 선택지 | 권고 |
|---|---|---|---|
| ① | 편집 UI 위치 | (a) 뷰어 인라인 편집 바 (b) 이미지처럼 전체화면 모달 | **(a)** — 편집이 "파라미터 → 내보내기"라 캔버스 편집기와 달리 모달일 이유가 없고, 모달이면 플레이어를 두 벌 만들게 된다 |
| ② | ffmpeg 다운로드 트리거 | (a) 편집 첫 사용 시 안내 다이얼로그 + 설정 버튼 (b) 설정에서만 | **(a)** — 발견이 먼저라 PATH에 있으면 다이얼로그 자체가 안 뜬다 |
| ③ | 산출물 저장 위치 | (a) 원본 옆 접미사 (b) OS 저장 다이얼로그 | **(a)** — 이미지 편집기와 일관, 산출물이 워크트리에 남아야 대시보드에서 보인다 |
| ④ | P5(코덱 변환 폴백) 포함 여부 | (a) 이번 범위 (b) 후속 | **(b)** — 요구 6개와 독립이고, P1~P4만으로도 큰 릴리스다 |

---

## 9. 위험·미검증 영역 — 정직 고지

- **무손실(copy)의 키프레임 스냅 폭은 소스마다 다르다**(GOP 1~10초). "무손실인데 왜 앞이 잘리냐/붙냐"는
  문의가 반드시 온다 — UI 상시 고지(§4.6)가 방어선이다.
- **HDR/10-bit 소스를 libx264로 재인코딩하면 색이 바랜다**(톤매핑 없음). probe에서 10-bit/HDR 감지 시
  경고 문구만 낸다 — 톤매핑은 범위 밖.
- **가변 프레임레이트(VFR) 소스**에서 프레임 스텝·진행률 계산은 근사다.
- **macOS ffmpeg 공급원**이 개인 운영 사이트라 공급망이 약하다 — sha256 핀 필수(§3.2)이고,
  릴리스 절차에 핀 갱신 검증을 넣어야 한다.
- **Windows AV(V3 등)가 갓 받은 ffmpeg.exe 첫 실행을 잠시 잠글 수 있다** — v0.3.5 무서명 setup.exe
  전례와 같은 계열. 실패 시 재시도 안내 문구로 대응.
- **Windows에서 내보내기 중 원본 파일 핸들이 열려 있어** git checkout/브랜치 전환이 그 파일에서
  실패할 수 있다 — 잡 진행 중임을 상태줄에 표시하는 것으로 완화.
- 배속 재생(`playbackRate`) 4x에서 일부 플랫폼 웹뷰가 오디오를 끊는 사례가 알려져 있다 — 실측 필요.
- e2e: macOS WKWebView는 CDP가 없어 플레이어 상호작용 자동 검증 불가(기존 제약과 동일). ffmpeg 인자
  생성기는 **순수 함수로 분리해 유닛 테스트**한다(홀수 크롭, atempo 체인, -t 변환, 접미사 규칙).
