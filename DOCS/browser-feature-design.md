# 브라우저(웹 미리보기) 탭 — 기능 설계서

> 상태: 설계(Design) · 대상: gitpervisor (Tauri 2.11.2 + wry 0.55.1 + React 19) · 1차 타깃 플랫폼: **Windows (WebView2)**
> 산출물 성격: `/sc:design` — 구현 코드가 아니라 아키텍처·계약(타입/커맨드/이벤트)·단계 계획. 시그니처/타입 스케치는 포함, 본문 구현은 제외.

## 0. 요구사항

cmux 레퍼런스(앱 내부에 브라우저 탭을 두고 `http://localhost:3777` dev 서버를 라이브 프리뷰 + github PR/google 검색을 바로 탐색)처럼,
**"접속해서 바로 테스트해서 보고"(localhost dev 서버 프리뷰) + "바로 검색해서 보는"(임의 외부 사이트 + 검색)** 브라우저 탭을 Viewer/DB/터미널과 나란히 추가한다.

핵심 제약(설계 출발점): **github.com 등 대형 사이트는 `X-Frame-Options:DENY` / CSP `frame-ancestors`로 `<iframe>` 렌더가 불가**하다. 따라서 "임의 외부 사이트"를 충족하려면 네이티브 webview가 필수다.

---

## 1. 결론 — 하이브리드 임베딩

| 렌더 경로 | 대상 | 메커니즘 |
|---|---|---|
| **네이티브 child webview** (1개) | 외부 사이트 (github, google 검색 등) | wry, Tauri `unstable` `Window::add_child` — "main" 창에 자식 webview 1개를 붙여 탭 콘텐츠 영역 위에 bounds-clip |
| **`<iframe>`** | localhost / 127.0.0.1 / [::1] / 자기 출처 dev 프리뷰 | React DOM 안의 평범한 iframe (XFO 없음 → split·모달·포커스에 완전 통합) |

URL 호스트로 경로를 **자동 분기**한다. 사용자는 경로를 의식하지 않는다.

**네이티브 webview는 `terminal.ts`의 검증된 레지스트리 패턴을 그대로 미러링한다**: 백엔드(Rust)가 리소스의 단일 진실(소유), 프론트는 attach/detach·show/hide·bounds·navigate만 동기화. PTY처럼 webview도 재시작 시 복원되지 않고 URL만 재생성·재탐색한다.

### 왜 이 구조인가 (옵션 비교)

| 옵션 | 외부 사이트 | DOM 통합 | 이 앱 적합성 | 판정 |
|---|---|---|---|---|
| iframe만 | ❌ (XFO) | 완벽 | 외부 요구 미충족 | ✗ |
| 별도 top-level WebviewWindow 도킹 | ✅ | 불가 | 커스텀 타이틀바(decorations:false)·도킹·동시이동 수동, 깜빡임·Alt-Tab 노출 | ✗ |
| 네이티브 child webview만 | ✅ | 안 됨(점유) | 단일창은 좋으나 localhost 프리뷰가 어색·점유비용 | △ |
| **하이브리드 (채택)** | ✅ | localhost는 완벽 | 각 단점 상쇄, 네이티브 **1개**로 Windows 다중 webview 위험 회피 | ✅ |

---

## 2. 검증된 API 사실 (Tauri 2.11.2 / wry 0.55.1)

> 출처: docs.rs/tauri/2.11.2 (`window::Window::add_child`, `webview::WebviewBuilder`), v2.tauri.app JS `namespacewebview`, GitHub 이슈. 아래 ⚠️ 정정은 워크플로 검증 단계에서 잡힌 초안 오류다.

- **child webview 지원**: `Window::add_child(builder, position, size) -> Result<Webview>` 존재. **`desktop` + `unstable` crate feature 게이트**. `WebviewBuilder`와 콜백(`on_navigation`/`on_page_load`/`on_document_title_changed`/`transparent`/`focused`/`auto_resize`)도 전부 `unstable` 게이트. webview 인스턴스 메서드(`set_position`/`set_size`/`navigate`/`show`/`hide`/`set_focus`/`eval`)는 stable(생성 경로만 unstable).
- **Cargo 변경 (⚠️ 실제 상태)**: `src-tauri/Cargo.toml:21`은 현재 `tauri = { version = "2", features = [] }` — **floating `^2` + unstable 없음**. `unstable`은 SemVer 보증 밖이라 floating 위에 얹으면 `cargo update`가 `add_child`를 깰 수 있다 → **먼저 `=2.11.2`로 핀 → `features = ["unstable"]` 추가** (`tauri-build`도 핀 권장).
- **이벤트 관측은 Rust 빌더 콜백에서만**: JS `new Webview()` 생성자에는 nav/title/load 콜백이 없다 → 반드시 Rust에서 child를 생성하고 콜백에서 이벤트를 emit, 프론트는 `listen`.
- **⚠️ z-order 정정 (#9798은 폐기된 캐비엇)**: 초안은 "Windows에서 child가 main *뒤로* 깔린다(#9798)"고 했으나 **#9798은 wry 0.40.0에서 수정**됐고 이 앱은 wry 0.55.1. 즉 **child는 React DOM *위에* 그려진다** → 점유 문제는 "숨겨야 한다"로 더 강해질 뿐 방향은 반대. 모든 #9798 인용은 제거.
- **⚠️ 다중 webview 버그 (#11376 마지막만 렌더 / #10011 흰 화면)**: 모두 **구버전(2.0.x)** 이슈로 현 스택 재현 근거 없음. 그러나 설계는 **네이티브 webview를 1개만** 쓰므로 무관하게 안전 — "방어적으로 단일 webview" 제약은 유지하되 인용의 확신도는 낮춤.
- **⚠️ DPR 정정**: `LogicalPosition`/`LogicalSize`는 이미 CSS(logical) 픽셀이고 `getBoundingClientRect`도 CSS px → **1:1로 전달, `devicePixelRatio`를 곱하지 않는다**(곱하면 HiDPI 125/150%에서 webview 과대 배치).
- **실측 필요(미해결)**: ① child가 main의 `--remote-debugging-port=9222`(CDP)를 **상속하지 않을 가능성 높음** → 자동 UI 검증이 child 내부를 못 봄. ② child는 `BASE_BROWSER_ARGS`(throttle 억제)도 상속 안 함. ③ `can_go_back/forward` 또는 history 깊이를 wry 콜백이 직접 주는지. ④ child에 별도 user-data-folder(쿠키 격리) 지정 API 유무. ⑤ 다운로드 인터셉트 훅 유무.

---

## 3. 아키텍처 개요

```
┌─ React (main webview, 특권) ─────────────────────────────────────────┐
│  WorkspaceTabs ─ 탭칩: Viewer │ DB │ 터미널… │ 🌐 브라우저…           │
│  BrowserTab(React DOM): [컨트롤 바: ◀ ▶ ⟳ 옴니박스 🔌 ⤢]            │
│                          [뷰포트 컨테이너 ref ───────────────┐]      │
│  BrowserController: ResizeObserver(ref)+window resize/scale  │      │
│   → 단일 진실 rect → invoke(browser_set_bounds)              │      │
│   → 모달/탭 상태 → invoke(browser_set_visible)               │      │
│  lib/browser.ts 레지스트리(=terminal.ts 미러)                │      │
└──────────────────────────────────────────────────────────────┼──────┘
                          invoke ▲ │ ▼ listen("browser://…")     │ rect
┌─ Rust (commands/browser.rs) ──────────────────────────────────┼──────┐
│  AppState.browser: { webview: Option<Webview>("browser" 라벨)  │      │
│                      owner_id, last_bounds, visible }          ▼      │
│  Window::add_child(WebviewBuilder…)  ← 단일 진실, 메인스레드 전용     │
│  콜백 on_navigation/on_page_load/on_document_title_changed →emit      │
└──────────────────────────────────────────────────────────────────────┘
                                   │ 외부 OS webview (WebView2)
                          ┌────────▼────────┐
                          │  github / google │  ← 이 사각형에 bounds-clip
                          └──────────────────┘
   localhost 경로일 때: 이 자리에 React <iframe>, 네이티브는 hide
```

데이터 흐름 원칙(events.ts 철학): **이벤트는 신호, 진실은 webview가 소유.** URL/title/loading/history는 Rust 콜백이 `browser://nav-state`로 push → 프론트가 store에 반영.

---

## 4. ⭐ 정규 점유(Occlusion) 스펙 — 단일 규범

> 네이티브 webview는 React DOM과 z-합성되지 않고 **항상 위에 그려진다**(§2 정정). 잘못하면 모달/메뉴/탭바를 덮는다. 점유 규칙은 여러 곳에 흩어지기 쉬워, **이 절을 유일한 규범**으로 삼는다. 아래 두 책임을 **엄격히 분리**한다.

### (A) bounds(위치·크기)의 단일 진실 = rect만

- bounds는 **오직** 뷰포트 컨테이너 ref의 `getBoundingClientRect`로 계산한다. 구동 신호 = **`ResizeObserver(ref)` + window `resize` + window `ScaleFactorChanged`(scale-changed)** 뿐.
- 상태 플래그(activeTab·모달·maximize)로 bounds를 계산하지 **않는다**. 이유(코드 검증): `LogPanel`은 `App.tsx:75`에서 `<main>` 안 **인라인 형제**라 열리면 콘텐츠 rect를 줄이고, `FileTreePanel`은 `App.tsx:63`에서 **조건부 마운트**라 리플로우를 만든다 — **둘 다 어떤 모달/탭 플래그도 바꾸지 않는다.** rect만이 모든 리플로우를 포착한다.
- 단위: rect(CSS px) → `LogicalPosition/LogicalSize` **1:1**. `devicePixelRatio` 곱셈 금지.

### (B) show/hide(표시 여부) = 플래그만

`show = AND( 아래 전부 )`, 하나라도 거짓이면 즉시 `hide`:

1. 이 브라우저 탭이 활성 탭 (`useTerminals.activeTab[projectId] === tab.id`)
2. `tab.mode === "native"` (iframe 모드면 React가 그리므로 네이티브는 **항상 hide**)
3. **차단성 모달 미오픈**: `useUi.settingsOpen` · `useUi.memoOpen` · `useUi.confirm` · **`useDb((s)=>s.dialog)`**(ConnectionDialog는 ui.ts가 아니라 **DB store**에 있음 — `ConnectionDialog.tsx:50` 검증)
4. 다른 패널 maximize 등으로 영역 미가림
5. 컨테이너 rect ≠ 0 (`display:none` 탭이면 rect=0 → hide; (A)의 ResizeObserver 신호와 일치)

> **Toast는 차단 모달이 아니다.** `useUi.toasts`는 하단 비차단·6초 자동소멸. hide 트리거에 넣으면 배경 fetch-에러 토스트마다 github가 스크롤 중 깜빡여 사라진다 → **제외.**

### (C) 드래그/리사이즈 jank 차단

- split divider 드래그·창 리사이즈 **시작 시 hide**, **종료(trailing-debounce) 시 1회만 bounds 적용 + show**.
- 종료 시 적용은 **fire-and-forget 금지** — 마지막 권위 bounds를 반드시 적용하는 **idle reconcile tick**으로 보장(드롭된 `set_bounds`로 오배치 잔류 방지).

### (D) hide의 신뢰성 — 끊긴(hung) invoke까지 견딘다 ⭐

알려진 WebView2 결함은 invoke **응답 유실(promise가 resolve도 reject도 안 됨 = 영원히 hang)**이다(메모리: 동시 invoke 유실). hide가 유실되면 webview가 **Confirm/Settings/Connection 모달 위에 끼여 사용자를 막는** 정합성 버그다(단순 jank 아님). 따라서:

- 백엔드 `browser_set_visible(false)`는 **멱등·즉시 적용**.
- 프론트 hide는 `await invoke; catch` 루프가 아니라 **per-attempt 타임아웃(`Promise.race` + 타이머)** 으로 hang을 끊고 재시도.
- 백엔드가 `visible=false` 확인 이벤트를 emit하거나, **reconcile-on-idle tick**으로 관측될 때까지 `visible=false`를 재단언.

```ts
async function hideReliably(id: string) {
  for (let i = 0; i < 4; i++) {
    const ok = await Promise.race([
      invoke("browser_set_visible", { browserId: id, visible: false }).then(() => true).catch(() => false),
      new Promise<false>((r) => setTimeout(() => r(false), 400)), // hung invoke 차단
    ]);
    if (ok) return;
  }
  // 최종 미확인 시 reconcile tick이 계속 재단언
}
```

---

## 5. 프론트엔드 설계

### 5.1 스토어 — `src/stores/browser.ts` (신규, 별도 영속 키)

`useTerminals`를 오염시키지 않도록 **별도 스토어**를 두되, **활성 탭 표시는 `useTerminals.activeTab[projectId]` 슬롯을 재사용**한다(WorkspaceTabs가 이미 `"viewer"|"db"|tabId` 단일 키로 탭 상호배타를 관리 → 브라우저 탭 id를 같은 슬롯에 넣으면 배타성이 공짜).

```ts
export type BrowserMode = "native" | "iframe"; // external=native, localhost/자기출처=iframe

export interface BrowserTab {
  id: string;        // crypto.randomUUID()
  projectId: string;
  title: string;     // on_document_title_changed → 갱신, 폴백 "새 브라우저"
  url: string;       // 현재/마지막 URL — 영속되는 유일한 네이티브 상태
  mode: BrowserMode; // url 호스트로 결정, 주소창 확정 시 재판정
}
export interface NavState { canGoBack: boolean; canGoForward: boolean; loading: boolean }

interface BrowsersState {
  tabs: BrowserTab[];
  activeExternalTabId: string | null; // 단일 네이티브 webview가 가리키는 tab.id
  navState: Record<string, NavState>; // tabId → (세션 한정, 비영속)
  openBrowser: (projectId: string, url?: string) => string; // setActiveTab도 호출
  closeBrowser: (tabId: string) => void;
  setUrl: (tabId: string, url: string) => void;             // 주소창 확정 → navigate + mode 재판정
  applyNav: (tabId: string, p: NavState & { url: string; title: string }) => void;
}
```

- 영속: `useBrowsers.subscribe`로 **`gp:browser`** 키에 `{ tabs(=id,projectId,title,url,mode) }` 저장(terminals.ts:304 패턴). `navState`는 비영속.
- mode 판정: `new URL(url).hostname ∈ {localhost,127.0.0.1,0.0.0.0,[::1]}` 또는 자기 출처 → `iframe`, 그 외 http(s) → `native`.

### 5.2 `src/lib/browser.ts` — 레지스트리 (terminal.ts 미러)

geometry/visibility는 **JS `@tauri-apps/api/webview` 클래스를 쓰지 않고** 백엔드 배치 커맨드로만 invoke한다(권한 표면 축소 + 동시 invoke 유실 대응).

```ts
export function openBrowser(o: { id; projectId; url; mode }): BrowserInstance; // 멱등
export function attachBrowser(id: string, container: HTMLElement): void;       // ref+ResizeObserver 부착, 첫 syncBounds
export function syncBounds(id: string): void;        // rect→backend, single-flight(lastBounds≠일 때만)
export function showBrowser(id: string): void;
export function hideBrowser(id: string): Promise<void>; // §4(D) retry-until-confirmed
export function navigate(id, url): void; back(id); forward(id); reload(id); stop(id);
export function disposeBrowser(id: string): void;    // host 제거 + ResizeObserver 해제 + backend close
export function onBrowserNav(l): () => void;         // listen("browser://…") 1회 구독 (terminal onTermExit 대응)
```

```ts
interface BrowserInstance {
  id; projectId; host: HTMLDivElement; ro: ResizeObserver;
  mode: BrowserMode; lastBounds: Bounds | null; visible: boolean;
}
type Bounds = { x: number; y: number; width: number; height: number }; // CSS px = Logical
```

### 5.3 `BrowserPane` + WorkspaceTabs 통합

- `WorkspaceTabs.tsx` 탭스트립에 브라우저 칩(`Globe` 아이콘) 추가. 기존 "새 터미널" `+`를 **split 버튼(`+` / `▾`)** 으로 교체: `+`=새 터미널(기존 동작 보존, 회귀 0), `▾` 메뉴=`[+ 새 터미널] [+ 새 브라우저] [+ DB 탐색기]`(메뉴 스타일은 `TerminalPane`의 `PaneMenu` 재사용).
- **⚠️ 의도된 일탈(명시)**: 터미널은 비활성 시 콘텐츠를 **언마운트**한다(`WorkspaceTabs.tsx:92` `{active === t.id && <PaneTreeRoot/>}`). 브라우저는 host/ResizeObserver가 끊기면 rect 추적이 죽으므로 **항상 마운트**(`<div className={active ? "h-full":"hidden"}><BrowserPane/></div>`)한다. 대가: 비활성(rect=0) BrowserPane이 `rect=0→hide`를 1회 emit — 무해하지만 §4(B) 조건 5로 자연 흡수.

### 5.4 UI/UX (cmux 패리티)

콘텐츠는 세로 2단: **컨트롤 바(React DOM, `h-9`)** + **뷰포트**. 모든 chrome는 Tailwind 토큰(`bg-base/raised/panel`, `text-fg/-muted/-dim`, `border-edge`, `text-accent`)이라 `data-theme` 전환에 자동으로 따라온다. 한국어 라벨.

```
┌ 탭스트립 (h-9, 기존) ───────────────────────────────────────────────────┐
│ [📄 Viewer] [🗄 DB ×] [⌨ 터미널1 ×] [🌐 github.com ⟳ ×]      [ + ▾ ]    │
├ 컨트롤 바 (h-9, bg-base, border-b border-edge) ─────────────────────────┤
│ [◀][▶] [⟳/✕]  ┌ 옴니박스 (flex-1, h-7, bg-raised) ──────────┐ [🔌▾][⤢] │
│  뒤  앞  새로고침 │ 🔒 https://github.com/org/repo/pull/12      │  포트 최대화│
├ 뷰포트 (flex-1, relative, ref) ─────────────────────────────────────────┤
│   ↑ 네이티브 webview가 이 사각형에 bounds-clip (localhost면 <iframe>)     │
│   로딩: 상단 2px bg-accent 진행바 + (첫 로드만) 중앙 스피너               │
└──────────────────────────────────────────────────────────────────────────┘
```

- **옴니박스 라우팅** `resolveOmnibox(raw)`: ① `^https?://`·`^localhost`·`^127.`·`^[::1]` → 그대로(scheme 보충). ② scheme 없고 점 포함 + 유효 호스트 패턴 → `https://` 보충(`github.com/x`→`https://github.com/x`). ③ 그 외(공백/점없음/한글) → **검색** `https://www.google.com/search?q=` + `encodeURIComponent`. 결과 host가 localhost류 → iframe 경로, 그 외 → 네이티브 경로.
- **컨트롤**: 뒤로/앞으로(`canGoBack/Forward` false면 disabled, `Alt+←/→`), 새로고침↔정지 토글(`Ctrl+R`/`F5`, 로딩 중이면 정지), 옴니박스(`Ctrl+L` 포커스+전체선택, 좌측 보안 아이콘 `Lock`/`Unlock`/`ShieldAlert`), 빠른접속 `🔌`(감지된 dev 포트 드롭다운, 클릭 시 iframe 즉시), 최대화/복원.
- **상태 머신** `idle|loading|ready|error|blocked` — 오버레이는 전부 **React DOM**(네이티브 위에는 못 그리므로 오버레이가 떠야 하면 webview를 hide하고 DOM이 전체를 그림, `TerminalPane`의 `exited` 오버레이와 동형). `blocked`(iframe XFO/CSP/mixed-content): "이 사이트는 미리보기로 열 수 없습니다 → **[외부 브라우저 보기로 열기]**"(네이티브 경로 폴백).
- **빈 상태**: `EmptyState icon={Globe}` "주소를 입력하거나 검색하세요" + 감지된 dev 서버 칩(`[localhost:3777 열기]`).
- **포커스 탈출**: 네이티브 webview 포커스 중엔 앱 단축키(`Ctrl+``, `Ctrl+Shift+D/E/W`)·Esc-모달닫기가 죽는다 → 컨트롤 바(항상 React DOM) 클릭으로 복귀 + child에 주입한 Esc 핸들러가 `browser://escape` emit → 주소창 포커스.

### 5.5 split 제약

**브라우저 탭은 split 미지원, 단일 뷰포트 고정.** 네이티브 webview는 contextmenu/우클릭·divider 드래그를 원격 페이지에 빼앗기고, sub-rect 분할은 async hide 레이스로 seam이 보인다. iframe 모드도 native↔iframe 전환 시 레이아웃이 흔들리므로 **두 모드 모두 split 미지원**으로 통일(cmux도 브라우저는 단일 면).

---

## 6. 백엔드 설계 — `src-tauri/src/commands/browser.rs`

`terminal.rs` 미러: 백엔드가 단일 진실, id는 프론트가 생성(invoke 응답 유실돼도 "아는 id"로 close 가능 → 고아 webview 방지).

### 6.1 AppState

```rust
// state.rs
pub struct BrowserState {
    webview: Option<tauri::Webview>, // 라벨 상수 "browser" 단 하나 (다중 금지의 물리적 강제)
    owner_id: Option<String>,        // 현재 네이티브를 점유 중인 프론트 browser_id
    last_bounds: Option<Bounds>,     // 동일값 set 생략 → jank/IPC 절감
    visible: bool,
}
// AppState에 browser: Mutex<BrowserState> 추가
```

> `Webview` 메서드(set_position/size/show/hide/navigate)는 **반드시 command 핸들러(메인 IPC 스레드)에서만** 호출(메인스레드 펌프 크래시 게이트 준수 — 별도 std 스레드에서 호출 금지). `add_child`는 메인스레드 + 저비용이라 시작 멈춤(watcher 백그라운드화 사례)을 재유발하지 않음.

### 6.2 커맨드 (`#[tauri::command]`, 본문 생략)

```rust
pub fn browser_open(app, state, browser_id: String, url: String, bounds: Bounds) -> Result<(), IpcError>; // 멱등: 있으면 navigate+인수
pub fn browser_navigate(state, browser_id, url) -> Result<(), IpcError>;
pub fn browser_set_bounds(state, browser_id, bounds: Bounds) -> Result<(), IpcError>; // set_position+set_size 배치 1콜, last_bounds 동일 시 no-op
pub fn browser_set_visible(state, browser_id, visible: bool, bounds: Option<Bounds>) -> Result<(), IpcError>; // 멱등·즉시
pub fn browser_back/forward/reload/stop(state, browser_id) -> Result<(), IpcError>;
pub fn browser_focus(state, browser_id) -> Result<(), IpcError>;  // 메인↔child 포커스 환원(트랩 탈출)
pub fn browser_close(state, browser_id) -> Result<(), IpcError>;
pub fn browser_scan_dev_ports(ports: Option<Vec<u16>>) -> Result<Vec<u16>, IpcError>; // std::net TCP connect, 외부 의존 없음

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds { pub x: f64, pub y: f64, pub width: f64, pub height: f64 } // Logical(CSS) px 계약, DPR 곱 금지
```

### 6.3 child 생성 + 콜백

```rust
let win = app.get_window("main").ok_or(/* NotFound */)?;
let builder = tauri::webview::WebviewBuilder::new("browser", tauri::WebviewUrl::External(url.parse()?))
    .on_navigation(|url| navigation_gate(url))            // file:/tauri:/javascript:/data: 차단, http(s)만
    .on_page_load(|wv, payload| emit_load(&wv, payload))  // Started/Finished → loading
    .on_document_title_changed(|wv, t| emit_title(&wv, t));
let webview = win.add_child(builder, pos, size)?;         // desktop+unstable 게이트
```

> **`additional_browser_args` 결정(§9.A 보안과 충돌 해소)**: child는 부모의 `BASE_BROWSER_ARGS`(throttle 억제)·CDP 인자를 **상속하지 않는다**. **권고 = child에 throttle-억제 인자를 적용하지 않는다** — (a) github 같은 무거운 외부 페이지에 백그라운드 throttle 억제를 걸면 CPU/배터리만 상승하고, (b) child는 어차피 활성일 때만 보이므로(점유 hide) 백그라운드 throttle이 문제되지 않으며, (c) child를 적대적으로 다루는 보안 원칙과도 합치. CDP(`--remote-debugging-port`)도 부여하지 않음. → §9의 "외부 webview엔 throttle 미적용"이 §6의 "재적용 필수"보다 우선(초안 모순 해소).

### 6.4 이벤트 (backend emit → 프론트 listen)

```rust
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NavState { browser_id: String, url: String, title: String, can_go_back: bool, can_go_forward: bool, loading: bool }
```

- `browser://nav-state` — nav/page-load/title 변화 시 url·title·canGoBack/Forward·loading을 1이벤트로(coalesce는 프론트 events.ts에서).
- `browser://favicon` `{ browser_id, href }` — page-load Finished 후 eval로 `link[rel~=icon]` 추출(실패 무시, 선택).
- `browser://new-window` `{ browser_id, url }` — `window.open`/`target=_blank`/OAuth → **두 번째 webview 절대 생성 금지**, OS 브라우저 위임(§6.5).
- `browser://escape` — child 주입 Esc → 프론트가 주소창 포커스.

> ⚠️ `can_go_back/forward`를 wry 0.55.1이 콜백으로 직접 주는지 **미검증**. 안 주면 nav/page-load 시 자체 카운터 또는 `eval(history.length)` 추정 — 단 `history.length`는 뒤/앞 구분을 못 하고 SPA `pushState`(github)를 못 잡으므로 버튼 enabled가 부정확할 수 있다. **M2에서 실측 후 확정**(필요 시 버튼을 "항상 enabled, 실패는 무동작"으로 단순화).

### 6.5 new-window / 외부 링크 / 다운로드 / 스킴

- ⚠️ **opener 정정(blocking)**: `tauri-plugin-opener`는 **이 repo의 Rust 의존성이 아니다**(Cargo.toml에 없음, lib.rs는 dialog+store만 등록; `@tauri-apps/plugin-opener`는 package.json JS만 → Rust 미설치라 런타임 실패). `open.rs`가 이미 raw `std::process::Command`(explorer/wt/cmd)를 쓴다 → **같은 raw-Command 헬퍼 채택**:

```rust
#[cfg(windows)] fn open_external(url: &str) { // start "" <url>
    let _ = Command::new("cmd").args(["/C","start","",url]).creation_flags(CREATE_NO_WINDOW).spawn();
}
// macOS: open / Linux: xdg-open (open.rs cfg 분기 동형)
```

- **스킴 게이트** `navigation_gate`: `file:`/`tauri:`/`javascript:`/`data:`(최상위) 거부, `http`/`https`/`about:blank`만 허용.
- **다운로드**: 1차 정책 = 차단 또는 OS 브라우저 위임(drive-by-write 방지). ⚠️ wry/WebView2 다운로드 인터셉트 훅 존재 여부 **M5 실측** — 없으면 "차단" 미구현이므로 정책 재조정.

### 6.6 lib.rs 등록 변경

- `invoke_handler!`에 `browser_open, browser_navigate, browser_set_bounds, browser_set_visible, browser_back, browser_forward, browser_reload, browser_stop, browser_focus, browser_close, browser_scan_dev_ports` 추가. `commands/mod.rs`에 `mod browser; pub use browser::*;`.
- `on_window_event` `Destroyed`에 `browser_kill_all(state)` 추가(현재 `kill_all`(PTY)만 정리 — webview 누수 방지):

```rust
pub fn browser_kill_all(state: &AppState) {
    let mut b = state.browser.lock().unwrap();
    if let Some(wv) = b.webview.take() { let _ = wv.close(); }
}
```

### 6.7 startup/lifecycle (재생성 시점 — 명시)

재시작 시 `gp:browser`에 `mode:"native"` 탭이 있어도 **eager로 add_child하지 않는다**(시작 멈춤 회피 원칙, lib.rs가 watcher::register를 백그라운드로 미룬 사례와 동일 정신). **lazy**: 사용자가 그 브라우저 탭을 처음 활성화할 때 `browser_open`. 활성화 전까지는 탭칩만 복원, URL은 store에 보존.

---

## 7. 보안 & 격리

**불변식 BROWSER-NO-IPC**: `"browser"` webview(임의 원격 콘텐츠)는 Tauri invoke 브리지에 도달 못 한다. github/google JS가 `invoke("commit")` 등 특권 커맨드를 부르는 경로가 **존재하지 않아야** 한다.

다층 방어:

1. **`WebviewUrl::External` + `withGlobalTauri` 미주입** — Tauri는 External webview에 기본적으로 `window.__TAURI__`를 주입 안 함.
2. **capability 분리(핵심)** — 기존 `default.json`은 `windows:["main"]`이라 `"browser"` 라벨에 **매칭 안 됨**. 새 `capabilities/browser.json`은 `webviews:["browser"]`로 스코프하되 **`permissions: []`** (원격 페이지 도달 표면 = 0). geometry/navigate/show/hide 권한은 **`"main"` capability에만** 부여(움직이는 권한은 신뢰된 main에, 움직여지는 대상엔 0). 단, §5.2처럼 host가 JS Webview 클래스 대신 **Rust 커스텀 배치 커맨드**를 쓰면 `core:webview:*` 권한 표면 자체를 최소화. (정확 식별자는 생성 `desktop-schema.json`로 검증.)

```jsonc
// capabilities/browser.json
{ "$schema": "../gen/schemas/desktop-schema.json", "identifier": "browser",
  "description": "임의 외부 사이트 렌더용 격리 webview. 절대 core:* 커맨드 권한을 추가하지 말 것.",
  "webviews": ["browser"], "permissions": [] }
```

3. **스킴 게이트**(§6.5) — file/tauri/javascript/data 차단.
4. **window.open/OAuth** — 두 번째 webview 금지, OS 브라우저 위임(§6.5 raw Command).
5. **CSP**: `app.security.csp = null` 유지(Monaco/xterm/HMR 인라인·blob 의존, 좁히면 회귀). CSP는 외부 콘텐츠 격리 수단이 아님(그게 요구) — 격리는 IPC 권한 분리 + 세션 분리 + 스킴 게이트로 달성.
6. **세션/쿠키 격리(⚠️ 결정 필요)**: 같은 앱 webview들은 WebView2 user-data-folder를 공유할 수 있다 → 적대 사이트 쿠키가 특권 컨텍스트와 같은 폴더. **결정안 A(권장)**: child `additional_browser_args`에 `--user-data-dir=<별도 경로>`를 주어 파티션을 시도하고 **실제 분리되는지 실측**. 실패 시 **결정안 B**: 공유를 수용하되 "브라우저 webview 쿠키는 신뢰하지 않는다"를 문서화 + 설정에 "브라우저 데이터 지우기"(우리 store 삭제 + webview 재생성) 제공. **임의 적대 사이트를 렌더하므로 이 항목이 보안의 중심** — open question으로 미루지 말고 M2에서 A를 실측해 확정.
7. **mixed-content**: `tauri://` 출처의 `http://localhost` iframe이 차단될 수 있음 → §8 영속/§11 검증에서 **M1 시작 전 10분 실측**. 차단되면 localhost도 네이티브 경로로(아래 §11 참조).
8. **CI/DoD 격리 테스트**: child에 `window.__TAURI__?.invoke`를 호출하는 테스트 페이지를 띄워 **undefined/거부됨**을 단언(한 줄 실수로 격리가 깨지므로 회귀 가드).

---

## 8. 데이터 모델 & 영속화

| 키 | 저장소 | 내용 | 비영속(런타임) |
|---|---|---|---|
| `gp:browser` | localStorage | `{ tabs: BrowserTab[](id,projectId,title,url,mode), activeExternalTabId }` | `navState` |
| `browser-history.json` (선택, M4) | tauri-plugin-store | 최근 방문 링버퍼 N=200 `{url,title,ts}` | — |
| `browser-bookmarks.json` (선택, M4) | tauri-plugin-store | 북마크 | — |

- **재시작 복구 한계(명시)**: 영속되는 네이티브 상태는 **URL 하나뿐**. back/forward 히스토리 stack·스크롤·in-page JS·로그인 세션(쿠키는 WebView2 폴더에 별도 보관)은 우리 store에 없다. 재시작 = webview 재생성 + 저장 URL 1회 navigate. **PTY가 재시작 시 새 셸로 되살아나는 것과 동일 등급의 한계.**
- 세션 내 탭 전환(activeTab 변경)은 webview가 hide만 되므로 **같은 페이지 복귀**. 재시작 후엔 **URL만** 복구.
- 죽은 localhost URL 복구 → §5.4 `error`/`blocked` graceful 화면(무한 흰 화면 금지).

---

## 9. 단계별 구현 계획 (독립 출하 가능 5단계)

> **선행 블로커(M0, 30분)**: §11의 두 empirical 체크 — ① `http://localhost` iframe이 `tauri://`에서 mixed-content 없이 로드되는가(M1 독립성의 전제), ② plugin-opener 정정 반영. ①이 NO면 localhost도 네이티브로 가고 M1은 M2에 흡수된다(아래 마일스톤 구조 재조정).

| 단계 | 범위 | 수용 기준(AC) | 공수 |
|---|---|---|---|
| **M1** localhost iframe MVP (네이티브 0) | 브라우저 탭 종류 + `gp:browser` store + 컨트롤 바(주소창·새로고침) + `<iframe>` + dev 포트 빠른추가 | 로컬 dev URL 라이브 프리뷰, 탭 전환 후 iframe 유지, 재시작 시 URL 복구, 외부 URL은 "네이티브로 열기" 안내 | ~2일 (S) |
| **M2** 단일 네이티브 webview + 옴니박스 ⭐ | Cargo 핀+unstable, `browser.rs`(커맨드·콜백·이벤트), capability, `lib.rs` 등록+Destroyed 훅, `lib/browser.ts`+BrowserController(점유 §4), 옴니박스 검색 라우팅 | github PR·google 검색 렌더·탐색, §11 수동 케이스 ①~⑪ 통과, "외부 탭 동시 1개" 안내 | ~5–7일 (L, 임계경로) |
| **M3** 내비 이벤트·타이틀·favicon + 영속성 | `browser://title/load`→탭 라벨·로딩바, favicon, `gp:browser` URL 영속, 죽은 URL graceful | 탭에 타이틀/favicon, 재시작 URL 복구, 죽은 dev 서버 에러 화면 | ~2–3일 (M) |
| **M4** 히스토리·북마크·dev 빠른접근 | 옴니박스 자동완성(히스토리), 북마크, dev 서버 칩 | 자동완성·북마크 영속, dev 칩 클릭→iframe 즉시 | ~3일 (M) |
| **M5** 한계 마감 + 폴리시 | focus escape(필수), 다운로드 정책 확정, 세션 격리 확정, split 비활성 명문화, HiDPI/멀티모니터 재동기화, invoke-loss reconcile 검증 | focus 왕복(브라우저→Esc→`Ctrl+``→터미널), HiDPI 125/150%·듀얼모니터 bounds 정합, 격리 테스트 통과 | ~3–4일 (M–L) |

**총 ~17–22일(약 4주). M1 단독 출하 가능(①이 YES일 때), M2가 임계 경로.**

---

## 10. 리스크 레지스터

| # | 리스크 | 심각도 | 완화 | 단계 |
|---|---|---|---|---|
| R1 | **점유** — child가 React DOM 위에 그려져(wry 0.55.1) 모달/탭바를 덮음 | High | §4: rect 단일 진실 + show-AND + bounds를 컨트롤 바 *아래*로 한정 | M2/M5 |
| R2 | **hung invoke로 hide 유실** — webview가 모달 위 "끼임"(정합성 버그) | High | §4(D): per-attempt 타임아웃(`Promise.race`)+재시도+reconcile tick, 멱등 backend | M2 |
| R3 | **N webview 렌더 버그**(#11376/#10011, 구버전) | Med | 네이티브 **1개** 불변식 + 외부 동시 1탭, localhost는 iframe 분리 | M2 |
| R4 | **보안** — 임의 적대 사이트 + 특권 webview | High | §7: External+권한0 capability, 스킴 게이트, 세션 분리(§7.6 A실측), OAuth→OS, CDP 미부여, 격리 CI 테스트 | M2/M5 |
| R5 | **점유 신호 누락** — LogPanel/FileTree 리플로우가 플래그 무변동, ConnectionDialog는 DB store | High | §4(B): bounds는 rect+ResizeObserver만, 모달 구독에 `useDb.dialog` 포함, toast 제외 | M2 |
| R6 | **HiDPI/멀티모니터 오배치** | Med | Logical 1:1(DPR 곱 금지) + `ScaleFactorChanged` 재동기화 | M2/M5 |
| R7 | **can_go_back/forward 부정확** — wry 콜백 미제공 가능 | Med | M2 실측, 없으면 버튼 단순화(항상 enabled·실패 무동작) | M2 |
| R8 | **opener 미설치** — JS plugin-opener는 Rust 크레이트 없음 | High(blocking) | raw `std::process::Command`(open.rs 패턴) 채택, security의 opener 주장 폐기 | M0/M2 |
| R9 | **child throttle/CDP 미상속** | Low | 권고: 외부 child엔 throttle/CDP **미적용**(보안·리소스), 초안 "재적용 필수" 폐기 | M2 |
| R10 | **mixed-content** — http://localhost iframe 차단 | Med | M0 console 실측, 차단 시 localhost도 네이티브 폴백(M1 구조 재조정) | M0/M1 |
| R11 | **Linux WebKitGTK 패리티** — add_child·z-order·IME 상이 | Med | **1차 Windows. Linux는 별도 결정** — iframe-only 폴백 시 github/google이 Linux에서 동작 안 함(제품 한계, §12 결정) | M5/후속 |
| R12 | **persist/restore 갭** — history/scroll/session 소실 | Low | URL만 복구 문서화(PTY 동형) + 죽은 URL graceful | M3 |
| R13 | **focus 트랩** — child 포커스 중 앱 단축키 무력 | Med | focus-escape 버튼 + child 주입 Esc→main set_focus | M5 |
| R14 | **다운로드 인터셉트 훅 부재 가능** | Med | M5 실측, 없으면 정책 재조정(OS 위임) | M5 |
| R15 | **unstable API 깨짐** — `^2` floating + unstable | Med | `=2.11.2` 핀 후 unstable, 업글 시 회귀 스모크 | M2 |
| R16 | **CDP 미커버** — 9222가 child 내부 못 봄 | Low | 메인측 자동화 + child 수동/스크린샷(`Page.captureScreenshot`), M2에서 `list_pages` 노출 확인 | M2 |
| R17 | **webview 누수** — Destroyed가 PTY만 정리 | Low | Destroyed에 `browser_kill_all` 추가 | M2 |

---

## 11. 검증 (DoD)

- **CDP 9222(메인 React webview)**: 옴니박스·컨트롤 바·show/hide 상태·`browser://*` 수신 후 store 반영을 `evaluate_script`로 자동 검증.
- **child 내부**(별 target, 9222 미커버 가능): 수동 + `Page.captureScreenshot`(메모리: 네이티브 캡처 불안정 → CDP 캡처).
- **M0 선행 실측(30분, 마일스톤 확정 전)**:
  1. `tauri://` 출처에서 `<iframe src="http://localhost:3777">`가 mixed-content 차단 없이 로드되는가? (`list_console_messages`) — NO면 localhost도 네이티브 경로, M1 구조 재조정.
  2. `list_pages`에 child "browser" target이 보이는가? (CDP 자동화 가능 여부)
  3. child가 `BASE_BROWSER_ARGS`/9222를 상속하는가? (권고대로 미부여 확정)
- **수동 회귀 매트릭스(M2)**: ① github PR 렌더 ② google 검색 ③ 뒤/앞/새로고침 ④ **탭 전환 시 즉시 hide** ⑤ **Settings 모달 열기 → webview가 안 가림(hide)** ⑥ ConnectionDialog 동일 ⑦ Confirm 동일 ⑧ **Toast 시 webview 안 사라짐** ⑨ 창 리사이즈/maximize→restore 시 bounds 재동기화 ⑩ 탭 닫기 → 정리(다음 열기 흰화면 없음) ⑪ 창 닫기 → 프로세스 잔존 없음(작업관리자) ⑫ **invoke-loss 스트레스**: 모달 토글 연타 중 webview "끼임" 없음.
- **dev 앱 실행**: `Start-Process` 분리 실행(메모리: `run_in_background` 회수 오인 방지).

---

## 12. 결정이 필요한 항목 (기본 권고 포함)

1. **플랫폼 범위** — *권고: Windows-first.* 앱은 NSIS·Korean-only 설치, 메모리도 전부 WebView2/Windows. Linux는 add_child z-order·IME가 상이해 별도 실측 필요하며, iframe-only 폴백 시 **github/google이 Linux에서 동작 안 함**(핵심 요구 미충족). → Linux는 후속/best-effort로 명문화하거나, Linux 동등성을 요구하면 별도 스파이크.
2. **멀티 탭 모델** — *권고: 외부(네이티브) 브라우저 탭은 앱 전체 동시 1개.* Windows 다중 webview 위험 + 단일 webview 불변식. localhost(iframe)는 무제한. WorkspaceTabs가 프로젝트별이므로, 프로젝트 A가 webview를 점유 중일 때 프로젝트 B의 브라우저 탭칩은 "재로드됨" 힌트 표시 + 활성화 시 단일 webview를 인수(re-navigate). 이 동작을 UI에 투명하게 안내.
3. **세션 격리(§7.6)** — *권고: 결정안 A(별도 user-data-dir 실측) → 실패 시 B(공유 수용+문서화+데이터 지우기).* M2에서 확정.

---

## 부록 — 워크플로 검증이 잡은 초안 정정 요약

| 초안 주장 | 정정 | 근거 |
|---|---|---|
| `tauri-plugin-opener` 이미 의존성 | **Rust 미설치**(Cargo.toml/lib.rs 없음, JS만) → raw Command | Cargo.toml·lib.rs 확인 |
| #9798: child가 main *뒤로* 깔림 | **wry 0.40.0에서 수정**, 0.55.1은 child가 *위로* → 항상 hide 필요 | wry PR #1271 |
| `getBoundingClientRect × devicePixelRatio` | **곱셈 금지**, Logical=CSS px 1:1 | Tauri Logical 단위 정의 |
| child에 `BASE_BROWSER_ARGS` 재적용 필수 | **외부 child엔 미적용 권고**(보안·리소스), CDP도 미부여 | §6.3/§7 합치 |
| hide는 `await invoke; catch` 재시도 | 결함은 **hung invoke** → per-attempt 타임아웃+reconcile 필요 | 메모리 IPC 유실 |
| ConnectionDialog는 useUi | **`useDb.dialog`** | ConnectionDialog.tsx:50 |
| 비활성 탭은 mounted 유지(터미널 미러) | 터미널은 **언마운트**(WorkspaceTabs:92) → 브라우저 always-mount는 *의도된 일탈* | WorkspaceTabs.tsx:92 |
| Cargo `version="2"` 핀됨 | 실제 **floating `^2`** → `=2.11.2` 핀 선행 후 unstable | Cargo.toml:21 |
