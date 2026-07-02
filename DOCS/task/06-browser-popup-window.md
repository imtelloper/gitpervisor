# 태스크 06 — 브라우저 팝업(window.open / target=_blank)을 플로팅 창으로

> 상태: 설계(Design) · 대상: gitpervisor · 산출물 성격: 아키텍처/계약/단계/위험 (구현은 후속)
> 근거: 코드 실측 2026-07-02 (repo + `%USERPROFILE%\.cargo\registry` 내 tauri 2.11.2 / wry 0.55.1 / tauri-runtime-wry 2.11.2 소스 직접 확인) · 관련: [07-browser-session-persistence.md](07-browser-session-persistence.md)(같은 browser-session 프로필 공유 전제 — 필수 상호참조), DOCS/browser-feature-design.md §6.5

## 1. 요구사항

브라우저 탭(네이티브 child webview)에서 `window.open()` / `target="_blank"` 앵커 / OAuth 로그인 팝업이 **앱 안에서 안 열린다**(현재는 OS 기본 브라우저로 빠짐). 이를 **앱의 플로팅(별도 OS) 창**으로 열리게 한다.

- 팝업 콘텐츠는 원격 페이지이므로 새 창은 격리된(권한 0) 웹뷰여야 한다.
- 핵심 유스케이스: **구글 등 OAuth 로그인 팝업** — 팝업↔오프너 간 `window.opener`/`postMessage` 관계가 유지돼야 로그인 완료 콜백이 동작한다.
- 브라우저 탭과 **같은 로그인 세션(쿠키)** 을 공유해야 한다(팝업에서 로그인 → 탭에 반영).

## 2. 현황(근거)

### 2.1 현재 팝업 처리 — OS 브라우저 위임 + Deny (그래서 "앱 안에서 안 열림")
- `src-tauri/src/commands/browser.rs:152-157` — child webview 빌더의 `.on_new_window(|url, _features| { http(s)면 open_external(...); NewWindowResponse::Deny })`. 즉 팝업 요청을 항상 거부하고 OS 기본 브라우저로 넘긴다.
- `browser.rs:100-118` — `open_external`: Windows `cmd /C start`, macOS `open`, Linux `xdg-open` (raw Command, cfg 분기).
- 이 정책의 설계 근거는 `DOCS/browser-feature-design.md` §6.5("두 번째 webview 절대 생성 금지, OS 위임")·§10 R3(다중 webview 방어) — 당시엔 `NewWindowResponse::Create` 활용을 검토하지 않았다.

### 2.2 브라우저 child webview 생성 옵션(전체 실측)
- `browser.rs:146-195` — `WebviewBuilder::new(label, WebviewUrl::External)` + `.data_directory(browser_data_dir)` + `.on_navigation(navigation_gate)` + `.on_new_window(…)` + `.on_download(…)` + `.on_page_load(…)` + `.on_document_title_changed(…)`, `win.add_child(builder, pos, size)`(:200).
- `browser.rs:84-92` — `browser_data_dir` = `app_local_data_dir()/browser-session`. 모든 브라우저 webview가 공유하는 분리 프로필(특권 main과 쿠키 격리, 탭끼리는 세션 공유).
- `browser.rs:94-98` — `navigation_gate`: `http`/`https`/`about:blank`만 허용.

### 2.3 플로팅 창 인프라(기존)
- `src-tauri/src/lib.rs:98-126` — `open_float_window`(async 커맨드): `run_on_main_thread` 안에서 `WebviewWindowBuilder::new(&app, "float-<paneId>", WebviewUrl::External(origin))` + `.decorations(false)`(커스텀 FloatTitleBar) + `.additional_browser_args(&browser_args())`.
- `lib.rs:80-89` — `browser_args()` = `BASE_BROWSER_ARGS`(+debug 시 CDP 29222). 주석: "같은 user-data 폴더를 공유하는 웹뷰는 환경 인자가 일치하지 않으면 초기화 실패"(:82-83).
- `lib.rs:315-328` — `Destroyed` 훅: `main` → `kill_all` + `browser_kill_all`, `float-*` → 해당 PTY만 `close_session`.

### 2.4 버전·feature 상태
- `src-tauri/Cargo.lock:5841-5842` tauri **2.11.2**, `:6095-6096` tauri-runtime-wry **2.11.2**, `:7909-7910` wry **0.55.1**.
- `src-tauri/Cargo.toml:25` — `tauri = { version = "=2.11.2", features = ["unstable", "image-png"] }` — 이미 핀 + `unstable` 활성(추가 Cargo 변경 불필요).

### 2.5 wry/tauri의 new-window API — 레지스트리 소스 실측 ⭐(설계의 갈림길 해소)
경로: `%USERPROFILE%\.cargo\registry\src\index.crates.io-1949cf8c6b5b557f\`

- **wry 0.55.1 `src/lib.rs`**
  - `:462-489` `enum NewWindowResponse { Allow, Create { webview: ICoreWebView2(windows)/WKWebView(mac)/webkit2gtk(linux) }, Deny }`.
  - `:493-521` `NewWindowOpener` — Windows에선 `webview: ICoreWebView2` + **`environment: ICoreWebView2Environment`**(대상 웹뷰는 오프너와 같은 environment 필수, :510).
  - `:529-538` `NewWindowFeatures { size: Option<LogicalSize>, position: Option<LogicalPosition>, opener }` — 팝업 요청의 크기/위치 힌트 포함.
  - `:1324-1330` `with_new_window_req_handler(Fn(String, NewWindowFeatures) -> NewWindowResponse)`.
- **wry 0.55.1 `src/webview2/mod.rs`(Windows 구현)**
  - `:696-786` — `add_NewWindowRequested` 등록 → `GetDeferral()` 후 `dispatch_handler`(`:1153-1163`, `PostMessageW`로 **webview hwnd의 스레드=메인 메시지 루프**에 후속 디스패치 — WebView2 재진입 데드락 회피, :763-765 주석)에서 핸들러 실행. `Create` → `SetHandled(true)` + **`SetNewWindow(&webview)`**(:771-775) — 요청된 콘텐츠가 우리가 만든 웹뷰에 렌더된다. ※ 빌더 문서주석 `:1321`의 "separate thread"는 실제 구현(메시지 루프 디스패치)과 다르다 — 구현 기준으로 설계.
  - `:781-783` — **핸들러 미등록 시 `SetHandled(true)` = 침묵 차단.** (§2.6의 원인)
  - `:133-137` — `with_environment` 제공 시 **새 environment 생성을 건너뛰고 재사용** → "browser_args 모든 창 일치" 요건은 environment를 새로 만들 때만 해당, 재사용 경로에선 원천적으로 문제없음.
  - `:615-619` — `add_WindowCloseRequested` → JS `window.close()` 시 `DestroyWindow(hwnd)`. OAuth 팝업이 완료 후 스스로 닫히는 경로가 네이티브로 처리된다.
- **tauri 2.11.2**
  - `src/webview/mod.rs:585-591` — `WebviewBuilder::on_new_window(Fn(Url, NewWindowFeatures) -> NewWindowResponse<R> + Send)`. `:239-255` `NewWindowResponse::Create { window: WebviewWindow<R> }`. `:550-576` 공식 doc 예제: **핸들러 안에서 `WebviewWindowBuilder`를 동기 `build()` 하고 `Create { window }` 반환**.
  - `src/webview/webview_window.rs:315-321` — `WebviewWindowBuilder::on_new_window`도 존재(팝업 창에 재귀 부착 가능).
  - `src/webview/webview_window.rs:1362-1401` — **`window_features(features)`**: 요청 위치/크기 반영 + **Windows `with_environment(opener.environment)`(:1378-1383)·macOS `with_webview_configuration`(:1371-1376)·Linux `with_related_view`(:1385-1399) 자동 적용** — 3플랫폼 필수 배선을 한 호출로 해결.
- **tauri-runtime-wry 2.11.2 `src/lib.rs:4907-4962`** — tauri `Create { window_id }` → 해당 창의 **첫 webview의 ICoreWebView2**를 wry `Create`로 전달. ⚠️ `:4933-4941` `get(&window_id).unwrap().webviews.first().unwrap()` — 창 생성 실패/웹뷰 부재 시 **패닉** → 핸들러에서 `build()` 실패하면 절대 `Create`를 반환하지 말 것.

### 2.6 메인 웹뷰(React + localhost iframe 프리뷰)의 팝업 — 현재 침묵 차단
- `lib.rs:186-` — main 창 빌더에 `on_new_window` 없음 → §2.5의 wry 기본 동작(`SetHandled(true)`)으로 **iframe(localhost 프리뷰) 안의 팝업도 아무 반응 없이 무시**된다.
- React 앱 자체는 `window.open`/`target="_blank"` 사용처 0건(src 전체 grep) — 앱 UI 회귀 위험 없음.

## 3. 설계(대안 비교 + 채택 근거)

### 3.1 대안 비교

| 대안 | 방식 | 판정 | 근거 |
|---|---|---|---|
| **(a) `NewWindowResponse::Create` — 채택** | 핸들러에서 `WebviewWindowBuilder`(플로팅 창) 생성 후 `Create { window }` 반환 → WebView2가 `SetNewWindow`로 콘텐츠를 그 창에 렌더 | ✅ | 네이티브 계약 그대로: `window_features`가 environment(=browser-session 프로필)·크기·위치를 자동 배선(§2.5). 창이 Tauri 레지스트리 안에 있어 라벨/수명/게이트/다운로드 정책/타이틀 통제 가능. `window.close()` 자동 닫힘(§2.5). opener 스크립트 관계 유지 기대(§6 R1). |
| (a0) `NewWindowResponse::Allow` | `SetHandled(false)` — WebView2가 자체 기본 팝업 창 생성 | ✗ | 한 줄로 "열리게"는 되지만 창이 Tauri 관리 밖: `navigation_gate` 미적용(원격 페이지가 임의 스킴/사이트로 탈출), 다운로드 정책 미적용, 아이콘/타이틀/수명주기 통제 불가. 보안 원칙(browser.rs:10-13) 위반. |
| (b) initialization script로 `window.open` 오버라이드 + 클릭 캡처 → IPC | 주입 자체는 가능(`WebviewBuilder::initialization_script`/`_for_all_frames` — tauri webview/mod.rs:868,:927 실측) | ✗ | ① `window.opener` 관계 원천 파괴(OAuth 즉사). ② `target=_blank`·중클릭·JS 위임 클릭·`rel=noopener` 등 경로 전수 커버 불가. ③ 원격 페이지 전역 오염·탐지 리스크. ④ child는 IPC 브리지가 없어(External+권한0) 통신로를 새로 뚫어야 함 — 격리 불변식 훼손. 네이티브 이벤트(a)가 있는데 JS 우회는 열등. |
| (c) OS 기본 브라우저 위임 (현행) | `open_external` + `Deny` | 폴백으로 유지 | 요구("앱 안 플로팅") 미충족 + opener 단절로 OAuth 콜백 실패 가능. 단 창 생성 실패·팝업 한도 초과 시의 안전한 폴백으로 재사용(browser.rs:100-118 그대로). |

### 3.2 채택 설계 상세

- **핸들러 실행 컨텍스트**: §2.5 실측 — Windows에선 `NewWindowRequested` 콜백이 deferral을 잡고 메인 메시지 루프에 재디스패치된 뒤 우리 핸들러를 부른다. 즉 **핸들러는 이미 메인 스레드에서, 재진입 안전 시점에 실행** → `open_float_window`(lib.rs:98-126)처럼 `async 커맨드 + run_on_main_thread`를 쓸 필요가 없고, tauri 공식 예제(§2.5)대로 **핸들러 안에서 동기 `build()`** 가 올바른 패턴이다. (플로팅 창 함정 메모의 "async+run_on_main_thread 필수"는 *IPC 커맨드에서 창을 만들 때* 이야기 — 이 경로는 커맨드가 아니다.)
- **창 구성**: 라벨 `gpv-popup-<seq>`(AtomicU64 — 동시 다중 팝업 라벨 충돌 방지), `WebviewUrl::External("about:blank")`(콘텐츠는 `SetNewWindow`가 채움 — `navigation_gate`가 about:blank 허용, browser.rs:97), `.window_features(features)`(environment·크기·위치), 크기 힌트 없으면 폴백 900×700 + center.
- **environment 재사용 = 세션 공유**: `features.opener().environment`는 child webview(browser-session 프로필)의 것 → 팝업은 **자동으로 브라우저 탭과 같은 쿠키/세션**을 쓴다(§2.5 wry :133-137 — 새 env 생성 생략). `data_directory`/`additional_browser_args`를 팝업 빌더에 **다시 지정하지 않는다**(환경이 이미 고정 — 지정하면 무시되거나 충돌 여지만 생김). → [07-browser-session-persistence.md](07-browser-session-persistence.md)가 browser-session 프로필 정책을 바꾸면 팝업도 자동 추종.
- **decorations(true) 유지**: float 터미널(`decorations(false)`+React FloatTitleBar)과 달리 팝업 콘텐츠는 원격 페이지라 우리 React chrome을 그릴 수 없다 → OS 기본 타이틀바 사용(의도된 차이). 타이틀은 `.on_document_title_changed`로 `set_title` 동기화.
- **팝업에도 동일 정책 재귀 부착**: `.on_navigation(navigation_gate)` + `.on_new_window(handle_new_window 재귀 — 팝업이 또 팝업을 열 수 있음)` + `.on_download(child와 동일: 인앱 취소 + http(s)는 OS 위임, browser.rs:160-175 미러)`.
- **팝업 폭탄 방어**: 살아있는 `gpv-popup-*` 수를 세어 상한(**8**) 초과 시 `Deny`(+ `log::warn`). 초과분을 `open_external`로 넘기면 OS 브라우저 스팸이 되므로 넘기지 않는다.
- **보안(격리 불변식 유지)**: `WebviewUrl::External` → Tauri IPC 브리지 미주입, `gpv-popup-*` 라벨은 어떤 capability에도 매칭 안 됨(기존 default.json은 `windows:["main","float-*"]` — 둘 다 `gpv-popup-*`와 불일치) → **권한 0** — browser.rs:10-13의 child와 동일 논리. CDP·throttle 인자도 오프너 env에 없으므로 미부여.
- **수명주기**: `lib.rs` Destroyed 훅의 `main` 분기에 `popup_kill_all` 추가(팝업만 남아 앱이 안 죽는 상태 방지). 개별 팝업 닫힘은 정리할 자원이 없어 no-op(레지스트리 불필요 — 카운트는 `app.webview_windows()` 라벨 prefix 스캔으로 충분).
- **메인 웹뷰(iframe 프리뷰) 팝업 — v1 범위 절단**: main 빌더에도 `on_new_window`를 달되 **`open_external` + `Deny`** 로만 개선(현재의 *침묵 차단* → *명시적 OS 위임*). 플로팅 승격은 **후속** — main의 opener environment는 **특권 프로필**이라, 팝업이 evil.com으로 내비게이트하면 특권 프로필 쿠키를 공유하는 원격 창이 생긴다. 이 보안 검토 없이 v1에 넣지 않는다(YAGNI + 격리 우선).

## 4. 계약(타입·커맨드·이벤트)

**신규 Tauri 커맨드·이벤트·프론트 변경 = 0.** 전부 Rust 내부(browser.rs + lib.rs 훅 1줄). 프론트는 이 기능의 존재를 모른다.

```rust
// src-tauri/src/commands/browser.rs — 내부 헬퍼(커맨드 아님)

const POPUP_LABEL_PREFIX: &str = "gpv-popup-";
const MAX_POPUPS: usize = 8;
static POPUP_SEQ: AtomicU64 = AtomicU64::new(0);

/// child·popup 빌더 양쪽의 .on_new_window에 부착되는 공용 본문(재귀).
/// http(s) 외 스킴 → Deny. 한도 초과 → Deny+warn. 창 생성 실패 → open_external + Deny(폴백 (c)).
/// 성공 → NewWindowResponse::Create { window }  (⚠ build 실패 시 Create 반환 금지 — §2.5 unwrap 패닉)
fn handle_new_window(
    app: &AppHandle,
    url: tauri::Url,
    features: tauri::webview::NewWindowFeatures,
) -> tauri::webview::NewWindowResponse<tauri::Wry>;

/// 팝업 플로팅 창 생성 — WebviewUrl::External("about:blank") + window_features(features)
/// + on_navigation(navigation_gate) + on_new_window(재귀) + on_download(child 정책 미러)
/// + on_document_title_changed(set_title). 크기 힌트 없으면 900×700 center.
fn build_popup_window(
    app: &AppHandle,
    features: tauri::webview::NewWindowFeatures,
) -> tauri::Result<tauri::webview::WebviewWindow>;

/// main 창 Destroyed 시 모든 gpv-popup-* 창 close — lib.rs:316-322 분기에서 호출.
pub fn popup_kill_all(app: &AppHandle);
```

```rust
// browser.rs:152-157 교체 스케치 (기존 open_external+Deny → 플로팅 승격)
.on_new_window({
    let app = app.clone();
    move |url, features| handle_new_window(&app, url, features)
})
```

- `lib.rs`: ① main 빌더에 `on_new_window(open_external + Deny)` 추가(§3.2 마지막 항목), ② Destroyed `main` 분기에 `commands::popup_kill_all(window.app_handle())` 추가.
- 후속(비 v1): `browser://popup-opened { label, url }` 이벤트(프론트 팝업 목록 UI), 팝업 URL 화이트리스트 설정, main 웹뷰 팝업의 플로팅 승격.

## 5. 단계(구현 순서)

1. **M1 — 스파이크(반나절, 갈림길 실측)**: 임시 브랜치에서 child의 `on_new_window`만 `Create` 경로로 바꿔 ① 팝업 창이 뜨는지 ② **`window.opener`/`postMessage` 보존 여부**(로컬 테스트 페이지: opener에서 open → 팝업에서 `window.opener.postMessage` → opener 수신 확인) ③ 실제 구글 OAuth 팝업 로그인 완주 ④ `window.close()` 자동 닫힘 ⑤ 타이틀 동기화를 실측. **②③이 NO면 §6 R1 완화안으로 설계 전환.**
2. **M2 — 본구현**: `handle_new_window`/`build_popup_window`/한도/폴백 + child 빌더 교체 + 팝업 빌더 재귀 부착(navigation_gate·download 정책 포함).
3. **M3 — 수명주기·메인 경로**: `popup_kill_all` + Destroyed 훅, main 빌더 `on_new_window`(OS 위임).
4. **M4 — 검증**: 수동 회귀 — github "Open in new tab", `window.open` 데모 페이지, 구글 OAuth 팝업 로그인(핵심), 팝업 폭탄 페이지(9번째 Deny), `window.close`, main 닫기 → 팝업 전멸·프로세스 잔존 없음, 07 태스크 적용 시 재시작 후 팝업이 유지된 세션을 쓰는지. ※ 팝업 webview는 CDP 미부여 env(§3.2)라 **E2E 하네스(9222)로 내부 구동 불가** → 수동 + `Page.captureScreenshot`. dev 앱은 `Start-Process` 분리 실행(메모리 준수).

규모: **S~M** — Rust ~120 LOC(browser.rs) + lib.rs ~10 LOC, 프론트 0. 위험은 코드량이 아니라 M1 실측 결과에 있다.

## 6. 위험과 완화

| # | 위험 | 심각도 | 완화 |
|---|---|---|---|
| R1 | **opener/postMessage 보존이 로컬 소스만으로 최종 검증 불가 (검증 필요)** — `SetNewWindow`+동일 environment 요건(§2.5)이 스크립트 관계 유지를 위한 계약으로 추정되나, wry 소스는 렌더 위임까지만 보여줌 | High | M1 스파이크에서 실측(1순위). **실패 시 완화안**: ① OAuth 도메인 패턴(`accounts.google.com`, `github.com/login` 등)은 팝업 대신 **같은 webview 내 내비게이션 허용** + 완료 후 원래 URL 복귀(리다이렉트형 OAuth는 opener 불필요) ② 그 외는 (c) OS 위임 유지 — 즉 현행보다 나빠지지 않음 |
| R2 | tauri-runtime-wry `unwrap` 패닉(§2.5 :4933-4941) — 창 생성 실패 후 `Create` 반환 시 앱 크래시 | High | `build()` `Err` → `open_external`+`Deny` 폴백을 계약에 명문화(§4), 리뷰 체크항목 |
| R3 | 팝업 폭탄(적대 페이지의 `window.open` 스팸) — 창 8개↑ 생성으로 리소스 고갈 | Med | `MAX_POPUPS=8` 상한 + 초과 `Deny`(OS 위임으로도 안 넘김) |
| R4 | 메인 스레드 동기 창 생성으로 메시지 루프 점유 | Low | 사용자 제스처 빈도 이벤트 + WebView2가 이미 deferral로 비동기화(§2.5) — 수용. 시작 멈춤 사례와 달리 lazy 경로 |
| R5 | main 웹뷰 팝업을 후속에서 플로팅 승격 시 **특권 프로필 공유** — 팝업이 임의 사이트로 가면 특권 env 쿠키 노출 | Med(후속) | v1은 의도적으로 OS 위임만(§3.2). 승격하려면 별도 프로필 강제 방안 검토가 선행 — 후속 태스크로 격리 |
| R6 | 07(세션 영속)과의 결합 — 프로필 폴더 이동/초기화 시 팝업 동작 변화 | Low | 팝업은 env를 **상속**하므로 07의 프로필 정책 변경에 자동 추종. 07 문서에 "팝업도 같은 프로필" 명시(상호참조 완료) |
| R7 | macOS/Linux 패리티 — `window_features`가 mac `webview_configuration`·Linux `related_view`를 자동 적용함은 소스로 확인(§2.5 :1371-1399)했으나 **동작 실측은 Windows만** | Low | 1차 Windows(기존 원칙). mac/Linux는 코드 경로가 동일하므로 회귀 스모크만 후속 |
