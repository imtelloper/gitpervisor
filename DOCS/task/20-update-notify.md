# 태스크 20 — 새 버전 알림 (persistent 토스트 + 설정 딥링크 + 주기 재확인)

> 상태: **구현 완료 · e2e 29 통과 · 실기(버전 하향 경로) 검증 통과** (2026-09-02, 미커밋) · 구현 결과는 §8 ·
> 근거: 코드 실측 2026-09-02 · 상위 설계: `DOCS/video-split-redock-notify-design.md` §3 (F3)

## 1. 요구사항

새 업데이트 버전이 나오면 **우측 하단**에 업데이트하라는 알림이 떠야 한다.

받아들이는 조건:
- 설치본을 **켜 둔 채로** 새 릴리스가 나와도(재시작 없이) 알림이 뜬다.
- 알림은 사용자가 닫기 전까지 남는다 — 6초 뒤에 사라지지 않는다.
- 알림의 버튼 하나로 **설정 › 업데이트 탭**에 바로 간다(일반 탭이 아니라).
- 같은 버전으로 두 번 조르지 않는다(세션당 1회). 닫았으면 그 세션엔 다시 안 뜬다.

## 2. 현황(근거)

- **알림 자체는 이미 있다.** `src/stores/updater.ts:76-80` — `check()`가 새 버전을 찾으면
  `pushToast("info", "새 버전 v… — 설정에서 업데이트", { label: "설정 열기", run: () => setSettingsOpen(true) })`.
  토스트 컨테이너는 우측 하단이다(`src/components/common/Toast.tsx:12`, `absolute bottom-8 right-4 z-50`).
  액션 버튼 1개(`:28-38`)와 수동 X(`:39-44`)를 지원한다.
- **문제 1 — 6초 자동 소멸.** `src/stores/ui.ts:470-474`의 `pushToast`가 `setTimeout(dismiss, 6000)`을
  하드코딩. 시그니처는 `(kind, message, action?)`(`:153-157`) — duration 인자 없음. `Toast` 타입은
  `{ id, kind, message, action? }`(`:6-12`).
- **문제 2 — 딥링크 없음.** `src/components/settings/SettingsDialog.tsx:71`
  `const [category, setCategory] = useState<SettingsCategory>("general")` — 로컬 state. 열림은
  `useUi.settingsOpen`(`:62-63`), 열기 효과(`:86-95`)는 폼·검색·시크릿만 초기화하고 카테고리는 건드리지
  않는다(닫았다 열면 **마지막 카테고리가 유지**된다 — 이 시맨틱은 보존). 카테고리 id `"update"`는 존재
  (`settings-index.ts:16-23` 타입, `:32` `CATEGORIES`). 사이드바 활성 표시는 `border-accent bg-selection`(`:309-311`).
- **문제 3 — 시작 시 1회.** `src/App.tsx:74-84`: `import.meta.env.DEV`면 건너뛰고(`:79`), `autoCheck`
  꺼져 있으면 건너뛰고(`:80`), 4초 뒤 `check({ silent: true })` 1회(`:81`). 이 앱 사용자는 설치본을 종일
  켜 둔다(CLAUDE.md) — 다음 재시작까지 새 릴리스를 모른다.
- **dev 가드는 계약이다.** CLAUDE.md: dev 창에서 "설치"를 누르면 **지금 쓰고 있는 설치본을 passive 모드로
  갈아엎는다**. 주기 재확인에도 같은 가드가 필요하다.
- 설치 흐름은 완비: `downloadAndInstall`(`updater.ts:101-149`), 엔드포인트·passive 모드
  (`src-tauri/tauri.conf.json:21-25`). 설정 › 업데이트 섹션(`sections/UpdateSection.tsx`)에 [지금 확인]
  (비-silent `check()`)과 [지금 업데이트하고 재시작]이 있다.
- **e2e 훅**: `window.__gpv = { ui, terminals }`(`src/main.tsx:48-52`, DEV 전용). e2e 29가
  `__gpv.ui.getState().setSettingsOpen(true)`로 설정을 연다(`29-settings-ux.mjs:13`).
- `settings-index.ts`는 lucide와 `lib/ipc` 타입만 import한다(`:1-14`) — `stores/ui.ts`가 여기서
  `SettingsCategory`를 **`import type`** 해도 런타임 순환이 없다.

## 3. 설계

### 3.1 알림 형태

| 대안 | 평가 |
|---|---|
| **A. 기존 토스트 + persistent 옵션** (채택) | 우측 하단·액션 버튼·X 전부 이미 있다. 바뀌는 건 "사라지지 않게"와 "어디로 가게" 두 가지. 신규 컴포넌트 0 |
| B. HealthBanner식 카드(태스크 21의 스택에 얹기) | 릴리스 노트까지 보여줄 수 있지만 요구에 없다. 21과 결합돼 순서 의존이 생긴다 |
| C. 타이틀바 배지 | "우측 하단 알림창" 요구와 다르다. 눈에 안 띈다 |

**A 채택.** persistent 토스트는 X로만 닫힌다. 액션 "업데이트 열기"를 누르면 토스트가 닫히고(기존 동작
`Toast.tsx:30-33`) 설정이 업데이트 탭으로 열린다.

### 3.2 설정 딥링크 — 1회성 소비

| 대안 | 평가 |
|---|---|
| **a. `useUi.settingsCategory: SettingsCategory \| null` + `openSettings(category?)`** (채택) | SettingsDialog가 열릴 때 값이 있으면 `setCategory` 후 null로 되돌린다. 기존 "마지막 카테고리 유지" 시맨틱과 e2e 29 단언 전부 보존 |
| b. `category`를 통째로 스토어로 이동 | 검색 자동 전환(`:113-116`)·유지보수 hidden 마운트(`:97-98`) 등 로컬 state에 얽힌 로직을 다 옮겨야 한다. 범위 초과 |

`openSettings(category?)`는 `setSettingsOpen(true)`의 상위 호환이다 — 기존 호출부는 그대로 두고,
딥링크가 필요한 곳(updater 토스트)만 새 액션을 쓴다.

### 3.3 주기 재확인 + 중복 방지

- `App.tsx:74-84` 효과에 `setInterval(() => check({ silent: true }), 12h)`를 추가한다. **같은 효과 안**에
  둬서 dev 가드·autoCheck 가드를 공유한다(가드 복제 금지 — 한쪽만 고쳐지는 사고 방지). 정리 함수에서
  `clearInterval`.
- `useUpdater.notifiedVersion: string | null`(메모리 전용). `check()`에서 새 버전이 발견됐을 때
  `notifiedVersion !== update.version`이면 토스트 + 기록, 같으면 상태만 갱신. 이 규칙은 silent·수동 공통이다
  — 수동 [지금 확인]은 설정 화면 안에 결과가 이미 보이므로 토스트가 없어도 손해가 없다.
- 12시간 근거: 릴리스 빈도(주 1회 미만) 대비 충분하고, 요청은 `latest.json` 1회 fetch라 트래픽이 무의미하다.
  `setInterval`은 절전 뒤 밀려 발화해도 무방하다.

### 3.4 만들지 않는 것

- "이 버전 건너뛰기"(버전별 영구 무시) — 요구에 없다. persistent + 세션당 1회로 충분.
- 알림 자체의 별도 옵트아웃 — `autoCheck`(설정 › 업데이트 › 시작 시 자동 확인)가 이미 그 스위치다.
  꺼져 있으면 초기 체크도 주기 체크도 돌지 않는다.

## 4. 계약(타입·액션)

Tauri 커맨드/이벤트/Rust 변경 **없음** — 순수 프론트엔드.

```ts
// src/stores/ui.ts
import type { SettingsCategory } from "../components/settings/settings-index"; // type-only — 런타임 순환 없음

export interface ToastOptions {
  /** 자동 소멸까지 ms. 기본 6000. `null`이면 사용자가 X로 닫을 때까지 유지. */
  durationMs?: number | null;
}

interface UiState {
  // 기존 …
  /** 설정 모달이 다음에 열릴 때 처음 보여줄 카테고리(1회성 — SettingsDialog가 소비 후 null). */
  settingsCategory: SettingsCategory | null;
  /** 설정 열기 + 선택적 딥링크. setSettingsOpen(true)의 상위 호환. */
  openSettings: (category?: SettingsCategory) => void;
  pushToast: (kind: Toast["kind"], message: string, action?: Toast["action"], opts?: ToastOptions) => void;
}

// 구현
settingsCategory: null,
openSettings: (category) => set({ settingsOpen: true, settingsCategory: category ?? null }),
pushToast: (kind, message, action, opts) => {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts, { id, kind, message, action }] }));
  const ms = opts?.durationMs === undefined ? 6000 : opts.durationMs;
  if (ms != null) setTimeout(() => useUi.getState().dismissToast(id), ms);
},
```

```tsx
// src/components/settings/SettingsDialog.tsx — 열기 효과(:86-95)에 합류
const requested = useUi((s) => s.settingsCategory);
useEffect(() => {
  if (!open || !requested) return;
  setCategory(requested);
  useUi.setState({ settingsCategory: null }); // 1회성 — 다음 일반 열기는 기존 시맨틱(마지막 카테고리 유지)
}, [open, requested]);
```

```ts
// src/stores/updater.ts
interface UpdaterState {
  // 기존 …
  /** 이번 세션에 토스트로 알린 버전 — 같은 버전은 다시 조르지 않는다(메모리 전용). */
  notifiedVersion: string | null;
}
// check() 내부, update 발견 분기(:67-80)
if (get().notifiedVersion !== update.version) {
  set({ notifiedVersion: update.version });
  useUi.getState().pushToast(
    "info",
    `새 버전 v${update.version}이 나왔습니다`,
    { label: "업데이트 열기", run: () => useUi.getState().openSettings("update") },
    { durationMs: null },
  );
}
```

```ts
// src/App.tsx — 기존 효과(:74-84) 확장. dev·autoCheck 가드는 그대로 앞에 둔다.
const UPDATE_RECHECK_MS = 12 * 60 * 60_000;
useEffect(() => {
  if (import.meta.env.DEV) return;                 // CLAUDE.md — 절대 빼지 않는다
  if (!useUpdater.getState().autoCheck) return;
  const run = () => void useUpdater.getState().check({ silent: true });
  const t = setTimeout(run, 4000);
  const iv = setInterval(run, UPDATE_RECHECK_MS);
  return () => { clearTimeout(t); clearInterval(iv); };
}, []);
```

## 5. 단계(구현 순서)

1. **ui.ts**: `ToastOptions`·`pushToast` 4번째 인자·`settingsCategory`·`openSettings`. `tsc`로 기존
   호출부 무영향 확인(인자 추가는 optional).
2. **SettingsDialog.tsx**: 딥링크 소비 효과(§4).
3. **updater.ts**: `notifiedVersion` + 토스트 교체(persistent · "업데이트 열기" · `openSettings("update")`).
4. **App.tsx**: 12h 인터벌(§4). dev 가드 위치 확인.
5. **e2e 29**: 딥링크 단언 추가(§7).
6. **실기 검증**(§7) — 정적 통과만으로 끝내지 않는다.

규모: **S** — 4파일 ~40 LOC + e2e 단언 2개.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| dev 가드 누락 | 인터벌을 별도 효과로 만들다 dev 가드를 빠뜨리면 dev 창이 설치본을 갈아엎을 수 있다 | 같은 효과 안에서 가드 공유(§3.3). 코드리뷰 체크 항목 |
| persistent 토스트가 다른 토스트를 밀어냄 | 토스트는 세로 스택(`Toast.tsx:12`) — 6초짜리 토스트가 그 위에 쌓였다 사라진다 | 정상 동작. 업데이트 토스트는 1개뿐이라 누적되지 않는다 |
| 토스트가 네이티브 브라우저 웹뷰에 가려짐 | 브라우저 탭이 우측 하단을 덮는 기존 한계(`HealthBanner.tsx:102-104` 주석) | 기존 결정 승계 — 사라지지 않으므로 탭을 바꾸면 보인다 |
| `notifiedVersion`이 더 새 버전을 막음 | 같은 세션에 v0.4.3 알림 후 v0.4.4가 나오면? | 버전 문자열 비교라 다르면 다시 알린다. 사용자는 새 토스트를 받고 이전 것은 남아 있을 수 있음 — X 2번. 허용 |
| 딥링크가 검색 자동 전환과 충돌 | 열릴 때 `query`는 리셋되므로(`:90`) `matched`가 null — 자동 전환 없음 | 충돌 없음(실측 순서: 열기 효과 → 딥링크 효과 → 검색 없음) |

## 7. 검증

**e2e 29 추가 단언**(같은 파일, 기존 셸 검사 뒤):
```js
await cdp.eval(`window.__gpv.ui.getState().openSettings("update")`);
await sleep(300);
const deep = await cdp.eval(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '업데이트');
  return { active: !!btn && btn.className.includes('border-accent'), body: document.body.textContent.includes('현재 버전') };
})()`);
r.check("딥링크: 설정이 업데이트 탭으로 열림", deep.active && deep.body, JSON.stringify(deep));
// persistent 토스트
await cdp.eval(`window.__gpv.ui.getState().pushToast("info","e2e-persistent",undefined,{durationMs:null})`);
await sleep(7000);
r.check("persistent 토스트 7초 후 생존", await cdp.eval(`document.body.textContent.includes('e2e-persistent')`));
await cdp.eval(`window.__gpv.ui.getState().toasts.forEach(t => window.__gpv.ui.getState().dismissToast(t.id))`);
```

**실기(디버그 앱, `npm run dev:app`)** — 새 릴리스 없이 "새 버전 발견" 경로를 밟는 방법:
1. `src-tauri/tauri.conf.json`의 `version`을 임시로 한 단계 낮춘다(예 0.4.2 → 0.4.1). **커밋 금지.**
2. dev 앱 실행 → 설정 › 업데이트 › [지금 확인] → `check()`가 최신 릴리스(0.4.2)를 발견 → 우측 하단 토스트.
3. 토스트를 그대로 두고 [지금 확인]을 한 번 더 → 토스트가 **1개**인지(중복 방지).
4. 토스트의 [업데이트 열기] → 설정이 업데이트 탭으로 열리는지. 닫고 ⚙로 다시 열면 마지막 카테고리
   유지(기존 시맨틱)인지.
5. 토스트를 60초 이상 방치 → 남아 있는지. X → 사라지고 [지금 확인] 재실행에도 다시 안 뜨는지.
6. **[지금 업데이트하고 재시작]은 누르지 않는다** — dev에서 설치를 누르면 설치본이 교체된다(CLAUDE.md).
7. `version`을 원복하고 `git diff`로 tauri.conf.json이 깨끗한지 확인.

주기 재확인(12h)은 실기로 기다리지 않는다 — 인터벌이 같은 `run`을 부르는지 코드로 확인하고,
필요하면 `UPDATE_RECHECK_MS`를 임시로 30초로 줄여 위 1~2 상태에서 토스트가 30초 뒤 **추가로 뜨지
않는지**(같은 버전 억제)만 본다. 원복 필수.

## 8. 구현 결과(2026-09-02)

§5 단계 1~6 전부 구현. `npx tsc --noEmit -p .` exit 0. Rust 변경 0.
`ui.ts` +22/-2 · `SettingsDialog.tsx` +10 · `updater.ts` +23/-5 · `App.tsx` +33/-5(태스크 21 몫 포함) · `29-settings-ux.mjs` +29/-1.

### 8.1 설계 대비 이탈

| # | 이탈 | 이유 |
|---|---|---|
| 1 | e2e 29 스니펫의 `sleep(300)`→`400`, 단언에 `consumed`(`settingsCategory === null`) 추가 | "1회성 소비" 계약을 e2e가 실제로 가드하도록 |
| 2 | (범위 밖 수리) `29-settings-ux.mjs:6`의 `REPO` 하드코딩(`C:/Users/…/DEVELOPMENT/gitpervisor`) → `import.meta.url`에서 유도 | 레포 이동 뒤 남은 옛 경로로 ⑤ 완전성 가드가 ENOENT 예외였다(선행 결함). 이 수정 전엔 29가 러너에서 통과할 수 없었다 |
| 3 | (범위 밖 수리) `tests/e2e/lib/cdp.mjs` `connect()`가 타이틀 매칭 페이지를 순회해 `currentWebview.label === "main"`인 것을 채택 | 프리워밍 풀 창(`float-pool-N`)에 붙어 스위트 13이 그 창을 닫으면 러너가 exit 13으로 멈추던 미해결 건(두 세션이 재현). 라벨을 못 읽는 옛 빌드는 첫 매칭 폴백 |

### 8.2 실기 관측값

**앱 재시작 없는 항목(CDP)**: 알림 탭 선택 → 닫고 일반 재오픈 → 여전히 알림(기존 시맨틱 유지) · `openSettings("update")` → 업데이트 탭
활성 + `현재 버전` 본문 + `settingsCategory: null`(소비) · 그 뒤 일반 열기 → 업데이트 탭(마지막 카테고리 유지, 고착 없음) ·
persistent/기본 토스트 동시 push → 1.0초 둘 다 존재, **7.2초 persistent만 존재** · 토스트 [업데이트 열기] 실클릭 → 업데이트 탭 + 토스트 소멸.

**"새 버전 발견" 경로**(`tauri.conf.json` version 0.4.2 → 0.4.1로 재빌드, 검증 후 0.4.2 원복 — `git diff` 빈 출력 확인):

| 단계 | 관측값 |
|---|---|
| 앱 버전 | `0.4.1` |
| 설정 › 업데이트 › [지금 확인] 실클릭 | 14초 후 토스트 `새 버전 v0.4.2이 나왔습니다`, 액션 `업데이트 열기`, 토스트 1개, 섹션에 `새 버전` 배지 |
| [지금 확인] 재클릭 | 토스트 **1개 유지**(`notifiedVersion` 억제) |
| 방치 | **75초** 후 생존(6초 소멸 없음) |
| X 클릭 | 토스트 0 |
| X 뒤 [지금 확인] 재실행 | 토스트 0 — 재표시 없음. 섹션의 `지금 업데이트하고 재시작`은 그대로(업데이트는 살아 있고 토스트만 억제) |
| [지금 업데이트하고 재시작] | **누르지 않음**(CLAUDE.md) |

**e2e 29(러너)**: 11 pass / 0 fail — 딥링크·persistent 단언 포함.

### 8.3 발견한 선행 이슈(수정 안 함)

- **설정 모달이 열려 있으면 토스트 X를 누를 수 없다** — `Toasts`(`absolute … z-50`)가 App에서 `SettingsDialog`보다 앞에
  렌더돼 같은 z-index에서 모달 오버레이 아래에 깔린다. 기존 구조. 업데이트 토스트의 액션은 클릭 시 토스트를 닫으므로
  실사용 동선엔 영향이 없지만, 모달을 연 채 토스트를 닫으려면 모달을 먼저 닫아야 한다.
- 12시간 주기 재확인은 실기로 기다리지 않았다 — 초기 `setTimeout`과 같은 `run` 클로저를 같은 가드 뒤에서 부르는 것을
  코드로 확인. 중복 억제는 위 표의 [지금 확인] 재클릭으로 같은 경로를 확인했다.
