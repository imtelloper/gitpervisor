# 태스크 29 — 사용자 정의 테마(색 조합) 만들기

> 상태: **구현 완료 · 검증 통과(2026-09-03, 미커밋)** — 결과는 §8·§9 · 대상: gitpervisor ·
> 근거: 코드 실측 2026-09-03 · 선행: `DOCS/task/03-themes.md`(6종 레지스트리, 구현 완료)
>
> ⚠ **태스크 36([36-project-color-32slot.md](36-project-color-32slot.md))이 프로젝트 틴트 부분을
> 무효화했다**(구현·검증 2026-09-03 · 이 주석 2026-09-04). 이 문서에서 **프로젝트 틴트 5변수**
> (`--proj-l`, `--proj-a-on/off/row/row-on`)를 다루는 서술은
> 전부 낡았다 — §2, §3.3의 "생성 블록 내용" 불릿, **§4 계약의 `customThemeCss` 시그니처 주석("라이트 기반이면
> `--proj-*` 5개 포함"은 이제 거짓 — `THEME_TOKENS` 18개만 낸다)**, §6 위험표의 "프로젝트 틴트 5변수 사본" 행,
> §7 검증의 "틴트 5변수" 항목, §8.2 ⑭, **§8.4 미해결("틴트 5변수는 검증이 없다"는 항목은 해소됐다 —
> `LIGHT_TINT`가 삭제됐고 팔레트를 토큰에서 유도한다)**. (여기에 줄번호를 쓰지 않는 이유: 이 주석 블록이
> 본문을 아래로 밀어 자기 인용을 무효화한다.)
> 그 사본에는 버그도 있었다: `TINT[t.base]`가 상속원 id로 다크/라이트를 판정해 "다크 기반 + 라이트 색"
> 커스텀 테마를 반대로 칠했다(36 §2.6). 지금은 실제 팔레트로 판정한다(`project-color.ts:123`).
> 반대로 §6 위험표 1행(`BUILTIN_TOKENS` 사본이 styles.css와 어긋남)은 **위험이 커졌다** — 이제 그 상수가
> 프로젝트 팔레트 전체의 입력이다(36 §6). 본문은 그 시점의 기록으로 보존한다.

## 1. 요구사항

설정에서 사용자가 **색을 직접 조합해 자기 테마를 만들어 추가**할 수 있어야 한다.

받아들이는 조건:
- 설정 › 모양에서 "새 테마 만들기" → 이름·기반 테마·색을 고르면 목록에 내 테마가 생기고 기존 6종처럼 선택된다.
- 편집 중 **즉시 미리보기**(기존 6종의 클릭 미리보기와 동일), 저장하지 않고 닫으면 원래 테마로 복귀.
- 앱 전체(UI·터미널·Monaco 에디터·보조 창)에 적용되고 재시작 후에도 유지된다.
- 내 테마를 수정·삭제할 수 있다. 선택 중인 테마를 삭제하면 기반 테마로 돌아간다.
- Rust 변경 0.

## 2. 현황(근거)

- **토큰 원천은 CSS다.** `src/styles.css` `@theme` 블록(`:3-33`)이 darcula 기본 색 토큰 **18종**
  (`--color-base/panel/raised/selection/edge/accent/accent-hover/on-accent/fg/fg-muted/fg-dim/ok/warn/danger/mod/add/del/untrk`)을
  정의하고, `:root[data-theme="…"]` 블록 5개(monokai `:41-64` · dracula `:67-89` · nord `:92-114` · light `:118-140` ·
  solarized-light `:145-167`)가 18종 전부를 재정의한다. 테마별로 달라지는 변수가 5개 더 있다 — 프로젝트 틴트
  `--proj-l/--proj-a-on/--proj-a-off/--proj-a-row/--proj-a-row-on`(`:179-202`, 라이트 2종 셀렉터 나열). 변수 밖 테마별 CSS는
  `.ai-working` 글로우의 라이트 오버라이드(`:460-474`)뿐.
- **레지스트리** `src/lib/themes.ts`: `ThemeName` 6개 리터럴 유니온(`:9-15`), `ThemeMeta{id,label,kind,monacoTheme,swatch,xterm?}`
  (`:17-28`), `THEMES`(`:72-117`), `themeOf(id)`는 **미지 id를 darcula로 조용히 폴백**(`:120-122`), `monacoThemeOf`(`:125-127`).
  `kind`는 어디서도 읽히지 않는다(라이트 분기는 전부 CSS 셀렉터).
- **적용 경로**: `main.tsx:33-38`이 렌더 전에 `localStorage gp:theme` → `dataset.theme`(모든 창 공통). 메인 확정은
  `App.tsx:70-82`(`settings.theme` → dataset + `gp:theme` 저장 + `refreshTerminalThemes()`). 보조 창은 각자
  `dataset.theme = settings.theme`(`AggregateWindow.tsx:33-38`, `FloatingTerminal.tsx:65-71`, `DocWindow.tsx:41-44`,
  `SysMonitorWindow.tsx:215-220`).
- **xterm은 CSS 변수를 런타임에 읽는다**: `terminal-engine.ts:124-144` `readTheme()`이 `getComputedStyle`로 base/fg/raised/
  fg-dim/mod/add/accent를 읽어 ITheme을 만들고 `themeOf(id).xterm`(라이트 ANSI 보정)을 덮는다. `refreshTerminalThemes()`
  (`terminal.ts:128-135`)가 열린 xterm 전부를 갱신. 레포에서 `getComputedStyle`은 여기 하나, `style.setProperty`는 0건.
- **Monaco**: `src/components/diff/monaco-setup.ts`에 `defineTheme` 6개(`gitpervisor-dark` `:131` … `-solarized-light` `:356`),
  각각 `base: "vs-dark"|"vs"`, `rules[]`(토큰 색 15~17개), `colors{}`(editor.background/foreground/lineHighlight/lineNumber,
  diffEditor 6키, scrollbarSlider 2키, wordHighlight 3키). 소비처 `DiffViewer.tsx:186,:493,:670,:685`, `MonacoBox.tsx:31`,
  `DbWorkspace.tsx:28` — 전부 `monacoThemeOf(settings.theme)`.
- **설정 UI**: `AppearanceSection.tsx:17-41`이 `THEMES.map` 2열 그리드(스와치 = `t.swatch` 정적 hex), 클릭 →
  `previewTheme(id)`(`SettingsDialog.tsx:172-176`: `update("theme", id)` + dataset + refresh), 저장 안 하고 닫으면
  `closeWithoutSave`(`:179-186`)가 `settings.theme`로 복원. `buildCleaned`(`:27-42`)는 theme를 검증하지 않는다.
- **타입·검증 지점**: TS `ipc.ts:194 theme: ThemeName`(컴파일 타임 유니온 — 커스텀 id는 타입 에러), Rust
  `git/types.rs:205-207 pub theme: String`(자유 문자열, 주석에 "검증·렌더는 프론트 담당"), e2e
  `19-themes.mjs:16 THEME_IDS` 6개 하드코딩 + `--color-base`가 6자리 hex여야 통과(`:95-139`) + base 값 유일성(`:143-150`).
- **선례**: 터미널 세션별 컬러 스킴 `src/lib/term-color-schemes.ts` + `src/stores/termThemes.ts` — 정적 ITheme 팔레트를
  **localStorage `gp:term-themes`** 에 두고 `storage` 이벤트로 창 간 동기(`:82-93`). 사용자 데이터를 settings.json 밖에 두는 선례.
- 사용자가 만든 테마를 settings.json에 넣으면 5곳 연쇄(`types.rs`·`ipc.ts`·`settings-index.ts`·섹션 UI·e2e 29 완전성 가드)
  이고, 무엇보다 **렌더 전 선적용**(`main.tsx:33`)이 동기 localStorage에 의존하므로 어차피 localStorage 사본이 필요하다.

## 3. 설계

### 3.1 커스텀 테마의 표현 — "기반 테마 + 18토큰 오버라이드"

| 대안 | 평가 |
|---|---|
| **A. 기반 테마(6종 중 하나) + 색 토큰 18개** (채택) | 라이트/다크 성격·Monaco 문법색·xterm ANSI 보정·`.ai-working` 같은 비토큰 CSS를 기반에서 상속. 사용자는 색만 고른다 |
| B. 토큰 + Monaco 규칙 + ANSI 16색까지 전부 편집 | 50개 넘는 입력. 요구("색을 조합")에 과하다. 기반 상속으로 대부분 자동 해결 |
| C. 기존 테마 복제 후 CSS 텍스트 편집 | 개발자용. 설정 UI 요구와 안 맞는다 |

```ts
// src/lib/themes.ts (확장)
export type ThemeId = ThemeName | `custom-${string}`;        // Settings.theme 타입을 이것으로 넓힌다(ipc.ts:194)
export const THEME_TOKENS = ["base","panel","raised","selection","edge","accent","accent-hover","on-accent",
  "fg","fg-muted","fg-dim","ok","warn","danger","mod","add","del","untrk"] as const;   // styles.css @theme 18종과 1:1
export type ThemeToken = (typeof THEME_TOKENS)[number];
export interface CustomTheme {
  id: `custom-${string}`;            // crypto.randomUUID() 앞 8자
  name: string;                      // 표시 이름(중복 허용, 빈 문자열 금지)
  base: ThemeName;                   // kind·Monaco 규칙·ANSI 보정·비토큰 CSS의 상속원
  colors: Record<ThemeToken, string>;// "#rrggbb" 6자리 소문자 — e2e 19의 hex 정규식과 xterm 파생이 이 형식을 전제
  updatedAt: number;
}
export function isCustomThemeId(id: string): id is `custom-${string}`;
/** 커스텀이면 기반 메타에 id·label·swatch(colors에서 파생)만 바꿔 돌려준다 — 기존 소비처(terminal-engine의 .xterm 등) 무변경 */
export function themeOf(id: string): ThemeMeta;
```

### 3.2 저장 — localStorage `gp:custom-themes` + `storage` 동기(선례 `termThemes.ts`)

- `src/stores/customThemes.ts`(zustand): `themes: CustomTheme[]`, `upsert(t)`, `remove(id)`, `get(id)`. 저장은 JSON 통째 쓰기,
  손상 값은 `[]`. 다른 창의 변경은 `storage` 이벤트로 따라간다(각 창이 자기 스토어 인스턴스를 가지므로 필수).
- `Settings.theme`에는 **id만** 저장된다(Rust 자유 문자열 그대로). 정의(색)는 localStorage. 정의가 없는 id(다른 identifier의
  설정을 복사해 온 경우)는 `themeOf` 폴백으로 darcula가 되고 설정 UI에 "정의를 찾을 수 없음" 표시 — 조용히 죽지 않는다.

### 3.3 적용 — `data-theme` 블록을 `<style>`로 생성(인라인 변수 주입이 아니라)

| 대안 | 평가 |
|---|---|
| **A. `<style id="gp-custom-themes">`에 `:root[data-theme="custom-…"]{18토큰}` 블록 생성** (채택) | `dataset.theme = id` 관례가 그대로 유효 → 보조 창 4개의 기존 코드(`dataset.theme = settings.theme`)를 **한 줄도 안 고쳐도** 색이 맞는다. xterm `readTheme()`·e2e 19의 `dataset.theme === id` 단언도 그대로 |
| B. `documentElement.style.setProperty` 인라인 주입 | 내장 테마로 돌아갈 때 18개를 `removeProperty`로 지워야 하고, 그 정리 코드가 모든 창·모든 전환 경로에 있어야 한다. 한 곳이라도 빠지면 색이 섞인다 |

- `src/lib/theme-apply.ts`(신규): `installCustomThemeStyles()` — localStorage에서 목록을 읽어 `<style>` 내용을 재생성.
  `main.tsx`의 선적용(`:33-38`) **직전**에 1회 호출(모든 창 공통 경로) + `storage` 이벤트(`gp:custom-themes`)에서 재생성.
  이렇게 하면 다른 세션이 작업 중인 `FloatingTerminal.tsx`·`AggregateTerminals.tsx`를 건드리지 않는다.
- 생성 블록 내용: 18토큰 + **기반이 라이트면 프로젝트 틴트 5변수**를 라이트 값으로(`styles.css:189-202`의 값을
  `theme-apply.ts` 상수로 복제 — 주석으로 원본 위치 명시. 그 블록은 다른 세션이 태스크 28로 편집 중이라 이번엔 손대지 않는다).
  `.ai-working` 라이트 글로우는 복제하지 않는다(장식, §6).
- Monaco: `monaco-setup.ts`의 6개 `defineTheme` 인자를 `MONACO_THEMES: Record<ThemeName, IStandaloneThemeData>`로 끌어올려
  그대로 등록하고, `ensureMonacoTheme(id: ThemeId): string`을 추가 — 커스텀이면 기반의 `base/rules`를 복사하고 `colors`의
  `editor.background←base, editor.foreground←fg, editor.lineHighlightBackground←raised, editorLineNumber.foreground←fg-dim,
  editor.selectionBackground←selection, diffEditor.insertedTextBackground/removedTextBackground←add/del 알파, scrollbarSlider←raised·edge`
  로 채워 `gitpervisor-custom-<id>`를 정의(멱등)하고 그 이름을 돌려준다. 소비처 3곳(`DiffViewer`·`MonacoBox`·`DbWorkspace`)의
  `monacoThemeOf(theme)`를 `ensureMonacoTheme(theme)`로 교체(monaco 모듈이 로드된 컴포넌트 안이라 define 가능). 내장 id는
  기존 이름 그대로.
- 전환 시 `refreshTerminalThemes()`는 기존 경로(App effect·previewTheme)가 이미 부른다. 커스텀 정의를 **편집 중**(색 드래그)에는
  `<style>` 재생성 + `refreshTerminalThemes()`를 150ms 디바운스로.

### 3.4 설정 UI — 모양 섹션 확장

- 기존 6종 그리드 아래 **"내 테마"** 소제목: 커스텀 카드(스와치 = colors[base/accent/add/danger], 이름, `편집`·`삭제` 아이콘) +
  `+ 새 테마 만들기`. 카드 클릭은 내장과 같은 `previewTheme(id)`.
- 편집기는 **섹션 안 인라인 패널**(새 모달 아님 — SettingsDialog의 Esc 계층·저장 모델을 건드리지 않는다):
  이름 · 기반 테마 `<select>` · 색 18개(`<input type="color">` + hex 텍스트, 그룹: 배경 5 · 텍스트 3 · 강조 3 · 상태 3 · diff 4)
  · 대비 힌트 `fg/base`·`fg-muted/base`·`on-accent/accent` 비율과 AA 배지(4.5:1) — 계산은 `theme-apply.ts`의 `contrastRatio`
  (WCAG 상대 휘도, e2e 19의 계산과 같은 식) · `[저장]` `[취소]`.
  - 새로 만들기: 기반 테마의 현재 값을 초기값으로(`getComputedStyle`이 아니라 **styles.css 값의 정적 사본**이 필요하다 —
    `theme-apply.ts`에 `BUILTIN_TOKENS: Record<ThemeName, Record<ThemeToken,string>>`을 둔다. 사본 유지 비용은 §6).
  - 편집 중 값 변경 = 즉시 미리보기(§3.3 디바운스). 저장 → `customThemes.upsert` + `previewTheme(id)`(= form.theme=id).
    취소 → 편집 전 상태 복원(`previewTheme(form.theme)`).
  - 삭제: 확인 다이얼로그(`askConfirm`). 선택 중이던 테마면 `previewTheme(base)`.
- `settings-index.ts`의 theme 항목 keywords에 "커스텀","내 테마","custom" 추가(검색). 신규 Settings 필드는 없다.

### 3.5 만들지 않는 것

- 테마 내보내기/가져오기(JSON) — 후속. 사용자 요구는 "조합해서 넣기".
- ANSI 16색·Monaco 문법색 편집 — 기반 상속.
- 시스템 다크모드 연동(03 문서에서 이미 제외).

## 4. 계약

```ts
// src/lib/theme-apply.ts (신규)
export const BUILTIN_TOKENS: Record<ThemeName, Record<ThemeToken, string>>;   // styles.css 6블록의 정적 사본(주석: 원본 줄)
export function installCustomThemeStyles(): void;      // <style id="gp-custom-themes"> 생성/갱신 — main.tsx 선적용 직전 + storage 이벤트
export function customThemeCss(t: CustomTheme): string; // ":root[data-theme=\"custom-…\"]{…}" (라이트 기반이면 --proj-* 5개 포함)
export function contrastRatio(hexA: string, hexB: string): number;
export function normalizeHex(v: string): string | null;  // "#RGB"/"#RRGGBB"/"rrggbb" → "#rrggbb", 아니면 null

// src/stores/customThemes.ts (신규)
export const useCustomThemes: { themes: CustomTheme[]; upsert(t: CustomTheme): void; remove(id: string): void; get(id: string): CustomTheme | undefined };

// src/lib/themes.ts
export type ThemeId = ThemeName | `custom-${string}`;
export function themeOf(id: string): ThemeMeta;           // 커스텀 → 기반 메타 + {id,label:name,swatch:[base,accent,add,danger]}
// src/lib/ipc.ts:194   theme: ThemeId;
// src/components/diff/monaco-setup.ts
export const MONACO_THEMES: Record<ThemeName, monaco.editor.IStandaloneThemeData>;
export function ensureMonacoTheme(id: ThemeId): string;   // 내장 → 기존 이름, 커스텀 → 정의(멱등) 후 "gitpervisor-custom-<id>"
```

DEV `__gpv`에 `customThemes: useCustomThemes` 노출(e2e).

## 5. 단계

1. `themes.ts` 타입 확장 + `theme-apply.ts`(BUILTIN_TOKENS·CSS 생성·설치·대비) + `customThemes.ts`. `main.tsx` 선적용 직전 설치 1줄 + `__gpv` 노출.
2. `monaco-setup.ts` `MONACO_THEMES` 추출 + `ensureMonacoTheme`; 소비처 3곳 교체.
3. `AppearanceSection.tsx` 내 테마 목록 + `CustomThemeEditor.tsx`(신규, 섹션 파일 옆) + `SettingsDialog.tsx` `previewTheme` 타입을 `ThemeId`로.
4. e2e 19 확장(§7) + 실기.

규모: **M** — 신규 3파일(~350 LOC) + 수정 6파일(~120 LOC). Rust 0.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| `BUILTIN_TOKENS` 사본이 styles.css와 어긋남 | 내장 테마 색을 바꾸면 초기값이 낡는다 | e2e 19에 "내장 6종 × 18토큰: `getComputedStyle` 값 == BUILTIN_TOKENS" 짝 검증 추가(테마 전환 루프가 이미 있다) |
| 프로젝트 틴트 5변수 사본 | 다른 세션이 태스크 28로 `--proj-*`를 편집 중 | 커스텀 블록엔 라이트 기반일 때만 넣고 원본 줄을 주석에 — 28 커밋 뒤 값 대조 1회 |
| 다른 identifier로 설정 복사 시 정의 없음 | `theme=custom-…`인데 localStorage에 정의가 없음 | `themeOf` 폴백(darcula) + 모양 섹션에 "정의를 찾을 수 없어 기본 테마로 표시 중" 문구 |
| 6자리 hex 외 입력 | `<input type=color>`는 항상 `#rrggbb`; 텍스트 입력은 `normalizeHex`로 정규화, 실패 시 저장 버튼 비활성 | e2e 19 정규식·xterm 파생이 깨지지 않는다 |
| 편집 중 미리보기 부하 | 색 드래그마다 `<style>` 재생성 + xterm 전체 갱신 | 150ms 디바운스, 열린 xterm 수는 작다 |
| 보조 창 동기 | 창별 스토어 | `storage` 이벤트로 `<style>` 재생성(정의 변경)·`gp:theme`(선택 변경은 기존 각 창 effect) |
| `.ai-working` 라이트 글로우 미적용 | 라이트 기반 커스텀에서 다크 글로우 색 | 장식 요소. 후속에서 `data-kind` 셀렉터로 정리(28 커밋 뒤 styles.css 정리 시) |

## 7. 검증

- **e2e 19 확장**: `__gpv.customThemes.getState().upsert({...base:"dracula", colors:{...BUILTIN_TOKENS.dracula, base:"#101010"}})` →
  `set_settings({theme:"custom-e2e"})` → `dataset.theme === "custom-e2e"`, `--color-base` 계산값 `#101010`, 열린 xterm 배경 `rgb(16,16,16)`,
  `document.getElementById("gp-custom-themes").textContent`에 블록 존재, Monaco(`__monaco`가 있으면) 현재 테마명
  `gitpervisor-custom-custom-e2e` 정의 존재 → `remove` → 정의 소멸·설정은 기반으로 복귀. 기존 6종 루프·유일성 단언은 그대로.
- **실기**: 설정 › 모양 › 새 테마 → 색 3개 바꾸며 미리보기(사이드바·터미널·diff 에디터가 즉시 바뀌는지) → 저장 → 재시작 후 유지 →
  플로팅 창·모아보기 별도 창을 열어 같은 색인지 → 편집 → 삭제 → 기반으로 복귀. 라이트 기반 커스텀에서 사이드바 행 틴트가
  읽히는지(틴트 5변수).

## 8. 구현 결과(2026-09-03)

검증 환경: dev 빌드(CDP 29222)에 붙어 e2e 19 격리 실행 + CDP 실클릭 실기. Rust 변경 0, `npx tsc --noEmit` 통과.

### 8.1 설계와 어긋난 점(3건)

| # | 설계 | 구현 | 판단 |
|---|---|---|---|
| ① | §2가 `monacoThemeOf`(`themes.ts:125-127`)를 현황으로 두고 §3.3은 소비처 3곳만 교체 | `monacoThemeOf`를 **삭제**하고 `ensureMonacoTheme`(`monaco-setup.ts:415`)이 유일한 진입점 | 수용. 소비처가 3곳뿐이라 남기면 "커스텀을 모르는 경로"가 하나 더 사는 셈 |
| ② | §4는 DEV `__gpv`에 `customThemes`만 노출 | `builtinTokens: BUILTIN_TOKENS`도 노출(`main.tsx:69`) | 수용. §6 위험표 1행(사본 ↔ styles.css 어긋남)의 짝 검증이 이것 없이는 불가능하다 |
| ③ | §3.3은 편집 중 미리보기도 `installCustomThemeStyles()` 재생성(디바운스) | 저장된 정의는 건드리지 않고 **별도 `<style id="gp-custom-theme-preview">`** 를 뒤에 얹는다(`CustomThemeEditor.tsx:17,:80-92`) | 수용. 취소 시 그 요소만 지우면 원상태 — 스토어를 더럽히지 않는다(설계안대로면 초안이 localStorage에 들어갔다 지워진다) |

### 8.2 관측값

**e2e 19(`tests/e2e/suites/19-themes.mjs`) 격리 실행: 38 pass / 0 fail / 1 skip.** 스킵은 Monaco 레지스트리
검사 — 이 스위트는 에디터를 띄우지 않는다(아래 실기 ⑨에서 직접 확인).

실기(설정 › 모양을 `Input.dispatchMouseEvent` 실클릭으로 몰고, 색만 값 주입 + `input` 이벤트):

| # | 검사 | 관측 |
|---|---|---|
| ① | 새 테마 만들기 → 미리보기 `<style>` 생성 + `dataset.theme`=draft id | `custom-b1e10265`, 클릭 후 ~174ms |
| ② | 기반 `dracula` 선택 → `--color-panel` | `#21222c` |
| ③ | 바탕 `#101010` · 강조 `#ff8800` (150ms 디바운스) | `--color-base=#101010` `--color-accent=#ff8800` |
| ④ | 타이틀바(`header.bg-panel`) · 사이드바 계산 배경 | 둘 다 `rgb(33, 34, 44)`(= dracula panel), 변경 전 `rgb(12, 18, 27)` |
| ⑤ | `body` 배경 · 열린 xterm(`.xterm-scrollable-element`) | `rgb(16, 16, 16)` / `rgb(16, 16, 16)` |
| ⑥ | 편집기 저장 → `gp-custom-themes` 블록 생성 · 미리보기 `<style>` 제거 | 둘 다 기대대로 |
| ⑦ | 설정 푸터 저장 → `get_settings().theme` · `gp:theme` 캐시 | 둘 다 `custom-b1e10265` |
| ⑧ | 재오픈 → Esc(`closeWithoutSave`) | `dataset.theme`·`--color-base` 유지 |
| ⑨ | Monaco(뷰어에 `src/app.txt`) 현재 테마명 / `.monaco-editor` 배경 | `gitpervisor-custom-custom-b1e10265` / `rgb(16, 16, 16)`. `_knownThemes`에 내장·커스텀 모두 등록(13개) |
| ⑩ | 보조 창 `open_sysmon_window` → `connectLabel("sysmon")` | `dataset.theme`=커스텀 id, `--color-base=#101010`, 새 문서에도 `<style>` 블록 존재(= 재시작 경로인 `main.tsx` 선적용이 동작) |
| ⑪ | 편집 중 색 변경 → 취소 | `#00ff00` 미리보기 → 취소 후 `#101010` 복귀, 저장 정의 무변경 |
| ⑫ | 정의 삭제(`gp:custom-themes` 제거 + `storage` 이벤트) | `--color-base` `#1e1f22`(darcula 폴백) + 설정에 "정의를 찾을 수 없어…" 문구 |
| ⑬ | 삭제(휴지통 → 확인 다이얼로그) | `dataset.theme`=`dracula`, `<style>` 블록 소멸, `--color-base=#282a36` |
| ⑭ | 라이트 기반 커스텀의 프로젝트 틴트 5변수 | `light` 기반 = `50%/0.42/0.2/0.1/0.15`, `solarized-light` 기반 = `…/0.06/0.1` — **내장 동명 테마와 완전 일치**(`theme-apply.ts`의 `LIGHT_TINT` 사본이 `styles.css:191-201`과 아직 어긋나지 않았다) |

합계 43 pass / 0 fail(실기) + 3 pass(Monaco 별도 실행).

### 8.3 고친 것

- **편집 중 설정 카테고리를 옮기면 앱 전체가 기본 테마 색으로 떨어졌다.** `AppearanceSection`이 언마운트되면
  편집기의 언마운트 정리가 미리보기 `<style>`만 지우고 `<html data-theme>`에는 **저장 안 된 draft id**가 남아
  정의 없는 테마가 된다(실측: 모양 → 새 테마 만들기 → 일반 클릭 → `--color-base`가 `#101010`에서 `#1e1f22`로).
  설정을 닫아야 복구됐다. `AppearanceSection.tsx`에 언마운트 가드를 넣어 **"현재 dataset이 정의 없는 커스텀
  id일 때만"** 편집 시작 시점 테마로 되돌린다 — 저장(정의 생김)·취소(이미 유효 id)·다이얼로그 닫기
  (`closeWithoutSave`가 저장값을 이미 넣음) 세 경로는 조건에 걸리지 않아 무해하다. 재실측으로 확인.
- **e2e 19의 Monaco 레지스트리 조회 경로가 틀렸다.** `monaco.editor._themeService`는 `undefined`라 검사가
  항상 `"unreachable"` 스킵이었다. 레지스트리는 **마운트된 에디터**의 `_themeService._knownThemes`로만 닿는다
  (실측). 그 경로로 고쳐 에디터가 떠 있는 전체 러너에서는 실제 단언이 되게 했다(격리 실행은 `"no-editor"` 스킵).

### 8.4 미해결

- **Monaco 검사는 19 단독 실행에서 여전히 스킵**이다(이 스위트가 에디터를 띄우지 않는다). 에디터를 띄우면
  픽스처 파일 열기·뷰어 탭 정리가 따라붙어 스위트 성격이 바뀐다 — 커버리지는 §8.2 ⑨의 실기로 대신한다.
- `.ai-working` 라이트 글로우는 커스텀 블록에 복제되지 않는다(설계 §6이 수용한 항목). 라이트 기반 커스텀에서
  글로우만 다크 값이다.
- `BUILTIN_TOKENS`·`LIGHT_TINT`는 `styles.css`의 정적 사본이다. 토큰 18종은 e2e 19가 짝 검증하지만
  **틴트 5변수는 검증이 없다** — 이번엔 수동 대조(§8.2 ⑭)로 확인했다.
- 선택 중인 커스텀 테마를 삭제한 뒤 설정을 **저장하지 않고** 닫으면 `settings.theme`은 삭제된 id로 남는다
  (다음 실행에 "정의를 찾을 수 없음" 문구로 노출). 설계 §3.2가 받아들인 고아 id 경로와 같은 상태다.
