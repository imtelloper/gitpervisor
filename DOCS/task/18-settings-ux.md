# 태스크 18 — 설정 모달 UX 재설계 (사이드바 카테고리 + 검색)

> 상태: 설계(Design) · 대상: gitpervisor · 산출물 성격: UI 아키텍처/계약/단계/위험 (구현은 후속)
> 근거: 코드 실측 2026-07-07(병렬 2에이전트 — ①SettingsDialog 정밀 해부 ②앱 모달/UI 관례 전수) + 사용자 스크린샷 피드백("설정할 게 많아지면서 스크롤 압박")

## 1. 요구사항

설정 모달이 **단일 스크롤 컬럼**(w-500px)에 8개 섹션·22개 설정 필드 + 즉시 액션 3종이 쌓여
"어디에 뭐가 있는지 모르고, 찾으려면 끝까지 스크롤"이 됐다. 태스크 15~17(포매터·린터·LSP)이
섹션을 3개 늘린 직접 원인 — 앞으로도 늘어난다(언어 서버 추가 등).

- **탐색성**: 원하는 설정을 스크롤 없이 2클릭(카테고리 클릭) 또는 타이핑(검색)으로 도달.
- **확장성**: 새 설정 그룹이 카테고리 1개 추가로 흡수되는 구조.
- **시맨틱 보존**: 현행 저장 모델(폼 편집 → 저장/취소, 배경클릭=취소)과 특수 동작(테마 라이브
  프리뷰+미저장 복원, 시크릿 "빈 값=변경 안 함", 테스트 전송의 선저장, LSP 다운로드 진행 상태)을
  **하나도 깨지 않는다** — 이번 작업은 정보 구조(IA) 개편이지 저장 모델 재설계가 아니다.
- 신규 백엔드 0 — 프론트 전용.

## 2. 현황(근거)

### 2.1 현행 구조 — 단일 컬럼의 실측 (src/components/settings/SettingsDialog.tsx, 총 860줄)

| # | 섹션 | 라인 | 폼 필드 | 특이사항 |
|---|---|---|---|---|
| 1 | (무제목 일반) | 479–564 | 5 | 테마 그리드(480–507) = `previewTheme` 라이브 적용, gitPath 아래 `useGitCheck` 상태(555–564) |
| 2 | 포매터 / 린터 | 566–610 | 4 | 공급망 경고 인라인(605–609) |
| 3 | LSP | 612–666 | 2 | 다운로드 버튼(619–630, `lspBusy`/`lspStatus`), 프로젝트 체크리스트 `max-h-40`(631) |
| 4 | 터미널 | 668–696 | 2 | |
| 5 | 알림 | 698–833 | 9 | +시크릿 2(키링, Settings 밖), 테스트 전송 2(`handleTest`), 토글 시 조건 렌더(736, 768) |
| 6 | 브라우저 | 835 | 0 | 즉시 액션(초기화, askConfirm) — 정의 175–215 |
| 7 | 진단 / 로그 | 837 | 0 | 패닉 로그 뷰어 — 정의 221–315 |
| 8 | macOS 격리 도구 | 839 | 0 | `{isMacOS && …}` 조건부(29, 839) — 정의 57–168 |

- 셸: 오버레이 `fixed inset-0 z-50 … bg-black/50` + 배경클릭=`closeWithoutSave`(458–461), 패널
  `max-h-[85vh] w-[500px] … p-5`(462–465), 바디 단일 스크롤(478), 푸터 취소/저장(842–856).
  **Esc 처리 없음**(파일에 keydown 전무).
- Settings 22필드 전부 렌더됨(ipc.ts:189–216 ↔ 렌더 매핑 전수 확인 — 누락 0).
- 열림 상태는 useUi `settingsOpen`(319–320), 컴포넌트는 **항상 마운트 + 조건부 null**(370).

### 2.2 폼 상태 흐름 — 보존해야 할 시맨틱 5종
- **테마 라이브 프리뷰**: `previewTheme`(377–381)가 dataset.theme 직접 조작 + `refreshTerminalThemes()`.
  미저장 닫기 복원은 `closeWithoutSave`(385–392) — 배경클릭·X·취소 3곳이 전부 이 함수(460, 471, 844).
- **폼 초기화**: useEffect `[open, settings]`(360–368) — 모달 열린 채 settings refetch되면 편집 중 값이
  통째로 리셋되는 잠복 특성. 재설계에서 악화시키지 말 것.
- **시크릿**: 빈 입력="변경 안 함"(상태 353–357, persist 로직 420–429), placeholder가 `slackHas`/`smtpHas`로 저장 여부 표현(렌더 741–745, 808–815).
- **테스트 전송**: `handleTest`(445–455)가 **전체 설정+시크릿을 선저장** 후 발송 — 탭별 저장과 구조 충돌.
- **LSP 다운로드**: `lspBusy`/`lspStatus` 로컬 상태(330–352) — 항상 마운트 구조 덕에 닫아도 진행 유지.

### 2.3 앱 모달/UI 관례 — 재설계가 따를 표준 (전수 실측)
- **좌우분할 모달 전례 2건(직접 전례)**: EnvDialog.tsx:62,75–128 — `flex h-[480px] w-[680px] flex-col
  overflow-hidden` + 좌 `w-48 shrink-0 border-r border-edge` / MemoDialog.tsx:118–166 — `h-[560px]
  w-[820px]` row flex + 좌 `w-[240px]`(헤더+스크롤 리스트+하단 버튼). **grid 없음, 전부 flex.**
- **사이드바 활성 항목**: 다수 관례 = `bg-selection`(MemoDialog.tsx:136–138, FileTreePanel.tsx:169),
  강조형 = `border-l-2 border-accent bg-selection`(ProjectItem.tsx:94–98). EnvDialog만 예외(bg-raised).
- **검색 입력(투명 인라인형)**: 보더 행 안 `bg-transparent … placeholder:text-fg-dim`(QuickPick.tsx:143–151,
  SearchPanel.tsx:62–80 동일 계열).
- **Esc 관례**: open 동안 window keydown + **위층 양보 가드** `!ui.prompt && !ui.confirm`
  (ImageEditor.tsx:364–372). 입력 내 Esc는 stopPropagation(PromptDialog.tsx:56–67 주석).
- **레이어**: 일반 모달 z-50, 그 위 confirm/prompt/QuickPick z-[60](ConfirmDialog.tsx:12 등) —
  설정 모달 안에서 askConfirm(브라우저 초기화)이 뜨는 관계가 이미 성립.
- **색 토큰**: styles.css:3–33 `@theme`(base/panel/raised/selection/edge/accent·on-accent/fg 3단/상태색).
  accent 위 텍스트는 `text-on-accent`(라이트 테마 대비 — text-white 하드코딩 금지).
- **외부 결합**: BrowserPane.tsx:100–106이 `settingsOpen`을 구독해 모달 열림 중 네이티브 webview를
  숨긴다 — **useUi 플래그 이름·시맨틱 유지 필수**.
- 재사용 가능: `Field`(34–50)·`inputCls`(31) — 그대로. `TabChip`(WorkspaceTabs.tsx:296–301)은 로컬
  미export(쓰려면 추출).

## 3. 설계

### 3.0 전체 그림

```
┌─ 설정 (w-[860px] h-[min(640px,85vh)]) ────────────────────────────┐
│ ⚙ 설정                                                      ✕    │ ← 헤더(border-b)
├──────────────┬─────────────────────────────────────────────────────┤
│ 🔍 검색       │  모양                                               │
│──────────────│  ┌──────────┬──────────┐                            │
│ 일반          │  │ 테마 그리드 (라이브 프리뷰 유지)      │            │
│ ▌모양         │  └──────────┴──────────┘                            │
│ 코드 도구     │  Diff 폰트 크기 [16]                                 │
│ 터미널        │  …                                                  │
│ 알림          │  (카테고리당 본문 — 대부분 스크롤 없이 한 화면)        │
│ 유지보수      │                                                     │
├──────────────┴─────────────────────────────────────────────────────┤
│                                              [취소]  [저장]        │ ← 푸터(border-t, 전역)
└─────────────────────────────────────────────────────────────────────┘
  좌: w-[200px] border-r  ·  활성 = border-l-2 border-accent bg-selection
```

### 3.1 내비게이션 모델 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **좌 사이드바 카테고리 + 상단 검색** | **채택** | JetBrains/VS Code 설정의 검증된 관례이자 **앱 내 직접 전례 2건**(EnvDialog·MemoDialog §2.3 — 신규 패턴 발명 없음). 카테고리 6개는 세로 리스트에 여유, 10개+로 늘어도 흡수. 검색이 "어디 있는지 모름"을 타이핑 한 번으로 해소. |
| 상단 탭(칩형) | 기각 | 카테고리 6개 × 한글 레이블이면 w-860에서도 줄바꿈 경계 — 확장마다 가로 공간과 싸움. 칩형 전례(WorkspaceTabs)는 2~4개 전환용. |
| 아코디언(현행+접기) | 기각 | 스크롤은 남고 "펼치면 다시 압박". 접힘 상태 기억 등 상태만 늘고 탐색성 개선 미미. |
| 검색만 추가(구조 유지) | 기각 | 최소 변경이지만 근본(단일 컬럼 성장) 미해결 — 검색은 채택안의 일부로 흡수. |

### 3.2 카테고리 구성 — 8섹션 → 6카테고리

| 카테고리 | 흡수하는 현행 섹션 | 필드 | 근거 |
|---|---|---|---|
| **일반** | 일반 일부 | remoteRefreshMinutes, confirmDiscard, gitPath(+gitCheck 상태) | 앱 동작 기본값. gitPath가 "일반"에 있는 건 keywords("git","경로","실행")로 검색 방어(검증 M2) |
| **모양** | 일반 일부 | theme 그리드, diffFontSize | 테마 그리드가 세로 공간 최대 소비자(6칸) — 분리로 "일반"이 가벼워짐. 라이브 프리뷰는 그대로 |
| **코드 도구** | 포매터/린터 + LSP | formatter* 4, formatOnSave, lsp* 2 + 다운로드 버튼 | 둘 다 "코드 인텔리전스" 계열이고 각각 작음(4+2) — 사이드바 항목 낭비 방지. 내부 소제목(§2.3 섹션 제목 관례 재사용)으로 구분 유지 |
| **터미널** | 터미널 | terminalShell, terminalFontSize | |
| **알림** | 알림 | notifyMode + slack/email 9필드 + 시크릿 2 + 테스트 전송 | 최대 섹션 — 단독 카테고리가 정당 |
| **유지보수** | 브라우저 + 진단/로그 + macOS 격리 | (폼 필드 0 — 즉시 액션만) | 셋 다 "폼이 아닌 즉시 액션"(§2.2)이라 시맨틱이 동질. "유지보수"가 쿠키 초기화·로그아웃 찾는 사용자에게 불투명한 건 keywords("쿠키","로그아웃","크래시","panic","격리")로 검색 방어(검증 M2). macOS 조건부는 카테고리 내부 조건 렌더로 — **빈 탭 문제 원천 차단**(win에서도 브라우저·진단이 있어 카테고리는 항상 비지 않음) |

### 3.3 저장 모델 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **전역 폼 + 단일 저장/취소 유지(현행 시맨틱)** | **채택** | 카테고리는 **뷰 필터일 뿐** — form 상태는 셸에 하나, 카테고리 전환해도 편집값 유지. §2.2의 5개 시맨틱(프리뷰·시크릿·선저장 테스트·LSP 진행·폼 초기화)이 무수정 보존. 위험 최소. |
| 카테고리별 저장 | 기각 | `handleTest`가 전체 선저장(§2.2)과 구조 충돌 — "알림 탭 저장"이 다른 탭 미저장분까지 저장하는 비직관. 저장 버튼 6개는 오히려 UX 악화. |
| 즉시 저장(auto-apply) | 기각(후속 검토) | buildCleaned 저장 시점 클램프(394–414)·시크릿·테마 프리뷰 시맨틱 전면 재설계 + mutation 폭주. IA 개편과 분리해야 할 별개 프로젝트. |

- **미저장 변경 표시(dirty 판정 — 검증 I2 반영)**: 푸터 저장 버튼 옆 `변경됨` 배지. 얕은 비교는
  오탐/미탐이 생기므로 정확히: **`isDirty = !shallowEqualNormalized(buildCleaned(form), settings) ||
  hasSecretInput`**. 세부:
  - `buildCleaned(form)`(394–414 클램프·trim→null 반영)으로 비교 — gitPath `""`↔`null`, 폰트 클램프
    등 **저장해도 no-op인 값을 dirty로 오탐하지 않게**.
  - 배열 필드(`lspEnabledProjects`)는 **내용 비교**(정렬 후 요소 비교) — 체크 토글 왕복 시 새 참조
    오탐 방지.
  - 시크릿(slackSecret/smtpSecret)은 Settings 밖이라 위 비교에 안 잡힘 → **입력이 non-empty면 dirty**로
    별도 OR(미탐 방지).
  - N개 카운트는 부정확 소지(정규화·시크릿 혼재)라 v1은 **개수 없이 "변경됨" 점/배지**만. (선택 강화:
    사이드바 카테고리명 옆 점 — v1 생략 가능)

### 3.4 검색 — 정적 인덱스 기반 필터

| 대안 | 판정 | 근거 |
|---|---|---|
| **정적 `SETTINGS_INDEX` 배열(카테고리·`key`·레이블·키워드) 매칭** | **채택** | 렌더 트리 파싱·ref 수집 같은 마법 없이 ~40줄 데이터. 매칭 → 사이드바가 매칭 카테고리만 표시 + 본문에서 매칭 필드에 `ring-1 ring-accent` 하이라이트. **각 항목은 `key: keyof Settings | null`을 가져(§4)** 하이라이트·완전성 가드가 label 문자열이 아닌 키로 동작. |
| DOM 텍스트 스캔 | 기각 | 조건 렌더(알림 하위 폼은 토글 켜야 존재 — 736, 768) 때문에 꺼진 필드가 검색에 안 걸림. |
| 필드 레지스트리 리팩토링(전 필드를 스키마 구동 렌더로) | 기각 | 22필드 전면 재작성 — 이득 대비 과대. 테마 그리드·시크릿 등 비정형 UI가 스키마에 안 맞음. |

- **위치**: 사이드바 최상단, QuickPick 투명 인라인 입력 스타일(§2.3). 검색 비면 전체 카테고리 복귀.
- **자동 카테고리 전환(검증 I3 반영)**: query 변경 시 **현재 `category`가 매칭 집합 밖이면 `matched[0]`의
  카테고리로 자동 전환** — 사이드바에서 현재 항목이 사라지고 본문만 남는 "고아 뷰" 방지. 검색 중
  카테고리 클릭도 허용(이동 + 검색어·하이라이트 유지).
- **매칭 0건**: 사이드바는 전체 카테고리를 dim 상태로 유지(사라지지 않음), 본문 상단에 "결과 없음"
  안내. (사이드바를 통째로 비우면 탐색 불능이 되므로 dim 유지가 정답.)
- **조건 렌더 필드의 하이라이트 폴백(검증 C3 반영)**: 매칭 필드가 조건 렌더(`emailEnabled=false`의 smtp
  등 768)로 **DOM에 없으면**, 그 필드 대신 **부모 토글(Slack/이메일 체크박스)에 하이라이트**를 준다
  ("여기를 켜면 나옵니다" 신호). **자동 토글-켜기는 금지**(form을 dirty로 만듦 — 명문화). 정적 인덱스가
  DOM 스캔 기각 근거의 거울상 문제(꺼진 필드)를 갖는 걸 이 폴백이 메운다.

### 3.5 셸·키보드

- **크기**: `h-[min(640px,85vh)] w-[860px] max-w-[95vw]` — MemoDialog(820×560) 계열의 대형 분할 모달.
  구조: 헤더(border-b) / `flex min-h-0 flex-1`(좌 사이드바 `w-[200px] shrink-0 border-r border-edge` +
  우 본문 `min-w-0 flex-1 overflow-y-auto p-5`) / 푸터(border-t) — EnvDialog:65,75 + MemoDialog:118 합성.
  좁은 화면(max-w-[95vv] 발동 시) 본문이 먼저 짜부되므로 **smtp host+port 같은 flex 행은 `flex-wrap`**로
  방어(사이드바 200px 고정 유지). 고정 h-640은 유지보수 카테고리에서 빈 공간이 남으나 수용(대칭 우선).
- **사이드바 항목**: `border-l-2 border-accent bg-selection`(활성) vs `border-transparent
  hover:bg-raised`(비활성) — ProjectItem 관례(§2.3).
- **Esc 닫기 신설**: ImageEditor 패턴(open 동안 window keydown, `!ui.prompt && !ui.confirm` 양보 가드)
  → 반드시 `closeWithoutSave` 경유(테마 복원 — §2.2). 검색 입력에 포커스 중 Esc는 1차로 검색어 클리어,
  빈 상태에서 Esc는 닫기(QuickPick 관례와 합치). **가드 확인 항목(검증 M3)**: 설정 위에 QuickPick 계열
  (QuickOpenHost·SymbolSearch — 자체 window Esc)이 열릴 수 있는지 구현 시 확인 — 열린다면 그 플래그도
  양보 조건에 포함.
- **Esc/배경클릭의 dirty 폐기(검증 M3)**: 배지가 미저장 변경을 알지만 Esc·배경클릭은 **현행과 동일하게
  무경고 폐기**(취소 버튼과 같은 시맨틱). dirty 시 확인 다이얼로그는 **v1 비범위**(후속 — 필요 시
  askConfirm 경유). 이 결정을 명시해 "왜 경고 안 하나" 혼선을 차단.
- **키보드 내비(v1 선택)**: 사이드바 ↑/↓ 카테고리 이동 — QuickPick 키내비 코드 참고. v1 생략 가능.

### 3.6 파일 구조 — 860줄 단일 파일 분해

```
src/components/settings/
  SettingsDialog.tsx     셸: 오버레이·헤더·사이드바·푸터 + 폼 상태 전부(form/update/preview/
                         secrets/lsp진행/persist/handleTest) + category/query — 셸이 상태 단일 소유
  sections/
    shared.tsx           Field·inputCls·HlField(하이라이트 래퍼) — 순환 의존 방지(검증 I6)
    GeneralSection.tsx   props: { form, update } (+ gitCheck 자체 쿼리)
    AppearanceSection.tsx  props: { form, update, previewTheme }
    CodeToolsSection.tsx   props: { form, update, projects, lspBusy, lspStatus, onDownload } (검증 M1)
    TerminalSection.tsx    props: { form, update }
    NotifySection.tsx      props: { form, update, secrets…, onTest }
    MaintenanceSection.tsx (즉시 액션 3종 — 상태 처리는 아래 I1 참조)
  settings-index.ts      SETTINGS_INDEX(+key) + CATEGORIES
```

- **`sections/shared.tsx`로 순환 의존 차단(검증 I6)**: `Field`·`inputCls`·`HlField`를 SettingsDialog가
  아닌 shared에 두고 셸·섹션 양쪽이 import — SettingsDialog→sections→SettingsDialog 사이클 제거.
- **폼 필드 섹션은 순수 표현**(props in, 콜백 out): General/Appearance/CodeTools/Terminal/Notify는 form·
  시크릿·프리뷰가 전부 셸 소유라 언마운트 무해 → **활성 카테고리만 렌더**.
- **MaintenanceSection은 예외 — 로컬 상태 3종 보존 필요(검증 I1)**: Quarantine `selected` Set(62,
  mount-effect가 전체선택 리셋 66–69)·BrowserData `busy`(176)·Diagnostics `log`(223)는 폼과 무관하지만
  **카테고리 왕복 시 재마운트되면 선택 소실·이중 실행·로그 뷰 소실**이 생긴다. 따라서 유지보수 카테고리
  섹션은 **`hidden`(display:none) 마운트 유지** — 첫 진입 후 언마운트하지 않는다. (활성만 렌더 원칙의
  유일한 예외. 폼 섹션엔 적용 안 함 — 셸이 상태를 소유하므로 불필요.)
- **셸 항상 마운트 유지**: 현행처럼 조건부 null(370) — LSP 진행 상태 보존(§2.2). `category`·`query`는
  셸 소유 → 카테고리 전환에 편집값 불변.

## 4. 계약(타입·컴포넌트)

**신규 백엔드/이벤트/Settings 필드 없음.** 프론트 전용.

```ts
// src/components/settings/settings-index.ts
export type SettingsCategory = "general" | "appearance" | "codetools" | "terminal" | "notify" | "maintenance";
export const CATEGORIES: { id: SettingsCategory; label: string; icon: LucideIcon }[] = [/* 6종, §3.2 순서 */];

/** 검색·하이라이트·완전성 가드의 단일 진실. key는 매칭·가드의 기준(검증 C1·C2·M5). */
export interface SettingIndexEntry {
  category: SettingsCategory;
  /** 대응 Settings 필드. 즉시 액션(브라우저 초기화 등)·시크릿은 null. */
  key: keyof Settings | null;
  label: string;
  keywords: string[];
  /** 조건 렌더로 숨을 수 있는 필드의 부모 토글 key(하이라이트 폴백 대상 — §3.4 C3). */
  parentToggle?: keyof Settings;
}
export const SETTINGS_INDEX: SettingIndexEntry[] = [
  { category: "appearance", key: "theme", label: "테마", keywords: ["theme", "다크", "라이트", "색"] },
  { category: "general", key: "gitPath", label: "git 실행 파일 경로", keywords: ["git", "path", "경로", "실행"] },
  { category: "notify", key: "smtpHost", label: "SMTP 호스트", keywords: ["smtp", "메일", "이메일"], parentToggle: "emailEnabled" },
  { category: "maintenance", key: null, label: "브라우저 데이터 초기화", keywords: ["쿠키", "로그아웃", "세션", "브라우저"] },
  { category: "maintenance", key: null, label: "크래시 로그", keywords: ["crash", "panic", "로그", "진단"] },
  // … Settings 22필드 전부(key 지정) + 즉시 액션 3종·시크릿 2종(key: null) = 27항목
];

// SettingsDialog.tsx 셸 로컬 상태(신규만)
const [category, setCategory] = useState<SettingsCategory>("general");
const [query, setQuery] = useState("");
// 파생: matched = query ? SETTINGS_INDEX.filter(matchesQuery) : null
//   → 사이드바: matched ? 매칭 카테고리 강조 + 비매칭 dim(사라지지 않음) : 전체 표시
//   → 자동 전환(§3.4 I3): query 변경 후 category ∉ matched의 카테고리들 → setCategory(matched[0].category)
//   → 하이라이트 대상 keys = matched.filter(m=>m.category===category).map(m => m.key ?? m.parentToggle)  // C3 폴백

// 하이라이트는 Field prop이 아니라 범용 래퍼로(검증 C2 — 22필드 중 Field 쓰는 건 9개뿐).
//   sections/shared.tsx: <HlField k={settingKey} highlightKeys={hlKeys}> {children} </HlField>
//   → data-setting-key 부여 + hlKeys에 있으면 ring-1 ring-accent rounded px-1 -mx-1. 체크박스·raw
//     input·테마 그리드 등 Field 안 쓰는 필드도 이 래퍼로 감싸 하이라이트 가능.

// 폼 초기화 effect(360–368)에 신규 상태 리셋 추가(검증 I5): setQuery(""); (category는 "general"로 리셋 선택)
//   → "smtp" 검색해두고 닫으면 다음 열기가 필터된 사이드바로 시작하는 잔존 방지.
```

- **닫기 경로 계약**: 배경클릭·X·취소·**Esc(신설)** 4곳 전부 `closeWithoutSave` 단일 함수 경유.
- **useUi `settingsOpen` 플래그** 이름·시맨틱 불변(BrowserPane.tsx:100–106 결합 — §2.3).
- **`ipc.getSettings()`가 런타임 키의 진실**(§5-⑤ 가드가 이걸 씀 — Settings TS 타입은 런타임 키가 없음).

## 5. 단계(구현 순서)

1. **무변화 분해** — sections/ 6파일 + `shared.tsx`(Field·inputCls·HlField)로 마크업 이동(props 계약
   §3.6), 셸은 기존 단일 컬럼 유지. 동작 diff 0을 tsc+수동 스모크로 확인. (~1h, 리스크 최저 지점)
2. **셸 좌우분할** — w-860 분할 셸 + 사이드바 + 활성 카테고리만 렌더(**유지보수는 hidden 마운트** —
   I1) + 푸터 이동. **`변경됨` 배지(buildCleaned 비교+배열 내용+시크릿 — §3.3 I2)**. (~2.5h — 배지
   정규화 비교 + 유지보수 상태 처리 포함)
3. **검색** — settings-index.ts 27항목(각 `key`) + 사이드바 필터/자동전환/dim + HlField 하이라이트 +
   조건 렌더 폴백(부모 토글 — C3). (~1.5h)
4. **Esc + 마감** — ImageEditor 패턴 Esc(양보 가드 + QuickPick 계열 확인 — M3), 검색 Esc 2단계
   (클리어→닫기), 폼 초기화에 query 리셋(I5), macOS 조건부를 MaintenanceSection 내부로. (~0.5h)
5. **E2E `tests/e2e/suites/29-settings-ux.mjs`** — ① 카테고리 전환 시 form 편집값 유지 + **재오픈 시 query
   리셋**(I5) ② 검색 "폰트" → 모양 카테고리 자동 전환 + 하이라이트, "smtp"(email off) → 부모 토글 폴백
   하이라이트(C3) ③ 테마 프리뷰 후 Esc → dataset.theme 복원 ④ 저장 → settings 반영 ⑤ **완전성 가드
   (검증 C1)**: `Object.keys(await ipc.getSettings())`(런타임 진실) vs `SETTINGS_INDEX`의 non-null `key`
   집합 대조 — 새 Settings 필드가 인덱스에 없으면 실패. (TS 타입은 런타임 키가 없어 getSettings 사용.) (~1.5h)

규모: **M~L(1일 상단)** — 프론트 ~350 LOC 이동 + ~250 LOC 신규(배지 정규화·검색 폴백·유지보수 상태
처리로 상향). 각 단계 독립 납품 가능(1단계만으로도 유지보수성 이득).

## 6. 위험과 완화 (실측 취약점 + 적대 검증 지적 전수 매핑)

| 위험 | 근거(실측) | 완화 |
|---|---|---|
| 테마 프리뷰 복원 누락 | 복원이 closeWithoutSave에 결합(377–392), 호출 3곳 | Esc 포함 닫기 4경로를 단일 함수로 강제(§4 계약) + E2E ③ |
| 카테고리 전환 시 편집값 소실 | 폼 리셋 effect `[open, settings]`(360–368) | 카테고리는 뷰 필터(§3.3) — form 상태 셸 고정. effect 의존성 불변. E2E ① |
| **handleTest 선저장 혼란(검증 I4)** | 445–455 — 분할 후 다른 탭 미저장분까지 조용히 저장 | 동작은 불변(단일 저장 모델) + **테스트 버튼 옆 "미저장 변경이 함께 저장됩니다" 안내**(dirty 시). "저장 안 눌렀는데?" 혼선 차단 |
| LSP 진행 상태 유실 | 로컬 상태 + 항상 마운트 의존(330–352) | 상태는 셸 소유(§3.6) — 카테고리 언마운트와 무관. 셸 조건부 null 유지 |
| 시크릿 시맨틱 파손 | 빈 값=변경 안 함(353–357, 420–429) | 시크릿 상태도 셸 소유, NotifySection은 표현만. 배지 dirty에 시크릿 non-empty 포함(I2) |
| macOS 빈 카테고리 | isMacOS 조건부(29, 839) | 유지보수 카테고리에 내부 조건 렌더(§3.2) — 카테고리 자체는 항상 존재 |
| BrowserPane 결합 파손 | settingsOpen 구독(BrowserPane.tsx:100–106) | 플래그 불변(§4) |
| Esc 레이어 충돌 | 설정 안에서 askConfirm z-[60] 뜸(§2.3) | `!ui.prompt && !ui.confirm` 양보 가드 + QuickPick 계열 확인(§3.5 M3) |
| refreshTerminalThemes 누락 | 프리뷰·복원 2곳 호출(380, 389) | previewTheme/closeWithoutSave를 셸에 그대로 — 이동 자체가 없음 |
| SETTINGS_INDEX drift | 신규 필드가 검색·하이라이트에 안 걸림 | **E2E ⑤: getSettings 런타임 키 ↔ 인덱스 `key` 대조**(검증 C1) |
| 클램프 규칙 유실 | buildCleaned 저장 시점 클램프(394–414) | buildCleaned 무수정 유지 — 인라인 검증 도입은 명시적 비범위 |
| **유지보수 로컬 상태 소실(검증 I1)** | Quarantine selected Set 리셋(62,66–69)·BrowserData busy(176)·Diag log(223) — 재마운트 시 소실·이중 실행 | 유지보수 섹션만 **hidden 마운트 유지**(§3.6) — 언마운트 안 함 |
| **배지 dirty 오탐/미탐(검증 I2)** | lspEnabledProjects 배열 새 참조·gitPath ""↔null 정규화·시크릿 미포함 | buildCleaned 비교+배열 내용 비교+시크릿 non-empty OR(§3.3) |
| **하이라이트 커버리지 부족(검증 C2)** | Field 쓰는 필드 9/22뿐 — 체크박스·raw input 하이라이트 불가 | Field prop 아닌 **HlField 범용 래퍼(data-setting-key)**로 전 필드 감쌈(§4) |
| **조건 렌더 필드 하이라이트 공중부양(검증 C3)** | smtp 검색 시 email off면 DOM에 없음(768) | 부모 토글에 폴백 하이라이트(§3.4). 자동 토글-켜기 금지(dirty 유발) |
| **검색 고아 뷰(검증 I3)** | 현재 카테고리가 매칭 밖이면 사이드바에서 사라짐 | matched[0]로 자동 전환 + 0건 시 dim+"결과 없음"(§3.4) |
| **query/category 잔존(검증 I5)** | 셸 상시 마운트라 닫아도 상태 유지 | 폼 초기화 effect에 setQuery("") (§4) + E2E ① |
| **순환 의존(검증 I6)** | Field/inputCls를 SettingsDialog에서 export | `sections/shared.tsx`로 분리(§3.6) |
