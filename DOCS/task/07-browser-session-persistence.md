# 태스크 07 — 브라우저 로그인 세션 유지 (gmail 재로그인 제거)

> 상태: 설계(Design) · 대상: gitpervisor · 산출물 성격: 아키텍처/계약/단계/위험 (구현은 후속) · 근거: 코드 실측 2026-07-02

## 1. 요구사항

- 임베디드 브라우저에서 gmail 등에 한 번 로그인하면 **기억**한다.
- **다른 새 터미널(=새 브라우저 패널)** 에서 재로그인 없이 로그인 상태가 이어진다.
- 앱을 껐다 켜도 유지된다(일반 브라우저와 동일한 기대).

## 2. 현황(근거)

### 2.1 프로필(데이터 폴더)의 실제 격리 단위 — 핵심 실측

- 브라우저 child webview의 데이터 폴더는 **모든 탭·패널이 공유하는 단일 영속 폴더**다:
  `browser_data_dir()` = `app_local_data_dir()/browser-session` — `src-tauri/src/commands/browser.rs:86-92`.
  주석에도 "모든 브라우저 webview가 공유하는 분리된 데이터 폴더 … (브라우저 탭끼리는 로그인 세션을 공유한다.)"라고 명시 — `browser.rs:84-85`.
- `data_directory` 적용 지점은 리포 전체에서 **`browser.rs:148` 단 한 곳**(`browser_open`의 WebviewBuilder). 즉 탭별/창별로 다른 폴더를 쓰는 경로는 없다.
- 실경로: `%LOCALAPPDATA%\com.greathoon.gitpervisor\browser-session` (identifier — `src-tauri/tauri.conf.json:5`). 임시 폴더가 아니며, 이 폴더를 삭제하는 코드도 없다(`browser_kill_all`은 webview `close()`만 — `browser.rs:350-365`; `remove_dir` 계열 grep 결과 브라우저 폴더 대상 없음).
- **유일한 예외**: `app_local_data_dir()` 실패 시 `std::env::temp_dir()` 폴백 — `browser.rs:90`. 이 경우에만 세션이 임시 폴더로 새어 유실될 수 있다.

**결론: "data_directory 격리가 재로그인의 직접 원인"이라는 가설은 기각.** 격리는 특권 main webview ↔ 브라우저 사이(보안 경계, `browser.rs:10-13`)이지 탭 사이가 아니다. 탭↔탭 세션 공유와 재시작 지속은 Windows에서 이미 구조적으로 지원된다(§2.4).

### 2.2 창 종류별 웹뷰 생성 경로 전수

| 생성 경로 | 위치 | 프로필 |
|---|---|---|
| main 창(앱 UI) | `src-tauri/src/lib.rs:186-204` | 기본 user-data 폴더(브라우저와 분리) |
| 플로팅 터미널 창 `float-<paneId>`(앱 UI) | `lib.rs:99-126` — `data_directory` 미설정 | main과 동일 기본 폴더. 브라우저 child를 붙이는 코드 없음 |
| 브라우저 child webview | `browser.rs:146-200` — **main 창에만** `add_child`(`get_window("main")` `browser.rs:142-144`, `add_child` `browser.rs:200`) | `browser-session` 공유 |
| localhost iframe 모드 | `src/components/workspace/BrowserPane.tsx:330-336` | main webview 프로필(이번 태스크 대상 외 — gmail 등 외부는 native 모드) |

- 같은 user-data 폴더를 공유하는 웹뷰는 **환경 인자가 일치**해야 한다(`lib.rs:82-89` 주석 + 메모리 노트). 브라우저 child들은 `additional_browser_args` 미지정 → 전부 wry 기본 인자로 상호 일치(문제 없음). main 창의 `BASE_BROWSER_ARGS`/debug CDP 포트는 폴더가 달라 무관.
- 새 브라우저 패널의 id는 매번 새로 발급되지만(`src/stores/browser.ts:154`의 `crypto.randomUUID()`; `src/lib/browser.ts:26-33`은 발급된 id를 받아 생성만) 폴더는 같으므로 쿠키는 공유된다. 패널이 닫히면 webview만 dispose되고 디스크 데이터는 남는다(`browser.ts:58-66, 80-87`).

### 2.3 그런데 왜 재로그인을 겪는가 — 원인 후보

| # | 원인 | 근거 | 확실성 |
|---|---|---|---|
| C1 | **OAuth/window.open 팝업을 OS 브라우저로 위임** — 팝업형 로그인("Google로 로그인" 등)은 OS 브라우저에서 완료되고 쿠키가 임베디드 프로필로 돌아오지 않음 | `browser.rs:150-157` `on_new_window` → `open_external` + Deny | 확정(구조) |
| C2 | **구글의 임베디드 웹뷰 로그인 차단**(403 `disallowed_useragent` / "이 브라우저는 안전하지 않습니다") — 로그인 자체가 실패하면 "기억"이 성립 불가 | WebView2 기본 UA로 gmail 로그인 가능 여부 미실측 | 추정(검증 필요, §5-1) |
| C3 | temp 폴백으로 프로필이 임시 폴더에 생성 | `browser.rs:90` | 가능(드묾) |
| C4 | 세션(비영속) 쿠키 사이트 — 마지막 브라우저 webview가 닫히면 in-memory 쿠키 소실 | dispose 경로 `browser.ts:80-87` | 확정(단, gmail은 영속 쿠키라 비해당) |
| C5 | 비정상 종료 시 Chromium 쿠키 flush 유실 | 추정(Chromium은 주기 flush) | 추정 |

- gmail **직접** 로그인(mail.google.com → accounts.google.com 전면 리다이렉트)은 C1 경로를 타지 않는다. C1은 서드파티 사이트의 팝업형 SSO에 해당.
- 원 설계 문서도 세션 격리 결정안 A(별도 user-data-dir)와 "브라우저 데이터 지우기" 액션을 예정했으나 후자는 미구현 — `DOCS/browser-feature-design.md:334`, 로그인 세션이 WebView2 폴더 소관임은 `:348`.

### 2.4 플랫폼별 지속성 (wry 0.55.1 소스 실측)

- **Windows**: `data_directory`가 WebView2 환경의 user data folder로 그대로 사용됨 — `wry-0.55.1/src/webview2/mod.rs:287-291, 343-345`(`CreateCoreWebView2EnvironmentWithOptions`). 쿠키/localStorage/IndexedDB가 이 폴더에 지속, 같은 폴더의 웹뷰는 세션 공유. **지속+공유 확정.**
- **Linux(webkitgtk)**: `WebsiteDataManager(base_data_directory)` + `<data_directory>/cookies`에 영속 쿠키 — `wry-0.55.1/src/webkitgtk/web_context.rs:32-48`. **지속 확정.**
- **macOS(WKWebView)**: `data_directory`는 세션 저장에 **사용되지 않는다**. incognito가 아니고 `data_store_identifier`(macOS 14+/iOS 17+)가 없으면 `defaultDataStore` — `wry-0.55.1/src/wkwebview/mod.rs:225-247`. 즉 macOS에선 지속은 되지만 **main webview와의 세션 격리가 성립하지 않는다**(격리 갭). 격리하려면 `WebviewBuilder::data_store_identifier([u8;16])`(`tauri-2.11.2/src/webview/mod.rs:1088`) 사용(macOS 14+ 한정, 검증 필요).

### 2.5 이번 설계에 쓰는 Tauri API 존재 확인

- `WebviewBuilder::user_agent(&str)` — `tauri-2.11.2/src/webview/mod.rs:940`.
- `Webview::clear_all_browsing_data()` — `tauri-2.11.2/src/webview/mod.rs:2123`; Windows 구현은 `ICoreWebView2Profile2.ClearBrowsingDataAll` = **프로필 전체 삭제** — `wry-0.55.1/src/webview2/mod.rs:1719-1731`.

## 3. 설계(대안 비교 + 채택 근거)

### 3.1 프로필 구조 — "공유 지속 프로필 1개" 유지를 계약으로 승격

| 대안 | 내용 | 판정 |
|---|---|---|
| A. 탭별 프로필 | 탭마다 폴더 분리 | **기각** — 요구(세션 공유)의 정반대 |
| B. 프로젝트/계정별 다중 프로필 | 계정 분리 가능 | **기각(후속)** — 요구는 "한 번 로그인"뿐. 프로필 선택 UI·수명 관리가 붙는 확장이며, 도입 시에도 변경점은 `browser_data_dir()` 한 곳(§2.1)이라 지금 준비할 것이 없다(YAGNI) |
| C. 공유 지속 프로필 1개(현행) | 모든 브라우저 webview가 `browser-session` 공유 | **채택** — 이미 동작 구조. 이번 태스크는 이를 명문 계약으로 승격하고 실패 경로를 막는 것 |

폴더 개명/이동(`browser-profiles/default`)은 **비채택**: 기능 이득 0에 마이그레이션(기존 로그인 유실) 리스크만 추가. 다중화 시점에 함께 이동한다(후속).

### 3.2 조치 목록 (원인 ↔ 대책)

- **F1 (C3) temp 폴백 제거**: `browser_data_dir`를 `Result`로 바꾸고 `app_local_data_dir` 실패 시 `browser_open`이 에러를 반환. "조용히 임시 프로필로 새는" 세션 증발을 차단.
- **F2 (C2) gmail 로그인 실측 → 실패 시에만 UA 조정**: `WebviewBuilder::user_agent`로 Edge 표준 UA를 브라우저 child에만 적용. per-webview 설정이라 환경 인자 불일치(빈 창) 문제와 무관하되, **같은 프로필의 모든 child에 동일 상수**를 쓴다(사이트가 UA 변동을 이상 징후로 볼 수 있음). 기본 UA로 로그인이 되면 적용하지 않는다 — 하드코딩 UA는 노화 비용(R5)이 있으므로 조건부.
- **F3 "브라우저 데이터 초기화(로그아웃)" 설정 액션**: 신규 커맨드 `browser_clear_data`. 살아있는 브라우저 child가 있으면 그중 하나에 `clear_all_browsing_data()`(Windows에선 프로필 전체 — §2.5), 없으면 `browser-session` 폴더 `remove_dir_all`(파일 락 실패 시 marker 파일을 남기고 **다음 시작 시** 첫 `browser_open` 전에 삭제). 북마크·방문기록(우리 store — main webview localStorage `gp:browser`, `src/stores/browser.ts:90`; 설계 문서의 `browser-bookmarks.json`은 미구현)은 별개 데이터이므로 **유지** — 일반 브라우저의 "쿠키 삭제 ≠ 방문기록 삭제" 관행과 동일.
- **F4 (C1 일부) 06 태스크와의 계약**: [06-browser-popup-window.md](06-browser-popup-window.md)가 만드는 플로팅 브라우저 창의 child webview도 **동일한 `browser_data_dir()` + 동일 UA 상수**를 사용해야 세션이 공유된다(계약 §4). 팝업형 SSO 로그인 자체를 인앱(플로팅 창)에서 처리하는 것은 06 소관 — v1 목표(gmail 직접 로그인)는 06 없이 충족된다.
- **F5 macOS 격리 갭(후속)**: `data_store_identifier` 고정 UUID로 격리+지속을 동시 달성(macOS 14+). v1은 Windows 1차 플랫폼만 검증하고 갭은 문서화.
- **C4·C5는 대응하지 않음**: 세션 쿠키 사이트가 재시작 시 로그아웃되는 것은 일반 브라우저와 동일한 정상 동작. 비정상 종료 flush 유실은 Chromium 주기 flush로 실질 위험이 낮고 제어 수단이 없다(한계 명시).

### 3.3 마이그레이션/정리 정책

- 기존 `browser-session` 폴더가 최종 위치 그대로이므로 **마이그레이션 불필요** — 이미 로그인해 둔 세션이 그대로 살아있다.
- 과거 temp 폴백으로 생성됐을 수 있는 `%TEMP%\browser-session`은 추적 불가·무해 → OS 임시 파일 정리에 맡긴다(능동 삭제 안 함).

### 3.4 보안 입장

- 쿠키가 디스크에 저장되는 것은 사실이나, WebView2(Chromium)는 쿠키 암호화 키를 **DPAPI(Windows 사용자 계정 단위)** 로 보호한다 — 다른 OS 계정은 읽을 수 없고, 같은 계정의 프로세스는 읽을 수 있다(Chrome/Edge와 동일한 위협 모델). (검증 필요 — 로컬 소스로 확인 불가한 외부 플랫폼 동작)
- 적대 사이트 탭과 gmail 쿠키가 같은 프로필에 있어도 same-origin 정책상 직접 탈취는 불가하며 CSRF 표면은 일반 브라우저와 동급. **특권 main webview와의 프로필 분리(보안 경계)는 그대로 유지**된다(`browser.rs:10-13`) — 이 태스크는 그 경계를 건드리지 않는다.
- 공용 PC 등에서 흔적을 지우는 수단으로 F3(데이터 초기화)을 제공한다.

## 4. 계약(타입·커맨드·이벤트)

```rust
// src-tauri/src/commands/browser.rs

/// 모든 브라우저 webview가 공유하는 지속 프로필 — 단일 진실.
/// temp 폴백 금지: app_local_data_dir 실패 시 Err(세션이 임시 폴더로 새는 것 방지).
/// 06 플로팅 브라우저 창의 child 생성도 반드시 이 함수를 재사용한다.
fn browser_data_dir(app: &AppHandle) -> Result<PathBuf, IpcError>;

/// (F2 조건부 — §5-1 실측으로 확정) 모든 브라우저 child 공통 UA. 적용 시 전 child 동일 값.
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
    (KHTML, like Gecko) Chrome/<major>.0.0.0 Safari/537.36 Edg/<major>.0.0.0";

/// 브라우저 프로필의 쿠키·스토리지 전부 삭제(북마크/히스토리 store는 유지).
/// 살아있는 child 있음 → clear_all_browsing_data(Windows: 프로필 전체) 후 전 child reload.
/// 없음 → 폴더 삭제. 파일 락으로 실패 → 지연 삭제 marker(다음 시작 시 첫 browser_open 전 처리).
#[tauri::command]
pub async fn browser_clear_data(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), IpcError>;
```

```ts
// src/lib/browser.ts
export async function clearBrowserData(): Promise<void>; // invoke("browser_clear_data")
// 성공 시 토스트 "브라우저 로그인/쿠키 데이터를 지웠습니다" (useUi.pushToast 관행)
```

- 신규 이벤트 없음. `lib.rs` invoke_handler에 `browser_clear_data` 등록.
- UI: `src/components/settings/SettingsDialog.tsx`의 진단 섹션(`:169` `DiagnosticsSection`) 인근에 "브라우저 데이터 초기화" 버튼 + 확인 다이얼로그(`useUi.askConfirm` 관행 — `src/stores/ui.ts:157`).
- **06 계약 조항(의존 명시)**: 플로팅 브라우저 창이 child webview를 만들 때 `browser_data_dir()`·`BROWSER_UA`(적용 시)를 재사용 — 어기면 세션 분열(재로그인 재발) + 같은 폴더·다른 인자 조합 시 초기화 실패 위험(`lib.rs:82-89`).

## 5. 단계(구현 순서)

1. **실측 게이트 (선행, ~0.5일)**: 현 빌드 그대로 ① gmail 직접 로그인 성공 여부(기본 UA — C2 확정), ② 로그인 후 새 브라우저 패널에서 로그인 유지, ③ 앱 재시작 후 유지. ①이 실패하면 F2를 범위에 확정, ②③이 실패하면 원인 재조사(§2.1 실측상 성공이 기대값).
2. **F1** temp 폴백 제거 + `browser_open` 에러 경로 (S).
3. **F3** `browser_clear_data` + 설정 버튼 + 지연 삭제 marker (S~M).
4. **(조건부) F2** `BROWSER_UA` 적용 → 1번 재실측으로 통과 확인.
5. **F4** 06 설계 문서에 공유 프로필 계약 조항 반영(문서 상호참조).
6. **검증**: 계정 없이 돌릴 수 있는 E2E 스모크 — 로컬 테스트 서버가 `Set-Cookie`(Expires 지정) 후, **새** `browser_open`에서 같은 서버 재요청 시 Cookie 헤더가 서버에 도착하는지 서버 측에서 관측(child에는 CDP가 없어 내부 관측 불가 — `DOCS/browser-feature-design.md:47`). `browser_clear_data` 후 쿠키 미도착도 단언. gmail 실계정 시나리오는 수동 체크리스트.

규모: 전체 **S~M** (F2 포함 시에도 백엔드 ~60 LOC + UI ~40 LOC 수준, 리스크는 코드량이 아니라 구글 정책).

## 6. 위험과 완화

| # | 위험 | 완화 |
|---|---|---|
| R1 | **구글이 임베디드 웹뷰 로그인을 차단**(disallowed_useragent / "안전하지 않은 브라우저") — WebView2 기본 UA 통과 여부 불확실 | §5-1 선행 실측 → F2(Edge 표준 UA). 그래도 차단되면 임베디드 gmail 로그인은 포기하고 OS 브라우저 안내로 대체(사용자 결정 필요 — open question) |
| R2 | 프로필 폴더 삭제 시 WebView2 브라우저 프로세스의 **파일 락** | `clear_all_browsing_data`(라이브 API) 우선, 폴더 삭제는 child 전무 시에만 + 지연 삭제 marker |
| R3 | 쿠키 디스크 저장(공유 지속 프로필) 보안 우려 | DPAPI 사용자 단위 암호화(§3.4) + main webview 프로필 분리 유지 + F3 초기화 액션. 계정 분리 요구가 실제로 생기면 프로필 다중화 후속 |
| R4 | macOS에서 `data_directory` 미적용 — main webview와 세션 공유(격리 갭) | v1 문서화 + F5 후속(`data_store_identifier`, macOS 14+, 검증 필요) |
| R5 | UA 하드코딩 노화(Chromium 메이저 갱신과 어긋남) | F2를 조건부로만 적용 + 릴리스 체크리스트에 UA 버전 확인. 필요 시 기본 UA 문자열에서 버전을 파생하는 방식 검토(후속) |
| R6 | 세션(비영속) 쿠키 사이트는 재시작/마지막 패널 닫힘 시 로그아웃 | 일반 브라우저와 동일 동작 — 대응하지 않음(한계 명시) |
