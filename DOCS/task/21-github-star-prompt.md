# 태스크 21 — GitHub star 부탁 카드 (3번째 실행에 1회 · 우측 하단)

> 상태: **구현 완료 · 실기 검증 통과** (2026-09-02, 미커밋) · 구현 결과는 §8 ·
> 근거: 코드 실측 2026-09-02 · 상위 설계: `DOCS/video-split-redock-notify-design.md` §4 (F4)

## 1. 요구사항

처음 설치해 **사용해본** 사용자에게 우측 하단 알림창으로 GitHub star를 부탁한다.

받아들이는 조건:
- 한 번만 보여준다. 누르든 닫든 다시 뜨지 않는다.
- 버튼을 누르면 OS 기본 브라우저에서 저장소 페이지가 열린다.
- 기존 우측 하단 카드(메모리 경보 HealthBanner)와 동시에 떠도 겹치지 않고 세로로 쌓인다.
- 설정 UI에 새 항목을 만들지 않는다(되돌릴 이유가 없는 1회성 플래그).

## 2. 현황(근거)

- **첫 실행 추적이 없다.** `session.json`은 매 실행 덮어쓰기라 판별 불가. `launch-count`·`first_run`류
  코드 0건(grep).
- **"한 번만 보여주기"의 선례는 전부 localStorage `gp:*`**: `gp:prev-session-seen`
  (`src/components/common/HealthBanner.tsx:49-50`), `gp:update-autocheck`(`stores/updater.ts:23` — 주석에
  "백엔드 Settings 스키마를 건드리지 않는다"), `gp:health-muted`(`stores/health.ts`). settings.json에
  필드를 넣으면 `git/types.rs` + `ipc.ts` 타입 + `settings-index.ts` + 섹션 UI + e2e 29 완전성 가드
  (`29-settings-ux.mjs:80-86`) 5곳이 연쇄된다.
- **persistent 우측 하단 카드의 정확한 선례 = HealthBanner.** 컨테이너 `fixed bottom-8 right-4 z-40 flex
  w-[380px] max-w-[calc(100vw-32px)] flex-col gap-2`(`:105`). 카드는 `role="alert"`, `rounded-lg border
  bg-panel p-3 text-xs shadow-xl`(`:131-135`), 헤더 행(아이콘·제목·X, `:137-153`), 버튼 행(`:168-185`).
  App에서 `<HealthBanner />`로 마운트(`src/App.tsx:131-132`), 토스트(`z-50`)는 같은 구석 위에 뜬다.
- **외부 URL 열기 — 검증된 경로가 이미 있다.** 메인 창 빌더(`src-tauri/src/lib.rs:749`)의
  `.on_new_window`(`:773-778`)가 `window.open`을 가로채 **`http`/`https`만** `commands::open_external`로
  넘기고 `NewWindowResponse::Deny`를 돌려준다. `open_external`은 Windows `ShellExecuteW "open"`
  (`commands/browser.rs:146` — cmd 메타문자 인젝션 불가 주석), macOS `open`(`:167`), Linux `xdg-open`(`:173`,
  `spawn_launcher` 경유라 브라우저가 앱 cgroup **밖**에서 뜬다). 신규 커맨드·capability·opener 크레이트
  (JS 패키지만 있고 Rust 크레이트 없음) 전부 불필요.
  단, 현재 `src/`에 `window.open` 호출은 **0건** — 실기 검증 필수(§7). CSP(`tauri.conf.json:15`)는
  `window.open` 대상을 제한하지 않는다(navigate-to 지시어 없음).
- **App은 메인 창에만 마운트된다**(`src/main.tsx:207`, 라벨 분기 밖). 단 `React.StrictMode`(`:205`)라
  마운트 효과가 dev에서 2회 돈다 — 카운터 증가는 멱등해야 한다. `App.tsx`는 모든 창의 번들에
  **import는 되지만** 렌더는 메인만이므로, 카운터 증가를 모듈 최상위에 두면 풀 창·모아보기 창이 뜰 때마다
  실행이 하나 늘어난다 → 반드시 App 마운트 효과 안에서.
- 저장소 URL: `https://github.com/imtelloper/gitpervisor`(`tauri.conf.json:22` 업데이트 엔드포인트와 같은
  레포). 코드 내 상수 없음.

## 3. 설계

### 3.1 노출 시점

| 대안 | 평가 |
|---|---|
| 첫 실행 즉시 | "사용해본" 상태가 아니다. 온보딩 중 알림은 닫힘만 당한다 |
| **3번째 실행에 1회** (채택) | 두 번은 돌아왔다 = 쓸 만하다고 판단한 뒤. 구현은 카운터 1개 |
| 누적 사용 시간 N분 | 타이머·저장 주기가 필요하다. 카운터로 충분(YAGNI) |

`gp:launch-count`를 App 마운트 시 1 증가(모듈 플래그로 StrictMode 이중 실행 차단). 값 ≥ 3이고
`gp:star-asked`가 없으면 카드 표시. **어떤 상호작용이든**(`Star 남기기` 클릭 / X) `gp:star-asked = "1"`.

### 3.2 외부 링크

| 대안 | 평가 |
|---|---|
| **`window.open(url, "_blank", "noopener")`** (채택) | 기존 `on_new_window` 위임 — Rust 0줄. 반환값은 항상 null(Deny)이라 쓰지 않는다 |
| 신규 `open_url` 커맨드(`open_external` 래핑 + 스킴 화이트리스트) | 위가 실기에서 어느 OS든 실패할 때의 **비상 대안**. 선제 구현하지 않는다 |
| `@tauri-apps/plugin-opener` | Rust 크레이트 미등록 — 호출 시 런타임 실패. 크레이트+capability 추가는 이 요구에 과하다 |

### 3.3 겹침 정리 — 공용 스택

HealthBanner가 자기 `fixed` 컨테이너를 갖고 있어(`:105`) 카드를 하나 더 만들면 같은 좌표에 **겹친다**.
App.tsx에 스택 컨테이너 하나를 두고 두 컴포넌트를 그 안에 넣는다. HealthBanner는 위치 클래스만 잃고
카드 목록(Fragment)만 반환한다. 순서: 경보(HealthBanner)가 위, star 카드가 아래(bottom 앵커라 마지막
자식이 가장 아래). 컨테이너는 비어 있어도 마우스를 막지 않게 `pointer-events-none` + 자식 `pointer-events-auto`.

### 3.4 문구·버튼

- 제목: "Gitpervisor가 도움이 되고 있나요?"
- 본문: "GitHub에서 ⭐ 하나 남겨 주시면 개발에 큰 힘이 됩니다. 이 안내는 다시 표시되지 않습니다."
- 버튼: [GitHub에서 Star 남기기] (accent) · [닫기] (X 아이콘, 헤더 우측 — HealthBanner와 동일 위치)
- 아이콘: lucide `Star`. 색은 HealthBanner의 amber 계열이 아니라 중립(`border-edge`) — 경보가 아니다.

## 4. 계약

Tauri 커맨드/이벤트/Rust 변경 **없음** — 순수 프론트엔드.

```tsx
// src/components/common/StarPrompt.tsx (신규)
const REPO_URL = "https://github.com/imtelloper/gitpervisor";
const KEY_ASKED = "gp:star-asked";
const KEY_LAUNCH = "gp:launch-count";
const MIN_LAUNCHES = 3;

let counted = false; // StrictMode 이중 마운트·재렌더에도 페이지 로드당 1회
/** App 마운트 효과에서 호출 — 메인 창만 App을 렌더하므로 보조 창은 세지 않는다. 증가 후 값 반환. */
export function bumpLaunchCount(): number {
  const n = Number(localStorage.getItem(KEY_LAUNCH) ?? "0") + (counted ? 0 : 1);
  if (!counted) { counted = true; localStorage.setItem(KEY_LAUNCH, String(n)); }
  return n;
}

/** 3번째 실행에 1회 — 상호작용(클릭·닫기) 시 KEY_ASKED 기록 후 영구 미표시. */
export function StarPrompt() {
  const [show, setShow] = useState(() =>
    localStorage.getItem(KEY_ASKED) == null &&
    Number(localStorage.getItem(KEY_LAUNCH) ?? "0") >= MIN_LAUNCHES,
  );
  if (!show) return null;
  const done = () => { localStorage.setItem(KEY_ASKED, "1"); setShow(false); };
  const star = () => { window.open(REPO_URL, "_blank", "noopener"); done(); }; // on_new_window → open_external
  return (
    <div role="status" className="rounded-lg border border-edge bg-panel p-3 text-xs shadow-xl">
      {/* 헤더(Star 아이콘·제목·X) / 본문 / 버튼 — HealthBanner LiveCard(:131-186) 구조 미러 */}
    </div>
  );
}
```

```tsx
// src/App.tsx
// (1) 마운트 효과 — 기존 효과들 옆
useEffect(() => { bumpLaunchCount(); }, []);
// (2) 우측 하단 카드 스택 — 기존 <HealthBanner />(:131-132) 자리
<div className="pointer-events-none fixed bottom-8 right-4 z-40 flex w-[380px] max-w-[calc(100vw-32px)] flex-col gap-2 [&>*]:pointer-events-auto">
  <HealthBanner />
  <StarPrompt />
</div>
```

```tsx
// src/components/common/HealthBanner.tsx — 루트(:105-114)를 Fragment로. 카드·로직 무변경.
return (
  <>
    {prev && <PrevSessionCard … />}
    {showLive && snap && <LiveCard … />}
  </>
);
```

`bumpLaunchCount`는 `StarPrompt`보다 **먼저** 실행돼야 3번째 실행에서 바로 뜬다 — `StarPrompt`의
초기 state가 마운트 시 localStorage를 읽으므로, App의 `useEffect`(자식 마운트 뒤 실행)에 두면 그 실행에서는
증가 전 값을 읽는다. 따라서 `bumpLaunchCount()`는 **App 컴포넌트 함수 본문 최상단**(렌더 중, 모듈 플래그로
멱등)이거나 `useState(() => bumpLaunchCount())`로 부른다. 후자를 채택한다(렌더 중 localStorage 쓰기를
한 번으로 고정).

## 5. 단계(구현 순서)

1. `StarPrompt.tsx` 작성(§4 — 마크업은 HealthBanner `LiveCard` 미러).
2. `App.tsx`: `useState(() => bumpLaunchCount())` + 스택 컨테이너 + `<StarPrompt />`.
3. `HealthBanner.tsx`: 루트 컨테이너 제거(Fragment).
4. 실기 검증(§7). `window.open` 경로가 어느 OS든 실패하면 §3.2 비상 대안으로 전환(그때 별도 커밋).

규모: **S** — 신규 1파일 ~70 LOC + App/HealthBanner 각 ~10 LOC.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| `window.open`이 위임되지 않음 | wry의 new-window 콜백 발화 조건은 플랫폼별(WebView2 `NewWindowRequested`, WKWebView `createWebViewWith`, WebKitGTK `create`)이고 이 앱에서 프론트 호출 선례가 없다 | 사용자 제스처(클릭) 안에서만 호출. §7에서 Windows·Linux 실측. 실패 시 `open_url` 커맨드로 대체(3.2) |
| 카운터 과다 증가 | 모듈 최상위 증가 → 풀 창·모아보기 창이 뜰 때마다 +1 | App 렌더 안에서만(§4). 회귀 체크: 별도 창을 열어도 `gp:launch-count` 불변 |
| StrictMode 이중 실행 | dev에서 마운트 2회 | 모듈 플래그 `counted` |
| HealthBanner 회귀 | 컨테이너를 App으로 옮기며 폭·z-index가 달라지면 경보 카드가 좁아지거나 토스트 아래로 | 클래스 문자열을 그대로 이동. 실기에서 `health://level` 강제 없이 `PrevSessionCard` 경로(`gp:prev-session-seen` 삭제 후 비정상 종료 시나리오)로 폭 확인 — 어려우면 DOM 검사로 컨테이너 클래스 일치 확인 |
| 네이티브 웹뷰에 가려짐 | 브라우저 탭이 우측 하단을 덮는다 | 기존 결정 승계(HealthBanner와 동일). 카드는 사라지지 않으므로 탭을 바꾸면 보인다 |
| dev 소음 | 개발자에게도 3번째 dev 실행에 뜬다 | 1회 닫으면 끝. DEV 가드를 두면 검증이 불가능해 두지 않는다 |

## 7. 검증

CDP(디버그 앱)로 localStorage를 조작한다 — 재시작 3회 대신 카운터를 직접 놓는다.

1. `localStorage.removeItem("gp:star-asked"); localStorage.setItem("gp:launch-count","2")` → 앱 재시작(또는
   dev 서버 리로드) → 카드가 우측 하단에 뜨는지, `gp:launch-count === "3"`인지.
2. 모아보기 별도 창·플로팅 창을 열었다 닫는다 → `gp:launch-count`가 그대로 3인지(보조 창 미집계).
3. [GitHub에서 Star 남기기] → **기본 브라우저**에 저장소 페이지. Windows: 브라우저가 뜬다. Linux: 브라우저
   프로세스가 앱 cgroup 밖인지(CLAUDE.md의 cgroup 계수법 — `cgroup.procs`에 브라우저 PID가 없어야 한다).
   macOS는 릴리스 전 1회.
4. 클릭 뒤 카드 소멸 + `gp:star-asked === "1"`. 리로드 → 카드 없음.
5. 1을 반복하되 X로 닫기 → 동일하게 `gp:star-asked` 기록·재표시 없음.
6. HealthBanner 동시 표시: `localStorage.removeItem("gp:prev-session-seen")` 후 지난 세션 비정상 종료
   상태를 만들기 어려우면, React DevTools 없이도 되는 방법으로 — 카드 스택 컨테이너의 클래스가 §4와
   일치하고 두 컴포넌트가 같은 부모 아래 있는지 DOM으로 확인. 둘 다 뜨는 상황은 e2e 대상이 아니다(수동).
7. 다크·라이트 테마 각 1회 — 카드 대비(`border-edge bg-panel`은 테마 토큰이라 자동).

## 8. 구현 결과(2026-09-02)

§5 단계 1~4 전부 구현. `npx tsc --noEmit` exit 0. Rust 변경 0. 신규 `StarPrompt.tsx` 82줄, `App.tsx` +33/-5(태스크 20 몫 포함),
`HealthBanner.tsx` +9/-4(루트 컨테이너 → Fragment).

### 8.1 설계 대비 이탈

| # | 이탈 | 이유 |
|---|---|---|
| 1 | `useState(() => bumpLaunchCount())` → `useState(bumpLaunchCount)` | React가 lazy initializer를 인자 없이 호출하므로 동일. 클로저 한 겹 제거 |

### 8.2 실기 관측값(디버그 앱, CDP 실입력)

| 항목 | 관측값 |
|---|---|
| `launch-count=2`, `star-asked` 삭제 → reload | `gp:launch-count === "3"`, 카드 표시, `role="status"`, 위치 right 16px / bottom 32px / width 380px, 스택 자식 1개 |
| 보조 창 미집계 | `float-pool-1` 창 reload 전후 카운트 불변(4 → 4) |
| **[GitHub에서 Star 남기기] 실클릭** | 기본 브라우저(Chrome) 창 제목 → `"imtelloper/gitpervisor - Google Chrome"`, chrome 프로세스 75 → 77, 웹뷰 콘솔 error/warn 0. **`window.open` → `on_new_window` → `open_external` 경로 Windows에서 정상** — §3.2 비상 대안(`open_url` 커맨드) 불필요 |
| 클릭 뒤 | `gp:star-asked === "1"`, 카드 소멸, reload 후 미표시 |
| X 경로 | 동일하게 `star-asked` 기록·재표시 없음 |
| 스택 컨테이너 | 클래스가 §4와 문자 단위 일치, `StarPrompt`는 그 직계 자식 |

### 8.3 하지 않은 것

- 다크/라이트 육안 확인 — 카드는 `border-edge bg-panel text-fg/fg-muted`(테마 토큰)만 쓴다(하드코딩 색 0).
- HealthBanner와 동시 표시 실물 — `PrevSessionCard`는 백엔드 `crashed=true`가 필요해 강제 불가. DOM 구조로 대체(§7-6 허용).
- Linux cgroup 확인·macOS — 이 머신은 Windows. 릴리스 전 각 1회 필요(§7-3).
