# 태스크 26 — 프롬프트 컬럼 호버 카드(비상호작용 툴팁)

> 상태: **구현 완료 · 검증 통과(미커밋)** — tsc exit 0, e2e 14 전체 57 pass/0 fail(#2d 11단언 포함), §7.2 실기 관측 완료(§9.3) ·
> 근거: 코드 실측 2026-09-02(워킹트리 기준) · 실행·관측 2026-09-03 ·
> 상위 설계: `DOCS/pane-history-tooltip-layout-design.md` §1.2(현황) · §2.2(B) · §3 B1 · §5 B1 · §6 ③
> 상위 태스크 ID: **B1**. Rust 변경 0 — 프론트 1파일(`TermSessionControls.tsx`) + DEV 테스트 훅 1줄 + e2e.

## 1. 요구사항

히스토리바(프롬프트 컬럼 `PromptSidePanel`)의 항목에 마우스를 올리면 **그 입력의 전문이 읽히는 카드**가
떠야 한다. 지금은 브라우저 native `title`이라 시스템 툴팁이 지연 뒤에 뜨고(지연 시간·줄바꿈 처리는 WebView2
동작 — 검증 필요), 고정폭·정렬·표시 지속을 제어할 수 없어 여러 줄 프롬프트(들여쓰기·표)는 읽기 어렵다.

받아들이는 조건:
- 항목 hover → **항목 왼쪽**에 카드. 본문은 고정폭 12px·줄 간격 20px·`pre-wrap`(줄바꿈·들여쓰기 보존).
- 지연은 **최초 1회만 150ms**. 이미 카드가 떠 있으면 항목 사이 이동은 **즉시 전환**. 리스트 영역을 벗어나면
  **즉시 숨김**.
- 좁은 셀(항목 `rect.left < 500px` — 별도 창 1100px 2열, 플로팅 900px 분할)에서 카드가 항목을 덮어도
  **깜빡이지 않는다**(카드는 hit-test에서 빠진다).
- 헤더: 절대시각 · N줄 · M자. 본문 **30줄 상한**, 넘으면 푸터 "… 외 N줄". 마지막 줄 "클릭하면 복사".
- 다른 창에서 기록을 지우거나(`clear`) 트림·교체(`storage` 이벤트)돼 항목이 사라지면 카드도 사라지고 **오류가
  없다**.
- 이웃 pane/셀이 브라우저(네이티브 webview)여도 카드가 가려지지 않는다. 항목 사이를 지날 때 webview가
  숨김/복원을 반복하지 않는다.
- 항목의 native `title`은 제거한다(이중 표시 방지). 헤더 버튼(지우기·닫기)의 title은 유지.
- 컬럼이 닫히거나(언마운트) 창이 닫혀도 대기 중 타이머가 `setState`를 부르지 않는다.
- **Escape 닫기 없음, 카드 스크롤 없음**(§2·§3.1).
- 다크 4종·라이트 2종에서 본문(`text-fg`) 대비 ≥ 4.5:1.

## 2. 현황(근거)

- **항목 툴팁은 native `title`.** `src/components/workspace/TermSessionControls.tsx:254`
  `title={`${e.text}\n\n클릭하면 복사`}`. 항목 본문은 `line-clamp-3`(`:257`), 아래 상대시간
  `relativeTime(e.at)`(`:260`, `text-[9px] text-fg-dim`). 항목은 `<button onClick={() => copy(e.text)}>`
  (`:251-253`) — 복사는 `copyText`(`lib/clipboard.ts:20`) 결과를 토스트로 알린다(`:215-222`).
- **패널 구조.** 루트 `flex w-[15%] min-w-[110px] shrink-0 flex-col border-l border-edge bg-panel text-[11px]`
  (`:224`), 헤더(`:225-244`, 지우기 `:229-236`·닫기 `:237-243`), 리스트 컨테이너
  `min-h-0 flex-1 overflow-y-auto`(`:245`), 최신이 위(`list.slice().reverse()`, `:247-249`), 빈 상태 문구
  `:263-267`. 컬럼은 부모 flex row의 **마지막(우측) 자식**이다 — 워크스페이스 `TerminalPane.tsx:97-121`
  (`relative h-full min-w-0 flex-1` xterm 래퍼 뒤에 `{promptOpen && <PromptSidePanel/>}`), 모아보기 셀
  `AggregateTerminals.tsx:1223-1226`. 따라서 카드가 갈 자리는 **항목의 왼쪽(자기 xterm 위)**이다.
- **래퍼가 `overflow-hidden`이라 카드는 `fixed`여야 한다.** 모아보기 셀 루트 `overflow-hidden`
  (`AggregateTerminals.tsx:1182`), 워크스페이스 분할 자식 래퍼 `overflow-hidden`(`PaneTree.tsx:148,166`).
  같은 파일의 `ThemeButton` 메뉴가 이미 이 이유로 fixed다(`TermSessionControls.tsx:23`, 메뉴 `:83-131`) —
  패널 트리 안에서 fixed가 뷰포트 기준으로 잘 빠져나온다는 선례.
- **비상호작용 fixed 카드 선례** `FileTreePanel.tsx:437-452` `DragGhost`:
  `pointer-events-none fixed z-50 max-w-64 rounded-md border border-edge bg-panel px-2.5 py-1.5 text-xs shadow-xl`
  (`:443`). 커서 따라다니는 라벨이라 자기 state를 갖고 부모 리렌더를 막는 구조(`:422-425`).
- **fixed 팝오버 공통 규칙.** `useOccludesWebview(!!menu)` 등록(`stores/occlusion.ts:49-54`, 호출부 14곳 —
  같은 파일 `:36`, `TerminalPane.tsx:58`, `AggregateTerminals.tsx:326,992` 등), 세로 뒤집기
  `menu.y > innerHeight/2 ? {bottom} : {top}`(`ChangesPanel.tsx:547-557`), 같은 파일 `ThemeButton`은
  `below >= 300 || below >= above`로 판정하고 `maxHeight`를 여유로 클램프한다(`:49-62`).
- **hover로 열리는 fixed 팝오버 선례** — 모아보기 묶음 칩 드롭다운(`AggregateTerminals.tsx:316-326`):
  `useRef<number | undefined>` 타이머 + `window.setTimeout(…, 150)` 지연 닫기 + 언마운트 `clearTimeout`
  (`:325`) + 점유 OR 등록(`:326`). 드롭다운 자체가 enter=hold/leave=schedule(`:712-720`) — **상호작용형**이다.
- **Escape는 xterm이 막지 않는다.** `lib/terminal-engine.ts:212` `attachCustomKeyEventHandler`는 앱 단축키·
  IME·Tab만 가로채고(`:220-225`, `:232-252`), `Escape`는 macOS IME 미러 리셋 목록(`:259-272`)에만 등장한다
  → `\x1b`가 PTY로 들어간다. 카드에 Escape 닫기를 달면 hover 중 Esc가 TUI(Claude Code 등)의 진행 중 턴을
  끊는다. 카드가 `pointer-events-none`이면 키 포커스도 못 받으므로 Escape 핸들러는 window 전역이어야 하는데,
  그게 바로 그 footgun이다.
- **데이터.** `stores/promptHistory.ts` `PromptEntry { id, text, at }`(`:5-10`, `at`은 epoch ms). `record`
  (`:148-162`): 한 줄 `MAX_TEXT 4000`자 트림 + `…`(`:21`, `:153`), 직전과 같은 줄이면 `at`만 갱신(`:155`),
  id `${at}-${++seq}`(`:156`), 터미널당 `MAX_PER_TERM 200`(`:20`, `:158-159`). `clear(termId)`(`:197-208`)는
  기록과 **패널 열림까지** 지운다(`:202-203`) → 컬럼이 언마운트된다. 다른 창의 변경은 `storage` 리스너가
  `setState({ byTerminal })`로 **통째로 교체**한다(`:213-223`, `:217`) — 항목 배열 참조가 바뀌지만 id는 보존된다.
- **절대시각 유틸은 없다.** `lib/format.ts`: `relativeTime`(`:1-7`, 시간 단위까지), `shortDate`(`:31-41`,
  날짜만). 인라인 `toLocaleTimeString()`으로 충분하다(상위 설계 §2.2).
- **React 19.2.7의 enter/leave 합성.** `node_modules/react-dom/package.json:3` `19.2.7`.
  `onMouseEnter/onMouseLeave`는 네이티브 `mouseenter`가 아니라 **`mouseover`/`mouseout`**에서 합성된다
  (`react-dom-client.development.js:19457-19597`). `mouseover`의 `relatedTarget`이 React 노드면 그쪽 `mouseout`이
  처리한다고 보고 건너뛴다(`:19463-19471`); `relatedTarget`이 없거나 React 밖이면 `from=null`로 진입 경로 전체에
  enter를 쏜다(`:19497`, enter 이벤트 생성 `:19529-19539`, 경로 누적 `:19580-19596`). **e2e가 `new MouseEvent('mouseenter')`를 보내면 아무 일도 안 일어난다** —
  §7 스니펫이 `mouseover`/`mouseout`을 쓰는 이유.
- **테스트 훅.** `src/main.tsx:49-56` `window.__gpv = { ui, terminals, videoSplit, planSegments }`(DEV 전용) +
  메인 창에서 `queryClient`(`:188-191`). `promptHistory`는 없다. e2e 14의 관례: `cdp.eval`(`tests/e2e/lib/cdp.mjs:76-87`,
  `awaitPromise`·`returnByValue`), `poll(fn, ok, tries, ms)`(`14-frontend-dom.mjs:29-37`), `J`(`:24`), `uGet`(`:25`),
  `r.check(name, cond, detail)`/`r.skip`(`lib/report.mjs:27-33`). `openTerminal`은 `{ tabId, paneId }`를 돌려준다
  (`stores/terminals.ts:201-204`; 14는 `tabId`만 받는다 `:133-135`). **prompt history 관련 e2e는 0건**
  (`tests/e2e`에서 `promptHistory`·`PromptSidePanel`·`gp:prompt-history` 매치 없음).
- **창 크기.** 모아보기 별도 창 `1100×720`, 최소 `520×320`(`src-tauri/src/lib.rs:360-361`); 플로팅 창
  `900×600`, 최소 `360×240`(`:153-154`); 메인 `1440×900`, 최소 `1100×700`(`:758-759`). 모아보기 열 수는
  `n<=4 → 2열`(`AggregateTerminals.tsx:337`).
- **토큰.** `styles.css` `@theme`(`:3-33`): `--color-panel #2b2d30`, `--color-fg #dfe1e5`, `--color-fg-muted #9da0a8`,
  `--color-fg-dim #6f737a`, `--font-mono "Cascadia Code", Consolas, "D2Coding", ui-monospace, monospace`(`:32`).
  테마별 오버라이드 `:41-167`(monokai `:43,51-53` · dracula `:69,77-79` · nord `:94,102-104` · light `:120,128-130` ·
  solarized-light `:147,155-157`). `bg-panel` 위 대비 사전 계산은 §7.3.

## 3. 설계

### 3.1 형태

| 대안 | 평가 |
|---|---|
| A. native `title` 유지(+ 줄바꿈 정리) | 시스템 툴팁은 폰트·폭·지연·줄바꿈을 제어할 수 없다. WebView2가 `\n`을 살리는지는 검증 필요 — 살리더라도 고정폭·정렬은 불가. 요구 불충족 |
| B. 상호작용 팝오버 + 지연 닫기(묶음 칩 드롭다운 방식 `AggregateTerminals.tsx:316-326`) | 카드에 pointer-events가 있으면 카드가 항목을 덮는 좁은 셀에서 **항목 mouseleave → 숨김 → 항목 mouseenter → 표시**의 깜빡임 루프(상위 §1.2). 지연 닫기 150ms를 걸어도 "리스트를 벗어나면 즉시 숨김"과 양립하지 않고, 카드 위로 넘어가 스크롤바를 잡는 UX는 "곁눈질" 패널의 목적을 넘어선다 |
| **C. 비상호작용 카드(`pointer-events-none fixed z-50`, 리스트 단위 hover 상태)** (채택) | `DragGhost` 선례. 카드가 hit-test에서 빠져 항목을 덮어도 무해 — 좁은 셀 문제가 **정의상** 사라진다. 스크롤·Escape가 없으니 상태는 `{id, rect} \| null` 하나. 전문은 클릭 복사로 얻는다 |
| D. 툴팁 라이브러리(Floating UI·Radix) | 사용처 1곳에 의존성 추가. 기본이 상호작용형·포털형이라 B의 문제를 그대로 들고 온다. 기각(YAGNI) |

**C 채택.** 상위 설계 §2.2와 같다. 공용 컴포넌트로 뽑지 않는다 — 사용처가 `PromptSidePanel` 하나다.

### 3.2 가로 기하

```
W    = max(240, min(480, rect.left − 16))     // 항목 왼쪽 여유에서 좌우 8px씩 뺀 폭, 240~480 클램프
left = max(8, rect.left − 8 − W)              // 항목과 8px 간격, 화면 왼쪽 8px 하한
겹침 = max(0, W + 16 − rect.left)             // 하한 240이 발동할 때만 > 0 — 무해(pointer-events-none)
```

| 상황 | 항목 `rect.left`(추정) | W | left | 카드 범위 | 비고 |
|---|---|---|---|---|---|
| 별도 창 1100px · 2열 · **첫 열** | ≈ 440(셀 ≈ 550 − 컬럼 110) | 424 | 8 | [8, 432] | 항목까지 8px. 상위 설계의 ≈460은 갭·테두리 차 |
| 별도 창 1100px · 2열 · 둘째 열 | ≈ 990 | 480 | 502 | [502, 982] | 첫 열 xterm 위 — 카드가 xterm을 덮지만 포인터는 통과 |
| 플로팅 900px · 좌우 분할 · 좌 pane | ≈ 340(pane 450 − 110) | 324 | 8 | [8, 332] | |
| 플로팅 900px · 좌우 분할 · 우 pane | ≈ 790 | 480 | 302 | [302, 782] | 좌 pane 위 |
| 극단: 사이드바 접힘 + 3열 분할, pane 300px | ≈ 190 | **240(하한)** | 8 | [8, 248] | 항목 190~을 **58px 덮음**. 카드가 그 항목의 전문을 보여주므로 정보 손실 없음, hit-test 제외라 깜빡임 없음 |

컬럼 폭은 `max(110, 0.15 × 셀 본문 폭)`(`:224`)이라 셀이 733px 아래면 항상 110px — 위 추정은 그 값을 썼다.
실측은 §7.2(항목 `getBoundingClientRect`로 W·left를 재계산해 카드 rect와 ±1px 비교).

### 3.3 세로 기하와 높이 상한 — 상위 설계와 다른 지점

세로 앵커는 `ChangesPanel.tsx:547-557` 규칙 그대로: `below = rect.top < innerHeight/2` → `top: rect.top`,
아니면 `bottom: innerHeight − rect.bottom`(항목 상단/하단에 카드 상단/하단을 맞춘다).

그런데 상위 설계의 `pre max-h-[60vh]`만으로는 **넘친다**. 카드 콘텐츠 최대 높이 ≈ 헤더 22 + `pre`(30줄 × 20px
+ 패딩 16) 616 + 푸터 20 + 힌트 18 ≈ **676px**. 별도 창 기본 `innerHeight ≈ 720`(§2)에서 절반은 360이고
`60vh = 432`다 — `rect.top = 350`(아래 앵커)이면 카드 하단이 350 + 432 + 60 = 842 > 720. 위 앵커도 대칭으로 같다.

→ **카드(루트)에 `maxHeight = max(120, (below ? innerHeight − rect.top : rect.bottom) − 8)`**, 카드는
`flex flex-col overflow-hidden`, `pre`는 `min-h-0 flex-1 overflow-hidden`(고정 `max-h` 없음). 헤더·푸터는
`shrink-0`이라 항상 보이고 **본문만 잘린다.** 앵커 쪽 여유는 정의상 ≥ innerHeight/2 − 8이라 720px 창에서도
헤더 + 15줄 + 푸터가 보인다. 매우 긴 **한 줄**(최대 4000자, 480px에서 ≈ 60 시각 줄)도 이 상한이 자른다 —
그때 "외 N줄" 푸터는 없지만(개행 기준) 헤더의 "M자"와 "클릭하면 복사"가 남는다(§6 ⑦, §8 ②).

### 3.4 타이머·상태 수명

상태: `hover: { id: string; rect: DOMRect } | null` + `hoverRef`(동기 미러 — 핸들러가 최신 열림 여부를 클로저
갱신 없이 읽는다) + `showTimer: useRef<number | undefined>`. 카드 표시 여부는 `entry = hover && list.find(id)`.

| 이벤트 | 조건 | 동작 | 이후 |
|---|---|---|---|
| 항목 `onMouseEnter` | 닫힘(`hoverRef.current == null`) | `clearTimeout`; `rect`를 **동기 캡처**(타이머 안에서 `currentTarget`은 null); `setTimeout(150)` → `show({id, rect})` | 150ms 후 표시 |
| 항목 `onMouseEnter` | 열림 | `clearTimeout`; `show({id, rect})` 즉시 | 즉시 전환 |
| 150ms 안에 다른 항목 enter | 닫힘 | 이전 타이머 clear, 새 타이머 | 마지막 항목만 표시(항목마다 기다리지 않음) |
| 리스트 컨테이너 `onMouseLeave` | — | `clearTimeout`; `show(null)` | 즉시 숨김. 헤더(지우기·닫기)로 올라가도 숨김 — 의도 |
| 리스트 컨테이너 `onScroll` | — | 위와 동일 | 캡처한 `rect`가 스테일해지는 것을 막는다. 닫힌 상태에선 `null → null`이라 리렌더 없음 |
| 항목 소멸(`clear`·트림·`storage` 교체) | `hover.id ∉ list` | 렌더 가드 → `entry` 없음 → 카드 미렌더, 점유 해제 | `hover`는 남지만 다음 leave/enter가 정리. 예외 없음 |
| 새 기록 추가(최신이 위라 항목이 아래로 밀림) | 열림 | 카드는 **id 기준**이라 내용은 그대로, 위치만 옛 rect | 포인터가 움직이면 새 항목 enter → 즉시 갱신(§6 ⑥) |
| 언마운트(컬럼 닫힘·셀 숨김·창 닫힘·`clear`) | — | effect cleanup `clearTimeout` | 타이머가 언마운트 뒤 `setState`하지 않음 |

Escape·창 resize 핸들러 없음. resize 뒤 위치는 다음 enter에서 재계산된다.

### 3.5 점유(occlusion)

`useOccludesWebview(!!entry)` — **리스트 단위** hover라 항목 사이를 지날 때 `acquire/release`가 반복되지 않는다
(옆 브라우저 셀이 항목마다 숨김/복원으로 깜빡이는 것을 막는다). 카드가 이웃 pane(브라우저일 수 있음) 위로
나가므로 등록은 필요하다(§3.2 둘째 열·우 pane 행). 상위 설계의 `!!hover`가 아니라 **`!!entry`**인 이유: 항목이
사라져 카드가 그려지지 않는데 webview만 계속 숨는 구간을 없앤다(§3.7).

### 3.6 접근성

- 카드는 `pointer-events-none`·비포커스 — **키보드 경로는 만들지 않는다.** 항목은 `<button>`이라 Tab으로
  도달·Enter로 복사되고, `line-clamp-3`는 CSS 클램프라 전문이 DOM에 있어 보조기술이 그대로 읽는다. 카드의
  내용은 항목 텍스트의 반복이라 `aria-describedby` 연결 없이도 정보 손실이 없다.
- 카드에 `role="tooltip"`을 준다 — 시맨틱 + e2e/실기의 안정 셀렉터(`src`에 `role="tooltip"` 사용 0건).
- native `title` 제거로 키보드 사용자가 "클릭하면 복사" 힌트를 잃는다 — 수용(헤더 버튼 title 유지, 항목 클릭 자체가
  복사라 발견 비용이 낮다).
- 색은 토큰만(`bg-panel`·`border-edge`·`text-fg`·`text-fg-muted`·`text-accent`) — 테마 6종 자동 대응. 대비 §7.3.

### 3.7 상위 설계와의 차이

| # | 상위 §2.2 | 이 문서 | 이유 |
|---|---|---|---|
| 1 | 헤더·푸터 `text-fg-dim` | **`text-fg-muted`** | `bg-panel` 위 `fg-dim` 사전 계산: darcula **2.90**, nord 3.80, solarized-light 3.64(§7.3) — 10px 텍스트에 AA 미달. `fg-muted`는 5.28 / 7.45 / 4.39. `styles.css` 주석의 AA 수치(`:104` nord 4.7, `:79` dracula 4.8, `:130` light 4.7, `:157` solarized 4.1)는 **`bg-base` 기준**이다(같은 식으로 재계산: 4.72 / 4.80 / 4.67 / 4.13; monokai `:53` 4.9만 panel 기준 4.93) — 카드 바탕 `bg-panel`에는 해당하지 않는다. 실기 computed color로 재확인(§7.3) |
| 2 | `pre max-h-[60vh] overflow-hidden` + 50% 뒤집기 | 카드 `maxHeight = 앵커 쪽 여유 − 8`, `flex-col`, `pre min-h-0 flex-1` | 30줄 카드(≈676px)가 720px 창에서 넘친다(§3.3). 헤더·푸터는 항상 보이게 |
| 3 | (없음) | 리스트 컨테이너 `onScroll` → 숨김 | 캡처한 `rect`로 그리는 fixed 카드는 리스트가 스크롤되면 항목과 어긋난다. 숨기고 다음 enter에서 새 rect |
| 4 | `useOccludesWebview(!!hover)` | `useOccludesWebview(!!entry)` | 항목 소멸 뒤 카드 없이 webview만 숨는 구간 제거(§3.5) |
| 5 | (없음) | `role="tooltip"` | e2e 셀렉터 + 시맨틱. 동작 영향 없음 |
| 6 | 변경 지점에 없음 | `main.tsx` `__gpv.promptHistory` 노출(DEV 전용 1줄) | e2e가 기록을 만들고 컬럼을 열려면 스토어 접근이 필요하다. `videoSplit`(태스크 22)과 같은 관례(`main.tsx:53`) |

### 3.8 만들지 않는 것

- Escape 닫기(§2 — PTY footgun), 카드 스크롤(§3.1 B), 카드 고정(pin)·클릭.
- 공용 `Tooltip` 컴포넌트, 포털(`createPortal`) — fixed가 패널 트리 안에서 이미 뷰포트로 빠져나온다(`ThemeButton` 선례).
- 절대시각 유틸(`format.ts`) 신설 — 인라인 `toLocaleTimeString()` 1곳.
- 카드 폭·줄 상한 설정값 — 상수(`240/480/30`, 상위 §6 ③).
- 항목 사이 이동 시 카드 위치 애니메이션.

## 4. 계약(타입·상태·코드 스케치)

Tauri 커맨드/이벤트/Rust 변경 **없음**. 스토어 변경 없음(`PromptEntry` 타입만 import).

```tsx
// src/components/workspace/TermSessionControls.tsx
import { usePromptHistory, type PromptEntry } from "../../stores/promptHistory"; // :14 확장

/** 카드 본문 줄 상한 — 더 긴 전문은 클릭 복사로(상위 설계 §6 ③). */
const CARD_MAX_LINES = 30;

type Hover = { id: string; rect: DOMRect };

export function PromptSidePanel({ termId }: { termId: string }) {
  // …기존 :210-222 그대로 (entries·clear·togglePanel·pushToast·list·copy)

  // 호버 카드 — 리스트 단위 상태. 카드는 pointer-events-none이라 "항목→카드" 이동이 존재하지 않고,
  // 상태 전이는 항목 enter / 컨테이너 leave·scroll / 언마운트 넷뿐이다(태스크 26 §3.4).
  const [hover, setHover] = useState<Hover | null>(null);
  const hoverRef = useRef<Hover | null>(null);
  const showTimer = useRef<number | undefined>(undefined);
  const show = (h: Hover | null) => {
    hoverRef.current = h; // 렌더 중 ref 쓰기를 피해 setter 안에서 미러
    setHover(h);
  };
  const cancelTimer = () => window.clearTimeout(showTimer.current);
  const hide = () => {
    cancelTimer();
    show(null);
  };
  const onItemEnter = (id: string, el: HTMLElement) => {
    const rect = el.getBoundingClientRect(); // 동기 캡처 — 타이머 콜백 시점엔 currentTarget이 null
    cancelTimer();
    if (hoverRef.current) show({ id, rect }); // 이미 떠 있으면 즉시 전환
    else showTimer.current = window.setTimeout(() => show({ id, rect }), 150); // 최초 1회만 지연
  };
  // 컬럼은 다른 창의 storage 이벤트(clear)로 hover 중에도 사라질 수 있다 — 대기 타이머 정리.
  useEffect(() => cancelTimer, []);
  // 기록 지우기·트림·다른 창 교체로 항목이 사라지면 카드도 사라진다(list는 최신 스냅샷).
  const entry = hover ? list.find((e) => e.id === hover.id) : undefined;
  // 카드가 이웃 pane(브라우저 셀일 수 있음) 위로 나간다 — 떠 있는 동안만 네이티브 webview를 숨긴다.
  useOccludesWebview(!!entry);

  return (
    <div className="flex w-[15%] min-w-[110px] shrink-0 flex-col border-l border-edge bg-panel text-[11px]">
      {/* 헤더 :225-244 무변경 */}
      <div className="min-h-0 flex-1 overflow-y-auto" onMouseLeave={hide} onScroll={hide}>
        {list.slice().reverse().map((e) => (
          <button
            key={e.id}
            onClick={() => copy(e.text)}
            onMouseEnter={(ev) => onItemEnter(e.id, ev.currentTarget)}
            // title 제거 — 카드와 native 툴팁 이중 표시 방지
            className="block w-full border-b border-edge/40 px-2 py-1 text-left last:border-b-0 hover:bg-raised"
          >
            {/* :257-260 무변경 */}
          </button>
        ))}
        {/* 빈 상태 :263-267 무변경 */}
      </div>
      {entry && hover && <PromptHoverCard entry={entry} rect={hover.rect} />}
    </div>
  );
}

/**
 * 항목 왼쪽에 뜨는 비상호작용 카드(DragGhost와 같은 계열). fixed라 overflow-hidden 셀을 빠져나오고,
 * pointer-events-none이라 항목을 덮어도 hover가 끊기지 않는다. 스크롤·Escape 없음 — 전문은 클릭 복사.
 */
function PromptHoverCard({ entry, rect }: { entry: PromptEntry; rect: DOMRect }) {
  const lines = entry.text.split("\n");
  const W = Math.max(240, Math.min(480, rect.left - 16));
  const left = Math.max(8, rect.left - 8 - W);
  const below = rect.top < window.innerHeight / 2; // ChangesPanel의 세로 뒤집기 규칙
  const space = (below ? window.innerHeight - rect.top : rect.bottom) - 8; // 앵커 쪽 여유 — 30줄 카드(≈676px)는 60vh로도 넘친다
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 flex flex-col overflow-hidden rounded-md border border-edge bg-panel shadow-xl"
      style={{
        left,
        width: W,
        maxHeight: Math.max(120, space),
        ...(below ? { top: rect.top } : { bottom: window.innerHeight - rect.bottom }),
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-2.5 py-1 text-[10px] text-fg-muted">
        <History size={11} className="shrink-0 text-accent" />
        <span>{new Date(entry.at).toLocaleTimeString()}</span>
        <span>· {lines.length}줄 · {entry.text.length}자</span>
      </div>
      <pre className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[12px] leading-5 text-fg">
        {lines.slice(0, CARD_MAX_LINES).join("\n")}
      </pre>
      {lines.length > CARD_MAX_LINES && (
        <div className="shrink-0 border-t border-edge px-2.5 py-1 text-[10px] text-fg-muted">
          … 외 {lines.length - CARD_MAX_LINES}줄
        </div>
      )}
      <div className="shrink-0 px-2.5 pb-1.5 text-[10px] text-fg-muted">클릭하면 복사</div>
    </div>
  );
}
```

```ts
// src/main.tsx:49-56 — DEV 전용 e2e 훅에 스토어 1개 추가(videoSplit과 같은 관례, release 미포함)
import { usePromptHistory } from "./stores/promptHistory";
…
if (import.meta.env.DEV) {
  (window as unknown as { __gpv?: unknown }).__gpv = {
    ui: useUi,
    terminals: useTerminals,
    videoSplit: useVideoSplit,
    planSegments,
    promptHistory: usePromptHistory, // 태스크 26 e2e — 기록 생성·컬럼 열기·교체 시뮬레이션
  };
}
```

계약 메모:
- 항목·헤더 마크업(`:225-244`, `:257-260`, `:263-267`)과 복사 동작은 무변경. 바뀌는 항목 속성은 `title` 삭제 + `onMouseEnter` 추가 둘.
- `hover.rect`는 `DOMRect` 스냅샷(정적)이며 `left/top/bottom`만 쓴다.
- `onScroll`은 React 17+에서 버블하지 않는다 — 스크롤 컨테이너(`:245`)에 직접 단다.

## 5. 단계(구현 순서)

**선행/후행 문서**: 태스크 **25**(A3 — 같은 파일 `TermSessionControls.tsx`의 `PromptHistoryButton` title 문구
`:186-187`·주석 `:164`) → **26**(이 문서, `PromptSidePanel` `:209-271`). 25의 변경은 **줄 수가 같은 치환**이라 이 문서의
앵커는 밀리지 않는다; 함수가 달라 충돌도 없지만 같은 파일이라 순차 납품. 태스크 23(A1)이 `TerminalPane.tsx:99-118`
클러스터(주석 2줄 포함)와 `:52-53`을 지워도 `PromptSidePanel` 마운트(`:121` — 23 적용 후 `:99`)는 그대로라 독립.
e2e는 23(`#2a`)·24(`#2c`) 뒤에 `#2d`로 들어가며 23이 잡은 함수 스코프 `paneId`를 공유한다(§7.1). 후행 없음.

1. **`TermSessionControls.tsx`** — `PromptEntry` type import, `CARD_MAX_LINES`, `Hover`, 상태·타이머·핸들러
   (§4), 항목 `title` 제거 + `onMouseEnter`, 리스트 컨테이너 `onMouseLeave`/`onScroll`, `PromptHoverCard`.
   `npx tsc --noEmit -p .` exit 0.
2. **`main.tsx`** — `__gpv.promptHistory`(DEV 가드 안, `:49-56`). `main.tsx`는 다른 세션의 미커밋 변경(+3)을 담은
   워킹트리 기준이다(`:49-56`은 그 상태에서 실측) — HEAD 체크아웃 금지(27의 `ui.ts` 규칙과 같다). 23·24는 이 노출 없이
   localStorage·DOM으로 관측한다(그쪽 §3.4) — 26 이후엔 그 스니펫도 이 훅으로 볼 수 있다.
3. **e2e 14** — `#2d` 블록(§7.1) + `finally` 정리. `openTerminal` 반환에서 `paneId`를 받는 `:46`/`:133-135` 수정은
   23(`#2a`)이 먼저 넣는다 — 이미 있으면 재선언하지 않는다.
4. **실기**(§7.2·§7.3) — 별도 창 첫 열·플로팅 분할·다크/라이트. 정적 통과만으로 끝내지 않는다.
5. 실기에서 `fg-muted` 대비가 목표에 못 미치는 테마가 있으면 그 토큰만 교체하고 §7.3 표에 실측값 기록.

규모: **S~M** — `TermSessionControls.tsx` +≈80/−2 · `main.tsx` +2 · e2e 14 +≈80/−2.

## 6. 위험과 완화

| # | 위험 | 내용 | 완화 |
|---|---|---|---|
| ① | 카드가 항목을 덮어 깜빡임 | 좁은 셀·하한 240 발동 시 카드가 항목 위로 겹친다(§3.2 극단 행) | `pointer-events-none` — 카드는 hit-test에서 빠져 항목 `mouseleave`가 발생하지 않는다. e2e가 `getComputedStyle(card).pointerEvents === "none"`을 단언 |
| ② | 언마운트 뒤 타이머 발화 | 다른 창의 `clear`가 `openPanels`까지 지워(`promptHistory.ts:202-203`) hover 중 컬럼이 사라질 수 있다 | `useEffect(() => cancelTimer, [])`. 실기: 별도 창에서 지우기 → 메인 콘솔 경고 0 |
| ③ | 스테일 항목 참조 | `storage` 교체는 `byTerminal`을 통째로 바꾼다(`:217`) — `hover.id`가 더는 없을 수 있다 | 렌더마다 `list.find` 가드. 상태를 지우지 않아도 카드는 안 그려지고 점유도 풀린다(`!!entry`) |
| ④ | 옆 브라우저 셀 깜빡임 | 항목마다 점유를 얻고 놓으면 webview가 숨김/복원을 반복 | 리스트 단위 hover 상태 하나 — 항목 사이 이동은 `hover` 값 교체일 뿐 `!!entry`는 계속 true |
| ⑤ | Escape가 PTY로 들어감 | 카드를 Esc로 닫는 기대를 가진 사용자가 Esc를 누르면 TUI 턴이 끊긴다 | 핸들러를 달지 않는다 — 카드는 마우스를 떼면 사라지므로 Esc 습관이 형성될 여지가 적다. 문서·주석에 명시 |
| ⑥ | 기록이 추가되며 목록이 밀림 | 최신이 위라 새 기록이 들어오면 hover 중 항목이 한 행 내려간다 — 카드는 옛 rect | 내용은 id 기준이라 틀리지 않는다. 포인터가 움직이면 새 항목 enter가 즉시 갱신. 곁눈질 패널에서 수용 |
| ⑦ | 긴 한 줄이 잘려도 표시가 없음 | 4000자 한 줄은 480px에서 ≈60 시각 줄 → `maxHeight`로 클립, "외 N줄" 푸터는 개행 기준이라 안 뜬다 | 헤더 "M자" + "클릭하면 복사"가 남는다. 글자 수 상한은 §8 ② |
| ⑧ | e2e가 hover를 못 일으킴 | React는 `mouseenter`가 아닌 `mouseover/mouseout`에서 합성(§2) | 스니펫이 `mouseover`(relatedTarget 없음)·`mouseout`(relatedTarget=body)을 쓴다 |
| ⑨ | 메타 텍스트 저대비 | `fg-dim`이 panel 위에서 darcula 2.90(§7.3) | `fg-muted` 채택(차이 표 #1). solarized-light 4.39는 §8 ① |
| ⑩ | 세로 넘침 | 30줄 카드가 720px 창에서 60vh를 넘는다(§3.3) | 카드 `maxHeight = 앵커 쪽 여유 − 8` + `flex-col`. e2e가 `card.top >= 0 && card.bottom <= innerHeight` 단언 |

## 7. 검증

### 7.1 e2e 14 추가 단언

`tests/e2e/suites/14-frontend-dom.mjs` — 24의 `#2c`(PaneMenu 프롬프트 토글) **뒤**, 우클릭→'4분할'(`:222`) **앞**에
`#2d`로 넣는다(pane이 아직 하나다. `#2`와 `#2b` 사이는 23의 `#2a`가 쓰고, 문자 순서상 `#2b` 앞에 끼울 이름이 없다).
`paneId`는 23(`#2a`)이 `:46`에 `let paneId = null;`을 두고 `:133-135`에서 `openTerminal` 반환값으로 채운 **함수 스코프
변수**다 — 아래는 그 변경의 모양(23이 이미 넣었으면 건드리지 않는다. try 스코프에 `const paneId`를 다시 선언하면 앞 블록이
TDZ ReferenceError):

```js
const opened = await cdp.eval(
  `window.__gpv.terminals.getState().openTerminal(${J(fix.projectId)})`,
);
tabId = opened.tabId;
paneId = opened.paneId;
```

```js
// ── #2d 프롬프트 컬럼 호버 카드 (태스크 26) — #2c 뒤·4분할 전, pane이 하나일 때 ──
// React의 onMouseEnter/Leave는 네이티브 mouseenter가 아니라 **mouseover/mouseout**에서 합성된다
// (react-dom 19.2.7 react-dom-client.development.js:19457-19597). relatedTarget이 React 노드면 그쪽
// mouseout이 처리한다고 보고 건너뛰므로(:19463-19471) 진입은 relatedTarget 없이, 이탈은
// relatedTarget=document.body(React 밖)로 보낸다. 정규식·역슬래시는 쓰지 않는다(#2b 주석의 함정).
if (!(await cdp.eval(`!!window.__gpv.promptHistory`))) {
  r.skip("프롬프트 호버 카드", "__gpv.promptHistory 미노출 — 구 빌드");
} else {
  const ph = `window.__gpv.promptHistory.getState()`;
  const ITEM = (prefix) =>
    `Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').startsWith(${J(prefix)}))`;
  const card = () =>
    cdp.eval(`(()=>{
      const c = document.querySelector('[role="tooltip"]');
      if (!c) return null;
      const cs = getComputedStyle(c), r = c.getBoundingClientRect();
      const pre = c.querySelector('pre'), ps = pre ? getComputedStyle(pre) : null;
      return { text: c.textContent, pe: cs.pointerEvents, pos: cs.position,
               left: r.left, width: r.width, top: r.top, bottom: r.bottom, ih: window.innerHeight,
               mono: ps ? ps.fontFamily : '', ws: ps ? ps.whiteSpace : '', lh: ps ? ps.lineHeight : '' };
    })()`);
  const enter = (prefix) =>
    cdp.eval(`(()=>{
      const b = ${ITEM(prefix)};
      if (!b) return { ok: false };
      b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return { ok: true, cardNow: !!document.querySelector('[role="tooltip"]') };
    })()`);
  const leave = (prefix) =>
    cdp.eval(`(()=>{
      const b = ${ITEM(prefix)};
      if (b) b.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
      return !!b;
    })()`);
  const long40 = Array.from({ length: 40 }, (_, i) => `L${i}`).join("\n");

  await cdp.eval(`${ph}.clear(${J(paneId)})`);
  await cdp.eval(
    `${ph}.record(${J(paneId)}, ${J(["e2e-hover-A 첫 프롬프트", "e2e-hover-B 둘째 프롬프트", long40])})`,
  );
  await cdp.eval(`if (!${ph}.openPanels[${J(paneId)}]) ${ph}.togglePanel(${J(paneId)})`);
  const listed = await poll(
    () =>
      cdp.eval(
        `['e2e-hover-A', 'e2e-hover-B', 'L0'].every(p => Array.from(document.querySelectorAll('button')).some(b => (b.textContent||'').startsWith(p)))`,
      ),
    (v) => v === true,
    12,
    250,
  );
  r.check("프롬프트 컬럼 열림 + 항목 3개 렌더", listed === true);
  r.check(
    "항목에 native title 없음(이중 표시 방지)",
    await cdp.eval(`(() => { const b = ${ITEM("e2e-hover-A")}; return !!b && !b.hasAttribute('title'); })()`),
  );

  // 최초 표시: 150ms 지연
  const e1 = await enter("e2e-hover-A");
  r.check("mouseover 동기 시점에는 카드 없음(150ms 지연)", e1.ok && e1.cardNow === false, JSON.stringify(e1));
  const cA = await poll(card, (c) => !!c && c.text.includes("e2e-hover-A"), 8, 50);
  r.check(
    "150ms 후 카드: 전문 + 헤더(줄·자) + 힌트",
    !!cA && cA.text.includes("e2e-hover-A 첫 프롬프트") && cA.text.includes("1줄") && cA.text.includes("클릭하면 복사"),
    cA ? cA.text.slice(0, 80) : "카드 없음",
  );
  r.check(
    "카드 비상호작용·fixed·monospace pre-wrap",
    !!cA && cA.pe === "none" && cA.pos === "fixed" && cA.mono.includes("monospace") && cA.ws === "pre-wrap" && cA.lh === "20px",
    cA && `pe=${cA.pe} pos=${cA.pos} ws=${cA.ws} lh=${cA.lh}`,
  );
  // 기하: 항목 rect로 W·left를 재계산해 카드와 비교(§3.2·§3.3)
  const ir = await cdp.eval(
    `(() => { const r = ${ITEM("e2e-hover-A")}.getBoundingClientRect(); return { left: r.left, top: r.top, bottom: r.bottom }; })()`,
  );
  const ih = await cdp.eval(`window.innerHeight`);
  const wantW = Math.max(240, Math.min(480, ir.left - 16));
  const wantL = Math.max(8, ir.left - 8 - wantW);
  const below = ir.top < ih / 2;
  r.check(
    "카드 폭·left = max(240,min(480,left−16)) / max(8,left−8−W)",
    !!cA && Math.abs(cA.width - wantW) <= 1 && Math.abs(cA.left - wantL) <= 1,
    `w=${cA?.width}/${wantW} l=${cA?.left}/${wantL} itemLeft=${ir.left}`,
  );
  r.check(
    "세로 앵커(50% 규칙) + 화면 안",
    !!cA && (below ? Math.abs(cA.top - ir.top) <= 1 : Math.abs(cA.bottom - ir.bottom) <= 1) && cA.top >= 0 && cA.bottom <= cA.ih,
    `below=${below} top=${cA?.top} bottom=${cA?.bottom} ih=${cA?.ih}`,
  );

  // 항목 간 이동 — 지연 없이 바뀐다(60ms 안)
  await enter("e2e-hover-B");
  await sleep(60);
  const cB = await card();
  r.check("항목 간 이동: 즉시 전환", !!cB && cB.text.includes("e2e-hover-B") && !cB.text.includes("e2e-hover-A"));

  // 40줄 → 30줄 + "외 10줄"
  await enter("L0");
  await sleep(60);
  const cL = await card();
  r.check(
    "40줄 프롬프트: 헤더 40줄, 본문 30줄(L29까지), 푸터 '외 10줄'",
    !!cL && cL.text.includes("40줄") && cL.text.includes("외 10줄") && cL.text.includes("L29") && !cL.text.includes("L30"),
    cL ? cL.text.slice(0, 40) : "카드 없음",
  );

  // 리스트 이탈 → 즉시 숨김
  await leave("L0");
  r.check("리스트 이탈(mouseout→body): 카드 숨김", (await poll(card, (c) => c === null, 8, 50)) === null);

  // 다른 창의 기록 교체 시뮬레이션 — storage 리스너와 같은 setState 경로(promptHistory.ts:217)
  await enter("e2e-hover-A");
  await poll(card, (c) => !!c, 8, 50);
  await cdp.eval(`window.__gpv.promptHistory.setState({ byTerminal: { ...${ph}.byTerminal, [${J(paneId)}]: [] } })`);
  const wiped = await poll(card, (c) => c === null, 8, 50);
  const panelAlive = await cdp.eval(`document.body.innerText.includes('아직 입력한 프롬프트가 없습니다')`);
  r.check("hover 중 기록 교체 → 카드 소멸, 패널은 빈 상태로 정상", wiped === null && panelAlive === true);

  await cdp.eval(`${ph}.clear(${J(paneId)})`); // 기록(localStorage)·패널 열림 원복
}
```

`finally`(`:406-423`)에 정리 한 줄:
```js
if (paneId)
  await cdp.eval(`window.__gpv.promptHistory && window.__gpv.promptHistory.getState().clear(${J(paneId)})`).catch(() => {});
```

### 7.2 실기(dev 디버그 앱 `npm run dev:app`, CDP 29222)

정적 검증·e2e만으로 통과시키지 않는다. 관측은 DOM·computed style·카운터로 한다.

1. **깜빡임 카운터**(DevTools 콘솔, 창마다):
   ```js
   window.__gpvFlick = 0;
   new MutationObserver((ms) => { for (const m of ms) for (const n of m.removedNodes)
     if (n.nodeType === 1 && n.getAttribute('role') === 'tooltip') window.__gpvFlick++; })
     .observe(document.body, { childList: true, subtree: true });
   ```
   항목 위에 포인터를 **3초 정지** → `__gpvFlick === 0`. 항목 사이를 천천히 5회 이동 → 여전히 0(전환은 같은
   노드의 내용 교체라 제거가 아니다). 리스트를 벗어남 → 1.
2. **별도 창 1100px 2열**: 터미널 2개를 모아보기 별도 창으로. 첫 열 셀 헤더 `PromptLogButton`으로 컬럼 열기 →
   항목 hover → 카드가 창 왼쪽(`left ≈ 8`)에, 항목까지 ≈8px. 둘째 열에서 hover → 카드가 첫 열 xterm 위에 놓이고
   1에서 깜빡임 0. 셀 하나를 브라우저로 바꿔 두고(옆 셀) 카드가 그 위로 나갈 때 브라우저 셀이 숨김 안내로
   바뀌고, 항목 사이 이동 중 다시 나타나지 않는지(점유 유지) 확인.
3. **플로팅 900px 좌우 분할**: "새 창으로 분리" → 우클릭 분할 → 우 pane 컬럼 열기(태스크 23·25 이후 가능; 그
   전엔 플로팅 창에 열기 버튼이 닿지 않으므로(상위 §1.1) 메인 콘솔에서
   `__gpv.promptHistory.getState().togglePanel(paneId)` — 세션 단위 스토어라 플로팅 창이 storage 이벤트로
   따라온다 `promptHistory.ts:218-219`) → 카드가 좌 pane 위, 깜빡임 0.
4. **좁은 극단**: 메인 창 사이드바를 접고 3열 분할 → 첫 pane 컬럼 항목 `rect.left`가 300 미만인지 확인 → hover →
   카드가 항목 일부를 덮은 채 **정지**(깜빡임 0), 항목 텍스트 전문이 카드에 있음.
5. **소멸 경로**: 메인에서 hover 유지한 채 별도 창에서 그 터미널의 "기록 지우기" → 메인 카드 즉시 소멸 + 컬럼
   닫힘(`clear`는 `openPanels`도 지운다), 콘솔 경고·에러 0. 반대로 별도 창에서 새 프롬프트를 치면(기록 추가) 메인
   카드 내용이 바뀌지 않고 포인터를 움직이면 갱신.
6. **스크롤·Esc**: 항목 30개 이상 만들어 리스트에 스크롤바가 생기게 한 뒤 hover 중 휠 → 카드 숨김, 살짝 움직이면
   150ms 후 재표시. hover 중 Esc → 카드는 그대로(핸들러 없음). **TUI가 돌고 있는 터미널에서는 Esc를 누르지 않는다.**
7. **긴 한 줄**: 3000자 한 줄을 붙여 넣고 hover → 카드 하단이 `innerHeight` 안, 헤더 "1줄 · 3000자"(4000자를
   넘겨 붙이면 트림 `…`로 "4001자", `promptHistory.ts:153`) + "클릭하면 복사"가 보이고 본문만 잘림.

### 7.3 다크·라이트 대비

`bg-panel`은 불투명이라 카드 텍스트 대비 = 토큰 쌍 대비다. `styles.css` hex로 **사전 계산**(2026-09-02, WCAG 2.x
상대 휘도식; 스크립트는 세션 스크래치, 사실검증에서 독립 재계산해 전 칸 일치 — 실기에서 computed color로 재확인한다):

| 테마 | `bg-panel` | `fg`(본문) | `fg-muted`(헤더·푸터, 채택) | `fg-dim`(상위 설계) |
|---|---|---|---|---|
| darcula | `#2b2d30` | 10.55 | 5.28 | **2.90** |
| monokai | `#0c121b` | 15.93 | 7.82 | 4.93 |
| dracula | `#21222c` | 14.81 | 8.67 | 5.32 |
| nord | `#3b4252` | 8.73 | 7.45 | **3.80** |
| light | `#ffffff` | 15.53 | 7.12 | 4.97 |
| solarized-light | `#eee8d5` | 10.61 | **4.39** | **3.64** |

목표: 본문 ≥ 4.5(전부 충족), 헤더·푸터 ≥ 4.5(solarized-light만 4.39 — §8 ①; 그 테마의 컬럼 헤더 `fg-dim`
3.64보다는 높다).

**실기 절차**(다크 1 = darcula, 라이트 1 = light 최소; 가능하면 6종): 설정 › 테마로 전환 → 항목 hover → 콘솔:
```js
(() => { const c = document.querySelector('[role="tooltip"]');
  const bg = getComputedStyle(c).backgroundColor, body = getComputedStyle(c.querySelector('pre')).color,
        meta = getComputedStyle(c.firstElementChild).color;
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = (s) => { const [r, g, b] = s.match(/\d+/g).map(Number); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
  const cr = (a, b) => { const x = L(a), y = L(b); return ((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2); };
  return { bg, body: cr(body, bg), meta: cr(meta, bg) }; })()
```
표의 값과 ±0.05 안이면 통과. 미달 테마가 있으면 그 표면의 토큰만 바꾸고(색상 hue가 아니라 토큰 선택) 표를
실측값으로 갱신한다. 시각 확인: 라이트에서 카드 테두리(`border-edge #d3d5db`)가 흰 패널 위 xterm(어두운
배경일 수 있음) 경계에서 보이는지, 다크에서 `shadow-xl`이 xterm 위에서 카드를 띄워 주는지.

## 8. 오픈 이슈(사용자 결정 — 없으면 기본값)

| # | 질문 | 기본값 |
|---|---|---|
| ① | 헤더·푸터를 `fg-muted`로(상위 설계 `fg-dim`과 다름) — solarized-light 4.39:1 수용? | **수용**. 저대비 테마 특성(`styles.css:142-144`)이고 기존 컬럼 헤더 `fg-dim`(3.64)보다 높다 |
| ② | 매우 긴 한 줄이 시각적으로 잘릴 때 표시 없음 — 글자 수 상한(예 2000자 + "… 외 N자") 추가? | **안 함**. 헤더 "M자" + 클릭 복사로 충분. 불편하면 상수 1개 추가 |
| ③ | 최초 지연 150ms · 줄 상한 30 · 폭 240~480(상위 §6 ③) | 그대로 |
| ④ | 기록 추가로 항목이 밀릴 때 카드 위치 즉시 갱신(길이 변화 effect) vs 다음 포인터 이동 | **다음 이동**. effect 추가는 상태 전이를 하나 늘린다 |
| ⑤ | `__gpv.promptHistory` DEV 노출(main.tsx 1줄) | **노출**. `videoSplit`과 같은 관례, release 빌드 미포함 |

## 9. 구현 결과(구현 2026-09-02 · 실행·관측 2026-09-03)

§5 단계 1~5 완료(§4 계약 그대로). Rust 변경 0. `npx tsc --noEmit -p .` **exit 0**(재실행 2026-09-03).
e2e 14 스위트 **57 pass / 0 fail / 1 skip**(스킵은 24의 "숨김 셀 칩 메뉴" — 탭 모으기 모드라 개별 칩 없음),
그중 **#2d 11단언 전부 pass**. §7.2 실기 1~6과 §7.3 대비를 dev 디버그 앱(CDP 29222)에서 관측했다(§9.3).
남은 것은 §7.2 7(긴 한 줄)과 hover 중 Escape 둘뿐이다(§9.4).

| 파일 | LOC | 내용 |
|---|---|---|
| `src/components/workspace/TermSessionControls.tsx` | +≈89/−2 | `PromptEntry` type import · `PromptSidePanel`에 hover 상태·`hoverRef`·`showTimer`·`show/cancelTimer/hide/onItemEnter`·언마운트 정리·`entry` 렌더 가드·`useOccludesWebview(!!entry)` · 리스트 컨테이너 `onMouseLeave`/`onScroll` · 항목 `title` 삭제 + `onMouseEnter` · `PromptHoverCard`(+`CARD_MAX_LINES`·`Hover`) |
| `src/main.tsx` | +2 | DEV 훅 `__gpv.promptHistory` + import 1줄 |
| `tests/e2e/suites/14-frontend-dom.mjs` | +≈124 | `#2d` 블록(#2c 뒤·4분할 앞) **11단언** + `finally`의 `promptHistory.clear` 정리 |

### 9.1 설계 대비 이탈

| # | 이탈 | 이유 |
|---|---|---|
| 1 | `CARD_MAX_LINES`·`type Hover`를 파일 상단(§4 스케치)이 아니라 `PromptHoverCard` 바로 위에 둠 | 유일한 소비자와 콜로케이트. 함수 선언·타입 별칭은 호이스팅돼 동작 동일(tsc exit 0) |
| 2 | e2e에서 `const ih` 대신 `const ihCard` | 같은 try 스코프의 `#4` Log 리사이즈 블록이 이미 `const ih`를 쓴다 — 재선언은 SyntaxError |
| 3 | §9 표의 "10단언"을 **11단언**으로 정정 | `#2d`의 `r.check`는 실제 11개다(§7.1 스니펫도 11개 — 최초 기록이 세었을 때 틀렸다) |
| 4 | §7.2 3(플로팅 900px 좌우 분할)·4(사이드바 접힘 3열)를 **모아보기 별도 창 하나로** 대체 | 두 시나리오의 검증 대상은 "항목 `rect.left`가 작을 때의 W 하한·겹침"이다. 별도 창 1100px에서 자동배치 grid(3열)는 `rect.left=254.7`, columns(4열)는 **163.5**를 만들어 **하한 240 발동과 84.5px 겹침을 둘 다** 얻었다 — 플로팅 창 분할(설계 추정 340)보다 극단이라 상위 집합이다. 사용자의 워크스페이스 레이아웃·플로팅 창을 건드리지 않는 쪽을 골랐다 |

### 9.2 §7.3 대비 — 실기 computed color

카드를 띄운 상태에서 `data-theme`만 바꿔 가며 `getComputedStyle`로 잰 값(모아보기 별도 창, 2026-09-03).
설계 표(§7.3, 토큰 hex 사전 계산)와 **전 칸 일치**:

| 테마 | `bg-panel`(computed) | `fg`(본문) | `fg-muted`(헤더·푸터) | 본문/메타 색 |
|---|---|---|---|---|
| darcula | `rgb(43, 45, 48)` | 10.55 | 5.28 | `rgb(223,225,229)` / `rgb(157,160,168)` |
| monokai | `rgb(12, 18, 27)` | 15.93 | 7.82 | `rgb(230,237,246)` / `rgb(152,169,189)` |
| dracula | `rgb(33, 34, 44)` | 14.81 | 8.67 | `rgb(248,248,242)` / `rgb(184,191,221)` |
| nord | `rgb(59, 66, 82)` | 8.73 | 7.45 | `rgb(236,239,244)` / `rgb(216,222,233)` |
| light | `rgb(255,255,255)` | 15.53 | 7.12 | `rgb(34,36,41)` / `rgb(85,88,95)` |
| solarized-light | `rgb(238,232,213)` | 10.61 | 4.39 | `rgb(7,54,66)` / `rgb(88,110,117)` |

본문은 6종 전부 ≥ 4.5, 헤더·푸터는 solarized-light 4.39(§8 ① 수용) 외 전부 ≥ 4.5 — `fg-muted` 채택 유지,
토큰 교체 불필요(§5 단계 5 해당 없음). 테두리는 라이트에서 `rgb(211,213,219)`, 다크(monokai) `rgb(27,39,56)`로
`bg-panel`과 구분되고, `shadow-xl`은 `rgba(0,0,0,0.1) 0 20px 25px -5px, rgba(0,0,0,0.1) 0 8px 10px -6px`로 살아 있다.

### 9.3 §7.1·§7.2 실행·관측 결과(2026-09-03, dev 디버그 앱 CDP 29222)

**e2e 14** — 스크래치 단독 러너로 실행: `ALL GREEN 57 pass / 0 fail / 1 skip`. `#2d` 11단언 전부 pass
(메인 창 2560×1392라 항목 `left=2289.3` → `W=480 / left=1801.3` 기대치와 정확히 일치, 세로 `below=true`).

**실기 무대** — 모아보기 별도 창(`1100×720`, 셀 9개). 자동배치 `grid`는 3열(셀 359px), `columns`는 4열(셀 271px)이라
프롬프트 컬럼(110px) 항목의 `rect.left`가 각각 **254.7 / 163.5** — 둘 다 §7.2의 "좁은 셀(< 500)"이고,
후자는 §3.2 표의 **극단 행**(W 하한 240 발동 + 카드가 항목을 덮음)이다.

| # | 항목(§7.2) | 관측값 |
|---|---|---|
| 1 | 깜빡임 카운터(카드 노드 add/remove + 항목 mouseover/mouseout) | 카드가 항목을 **84.5px 덮은 상태**에서 3초 정지 → remove **0** · add 0 · 항목 mouseover **1회 그대로** · mouseout **0회**. 항목 사이 5회 이동 → 카드 노드 add/remove **0**(같은 노드 내용 교체), mouseover 6. 리스트 이탈에서만 remove 1 |
| 2 | 별도 창 2열(카드가 이웃 셀 xterm 위로) | 둘째 열 항목 `left=619.3` → 카드 `W=480 left=131.3` = 기대치 정확히 일치, 카드가 첫 열 셀 위로 나간다. 셋째 열 `left=983.3`도 동일 규칙 |
| 3·4 | 좁은 극단(하한 240 발동·겹침) | grid 첫 열 `left=254.7` → `W=240`(하한) `left=8`, 항목까지 6.7px. columns 첫 열 `left=163.5` → `W=240 left=8`, 카드 오른쪽 끝 248이 항목을 **84.5px 덮는다** — 그 상태에서 위 1의 깜빡임 0. computed `pointer-events: none` · `position: fixed` · `z-index: 50` |
| — | 지연·전환 | 최초 표시: 항목 `mouseover` 시각 기준 카드 노드 삽입까지 **154.5ms / 156.2ms / 168.4ms**(세 셀), 포인터 도착 0ms·70ms 시점 카드 없음. 이미 떠 있는 뒤 항목 이동은 120ms 안에 이미 내용 교체 완료(노드 교체 없음) |
| — | 헤더·본문·푸터 | 1줄 항목 헤더 `오전 2:41:10· 1줄 · 7자`. 40줄 프롬프트 → 헤더 `· 40줄 · 349자`, 본문 **30줄**(`L0`…`L29`, `L30` 없음), 푸터 `… 외 10줄`, 마지막 줄 `클릭하면 복사`. `\t` 들여쓰기 보존(`white-space: pre-wrap`, `line-height: 20px`). 카드 `top=206.7 bottom=712`(ih 720) — `maxHeight`가 화면 안으로 잡았다 |
| 5 | 소멸 경로(다른 창의 지우기) | 모아보기 창에 카드를 띄운 채 **메인 창**에서 `promptHistory.clear(paneId)` → 카드 remove 1, 컬럼 자체가 언마운트(`openPanels` 비고 리스트 DOM 없음), **두 창 모두 `console.error`/`warn`·`onerror`·`unhandledrejection` 0건** |
| 6 | 스크롤·Esc | 항목 23개로 스크롤바가 생긴 리스트에서 hover 중 휠 → `scrollTop 0→120`, 카드 즉시 사라짐. Esc는 **누르지 않았다**(핸들러가 없다는 것은 코드·§3.8 근거 — TUI 진행 중 터미널이 붙어 있어 실기에서 시도하지 않는다) |
| — | 점유(§3.5·위험 ④) | 같은 창에 **네이티브 브라우저 셀**을 두고(`https://example.com`, 셀 제목이 원격 페이지의 `Example Domain`으로 갱신돼 webview가 실제로 떴음을 확인, 10/10 선택) 측정: hover 전 `count=0 blocked=false` → 카드 표시 `count 0→1 blocked=true` → **항목 5회 이동 동안 occlusion 변화 이벤트 0건**, 매 시점 `blocked=true` → 리스트 이탈 `count 1→0 blocked=false`. `blocked`는 `BrowserPane`이 읽는 `useWebviewBlocked`의 세 항(`selectBlockingOverlay` · `useDb.dialog` · `useOcclusion.count`)을 실제 스토어에서 그대로 계산한 값이다 |
| 7 | 긴 한 줄 | 별도 확인 대신 40줄 카드의 `maxHeight` 클립으로 같은 경로를 봤다 — **미확인**(§9.4) |

**관측 함정 두 개**(다음 세션이 같은 데 빠지지 않게):

- `useOcclusion`·`useBrowsers`는 `__gpv`에 없다. vite dev에서 `import('/src/stores/occlusion.ts')`로 잡으면
  **앱과 다른 모듈 인스턴스**가 만들어져 `count`가 영원히 0으로 보인다(한 번 속았다). HMR 쿼리가 붙은 실제 URL을
  `performance.getEntriesByType('resource')`에서 찾아 `import('…/occlusion.ts?t=1788367390506')` 해야 같은
  인스턴스다(`useUi === __gpv.ui`로 검증). `promptHistory`는 `__gpv`에 있어 이 문제가 없다.
- `browser_set_visible` 호출을 세려고 `__TAURI_INTERNALS__.invoke`를 감싸면 **조용히 실패**한다 —
  그 속성은 `writable: false, configurable: false`다(대입이 sloppy mode에서 무시된다). 그래서 webview 숨김은
  invoke 로그가 아니라 위의 `blocked` 합성값으로 관측했다.

**정리** — 임시 기록·패널은 전부 `promptHistory.clear`로 되돌렸고(`gp:prompt-history`·`gp:prompt-panel-open` 모두 `{}`),
브라우저 탭 닫힘(`gp:browsers` null)·`activeTab` 원복·자동배치 `grid` 원복·테마 `monokai` 원복·모아보기 별도 창 닫음.
남은 CDP 페이지는 `main`과 세션 시작 전부터 있던 `float-pool-14`뿐이다.

### 9.4 남은 미검증

- §7.2 7 **긴 한 줄**(3000자 한 줄 → 헤더 "1줄 · 3000자" + 본문만 클립). 40줄 카드에서 `maxHeight` 클립 자체는
  확인했으나(카드 `bottom=712 ≤ ih 720`), 개행 없는 4000자 경로는 실기로 보지 않았다. 위험 ⑦의 "푸터가 안 뜬다"는
  설계상 자명하고(푸터 조건이 `lines.length > 30`) 정보 손실은 헤더 "M자"가 메운다.
- hover 중 **Escape**(§7.2 6 후반) — 핸들러가 없음은 코드로만 확인. TUI가 붙은 실사용 터미널이라 누르지 않았다.
- 카드 `role="tooltip"`의 스크린리더 실독(§3.6) — 보조기술 실기는 이 세션 범위 밖.
