# 태스크 03 — 테마 시스템 (다크 기본 + 다수 팔레트)

> 상태: 설계(Design) · 대상: gitpervisor (Tauri 2 + React 19 + TS + Tailwind v4) · 1차 플랫폼: **Windows (WebView2)**
> 산출물 성격: 아키텍처/계약/단계/위험 (구현은 후속)
> 근거: 코드 실측 2026-07-02. "현황"의 모든 주장은 실제 파일·라인 인용.

## 1. 요구사항

여러 가지 테마를 추가한다. 다크를 기본으로 유지하고, 라이트를 포함한 다수의 팔레트를 제공한다.
테마 전환은 UI(Tailwind 토큰) · 임베디드 터미널(xterm) · 에디터(Monaco) 3곳에 일관되게 반영되어야 한다.

## 2. 현황(근거)

**핵심 발견: 2-테마 시스템이 이미 존재한다.** 이 태스크는 "0→1"이 아니라 "2→N 확장 + 구조 정리 + 라이트 대응"이다.

### 2.1 DOM 토큰 (Tailwind v4 `@theme` + CSS 변수)
- `package.json:43` — `tailwindcss ^4.3.0`(+`@tailwindcss/vite ^4.3.0`). v4라 config 파일 없이 CSS `@theme` 블록이 토큰 원천.
- `src/styles.css:3-33` — `@theme` 블록에 색 토큰 18종 + 폰트 2종:
  `base / panel / raised / selection / edge / accent / accent-hover / on-accent / fg / fg-muted / fg-dim / ok / warn / danger / mod / add / del / untrk`, `--font-sans / --font-mono`. 기본값은 Darcula 계열 다크.
- `src/styles.css:41-64` — `:root[data-theme="monokai"]` 오버라이드 블록. **유틸리티(bg-base 등)가 `var(--color-*)`를 참조하므로 변수만 덮으면 전체가 바뀐다**는 패턴이 이미 검증돼 있다(styles.css:35-38 주석).
- `src/App.tsx:49-51` — `document.documentElement.dataset.theme = settings?.theme ?? "darcula"` (settings 쿼리 의존 useEffect). 즉 **settings 로드 전에는 항상 darcula로 첫 페인트** → 비-darcula 사용자에게 시작 플래시가 이미 존재.
- 테마를 못 따라가는 하드코딩 잔존: 스크롤바 썸 `#44464b`(styles.css:88), 체커보드 `#2b2d31`(styles.css:329), `.ai-working` 무지개 rgba 알파 0.26(styles.css:294-308) + 글로우 rgba(키프레임 styles.css:285-293) — 전부 다크 전제. `.ai-done`은 `var(--color-add)` 파생(styles.css:311-317)이라 안전.
- `src/lib/file-icon.tsx:42-91` — 파일 아이콘 브랜드색 하드코딩(#9CA3AF 회색류는 라이트 배경 대비 미확인).

### 2.2 설정 저장 경로
- `src-tauri/src/git/types.rs:199` — `pub theme: String`(주석: "검증·렌더는 프론트가 담당"), 기본값 `"darcula"`(types.rs:225). **백엔드는 자유 문자열 통과 — 테마 추가에 Rust 변경 불요.**
- `src-tauri/src/commands/settings.rs:10-25` — `get_settings`/`set_settings`(전체 Settings 통째 저장). 영속은 tauri store `settings.json`(`src-tauri/src/state.rs:15,114-118`).
- `src/lib/ipc.ts:132` — `export type ThemeName = "darcula" | "monokai"`; `Settings.theme: ThemeName`(ipc.ts:143).
- `src/queries/index.ts:555-575` — `useSettings`(staleTime Infinity) / `useSetSettings`(invalidate + 토스트).

### 2.3 동기화 대상 3곳
- **xterm**: `src/lib/terminal-engine.ts:28-44` `readTheme()`가 **CSS 변수를 getComputedStyle로 읽어** ITheme 생성(base→background, fg→foreground/cursor, raised→selectionBackground, fg-dim→brightBlack, mod→blue, add→green, accent→cyan). 단 **Terminal 생성 시 1회만** 적용(terminal-engine.ts:72). 폰트 크기와 동일한 한계(`src/components/workspace/TerminalPane.tsx:64` "fontSize는 생성 시점에만 쓰인다") — **테마 전환 후 이미 열린 터미널은 옛 색 유지**. 레지스트리는 `src/lib/terminal.ts:23` `registry: Map<string, TermInstance>` — 순회 재적용 가능(xterm 6.0.0 설치 확인, `term.options.theme` 재설정은 즉시 리렌더 — 단 xterm.d.ts 명시상 **새 객체 대입 필수**(참조 비교), readTheme()가 매번 새 객체를 반환하므로 충족).
- **Monaco**: `src/components/diff/monaco-setup.ts:39-76` `gitpervisor-dark`, :79-117 `gitpervisor-monokai` defineTheme(구문 rules + diff 오버레이 colors). 사용처 3곳이 **같은 삼항 매핑을 중복**: `DiffViewer.tsx:27-29`(monacoThemeOf), `MonacoBox.tsx:30-31`, `DbWorkspace.tsx:27-28`. 실시간 반영은 DiffViewer가 `monaco.editor.setTheme` effect로 이미 처리(DiffViewer.tsx:185-188, setTheme는 전역이라 전체 에디터에 적용).
- **플로팅 창(별도 OS 창)**: `src/main.tsx:38-53` — `float-<paneId>` 라벨 창은 `FloatingTerminal`만 렌더. `src/FloatingTerminal.tsx` 전체에 테마 코드 없음 → **플로팅 창은 항상 darcula 기본값으로 뜬다**(그 창의 xterm readTheme도 기본 변수를 읽음). [06-browser-popup-window.md](06-browser-popup-window.md)의 플로팅 창에도 동일 관심사.

### 2.4 선택 UI · E2E
- `src/components/settings/SettingsDialog.tsx:381-397` — `["darcula","monokai"] as const` 하드코딩 버튼 2개(스와치 없음). :265 주석 "테마는 후속 보류"는 낡음(이미 구현됨).
- `tests/e2e/run.mjs:80,96` — 테마 포함 설정 스냅샷/원복 이미 존재. `tests/e2e/suites/01-system.mjs:20-21` — get_settings 검증.

## 3. 설계(대안 비교 + 채택 근거)

### 3.1 테마 정의의 소스 구조

| 대안 | 내용 | 장점 | 단점 |
|---|---|---|---|
| A. TS 단일 소스 | themes.ts 객체에서 CSS 변수 주입(setProperty) + xterm + Monaco 전부 파생 | 진짜 한 소스 | JS 실행 전 무색(FOUC), Tailwind `@theme`와 이중화, 검증된 CSS 블록 패턴 폐기, 플로팅 창도 JS 주입 필요 |
| B. CSS = UI 원천, TS = 레지스트리(채택) | UI 토큰은 styles.css `[data-theme]` 블록(현행), xterm은 CSS 변수 파생(현행 readTheme), themes.ts는 메타(id/라벨/스와치)+Monaco 정의+xterm 보정만 | 기존 2테마 패턴 그대로 확장, 첫 페인트 무FOUC(기본 다크), 사람이 튜닝하기 쉬움 | 테마 1개 = styles.css 블록 + themes.ts 엔트리 **2곳**(성격이 달라 완전 통합 불가한 부분) |

**채택: B.** xterm은 이미 CSS 변수에서 파생되므로(terminal-engine.ts:28-44) "한 소스에서 파생"의 실질은 UI·터미널에 대해 성립한다. Monaco 구문 강조색(키워드/문자열/주석)은 UI 토큰으로 표현 불가능한 별개 팔레트라 TS에 있는 게 맞다. 2곳 동기화 누락은 E2E 가드(§5)로 방어.

### 3.2 전환 방식: `data-theme` 속성 (현행 유지)
- 클래스 전환(`class="theme-x"`) 대비: 이미 `:root[data-theme]`로 구현·검증됨(styles.css:41, App.tsx:50, method-color.ts:3 주석 "data-theme 자동 추종"). 다중 테마는 상호 배타 1값이라 속성이 의미상 정확(클래스는 중복 부착 실수 여지). **변경 없음.**

### 3.3 제공 테마 세트 (v1: 기존 2 + 신규 4 = 6)

| id | 종류 | 선정 근거 |
|---|---|---|
| `darcula` (기본, 유지) | 다크 | 현행 기본. JetBrains 컨벤션(styles.css:4,24 주석)과 정합 |
| `monokai` (유지) | 다크 | 현행. 로고 톤 정합(styles.css:39-40 주석) |
| `light` (신규) | 라이트 | IntelliJ Light 계열 — 앱 전반이 JetBrains 색 컨벤션이라 대응 라이트가 자연스럽고, 밝은 사무환경 수요의 대표 |
| `dracula` (신규) | 다크 | 공식 스펙(draculatheme.com)에 배경/전경/8색이 고정 정의 → UI·Monaco·ANSI 매핑 근거가 명확, 인지도 최상위 |
| `nord` (신규) | 다크(한색) | 공식 팔레트(nord0-15) + 공식 터미널/에디터 포팅 존재 → 매핑 근거 확보. 웜톤 darcula/monokai와 차별화 |
| `solarized-light` (신규) | 라이트(저대비) | 공식 16색 팔레트에 라이트/ANSI가 수학적으로 정의 → 라이트 2안으로 눈부심 민감층 커버 |

다크 4 : 라이트 2. Solarized Dark·GitHub 계열 등 추가는 후속(레지스트리에 엔트리만 추가하면 됨).

### 3.4 시스템 다크모드 자동 연동 — **YAGNI, v1 제외**
개발자 데스크톱 도구 + 다크 기본 사용층이라 OS 연동 수요가 낮고, 요구사항에도 없음. 후속 시 `ThemeName`에 `"system"` 추가 + `matchMedia("(prefers-color-scheme)")` resolve 함수 하나로 끝나는 구조를 §4 계약이 막지 않는다(themeOf가 resolve 지점).

### 3.5 실시간 반영 (3곳 동기화)
1. **DOM**: 현행 App.tsx effect 유지. 시작 플래시 완화로 **localStorage에 테마 id를 캐시**해 main.tsx에서 렌더 전 `dataset.theme` 선적용(비-darcula 사용자의 기존 플래시도 함께 해소).
2. **xterm**: 신규 `refreshTerminalThemes()` — registry 순회하며 `inst.term.options.theme = readTheme()`. App.tsx effect에서 `dataset.theme` 세팅 직후 호출(CSSOM 반영은 동기라 getComputedStyle 안전). 엔진 미로드(터미널 0개) 시 no-op이 되도록 코어(terminal.ts)에서 registry 비었으면 스킵.
3. **Monaco**: DiffViewer의 setTheme effect(:185-188) 패턴 유지. 삼항 중복 3곳은 themes.ts의 `monacoThemeOf()` 하나로 통합. `@monaco-editor/react`는 `theme` prop 변화로도 반영(MonacoBox/DbWorkspace).
4. **플로팅 창**: FloatingTerminal에 동일한 "settings→dataset.theme" effect 추가(창 생성 시 1회 반영, useSettings 재사용 — main.tsx:47에서 QueryClientProvider 이미 존재). 메인 창에서 테마 변경 시 열려있는 플로팅 창으로의 실시간 브로드캐스트(tauri emit)는 **후속**(플로팅 창은 단명, 빈도 낮음).

### 3.6 라이트 테마의 터미널 — ANSI 보정 필수
xterm 기본 ANSI 16색은 다크 배경 전제(밝은 노랑·흰색 출력이 라이트 배경에서 소실). readTheme의 CSS 파생만으론 부족 → ThemeMeta에 `xterm?: Partial<ITheme>` 보정 필드를 두고 readTheme가 병합. **라이트 2종에만 ANSI 16색 오버라이드 정의**(Solarized는 공식 ANSI 존재, light는 VS Code Light+ 팔레트 참조), 다크 4종은 현행 파생 유지. 다크 테마별 풀 ANSI 팔레트(Dracula/Nord 공식 터미널색)는 후속.

### 3.7 선택 UI (SettingsDialog)
하드코딩 배열 → `THEMES` 레지스트리 순회. 버튼당 **미리보기 스와치**(base 바탕 위 accent/add/danger 점 3개 — ThemeMeta.swatch) + 라벨. 6개라 2열 그리드. **라이브 프리뷰**: 클릭 즉시 `dataset.theme` 직접 세팅(+refreshTerminalThemes), 저장 없이 닫으면 `settings.theme`로 명시 복원(App effect는 settings 의존이라 자동 복원 안 됨 — App.tsx:49-51 실측 근거).

## 4. 계약(타입·커맨드·이벤트)

**백엔드 변경 없음.** `Settings.theme: String`(types.rs:199)은 자유 문자열이라 그대로 통과. 신규 Tauri 커맨드·이벤트 없음. 미지의 id(다운그레이드 등)는 프론트 `themeOf()`가 darcula로 폴백.

```ts
// src/lib/themes.ts (신규) — 테마 레지스트리
import type { ITheme } from "@xterm/xterm";

export type ThemeName =
  | "darcula" | "monokai" | "light" | "dracula" | "nord" | "solarized-light";

export interface ThemeMeta {
  id: ThemeName;
  label: string;                 // "다크 (Darcula)" 등 — SettingsDialog 표기
  kind: "dark" | "light";
  monacoTheme: string;           // defineTheme 이름 "gitpervisor-<id>"
  /** 스와치 미리보기 [base, accent, add, danger] — CSS 파싱 없이 정적 보관 */
  swatch: [string, string, string, string];
  /** 라이트 테마 등 CSS 파생만으론 부족한 xterm 보정(ANSI 16색 등). 다크는 생략 */
  xterm?: Partial<ITheme>;
}

export const THEMES: readonly ThemeMeta[];
export function themeOf(id: string | undefined): ThemeMeta;      // 미지 id → darcula
export function monacoThemeOf(id: string | undefined): string;   // 기존 3중복 대체
```

```ts
// src/lib/ipc.ts — 타입 확장만
export type ThemeName = /* themes.ts에서 re-export 또는 동일 유니온으로 확장 */;

// src/lib/terminal-engine.ts — 신규 export (코어 terminal.ts 경유 노출)
/** 열린 모든 터미널에 현재 CSS 변수 기반 테마 재적용. 레지스트리 비면 no-op. */
export function refreshTerminalThemes(): void;
// readTheme(): themes.ts의 themeOf(현재 data-theme).xterm 보정을 CSS 파생값에 병합
```

```css
/* src/styles.css — 테마당 블록 1개(monokai 패턴 미러). 18토큰 전부 오버라이드 */
:root[data-theme="light"] { --color-base: #f7f8fa; /* … 나머지 17토큰 */ }
:root[data-theme="dracula"] { --color-base: #282a36; /* … */ }
:root[data-theme="nord"] { --color-base: #2e3440; /* … */ }
:root[data-theme="solarized-light"] { --color-base: #fdf6e3; /* … */ }
/* 라이트 테마 상태 스타일 보정(알파·글로우 저감) — 토큰이 아니라 오버라이드로 */
:root[data-theme="light"] .ai-working,
:root[data-theme="solarized-light"] .ai-working { /* 저알파 그라데이션 */ }
```

```rust
// src-tauri — 변경 없음. (types.rs:198 주석 "darcula|monokai" 갱신만 — 문서성)
```

## 5. 단계(구현 순서)

1. **토큰 위생** — styles.css 하드코딩 3건을 테마 추종으로: 스크롤바 썸(:88)→`var(--color-raised)` 계열, 체커보드(:330)→`var(--color-panel)` 파생, `.ai-working`은 다크 공용 유지 + 라이트용 오버라이드 자리만 마련. 기존 2테마에서 시각 회귀 없음 확인.
2. **레지스트리 도입(기능 동일 리팩터)** — themes.ts 신설(darcula/monokai 2개로 시작), `monacoThemeOf` 3중복(DiffViewer/MonacoBox/DbWorkspace) 통합, SettingsDialog를 THEMES 순회+스와치로 교체, ipc.ts ThemeName 연결.
3. **실시간 반영** — `refreshTerminalThemes()` 추가 + App.tsx effect에서 호출, main.tsx localStorage 선적용(플래시 제거), FloatingTerminal에 테마 적용 effect, SettingsDialog 라이브 프리뷰/복원.
4. **다크 2종 추가** — dracula, nord: styles.css 블록 + monaco-setup defineTheme + THEMES 엔트리. (기존 다크 인프라 그대로라 위험 최소 — 먼저 납품 가능한 단위)
5. **라이트 2종 추가** — light, solarized-light: 위와 동일 + Monaco `base:"vs"` + diff 오버레이 라이트 색 + xterm ANSI 보정(ThemeMeta.xterm) + `.ai-working` 라이트 오버라이드. 대비 점검(fg-dim/del 등 WCAG AA — monokai 블록의 선례: styles.css:53,62 주석).
6. **E2E** — 신규 스위트: 각 THEMES id에 대해 `set_settings`→CDP로 `documentElement.dataset.theme`·`getComputedStyle(--color-base)` 변화·열린 xterm `options.theme.background` 일치 단언. 기존 스냅샷 원복(run.mjs:80)과 호환 확인. styles.css 블록↔THEMES 엔트리 짝 누락도 이 스위트가 잡는다.

규모: **M** (신규 코드 대부분이 팔레트 데이터. 로직은 refreshTerminalThemes + 레지스트리 + 다이얼로그 UI 정도)

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| 라이트 대비 붕괴 | diff 오버레이(현재 다크 알파 튜닝: monaco-setup.ts:67-72), `.ai-working` 글로우, file-icon 회색(#9CA3AF), `--color-del` 회색이 라이트 배경에서 저대비/과광 | 라이트 테마별 diff 색 명시 정의, `.ai-working` 라이트 오버라이드, 대비 4.5:1 체크(§5-5). file-icon 브랜드색은 유지하되 회색류만 토큰화 검토(후속) |
| 열린 xterm 재적용 부작용 | WebGL 렌더러(addon-webgl, terminal-engine.ts:3)에서 `options.theme` 교체 시 배경 재도색 검증 필요 | E2E에서 열린 터미널 배경색 단언(§5-6). 문제 시 refresh 후 `term.refresh(0, rows-1)` 강제 |
| 2곳 동기화 누락 | 테마 추가 시 styles.css 블록 또는 themes.ts 엔트리 한쪽 누락 → 반쪽 테마 | E2E가 THEMES 전 항목의 `--color-base` 변화를 단언(누락 시 기본값과 동일해 실패) |
| 다운그레이드/미지 id | 신규 테마 저장 후 구버전 실행 시 `theme:"nord"` 등 미지 값 | 백엔드는 자유 문자열이라 저장 무해, 프론트 `themeOf()` darcula 폴백(신·구 모두 안전) |

## 열린 질문(사용자 결정)

- 라이트 테마에서 **임베디드 터미널도 라이트 배경**으로 갈지(본 설계 채택: 라이트 + ANSI 보정), 아니면 VS Code처럼 UI만 라이트/터미널은 다크 유지가 취향인지.
- 제공 4종(light/dracula/nord/solarized-light) 외에 꼭 원하는 특정 테마가 있는지(예: Solarized Dark, GitHub Light — 후속 추가는 저비용).
