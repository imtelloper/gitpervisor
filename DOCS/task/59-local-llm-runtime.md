# 태스크 59 — 로컬 LLM 런타임(llama-server) + 모델 다운로드 + 설정 "AI" 페이지 + 스트리밍 채팅 IPC

> 상태: **설계** (2026-09-07) · 대상: gitpervisor · 근거: 코드 실측 2026-09-07 + 외부 실측(llama.cpp 릴리스 자산·
> HuggingFace tree API·llama-server README, 2026-09-07) · 선행: 태스크 17(획득 계층·`NativeSpec`), ffmpeg 관리형
> 다운로드(`video.rs:1370-1420`), LSP 세션 관리(`commands/lsp.rs`), 18(설정 셸), 31(`sys_info_static`) ·
> **소비자: 60(요약·잔디), 61(번역)** — 이 문서가 LLM 계약의 정본이다. 규모 **L**

## 1. 요구사항

설정에 페이지 하나를 두고 **무료 로컬 LLM을 앱 안에서 다운로드·실행**할 수 있어야 한다. 그 모델로 60(작업 요약)·
61(번역)이 동작한다. 외부 서비스·API 키 없이, 인터넷은 다운로드 때만.

받아들이는 조건:
- 설정 › **AI** 카테고리: 런타임 다운로드(크기 명시), 모델 목록(크기·권장 RAM·다운로드/삭제), 현재 상태(설치·실행·포트),
  "테스트" 버튼(짧은 응답을 스트리밍으로 표시), 고급(GPU 레이어·컨텍스트·외부 서버 URL).
- 다운로드는 진행률(%)·sha256 검증·원자 설치(`.part` → rename), 취소 가능. 실패 시 이유 토스트.
- 첫 요청 때 서버가 자동 기동(모델 로드 20~60초 — 진행 상태 표시), 유휴 10분 후 자동 종료, 앱 종료 시 종료.
- 요청은 **토큰 스트리밍**으로 프론트에 도달한다(60·61이 글자 단위로 그린다). 취소 가능.
- 이미 Ollama/LM Studio를 쓰는 사용자는 **외부 OpenAI 호환 URL**만 적어 같은 기능을 쓴다(관리형 런타임 불필요).
- 이 머신에서 못 돌릴 모델은 목록에서 **권장하지 않음** 표시(RAM/VRAM 기준, `sys_info_static`).

## 2. 현황(근거)

### 2.1 코드베이스
- **AI/LLM 통합 0건**(`openai|anthropic|ollama|llama|gguf` grep — 무관 히트뿐). 프론트에 `fetch` 사용 0, `plugin-http` 없음 —
  HTTP는 전부 Rust `reqwest 0.13`(`Cargo.toml:61`, **rustls·stream·json** 활성). `sha2`·`zip`·`tar`·`flate2` 있음(`:69-72`).
- 관리형 다운로드 선례 2개. **ffmpeg가 더 가깝다**(수백 MB): `FfArtifact{urls, sha256, kind}`·`FfmpegSpec`(`video.rs:1257-1271`),
  `download_verified`(`:1370-1420` — `resp.chunk()` 스트리밍 + 증분 sha256 + 정수 % 변화 시만 `send_progress`), 설치 루트
  `app_local_data_dir/tools/ffmpeg-<ver>/`(`:120-130`), `video_tool_ensure(on_progress: Channel<String>)`(`:1513-1525`),
  상태 `video_tool_status`(`:250-269`). LSP는 `NativeSpec{url, sha256: Option, inner_dir, exe_rel, kind}`(`lsp/acquire.rs:310-318`)
  + `.ok` 마커(`:574`) + 통짜 `.bytes()`(진행률 없음).
- 프론트 다운로드 UX = **"클릭이 곧 동의"**: `SettingsDialog.tsx:230-271`(`downloadLspServers`/`downloadFfmpeg` — phase→한국어
  상태), `CodeToolsSection.tsx:92-105, :163-178`(버튼 + 상태 줄, 크기는 안내문에), `ipc.ts:1197-1232`(호출마다 `new Channel<string>()`).
- 장수 자식 프로세스 관리 템플릿 = `commands/lsp.rs`: `LspSession{stdin, child, sink, last_activity, pid, terminated}`(`:34-45`),
  `lsp_start`(`:91-225` — CREATE_NO_WINDOW `:138-142`, unix `process_group(0)` `:143-150`, **stderr 드레인 필수** `:176-185`),
  `terminate_child`(`:348-383` — graceful→kill→wait), `kill_group`(`:399-408`, Windows는 직계만), `lsp_spawn_idle_reaper`(`:313-334`,
  60s 틱·10분 유휴), `lsp_kill_all`(`:295-310`, `lib.rs`·`health/mod.rs`가 호출), 레지스트리 `AppState.lsp`(`state.rs:46-47`).
  `spawn_launcher`(`open.rs:43-71`)는 **소유하지 않는** 프로세스용(분리·cgroup 이탈) — 여기엔 부적합. 단 Linux에서
  `systemd-run --user --scope` 위임이 자식을 앱 cgroup 밖으로 빼는 방법이라는 사실은 유용하다(2026-08 OOM 사건).
- 스트리밍 프리미티브 = `Channel<T>`: `term_open(on_data: Channel<Vec<u8>>)`(`terminal.rs:132-140`), `lsp_start(on_msg:
  Channel<String>)`. **호출마다 새 Channel**(재사용 시 영구 정지 — CLAUDE.md·`ipc.ts:1398`).
- 취소 선례: `http.rs:177-180` `HttpReg{inflight: HashMap<String, AbortHandle>}` + `http_cancel`(`:362-`).
- 설정: `Settings`(`git/types.rs:195-270`, `#[serde(default)]` → 필드 추가 하위호환), `buildCleaned`(`SettingsDialog.tsx:27-42`,
  숫자 클램프), `CATEGORIES`·`SETTINGS_INDEX`(`settings-index.ts:25-89`), 섹션 조건 렌더(`SettingsDialog.tsx:336-375`),
  프리미티브 `Field`·`Hl`·`inputCls`(`shared.tsx`). **e2e 29 `:19-22`가 사이드바 버튼을 정규식으로 6개 단언** — 카테고리 추가 시 갱신.
  `openSettings(category)` 딥링크(`ui.ts:486-488`).
- 하드웨어: `sys_info_static(force)`(`sysinfo_static.rs:150-162`, 캐시) → `memory.total_bytes`, `gpus[].vram_bytes`,
  `volumes[].available_bytes`(`:71-113`).

### 2.2 외부(2026-09-07 실측)
- llama.cpp 릴리스는 `v0.4.0` 태그 + 빌드 태그(`b10809`)로 나뉜다. **`b10809` 자산 이름(원문)**:
  `llama-b10809-bin-win-cpu-x64.zip`(18.4MB) · `llama-b10809-bin-win-vulkan-x64.zip`(35.2MB) · `llama-b10809-bin-win-cuda-12.4-x64.zip`
  (253.9MB, +`cudart-…`391MB) · `llama-b10809-bin-macos-arm64.tar.gz`(11.1MB) · `llama-b10809-bin-macos-x64.tar.gz`(11.2MB) ·
  `llama-b10809-bin-ubuntu-x64.tar.gz`(16.7MB) · `llama-b10809-bin-ubuntu-vulkan-x64.tar.gz`(33.8MB).
  URL: `https://github.com/ggml-org/llama.cpp/releases/download/<build>/<asset>`. 릴리스에 체크섬 파일은 없다 → 구현 시 1회
  다운로드해 sha256을 코드에 고정(ffmpeg 관례).
- `llama-server` 플래그(README 원문): `-m/--model`, `--host`, `--port`, `-c/--ctx-size`, `-ngl/--gpu-layers`, `--api-key`,
  `--no-webui`, `-t/--threads`. 엔드포인트: `GET /health`(준비되면 `{"status":"ok"}`, 로드 중 503), `POST /v1/chat/completions`
  (OpenAI 호환, `stream`), `GET /v1/models`, `GET /props`. router 모드(`--models-dir`)는 v1 미사용.
- HuggingFace: `https://huggingface.co/api/models/<org>/<repo>/tree/main`이 파일별 `lfs.oid`에 **sha256**을 준다(실측:
  `Qwen/Qwen3-4B-GGUF` → `Qwen3-4B-Q4_K_M.gguf` 2,497,280,256B, sha256 `7485fe6f…4fdf5`; `Qwen3-4B-Q8_0.gguf` 4,280,404,704B).
  다운로드 URL `https://huggingface.co/<org>/<repo>/resolve/main/<file>`(공개 모델은 인증 없음, CDN 리다이렉트 — reqwest 기본 follow).

## 3. 설계

### 3.1 런타임 선택

| 대안 | 평가 |
|---|---|
| **A. llama.cpp `llama-server` 바이너리를 관리형 다운로드 + OpenAI 호환 HTTP로 대화** (채택) | 단일 실행파일 12~35MB, 세 OS 공식 빌드, GPU 자동(Metal 내장·Vulkan은 벤더 무관), 스트리밍 표준(SSE). ffmpeg 선례가 곧 설치 코드 |
| B. Ollama 설치 안내 후 `localhost:11434` 사용 | 앱 안 다운로드 요구 미충족. **단 외부 URL 모드로 흡수**(§3.6) — 이미 쓰는 사용자에게 0 설치 |
| C. Rust 인프로세스 추론(llama-cpp-rs/candle) | CMake·CUDA 빌드 의존, CI 매트릭스 3종 붕괴 위험, 크래시가 앱을 죽인다. 기각 |
| D. CUDA 빌드 | 254+391MB. Vulkan이 NVIDIA에서도 돈다. 기각(§7) |

플랫폼별 자산: **Windows = vulkan-x64**(실패 시 cpu-x64 자동 폴백, §3.3) · **macOS = arm64/x64**(Metal) · **Linux = ubuntu-x64(CPU)**
(vulkan은 libvulkan 의존 — v1 제외). 빌드 태그 상수 `LLAMA_BUILD = "b10809"` + 자산별 sha256 코드 고정.

### 3.2 파일 배치

```
app_local_data_dir/llm/
  llama-b10809/            # 압축 해제(inner_dir 없음 — zip은 평탄, tar.gz는 build/bin/ — (검증 필요))
    llama-server(.exe), *.dll/.dylib/.so
    .ok                    # 설치 완료 마커(버전)
  models/
    Qwen3-4B-Q4_K_M.gguf
    <name>.gguf.part       # 다운로드 중(재시작 시 삭제)
```
`ffmpeg`와 같은 루트 규칙(`app_local_data_dir/tools`가 아니라 `llm/`로 분리 — 모델이 GB 단위라 "유지보수 › 캐시 삭제" 대상이 된다).

### 3.3 Rust — `src-tauri/src/llm/` (mod.rs · acquire.rs · server.rs · chat.rs)

**획득(`acquire.rs`)** — ffmpeg 코드 이식:
```rust
pub struct Artifact { url: &'static str, sha256: &'static str, size: u64, kind: ArchiveKind /* Zip|TarGz */ }
fn runtime_spec() -> Artifact                  // cfg(target_os, target_arch)
pub struct ModelSpec { id: &'static str, label: &'static str, repo: &'static str, file: &'static str, sha256: &'static str,
                       size: u64, min_ram: u64, note: &'static str }
pub const MODELS: &[ModelSpec] = &[ /* §3.5 */ ];
async fn download_verified(client, url, sha256, size, dest, on_progress, cancel: CancellationToken) -> Result<(), IpcError>
```
- 진행 이벤트: `{"name": "runtime"|"<modelId>", "phase": "download"|"verify"|"extract"|"done"|"error", "percent", "message"}`
  (ffmpeg `send_progress` 형식과 동일 — `SettingsDialog`의 phase 매핑을 재사용).
- 취소: `AppState.llm_downloads: Mutex<HashMap<String, CancellationToken>>`(`tokio_util` 없으면 `AbortHandle` — http.rs 관례).
  취소 시 `.part` 삭제.
- 디스크 선검사: `sys_info_static` 캐시의 `volumes`에서 설치 루트 볼륨 `available_bytes < size * 1.05`면 즉시 Err("여유 공간 부족: 필요 2.6GB / 남음 1.1GB").
- 커맨드: `llm_runtime_ensure(on_progress)`, `llm_model_download(model_id, on_progress)`, `llm_download_cancel(name)`,
  `llm_model_delete(model_id)`(서버가 그 모델을 물고 있으면 먼저 stop), `llm_status() -> LlmStatus{runtime: Option<version>,
  models: Vec<{id, present, path, size}>, server: Option<{model, port, ready}>, custom_model_ok: bool}`.

**서버(`server.rs`)** — `lsp_start` 이식, 단일 세션:
```rust
pub struct LlmSession { child: Mutex<Child>, pid: u32, port: u16, api_key: String, model: String,
                        last_activity: Mutex<Instant>, ready: AtomicBool, terminated: AtomicBool }
AppState.llm: Mutex<Option<LlmSession>>     // lsp 옆
async fn ensure_server(app, state) -> Result<(u16 /*port*/, String /*key*/), IpcError>
```
- 기동: 빈 포트는 `TcpListener::bind("127.0.0.1:0")`로 얻어 즉시 drop(경쟁 시 재시도 3회). `api_key`는 32바이트 난수 hex —
  **다른 로컬 프로세스가 이 서버를 못 쓰게** 한다(llama-server는 기본 무인증). 인자:
  `-m <gguf> --host 127.0.0.1 --port <p> -c <ctx> -ngl <gpu_layers> -t <physical_cores.max(1)> --api-key <key> --no-webui`.
  stdio: stdout/stderr **드레인 스레드**(로그 tail 50줄을 `Mutex<VecDeque>`에 보관 — 기동 실패 시 에러 메시지에 붙인다).
  Windows `CREATE_NO_WINDOW`, unix `process_group(0)`. **Linux는 `systemd-run --user --scope --quiet` 접두**(있을 때) — 모델
  mmap이 앱 cgroup 메모리로 집계돼 oomd가 앱을 통째로 죽이는 경로를 끊는다(CLAUDE.md의 사건). scope 모드에서 pid는 여전히 우리
  자식이라 `terminate_child`가 그대로 닿는다 (검증 필요: `systemd-run --scope`가 exec 체인을 유지하는지 — open.rs
  `try_delegate_to_systemd`가 같은 전제).
- 준비 대기: `GET /health`를 500ms 간격, **모델 크기 GB당 30초 + 30초** 상한(HDD 고려). 503 = 로딩 중. 상한 초과·프로세스 종료 →
  `Err(ErrorCode::Io, "모델 로드 실패: " + stderr tail)`. 준비 전 진행은 커맨드가 `Channel`로 `{"phase":"loading"}`를 보낸다.
- **Windows Vulkan 폴백**: 기동이 stderr에 `vulkan`·`failed to initialize` 류로 실패하거나 20초 내 프로세스가 죽으면, cpu-x64 zip을
  `llama-b10809-cpu/`에 추가 다운로드(18MB, 진행 이벤트 `name:"runtime-cpu"`)해 그것으로 재기동, 설정 `llmBackend="cpu"`를 기억.
  이 분기가 이 태스크의 유일한 (검증 필요) 자동 복구 경로다.
- 모델 전환: 설정의 모델이 세션과 다르면 stop → start. 설정 저장(`set_settings`) 자체는 서버를 건드리지 않는다(다음 요청 때 반영).
- 유휴 종료: `llm_spawn_idle_reaper` — LSP 리퍼 복제(60s 틱, 10분). `llm_kill_all(&state)` — `lsp_kill_all` 호출 지점 2곳 옆에 추가.
- 외부 URL 모드(§3.6)면 `ensure_server`는 `(url, key?)`를 그대로 돌려준다 — 프로세스 없음.

**채팅(`chat.rs`)**:
```rust
#[derive(Deserialize)] pub struct ChatMsg { role: String, content: String }
#[derive(Deserialize)] pub struct ChatReq { messages: Vec<ChatMsg>, max_tokens: Option<u32>, temperature: Option<f32>,
                                            request_id: String }
#[derive(Serialize)]   pub struct ChatDone { text: String, prompt_tokens: u32, completion_tokens: u32, truncated: bool }
#[tauri::command] pub async fn llm_chat(app, state, req: ChatReq, on_token: Channel<String>) -> Result<ChatDone, IpcError>
#[tauri::command] pub fn llm_cancel(state, request_id: String)
```
- `ensure_server` → `POST {base}/v1/chat/completions` `{model, messages, stream: true, max_tokens, temperature,
  chat_template_kwargs: {"enable_thinking": false}}`(Qwen3 사고 모드 차단 — 요약·번역에 불필요하고 토큰을 태운다; 다른 모델은 무시)
  → `bytes_stream()`을 줄 단위로 나눠 `data: {...}`의 `choices[0].delta.content`를 **그대로** `on_token.send`(빈 문자열은 생략),
  `[DONE]`에서 종료, `finish_reason == "length"`면 `truncated: true`. `usage`는 마지막 청크(있으면).
- 동시성: **v1은 한 번에 한 요청** — `AppState.llm_inflight: Mutex<Option<(String /*request_id*/, AbortHandle)>>`; 진행 중이면
  `Err(ErrorCode::Busy, "다른 AI 요청이 진행 중입니다")`. 서버도 `-np 1`(기본). 60의 배치는 프론트가 직렬로 돈다.
- 타임아웃 10분(요약 최대). `last_activity` 갱신은 요청 시작·토큰마다.
- 헤더 `Authorization: Bearer <api_key>`(관리형) / 외부 URL 모드는 설정의 키(없으면 생략).

### 3.4 프론트 계약 — `src/lib/llm.ts` (60·61은 이것만 import)

```ts
export type ChatMsg = { role: "system" | "user" | "assistant"; content: string };
export interface ChatOpts { maxTokens?: number; temperature?: number; signal?: AbortSignal }
/** 토큰이 올 때마다 onToken(누적 아님, 델타). 완료 시 전체 텍스트. 취소는 signal → llm_cancel. */
export async function chat(messages: ChatMsg[], onToken: (delta: string) => void, opts?: ChatOpts): Promise<ChatDone>
export function useLlmStatus()              // ["llm-status"], staleTime 5s, 설정 페이지·60·61의 "준비 안 됨" 안내에 사용
export function llmReadyReason(status, settings): string | null   // null=사용 가능, 아니면 사용자에게 보일 이유("모델을 다운로드하세요" 등)
```
- `chat`은 호출마다 `new Channel<string>()`, `request_id = crypto.randomUUID()`, `signal.abort` → `ipc.llmCancel(id)`.
- 프롬프트 언어: 설정 `llmLanguage`(§3.6) — 60·61이 시스템 프롬프트에 넣는다. `lib/llm.ts`가 `langName()` 헬퍼 제공.
- 스토어 없음 — 상태는 react-query(`llm-status`)와 호출자 로컬 state.

### 3.5 모델 카탈로그(v1)

| id | 파일 | 크기 | 권장 | 비고 |
|---|---|---|---|---|
| `qwen3-4b-q4` **(기본)** | `Qwen/Qwen3-4B-GGUF` · `Qwen3-4B-Q4_K_M.gguf` | 2.50GB | RAM ≥ 8GB | sha256 실측 `7485fe6f…`. 한국어·코드 양호, Apache-2.0 |
| `qwen3-1.7b-q8` | `Qwen/Qwen3-1.7B-GGUF` · `Qwen3-1.7B-Q8_0.gguf` | ≈1.8GB | RAM ≥ 6GB | 저사양. 파일명·해시 (검증 필요 — 구현 시 tree API로 고정) |
| `qwen3-8b-q4` | `Qwen/Qwen3-8B-GGUF` · `Qwen3-8B-Q4_K_M.gguf` | ≈5.0GB | RAM ≥ 12GB 또는 VRAM ≥ 6GB | 품질 우선. (검증 필요) |
| `custom` | 설정의 절대경로 `.gguf` | — | — | 어떤 GGUF든. 존재·확장자만 검사 |

- **2026-09-21(태스크 70)에 2종이 늘어 5종이다** — `qwen3-4b-2507-q4`(bartowski, 2.33GB)·
  `gemma4-e4b-qat-q4`(google, 4.80GB). 근거·실측·탈락한 후보는 `70-llm-model-catalog-2026-09.md`.
- 제외: EXAONE(비상업 라이선스), Llama(라이선스 고지 의무), **Gemma 3**(게이트가 아니라 **라이선스**가
  사유다 — 커뮤니티 미러는 무게이트다. 70 §3). **Gemma 4는 Apache-2.0·무게이트라 들어왔다.**
  카탈로그는 `MODELS` 배열 하나 — 항목 추가 = 한 줄.
- 권장 판정(프론트, `sys_info_static`): `vram ≥ size*1.15` → "GPU 전체 오프로드 가능", 아니면 `ram ≥ size*1.3 + 1GB` → "CPU/부분",
  둘 다 미달 → "권장하지 않음"(다운로드 버튼은 살려 둔다 — 사용자가 안다).

### 3.6 설정

`Settings` 신규 필드(`#[serde(default)]`):
```rust
llm_provider: String,          // "managed" | "external"   기본 "managed"
llm_model: String,             // 카탈로그 id 또는 "custom"  기본 "qwen3-4b-q4"
llm_custom_model_path: Option<String>,
llm_external_url: Option<String>,   // 예: http://localhost:11434/v1
llm_external_model: Option<String>, // 외부 서버의 모델 이름(예: qwen3:4b)
llm_external_key: Option<String>,   // 시크릿이지만 로컬 서버용 — 키링 미사용(§7)
llm_gpu_layers: u32,           // 기본 99
llm_context: u32,              // 기본 8192 (클램프 2048..32768)
llm_language: String,          // "ko" | "en"  기본 "ko" — 요약·번역 기본 언어
llm_backend: String,           // "auto" | "cpu" — Windows Vulkan 폴백이 기록
```
- `CATEGORIES`에 `{ id: "ai", label: "AI", icon: Sparkles }`(업데이트 앞). `SETTINGS_INDEX`에 위 10키 + 즉시 액션 4개
  (`llmRuntimeDownload`·`llmModelDownload`·`llmTest`·`llmDeleteModels`). `buildCleaned`에 `llmContext` 클램프·문자열 trim→null.
- **e2e 29 `:19-22` 갱신**: 정규식에 `|AI`, `=== 7`. 유지보수 섹션의 hidden 마운트(I1)처럼 AI 섹션도 **다운로드 진행 중 카테고리를
  옮겨도 상태를 잃지 않게** 진행 상태는 `SettingsDialog` 셸 state에 둔다(ffmpeg `ffmpegBusy/Status`와 같은 층).
- `AiSection.tsx`(신규): ① 상태 카드(런타임 b10809 설치됨/없음 · 모델 N개 · 서버 실행 중 port/유휴) ② 런타임 다운로드 버튼
  ("런타임 다운로드 (35MB)") ③ 모델 표(카탈로그 4행: 이름·크기·권장 뱃지·[다운로드 %]/[삭제]) ④ 테스트 버튼("테스트" → 시스템
  프롬프트 없이 "안녕하세요. 한 문장으로 자기소개해 주세요." → 결과 스트리밍 표시, 첫 실행이면 로드 진행 표시) ⑤ 고급 접기: provider
  라디오, 외부 URL/모델/키, GPU 레이어·컨텍스트, 언어. 다운로드 버튼은 "클릭이 곧 동의" 관례 — 크기·출처(`huggingface.co/Qwen`)를
  버튼 옆 한 줄에.

## 4. 변경 목록

| 파일 | 변경 | 규모 |
|---|---|---|
| `src-tauri/src/llm/{mod,acquire,server,chat}.rs` | 신설 | ≈ +520 |
| `src-tauri/src/state.rs` | `llm`, `llm_inflight`, `llm_downloads` 필드 | +6 |
| `src-tauri/src/git/types.rs` | Settings 10필드 + Default | +24 |
| `src-tauri/src/lib.rs` | 등록 7커맨드, 리퍼 spawn, `llm_kill_all` 2곳 | +12 |
| `src/lib/ipc.ts` | 타입·바인딩 7 | ≈ +70 |
| `src/lib/llm.ts` | 계약 §3.4 | ≈ +80 |
| `src/components/settings/sections/AiSection.tsx` | 신설 | ≈ +220 |
| `src/components/settings/{SettingsDialog.tsx,settings-index.ts}` | 카테고리·인덱스·핸들러·클램프 | ≈ +60 |
| `tests/e2e/suites/29-settings-ux.mjs` | 7카테고리 | 2줄 |
| `tests/e2e/suites/47-llm-runtime.mjs` | 신설(§5) | ≈ +90 |

## 5. 검증

### 5.1 e2e 47(네트워크 필요 — `E2E_NET=1`일 때만, 아니면 skip)
1. `llm_status` → runtime null이면 `llm_runtime_ensure` 실행(Channel 진행 이벤트 수신, `percent` 단조 증가) → `.ok` 존재.
2. 모델은 **다운로드하지 않는다**(2.5GB). 대신 러너 픽스처의 소형 GGUF(예: `tinyllama`급 ~600MB는 여전히 크다 → **`custom` 경로에
   테스트용 최소 GGUF**를 CI 캐시에서 주입; 없으면 3~5 skip).
3. `llm_chat({messages:[user:"Reply with the single word OK"]})` → 토큰 ≥ 1 수신, `ChatDone.text` 비어 있지 않음, 두 번째 호출은
   서버 재사용(포트 동일), `llm_status.server.ready`.
4. 진행 중 `llm_cancel` → 첫 호출 Err(Cancelled) 후 즉시 다음 호출 가능.
5. 설정 모달: AI 카테고리 버튼 존재, 완전성 가드(29 ⑤) 통과, `llmContext` 100 입력 → 저장값 2048(클램프).
6. finally: `llm_stop` — 프로세스 부재 확인(`sys_process_snapshot`에 `llama-server` 없음).

### 5.2 실기
- Windows(이 머신: Vulkan GPU): 런타임 35MB + Qwen3-4B 2.5GB 다운로드 % 표시·취소·재개(재시작 후 `.part` 삭제) → 테스트 버튼
  첫 응답까지 시간·토큰/s 기록. `nvidia-smi`/작업관리자에서 VRAM 점유 확인. 유휴 10분 후 프로세스 소멸. 앱 종료 시 소멸(고아 0).
- Vulkan 폴백: 환경변수 `VK_ICD_FILENAMES=`로 Vulkan을 죽인 채 기동 → cpu 빌드 자동 다운로드·재기동.
- 외부 모드: Ollama `http://localhost:11434/v1` + `qwen3:4b` → 테스트 통과, 관리형 프로세스 0.
- Linux: `systemd-cgls`로 llama-server가 앱 scope 밖(별도 `run-*.scope`)에 있는지 — CLAUDE.md의 cgroup 계수 방법.
- 메모리 경보(`healthAlert`)가 모델 로드 중 오탐하지 않는지(RSS 급증) — 오탐이면 60의 배치 실행 시 경보 억제 창(§7).

## 6. 위험

- **공급망**: 릴리스 zip에 체크섬이 없어 최초 1회 수동 해시 고정 — LSP·ffmpeg와 같은 수준. HF는 tree API sha256이 있어 더 낫다.
- **메모리**: 4B Q4 = 2.5GB mmap + KV 8k ctx ≈ 1GB. 앱의 OOM 이력(Linux)은 scope 분리로 완화, Windows/mac은 OS가 페이지 캐시로 다룬다.
  경보 오탐 가능성은 실기 항목.
- **Vulkan 없는 Windows(RDP·VM)**: 자동 폴백 경로가 (검증 필요).
- **한 번에 한 요청**: 60 배치 중 61 번역을 누르면 Busy — 프론트가 "대기 중" 표시 후 순차 실행(61 §3).
- 첫 요청 지연 20~60초 — 모든 호출자가 `phase:"loading"` 진행을 그려야 한다(계약 §3.4의 `onProgress`는 `chat` 옵션에 포함).

## 7. 열린 질문

| 질문 | 기본값 |
|---|---|
| CUDA 빌드 옵션(NVIDIA 전용 속도) | 제외 — Vulkan으로 충분, 645MB. 요청 시 `llmBackend:"cuda"` + 자산 2개 |
| 카탈로그 기본 모델 4B vs 8B | 4B(8GB RAM 머신 기준). 이 머신(63GB)은 8B 권장 뱃지 |
| 외부 키를 OS 키링에 | 아니오 — 로컬 서버 키. 원격 OpenAI 호환 서비스를 넣기 시작하면 키링(`notifySetSecret` 관례) |
| 모델 삭제 시 확인창 | 예(`askConfirm`, GB 단위 재다운로드) |
| 동시 요청 2개(`-np 2`) | 아니오 — 컨텍스트 메모리 2배. 60·61이 직렬로 충분 |
| Linux Vulkan 자산 | 후속(libvulkan 존재 검사 필요) |

## 8. 구현 결과 (2026-09-07~08)

**구현 완료 · 정적 검증 통과(미커밋).** 설계대로 A안 — llama.cpp `llama-server` 관리형 다운로드 + OpenAI 호환 HTTP.

- Rust `src-tauri/src/llm/{mod,acquire,server,chat}.rs` 신설. 커맨드 8개(설계의 7 + `llm_stop`),
  `ErrorCode::Busy` 추가, `Settings` +10필드, `AppState` +3필드, 종료 훅·유휴 리퍼 배선.
- **해시는 전부 고정했다**(설계의 "(검증 필요)" 해소). 런타임 5종은 실제로 받아 `Get-FileHash`로,
  모델 3종은 HF `tree` API의 `lfs.oid`로:

| 자산 | 바이트 | sha256(앞 12) |
|---|---|---|
| `llama-b10809-bin-win-vulkan-x64.zip` | 35,221,385 | `97e50b3ef0cd` |
| `llama-b10809-bin-win-cpu-x64.zip` | 18,407,457 | `9df3158ed228` |
| `llama-b10809-bin-macos-arm64.tar.gz` | 11,123,196 | `7d692df9e1e3` |
| `llama-b10809-bin-macos-x64.tar.gz` | 11,175,330 | `13b34aa8a5d8` |
| `llama-b10809-bin-ubuntu-x64.tar.gz` | 16,734,586 | `5e34434ddc6d` |
| `Qwen3-4B-Q4_K_M.gguf` | 2,497,280,256 | `7485fe6f11af` |
| `Qwen3-1.7B-Q8_0.gguf` | 1,834,426,016 | `061b54daade0` |
| `Qwen3-8B-Q4_K_M.gguf` | 5,027,783,488 | `d98cdcbd03e1` |

- **`inner_dir` 확정**(§3.2의 추측 정정): Windows zip은 평탄(`None`), mac/linux tar.gz는 `llama-b10809/`
  아래에 있다 — 설계가 짐작한 `build/bin/`이 **아니다**.
- 프론트 `lib/llm.ts`(계약 §3.4 그대로) · 설정 AI 카테고리·`AiSection` · e2e 47(네트워크 게이트).

**적대적 리뷰(2026-09-08)에서 확정돼 고친 것 — 둘은 이 기능을 실제로 못 쓰게 만드는 것이었다:**

| 지적 | 수정 |
|---|---|
| **(높음)** 외부 서버 모드가 `/v1`을 **두 번** 붙인다 — 설정 힌트·플레이스홀더·타입 주석이 전부 "URL에 `/v1`을 넣으라"고 안내하는데 `chat.rs`가 다시 `/v1/chat/completions`를 이어 붙여 Ollama·LM Studio가 404를 낸다. §1의 외부 서버 수용 조건이 **도달 불가**였다 | `normalize_base()`가 끝의 `/`와 `/v1`을 벗기고, 힌트를 "끝의 /v1은 있어도 없어도 됩니다"로. 네 가지 표기가 같은 URL로 가는 테스트 |
| **(높음)** SSE 본문을 **네트워크 청크마다** `from_utf8_lossy`로 디코드해, 청크 경계에 걸친 멀티바이트 문자가 U+FFFD로 파괴된다 — **한국어 출력이 정상 경로**인 기능이라 이론이 아니다 | 버퍼를 `Vec<u8>`으로 바꿔 `\n`을 **바이트로** 자르고 완성된 줄만 디코드, 미완성 꼬리는 이월. `안`의 3바이트 한가운데를 자르는 테스트 |
| (중) Vulkan→CPU 폴백이 `llm_backend="cpu"`를 저장해도 프론트 `["settings"]`가 안 바뀌어, 열려 있던 설정 폼이 다음 저장에 `"auto"`를 덮어쓴다 — 폴백이 **기억되지 않는다** | 폴백이 `settings://changed` emit → `attachRepoEvents`가 `["settings"]` 무효화(`repo://remote-freshness`와 같은 "이벤트=신호, 진실=재조회") |
| (중) 그 폴백 다운로드가 채팅 진행 채널에 `{name,phase,percent}`를 실어 보내는데 타입은 `{phase:"loading",seconds}`뿐이라 UI가 "모델 로드 중… (undefined초)"를 그린다 | `LlmChatProgress`를 판별 유니온으로 + `progressMessage()` 렌더러 |
| (중) `.part` 잔여 파일을 아무도 치우지 않는다(§3.2가 "재시작 시 삭제"라고 적어 둔 것) | `sweep_stale_downloads()` — 진행 중 다운로드가 있으면 건너뛴다 |
| (중) 여유 공간 검사가 **프로세스 수명 캐시**를 읽어, 한 번 부족했으면 재시작 전까지 모든 다운로드가 거짓 거절된다 | `sysinfo::Disks`를 직접 조회(동기·항상 최신) |
| (중) 죽은 연결에서 다운로드가 **영원히 매달리고**, 그 이름의 등록이 안 풀려 이후 같은 이름이 영구히 Busy가 된다 | `connect_timeout(30s)`+`read_timeout(60s)`(전체 timeout은 금지 — GB 다운로드), 청크 루프를 `select!`로 즉시 취소. `DownloadGuard(Drop)`는 이미 모든 종료 경로를 덮고 있었고 문제는 "퓨처가 안 끝나는 것"이었다 |
| (낮음) custom 모델 경로 판정이 두 곳에서 어긋난다(`status`는 `.gguf` 요구, `resolve_model`은 아무 파일이나 수용) | `acquire::custom_model()` 한 곳으로 통일 |
| (낮음) 시스템 정보 로딩 중 모든 모델이 "권장 안 함" 뱃지 · 런타임 취소 버튼이 `runtime-cpu`를 못 끊는다 | 뱃지는 데이터 없으면 미표시, 취소는 두 이름 다 |
| (중, e2e) 스위트 47 ①의 `timeoutMs: 600000`이 **60초에서 거짓 실패**한다(`Cdp.try`가 `timeoutMs`를 `eval`에 안 넘긴다) | 스위트 쪽에서 `startInvoke` + 슬롯 폴링으로 교체(공유 헬퍼는 안 건드림) |

**미검증(§5.2 실기 — 전부 남음)**: 실제 `llama-server` 기동·모델 로드·토큰 처리량, Vulkan→CPU 폴백,
Linux `systemd-run --scope` 위임, 유휴 리퍼·앱 종료 시 고아 0, `.part` 정리, e2e 47(`E2E_NET=1` + 런타임 35MB 필요).
런타임·모델을 받지 않은 상태에서는 60·61도 "LLM 미준비" 경로만 검증된다.
