# 태스크 72 — 영상 자동 자막 + 대본 기반 편집 (Vrew식): whisper.cpp 별도 프로세스 + 비파괴 자막 문서

> 상태: **구현됨 P0~P4** (설계·구현 2026-09-22 — 설계와 달라진 것·리뷰 후 수정은 §9, 실측은 부록 B, P5는 미착수) · 대상: gitpervisor ·
> 근거: 코드 실측 2026-09-22(515cd5f) + 외부 실측(whisper.cpp b5130 바이너리·HF tree API·FFmpeg 필터 소스·
> sherpa-onnx, 이 머신 Windows 11 / Core Ultra 9 275HX / RTX 5070 Ti, §2.2) + Vrew·Descript·CapCut 도움말(§2.3)
> 선행: 59(관리형 다운로드 `llm/acquire.rs`·프로세스 수명 `llm/server.rs`), video-editor-design(잡 레지스트리·
> `video_export`), 61(LLM 번역), 68(세 OS 백엔드 원칙), 64(분할 패널)
> **Rust 변경 있음**(새 모듈 `stt/` + `video_export` 확장) · npm 의존성 0 · CSP 변경 0 · 앱 번들 +0(엔진·모델은 선택 다운로드)
> 규모 **L**(P1만 M~L). 설계안 3개(lean·vrew-ux·robust)를 채점해 vrew-ux를 뼈대로 합성했다 — 부록 A.

## 1. 요구사항

**"영상 파일에서 자막을 자동으로 만들고, 그 자막(대본)을 고쳐서 영상까지 편집할 수 있어야 한다. Vrew처럼."**

받아들이는 조건:
- 영상 플레이어에서 버튼 하나 → 로컬 음성 인식으로 자막 초안이 생긴다. 인터넷은 엔진·모델 다운로드 때만.
  한국어·영어 혼합이 된다. 진행률·취소가 있다.
- 대본을 보며 검색·클릭 이동·자막 텍스트 수정·나누기·합치기·찾아 바꾸기·되돌리기가 된다.
- **자막 텍스트를 고치는 것과 영상을 자르는 것은 다른 동작이다**(Vrew "자막 줄 / 영상 줄", Descript Correct / Delete).
  인식 오타를 고쳤는데 영상이 잘리면 사고다.
- 단어를 지우면(취소선) 그 부분이 빠진 영상을 내보낼 수 있다. 원본 파일은 절대 바뀌지 않는다.
- 무음 구간 줄이기(목표 길이로 **단축**, 결과 검토 후 적용, 복구 가능).
- SRT/VTT/TXT 내보내기(원본 시각·편집본 시각), 자막 입힌 mp4, 번역 자막 2단.
- **세 OS 모두 같은 UI·같은 IPC 계약.** 엔진이 없으면 무엇을 설치하면 되는지 알려 준다(회색 버튼·무반응 금지).

## 2. 현황(근거)

### 2.1 코드베이스

**영상 경로.** `DiffViewer.tsx:257` `isPlayable` → `MediaView.tsx:19-34` → `VideoPlayer`. 뷰어 탭·분할 패널
(`ViewerTab.tsx:152-158`)·doc 창(`DocWindow.tsx:151`)·Git 모달이 전부 여기로 모인다 — **VideoPlayer 안에 붙이면
네 경로에 자동으로 따라간다.** `VideoPlayer.tsx`는 이미 2249줄(CLAUDE.md 2000줄 분할 검토선 초과).

**VideoPlayer 내부에서 이 설계가 기대는 것**
- 레이아웃: 상단 바 `:948-1014`, 모드 스위치 `:968-994`(주석: "두 상태(재생/편집)뿐"), 본문 `:1019`
  (레일 | 가운데 칼럼 | 인스펙터 `w-80` `:1382-1410`, `editOpen`일 때만), 스테이지 `:1048`(`relative inline-flex`,
  `RegionBox`·`CropOverlay`가 표시 영역과 1:1로 겹치는 자리).
- `time`은 재생 중 rAF마다 갱신(`:399-421`) → VideoPlayer 전체가 60fps로 다시 그려진다. `ExportPanel`·`LibraryRail`은
  memo + `useCallback` 고정 props가 계약(`:708-742`, `ExportPanel.tsx:94-95`).
- 되돌리기 `editSnap` `:209-253`(참조 비교, 350ms 디바운스), 파일 전환 리셋 `:310-336`.
- **컨테이너 단축키 `:785-874`는 `INPUT/TEXTAREA/SELECT`만 거르고 contentEditable은 거르지 않는다**(`:786-789`).
  contentEditable 대본 편집기를 안에 두면 `i`가 In 지점을 찍고 Ctrl+Z가 영상 편집 되돌리기로 간다.
- Timeline(`:1487-2226`, 같은 파일): 트랙 행 패턴 `:1919-2039`(V1 `:1925`, A1 `:1979`, 마커 `:2007`), `pct/visible`
  `:1573-1574`, `snapTo` `:1584-1605`, `startTickDrag` `:1782-1785`. memo가 아니고 `time`을 props로 받는다.
- 파형 버킷 900 고정(`:293`, 백엔드 상한 4096 `video.rs:1341`), **최대값 정규화**(`video.rs:1310-1331`) → 절대 dB 무음
  판정에 못 쓴다. 필름스트립·파형 캐시는 경로만 키이고 덮어쓰기 뒤에 무효화되지 않는다(`events.ts:79-84`, 기존 빈틈).

**`commands/video.rs`**
- `ExportSpec` `:447-471`(TS `VideoExportSpec` `ipc.ts:391-411`) — `range: Option<RangeMs>` **단일 구간**(`:453`),
  `mode`·`mask_kind`는 문자열(기존 코드, 새 코드는 따라 하지 않는다).
- `build_export_args` `:602-710`(순수 함수, 테스트 `:1648-2057`), 구간은 `-ss`+`-t` 하나(`:610-614`). 다중 구간
  concat은 설계 문서가 "⏸ 보류"(`DOCS/video-editor-design.md:293`). 분할은 단일 구간 내보내기를 N번(`videoSplit.ts:216-268`).
- `build_mask_graph` `:512-542`는 입력 라벨 `[0:v]`를 하드코딩(`:522`). 체인 순서 mask → crop → scale → setpts(`:632-649`).
- 잡 계약: `VideoReg`/`JobGuard` `:32-56`(`AppState.video`, `state.rs:59-60`), **spawn 전 등록** `:866-876`,
  `-progress pipe:1` 파싱 `:899-933`, 종결 이벤트를 모든 결과에 한 곳에서 `:800-829`, 취소 `video_export_cancel` `:1011-1029`,
  앱 종료 회수 `video_kill_all` `:60-77` ← `lib.rs:816` `shutdown_step("video")`.
- 쓰기 경로: `resolve_in_repo`(`tree.rs:1812-1829`) → 원본과 canonical 비교(`:846-854`) → `AlreadyExists`(`:855-860`) →
  같은 폴더 `.gpv-export-{job_id}.tmp` → rename(`:862-863`, `:972-986`). `job_id`는 검증 없이 파일명에 들어간다(`:863`) —
  새 커맨드는 uuid 파싱으로 검증한다.
- start_time: `parse_start_time` `:1034`, `frame_seek_secs` `:1078-1093` — 직접 재생의 `currentTime`은 컨테이너 절대 pts,
  ffmpeg `-ss`·HLS는 start_time 상대값. **TS `VideoMeta`(`ipc.ts:377-388`)에는 startTime 필드가 없다**(실측).
- ffmpeg 공급원: Windows gyan 9.0.1 essentials(`:1393-1405`), **Linux johnvansickle 7.0.2**(`:1406-1436` — 과제 설명의
  "BtbN"은 틀림), macOS martin-riedl 9.0.1(`:1437-1475`), **win-arm64 없음**(`:1476-1479`). ffmpeg 다운로더
  (`:1490`, `:1587-1590`)에는 취소·타임아웃·크기 선검사가 없다 — STT 획득에 쓰지 않는다.

**미디어 서빙·CSP.** 프리뷰 서버는 ACAO 없음(`preview.rs:519-524`, 설계 결정 5), MIME 표에 vtt/srt 없음(`:618-665`).
CSP(`tauri.conf.json:15`) `media-src`에 `blob:`/`data:` 없음, `connect-src`에 루프백 없음. → `<track>`·blob·fetch
자막은 전부 막힌다. **DOM 오버레이만 된다**(`CropOverlay`와 같은 자리). HLS는 자막 스트림을 버린다(`hls.rs:326-332`).

**`llm/acquire.rs`(59)** — 범용이다. `Artifact` `:37-47`, `ModelSpec` `:171-181`, `download_verified` `:402-475`
(스트리밍 sha256·Content-Length 선검사·취소·`.part` 정리), `check_free_space` `:368-391`, `extract_archive`(zip·tar.gz,
프로세스 내부) `:477-500`, `register_cancel`/`DownloadGuard` `:503-537`(`state.llm_downloads`), `http_client` `:539-550`,
`sweep_stale_downloads` `:310-337`, `llm_download_cancel` `:768-778`. 일반화가 필요한 곳: `ensure_runtime` `:554-606`의
진행 이름(`artifact_progress_name` `:137-143`)과 `.ok` 값(`LLAMA_BUILD` `:603`) 상수, 모델 다운로드·삭제 본문
(`:731-757`, `:782-798`). 카탈로그 테스트가 `.gguf`를 단언(`:822`) → whisper `.bin`은 별도 카탈로그.

**`llm/server.rs`** — Linux `systemd-run --user --scope` 래핑 `:293-315`(인라인, std Command 전용), stderr 드레인
`:246-257`, `kill_group` `:627-635`. llama-server는 유휴 10분 동안 VRAM을 쥔다(12B 9.3GB, `:282-285`).

**번역(61)·설정.** `lib/llm.ts chat()` `:57-80`, `llmReadyReason` `:95-121`, `ChatDone.truncated`(`chat.rs:51-52`),
Busy 재시도가 `translate.ts:70-100` 안에 묻혀 있다, `langName`은 ko/en뿐(`llm.ts:124-126`). 설정 AI 섹션
`AiSection.tsx:111-199`(런타임 행·모델 표), 진행 상태는 셸 소유(`SettingsDialog.tsx:86-93`, `:291-342`).
**e2e 47 ⑤는 `llm*` 키가 10개라고 단언하는데 실제는 11개**(`47-llm-runtime.mjs:233`, `llmReportModel` 이후) —
`E2E_NET=1`에서만 도는 스위트라 드러나지 않은 기존 결함. 새 설정 키는 `stt*` 접두어.

**e2e.** 33(분할, testsrc+sine — 음성 없음), 34 `videoDocBlock`(doc 창 내보내기·토스트 창 소유), 47(LLM 획득 패턴:
`E2E_NET` 게이트·`E2E_LLM_GGUF` 주입·`sys_process_snapshot` 잔존 0). 새 스위트 번호는 64 이후 빈 번호.

### 2.2 엔진 실측 (2026-09-22, 이 머신)

**whisper.cpp** — 안정판 `v1.9.4`(2026-09-11) 태그에는 **자산이 0개**, 같은 커밋 `927cfce3`의 nightly **`b5130`**에
있다(`releases/latest`로 찾으면 빈손). https://github.com/ggml-org/whisper.cpp/releases/tag/b5130

| 자산 | 크기(B) | sha256(API digest = 받은 파일, 일치 확인) |
|---|---|---|
| whisper-bin-x64.zip | 8,573,270 | f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c |
| whisper-bin-win-cpu-arm64.zip | 4,361,895 | 799543b926ab5b6c2d60cab269a2092e0ae8d27820e9e15429e59de3699546fc |
| whisper-bin-ubuntu-x64.tar.gz | 9,793,438 | 53e7fd8b5764edad916b8848dd0af6abb1ff1d3b86c899e79c78652412536c32 |
| whisper-bin-ubuntu-arm64.tar.gz | 4,605,905 | 93532a0e3777f26f041ffa358ee77dd88b1a33a86847c1990745327ff335a5d6 |
| whisper-cublas-12.4.0-bin-x64.zip | 674,539,285 | af520ddd034d985b55dfeea3e465ed93653ba2aee1a55e865033edc548c272a7 |

- **macOS CLI prebuilt 없음**(xcframework뿐, release.yml macOS 잡이 `WHISPER_BUILD_EXAMPLES=OFF`). **Windows Vulkan 자산은
  역대 43개 릴리스에 한 번도 없음.** Linux는 CPU 전용, `GLIBC_2.34`·`libgomp.so.1` 필요(ubuntu-22.04 빌드).
- Windows zip에 MSVC 런타임 미동봉. `ggml-base.dll`이 **`VCOMP140.DLL`** 을 import — 클린 Windows 동작 **미확인**.
- Homebrew `whisper.cpp` 1.9.4: bottle은 arm64 macOS·Linux뿐(**Intel mac bottle 없음**), `WHISPER_BUILD_SERVER=OFF`.
  설치되는 실행 파일 이름 **미확인**.
- 입력: `--help` 원문 `supported audio formats: flac, mp3, ogg, wav` — **mp4는 실패**(`failed to read audio file`).
  영상은 ffmpeg로 먼저 뽑는다.
- **`-l` 기본값이 `en`** — 한국어는 `-l ko`/`-l auto`를 반드시 넘긴다.
- 진행률 `-pp`는 stderr에 `whisper_print_progress_callback: progress =  11%` (띄엄띄엄). **`-of -`면 진행률이 꺼진다.**
- `--vad`를 켜면 **세그먼트 시각은 원본 타임라인으로 되돌려지지만 `-ojf` 토큰 offsets는 VAD로 잘라 붙인 타임라인 그대로**
  (jfk: 세그먼트 330–680ms, 토큰 10–210ms). flash-attn 기본 ON이라 DTW가 조용히 꺼진다(`-nfa` 필요). `-ml 1 -sow`는
  어절 단위지만 길이 0 항목이 생긴다.

속도·품질(ggml-large-v3-turbo-q5_0, `-l ko`):

| 조건 | 결과 |
|---|---|
| CPU b5130, VAD, 34.1초 한국어 TTS | **13.6초(RTF 0.40), 단어 하나 틀리지 않음**, 세그먼트 시각이 발화와 일치 |
| CPU `-t 8`, 227.6초 | 144.5초(실시간 1.57배) |
| CUDA 12.4 첫 실행 / 재실행 / greedy | 55.4초(JIT 추정) / 6.4초 / 3.4초 |
| CUDA + beam 5 | **SRT에 잘못된 UTF-8 바이트 2곳**("리눅스" → `eb88 85 b9 ec8aa4`). greedy·CPU beam은 정상 |
| `--prompt "깃퍼바이저"` | 출력이 바뀌지만 용어를 고정하지 못함("Git supervisor는…") |

한국어 공개 수치: turbo CER CV15 5.6 / FLEURS 3.2, large-v3 5.2 / 3.1(https://github.com/openai/whisper/discussions/2363).
**측정은 깨끗한 TTS뿐이다 — 실제 녹음·잡음·다화자는 미측정.**

모델(HF `ggerganov/whisper.cpp`, MIT, https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main):
`ggml-large-v3-turbo-q5_0.bin` 574,041,195B `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2`,
`ggml-base-q5_1.bin` 59,707,625B `422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898`.
VAD `ggml-org/whisper-vad` `ggml-silero-v6.2.0.bin` 885,098B `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987`.
(구현 때 tree API·릴리스 digest에서 **다시 채록해 대조**한다 — 이 표는 조사 보고서의 전사.)

**대안 엔진 실측**(https://github.com/FFmpeg/FFmpeg/blob/release/9.0/libavfilter/af_whisper.c 등)
- FFmpeg `af whisper`: 우리가 받는 빌드엔 **없다**(gyan essentials·martin-riedl·johnvansickle 7.0.2 — 필터는 8.0부터).
  gyan *full*(7z 169MB)에만 있다. 실측: 30초 청크 경계에서 문장이 통째로 빠지고, VAD를 켜면 시각이 약 2.7초 앞당겨지고
  겹치며 40배 느리다. JSON 출력은 텍스트를 이스케이프하지 않는다.
- sherpa-onnx 1.13.8 + SenseVoice 2024-07-17: 세 OS 모두 prebuilt, RTF 0.018. 띄어쓰기 오류, "음" → "うん。",
  "SRT" → "에 사어티". **2025-09-09 모델은 한국어가 깨진다**(광둥어 파인튜닝).
- whisper-rs(프로세스 내): `ggml_abort`가 **`abort()`** → PTY 터미널까지 앱 전체가 죽는다. CI에 CMake·libclang.
- OS 엔진: Windows는 MSIX 패키지 ID 필요 + Windows AI API는 영어만·시각 없음, Linux 없음, macOS 26+ Swift 전용.
- faster-whisper-XXL: macOS·ARM 없음, 1.4GB+, 라이선스 표기 없음.
- 클라우드: 시각을 주는 것은 whisper-1·Groq뿐, 업로드 25MB 제한(https://developers.openai.com/api/docs/guides/speech-to-text).

### 2.3 UX 조사 (Vrew·Descript·CapCut)

- Vrew: **클립 하나 = 영상 줄(인식 단어, 지우면 컷) + 자막 줄(표시만)**, 무음 `…`·미인식 `?`도 토큰
  (https://vrew-help.notion.site/82cdfd1384e442fbb8db2892f2f2760a). 무음 줄이기는 0~3초로 단축, 적용 후 복구 가능
  (https://vrew.ai/ko/feature/auto-silence-removal). 추임새 전용 기능은 공식 문서에서 **미확인** — "찾아서 편집하기"로 대신.
  전체 오프셋 이동은 미지원.
- Descript: Delete(숨김·`¦`·복원) / Ignore(취소선, 자막에서 제외) / Correct(텍스트만)
  (https://help.descript.com/hc/en-us/articles/10164872017933-Deleting-vs-ignoring-script-text). Shorten word gaps는
  "초과 길이 → 목표 길이".
- **SRT에 보이지 않는 특수 문자가 섞이면 Premiere가 그 뒤 자막을 못 읽는다**(Vrew 공지) → 작성기가 제어·폭 없는 문자를 제거.
- Whisper는 추임새를 전사에서 빼는 경향(CrisperWhisper, https://github.com/nyrahealth/CrisperWhisper) → 추임새 자동 탐지는
  한국어에서 신뢰도가 낮다.
- 분할 기준: Netflix 한국어 16자/줄·2줄(https://partnerhelp.netflixstudios.com/hc/en-us/articles/216001127),
  이벤트 최대 7초.

## 3. 설계

### 3.1 엔진 — whisper.cpp `whisper-cli`, 잡 하나에 프로세스 한 번

**결정: whisper.cpp `whisper-cli`(빌드 `b5130` 고정)를 별도 프로세스로 파일당 한 번 실행한다. P1은 CPU 빌드만.**
- 이유: 한국어 품질·시각 정확도가 실측 1위, 크래시가 앱으로 번지지 않는다, MIT, 59의 획득 파이프라인과 `video_export`
  잡 틀에 그대로 맞는다.
- 상주 `whisper-server`는 쓰지 않는다 — 파일 하나 전사에서 모델 로드는 수 초, 추론은 수 분이라 이득이 작고, 진행률이
  클라이언트로 안 오며, 전역 뮤텍스로 한 요청씩만 처리하고, README가 "sandbox에서 돌려라"라고 경고한다.
- CPU만이면 llama-server의 VRAM과 부딪치지 않는다(GPU는 P5, §8 Q4).
- 스레드 기본 `min(8, 논리 코어/2)` — 태스크 71(부하 중 타이핑)과 겹치지 않게 코어를 다 쓰지 않는다.

**OS별 배포**

| 타깃 | P1 방식 | 없거나 실패하면 |
|---|---|---|
| Windows x64 / arm64 | 관리형 다운로드(CPU zip) | 설치 스모크 실패(VCOMP140 등) → "Visual C++ 재배포 패키지 설치" 안내. win-arm64는 관리형 ffmpeg가 없어 사용자 ffmpeg가 없으면 기존 ffmpeg `ToolNotFound` |
| Linux x64 / arm64 | 관리형 다운로드(ubuntu tar.gz) | glibc < 2.34·libgomp 없음 → 스모크 실패 → "시스템 whisper-cli를 PATH에" 안내 |
| macOS arm64 / x64 | **발견만**: PATH → wellknown(`/opt/homebrew/bin`, `/usr/local/bin`) | `ToolNotFound` + `brew install whisper-cpp` 안내(Intel은 bottle이 없어 소스 빌드). 관리형은 P5(우리 CI, Metal) |

- **발견 체인은 모든 OS에서 같다**: 관리형 설치본 → PATH → wellknown. 레포 안 바이너리는 찾지 않는다(`video.rs:10-11`과 같은 공급망 방어).
- 발견된 비관리 바이너리(brew 등)는 버전을 통제할 수 없으므로 첫 사용 때 `--help`에 `-ojf`·`--vad`·`-pp`가 있는지 확인하고
  (프로세스 수명 캐시), 없으면 "whisper.cpp 버전이 낮음" 오류.

**전사 파이프라인**(`stt/transcribe.rs`, `video_export_inner` 골격을 따른다)

```
1. job_id를 uuid로 파싱(임시 파일 이름에 들어간다) · resolve_media(입력 경계) · ffprobe(기존) → durationMs, startTimeMs, 오디오 유무
2. check_free_space(앱 캐시, 32KB/s × 길이)                          # 1시간 ≈ 115MB
3. [extract]    ffmpeg -nostdin -i SRC -map 0:a:0 -vn -ac 1 -ar 16000 -c:a pcm_s16le -f wav CACHE/stt/gpv-stt-<job>.wav
                (-progress pipe:1 → 0~10%)
4. [transcribe] whisper-cli -m MODEL -f WAV -l <auto|ko|…> --vad -vm SILERO -sns -ojf -pp -t N
                -of CACHE/stt/gpv-stt-<job> [--prompt P]           # stderr progress → 10~95%
5. [parse]      <job>.json → CaptionDoc(순수 함수) → 앱 데이터에 저장 → stt://finished
6. 임시 WAV·JSON은 결과와 무관하게 Drop 가드로 삭제
```

- 파일로 추출하는 이유: 16kHz 1시간 ≈ 115MB를 파이프로 메모리에 올리지 않는다. 캐시 폴더라 제어된 폴더 액세스·git과 무관.
- **`-l`은 항상 명시**(기본 `en`), **`-of`는 절대 `-`가 아니다**(진행률이 꺼진다) — 둘 다 인자 빌더 단위 테스트로 고정.
- **VAD를 켠다**: 실측에서 turbo+VAD 조합이 세그먼트 시각까지 정확했고, 무음·음악 구간 헛말을 줄인다. 대가로 토큰 시각은
  VAD 타임라인에 있으므로 단어 시각은 **세그먼트 `[start,end]` 안으로 선형 재배치**한다(`remap_tokens_into_segment`).
  세그먼트가 긴 무음을 끼고 있으면 틀리다 — P1은 cue(세그먼트) 시각만 믿고, 단어 시각을 쓰는 컷 편집(P2) 착수 전에
  §4 P0 실측으로 "VAD+재배치 vs VAD 끄고 `-nfa -dtw`"를 고른다.
- **UTF-8은 엄격 검사**: 결과 바이트가 유효하지 않으면 `-bs 1 -bo 1`(greedy)로 한 번만 다시 돌린다(실측에서 greedy는 깨끗).
  그래도 깨지면 깨진 시퀀스를 U+FFFD로 바꾸고 해당 cue에 `suspect: "invalid-utf8"`를 달아 **드러낸다**(조용히 삼키지 않음).
- **Linux**: whisper-cli는 `systemd-run --user --scope --quiet --collect`로 감싼다 — 수백 MB 모델을 수 분간 앱 cgroup에 올리는
  것이 2026-08 oomd 사고와 같은 조건이다. `server.rs:293-315`를 `(program, prefix_args)`를 돌려주는 헬퍼로 빼 std·tokio 공용으로.
  `--scope`는 대상으로 exec해 pid가 같으므로 `video.rs:81-96`의 killpg가 그대로 닿는다. `--service-type=exec`로 바꾸지 않는다.
  ffmpeg 추출은 기존 export처럼 감싸지 않는다(짧다).
- 스폰 규약은 export와 같다: args 배열, `CREATE_NO_WINDOW`, unix `process_group(0)`, `kill_on_drop`, stderr를 **한 리더가**
  진행 파싱 + tail 보관(안 읽으면 파이프가 차서 멈춘다), `select!`로 종료·취소 경합, 반드시 `wait`.
- **환각·시간 방어**(`stt/guard.rs`, 순수 함수, 지우지 않고 표시만): 같은 정규화 텍스트 연속 3회 이상 → `suspect: "repeat"`,
  시각 역전·범위 밖 → `[0, durationMs]`로 자르고 단조 보정, 길이 0 단어 → 이웃과 나눠 최소 1ms.
- 긴 파일 청크 분할·이어서 하기(robust안)는 **P1에 넣지 않는다** — whisper-cli가 파일 전체를 스스로 30초 창으로 처리하므로
  필요성은 "2시간 실제 녹음에서 메모리·크래시"를 재 본 뒤에 판단한다(§8 Q8).

### 3.2 획득 (`stt/acquire.rs`, 59 재사용)

- **그대로**(가시성만 `pub(crate)`): `download_verified`, `check_free_space`, `extract_archive`, `register_cancel`/`DownloadGuard`,
  `http_client`, `send_progress`, `installed_server`, `installed_model`, `model_url`, `sweep_stale_downloads`.
  **취소는 기존 `llm_download_cancel(name)`** — 이름 `stt-runtime`·`stt-model-<id>`로 같은 맵을 공유하므로 새 커맨드 없음.
- **일반화**(로직 변경 없는 추출 커밋으로 먼저 분리): `Artifact`에 `progress_name`·`build` 필드 + `smoke: Option<fn(&Path) -> Result<(), IpcError>>`
  (`.ok`를 쓰기 **전에** 호출). llama는 `smoke: None`. 모델 다운로드·삭제 본문 → `download_model`/`delete_model` 헬퍼.
- **스모크**: 압축 해제 후 `whisper-cli --help`를 한 번 실행, 성공 + 출력에 `1.9.4`가 있을 때만 `.ok`. Windows `0xC0000135`
  (DLL 없음)은 VC++ 안내, Linux 로더 오류(`GLIBC_`, `libgomp`)는 시스템 설치 안내로 매핑.
- 위치: `app_local_data_dir/llm/whisper-b5130/`(런타임), `llm/models/ggml-*.bin`(모델) — `llm/` 아래라 고아 `.part` 청소와
  dev/설치본 identifier 분리를 그대로 탄다. 런타임 폴더가 llama 폴더와 달라야 한다는 테스트 추가.
- **`inner_dir`/`exe_rel`은 받은 아카이브를 풀어 보고 채운다**(llama 때 설계서 추정이 틀렸다, `acquire.rs:43-44`).
  zip에는 `llama.dll`·`parakeet-cli.exe` 같은 무관 파일도 있지만 실행은 `whisper-cli`만.
- **카탈로그 `STT_MODELS`**(`MODELS`와 분리 — `.gguf` 단언 보호): `turbo-q5`(기본, 547MiB), `base-q5`(57MiB, 저사양·빠른 초안).
  Silero VAD는 런타임과 함께 자동으로 받는다(선택지로 안 보임). small·turbo-q8·제3자 한국어 파인튜닝은 넣지 않는다
  (small은 turbo-q5와 크기가 비슷한데 품질이 낮다, 파인튜닝은 독립 평가·라이선스 표기가 없다).
- 모델 삭제는 그 모델을 쓰는 전사 잡이 돌고 있으면 `Busy`.
- 권장 뱃지는 `sys_info_static`(`["sys-info"]` 쿼리 키 공유) + `recommend()` 재사용. whisper에 `size×1.15`가 맞는지 **미확인**.

### 3.3 데이터 모델 — 비파괴 자막 문서 `CaptionDoc` v1

Rust `stt/doc.rs` serde 구조체가 원본, TS 타입은 **같은 커밋에서** 맞춘다.

```ts
interface CaptionDoc {
  version: 1;
  rev: number;                         // 저장마다 +1, 낙관적 동시성
  source: { rel: string; sizeBytes: number; mtimeMs: number; durationMs: number;
            startTimeMs: number;       // ffprobe format.start_time — 오버레이 보정(§3.5)
            audioStream: number };     // P1은 0
  engine: { name: "whisper.cpp"; build: string; modelId: string; language: string;
            detectedLanguage?: string; vad: boolean; prompt?: string };
  tokens: Token[];                     // 원본 시간순 고정. 재배치·삽입 없음
  cues: Cue[];                         // 연속 토큰 구간, 순서대로, 겹치지 않음, 토큰 전체를 덮음
  silenceKeepMs?: number;              // P2 무음 줄이기 전역 목표. 필드 삭제 = 복구
  translations?: Record<string, Record<string, string>>;  // P4: lang → cueId → text
}
type Token =
  | { id: string; kind: "word"; startMs: number; endMs: number; text: string; p?: number; cut: boolean }
  | { id: string; kind: "gap";  startMs: number; endMs: number; cut: boolean };
interface Cue { id: string; firstTokenId: string; lastTokenId: string;
  caption?: string;                    // 자막 줄 override(Correct). 없으면 남은 word를 이어 붙인다
  suspect?: "repeat" | "invalid-utf8" }
```

- **영상 줄 = `tokens`(cut만 영상에 영향), 자막 줄 = `cue.caption`(표시만).** word `text` 수정은 인식 교정 — 시각은 그대로.
- **시각은 전부 정수 ms, ffmpeg 디코드 기준(start_time 상대)** — whisper 결과·ffmpeg `trim`이 같은 기준이라 변환이 없다.
  플레이어 경계 한 곳에서만 `playerT = docT/1000 + (usingHls ? 0 : startTime)`(§3.5).
- 단어 만들기: BPE 토큰을 합친다(앞 공백 = 새 어절), 특수 토큰(`[_BEG_]`, `[_TT_*]`) 버림.
  gap: 이웃 단어 사이 ≥ 300ms와 파일 머리·꼬리(Vrew `…`).
- 초기 cue: whisper 세그먼트에서 시작해 16자/줄·2줄·7초 규칙으로 다시 자른다. 분할점 우선순위는 문장부호 → 700ms 이상 gap.
  AI 의미 분할은 하지 않는다.
- 불변식(`validate_doc`, 저장 전 필수): tokens 정렬, `0 ≤ s ≤ e ≤ durationMs`, cue 연속·비중첩·전체 덮음, 모든 텍스트에서
  제어 문자(`\n` 제외)·폭 없는 문자 제거.
- **편집 계획 `caption_plan`(Rust 순수 함수, 단일 구현)**:
  1. word: `cut`이 아니면 `[s − pad, e + pad]`(이웃 컷 구간과 겹치는 패딩은 잘라 냄)
  2. gap: `cut`이면 버림, `silenceKeepMs`가 있고 gap이 그보다 길면 가운데 기준으로 `silenceKeepMs`만 남김, 아니면 전부
  3. 병합(1프레임 미만 틈은 합치고 1프레임 미만 구간은 버림) → `keep: RangeMs[]`
  4. `out(t) = t − (t 이전 제거 길이 합)`, cue 출력 구간 = 남은 첫~마지막 토큰, 전부 잘린 cue는 버림,
     컷된 단어는 (override 없을 때) 자막 텍스트에서도 뺀다 → `outCues`
  `pad` 기본값은 **미확인**(auto-editor 200ms) — P0 실측으로 정하는 상수, 설정값 아님.
  무음 개별 조정 UI가 생기면 gap별 `keepMs`를 추가한다(지금은 전역 한 값).
- 되돌리기: 패널 전용 불변 스냅샷 스택(상한 200, 일괄 연산 하나 = 한 단계). VideoPlayer `editSnap`과 섞지 않는다 —
  대본 패널에 포커스가 있으면 패널이 Ctrl+Z/Y를 먹고 전파를 막는다. 구조 공유로 바뀐 cue·토큰만 새 객체.
- **저장: 앱 데이터**(§8 Q1). `app_data_dir/captions/<projectId>/<hex16(sha256(rel_normalized))>.json`, 경로는 Rust만 계산.
  - 레포에 쓰는 것은 사용자가 누른 내보내기뿐 → git이 더러워지지 않고 `resolve_in_repo` 경계를 밟지 않는다.
  - 원자적 쓰기(같은 폴더 `.tmp-<uuid>` → rename). 재전사로 덮을 때 직전 판을 `.bak` 한 세대.
  - 알지 못하는 **더 높은** `version`은 읽기 전용 + 저장 거절(새 앱 문서를 옛 앱이 망가뜨리지 않게).
  - `size`/`mtime`이 다르면 `stale: true` → "원본이 바뀌어 시각이 어긋날 수 있음 — 다시 인식" 배너, 편집은 막지 않음.
    원본 이동 시 재연결 UI는 만들지 않는다(P5).
  - `rev` 불일치면 `Conflict`. `SAVE_LOCK`은 프로세스 내부지만 dev/설치본은 identifier가 달라 폴더가 갈리므로 충분.

### 3.4 IPC

모든 커맨드 `#[tauri::command(async)]` + `Result<T, IpcError>`, `lib.rs` 등록. 외부 프로세스·디스크 스캔 커맨드
(`stt_status`, `stt_transcribe`, `stt_runtime_ensure`, `stt_model_download`, `caption_export_subs`)는 `hot_commands_stay_async`
`HOT` 목록에 추가. 락은 `unwrap_or_else(|e| e.into_inner())`.

| Rust | TS(`ipc.ts`) | 종류 | 비고 |
|---|---|---|---|
| `stt_status() -> SttStatus` | `sttStatus` | `call` | `{runtime: Found{path,source}\|Missing\|Unsupported, models[{id,label,size,installed}], vadInstalled}` |
| `stt_runtime_ensure(on_progress: Channel<String>)` | `sttRuntimeEnsure` | `callMutating`, **호출마다 새 Channel** | 런타임 + VAD, 스모크 통과 시 `.ok` |
| `stt_model_download(model_id, on_progress)` | `sttModelDownload` | `callMutating`, 새 Channel | 카탈로그 id만 |
| `stt_model_delete(model_id)` | `sttModelDelete` | `callMutating` | 사용 중이면 `Busy` |
| (재사용) `llm_download_cancel(name)` | `llmDownloadCancel("stt-…")` | `callMutating` | |
| `stt_transcribe(req: TranscribeReq) -> CaptionLoaded` | `sttTranscribe` | `callMutating`, timeout 6h | §3.1 |
| `stt_transcribe_cancel(job_id)` | `sttTranscribeCancel` | `callMutating` | 멱등, `video_export_cancel`과 같은 레지스트리 함수를 부르는 얇은 래퍼(검색성) |
| `caption_doc_load(project_id, rel_path) -> Option<CaptionLoaded>` | `captionDocLoad` | `call` | |
| `caption_doc_save(project_id, rel_path, doc, base_rev) -> CaptionSaved` | `captionDocSave` | `callMutating` | `validate_doc` → `rev` 검사 → 원자 쓰기 |
| `caption_export_subs(project_id, rel_path, spec: SubExportSpec) -> String` | `captionExportSubs` | `callMutating` | 레포에 SRT/VTT/TXT |
| (확장) `video_export(spec)` | 기존 `videoExport` | 기존 | `ExportSpec.caption_cut`, `caption_subs`(§3.6) |

```rust
struct TranscribeReq { job_id: String, project_id: String, rel_path: String,
                       model_id: String, language: String, prompt: Option<String> /*≤500자*/ }
struct CaptionLoaded { doc: CaptionDoc, stale: bool, plan: CaptionPlan }
struct CaptionSaved  { rev: u64, plan: CaptionPlan }
struct CaptionPlan   { keep: Vec<RangeMs>, out_cues: Vec<OutCue>, out_duration_ms: u64 }
enum SubFormat { Srt, Vtt, Txt }   enum SubTimeline { Source, Edited }   enum SubText { Caption, Translation, Both }
struct SubExportSpec { format: SubFormat, timeline: SubTimeline, text: SubText, lang: Option<String>, out_rel: String, overwrite: bool }
```

- **잡 계약 = `video_export` 그대로**: 프론트가 `crypto.randomUUID()`로 jobId → 백엔드 uuid 검증 → `state.video` 레지스트리에
  **spawn 전 등록**(앱 종료 시 `video_kill_all`이 거두므로 새 `shutdown_step` 불필요) → 진행 이벤트
  `stt://progress {jobId, phase: "extract"|"transcribe"|"parse", percent}`(정수 %가 바뀔 때만) → 종결 `stt://finished {jobId, ok, error?}`를
  **모든 결과에 한 곳에서**. 프론트는 invoke 응답과 종결 이벤트 중 먼저 온 쪽을 ref로 한 번만 처리(Windows 응답 유실,
  `videoSplit.ts:124-144` 패턴). 결과는 이미 디스크에 있으므로 이벤트 경로에서는 `captionDocLoad`를 다시 부른다.
  토스트는 잡을 시작한 창만(`events.ts:34-45`, `localVideoJobs`).
- 다른 창 저장: `caption://changed {projectId, relPath, rev}` — 받는 쪽에 미저장 편집이 없으면 다시 읽고, 있으면 충돌 배너.
- 동시 실행: 전사는 앱 전체에서 **하나**(두 번째 `Busy`). 전사 중에는 같은 플레이어의 내보내기·분할 버튼을 막는다
  (`ExportPanel.tsx:825-826`의 "ffmpeg 동시 실행 금지" 확장).
- **cue·keep을 IPC로 넘기지 않는다**: 내보내기는 Rust가 자기 저장소에서 문서를 읽어 `caption_plan`을 계산한다 — 계획 구현이
  하나뿐이다. 프론트의 미리보기·타임라인 음영도 저장 응답의 `plan`만 쓴다(자동 저장 500ms 디바운스).

**설정**: `sttModel: String`(기본 `"turbo-q5"`), `sttLanguage: String`(기본 `"auto"`) 두 개. Rust `Settings`·TS `Settings`·
`SETTINGS_INDEX`를 같은 커밋에서, `buildCleaned`에서 언어 코드 소문자 정리. 같은 기회에 e2e 47 ⑤ 개수 단언을 현행값으로.

### 3.5 UI

**붙는 자리** — 상단 바에 **"대본" 토글 버튼**(모드 스위치의 세 번째 칸이 아니다 → `:968-969` "두 상태뿐" 결정 유지).
켜면 가운데 칼럼과 인스펙터 사이에 대본 칼럼(기본 400px, 360~720px 드래그). **재생 모드에서도 보인다** — 검색·이동은 편집 없이도
쓴다. ExportPanel 탭(320px)은 대본 편집에 좁아서 기각.
- 새 파일: `src/components/video/captions/TranscriptPanel.tsx`(memo), `CaptionOverlay.tsx`, 스토어 `src/stores/captionDoc.ts`
  (창마다 스토어, key `projectId+relPath`), 번역 `src/lib/captionTranslate.ts`(P4). VideoPlayer에는 토글·칼럼 슬롯·파일 전환
  리셋·시각 변환만 추가. Timeline을 떼어 내야 하면 **로직 변경 없는 이동 커밋**을 먼저.
- TS `VideoMeta`에 `startTimeMs` 추가(Rust `VideoMeta`와 같은 커밋) — 오버레이·"현재 위치로" 보정용. 지금은 없다(§2.1).

**빈 상태** — `sttReadyReason(toolStatus, sttStatus, settings)`이 ffmpeg → ffprobe → 엔진 → 모델 순서로 보고 문구와 행동
("코드 도구에서 ffmpeg 받기" / "설정 › AI › 음성 인식에서 받기" / macOS `brew install whisper-cpp`)을 준다. 준비되면
`[자막 만들기]` + 모델·언어 드롭다운 + 용어 힌트 입력. 진행 중에는 단계·%·취소.

**대본 편집기 — contentEditable을 쓰지 않는다**(§2.1 단축키 함정). 토큰 `<span>` + 자체 선택 모델.
- cue 한 행 = 두 줄: **영상 줄**(토큰 span, `cut`은 취소선·흐림, gap은 `··· 1.4s` 칩 / 단축되면 `1.4→0.6s`, "잘린 부분 숨기기"
  보기 옵션) + **자막 줄**(읽기 전용, 클릭하면 `<input>` → `caption` override, override 행에 "인식 텍스트 따라가기" 아이콘) +
  `suspect` 뱃지.
- 선택 `{anchorId, focusId}`: 클릭 = 그 단어로 이동 + 앵커, Shift+클릭·드래그 = 범위.
- 키(패널 루트 `onKeyDown`에서 처리하고 **`stopPropagation`**):

| 키 | 동작 | 단계 |
|---|---|---|
| Ctrl+F | 찾기, 결과 사이 이동 | P1 |
| Enter / cue 첫 단어에서 Backspace / Ctrl+E | 나누기 / 위와 합치기 / 아래와 합치기 | P1 |
| 더블클릭 / F2 | 단어 텍스트 인라인 `<input>` 수정(Correct, 시각 그대로) | P1 |
| Ctrl+H | 찾아 바꾸기(텍스트만) | P1 |
| Ctrl+Z / Y | 패널 전용 되돌리기 | P1 |
| Space | 재생 토글(패널이 처리, 전역 Space 리스너 `:365-396`과 이중 토글 방지) | P1 |
| Delete / Backspace(선택 영역) | `cut` 토글(전부 잘렸으면 복구) | P2 |
| Ctrl+H "찾은 곳 모두 컷" | 추임새 단어 목록 일괄 컷 | P2 |

- **렌더 성능**: `time`을 props로 받지 않는다 — `getTime` ref 게터를 받고, 패널 자체 rAF에서 이진 탐색으로 현재 단어를 찾아
  이전 span `classList.remove` / 새 span `add`(React 렌더 0회). cue 행은 객체 동일성으로 memo. 가상화 없음 — 1시간(약 1,000 cue)
  초기 렌더를 재서 200ms를 넘으면 `content-visibility: auto`부터.
- 드래그 커밋은 setState 업데이터 **밖에서**(StrictMode 이중 실행, `CropOverlay.tsx:41-47`), `listen()`은 `disposed` 플래그 패턴.

**자막 미리보기 = DOM 오버레이** — 스테이지(`:1048`) 안 absolute div. VideoPlayer가 이미 rAF마다 그리므로 이진 탐색으로 현재
cue를 찾아 `CaptionOverlay`(memo, `text`만)에 넘긴다. 확대(F)도 같은 컨테이너라 따라간다. `<track>`·blob·data·캔버스는 쓰지 않는다
(CSP·CORS 결정 5 유지). 상단 바 `CC` 토글. 스타일 프리셋은 ASS 프리셋과 **같은 값 표**(글자 크기 = 영상 높이 비율, 테두리, 위치)에서
CSS를 파생 — 번인 결과와 완전히 같지는 않다(§6).

**편집 반영 재생**(P2): VideoPlayer rAF가 `planRef.keep`을 보고 잘린 구간에 들어가면 다음 keep 시작으로 seek. 이음매의
작은 소리 튐은 미리보기에서 허용.

**타임라인 S1 자막 트랙**: A1과 마커 사이에 같은 형태의 행. cue 블록 `left: pct(s)`, `width: pct(e)-pct(s)`, 컷 구간은 빗금.
블록 레이어는 memo 하위 컴포넌트로 `vs/ve/barW/cues/plan`만 받고 `visible()`로 컬링. `snapTo` 후보에 cue 경계. 경계 드래그·파형
기반 단어 경계 조정은 P5.

**설정** — 새 카테고리 없이 AI 섹션에 "음성 인식(자막)" 소제목. 런타임 행·모델 표는 `AiSection.tsx:111-199` 복제, 진행 상태
`sttRuntimeBusy/Status`·`sttModelBusy/Status`는 셸 소유, 삭제는 `askConfirm`.

### 3.6 내보내기

| 산출물 | 경로 | 규칙 |
|---|---|---|
| SRT/VTT/TXT | `caption_export_subs`, Rust 순수 함수 `build_srt/build_vtt/build_txt` | `resolve_in_repo` → 같은 폴더 `.gpv-export-<uuid>.tmp` → rename, `AlreadyExists` 확인. **제어 문자(`\n` 제외)·폭 없는 문자(U+200B–U+200F, U+2028/2029, U+2060, U+FEFF)·방향 제어(U+202A–U+202E, U+2066–U+2069) 제거.** SRT `HH:MM:SS,mmm` CRLF, VTT `HH:MM:SS.mmm` LF(관례, 명세 근거 **미확인**), BOM 없는 UTF-8, 빈 cue 생략, 겹침은 앞 cue 끝을 자름 |
| 기본 파일명 | 원본 `name.srt`, 편집본 `name.cut.srt`, 번역 `name.<lang>.srt` | `.cut`/`.sub`를 `frameCapture.ts:16-19` `GEN_SUFFIX`에 추가 |
| 선택 cue → 클립/GIF | 기존 `video_export` + `range` | 변경 없음. 선택한 cue 범위를 In/Out으로 |
| 편집본 mp4 | `ExportSpec.caption_cut: bool` → `name.cut.mp4` | 아래 |
| 번인 / 소프트 자막 mp4 | `ExportSpec.caption_subs: Option<CaptionSubs{mode: Burn\|Soft, timeline, text}>` → `name.sub.mp4` | 아래 |

`ExportSpec`에 필드 두 개, TS `VideoExportSpec`도 같은 커밋에서. `build_export_args` 확장은 전부 순수 함수 + 단위 테스트.

1. **다중 구간**(`caption_cut`): 구간 i마다 `[0:v]trim=start=a:end=b,setpts=PTS-STARTPTS[v_i]`,
   `[0:a]atrim=…,asetpts=PTS-STARTPTS,afade=t=in:d=0.01,afade=t=out:st=(len−0.01):d=0.01[a_i]` → `concat=n=N:v=1:a=1[vc][ac]`
   (오디오 없으면 `a=0`). 초 값은 소수 6자리 숫자 문자열만. `-ss` 입력 탐색 없음, **copy 모드·`range`와 배타**(`validate_spec`).
   `expected_out_us = Σkeep ÷ speed`.
2. **체인 순서**: concat → mask → crop → scale → **subtitles** → setpts(배속). subtitles는 setpts **앞** — 자막 시각이 배속 전
   타임라인이라 나누기 변환이 필요 없고, scale 뒤라 글자 크기가 출력 해상도 기준. 이를 위해 `build_mask_graph`의 입력 라벨을
   인자로 바꾼다(`:522`). 구간이 있으면(`range`) cue 시각에서 `range.start`를 빼고 밖은 버림.
3. **명령줄 길이**: 구간당 약 300자라 Windows 32,767자 한도에서 인라인은 약 100구간까지. 인라인 그래프를 24KB로 제한하고, 넘으면
   캐시 폴더 그래프 파일로 넘긴다 — 플래그(`-/filter_complex` vs `-filter_complex_script`)가 johnvansickle 7.0.2·gyan 9.0.1·
   martin-riedl 9.0.1에서 각각 되는지 **미확인**, P0 실측 전까지는 `TooManyRanges` + "무음 줄이기 목표를 늘려 주세요" 안내.
4. **번인 — 필터 문자열에 경로·사용자 텍스트를 넣지 않는다**: Rust `build_ass(cues, preset, out_h)`가 ASS를 캐시 잡 폴더
   `gpv-stt-burn-<uuid>/subs.ass`에 쓰고, ffmpeg **`current_dir`를 그 폴더**로, 필터는 상수 `subtitles=f=subs.ass`. 입·출력은 절대
   경로 argv 원소. Windows 드라이브 콜론 이스케이프 문제와 필터 인젝션 경계가 사라진다. ASS 본문: `{`·`}`·`\`는 전각
   (`｛｝＼`)으로 치환(ASS 이스케이프 규칙 의존을 피함), 줄바꿈 `\N`, `PlayResY` = 출력 높이. 번역 2단은 `원문\N번역`.
5. **libass 감지**: `video_tool_status`에 `has_subtitles_filter`(`ffmpeg -hide_banner -filters`에 `subtitles`, 경로별 캐시).
   gyan essentials는 포함([gyan.dev](https://www.gyan.dev/ffmpeg/builds/)), johnvansickle 7.0.2·martin-riedl·시스템 ffmpeg는 **미확인**.
   없으면 번인 버튼 대신 **소프트 자막**(`-i <tmp.srt> -map 0:v -map 0:a? -map 1 -c:s mov_text`, libass 불필요)을 안내와 함께.
6. **한글 폰트**: ASS `Fontname` OS 기본값 Windows "Malgun Gothic" / macOS "Apple SD Gothic Neo" / Linux "Noto Sans CJK KR".
   정적 ffmpeg가 fontconfig로 찾는지 **미확인** — 네모 칸이 나오면 OFL 폰트 한 벌을 sha256 고정 선택 자산으로(§8 Q6).

### 3.7 번역 자막 (P4, Rust 변경 없음)

- `src/lib/captionTranslate.ts` 순수 함수: `batchCues(cues, charBudget(llmContext))`(`report.ts:153-165` 패턴, 추정 1,500자 ≈ 30~40 cue) →
  `buildPrompt`(`12|텍스트` 번호 줄, cue 안 줄바꿈 ` ⏎ `, system "같은 번호·같은 줄 수·서문 금지") → `parseNumbered` + 검증
  (id 집합 일치·빈 줄/중복 없음·`truncated` 아님) → 실패 시 temperature 0으로 1회 → 배치를 반으로 → 크기 1까지.
- **타임코드는 LLM에 보내지 않는다** — id로 다시 붙이므로 시각이 망가질 수 없다.
- `translate.ts:70-100`의 Busy 재시도를 `llm.ts chatWithBusyRetry`로 추출(두 번째 소비자). 배치 사이에 61·60 요청이 끼어드는 것은 의도.
- 배치마다 `translations[lang]`에 저장 → 창을 닫았다 열면 빈 id부터 이어서. `langName`을 ko/en/ja/zh/es/fr/de/vi 정도로.
  Vrew의 "100개 언어"는 약속하지 않는다. 전사 중에는 번역 버튼 비활성.
- 순수 함수는 `__gpv`로 노출해 e2e에서 단언(33 `planSegments` 선례 — TS 단위 테스트 러너가 없다).

## 4. 단계 (각 단계가 독립 릴리스 절단면)

| 단계 | 내용 | 릴리스 가치 |
|---|---|---|
| **P0 리팩터·실측** (릴리스 없음) | `acquire.rs` `Artifact` 일반화·헬퍼 추출·`pub(crate)`, `server.rs` scope 헬퍼 추출(로직 변경 없는 커밋) + 실측 체크리스트(아래) | 결정 확정, llama 경로 무회귀 |
| **P1 자동 자막** | `stt/`(acquire·transcribe·doc·guard), 5+4 커맨드, 설정 AI 소제목, 대본 패널(보기·검색·클릭 이동·자막 줄 수정·나누기·합치기·찾아 바꾸기·undo), 오버레이, SRT/VTT/TXT(원본 시각), 선택 cue → 기존 단일 구간 내보내기, 용어 힌트, `VideoMeta.startTimeMs`, e2e 47 ⑤ 수정. OS: Win x64/arm64·Linux x64/arm64 관리형, macOS 발견 | "영상에 자막 파일 만들기"로 완결 |
| **P2 대본 편집(컷)** | `cut` 토글, `caption_plan`, 편집 반영 재생, S1 트랙·컷 음영, `ExportSpec.caption_cut`(다중 구간), 편집본 SRT, 무음 줄이기(조건 "X초 초과 → Y초로", 기본 1.0 → 0.6s, 결과 목록 검토 후 적용, 복구), 찾아서 일괄 컷 + 추임새 단어 목록, 필름스트립·파형 캐시 무효화 빈틈 수정(`events.ts:79-84`) | Vrew의 핵심 경험 |
| **P3 자막 입힌 영상** | libass 감지, `build_ass`, 번인·소프트 자막, 스타일 프리셋 3종(기본·박스·크게, 오버레이와 값 공유), 오디오 트랙 선택 | PR 클립(소리 없이 자동 재생) |
| **P4 번역 자막** | §3.7 | 2단 자막 |
| **P5 조건부** | macOS 관리형 CI 빌드(Metal, 공식 release.yml 플래그 `-DGGML_BACKEND_DL=ON -DGGML_NATIVE=OFF -DGGML_METAL_EMBED_LIBRARY=ON`), Windows CUDA 선택 자산(greedy 기본·UTF-8 검증·LLM 세션 있으면 `-ng`), 긴 파일 청크·이어서 하기, 원본 재연결, 경계 드래그, 클라우드 URL | 수요를 보고 |

**P0 실측 체크리스트**(결과는 이 문서 부록에 채운다)
1. 단어 시각: VAD+선형 재배치 vs VAD 끄고 `-nfa -dtw large.v3.turbo` — **실제 녹음** 3종(화면녹화 해설·회의·음악 깔린 강의)에서
   손으로 표시한 경계와의 오차 중앙값 → P2 방식과 `pad` 기본값 결정.
2. `-/filter_complex`·`-filter_complex_script` 지원(세 ffmpeg 빌드), libass 포함과 한글 폰트 렌더(같은 셋).
3. 클린 Windows VM(VC++ 재배포 패키지 없음)에서 VCOMP140 때문에 막히는지.
4. zip·tar.gz의 `inner_dir`/`exe_rel`, Homebrew 설치 파일 이름과 `--help` 플래그(mac arm64 실기).
5. 저사양(4코어)·ARM RTF, 2시간 실제 녹음의 최대 메모리, 전사 중 태스크 71 `[term-perf]` 지연.

## 5. 검증

변경 크기 **"큰 것"**(새 서브시스템 + IPC 커맨드 + `video_export` 파일 쓰기 경로) → 단계마다 관련 스위트, 릴리스 전 전체
`node tests/e2e/shard.mjs`. 파일 쓰기·보안 경계(필터 문자열·경로)는 크기와 무관하게 엄격.

**Rust `cargo test --lib`**(같은 파일 `#[cfg(test)]`)
- 카탈로그: 해시 64자 소문자 hex, id 중복 없음, `.bin`, 런타임 폴더 ≠ llama 폴더.
- `build_stt_audio_args`: `-map 0:a:0 -vn -ac 1 -ar 16000 -c:a pcm_s16le -f wav`, 입력이 출력보다 앞.
- `build_whisper_args`: `-l` 항상 존재, `-of`가 `-`가 아님, `--vad -vm`, `-ojf`, `-pp`.
- `parse_whisper_progress`(`progress =  11%` → 11, 무관한 줄 None), `parse_whisper_json`(BPE 병합, 특수 토큰, 멀티바이트, 길이 0,
  **잘못된 UTF-8 → Err** — `ko6_cuda2.srt` 재현 바이트), `remap_tokens_into_segment`, guard(반복·역전·범위 밖).
- `split_cues`(16자·2줄·7초), `validate_doc`, `caption_plan`(컷·패딩 충돌·gap 단축·1프레임 병합·전부 잘린 cue 제거·`out(t)` 단조·
  Σkeep = `out_duration_ms`), 높은 version 저장 거절, `rev` 충돌, 문서 키가 경로 탈출 불가.
- `build_srt/vtt/txt`(59.999초·1시간 이상 경계, 금지 문자 제거), `build_ass`(`{}\` 치환, `\N`).
- `build_export_args`: `caption_cut`이면 `-ss` 없음·concat N·copy/range 거절, 체인 순서, 마스크 입력 라벨, `expected_out_us`,
  **번인 필터 문자열에 경로·사용자 텍스트가 없다**(반증 단언).
- 소스 스캔: `hot_commands_stay_async` HOT에 새 커맨드, `no_poison_propagating_unwraps`(새 파일 자동).
- `#[ignore]` 수동: 실제 whisper-cli로 jfk.wav 전사.

**TS**: `tsc --noEmit`.

**e2e**(스위트 번호는 착수 시 빈 번호)
- `stt-captions`(47 패턴, `E2E_NET`·`E2E_STT_MODEL`(ggml-tiny 주입) 게이트): 픽스처는 whisper.cpp `samples/jfk.wav`(MIT, 11초) +
  testsrc를 ffmpeg로 합성, sha256 고정. 결과에 "country" 포함(전체 문장 비교 안 함, `-bs 1 -nf`), cue 시각 단조·길이 이내, 문서
  저장·재로드 동일, 진행 이벤트 수신, **취소 시 whisper·ffmpeg 잔존 0**(`sys_process_snapshot`) + 캐시 WAV 삭제, 오버레이가 seek 후
  해당 cue 표시, 대본 패널에서 `i` 입력 시 In 지점이 **찍히지 않음**(키 가로채기 회귀).
- `caption-edit-export`(엔진 없이 결정적): 33의 testsrc+sine에 합성 `CaptionDoc`을 `caption_doc_save`로 주입 → 나누기·합치기·컷 후
  불변식, 편집본 mp4 ffprobe 길이 ≈ Σkeep(±1프레임), 편집본 SRT 시각 = `out(t)`, 금지 문자 부재, `rev` 충돌 → Conflict, doc 창에서
  시작한 잡 토스트가 그 창에만(34 패턴), 번인은 libass 있을 때만(없으면 소프트 자막 스트림 존재).
- 기존 회귀: 33(분할), 34(doc 창 내보내기), 47(llama 획득 — P0 리팩터), 29(설정 인덱스).

**변이 검증**(조용히 실패하는 유형만): "잘린 토큰이 편집본 SRT에서 빠진다", "`caption_cut`이면 `-ss`가 없다" — 수정을 되돌려 빨개지는지.

**실기 필수**(자동화 불가): 클린 Windows x64 VM(스모크·안내), Windows arm64, Ubuntu 20.04(실패 안내)·22.04/24.04 x64·arm64,
GNOME 메뉴로 띄운 설치본의 `cgroup.procs`·scope 분리·종료 후 잔존 0, macOS arm64(brew 있음/없음, 번인 폰트 — WKWebView는 CDP가
없어 수동), Intel mac 안내 문구, **실제 녹음**(회의·다화자·잡음·OBS 다중 트랙·1시간+).

## 6. 위험

| 위험 | 영향 | 대응 / 상태 |
|---|---|---|
| macOS에 공식 CLI 없음 | P1 mac 사용자는 brew 설치, Intel은 소스 빌드, 버전 통제 불가 | 발견 + 플래그 검사 + 안내, P5 자체 CI 빌드 |
| VCOMP140(클린 Windows) **미확인** | 설치됐는데 실행 불가 | 스모크 → VC++ 안내 |
| Linux glibc 2.34·libgomp | 구형 배포판 실행 불가 | 스모크 → 시스템 설치 안내 |
| VAD 켤 때 토큰 시각이 VAD 타임라인 | 단어 컷이 어긋남 | P1은 cue만 신뢰, 선형 재배치, P0 실측으로 P2 방식 확정 |
| 단어 시각 자체가 부정확("experimental", 길이 0) | 말이 잘리거나 남음 | `pad`, 편집 반영 재생으로 확인 |
| 한국어 품질 근거가 TTS 1건 + 공개 CER뿐 | 초안 수정 부담 | 찾아 바꾸기 우선, 용어 힌트(효과 제한적 실측), `suspect` 표시 |
| CPU 속도: 24코어에서 실시간 1.5배, 저사양·ARM **미측정** | 1시간 영상 수십 분+ | 예상 시간 표시, base-q5, 취소, P5 CUDA |
| 전사 CPU 부하로 터미널 지연 | 태스크 71 회귀 | 스레드 상한, 필요하면 낮은 우선순위, `[term-perf]` 실측 |
| Linux oomd(수백 MB 모델) | 앱 SIGKILL | `systemd-run --scope` 필수 + 실기 cgroup 확인 |
| CUDA + beam UTF-8 깨짐(실측) | 깨진 자막 | P1 CPU만, 엄격 검사 + greedy 재시도 + 표시 |
| libass·한글 폰트·필터 스크립트 플래그 **미확인** | 번인·편집본 실패 | 런타임 감지, 소프트 자막, 구간 상한, P0 |
| `b5130`은 prerelease nightly 태그 | 태그 삭제 시 신규 설치 실패 | sha256 고정이라 다른 파일은 안 받는다, 사라지면 자체 미러(P5 CI) |
| 오버레이 CSS ≠ ASS 렌더 | 미리보기와 결과 차이 | 같은 값 표에서 파생, 차이 문서화 |
| start_time ≠ 0 파일(방송 ts +1.4초 등) | 오버레이 싱크 어긋남 | 경계 한 곳에서 변환. 기존 In/Out 내보내기(`ExportPanel.tsx:168-174`)에도 같은 잠재 오차 — 별건 |
| 여러 창 동시 편집 | 덮어쓰기 | `rev` + `caption://changed` |
| 원본 이동 | 문서 고아 | `stale` 배너, 재전사, 재연결은 P5 |
| 1만 토큰 렌더 **미측정** | 패널 버벅임 | DOM 클래스 강조, 행 memo, 필요하면 `content-visibility` |

## 7. 하지 말 것(비범위)

- AI 목소리(TTS)·음성 덮어쓰기·AI 더빙·Regenerate — 개발자 녹화는 원본 음성이 콘텐츠, 윤리·품질 위험.
- 텍스트/PDF → 영상, AI 이미지·영상 생성, 아바타, 스톡 소재, 썸네일, 전환 효과 — 편집이 아니라 생성, 라이선스 부담.
- 클라우드 저장·공유, 화면 녹화, 프록시(HLS 폴백이 있다), 투명 자막 mov, 씬, 빈 클립.
- 단어 순서 바꾸기·복제 — 빼야 keep 목록이 단조 증가해 계획·시간 매핑이 단순하다.
- 화자 분리, 카라오케 강조, 리테이크 자동 제거, NLE XML, 잡음 제거, 전체 오프셋, 추임새 자동 탐지(단어 목록으로 대신).
- **엔진**: FFmpeg `whisper` 필터(빌드에 없음·청크 손실), whisper-rs 프로세스 내(abort가 앱을 죽임), OS 엔진, faster-whisper-XXL,
  상주 whisper-server, sherpa-onnx 병행(파서·카탈로그가 둘로 는다 — macOS 공백이 끝내 안 풀릴 때만 재검토).
- `<track>`·blob·data URI 자막, 프리뷰 서버 CORS 개방, CSP 완화 — 설계 결정 5를 뒤집지 않는다.
- `video.rs` ffmpeg 다운로더 재사용, 새 설정 카테고리, `llm*` 접두어 설정 키, `mode: String` 같은 문자열 상태.
- 필터 문자열에 경로·사용자 텍스트 넣기. `from_utf8_lossy`로 조용히 복구하기.

## 8. 열린 질문

| # | 질문 | 선택지 | 권고 |
|---|---|---|---|
| Q1 | 자막 문서 저장 위치 | (a) 앱 데이터 (b) 영상 옆 사이드카 `name.gpvcap.json` | **(a).** git을 더럽히지 않고 레포 쓰기는 명시적 내보내기뿐, 공유는 SRT. 팀 공유가 필요하면 (b)를 옵션으로 P5 |
| Q2 | macOS 엔진 | (a) P1 brew 발견·안내, P5 자체 CI 빌드 (b) P1부터 자체 CI 빌드(Metal) (c) sherpa-onnx 두 번째 엔진 | **(a).** mac 사용 비중이 크면 (b)를 P2와 병행. (c)는 한국어 품질 열세 + 구현 둘 |
| Q3 | 기본 모델·언어 | turbo-q5 + auto / turbo-q5 + ko / base-q5 | **turbo-q5(547MiB) + auto**, 드롭다운 값 기억. 한국어만 쓰면 `ko` 고정이 감지 오류를 줄인다 |
| Q4 | Windows GPU(CUDA 273~675MB) | P1 / P5 선택 자산 / 안 함 | **P5 선택 자산.** 첫 실행 JIT 55초·beam UTF-8 깨짐 실측, CPU turbo RTF 0.4로 시작 가능 |
| Q5 | 클라우드·OpenAI 호환 URL 전사 | 안 함 / 옵트인 | **안 함.** 로컬 원칙·회의 녹화 개인정보. 요청 시 `verbose_json`+`timestamp_granularities` 계약 하나로 |
| Q6 | 번인 한글 폰트 | 시스템 폰트만 / OFL 폰트 선택 다운로드 | P3에서 세 OS ffmpeg로 먼저 번인해 보고, 네모 칸이면 OFL 폰트 하나를 sha256 고정 자산으로 |
| Q7 | VCOMP140 없을 때 | 안내만 / DLL 동봉 | **안내만.** 재배포 권리·해시 출처 확인 전에는 동봉하지 않는다 |
| Q8 | 긴 파일(2시간+) 청크 분할·이어서 하기 | P1 / 실측 후 | **실측 후.** 2시간 실제 녹음의 메모리·크래시를 재서 필요하면 P5(robust안 §5.1 설계 재사용) |
| Q9 | 컷 편집(P2)까지 갈지 | P1+P3 먼저 내고 반응 보기 / 순서대로 | **순서대로(P1 → P2).** 사용자 요청이 "Vrew처럼 편집"이다. 단 P1 단독으로도 릴리스 가능 |
| Q10 | 무음 줄이기 기본값 | 1.0s 초과 → 0.6s / 0.8s → 0.8s(Vrew 블로그) | 1.0 → 0.6s, **자동 적용 없이 검토** — 데모 영상의 무음은 "화면 작업 중". P2 실측으로 확정 |

## 부록 A. 설계안 채점 (각 10점)

| 안 | 재사용·실현성 | 세 OS | 사용자 가치 | 위험 관리 | 범위 절제 | 검증 가능성 | 합계 | 한 줄 |
|---|---|---|---|---|---|---|---|---|
| **vrew-ux** (뼈대) | 8 | 8 | 9 | 8 | 7 | 9 | **49** | 영상 줄/자막 줄 모델, Rust 단일 계획 구현, 대본 토글(두 상태 결정 유지), P0 실측 |
| robust | 8 | 8 | 8 | 9 | 5 | 9 | 47 | 방어 필터·스모크·필터 경로 cwd 우회·구간 상한은 이식. 청크 분할·이어서 하기는 P1엔 과함(Q8) |
| lean | 9 | 8 | 6 | 7 | 9 | 8 | 47 | 가장 싸지만 컷 편집이 P3로 밀려 "Vrew처럼" 요청에서 멀다. subtitles/setpts 순서 서술이 자기모순 |

이식한 것: robust → 설치 스모크(`.ok` 전), 방어 필터(`suspect`), 번인 cwd + 상수 파일명, 구간 상한, `rev`·`validate_doc`;
lean → 모델 2종 카탈로그, 인자 빌더 테스트 목록; vrew-ux 자체 → 데이터 모델·IPC·UI·P0 체크리스트.

판정한 충돌(조사 원문 기준): Linux ffmpeg는 BtbN이 아니라 johnvansickle 7.0.2(`video.rs:1406-1436`) · VAD는 켠다(ext-alternatives 실측
turbo+VAD 무오류·세그먼트 정확, 토큰 offset 문제는 ext-whisper 실측이라 재배치 + P0) · subtitles는 setpts 앞(자막 시각이 배속 전
타임라인) · UTF-8은 greedy 재시도 후 U+FFFD + `suspect`(lean의 조용한 lossy 기각, vrew-ux의 "오류로 끝냄"은 전사 전체를 버려 과함) ·
TS `VideoMeta`에 startTime 없음(코드 실측, vrew-ux의 "미확인"을 확정) · 필터 스크립트 플래그는 세 안이 다르게 주장 → 미확인으로 두고 P0.

## 부록 B. P0 실측 결과 (2026-09-22, 이 머신 Windows 11 x64 + WSL Ubuntu 24.04)

스크립트·원자료는 세션 스크래치(`p0/`)에만 있다 — 다시 재려면 아래 명령으로 재현한다.

### B.1 단어 시각 정확도 → P2 방식·`pad`

**정답 만들기.** 한국어 음성 `Microsoft Heami Desktop`(SAPI, ko-KR)으로 12문장 111어절을 SSML 합성, `SpeakProgress.AudioPosition`
(어절 시작)을 정답으로 기록. 문장 사이 `<break>` 1.0~3.0초, 머리·꼬리 1초, 16kHz mono, 92.5초. 정답 자체 검증: 문장 첫 어절의
AudioPosition이 `silencedetect=noise=-45dB` 발화 시작보다 16~20ms 앞(1100/1120, 2825/2841, 9960/9980ms) — 정답 오차 ±20ms 수준.
변형: 핑크 잡음 `anoisesrc=color=pink:amplitude=0.03`(잡음 평균 −44.7dB, 음성 −22.3dB ≈ SNR 22dB)·`amplitude=0.12`(잡음 −32.8dB ≈ SNR 10dB)를 `amix … normalize=0`.

**전사.** b5130 CPU(`whisper-bin-x64.zip`) + `ggml-large-v3-turbo-q5_0`, 공통 `-l ko -sns -ojf -pp -t 8`.
- (c) 기본: VAD 끔, 토큰 `offsets.from`
- (a) `--vad -vm silero`, 세그먼트 안 선형 재배치(`seg.from + (t − tmin)·(seg.to − seg.from)/(tmax − tmin)`, tmin/tmax = 특수 토큰 제외 토큰 시각)
- (a2) `--vad`, 토큰 시각을 **stderr의 VAD 대응표**(B.3)로 조각별 이동
- (b) VAD 끔, `-nfa -dtw large.v3.turbo`, 어절 첫 토큰의 `t_dtw × 10`
- (d) `--vad -nfa -dtw large.v3.turbo`, `t_dtw × 10`을 stderr VAD 대응표로 이동
- (d') (d)와 같은 실행, `t_dtw`를 (a)처럼 세그먼트 안 선형 재배치

**짝짓기.** 공백·문장부호를 뺀 글자열을 difflib로 맞추고, 정답 어절 첫 글자가 가설 어절 첫 글자에 붙은 것만 잰다(104~109/111쌍).
오차 = 가설 − 정답(ms, +면 늦음).

| 방식 | 깨끗 중앙값\|e\| | p90\|e\| | 부호 p10~p90 | SNR 10dB 중앙값\|e\| | p90\|e\| | 부호 p10~p90 |
|---|---|---|---|---|---|---|
| (c) 기본 토큰 | 900 | 1687 | −1687 ~ −169 | 1025 | 1830 | −1830 ~ −418 |
| (a) VAD + 선형 재배치 | 620 | 1483 | −1483 ~ +4 | 578 | 1185 | −1185 ~ −22 |
| (a2) VAD + stderr 표 | 505 | 911 | −911 ~ +30 | 410 | 702 | −702 ~ +39 |
| **(b) VAD 끔 + DTW** | 190 | 327 | +130 ~ +327 | 190 | 335 | +135 ~ +335 |
| **(d) VAD + DTW + stderr 표** | 185 | 325 | +125 ~ +325 | 195 | 345 | +136 ~ +345 |
| (d') VAD + DTW + 선형 재배치 | 147 | 763 | −763 ~ +90 | 171 | 920 | −920 ~ +55 |

(SNR 22dB는 깨끗과 거의 같다: a 650/1280, b 185/327, c 930/1721.)

- **DTW가 아닌 토큰 시각은 한국어에서 못 쓴다** — 세그먼트 안에서 토큰 길이 비례 추정이라 0.4~1.0초 이르다. VAD 선형 재배치(설계 원안)는
  여기에 세그먼트가 문장 사이 무음을 끼는 문제까지 더한다(실측: whisper 세그먼트 `38920–46380`이 2.8초 break를 끼었다).
- **DTW는 일정하게 늦다**(중앙값 +185~195ms). 이 지연을 빼면 잔차 p90 |e| 137~150ms, 최대 350~370ms. 100ms 넘게 **이른** 오차는 0건 —
  남는 오차는 전부 "늦음" 쪽이고, 큰 것은 무음 뒤 문장 첫 어절(최대 +370)이다.
- 지연 190ms를 뺀 뒤 `pad`별로 "시작이 pad보다 늦게 잡혀 앞이 잘리는 어절" 수: pad 100/150/200/250ms →
  깨끗(d) 18/9/7/4 (107개 중), SNR 10dB(d) 19/10/6/2 (104개 중).
- 인식 품질(글자 일치율): 깨끗 1.000(전 방식), SNR 10dB에서 VAD 켠 실행 0.974 · VAD 끈 실행 0.984~0.987.
- UTF-8: CPU 11회 전사의 모든 토큰이 **토큰 단위로** 유효 UTF-8(부분 바이트 토큰 0) — 잘못된 바이트는 CUDA beam(§2.2)에서만 봤다.
- 속도(92.5초, `-t 8`, 동시에 다른 측정이 돌던 부하 포함): (a) 44~50초, (d) 52~53초, (c) 61~62초, (b) 71~79초 — VAD가 무음 37%를 건너뛴다.

**판정**
- **P2 단어 시각 = (d)**: VAD는 그대로 켜고 `-nfa -dtw <프리셋>`을 더해, 어절 시작 = 첫 토큰 `t_dtw × 10 − 190ms`를 stderr VAD 대응표로
  원본 타임라인에 옮긴다. (b)와 정확도가 같으면서 VAD의 속도·무음 헛말 방어를 유지한다. 선형 재배치(`remap_tokens_into_segment`)는 기각.
- **`pad` = 200ms**(상수). 지연 보정 뒤 앞이 잘리는 어절 ≈ 6%, 잘려도 최대 ~170ms. 250ms는 잘림이 더 적지만 잘라 낸 이웃 단어가 더 남는다.
- 한계: 목소리 하나의 TTS뿐이다 — §4 체크리스트 1의 **실제 녹음 3종·손 표시 경계는 미실측**. 어절 **끝** 시각의 정답이 없어 끝 쪽 pad는
  재지 못했다. 지연 190ms는 이 음성·turbo 모델 기준값이다.

### B.2 ffmpeg — libass·필터 스크립트 플래그·긴 인라인 그래프

실험: `testsrc 320x240@30 + sine` 90초 mp4에서 0.3초 구간 N개(0.55초 간격)를 설계 §3.6-1 그래프(`trim/setpts` + `atrim/asetpts/afade×2`,
초는 소수 6자리) + `concat=n=N:v=1:a=1`로 이어 `libx264 ultrafast + aac`.

| 빌드 | `-filters`의 `subtitles`·`ass` | `-/filter_complex <file>` | `-filter_complex_script <file>` | 150구간 인라인 |
|---|---|---|---|---|
| gyan **9.0.1** essentials(관리형, sha `fec81ae0…` 일치), Windows | 있음 | 동작(45.000초) | **실패** `Unrecognized option 'filter_complex_script'` | 동작 |
| gyan 8.0 essentials(PATH), Windows | 있음 | 동작 | 동작 + `deprecated, use -/filter_complex` 경고 | 동작 |
| johnvansickle **7.0.2** amd64(관리형, sha `abda8d77…` 일치), WSL | 있음 | 동작(45.04초) | 동작 + 같은 경고 | 동작 |
| martin-riedl 9.0.1 macOS | 미실측 | 미실측 | 미실측(gyan 9.0.1과 같은 계열이라 없을 것) | 미실측 |
| 배포판 ffmpeg 6.x(Ubuntu 24.04 apt 후보 6.1.1) | 미실측 | 미실측 | 미실측 | 미실측 |

- 그래프 길이: 구간당 ≈192자, 100구간 19,014자, **150구간 28,764자 → 명령줄 전체 28,920~29,054자로 Windows 32,767자 안에서 성공**,
  출력 길이 = 150 × 0.3초 정확. 인라인 한도는 ≈165구간.
- **판정: 그래프가 24KB를 넘으면 캐시 파일 + `-/filter_complex <file>`**(관리형 세 빌드 모두 동작). `-filter_complex_script`는 쓰지 않는다
  (9.0.1에서 제거). `-/` 문법이 없는 ffmpeg 7 미만(PATH 발견본)은 버전을 보고 `TooManyRanges` 안내로 둔다(6.x는 미실측이라 보수적으로).
- libass는 관리형 두 빌드와 gyan 8.0 모두 포함 → 번인 기본 경로가 된다. 한글 폰트 렌더는 미실측(P3).
- 곁가지(기존 결함, 이 태스크 범위 밖): **`video.rs`의 gyan 9.0.1 URL이 404**(gyan.dev는 9.0.2로 넘어가며 옛 패키지를 내렸다, 2026-09-22).
  같은 파일이 `https://github.com/GyanD/codexffmpeg/releases/download/9.0.1/ffmpeg-9.0.1-essentials_build.zip`에 있고 sha256이
  코드 고정값과 같다. johnvansickle은 `releases/`가 살아 있고 `old-releases/`가 404.

### B.3 whisper-cli 출력 형식 (P1 파서 기준)

- `-pp` 진행률 — **stderr**, 30초 창마다 한 줄, 정수 %, 3칸 폭: `whisper_print_progress_callback: progress =  44%` … `progress = 100%`.
  92.5초 입력에서 VAD 켜면 3줄(44/92/100), 끄면 4줄(26/59/85/100) — 짧은 파일은 진행률이 거칠다.
- **stdout**에는 세그먼트 텍스트(`[00:00:00.000 --> 00:00:10.500]   And so, …`)가 계속 나온다 → 드레인 필수.
  `-np`는 진행률은 남기지만 **stderr의 VAD 대응표까지 없앤다**(jfk: 4줄 → 0줄) — B.1 (d)를 쓰려면 `-np`를 넣지 않는다(stderr ≈100줄).
- VAD 대응표(stderr, 초 단위 소수 2자리, VAD 타임라인은 조각 사이에 0.20초씩 벌어짐):
  ```
  whisper_vad: vad_segment_info: orig_start: 2.82, orig_end: 8.19, vad_start: 1.19, vad_end: 6.56
  ```
  VAD 시각 t가 `[vad_start, vad_end]` 안이면 `orig_start + (t − vad_start)`, 조각 사이 틈이면 다음 조각 `orig_start`로.
- `--version` → **stdout** `whisper.cpp version: 1.9.4`, 종료 코드 0(Windows·Linux 동일). **`--help` 출력에는 버전 문자열이 없다**(종료 코드 0).
- `-ojf` JSON(탭 들여쓰기, UTF-8): 최상위 `systeminfo, model{type,multilingual,vocab,audio,text,mels,ftype}, params{model,language,translate},
  result{language}, transcription[]`. 세그먼트 `{timestamps{from,to:"HH:MM:SS,mmm"}, offsets{from,to: 정수 ms}, text, tokens[]}`,
  토큰 `{text, timestamps, offsets{from,to: 정수 ms}, id, p, t_dtw}`. `t_dtw`는 **10ms 단위 정수**, DTW 꺼지면 `-1`.
  특수 토큰 `[_BEG_]`·`[_TT_*]`은 `text`로 구분. VAD를 켜면 세그먼트 `offsets`만 원본 시각이고 토큰 `offsets`·`t_dtw`는 VAD 타임라인이다.
  ```json
  {"text": " 먼저", "offsets": {"from": 6800, "to": 6800}, "id": 20749, "p": 0.999996, "t_dtw": -1}   // 세그먼트 offsets 9990–16190
  {"text": ".", "offsets": {"from": 1670, "to": 1680}, "id": 13, "p": 0.998664, "t_dtw": 242}          // -nfa -dtw
  ```

### B.4 아카이브 구조 (b5130, sha256 전부 §2.2 표와 일치 — VAD·turbo 모델 포함)

| 자산 | 최상위 | `inner_dir` | `exe_rel` | 비고 |
|---|---|---|---|---|
| whisper-bin-x64.zip | `Release/` (40개) | `Some("Release")` | `whisper-cli.exe` | `whisper.dll`·`ggml.dll`·`ggml-base.dll`·`ggml-cpu-{alderlake,cannonlake,cascadelake,haswell,icelake,sandybridge,skylakex,sse42,x64}.dll`(런타임 선택). `SDL2.dll`·`llama.dll`·`parakeet*` 등 무관 파일 동봉 |
| whisper-bin-win-cpu-arm64.zip | `Release/` (24개) | `Some("Release")` | `whisper-cli.exe` | `ggml-cpu.dll` 하나. import 목록은 미확인(mingw objdump가 ARM64 PE를 못 읽음) |
| whisper-bin-ubuntu-x64.tar.gz | `whisper-bin-ubuntu-x64/` | `Some("whisper-bin-ubuntu-x64")` | `whisper-cli` | `.so` **심볼릭 링크 체인**(`libwhisper.so → .so.1 → .so.1.9.4`, `libggml*.so.0 → .so.0.23.0`), RUNPATH `$ORIGIN`, 최대 `GLIBC_2.34`, ldd에 `libgomp.so.1`. WSL Ubuntu 24.04(glibc 2.39)에서 `--help`·`--version` 성공 |
| whisper-bin-ubuntu-arm64.tar.gz | `whisper-bin-ubuntu-arm64/` | `Some("whisper-bin-ubuntu-arm64")` | `whisper-cli` | 같은 심볼릭 링크 구조, `libggml-cpu.so` 하나 |

- Windows x64 import: `whisper-cli.exe`가 `MSVCP140`·`VCRUNTIME140`·`VCRUNTIME140_1`을 **직접**, `ggml-base.dll`·`ggml-cpu-*.dll`이 `VCOMP140`을
  가져온다 → VC++ 재배포 패키지가 없으면 로드 단계에서 실패할 것(클린 VM 실측은 여전히 미실측).
- Linux tar.gz는 심볼릭 링크를 풀어야 동작한다 — `extract_archive`(tar 크레이트 `unpack`)는 unix에서 링크를 만든다.

### B.5 미실측으로 남은 P0 항목

실제 녹음 3종(체크리스트 1), martin-riedl·배포판 ffmpeg 플래그, 한글 폰트 번인(2), 클린 Windows VM의 VCOMP140/MSVCP140(3),
Homebrew 설치 파일 이름·`--help` 플래그(4, mac 실기), 저사양·ARM RTF·2시간 최대 메모리·`[term-perf]`(5), base-q5 모델의 `-dtw base` 동작.

## 9. 구현 결과

### P0 리팩터 (2026-09-22)

- `llm/acquire.rs`: `Artifact`에 `progress_name`·`build`·`smoke: Option<fn(&Path) -> Result<(), IpcError>>` 추가(llama 5개 스펙은
  `RUNTIME_NAME`/`RUNTIME_CPU_NAME`·`LLAMA_BUILD`·`None`). `artifact_progress_name`(폴더 이름 `-cpu` 접미로 추론) 삭제 → 필드로.
  `ensure_runtime`은 `.ok` 쓰기 직전에 `smoke`를 부른다(있을 때만 `verify` 진행 이벤트). 모델 다운로드·삭제 본문을
  `download_model(app, state, spec, name, ch)`·`delete_model(app, spec)`로 추출 — 진행·취소 이름을 호출자가 준다(stt는 `stt-model-<id>`).
  §3.2 목록(`download_verified`·`check_free_space`·`extract_archive`·`register_cancel`/`DownloadGuard`·`http_client`·`send_progress`·
  `model_url`·`sweep_stale_downloads`)을 `pub(crate)`로. `installed_server`·`installed_model`·`ensure_runtime`은 원래 `pub`.
- `llm/server.rs`: Linux `systemd-run --user --scope --quiet --collect --` 래핑을 `systemd_scope_wrap(exe) -> (PathBuf, Vec<OsString>)`로 추출
  (`Command::new(program).args(prefix).args(own)` — std·tokio 공용), `spawn_server`가 사용. 회귀 테스트
  `systemd_scope_wrap_uses_scope_and_keeps_exe`(`--scope` 있음·`--service-type` 없음·`--` 뒤가 exe).

### 설계와 달라진 것 (P0 실측 근거 — 부록 B)

1. **P2 단어 시각 방식**: VAD + 세그먼트 선형 재배치(`remap_tokens_into_segment`) **기각** → **VAD 유지 + `-nfa -dtw <프리셋>` + stderr
   `vad_segment_info` 대응표로 조각별 이동, 시작 = `t_dtw × 10 − 190ms`**(B.1 (d)). 선형 재배치는 중앙값 0.6초·p90 1.2~1.5초 어긋났다.
   P1 전사부터 `-nfa -dtw`를 넣어 두면 P2에서 재전사가 필요 없다(실측 비용: (a) 대비 +5%(깨끗)·+18%(SNR 10dB), 부하 섞인 1회씩). 따라서 P1 whisper 인자에 `-np`를 넣지 않는다(B.3).
   `-dtw` 프리셋은 모델마다 다르다(turbo = `large.v3.turbo`, base = `base` — 후자 미실측) → `STT_MODELS`에 프리셋 필드가 필요하다.
2. **`pad` = 200ms**(상수). 지연 보정 상수 190ms도 함께(이 음성·turbo 기준, 실제 녹음으로 재확인 대상).
3. **필터 스크립트 플래그 = `-/filter_complex <file>`**. `-filter_complex_script`는 gyan 9.0.1에서 제거돼 쓰지 않는다. 24KB 초과 시 파일로
   넘기면 관리형 세 빌드에서 `TooManyRanges`는 필요 없다 — 남기는 곳은 `-/` 문법이 없는 ffmpeg 7 미만(PATH 발견본)뿐. 인라인 150구간도
   Windows에서 성공(29.0K자)했으므로 24KB 경계는 여유 있게 안전하다.
4. **설치 스모크 = `whisper-cli --version`**(stdout에 `1.9.4`, 종료 코드 0). §3.2의 "`--help` 출력에 `1.9.4`"는 성립하지 않는다 —
   `--help`에는 버전 문자열이 없다. 비관리 바이너리의 플래그 검사(§3.1)는 그대로 `--help`.
5. `inner_dir`/`exe_rel` 확정값은 B.4 표(Windows 두 zip = `Release`, Linux = 아카이브 이름 폴더).

### P1 백엔드 (2026-09-22)

- 새 모듈 `src-tauri/src/stt/`: `acquire`(엔진·모델 획득, 발견 체인, 스모크, 플래그 검사, `stt_status`·
  `stt_runtime_ensure`·`stt_model_download`·`stt_model_delete`) · `transcribe`(잡·인자 빌더·진행률, `stt_transcribe`·
  `stt_transcribe_cancel`) · `whisper_json`(`-ojf` + stderr VAD 대응표 파서) · `doc`(CaptionDoc v1·`split_cues`·
  `validate_doc`) · `guard` · `plan`(`caption_plan`) · `store`(`caption_doc_load`·`caption_doc_save`) · `subs`
  (`build_srt/vtt/txt`·`caption_export_subs`). 9개 커맨드 lib.rs 등록, HOT 목록에 §3.4의 5개 추가.
- `video.rs`: `VideoMeta.start_time_ms`(TS `startTimeMs`), `RangeMs`에 `Serialize`, 재사용 헬퍼 가시성만
  `pub(crate)`(`JobGuard`·`kill_pid`·`need_probe`·`parse_out_time_us`·`last_error_line`). 로직 변경 없음.
- 설정 `stt_model`("turbo-q5")·`stt_language`("auto") + TS·`SETTINGS_INDEX`·`buildCleaned`. e2e 47 ⑤ `llm*` 키 11개로.
- sha256: 2026-09-22 GitHub 릴리스 API digest(4개 자산)·HF tree API `lfs.oid`(모델 2 + VAD)를 다시 받아 §2.2와 대조 — 전부 일치.
- 실측: `#[ignore]` 테스트 `stt_real_whisper_transcribes_jfk`가 b5130 whisper-cli(Windows x64)·ggml-tiny·Silero로 jfk.wav를
  실제 전사 — 진행률 줄·VAD 대응표 수신, `wordTiming: dtw`, 감지 언어 en, "country" 포함, cue 시각 단조·길이 이내, 시작 전 취소 → Cancelled.

### 설계와 달라진 것 (P1 백엔드)

6. **whisper-cli는 cwd = 앱 로컬 데이터 폴더, 인자는 ASCII 상대 경로로만.** b5130 Windows 빌드는 ANSI `main(argc, argv)`라
   비ASCII 경로가 시스템 코드 페이지로 깨진다 — 실측: 한글 폴더의 모델을 `'�ѱ۰��/m.bin'`으로 읽고 exit 127. 비ASCII
   **실행 파일** 폴더는 괜찮았다(DLL 백엔드 로드 정상). 사용자 이름이 한글이면 앱 데이터 경로 전체가 비ASCII라, 임시 WAV·JSON도
   §3.1의 캐시 폴더가 아니라 모델과 같은 `app_local_data_dir/stt/`에 둔다(Windows에서 캐시 = 로컬 데이터라 위치 차이는 mac·Linux뿐).
7. **Windows 용어 힌트는 ASCII만**(같은 원인 — 한글 `--prompt`는 CP949 바이트로 넘어가 엉뚱한 토큰이 된다. §2.2의 "용어를 고정하지
   못함" 실측도 이것일 수 있다). 비ASCII면 저장 전 오류로 알린다. mac·Linux는 제한 없음.
8. **`engine.wordTiming: "dtw" | "approx"` 추가**(P0 열린 문제의 결정). stderr VAD 대응표가 없으면(비관리 바이너리가 다르게 찍음)
   세그먼트 안 선형 재배치(B.1 d′)로 두고, 한 어절이라도 DTW 값이 없어도 `approx`. P2는 `approx` 문서의 컷 편집을 막는다.
9. **어절 끝 시각** = 같은 세그먼트의 다음 어절 시작, 마지막 어절은 세그먼트 끝. 둘 다 그 어절이 든 VAD 조각의 `orig_end`를
   넘지 않는다 — whisper 세그먼트가 문장 사이 무음을 끼는 경우(B.1) 쉼이 앞 어절에 붙지 않게. 끝 시각 정답은 여전히 미실측(B.5).
10. **줄 폭**: 한국어·일본어·중국어·언어 미상 16자, 그 밖(띄어 쓰는 언어) 42자(Netflix 영어 기준). §3.3의 16자를 영어에 걸면 cue가
    다섯 단어 남짓으로 잘게 쪼개진다(jfk 실측). 규칙은 감지 언어(`detectedLanguage`) 우선. 자동 텍스트 cue는 이 폭으로 `\n` 줄바꿈해 둔다.
11. **무음 줄이기 해석**: 목표보다 긴 gap은 **가운데를 덜어** 양 끝에 `silenceKeepMs/2`씩 남긴다. §3.3 문구대로 "가운데 k만 남기면"
    이웃 어절의 패딩(200ms×2)이 양 끝을 다시 살려 실제 쉼이 k+400ms가 된다 — "목표 길이로 단축" 요구와 어긋난다.
    제거 구간은 컷 구간과 같이 패딩을 잘라 낸다. "1프레임" = 42ms 상수(문서에 fps가 없어 24fps 한 프레임으로).
12. **gap의 cue 소속**: 사이 gap은 뒤 cue(쉼 → 말), 꼬리 gap은 마지막 cue. 말이 하나도 없는 파일은 무음 gap 하나를 덮는 cue 하나.
    반복(`repeat`) 판정은 cue가 아니라 whisper **세그먼트** 텍스트로 한다 — 환각 루프는 세그먼트를 되풀이하고, 한 세그먼트가 여러
    cue로 쪼개지면 cue 단위로는 "연속 같은 텍스트"가 안 된다.
13. **저장**: 원자 쓰기는 기존 `state::save_bytes_at`(`<key>.json.tmp` + 전역 SAVE_LOCK) 재사용(§3.3의 `.tmp-<uuid>` 대신),
    `.bak`은 `<key>.json.bak`. 중첩 저장소 id(`<outer>::<rel>`)는 폴더 이름으로 못 쓰므로 `h-<hex16>`로 해시. 읽을 때도
    `validate_doc`을 돌려 손상 문서를 드러내고, 더 높은 version은 모양이 맞으면 검증 없이 돌려준다(읽기 전용 판정은 프론트가
    `version > 1`로 — `CaptionLoaded`에 필드를 늘리지 않았다). 손상된 직전 판은 재전사 때 `.bak`으로 보존하고 덮는다.
14. **IPC 모양 보강**: `SttStatus.runtimeSize`(버튼 크기 표시, LlmStatus 관례)·모델 `note`, `stt://finished`에 `cancelled`
    (취소에 실패 토스트를 안 띄우게, ExportFinished 관례). TS 타입 이름은 저장소 고유 이름 규칙으로 `CaptionToken`·`CaptionCue`·
    `CaptionOutCue`(§3.3의 `Token`·`Cue`).
15. **발견·검사**: 이름 후보에 `whisper-cpp`(옛 brew formula)를 더했고, 비관리 바이너리 플래그 검사는 §3.1의 셋이 아니라 **넘기는
    플래그 전부**(`-nfa`·`-dtw`·`-sns`·`-bs`·`-bo`·`--prompt` 등)를 본다 — 하나라도 없으면 whisper-cli가 인자 오류로 죽는다.
    검사 통과만 프로세스 수명 캐시(실패는 캐시하지 않아 brew 업그레이드 뒤 재시작 불필요).
16. **전사 단일 실행**은 AppState 필드가 아니라 모듈 static(`transcribe.rs` ACTIVE) — 모델 삭제 Busy 판정도 여기서.
    고아 임시 파일 청소는 **하루 지난 것만**(e2e 샤드가 앱 로컬 데이터 폴더를 공유한다).
17. 원본 시각 SRT는 **컷된 어절도 넣는다**(원본에는 그 소리가 있다) — 편집본(`edited`)만 뺀다.

### P1 프론트엔드 (2026-09-22)

- 새 파일: `src/lib/captionEdit.ts`(순수 함수 — cue 구간·탐색·선택·나누기·합치기·단어/자막 줄 수정·찾아 바꾸기,
  Rust `line_chars`·`wrap_words`·`cue_text`·`source_cues`의 거울), `src/lib/stt.ts`(`useSttStatus`·`sttReadyReason`·언어 목록·
  `rememberSttChoice`), `src/stores/captionDoc.ts`(창마다 스토어, 키 `projectId\nrelPath` — 문서·rev·plan·자동 저장·충돌·
  되돌리기·전사 잡), `src/components/video/captions/TranscriptPanel.tsx`(memo)·`CaptionOverlay.tsx`(memo),
  `src/components/settings/sections/SttSection.tsx`.
- VideoPlayer: 상단 바 `대본` 토글·`CC` 토글, 가운데 칼럼과 인스펙터 사이 대본 칼럼(`usePanelWidth` 400px, 360~720 드래그,
  `key={path}`), 스테이지 안 `CaptionOverlay`, 시각 변환 한 쌍 `docToPlayer`/`playerToDoc`(startSecRef), `togglePlay`를
  useCallback으로(로직 동일), ExportPanel에 `sttBusy`(내보내기·분할 잠금 + 사유 문구). 타임라인은 건드리지 않았다(S1 트랙은 P2).
- events.ts `markLocalSttJob` + `stt://finished` 토스트는 시작한 창만. frameCapture.ts `GEN_SUFFIX`에 `cut|sub`,
  `subsOutRel(path, format, timeline)`. 설정: AI 카테고리 끝에 "음성 인식 (자막)" 소제목(엔진 행·모델 표·기본 언어),
  진행 상태는 SettingsDialog 소유, 취소는 `llmDownloadCancel("stt-runtime" | "stt-model-<id>")`, 삭제는 askConfirm.
  `SETTINGS_INDEX`에 즉시 액션 `sttRuntimeDownload` 한 줄.
- `__gpv.caption`(순수 함수)·`__gpv.captionDoc`(스토어) 노출(dev 전용, 33 `planSegments` 선례). e2e용 `data-gpv`:
  `transcript-toggle`·`cc-toggle`·`transcript-panel`·`caption-overlay(-text)`·`caption-line`·`stt-start`·`stt-progress`·
  `transcript-find`·`subs-export(-toggle)`, 행 `data-cue`, 토큰 `data-tid`.

### 설계와 달라진 것 (P1 프론트엔드)

18. `sttReadyReason(tool, stt, modelId)` — 셋째 인자는 설정이 아니라 **패널 드롭다운의 모델 id**(`llmReadyReason`의 modelId와
    같은 이유: 기본값과 다른 모델을 고르면 설정 기준 판정이 틀린다). 결과는 `{text, fix: "ffmpeg"|"ai"|"brew"|null}`.
    "설정 열기" 버튼은 메인 창에만(DocWindow에는 설정 다이얼로그가 없어 누르면 무반응이 된다) — 보조 창은 문구로 안내.
19. **자막 줄 수정은 `<textarea>`**(§3.5의 `<input>` 대신) — `<input>`은 값의 줄바꿈을 지워 여러 줄 override를 다시 고칠 때
    글이 붙어 버린다. Enter 확정·Shift+Enter 줄바꿈·Esc 취소·포커스 잃으면 확정.
20. **override가 있는 cue 나누기**는 override를 어절 수 비율로 갈라 양쪽에 준다(한쪽에 통째로 두면 두 구간에 같은 글이
    겹치고, 지우면 고친 글이 사라진다). **합치기**는 둘 중 하나라도 override가 있으면 두 자막 줄을 이은 override. 프로그램이
    만드는 override는 줄 폭(16/42자)으로 다시 줄바꿈한다(SRT에 한 줄로 길게 나가지 않게). 사용자가 친 override는 그대로 둔다.
21. **찾아 바꾸기 규칙**: override가 있는 cue는 그 글에서, 없으면 인식 단어를 공백으로 이은 글에서 찾는다(대소문자 무시).
    한 단어 안 일치 → 단어 텍스트를 고침(인식 교정), 단어 경계를 넘는 구절 → **토큰은 합치지 않고** 자막 줄 override로 고침.
    단어를 비게 만드는 바꾸기는 건너뛰고 몇 곳을 건너뛰었는지 알린다(저장 검증이 빈 단어를 거절한다).
22. **키**: 패널은 표의 키를 처리한 뒤 전파를 끊고, 그 밖의 **글자 키**(i·o·t·r·s·숫자…)도 끊는다 — 플레이어 단축키가 대본을
    보다 구간·분할을 찍지 않게. 이동 키(←/→ , . m f - = +)와 비글자 키(F5·Tab 등), 처리하지 않는 수정자 조합(Ctrl+Shift+F·
    Ctrl+W)은 흘려보낸다. Esc는 찾기 닫기 → 선택 해제 → (없으면) 플레이어로. Ctrl+Z/Y는 되돌릴 것이 없어도 끊는다.
    **macOS 찾아 바꾸기 = ⌥⌘F**(⌘H는 OS의 앱 숨기기라 가로챌 수 없다). Backspace 합치기는 caret이 cue 첫 단어(또는 그 앞
    쉼)일 때만 — 그 밖은 P2 컷 자리라 아무 것도 하지 않는다. caret = 선택 구간의 앞 토큰.
23. **모델·언어 기억** 시점은 드롭다운을 바꿀 때가 아니라 **[자막 만들기]를 누를 때**, 직전 설정을 다시 읽어 바뀐 경우만 쓴다
    (TitleBar 즐겨찾기 패턴 — 저장 토스트 없이). 드롭다운은 고르기 전까지 설정값을 따른다.
24. 설정 소제목은 `AiSection.tsx`를 늘리지 않고 **별도 파일 `SttSection.tsx`**(AiSection 아래에 렌더) — 따로 바뀌는 단위.
    권장 뱃지는 `recommend(size, ram, vram=0)`(P1은 CPU만이라 "GPU 전체"가 뜨면 거짓말) → "CPU/부분"·"권장 안 함".
    macOS에서 엔진이 없으면 엔진 버튼은 비활성 + brew 안내, brew 엔진이 발견되고 VAD만 없으면 "VAD 모델 받기".
25. **스토어 순서 보장**: 재전사 시작 전에 대기 중인 자동 저장을 먼저 끝낸다(버리지 않는다 — 전사가 실패·취소되면 편집이
    남아야 하고, 늦게 도착한 옛 base_rev 저장은 CONFLICT가 된다). 전사 중에는 대본 편집·되돌리기를 막는다. 자막 파일
    내보내기는 Rust가 **저장본**을 읽으므로 먼저 `flush`한다(충돌·저장 실패면 내보내지 않고 알린다).
    `caption://changed`는 자기 저장의 메아리(`rev == baseRev`, 저장 중 `baseRev+1`)와 자기 전사 결과(잡 진행 중)를 거른다.
26. 자막 파일 내보내기 UI는 P1 범위대로 **원본 시각만**(편집본 시각·`name.cut.srt`는 P2 — 이름 함수는 timeline 인자를 이미 받는다).
27. 오버레이·패널 시각은 TS의 `captionSourceCues`(Rust `source_cues` 거울)로 **원본 시각** cue를 쓴다 — 원본 영상 위 미리보기라
    `plan.outCues`(편집본 시각)가 아니다. 계획(`caption_plan`) 구현은 여전히 Rust 하나이고 P2 음영·편집 반영 재생이 plan을 쓴다.
    `startTime`은 probe 값, probe가 없으면(ffprobe 없음) 문서의 `source.startTimeMs`.
28. 현재 단어 강조는 배경이 아니라 **글자색+밑줄**(classList) — 선택(bg-selection)·찾은 곳(bg-warn) 배경과 겹쳐도 보이게.
29. 미실측·미구현: 1시간(≈1,000 cue) 초기 렌더 시간은 재지 않았다(`content-visibility`는 재 보고 필요하면), 재생 중 현재 cue로
    자동 스크롤하지 않는다(요구 목록에 없음). 앱 실행 확인은 다음 단계(e2e).

### P2 백엔드 (2026-09-22)

- `video.rs`: `ExportSpec.caption_cut`(TS `VideoExportSpec.captionCut?`) — `video_export_inner`가 저장본으로 남길 구간을 계산해
  `build_export_args(src, tmp, spec, cut)`에 넘긴다. `build_cut_graph`(구간마다 `[0:v]trim…,setpts=PTS-STARTPTS[v_i]` ·
  `[0:a]atrim…,asetpts=PTS-STARTPTS,afade 10ms 인·아웃[a_i]` → `concat=n=N:v=1:a=1[vc][ac]`, 오디오 없음·소리 빼기면 `a=0`),
  초 값은 `fmt_secs6`(정수 연산, 소수 6자리 숫자만), `-ss` 없음. `build_mask_graph(spec, input)` — 입력 라벨이 인자(`[0:v]`/`[vc]`).
  체인 concat → mask → crop → scale → setpts. `validate_spec`: encode만·`range`와 배타·mp4/m4v/mov만. `expected_out_us(spec, cut)`
  = Σkeep ÷ speed. 그래프가 24KB를 넘으면 `-/filter_complex <파일>`(`long_graph_at`·`externalize_graph`·`graph_to_file`), ffmpeg < 7이면
  `TooManyRanges`.
- `stt/store.rs`: `cut_keep_at`(순수)·`load_cut_keep` — 저장본 → 문서 없음·`approx`·stale·전부 잘림 거절 → `plan.keep`.
- `error.rs`: `ErrorCode::TooManyRanges`(TS `TOO_MANY_RANGES`).
- 편집본 SRT/VTT(`SubTimeline::Edited`)는 P1에서 이미 끝나 있었다(`caption_export_subs`가 `caption_plan().out_cues`, 테스트
  `subs_source_includes_cut_words_edited_does_not`) — 변경 없음.
- 필름스트립·파형 캐시 빈틈(§2.1): `queries/index.ts invalidateVideoMedia` — 내보내기 종결(`events.ts invalidateVideoOutputs`)은
  `outRel`, 분할 배치(`videoSplit.ts`)는 분할 폴더 접두로 좁혀 무효화.
- 실측: `#[ignore]` `caption_cut_real_ffmpeg_output_matches_keep`(PATH gyan 8.0, testsrc 320x240@30 + sine 40초) — 3구간 Σ2,800ms →
  출력 2.800s(영상·오디오 스트림 모두 2.800000), 200구간(그래프 ≈38K자 → 파일) Σ20,000ms → 20.000s. 9.0.1·7.0.2의
  `-/filter_complex`는 부록 B.2 실측에 기댄다(이번에 다시 재지 않았다).

### 설계와 달라진 것 (P2 백엔드)

30. **편집본은 mp4·m4v·mov만**(gif·m4a·mp3는 `validate_spec`이 거절) — 설계는 `name.cut.mp4`만 말했다. gif·오디오 전용은 concat
    구성(`v=0`·팔레트 그래프)이 달라 검증 없이 열지 않는다.
31. **배속 + 컷의 오디오는 그래프 안에서** `[ac]atempo…[a]` — 그래프 출력 스트림에는 `-af`를 함께 걸 수 없다(ffmpeg가 simple·complex
    필터링 동시 사용을 거절). 컷이 아닌 경로는 예전대로 `-af`.
32. **긴 그래프 파일 위치 = 앱 로컬 데이터 `stt/gpv-stt-graph-<uuid>.txt`**(§3.6-3의 "캐시 폴더" 대신) — 전사 임시 파일의 Drop 가드
    (`TempFiles`)와 하루 지난 고아 청소를 그대로 탄다. Windows에서는 캐시 = 로컬 데이터라 위치 차이는 mac·Linux뿐. 파일 이름은
    `job_id`가 아니라 새 uuid(검증 안 된 id를 경로에 넣지 않는다).
33. **ffmpeg 버전 판정은 그래프가 24KB를 넘을 때만** `ffmpeg -version` 첫 줄(`parse_version`, Arch식 `n7.1`도)로 한다. 주 버전 < 7이면
    `TooManyRanges`, **못 읽는 버전(git 빌드 `N-…`, `-version` 실패)은 시도**한다 — 틀리면 ffmpeg 자신의 "Unrecognized option"이 나온다.
34. 종결 이벤트(`video://export-finished`)에는 메시지만 가므로 `TOO_MANY_RANGES` 안내("무음 줄이기 목표를 늘려 구간을 줄이거나
    ffmpeg 7 이상")는 메시지 안에 있다. 코드는 invoke 응답으로 분기할 때 쓴다.
35. **stale은 내보낼 때 다시 판정**한다(원본의 크기·수정 시각 — 원본을 못 읽어도 stale). 더 높은 `version` 문서는 따로 거절하지 않는다
    (읽기 전용 판정은 프론트, 계획은 `cue_spans` 구조 검사를 통과해야 나온다).
36. TS `captionCut`은 **선택 필드**, Rust `#[serde(default)]` — 기존 스펙 작성처 3곳(ExportPanel·VideoPlayer·videoSplit)은 켤 일이 없어
    건드리지 않았다.
37. 캐시 무효화는 **쓴 경로로 좁힌다** — `["video-probe"]`처럼 넓게 지우면 열린 영상의 필름스트립(파일 전체 디코드)을 내보낼 때마다
    다시 뽑는다. 외부 도구가 덮어쓴 경우(워처 `repo://changed`)는 여전히 무효화하지 않는다 — 워처는 저장마다 오므로 같은 비용 문제가 있다.

### P2 프론트엔드 (2026-09-22)

- `src/lib/captionEdit.ts` P2 순수 함수: `captionCutAllowed`·`toggleCaptionCut`(선택 영역 컷 토글)·`cutCaptionTokens`(일괄 컷)·
  `captionMatchCutIds`(찾은 곳 → 자를 토큰)·`captionFillerIds`·`parseCaptionFillers`·`captionGapKeptMs`(쉼 칩)·
  `captionSilenceCandidates`(무음 줄이기 검토 목록)·`setCaptionSilence`(적용/복구)·`captionPlaySkipTo`(편집 반영 재생 위치)·
  `captionRemovedRanges`(plan.keep 여집합). `captionSourceCues(doc, includeCut)`에 인자 추가. 전부 `__gpv.caption`에 노출.
- 대본 패널: Delete/Backspace 컷 토글, 잘린 단어 취소선·흐림, 쉼 칩 `··· 1.4s`/`1.4→0.6s`, 헤더 ⏱ 무음 줄이기 팝업·잘린 부분 숨기기,
  찾기 막대 "찾은 곳 모두 컷"(✂)·"추임새" 줄, 근사 문서 배너, 자막 파일 내보내기 "원본 시각/편집본 시각"(`name.cut.srt`).
- VideoPlayer: 상단 바 "편집 반영" 토글(컷이 있을 때만 보이고 기본 켜짐), 재생 rAF가 `plan.keep`으로 잘린 구간을 건너뜀,
  타임라인 A1과 마커 사이 S1 행(블록 층은 새 파일 `captions/CaptionTrack.tsx`의 memo `CaptionTrackBlocks`), `snapTo` 후보에 cue 경계.
- ExportPanel: "대본 편집" 섹션 — "대본 편집 반영"(`captionCut`), 기본 파일명 `name.cut.mp4`.
- Rust: `CaptionDoc.silence_min_ms`(TS `silenceMinMs`) + `caption_plan` 조건 — 아래 38.
- 확인: `cargo test --lib`·`npx tsc --noEmit`·`npm run build`. 앱 실행·e2e(`caption-edit-export`)는 다음 단계.

### 설계와 달라진 것 (P2 프론트엔드)

38. **`silenceMinMs` 추가**(Rust `silence_min_ms: Option<u64>`, serde 기본값·생략) — §3.3의 전역 목표 하나(`silenceKeepMs`)로는 §4의
    "X초 초과 → Y초로"를 적을 수 없다(0.6~1.0초 쉼까지 같이 줄어든다). `caption_plan` 조건 = `길이 > max(목표, 조건)`, 조건이 없으면
    예전과 같다(목표가 곧 조건). 복구 = 두 필드 삭제. 테스트 `plan_shortens_only_gaps_over_threshold`.
39. **Backspace**: 한 단어(caret)만 고른 채 cue 첫 단어(또는 그 앞 쉼)에서 → 위와 합치기(P1 유지), 그 밖(여러 토큰 선택 포함) → 컷
    토글. Delete는 늘 컷 토글. 9절 22의 "선택의 앞 토큰이 cue 머리면 합치기"를 한 단어 선택일 때로 좁혔다 — 여러 단어를 골라 지우는데
    합쳐지면 안 된다.
40. **찾은 곳 모두 컷**은 단어 **전체**(앞뒤 문장부호 무시)와 맞은 곳과 단어 경계에서 시작·끝나는 구절만 자른다(구절은 사이 쉼까지).
    부분 일치("어" → "어떻게")·자막 줄 override 안의 일치는 건너뛰고 몇 곳인지 토스트로 알린다.
41. **추임새 목록**: 기본 `음, 어, 아, 그, 저기, 흠, um, uh`, localStorage `gp:caption-fillers`(설정 키가 아니다 — 개인 취향), 항목 하나 = 단어
    하나(쉼표·공백 구분), 비교는 단어 전체·앞뒤 문장부호·대소문자 무시. 추임새 컷은 검토 목록 없이 개수만 보이고 되돌리기 한 단계다.
42. **근사(`approx`) 문서**: 자르기·무음 줄이기·일괄 컷·편집본 내보내기를 막고 이유 배너를 띄운다. 문구는 "다시 인식하라"고 하지 않는다 —
    brew 엔진은 다시 돌려도 근사값일 수 있다. 되살리기·무음 복구는 된다. 순수 함수(`toggleCaptionCut`·`cutCaptionTokens`·
    `setCaptionSilence`)도 근사 문서엔 null을 돌려줘 UI를 우회해도 컷이 생기지 않는다.
43. **편집 반영 재생**: 마지막 남는 구간 뒤면 영상 끝으로 보내 `ended`로 멈춘다(그 자리에서 pause하면 ▶가 곧바로 다시 멈춘다).
    구간 시작 1ms 앞까지는 안으로 본다(부동소수 오차로 같은 자리를 매 프레임 다시 seek해 재생이 멈추는 것 방지). 켜져 있으면 오버레이도
    잘린 어절을 뺀 글을 보인다. 토글은 파일 전환 때 켜짐으로 돌아간다. keep은 저장 응답의 plan이라 편집 후 자동 저장(500ms)만큼 늦다.
44. **S1 트랙**: memo 블록 층은 `vs/ve/barW/cues/cuts`를 받는다 — 설계의 `plan` 대신 VideoPlayer가 `docToPlayer`로 플레이어 초로 바꾼
    cue와 빠지는 구간(plan.keep 여집합)을 넘긴다(시각 변환은 VideoPlayer 한 곳). 잘린 cue도 원본 시각 블록으로 그리고 빗금이 덮는다.
    블록 클릭 탐색은 없다(요구 목록에 없음).
45. **ExportPanel "대본 편집" 섹션은 자막 문서가 있는 영상에만** 보인다. 막히는 이유(근사·stale·전부 잘림·mp4 아님)를 백엔드 거절과 같은
    내용으로 미리 보이고, 켜 둔 뒤 막히면 끌 수만 있다. 켜면 구간(I/O)은 무시(경고)·무손실 복사 → 재인코딩 안내·분할 경고 목록에 포함·
    출력 길이 = `plan.outDurationMs ÷ 배속`. 내보내기 전에 대본 저장을 `flush`하고 실패하면 내보내지 않는다. `TOO_MANY_RANGES`·거절
    메시지는 기존 종결 토스트(events.ts)가 보인다 — 별도 UI를 만들지 않았다.
46. **무음 줄이기 UI** = 대본 헤더 ⏱ 팝업. 입력은 초(소수 1자리), 저장은 정수 ms, 검증 = 0 이상·조건 ≥ 목표. 검토 목록 항목을 누르면
    그 쉼으로 이동한다. "잘린 부분 숨기기"는 패널 상태(기억하지 않음)이고, 전부 잘린 cue 행은 통째로 숨긴다.

### e2e (2026-09-22)

- **64 `caption-edit-export`**(엔진 없이 결정적): testsrc+sine 10초 영상에 손으로 만든 문서(wordTiming `dtw`, 금지 문자 섞은 단어
  하나)를 `caption_doc_save`로 주입 → 영상 doc 창의 대본 패널을 실제 DOM 이벤트로 구동. 저장 때 금지 문자 제거·stale 아님·낡은
  base_rev CONFLICT · 오버레이(seek 3.6s/0.7s/쉼) · 패널 `i` → In 안 찍힘(대조: 플레이어 컨테이너 `i`는 찍힘) · Enter 나누기 →
  Backspace 합치기 · 더블클릭 단어 교정 · Ctrl+H 바꾸기 → 불변식·저장본 = 화면 · Delete 컷 토글 → plan.keep을 손으로 푼 값과
  대조 · 무음 줄이기 검토 문구·적용 → keep 6구간 · 편집 반영 재생(잘린 3.0~3.4s 안 표본 0) · 편집본 SRT **원문 대조**(out(t)·잘린
  단어 없음·금지 문자 없음) · S1 빗금 5개 · 편집본 mp4 컨테이너·영상·오디오 모두 5.200s(Σkeep) · 완료 토스트 doc 창에만 · 무음 복구 ·
  approx(다른 창 저장 → 다시 읽어 배너·Delete 안 됨·ExportPanel 이유·백엔드 거절). 단독 29/29.
- **65 `stt-captions`**(`E2E_NET=1` + `E2E_STT_MODEL`): 관리형 엔진·VAD 실제 다운로드(158 진행 이벤트, 다운로드마다 단조) ·
  멱등 · jfk(11초)+testsrc → 스토어 `transcribe`(e2e-tiny) 1.8~3.2초 → "country"·cue 단조·길이 이내·dtw·감지 en·진행(추출→인식,
  단조, 끝 95%)·다시 읽기 동일·완료 토스트·임시 WAV/JSON 삭제 · 전사 중 두 번째 전사 BUSY · jfk×30(5분 30초) 인식 중 취소 →
  whisper-cli 실행 관측 후 취소 · 취소 토스트 · 문서 안 씀 · whisper-cli·ffmpeg 잔존 0 · 임시 파일 삭제. 단독 20/20(신규 설치 회차 21/21).
- 회귀(한 앱에서 29·33·34·47·48·64·65, `E2E_NET=1`·`E2E_LLM_GGUF`) 196 pass / 0 fail / 1 skip(48 ⑨ — LLM 답이 요약 형식이 아닐 때의
  기존 skip). 스위트가 지나간 뒤 dev identifier의 앱 로컬 데이터에 관리형 whisper 런타임·Silero VAD가 남는다(47 llama 런타임과 같은 선례),
  주입한 ggml-tiny는 지운다.
- **실기**(이 머신, 앱 경로 그대로): turbo-q5 + 한국어 TTS 227.6초(ko.txt 6회 반복) → **138.2초(RTF 0.61)**, 66 cue·405 토큰,
  wordTiming `dtw`. 처음 26초 cue가 원고와 글자까지 같다("안녕하세요." / "오늘은 영상 편집 프로그램에서 / 자동 자막을 만드는 방법을" …
  "어 같은 추임새도 한 번에 / 지울 수 있습니다."). 첫 반복 글자 위치 비교 155/169 — 위치 단순 비교라 뒤쪽 한 곳의 삽입·삭제가 남은
  글자를 모두 어긋나게 한다(어느 단어인지는 미확인). 16자×2줄 규칙 때문에 "알아보겠습니다."(0.8초)처럼 짧은 cue가 생긴다.

### 설계와 달라진 것 (e2e)

47. **e2e 모델 주입 = 디버그 빌드 전용 모델 id `e2e-tiny`**(`stt/acquire.rs` `E2E_MODEL` — 파일 `llm/models/ggml-tiny.bin`, `-dtw tiny`).
    §5의 `E2E_STT_MODEL`은 **스위트 쪽** 환경변수(원본 경로)이고, 스위트가 sha256을 확인해 엔진 옆 `llm/models/`에 복사했다가 끝나면
    지운다. 앱에 경로를 환경변수로 넘기지 않은 이유: whisper-cli에는 앱 데이터 아래 ASCII 상대 경로만 넘긴다(9절 6). `stt_status` 목록에
    없어 화면에 안 보이고 릴리스 빌드에서는 모르는 id다. 전사는 드롭다운에 없는 모델이라 UI 폼이 아니라 스토어 `transcribe`로 부른다.
48. §5가 `stt-captions`에 둔 "오버레이 seek → cue"·"패널 `i` → In 안 찍힘"은 엔진이 필요 없어 **64로 옮겼다**(결정적·네트워크 없음).
    `i` 단언에는 대조군(같은 키를 플레이어 컨테이너에 치면 찍힘)을 같이 둔다 — 대조군이 없으면 In 표시가 통째로 고장 나도 통과한다.
49. jfk.wav는 레포에 넣지 않고 b5130 태그의 raw URL에서 받아 sha256을 고정한다(`E2E_STT_WAV`로 로컬 파일 대체 가능).
50. 64에서 **뺀 것**: 번인·소프트 자막 스트림(P3 미구현), 원본 시각 SRT·VTT·TXT(P1 Rust 단위 테스트), 추임새·찾은 곳 모두 컷 버튼,
    되돌리기 UI, 두 창 동시 편집의 충돌 배너(IPC CONFLICT만 본다).
51. 64의 편집 반영 재생은 창이 가려져 재생·rAF가 멈추면(표본 < 10) **skip**으로 남긴다 — 통과로 세지 않는다.

### 리뷰 후 수정 (2026-09-22)

리뷰·반증을 통과한 결함 12건(중복 제외)을 근본 원인 한 곳에서 고쳤다. 조용히 실패하던 것(52·53·54·55·56)은 수정을 되돌려
단언이 빨개지는 것까지 봤다.

52. **추출 WAV의 0초 = `format.start_time`**. §3.3의 "whisper 결과·ffmpeg `trim`이 같은 기준이라 변환이 없다"는 오디오가 영상보다
    늦게 시작하는 파일에서 틀렸다. 추출 WAV가 첫 오디오 표본부터 시작해서(실측: 오디오 0.976초 늦은 mp4 → WAV 4.04초), 모든 단어
    시각이 그 차이만큼 일렀다. 오버레이·컷 구간·편집본 SRT·mp4가 전부 어긋났다(방송 TS·OBS 녹화 유형).
    수정: `build_stt_audio_args`에 `-copyts` + `-af aresample=16000,aresample=async=1:first_pts=<start_ms×16>`.
    - 리뷰가 제안한 `aresample=async=1:first_pts=0`만으로는 **TS가 안 고쳐진다**. ffmpeg는 불연속 형식(TS)에서 시각을 켠
      스트림(여기선 오디오뿐)의 시작으로 옮긴다(8.0 실측: 영상 2.8초·오디오 4.189초 TS의 첫 오디오 pts가 0).
      `-copyts -start_at_zero`도 같은 보정을 탄다. 그래서 절대 시각을 받아 start_time부터 채운다.
    - 한 aresample에서 표본률을 바꾸며 채우면 `first_pts`가 입력 표본률 단위로 읽힌다(2.8초 → 44.1kHz 기준 1.016초). 그래서
      16kHz 변환과 채우기를 둘로 나눴다.
    - 덤: 스트림 중간의 0.1초 넘는 틈도 무음으로 채워져 뒤 시각이 밀리지 않는다.
    - `-progress`의 out_time은 `-copyts`에서도 첫 pts 기준이라 추출 진행률은 그대로 동작한다(600초 TS로 실측).
    - 검증: `#[ignore]` `stt_audio_extract_real_ffmpeg_keeps_container_clock`. mp4·TS 둘 다 WAV 앞 무음 = 오디오 지연(±60ms)
      (0.976 → 0.999초, 0.989 → 1.000초).
    - 변이: 옛 인자면 mp4가 실패(무음 0초), 리뷰 제안안이면 TS가 실패(무음 0초).
53. **잘린 어절은 앱이 만드는 override에 싣지 않는다.** 합치기(`mergeCaptionCues`)·구절 바꾸기·자막 줄 입력의 초기값이 잘린
    어절을 넣고 있었다. override는 컷보다 앞서므로(Rust `cue_text`) 영상에서 지운 말이 편집본 SRT·mp4 자막·편집 반영 오버레이에
    되살아났다.
    - 인식 텍스트는 `captionRecognizedText(…, includeCut=false)`로 만든다.
    - 구절 바꾸기는 바꾸기가 닿지 않은 잘린 어절을 뺀다. 닿은 어절은 사용자가 고른 곳이라 바꾼 글로 남긴다.
    - **패널의 자막 줄은 잘린 어절을 뺀 글**(편집본에 나가는 글)을 보이고, 고칠 때도 그 글에서 시작한다.
      `setCaptionCueCaption`의 "인식 텍스트와 같으면 override를 지운다" 비교도 같은 기준이다. 그래서 고치지 않고 확정한 줄은
      override가 되지 않는다.
    - 원본 시각 자막 파일은 여전히 잘린 어절을 넣는다(9절 17). 나누기는 있던 override를 나눌 뿐이라 그대로 뒀다.
    - e2e 64 ④에서 자막 줄 'this test.'와 순수 함수(구절 바꾸기 '굿모닝', 합치기 '좋은 아침! 여러분', 고치지 않은 확정)를 본다.
54. **저장 실패 배너의 '다시 저장'이 실제로 저장한다.** `flush`는 첫 검사에서 `saveError`를 보고 곧바로 false를 돌려줬다. 그래서
    버튼도, 내보내기 직전의 flush도 아무 일을 하지 않았다. 이제 `flush`는 들어올 때 `saveError`를 지우고, **이번 호출 안에서**
    다시 실패할 때만 멈춘다. e2e 64 ③(실패를 흉내 낸 상태 → 버튼 → rev+1).
55. **파일 교체는 rename 한 번**이다(`commands::commit_tmp_output`, 자막 파일·영상 내보내기·프레임 캡처가 같이 쓴다).
    - 옛 순서(기존 파일을 먼저 지우고 rename)는 rename이 실패하면(백신·인덱서가 새 임시 파일을 공유 삭제 없이 잡음) 옛 파일과
      새 파일을 둘 다 잃었다.
    - "Windows rename은 기존 파일을 덮지 못한다"는 틀린 전제였다. std가 MoveFileExW(REPLACE_EXISTING)/POSIX 교체로 덮는다
      (`state.rs save_bytes_at`과 같은 전제).
    - 테스트 `commit_tmp_output_keeps_existing_when_rename_is_blocked`(Windows): 임시 파일을 `FILE_SHARE_READ`로만 잡고 교체
      → 실패해도 기존 파일이 남는다. 옛 순서로 되돌리면 빨갛다.
56. **전사 잡 등록을 `begin_active` 바로 뒤로** 옮겼다(느린 엔진 확인·ffprobe 전). 엔진 확인 뒤와 추출 직전에는 `check_cancel`을
    둔다. 그 틈의 취소는 모르는 id라 조용히 버려졌고, 전사가 끝까지 돌아 문서를 덮었다. e2e 65 ⑤(시작 20ms 뒤 취소 →
    CANCELLED·문서 없음).
57. **끝난 자식의 pid는 레지스트리에서 바로 지운다**(`run_step`, wait 직후). 파싱·저장 동안 남아 있으면 앱 종료의
    `video_kill_all`이 재사용된 pid의 트리를 죽일 수 있었다.
58. **설치 스모크는 블로킹 풀에서** 돈다(`llm::acquire::ensure_runtime`, `spawn_blocking`). 자식을 최대 20초 기다리는 동안 async
    워커를 잡지 않게 한다.
59. **포커스된 버튼의 Enter·Delete·Backspace·F2는 버튼 몫**이다(Space와 같다). 패널 루트가 가로채서 버튼이 안 눌리고, 앞서
    고른 단어가 말없이 나뉘거나 잘렸다. e2e 64 ③(대조: 같은 Enter를 패널 루트에 치면 나눈다).
60. **읽기 전용(새 버전 앱) 문서는 다시 인식 버튼을 막는다.** 전에는 수 분 전사한 뒤 저장에서 거절됐다. 백엔드 선검사는 넣지
    않았다 — 문서가 있을 때 다시 인식하는 UI 경로는 이 버튼뿐이고, 저장 거절은 그대로 남아 있다.
61. 편집본 거절 문구(`cut_keep_at`)에서 "다시 인식하세요"를 뺐다(9절 42, ExportPanel 문구와 같게).
62. **Shift+F2 = caret이 든 cue의 자막 줄 고치기**(§3.5 키 표에 추가). 자막 줄은 마우스 클릭으로만 열렸다. e2e 64 ③.
63. **인식 중 남은 시간 추정**(§6 위험 대응 "예상 시간 표시"가 빠져 있었다). 인식 단계 경과 × (95 − %) ÷ (% − 10)
    (`sttRemainingMs`, 진행 보고 때마다 스토어에서 잰다). whisper는 30초 창마다 보고하므로 첫 보고 전과 95% 뒤에는 보이지 않는다.
    greedy 재시도로 진행이 10%로 돌아가면 기준 시각을 다시 잡는다. e2e는 없다(짧은 픽스처는 보고가 한두 번뿐이다).

검증(2026-09-22): `cargo test --lib` 361 통과·6 무시, `tsc --noEmit` 통과. 64 단독 42/0/0(스위트 33 + 정리 9). 65 단독
(`E2E_NET=1`·ggml-tiny) 30/0/0. 한 앱에서 29·33·34·47·64·65 141/0/0. 변이:
- 버튼 가드·flush·`includeCut` 셋을 한꺼번에 되돌림 → 64의 새 단언 셋이 빨갛다(버튼 Enter가 나눈 여파로 ⑤ SRT도 빨갛다).
- 구절 바꾸기의 잘린 어절 빼기만 되돌림 → '음 굿모닝'으로 빨갛다.
- 잡 등록을 옛 자리로 되돌림 → 65 ⑤ 빨갛다(취소가 버려지고 5분 30초 전사가 끝나 문서 rev 1을 썼다).
- 교체 전 삭제를 되살림 → `commit_tmp_output_keeps_existing_when_rename_is_blocked` 빨갛다.

### P3 백엔드 (2026-09-22)

- 새 파일 `stt/video_subs.rs`: `CaptionSubs{mode: Burn|Soft, timeline, text, lang, preset}`(TS `CaptionSubsSpec`) · 스타일 표
  `caption_style`(기본·박스·크게) · OS 기본 글꼴 `CAPTION_FONTS`/`caption_font` · `build_ass` · `shift_cues`(구간·배속) ·
  `export_cues`(시간축 → 자막 줄 고르기 → 출력 타임라인) · `write_burn_ass`(`stt/gpv-stt-burn-<uuid>/subs.ass`)·`write_soft_srt`
  (`stt/gpv-stt-subs-<uuid>.srt`), 둘 다 `TempFiles` 가드. 상수 `BURN_FILTER = "subtitles=f=subs.ass"`.
- `video.rs`: `VideoToolStatus.has_subtitles_filter`(TS `hasSubtitlesFilter`, `-hide_banner -filters`의 이름 칸, 경로별 캐시) ·
  `VideoMeta.audio_streams`(TS `audioStreams: VideoAudioStream[]` — index·codec·channels·language·title) ·
  `ExportSpec.caption_subs`(TS `captionSubs?`) · `build_export_args`의 넷째 인자가 `DocInputs{keep, audio_stream, subs}`로 —
  체인 (concat →) mask → crop → scale → **subtitles** → setpts, 소프트는 입력 1번 + `-map 1` + `-c:s mov_text` · `export_out_size`
  (PlayRes) · `caption_subs_file` · `validate_spec` 규칙 · `burn_missing_glyphs`(아래 73).
- 오디오 트랙: `TranscribeReq.audio_stream`(TS `audioStream?`, 기본 0) → 추출 `-map 0:a:<n>`, 범위 밖이면 오류, 문서
  `source.audioStream`에 기록. 편집본·자막 입힌 영상은 문서의 트랙(`[0:a:<n>]atrim` · `-map 0:a:<n>?`)을 쓴다.
- `stt/subs.rs` `select_sub_text`(원문·번역·2단) — 영상 자막과 SRT/VTT/TXT가 같이 쓴다. `stt/store.rs` `cut_keep_at`/`load_cut_keep`
  → `export_doc_at`/`load_export_doc(cut)`. `stt/transcribe.rs` `temp_dir`(세 번째 복사를 함수로), `TempFiles`가 빈 폴더도 지우고
  고아 청소가 하루 지난 번인 폴더를 폴더째 지운다. `commands/ocr.rs` `recognize_two_pass`는 가시성만 `pub(crate)`(실측 테스트용).
- TS: `src/lib/ipc.ts` 타입, 새 파일 `src/lib/captionStyle.ts`(스타일 표 거울 + 글꼴 목록). UI는 아직 없다.
- 실측(`#[ignore]` `caption_burn_real_ffmpeg_renders_hangul`, PATH gyan 8.0 Windows — libass 글꼴 공급자 DirectWrite): testsrc
  1280×720 + sine에 "자막 번인 시험 / 한글 글자 확인"을 세 프리셋으로 번인, 앱의 OCR 엔진(Windows.Media.Ocr ko-KR)이 한글 음절
  8/9 · 8/9 · 9/9를 읽음(틀린 글자는 OCR 오독 — 프레임을 눈으로 보면 맑은 고딕으로 정확히 그려져 있다), 박스 프리셋은 반투명 검정
  상자. 구간(1.0~5.0초) 시프트: 출력 0.2초·3.8초 프레임에는 한글 없음. U+0378(미할당)은 libass 경고로 잡히고 ffmpeg는 0으로 끝남.
  소프트 자막 + 무손실 복사 + 구간(1.4초, 키프레임 1초 간격) → mov_text 스트림, 원본 1.5초 cue가 출력 0.502초(영상 첫 프레임
  0.000977초 = 원본 1.0초) — 1ms 안에서 맞다.
- 실측(Linux): 관리형 johnvansickle 7.0.2(sha 일치)를 WSL Ubuntu 24.04(CJK 글꼴 없음)에서 — fontconfig가 `Noto Sans CJK KR`을
  `DejaVuSans`로 대체하고 한글 전부 네모 칸, **종료 코드 0**. fonts-noto-cjk가 있는 Ubuntu·martin-riedl(macOS)·관리형 gyan
  9.0.1의 글꼴 렌더는 미실측.
- e2e 64 ⑤b(IPC 직접 — 내보내기 UI는 프론트 단계): 소프트 자막 + 무손실 복사 → mov_text를 되읽은 cue = `captionSourceCues`(글·개수·
  시각, 출력 영상과 같은 이동 ±2ms — B프레임 음수 DTS로 `make_zero`가 모든 스트림을 66ms 민다) · 편집본 + 원본 시각 자막 거절 ·
  번인(편집본 시각·박스) 길이 5.2s, 편집본 cue 자리(2.3초)만 ⑤ 편집본과 화소가 다르고 cue 사이(3.3초)는 같다(원본 시각을 잘못 쓰면
  둘 다 뒤집히는 시점) · libass 없으면 TOOL_NOT_FOUND 분기 · `stt/gpv-stt-burn-*`·`subs-*` 잔존 0. 64 단독 46/0/0, 33·34·64 한 앱 회귀
  (⑤b 추가 전) 92/0/0.

### 설계와 달라진 것 (P3 백엔드)

64. **`build_ass(cues, preset, out_w, out_h)`** — 텍스트 고르기와 구간 시프트는 따로 뺐다(`select_sub_text`·`shift_cues`). 소프트
    SRT·자막 파일 내보내기도 같은 것이 필요해서다. 번역 2단은 cue 텍스트 `원문\n번역` → ASS `\N`.
65. **자막 파일 내보내기의 번역·2단도 풀었다**(P1의 "P4 미구현" 거절 제거) — 같은 `select_sub_text`. 내보낼 줄 중 하나라도 번역이
    없으면 **거절**한다(원문으로 채우거나 빼지 않는다). 편집본 시각이면 번역문은 컷을 모른다(cue 단위 번역이라 잘린 어절의 번역이 남는다).
66. **스타일 표 = Rust 상수 + TS 거울 + 소스 단언**(`caption_style_table_matches_ts_mirror`가 `captionStyle.ts`의 행을 한 줄 문자열로
    찾는다). 값은 천분율 정수(크기·테두리·박스 여백·아래 여백 = 높이 기준, 좌우 여백 = 폭 기준, 박스 불투명도 %): 기본 50/3/0/-/60/50,
    박스 50/0/10/70%/60/50, 크게 70/4/0/-/60/30. 박스는 BorderStyle 3, 박스 색을 OutlineColour·BackColour 둘 다에 준다.
    `CaptionOverlay`는 아직 옛 상수(`CAPTION_PREVIEW_STYLE`) — 표로 옮기는 것은 프론트 단계.
67. **ASS 글꼴 크기 ≠ CSS font-size**: libass의 Fontsize는 글줄 높이에 가깝다(720p에서 36 → 한글 글자 높이 ≈ 24px). 같은 숫자로
    CSS를 만들면 오버레이가 번인보다 크게 보인다 — 오버레이가 보정할지는 프론트 단계에서 정한다(§6 "완전히 같지 않다").
68. **PlayRes = 백엔드가 계산**: 번인이면 ffprobe를 한 번 더 돌려 표시 기준 크기에 crop(짝수)·scale(`-2:min(mh,ih)`) 규칙을
    적용한다(`export_out_size`). 프론트가 넘기는 값을 믿지 않는다. 영상 트랙이 없으면 거절.
69. **문서가 있는 내보내기는 명시 매핑 `-map 0:v:0`**(지시의 `0:v` 대신 — 커버 그림·보조 영상 트랙까지 인코딩하지 않게) +
    `0:a:<n>?` + (소프트) `1`. 문서 없는 내보내기의 매핑은 예전 그대로.
70. **소프트 + 무손실 복사 + 구간을 허용**: `-avoid_negative_ts make_zero`가 모든 스트림을 같은 만큼 옮겨 키프레임 스냅을 자막도
    따라간다(위 실측). **소프트 + 배속**은 SRT 시각을 배속으로 나눈다(자막 스트림은 setpts를 타지 않는다). 번인은 setpts 앞이라
    나누지 않는다.
71. **mp4·m4v·mov 전용**(gif·오디오 전용 거절 — 설계는 `name.sub.mp4`만 말했다). libass 없는 ffmpeg의 번인은 `TOOL_NOT_FOUND`
    ("소프트 자막으로 내보내세요"). 상태 조회의 필터 확인 실패는 로그 + `false`, 내보내기는 같은 확인을 다시 해 진짜 오류를 낸다.
72. **원본 시각 자막은 stale 문서도 거절하지 않는다**(자막 파일 내보내기와 같다 — 배너는 프론트). 편집본 시각은 `caption_cut`과 짝이라
    편집본 거절 규칙(근사·stale·전부 잘림)을 그대로 탄다. 번역 자막은 `lang` 필수(`validate_spec`).
73. **네모 칸 감지 → 거절**: libass가 어떤 글꼴에서도 못 찾은 글자는 네모 칸으로 그려지는데 ffmpeg는 0으로 끝난다(위 Linux 실측).
    stderr **전체**에서 `fontselect: failed to find any fallback with glyph 0x…`를 찾아(8KB 꼬리로 자르기 전) 하나라도 있으면
    임시 출력을 지우고 `TOOL_NOT_FOUND`로 글자 목록과 "'<글꼴>' 설치(Linux: fonts-noto-cjk) 또는 소프트 자막"을 알린다.
    Windows(DirectWrite)·Linux(fontconfig) 경고 문구가 같다. 이모지 하나가 없어도 거절된다 — 조용히 네모 칸 영상을 내는 것보다
    낫다고 봤다. OFL 글꼴 선택 자산(§8 Q6)은 만들지 않았다.
74. **취소 등록을 앞으로**: `video_export_inner`가 문서 읽기·번인 ffprobe·필터 확인·그래프 파일보다 먼저 잡을 등록한다(9절 56과
    같은 이유 — 준비 중 취소가 버려지지 않고, 등록된 신호를 spawn 직후 select!가 받는다).
75. `AudioStreamInfo.index` = **오디오 스트림 안 순번**(`0:a:<n>`), 전체 스트림 번호가 아니다. 소프트 자막 트랙에 언어 태그는
    달지 않는다(2글자 → ISO 639-2 변환 없음).

### P3 프론트엔드 (2026-09-22)

- `src/lib/captionStyle.ts`: `CAPTION_STYLE_PRESET_IDS`·`CAPTION_STYLE_LABELS`(기본·박스·크게), `captionStylePresetOf`·
  `setCaptionStylePreset`(문서에 기억, 되돌리기 한 단계), `CAPTION_OS_FONT`(Rust `caption_font()` 거울),
  `captionOverlayLayout(preset, w, h)` — 값 표에서 오버레이 px(글자 크기·줄 간격·아래 여백·글줄 폭·테두리·박스).
- `CaptionOverlay`: 옛 상수 `CAPTION_PREVIEW_STYLE`을 지우고 `captionOverlayLayout`으로. 테두리 = 8방향 text-shadow, 박스 =
  반투명 배경 + 여백, `data-preset`. 스테이지 폭·높이를 ResizeObserver로 잰다.
- VideoPlayer: 상단 바 CC 옆 스타일 드롭다운(`data-gpv="caption-style"`, 전사 중·읽기 전용 문서면 비활성), 대본 패널에
  `audioStreams`를 넘긴다.
- ExportPanel "자막 넣기" 섹션(자막 문서가 있는 영상에만, `data-gpv="caption-subs"`): 넣지 않음 / 영상에 입히기(번인) / 자막 트랙.
  → `VideoExportSpec.captionSubs`.
- 전사 폼: 오디오 트랙 드롭다운(`data-gpv="stt-audio-track"`, 트랙 2개 이상일 때만) → `TranscribeOpts.audioStream` →
  `TranscribeReq.audioStream`. 이름은 `sttAudioTrackLabel`(`src/lib/stt.ts`).
- Rust: `CaptionDoc.style_preset: Option<CaptionStylePreset>`(TS `stylePreset?`, serde 기본값·생략), `CaptionStylePreset`에
  `Serialize`, `write_transcribed_at`이 직전 판의 스타일을 이어 간다(테스트 `caption_transcribe_overwrite_keeps_backup`에 단언 추가).
- `__gpv.caption`에 `captionOverlayLayout`·`setCaptionStylePreset`·`sttAudioTrackLabel`.
- e2e 64 ⑤c: CC 옆 스타일 → 문서 저장(Rust 왕복) · 오버레이가 box 값 표를 따른다(아래 여백 ≠ basic·글자 크기·반투명 박스) ·
  트랙 이름 · 번인 선택지 = libass 유무 · ExportPanel 자막 트랙 + 대본 편집 → 기본 이름 `.cut.sub.mp4` → mov_text = 편집본 시각 cue.
- 확인: `cargo test --lib` 376 통과·7 무시, `tsc --noEmit`·`npm run build` 통과, 64 단독 51/0/0(⑤c 5개 포함, gyan 8.0 PATH·libass 있음).
  ⑤c 실측: doc 창 스테이지 높이 ≈222px라 글자 크기는 12px 하한에 걸린 값으로 비교됐다(하한 밖의 크기 비교는 e2e에 없다) ·
  박스 아래 여백 10.13px vs basic 13.32px · 자막 트랙 cue 3개가 편집본 시각과 ms 단위로 같다(영상 이동 0).

### 설계와 달라진 것 (P3 프론트엔드)

76. **스타일은 설정이 아니라 자막 문서에 기억한다**(`CaptionDoc.stylePreset`, 없으면 basic). 더 단순한 쪽이라서다.
    - 설정 키는 Rust `Settings`·TS `Settings`·`SETTINGS_INDEX`를 함께 늘려야 한다. e2e 29 ⑤가 모든 키의 인덱스 항목을 요구하므로
      설정 화면 항목까지 생긴다. 설정 다이얼로그가 든 옛 스냅샷과의 동시 저장도 따로 다뤄야 한다.
    - 문서는 필드 하나로 끝나고, 기존 편집 경로(되돌리기·자동 저장·다른 창 `caption://changed`)를 그대로 탄다.
    - 대가: 영상마다 따로 고른다(새 영상은 기본). 전사 중·읽기 전용 문서에서는 바꿀 수 없다.
    - 재전사는 직전 판의 스타일을 이어 간다 — 번역·컷과 달리 cue·토큰 id에 매이지 않는다.
    - 백엔드는 이 필드를 읽지 않는다. 번인은 여전히 `CaptionSubs.preset`이고, 프론트가 문서 값을 넣는다.
77. **오버레이 글자 크기 보정**(9절 67의 결정): CSS font-size = ASS Fontsize × unitsPerEm ÷ (winAscent + winDescent), 줄 간격 =
    Fontsize. libass(VSFilter 호환)가 Fontsize를 em이 아니라 글꼴의 OS/2 win 높이에 맞추기 때문이다.
    - GDI+ 실측: Malgun Gothic 2048/(2229+495) = 0.752, Noto Sans CJK KR(Noto Sans KR과 같은 메트릭) 1000/(1160+288) = 0.691.
      Apple SD Gothic Neo는 미실측이라 Malgun 값을 빌린다.
    - 백엔드 실측(720p Fontsize 36 → 한글 글자 높이 ≈ 24px)과 맞는다: 36 × 0.752 ≈ 27px em, 한글 글자는 em의 0.9 안팎.
    - 12px 하한 밑이면(아주 작은 창) 글자·줄 간격·테두리·박스를 같은 비율로 키운다.
    - 박스 프리셋의 아래 여백은 MarginV − 박스 여백이다 — ASS MarginV는 박스가 아니라 글자 아래까지다.
    - 크롭은 반영하지 않는다. 크롭하면 번인 글자가 크롭 영역 기준이라 원본 프레임 위 미리보기보다 작게 그려진다(§6 "같지 않다").
78. **스타일 드롭다운은 CC 옆 한 곳**이다. ExportPanel은 번인 스타일을 고르지 않고 문서 스타일을 보여 준다("스타일 박스 — 자막
    미리보기와 같습니다"). 두 곳에서 고르면 미리보기와 결과가 어긋날 수 있다.
79. **자막 넣기 UI**
    - 시간축은 고르지 않는다. 대본 편집 반영이 켜지면 편집본 시각, 아니면 원본 시각이다(백엔드의 짝 규칙).
    - 글(text)은 원문(`caption`)만 넣는다. 번역·2단 선택지는 P4 몫이다.
    - libass가 없으면 번인 선택지를 비활성으로 두고 "이 ffmpeg엔 libass가 없어 … 자막 트랙으로 넣습니다"를 보인다. 번인을 고른 뒤
      ffmpeg가 바뀌어 libass가 사라지면 그 이유를 경고로 보이고 스펙에 넣지 않는다.
    - 번인은 재인코딩을 강제한다(copy 경고 목록에 "자막 번인"). 자막 트랙은 copy일 때 "무손실 복사로 자막 트랙만 더합니다",
      아니면 다른 옵션 때문에 재인코딩한다고 알린다.
    - 기본 이름에 `sub`를 붙인다(대본 편집과 함께면 `name.cut.sub.mp4`). 자막만 넣는 무손실 복사도 "바꿀 항목 없음"이 아니다.
    - 내보내기 전에 대본 저장을 flush한다(편집본과 같은 이유 — Rust가 저장본을 읽는다).
    - 원본 시각 + stale 문서는 거절하지 않고 경고만 한다(9절 72).
    - 문서를 쓰는 내보내기(편집본·자막)는 자막을 만든 오디오 트랙 하나만 매핑한다(9절 69). 트랙이 여럿이면 어느 트랙이
      들어가는지 알린다. 분할 저장 경고 목록에 "자막"을 더했다.
    - 넣을 자막이 하나도 없는 문서의 선검사는 하지 않았다. 드물고, 백엔드 거절이 종결 토스트로 보인다.
80. **오디오 트랙**
    - 드롭다운은 트랙이 2개 이상일 때만 보인다. 이름은 "트랙 N · 언어 · 제목 · 코덱 채널"이고 `und`는 뺀다.
    - 다시 인식은 문서가 쓴 트랙이 기본이다. 그 번호가 파일에 없으면(원본 교체) 첫 트랙을 쓴다.
    - 고른 트랙은 기억하지 않는다 — 파일마다 트랙 구성이 다르다. 인식 언어를 트랙의 언어 태그로 자동 고르지도 않는다.
81. 오버레이의 흰 글자·검정 테두리·반투명 검정 박스는 **테마 토큰이 아니다**. 번인 결과(ASS 색)를 그대로 보이는 자리라서다.
    드롭다운·안내 문구 같은 UI는 테마 토큰만 쓴다.

### P4 번역 자막 (2026-09-22)

- 새 파일 `src/lib/captionTranslate.ts`(순수 함수 + 주입된 `chat`): 대상 언어 8개(`CAPTION_TRANSLATE_LANGS` — ko·en·ja·zh·es·fr·de·vi) ·
  `captionTranslateItems`(원본 시각 cue 글 + 해시) · `captionTranslationState/Pending/Counts/Langs` · `captionDefaultTranslateLang` ·
  `captionTranslateBudget`·`batchCaptionItems`·`captionTranslateMessages`·`captionTranslateMaxTokens`·`parseCaptionTranslation` ·
  `translateCaptionItems`(검증 실패 → temperature 0으로 한 번 → 반으로 → 한 줄까지, 한 줄도 안 되면 그 cue만 비움) ·
  `setCaptionTranslations`(배치 쓰기)·`setCaptionTranslation`(손으로 고치기).
- `src/lib/llm.ts`: `chatWithBusyRetry` — `translate.ts`의 Busy 재시도(3초 간격·10분)를 옮겼다. `translateStream`은 이것을 부르고
  동작은 같다(대기 문구 `onBusy`, 로드 문구 `onProgress`, abort 즉시 깨는 sleep). `langName`을 8개 언어로.
- 스토어 `captionDoc.ts`: `translate(key, lang, ctx)`·`cancelTranslate(key)`, 엔트리 `translate{lang,total,done,failed,status}`·
  `translateError`. 배치마다 `edit`으로 문서에 쓴다(자동 저장·되돌리기 한 단계) — 창을 닫았다 열면 빈 줄·원문이 바뀐 줄만 다시 한다.
  모델은 61처럼 설정의 기본 모델(modelId 없음), 취소는 AbortController → `chat()`의 `llm_cancel`. 번역 중엔 다시 인식을 막는다.
- UI: 대본 헤더 [번역](`data-gpv="translate-toggle"`) → 새 파일 `captions/TranslatePanel.tsx`(대상 언어 · n/N줄 · 원문 바뀜 수 ·
  번역 시작/이어서 번역(남은 k줄)/모두 번역됨 · 진행·취소 · `llmReadyReason` 안내 + 설정 › AI 열기). cue 행 아래 번역 줄
  (`translation-line`, 클릭해 고침 — 비우면 그 줄 번역 삭제, `translation-stale` "원문 바뀜"). 자막 파일 내보내기에 "글: 원문·번역·2단"
  (+번역 언어), 빠진 번역 안내(`subs-trans-missing`)·저장 비활성. VideoPlayer CC 옆 `caption-trans` "원문만 / 원문 + <언어>"
  (오버레이 2단). ExportPanel "자막 넣기"에 글(`caption-subs-text`)·번역 언어 + 빠진 번역 선검사.
- `frameCapture.ts subsOutRel(path, format, timeline, lang?, dual?)` — 번역 `name.<lang>.srt`, 2단 `name.<lang>.dual.srt`.
- Rust: `CaptionDoc.translation_src`(TS `translationSrc`) — 저장만 한다(아래 85). 자막 파일·영상 자막의 번역·2단 선택
  (`select_sub_text`)은 P3 백엔드에서 이미 동작했다 — 이번엔 단위 테스트 `subs_translation_and_both_select_by_cue_id`
  (cue id로 붙임·빈 번역 = 없음·언어 없음/모르는 언어 거절·SRT 2단·편집본에서 빠진 cue는 번역이 없어도 됨)와
  `doc_serializes_to_ts_shape`의 `translationSrc` 왕복 단언을 더했다.
- `__gpv.caption`에 번역 순수 함수 10개(`translateCaptionItems`·`parseCaptionTranslation`·`batchCaptionItems` …).
- e2e 64 ⑤d(LLM 없이 결정적): 가짜 chat으로 밀린 답 거절·서문 무시·번호 반복·문장부호 차이 허용·잡담·원문만 베낀 답·기호뿐인 답
  거절 · 잘림 → temperature 0 → 반으로 → 한 줄(호출 순서 `5@0.2,5@0,3@0.2,3@0,2@0.2,1@0.2,2@0.2`) · 보낸 글 = 번호|글뿐(타임코드
  없음) · 스토어에 쓴 번역의 Rust 왕복 · [번역] 현황 · 오버레이 2단 · 원문 바뀜 → 손으로 고쳐 풀림 · 자막 파일 2단 원문 대조 ·
  빠진 번역을 패널·ExportPanel·백엔드가 막음.
- **실측**(앱 밖 — `captionTranslate.ts`를 esbuild로 묶어 dev 데이터의 llama-server b10809 + 모델을 직접 띄움(읽기만), RTX 5070 Ti
  Vulkan, `-c 8192 -np 1`, 한국어 화면 녹화 해설 35줄(2줄 cue 5개, 명령·파일명·버전 포함)과 영어 14줄):

  | 모델 | 방향 | 결과 |
  |---|---|---|
  | Qwen3 4B Q4_K_M(기본 `qwen3-4b-q4`), §3.7 원안 `번호\|번역` | ko→en | 1회 호출 6초, 35/35 "성공" — **그런데 내용이 밀렸다**: 3~6번이 한 줄씩 다음 줄 뜻, 23번부터 끝까지 밀려 마지막 줄 소실. 프롬프트로 "그 줄 뜻만" 강조해도 두 번 다 같게 밀림 |
  | 같은 모델, `번호\|원문\|번역`(원문 베끼기) | ko→en | 1회 12초, 35/35, 줄 정렬 맞음 |
  | 〃 | ko→ja | 첫 판: 베낀 원문의 `.`→`。`로 대조 실패 → 62회·99초, 한 줄 배치에서 원문이 번역 자리에 저장됨 → 대조 키에서 문장부호·기호를 빼고 원문만 베낀 답을 거절한 뒤 1회 13초, 35/35 |
  | 〃 | en→ko | 입력을 그대로 베끼고 끝(두 온도 다) → 25회 → 구분자를 `=>`로 바꾸자 1회 5초, 14/14 |
  | 최종(`번호\|원문 => 번역`) | ko→en · ko→ja · en→ko | 각 1회 · 12.2초 · 13.8초 · 5.2초, 전부 줄 정렬 맞음 |
  | Qwen3 1.7B Q8_0(dev 설정 모델), 최종 | ko→en | 95회 42초, 34/35(1줄 실패 → 비움), 정렬 맞음, 번역 품질은 4B보다 낮음 |
  | 〃 | en→ko | 19회 19초, 14/14 |

  남은 품질 문제는 줄 **안**의 것이다(4B: 문장 가운데서 끊긴 cue의 뜻 일부를 이웃 줄로 옮김, "알아보겠습니다" → "I'll explain" 같은
  약한 번역, ja "イシュー" 오기).
- **앱 안 실제 LLM**: 샤드 앱은 dev 식별자의 앱 로컬 데이터(`llm/` — 런타임·기본 모델 Qwen3 4B)를 공유하므로 e2e에서 LLM이 준비돼
  있다. 64 ⑤d가 그때만 스토어 번역 잡을 실제로 돌린다 — 빠진 한 줄(`2nd line` → "2번째 줄")만 보내고 손으로 고친 줄은 그대로, 시작
  직후 취소는 오류 없이 끝나고 아무 것도 쓰지 않는다. 49(선택 번역 카드)도 같은 회차에 실제 스트리밍·방향 토글까지 통과 —
  `chatWithBusyRetry`로 옮긴 `translateStream` 무회귀.
- 확인: `cargo test --lib` 377 통과·7 무시 · `tsc --noEmit`·`npm run build` 통과 · `GPV_E2E_ONLY=49,64` 한 앱 80/0/0(64는 단언
  63개, ⑤d 12개 포함). 변이: 아래 92의 가드를 빼면 64 "요청 중 취소" 단언이 빨갛다(`late:["k0"]`) — 실제 LLM 취소 단언은 이번 회차에서
  취소가 제때 닿아 가드 없이도 초록이었다(경합이 안 일어났다), 판별은 가짜 chat 단언이 한다.

### 설계와 달라진 것 (P4)

82. **응답에 원문을 베껴 쓰게 한다**(`번호|원문 => 번역`, §3.7의 `12|텍스트` 응답 대신). 번호 집합 검사만으로는 한 줄씩 밀린 답을
    못 잡는다(위 실측 — 번호 개수는 맞다). 베낀 원문이 그 번호의 원문과 맞아야 통과하므로 밀린 답이 형식 오류가 돼 다시 묻기·쪼개기로
    간다. 대조 키는 공백·문장부호·기호(⏎ 포함)·대소문자를 뺀 글. 비용: 응답 토큰이 약 두 배(4B 35줄 6초 → 12초). 구분자는 `=>`
    (`|`로 두면 영→한에서 입력만 베끼고 끝났다) — 파서는 `=>`·`→`·`|`를 다 받는다.
83. **한 줄 배치는 느슨하게**(쪼개기의 마지막 단계 — 밀릴 이웃이 없다): 베낀 원문이 틀려도 마지막 칸을 번역으로 받는다. 원문 그대로이거나
    글자·숫자가 없는 칸은 거절. 번역 앞에 같은 번호를 다시 쓴 답(`3|원문|3|번역`)은 번호를 뗀다. 여러 줄 배치에서는 서문(첫 번호 줄 앞)은
    무시하고, 번호 줄 뒤의 번호 없는 줄은 실패로 본다(잡담이 마지막 번역에 섞이지 않게). 원문과 같은 번역은 받는다(이미 대상 언어인 줄).
84. **번역의 원문 = 원본 시각 cue 글**(Rust `source_cues`와 같은 글, 잘린 어절 포함) — 원본·편집본 어느 시각으로 내보내도 모든 cue에
    번역이 있게. 대가: 편집본 자막의 번역엔 잘린 말의 뜻이 남을 수 있고(9절 65와 같은 한계), 패널의 자막 줄(잘린 말 뺀 글)과 조금
    다르다 — 번역 줄은 손으로 고친다. 컷을 해도 "원문 바뀜"이 되지 않는다.
85. **원문 바뀜 = `translationSrc`(lang → cueId → 원문 fnv16 해시) 비교** — Rust `CaptionDoc.translation_src` 필드가 생겼다(§3.7의 "Rust
    변경 없음"과 다르다 — 선언이 없으면 저장 때 serde가 버린다). 백엔드는 읽지 않는다. 해시는 **보낼 때** 원문의 것이라 번역 도중 고친
    cue는 도착하자마자 원문 바뀜이다. 해시가 없는 번역(손으로 만든 문서)은 믿는다. 나누기·합치기는 번역을 옮기지 않는다 — 나누면 앞쪽은
    원문 바뀜·뒤쪽은 빠짐, 합치면 사라진 cue의 번역이 고아로 남는다(쓰이지 않고, 같은 id가 다시 생겨도 해시가 달라 원문 바뀜).
    원문 바뀜 번역은 내보내기를 막지 않고 경고만 한다(백엔드는 해시를 모른다).
86. **번역 줄 손으로 고치기** = 지금 원문의 해시로 갱신(원문 바뀜이 풀린다). 고치지 않고 확정(포커스 잃음 포함)은 아무 것도 안 한다 —
    말없이 원문 바뀜을 풀지 않게. 비우면 그 cue 번역을 지운다. 자막 줄처럼 `<textarea>`(Enter 확정·Shift+Enter 줄바꿈·Esc 취소).
87. **줄바꿈**: 번역문은 ⏎·줄바꿈을 공백으로 편 뒤 대상 언어의 줄 폭(`captionLangLineChars` — Rust `line_chars` 거울, 16/42)으로 다시
    줄바꿈한다(원문 줄 나눔은 번역에서 자리가 맞지 않는다). 일본어·중국어는 공백이 없어 한 줄로 남는다(Rust `wrap_words`와 같은 한계).
88. **번역 없는 cue**: 9절 65 그대로 — 내보낼 줄에 하나라도 없으면 거절(원문 대체·생략 없음). 편집본에서 빠지는(전부 잘린) cue는
    번역이 없어도 된다. 프론트가 같은 규칙으로 미리 막는다 — 대본 패널은 저장 버튼 비활성, ExportPanel은 P3 관례대로 이유를 보이고
    자막을 스펙에 넣지 않는다(기본 이름에서 `.sub`가 빠진다).
89. 번역 잡은 창 수명(스토어). 배치 하나 = 되돌리기 한 단계라 Ctrl+Z가 번역 배치를 되돌린다(되돌린 줄은 이어서 번역이 다시 한다).
    새 설정 키 없음 — 모델은 기본 모델, 대상 언어·2단 보기 언어는 기억하지 않는다(패널 기본값 = 번역이 있는 첫 언어, 없으면 한국어
    영상은 영어·그 밖은 한국어). 한 줄도 못 한 cue는 비워 두고 "N줄은 번역하지 못했습니다 — 다시 번역하면 그 줄만" 안내.
90. 배치 예산 = min(1,500자, (ctx − 320) ÷ 3), 40줄 상한 — 입력(한글 최악 1자 ≈ 1토큰) + 응답 상한(입력 × 2 + 64, 베낀 원문 몫)이
    컨텍스트에 들어가게. 첫 시도 temperature 0.2, 다시 물을 때 0.
91. 파일 이름: 번역 `name.<lang>.srt`, 2단 `name.<lang>.dual.srt`(편집본 시각은 `name.cut.<lang>…`). 영상 내보내기(`.sub.mp4`)는
    언어를 이름에 넣지 않는다. 자막 트랙 언어 태그는 여전히 없다(9절 75).
92. **LLM 답을 받은 뒤에도 취소를 다시 본다**(`translateCaptionItems`). `chat()`의 취소는 `llm_cancel(requestId)`인데, 백엔드가 요청을
    등록하기 전에 닿으면 아무 일도 안 하고(`chat.rs` — id가 다르면 no-op) 답이 그대로 온다. 그 답을 쓰면 사용자가 취소한 뒤에 번역
    배치가 문서에 들어간다. 61 카드는 결과를 버리니 문제가 없었지만 72는 문서에 쓴다.

### e2e 확장 (P3·P4, 2026-09-22)

- **64** ⑤b: 소프트 자막 mp4 스트림 = `video:h264,audio:aac,subtitle:mov_text`(ffprobe), 번인 mp4 = `video:h264,audio:aac`(자막
  스트림 없음). 길이·자막 자리 화소 비교는 원래 있었다. OCR로 한글을 확인하는 것은 Rust `#[ignore]` 실측에 맡겼다.
  ⑤d: **번역만(원본 시각) SRT** `e2e-cap.ko.srt`를 IPC로 내보내 원문과 대조한다(원본 시각 cue마다 그 cue id의 번역 · 시각 = `captionSourceCues`).
  원문을 그대로 돌려준 답은 가짜 chat으로 본다(아래 93). 실제 LLM 부분은 게이트를 바꾸고(아래 94) **한 언어 전체 번역**을 더했다.
- **65 ②b**(`E2E_NET`·`E2E_STT_MODEL`): 첫 트랙은 사인파, 둘째 트랙은 jfk인 영상을 스토어 `transcribe`(`audioStream: 1`)로 전사한다
  → "country"·`source.audioStream = 1`. `-map`을 무시하고 첫 트랙을 뽑으면 말이 없어 실패한다. 없는 트랙 번호(3번)는 거절하고
  문서 rev는 그대로다.
- **새 스위트 68 `caption-audio-tracks`**(엔진 없이 결정적, doc 창): 사인파 두 트랙(eng·kor) 영상으로 다음을 본다.
  - `video_probe` 트랙 순번·코덱·채널·언어.
  - [자막 만들기] 폼의 트랙 드롭다운: 이름 = `sttAudioTrackLabel`, 기본은 첫 트랙이다. 둘째를 고르면 전사 요청이 `audioStream 1`이다.
  - 문서(`audioStream 1`)가 생기면 [다시 인식] 기본 트랙 = 트랙 2.
  - ExportPanel 자막 트랙은 "트랙 2 · kor · aac 1ch만 들어감"을 안내한다. 내보낸 mp4는 `video:h264,audio:aac:kor,subtitle:mov_text`
    (eng 트랙은 빠진다).
  - libass 없는 ffmpeg(흉내): 번인 선택지가 비활성이고 "자막 트랙으로 넣습니다"를 안내한다. 번인을 고른 뒤 libass가 사라지면 경고가
    뜨고 기본 이름에서 `.sub`가 빠진다.
- 실행(이 머신, gyan 8.0 PATH·libass 있음):
  - 68 단독 11/0/0.
  - 64 단독(`E2E_LLM_GGUF` = Qwen3 4B) 59/0/0(러너 정리 포함 68). 1.7B로는 2 실패(아래 94).
  - 회귀는 한 앱에서 29·33·34·47·48·49·64·65·66을 돌렸다(`E2E_NET=1`·`E2E_STT_MODEL`·`E2E_STT_WAV`·`E2E_LLM_GGUF`=4B). 결과는
    257 pass / 0 fail / 1 skip이고, skip은 48 ⑨(LLM 답이 요약 형식이 아닐 때의 기존 skip)다.
  - 전체 `node tests/e2e/shard.mjs`(3샤드, 게이트 없음)는 1564 pass / 5 fail / 18 skip, 277초. 실패 5개는 전부 1번 샤드의 클립보드
    단언이다(54 ⑥ · 52 셋(CDP 60초 시한 포함) · 60 ⑥, 모두 `클립=""`). 회차 중 화면이 잠겨 있었다(`LogonUI.exe`). 52·54·60만
    혼자 다시 돌려도 같은 5개가 같은 모양으로 실패한다. 이 태스크와 무관한 환경 요인이다. 이 회차에서 64는 56/0/1(실제 LLM skip),
    66은 11/0/0, 49는 17/0/0이었다. 47·65는 `E2E_NET` 게이트로 skip됐다.
- 변이: 93의 가드를 끄면(`true ||`) 64 ⑤d "원문을 그대로 돌려준 답"이 빨갛다(`ko:["ok:e0","ok:e1"]`). 되돌린 파일은 백업과 같다.

### 설계와 달라진 것 (P3·P4 e2e)

93. **번역하지 않고 원문을 그대로 돌려준 답을 거절한다**(제품 결함 수정, `captionTranslate.ts untranslatedEcho`).
    - e2e 64를 Qwen3 1.7B로 돌렸다. 영어 → 한국어에서 `N|2nd line => 2nd line`처럼 베낀 원문을 번역 자리에도 썼다.
    - 형식 검사(베낀 원문 대조)를 통과했고 9절 83의 "원문과 같은 번역은 받는다"에 걸렸다. 그래서 영어가 한국어 번역으로 저장되고
      [번역]에는 "모두 번역됨"이 떴다. 조용히 틀린 자막이 나간다.
    - 이제 대상 언어가 제 글자를 가진 언어(ko 한글 · ja 가나·한자 · zh 한자)이고 원문에 그 글자가 없는데 번역이 원문과 같으면
      (`echoKey` 비교) 그 배치를 형식 오류로 본다 → temperature 0 → 반으로 → 한 줄. 한 줄로도 안 되면 번역하지 못한 줄로 남기고
      알린다.
    - 원문에 이미 대상 언어 글자가 있으면(한국어 원문 → 한국어) 받는다. 라틴 문자 언어끼리는 가릴 수 없어 예전처럼 받는다.
    - 대가: 한국어로 옮길 cue가 "GitHub"뿐이면 번역하지 못한 줄로 남는다. 손으로 채운다.
    - 수정 뒤 1.7B는 "2nd line"을 네 번(0.2/0 × 배치·한 줄) 다 그대로 돌려줘, 그 줄은 "1줄은 … 번역하지 못했습니다"로 남는다.
      4B는 "2번째 줄"·"두 번째 줄"로 옮긴다.
94. **64의 실제 LLM 부분은 `E2E_LLM_GGUF`를 줄 때만** 돈다(47과 같은 주입 — `llmModel: "custom"` + 경로, 끝나면 설정 복원 + `llm_stop`).
    P4 때는 "LLM이 준비돼 있으면" 돌았다. 샤드 앱은 dev 앱 로컬 데이터의 `llm/`을 공유하므로 기본 회차에서도 4B를 띄웠고, 다른
    샤드와 메모리를 다퉜다(드라이버의 여유 메모리 중단선). 런타임이 없으면 skip하고 E2E_NET 회차의 47이 받는다고 안내한다.
    - 단언은 엄격하게 두었다: 빠진 줄 = 한글, 한 언어 전체 = 모든 cue 한글·남은 줄 0·오류 없음. **4B(기본 모델)로 통과하고 1.7B로는
      실패한다**(93의 모델 능력 한계 — 제품은 실패를 드러낸다). 지시의 1.7B 대신 4B GGUF로 게이트를 통과시켰다.
    - 한 언어 전체(cue 3개, 한 배치)는 4B로 1.0초 걸렸다.
95. 66은 엔진·모델 없이 **드롭다운 → 요청**까지만 본다.
    - doc 창 쿼리 캐시의 `["stt-status"]`에 가짜 준비 상태를 넣고, 스토어 `transcribe`를 가로챈다.
    - `__TAURI_INTERNALS__.invoke`는 쓰기 금지 속성이라(tauri `core.js` `defineProperty`) IPC에서 가로챌 수 없다.
    - 요청 → 추출(`-map 0:a:<n>`) → 문서는 65 ②b가 실제 엔진으로 본다.
    - libass 없음은 `["video-tool"]` 캐시만 흉내 낸다. 백엔드 TOOL_NOT_FOUND 분기는 실제 ffmpeg에 libass가 없을 때 64 ⑤b가 본다
      (이 머신에선 안 돈다).
96. mp4는 오디오 트랙 `title` 태그를 남기지 않는다(ffmpeg mp4 muxer — `handler_name`만). 그래서 68 픽스처 이름에는 제목이 없고
    ("트랙 2 · kor · aac 1ch"), 제목이 붙는 이름은 64 ⑤c의 `sttAudioTrackLabel` 단언이 본다.

### 리뷰 후 수정 (P3·P4, 2026-09-22)

리뷰가 올린 결함 11건(같은 원인 셋을 합쳐 8건)을 근본 원인 한 곳에서 고쳤다. 조용히 실패하던 것(97~100)은 수정을 되돌려
단언이 빨개지는 것까지 봤다.

97. **소프트 자막 글이 ffmpeg SRT 마크업으로 먹혔다**(`write_soft_srt`).
    - 원인: `build_srt` 그대로 썼고, ffmpeg SRT 디코더(htmlsubtitles)가 cue 글을 태그로 읽은 뒤 mov_text로 옮겼다. 실측(gyan 8.0,
      mux 후 되읽은 패킷): `C:\new` → `C:`+줄바꿈+`ew`, `if a<b and c>d` → `if ad`(굵게), `<file>`·`{\an8}`·`{y:b}`·`{\i1}`은 사라지고
      `<i>x</i>`는 기울임이 됐다. 화면 녹화 해설의 경로·명령·비교식이 소프트 자막에서만 말없이 바뀌었다.
    - 수정: `video_subs::build_soft_srt` — 번인(`ass_text`)과 같은 전각 치환(`{ } \` → `｛｝＼`, 공용 `fullwidth_markup`)에
      `<` → `＜`를 더한다. `&lt;`는 풀리지 않고 그대로 보여(실측) 쓸 수 없다. `>`·`&`·줄바꿈은 그대로.
    - 대가: 소프트 자막의 `<`는 `＜`로 보인다(번인은 `<` 그대로 — ASS는 꺾쇠를 읽지 않는다). 자막 파일(.srt) 내보내기는 편집기가
      읽는 원문이라 건드리지 않았다.
    - 소프트 트랙도 ASS로 넣는 대안은 택하지 않았다 — mov_text 표본 설명(글꼴·크기·색)이 문서 스타일·출력 크기를 따라 바뀌고,
      소프트 경로에 출력 크기 계산(ffprobe)이 늘어난다.
    - 검증: 단위 `soft_srt_escapes_markup_like_burn`, e2e 68 ④(자막 글 `C:\new {\an8}<i>x</i> a<b and c>d.` → 되읽은 mov_text =
      원문의 전각 치환). 변이: `build_srt`로 되돌리면 68 ④가 빨갛다.
98. **번역 잡이 잡 도중 손으로 고친 번역 줄을 덮었다.** 대기 목록은 잡을 시작할 때 정해지고, 배치가 도착하면
    `setCaptionTranslations`가 글·해시가 다르면 무조건 썼다(되돌리기로만 찾을 수 있었다).
    - 수정: 스토어가 시작할 때의 `translations[lang]`을 `base`로 넘기고, 그 뒤 바뀐 줄(고침·지움·새로 씀)은 건너뛴다(처리한 줄로 센다).
    - 번역 줄을 잡 동안 잠그는 대안은 택하지 않았다 — 수 분 걸리는 잡 내내 다른 줄도 못 고친다.
    - 검증: e2e 64 ⑤d 순수 함수 단언(결정적 — 고친 줄·새로 쓴 줄은 그대로, 손대지 않은 줄만 LLM 답, base 없으면 다 덮음) + 실제 LLM
      게이트 단언(시작하자마자 한 줄을 손으로 → 끝난 뒤 그대로). 변이: 스토어가 `base`를 넘기지 않으면 실제 LLM 단언이 빨갛다.
99. **stale 문서의 오디오 트랙이 파일에 없으면 소리 없는 영상이 "성공"했다** — `-map 0:a:<n>?`의 `?`가 없는 트랙을 말없이 건너뛴다.
    원본을 바꿔 끼운 stale 문서(원본 시각 자막은 stale도 받는다, 9절 72)에서만 생긴다.
    - 수정: `video_export_inner`가 stale 문서 + 소리 매핑일 때 ffprobe로 트랙 수를 확인해 거절한다("자막을 만든 오디오 트랙 N번이 이
      파일에 없습니다 … 대본에서 다시 인식하거나 소리 빼기로"). 같은 파일(stale 아님)은 전사가 범위를 확인했으므로 ffprobe를 늘리지 않는다.
    - 첫 트랙으로 대신 넣는 안은 택하지 않았다 — 자막을 만든 소리와 다른 소리가 말없이 들어간다(9절 65·88의 "채우지 않는다"와 같은 기준).
    - ExportPanel: 그 트랙이 probe에 없으면 경고(`caption-audio-missing`). "어느 트랙이 들어가는지" 안내는 전처럼 트랙 2개 이상일 때만.
    - 검증: e2e 68 ④b(문서 크기를 틀리게 해 stale + 트랙 6번 → 경고 · 거절 · 파일 없음). 변이: 검사를 빼면 68 ④b가 빨갛다(파일이 써진다).
100. **트랙 목록을 모를 때 [다시 인식]이 첫 트랙으로 바꿨다**(`TranscribeForm`) — `audioStreams ?? []`를 "그 트랙 없음"으로 봤다(probe
     읽는 중·실패). 다중 트랙 녹화를 엉뚱한 트랙으로 다시 인식해 문서를 덮을 수 있었다(드롭다운도 숨어 보이지 않는다).
     - 수정: 목록을 알 때만 첫 트랙으로 물러선다. 모르면 문서의 트랙으로 요청하고, 그 트랙이 없으면 백엔드가 거절한다(transcribe.rs).
     - 검증: e2e 68 ③(doc 창 probe 캐시의 audioStreams를 비워 흉내 → 요청 audioStream 1). 변이: 되돌리면 `[0]`으로 빨갛다.
101. **e2e 64 ⑤b 임시 파일 단언이 공유 폴더를 셌다.** 앱 로컬 데이터 `stt/`는 샤드·dev 앱이 공유해(shard.mjs), 다른 샤드의 자막
     내보내기(68 ④) 임시 파일이 보이면 제품이 멀쩡해도 빨갰다. 이제 ⑤b 전에 없던 것 중 30초 안에 사라지지 않는 것만 센다(잡 가드가
     끝나면 지운다).
102. **자막 파일 기본 이름 = 열린 영상의 stem 그대로**(`subsOutRel`, cleanStem 아님). 플레이어는 이름이 같은 자막 파일을 붙인다 —
     `talk.cut.mp4`의 자막이 `talk.srt`가 되면 제 영상엔 안 붙고 시간축이 다른 원본 `talk.mp4`에 붙었다. 이제 `talk.cut.srt`(편집본
     시각이면 `talk.cut.cut.srt`, 번역 `talk.cut.<lang>.srt`). 영상·프레임·분할 이름은 여전히 cleanStem이다(§3.6 표의 "원본 name.srt"는
     열린 영상의 이름으로 읽는다).
103. **Alt+Shift+F2 = caret이 든 cue의 번역 줄 고치기**(§3.5 키 표에 추가, 번역 줄이 보일 때만). 번역 줄은 클릭으로만 열려, 키보드로는
     "원문 바뀜"(손으로 고쳐야 풀린다, 9절 86)을 풀 길이 없었다. Alt+F2는 GNOME이 가져가서 쓰지 않았다. 번역 대상 언어·자막 파일
     번역 언어 `<select>`에 `aria-label`. e2e 64 ⑤d(키 → 입력 초깃값 = 번역 · Esc 취소).
104. **내보내기 직전 저장(flush)을 기다리는 동안 버튼을 막는다** — ExportPanel `flushing`, 대본 패널 자막 파일 저장은 `exporting`을
     flush 앞에서 켠다. 그 사이 한 번 더 누르면 ffmpeg 두 개가 같은 출력으로 돌고 두 번째 rename이 첫 결과를 덮어쓰기 확인 없이 바꿨다.
     e2e는 없다(눈에 보이는 비활성 — 변이 검증 대상 아님).

검증(2026-09-22): `cargo test --lib` 378 통과·7 무시, `tsc --noEmit`·`npm run build` 통과.
- 68 단독 23/0/0(러너 정리 포함).
- 한 앱에서 33·34·64·65·68(`E2E_NET=1`·`E2E_STT_MODEL`·`E2E_STT_WAV`·`E2E_LLM_GGUF`=Qwen3 4B) 157/0/0.
- 변이 — 한 회차(64·68)에 넷을 한꺼번에 되돌림 → 넷 다 빨갛다: 소프트 SRT 치환(되읽은 글 `C:\new <i>x</i> a<b>d.</b>`), 트랙 거절(파일이
  써짐), 트랙 목록 모를 때(요청 `[0]`), `base` 거르기(`LLM a`). 스토어가 `base`를 넘기지 않게만 바꾼 회차(64, 4B) → 실제 LLM 단언이
  빨갛다(손 번역이 LLM 답으로 덮임). 되돌린 파일은 백업과 바이트가 같다(cmp).
- 전체 `node tests/e2e/shard.mjs`(3샤드, 게이트 없음) 1569 pass / 5 fail / 18 skip, 277초. 실패 5개는 직전 회차(e2e 확장)와 같은
  클립보드 단언(52 셋 · 54 ⑥ · 60 ⑥, 모두 `클립=""`)이고, 회차 내내 화면이 잠겨 있었다(`LogonUI.exe` 같은 PID). 64·68은 전체 회차에서도
  초록(58/0/1 · 14/0/0).
