# 태스크 45 — 컨텍스트 바 7종·인스펙터 4탭 셸·속성 탭·필드(Mixed/스크럽)·정렬/분배·팝오버 프리미티브+8종

> 상태: 설계(Design) · 대상: gitpervisor · 근거: 코드 실측 2026-09-04(워킹트리) · 선행: 태스크 42(`useImageEditorUi`·`Mode`·`EDITOR_SHORTCUTS`·툴 레일·상태바),
> 44(레이어 패널·타입 필터 팝오버 콘텐츠), 37(`applyPaintPatch/paintOf/DefaultPaint/documentColors`), 38(`setObjectFrame/rotateNodes/nodeAABB/makeMask`), 39(`renderScene` 병합 캔버스),
> 41(`patchDoc(patch, mode, label)`) · `DOCS/pro-image-editor-design.md` §8(정렬/분배·스냅 기각 K3 — 사용자 결정으로 대체)·§5.3(히스토리 단위) ·
> 시안: `designs/image-editor-figma-v2.pen` ①(인스펙터 속성·컨텍스트 바)④(팝오버 8종)⑦(조정 탭)⑧(컨텍스트 툴바 7종·정렬/분배) · 상위: `00-INDEX.md` §10 — **M3 첫 태스크(XL, 4커밋).**

## 1. 요구사항

시안의 **선택 대상별 편집 UI 전부** — 캔버스 위 컨텍스트 바, 우측 인스펙터(4탭), 값을 고르는 팝오버 — 를 기존 `applyDoc` 깔때기의 **호출자**로만 얹는다.
문서 변경 경로는 늘리지 않고, 도메인 섹션(벡터·크롭·텍스트·스타일·내보내기)은 46/48/50/51/52의 컴포넌트를 **마운트만** 한다.

받아들이는 조건(시안 라벨 인용):
- ⑧ `컨텍스트 툴바 · 선택 대상별 · 캔버스 상단 바가 선택 대상에 따라 바뀐다` — 7변형: `선택 없음(캔버스 · 줌 70%)` · `단일 도형(사각형 · F0398B · 선 2 · 반경 8 · 불투명도 100% · 표준/곱하기/스크린)` · `다중 선택 (3)(3개 선택 · 정렬 · 분배 · 불리언 · 그룹 · 간격 정리)` · `텍스트(Noto Sans KR · Regular/Bold · 크기 14 · 행간 150% · 텍스트 스타일)` · `이미지(배경 이미지 · 원본 크기 2880×1605)` · `벡터 편집(지시선 벡터 · 코너/대칭/비대칭/자동 · 편집 완료 ⏎)` · `크롭(자유·1:1·3:2·16:9 · 직선화 1.4° · 취소 · 적용 ⏎)`.
- ① 컨텍스트 바 공통: `2개 선택` · 정렬 6 · 분배 2 · `간격 정리` · 불리언 4+캐럿 · 반전/회전 · `마스크로 사용` · `그룹` · 불투명도 `100%` · 블렌드 `표준` · 눈금자/그리드/자석 토글.
- ⑧ `정렬 · 선택 2개 이상 · 마지막 선택 기준 · 왼쪽 ⌥A · 가로 가운데 ⌥H · 오른쪽 ⌥D · 위 ⌥W · 세로 가운데 ⌥V · 아래 ⌥S`, `분배 · 3개 이상 · 균등 간격 · 수평 분배 ⌃⌥H · 수직 분배 ⌃⌥V`, `간격 정리 ⌃⌥⌘K · 간격 값 지정 · 균등 24` — Windows 1차라 Alt/Ctrl+Alt/Ctrl+Alt+Shift+K(키 배선은 42 표).
- ① 인스펙터 탭 `속성 · 텍스트 · 조정 · 내보내기`, 속성 탭 섹션 `정렬 · 분배(간격 24 · 정리)` · `위치 · 크기(X 330 · Y 250 · W 220 · H 230 · 비율 잠금 · 각도 0° · 반경 8 · ↖↗↘↙ 개별 반경 · 반전/회전 · 좌·상 고정)` · `모양(100% · 표준 · 마스크로 사용 (클리핑))` · `채우기(F0398B 12% · 선형 그라디언트 135° · 이미지 · 채우기 · 곱하기 · +/눈/− · 스타일 · 경고/핑크 · 분리)` · `선(3B82F6 100% · 두께 2 · 안쪽 · 대시 8 · 간격 4 · 캡)` · `효과(드롭 섀도 0·4 12 25% · 이너 섀도 0·2 6 20% · 레이어 블러 반경 4 · 배경 블러 반경 12 · 설정/눈)` · 푸터 `초기화 · 복사 · 다른 이름으로 · 저장 (PNG)`.
- ④ 팝오버: `색 피커(채우기 · 단색 · HEX · RGB · HSL · F0398B · 78% · 최근 사용 · 문서 색상 · 색 스타일로 저장)` · `그라디언트 편집기(선형 · 방사 · 원뿔 · 다이아 · 3B82F6 0% · A855F7 55% · 100% · 각도 135° · 스케일)` · `블렌드 모드 19(패스스루 … 광도)` · `효과 편집(드롭 섀도 · X 0 · Y 6 · 흐림 16 · 확산 · 000000 65% · 드롭 · 이너)` · `아이드로퍼(#2B6CB0 · 1284, 742 · 클릭 = 색 추출 · Esc = 취소)`. `폰트 피커`·`색 스타일 라이브러리`는 이 태스크의 `Popover` 위에 50·51 콘텐츠, `레이어 타입 필터`는 44.
- ⑦ 조정 탭 섹션 `크롭(48) · 마스크(모양 마스크 · 알파 채널 · 마스크 반전 · 마스크 잠금 · 함께 이동 · 마스크 만들기 · 마스크 해제) · 스냅 · 가이드(43 토글 6 · 그리드 8px · 임계값 4px) · 픽셀 미리보기(끄기 · 1x · 2x)`.
- 다중 선택에서 값이 다르면 **Mixed**(`—`)로 보이고 입력하면 전체에 적용된다. 필드는 타이핑·스크럽(라벨 드래그)·방향키가 각각 **히스토리 1칸** 규칙을 지킨다(pro §5.3·K5).
- e2e 30(91)·34(32)·35(13)이 헬퍼 무수정(42가 열거한 줄 외)으로 초록 — 특히 `click(/오른쪽 90/)`(30:825)·`/저장 \(/`(30:747)·`/^\s*저장/`(30:1741)·`/다른 이름으로/`(30:291)·`selCount()`(30:1281 외 11곳).

## 2. 현황(근거)

- **속성 편집은 도구 속성 하나로 묶여 있다**: `ImageEditor.tsx:152-172 restyle`이 `ToolStyle` 부분 패치를 kind별 if 7개로 옮기고, `:626-642 onStyleChange`가 선택 전체에 같은 값을 쓴다(`live`면 `patchLive`). 불투명도는 별도 경로 `:644-652`. **선택 → 패널 동기화는 단일 선택일 때만**(`:603-618`, `:604 if (selectedIds.length !== 1) return`) — 두 개를 고르면 패널이 마지막 단일 선택 값을 그대로 보여 준다(Mixed 없음). 37이 `restyle/ToolStyle`을 `applyPaintPatch/paintOf/DefaultPaint`로 대체한다(37 §3.3) — 이 태스크는 그 위에 UI를 얹는다.
- **패널은 슬라이더뿐**: `AnnotationToolbar.tsx:29-45 TOOLS` 10종 + 팔레트 8색 스와치(`:158-165`, `types.ts:173-182 PALETTE`) + `PropSlider`(`:318-351`) 두께/모서리/글자 크기/강도/불투명도. 숫자 입력·단위·Mixed·스크럽 없음. 표시 조건은 `propTool`(`ImageEditor.tsx:621-624`, "선택 1개면 그 kind") 기반 boolean 6개(`AnnotationToolbar.tsx:107-114`). 42가 이 파일을 삭제(레일·인스펙터로 대체)하므로 여기 있던 색·두께·반경·글자 크기·모자이크 편집이 **전부 이 태스크의 속성 탭으로 온다**.
- **우측 aside 섹션 6개**(`ImageEditor.tsx:1121-1273`): 주석(툴바) · 회전·반전(`:1145-1168`, `rotateBy/flipBy :472-502`, title `왼쪽 90°/오른쪽 90°/좌우 반전/상하 반전`) · 크롭(`:1170-1197`) · 크기(`:1199-1216`, `changeW/changeH :553-566`, `lockRatio :208`) · 색 보정 3 슬라이더(`:1218-1243`, `patchLive/endLive`) · 포맷 4+품질(`:1245-1272`). 푸터 5버튼(`:1277-1315`): `초기화(resetAll :569-597) · 복사(copyToClipboard :833-842) · 취소(requestClose) · 다른 이름으로(saveAs :815-830) · 저장 (ext)(saveInPlace :795-813)`. 시안 ① 푸터는 4버튼(`취소` 없음 — 닫기는 42 타이틀바 X·Esc).
- **입력 필드 히스토리 규칙의 원형**: `NumInput`(`:1364-1384`)은 `onChange→patchLive`, `onBlur→endLive`; `Slider`(`:1386-1420`)는 `onPointerUp/onKeyUp→endLive`. `patchLive`(`:261-270`)가 첫 틱만 commit, 이후 replace — "드래그 1회 = 1칸". 라벨 인자는 41이 `patchDoc(patch, mode, label)`로 연다(41 §4).
- **정렬·분배·간격·회전 설정·개별 반경 — 없다.** 재료는 있다: `translateObject`(`geometry.ts:534-561`), `objectAABB`(`:337-356`), 다중 선택 합집합 bbox 계산(`AnnotationLayer.tsx:941-961` — 같은 식), 90°/반전 델타 `transformObjects`(`geometry.ts:484-531`, `x → W − x` 사상 + text/badge `rot` 부호 반전 `:522-523`), 38의 `setObjectFrame/rotateNodes/nodeAABB/selectBox`.
- **팝오버 프리미티브가 없다**: 앵커 메뉴는 전부 `fixed inset-0 z-50` 백드롭 + `min(x, innerWidth−200)` 클램프(`workspace/ViewerFileTabs.tsx:121-132`) + `useOccludesWebview(!!menu)`(`:52`, `stores/occlusion.ts:49-54`)의 로컬 state 패턴이다. 앵커 배치·플립·폭·Esc 계층 연동이 없다. z 계층 규약: 편집기 모달 z-50(`ImageEditor.tsx:979`) < 토스트 `z-[55]`(`common/Toast.tsx:11-16`) < 확인·프롬프트·QuickPick `z-[60]`(`ConfirmDialog.tsx:18`·`PromptDialog.tsx:41`·`QuickPick.tsx:136`). e2e 34 `A.overlay`(34:56-59)가 `z-[60]`을 확인창 판별에 쓴다 — 팝오버가 `z-[60]`을 쓰면 오탐.
- **색 유틸이 없다**: `render.ts:294-310 readableOn`(비공개, BT.601 밝기)뿐. hex↔rgb↔hsl↔hsv 변환·알파 표기 없음. 최근 색은 `RECENT_COLORS=6`(`ImageEditor.tsx:71`, `:629-634`) 세션 state. 37 `Paint`는 `color:#rrggbb + opacity`라 알파는 색 문자열에 섞지 않는다(e2e 30:25-27 RED/BLUE 상수가 `#rrggbb` 전제).
- **Mixed 판정·선택 분류 없음**: 컨텍스트 바 개념 자체가 없고, `A.selCount`(30:454-469)는 툴바 아래 문구 `N개 선택 — …`(`ImageEditor.tsx:1139-1141`)을 **가장 안쪽 요소**에서 읽는다. 42의 상태바 `2개 선택 · 220 × 230`이 그 문구를 승계한다(42 §4) — 이 태스크의 바 변형이 `1개 선택`을 안 써도(시안 단일 도형은 `사각형`) e2e는 상태바에서 읽는다.
- **e2e 계약 중 이 태스크에 걸리는 것**: `A.btn`은 `textContent + ' ' + title`을 정규식 매칭(30:64-73) → 버튼 라벨 유지가 곧 계약. `click(/오른쪽 90/)`(30:825)은 **탭 상태와 무관하게** 눌러야 한다 → 조정 탭이 hidden 마운트여야 `.click()`이 먹는다(설정 모달 태스크 18의 hidden 마운트 전례). (b) 밝기는 `setDoc({brightness:50})`(30:796)이라 슬라이더 조작 e2e는 없다. `outW/outH`도 `setDoc`뿐(30:898 등). (p-4)(30:1629-1631)는 모달의 **첫 `input`**에 포커스 후 `window`에 ArrowRight를 쏜다 — 첫 input이 NumField가 돼도 `window` 이벤트는 input 핸들러에 닿지 않고 42 캡처 리스너의 INPUT 가드가 통과시킨다.
- **시안 실측**(`.pen`): 인스펙터 폭 320(프레임 ② 320×1360), 필드 높이 28, 버튼 26, 섹션 헤더 `Title + HeadActions(A plus)`, 스택 행 = `Swatch 18 · Text(L,M) · Vis · Del`(채우기/선), `Icon Box · Text · Set · Vis`(효과). 블렌드 목록 `BM` 노드 19개(Sep 5개로 6그룹). 색 피커 `Pop Head(T "채우기 · 단색" · A settings-2 · A x)`, `SV Field 160`, `Hue/Alpha Slider`, `Model HEX/RGB/HSL`, `Sw 최근 사용 8칸`, `Sw 문서 색상 8칸`. 그라디언트 `Pop Head(A shuffle)`, `Preview(Axis+Stop 3)`, `Stop Bar`, 스톱 행 `Sw · Hex · Pos · Del`, `Dial + 각도/스케일`. 효과 편집 `Pop Head(T "드롭 섀도" · A eye · A minus)`, 필드 X/Y/흐림/확산·색+알파·**Blend "곱하기"**·Type 드롭/이너. 아이드로퍼 `Magnifier 176 + Readout(Sw · #2B6CB0 · 1284, 742) + Hint`. 컨텍스트 바 `Var 단일 도형`: `B square · T 사각형 · W F0398B · W 선 2 · F 반경 · F 불투명도 · Seg 표준/곱하기/스크린 · B align-center-vertical · B copy · B trash-2`.

## 3. 설계

### 3.1 선택 분류 하나 — `classifySelection` · `readProp`/`MIXED`

컨텍스트 바와 인스펙터가 **같은 판정**을 본다. 규칙(우선순위 순): `mode.crop → 'crop'` > `mode.nodeEdit → 'vector-edit'` > `sel=0 → 'none'` > `sel ∋ '__base' → 'image'` > `sel=1 ∧ text → 'text'` > `sel=1 → 'single-shape'` > `'multi'`.

네 번째 규칙이 42 §4 `select()` 주석("노드 id 와 섞이면 노드가 이긴다")과 반대로 읽히지만 **둘은 서로 다른 경계 얘기다.** 스토어의 `normalizeSelection`(42, `stores/imageEditor.ts`)이 id 가 둘 이상이면 `'__base'` 를 먼저 걷어내므로 섞인 배열은 애초에 분류기에 닿지 않는다 — 정상 경로에서 이 규칙이 만나는 `'__base'` 는 언제나 단독이고, 두 문서는 같은 결과를 낸다. 정규화를 건너뛴 입력(세션 복원, `selectedIds` 를 직접 쓰는 DEV/e2e 훅)만 섞인 채로 여기 도달하는데, 그때는 표대로 **배경이 이긴다**(`selection.ts:45-48`). 노드를 이기게 하면 배경이 도형 취급을 받아 `setObjectFrame` 이 존재하지 않는 id 로 가고, 예외도 로그도 없이 아무 일도 일어나지 않는다.

| 종류 | 컨텍스트 바(⑧ Var) | 자동 탭 | 콘텐츠 소유 |
|---|---|---|---|
| none | 포인터 아이콘 · `캔버스` 칩(라벨만 — 배경색 개념이 없다, INDEX §10.5 "캔버스=이미지") · 눈금자/그리드/자석 토글 · `줌 70%` 필드 · 맞춤 | 없음 | 45 |
| single-shape | kind 아이콘+이름 · 채우기 스와치(hex) · 선 스와치(`선 2`) · `반경` · `불투명도` · 블렌드 Seg `표준/곱하기/스크린`+`…`(BlendMenu) · 캔버스 가운데 정렬 · 복제(Ctrl+D) · 삭제 | 속성 | 45 |
| multi | `N개 선택` · 정렬 6 · 분배 2(≥3) · `간격 정리` · 불리언 4+캐럿(전부 도형/path일 때만 활성, 46) · 반전/회전 · `마스크로 사용` · `그룹`(그룹 포함 시 `그룹 해제`) · 불투명도/블렌드(Mixed) | 속성 | 45 (불리언 콜백은 46) |
| text | 50 `TextContextBarContent`(폰트 · Regular/Bold · 크기 · 행간 · 정렬 · 장식 · 텍스트 스타일 ▾) | 텍스트 | 50 |
| image | `배경 이미지` · sun/contrast/droplet(→ 조정 탭 밝기/대비/채도로 포커스) · 크롭(→ `mode.crop`) · `원본 크기 W×H`. `채우기·맞춤·늘이기`는 **미렌더**(INDEX §10.5) | 조정 | 45 |
| vector-edit | 47 `NodeContextBar` | 속성(46 `PathInspectorSection`) | 47 |
| crop | 48 `CropContextBar` | 조정(48 `CropInspectorSection` 펼침) | 48 |

자동 탭 전환은 **선택 종류가 바뀔 때 1회**, 사용자가 탭을 누르면 그 종류 안에서는 수동 선택을 기억한다(`ui.inspectorTab` + `inspectorTabManual` 플래그, 42 스토어 필드 2개 — 42 §4에 요청).

`readProp(nodes, get, eq?)` → 값 | `MIXED` | `undefined`. `undefined`(아무 노드도 그 속성이 없음)면 필드를 **숨긴다**(현 `restyle`의 "kind에 의미 있는 필드만" 규칙을 데이터로 옮긴 것, `ImageEditor.tsx:152-172`). `MIXED`면 `—` + placeholder `혼합`, 입력하면 전체에 같은 값. 첫 객체 값을 보여 주는 안은 탈락 — 현 코드가 정확히 그 함정을 피하려고 `:604`에서 동기화를 끊는다.

### 3.2 컨텍스트 바 — 셸 + 슬롯

| 대안 | 평가 |
|---|---|
| **A. `ContextBar`가 `classifySelection` 분기 셸. none/single/multi/image는 이 태스크 콘텐츠, text/vector-edit/crop은 50/47/48 컴포넌트를 마운트** (채택) | 규칙표 한 곳. 도메인 축이 자기 필드(PathObject·CropSession·TextStyle)를 아는 채로 바를 그리고, 셸은 `Mode`·선택만 안다 |
| B. 인스펙터 요약을 자동 생성 | 시안 7변형의 버튼 구성이 서로 달라 규칙으로 안 나온다 |
| C. 도메인 축이 바를 통째로 각자 | `classifySelection`이 세 벌이 되고 전이(크롭 중 텍스트 선택 등)가 갈린다 |

바는 캔버스 스테이지 위 44px(시안 `Context Bar [·×44]`), 42 셸이 슬롯을 준다(42 §3.8 그리드 — stage 열 상단). 액션은 전부 `ImageEditor`의 **액션 맵**(§4 `EditorActions`)을 부른다 — 단축키(42 표)와 버튼이 같은 함수를 공유해 두 경로가 갈리지 않는다.

### 3.3 인스펙터 4탭 — 항상 마운트 + `hidden`

| 탭 | 섹션(위→아래) | 소유 |
|---|---|---|
| 속성 | 정렬 · 분배 → 위치 · 크기 → 모양 → 채우기 → 선 → 효과 → (vector-edit면 46 `PathInspectorSection`이 채우기/선 자리를 대체) → 내보내기 행(52 `ExportSection`) | 45 (+46·52) |
| 텍스트 | 50 `TextInspector` 통째(텍스트 스타일 · 타이포그래피 · 정렬 · 장식/대소문자 · OpenType · 채우기 · 선 · 효과 · 미리보기). 채우기/선/효과 섹션은 이 태스크의 `StackList`를 50이 재사용 | 50 |
| 조정 | **변형**(기존 `rotateBy/flipBy` 4버튼, title 유지 — e2e 30 (c)) → 크롭(48 `CropInspectorSection`) → 마스크 → 스냅 · 가이드(43 토글) → 픽셀 미리보기(40/42 `pixelPreview`) → **색 보정 3 슬라이더**(기존, INDEX §10.3 결정) → **출력 크기 W×H·비율**(기존 `changeW/changeH`). 탭 상단 캡션 `이미지 전체에 적용`(선택 대상별 규칙과 어긋나 보이는 것을 막는다) | 45 (+48·43) |
| 내보내기 | **저장 포맷 4 + 품질**(기존 `FORMATS`·`quality` — 푸터 `저장 (PNG)` 라벨의 출처) → 52 `ExportSection`(노드 내보내기 행·프리셋·`내보내기…`) | 45 (+52) |

`변형·색 보정·출력 크기·포맷`은 시안 ⑦ 조정 탭에 **없는** 라벨이다 — 기존 기능(e2e 30 (b)(c)·`A.ready`의 `outW>0`)을 후퇴시키지 않기 위해 유지하고 문서에 그렇게 적는다. 시안 밖 8슬라이더·필터 6·자동수평은 넣지 않는다(INDEX §10.3).

hidden 마운트를 택한 이유: e2e 30이 `A.btn(/오른쪽 90/)`을 **탭 상태와 무관하게** 클릭한다(30:825). 조건부 마운트면 속성 탭이 열린 채 `null`을 돌려준다. 비용은 DOM 4탭분(≈300노드)이고 리렌더는 선택 변경·커밋 시점뿐(§3.4 필드는 로컬 state).

푸터: `초기화 · 복사 · 다른 이름으로 · 저장 (PNG)` — 기존 핸들러 4개 그대로(`resetAll/copyToClipboard/saveAs/saveInPlace`), 라벨은 `저장 (${FORMATS.label})`. `취소`는 없앤다(닫기 = 42 타이틀바 X·Esc 계층; e2e 30/34/35에 `/취소/` 클릭 0건 — grep).

### 3.4 필드 프리미티브 — `NumField`·`StackList`·`Select`·`Toggle`

| 입력 | 문서 반영 | 히스토리 |
|---|---|---|
| 타이핑 | 로컬 state, **Enter/blur**에 `patchDoc(…, 'commit', label)` | 1칸 (현 `NumInput onBlur=onEnd` 규칙 `:1364-1384`) |
| 스크럽(라벨 pointer 드래그, `setPointerCapture`) | 틱마다 `patchLive`, up에 `endLive`. Shift ×10, Alt ×0.1 | 드래그 1회 = 1칸(`:261-270`) |
| ↑/↓ (Shift ±10) | `patchDoc` 즉시. `ev.repeat` 무시 | keydown 1회 = 1칸(K5, `AnnotationLayer.tsx:690-698` 규칙 승계) |
| Mixed 상태 | 타이핑 = 전체에 절대값, 스크럽/방향키 = **각 객체 현재값 + Δ**(상대 델타) | 위와 동일 |

단위 접미(`px`·`%`·`°`)는 표시만, 수식(`+10`, `*2`)은 없다(시안에 없음). `StackList<T>`는 채우기/선/효과가 공유하는 행 목록: 헤더 `+`, 행마다 `눈`(visible)·`−`(제거)·`설정`(효과) — 배열 조작만 하고 `applyPaintPatch(node, {fills|strokes|effects})`로 커밋. 렌더는 39. `Select`는 `Popover` 위의 단일 선택 목록(정렬·대시·캡·조인·제약·블렌드), `Toggle`은 시안 `Switch 24×14`.

### 3.5 정렬·분배·간격 정리·반전/회전 — `align.ts`

| 연산 | 구현 | 근거 |
|---|---|---|
| `alignObjects(objects, ids, mode, keyId)` | 대상 AABB(리프 `objectAABB`, 컨테이너 `nodeAABB` 38)를 기준 AABB에 맞춰 `translateSubtree`(38). 기준 = `keyId`(선택 순서 마지막, 시안 ⑧ `마지막 선택 기준`), 단일이면 캔버스 `(0,0,ow,oh)` | `geometry.ts:337-356`, 회전·스케일 없음 → 기하 코드 0 |
| `distributeObjects(objects, ids, axis)` | ≥3, 양 끝 고정, 중심 등간격 | 시안 `3개 이상 · 균등 간격` |
| `tidyObjects(objects, ids, gap)` | `'auto'` = 현재 평균 간격, 숫자 = 지정(시안 `균등 24`). 바 버튼은 `ui.tidyGap`(기본 `'auto'`), 인스펙터 `간격` 필드가 그 값을 편집 | 시안 ① `간격 24 · 정리` |
| `flipNodes(objects, ids, axis)` | 선택 AABB 중심 `c`에 대해 **`transformObjects(selected, 'flipH'|'flipV', 2·cx, 2·cy)`** — 그 함수의 사상이 `x → W − x`라 `W=2cx`면 AABB가 제자리에서 뒤집힌다. text/badge는 `rot` 부호 반전(`:522-523`)·글리프는 안 뒤집힌다(`ponytail:` 캔버스가 글리프 미러를 못 한다 — 읽히는 쪽이 낫다) | `geometry.ts:484-531` 재사용, 신규 수학 0 |
| 회전 ±90 | `rotateNodes(objects, ids, ±90, selectBox 중심)` | 38 §4 |

`tidy`의 등간격 계산은 선택 정렬 후 인접 O(N) — 선택 수백 개 이하라 상한 불필요.

### 3.6 위치·크기·각도·반경·제약·모양

- X/Y/W/H/각도: `setObjectFrame(node, partial)`(38, 피벗 = `objectAnchor`). `비율 잠금`(시안 `Btn 비율 잠금`): W 입력 시 H = W·h/w — 잠금 상태는 `ui` 필드(문서 아님, 기본 off; 기존 출력 크기 `lockRatio :208`와는 별개 노드 속성).
- 반경: `radius` 4-tuple(37). `반경` 필드 = 4곳 동일값(다르면 Mixed), `개별 반경` 토글로 `↖↗↘↙` 4필드 펼침. rect·frame에만(`readProp` undefined → 숨김).
- 제약(`좌·상 고정`): `Select`로 `constraints.h × v` 5×5 — 적용 시점은 프레임 리사이즈(38 `applyConstraints`), 여기서는 값만 쓴다.
- 모양: 불투명도(`NodeBase.opacity`, 0~100%), 블렌드(BlendMenu 19, 컨테이너 아니면 `pass-through` 항목 비활성 — 37 정규화 규칙), `마스크로 사용 (클리핑)` 토글 = `tree.makeMask/releaseMask`(38) — 그룹 감싸기까지 그 함수가 한다.
- 이동/복제/삭제/그룹/해제/순서: 액션 맵이 38 `tree.*`·`translateSubtree`·`remove`·`reorder`를 부른다 — `objects`를 직접 만지지 않는다(INDEX §10.4).

### 3.7 `Popover` 프리미티브

| 대안 | 평가 |
|---|---|
| **A. 신규 120줄: 앵커 rect 기준 `fixed` 배치, 뷰포트 플립(placement 3종), 바깥 클릭/Esc 닫기, `useOccludesWebview(true)`, 열린 팝오버 스택(`popoverStack`)** (채택) | 기존 메뉴 패턴(`ViewerFileTabs.tsx:121-132`)은 좌표 클램프뿐이라 앵커·플립·폭이 없다. QuickPick은 전면 모달 |
| B. floating-ui 도입 | 필요한 건 플립 1축(인스펙터 폭 320 안)뿐 — 신규 의존 근거 부족(INDEX §10.4) |
| C. 기존 `fixed inset-0 z-50` 백드롭 메뉴 재사용 | 8종이 각자 클램프를 복제한다. 그라디언트 핸들처럼 **열린 채 캔버스와 상호작용**해야 하는 팝오버는 백드롭이 포인터를 막아 성립하지 않는다 |

- 배치: 편집기 루트(`fixed inset-0 z-50`) 안의 `fixed` 요소 — 같은 스택 컨텍스트라 확인창 `z-[60]`·토스트 `z-[55]` 아래, 편집기 위. `z-[60]`을 쓰지 않는다(34 `A.overlay` 오탐 방지). doc 창 `top:32`는 루트가 이미 비켜 준다.
- 닫기 규칙: 바깥 `pointerdown`(캡처)·Esc·앵커 재클릭. **캔버스 상호작용 팝오버**(그라디언트 편집기·아이드로퍼)는 `modal:false` — 바깥 클릭이 닫지 않고 캔버스가 포인터를 받는다(그라디언트 핸들 드래그 → 43 `onPointerHit`).
- Esc: 42 키 스코프의 **0단계**가 `closeTopPopover()`를 부른다(42 §4에 요청). 팝오버가 열린 동안 42 캡처 리스너는 Esc 외 편집기 단축키를 **통과**시킨다(`hasOpenPopover()` — Delete가 팝오버 안 텍스트 선택을 지우는 사고 방지).
- 포커스: 열릴 때 첫 입력에 포커스, 닫힐 때 편집기 루트(42 `tabIndex=-1`)로 복귀.

### 3.8 팝오버 8종

| 팝오버 | 콘텐츠 | 결정 |
|---|---|---|
| **색 피커** | 헤더 `채우기 · 단색`(슬롯명·페인트 종류) + `설정`(아이콘 — 모델 기본값·최근 색 지우기) + ✕ · SV 사각형 캔버스 160×120 + Hue/Alpha 슬라이더(캔버스 2장, **열릴 때만 생성**) · 아이드로퍼 버튼 · `HEX/RGB/HSL` 탭 + hex 입력 + 알파 `%` · `최근 사용` 8칸(스토어 `recentColors` 상한 12) · `문서 색상` 8칸(37 `documentColors(doc)`) · `색 스타일로 저장`(51 `saveStyleFromNode`) | 알파는 `Fill.opacity`로(색 문자열은 `#rrggbb` 유지 — e2e RED/BLUE 상수·PALETTE 전제). `<input type=color>`는 탈락: WebView2 네이티브 다이얼로그가 별창이라 HSL·알파·최근 색을 못 얹는다 |
| **그라디언트 편집기** | 헤더 `채우기 · 그라디언트` + `shuffle`(스톱 순서 반전 = `pos → 1−pos`) + ✕ · 종류 4(선형/방사/원뿔/다이아) · 미리보기(39 `gradientOf`로 오프스크린 1장) · 스톱 바(클릭 = 스톱 추가, 드래그 = `pos`, 행 `Del`) · 각도 다이얼 + `각도/스케일` 필드 · 캔버스 핸들(시작/끝 점 + 스톱 점)은 43 `ChromeState.extra` 프리미티브로 그리고 `onPointerHit`으로 드래그 선점 | 핸들이 `renderScene` 밖(SVG 크롬)이라 저장에 못 샌다. 스톱 색 편집은 색 피커를 **중첩**(스택 2단) |
| **블렌드 목록** | 19항목, 시안 그룹 구분선 5(`[패스스루·표준] [어둡게·곱하기·색상 번·선형 번] [밝게·스크린·색상 닷지·선형 닷지] [오버레이·소프트·하드] [차이·제외] [색조·채도·색상·광도]`), 현재값 체크. `pass-through`는 컨테이너 선택에서만 활성 | 라벨↔enum 표 `BLEND_LABELS`(§4) 한 곳 — 인스펙터·컨텍스트 바·효과 편집이 공유 |
| **효과 편집** | 헤더 `드롭 섀도` + `눈` + `−` · 미리보기 칩(39 `dropShadow`로 96×44 오프스크린) · X/Y · 흐림/확산 · 색 스와치(색 피커 중첩) + 알파 · 종류 `드롭/이너`(블러 계열은 `반경` 1필드) | 시안 `Blend "곱하기"` 행은 37 `Effect`에 `blend`가 없어 **렌더하지 않는다** → 열린 질문(§3.10) |
| **아이드로퍼** | `I` 또는 색 피커의 스포이드 버튼 → 42 `setTool('eyedropper', {temporary:true})`. 포인터 따라 다니는 카드: 11×11 확대경(중심 셀 강조, 시안 `Magnifier 176` — 시안의 8×8은 삽화, 중심 셀이 필요해 홀수) + 판독 `#2B6CB0 · 1284, 742`(oriented px) + `클릭 = 색 추출 · Esc = 취소`. 픽셀은 씬 캔버스 `[1]`의 백킹 좌표에서 `getImageData(11×11)` 1회/rAF — 39 병합 뒤 `[1]`은 이미지+노드 합성이라 보이는 색 그대로 | 클릭 → 호출자 콜백(채우기/선/효과 색) + `restoreTool()`, Esc → 콜백 없이 복귀. `ponytail:` 확대 중(40 디테일 캔버스 활성)에는 백킹 해상도 픽셀을 보여 준다 — 원본 픽셀이 필요하면 `[2]`에서 샘플 |
| **폰트 피커** | 50 `FontPicker` 콘텐츠(폰트 검색·전체/한글/산세리프/세리프/모노/최근·미리보기 `가나 Ag 123`·굵기 6단) | 셸만 이 태스크 |
| **색 스타일 라이브러리** | 51 `StyleLibrary({mode:'popover'})` 콘텐츠(스타일 검색·그룹·적용됨) | 셸만 이 태스크 |
| **레이어 타입 필터** | 44 | 44가 `Popover`를 import |

### 3.9 커밋 라벨(41 `describeChange` 폴백 위)

사이트가 아는 곳은 명시: `정렬 왼쪽`·`수평 분배`·`간격 정리 24`·`X 330`·`W 220`·`각도 45°`·`반경 8`·`채우기 F0398B`·`채우기 추가`·`선 3B82F6`·`두께 2`·`효과 추가 드롭 섀도`·`드롭 섀도 흐림 16`·`불투명도 50%`·`블렌드 곱하기`·`좌우 반전`·`90° 회전`·`마스크로 사용`·`그룹`·`그라디언트 각도 135°`. 스크럽 라이브 구간은 첫 커밋 라벨을 유지(`patchLive`가 replace라 라벨 불변).

### 3.10 만들지 않는 것 · 미해결

- 레이어 패널·타입 필터 콘텐츠(→ 44), 툴 레일·타이틀바·상태바·단축키 표·키 스코프(→ 42), 스냅 계산·크롬 SVG(→ 43), 패스 인스펙터·불리언(→ 46), 노드 편집 바(→ 47), 크롭 바/섹션(→ 48), 텍스트 탭·폰트 피커 콘텐츠(→ 50), 스타일/컴포넌트 저장·색 스타일 콘텐츠(→ 51), 내보내기 행·모달(→ 52).
- 시안 밖: 조정 8슬라이더·필터·자동수평, 필드 수식, 색 피커 색상 모델 추가(LAB 등), 팝오버 드래그 이동/도킹, 이미지 컨텍스트 바 `채우기·맞춤·늘이기`(INDEX §10.5).
- **미해결(37에 질문)**: 시안 ④ 효과 편집의 `Blend "곱하기"` — `Effect` 타입에 `blend?: BlendMode`가 없다. 기본값: 렌더하지 않음. 37이 필드를 추가하면 `EffectEditor`에 `Select` 1행 + 39 `dropShadow`가 gCO로 적용(순증).
- **반영됨(42 §4)**: `ui.inspectorTab`·`inspectorTabManual`·`tidyGap`·`ratioLock`·`recentColors` 스토어 필드 5개 + Esc 0단계(42 §3.2 — `useEditorKeys` 의 `popoverOpen` 게이트가 `hasOpenPopover()`·`closeTopPopover()` 를 부른다). `classifySelection/MIXED/readProp` 은 42 `selection.ts` 소유, 분류 규칙 본문(§3.1)만 이 태스크가 채운다.

## 4. 계약 (소유: 45)

```ts
// src/lib/annotate/selection.ts — 42 소유(42 §4): SelectionKind · classifySelection · MIXED · Maybe · readProp 은 import 만. 분류 규칙(§3.1 표)은 이 태스크가 42 파일 안에 채운다(+≈60)
// src/lib/annotate/blend-labels.ts (45)
export const BLEND_LABELS: readonly { value: BlendMode; label: string; group: number }[];   // 19, 시안 ④ 순서·그룹 5구분

// src/lib/annotate/align.ts (순수 — translateSubtree/objectAABB/nodeAABB/transformObjects 만 쓴다)
export type AlignMode = 'left'|'hcenter'|'right'|'top'|'vcenter'|'bottom';
export function alignObjects(objects: readonly Node[], ids: readonly ObjId[], mode: AlignMode, keyId: ObjId | null, canvas: Rect): Node[];  // keyId null = 캔버스 기준
export function distributeObjects(objects, ids, axis: 'x'|'y'): Node[];                  // ids.length < 3 → 항등
export function tidyObjects(objects, ids, gap: number | 'auto'): Node[];
export function flipNodes(objects, ids, axis: 'h'|'v'): Node[];                          // transformObjects(sel, flip, 2cx, 2cy)

// src/lib/color.ts (readableOn 을 render.ts:294-310 에서 이관, render 는 import)
export function hexToRgb(hex): [r,g,b] | null;  rgbToHex;  rgbToHsl;  hslToRgb;  rgbToHsv;  hsvToRgb;  readableOn(bg): string;  normalizeHex(input): string | null;

// src/components/image/ContextBar.tsx
export function ContextBar(p: { kind: SelectionKind; actions: EditorActions }): JSX.Element;   // text/vector-edit/crop 은 50/47/48 컴포넌트 마운트

// src/components/image/inspector/Inspector.tsx — 4탭 항상 마운트, 비활성 탭은 hidden
export function Inspector(p: { actions: EditorActions }): JSX.Element;      // 탭 버튼 role="tab" aria-selected · 패널 [data-inspector-tab="props|text|adjust|export"]
// PropsTab.tsx · AdjustTab.tsx · ExportTabHost.tsx(포맷/품질 + 52 ExportSection) · InspectorFooter.tsx(기존 핸들러 4)

// src/components/image/inspector/fields/
export function NumField(p: { label: string; value: Maybe<number> | undefined; unit?: 'px'|'%'|'°'; min?; max?; step?;
  onCommit(v: number): void; onLive?(v: number): void; onLiveEnd?(): void; onDelta?(d: number, live: boolean): void /* Mixed 상대 델타 */ }): JSX.Element | null;  // value undefined → null
export function StackList<T>(p: { title: string; items: T[]; render(item: T, i: number): React.ReactNode; onAdd(): void; onToggle(i): void; onRemove(i): void; onOpen?(i, anchor: HTMLElement): void }): JSX.Element;
export function Select<V>(p: { value: Maybe<V>; options: { value: V; label: string; disabled?: boolean }[]; onChange(v: V): void }): JSX.Element;
export function Toggle(p: { checked: boolean | typeof MIXED; label: string; onChange(v: boolean): void }): JSX.Element;

// src/components/image/popovers/Popover.tsx
export function Popover(p: { anchor: DOMRect | HTMLElement; open: boolean; onClose(): void; placement?: 'bottom-start'|'left-start'|'right-start'; width?: number; modal?: boolean /* 기본 true; false = 바깥 클릭 통과 */; title?: React.ReactNode; children: React.ReactNode }): JSX.Element | null;
export function closeTopPopover(): boolean;   // 42 Esc 계층 0단계
export function hasOpenPopover(): boolean;    // 42 키 스코프 — 열린 동안 Esc 외 통과
// popovers/ColorPicker.tsx · GradientEditor.tsx · BlendMenu.tsx · EffectEditor.tsx · Eyedropper.tsx
export function ColorPicker(p: { title: string; paint: Extract<Paint,{type:'solid'}>; onLive(p: Paint): void; onCommit(p: Paint): void; onSaveStyle?(): void }): JSX.Element;
export function GradientEditor(p: { paint: Extract<Paint,{type:'linear'|'radial'|'angular'|'diamond'}>; bbox: Rect; onLive; onCommit }): JSX.Element;   // 핸들 → ChromeState.extra(43 §4) · onPointerHit(43 §4)
export function BlendMenu(p: { value: Maybe<BlendMode>; container: boolean; onChange(v: BlendMode): void }): JSX.Element;
export function EffectEditor(p: { effect: Effect; onLive(e: Effect): void; onCommit(e: Effect): void; onRemove(): void; onToggle(): void }): JSX.Element;
export function useEyedropper(): { start(onPick: (hex: string) => void): void }   // setTool('eyedropper',{temporary:true}) → [1] 11×11 샘플 → restoreTool()

// ImageEditor.tsx — 액션 맵(단축키 42 표와 버튼이 같은 함수)
export interface EditorActions {
  patchSelection(patch: Partial<DefaultPaint> & { opacity?; blend?; name?; visible?; locked?; constraints?; radius? }, label: string, live?: boolean): void;  // applyPaintPatch(37) 경유
  setFrame(id: ObjId, f: Partial<{x;y;w;h;rot}>, label: string, live?: boolean): void;                      // setObjectFrame(38)
  align(mode: AlignMode): void; distribute(axis: 'x'|'y'): void; tidy(gap: number | 'auto'): void;
  flip(axis: 'h'|'v'): void; rotate(deg: 90 | -90): void;                                                    // 선택 대상 — flipNodes / rotateNodes(38)
  group(kind: 'group'|'frame'): void; ungroup(): void; mask(on: boolean): void; duplicate(): void; remove(): void;   // tree.*(38)
  boolean(op: BoolOp): void;                                                                                 // → 46 booleanOp
  rotateImage(plus90: boolean): void; flipImage(axis: 'h'|'v'): void;                                       // 기존 rotateBy/flipBy(이미지 전체)
}
```

e2e 훅(`window.__gpv.imageEditor`, 42 `getUi()` 옆): `inspector(): { tab: 'props'|'text'|'adjust'|'export'; popover: string | null }` · `classify(): SelectionKind` · `actions: EditorActions`(DEV 전용).

파일: `src/lib/annotate/selection.ts`(42 소유 — `classifySelection` 본문 +≈60) · `blend-labels.ts`(≈30) · `align.ts`(≈140) · `src/lib/color.ts`(≈120, `render.ts` −17) · `src/components/image/ContextBar.tsx`(≈280) · `inspector/Inspector.tsx`(≈90) · `PropsTab.tsx`(≈400) · `AdjustTab.tsx`(≈220) · `ExportTabHost.tsx`(≈70) · `InspectorFooter.tsx`(≈60) · `fields/NumField.tsx`(≈120) · `StackList.tsx`(≈90) · `Select.tsx`(≈70) · `Toggle.tsx`(≈30) · `popovers/Popover.tsx`(≈120) · `ColorPicker.tsx`(≈280) · `GradientEditor.tsx`(≈240) · `BlendMenu.tsx`(≈60) · `EffectEditor.tsx`(≈160) · `Eyedropper.tsx`(≈150) · `ImageEditor.tsx`(aside `:1121-1273`·푸터 `:1277-1315`·`onStyleChange/onOpacityChange :626-652`·`Section/IconBtn/NumInput/Slider :1321-1420` 삭제 ≈ −330, 액션 맵·훅 +120) · `tests/e2e/suites/40-image-editor-pro-ui.mjs`(+≈320, 42/43/44와 공유 스위트).

## 5. 단계

1. **속성 탭**: 42 `selection.ts`에 `classifySelection` 규칙 채움·`blend-labels.ts`·`align.ts`·`color.ts`·필드 4종·`Inspector` 셸(hidden 4탭)·`PropsTab`(정렬/분배·위치/크기·모양·채우기/선/효과 `StackList`)·`InspectorFooter`·액션 맵. 기존 aside/푸터를 이 자리로 이관, `AnnotationToolbar` 삭제는 42가 이미 했으므로 42의 임시 인스펙터 자리를 교체. 30/34/35 초록(`/오른쪽 90/`은 `AdjustTab` 자리에 임시로 변형 4버튼만 두어 hidden 마운트).
2. **컨텍스트 바** 7변형 셸 + none/single/multi/image 콘텐츠 + 42 슬롯 배선. text/vector-edit/crop은 해당 태스크 컴포넌트가 없으면 `Sel Info` 라벨만(빈 껍데기 금지 — 없는 기능은 안 보인다).
3. **조정 탭·내보내기 탭 호스트**: 변형·마스크·스냅/가이드(43 토글)·픽셀 미리보기(42 `pixelPreview`)·색 보정 3·출력 크기 + 포맷/품질 이관, 캡션.
4. **팝오버**: `Popover` + 색 피커·그라디언트(핸들은 43 `extra` 계약 확정 뒤)·블렌드·효과 편집·아이드로퍼 + 폰트/스타일 슬롯. e2e 40 (ins-*) 전부.

규모 **XL**: 프론트 ≈ +2,900/−350 · Rust 0 · 신규 의존 0. 커밋 4개, 각 커밋 뒤 30(91)·34(32)·35(13) 초록.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| 팝오버가 열린 채 편집기 키가 먹음 | Delete가 팝오버 안 텍스트가 아니라 객체를 지운다 | `hasOpenPopover()`면 42 캡처 리스너가 Esc 외 통과. e2e (ins-9) |
| hidden 탭이 이벤트를 받음 | 숨은 탭의 NumField가 포커스를 갖거나 스크럽이 반응 | `hidden` 속성 + `inert`(Chromium 102+, WebView2 가용) — `.click()`(e2e)은 `inert`에서도 프로그램적으로 동작함을 1단계 첫 실행에서 확인, 막히면 `hidden`만 |
| Mixed 스크럽 상대 델타가 범위를 넘김 | 반경 4/8에 −5 → 음수 | 각 객체별 clamp(`min/max`), 라벨은 Δ 표기 |
| 39 전 착수 | 다중 페인트·효과가 "문서엔 있는데 안 보임" | M3(45)는 M1(39) 뒤 — 순서 고정(INDEX §10.1). 스택 UI는 39 렌더 결과를 전제 |
| 그라디언트 캔버스 핸들 | 43 §4 `registerPointerHit`(선점 훅) + `ChromeState.extra` 로 확정(정합 검사 결정) — 팝오버 열림 동안 등록, 닫힘에 해제 | 각도/스케일 **필드**로도 전 기능 도달 — 핸들은 순증 |
| 색 피커 캔버스 상시 상주 | doc 창 5개 × 3장 | 열릴 때만 생성, 닫히면 `width=0`(창당 ≈80KB라 사소하나 관례) |
| 아이드로퍼가 확대 중 백킹 픽셀을 보여 줌 | 원본 픽셀과 다를 수 있다(1800 백킹) | `ponytail:` 명시, 필요 시 40 `[2]`에서 샘플 |
| `flipNodes`가 그룹 회전 메모를 모름 | 그룹은 기하가 없어 리프에 굽는다(38) | 대상은 `resolveScene` 리프 슬라이스 — 컨테이너는 `subtreeRange`로 펼쳐 넘긴다. (ins-6) 두 번 반전 = 항등 |
| 조정 탭 기능이 "선택 대상별" 규칙과 어긋나 보임 | 이미지 전체 조작 | 상단 캡션 `이미지 전체에 적용` |
| 컨텍스트 바 폭 부족(doc 창 900) | 버튼 30개가 한 줄에 안 들어감 | 우선순위 접기(뒤쪽 그룹부터 `…` 메뉴로) — 42 셸이 폭을 준다 |

## 7. 검증

- **e2e 40 `40-image-editor-pro-ui.mjs` (ins-*)**: (ins-1) 선택 0/1(rect)/1(text)/2/3에서 `[role=toolbar]` 버튼 title 집합이 §3.1 표와 일치(3개 → `수평 분배` 존재, 2개 → 없음; text → `inspector().tab==='text'` 자동 전환, 수동 탭 클릭 후 유지). (ins-2) 정렬: rect(40,40,60,60)·rect(150,100,80,30) 마지막 선택 2번 → `actions.align('left')` → 1번 `x===150`, 2번 불변, 히스토리 라벨 `/정렬/`, Ctrl+Z 원복; 분배 3개 → 중심 간격 동일 ±0.5; `tidy(24)` → 인접 간격 전부 24. (ins-3) Mixed: radius 4/8 두 rect → 반경 필드 `value===''`·placeholder `혼합`; `12`+Enter → 둘 다 `[12,12,12,12]`·히스토리 1칸; 스크럽 +5 합성(pointerdown 라벨 → move) → 9/13(상대 델타)·up 후 1칸. (ins-4) X 필드 100 → `objects[0].x===100`(`setObjectFrame` 경유); W Shift+↑ → +10·1칸; `ev.repeat` 무시. (ins-5) 채우기 `+` → `fills.length===2`; 눈 → `fills[1].visible===false` → 프리뷰 픽셀 == 저장 픽셀(39); `−` → 1개. (ins-6) `flip('h')` 두 번 → 좌표 딥이퀄·AABB 불변; `rotate(90)` → `rot===90`. (ins-7) 색 피커: 스와치 클릭 → `[role=dialog]` 등장·뷰포트 안; HEX `0A84FF`+Enter → `fills[0].color==='#0A84FF'`·1칸; 알파 50 → `fills[0].opacity===0.5`; Esc → 닫힘·문서 불변; 바깥 클릭 → 닫힘; `문서 색상` 칸 수 == `documentColors(doc).length`(≤8). (ins-8) 블렌드 메뉴 항목 19·`곱하기` → `blend==='multiply'`; 리프에서 `패스스루` disabled. (ins-9) 팝오버 열린 채 `Delete` 디스패치 → 객체 수 불변. (ins-10) 아이드로퍼: `I` → `getUi().tool==='eyedropper'`, 캔버스 (100,100) 클릭(빨강 rect 위) → 대상 fill `#FF3B30`·도구 `select` 복귀; Esc → 색 불변. (ins-11) 그라디언트: 종류 `선형` → `fills[0].type==='linear'`, 각도 필드 135 → `angle===135`, 스톱 바 클릭 → `stops.length===3`, `shuffle` → `pos` 반전; 43 계약 있으면 SVG 핸들 `[data-chrome=extra]` 존재·저장본에 핸들 색 0. (ins-12) 효과 편집: `효과 +` → 드롭 섀도 행, `설정` → 팝오버, 흐림 16 → `effects[0].blur===16`, `−` → 0개. (ins-13) 조정 탭: `A.btn(/오른쪽 90/).click()`이 속성 탭이 활성인 상태에서 회전(hidden 마운트 증명); `마스크 만들기` → `objects` 중 `mask!==null` 1개(38 `makeMask`). (ins-14) 푸터 4버튼 라벨이 `/초기화/ /복사/ /다른 이름으로/ /저장 \(/`에 잡히고 `/취소/` 버튼 0개.
- **회귀**: 30(91)·34(32)·35(13) 단언 수·pass 동일(헬퍼 무수정) — 커밋 1·2·3·4 뒤 각각.
- **컴파일**: `objects.splice`·`restyle`·`ToolStyle` 참조가 `src/components/image` 안에 0건(grep), `ContextBar`가 `Node['kind']` 대신 `SelectionKind`만 분기.
- **실기**: doc 창 1180×860·900×760에서 인스펙터 320 + 컨텍스트 바 접힘; 3개 선택 → 정렬/분배/간격 정리 → 스마트 가이드(43)와 결과 일치; 색 피커 HSL 왕복 오차 0(`#F0398B` → HSL → hex 동일); Mac은 팝오버 Esc·Cmd 표기만 확인(키 표는 42).
