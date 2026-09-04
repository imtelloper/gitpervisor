# 태스크 49 — 텍스트 레이아웃 엔진(줄바꿈·정렬·목록·말줄임·박스 모드)·렌더·textarea 메트릭 계약·Mixed

> 상태: 설계(Design) · 대상: gitpervisor · 근거: 코드 실측 2026-09-04(워킹트리) · 선행: 태스크 37(`TextNode = NodeBase & TextStyle`, `normalizeNode`, `annotation/textEdit.ts` 분할),
> 38(`hitTest`·`objectFrame/setObjectFrame`·`buildObjectPath` WeakMap), 39(`renderScene v2`·`drawText` 페인트/효과 래퍼), 42(`MIXED`/`readProp`), 43(`ChromeState.extra`) ·
> `DOCS/image-annotation-design.md` §5.5(textarea 오버레이·폰트 일치 계약 — 이 문서가 메트릭 계약으로 확장), `DOCS/pro-image-editor-design.md` §8 :403(정렬·자간 기각 — 사용자 결정으로 대체) ·
> 시안: `designs/image-editor-figma-v2.pen` ②(인스펙터 텍스트)⑧(텍스트 컨텍스트 바) · 상위: `00-INDEX.md` §10 — **M4 텍스트 레인 첫 태스크(50이 이 위에 폰트·OpenType을 얹는다).**

## 1. 요구사항

시안 ② 인스펙터 텍스트 `타이포그래피 · Pretendard · Regular · 크기 14 · 행간 150% · 자간 -0.2 · 문단 간격 8 · 들여쓰기 0 · 정렬 · 자동 폭 · 자동 높이 · 고정 · 장식 · 대소문자 · 말줄임 · 2줄 · 미리보기`,
같은 프레임의 아이콘 행(`.pen` 노드명 — 텍스트 라벨이 없어 인벤토리에는 빠져 있다): `S align-left · align-center · align-right · align-justify`(정렬 4), `S fold-vertical`(세로 정렬 메뉴 — 37 `valign` 3값),
`S underline · strikethrough · superscript · subscript`(장식), `S case-sensitive · case-upper · case-lower`(Aa/AA/aa), `S list · list-ordered · list-todo`(목록), `S indent-increase · indent-decrease`(들여쓰기 in/out),
`Resize Row`(자동 폭/자동 높이/고정), `Trunc Row`(말줄임 2줄). ⑧ 컨텍스트 바 `텍스트 · Noto Sans KR · Regular · Bold · 크기 14 · 행간 150%`, `다중 선택 (3) · 3개 선택`(Mixed). ① 레이어 `측정값 오차 ±0.2mm`(여러 줄·박스 텍스트가 캔버스 위에 있다).

받아들이는 조건:
- 텍스트 노드가 **박스 안에서 줄바꿈**된다(한글 어절·영문 단어 경계, 박스보다 긴 토큰은 강제 분할). 자동 폭/자동 높이/고정 3모드가 리사이즈 핸들로 전환된다.
- 정렬 4(왼쪽·가운데·오른쪽·양쪽)·세로 정렬 3·행간(%)·자간(%)·문단 간격·들여쓰기·목록 3종(+레벨)·말줄임 N줄·대소문자·위/아래첨자·밑줄/취소선이 **렌더·히트·선택 상자·textarea 오버레이에서 같은 상자와 같은 줄**을 쓴다 — 한 산출물(`TextLayout`)을 네 소비자가 공유한다.
- 편집 중(textarea)과 확정 후(캔버스)의 첫 글자 위치가 **1px 이내**로 일치한다(현행 최대 5px 어긋남 — §2). 원 설계 §5.5 "확정 후 캔버스가 정본" 규칙은 유지한다.
- 다중 선택에서 값이 다른 타이포 필드는 `MIXED`로 읽힌다(42 `readProp` 규칙) — 인스펙터(50)가 '—'를 그릴 수 있다.
- e2e 30 (k)(텍스트 도구 → textarea → Esc 확정 → `text==='e2e'`)가 무변경으로 통과하고, 30/34/35 기준선(91/32/13)이 그대로다.
- 이 태스크만 머지해도 쓸 수 있다: 인스펙터 UI 없이도 `setDoc`으로 넣은 v2 타이포 필드가 전부 보이고, 기존 텍스트 도구 흐름(클릭·입력·확정·더블클릭 재편집·리사이즈)이 그대로 동작한다.

## 2. 현황(근거)

- **레이아웃은 `split("\n")` + `measureText`뿐**: `geometry.ts:123-133 layoutText` — `lines = text.split("\n")`, 줄마다 `measureText().width`의 최대값, `lineHeight = fontSize × TEXT_LINE_HEIGHT(1.25)`(`types.ts:201`). `TextLayout{lines:string[]; lineHeight; width; height}`(`:115-120`). 줄바꿈·정렬·자간·문단 간격·목록·말줄임·박스 모드 — **전부 없다**. `TextObject`(`types.ts:88-95`)에는 `w/h`가 없어 박스 개념 자체가 없다(37이 `TextNode`에 `w,h` + `TextStyle` 24필드를 넣는다).
- **소비자 3곳이 같은 `layoutText`를 믿는다**: 히트 `buildObjectPath` `:223-226`(`p.rect(o.x,o.y,m.width,m.height)`), 바운딩 `objectBBox` `:302-304`, 렌더 `render.ts:263-272 drawText`(`textBaseline="top"`, `fillText(line, o.x, o.y + i·lineHeight)`, `fillStyle = o.stroke`), 편집 `AnnotationLayer.tsx:780-802 editBox`(`layoutText({...obj, text: text || " "})`, 폭 `m.width + fontSize`). pro 설계 §8 :403이 정렬·자간을 기각한 이유가 정확히 이것("3곳을 동시에 흔든다") — 사용자 결정으로 기각이 대체됐으므로 **3곳을 한 커밋에** 바꾼다(§5).
- **세로 메트릭이 어긋난다**: 캔버스는 `textBaseline="top"`(`render.ts:268`) + 줄 간격 `fontSize×1.25`, textarea는 CSS 라인박스(half-leading). `editBox`가 `halfLeading = (lh − fs)/2`(`:787`)를 `top`에서 빼 근사한다(`:790`, `:799 originY`). text 축 제안의 CDP 프로브(2026-09-04, WebView2 Chromium 152 — 이 문서 작성 세션에서 재실행하지 않았다, 착수 첫 단계 재확인 §5-0): 40px/line-height 50px에서 DOM 베이스라인이 Segoe UI 41 / Malgun Gothic 42 / Noto Sans KR 42 / Pretendard 39.3인데 현행 캔버스는 36 / 37 / 40 / 37 → **최대 5px**. `alphabetic` + CSS 라인박스 공식(§3.3)은 41.5 / 42 / 42 / 39 → ±0.5px.
- **Canvas 2D 가용 속성(같은 프로브)**: `ctx.letterSpacing/wordSpacing/fontKerning/fontVariantCaps/textRendering` 존재·동작(자간 10px×6자 = +60px, `wordSpacing` 20px로 'a b' 54.8→74.8), `ctx.font`은 `font-feature-settings`를 **거부**(대입 후 문자열 불변 → 50 fontkit 경로), `TextMetrics`에 `underlinePosition` 없음. 이 저장소 `src/` grep: `letterSpacing|wordSpacing|Intl.Segmenter|fontBoundingBox` **0건**, `textBaseline`은 `render.ts:268,289`·`AnnotationLayer.tsx:1061`(HUD)뿐.
- **텍스트 리사이즈 = 글자 배율**: `resizeObject`(`AnnotationLayer.tsx:1283-1346`) → `scaleObject`(`:1352-1396`) text 분기 `:1387-1394`가 `x,y` 이동 + `fontSize × √(fx·fy)`. 고정 폭 박스를 만들 방법이 없어 시안 ② `자동 높이 · 고정`에 도달할 수 없다.
- **편집 상태·확정**: `EditState{obj,isNew,text}`(`:136-142`), `beginEditing`(`:380-391`), `finishEditing`(`:359-378` — 끝 공백 trim, 빈 내용이면 삭제), 캔버스 클릭 시 확정(`:407`), 더블클릭 재편집(`:620-631`), 키 가드(`:643-652` 편집 중·INPUT/TEXTAREA 포커스면 통과), `ensureCache`가 편집 객체를 제외(`:223` — 39 `opts.skipId`와 같은 의미), textarea 마크업 `:821-853`(`whiteSpace:"pre"`, `fontFamily = obj.fontFamily`, `color = obj.stroke`, `rotate(rot)` + `transformOrigin 0 halfLeading`). 새 텍스트는 `:454-472`(`strokeWidth:0`, `fontFamily = FONT_FAMILY` `:867-868`). 37 §3.5가 이 블록을 `annotation/textEdit.ts`로 옮기고 소유를 49에 넘긴다.
- **툴바 동기**: `ImageEditor.tsx:603-618`이 단일 선택 시 `fontSize`만 끌어오고, `restyle`(`:152-172`)이 `fontSize`만 쓴다 — 37이 `applyPaintPatch/paintOf`로 대체하지만 **타이포 필드 슬롯이 없다**(37 §4 `DefaultPaint`에 `fontSize`뿐).
- **e2e**: 30 (k) `:1237-1264` — `setTool("text")` → `clickCanvas([[60,170]])` → `hasTextarea`(`:476-479`) → `typeText("e2e")`(`:485-497`, 네이티브 setter + input 이벤트) → Esc → `txt.text==="e2e"`. `kind:"text"` **리터럴은 30/34/35에 0건**(grep) — 텍스트 기하 좌표를 단언하는 케이스가 없어 레이아웃 변경이 기존 단언을 건드리지 않는다. 30 (n) `:1483-1526`은 rect로만 회전 리사이즈를 본다(주석의 text/badge 경로는 설명).
- **39 접점**: 39 §3.8 `drawText`는 "`layout.outline`(50)이 있으면 `fill(path)`, 없으면 `runs`를 `fillText`" — 페인트 스택·선·효과 래퍼는 39, **줄·런·장식·외곽선 정렬은 이 태스크**. 38 `buildObjectPath`는 `WeakMap<GeomNode,Path2D>` 메모 — 텍스트 경로(박스 rect)가 `layoutText`를 부르므로 레이아웃 캐시가 그 아래에 필요하다.

## 3. 설계

### 3.1 무엇으로 그리나 — **Canvas `fillText` 런 + 자체 줄 배치**

| 대안 | 평가 |
|---|---|
| **A. `fillText` 런(줄마다 1회) + 네이티브 `letterSpacing/wordSpacing/fontKerning`. 엔진은 줄 나눔·배치·마커·장식만** (채택) | 브라우저 셰이핑·힌팅·커닝을 그대로 쓴다. 폰트 바이트 불필요. 렌더 코드는 `fillText` 호출 위치가 바뀔 뿐 |
| B. SVG `foreignObject` 래스터 | `Image` 디코드가 비동기라 `renderScene` 동기 계약(39)이 깨지고, WebKit(macOS)은 foreignObject 이미지를 캔버스에 그리면 taint/미렌더 → Mac 저장 불능. 렌더 경로 2벌 |
| C. 전면 fontkit 글리프 패스 | 힌팅 없는 패스 AA가 11px 캡션에서 `fillText`와 달라 보이고 모든 텍스트에 폰트 파일(12~43MB)이 필요. 50이 **기능 켠 객체만** 이 경로로 — `TextLayout.outline` 슬롯이 그 접점 |

### 3.2 레이아웃 엔진 — `text-layout.ts layoutText(o): TextLayout` (동기·순수·LRU)

파이프라인(문단 = `\n` 분리): ① `textCase` 적용(`upper/lower` → `toLocaleUpperCase/LowerCase`; 저장 문자열은 불변) ② 토큰화 — **공백 경계에서만** 끊는다 ③ 줄 채우기 — 가용 폭 = `w − 마커열 − (첫 줄이면 indent)`; 토큰이 빈 줄에서도 넘치면 `Intl.Segmenter(undefined,{granularity:'grapheme'})`로 잘라 채운다(`forced:true`) ④ 정렬 — `left/center/right`는 줄 x 오프셋, `justify`는 줄별 `wordSpacing = 여분/공백수`(문단 마지막 줄·강제 분할 줄 제외 → 0) ⑤ 세로 배치(§3.3) + 문단 사이 `paragraphSpacing` ⑥ 목록 마커 ⑦ 말줄임 ⑧ 장식 위치 ⑨ `box`.

| 규칙 | 결정 | 탈락 |
|---|---|---|
| 줄바꿈 | 공백 경계 + 긴 토큰 그래핌 강제 분할 = Blink `word-break:keep-all; overflow-wrap:anywhere` **등가** → textarea에 같은 CSS를 걸면 미러가 같은 줄을 낸다. 닫는 괄호·마침표는 앞 어절에 붙어 있어 줄머리에 올 수 없다(금칙 흡수) | UAX#14 전체 구현: 클래스 표 수백 줄, Blink와 다른 결과를 낼 지점만 는다. `Intl.Segmenter` word 경계: 문장부호를 별도 세그먼트로 내 '세계 ,' 같은 줄머리 부호를 만든다 |
| 박스 모드 | `auto-width`: 폭 = 최장 줄(줄바꿈 없음, 문단만), `auto-height`: `w` 고정·높이 = 내용, `fixed`: `w,h` 고정 — `box = {0,0, w_eff, max(h, contentH)}`(넘치면 잘리지 않고 상자만 늘어난다 — 히트·선택이 보이는 글리프를 덮게), `valign`은 `h` 기준 | 넘침 클립: Figma도 자르지 않는다. `w/h` 없이 auto만: ② `고정` 라벨 |
| 정렬 | `justify` = 줄당 `fillText` 1회 + `ctx.wordSpacing`(프로브: +20px 정확) | 단어별 런 배치: 런 수 N배, 자간·커닝이 단어 경계마다 끊긴다 |
| 자간·행간 | 둘 다 % (`lineHeight 150` = 1.5배, `letterSpacing` = fontSize의 %) → px 환산은 레이아웃 한 곳. `ctx.letterSpacing = "<px>px"`; Chromium `measureText`가 마지막 글자 뒤 자간을 폭에 포함하는지(추정)는 §5-0 프로브 — 포함하면 줄 폭에서 한 칸 뺀다 | px 단위: H1 28 / Caption 11 사이에서 자간이 함께 스케일돼야 Figma와 같다(37 결정) |
| 목록 | 마커열 폭 `1.5em`, 내용 x 오프셋 = `1.5em × (listLevel+1)`, 마커 = `•` / `${n}.` / `☐`(문단 단위, 번호는 문단마다 +1), 마커 x = 오프셋 − 1.5em | 마커를 텍스트에 삽입: 저장 문자열이 오염되고 편집 중 커서가 마커를 지운다 |
| 말줄임 | `truncateLines: N`이면 N줄까지만 배치, 마지막 줄 끝에 `…`를 붙이고 그래핌 단위로 줄여 폭에 맞춘다(`truncated:true`). 편집 중(`skipId` 객체)은 해제 — textarea가 전문을 보여준다(Figma 동일) | 잘린 줄 숨김만(… 없음): ② `말줄임` 의미와 다르다 |
| 위/아래첨자 | 객체 단위(`script`) — 글자 크기 `×SCRIPT_SCALE(0.62)`, 베이스라인 시프트 `super −0.34em / sub +0.20em`(fontSize 기준, 상수 한 곳; CSS `vertical-align: super/sub`의 Blink 값에 맞춘 근사 — **추정**, §5-0 프로브에서 DOM 값으로 보정) | 글리프 치환(OpenType sups/subs): 50 범위·폰트 의존 |
| 캐시 | 키 = `JSON(TextStyle 24필드) + '|' + w + '|' + h + '|' + text`, `Map` LRU 256(≈1KB/항목 → ≤256KB, 40 원장 §3.5에 한 줄). `x,y`는 키에 없다 — 드래그 프레임(매 틱 새 객체)이 전부 적중. 산출물은 **객체 로컬**(원점 = 앵커 `o.x,o.y`)이라 소비자가 더한다 | `WeakMap<TextNode>`: 이동마다 새 객체 → 매 프레임 재측정(20객체×3줄 `measureText` 60회/프레임 — 작지만 공짜 캐시를 버릴 이유가 없다) |

### 3.3 세로 메트릭 — `alphabetic` + CSS 라인박스 공식

```
L        = fontSize × lineHeight / 100                    // 줄 높이 px
asc,desc = measureText(줄).fontBoundingBoxAscent/Descent   // 폰트 고정값(글자 내용 무관)
baseline = lineTop + (L − (asc + desc)) / 2 + asc          // = CSS 인라인 라인박스 half-leading
contentTop = valign top 0 · middle (h − contentH)/2 · bottom h − contentH   // fixed 모드만 ≠ 0
```

| 대안 | 평가 |
|---|---|
| **A. 위 공식, `textBaseline='alphabetic'`** (채택) | textarea(Blink 라인박스)와 같은 정의라 폰트가 무엇이든 ±0.5px(프로브 4폰트). 밑줄·취소선·첨자 시프트가 전부 베이스라인 기준이라 한 좌표계 |
| B. 현행 `top` + `(lh−fs)/2` 보정 유지 | em 상자 상단 ≠ 폰트 ascent — Segoe UI 5px, Pretendard 2px 어긋남(§2). 폰트가 늘수록 편차가 폰트마다 다르다 |
| C. `textBaseline='middle'` | 규격상 em 중앙이지 라인박스 중앙이 아니다 — B와 같은 문제 |

`asc/desc`는 폰트당 1회 측정(`font` 문자열 키 캐시). 회전 피벗은 종전대로 앵커 `(o.x,o.y)`(`objectAnchor` `geometry.ts:253-255` 불변 — `transformObjects`의 text `rot ±90` 규칙 `:519-528`이 그대로 산다).

### 3.4 렌더 — `drawText` 런 루프(39 래퍼 안)

39가 만든 페인트 스택·효과 래퍼는 그대로 두고 **글리프를 놓는 부분만** 교체한다: `setupTextCtx(ctx, layout)`(`font`·`letterSpacing`·`textBaseline='alphabetic'`·`textAlign='left'`) → `lines[].runs[]`마다 `ctx.wordSpacing = run.wordSpacing; fillText(run.text, x + run.x, y + run.baseline)` → 마커 `fillText` → 장식 사각형 `fillRect`(밑줄 `y = baseline + 0.12em`, 두께 `max(1, 0.06em)`; 취소선 `baseline − 0.30em` — `TextMetrics`에 폰트 표 값이 없어 em 근사, **50이 `post/OS2` 값으로 대체**). `layout.outline`이 있으면(50) 이 루프 대신 `fill(outline)` — 39 §3.8 분기 그대로.

외곽선(`strokes[] + strokeWidth + strokeAlign`, 시안 ② `선 · 외곽선 0E0E10 · 3px`): `center` = `strokeText` 후 `fillText`; `outside` = `lineWidth 2w`로 `strokeText` 후 `fillText` 덮기(`source-over`라 안쪽 절반이 채움에 묻힌다 — 스크래치 0); `inside` = 글리프 영역 clip이 `Path2D`로만 가능하므로 **50 outline 모드에서만** — 없으면 `center`로 그리고 `paintOf`가 `strokeAlignEffective:'center'`를 돌려줘 인스펙터가 표시. 텍스트 페인트(`fills[]`)는 39 `fillPaint`가 `layout.box`를 그라디언트 기준 상자로 받는다(37 §3.3 `text.stroke → fills` 승계).

### 3.5 기하 접속

- `geometry.ts:107-133`(`fontStringOf`·`TextLayout`·`layoutText`)을 `text-layout.ts`로 **이전**(geometry가 import — 순환 없음: text-layout은 `types`만 본다). `fontStringOf`에 `italic`·`fontWeight` 인자(뱃지 `render.ts:287`의 `700` 호출은 그대로).
- `buildObjectPath(text)` = `rect(o.x + box.x, o.y + box.y, box.w, box.h)`, `objectBBox(text)` 동일 — 38의 `WeakMap` 메모가 그 위에서 그대로 동작. `hasInterior(text)` true 유지(박스 클릭 = 선택).
- `objectFrame(text)`(38) = `{x:o.x, y:o.y, w:box.w, h:box.h, rot}`; `setObjectFrame(text,{w,h})`는 `resizeText`로 위임(아래) — 45 인스펙터 W/H 필드가 같은 경로.

### 3.6 리사이즈 — `resizeText(o, {w,h}, handle)` (글자 크기 불변, Figma 동작)

| 핸들 | 결과 |
|---|---|
| E / W | `resize='auto-height'`, `w` = 새 폭(최소 `1em`), `h` 무시 |
| N / S / 모서리 4 | `resize='fixed'`, `w,h` = 새 값(최소 `1em`/`L`) |
| Ctrl + 아무 핸들 | 종전 `scaleObject`(`:1387-1394` 글자 배율) — 회귀 없음 |

`resizeObject`(`:1283`)의 text 분기가 `scaleObject` 대신 이걸 부른다(회전 앵커 되밀기 `:1336-1345`는 앵커가 `(x,y)`라 이동량 0 — 항등). W 핸들은 오른쪽 변 고정 → `x`도 함께 이동(rect 규칙 `:1311-1313`과 동일).

### 3.7 textarea 메트릭 계약 — `textCss` / `textEditBox` (두 열을 나란히)

`setupTextCtx`(캔버스 열)와 `textCss`(DOM 열)를 **같은 파일에 나란히** 둔다 — 속성을 하나 추가하면 두 열 + e2e 미러 샘플(§7)이 강제된다. `textCss(o, ds)`: `font-family/weight/style`, `font-size = fontSize·ds`, `line-height = L·ds px`, `letter-spacing = px·ds`, `text-align`(justify는 §5-0 프로브에서 textarea 적용이 확인될 때만, 아니면 left — **추정** 항목), `text-transform`, `text-decoration`, `text-indent`, `padding-left = 마커열·ds`, `word-break:keep-all; overflow-wrap:anywhere; white-space: pre-wrap`(auto-width만 `pre`). `textEditBox(o, liveText, ds)`: `left = o.x·ds`, `top = (o.y + layout.contentTop)·ds` — **halfLeading 뺄셈 폐기**(라인박스 공식이 양쪽 정의), `width = (box.w + 1em)·ds`(auto-width 여유는 현행 `+fontSize` `:791` 유지), `height = box.h·ds`, `rot`·`originX/Y = 0,0`(앵커가 상자 좌상단이라 피벗 보정 불필요 — 현행 `originY: halfLeading` `:799` 삭제).

편집 중 표시 규칙: 마커는 textarea가 못 그리므로 **43 `ChromeState.extra`**에 `text` 프리미티브로 넘긴다(캔버스 `[1]`에 그리지 않는다 — INDEX §10.4). 말줄임 해제, `skipId`는 종전대로 객체 통째(`ensureCache :223`). `finishEditing`의 끝 공백 trim `:364` 유지(30 (k) `text==="e2e"`).

### 3.8 Mac(WKWebView) 폴백 — `HAS_CTX_SPACING = 'letterSpacing' in CanvasRenderingContext2D.prototype`

거짓이면 줄 폭 = 그래핌별 `measureText` 합 + 자간×(n−1), 렌더는 그래핌마다 `fillText`(커닝·리가처가 끊긴다 — `ponytail:` Windows 1차, Mac은 실기 1회로 눈금), `justify`는 단어별 런 분할(`wordSpacing` 부재). 자간 0이고 justify가 아니면 폴백 경로를 타지 않으므로 Mac에서도 기본 텍스트는 네이티브 한 줄 `fillText`다. INDEX §10.5 "letterSpacing 미지원(추정)" 항목의 구현체.

### 3.9 Mixed·타이포 편집 경로

- `mixedTextStyle(objs): {[K in keyof TextStyle]: TextStyle[K] | typeof MIXED}` = 42 `readProp`을 24필드에 돌린 얇은 래퍼(≈10줄) — 50 인스펙터·45 컨텍스트 바가 객체 하나로 받는다.
- 타이포 편집은 **`applyPaintPatch(node, {typo: Partial<TextStyle>})` 하나**: 37 §4 `applyPaintPatch`의 patch 타입에 `typo` 키를 **순증**(37 소유 파일 +1 키, 이 태스크 커밋3), 텍스트가 아닌 kind는 무시(37의 "kind에 의미 없는 키 무시" 규칙), `typo` 직접 변경 시 `styleRefs.text` 자동 detach(51 규칙과 동일). 도구가 드는 "다음 텍스트 기본값"은 `DefaultPaint.typo: TextStyle`(37 `TEXT_STYLE_DEFAULTS` = `normalizeNode` 기본값과 같은 상수 하나). `ImageEditor.tsx:603-618`의 `fontSize` 동기는 37 `paintOf`가 대체하므로 여기서 삭제.

### 3.10 만들지 않는 것

- 폰트 열거·피커·텍스트 인스펙터/컨텍스트 바 UI·OpenType·`TextLayout.outline`·윤곽선화(→ 50), 텍스트 스타일 라이브러리(→ 51), 인스펙터 탭 셸·`MIXED` 정의(→ 45·42), 마커 크롬 그리기(→ 43 — 여기서는 프리미티브만 넘긴다), 텍스트 페인트/효과 래퍼(→ 39).
- 한 객체 안 범위(부분) 스타일(INDEX §10.5), 세로쓰기, `textCase:'title'`(37 §3.2 탈락), 탭 정지, 하이픈, auto-width 모드의 justify(가용 폭이 곧 내용 폭이라 무의미 — left로 처리), 넘침 클립.
- 텍스트 단축키(Ctrl+B/I/U·정렬·크기 ±): 시안 ②⑧에 라벨이 없다 → 42 표에 행을 추가하지 않는다(INDEX §10.4 "시안에 없는 기능은 넣지 않는다").
- UAX#14 전체 줄바꿈, 자체 셰이핑, 워커 레이아웃(줄당 `measureText` 1회 + LRU로 충분 — 40 실측표에 프레임 시간 항목만).

## 4. 계약 (소유: 49 · `src/lib/annotate/text-layout.ts`, `src/components/image/annotation/textEdit.ts`)

```ts
// text-layout.ts — 동기·순수. types.ts(37)만 import. 산출물 좌표는 **객체 로컬**(원점 = o.x,o.y), 단위 oriented px
export interface TextRun  { text: string; x: number; baseline: number; width: number; wordSpacing: number /* justify 줄만 > 0 */ }
export interface TextLine { top: number; baseline: number; width: number; runs: TextRun[]; marker: { text: string; x: number } | null; para: number; forced: boolean }
export interface TextLayout {
  box: Rect;                       // {0,0,w_eff,h_eff} — buildObjectPath/objectBBox/objectFrame/textEditBox 가 쓰는 유일한 상자
  lines: TextLine[]; font: string; /* ctx.font 문자열(script 배율 반영) */ letterSpacingPx: number;
  ascent: number; descent: number; lineHeightPx: number; contentTop: number; contentH: number; truncated: boolean;
  decor: { underline: { y: number; thick: number } | null; strike: { y: number; thick: number } | null };
  outline?: Path2D;                // 50 이 채운다 — 있으면 drawText 는 runs 대신 fill(outline)
}
export function layoutText(o: TextNode, opts?: { editing?: boolean /* 말줄임 해제 */ }): TextLayout;   // LRU 256, 키에 x,y 없음
export function setupTextCtx(ctx: CanvasRenderingContext2D, l: TextLayout): void;                       // font·letterSpacing·textBaseline='alphabetic'·textAlign='left'
export function textCss(o: TextNode, ds: number): React.CSSProperties;                                    // setupTextCtx 와 짝 — 같은 파일, 같은 순서
export function textEditBox(o: TextNode, liveText: string, ds: number): { left; top; width; height; rot; originX; originY };
export function resizeText(o: TextNode, p: { w?: number; h?: number }, handle: 'E'|'W'|'N'|'S'|'NE'|'NW'|'SE'|'SW'): TextNode;
export function mixedTextStyle(objs: readonly TextNode[]): { [K in keyof TextStyle]: TextStyle[K] | typeof MIXED };   // 42 readProp 래퍼
export function fontStringOf(fontSize: number, fontFamily: string, weight?: number | string, italic?: boolean): string; // geometry.ts:107 이전
export const HAS_CTX_SPACING: boolean;                                                                    // 착수 프로브 — 40 실측표 1행
export const TEXT_METRICS = { SCRIPT_SCALE: 0.62, SUPER_SHIFT: -0.34, SUB_SHIFT: 0.2, UNDERLINE_Y: 0.12, UNDERLINE_THICK: 0.06, STRIKE_Y: -0.3, LIST_COL_EM: 1.5 } as const; // 50 이 폰트 표로 덮는다

// schema.ts(37) 순증 — 이 태스크 커밋3
applyPaintPatch(node, patch: Partial<DefaultPaint> & { typo?: Partial<TextStyle> }): Node;   // text 외 kind 무시, typo 변경 시 styleRefs.text detach
DefaultPaint.typo: TextStyle;                                                                 // = TEXT_STYLE_DEFAULTS(normalizeNode 기본값과 같은 상수)

// render.ts(39) drawText — 페인트/효과 래퍼 안의 글리프 배치만 교체
// geometry.ts — layoutText/fontStringOf 를 text-layout 에서 import, text 케이스 = layout.box + (o.x,o.y)
// annotation/textEdit.ts(37 분할) — editBox → textEditBox, textarea style → textCss, 마커 → ChromeState.extra(43)
```

e2e 훅(`window.__gpv.imageEditor`, 37 `roundTrip` 옆): `textLayout(id, opts?: { fallback?: boolean }): TextLayout`(직렬화 가능 필드만, `fallback:true`면 §3.8 경로 강제) · `textCss(id): CSSProperties`(미러 div 구성용) · `resizeText(id, p, handle)`.

## 5. 단계

0. **프로브**(≈30분, DEV 앱 CDP): `HAS_CTX_SPACING`, `measureText` 폭의 끝 자간 포함 여부, textarea `text-align: justify` 적용 여부, 4폰트(Segoe UI·Malgun Gothic·Noto Sans KR·Pretendard) DOM 베이스라인 vs 공식값, `vertical-align: super/sub` Blink 시프트값 → §7 표·`TEXT_METRICS` 상수 확정.
1. **커밋1 — 엔진 + 소비자 3곳(한 커밋)**: `text-layout.ts` 신규(≈380: 파이프라인 ≈220·캐시 ≈30·`setupTextCtx/textCss/textEditBox` ≈70·`resizeText` ≈40·폴백 ≈30), `geometry.ts`(−27/+15: 이전·text 케이스), `render.ts drawText`(−10/+60: 런·마커·장식·외곽선 정렬), `AnnotationLayer`(`resizeObject` text 분기 → `resizeText` +12). 30/34/35 격리 실행 → 91/32/13 동일.
2. **커밋2 — textarea 계약**: `annotation/textEdit.ts`(37 분할 모듈) `editBox`·textarea style → `textEditBox/textCss`(−30/+25), 마커 → `ChromeState.extra`(+15), `EditState`에 `w/h` 라이브 반영. 30 (k) 통과.
3. **커밋3 — Mixed·편집 경로**: `mixedTextStyle`(+12), `applyPaintPatch typo`·`DefaultPaint.typo`(schema.ts +25), `ImageEditor.tsx:603-618` 삭제(37 `paintOf`로 대체된 뒤라면 diff 0).
4. **e2e `43-image-text.mjs`** 신설(≈320, INDEX §10.4 번호표 43) + `run.mjs` 1줄(35 뒤). 40 실측표에 `HAS_CTX_SPACING`·LRU 바이트·텍스트 20객체 프레임 시간 3행.

규모 **L**: 프론트 ≈ +620/−90 · Rust 0 · 신규 의존 0(`Intl.Segmenter`는 Chromium 87+ 내장).

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| 소비자 3곳 부분 교체 | 히트는 새 상자, 렌더는 옛 줄 같은 중간 상태가 커밋에 남으면 "집히는 곳 ≠ 보이는 곳" | 커밋1이 geometry·render·AnnotationLayer를 **한 커밋**에 바꾼다. e2e 43 (i) 히트==상자 단언 |
| `letterSpacing`이 `strokeText`에도 같게 걸리는지 | 프로브는 `fillText/measureText`만 봤다 — 외곽선이 글리프와 어긋날 수 있다(추정) | 43 (j-2) 외곽선 픽셀 단언(글리프 경계 바로 밖 1px = 외곽선색) — 어긋나면 외곽선을 런이 아니라 그래핌 단위로 |
| textarea `justify` 미적용 | Blink textarea가 `text-align:justify`를 무시하면 편집 중 줄 끝이 어긋난다(추정) | §5-0 프로브 → 미적용이면 편집 중 `left`로 표시 + 문서화(원 설계 §5.5 "확정 후 캔버스가 정본") |
| `measureText` 끝 자간 포함 | Chromium이 마지막 글자 뒤 자간을 폭에 넣으면 center/right 정렬이 자간 한 칸 오른쪽으로 민다 | 프로브 확정 후 `width −= letterSpacingPx` 한 줄. 43 (c) 오른쪽 잉크 x 단언이 잡는다 |
| Mac 폴백 품질 | 그래핌별 `fillText`는 커닝·리가처가 끊긴다 | 자간 0·비justify는 폴백을 타지 않는다. `ponytail:` 천장 명시, TROUBLESHOOTING에 Mac 항목, 실기 1회 |
| DPR 분수 반올림 | 배율 1.5에서 라인박스 높이가 53.33px처럼 나와 미러와 0.5px씩 어긋난다 | 허용오차 1px 고정(§7). 캔버스 배치는 실수 좌표라 누적되지 않는다 |
| 편집 중 마커·말줄임 부재 | textarea에 마커가 없고 전문이 보인다 | 마커는 크롬 extra로 같은 자리에, 말줄임은 Figma도 편집 중 해제 — 문서화 |
| LRU 키 문자열 비용 | 24필드 JSON 매 호출 | ≈300B 문자열 1회/호출, 히트 시 `Map.get` 1회. 40 실측표 프레임 시간 행으로 확인 |
| `w/h` 기본값 0인 v1 텍스트 | 37 `normalizeNode`가 `resize:'auto-width', w:0, h:0`을 채운다 | auto 모드는 `w/h`를 읽지 않는다(§3.2) — v1 문서가 종전과 같은 자리·폭으로 보인다 |

## 7. 검증

- **e2e 43 (신규)** — 픽스처 200px 흰색, `setDoc`에 v2 텍스트 리터럴(37 `normalizeNode` 경유):
  (a) `'가나다 라마바'` `w=80 auto-height fontSize 20` → `textLayout().lines.length===2`, 2번째 줄 `runs[0].text` 가 `'라'`로 시작, 캔버스 잉크 스캔: 2번째 줄 첫 잉크 행 ≥ `o.y + lines[1].top`;
  (b) 영문 26자 단일 토큰 `w=60` → `lines.length≥2`·전 줄 `forced===true`·`width ≤ 60+1`;
  (c) `justify` 4단어 2줄 → 1번째 줄 오른쪽 잉크 x = `o.x+box.w ±1`, 마지막 줄은 그보다 작다;
  (d) `truncateLines:2` 3줄 텍스트 → `truncated===true`, 2번째 줄 끝 `…` 잉크 존재, 3번째 줄 영역 잉크 0; `setTool('text')`+더블클릭 편집 중 `textLayout(id,{editing:true}).truncated===false`;
  (e) `list:'bullet'|'number'|'check'` → 마커 잉크 x < 첫 글자 잉크 x, `listLevel:1` → `runs[0].x` 가 레벨 0보다 `1.5em` 크다, `number` 2문단 → 마커 `'1.'`·`'2.'`;
  (f) `textCase:'upper'` `'abc'` → `lines[0].width === measureText('ABC') ±0.5`(훅으로 비교), 저장 문자열 `'abc'` 불변;
  (g) `fixed w=150 h=200 valign:'bottom'` → 마지막 줄 `baseline+descent === 200 ±1`; `middle` → 위·아래 여백 차 ≤1;
  (h) 리사이즈: E 핸들 +40 → `resize==='auto-height'`·`w +40`·`fontSize` 불변; SE 핸들 → `'fixed'`; Ctrl+SE → `fontSize` 배율·`resize` 불변(현행 회귀);
  (i) 히트 == 상자: 상자 안 클릭 `selCount 1`, 상자 오른쪽 2px 밖 `0`, `objectAABB` == `box` 이동값;
  (j) 프리뷰 `[1]` vs `readSaved` 텍스트 영역 픽셀 델타 0(4폰트 — 미설치 폰트는 `document.fonts.check` false면 skip); (j-2) `strokeAlign:'outside' strokeWidth 3 #0E0E10` → 글리프 경계 바로 밖 1px ≈ `[14,14,16]`, `'center'`는 안팎 반씩;
  (k) **미러 대조 6샘플**(한글 공백 문장·영문 장토큰·혼합·bullet 목록·justify·문단 간격+들여쓰기): `textCss(id)`로 숨은 `div`(`white-space:pre-wrap`, 줄마다 `<span>`)를 만들어 `Range.getClientRects()` 줄 수 == `lines.length`, 줄 폭 차 ≤1px, `contentTop` 차 ≤1px(DPR 1.5);
  (l) 편집 중 첫 글자: textarea 미러 첫 글자 rect ↔ 확정 후 캔버스 첫 잉크 top 차 ≤1px, 4폰트;
  (m) `rot:90` 텍스트 더블클릭 → textarea `transform: rotate(90deg)`·`transformOrigin 0 0`·`left/top` == `(o.x,o.y)·ds`;
  (n) 텍스트 2개(14/28) → `mixedTextStyle().fontSize === MIXED`·`fontFamily` 동일값; `applyPaintPatch(t,{typo:{fontSize:32}})` → 32·`styleRefs.text` 없음;
  (o) 폴백: `textLayout(id,{fallback:true})` 줄 폭이 네이티브와 ±1px(Windows에서 Mac 경로 검사).
- **회귀**: 30(91)·34(32)·35(13) 단언 수·pass 동일 — 커밋1·커밋2 뒤 두 번. 30 (k) `text==='e2e'`·`hasTextarea` 전이 무변경.
- **프로브 표(§5-0, 이 절에 채운다)**: `HAS_CTX_SPACING` · 끝 자간 포함 여부 · textarea justify · 4폰트 베이스라인(DOM vs 공식) · super/sub 시프트 · 20객체×3줄 프레임 시간(목표 ≤2ms 추가).
- **실기**: 긴 한글 문장 박스 리사이즈(E 핸들)로 줄바꿈 확인, 편집 중/확정 후 첫 글자 튐 육안 0, 이미지 90° 회전 후 텍스트 재편집(textarea 방향·자리), macOS 1회(폴백 경로·`letterSpacing` 유무 기록).
