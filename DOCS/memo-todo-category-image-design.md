# 메모장 개선 설계 — 할 일 패널 · 카테고리 · 이미지 · 정렬

2026-11-24. 대상: 전역 메모 팝오버(`GlobalMemoPopover`)와 프로젝트 메모 모달(`MemoDialog`)이 함께 쓰는
`MemoPanel`. 상태: **M1~M5 구현·커밋(2026-11-24, b82bd65), 미릴리스. macOS·Linux 실기 확인 전(§10).** 초안을 세 관점
(데이터 경쟁 · CodeMirror 실현성 · 이미지/보안)으로 반박 검토해 고친 판이고, 구현하면서 달라진 곳은 그 자리에
"구현:"으로 적었다.

## 0. 결정 요약

| 항목 | 결정 | 누가 |
|---|---|---|
| 편집기 | textarea → **CodeMirror 6 라이브 프리뷰**. 본문은 지금처럼 **평문 그대로** 저장 | 사용자 선택 |
| 오늘 투두 | 메모와 분리된 **독립 "할 일" 패널**, 항목 단위 데이터(`todos.json`) | 사용자 선택 |
| 투두 범위 | **전역 하나**(프로젝트별 목록 없음). 전역 메모 팝오버의 탭으로 | 기본값 |
| "오늘"의 뜻 | 저장하지 않고 **계산한다**: 미완료 전부 + 오늘 완료한 것. 이월 로직은 없다(안 끝난 건 계속 보인다) | 기본값 |
| 카테고리 | 메모당 **하나**. 목록은 따로 관리하지 않고 메모에 붙은 이름에서 **도출** | 기본값 |
| 정렬 | **표시만** 바꾼다. 정본(배열 순서 = 수동 순서)은 건드리지 않는다. 기본값 "수동" | 기본값 |
| 이미지 저장 | 앱 데이터 `note-images/<uuid>.avif`, 본문에는 토큰 `![](memo-img/<uuid>.avif#w=320)` | 기본값 |
| AVIF 인코딩 | **Worker**에서 `@jsquash/avif`, speed 8 (실측 §7.2) | 실측 |
| 이미지 정리 | 안 쓰는 파일은 바로 지우지 않고 **30일 보관함**을 거친다 | 기본값 |
| 창 간 동기화 | `notes://changed`·`todos://changed` 신호 + 패널의 "안 고친 본문만 따라간다" 규칙 | 기본값 |

"기본값"은 내가 정한 것이다 — 틀렸으면 그 줄만 말해 주면 된다.

## 1. 지금 구조에서 지켜야 할 것

- **배열 순서가 정본**이고 표시는 역순이다(`MemoPanel.tsx:52-56`, `DOCS/task/57` §3.1). `add_memo`는 push.
- `text`가 메모의 유일한 내용이다. 비면 떠날 때 삭제되고(`MemoPanel.tsx:151-158`), 툴바 배지·사이드바 표시도
  `text.trim()`으로 센다(`Toolbar.tsx:66`, `ProjectItem.tsx:56`). → **이미지도 본문 토큰으로** 넣어야 "이미지만 있는
  메모"가 빈 메모로 지워지지 않는다.
- 닫기 직전 `flush`는 부모가 명시적으로 부른다(StrictMode 때문에 언마운트 정리에서 하면 초안이 지워진다,
  `MemoPanel.tsx:129-139`). 이 계약은 유지한다.
- 패널이 뜨는 창은 **메인과 모아보기 별도 창** 둘이다(`TitleBar.tsx:77`, `AggregateTerminals.tsx:966`). 창마다
  react-query 캐시가 따로이고 `useNotes`는 `staleTime: Infinity`, 변경 신호가 없다. 지금도 한 창이 오래된 캐시로
  "빈 메모"를 정리하면 다른 창이 채운 내용이 지워질 수 있다(코드 추적, 미재현) — §6.2 + §8로 막는다.
- 패널 크기는 껍데기가 갖는다(팝오버 최소 480×300, 목록 열 240px 고정).

## 2. 데이터 모델

### 2.1 메모 — 필드 하나 추가

```rust
// git/types.rs
pub struct Memo {
    pub id: String,
    pub text: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,   // 카테고리 이름 그 자체. None = 미분류
}
```

- 기존 `notes.json`은 필드가 없어도 그대로 읽힌다. 마이그레이션 없음.
- **카테고리 테이블은 만들지 않는다.** 한 스코프의 카테고리 목록 = 그 스코프 메모들의 `category` 고유값.
  이름 바꾸기 = 그 이름을 가진 메모 일괄 갱신. 대가: 빈 카테고리는 존재할 수 없고, 카테고리 순서는 이름순이다.
- 색은 `assignProjectSlots(이름들)` + `projectPalette(theme)`(`lib/project-color.ts:146,209`)를 그대로 쓴다 — 저장 안 함.
- 카테고리를 바꿔도 `updatedAt`은 올리지 않는다(분류만 옮겼는데 "수정일순" 맨 위로 튀지 않게).

### 2.2 할 일 — 새 파일 `todos.json`

```rust
// git/types.rs
pub struct Todo {
    pub id: String,                 // 프런트 생성 UUID(메모와 같은 이유: 낙관적 갱신)
    pub text: String,
    pub created_at: String,         // RFC3339 UTC
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_at: Option<String>,    // 완료 시각. None = 미완료
}
// state.rs: pub todos: RwLock<Vec<Todo>>, TODOS_FILE = "todos.json", TODOS_KEY = "todos"
// AppState::new 에 인자 하나 추가 — 호출처는 lib.rs:1379 한 곳뿐이다.
```

- 배열 순서 = 표시 순서(추가는 push = 맨 아래).
- **날짜 필드가 없다.** "오늘 목록"은 계산이다(§5). 그래서 자정에 도는 작업도, 이월 로직도, 그걸 두 창이 동시에
  실행하는 경쟁도 없다.
- 기한·반복·우선순위는 지금 넣지 않는다. 항목이 구조체라 나중에 선택 필드로 붙이면 된다.
- 저장은 메모와 같이 변경마다 파일 통째 재기록(`save_json`, tmp+rename).
  `// ponytail: 전체 재기록 — 완료 항목이 수천 건(수백 KB)을 넘기면 연도별 파일로 가른다`

### 2.3 이미지 — 파일 + 본문 토큰

- 파일: `data_root(app)/note-images/<uuid>.avif`. `app_data_dir()`를 직접 부르지 않는다 — e2e 샤드가
  `GPV_DATA_DIR`로 갈리는 건 `data_root`뿐이다(`state.rs:160`).
- 본문 토큰: `![대체텍스트](memo-img/<uuid>.avif#w=320)`. `#w=`는 표시 폭(px), 없으면 원본 폭(편집기 폭 이내).
  - 상대 URL이라 react-markdown 기본 `urlTransform`을 통과한다(커스텀 스킴은 빈 문자열로 지워진다 —
    `react-markdown/lib/index.js:421-442`).
  - 평문이라 메모 사이에서 잘라 붙여도 따라가고, MCP `read_memos`에도 그냥 글자로 나간다.
- 메모 ↔ 이미지 소유 관계를 따로 저장하지 않는다. 참조 여부는 저장된 파일 원문을 훑어 판정한다(§7.4).

## 3. IPC 계약

TS는 `src/lib/ipc.ts` 래퍼로만 부른다. Rust 필드를 바꾸는 커밋에서 TS 타입도 같이.

| 커맨드 | 인자 | 반환 | TS 호출 |
|---|---|---|---|
| `add_memo` (변경) | `project_id, memo_id, category: Option<String>` | `Memo` | `callMutating` |
| `set_memo_category` | `project_id, memo_id, category: Option<String>` | `Option<Memo>` | `callMutating` |
| `rename_memo_category` | `project_id, from, to: Option<String>` (`None` = 그 카테고리 해제) | `()` | `callMutating` |
| `get_todos` (async) | — | `Vec<Todo>` | `call` |
| `add_todo` | `todo_id, text` | `Todo` | `callMutating` |
| `update_todo_text` | `todo_id, text` | `Option<Todo>` | `callMutating` |
| `set_todo_done` | `todo_id, done: bool` | `Option<Todo>` | `callMutating` |
| `delete_todo` | `todo_id` | `()` | `callMutating` |
| `note_image_put` (async) | 원시 본문(AVIF 바이트) + 헤더 `id` — `write_file_raw` 방식(`raw_file.rs:98-142`, `ipc.ts:1707`) | `()` | `callMutating` |
| `note_image_get` (async) | `id` | `tauri::ipc::Response`(원시 바이트, `read_file_raw` 방식) | `call` |

- `add_memo`의 `category`는 필터가 걸린 채 "새 메모"를 눌렀을 때 그 카테고리로 만들기 위함이다. Tauri는 빠진
  `Option` 인자를 `None`으로 받으므로 기존 호출(e2e 05)은 그대로 통과한다.
- 카테고리 이름: trim, 1~30자, 개행 금지. 빈 문자열은 `None`으로.
  구현: 거절하지 않고 **다듬어 받는다**(개행→공백, 30자에서 자름 — `normalize_memo_category`). 이름은 표시용
  문자열일 뿐 경로나 키가 아니라서 오류 코드·오류 문구를 새로 만들 이유가 없다.
- **이미지 id는 경로가 된다 — 보안 경계.**
  - `uuid::Uuid::parse_str`로 파싱하고 **소문자 하이픈 정규형과 같을 때만** 받는다(`uuid` 크레이트는 이미 있다,
    `Cargo.toml:39`). 대소문자를 섞어 받으면 NTFS·APFS에서 같은 파일인데 참조 대조(§7.4)는 다른 문자열로 본다.
  - 본문 8MB 상한, 앞머리는 기존 `ftyp_is_avif`(`favorites.rs:690`)로 확인.
  - 쓰기는 `create_new`로 최종 경로에 직접(`write_all` → `sync_all`, 실패하면 그 파일 삭제). tmp+rename은 쓰지 않는다 —
    rename은 대상을 덮어써서 "같은 id 재사용 금지"를 못 지킨다. 쓰다 죽어 잘린 파일은 "이미지 없음"으로 보일 뿐이다.
  - 파일 쓰기는 `spawn_blocking`(메인 스레드에서 디스크를 만지지 않는다 — `write_file_raw` 선례).
- `note_image_get`은 본 폴더에 없으면 보관함(§7.4)에서 찾아 **본 폴더로 되돌린 뒤** 돌려준다.
  TS 래퍼 주석: "받은 `ArrayBuffer`를 transfer하지 마라" — `call`은 같은 인자의 진행 중 호출을 합쳐서, 한쪽이 넘겨
  버리면 다른 쪽이 빈 버퍼를 받는다(`ipc.ts:1692-1699`의 `readFileRaw`가 `dedup:false`인 이유).
- 할 일 순서 바꾸기(`reorder_todos`)는 이번에 없다(§12).

## 4. 메모 목록 — 정렬 · 카테고리

```
┌ 목록 열(240px) ───────────┐
│ ▣ 전역 메모            24 │
│ [● 업무 ▾]        [⇅ 수정]│  ← 카테고리 필터 / 정렬
│ ───────────────────────── │
│ [26-11-24]                │
│ ● 업무 · 방금 전          │
│ 접힘선 AI : 불량 데이터…  │
│ 11-20                     │
│ …                         │
│ + 새 메모                 │
└───────────────────────────┘
```

### 4.1 정렬

- 모드 4개: `manual`(수동 — 지금 순서, 기본) · `updated`(수정일 최신순) · `created`(생성일 최신순) · `title`(제목 가나다순).
- **정본 배열은 건드리지 않는다.** 정렬·필터는 순수 함수 하나로 표시 목록만 만든다:
  `visibleMemos(memos, { sort, category, activeId })` — `src/lib/memo-list.ts`.
- 드래그 순서 변경은 **수동 + 필터 "전체"일 때만** 켠다. 그 밖에서 켜면 `reorder_memos`가 (a) 정렬된 표시 순서를
  정본으로 덮어쓰고 (b) 필터로 빠진 메모를 꼬리로 밀어낸다(`notes.rs:84-86`).
- 저장: `localStorage` `gp:memo-sort`(스코프 공통 — `gp:memo-md`와 같은 급의 취향 설정).
- 정렬이 수동이 아니면 새 메모가 화면 밖에 놓일 수 있다 → 활성 행을 `scrollIntoView({ block: "nearest" })`.
- 같이 고친다: 행의 시간 표기가 `relativeTime`이라 "1339시간 전"이 된다(`MemoPanel.tsx:283`, 일 단위가 없음).
  `shortDate`(`lib/format.ts:34` — 24시간 안은 상대, 올해는 MM-DD, 그 밖은 YYYY-MM-DD)로 바꾼다.

### 4.2 카테고리

- 필터 드롭다운: `전체 (24)` · `미분류 (n)` · 카테고리별(개수). 선택은 스코프별
  `gp:memo-category:<scopeId>`에 기억(스코프마다 카테고리 집합이 다르다). 기억한 카테고리가 사라졌으면 "전체".
- 편집기 헤더에 카테고리 칩 `[● 업무 ▾]`: 누르면 `없음` · 기존 카테고리 · 입력칸 "새 카테고리…"(Enter).
  카테고리 줄에 hover 시 `✎`(이름 바꾸기 — 그 자리 input) · `✕`(카테고리 해제, 메모는 남는다).
  이름을 바꾸면 기억해 둔 필터 선택도 새 이름으로 옮긴다.
- 구현: 필터와 정렬은 **네이티브 `<select>`**다(직접 만든 드롭다운 없음). 그래서 이름 바꾸기·해제는 필터가 아니라
  칩 메뉴(`MemoCategoryMenu.tsx`)에 모았고, 필터 `<select>`는 카테고리가 하나라도 있을 때만 보인다.
- 목록 행 둘째 줄: `● 업무 · 11-20`.
- **활성 메모는 필터 밖으로 나가도 유지한다.** `active`는 표시 목록이 아니라 스코프 전체에서 찾고, `visibleMemos`는
  활성 메모를 필터와 무관하게 포함한다. 안 그러면 필터를 바꾸거나 활성 메모의 카테고리를 바꾸는 순간 `active`가 다른
  메모로 폴백하면서, 치던 마지막 500ms가 `flush` 없이 버려진다. 필터 변경·카테고리 지정은 먼저 `flush()`를 부른다.
- 낙관적 갱신(`onMutate`)이 `category`까지 캐시에 싣는다 — `useAddMemo`가 안 실으면 필터가 걸린 채 만든 새 메모가
  화면에서 바로 사라진다(`staleTime: Infinity`라 재조회도 없다).
- 메뉴는 **패널 안 absolute**로 띄운다. 새 `fixed` 레이어를 만들면 팝오버 백드롭 클릭으로 새고
  (`GlobalMemoPopover.tsx:67`), e2e 05의 `closest('.fixed')` 범위 찾기(`05-notes.mjs:211`)도 흔들린다.
- 입력칸: Enter는 `isComposing` 가드(한글 확정 Enter가 "추가"로 새는 것 — `SessionHistoryDialog.tsx:235` 관례).
  Esc는 `stopPropagation()` — 팝오버의 창 단위 Esc 닫기가 `defaultPrevented`를 보지 않는다(`GlobalMemoPopover.tsx:45-52`).

## 5. 할 일 패널

전역 메모 팝오버에 탭 두 개: **메모 | 할 일**. 마지막 탭은 `gp:memo-tab`에 기억. `MemoDialog`(프로젝트 메모)에는 없다.

```
┌──────────────────────────────────────────────────────────────┐
│ [메모][할 일]        ‹  11-24 (화) · 오늘  ›        3/7    ✕ │
├──────────────────────────────────────────────────────────────┤
│ ┌ + 할 일 추가… (Enter) ─────────────────────────────────┐   │
│ └────────────────────────────────────────────────────────┘   │
│ ☐ nqvm-homepage admin 체크                                   │
│ ☐ gitlab 서버 백업 프로세스 확인                    3일째    │
│ ☐ KOPA 각종 AI 모델과 알고리즘 준비                          │
│ ── 완료 3 ───────────────────────────────────────────────    │
│ ☑ 불량 이미지 생성                                           │
└──────────────────────────────────────────────────────────────┘
```

- **오늘 보기** = 미완료 전부(배열 순서) + 오늘(로컬 날짜) 완료한 것(완료 시각순, 취소선, 아래 구획).
  어제 못 끝낸 항목은 그대로 미완료라 오늘도 보인다 — 만든 날이 오늘이 아니면 `N일째`를 붙인다.
- **지난 날 보기**(‹ ›) = 그 날 완료한 항목. 읽기 전용 기록이다(체크 해제만 가능 — 해제하면 오늘 미완료로 돌아온다).
- 조작: 입력칸 Enter → 추가(포커스 유지, 연속 입력). 체크 → 완료/해제. 글자 클릭 → 그 자리 input으로 수정
  (Enter 저장, Esc 취소, 비우면 삭제). hover 시 `✕` 삭제. Enter·Esc 처리는 §4.2의 입력칸 규칙과 같다.
- 계산은 순수 함수로 뗀다: `todosForDay(todos, day, today)` → `{ open, done }` — `src/lib/todo-day.ts`.
  로컬 날짜 키 `localDayKey(date)` → `"YYYY-MM-DD"`(UTC로 저장된 `doneAt`을 로컬로 바꿔 비교 — 자정 근처 9시간 함정).
  `N일째`도 밀리초 나눗셈이 아니라 날짜 키의 차로 센다.
- 패널이 열린 채 자정을 넘기면 "오늘"이 바뀌어야 한다 → 열려 있는 동안 1분 타이머로 `today`를 다시 계산.
- 타이틀바 "메모장" 버튼에 미완료 개수 배지(0이면 없음). `GlobalMemoButton`이 `useTodos()`를 읽는다.
- 컴포넌트: `src/components/memo/TodoPanel.tsx`. 탭 버튼은 `GlobalMemoPopover`가 상태를 갖고 두 패널의 헤더 왼쪽 자리에
  꽂는다(`MemoPanel`에 `headerLead?: ReactNode` 추가 — 없으면 지금의 아이콘+이름).
- **탭을 바꾸기 전에 `flushRef.current?.()`를 부른다.** 탭 전환은 `MemoPanel`을 언마운트하는데, 지금 `flush`가 도는 길은
  팝오버 닫기뿐이다 — 안 부르면 마지막 500ms 입력이 버려지고 방금 만든 빈 메모가 남는다.
- 쿼리 훅은 메모와 같은 모양: `useTodos` + 낙관적 `useAddTodo`/`useUpdateTodoText`/`useSetTodoDone`/`useDeleteTodo`.
- 구현하면서 정한 것:
  - `N일째`는 **만든 날이 1일째**다(어제 만든 항목은 오늘 "2일째"). `todoDaysOpen`은 날짜 차(만든 날 = 0)를 돌려주고 표시할 때 1을 더한다.
  - 추가 입력칸의 Esc는 **글자가 있을 때만** 먹는다(입력 비움). 빈 칸의 Esc는 평소처럼 팝오버를 닫는다.
  - 지난 날 보기에서는 글자 수정·삭제 버튼이 없다(체크 해제만). 오늘 보기의 완료 항목은 수정·삭제할 수 있다.
  - 진행 표시 `완료/전체`의 전체는 그 날 보이는 것(미완료 + 그 날 완료)이라, 지난 날은 `N/N`이다.
  - 이미 완료인 항목을 다시 완료로 불러도 처음 완료한 시각을 지킨다(`apply_todo_done`) — 그 시각이 어느 날의 기록인지를 정한다.

## 6. 편집기 — CodeMirror 6 라이브 프리뷰

### 6.1 왜 이 구성인가

- **문서 모델이 평문**이다. 기존 메모의 줄바꿈·연속 빈 줄·`<` 같은 글자가 한 바이트도 바뀌지 않는다. 마크다운
  WYSIWYG(TipTap 등)는 저장할 때 본문을 정규화해서 지금 메모들의 모양을 바꾼다 — 그래서 뺐다.
- 의존성 3개: `@codemirror/state` · `@codemirror/view` · `@codemirror/commands`. 필요한 것(`StateField`, `Decoration`,
  `WidgetType`, `atomicRanges`, `placeholder`, `lineWrapping`, `history`)이 전부 이 셋에 있다. `codemirror` 묶음 패키지와
  `lang-markdown`은 넣지 않는다 — 구문 강조가 목적이 아니고, 위젯으로 바꿀 토큰 두 종류는 정규식으로 찾는다.
- `React.lazy`로 메모장을 처음 열 때만 불러온다. 번들 증가는 M4에서 빌드로 잰다.

### 6.2 본문 상태 계약 — 편집기 교체의 핵심

textarea는 `value={text}`로 제어돼서, `text`가 이펙트에서 한 박자 늦게 바뀌어도 화면이 따라왔다. CodeMirror는 문서를
스스로 갖는다. 그대로 끼우면 **메모 B를 눌렀을 때 편집기에 A의 본문이 실리고, 한 글자만 쳐도 A의 본문이 B에 저장된다.**
그래서 `MemoPanel`의 상태를 이렇게 바꾼다(지금의 `text` + `textOwner` 를 대체):

```ts
// 본문과 그 주인을 한 덩어리로 — 둘이 따로 놀 수 없게.
draft = { ownerId: string | null, text: string, base: string }
//   base  = 이 메모에서 마지막으로 불러왔거나 저장한 본문
//   dirty = text !== base
```

| 일어난 일 | 처리 |
|---|---|
| 활성 메모가 바뀜 | `draft = { ownerId: active.id, text: active.text, base: active.text }` |
| 사용자가 침 | `text`만 바뀜 → 500ms 뒤 `update_memo(text)`, 보낸 값으로 `base` 갱신 |
| 캐시의 `active.text`가 `base`와 달라짐(다른 창이 고침) | **dirty가 아니면** `text`·`base`를 새 값으로(편집기에도 반영). dirty면 내 입력 유지 — 마지막 저장이 이긴다 |
| `flush()` | `ownerId !== active.id`면 손대지 않는다. dirty면 저장(비었으면 삭제). dirty가 아니면 **`text`와 캐시 본문이 둘 다 비었을 때만** 삭제 |

- 편집기는 `<MemoEditor key={draft.ownerId} value={draft.text} … />`. `key`로 메모마다 다시 마운트해 실행 취소 기록을
  가른다(안 가르면 메모를 바꾼 뒤 Ctrl+Z가 앞 메모의 변경을 지금 문서에 되감는다).
- `draft.ownerId !== active?.id`인 과도기(메모 전환 직후 한 렌더, "새 메모" 직후)에는 **편집기를 그리지 않는다.**
  구현(M2, textarea): "새 메모" 직후에는 낙관적 추가가 캐시에 닿기 전까지 `pendingAdd`(임시 메모 객체)가 활성 메모를
  대신한다 — 재조회 취소(§8)를 기다리는 만큼 그 틈이 길어져서, 없으면 `active`가 목록 첫 메모로 넘어갔다 돌아온다.
- `MemoEditor`는 반제어다: `value`가 자기 문서와 다르면 문서 전체를 바꾸는 트랜잭션을 보낸다(실행 취소 기록에 남기지
  않음). 위 표의 "다른 창이 고침"과 MD 보기에서 편집으로 돌아오는 경우가 이 길을 탄다.
- 구현(M4)은 `value` prop 을 두지 않았다 — **`initialText`(마운트 때 한 번만 읽음) + ref 의 `replaceDoc(text)`** 다.
  값을 계속 내려 주면 렌더가 한 박자 늦은 값이 방금 친 글자를 덮는다(편집기의 onChange 는 React 이벤트가 아니라
  렌더가 뒤따라온다). 메모 전환·MD 에서 편집으로 돌아오기는 `key` 재마운트가, "다른 창이 고침"만 `replaceDoc` 이 맡는다.
- 같은 이유로 `flush()`와 "다른 창이 고침" 판정은 **편집기가 떠 있으면 그 문서에서** 본문을 읽는다(`getDoc()`).
  draft 만 보면 방금 친 글자가 빠진 채로 "빈 메모"라 판단해 지울 수 있다.
- 넷째 줄이 §1의 "오래된 캐시의 빈 메모 정리가 남의 내용을 지운다"를 닫는다. 신호(§8)만으로는 안 닫힌다 — 재조회는
  캐시만 바꾸고 패널의 `text`는 그대로라, 오히려 비교 기준만 최신이 되어 덮어쓰기가 확정된다.

### 6.3 구성

- `src/components/memo/MemoEditor.tsx` — props `{ value, onChange, placeholder, autoFocus }` + ref 핸들
  `insertAtCursor(text)`. `autoFocus`면 마운트 뒤 `view.focus()`하고 커서를 끝에 둔다(지금 부모의 `setTimeout(0)` 포커스는
  lazy 청크 로드보다 먼저 돌아 헛돈다 — 포커스는 편집기 안으로 옮긴다).
- 확장: `history()` · `keymap(standardKeymap + historyKeymap)` · `EditorView.lineWrapping` · `placeholder()` ·
  `contentAttributes({ spellcheck: "false" })` · 테마(지금 textarea와 같은 14px/leading-7, 색은 CSS 변수).
  - **`defaultKeymap`은 쓰지 않는다.** 코드 편집기용 키(Ctrl+Shift+K 줄 삭제, Alt+↑↓ 줄 이동, Ctrl+[ ] 등)가 들어 있고
    CodeMirror는 처리한 키의 전파를 막지 않는다 → Ctrl+Shift+K 한 번에 메모 줄 삭제와 앱의 git push
    (`KeyboardShortcuts.tsx:172`)가 **같이** 돈다. `standardKeymap`이 textarea와 같은 키 동작이다. Tab은 어느 쪽에도 없어
    지금처럼 포커스가 밖으로 나간다.
- **위젯 장식**(`src/lib/memo-live-preview.ts`): `StateField<DecorationSet>`. `tr.docChanged`일 때만 문서를 다시 훑고,
  아니면 `deco.map(tr.changes)`.
  - 이미지 토큰 → `Decoration.replace({ widget })` + `EditorView.atomicRanges`. 토큰 원문은 드러내지 않는다 —
    이미지는 **한 글자처럼** 선택·삭제·잘라 붙이기 된다. (질문 때 보인 "커서가 들어가면 원문이 보임"보다 단순하고,
    토큰을 반쯤 지워 깨뜨릴 일이 없다.)
  - 줄 머리 `- [ ]` / `- [x]` → `[ ]` 세 글자를 체크박스 위젯으로. 클릭하면 그 세 글자를 바꾸는 트랜잭션(실행 취소 가능).
  - 두 위젯 모두 `eq`를 구현한다(이미지 = id+폭, 체크박스 = checked). 기본 `eq`는 false라 안 하면 문서를 훑을 때마다
    위젯 DOM이 새로 만들어진다 — 깜빡임이고, 위젯 옆에서 한글을 조합할 때 IME가 깨지는 원인이기도 하다(§6.4).
  - `// ponytail: 문서 전체 스캔 — 메모가 수백 KB가 되면 보이는 범위만 훑는 ViewPlugin으로`
  - 토큰 찾기·폭 바꾸기는 순수 함수: `findMemoImageTokens(text)` · `withMemoImageWidth(tokenText, w)` — `src/lib/memo-image-token.ts`.
- **헤더 버튼은 포커스를 뺏지 않는다**: 이미지 버튼·카테고리 칩에 `onMouseDown={e => e.preventDefault()}`. MD 모드에서는
  blur가 편집기를 언마운트시켜(`MemoPanel.tsx:359`) 파일 선택이 끝났을 때 토큰을 넣을 커서가 없어진다. 그래도 편집기가
  없으면 본문 끝에 붙인다.
- **MD 토글은 남긴다**(제목·표를 렌더해 읽는 기존 기능). MD 보기에서도 이미지가 보이도록 `MarkdownBody`가
  `components`를 선택 인자로 받아 합치고(기존 `a` 덮지 않게), 메모장은 `img`를 넘겨 `memo-img/…`를 blob URL로 푼다.
  MD 보기에서의 크기 조절·체크박스 클릭은 안 한다 — 편집 화면에서 한다.

### 6.4 textarea를 떠나면서 생기는 일

- **macOS 복사.** 창 캡처 단계의 copy 가로채기가 `.xterm, .monaco-editor`만 빼고 `getSelection().toString()`을 기록한 뒤
  전파를 끊는다(`clipboard.ts:284-303`). CodeMirror가 거기 걸리면 (a) 화면에 그려진 부분만 복사되고 (b) 위젯 자리의
  토큰·`[ ]`가 빠진다. → 예외 셀렉터에 `.cm-editor`를 넣는다. 그러면 CodeMirror가 확정한 텍스트를 아래 버블 미러
  (`:304-311`)가 네이티브로 다시 기록해 한글 깨짐 우회도 유지된다.
- **한글 IME.** WKWebView는 한글에 `composition*`을 쏘지 않고 `insertReplacementText`로 값을 갈아 끼운다
  (`TROUBLESHOOTING.md` §3). CodeMirror 6은 키가 아니라 DOM 변화를 읽는 구조라 본문 입력은 통할 것으로 보지만,
  **커서가 인라인 위젯 바로 옆에 있을 때** Safari에서 조합이 깨진다는 보고가 있다
  (discuss.codemirror.net/t/…/9799 — 미확인, 실기로 본다). 대응은 위의 `eq` 구현과 `@codemirror/view` 최신판 사용,
  그리고 §10의 실기 확인이다.
- **단일 키 누수는 표본에서 없었다.** 초안은 "창 단위 keydown 가드 14곳이 contenteditable을 못 거른다"고 썼는데 틀렸다 —
  `VideoPlayer.tsx:470`·`AudioPlayer.tsx:300`은 바로 다음 줄에서 `isContentEditable`을 거르고, 나머지는 메모장이 들어가지
  않는 컨테이너의 `onKeyDown`이다. 그래서 가드 일괄 교체는 하지 않는다. 창/문서에 keydown을 거는 곳이 49곳이고 전수는
  안 봤으므로 §10에서 실제로 쳐 본다.
- **e2e 05.** `textarea.value` 읽기/쓰기에 기대는 단언이 전부 깨진다 — 고치는 방법은 §9.
- **StrictMode 와 focusout(구현 중 발견).** 포커스를 가진 편집기가 DOM 에서 빠지면 브라우저가 focusout 을 쏜다.
  개발 모드의 StrictMode 는 편집기를 한 번 만들었다 버리므로, 그걸 "포커스가 떠났다"로 받으면 MD 모드에서 렌더 본문을
  눌러 편집에 들어가자마자 렌더 뷰로 되돌아간다. `MemoEditor`의 onBlur 는 **지금 살아 있는 편집기에서 온 이벤트만** 받는다.
- **Enter.** `standardKeymap`의 Enter 는 앞줄의 들여쓰기를 이어받는다(textarea 는 안 그랬다). 목록을 들여 쓸 때 편해서 그대로 뒀다.
- **dev 에서 첫 로드.** Vite 가 새 의존성을 처음 만나면 최적화한 뒤 페이지를 통째로 다시 불러온다 — 메모장을 처음 열 때
  한 번 화면이 새로 뜨는 것은 dev 에서만 생기는 일이다.

## 7. 이미지

### 7.1 넣는 길 세 가지 → 한 파이프라인

| 입력 | 받는 곳 | 규칙 |
|---|---|---|
| 붙여넣기(스크린샷) | 편집기 `paste` | **`text/plain`이 비어 있고** `image/*` 파일이 있을 때만 이미지로. 그 밖은 CodeMirror 기본 붙여넣기. `preventDefault`는 await 전에 동기로(`ImageEditor.tsx:2100-2112` 선례) |
| 파일 끌어다 놓기 | 편집기 `drop` | 이미지 파일이 하나라도 있으면 동기로 `preventDefault`, **떨군 좌표**(`view.posAtCoords`)에 삽입. 이미지가 아닌 파일은 CodeMirror 기본 동작에 맡긴다 |
| 헤더의 "이미지" 버튼 | 기존 `asset_pick_file`(`image_doc.rs:234`, 16MB 상한) | 커서 자리에 삽입 |

- 텍스트 우선인 이유: Excel 셀·Word 글은 텍스트와 비트맵을 함께 클립보드에 올린다 — 파일만 보고 판단하면 복사한 글이
  그림으로 붙는다.
- 모든 창이 `disable_drag_drop_handler`라 드롭은 HTML5 `File`로 온다(`lib.rs:459`). 붙여넣기·드롭이 Linux·macOS에서
  미확인이라, 버튼이 세 OS 모두에서 확실한 유일한 길이다 — 셋 다 둔다.

```
File/바이트 ─ 디코드(메인, loadImage) ─ 긴 변 2560 초과면 축소(canvas) ─ getImageData
   │ ① id = randomUUID()                                                │ RGBA 버퍼 transfer
   │ ② 토큰 삽입 → 위젯은 "변환 중" 자리표시                             ▼
   │                                                         avif-encode.worker.ts
   │ ③ 완료: AVIF 바이트로 blob URL → 캐시 → 위젯이 그림으로             @jsquash/avif
   └─ ④ note_image_put(id, bytes) ◀────────────────────────────────────┘
```

- 파이프라인은 **모듈 수준 싱글턴**이다(`src/lib/memo-image-pipeline.ts`). 편집기 컴포넌트가 가지면, 인코딩 중에 메모를
  바꾸거나 팝오버를 닫는 순간 Worker가 같이 죽어 토큰만 저장되고 파일은 영영 안 생긴다.
- 디코드·축소는 메인에서(수 ms), **인코딩과 디코드 폴백(§7.5)은 Worker에서만** 한다.
- Worker는 첫 이미지에서 만들고 마지막 작업 뒤 30초 놀면 `terminate()`한다. WASM 메모리는 늘기만 하고 줄지 않는데
  패널이 뜨는 창이 둘이라, 안 끄면 창마다 인코더 힙이 상주한다. 연달아 붙인 것은 Worker 안에서 차례로 처리된다.
- **실패해도 토큰은 지우지 않는다.** "이미지 없음" 자리표시로 그리고 id가 든 토스트만 띄운다. 토큰 제거 경로는 만들지
  않는다 — 그 사이 다른 메모로 옮겼으면 지울 대상을 못 찾고, 저장 전에 앱이 죽는 경우 때문에 자리표시는 어차피 필요하다.
- 표시 캐시: 모듈 수준 `Map<id, Promise<blobUrl>>`. id당 한 번만 `note_image_get`을 부르고, **성공만** 남긴다.
  못 찾은 경우는 캐시하지 않고 위젯이 몇 초 뒤 한 번 더 조회한다(다른 창이 토큰을 파일보다 먼저 받는 경우).
  CSP `img-src`에 `blob:`이 이미 있다. `gpvthumb`는 못 쓴다 — 허용 루트에 앱 데이터가 없고 JPEG로 재인코딩한다
  (`thumb_protocol.rs:52`, `favorites.rs:83,257`).

### 7.2 AVIF 옵션 — 실측

`@jsquash/avif` 2.1.1을 Node(V8, 단일 스레드)에서 잰 값. 합성 이미지라 실제 스크린샷과 비율은 다를 수 있다.

| 1920×1080 | speed 6 | speed 8 | speed 10 |
|---|---|---|---|
| 스크린샷 꼴 q60 (PNG 198KB) | 6.4초 / 111KB | 0.45초 / 177KB | 0.21초 / 676KB |
| 스크린샷 꼴 q70 | 6.5초 / 113KB | 0.48초 / 158KB | 0.22초 / 771KB |
| 사진 꼴 q60 (PNG 4971KB) | 1.5초 / 264KB | 0.23초 / 257KB | 0.18초 / 258KB |

2560×1440 스크린샷 꼴은 speed 6에서 12~13초, speed 8에서 0.6~0.8초.

- **메인 스레드에서는 못 돌린다** — 지금 `encodeCanvas`는 speed를 안 넘겨 기본 6이고(`image-codec.ts:99`), 스크린샷
  한 장에 6~13초 멈춘다. 그래서 Worker.
- 기본값 **speed 8 · quality 70**. speed 6은 절반 크기지만 10초 넘게 "변환 중"이 떠 있는다. speed 10은 PNG보다 커진다.
- 상수(`MEMO_IMAGE_QUALITY`·`MEMO_IMAGE_SPEED`·`MEMO_IMAGE_MAX_EDGE`)로 두고, M5에서 **실제 스크린샷 몇 장**으로 다시 재서 확정한다.
- 멀티스레드판은 `crossOriginIsolated`가 있어야 켜지는데 설정이 없다(`encode.js:29`) → 단일 스레드로 돈다.

### 7.3 크기 조절

- 이미지 위젯 = `<span><img style="width:…"><i class="핸들"></i></span>`.
- 선택: `img`의 `mousedown`에서 그 토큰 범위를 선택하는 트랜잭션을 직접 보낸다(위젯은 기본적으로 이벤트를 편집기에 넘기지
  않는다). 테두리는 선택 범위에 겹치는 `Decoration.mark` 클래스로 그린다.
- 핸들 `pointerdown` → `pointermove` 동안은 **DOM 폭만** 바꾼다 → `pointerup`에서 토큰의 `#w=`를 바꾸는 트랜잭션 한 번
  (= 실행 취소 한 번). 폭은 48px ~ 편집기 내용 폭. 비율은 `height:auto`.
- 폭이 바뀌면 `eq`가 false가 된다 → `updateDOM`을 구현해 `img`를 재사용한다(안 하면 다시 불러와 깜빡인다).
- 높이가 바뀌는 때(로드 완료, 드래그 중, 놓았을 때)마다 `view.requestMeasure()`.
- 저장되는 건 **표시 폭뿐**이다. 파일은 다시 인코딩하지 않는다.

### 7.4 안 쓰는 파일 정리 — 지우는 경로

지우는 판단이 휴리스틱(본문 스캔)이라 **되돌릴 수 있게** 두 단계로 한다. 앱 시작 뒤 백그라운드에서 한 번 돈다.

1. **참조 집합** = `notes.json`과 (있으면) `notes.corrupt`의 **원문 바이트**에서 뽑은 UUID 꼴 문자열 전부.
   - 파싱한 메모가 아니라 원문을 본다. 손상된 `notes.json`은 `notes.corrupt`로 옮겨지고 빈 목록으로 부팅하는데
     (`state.rs:187-218`), 그 뒤 메모를 하나만 써도 새 `notes.json`이 생겨 "정상"으로 보인다 — 파싱 결과만 믿으면 격리본이
     가리키던 이미지를 전부 지운다.
   - 토큰 정규식이 아니라 UUID 문자열로 본다 — 반쯤 지워진 토큰도 참조로 친다(넓게 잡는 쪽이 안전한 방향이다).
   - **`notes.json`이 없으면 아무것도 하지 않는다.**
2. 참조되지 않은 `note-images/*.avif` → `note-images/orphan/`으로 **옮기고** 수정 시각을 지금으로.
3. `orphan/`에서 30일 넘은 것만 삭제.
4. `note_image_get`은 본 폴더에 없으면 `orphan/`에서 찾아 되돌린다(§3) — 잘라낸 토큰을 재시작 뒤 붙여 넣는 경우,
   실행 취소, 다른 창의 미저장 본문이 다 이 길로 살아난다.

- 메모 삭제·프로젝트 삭제(`projects.rs:333`) 때 따로 지우지 않는다. 다음 시작의 정리가 거둔다.
- 판정은 순수 함수로 떼고 `#[cfg(test)]`: `orphan_note_images(파일 이름들, 참조 집합)` — 참조된 것·`.corrupt`에만
  참조된 것·`.avif`가 아닌 것이 절대 나오지 않는지. 보관함 만료 판정도 같이.

### 7.5 세 OS

- **CSP.** `script-src`에 `'wasm-unsafe-eval'`이 없다(`tauri.conf.json:15`). 다만 Tauri는 CSP 헤더를 HTML 응답에만 붙이고
  (`tauri-2.11.2/src/manager/mod.rs:435-457`), 같은 출처 파일로 만든 전용 Worker는 **자기 응답 헤더**로 정책을 만든다 —
  Worker 안의 WASM은 막히지 않을 가능성이 높다. dev는 vite를 바로 띄워 CSP가 아예 없으므로 **dev·e2e로는 확인이 안 된다.**
  → M5 첫 단계에서 릴리스 빌드로 본다(§10 #1). 그래서 계약 두 줄:
  - jsquash 인코딩·디코딩은 Worker 안에서만 부른다.
  - Worker는 `new Worker(new URL("./avif-encode.worker.ts", import.meta.url), { type: "module" })`로만 만든다.
    `?worker&inline`·blob: Worker는 만든 쪽의 CSP를 물려받아 릴리스에서만 조용히 막힌다.
  - 릴리스에서 막히면 그때 `'wasm-unsafe-eval'`을 넣는다(WASM 컴파일만 푸는 값). 미리 넣지 않는다.
  - **확인(2026-11-24).** 프로덕션 번들(`vite build`)을 `tauri.conf.json`의 CSP 그대로 내주는 정적 서버에 올리고 dev 앱의
    WebView2 안 iframe 에서 돌렸다. CSP 를 HTML 응답에만 붙이면(Tauri 방식) 메인 스레드의 `WebAssembly.compile`은
    **막히고**(대조군 — CSP 가 실제로 걸렸다는 증거) Worker 의 인코딩·디코딩은 **된다**. CSP 를 모든 응답에 붙이면 Worker 도
    막힌다 — 즉 이 기능은 "Tauri 가 CSP 를 HTML 에만 붙인다"에 기대고, 그건 소스로 확인했다
    (`tauri-2.11.2/src/manager/mod.rs:436`의 `is_html`). **실제 릴리스 빌드로 돌려 본 것은 아니다**(릴리스에는 CDP 가 없다).
    Tauri 를 올릴 때 이 동작이 바뀌면 이미지가 릴리스에서만 조용히 죽는다 — 그때는 위 `'wasm-unsafe-eval'`.
- **표시.** WebView2·WKWebView는 AVIF `<img>`를 그린다. WebKitGTK는 AVIF가 빌드 옵션이고 배포판 패키지에서 미지원
  보고가 있다(`favorites.rs:605` 주석과 일치). → `img` `onerror`에서 Worker로 `@jsquash/avif/decode` → RGBA → canvas →
  PNG blob URL로 바꿔 끼운다. 범위에 포함.
- **붙여넣기.** WebKitGTK·WKWebView가 스크린샷을 `clipboardData.files`로 주는지 미확인. 안 주면 기존 arboard 경로
  (`terminal.rs:1015`)를 바이트 반환 커맨드로 여는 것이 대안이다 — 확인 전에는 만들지 않는다(버튼이 있다).

## 8. 창 간 동기화

- 메모·할 일 커맨드가 저장 뒤 신호를 쏜다: `notes://changed` · `todos://changed`. 페이로드는 **바꾼 창의 라벨**이고,
  커맨드가 `window: tauri::Window`를 받아 넘긴다(선례 `lib.rs`의 `float_pool_ready`).
  구현: 신호는 `save_notes`가 아니라 `notes.rs`·`todos.rs`의 `persist`에서 쏜다. 프로젝트 삭제(`projects.rs`의
  `save_notes` 직접 호출)는 쏘지 않는다 — 그 프로젝트의 메모는 프로젝트와 함께 화면에서 사라지고, 목록 쪽 신호
  (`projects://changed`)가 따로 간다.
- 받는 쪽(`lib/events.ts`의 `attachMemoTodoEvents` — 메인은 `attachRepoEvents`, 모아보기 창은 `main.tsx`에서 부른다)은
  **자기 라벨이면 무시**하고, 아니면 해당 쿼리를 무효화한다.
- 메모·할 일 변경 훅은 `onMutate` 첫 줄에서 `await qc.cancelQueries({ queryKey })`. 안 하면 이미 날아간 재조회 응답이
  뒤이은 낙관적 갱신을 덮는다 — "새 메모" 직후에 덮이면 새 메모가 캐시에서 빠지고 `active`가 엉뚱한 메모로 폴백한다.
- 재조회가 캐시를 바꾼 뒤 패널이 무엇을 하는지는 §6.2의 표가 정한다(안 고친 본문만 따라간다).
- 같은 메모를 두 창에서 **동시에 치는** 경우는 여전히 마지막 저장이 이긴다 — 그건 풀지 않는다.

## 9. 테스트

- Rust(`cargo test --lib`): `rename_memo_category`(일괄·해제) · `Memo`/`Todo` 역직렬화(필드 없는 옛 JSON) ·
  이미지 id 거절(`..`·슬래시·대문자·길이) · `orphan_note_images`와 보관함 만료 · `lib.rs`의 async 유지 목록에
  `get_todos`·`note_image_get`·`note_image_put`.
- TS는 단위 러너가 없다 → 순수 함수(`visibleMemos`·`todosForDay`·`findMemoImageTokens`·`withMemoImageWidth`)를 dev에서
  `window.__gpv`에 실어 e2e가 합성 데이터로 부른다(자정 경계는 실제 시계로 못 잰다).
- e2e 05(메모) — 편집기 교체로 바뀌는 것:
  - 읽기: dev 전용 `window.__gpv.memoEditorDoc()`(`EditorView.findFromDOM` → `state.doc.toString()`).
    `.cm-content`의 `textContent`는 줄바꿈을 잃고 위젯이 `[ ]`를 대신해서 `=== MD_TEXT` 단언에 못 쓴다.
  - 쓰기: `.cm-content`에 포커스 → CDP `Input.insertText`(선례 `61-pdf.mjs:1594`).
  - 새 단언: 메모 A→B 전환 직후 편집기 문서가 B의 본문 · 체크박스 위젯 존재(`.cm-content input[type=checkbox]`).
- e2e 05 — 기능 추가분: 정렬 기본값에서 기존 순서 단언 유지 · 정렬 바꾸면 표시만 바뀌고 `get_notes` 배열은 그대로 ·
  정렬/필터 중 드래그 꺼짐 · 카테고리 지정→필터→이름 바꾸기 · 활성 메모의 카테고리를 바꿔도 치던 내용이 저장됨 ·
  이미지 넣기→`note-images`에 파일 생김→폭 드래그 후 토큰의 `#w=` 변화. 새 `localStorage` 키는 finally 정리에 추가.
- **유실 회귀 두 개**(조용히 실패하던 결함이라 되돌려서 빨개지는지도 본다):
  - 빈 메모를 열어 둔 채 `queryClient.setQueryData`로 그 메모 본문을 채움(= 다른 창이 고침) → 닫기 → `get_notes`에 남아 있음.
  - 타이핑 직후 탭을 "할 일"로 전환 → `get_notes`에 본문 있음.
- e2e 새 스위트(할 일): IPC 왕복 · 추가/체크/수정/삭제 DOM · 배지 숫자 · 수정 input의 Esc가 팝오버를 닫지 않음.
- 현재 상태(2026-11-24, M1~M5): `05-notes.mjs`에 정렬·카테고리, "다른 창이 채운 메모", 메모 전환 직후의 편집기,
  체크박스 위젯, 이미지(붙여넣기·AVIF 저장·크기 조절·MD 보기) 절을 넣었고 할 일은 `71-todos.mjs`다.
  dev 앱에 붙여 둘을 돌려 **125 pass / 0 fail**(`GPV_E2E_PORT=29222 GPV_E2E_ONLY=05,71 node tests/e2e/run.mjs`).
  전체 e2e 는 돌리지 않았다.
- 변이 확인(수정을 되돌려 단언이 빨개지는지): `flush` 가 편집기 문서를 읽지 않게 하면 71 의 "탭 전환 뒤 본문 남음"이,
  바깥 변경 따라가기와 빈 메모 정리 조건을 되돌리면 05 의 "따라감"·"지우지 않음"이 빨개진다.
- 편집기 e2e 훅: `window.__gpvMemoEditor`(`doc()`·`type(text)`·`select()`), `window.__gpvMemoTokens`, `window.__gpvTodoDay` — dev 전용.
  `__gpvMemoEditor` 는 편집기를 **DOM 에서** 찾는다(모듈 변수에 두면 HMR 이 만든 모듈 사본 때문에 훅이 빈 값을 본다).
- 이미지 절의 폭 단언은 **dev 창이 최소화돼 있으면 깨진다** — 뷰포트가 144×18 로 줄어 고정 크기 모달까지 눌린다.
- 실행 강도: 마일스톤마다 `tsc --noEmit` + `cargo test --lib <이름>` + dev 앱에서 그 동작 확인. e2e는 개발 중에 돌리지 않고
  M4(편집기 교체)·M5(파일 쓰기/지우기) 끝에 05와 새 스위트만 돌린다.

## 10. 실기 확인이 필요한 것

| # | 무엇 | 언제 | 안 되면 |
|---|---|---|---|
| 1 | **릴리스 빌드**에서 메모 Worker로 AVIF 한 장 인코딩·디코딩(CSP) | M5 첫 단계 — 최소 Worker만 만들어 별도 워크트리에서 빌드 | CSP에 `'wasm-unsafe-eval'` |
| 2 | WebView2: CodeMirror 한글 입력, 위젯 바로 앞뒤에서 빠른 타자 | M4, dev 앱 | 위젯 `eq`·버전 점검 |
| 3 | 메모 편집기에 포커스를 두고 단일 키(스페이스·화살표·영문자)가 창 단위 keydown 리스너로 새는지 — 영상·PDF를 띄운 채 | M4, dev 앱 | 새는 리스너에 `isContentEditable` 가드 |
| 4 | macOS WKWebView: 한글 IME(`insertReplacementText`), 긴 메모 전체 복사, 이미지 포함 복사 | M4, 실기 | 미확인 상태로 릴리스하지 않는다 |
| 5 | Linux WebKitGTK: 한글 IME, AVIF 표시(디코드 폴백) | M4·M5, 실기 | 같음 |
| 6 | Linux·macOS: 붙여넣기 `clipboardData.files`, 드롭 `File` | M5, 실기 | arboard 바이트 커맨드 |

## 11. 구현 순서

각 단계는 그것만으로 쓸 수 있고 커밋도 따로다.

| 단계 | 내용 | 건드리는 곳 | 크기 |
|---|---|---|---|
| M1 | 정렬 + 날짜 표기(`shortDate`) | `MemoPanel`, `lib/memo-list.ts`, i18n, e2e 05 | 작음 |
| M2 | 카테고리 + `notes://changed` + §6.2 본문 상태 계약(`draft`) | `types.rs`, `notes.rs`, `ipc.ts`, `queries`, `MemoPanel`, `events.ts` | 보통 |
| M3 | 할 일 패널 + 탭 + 배지 + `todos://changed` | `state.rs`, `commands/todos.rs`, `ipc.ts`, `queries`, `TodoPanel`, `GlobalMemoPopover`, `TitleBar` | 보통 |
| M4 | 편집기 교체(기능 동일) + 체크박스 위젯 + mac 복사 예외 | `MemoEditor`, `memo-live-preview.ts`, `clipboard.ts`, e2e 05 | 큼 |
| M5 | 이미지 — 릴리스 CSP 확인 → Worker·저장·위젯·크기 조절·정리·MD 보기 | `note_images.rs`, Worker, 파이프라인, `MemoEditor`, `MarkdownView` | 큼 |

- M1~M3은 지금 textarea 위에서 끝난다. 편집기 교체(M4)가 미뤄져도 정렬·카테고리·할 일은 먼저 쓸 수 있다.
- §6.2의 `draft` 계약을 M2에 넣는 이유: 창 간 유실을 닫는 데 필요하고, textarea에서도 그대로 성립한다(M4는 그 위에
  `value`만 꽂는다).

## 12. 하지 않는 것

- 할 일 순서 드래그 — 드래그 코드가 `ProjectList`·`MemoPanel`에 이미 두 벌이라 세 번째는 훅으로 빼야 한다. 순서가
  아쉬워지면 그때.
- 할 일의 기한·반복·프로젝트 연결, MCP `read_todos`.
- 다중 태그, 빈 카테고리 유지, 카테고리 색 직접 지정·순서 지정, MCP `read_memos`에 카테고리 노출.
- 이미지 자르기·회전, 대체텍스트 편집 UI.
- **메모를 앱 밖으로 복사하면 이미지 자리는 토큰 글자(`![](memo-img/…)`)로 나간다.** 본문 복사의 텍스트를 바꾸면 메모
  사이 이동이 깨지므로 그대로 둔다. 필요해지면 위젯 우클릭 "이미지 복사"를 따로 둔다.
- ~~기존 "AVIF로 변환" 수리~~ — **했다(2026-11-24).** 그 기능(파일 트리·사진 뷰어·이미지 편집기의 `encodeCanvas`)은 메인
  스레드에서 jsquash 를 불러 화면이 멈췄고, §7.5 의 확인대로 릴리스 CSP 에서는 그 WASM 컴파일이 거절된다(설치본에서
  직접 눌러 본 것은 아니다). Worker 호출부를 `avif-worker-client.ts` 로 떼어 메모 이미지와 같이 쓴다. 변환은 크기가
  목적이라 speed 6 그대로다 — dev 앱 실측 1080p 한 장 1.3초, 그동안 메인 스레드 최대 공백 21ms.
