# 태스크 50 — 시스템 폰트 열거(Rust fontdb)·폰트 피커·텍스트 인스펙터/컨텍스트 바·OpenType(fontkit)·텍스트 윤곽선화

> 상태: 설계(Design) · 대상: gitpervisor · 근거: 코드 실측 2026-09-04(워킹트리) + 이 머신 폰트 인벤토리·npm/crates.io/번들 실측 2026-09-04 · 선행: 태스크 45(`Popover`·`ContextBar`·`NumField`·`StackList`),
> 49(`layoutText`·`TextLayout.outline`·`textCss`·`mixedTextStyle`), 37(`TextStyle`·`TextNode`·`PathNode`), 39(`drawText`의 outline 분기·`strokePaint`), 42(`EDITOR_SHORTCUTS` `outline` 액션), 46(`fromPathCmds`), 51(텍스트 스타일 라이브러리) ·
> `DOCS/image-annotation-design.md` §5.5(폰트 일치 계약 — 이 문서가 폰트 선택으로 확장) · 시안: `designs/image-editor-figma-v2.pen` ②(인스펙터 텍스트 46 라벨)④(폰트 피커)⑧(텍스트 컨텍스트 바·윤곽선화 ⇧⌘O) · 상위: `00-INDEX.md` §10 — **M4 텍스트 레인 마감(L).**

## 1. 요구사항

시안 ④ 폰트 피커 `폰트 · 폰트 검색 · 전체 · 한글 · 산세리프 · 세리프 · 모노 · 최근 · Noto Sans KR · 가나 Ag 123 · Inter · Playfair Display · Roboto Mono · Space Grotesk · IBM Plex Sans KR · Thin · Light · Regular · Medium · Bold · Black`,
② 텍스트 탭 `텍스트 스타일 › 제목 / H1 · Pretendard Bold 28 · 130% · 본문 / Body · Pretendard Regular 14 · 150% · 캡션 / Caption · Pretendard Medium 11 · 140%` · `타이포그래피 › Pretendard · Regular · 크기 14 · 행간 150% · 자간 -0.2 · 문단 간격 8 · 들여쓰기 0` · `정렬` · `자동 폭 · 자동 높이 · 고정` · `장식 · 대소문자 · 말줄임 · 2줄` ·
`OpenType › 리가처 · 구식 숫자 · 고정폭 숫자 · 분수` · `채우기 EDEDEF 100%` · `선 외곽선 0E0E10 3px` · `효과 드롭 섀도 0·1 3 60%` · `미리보기`, ⑧ 텍스트 컨텍스트 바 `Noto Sans KR · Regular · Bold · 크기 14 · 행간 150% · 텍스트 스타일`, ⑧ `윤곽선화 ⇧⌘O`(Windows Ctrl+Shift+O).

받아들이는 조건:
- 이 머신에 설치된 폰트가 **전부** 피커에 나온다(사용자 폰트 폴더의 Pretendard·Noto Sans KR 포함). 목록은 1회 열거·세션 캐시, 콜드 ≤1.5s.
- 피커에서 고른 폰트·굵기가 캔버스 렌더·textarea 편집·저장 파일 세 곳에서 같은 글꼴로 보인다(§5.5 폰트 일치 계약의 확장).
- ② 46 라벨 각각에 대응하는 컨트롤이 있고 값 변경이 `TextNode`(37) 필드에 1:1로 쓰인다. 다중 선택은 `Mixed`.
- OpenType 4토글은 **폰트가 실제로 가진 기능만** 켤 수 있고, 켜면 프리뷰와 저장이 같은 글리프로 그려진다. 못 켜는 이유가 툴팁에 있다.
- 텍스트 윤곽선화(Ctrl+Shift+O)는 텍스트 노드를 같은 자리·같은 픽셀의 `PathNode`(37)로 바꾸고 undo 1칸으로 돌아온다. 설치되지 않은 폰트로 폴백 렌더 중이면 문서를 건드리지 않는다.
- 이 태스크만 머지해도 쓸 수 있다: 49의 레이아웃 엔진 위에 폰트 선택·타이포 편집·OT·윤곽선화가 붙고, 30/34/35 초록.

## 2. 현황(근거)

- **폰트는 상수 하나다.** `types.ts:198-199 DEFAULT_FONT_FAMILY`(Segoe UI·Malgun Gothic·Apple SD Gothic Neo·system-ui 5단 스택), `AnnotationLayer.tsx:866-868 FONT_FAMILY`가 같은 문자열을 **중복 선언**해 새 텍스트에 박는다(`:467`). `TextObject`(`types.ts:88-95`)는 `fontSize·fontFamily`뿐 — 굵기·이탤릭·행간·자간 없음. `fontStringOf(size, family, weight=400)`(`geometry.ts:107-113`)이 `ctx.font`를 만들고 `drawText`(`render.ts:263-272`)·`layoutText`(`geometry.ts:123-133`)·textarea(`AnnotationLayer.tsx:838-852` `fontFamily: editing.obj.fontFamily`)가 그 문자열을 나눠 쓴다. 뱃지만 `700`(`render.ts:287`). **폰트를 고르는 UI는 0**(`AnnotationToolbar.tsx:111,232-238`은 크기 슬라이더뿐, `fontFamily` grep은 AnnotationLayer 1파일).
- **시스템 폰트 열거 경로가 없다.** `font_list|fontdb|queryLocalFonts` grep 0건(src·src-tauri). 이 머신 실측(PowerShell, 2026-09-04): `C:\Windows\Fonts` 235파일 842MB(ttc 18·ttf 217), 사용자 폴더 `%LOCALAPPDATA%\Microsoft\Windows\Fonts` 49파일 85MB(**Pretendard 9 otf·NotoSansKR-VF 9.9MB·HANBatang 계열**, 레지스트리 `HKCU\…\Fonts`에 등록) — 합 284파일 ≈927MB. 최대 `Hancom HMJE_V.ttf` 61.7MB·`HANBatangExtB.ttf` 42.8MB·`mingliub.ttc` 35.4MB·`batang.ttc` 15.5MB·`malgun.ttf` 12.8MB. 전량 읽기는 CLAUDE.md OOM 이력과 정면충돌 — 목록은 **메타만**, 바이트는 **요청한 파일 하나만**.
- **브라우저 쪽 열거는 막혀 있다.** `queryLocalFonts()`는 `local-fonts` 권한 프롬프트를 요구하는데 wry는 `PermissionRequested`에서 `CLIPBOARD_READ`만 허용한다(`~/.cargo/registry/src/*/wry-0.55.1/src/webview2/mod.rs:500-507`) — 나머지는 WebView2 기본 UI로 넘어가고(추정) macOS WKWebView는 API 자체가 없다. INDEX §10.5가 같은 결론.
- **OpenType 기능은 `fillText`로 못 켠다.** `ctx.font`는 CSS `font` 축약형이라 `font-feature-settings`가 문법상 들어갈 자리가 없다(대입 시 무시 — 텍스트 축 CDP 프로브 2026-09-04에서 문자열 불변 실측). `fontVariantCaps`만 있고 `liga/onum/tnum/frac`에 해당하는 속성이 없다. 캔버스는 글리프 윤곽을 노출하지 않으므로 윤곽선화도 폰트 파일 파싱 없이는 불가 — INDEX §10.5·39 §3.8("`layout.outline`이 있으면 `fill(path)`")이 이 태스크에 그 자리를 비워 뒀다.
- **큰 바이트 IPC 선례**: `read_file_base64`는 base64 문자열(`diff.rs:254-290`, 25MB 상한 `:228`), `write_file_bytes`는 base64 입력 64MB 상한(`tree.rs:404-408`). `tauri::ipc::Response`(raw 응답)는 이 저장소 **첫 사용**이 된다 — `tauri-2.11.2/src/ipc/mod.rs:190 pub struct Response`, `:112 From<Vec<u8>> for InvokeResponseBody`, JS는 `invoke()`가 `ArrayBuffer`를 그대로 돌려준다(`@tauri-apps/api/core.d.ts:105`). `ipc::Channel`은 5파일이 쓰지만(`lsp.rs:15` 등) `Response`는 0건. 42.8MB 파일을 base64로 보내면 57MB 문자열 + 디코드 사본이 생긴다.
- **블로킹 작업 관례**: `tauri::async_runtime::spawn_blocking`(`disk.rs:129`)·`tokio::task::spawn_blocking`(`tree.rs:600`, `logo.rs:280`), 프로세스 수명 캐시는 `OnceLock`(`lib.rs:28 CRASH_LOG`). 등록은 `lib.rs:943 generate_handler!` + `commands/mod.rs`(`mod x; pub use x::*;`).
- **의존성 실측(2026-09-04)**: `fontdb 0.24.0`(crates.io, MIT, 2026-07-29) — 기본 feature `std/fs/memmap/fontconfig`, 의존 `log·memmap2·slotmap·tinyvec`(+Linux `fontconfig-parser`, 순수 Rust). **ttf-parser 크레이트에 의존하지 않는다** — `src/lib.rs:66 mod ttf_parser`로 name/OS2/post만 읽는 축소판을 내장. `load_system_fonts`(`:402-420`)가 Windows 사용자 폴더(`AppData\Local\…\Fonts`·`AppData\Roaming\…\Fonts`)를 포함하고, `with_face_data`(`:723`, `Arc<Mmap>` `:759`)가 요청한 face만 memmap한다. `FaceInfo`(`:813-857`) = `source·index·families:(String,Language)[]·post_script_name·style·weight·monospaced`. `Cargo.lock`에는 `tinyvec`만 있다 — 신규 크레이트 `fontdb·slotmap·memmap2·(fontconfig-parser)` + cmap/OS2 판독용 `ttf-parser`(아래 §3.2), 전부 순수 Rust.
  `fontkit 2.0.4`(npm, MIT) — 의존 9, unpacked 5.6MB, `module: dist/browser-module.mjs`(**545KB 미압축, `Buffer` 참조 0건, 외부 import 10 = 의존 전부**, `process.` 참조 1건), TTC(`ttcf`·`getFont`)·`getVariation`·`availableFeatures`·`underlinePosition/Thickness`·`OS/2` 노출. `opentype.js 2.0.0`(MIT, 3.6MB)의 TTC·체인 GSUB 미지원은 미검증(추정) — 결정은 이 머신 인벤토리(TTC 18개·가변 폰트 1개)로 독립 성립.
- **e2e**: 30 `:475-490 hasTextarea/typeText`, `(k) :1237-1263`은 `txt.text==='e2e'`만 본다 — 폰트·굵기 단언 0건. 34·35 텍스트 0건. 49가 `43-image-text.mjs`를 신설한다(INDEX §10.4 번호표) — 이 태스크는 그 스위트에 케이스를 더한다.

## 3. 설계

### 3.1 폰트 목록 출처 — **Rust fontdb 단일 경로**

| 대안 | 평가 |
|---|---|
| **A. Rust `fontdb::Database::load_system_fonts()` → `font_list` IPC 1회, `OnceLock` 캐시, `spawn_blocking`** (채택) | Windows/macOS/Linux 한 코드(fontconfig 파서 순수 Rust — `openssl-sys` vendored와 같은 이식성 이유). 메타만 읽고(`with_face_data` memmap) 바이트를 들지 않는다. 사용자 폴더 포함 실측(§2) |
| B. `queryLocalFonts()` | wry 권한 미처리(§2)·WKWebView 부재 → 플랫폼 2벌 + `unsafe with_webview` 훅 |
| C. DirectWrite/CoreText FFI | Windows `windows-sys`는 트리에 있으나 COM `unsafe` ≈120줄 + Mac/Linux 별도 |
| D. `font-kit` 크레이트 | Linux에서 freetype/fontconfig **C 링크** — CI 빌드 호스트에 없다(Cargo.toml Linux openssl vendored 주석과 같은 문제) |
| E. 큐레이션 12종만 | 시안 ④ `전체 · 한글 · …` 필터가 열거를 전제. 사용자 설치 폰트(Pretendard)를 못 고른다 |

### 3.2 항목·분류 — `FontFaceInfo`

face마다 `family`(영문, name id 16→1)·`family_ko`(Windows 플랫폼 lang 0x0412 이름)·`postscript`·`weight`·`italic`·`mono`(fontdb `monospaced`)·`hangul`·`class`·`path`·`index`·`collection`·`file_size`. fontdb 내장 파서는 cmap·OS/2 분류 바이트를 안 주므로 **`ttf-parser`(순수 Rust, 신규)** 로 `with_face_data` 안에서 `Face::parse(data, index)` 1회: `hangul = face.glyph_index('한').is_some()`, `class`는 `raw_face().table(b"OS/2")` 오프셋 30 `sFamilyClass`(상위 바이트 1~7 serif·8 sans) → PANOSE(32..42, `bFamilyType 2 && bSerifStyle 11~15` sans) → 없으면 `'other'`. 이름 휴리스틱(`명조|Myeongjo|Batang|바탕|Serif|Times|Georgia` → serif, `Mono|Code|Consol|Courier|D2Coding` → mono)은 TS `classify()`가 `'other'`에만 건다 — `ponytail: 오분류 보고가 오면 표 확장`. 자체 sfnt/cmap 파서(≈90줄, format 4/12)를 쓰지 않는 이유: 같은 코드를 ttf-parser가 이미 검증된 채로 갖고 있고 컴파일 비용이 작다.

### 3.3 폰트 바이트 — `font_read(path) → ipc::Response`

| 항목 | 결정 |
|---|---|
| 허용 범위 | `font_list`가 돌려준 `path` 문자열 집합(`OnceLock` 안 `HashSet<String>`)에 **정확히 일치**할 때만. `resolve_in_repo`(`tree.rs:1772`)는 레포 전용이라 못 쓴다 — 허용목록이 그 자리. 프론트가 임의 절대경로를 넘겨 읽는 표면은 0(INDEX §10.4 Rust 규칙) |
| 상한 | 메타 `len > 64MB` → `Io`(`write_file_bytes` 대칭). 실측 최대 61.7MB 통과 |
| 반환 | `tokio::fs::read` → `tauri::ipc::Response::new(bytes)` → JS `ArrayBuffer`. base64 탈락(§2 사본 2벌) |
| 컬렉션 | 파일 통째(ttc 최대 35.4MB) — face 선택은 JS fontkit `getFont(postscript) ?? fonts[index]` |
| 슬롯 리미터 | 기존 `call()`(`ipc.ts:964-1013`)을 그대로 지난다 — 같은 `(cmd,args)` single-flight가 같은 폰트 동시 요청을 1건으로 합친다. `attempts:1`·`timeoutMs 30_000`. 52의 `invokeRaw`는 **요청** raw body용이라 여기선 불필요 |

### 3.4 OpenType — 기능을 켠 객체만 fontkit 글리프 패스로

| 대안 | 평가 |
|---|---|
| **A. `features`가 하나라도 켜진 `TextNode`만 fontkit 셰이핑 → 글리프 `Path2D` → `TextLayout.outline`(49) → 39 `drawText`가 `fill(path)`** (채택) | 기능 OFF 문서는 비용·픽셀 변화 0. 39·49가 비워 둔 자리(`outline`)에 끼운다 |
| B. `fillText`에 `font-feature-settings` | 불가(§2) |
| C. SVG `foreignObject` 래스터 | 디코드 비동기라 `renderScene` 동기 계약 위반 + WebKit taint → Mac 저장 불능 |
| D. 전 텍스트를 패스로 | 모든 폰트 바이트(12~43MB) 필요, 힌팅 없는 AA가 11px 캡션에서 `fillText`와 달라 보인다 |
| E. opentype.js | TTC 18개·가변 폰트(NotoSansKR-VF)를 못 다룬다(추정) — fontkit은 실측으로 `ttcf`·`getVariation` 보유 |

- **동기 렌더 + 비동기 로드**: `renderScene`은 동기 유지. `ensureTextShaping(scene)`이 기능 켠 노드의 face를 `resolveFace(family, weight, italic)`로 찾아 `font_read` → `fontkit.create(bytes)`(TTC면 `getFont`) → 가변 폰트는 `getVariation({wght})` → LRU. **프리뷰**(AnnotationLayer `ensureCache`)는 await하지 않고 미로드면 `fillText` 폴백 후 로드 완료 시 `renderOnce()`(플래시 1회, 문서화). **저장·복사·내보내기**(`ImageEditor.tsx:733,837` `encodeCanvas(renderOutput())`, 52 `runExport`, 40 `renderOutput`)는 반드시 `await ensureTextShaping` 뒤 — 프리뷰≠저장이 생기지 않는다.
- **49 접점 한 곳**: `layoutText(o)`가 `shapeFor(o)`를 부른다 — `null`이면 종전 `measureText`, 있으면 `measure(text)`(셰이핑 어드밴스 합 × fontSize/unitsPerEm)로 줄을 나누고 `outline(lines)`를 `layout.outline`에 넣는다(+≈8줄, → 태스크 49 §4). HarfBuzz(Blink)와 fontkit은 같은 GSUB/GPOS·hmtx를 읽으므로 textarea(같은 `font-feature-settings` CSS — 49 `textCss`)와 어드밴스가 ±1px 안에서 같다.
- **메모리(40 원장 `fontkit ≤ 24MB`)**: LRU 항목 비용 = 파일 바이트 × 1.4(ArrayBuffer + 파싱 구조, 추정) 합 ≤ 24MB — malgun 12.8→17.9MB 1개 + Pretendard 1.5→2.1MB 몇 개. **단일 파일 > 17MB는 셰이핑을 거부**(`shapeSupports` → `'too-large'`, 토글 비활성 + 툴팁 "폰트 파일 42.8MB — OpenType 기능은 17MB 이하 폰트만"): HANBatangExtB·Hancom HMJE_V·mingliub·batang.ttc(15.5MB, 통과)·그 위는 어차피 명조 계열이라 실사용 손실이 작다. 글리프 `Path2D` 캐시 ≤4096(≈8MB 추정). `releaseTextShaping()`은 `releaseScratch`와 같은 자리(`AnnotationLayer.tsx:635` 언마운트).
- **`shapeSupports(family, weight, feature)`**: 로드된 폰트의 `availableFeatures`에 태그가 있으면 `true`, 없으면 `false`, 미로드면 `'unknown'`(인스펙터가 로드를 트리거하고 잠시 비활성). `frac`는 폰트 GSUB에 있을 때만 — 합성 안 함(INDEX §10.5).
- **장식·외곽선**: 로드된 폰트가 있으면 `decorMetrics(o)`(`underlinePosition/Thickness`·OS/2 `yStrikeoutPosition/Size`)를 49 `layout.decor`가 우선 쓴다(없으면 49의 em 근사). `strokeAlign inside/outside`는 `outline`이 있을 때 39 `strokePaint(ctx, node, outline, t)`가 다른 Path2D와 똑같이 처리 — 텍스트 전용 코드 0. `outline` 없으면 49 규칙대로 center 폴백.

### 3.5 텍스트 윤곽선화 — `outlineText(node) → PathNode`

- 조건 3: (1) `resolveFace`가 face를 찾는다(폴백 렌더 중이면 거부) (2) 파일 ≤17MB·fontkit 파싱 성공 (3) 글리프가 전부 있다. 미달 → `pushToast("설치되지 않은 폰트 — 윤곽선화 불가")`, 문서·히스토리 불변.
- 변환: 49 `layoutText(o)`의 `lines[].runs`(x·baseline)와 같은 위치에 `font.layout(text, features)` 글리프 `path.commands` → 46 `fromPathCmds`로 `SubPath[]`, 마커(`layout.lines[].marker`)·밑줄/취소선 사각형(`layout.decor`)도 서브패스로. 결과 `PathNode`: `id` 유지, `fills/strokes/strokeWidth/strokeAlign/effects/opacity/blend/name` 그대로, `fillRule:'nonzero'`(TrueType·CFF 윤곽 방향 일관), `rot` 유지 — 피벗이 텍스트 앵커 `(x,y)`(37)에서 패스 AABB 중심 `c`로 바뀌므로 정점 전체를 `d = rotatePoint(c, rot, {x,y}) − c`만큼 옮긴다(`R(θ,c+d)(v+d) = R(θ,(x,y))(v)` — 픽셀 동일, `rot` 필드 보존). 커밋 라벨 `'텍스트 윤곽선화'`, undo 1칸.
- 진입: 42 `EDITOR_SHORTCUTS`의 `outline` 액션(Ctrl+Shift+O, Mac ⇧⌘O)이 `classifySelection`으로 분기 — text → `outlineText`, path → 46 `outlineStroke`(같은 행, 표에 새 행 없음). 인스펙터 텍스트 탭 하단·컨텍스트 바에는 버튼을 두지 않는다(시안 ⑧에만 단축키로 존재).
- 내보내기 옵션 `텍스트 윤곽선화`(⑥)는 래스터에서 무의미 — 52가 비활성+툴팁(→ 태스크 52 §4 `ExportOptions.outlineText:false`). 문서 내 윤곽선화는 항상 가능.

### 3.6 폰트 피커 — 45 `Popover` 콘텐츠

| 요소(시안 ④) | 구현 |
|---|---|
| `폰트 검색` | `family`·`family_ko` 대소문자 무시 부분일치 |
| 칩 `전체 · 한글 · 산세리프 · 세리프 · 모노 · 최근` | `classify(f)`(`hangul → 'hangul'`, 아니면 `class`/이름 휴리스틱) · 최근 = `localStorage 'gp:image-recent-fonts'` family 5개(`ui.ts` `gp:*` 관례) |
| 행 `Noto Sans KR · 가나 Ag 123` | family 단위 그룹(face → family 집계), 미리보기는 DOM 텍스트 + `font-family: "<family>"`(시스템 폰트라 로드 0). 행 `content-visibility:auto`(44 규칙) — 이 머신 family ≈150이라 가상화 없음 |
| 굵기 `Thin · Light · Regular · Medium · Bold · Black` | 100/300/400/500/700/900. 해당 `weight` face가 있으면 활성; 없고 ≥600이면 회색 + `합성` 배지(Blink 합성 굵게, 선택 가능); 없고 <600이면 비활성(Blink는 합성 없이 가까운 face로 조용히 대체 — 실측 Malgun 300/400/700 폭 동일) |
| 미설치 시안 폰트 | INDEX §10.3 기본값: `Inter·Playfair Display·Roboto Mono·Space Grotesk·IBM Plex Sans KR·Noto Sans KR` 중 `font_list`에 없는 것은 회색 행(`document.fonts.check`) — 웹폰트 로드 없음 |
| `font_list` 실패 | 위 6종 + `DEFAULT_FONT_FAMILY` 스택 구성원으로 폴백 목록(회색 표시 동일 규칙) |

선택 → `patchTextStyle(node, {fontFamily, fontWeight})` 1커밋(라벨 `'폰트 <family>'`), 캔버스 `ctx.font`·textarea `font-family/weight`(49 `textCss`)가 같은 문자열을 받는다.

### 3.7 텍스트 인스펙터·컨텍스트 바 — 시안 ② 46 라벨 → `TextStyle` 필드

| 섹션(.pen 노드) | 라벨 | 필드(37 `TextStyle`) | 컨트롤(45) |
|---|---|---|---|
| `Sec 텍스트 스타일` | 제목/H1 · 본문/Body · 캡션/Caption(+`A plus`) | `styleRefs.text` | 칩 3 = 51 `useImageLibrary().lib.textStyles`, 클릭 → 51 `applyStyle(node,'text',style)`, `+` → 51 `saveStyleFromNode(node,'text',name)` |
| `Sec 타이포그래피` | Pretendard(`Font Family`+caret) · Regular(`Sel`) · 크기 14 · 행간 150% · 자간 -0.2 · 문단 간격 8 · 들여쓰기 0 | `fontFamily · fontWeight · fontSize · lineHeight(%) · letterSpacing(%) · paragraphSpacing · indent` | family 버튼 → §3.6 피커, weight `Sel`(면이 있는 굵기만), `NumField` 5(스크럽·Mixed) |
| `Sec 정렬` | 가로 정렬 4(`align-left/center/right/justify`) · 세로 정렬 3(`arrow-up-to-line/fold-vertical/arrow-down-to-line`) · `Rs 자동 폭/자동 높이/고정` | `align · valign · resize` | 세그먼트 3개 |
| `Sec 장식 · 대소문자` | `underline/strikethrough/superscript/subscript` · `case-sensitive/case-upper/case-lower` · `list/list-ordered/list-todo` · `indent-decrease/increase` · 말줄임 · 2줄 | `underline · strike · script · textCase · list · listLevel · truncateLines` | 토글/세그먼트 + `NumField`(2줄) |
| `Sec OpenType` | 리가처 · 구식 숫자 · 고정폭 숫자 · 분수 | `features.liga/onum/tnum/frac` | 토글 4 — `shapeSupports` `false`/`'too-large'`면 비활성 + 툴팁(사유), `'unknown'`이면 로드 중 |
| `Sec 채우기 / 선 / 효과` | EDEDEF 100% · 외곽선 0E0E10 3px · 드롭 섀도 0·1 3 60% | `fills · strokes+strokeWidth+strokeAlign · effects`(NodeBase) | 45 `StackList` 3개(속성 탭과 같은 컴포넌트) |
| `Sec 미리보기` | Preview Box | — | `<div style={textCss(node, 1)}>`(49) — 렌더 경로와 같은 CSS 문자열, DOM이라 비용 0 |

- 값 쓰기: `patchTextStyle(node, p) = applyPaintPatch(node, { typo: p })`(49 §3.9 가 37 `applyPaintPatch` 에 `typo` 키를 순증 — `styleRefs.text` 자동 분리 포함, 51 `STYLE_DETACH_KEYS` 규칙과 동일). 새 함수가 아니라 이 파일 안 1줄 래퍼. 다중 선택은 49 `mixedTextStyle(nodes)` → `NumField`의 `MIXED`, 입력 시 전체 적용(45 규칙). 스크럽·타이핑·방향키의 히스토리 단위는 45 `NumField` 규칙 그대로(라이브 `patchDoc(…,'live')` → 확정 1칸).
- 컨텍스트 바(⑧ 텍스트 변형): `Noto Sans KR`(피커) · `Regular ▾`(weight) · `크기 14` · `행간 150%` · `텍스트 스타일 ▾`(51 칩 목록) — `TextContextBarContent`를 45 `ContextBar`의 `'text'` 분기가 마운트한다(→ 태스크 45 §4). 별도 툴바 파일 없음(`AnnotationToolbar.tsx`는 42가 삭제).
- 편집 중(textarea) 일치: `fontWeight/italic/letterSpacing/font-feature-settings`는 49 `textCss`가 이미 낸다 — 이 태스크가 CSS를 따로 만들지 않는다.

### 3.8 만들지 않는 것

- 텍스트 편집 단축키(Ctrl+B/I/U·정렬·크기 ±): 시안 라벨 없음 — 42 표에 행을 요청하지 않는다. 윤곽선화 Ctrl+Shift+O만(⑧).
- 웹폰트 번들·다운로드(INDEX §10.3 기본값 '아니오'), 폰트 파일 경로 표시·열기, 사용자 폰트 설치.
- 부분(범위) 스타일·`frac` 합성·`fontStretch/wdth`·전 텍스트 패스 렌더(INDEX §10.5).
- 레이아웃 엔진·줄바꿈·textarea 메트릭(→ 49), 텍스트 스타일 저장소·전파(→ 51), 페인트/효과 렌더(→ 39), 내보내기 옵션 게이팅 UI(→ 52), 단축키 표(→ 42), 패스 기하·`fromPathCmds`(→ 46).
- 17MB 초과 폰트의 OpenType/윤곽선화(`ponytail:` 상한 — 스트리밍 파싱이 필요해지면 그때).

## 4. 계약 (소유: 50 · `src-tauri/src/commands/fonts.rs`, `src/lib/fonts.ts`, `src/lib/annotate/text-shape.ts`, `src/components/image/FontPicker.tsx`, `TextInspector.tsx`)

```rust
// src-tauri/src/commands/fonts.rs  (lib.rs generate_handler! :943 에 2개 등록, mod.rs `mod fonts; pub use fonts::*;`)
// Cargo.toml: fontdb = "0.24" (기본 feature std/fs/memmap/fontconfig 그대로), ttf-parser = "0.25" (cmap·OS/2 raw 판독)
#[derive(Serialize, Clone)] pub struct FontFaceInfo { family: String, family_ko: Option<String>, postscript: String, weight: u16, italic: bool, mono: bool,
  hangul: bool, class: &'static str /* "sans"|"serif"|"mono"|"other" */, path: String, index: u32, collection: bool, file_size: u64 }
static FONTS: OnceLock<FontIndex>;  struct FontIndex { faces: Vec<FontFaceInfo>, allowed: HashSet<String> }   // 프로세스 수명 1회 열거
#[tauri::command] pub async fn font_list() -> Result<Vec<FontFaceInfo>, IpcError>;          // spawn_blocking(load_system_fonts + with_face_data 분류)
#[tauri::command] pub async fn font_read(path: String) -> Result<tauri::ipc::Response, IpcError>; // allowed 정확 일치 아니면 NotFound · len>64MB → Io · Response::new(bytes)
```

```ts
// src/lib/ipc.ts
fontList(): Promise<FontFaceInfo[]>                       // call("font_list", {}, {attempts:1, timeoutMs:20_000, lane:"background"})
fontRead(path: string): Promise<ArrayBuffer>               // call("font_read", {path}, {attempts:1, timeoutMs:30_000}) — single-flight 는 call() 관례

// src/lib/fonts.ts
export async function fontList(): Promise<FontFaceInfo[]>;                 // 세션 캐시(모듈 Promise 1개), 실패 시 CURATED 폴백
export function resolveFace(family: string, weight: number, italic: boolean): FontFaceInfo | null;   // CSS 폰트 매칭 규칙(가까운 굵기, 이탤릭 우선)
export function classify(f: FontFaceInfo): 'hangul' | 'sans' | 'serif' | 'mono';                  // hangul → class → 이름 휴리스틱(ponytail:)
export function familiesOf(faces: FontFaceInfo[]): { family: string; family_ko?: string; weights: number[]; italic: boolean; cls: ReturnType<typeof classify> }[];
export function recentFonts(): string[]; export function pushRecentFont(family: string): void;      // localStorage 'gp:image-recent-fonts', 5개
export const CURATED = ['Noto Sans KR','Inter','Playfair Display','Roboto Mono','Space Grotesk','IBM Plex Sans KR'];

// src/lib/annotate/text-shape.ts  (fontkit 은 `await import('fontkit')` — 편집기 lazy 청크 안)
export const SHAPING_BUDGET_BYTES = 24 * 1024 * 1024; export const SHAPING_MAX_FILE = 17 * 1024 * 1024;
export async function ensureTextShaping(scene: Scene): Promise<void>;      // features 켜진 TextNode 의 face 로드(LRU ≤24MB). 프리뷰는 미대기, 저장/복사/내보내기는 await
export function releaseTextShaping(): void;                                // LRU·Path2D 캐시 해제 — releaseScratch 옆(언마운트)
export function shapeSupports(family: string, weight: number, italic: boolean, f: keyof TextStyle['features']): boolean | 'unknown' | 'too-large';
export interface Shaper { measure(text: string): number /* oriented px */; outline(lines: { text: string; x: number; baseline: number }[]): Path2D; unitsPerEm: number }
export function shapeFor(o: TextNode): Shaper | null;                      // 기능 OFF·미로드·거부면 null — 49 layoutText 가 부른다
export function decorMetrics(o: TextNode): { underline: { y: number; thick: number }; strike: { y: number; thick: number } } | null;   // 폰트 표(post/OS2), 미로드 null
export async function outlineText(o: TextNode, layout: TextLayout): Promise<PathNode | null>;   // 46 fromPathCmds 경유, 조건 미달 null(호출부 토스트)
export function shapingState(): { loaded: { key: string; bytes: number }[]; bytes: number; glyphs: number };   // e2e·40 실측표

// src/components/image/FontPicker.tsx      — 45 Popover 콘텐츠
export function FontPicker(p: { value: { family: string; weight: number }; onPick(family: string, weight: number): void }): JSX.Element;
// src/components/image/TextInspector.tsx   — 45 인스펙터 텍스트 탭 콘텐츠 + 컨텍스트 바 콘텐츠
export function TextInspector(p: { nodes: TextNode[]; onLive(patch: Partial<TextStyle>): void; onCommit(patch: Partial<TextStyle>, label: string): void }): JSX.Element;
export function TextContextBarContent(p: TextInspectorProps): JSX.Element;
function patchTextStyle(node: TextNode, p: Partial<TextStyle>): TextNode;   // = applyPaintPatch(node, { typo: p }) (49 §3.9·37 §4) — 파일 내부
```

접점: 49 `layoutText` +≈8줄(`shapeFor`·`decorMetrics`) · 39 `drawText`(이미 `outline` 분기)·`strokePaint`(Path2D 공용) 변경 0 · 42 `outline` 액션 text 분기 +≈6줄 · 45 `ContextBar 'text'`·인스펙터 텍스트 탭에 위 컴포넌트 마운트 · 52 `outlineText:false` 게이팅 · 40 원장 `fontkit ≤24MB` 행 = `shapingState().bytes`.
e2e 훅(`window.__gpv.imageEditor`): `fonts: { list(): Promise<FontFaceInfo[]>; read(path): Promise<number /* byteLength */>; supports(family, weight, italic, feature); shaping(): ReturnType<typeof shapingState>; release(): void }`, `outline(id): Promise<boolean>`.

## 5. 단계

1. **Rust + IPC + fonts.ts**(45·49와 무관 — 먼저): `fonts.rs` 신규(≈170: 열거·분류·허용목록·read), `mod.rs`/`lib.rs`(+4), `Cargo.toml`(+2), `ipc.ts`(+25), `fonts.ts` 신규(≈120). `cargo test`: 분류 표(OS/2·PANOSE 바이트 픽스처 3개)·허용목록 거절. e2e 43 (f-1)~(f-4).
2. **FontPicker**(≈200) — 45 `Popover` 위, 최근·큐레이션·굵기 배지. e2e (f-5).
3. **TextInspector + TextContextBarContent**(≈320+80) — 49 `mixedTextStyle/textCss`, 51 텍스트 스타일 칩, 45 필드. e2e (f-6).
4. **text-shape.ts**(≈260): 착수 프로브 1시간 — `vite build`로 fontkit 청크 크기(gz)와 `process.` 1건의 정체 확인, malgun.ttf·batang.ttc(index)·NotoSansKR-VF(getVariation) 파싱 1회. 그 뒤 `ensure/release/shapeFor/shapeSupports/decorMetrics` + 49 `layoutText` 훅(+8) + `AnnotationLayer`(`ensureCache` 프리페치 +8, 언마운트 `releaseTextShaping` +1) + `ImageEditor`(저장·복사 경로 `await` +6). `package.json` +fontkit. e2e (f-7)~(f-10).
5. **outlineText**(+60) + 42 액션 분기(+6) + 토스트. e2e (f-11)~(f-13). 40 실측표에 `shapingState().bytes` 3시점 기입.

규모 **L**: Rust ≈ +180 · 프론트 ≈ +1,050 · 신규 의존 npm `fontkit 2.0.4`(MIT), cargo `fontdb 0.24`·`ttf-parser 0.25`(MIT, 순수 Rust) — 근거 §2·§3.1·§3.4.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| fontkit 브라우저 번들 | `process.` 참조 1건, 의존 10개의 ESM 호환 미확인 | 단계 4 첫 프로브(빌드 + 파싱 3개)로 확정 — `Buffer` 0건은 실측 완료. 실패 시 `dist/browser.cjs`+vite `commonjsOptions`로 우회 |
| `font_list` 콜드 시간 | 284파일 memmap·파싱(macOS·Linux는 파일 수가 다르다) | `spawn_blocking` + `OnceLock` 1회, 피커 첫 열기 전 편집기 마운트 시 `fontList()` 프리페치(background lane). 목표 ≤1.5s, 초과 실측이면 `class`/`hangul` 계산을 지연(피커가 요청한 family만) |
| 허용목록 문자열 비교 | 대소문자·구분자 차이로 정당한 경로 거절 | `path`는 fontdb `Source::File` 그대로 왕복 — JS가 가공하지 않는다. e2e (f-4) 왕복 단언 |
| 셰이핑 어드밴스 ≠ Blink | 반올림·kern 적용 차 | ±1px 허용(49 §3 계약 동일), (f-8) 폭 단언 |
| 힌팅 없는 패스 AA | 11px 이하에서 `fillText`와 미세 차이 | 인스펙터 OT 섹션 캡션 "작은 글자에서 미세한 차이" + (f-9) bbox ≤1px 게이트 |
| 저장 전 로드 미완료 | 프리뷰는 폴백, 저장은 정본 | 저장·복사·내보내기 3경로 전부 `await ensureTextShaping` — (f-10) |
| LRU 24MB 초과·17MB 거부 | 명조 대형 폰트에서 OT 불가 | 토글 비활성+사유 툴팁(정직), `ponytail:` 상한. 40 원장 행 |
| 가변 폰트 굵기 | Canvas는 `wght` 자동, fontkit은 `getVariation` 명시 | `resolveFace`가 VF면 `getVariation({wght: weight})` — (f-8) NotoSansKR-VF 500 폭 변화 단언 |
| 그룹/인스턴스 안 텍스트 윤곽선화 | `parentId`·트리 불변식 | `id`·`parentId` 유지·자리 교체(`objects.map`) — `tree.ts` 밖 재배열 0(INDEX §10.4) |
| 사용자 폰트 폴더 미열거(다른 OS) | macOS `~/Library/Fonts`·Linux fontconfig dirs | fontdb `load_system_fonts`가 처리(`:402-475`), Linux CI 컨테이너는 `fonts.conf` 부재 시 `load_no_fontconfig` 폴백(`:487`) — 실기 항목 |

## 7. 검증

- **e2e 43 (49 신설 스위트에 추가)**: (f-1) `fonts.list()` 콜드 ≤1.5s·두 번째 ≤50ms, 길이 ≥ 200(이 머신 284 face); (f-2) `Malgun Gothic` → `hangul true·class sans·family_ko '맑은 고딕'`, `Batang` → `collection true·index ≥0`, `Consolas` → `mono true`, `Pretendard` 9 face·weight 100~900·`path`가 `%LOCALAPPDATA%` 아래; (f-3) `classify` 한글 필터 → 전부 `hangul true`, 검색 `noto` → `Noto*`만; (f-4) `fonts.read(malgun.path)` `byteLength === file_size`, `read('C:/Windows/System32/config')` → 에러(NotFound), `read(path+' ')` → 에러; (f-5) 피커 DOM: `[role=dialog]` 안 칩 6·검색·행 `가나 Ag 123` computed `font-family` = 그 family, 선택 → `getDoc()` 노드 `fontFamily/fontWeight` 갱신 + textarea computed `font-family` 동일, 굵기 900 없는 family에 `합성` 배지, `gp:image-recent-fonts` 갱신; (f-6) 인스펙터 46 라벨 DOM 존재, 샘플 12 필드(크기·행간·자간·문단·들여쓰기·정렬·세로 정렬·자동 폭·밑줄·대소문자·말줄임 2줄·목록) 변경 → 노드 필드 1:1·히스토리 1칸씩, 두 노드 크기 14/28 → 크기 필드 `MIXED` 표시, `styleRefs.text` 있는 노드의 자간 변경 → `styleRefs.text` 해제; (f-7) `features.liga` ON(지원 face 있을 때 — 없으면 skip 기록) → `shaping().loaded` 1건·글리프 수 −1·잉크 폭 감소, 프리뷰 `[1]` == 저장본 픽셀; (f-8) `tnum` ON → `'1111'` 잉크 폭 == `'8888'` ±0.5, NotoSansKR-VF weight 500 → 폭 변화, `batang.ttc` face 로드 성공; (f-9) 기능 ON/OFF 같은 텍스트 잉크 bbox 차 ≤1px, 미지원 face → 토글 `disabled` + `title`에 사유; (f-10) 셰이핑 미로드 상태에서 `saveAs` → 파일 픽셀 == 로드 후 프리뷰(폴백 픽셀 아님); 3폰트 순차 로드 후 `shaping().bytes ≤ 24MB`, `release()` → 0; (f-11) `'가나 Ag'` `outline(id)` → 같은 id `kind 'path'`·`fills` 딥이퀄·`objectAABB` == 원 `layout.box` ±1·잉크 bbox 차 ≤1px, `rot 30` 텍스트도 픽셀 동일; (f-12) undo → `kind 'text'`·`text`·`styleRefs` 복귀; 미설치 family → 토스트 + `getDoc()` 불변 + `history.entries()` 길이 불변; (f-13) bullet 2줄 + 밑줄 → `subpaths`에 마커·밑줄 사각형 포함(글리프 수보다 많음), 저장본 픽셀 == 변환 전.
- **Rust `cargo test`**: OS/2·PANOSE 분류 표, 허용목록 외 경로 거절, 64MB 상한.
- **회귀**: 30(91)·34(32)·35(13) 무변경 통과 — `DEFAULT_FONT_FAMILY` 기본값이 그대로라 기존 텍스트 픽셀 동일.
- **실기**: Windows(이 머신) 피커 스크롤·한글 이름·Pretendard 9단; macOS 1회 — `~/Library/Fonts` 열거·`ipc::Response` 수신·fontkit 파싱(`ctx.filter`와 같은 실기 항목 묶음); Linux CI 빌드 통과(fontconfig-parser 순수 Rust).
