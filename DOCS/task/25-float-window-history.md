# 태스크 25 — 플로팅 창 타이틀바 히스토리 마스터 토글 + 토스트 호스트

> 상태: **구현 완료 · 검증 통과(미커밋)** — e2e 13 스위트 27건 전부 pass(실기 전·후 2회),
> 실기 §7.2 1~7(관측 10항목)을 CDP 실측으로 관측. 복사 **성공** 토스트 문구 1건만 미검증(이 기기의
> Windows 클립보드가 앱 밖에서 점유돼 있다 — §9.3) (2026-09-03) ·
> 근거: 코드 실측 2026-09-02(워킹트리 기준) + 실기 관측 2026-09-03 ·
> 상위 설계: `DOCS/pane-history-tooltip-layout-design.md` §2.1 **A3**(§1.1 현황, §3 태스크표 A3, §5 검증 A3)

## 1. 요구사항

분리된 터미널 세션(플로팅 창 `float-*`)에서도 프롬프트 컬럼(히스토리)을 **창 단위로** 켜고 끌 수 있어야
하고, 그 창에서 일어나는 토스트(컬럼 항목 복사 결과)가 **그 창에** 보여야 한다.

받아들이는 조건:
- 플로팅 창 타이틀바에 "히스토리" 버튼이 있고, 클릭 한 번으로 **그 창의 모든 터미널 pane**(분할로 늘린
  것 포함) 우측에 프롬프트 컬럼이 펼쳐지고, 다시 누르면 전부 접힌다.
- 대상은 **그 창의 pane만**이다 — 메인 창·다른 플로팅 창·별도 모아보기 창의 컬럼 상태는 바뀌지 않는다.
- 일부 pane만 열린 상태에서 누르면 "전부 펼치기"부터 한다(기존 마스터 토글 규칙 그대로).
- 컬럼 항목을 클릭해 복사하면 성공/실패 토스트가 **플로팅 창 우측 하단**에 뜬다(지금은 무음).
- 버튼의 `title` 문구가 메인 타이틀바·별도 모아보기 창 헤더·플로팅 타이틀바 **세 곳에서 모두 참**이다
  (현재 문구의 "(모아보기에서 표시)"는 컬럼이 워크스페이스 pane에도 열리는 지금은 거짓).
- 컬럼을 연 채 "메인으로 되돌리기"를 하면 메인에 편입된 pane에도 컬럼이 열린 채 이어진다
  (열림 상태가 세션 단위 영속이라 이미 그렇게 동작한다 — 회귀 확인 항목).

## 2. 현황(근거)

### 2.1 플로팅 창에는 마스터 토글이 없고, pane별 버튼은 눌리지 않는다

- 플로팅 창은 `FloatingTerminal.tsx`의 `FloatWorkspace`가 그린다. 타이틀바 `FloatTitleBar`의 `actions`
  슬롯에는 지금 **되돌리기 버튼 하나**만 있다(`src/FloatingTerminal.tsx:212-223`; 버튼 클래스
  `flex h-full shrink-0 items-center gap-1 px-2 text-[11px] text-fg-muted transition-colors hover:bg-raised hover:text-fg` :218).
  import 목록(:1-19)에 `PromptHistoryButton`·`Toasts` 없음.
- `FloatTitleBar`의 `actions`는 드래그 영역(`data-tauri-drag-region` spacer :38) **바깥**, 창 컨트롤(:42-54)
  왼쪽에 놓인다(`src/components/FloatTitleBar.tsx:40`; 슬롯 정의 :16, 주석 :6-8). 되돌리기 버튼이 지금
  거기서 정상 클릭되므로 같은 자리에 버튼을 하나 더 두면 드래그로 먹히지 않는다(검증 필요 — 실기 근거다.
  e2e 13은 되돌리기 버튼을 직접 누르지 않고 메인에서 재현한다(:9-11); §7.2 2에서 클릭으로 확인).
- pane 우상단의 세션 클러스터(`ThemeButton`·`PromptLogButton`, `src/components/workspace/TerminalPane.tsx:99-118`,
  `z-10`)는 형제 `PaneControls` 오버레이(`src/components/workspace/PaneTree.tsx:124-126`, `z-30`)에 가려져
  **눌리지 않는다**(상위 설계 §1.1 CDP 실측). 플로팅 창도 같은 `PaneTreeRoot → LeafView → TerminalPane`을
  쓴다(`FloatingTerminal.tsx:225`, `PaneTree.tsx:115-128`). 그 수리는 태스크 23(A1)이다 — 이 문서는 창 단위
  마스터 토글만 다룬다.

### 2.2 왜 마스터 토글의 대상이 "그 창의 pane만"이 되는가

- `PromptHistoryButton`은 `useTerminals((s) => s.terminals)`를 읽어 `collectByContent(t.layout, "terminal")`로
  대상 pane 집합을 만든다(`src/components/workspace/TermSessionControls.tsx:171-178`; `collectByContent`는
  `src/stores/terminals.ts:159-163`, export :191). pane이 0개면 렌더하지 않는다(:179).
- 플로팅 창은 **별도 웹뷰 = 별도 JS 컨텍스트**라 `useTerminals`가 메인과 다른 인스턴스다. 역할 판정
  `ROLE`은 창 라벨 `float-*`면 `"float"`(`terminals.ts:27-37`, 역할별 정책 주석 :18-26). float는 localStorage를
  **불러오지 않고**(:267-270 빈 상태로 시작) **저장하지도 않는다**(:536-550 main 한정).
  `FloatingTerminal`이 attach 뒤 그 스토어에 "floated pane 하나짜리 탭"을 시드한다(`FloatingTerminal.tsx:86-100`).
- 창 안 분할은 `splitPane`이 그 로컬 스토어에 직접 넣는다(`terminals.ts:368-383` — `ROLE` 분기 없음;
  위임 분기는 `openTerminal`·`closePane`·`floatPane`의 `"aggregate"`만 :301, :412, :466). 따라서 플로팅 창에서
  `PromptHistoryButton`이 보는 `terminals`는 **그 창의 탭 하나**, `paneIds`는 그 창의 터미널 leaf 전부다.
- 열림 상태 자체는 세션(termId) 단위로 **창을 가로질러 공유**된다: `openPanels`(`src/stores/promptHistory.ts:129`)는
  부트 시 `gp:prompt-panel-open`을 읽고(:146, 키 :18), `setPanels`가 메모리 + localStorage에 일괄 반영하며
  (:175-195), 다른 창의 변경은 `storage` 이벤트로 따라간다(:211-223). 그래서 **대상 집합은 창 단위, 상태는
  세션 단위**다 — 플로팅 창에서 켠 컬럼은 되돌리기 뒤 메인의 `TerminalPane`이 `openPanels[paneId]`로
  그대로 그린다(`TerminalPane.tsx:55`, :121).
- 입력 기록은 xterm을 소유한 창의 `ptyWrite`에서 캡처된다(`src/lib/terminal-engine.ts:78-82` →
  `src/lib/prompt-capture.ts:175-189` → `record`). 플로팅 창이 PTY를 attach해 소유하므로 그 창의 세션도
  기록되고, 영속은 termId 단위 RMW라 창끼리 덮어쓰지 않는다(`promptHistory.ts:81-124`).

### 2.3 토스트 호스트가 없어 무음인 경로

- `PromptSidePanel`의 항목 클릭은 `copyText` 뒤 `pushToast(ok ? "success" : "error", …)`를 부른다
  (`TermSessionControls.tsx:213-222`; `copyText`는 `src/lib/clipboard.ts:20-28`, 네이티브 플러그인 경로고
  `src-tauri/capabilities/default.json:7,23`이 `float-*` 창에 `clipboard-manager:allow-write-text`를 허용하므로
  플로팅 창에서도 동작). `pushToast`는 **그 창의** `useUi` 인스턴스 `toasts`에 쌓고 6초 타이머를 건다
  (`src/stores/ui.ts:485-492`).
- 렌더하는 쪽은 `<Toasts />`(`src/components/common/Toast.tsx:5-53`, 컨테이너 `absolute bottom-8 right-4 z-[55]`
  :16). 마운트 지점은 `App.tsx:195`, `AggregateWindow.tsx:49`, `components/sysmon/SysMonitorWindow.tsx:570` 세 곳뿐 —
  **플로팅 창에는 없다**. `AggregateWindow.tsx:45-47` 주석이 이유를 정확히 적어 두었다: "스토어는 창마다
  별개라(웹뷰 = 별도 JS 컨텍스트) 메인 창의 호스트가 여기 대신 그려 주지 않는다".
- 되돌리기 실패는 `console.error`로만 남는다(`FloatingTerminal.tsx:194-200`, :198). 호스트를 달아도
  `pushToast`를 부르지 않으므로 **표면화되지 않는다** — §3 "상위 설계와의 차이" ②.
- 플로팅 창에는 `askConfirm` 경로가 없다. `PaneControls.tsx`·`PaneTree.tsx`·`TerminalPane.tsx`·
  `stores/terminals.ts` 어디에도 `askConfirm` 호출이 없다(`src` 전체 grep 22곳 — 모아보기는
  `AggregateTerminals.tsx:681,781`, 그 외는 메인 전용 표면(`App.tsx:109`·툴바·변경 패널·사이드바·파일트리·
  이미지·영상·DB·API 클라이언트·설정·sysmon)과 `queries/index.ts:1055`(`usePushFlow` — 플로팅 창이 쓰는
  쿼리는 `useSettings`뿐, `FloatingTerminal.tsx:18,35`)). `ConfirmHost`는 필요 없다.

### 2.4 문구 사용처

- `PromptHistoryButton` title(`TermSessionControls.tsx:184-188`):
  펼치기 "전체 프롬프트 히스토리 펼치기 — 모든 터미널 우측에 입력 목록을 엽니다 (모아보기에서 표시)"(:187),
  접기 "전체 프롬프트 히스토리 접기 — 모든 터미널의 우측 목록을 닫습니다"(:186). 함수 주석 :164에도
  "(모아보기에서 보임)". 라벨 텍스트는 "히스토리"(:195), 기본 className `mr-2.5 px-1.5 py-0.5 text-[10px]`(:193).
- 사용처 2곳: 메인 타이틀바 `src/components/TitleBar.tsx:65`(import :12), 별도 모아보기 창 헤더
  `src/components/AggregateTerminals.tsx:531-533`(`IS_AGGREGATE_WINDOW` 조건, 주석 :529-530 "메인 안
  모아보기는 바로 위 TitleBar에 같은 버튼이 있어 한 화면에 두 개가 보이면 안 된다").
- 세션 단위 어휘는 "프롬프트 목록"이다 — `PromptLogButton` title "…우측 목록을 엽니다/닫습니다"(:149),
  `PromptSidePanel` X 버튼 title "프롬프트 목록 닫기"(:239), 태스크 24의 메뉴 항목 "프롬프트 목록 열기/닫기".

### 2.5 e2e 제약

- 러너의 `cdp`는 **메인 페이지 하나**다: `connect()`가 타이틀 매칭 페이지를 순회해 라벨 `main`을 고른다
  (`tests/e2e/lib/cdp.mjs` `export async function connect` — 워킹트리 스냅샷 `:206-250`, 라벨 비교 `:218`; 라벨 식
  `LABEL_EXPR` `:22`). `listTargets`(`:24-31`)와 `attach`(`:191-204`)는 **export되지 않는다**(현재 export는 `connect` 하나).
  이 파일은 다른 세션이 편집 중(M, +118/−24)이라 줄번호는 2026-09-02 스냅샷이고 **심볼로 찾는다** — 23·24도 같은 기준. 스위트는 `{ cdp, report, fix, snapshot, port: cdp.cdpPort, devPort }`를 받는다
  (`tests/e2e/run.mjs:175` — 정확히는 `devPort: cdp.devPort`).
- 모든 창이 같은 WebView2 환경 인자를 쓰고(`src-tauri/src/lib.rs:89-96`, 플로팅 창 :159), 디버그 빌드는
  `--remote-debugging-port=29222`(:94)라 플로팅 페이지도 같은 `/json`에 나타난다. HTML 타이틀은 모두
  `Gitpervisor`(`index.html:7`)라 **라벨로만** 구분된다(`cdp.mjs:16-19` 주석의 풀 창 함정과 같은 이유).
- 태스크 13 스위트가 선례다: "플로팅 창의 버튼은 이 러너의 CDP(메인 페이지 1개)로 누를 수 없으므로 …
  메인에서 직접 재현한다"(`tests/e2e/suites/13-float-window.mjs:9-11`). 새로 보이게 된 float 창의 라벨을
  알아내는 `openFloat`(:55-79), `closeLabel`(:40-45), `gone`(:46-53), `openPty`(:81-90)가 거기 있다.
- `window.__gpv = { ui, terminals, … }`는 라벨 분기 **앞**에서 노출되므로(`src/main.tsx:47-56`) dev 빌드의
  플로팅 페이지에도 있다. `usePromptHistory`는 노출되지 않는다 — 열림 상태는 DOM(`PromptSidePanel`의
  X 버튼 `title="프롬프트 목록 닫기"`)과 localStorage(`gp:prompt-panel-open`)로 관측한다.

## 3. 설계

### 3.1 마스터 토글

| 대안 | 평가 |
|---|---|
| **A. 기존 `PromptHistoryButton`을 플로팅 타이틀바 `actions`에 그대로 배치** (채택) | 대상 집합이 "이 창의 pane"으로 저절로 좁혀진다(§2.2 — 창별 독립 스토어). 코드 1줄 + import. 메인·별도 창과 동작·상태색(`bg-raised text-accent`)이 같다 |
| B. 창 전용 컴포넌트(`FloatHistoryButton`)에 `paneIds` prop | A와 같은 결과를 더 많은 코드로 낸다. 스토어가 이미 창 단위라 prop이 필요 없다 |
| C. 우클릭 세션 토글(태스크 24 A2)만으로 충분 | 분할 2~4개 창에서 pane마다 우클릭해야 한다. 요구 1은 "세션에서도 켜고 끌 수 있어야" — 창 단위 한 번이 자연스럽다. 24와 상보적, 대체가 아니다 |

배치는 **되돌리기 버튼 왼쪽**(actions 순서: 히스토리 → 되돌리기 → 창 컨트롤). className은
`"h-full shrink-0 px-2 text-[11px]"` — 되돌리기 버튼(:218)과 높이·패딩·글자 크기를 맞춘다. 기본 클래스
`flex items-center gap-1 rounded`(:189)는 남는다(메인 타이틀바 버튼도 `rounded`라 관례 안).

### 3.2 토스트 호스트

| 대안 | 평가 |
|---|---|
| **a. `FloatWorkspace` 루트 div 마지막 자식으로 `<Toasts />`** (채택) | `AggregateWindow.tsx:48-49` 선례 그대로. `pushToast`를 부르는 코드(`PromptSidePanel`)가 이 트리 안에 있다. 루트가 non-positioned `flex h-screen flex-col`(:211)이라 `absolute bottom-8 right-4`는 뷰포트 기준 우하단 — `AggregateWindow.tsx:40` 루트와 같은 조건 |
| b. `FloatingTerminal` 최상위(attach 전 placeholder 포함) | attach 전엔 토스트를 낼 코드가 없다. 얻는 것 없이 분기만 늘어난다 |
| c. `ConfirmHost`도 함께 | 플로팅 창엔 `askConfirm` 경로가 없다(§2.3). 필요해지는 코드가 생길 때 그 커밋이 단다 |

### 3.3 문구

세 사용처에서 모두 참인 문장 — prop 추가 없음(상위 설계 §2.1 A3 그대로):

- 펼치기: **"전체 프롬프트 목록 펼치기 — 이 창의 모든 터미널 우측에 입력 목록을 엽니다"**
- 접기: **"전체 프롬프트 목록 접기 — 이 창의 모든 터미널 우측의 입력 목록을 닫습니다"**

"프롬프트 목록"은 세션 단위 어휘(§2.4)와 맞추고, "전체"가 마스터임을 말한다. 라벨 "히스토리"는 유지
(사용자 어휘 — 상위 설계 용어표).

### 3.4 만들지 않는 것

- `ConfirmHost` 마운트(§3.2 c). 
- `__gpv.promptHistory` 노출 — e2e는 DOM·localStorage로 충분(§7). 
- `PromptHistoryButton`의 범위/문구 prop — 문구가 세 곳 공통이라 불필요. 
- 되돌리기 실패 토스트(`pushToast("error", …)`) — §8 오픈 이슈 ①(1줄이지만 이 태스크의 요구가 아니다).
- 플로팅 창 전용 스타일 변형(`rounded-none` 등) — 실기에서 거슬리면 그때.

### 3.5 상위 설계와의 차이

| # | 상위 설계 | 이 문서 | 이유 |
|---|---|---|---|
| ① | §3 V: "e2e 14에 … 단언 추가" | A3 단언은 **13-float-window.mjs**에 둔다 | 플로팅 창을 열고 라벨을 알아내는 `openFloat`·`closeLabel`·`openPty` 헬퍼가 13에 있다. 14로 옮기면 복제. 문체는 14 관례(`cdp.eval`·`poll`·`r.check`·`__gpv`)를 따른다 |
| ② | §2.1 A3: "`<Toasts />` 추가 … 되돌리기 실패도 표면화된다" | 호스트만으로는 표면화되지 않는다 — 실패 경로는 `console.error`뿐(`FloatingTerminal.tsx:198`) | `pushToast` 호출 1줄이 더 필요하다. 요구에 없어 오픈 이슈 ①로 넘긴다 |
| ③ | 변경 파일 `FloatingTerminal.tsx`, `TermSessionControls.tsx` | + `tests/e2e/lib/cdp.mjs`(export 3개), `tests/e2e/suites/13-float-window.mjs` | 플로팅 페이지에 두 번째 CDP를 붙이려면 `listTargets`·`attach`·`LABEL_EXPR`를 export해야 한다(본문 무변경) |

## 4. 계약(타입·액션·코드 스케치)

Tauri 커맨드/이벤트/Rust 변경 **없음**. 스토어 변경 없음 — 기존 `useTerminals`(창별)·`usePromptHistory`
(`setPanels`)·`useUi`(`pushToast`/`toasts`)를 그대로 쓴다.

```tsx
// src/FloatingTerminal.tsx — import 추가
import { Toasts } from "./components/common/Toast";
import { PromptHistoryButton } from "./components/workspace/TermSessionControls";

// FloatWorkspace return (:210-228) — actions를 fragment로, 루트 마지막에 Toasts
return (
  <div className="flex h-screen flex-col bg-base">
    <FloatTitleBar
      title={title}
      actions={
        <>
          {/* 이 창의 pane 전체(분할 포함) 프롬프트 컬럼 마스터 토글. useTerminals가 창별 독립 스토어라
              (stores/terminals ROLE float) 대상은 저절로 이 창의 pane만이다 — 메인·다른 창은 불변. */}
          <PromptHistoryButton className="h-full shrink-0 px-2 text-[11px]" />
          <button onClick={() => void redock()} title="…" className="…">
            <Undo2 size={12} /> 메인으로 되돌리기
          </button>
        </>
      }
    />
    <div className="min-h-0 flex-1">
      <PaneTreeRoot tab={tab} projectId={projectId} fontSize={FONT} />
    </div>
    {/* 컬럼 항목 복사 토스트가 이 창에서만 무음이었다 — 스토어는 창마다 별개라 메인 호스트가 대신
        그려 주지 않는다(AggregateWindow와 같은 이유). 확인 모달은 이 창에 askConfirm 경로가 없어 안 단다. */}
    <Toasts />
  </div>
);
```

```tsx
// src/components/workspace/TermSessionControls.tsx:184-188 — title 문구만
title={
  allOpen
    ? "전체 프롬프트 목록 접기 — 이 창의 모든 터미널 우측의 입력 목록을 닫습니다"
    : "전체 프롬프트 목록 펼치기 — 이 창의 모든 터미널 우측에 입력 목록을 엽니다"
}
// :162-169 함수 주석(:164)의 "(모아보기에서 보임)" → "(메인·별도 창·플로팅 — 그 창의 스토어에 있는 pane)"로 갱신.
```

```js
// tests/e2e/lib/cdp.mjs — 본문 무변경, 식별자 3개만 export
export const LABEL_EXPR = "window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label"; // :22 (스냅샷 — 심볼로 찾는다)
export async function listTargets(port) { /* :24-31 그대로 */ }
export async function attach(page) { /* :191-204 그대로 */ }
```

시그니처 확인: `PromptHistoryButton({ className }: { className?: string })`(:170), `Toasts()` 무인자(:5),
`FloatTitleBar` `actions?: React.ReactNode`(:16) — fragment 허용.

## 5. 단계(구현 순서)

1. **TermSessionControls.tsx** — title 문구 2개(:186-187) + 함수 주석(:164). ~4 LOC.
   메인·별도 창 hover로 새 문구 확인(사용처 2곳, 코드 변경 없음).
2. **FloatingTerminal.tsx** — import 2줄, `actions` fragment + `PromptHistoryButton`, 루트 `<Toasts />`. ~10 LOC.
   `npx tsc --noEmit -p .` exit 0.
3. **e2e** — `cdp.mjs` export 3개, `13-float-window.mjs`에 히스토리·토스트 블록(§7). ~55 LOC.
4. **실기**(§7) — 정적 통과만으로 끝내지 않는다.

규모: **S** — 앱 2파일 ~14 LOC, 테스트 2파일 ~55 LOC.

**선행/후행 문서**: **25 → 26** (`TermSessionControls.tsx` — 26의 호버 카드가 같은 파일의 `PromptSidePanel`(:209-271)을
고친다. 25의 변경은 `PromptHistoryButton` 안 title 2줄(:186-187)과 주석 1줄(:164)의 **같은 줄 수 치환**이라 26의 앵커가 밀리지
않고 충돌도 없지만 순서를 지킨다).
23(A1)·24(A2)와는 파일이 겹치지 않아 독립이다. 다만 플로팅 창의 **pane별** `PromptLogButton`은 23이
끝나야 눌린다 — 25만 넣으면 "창 단위는 되고 pane 단위는 안 되는" 중간 상태가 된다(기능은 정상, 순서
23 → 24 → 25가 자연스럽다).

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| 토스트가 네이티브 웹뷰 뒤에 가림 | 플로팅 pane도 `PaneControls`로 브라우저로 전환할 수 있다(`PaneControls.tsx:38`). 토스트는 의도적으로 webview 숨김 트리거에서 제외(`stores/occlusion.ts:56-60`) | 메인·HealthBanner와 같은 기존 결정 승계. 컬럼은 터미널 pane 안이라 복사 동선에선 대개 보인다 |
| 문구 "이 창의"가 부정확한 상태 | 별도 모아보기 창이 열려 메인 터미널을 가져간 동안 메인 타이틀바 버튼을 누르면 컬럼은 **저 창** 셀에 열린다(`openPanels` storage 동기) | 수용. prop으로 문구를 갈라도 이 상태는 "이 창"이 아니다. 별도 창 헤더에 같은 버튼이 있어 실사용 동선은 그쪽이다 |
| 되돌리기 후 컬럼이 메인에서도 열려 있음 | 상태가 세션 단위 영속(§2.2)이라 플로팅에서 켠 것이 메인 편입 pane에 그대로 온다 | 의도된 연속성(모아보기↔메인과 같은 규칙). §1 조건에 명시 |
| 풀 창(`float-pool-*`)에서 버튼 노출 | claim 전엔 `FloatWorkspace` 자체가 마운트되지 않는다(`FloatingTerminal.tsx:111` placeholder). 설령 마운트돼도 `terminals: []` → `paneIds.length === 0` → `null`(`TermSessionControls.tsx:179`). 창은 숨김 상태 | 없음 — 렌더 조건이 이미 막는다 |
| 되돌리기 중 토스트 | `redock`은 `terminals: []`로 비워 `FloatWorkspace`가 `null`(:179)을 반환하고 창이 닫힌다 — 토스트도 함께 사라진다 | 정상. 실패 시엔 `return`(:199)으로 트리가 남아 토스트를 낼 수 있다(오픈 이슈 ①) |
| e2e 두 번째 CDP가 풀 창에 붙음 | `/json`의 float 페이지가 여럿(풀 보충 창 포함) | `openFloat`가 알아낸 라벨과 **정확히 일치**하는 페이지만 채택, 나머지 연결은 즉시 `close()`(cdp.mjs `connect`와 같은 규칙) |
| e2e 잔여 상태 | 창을 닫으면 `beforeunload`가 `disposeTerminal`만 부른다(:163-172) — `dropPane`이 아니라 `openPanels`의 e2e paneId가 `gp:prompt-panel-open`에 남을 수 있다 | 창을 닫기 **전에** 마스터를 끄는 단언(→ 0개)이 곧 정리다. finally에서도 best-effort로 한 번 더 |
| StrictMode 이중 마운트 | 플로팅 창도 `React.StrictMode`(`main.tsx:143`) | `Toasts`·`PromptHistoryButton` 모두 효과 없는 순수 렌더 — 무해 |
| `cdp.mjs`가 다른 세션 수정 중 | 워킹트리 M(+118/−24), 검토 중에도 10줄이 늘었다. 이 문서·23·24가 인용한 `cdp.mjs` 줄번호는 2026-09-02 스냅샷(HEAD와 다르다) — 구현 시 `export async function connect`·`async function attach`·`LABEL_EXPR` 심볼로 찾는다 | export 3개를 워킹트리 위에 얹는다 — HEAD 체크아웃·리베이스 금지(27의 `ui.ts` 규칙과 같다). 함수 본문은 무변경이라 병합 충돌은 `export` 키워드 3곳뿐 |

## 7. 검증

정적 검증만으로 통과시키지 않는다(CLAUDE.md). dev 디버그 앱(`npm run dev:app`, CDP 29222).

### 7.1 e2e — `tests/e2e/suites/13-float-window.mjs`(기존 케이스 뒤, 회귀 가드 앞)

```js
import { attach, LABEL_EXPR, listTargets } from "../lib/cdp.mjs"; // §4에서 export

const poll = async (fn, ok, tries = 20, ms = 300) => {
  let v;
  for (let i = 0; i < tries; i++) { v = await fn(); if (ok(v)) return v; await sleep(ms); }
  return v;
};

/** 라벨이 label인 플로팅 페이지에 두 번째 CDP를 붙인다 — 러너의 cdp는 main 페이지 하나다(cdp.mjs connect).
 *  풀 보충 창도 float-* 라벨이라 **정확히 일치**하는 것만 채택하고 나머지는 바로 닫는다. */
const attachFloat = async (label) => {
  for (let i = 0; i < 20; i++) {
    const pages = ((await listTargets(cdp.cdpPort)) ?? []).filter((t) => t.type === "page");
    for (const p of pages) {
      const c = await attach(p);
      if (!c) continue;
      if ((await c.eval(LABEL_EXPR).catch(() => null)) === label) return c;
      c.close();
    }
    await sleep(500);
  }
  return null;
};

// ── 히스토리 마스터 토글 + 토스트 호스트(태스크 25) ──
const TID_H = "gpv-e2e-float-hist";
const openH = await openPty(TID_H);
if (r.check("term_open: 히스토리용 PTY 생성", openH.ok, openH.code || "")) {
  const fh = await openFloat(TID_H);
  const fcdp = fh.label ? await attachFloat(fh.label) : null;
  if (!fcdp) r.skip("플로팅 창 히스토리 마스터 토글", fh.label ? "플로팅 페이지 CDP 연결 실패" : "창 미발견");
  else {
    const openCols = () =>
      fcdp.eval(`document.querySelectorAll('button[title="프롬프트 목록 닫기"]').length`);
    const clickMaster = () =>
      fcdp.eval(`(()=>{ const b=[...document.querySelectorAll('header button')].find(x=>/히스토리/.test(x.textContent||''));
        if(b){ b.click(); return true; } return false; })()`);
    try {
      // 시드 완료(attach 뒤 로컬 스토어에 탭 1개) → 창 안에서 분할 → pane 2개. 메인 스토어는 변하지 않는다.
      const seeded = await poll(() => fcdp.eval(`window.__gpv.terminals.getState().terminals.length`), (n) => n === 1);
      r.check("플로팅 창: 로컬 스토어 시드", seeded === 1, `tabs=${seeded}`);
      const mainTabs = await cdp.eval(`window.__gpv.terminals.getState().terminals.length`);
      await fcdp.eval(`(()=>{ const s=window.__gpv.terminals.getState(); const t=s.terminals[0];
        s.splitPane(t.id, t.activePaneId, "row", false); })()`);
      const panes = await poll(() => fcdp.eval(`document.querySelectorAll('.xterm').length`), (n) => n >= 2);
      r.check("플로팅 창: 분할로 pane 2개", panes >= 2, `xterm=${panes}`);
      r.check("분할이 메인 스토어를 건드리지 않음(창별 독립)",
        (await cdp.eval(`window.__gpv.terminals.getState().terminals.length`)) === mainTabs);

      r.check("사전: 프롬프트 컬럼 0개", (await openCols()) === 0);
      r.check("타이틀바에 히스토리 버튼 존재·클릭", await clickMaster());
      const openedCols = await poll(openCols, (n) => n === panes); // `opened`(Set, :24)와 이름 충돌 금지
      r.check("마스터 켬 → 이 창의 모든 pane에 컬럼", openedCols === panes, `${openedCols}/${panes}`);
      // 상태는 세션 단위 영속 — 같은 origin localStorage를 메인 페이지에서 읽어 확인(promptHistory.ts PANEL_KEY)
      const persisted = await cdp.eval(`(()=>{ try { return !!JSON.parse(localStorage.getItem('gp:prompt-panel-open')||'{}')[${J(TID_H)}]; } catch { return false; } })()`);
      r.check("열림 상태 localStorage 영속(메인에서 관측)", persisted === true);

      await clickMaster();
      const closed = await poll(openCols, (n) => n === 0);
      r.check("마스터 끔 → 컬럼 0개", closed === 0, `cols=${closed}`);

      // 토스트 호스트 — 항목 클릭은 클립보드를 건드리므로 pushToast로 호스트 존재만 확인
      await fcdp.eval(`window.__gpv.ui.getState().pushToast("success","e2e-float-toast")`);
      const toast = await poll(() => fcdp.eval(`document.body.textContent.includes('e2e-float-toast')`), (v) => v === true, 10, 200);
      r.check("플로팅 창에 토스트 렌더(호스트 존재)", toast === true);
      await fcdp.eval(`window.__gpv.ui.getState().toasts.forEach(t=>window.__gpv.ui.getState().dismissToast(t.id))`);
    } finally {
      // 컬럼이 열린 채 창을 닫으면 gp:prompt-panel-open에 e2e id가 남는다 — 끄고 닫는다(best-effort).
      await fcdp.eval(`(()=>{ const n=document.querySelectorAll('button[title="프롬프트 목록 닫기"]').length;
        if(n){ const b=[...document.querySelectorAll('header button')].find(x=>/히스토리/.test(x.textContent||'')); b&&b.click(); } })()`).catch(() => {});
      fcdp.close();
      await closeLabel(fh.label);
      opened.delete(fh.label);
    }
  }
}
// 기존 finally(:225-234)의 term_close 목록에 TID_H 추가.
```

기대: 회귀 가드 케이스(:195-224)가 뒤따르므로 이 블록이 PTY를 남기면 그쪽이 잡는다.

### 7.2 실기(디버그 앱)

관측은 눈이 아니라 값으로 한다 — 플로팅 페이지는 `http://127.0.0.1:29222/json`에서 라벨로 골라 DevTools를 붙인다.

1. 메인에서 터미널 탭 → 우클릭 → "새 창으로 분리 (Float)" → 플로팅 창. 창 안 우클릭 → "오른쪽으로 분할"
   → pane 2개. 타이틀바에 **"히스토리"** 버튼이 되돌리기 왼쪽에 보이는지, 높이가 되돌리기와 같은지
   (`getBoundingClientRect().height` 두 버튼 동일, 32).
2. "히스토리" 클릭 → 두 pane 우측에 컬럼(헤더 "프롬프트 N"). 관측:
   `document.querySelectorAll('button[title="프롬프트 목록 닫기"]').length === 2`, 버튼 class에
   `bg-raised text-accent`. 메인 페이지에서 `localStorage.getItem('gp:prompt-panel-open')`에 두 paneId.
   **메인 창의 다른 터미널 컬럼은 변하지 않았는지**(`.xterm` 옆 컬럼 개수 불변).
3. 한 pane에서 `echo hi` Enter → 그 pane 컬럼에 항목 → 클릭 → **플로팅 창 우하단**에 "프롬프트를
   복사했습니다" 토스트(6초 뒤 소멸), 메모장에 Ctrl+V로 `echo hi`. 관측:
   `[...document.querySelectorAll('div')].some(d=>d.textContent==='프롬프트를 복사했습니다')`.
4. 한 pane의 컬럼 X → 마스터 버튼이 비활성색(`text-fg-muted`)으로 → 마스터 클릭 → **둘 다** 열림
   (전부 펼치기 우선) → 다시 클릭 → 둘 다 닫힘.
5. 컬럼을 연 채 "메인으로 되돌리기" → 메인 탭에 pane 2개, **컬럼 열린 채**(세션 단위 영속).
   메인에서 컬럼 X로 닫아 정리.
6. 문구: 메인 타이틀바 "히스토리" hover → 새 문구, 별도 모아보기 창(모아보기 버튼 우클릭) 헤더 "히스토리"
   hover → 새 문구, 플로팅 → 새 문구. 세 곳에서 `button.title`이 §3.3 두 문자열 중 하나.
7. 다크·라이트 각 1회 3번 토스트 색 확인(토큰만 쓰므로 형식 확인).
8. 러너 `npm run test:e2e` — 13 전체 통과, 14 회귀 없음.

## 8. 오픈 이슈(사용자 결정 — 없으면 기본값)

| # | 질문 | 기본값 |
|---|---|---|
| ① | 되돌리기 실패(`float_redock_begin` reject, `FloatingTerminal.tsx:198`)를 `pushToast("error", "되돌리기 중단 — PTY 보존 등록 실패")` 1줄로 표면화할지 | **범위 밖**(요구에 없다). 호스트가 생기므로 넣으려면 그 줄 하나다 — 원하면 이 태스크에 얹는다 |
| ② | A3 e2e 위치 — 13(플로팅 헬퍼 재사용) vs 14(상위 설계 V) | **13** |
| ③ | 문구 "이 창의" — 별도 창이 메인 터미널을 가져간 동안 메인 버튼의 부정확(§6) 수용 | **수용**. prop으로 갈라도 그 상태는 어느 창도 "이 창"이 아니다 |
| ④ | 플로팅 창에 `ConfirmHost`도 선제 마운트 | **안 함**. `askConfirm` 경로가 생기는 커밋이 단다 |

## 9. 구현 결과(구현 2026-09-02 · 검증 2026-09-03)

§5 단계 1~3 구현. `npx tsc --noEmit` **exit 0**(검증일 재실행도 exit 0). Rust 변경 0.
스토어·타입 변경 0(§4 계약대로 기존 것만 사용). 단계 4(e2e·실기)는 **2026-09-03에 실행**했다(§9.3).
검증 과정에서 앱 코드는 **한 줄도 고치지 않았다** — 실패한 단언이 없었다.

| 파일 | LOC | 내용 |
|---|---|---|
| `src/components/workspace/TermSessionControls.tsx` | +6/−3 | `PromptHistoryButton` title 2문장을 §3.3 문구로 치환(+ 세 사용처 이유 주석 2줄), 함수 주석의 "(모아보기에서 보임)" → "(메인·별도 창·플로팅 — 그 창의 스토어에 있는 pane)" |
| `src/FloatingTerminal.tsx` | +19/−7 | import 2줄(`Toasts`·`PromptHistoryButton`), `FloatTitleBar actions`를 fragment로 바꿔 되돌리기 **왼쪽**에 `<PromptHistoryButton className="h-full shrink-0 px-2 text-[11px]" />`, 루트 div 마지막 자식에 `<Toasts />`(각각 이유 주석) |
| `tests/e2e/suites/13-float-window.mjs` | +174/−2 | §7.1 블록(히스토리 마스터 토글 8단언 + 토스트 호스트 1단언)을 redock 케이스 뒤·회귀 가드 앞에 삽입, `TID_H` 상수와 finally `term_close` 목록 추가, 모듈 스코프에 플로팅 페이지용 최소 CDP 클라이언트 `attachPage`와 run 스코프의 `poll`·`attachFloat` |

### 9.1 설계 대비 이탈

| # | 설계 | 구현 | 이유 |
|---|---|---|---|
| 1 | §3.5 ③·§4: `tests/e2e/lib/cdp.mjs`에 `LABEL_EXPR`·`listTargets`·`attach` **export 3개** 추가 | `cdp.mjs` **무변경**. 13 스위트 파일 안에 `attachPage`(WebSocket + `Runtime.enable` + `eval` 하나, ~55 LOC)와 `LABEL_EXPR` 상수를 두고, `attachFloat`이 `/json`을 직접 열거 | 이 태스크의 지시가 `cdp.mjs` 수정을 금지했다(다른 세션이 편집 중, 워킹트리 M). 대안으로 지시가 제시한 "13 스위트 안 로컬 헬퍼"를 택했다. `attachFloat`의 라벨 정확 일치·비채택 연결 즉시 close 규칙은 §6 마지막 행 그대로 |
| 2 | §7.1: `const attachFloat = …` 이 `listTargets(cdp.cdpPort)` 사용 | 포트는 `port ?? cdp.cdpPort ?? 29222` — `run({ … , port })`로 받는다 | 러너는 `port: cdp.cdpPort`를 넘기지만(`run.mjs`) 단독 러너는 `{cdp, report, fix}`만 넘긴다. 두 경로 모두에서 동작해야 한다 |
| 3 | §7.1 finally: `closeLabel(fh.label); opened.delete(fh.label);` | 같은 두 줄을 `if (fh.label)`로 감쌌다 | `fh.label`이 null이면 `attachFloat`도 null이라 이 finally에 들어오지 않지만, 정적으로도 null 인자를 배제 |
| 4 | §7.1 토스트 정리 `toasts.forEach(t=>getState().dismissToast(t.id))` | `const u=getState()`를 한 번 잡아 `u.toasts.forEach(t=>u.dismissToast(t.id))` | 반복 중 `getState()`가 갱신된 스냅샷을 돌려줘 일부가 남는 것을 피한다 |

§3.4 "만들지 않는 것"은 전부 지켰다 — `ConfirmHost` 미마운트, `__gpv.promptHistory` 미노출,
`PromptHistoryButton` prop 무추가, 되돌리기 실패 토스트 없음(오픈 이슈 ① 기본값 **범위 밖** 유지).

### 9.2 §2 현황과 실제 코드의 차이(구현 시점)

- §2.1이 인용한 `TerminalPane.tsx:99-118`의 **세션 클러스터는 이미 없다** — 태스크 23(A1, 오버레이 병합)이
  워킹트리에 먼저 들어와 있었다(`PaneTree.tsx`·`TerminalPane.tsx` 모두 M). 이 태스크와 파일이 겹치지 않아
  영향 없음. §5의 "25만 넣으면 pane 단위는 안 되는 중간 상태"는 해당하지 않는다(23이 이미 끝나 있다).
- 나머지 인용(§2.2~§2.4의 `PromptHistoryButton`·`Toasts`·`FloatTitleBar` 구조, `promptHistory` PANEL_KEY,
  `main.tsx`의 라벨 분기 앞 `__gpv` 노출)은 전부 코드와 일치했다.

### 9.3 검증 — e2e·실기 실행·관측 결과(2026-09-03)

디버그 앱(dev identifier, CDP 29222 · vite 39090)에 붙어 실행했다. 관측은 눈이 아니라 값이다 —
플로팅 페이지는 `http://127.0.0.1:29222/json`의 page 타깃을
`__TAURI_INTERNALS__.metadata.currentWebview.label`로 골라 두 번째 CDP를 붙였고, 버튼은 전부
`Input.dispatchMouseEvent`(실제 포인터)·`Input.dispatchKeyEvent`(실제 키보드)로 눌렀다.

#### e2e(§7.1)

| 실행 | 결과 |
|---|---|
| 13 스위트 단독 러너(실기 **전**) | **27 pass / 0 fail / 0 skip** |
| 13 스위트 단독 러너(실기 **후** 재실행) | **27 pass / 0 fail / 0 skip** |
| `npx tsc --noEmit -p .` | **exit 0** |

이 태스크가 넣은 9단언(마스터 토글 8 + 토스트 1) 전부 pass — 시드·분할 2 pane·메인 스토어 불변·
사전 0개·버튼 클릭·`2/2` 펼침·`gp:prompt-panel-open` 영속·접기 0개·플로팅 토스트 렌더.
`attachFloat`(라벨 정확 일치 + 비채택 연결 즉시 close)와 로컬 `attachPage`는 두 번 다 정상 동작했다.
14 스위트는 이번 범위가 아니라 돌리지 않았다(§9.5 ③).

#### 실기(§7.2 1~7) — 관측값

번호는 §7.2 항번이 아니라 **관측 항목 10개**다(§7.2 1~7을 쪼갠 것). §7.2 8은 위 e2e 표.

| # | 관측 항목 | 관측값 | 판정 |
|---|---|---|---|
| 1 | 버튼 위치·높이 | 타이틀바 버튼 좌→우: **히스토리 x=582 w=75** → 되돌리기 x=657 w=123 → 최소화 780 → 최대화 820 → 닫기 860. 높이는 다섯 개 **모두 31.33px**(헤더 `h-8`=32px − `border-b` 1px) | ✅ 되돌리기 **왼쪽**·높이 동일 |
| 2 | 실클릭(드래그 영역에 안 먹히나) | 버튼 중심(619,16)의 `elementFromPoint` = **그 `<button>` 자신**(drag-region spacer 아님). `Input.dispatchMouseEvent` 실클릭 → 컬럼 `0 → 2`. 되돌리기 버튼도 `hitSame=true` | ✅ 이전 판의 최대 미검증 항목("클릭이 먹는지 — 되돌리기 선례로 추정할 뿐") 해소 |
| 3 | 상태색 | 켬 → class가 `flex items-center gap-1 rounded bg-raised text-accent h-full shrink-0 px-2 text-[11px]`(**bg-raised text-accent**) / 끔 → `… text-fg-muted hover:bg-raised hover:text-fg …`(**text-fg-muted**) | ✅ |
| 4 | `gp:prompt-panel-open` | 메인 페이지에서 읽어 `["gpv-real25-hist","051bf63d-…"]` — 그 창의 **두 paneId** | ✅ |
| 5 | 메인 창 불변 | 컬럼 `0 → 0`, 탭 `9 → 9`, `.xterm` 0 (메인은 viewer 탭 표시 중). 메인 `openPanels`에는 플로팅 pane id만 들어온다 — 상태가 세션 단위 공유라 **의도된 것**(§2.2) | ✅ |
| 6 | 항목 클릭 복사 토스트 | 실제 키보드로 `echo gpv25`+Enter → 컬럼에 항목 생성 → 항목 **실클릭** → 플로팅 창의 `div.absolute.bottom-8.right-4` 렌더. `innerWidth−right = **16px**`, `innerHeight−bottom = **32px**`, `z-index 55`. 메인 창의 토스트 호스트는 `null`(안 뜬다) | ✅ 우하단·이 창에만. **단 문구는 "복사에 실패했습니다"** — 아래 참조 |
| 7 | 전부 펼치기 우선 | 2개 열린 상태에서 한 pane만 닫음 → cols 1 · 마스터 `text-fg-muted`·title "펼치기" → 마스터 클릭 → **cols 2** → 재클릭 → cols 0 → 재클릭 → cols 2 | ✅ |
| 8 | 되돌리기 후 컬럼 연속성 | 컬럼 2개 연 채 되돌리기 실클릭 → 창 소멸, PTY 2개 **생존**(`term_project` 둘 다 projectId 반환), 메인 `openPanels`에 두 pane 유지. 편입 결과는 **pane당 탭 하나**(§9.5 ②) — 각 탭을 활성화하니 `.xterm` 1 + 컬럼 1(헤더 "프롬프트 0") | ✅ |
| 9 | 세 사용처 title | 메인 타이틀바 / **별도 모아보기 창 헤더**(열어서 확인 후 닫음) / 플로팅 타이틀바 — 셋 다 §3.3 두 문자열 중 하나. 예: 메인·모아보기 "전체 프롬프트 목록 펼치기 — 이 창의 모든 터미널 우측에 입력 목록을 엽니다", 플로팅(열린 상태) "…접기 — 이 창의 모든 터미널 우측의 입력 목록을 닫습니다" | ✅ |
| 10 | 다크/라이트 토스트 색 | 토큰이 세 테마에서 모두 해석된다(카드 bg / icon success·error / fg): monokai `rgb(22,31,44)` / `rgb(87,198,92)`·`rgb(240,85,106)` / `rgb(230,237,246)` · light `rgb(230,232,238)` / `rgb(54,140,60)`·`rgb(199,34,45)` / `rgb(34,36,41)` · solarized-light `rgb(228,220,196)` / `rgb(133,153,0)`·`rgb(220,50,47)` / `rgb(7,54,66)` | ✅ 형식·대비 구분 확인 |

**§3.2 a의 가정이 실측으로 확인됐다** — 루트가 non-positioned `flex h-screen flex-col`이라
`absolute bottom-8 right-4`가 뷰포트 기준 우하단(16/32px)으로 잡힌다.

**미검증 1건 — 복사 성공 문구.** 항목 클릭이 낸 토스트는 `pushToast("error", "복사에 실패했습니다")`
쪽이었다. 원인은 앱 밖이다: 이 기기의 Windows 클립보드가 앱 밖 무언가에 점유돼 있어
플로팅 창·**메인 창**·PowerShell `Set-Clipboard`·WinForms `Clipboard.SetText`가 **전부 같은 이유로 실패**한다
(플러그인 에러 문구 "The native clipboard is not accessible due to being held by another party",
`GetOpenClipboardWindow()`는 0을 돌려준다 — 순간 점유가 반복되는 형태). 즉 이 태스크가 만든 경로
(**항목 클릭 → `copyText` → `pushToast` → 이 창의 `<Toasts/>`**)는 **끝까지 실측으로 확인**됐고,
남은 것은 성공 분기의 문구 "프롬프트를 복사했습니다"와 실제 붙여넣기뿐이다. 클립보드가 정상인 기기에서
§7.2 3을 한 번 더 볼 것.

#### 잔여 정리

임시 자원은 전부 회수했다 — 플로팅 창 0개(숨김 풀 창만 남음), 임시 탭 0개, `gp:prompt-panel-open` `[]`,
`gp:prompt-history` `[]`, 토스트 0개, 테마 `monokai` 원복, 메인 활성 탭 `viewer` 원복,
실기·e2e가 만든 PTY 7개 전부 `term_project = null`(종료). 별도 모아보기 창도 닫았다.

### 9.4 발견한 선행 이슈(수정 안 함)

- **컬럼 헤더의 X(`title="프롬프트 목록 닫기"`)가 pane 오버레이의 "패널 닫기"에 덮여 있다 — 누르면
  pane이 통째로 닫힌다.** 실측(플로팅 창 900×600, 분할 2 pane): 컬럼 X = `(877,36)–(892,51)`,
  오버레이 닫기 버튼 = `(872,39)–(893,60)`, 컬럼 X **중심의 `elementFromPoint`가 오버레이 쪽 버튼**을
  돌려준다(두 pane 모두). 1차 실기에서 §7.2 4를 문서대로 "컬럼 X 클릭"으로 시도했더니 **그 pane이
  닫히고 PTY가 죽었다**(재현). 원인은 `PaneTree.tsx`의 세션/패널 통합 오버레이
  (`absolute right-1 top-1 z-30 … group-hover/pane:opacity-100`)가 `PromptSidePanel` 헤더와 같은 자리라는
  것 — **태스크 25가 만든 코드가 아니고**(컬럼도 오버레이도 이 태스크 이전부터 있다) 파일 소유는
  태스크 23(A1)이라 **고치지 않았다**. 메인 창에도 같은 구조가 그대로 적용된다.
  §7.2 4는 우클릭 메뉴 "프롬프트 목록 닫기"(태스크 24)로 대체 관측했다.
- **`tests/e2e/lib/cdp.mjs`의 `attach`·`listTargets`는 export가 없어 스위트가 두 번째 창에 붙을 수 없다** —
  §3.5 ③이 지적한 그대로다. 이번엔 지시에 따라 13 스위트 안에 최소 클라이언트를 복제했으므로 `cdp.mjs`
  export가 추가되면 그 복제(`attachPage`, ~55 LOC)를 지우고 import로 바꾸는 것이 맞다.
- 되돌리기 실패는 여전히 `console.error`만이다(`FloatingTerminal.tsx`) — 호스트가 생겼으니 표면화는
  `pushToast("error", …)` 1줄이지만 오픈 이슈 ① 기본값(범위 밖)을 지켰다.
- **실기 함정(코드 결함 아님)**: vite HMR **전체 리로드**가 오면 플로팅 창의 `useTerminals`가 시드
  상태(leaf 1개)로 되돌아가고 `beforeunload`가 그 창의 pane PTY를 `disposeTerminal` 한다 —
  분할로 늘린 pane과 그 PTY가 조용히 사라진다. 다른 세션이 소스를 고치는 동안 실기하면 두 번 겪는다.
  긴 실기 스크립트는 관측 구간을 짧게 끊고, 시작할 때 `layout`을 다시 읽어 전제를 확인할 것.

### 9.5 §7 문서와 실제의 차이(검증에서 드러난 것)

| # | 문서 | 실제 | 처리 |
|---|---|---|---|
| ① | §7.2 1 "두 버튼 높이 **32**" | 헤더가 32px(`h-8`), 버튼 콘텐츠 높이는 **31.33px**(헤더 `border-b` 1px 제외). 히스토리·되돌리기·창 컨트롤 3개가 **모두 같은 값** | 요구("높이가 되돌리기와 같은지")는 충족. 문서의 32는 헤더 값 |
| ② | §7.2 5 "메인 **탭**에 pane 2개" | `redock()`이 `panes.forEach(p => sendTerminalsCmd({op:"openTerminal", paneId:p}))`라 **pane마다 탭 하나**가 생긴다(2 pane → 2 탭) | 컬럼 연속성(요구 §1 마지막 줄)은 그대로 성립 — 각 탭에서 컬럼이 열린 채였다. 편입 형태는 이 태스크 범위 밖 |
| ③ | §7.2 8 "`npm run test:e2e` — 13 전체 통과, 14 회귀 없음" | 13만 단독 러너로 2회 실행(27 pass) | 14 회귀 확인은 미실행 — 이번 지시가 13 스위트로 한정했고, 14는 다른 태스크가 소유한다 |
| ④ | §7.2 4 "한 pane의 컬럼 **X**" | 그 X는 오버레이에 덮여 실제로는 pane을 닫는다(§9.4) | 우클릭 메뉴로 대체 관측. 문서의 클릭 경로는 §9.4가 고쳐지기 전까지 쓰면 안 된다 |
