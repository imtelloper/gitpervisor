# 태스크 51 — 스타일 라이브러리(색·텍스트·효과)·컴포넌트/인스턴스·앱 전역 저장소·창 간 동기·에셋 패널

> 상태: 설계(Design) · 대상: gitpervisor · 근거: 코드 실측 2026-09-04(워킹트리) · 선행: 태스크 37(`styleRefs`·`InstanceNode`·`applyPaintPatch`), 38(`group(ids,'frame')`·`applyConstraints`·`rotateNodes`·`subtreeRange`),
> 41(라벨 커밋·사이드카 로드 훅), 45(Popover 셸·인스펙터 슬롯), 44(에셋 탭 슬롯·doc 창 `disable_drag_drop_handler`) · `DOCS/pro-image-editor-design.md` §3 K6(localStorage 기각 근거) ·
> 시안: `designs/image-editor-figma-v2.pen` ①(인스펙터 `스타일 · 경고/핑크`)②(텍스트 스타일)④(색 스타일 라이브러리·레이어 타입 필터)⑤(에셋·인스턴스 상태) · 상위: `00-INDEX.md` §10(51행·§10.3 시드 열린 질문) — **M3 마감(L).**

## 1. 요구사항

시안 ④ `색 스타일 라이브러리 · 색 스타일 · 스타일 검색 · 브랜드 › Primary / Blue 500 · Primary / Blue 700 · Accent / Purple · 상태 › Success · Warning · Danger · 경고 / 핑크 [적용됨] · 중립 › Text / Primary · Text / Tertiary · Surface / App`,
④ 색 피커 `색 스타일로 저장`, ① 채우기 섹션 `스타일 · 경고/핑크`, ② `텍스트 스타일 › 제목 / H1 · Pretendard Bold 28 · 130% · 본문 / Body · Pretendard Regular 14 · 150% · 캡션 / Caption · Pretendard Medium 11 · 140%`,
⑤ `에셋 · 에셋 검색 · 로컬 컴포넌트 › 번호 뱃지 · 말풍선 주석 · 지시선 · 범례 칩 · 워터마크 · 측정 라벨 · 화살표 주석 · 흐림 영역 · 프레임 캡션 · 인스턴스 상태 5 연결됨 · 2 재정의됨 · 1 분리됨`,
④ 레이어 타입 필터 `컴포넌트 · 재정의된 인스턴스`. 효과 스타일은 인벤토리에 문자열이 없다(① `효과` 섹션 + ④ `효과 편집`이 근거, 지시서 포함) — 색·텍스트와 같은 코드 경로의 슬롯 하나로만 들어간다.

받아들이는 조건:
- 스타일·컴포넌트는 **이미지를 넘어 재사용**된다(④ 브랜드/상태/중립은 이미지 하나에 묶일 값이 아니다). 앱을 재시작해도, 다른 창(doc-*)에서도 같은 라이브러리가 보인다.
- 노드에 스타일을 적용하면 값이 노드에 **복사**되고 참조가 남는다. 라이브러리에서 색을 고치면 참조 노드가 전부 바뀌고(히스토리 1칸), 노드를 직접 고치면 참조가 풀린다. 렌더는 라이브러리를 읽지 않는다(INDEX §10.4).
- 컴포넌트는 선택을 이름 붙여 저장한 것이고, 인스턴스는 캔버스에 놓인 사본이다. 인스턴스 자식의 페인트·텍스트를 바꾸면 **재정의됨**, 마스터를 갱신하면 연결된 인스턴스가 따라오되 재정의는 유지, 분리하면 보통 그룹이 된다. 마스터가 사라지면 인스턴스는 자동으로 분리된다.
- 렌더·히트·기하·히스토리·사이드카는 인스턴스를 **모른다** — 자식이 문서에 실제 노드로 있다(37 §3.2 결정). 이 태스크만 머지해도 M1~M3의 나머지가 그대로 동작한다.

## 2. 현황(근거)

- **스타일·컴포넌트 개념이 없다.** 툴바가 드는 값은 `ToolStyle`(`types.ts:223-241`) 하나고, 선택 노드에 값을 **복사**해 쓴다(`ImageEditor.tsx:626-642 onStyleChange` → `:152-172 restyle`, `:603-618` 선택→툴바 동기). 최근 색은 세션 상태 6개(`:70-71 RECENT_COLORS`, `:218`). 37이 `restyle/ToolStyle`을 `applyPaintPatch/DefaultPaint`로 대체하고 `NodeBase.styleRefs:{fill?,stroke?,text?,effect?: StyleId}`·`InstanceNode{kind:'instance';componentId;overrides}`·`GroupNode`를 정의한다(37 §4) — 값은 있으나 **라이브러리·전파·재정의 파생·UI가 없다.**
- **앱 데이터 원자 쓰기는 이미 있다**: `state.rs:129 SAVE_LOCK`(전 파일 직렬화) · `:131-133 data_path = app_data_dir/<file>` · `:141-172 load_json_at`(파싱 실패 시 `.corrupt`로 격리하고 기본값 — 잔해를 덮어쓰지 않는다) · `:176-189 save_json_at`(tmp → rename) · `:192-211 load_json/save_json`(`pub(crate)`, 파일 포맷 `{"<키>": <값>}`). 41의 사이드카가 같은 루트를 쓴다(INDEX §10.2 "사용자 데이터 루트 하나").
- **`tauri-plugin-store`는 Rust에만 등록**(`lib.rs:843`)돼 있고 JS 패키지는 없다(`package.json`·`src` grep 0). 있어도 손상 격리가 없어 `state.rs`보다 못하다. `settings.json`은 `settings-index.ts:2`의 e2e 29 완전성 가드가 **모든 키의 설정 UI 노출**을 강제하므로 블롭이 들어갈 자리가 아니다. `localStorage`는 pro 설계 §3 K6(`:83`)가 `gp:file-draft:*`(복구 불가능한 미저장 파일 내용)와의 5MB 경쟁으로 기각했다.
- **창 간 신호 관례**: Rust `app.emit`은 전 창 브로드캐스트(`video.rs:802-812 ExportFinished`, `watcher.rs:102`), 프론트는 창마다 `listen`(`events.ts:56-74`, `DocWindow.tsx:75-93`)하고 자기 창이 시작한 것만 토스트한다(`events.ts:33-44 localVideoJobs`). 창의 zustand 스토어는 창마다 별개다(`DocWindow.tsx:42-44`); 자기 라벨은 `getCurrentWebviewWindow().label`(`floating.ts:59-65`).
- **문서 변경 깔때기**: `applyDoc(next, mode)`(`ImageEditor.tsx:241-250`) 하나 — 41이 `label`을 붙인다. `history.ts:46-54 commit`은 참조를 그대로 쌓으므로 바뀐 서브트리만 새 참조여야 비용이 배열 복사뿐이다. 이미지 회전/반전은 `rotateBy/flipBy`(`:472-486`) → `transformObjects`(`geometry.ts:484-531`, 규칙 R-ROT: 사각형은 꼭짓점 재정규화·`rot` 유지, 반전은 `rot→−rot`) — 축정렬 사각형 표현은 **미러링·180° 정보를 잃는다**(§3.4의 인스턴스 방향 결정 근거).
- **드롭 좌표 변환**은 `AnnotationLayer.tsx:339-350 toOriented(e: PointerEvent)`뿐(clientX/Y 판이 없다). 핸들은 `:101-111 AnnotationLayerHandle`(`:724 useImperativeHandle`). HTML5 DnD는 메인 창만 산다 — `lib.rs:893 .disable_drag_drop_handler()`(주석 `:890-892`: WebView2가 OS 핸들러로 HTML5 drop을 가로챈다), `open_doc_window` 빌더(`:527-536`)에는 **그 줄이 없다** → doc 창(편집기의 주 무대, `App.tsx:200-208` 메인 마운트는 e2e 전용)에서 drop이 죽는다. INDEX 44행이 그 1줄을 44에 배정했다.
- **단축키 충돌**: `KeyboardShortcuts.tsx:82-83`이 `ctrlKey`만 보고 `:122-126`에서 `k` → 커밋(shift면 push) — `altKey`를 검사하지 않아 **Ctrl+Alt+K가 커밋 폼을 연다.** 42의 window capture 리스너가 `consume`으로 막는 자리(42 §4 표에 행 2개).
- **e2e 관례**: 페이지 훅은 `window.__gpv.imageEditor`(`ImageEditor.tsx:950-964`), `__gpvAnno`는 30이 설치하는 스위트 헬퍼(`30:503`)이며 30의 `HELPERS`는 지역 문자열이라 재사용 불가(`35:24-27`) — 38 스위트는 자기 헬퍼를 설치한다. doc 창 접속은 `cdp.mjs:263 connectLabel`. 라이브러리는 **앱 전역**이라 e2e가 개발자의 dev 라이브러리(`com.greathoon.gitpervisor.dev` 데이터 루트)를 지울 수 있다 — 스냅샷·복원이 필요하다.
- 심사 판정(정합성 major·실현가능성 major): 스타일 저장소 4벌(문서 로컬·앱 전역·localStorage 2) → **앱 전역 파일 + 노드 값 복사(스냅샷 중복 없음)**, 컴포넌트 2벌(렌더 시 확장 vs 물질화) → **물질화**, `components.ts/styles.ts` 중복 신규 → 이 문서 하나.

## 3. 설계

### 3.1 저장소 — `app_data_dir/image-library.json` 키 `library`, Rust 커맨드 2개

| 대안 | 평가 |
|---|---|
| **A. 앱 전역 파일 1개(`state.rs` `load_json/save_json` 재사용), 8MB 상한, 저장 후 `image-library://changed{origin}` emit** (채택) | 손상 격리·원자 rename·`SAVE_LOCK`을 Rust 0줄 재작성으로 얻는다. 시안 ④ 브랜드/상태/중립·⑤ 워터마크·범례 칩은 이미지 간 재사용물 |
| B. 문서 로컬(`doc.styles/components`) | 이미지마다 브랜드 색을 다시 입력. 사이드카가 문서마다 라이브러리 사본을 든다 |
| C. 로컬 + 전역 2스코프 | 승격/이동 UI가 코드를 두 배로. 요구 0 |
| D. `localStorage` | K6 — 5MB origin을 복구 불가능한 초안과 나눈다. 펜 점 수천 개 컴포넌트가 밀어낸다 |
| E. `tauri-plugin-store` / `settings.json` | JS 미설치·손상 격리 없음 / e2e 29 가드가 설정 UI 노출을 강제 |

두 창이 300ms 안에 동시에 저장하면 **나중 저장이 이긴다**(같은 프로세스라 `SAVE_LOCK`이 tmp 충돌만 막는다). 개인 도구·마우스 하나라 실사용 발생 조건이 없다 — `ponytail: 41의 stamp+Conflict 재사용과 id 병합(삭제 부활 문제 포함)이 필요해지면 그때`. 52의 내보내기 프리셋은 같은 파일에 슬라이스로 얹는다(→ 52 §4) — `normalizeLibrary`는 모르는 키를 보존한다.

### 3.2 스타일 참조 — 값 복사 + `styleRefs[slot] = StyleId`

| 대안 | 평가 |
|---|---|
| **A. 적용 시 페인트/타이포/효과를 노드에 복사하고 `styleRefs[slot]`만 남긴다** (채택, 37 §4 형태) | 렌더·히트·AABB(`paintExtent`가 선 두께를 본다)가 라이브러리를 몰라도 되고, 라이브러리가 지워져도·다른 머신에서 열어도 문서가 자기완결. `styleState`는 노드 값 vs 라이브러리 값 비교로 충분 |
| B. 참조만(렌더 시 조회) | 렌더가 문서 밖 상태를 읽는다 — WYSIWYG·히스토리 결정론이 깨진다(INDEX §10.4 위반) |
| C. 참조 + `snapshot` 동봉(export 축) | 노드 값과 중복. 'stale' 판정은 A로도 된다 |

자동 분리 규칙(37 `applyPaintPatch`가 구현, 이 문서가 소유): 패치에 `fills` → `styleRefs.fill` 삭제, `strokes` → `stroke`, `effects` → `effect`, 타이포 키(`TextStyleProps` 중 하나) → `text`. `strokeWidth`·`opacity`·`blend`는 스타일 값이 아니므로 분리하지 않는다.

### 3.3 이름·그룹·상태·전파

- **이름 = 경로 하나**(`'상태 / 경고 / 핑크'`). 첫 세그먼트가 섹션, 나머지가 표시 이름. 같은 첫 세그먼트가 **2개 이상일 때만** 섹션 헤더로 접고 아니면 전체 이름을 그대로 보인다 — ④(브랜드 3·상태 4·중립 3 → 헤더)와 ②(제목/본문/캡션 각 1 → `제목 / H1` 전체 표기)가 규칙 하나로 나온다. 인스펙터 칩은 표시 이름(① `경고/핑크`).
- `styleState(node, slot, lib)`: `none`(참조 없음) · `linked`(값 == 라이브러리) · `stale`(값 ≠ 라이브러리 — 재동기 전, 또는 '스타일 갱신' 커밋을 undo한 뒤) · `missing`(라이브러리에 없음). ④ `적용됨` 배지 = 선택 전부의 `styleRefs[slot] === id`.
- 편집 전파 = `resyncStyles(doc, lib)`: 참조가 있고 값이 다른 노드만 재기록해 **커밋 1칸 '스타일 갱신'**, `missing`은 분리(값 유지). 실행 시점은 §3.7 하나(라이브러리 참조 변경). 삭제는 라이브러리에서 빼는 것으로 끝 — 열린 문서는 재동기가, 닫힌 문서는 다음 로드가 분리한다.
- 내장 텍스트 스타일 3종(② H1/Body/Caption)은 첫 로드에 한 번 심고 `seeded:true`를 기록한다 — 사용자가 지우면 돌아오지 않는다.

### 3.4 컴포넌트 — 정의는 라이브러리에, 인스턴스는 물질화되고 **프레임 자식이 변환을 든다**

| 대안 | 평가 |
|---|---|
| **A. `ComponentDef.nodes = [루트 FrameNode(0,0,w,h) + 자손(로컬 좌표)]`. 인스턴스 = `InstanceNode` 아래 그 서브트리를 실제 노드로 물질화(id `${inst}/${defId}`). 인스턴스의 위치·크기·회전은 **첫 자식 프레임의 기하**가 든다** (채택) | 이동·리사이즈·회전·직선화·제약 재배치·히트·마퀴·AABB·히스토리·사이드카 전부 38의 프레임 처리로 **공짜**(코드 0). 재물질화(§3.6)는 `applyConstraints(def 프레임 → 현재 프레임)` + `rotateNodes(frame.rot)` 두 호출 — 인스턴스 기하 필드·변환 훅이 필요 없다 |
| B. 렌더 시 확장(document 축 원안) | Scene·히트·마퀴·히스토리가 "문서에 없는 노드"를 다룬다(`owner` 특수 매핑, 37 §3.2 탈락 사유) |
| C. `InstanceNode`에 `x,y,rot,flipH` 필드 | 38의 `translateSubtree/rotateNodes/transformObjects`·48의 `straightenObjects` 네 곳이 그 필드를 갱신해야 한다 |
| D. 자식 한 쌍의 앵커 차로 변환 유추 | 텍스트 재정의로 폭이 바뀌면 앵커가 흔들리고, 반전·180°는 유추 불가 |

- `makeComponent(objects, ids, name)`: `tree.group(ids,'frame')`(38)로 합집합 rect 프레임에 감싼다(`fills/strokes:[]`·`clipsContent:false` — 그리지 않는다) → 서브트리를 프레임 원점으로 옮긴 사본이 `def.nodes` → 프레임 서브트리를 `InstanceNode` + 접두 id 자식으로 치환(기하 그대로, `overrides:{}`) → 라이브러리 upsert(썸네일 ≤96px PNG dataURL, `renderScene(…, {background:'transparent'})` 1회). 선택에 인스턴스가 있으면 거부(토스트 "먼저 분리") — **중첩 인스턴스 없음**이 순환 검사를 대체한다.
- `instantiate(def, at)`: 자식 접두 id·`parentId` 재매핑·`translateObject`(리프·프레임)로 `at`에 배치 → `insertNodes`(루트 끝에 서브트리 append — DFS 불변식 유지, `assertTreeInvariant` 통과) + 선택. 카드 드래그 → 드롭 좌표에 프레임 중심, 더블클릭 → 이미지 중심.
- 상호작용 규칙(38/42/43/45가 소비): 클릭은 38 기본(`topLevelAncestor` = 인스턴스). 더블클릭으로 들어간 자식은 **페인트·텍스트만** 편집 대상 — 이동·nudge는 `moveUnit(objects,id)`(인스턴스 조상이 있으면 그 id)로 인스턴스 전체를 옮기고, 자식 선택 상자는 핸들 없음(43 `ChromeState.selection[].handles=false`), 45 위치/크기 필드는 읽기 전용. 인스턴스 자체의 리사이즈 = 프레임 자식 리사이즈(38 `applyConstraints` 재배치 = Figma 제약 동작), 회전 = `rotateNodes`(리프에 굽고 프레임 `rot` 누적).
- **이미지 90° 회전·반전(`rotateBy/flipBy`)은 인스턴스를 분리한다**(토스트 "회전/반전으로 인스턴스 N개를 분리했습니다", undo 1칸으로 복귀). 근거: R-ROT의 사각형 표현이 미러·180°를 잃어 프레임이 방향을 들 수 없다(§2). 스크린샷 도구에서 인스턴스를 놓은 **뒤** 이미지를 회전하는 흐름은 드물다 — `ponytail: 프레임에 quarter/mirror를 기록하고 37 frame stub(transformObjects)을 'w,h 유지·중심 회전·rot±90'으로 바꾸면 유지 가능`. 직선화(48)는 `rot` 누적이라 유지된다.

### 3.5 재정의 — 커밋 시 파생

`diffInstance(doc, lib)`를 `applyDoc`의 **commit 경로**에서만(라이브 갱신 제외) 돈다 — 인스턴스가 없으면 즉시 반환. 인스턴스마다 def 노드 `m`과 자식 `c = ${inst}/${m.id}`를 비교해 `INSTANCE_FIXED_KEYS`(id·parentId·kind·x·y·w·h·rot·pts·x1..y2·subpaths·componentId·overrides·detachedFrom·mask·constraints·exportRows·locked) 밖의 키 중 다른 것만 `overrides[c.id]`에 적는다(깊은 비교는 `JSON.stringify` — 값이 작다). 자식이 **없으면** `{visible:false}`(Figma: 인스턴스 안 삭제 = 숨김 — 42의 Delete 경로 수정 0). 접두 없는 **떠돌이 노드**(그리기·붙여넣기가 인스턴스 안에 넣은 것)는 인스턴스 부모 바로 뒤로 `reparent`(38)해 뺀다 — 42/44/47이 무엇을 하든 "인스턴스 서브트리 ⊆ def id"가 커밋마다 회복된다. 기하 차이는 무시(재정의 아님·§3.4 규칙이 막는다).

| 대안 | 평가 |
|---|---|
| **커밋 시 diff 파생** (채택) | 자식을 캔버스·인스펙터에서 편집하는 모든 경로(색·텍스트·숨김·삭제)에 훅이 필요 없다. 비용 = 인스턴스 × 자식 × 키 수, 커밋당 1회 |
| 명시 `setOverride` API만 | 인스펙터·팝오버·컨텍스트 바·키보드가 전부 그 API를 알아야 한다 |
| 자식 위치·크기 재정의 허용 | 마스터 구조 변경과의 3-way 병합. Figma도 오토레이아웃 없이는 제한(INDEX §10.5 승계) → 분리 후 편집 |

### 3.6 재물질화·마스터 갱신·분리·삭제

- `applyOverrides(def, frame, instId, overrides)`: def 노드 접두 id → `applyConstraints(child, {0,0,def.w,def.h}, frame rect)`(38, 중첩 프레임 재귀 규칙 그대로) → `frame.rot ≠ 0`이면 `rotateNodes(…, frame.rot, frame 중심)` → `{...node, ...overrides[id]}`. 순수 함수 — 같은 입력이면 같은 서브트리라 **현재 서브트리와 깊은 동치면 커밋하지 않는다**(라이브러리가 바뀔 때마다 빈 커밋이 쌓이지 않는다).
- `resolveInstances(doc, lib)`: 인스턴스마다 def 조회 → 없음 → `detachInstance`(토스트 "컴포넌트 '<이름>'이 라이브러리에 없어 인스턴스 N개를 분리했습니다") · 있음 → `applyOverrides` 결과로 서브트리 치환. 바뀐 것이 있으면 커밋 1칸 '컴포넌트 갱신'.
- `pushToMaster(doc, lib, instId)`('이 인스턴스로 마스터 갱신'): 인스턴스 서브트리를 `rotateNodes(−frame.rot)` 후 프레임 원점으로 옮겨 def로(썸네일 재생성, `updatedAt`), 이 인스턴스의 `overrides:{}`. 라이브러리 upsert → §3.7이 같은 문서의 다른 인스턴스와 다른 창을 갱신(재정의 유지). Figma식 캔버스 마스터 편집 모드는 없다 — 문서가 이미지 1장이라 마스터를 놓을 아트보드가 없다(INDEX 51행).
- `detachInstance(objects, instId)`: `InstanceNode` → `GroupNode{detachedFrom: componentId}`, 자식 id는 새 uuid·`parentId` 재매핑(마스터 id와의 연결 소멸). Ctrl+Alt+B(Mac ⌥⌘B). `resetOverrides` = `overrides:{}`로 `applyOverrides`.
- `instanceState(node)`: `kind==='instance'` → `Object.keys(overrides).length ? 'overridden' : 'linked'`; `kind==='group' && detachedFrom` → `'detached'`; 그 외 `null`. ⑤ `5 연결됨 · 2 재정의됨 · 1 분리됨`은 문서 전체 집계, ④ 필터 `컴포넌트`=`kind==='instance'`·`재정의된 인스턴스`=`'overridden'`(44가 술어만 가져간다). 마스터 삭제(38 `remove`가 컴포넌트 마스터를 지우는 경우는 없다 — 마스터는 캔버스에 살지 않는다) → 라이브러리 삭제 = §3.7 경로로 분리.

### 3.7 창 간 동기 — 신호는 Rust emit, 문서 재동기 경로는 하나

`useImageLibrary`(창별 zustand 싱글턴): 첫 사용 시 `image_library_get` → `normalizeLibrary`(빈 배열 기본값·모르는 키 보존) → 시드 → `ready`. 변경 함수(`upsert*/remove*/rename*`)는 `set` 뒤 **300ms 디바운스·단일 비행** `image_library_set`, `pagehide`에서 `flush()`(41과 같은 규칙). `listen('image-library://changed')`는 `origin !== 자기 라벨`일 때만 재로드(자기 창은 이미 최신). 편집기는 `useImageLibrary(s => s.lib)` 참조 변경 **하나**에 effect를 걸어 `resyncStyles` + `resolveInstances`를 돈다 — 자기 창의 편집(이벤트 불필요)·남의 창의 편집(이벤트 → 재로드 → 참조 변경)·문서 로드 직후(41 `load` → `hist.reset` 뒤 effect 1회)가 같은 코드다.

| 대안 | 평가 |
|---|---|
| **Rust `app.emit` + origin 필터** (채택) | `video://`·`repo://changed` 관례 그대로, 창이 몇 개든 리스너 1개 |
| `storage` 이벤트 | 저장소가 localStorage가 아니다 |
| 폴링 | 탈락 |

### 3.8 UI — 콘텐츠는 여기, 셸은 45/44/50

- `StyleLibrary({slot, mode:'popover'|'inline'})` — 검색(대소문자 무시·표시 이름·섹션 이름)·섹션 접기·행(색 칩 / `가나 Ag` 텍스트 샘플 / 효과 요약)·`적용됨` 배지·클릭 적용·우클릭 이름 변경(`askPrompt`)/삭제(`askConfirm`, "참조 노드 N개의 값은 유지되고 연결만 풀립니다"). `mode:'popover'`는 45 `Popover` 안(④), `'inline'`은 ② 텍스트 스타일 목록(50 `TextInspector`가 마운트).
- `StyleRow({slot})` — ① `스타일 · 경고/핑크` 칩 + 분리 버튼. `stale`이면 칩에 '갱신 가능'(클릭 = 그 노드만 재동기). 45가 채우기/선/효과 섹션, 50이 텍스트 섹션에 마운트.
- '색 스타일로 저장'(④ 색 피커)·'효과 편집' 저장은 45 컴포넌트의 버튼 1개가 `saveStyleFromNode(node, slot, name)`을 부른다(이름 `askPrompt`, 기본값 현재 색 hex).
- `InstanceSection` — 선택이 인스턴스(또는 그 자식)일 때 인스펙터 상단: 컴포넌트 이름·상태(연결됨/재정의됨) · `재정의 초기화` · `이 인스턴스로 마스터 갱신` · `분리`. 45 속성 탭 슬롯.
- `AssetsPanel` — 44 좌측 패널 `에셋` 탭 콘텐츠: `에셋 검색` · `로컬 컴포넌트` 카드 그리드(썸네일·이름)/목록 토글(.pen 아이콘, 텍스트 라벨 없음) · 카드 `draggable`(`dataTransfer 'application/x-gpv-component'`) · 더블클릭 배치 · 우클릭 이름 변경/삭제(삭제는 "인스턴스 N개가 분리됩니다" 확인) · 하단 `인스턴스 상태` 3칩(문서 집계). 스테이지(`ImageEditor stageRef`)에 `onDragOver(preventDefault)/onDrop` → `layerRef.clientToOriented(clientX, clientY)` → `instantiate`.
- 단축키 2행(42 §3.4 표 컴포넌트 그룹, id 그대로): `component.make` Ctrl+Alt+K(⌥⌘K, `when:'hasSelection'`, consume — `KeyboardShortcuts.tsx:122` 커밋 충돌) · `component.detach` Ctrl+Alt+B(⌥⌘B, `when:'hasSelection'`). 시안 ⑧ 글리프에는 없다 — INDEX §10.3 열린 질문.

### 3.9 시드 9종 — 열린 질문(INDEX §10.3 기본값 "예")

⑤의 `번호 뱃지 · 말풍선 주석 · 지시선 · 범례 칩 · 워터마크 · 측정 라벨 · 화살표 주석 · 흐림 영역 · 프레임 캡션`은 사용자 저장물의 예시 화면일 수도, 기본 제공물일 수도 있다. 기본값대로면 `seed-components.ts`가 `seeded`가 아닐 때 한 번 생성한다 — badge / rect+text(말풍선 꼬리는 46 `path` 프리셋 뒤에 교체, 그 전엔 사각형) / line+text / rect+ellipse+text / text(opacity .3) / rect+text / arrow+text / mosaic(blur) / frame+text. 응답이 "아니오"면 단계 6을 뺀다.

### 3.10 만들지 않는 것

- 중첩 인스턴스(컴포넌트 안 인스턴스)·인스턴스 자식 위치/크기 재정의·Figma 변형(variants)/컴포넌트 속성·캔버스 마스터 편집 모드·원격/공유 라이브러리·라이브러리 병합(충돌은 나중 저장 승리)·문서 로컬 스타일·`.gpv` 라이브러리 내보내기/가져오기(열린 질문 아님, 요구 0).
- 렌더/히트/기하 변경(→ 38·39), Popover·색 피커·효과 편집기(→ 45), 텍스트 인스펙터 셸(→ 50), 레이어 패널 행·필터 UI(→ 44), 내보내기 프리셋(→ 52), doc 창 `disable_drag_drop_handler`(→ 44).

## 4. 계약 (소유: 51 · `src/lib/annotate/styles.ts`, `components.ts`, `src/stores/imageLibrary.ts`, `src-tauri/src/commands/library.rs`)

```ts
// types.ts 에 37 이 추가(51 요청, 정의 텍스트는 여기): StyleId·ComponentId = string(uuid)
export interface ColorStyle  { id: StyleId; name: string /* '섹션 / 이름' */; paint: Fill; updatedAt: number }
export type  TextStyleProps  = Pick<TextStyle, 'fontFamily'|'fontWeight'|'italic'|'fontSize'|'lineHeight'|'letterSpacing'|'paragraphSpacing'|'indent'|'underline'|'strike'|'textCase'|'features'>;
export interface TextStyleDef{ id: StyleId; name: string; style: TextStyleProps; updatedAt: number }
export interface EffectStyle { id: StyleId; name: string; effects: Effect[]; updatedAt: number }
export interface ComponentDef{ id: ComponentId; name: string; nodes: Node[] /* [0] = 루트 FrameNode (0,0,w,h) rot 0, 그리지 않음 */; w: number; h: number; thumb: string /* data:image/png ≤96px */; updatedAt: number }
export type  InstanceOverride = Partial<Omit<NodeBase,'id'|'parentId'|'constraints'|'mask'|'exportRows'|'locked'>> & Partial<TextStyle>
  & { text?: string; radius?: RectObject['radius']; n?: number; fontSize?: number; mode?: MosaicMode; strength?: number; fillRule?: PathNode['fillRule']; clipsContent?: boolean };
// 37 §4 수정 요청(반영됨 2026-09-04 — 37 §4가 정본): InstanceNode { kind:'instance'; componentId: ComponentId; overrides: Record<ObjId, InstanceOverride> } — `children: Node[]` 삭제(자식은 objects 평탄 슬라이스, 38 §3.1 불변식과 중복)
//                 GroupNode { kind:'group'; detachedFrom?: ComponentId } · normalizeNode 가 componentId/overrides/detachedFrom 보존 · id 에 '/' 허용
export interface ImageLibrary { v: 1; colorStyles: ColorStyle[]; textStyles: TextStyleDef[]; effectStyles: EffectStyle[]; components: ComponentDef[]; seeded: boolean } // 52 가 exportPresets·exportDefaults 슬라이스 + upsertExportPreset/removeExportPreset/setExportDefaults 추가(52 §4)

// styles.ts (순수)
export type StyleSlot = 'fill' | 'stroke' | 'text' | 'effect';
export function styleSection(name: string): { section: string | null; display: string };          // 첫 '/' 세그먼트, 2개 이상 공유할 때만 섹션(호출자가 groupStyles 로 판단)
export function groupStyles<T extends { name: string }>(items: T[], query: string): { section: string | null; items: T[] }[];
export function applyStyle(node: Node, slot: StyleSlot, style: ColorStyle | TextStyleDef | EffectStyle): Node; // 값 복사 + styleRefs[slot]
export function detachStyle(node: Node, slot: StyleSlot): Node;                                     // 참조만 제거
export function styleFromNode(node: GeomNode, slot: StyleSlot, name: string): ColorStyle | TextStyleDef | EffectStyle;
export function styleState(node: Node, slot: StyleSlot, lib: ImageLibrary): 'none' | 'linked' | 'stale' | 'missing';
export function resyncStyles(doc: EditorDoc, lib: ImageLibrary): EditorDoc;                          // 변경 없으면 같은 참조
export const STYLE_DETACH_KEYS: Record<StyleSlot, readonly string[]>;                                // 37 applyPaintPatch 자동 분리 규칙(§3.2)

// components.ts (순수 — 38 tree/geometry 만 호출)
export function makeComponent(objects: readonly Node[], ids: readonly ObjId[], name: string, thumb: (nodes: Node[]) => string): { objects: Node[]; def: ComponentDef; instanceId: ObjId }; // 인스턴스 포함 선택 → throw
export function instantiate(def: ComponentDef, at: { x: number; y: number }): Node[];               // [InstanceNode, frame, …] 새 id 접두, at = 프레임 중심
export function instanceFrame(objects: readonly Node[], instId: ObjId): FrameNode;                   // 첫 자식
export function moveUnit(objects: readonly Node[], id: ObjId): ObjId;                                 // 인스턴스 조상 있으면 그 id
export function applyOverrides(def: ComponentDef, frame: FrameNode, instId: ObjId, overrides: Record<ObjId, InstanceOverride>): Node[];
export function diffInstance(doc: EditorDoc, lib: ImageLibrary): EditorDoc;                        // 커밋 시 · 떠돌이 노드 reparent · 변경 없으면 같은 참조
export function resolveInstances(doc: EditorDoc, lib: ImageLibrary): { doc: EditorDoc; detached: { name: string; count: number }[] };
export function resetOverrides(doc: EditorDoc, lib: ImageLibrary, instId: ObjId): EditorDoc;
export function detachInstance(objects: readonly Node[], instId: ObjId): Node[];
export function detachAllInstances(objects: readonly Node[]): { objects: Node[]; count: number };     // rotateBy/flipBy 훅
export function pushToMaster(doc: EditorDoc, instId: ObjId, def: ComponentDef, thumb: (nodes: Node[]) => string): { doc: EditorDoc; def: ComponentDef };
export function instanceState(node: Node): 'linked' | 'overridden' | 'detached' | null;
export function instanceCounts(objects: readonly Node[]): { linked: number; overridden: number; detached: number };
export const INSTANCE_FIXED_KEYS: ReadonlySet<string>;

// stores/imageLibrary.ts (창별 zustand)
export const useImageLibrary: { lib: ImageLibrary; ready: boolean; ensure(): Promise<void>; flush(): Promise<void>;
  upsertColorStyle(s); upsertTextStyle(s); upsertEffectStyle(s); removeStyle(slot, id); renameStyle(slot, id, name);
  upsertComponent(d); removeComponent(id); renameComponent(id, name);
  saveStyleFromNode(node: GeomNode, slot: StyleSlot, name: string): StyleId };                       // = styleFromNode + upsert — 45 색 피커 '색 스타일로 저장'·효과 편집·50 텍스트 스타일 `+` 가 부른다
                                                                                                    // 변경 → 300ms 디바운스 저장, 자기 origin 이벤트 무시
export const LIBRARY_MAX_BYTES = 8 * 1024 * 1024;

// ImageEditor 배선
applyDoc(next, 'commit', label) 앞에 next = diffInstance(next, lib)   · useEffect([lib]) → resyncStyles/resolveInstances → applyDoc(…, '스타일 갱신' | '컴포넌트 갱신') + 분리 토스트
rotateBy/flipBy: detachAllInstances 후 변환(count>0 이면 토스트)          · insertNodes(nodes, label) = applyDoc({…doc, objects:[…objects, …nodes]}) + ui.select
AnnotationLayerHandle.clientToOriented(clientX, clientY): Point           // toOriented(:339) 가 이것을 호출하도록 분리
// 42 EDITOR_SHORTCUTS: component.make Ctrl+Alt+K · component.detach Ctrl+Alt+B (Mac ⌥⌘K/⌥⌘B, consume) → 42 §3.4
// 43 ChromeState.selection[].handles=false (인스턴스 자식) · 44 필터 술어 kind==='instance' / instanceState==='overridden' · 45 StyleRow/InstanceSection 슬롯·위치 필드 읽기 전용 → 각 §4
```

```rust
// src-tauri/src/commands/library.rs  (mod.rs +2, lib.rs generate_handler :943 옆 +2)
const LIBRARY_FILE: &str = "image-library.json"; const LIBRARY_KEY: &str = "library"; const MAX_BYTES: usize = 8 << 20;
#[tauri::command] pub fn image_library_get(app: AppHandle) -> Option<String>                       // state::load_json::<serde_json::Value> → to_string; 없거나 손상(.corrupt 격리) → None
#[tauri::command] pub fn image_library_set(app: AppHandle, window: tauri::WebviewWindow, json: String) -> Result<(), IpcError>
//   json.len() > MAX_BYTES → Io("이미지 라이브러리 8MB 초과") · serde_json::from_str::<Value> 실패 → Io · state::save_json(&app, LIBRARY_FILE, LIBRARY_KEY, &value, "이미지 라이브러리")
//   → app.emit("image-library://changed", LibraryChanged { origin: window.label() })              // origin 은 JS 가 아니라 창 핸들에서
```

```ts
// src/lib/ipc.ts
imageLibraryGet(): Promise<string | null>                     // call(읽기, 재시도 허용)
imageLibrarySet(json: string): Promise<void>                   // callMutating 30s
// e2e 훅(DEV): window.__gpv.imageLibrary = { get(): ImageLibrary; set(lib): Promise<void>; flush(): Promise<void> }
// window.__gpv.imageEditor.styles = { save(nodeId, slot, name): StyleId; apply(ids, slot, id); detach(ids, slot); edit(slot, id, patch); remove(slot, id); state(nodeId, slot) }
// window.__gpv.imageEditor.components = { make(ids, name): ComponentId; place(id, x, y): ObjId; detach(instId); push(instId); reset(instId); state(id); counts() }
```

## 5. 단계

1. **Rust + IPC**: `library.rs` 신규(≈80) + `mod.rs`/`lib.rs`(+4) + `ipc.ts`(+12). `cargo test` 2개: 8MB 거부·`load_json_at` 손상 격리(기존 테스트 재사용). 이 단계만으로 다른 창의 `image-library://changed` 수신을 실기로 확인.
2. **`stores/imageLibrary.ts`** 신규(≈180: normalize·ensure·디바운스 저장·flush·listen·시드 텍스트 3종) + 37 `types.ts` 수정 요청 반영(+30).
3. **`styles.ts`** 신규(≈200) + 37 `applyPaintPatch`의 `STYLE_DETACH_KEYS` 연동(schema.ts +8) + `ImageEditor` `useEffect([lib])` 재동기(+25).
4. **`components.ts`** 신규(≈320: makeComponent·instantiate·applyOverrides·diffInstance·resolveInstances·push·detach·counts·썸네일) + `ImageEditor`(`applyDoc` 파생 1줄·rotateBy/flipBy 훅·insertNodes·드롭·훅 ≈+60) + `AnnotationLayer`(`clientToOriented`·move 분기 `moveUnit` +15).
5. **UI**: `StyleLibrary.tsx`(≈300)·`StyleRow.tsx`(≈80)·`InstanceSection.tsx`(≈120)·`panels/AssetsPanel.tsx`(≈320). 45/44/50 슬롯에 마운트, 42 표 2행.
6. **시드**(열린 질문 "예"일 때): `seed-components.ts`(≈120).
7. **e2e** `38-image-components-styles.mjs` 신설(≈340, INDEX §10.4 번호) + `run.mjs` 1줄(35 뒤).

규모 **L**: Rust ≈ +85 · 프론트 ≈ +1,750 · e2e ≈ 340 · 신규 의존 0. 메모리: 라이브러리 JSON ≤ 8MB(실사용 수십 KB — 썸네일 9×≈4KB), 40 원장에 별도 행 없음(<1MB).

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| e2e가 개발자 dev 라이브러리를 지움 | 라이브러리는 앱 전역·창 무관 | 스위트 시작에 `imageLibrary.get()` 스냅샷, `finally`에서 `set(snapshot)`; 생성물은 `e2e:` 접두, 다음 실행 시작에 잔존 `e2e:` 정리 |
| 90°/반전이 인스턴스를 분리 | 사용자가 놀란다 | 토스트 + undo 1칸 복귀, TROUBLESHOOTING 1줄. `ponytail:` 천장(§3.4) |
| 커밋마다 `diffInstance` | 인스턴스 × 자식 × 키 비교 | 인스턴스 없으면 즉시 반환, 값 비교는 소형 JSON — 5,000노드·인스턴스 50에서도 ms |
| 라이브러리 변경 → 빈 커밋 폭주 | 창마다 '스타일 갱신'이 쌓인다 | 재동기 결과가 깊은 동치면 커밋하지 않는다(§3.6) — 실제로 바뀐 창만 1칸 |
| 두 창 동시 저장 | 나중 저장이 이긴다 | §3.1 명시. 300ms 안 동시 편집은 마우스 하나로 불가능; 41의 stamp 방식이 후속 |
| 떠돌이 노드 자동 이동 | 사용자가 인스턴스 안에 그린 것이 밖으로 나간다 | 커밋 직후 선택은 유지되고 위치도 같다(부모만 바뀜). 42 그리기 scope가 인스턴스를 피하면 발생 0 |
| doc 창 HTML5 drop | 44의 `disable_drag_drop_handler` 1줄 없이는 죽는다 | 44 선행 deps. 더블클릭 배치가 폴백이라 기능은 살아 있다. e2e (l)이 doc 창에서 검증 |
| Ctrl+Alt+K가 커밋 폼을 연다 | `KeyboardShortcuts.tsx:122` alt 미검사 | 42 캡처 리스너 `consume` + 42 프로브 e2e 행 |
| 썸네일 생성이 39 렌더에 의존 | M1 전에는 그릴 수 없다 | M3 순서(INDEX §10.1)라 전제 충족. 실패 시 빈 dataURL — 카드는 이름만 |
| 8MB 초과 | 펜 점 수천 개 컴포넌트 다수 | 저장 거부 토스트 + 마지막 성공본 유지(파일은 원자 rename이라 손상 없음) |

## 7. 검증

- **e2e 38 (신규)**: (a) `imageLibrary.set(빈)` → `get()` `{v:1, 배열 4개 [], seeded}` · Node fs `%APPDATA%\com.greathoon.gitpervisor.dev\image-library.json` 존재·키 `library`. (b) rect A → `styles.save(A,'fill','e2e:상태 / 경고 / 핑크')` → `colorStyles[0].name` 일치; `apply([B],'fill',id)` → `B.fills` 딥이퀄·`styleRefs.fill===id`·저장본 픽셀; 팝오버 DOM에 섹션 없이 전체 이름(1건) → 같은 섹션 2번째 저장 후 헤더 `상태` + 행 `경고 / 핑크` + `적용됨`(B 선택); 검색 `blue` 대소문자 무시. (c) `edit('fill',id,{paint})` → A·B 픽셀 동시 변경·`history.entries()` 마지막 라벨 `스타일 갱신` 1칸; B `applyPaintPatch({fills})` → `styleRefs.fill` 없음·A 유지; `remove` → 값 유지·참조 전부 해제. (d) 내장 `제목 / H1` 존재 → 텍스트 노드에 적용 → `fontSize 28·fontWeight 700·lineHeight 130`; `edit` 32 → 반영. (e) rect+text 선택 → `components.make(ids,'e2e:범례 칩')` → `objects`에 `instance` 1·`frame` 1·자식 2(id 접두 `${inst}/`), `components[0].thumb`가 `data:image/png` 접두, 에셋 카드 DOM 1. (f) `place(id, 120, 60)` ×2 → 프레임 중심 ±1, 세 위치 픽셀 동일(프리뷰 == `readSaved`). (g) inst1 자식 fill 변경(`applyPaintPatch` 훅) → 커밋 후 `overrides` 키 1·`state(inst1)==='overridden'`·패널 `재정의됨 1`; inst2 텍스트 변경 후 `push(inst2)` → inst1 텍스트 갱신 **+ fill 재정의 유지**·라벨 `컴포넌트 갱신`; `reset(inst1)` → 마스터와 딥이퀄. (h) `detach(inst2)` → `kind 'group'`·`detachedFrom`·`분리됨 1`; `removeComponent` → inst1 자동 분리 + 토스트 `/라이브러리에 없어/`. (i) 더블클릭 진입 자식 드래그 → 인스턴스 전체 이동(자식 상대 좌표 불변); 자식 Delete → `overrides[child].visible===false`, `reset` → 복귀; `assertTreeInvariant` 콘솔 에러 0. (j) `rotateBy(90)` → 인스턴스 0·그룹 `detachedFrom`·토스트 `/분리/`; undo → 인스턴스 복귀. (k) doc 창(`connectLabel`)에서 `styles.save` → 메인 `get()`에 1s 내 등장, 메인 편집기의 참조 노드가 `스타일 갱신` 커밋(참조 없으면 커밋 0). (l) doc 창 에셋 카드 합성 `dragstart/drop`(clientX/Y) → 프레임 중심 == `clientToOriented` ±1. (m) 41 `flush → imageDocs.read → normalizeDoc` 뒤 인스턴스·`overrides`·`styleRefs` 딥이퀄; undo로 `컴포넌트 생성` 이전 복귀 시 인스턴스·프레임 사라짐. (n) `set(8MB+1)` → `IpcError code 'IO'`, 이전 라이브러리 유지.
- **회귀**: 30(91)·34(32)·35(13) 무변경 통과(인스턴스·스타일 없는 문서에서 `diffInstance/resyncStyles`는 같은 참조를 돌려준다 — 캐시 참조비교 `AnnotationLayer:227` 히트 유지).
- **Rust**: `cargo test` 8MB 거부·`load_json_at` 손상 격리·`is_secondary_window` 무영향.
- **실기**: 메인·doc 창 두 개에서 색 저장 → 반대 창 팝오버 1초 내 반영; 카드 드래그 배치(doc 창, 44 적용 후) · 더블클릭 배치; 인스턴스 리사이즈(프레임 핸들) 뒤 마스터 갱신 → 다른 인스턴스 크기 불변·내용만 갱신; 90° 회전 토스트 → Ctrl+Z.
