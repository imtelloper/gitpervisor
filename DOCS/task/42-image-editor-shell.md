# 태스크 42 — 편집기 셸: UI 스토어·모드 상태 머신·키 스코프·단축키 표·타이틀바·툴 레일 23·상태바

> 상태: 설계(Design) · 대상: gitpervisor · 근거: 코드 실측 2026-09-04(워킹트리) · 선행: 태스크 37(커밋0 AnnotationLayer 4모듈 분할 — `annotation/keys.ts`·`pointer.ts`),
> 38(`resolveScene`·`hitTest`·`tree.ts`·`selectBox`), 41(`persist.state`·`DocHistory.entries/cursor`·`applyDoc(next, mode, label)`·닫기 확인창 삭제),
> `DOCS/image-annotation-design.md` §5.4(Esc 계층)·§5.6(키), `DOCS/pro-image-editor-design.md` §8 K4(호버 히트 기각 — 38 `buildObjectPath` WeakMap 이 해소) ·
> 시안: `designs/image-editor-figma-v2.pen` ①③⑦(워크스페이스 셸: Title Bar 48 · Tool Rail 56 · Left Panel 264 · Inspector 320 · Status Bar 30)⑧(단축키 글리프 표) ·
> 상위: `00-INDEX.md` §10 — **M2 두 번째 태스크(41 → 42 → 43 → 44).**

## 1. 요구사항

시안 ①③⑦ 공통 셸 — 타이틀바 `260903-NQVM-AIS · / · 장비별 현황판 대시보드.png · 편집됨 · 디자인 · 픽셀 미리보기 · 70% · 내보내기`(+undo/redo 아이콘),
툴 레일 23(`.pen` 노드명 실측: `Tool 선택 · 이동 · 프레임▾ · 펜▾ · 곡률 · 연필 · 지우개 · 사각형▾ · 타원 · 다각형 · 직선 · 화살표 · 텍스트 · 이미지 · 번호 뱃지 · 말풍선 · 모자이크▾ · 블러 · 스포이드 · 측정 · 크롭 · 슬라이스 · 손` + `Color Swatch(Stack Back/Front)`, 캐럿 4개 `.pen:540,596,742,1046`),
상태바 `X 1284  Y 742 · 스냅 · 스마트 가이드 · 픽셀 그리드 · 눈금자 · 가이드 표시 · 2개 선택 · 220 × 230 · #2B6CB0 · 실행 취소 12단계`,
모드 배너 ③ `벡터 편집 모드 · Esc 로 편집 종료`·⑦ `크롭 모드 · ⏎ 적용 · Esc 취소`, ③ 상태바 `노드 1개 선택 · 대칭 핸들`·⑦ `크롭 2400 × 1600 · 3:2`(모드별 요약 슬롯),
⑧ 글리프 표 `⌥A ⌥H ⌥D ⌥W ⌥V ⌥S · ⌃⌥H ⌃⌥V ⌃⌥⌘K · ⌥⌘U ⌥⌘S ⌥⌘I ⌥⌘X ⌘E ⇧⌘O · ⌘G ⇧⌘G ⌥⌘G ⌃⌘M ⌥⌘] ⌥⌘[ · 편집 완료 ⏎ · Esc 로 편집 종료 · ⏎ 적용 · Esc 취소 · ⇧클릭`, Space 손 도구(홀드).

받아들이는 조건:
- 레이아웃이 시안 치수대로 **창 전체**(메인 창·doc 창 모두): 타이틀바 48 / 레일 56 / 좌 패널 264 / 스테이지 / 인스펙터 320 / 상태바 30. 기존 카드형 모달(1180px)은 사라진다.
- 도구·모드·선택·호버·토글·탭이 **창별 스토어 하나**에 있고, 레이어 패널(44)·컨텍스트 바(45)·상태바가 같은 값을 본다. 문서 변경은 여전히 `applyDoc/patchDoc`만 지난다.
- 편집기가 열려 있는 동안 앱 전역 키 25곳이 편집기 키를 **가로채지 않고**, 편집기가 소비하지 않는 키(F5·Ctrl+P·mod+Shift+A·mod+Alt+N·mod+Shift+F)는 **여전히 통과**한다 — 앱 전역 리스너는 한 줄도 고치지 않는다.
- 단축키는 **표 하나**(Win/Mac 두 열). 한글 IME 상태(`key='ㅍ'`)와 Mac ⌥A(`key='å'`)에서도 글자 키가 잡힌다. 방향키 auto-repeat 무시(K5) 유지.
- 레일 23 도구 각각에 **동작과 소유 태스크**가 있다(§3.5) — 소유 태스크가 도착하기 전의 도구는 레일에 그려지지 않는다(INDEX §10.4 "없는 기능은 안 보인다").
- e2e 30/34/35: 헬퍼 6줄(§4) 외 무변경으로 기준선(91/32/13) pass.

## 2. 현황(근거)

- **UI 상태가 흩어져 있다**: `ImageEditor.tsx:207-219` 로컬 `useState` 9개(`cropMode·lockRatio·format·quality·busy·tool·style·opacity·recent·selectedIds`) + `:226 view`, `AnnotationLayer.tsx:187-189` 는 props 를 ref 로 미러. 레이어 패널·컨텍스트 바·상태바가 `selectedIds/hoverId/tool` 을 보려면 prop 4단이고, 호버(초당 60회)가 1,420줄 컴포넌트를 리렌더한다. `useUi`(`ui.ts:240`)는 앱 전역이라 `selectBlockingOverlay`(`:231-236`) 같은 무관 셀렉터가 매 변경마다 돈다. 창마다 스토어 인스턴스가 별개인 것은 이미 관례(`DocWindow.tsx:42-44`).
- **키 리스너는 둘 다 window 버블**: `ImageEditor.tsx:910-948`(Esc 계층·Ctrl+Z/Shift+Z/Y), `AnnotationLayer.tsx:639-720`(Ctrl+D·Delete·`[`·`]`·Arrow·`TOOL_KEYS :88-99`). `TOOL_KEYS` 는 `ev.key.toLowerCase()`(`:657`)라 한글 IME 에서 V 가 `'ㅍ'` 로 와 도구 전환이 죽는다. 37 커밋0이 이 effect 를 `annotation/keys.ts` 로 옮긴다(37 §3.5) — 이 태스크가 표로 흡수하고 그 파일을 지운다.
- **앱 전역 window keydown 리스너 25곳**(grep `addEventListener("keydown"`): 편집기 열림 여부를 아무도 모른다. 실재 충돌 — `KeyboardShortcuts.tsx:122-126` `k==="k"` 에서 `shiftKey→push`, **`altKey` 미검사** → 시안 ⑧ 간격 정리 `Ctrl+Alt+Shift+K` 가 `git push` 를 쏜다; `:110-120` Ctrl+W 가 편집기 뒤 뷰어 탭을 닫는다; `DiffViewer.tsx:272-283` mod+Shift+O(윤곽선화)가 `ed.focus()` 로 Monaco 포커스를 뺏는다; `terminal.ts:212-236` Ctrl+C 폴백이 터미널 선택이 있으면 그걸 복사하고 `preventDefault`. 통과해야 하는 키: `:55 F5`, `:63 mod+P`, `:70 mod+Alt+N`, `:77 mod+Shift+F`, `:87 Ctrl+Shift+D/E/W`, `GlobalShortcuts :18 mod+Shift+A`. 등록 순서상 App 마운트 리스너가 lazy 편집기 리스너보다 **먼저** 실행되므로 버블 단계에서는 막을 수 없다. `window.dispatchEvent`(e2e 30:397)로 오는 at-target 이벤트도 capture 리스너가 먼저다(DOM 규격: at-target 에서 capture 리스너 선실행 — Chromium 89+).
- **툴바·셀렉터 계약**: `AnnotationToolbar.tsx:29-45` 도구 10종, title `${label} (${key})`(`:122`). e2e 30 `activeTool`(`:436-450`)이 title 정규식 `\(([A-Z])\)$` + `byKey P→'pen'` 으로 읽고 `:1267-1275` 가 `setTool("pen")→'pen'` 을 단언. `A.modal`(30:34-36 · 34:49-51 · 35:31-34)은 `div.fixed.inset-0.z-50` + textContent `/이미지 편집/`(헤더 `:991`). `selCount`(30:460-470)는 `^\s*(\d+)개 선택` 을 담은 **가장 안쪽** 요소(현재 `:1139-1140`). `cropOn`(30:473) `/영역을 드래그/`·`click(/크롭 선택/)`(30:1291)은 `:1181` 버튼, `/오른쪽 90/`(30:825)은 `:1150`, `/실행 취소/`(30:1605)는 툴바 `:137` title, `(p-4)`(30:1630)는 모달 첫 `input`. `A.key`(30:396-403)는 **`code` 없이 `key` 만** 실어 보낸다.
- **줌**: `zoom.ts:31-37 zoomAt(v,cx,cy,factor)` 뿐 — 배율을 **지정**하는 함수가 없다. 헤더 `:1004-1019` 가 `%` 표시와 `맞춤`(=`IDENTITY_VIEW`)만. `screenScale = displayScale·view.scale`(`:397-400`) — 100% = `view.scale = 1/displayScale`.
- **루트·레이아웃**: `:978-988` `fixed inset-0 z-50` + 메인 창 카드 `h-[min(820px,94vh)] w-[min(1180px,96vw)]`, doc 창은 `top:32`(FloatTitleBar) 후 꽉 채움. 시안 고정 폭 합 56+264+320 = 640 → 카드 1180 이면 stage 540px. 우측 `aside w-72`(`:1121-1273`) 안에 툴바·회전/반전·크롭·크기·색 보정·포맷 섹션, 푸터 `:1277-1315`(초기화·복사·취소·다른 이름으로·저장). 메인 창 마운트는 e2e 전용이나 지워선 안 된다(`App.tsx:203-210`).
- **Esc 계층**: `ImageEditor.tsx:913-928` 1) prompt/confirm 통과 → 2~5) `handleEscape`(`AnnotationLayer:727-756`: 텍스트 확정·드래그 취소·select 복귀·선택 해제) → 6) cropMode 해제 → 7~8) `requestClose`. 41이 7~8의 확인창을 지운다(flush 뒤 즉시 닫힘).
- **상태바 데이터 원천**: 커서 oriented 좌표는 `AnnotationLayer toOriented`(`:339-350`), 호버 커서는 React state 없이 `canvas.style.cursor` 직접(`:500-526`, K4 근거). 39 이후 `[1]` 은 이미지+노드 **불투명 합성**이라 커서 색은 `[1]` 의 `getImageData(x,y,1,1)` 한 픽셀이다(스크래치 0).
- **팬**: 가운데 버튼만(`:424-446`) — 좌버튼은 주석 레이어가 전부 쓴다. 손 도구는 좌버튼 팬이 필요하다.
- 로컬 오버레이 관례: `useOccludesWebview`(`occlusion.ts:49`) + `fixed` 백드롭·좌표 클램프(`ViewerFileTabs.tsx:118-135`). z 계층: 편집기 z-50 < 토스트 z-[55](`Toast.tsx:11-16`) < 확인/프롬프트 z-[60](`ConfirmDialog.tsx:18`).

## 3. 설계

### 3.1 창별 UI 스토어 — `useImageEditorUi`

| 대안 | 평가 |
|---|---|
| **A. 새 zustand 스토어 `src/stores/imageEditor.ts`(창별 인스턴스). 문서·히스토리는 ImageEditor 로컬 + `applyDoc` 깔때기 그대로. AnnotationLayer 의 `tool/selectedIds` props 는 유지하고 ImageEditor 가 스토어→props 브릿지** (채택) | 44/45/43/47/48 이 `useImageEditorUi(s => s.selectedIds)` 로 직접 구독. 호버는 행 단위 셀렉터로 그 두 행만 리렌더. e2e 30 의 `setDoc` 훅(`:957`)·AnnotationLayer 계약 무변경 |
| B. `useUi` 슬라이스 | 앱 전역 스토어의 셀렉터가 편집기 호버마다 돈다(`:231-236`) |
| C. 로컬 useState 확장 | 소비자 4곳 prop 드릴링 + 호버가 1,420줄 리렌더 |
| D. 문서까지 스토어로 | `applyDoc/patchLive/histRef` 단일 깔때기(`:241-270`)와 pro 설계 §2.1 계약, 30 의 `setDoc` 훅을 다시 배선 |

`Tool` 은 **문서 타입이 아니라 화면 상태**다 — `types.ts:14-24` 에서 이 스토어로 옮긴다(37 §4 "types.ts 는 37 소유, 타 축은 import 만" 준수; 옮기지 않으면 42가 37 파일을 편집한다). `propTool`(`:621-624`, `AnnoKind ⊂ Tool` 전제)은 `'path'`(노드 kind)와 `'vpen'`(도구)이 갈리므로 폐기 — 속성 패널은 `paintOf(선택)`(37)를 쓴다. `toggles` 는 `localStorage 'gp:ie:toggles'`(`ui.ts:195-283` `gp:*` 관례, ≈200B — K6 무관). 편집기 마운트·`path` 변경 시 `reset()`.

### 3.2 모드 상태 머신 — 도구와 **직교**

`mode ∈ {design, nodeEdit(id), crop}`, `pixelPreview ∈ {0,1,2}` 는 직교(40 DetailCanvas 입력 — 켜져도 포인터·키는 그대로 `[1]` 이 받는다).

| 전이 | 트리거 | 규칙 |
|---|---|---|
| design → crop | `C` · 레일 크롭 · 조정 탭 `크롭 선택` | `prevTool = tool`, 도구 키 무시. 배너 `크롭 모드 · ⏎ 적용 · Esc 취소` |
| crop → design | `Enter`(적용 = 모드 종료, `doc.crop` 유지) · `Esc`(드래그 있으면 계층 3, 없으면 모드 종료) · 드래그 확정(`onCropUp :526-545` 현행) | 48 이 `CropSession`(비율·직선화·적용/취소)으로 확장 — 전이 자체는 불변 |
| design → nodeEdit | `Enter`(path 1개 선택) · 더블클릭(path) · 펜 완료 직후 | 진입 함수 `layerRef.enterNodeEdit(id)` 는 47 소유 — 47 전에는 트리거가 없다(상태·배너·Esc 만 여기) |
| nodeEdit → design | `Enter`(편집 완료) · `Esc`(노드 선택 있으면 해제 → 없으면 종료) · 문서 undo 로 id 소멸 · `setTool` 이 `select`/`vpen` 밖으로(47 §3.2) | 배너 `벡터 편집 모드 · Esc 로 편집 종료` |
| 일시 도구 | `Space` keydown → `setTool('hand',{temporary:true})`, keyup → `restoreTool()`; 스포이드(45) `I` 클릭 후 복귀 동일 | `prevTool` 슬롯 하나 |

| 대안 | 평가 |
|---|---|
| **A. `Mode` 를 도구와 별개 필드로** (채택) | `cropMode`(`:207`)가 tool 과 별개인 현행 전제 유지 — 크롭 중 도구 키를 눌러도 크롭이 조용히 취소되지 않는다. 48 §3 "`tool==='crop'` 대신 `mode.kind==='crop'`"과 일치 |
| B. `Tool` 에 `'crop'`·`'nodeEdit'` | Esc 계층이 이중이 되고 vector 축의 `tool==='crop'` 전환이 `:948` 키 핸들러·`:1105` prop 을 같이 바꾼다(심사 blocker) |

**Esc 계층(개정)**: 0) 팝오버·플라이아웃 닫기(45 Popover, 42 플라이아웃) → 1) `ui.prompt||ui.confirm` 이면 **통과**(그쪽 리스너가 처리) → 2~5) `handleEscape` → 6) `nodeEdit` 종료 · `crop` 종료(동급) → 7) `requestClose`(41: flush → close, 확인창 0).

### 3.3 키 스코프 — `window` **capture** 리스너 1개(`useEditorKeys`)

| 대안 | 평가 |
|---|---|
| **A. 편집기 마운트 중 `window.addEventListener('keydown', h, {capture:true})` 1개. 표에 매치되고 `consume` 이면 `preventDefault()+stopImmediatePropagation()` 후 액션 디스패치** (채택) | 25곳 무수정. capture 는 등록 순서와 무관하게 버블 리스너보다 먼저 실행(at-target 포함). 편집기가 안 다루는 키는 그대로 흘러 F5·Ctrl+P 가 산다 |
| B. 25곳에 `if (imageEditorPath) return` | 25파일 + doc 창은 그 리스너들이 없고 26번째를 잊는다 |
| C. 버블 리스너 + 순서 의존 | `KeyboardShortcuts` 가 먼저 등록돼 먼저 실행된다(§2) |

디스패치 전 게이트(순서): ① `ui.prompt||ui.confirm` → 전부 통과. ② 팝오버/플라이아웃 열림 → `Escape` 만(0단계). ③ `textEditing`(AnnotationLayer `onEditingChange` → 스토어 `textEditing`) → `when:'textEdit'` 행 + `Escape`(계층 2)만. ④ 그 외 `INPUT/TEXTAREA/contentEditable` 포커스(NumField·검색창) → **전부 통과**(Esc 도 그 필드가 처리 — 30 (p-4) 회귀). ⑤ `e.isComposing || keyCode===229` → 통과(`terminal-engine.ts:286-289` 와 같은 가드). 글자·숫자·괄호는 `e.code`(`KeyV/Digit0/BracketRight/Equal/Minus/Comma/Period/Quote/Space`), 명명 키는 `e.key`. **`e.code` 가 비면 `e.key` 에서 유도**(`/^[a-z]$/i → Key*`) — e2e 30 `A.key` 가 `code` 없이 보낸다. `Space` 홀드·복귀를 위해 `keyup` capture 1개를 같은 훅이 단다.

루트 `<div role="application" aria-label="이미지 편집" tabIndex={-1}>` 에 마운트·레일 클릭 후 `focus()` — Space 가 마지막 클릭한 버튼을 누르거나 뒤의 터미널 textarea 로 가는 것을 막는다.

**앱 전역 키 출처표**(consume 판정의 근거 — e2e 40 프로브가 전 행을 디스패치한다):

| 키 | 출처 | 편집기 | 이유 |
|---|---|---|---|
| F5 · mod+P · mod+Alt+N · mod+Shift+F · mod+Shift+A | `KeyboardShortcuts.tsx:55,63,70,77`, `GlobalShortcuts:18` | 통과 | 편집기 의미 없음 — 앱 기능 유지 |
| Ctrl+Shift+D/E/W · Ctrl+T · Ctrl+` · Ctrl+K | `:87-106,127,130,122` | 통과 | 동상 |
| **Ctrl+Alt+Shift+K** | `:122-126`(altKey 미검사 → push) | consume(간격 정리) | 시안 ⑧ ⌃⌥⌘K |
| **Ctrl+W** | `:110-120`(뷰어 탭 닫기) | consume(편집기 닫기) | 편집기 뒤 탭이 닫히면 안 된다 |
| **Ctrl+Shift+O** | `DiffViewer.tsx:272-283`(Monaco 포커스 강탈) | consume(윤곽선화) | 시안 ⑧ ⇧⌘O |
| **Ctrl+C** | `terminal.ts:212-236`(터미널 선택 복사) | consume — 선택 있을 때만 | 객체 복사가 우선. 선택 0이면 통과 |
| Ctrl+Shift+C | `terminal-engine.ts:380`(터미널 **포커스** 시만) | consume(PNG 복사 `:1287`) | 루트 포커스라 충돌 없음 |
| Ctrl+Z/Y/S/=/-/D · Ctrl+' | Chromium 액셀러레이터(추정) | consume + `preventDefault` | 인쇄·북마크·페이지 줌 억제 — e2e 40 이 `defaultPrevented` 단언 |

### 3.4 단축키 표 — `EDITOR_SHORTCUTS`(Windows 1차 · Mac 열은 시안 ⑧ 글리프 그대로)

`when`: `always`·`design`·`hasSelection`(design+sel≥1)·`multi`(sel≥2)·`nodeEdit`·`crop`·`textEdit`. Mac 열의 ⌃=Control, ⌥=Option, ⌘=Cmd, ⇧=Shift — 행마다 **명시**(⌃⌥H 처럼 Ctrl→⌘ 일괄 치환이 아닌 행이 있다). `formatShortcut` 이 `isMac`(`platform.ts:4`)으로 표기를 고른다.

| 그룹 | id → Win · Mac | when | consume | 액션(소유) |
|---|---|---|---|---|
| 도구 | `tool.select` V · `tool.scale` K · `tool.frame` F · `tool.vpen` P · `tool.pen` Shift+P · `tool.highlight` H · `tool.eraser` E · `tool.rect` R · `tool.ellipse` O · `tool.line` L · `tool.arrow` A(별칭 Shift+L) · `tool.text` T · `tool.badge` N · `tool.mosaic` M · `tool.eyedropper` I · `tool.slice` S · `mode.crop` C · `hand` Space(홀드) | design | ○ | `setTool` / `setMode` (42; vpen 47·eyedropper 45·slice 52·측정 43 은 행만 예약) |
| 편집 | `undo` Ctrl+Z ⌘Z · `redo` Ctrl+Shift+Z·Ctrl+Y ⇧⌘Z · `duplicate` Ctrl+D ⌘D · `copy` Ctrl+C ⌘C · `cut` Ctrl+X ⌘X · `copyPng` Ctrl+Shift+C ⇧⌘C · `selectAll` Ctrl+A ⌘A · `delete` Delete/Backspace · `nudge` Arrow·Shift+Arrow(1/10px, `repeat` 무시) · `rename` F2 | 편집 always, 나머지 hasSelection(nodeEdit 에서는 delete/nudge/selectAll 이 47 정점 핸들러로 분기) | ○ | 42(undo/redo/dup/copy/cut/delete/nudge/selectAll: `tree.remove/translateSubtree` + `applyDoc(…,'commit',라벨)`), rename 44, nodeEdit 분기 47 |
| 모드 | `enter` Enter(design: text→편집·group→진입(38 `scope`)·path→nodeEdit(47) / crop·nodeEdit: 적용·완료) · `esc` Escape(계층) | always | ○ | 42 |
| 구조(⑧) | `group` Ctrl+G ⌘G · `ungroup` Ctrl+Shift+G ⇧⌘G · `frame` Ctrl+Alt+G ⌥⌘G · `mask` Ctrl+Alt+M ⌃⌘M · `front` Ctrl+Alt+] ⌥⌘] · `back` Ctrl+Alt+[ ⌥⌘[ · `forward` ]·Ctrl+] · `backward` [·Ctrl+[ | hasSelection(group·mask multi) | ○ | 42 → `tree.group/ungroup/makeMask/reorder`(38) 1:1 |
| 정렬(⑧) | `align.left/hcenter/right/top/vcenter/bottom` Alt+A/H/D/W/V/S ⌥A/H/D/W/V/S · `distribute.h/v` Ctrl+Alt+H/V ⌃⌥H/V · `tidy` Ctrl+Alt+Shift+K ⌃⌥⌘K | multi(단일은 캔버스 기준) / 3+ / multi | ○ | 45 `align.ts` — 45 전엔 행만 |
| 불리언(⑧) | `bool.union/subtract/intersect/exclude` Ctrl+Alt+U/S/I/X ⌥⌘U/S/I/X · `flatten` Ctrl+E ⌘E · `outline` Ctrl+Shift+O ⇧⌘O | multi / hasSelection / hasSelection | ○ | 46 · `outline` 은 **액션 1개**가 선택 kind 로 분기(path→46 `outlineStroke`, text→50 `outlineText`) |
| 컴포넌트 | `component.make` Ctrl+Alt+K ⌥⌘K · `component.detach` Ctrl+Alt+B ⌥⌘B | hasSelection | ○ | 51 — 시안 ⑧ 글리프 없음(Figma 관습, INDEX §10.3 열린 질문) |
| 뷰 | `zoom.in` Ctrl+=/NumpadAdd ⌘= · `zoom.out` Ctrl+-/NumpadSubtract ⌘- · `zoom.100` Shift+0 ⇧0 · `zoom.fit` Shift+1 ⇧1 · `zoom.sel` Shift+2 ⇧2 · `view.rulers` Shift+R ⇧R · `view.pixelGrid` Ctrl+' ⌘' · `view.snapPixel` Ctrl+Shift+' ⇧⌘' · `view.pixelPreview` Ctrl+Alt+Y ⌥⌘Y(0↔1) · `measure.hold` Alt(왼쪽, keydown/keyup 홀드 — 43 Alt 측정) | always / design | ○(measure.hold 는 preventDefault 만) | 42(줌·토글), 표시는 43(눈금자·그리드·측정)·40(디테일) |
| 파일 | `file.save` Ctrl+S ⌘S(41 `persist.flush` — 평탄화 아님) · `file.saveAs` Ctrl+Shift+S ⇧⌘S(`saveAs :795-`) · `file.export` Ctrl+Shift+E ⇧⌘E(52) · `file.close` Ctrl+W ⌘W(`requestClose`) | always | ○ | 42/41/52 |

표에 **없는** 키: Ctrl+V — 브라우저 기본이 만드는 `paste` 이벤트 하나(41 §3.5 핸들러 확장: `text/plain` 이 `gpv-anno:` 접두면 객체(새 id·`DUPLICATE_OFFSET`), 파일이면 에셋)가 같은 창·doc 창 간 붙여넣기를 다 처리한다. `copy/cut` 은 `clipboard.ts copyText('gpv-anno:'+JSON)`. Ctrl+Shift+H/L(숨김·잠금)·Tab 순환·Ctrl+Shift+K 이미지 배치는 시안에 없어 **넣지 않는다**(레이어 패널 눈/자물쇠·레일 클릭이 대신).

### 3.5 툴 레일 23 — 도구 의미·소유(레일 순서 = `.pen`)

| 레일 | id · 키 | 동작 | 소유 |
|---|---|---|---|
| 선택 | `select` V | 현행 | 42 |
| 이동 | `scale` K | 선택 드래그가 `resizeObject` 대신 **`scaleObject`**(`AnnotationLayer:1352` — 글자·선폭 배율) | 42(`pointer.ts` 분기 1개) |
| 프레임▾ | `frame` F | 드래그 → `FrameNode{clipsContent:true, radius:[0,0,0,0]}`(37 stub) `makeDraft` 케이스 1개. 플라이아웃: 슬라이스 | 42 |
| 펜▾ | `vpen` P | 베지어 펜 | 47(전엔 숨김). 플라이아웃: 연필 Shift+P · 형광펜 H(레일에 없는 유일한 기존 도구) |
| 곡률 | 토글 `toggles.curvature` | 도구가 아니다 — 펜의 기본 노드 모드 auto | 47(전엔 숨김) |
| 연필 | `pen` Shift+P | 현행 자유곡선(kind `pen`) — 라벨만 '연필' | 42 |
| 지우개 | `eraser` E | 드래그 경로의 각 점을 `hitTest(scene,…)`(38)로 적중한 노드 집합 → pointerup 에 `tree.remove` 1커밋 '지우개' | 42(`pointer.ts` 드래그 모드 1개) |
| 사각형▾ · 타원 | `rect` R · `ellipse` O | 현행. 플라이아웃: 다각형·직선·화살표 | 42 |
| 다각형 · 말풍선 | `polygon` · `callout` | 46 프리셋 드래프트(`toPathObject` 정N각형·말풍선 path) | 46(전엔 숨김) |
| 직선 · 화살표 · 텍스트 · 번호 뱃지 | L · A · T · N | 현행 | 42 |
| 이미지 | `image` | 클릭 → 41 `assetPickFile` → `doc.assets` 등록 → 원본 크기 `rect` + `fills:[{type:'image', assetId, mode:'fill'}]`(37 §3.6 "ImageNode kind 없음") 클릭 위치에 1커밋 '이미지 배치' | 42(41·39 선행) |
| 모자이크▾ · 블러 | `mosaic` M · `blur` | 블러 = `mosaic` kind `mode:'blur'`(`AnnotationToolbar:258` 프리셋) — 도구가 `DefaultPaint.mosaicMode` 만 다르다. 플라이아웃: 블러 | 42 |
| 스포이드 | `eyedropper` I | 일시 도구(클릭 후 `restoreTool`) | 45(전엔 숨김) |
| 측정 | `measure` | 측정 라벨 도구 | 43(전엔 숨김) |
| 크롭 | `mode.crop` C | §3.2 | 42 → 48 |
| 슬라이스 | `slice` S | 내보내기 영역 | 52(전엔 숨김) |
| 손 | `hand` Space 홀드·레일 | 좌버튼 팬: AnnotationLayer 가 `tool==='hand'` 면 pointerdown 을 잡지 않고(캡처 안 함) 스테이지 핸들러(`:427-446`)가 `button===1 || hand` 로 팬. 커서 `grab` | 42 |
| Color Swatch | Front=선 · Back=채우기(`DefaultPaint`) | 클릭 → 인스펙터 속성 탭으로 전환(45 가 색 피커 팝오버를 붙인다) | 42 |

플라이아웃 4(캐럿 우클릭·300ms 길게 누름): 내용은 시안에 없어 Figma 그룹 관례를 따른다(위 표) — 순증 항목은 형광펜 하나. 구현은 `ViewerFileTabs.tsx:118-135` 패턴(`fixed` 백드롭 + 좌표 클램프 + `useOccludesWebview`) ≈40줄, 45 `Popover` 도착 시 교체. 레일 항목 데이터 `TOOLS`(id·라벨·키·아이콘·`owner`) 한 곳 — `title="<라벨> (<키>)"` 형식 유지(e2e activeTool). **`ready` 가 아닌 항목은 렌더하지 않는다** — M2 시점 레일은 15개, M5 완료 시 23.

| 대안 | 평가 |
|---|---|
| **A. 출시 키 유지 + P 만 베지어 펜으로 이관(연필 Shift+P), H 형광펜 유지** (채택) | Figma 관습(P=펜)·시안 ③ 펜 우선. 비용 = e2e 헬퍼 2줄. INDEX §10.3 42행 열린 질문(기본 '예') |
| B. Figma 전면(H=손) | Shift+H 는 Figma 좌우 반전이라 형광펜 자리가 없고 30 `setTool('pen')` 이 자유곡선을 전제 |
| C. `Tool` id `'path'` | 노드 kind 이름과 충돌(`propTool = kind` 관례) — `'vpen'` |

### 3.6 타이틀바(48px)

브레드크럼 `<프로젝트 이름>(useProjects, queries/index.ts:301) · / · <basename>`, `편집됨` 점 = `persist.state !== 'clean'`(41), 세그먼트 `디자인 | 픽셀 미리보기`(`pixelPreview` 0↔1 — ⑦ `끄기·1x·2x` 3상태는 45 조정 탭 픽셀 미리보기 섹션), 줌 드롭다운(`%` 표시 + 프리셋 25/50/100/200/400·맞춤·선택 맞춤), undo/redo(title `실행 취소 (Ctrl+Z)`·`다시 실행 (Ctrl+Shift+Z)` 유지 — 30:1605), `내보내기` 버튼 슬롯(52 도착 전 미렌더), 닫기 X(`requestClose`). 기존 `roundTripWarning` 배지·원본 변경 배너(41)는 타이틀바 아래 줄.

줌 수식은 `zoom.ts` 에 **한 함수 추가**: `zoomTo(v, cx, cy, target) = zoomAt(v, cx, cy, target / v.scale)`. 100% = `1/displayScale`, 맞춤 = `IDENTITY_VIEW`, 선택 맞춤 = `selectBox(scene, ids).rect`(38) 가 stage 의 80% 가 되는 배율 후 중심 이동. 키 줌은 stage 중심 기준(휠은 커서 기준 — `:409-422` 유지).

### 3.7 상태바(30px)

`X / Y` 와 커서 색은 **React state 를 타지 않는다**: `AnnotationLayer` 가 `onCursor(x, y)` 대신 `StatusBarHandle.setCursor(x,y,rgb)` 를 rAF 당 1회 부르고 상태바가 `textContent` 를 직접 쓴다(K4 관례 `:500-506`). 색은 `[1]` 1px `getImageData`. 토글 5(`스냅·스마트 가이드·픽셀 그리드·눈금자·가이드 표시` = `toggles.snap/smartGuides/pixelGrid/rulers/guidesVisible`), 선택 요약 `N개 선택 · W × H`(`selectBox`; **`N개 선택` 은 자기 `<span>`** — 30 `selCount` 최안쪽 규칙), 줌 `%`, `실행 취소 N단계`(41 `hist.cursor`), 모드 요약 슬롯(`hint` — 47 `노드 1개 선택 · 대칭 핸들`, 48 `크롭 2400 × 1600 · 3:2`, 40 디테일 강등 힌트, 47 펜 `클릭 = 코너 · 드래그 = 곡선`).

### 3.8 레이아웃·인스펙터 프레임·기존 컨트롤의 자리

CSS grid `[rail 56][left 264][stage 1fr][inspector 320]` × `[title 48][1fr][status 30]`. 루트 `fixed inset-0 z-50`(클래스 문자열 유지) + `role="application" aria-label="이미지 편집"`, 카드 클래스(`:983-987`) 삭제 → 두 창 모두 `flex h-full w-full`. doc 창 `top:32` 유지. 좌·우 폭은 `usePanelWidth('gp:ie:left', 264, 200, 420)`·`('gp:ie-right', 320, 260, 480, 'left')`(`use-panel-width.ts:7`) 재사용.

인스펙터는 **4탭 프레임(속성·텍스트·조정·내보내기, 전부 마운트 + `hidden`)** 만 이 태스크가 만들고, 기존 `aside` 섹션을 탭 안으로 **옮긴다**(45 가 교체할 때까지 기능 후퇴 0): 속성 ← `AnnotationToolbar` 의 속성부(팔레트·최근·두께·채움·모서리·모자이크·불투명도, 도구 격자·undo/redo 는 삭제 → 레일·타이틀바), 텍스트 ← 글자 크기 슬라이더(텍스트/뱃지 선택 시), 조정 ← 회전·반전·크롭(`크롭 선택/영역을 드래그` 버튼 문구 유지)·크기·색 보정, 내보내기 ← 포맷·품질. 푸터 `초기화 · 복사 · 다른 이름으로 · 저장 (PNG)`(시안 Inspector Footer, `취소` 는 삭제 — X 가 닫기). 좌 패널은 탭 3(레이어·에셋·히스토리) 프레임만 — 본문은 44(M2 안에서 채워진다).

### 3.9 만들지 않는 것

- 레이어 패널 본문·히스토리/에셋 탭 내용(→ 44), 컨텍스트 바·인스펙터 속성 필드·팝오버·정렬/분배 구현(→ 45), 눈금자·가이드·스냅·픽셀 그리드 **표시**(→ 43 — 토글 값만 여기), 디테일 캔버스(→ 40), 노드 편집 진입·펜(→ 47), 크롭 세션(→ 48), 텍스트 키 동작(→ 50), 내보내기(→ 52).
- 시안에 없는 키·기능: Ctrl+Shift+H/L, Tab 순환, Figma H=손, 텍스트 편집 단축키(Ctrl+B/I/U·정렬·크기 ± — 49 §3.10·50 §3.8 판정, INDEX §10.3 열린 질문), 수식 입력, 키 재배정 UI, 앱 전역 리스너 수정.
- 런타임 탭/패널 레지스트리(`registerInspectorTab` 류) — 고정 4탭·3패널에 도메인 컴포넌트를 직접 마운트(구현 하나짜리 추상화).

## 4. 계약 (소유: 42 · `src/stores/imageEditor.ts`, `src/lib/annotate/shortcuts.ts`, `src/lib/annotate/selection.ts`, `src/components/image/useEditorKeys.ts`, `EditorTitleBar/ToolRail/EditorStatusBar/LeftPanel/inspector/Inspector.tsx`)

```ts
// src/stores/imageEditor.ts — 창(JS 컨텍스트)별 인스턴스. 문서는 여기 없다(ImageEditor 로컬 + DocHistory 유지)
export type Tool = 'select'|'scale'|'frame'|'vpen'|'pen'|'highlight'|'eraser'|'rect'|'ellipse'|'polygon'|'line'|'arrow'
  |'text'|'image'|'badge'|'callout'|'mosaic'|'blur'|'eyedropper'|'measure'|'slice'|'hand';   // types.ts:14-24 에서 이동. 곡률=토글, 크롭=모드
export type Mode = { kind:'design' } | { kind:'nodeEdit'; id:ObjId } | { kind:'crop' };
export interface EditorUiState {
  tool:Tool; prevTool:Tool|null; mode:Mode; pixelPreview:0|1|2; textEditing:boolean;
  selectedIds:(ObjId|'__base')[] /* 순서 보존 — 마지막이 정렬 기준(45). '__base' = 이미지 배경 의사 id, 단독 선택만 */; hoverId:ObjId|null;   // 레이어 접기·검색·필터는 44 패널 로컬 state(44 §3.1) — 스토어에 없다
  leftTab:'layers'|'assets'|'history'; inspectorTab:'props'|'text'|'adjust'|'export'; inspectorTabManual:boolean /* 45 §3.1 자동 탭 전환 억제 */;
  tidyGap:number|'auto' /* 45 §3.5 */; ratioLock:boolean /* 45 §3.6 노드 W/H 비율 잠금 */; recentColors:string[] /* 45 색 피커, 상한 12 */;
  toggles:{ snap:boolean; smartGuides:boolean; pixelGrid:boolean; rulers:boolean; guidesVisible:boolean; snapObjects:boolean; snapGuides:boolean;
            snapPixel:boolean; gapBadges:boolean; grid:0|8|16; curvature:boolean; cropOverlay:'none'|'thirds'|'quarters'|'golden'|'diagonal' /* 48 */ };   // localStorage 'gp:ie:toggles'
  snapThresholdCss:number /* 4 */; hint:string|null /* 상태바 모드 요약 슬롯 */;
  setTool(t:Tool, o?:{temporary?:boolean}):void /* select|vpen 밖으로 가면 mode.nodeEdit → design (47 §3.2) */; restoreTool():void; setMode(m:Mode):void;
  select(ids:(ObjId|'__base')[], o?:{append?:boolean; toggle?:boolean}):void;   // '__base' 는 단독만 — 노드 id 와 섞이면 노드가 이긴다(44 배경 행 → 45 image 컨텍스트 바) setHover(id:ObjId|null):void;
  setToggle<K extends keyof EditorUiState['toggles']>(k:K, v:EditorUiState['toggles'][K]):void; setTab(...):void; setPixelPreview(n:0|1|2):void;
  setTextEditing(v:boolean):void; setHint(s:string|null):void; reset():void;
}

// src/lib/annotate/selection.ts — 42 소유(순수). 45 컨텍스트 바·인스펙터, 49 mixedTextStyle, 46 canBoolean 게이트가 import
export type SelectionKind = 'none'|'single-shape'|'multi'|'text'|'image'|'vector-edit'|'crop';
export function classifySelection(objects: readonly Node[], selectedIds: readonly (ObjId|'__base')[], mode: Mode): SelectionKind;   // 규칙(우선순위)은 45 §3.1 표가 정본
export const MIXED: unique symbol;  export type Maybe<T> = T | typeof MIXED;
export function readProp<T>(nodes: readonly Node[], get: (n: Node) => T | undefined, eq?: (a: T, b: T) => boolean): Maybe<T> | undefined;   // undefined = 어느 노드에도 없음(필드 숨김)
export const useImageEditorUi: UseBoundStore<StoreApi<EditorUiState>>;   // 타 태스크는 getState()/셀렉터로 읽고, 문서 변경은 applyDoc/patchDoc 경유

// src/lib/annotate/shortcuts.ts
export type ShortcutId = 'tool.select'|…|'file.close';   // §3.4 전 행
export interface Shortcut { id:ShortcutId; win:string; mac:string; label:string; when:'always'|'design'|'hasSelection'|'multi'|'nodeEdit'|'crop'|'textEdit'; consume:boolean; owner:37|42|43|44|45|46|47|48|50|51|52 }
export const EDITOR_SHORTCUTS: readonly Shortcut[];
export function matchShortcut(e:KeyboardEvent, ctx:{ mode:Mode; sel:number; selKinds:Set<Node['kind']>; textEditing:boolean }, platform?:'win'|'mac'):ShortcutId|null;
  // 글자·숫자·기호 e.code(비면 e.key 에서 유도), 명명 키 e.key, isComposing/229 → null. platform 기본 isMac
export function formatShortcut(s:Shortcut):string;   // 'Ctrl+Alt+H' / '⌃⌥H'
export function codeOf(e:KeyboardEvent):string;

// src/components/image/useEditorKeys.ts — 편집기 마운트 중 window capture keydown 1 + keyup 1
export function useEditorKeys(actions:Partial<Record<ShortcutId, (e:KeyboardEvent)=>void>>, opts:{ popoverOpen:()=>boolean }):void;
  // 게이트 순서 §3.3 ①~⑤. 매치+consume → preventDefault+stopImmediatePropagation → actions[id]. 액션 맵은 ImageEditor 가 주입(다른 태스크는 표에 행 + 맵에 핸들러 — window 리스너 추가 금지)

// src/lib/zoom.ts (+1)
export function zoomTo(v:View, cx:number, cy:number, targetScale:number):View;   // = zoomAt(v,cx,cy,target/v.scale)

// src/components/image/ToolRail.tsx
export const TOOLS: readonly { id:Tool|'crop'|'curvature'; label:string; key:string|null; icon:LucideIcon; flyout?:readonly Tool[]; owner:number; ready:boolean }[];   // .pen 순서 23 + 스와치
// src/components/image/EditorStatusBar.tsx
export interface StatusBarHandle { setCursor(x:number|null, y:number|null, rgb:string|null):void }   // AnnotationLayer 가 rAF 당 1회 — React state 없음
// AnnotationLayer props 추가: statusRef?:RefObject<StatusBarHandle>; onEditingChange(v:boolean):void; tool 은 Tool(스토어 타입) — 나머지 계약(e2e 30) 불변
```

e2e 페이지 훅(`window.__gpv.imageEditor`, DEV): `getUi(): {tool, mode, pixelPreview, selectedIds, hoverId, toggles}` · `matchShortcut(init:KeyboardEventInit, platform:'win'|'mac'): ShortcutId|null` · `setMode(m)`. 기존 `setTool(t)` 는 스토어로 재배선(시그니처 동일).

**e2e 헬퍼 수정(6줄)**: 30·34·35 `A.modal` 각 1줄 — `.find(el => el.getAttribute('aria-label') === '이미지 편집' || /이미지 편집/.test(el.textContent || ''))`; 30 `activeTool` 2줄 — 정규식 `/\(((?:Shift\+)?[A-Z])\)$/`, `byKey` 에 `P:'vpen', 'Shift+P':'pen'`; 30:1605 `/실행 취소/` 는 타이틀바 버튼 title 이 같아 무수정, `cropOn`·`/크롭 선택/`·`/오른쪽 90/`·`(p-4)` 첫 `input`(속성 탭 range) 무수정 + 41 의 `openEditor` 1줄.

## 5. 단계

1. **스토어·표·키 스코프**(`imageEditor.ts` ≈180, `shortcuts.ts` ≈200(표 ≈70행), `useEditorKeys.ts` ≈120, `zoom.ts` +6): `Tool` 이동, `ImageEditor` 로컬 `tool/selectedIds/cropMode` → 스토어 브릿지(≈ −30/+40), `:910-948` 키 effect 삭제, 37 `annotation/keys.ts` 삭제(액션 맵으로 이관: dup/delete/nudge/reorder/selectAll/copy/cut/group/ungroup/frame/mask/front/back/zoom/close ≈ +140). e2e 40 키 프로브·Mac 단위 케이스 먼저 초록.
2. **셸**(`EditorTitleBar.tsx` ≈140 · `ToolRail.tsx` ≈200(+플라이아웃 40) · `EditorStatusBar.tsx` ≈120 · `LeftPanel.tsx` ≈60 · `inspector/Inspector.tsx` ≈90): `ImageEditor` 루트·헤더·aside·푸터(`:973-1315`) → 그리드 조립(≈ −350/+220), `AnnotationToolbar.tsx` 속성부만 `inspector/PropsLegacy.tsx` 로 이동(45 가 삭제) · 도구 격자 삭제. `A.modal` 3줄·`activeTool` 2줄. 30/34/35 초록.
3. **레일 도구 동작**(`annotation/pointer.ts` +≈90): eraser 드래그 모드·scale 도구·frame/blur/image `makeDraft` 케이스·hand 통과. e2e 40 (e)(f)(g).
4. e2e `40-image-editor-pro-ui.mjs` 신설(≈300) + `run.mjs` 1줄, `DOCS/task/00-INDEX.md` 행 갱신.

규모 **L**: 프론트 ≈ +1,250/−480 · Rust 0 · 신규 의존 0.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| capture 가 과하게 먹어 앱 키가 "편집기 열린 동안 죽었다"로 보임 | consume 판정 실수 | `consume` 은 표의 편집기 처리 키만. e2e 40 프로브: 통과 키 5종 버블 도달 1회·앱 상태 불변 |
| Ctrl+Alt+글자가 한국어 키보드 오른쪽 Alt(한/영)와 겹침 | WebView2 는 `key='HangulMode'`(추정) — `e.code` 매칭엔 안 잡히나 IME 모드가 토글 | 툴팁에 "왼쪽 Alt" 표기, 실기 1회. 모든 Ctrl+Alt 행은 컨텍스트 바 버튼(45)이 대안 |
| 루트 포커스 관리 실패 → Space 가 마지막 클릭 버튼을 누름 | 레일 클릭 후 포커스가 버튼에 남음 | `ToolRail` onClick 뒤 `rootRef.focus()`, e2e 40 (d) Space→hand |
| `A.key` 가 `code` 없이 보냄 | e.code 전용 매칭이면 30 (p-2)(p-3) 방향키는 명명 키라 무관하지만 향후 글자 키 합성이 깨진다 | `codeOf` 폴백(`e.key` → `Key*`) |
| 스토어 브릿지로 AnnotationLayer 선택 갱신이 한 프레임 늦음 | zustand → ImageEditor 리렌더 → props | 포인터 핸들러는 `p.current` 미러(`:187-189`)를 읽고 `select()` 는 동기 setState — 종전 `setSelectedIds` 와 같은 경로 |
| 레일이 M2 시점 15개뿐 | 시안 23 과 시각 차이 | `ready` 규칙을 문서화, e2e 40 (b) `버튼 수 === TOOLS.filter(ready).length` — 47/46/43/45/52 가 각자 `ready:true` 로 바꾸며 수용 기준을 가진다 |
| 상태바 `N개 선택` 이 30 `selCount` 를 오염 | 인접 텍스트 노드가 붙으면 `1001개 선택` 류 | 자기 `<span>` + 공백 분리; e2e 30 (k) 계층 5 단언이 회귀망 |
| `Tool` 이동으로 37 파일 편집 | `types.ts:14-24` 삭제 | 삭제만(추가 0) — 37 §4 표에 `Tool` 없음을 확인 |

## 7. 검증

- **e2e 40 `40-image-editor-pro-ui.mjs`(신규)**: (a) 루트 `[aria-label="이미지 편집"]` 이 `div.fixed.inset-0.z-50` 이고 `canvases()[0].width>0 && [1].width>0`, 그리드 4열(레일 56·좌 264·인스펙터 320 ±1). (b) 레일 버튼 수 == `TOOLS.filter(ready)`, 각 title `<라벨> (<키>)`|`<라벨>`, 캐럿 4개 우클릭 → 플라이아웃 DOM 등장·Esc 로 닫힘(0단계). (c) **키 프로브**: 메인 창에서 편집기를 열고 뒤에 코드 파일 + 선택 있는 터미널을 둔 뒤 `window` 버블 프로브 설치 → 표 전 행 디스패치: `consume` 행은 프로브 0회·`defaultPrevented===true`, 통과 5종은 프로브 1회; Ctrl+Alt+Shift+K → `ops` 진행 없음, Ctrl+W → `viewerTabs.length` 불변·`imageEditorPath` 유지, Ctrl+Shift+O → `document.activeElement` 가 Monaco 아님, Ctrl+C(선택 1) → 클립보드 `gpv-anno:` 접두. (d) `{key:'ㅍ', code:'KeyV'}` → tool select; `{key:'å', code:'KeyA', altKey:true}` → `matchShortcut(…, 'mac')==='align.left'`; `{metaKey, code:'KeyG'}`(mac) → `group`, `{ctrlKey, altKey, code:'KeyH'}`(mac) → `distribute.h`; Space keydown → `getUi().tool==='hand'`, keyup → 이전 도구. (e) 모드: `C` → `mode.kind==='crop'` + 배너 텍스트 `/크롭 모드/`, Enter → design, Esc → design·`crop===null`(30 (k) 계층 3 무변경); `setMode({kind:'nodeEdit', id})` → 배너 `/벡터 편집 모드/`, Esc → design. (f) 지우개: rect 2개 → `E` → 한쪽을 가로지르는 pointerSeq → `objects.length===1`·히스토리 라벨 `/지우개/`; `K` 리사이즈 드래그 후 텍스트 `fontSize` 배율 변화; `F` 드래그 → `kind:'frame'`; 이미지 도구는 `asset_pick_file` 취소 → 문서 불변. (g) 줌: 드롭다운 `100%` → `canvases()[1].getBoundingClientRect().width === oriented.width ± 1`; `Shift+1` → `IDENTITY_VIEW`; `Ctrl+=` 2회 → `WHEEL_STEP⁴` 배율 ±1e-6. (h) 상태바: `[1]` 위 pointermove(100,100) → 텍스트 `X 100  Y 100`·색 `#FFFFFF`, React Profiler 커밋 0; 사각형 2개 선택 → `2개 선택` span 존재·`selCount()===2`; `실행 취소 N단계` == `history.cursor()`. (i) Ctrl+C → Ctrl+V(같은 창) → 객체 +1·오프셋 8·새 id; doc 창(connectLabel)에서 복사 → 메인 편집기 붙여넣기 → 객체 건너옴. (j) 토글 5 클릭 → `getUi().toggles` 반영·`localStorage['gp:ie:toggles']` 갱신·재오픈 유지.
- **회귀**: 30(91)·34(32)·35(13) — 헬퍼 6줄 외 무변경 pass. 34 `overlay(/편집기 닫기/)` 는 41이 평탄화 확인창으로 옮긴 뒤 상태 기준.
- **컴파일**: `AnnotationLayer` 안 `window.addEventListener('keydown'` grep 0건, `annotation/keys.ts` 부재, `types.ts` 에 `Tool` 부재.
- **실기**: 한글 IME 켠 채 V/R/T 도구 전환; 오른쪽 Alt(한/영) + Ctrl+Alt+M 동작 확인; doc 창(1180×860)·메인 창(1440×900)에서 그리드 폭·stage 축소 확인; Space 팬 중 마우스 업 후 도구 복귀; Mac 1회(⌥A·⌃⌥H·⌘G 글리프 표기와 동작).
