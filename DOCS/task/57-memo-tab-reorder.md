# 태스크 57 — 메모장 왼쪽 목록을 드래그로 위아래 순서 변경

> 상태: **설계** (2026-09-07) · 대상: gitpervisor · 근거: 코드 실측 2026-09-07(워킹트리 기준) ·
> 선례: PROJECTS 사이드바 드래그 정렬(`ProjectList.tsx:135-196`, `reorder_projects`) · **Rust 변경: 커맨드 1개**

## 1. 요구사항

메모장(프로젝트별 `MemoDialog`·전역 `GlobalMemoPopover` 공통)의 왼쪽 메모 목록에서 항목을 **드래그해 위아래로**
옮길 수 있고, 그 순서가 **저장**된다(재시작·다른 창에서도 같은 순서).

받아들이는 조건:
- 좌클릭 드래그 5px 이상 → 드래그 시작(끌리는 행 반투명, 삽입 위치에 accent 선). 놓으면 순서 확정.
- 5px 미만은 그대로 클릭(메모 선택)이다 — 드래그 도입으로 클릭이 둔해지지 않는다.
- 기존 사용자의 메모 순서는 업그레이드 후에도 **그대로**(새 메모가 위).
- 새 메모는 여전히 맨 위에 생긴다.

## 2. 현황(근거)

- 데이터는 zustand가 아니라 **React Query + Rust 파일**이다. `useNotes()`(`queries/index.ts:145-151`, `["notes"]`),
  `NotesMap = Record<projectId, Memo[]>`·`Memo{id,text,createdAt,updatedAt}`(`ipc.ts:448-456`). 뮤테이션 3개는 `patchNotes`로
  낙관적(`:153-220`). 커맨드 `get_notes/add_memo/update_memo/delete_memo`(`notes.rs`, `add_memo`는 `push` `:33-39`),
  저장은 `state::save_notes` → `notes.json`(`state.rs:19-22`, `Notes = HashMap<String, Vec<Memo>>`). **`Vec` 순서가 저장·로드를
  왕복한다** — 순서 필드가 없어도 배열 순서 자체가 영속 상태다.
- **표시는 배열 순서를 무시하고 `createdAt` 내림차순으로 정렬한다**(`MemoPanel.tsx:49-52`). `add_memo`가 `push`하고
  `createdAt=now`라 배열은 언제나 createdAt 오름차순 → 표시는 **배열의 역순**과 같다.
- 목록 JSX `MemoPanel.tsx:164-188`: `<button key onClick={selectMemo}>` 행, `data-*` 없음, 컨테이너 ref 없음.
  `selectMemo`(`:129-132`)는 `flush()` 뒤 선택. 이름 변경 없음(제목은 본문 첫 줄 파생 `:13-16`).
- 앱의 모든 드래그는 **포인터 이벤트**다. HTML5 DnD 사용 0건(`FileTreePanel.tsx:629-631` 주석 — Tauri `dragDropEnabled`가
  WebView2에서 DOM drag를 가로챈다). 메인 창은 `disable_drag_drop_handler`가 켜져 있지만(`lib.rs:893`) 관례를 따른다.
- 복사할 정렬 드래그 선례 `ProjectList.tsx:147-196`: `beginDrag(e, id)` — 좌클릭·`clientY` 5px 임계·`window`
  pointermove/up·`[data-project-id]` 중점으로 삽입 index·`reorderMutate(ids)`; 표시 `ProjectItem.tsx:110`(`opacity-40`)·
  `:123-125`(상단 accent 선), 꼬리 삽입선 `ProjectList.tsx:438-440`. 뮤테이션 `useReorderProjects`(`queries/index.ts:782-801`,
  onMutate 낙관 재정렬), 커맨드 `reorder_projects`(`projects.rs:250-269`, rank map + 미포함은 꼬리).
- e2e: `05-notes.mjs` 존재.

## 3. 설계

### 3.1 순서의 정본 — 배열 순서, 표시는 역순

| 대안 | 평가 |
|---|---|
| **A. `Vec` 순서를 정본으로, 표시 = `[...list].reverse()`, 드래그 결과는 `.reverse()`해서 저장** (채택) | 스키마 변경 0. 기존 데이터의 표시 순서가 **비트 단위로 동일**(createdAt 오름차순 배열의 역순 = 오늘의 정렬). `add_memo push` 그대로 = 새 메모 맨 위 |
| B. `Memo.order` 필드 | 스키마·마이그레이션·정렬 코드. 배열이 이미 순서를 갖는데 중복 표현 |
| C. `add_memo`를 `insert(0)`로 바꾸고 표시를 배열 그대로 | 기존 사용자 목록이 업그레이드 순간 **뒤집힌다**(oldest-first). 마이그레이션 없이는 불가 |
| D. 프론트 localStorage에만 순서 | 창·기기 간 불일치, `gp:memo-active`처럼 UI 상태로 격하 — "저장" 요구에 못 미침 |

`MemoPanel.tsx:49-52`를 다음으로 교체(주석 필수 — 왜 reverse인지):
```ts
// 배열 순서가 정본(notes.json Vec). add_memo가 push하므로 역순 = 새 메모가 위 — 종전 createdAt 내림차순과 동일한 표시.
const memos = useMemo(() => [...(notes?.[scopeId] ?? [])].reverse(), [notes, scopeId]);
```

### 3.2 Rust — `reorder_memos`

```rust
/// 드래그로 정한 순서 영속화 — ordered_ids 순서로 재배열, 목록에 없는 id는 상대순서 유지한 채 뒤로.
#[tauri::command]
pub fn reorder_memos(app, state, project_id: String, ordered_ids: Vec<String>) -> Result<(), IpcError> {
    {
        let mut notes = state.notes.write()…;
        if let Some(list) = notes.get_mut(&project_id) {
            let rank: HashMap<&str, usize> = ordered_ids.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
            let tail = ordered_ids.len();
            list.sort_by_key(|m| rank.get(m.id.as_str()).copied().unwrap_or(tail)); // stable sort
        }
    }
    persist(&app, &state)
}
```
`sort_by_key`는 안정 정렬 — 미포함 id의 상대 순서가 유지된다(`reorder_projects`의 `tail` 규칙과 동일).

### 3.3 프론트

- `ipc.reorderMemos(projectId, orderedIds)` → `callMutating("reorder_memos", …)`.
- `useReorderMemos()`: `onMutate`에서 `patchNotes`로 같은 규칙(rank·tail)으로 재배열; `onError` invalidate + 토스트(`useReorderProjects` 복제).
- `MemoPanel`: 행에 `data-memo-id={m.id}`, 목록 컨테이너 `ref`, `beginDrag` = `ProjectList.tsx:147-196` 복제(`[data-project-id]`
  → `[data-memo-id]`, `reorderMutate(ids)` → `reorder.mutate({projectId: scopeId, orderedIds: displayIds.reverse()})`).
  드래그 중 상태 `dragId`·`overId`; 행 클래스 `dragId===m.id ? "opacity-40"`, `overId===m.id`이면 행 상단 `absolute inset-x-0 top-0 h-0.5 bg-accent`
  (행을 `relative`로), 꼬리 삽입은 목록 끝 `h-0.5` 선. `onPointerDown={(e) => beginDrag(e, m.id)}` — 행은 `<button>`이라 pointerdown
  캡처 후에도 click이 뒤따르므로 임계 미달은 기존 `onClick`이 선택한다(ProjectList `:180` 주석과 동일).
  드래그가 성립한 경우 뒤따르는 click은 `dragged` ref로 한 번 무시(`flush()`가 불필요하게 돌지 않게).
- 두 셸(`MemoDialog`·`GlobalMemoPopover`)은 `MemoPanel`을 공유하므로 변경 0.

## 4. 변경 목록

| 파일 | 변경 | 규모 |
|---|---|---|
| `src-tauri/src/commands/notes.rs` | `reorder_memos` | ≈ +18 |
| `src-tauri/src/lib.rs` | 등록 | +1 |
| `src/lib/ipc.ts` | 바인딩 | +2 |
| `src/queries/index.ts` | `useReorderMemos` | ≈ +22 |
| `src/components/memo/MemoPanel.tsx` | reverse 표시·`beginDrag`·data-attr·삽입선 | ≈ +55 |
| `tests/e2e/suites/05-notes.mjs` | 절 추가 | ≈ +45 |

## 5. 검증

### 5.1 e2e 05 추가 절
1. 픽스처 스코프에 메모 3개 추가(본문 "A","B","C" — 순서대로) → 표시 순서 C,B,A(`[data-memo-id]` 순회, 제목 텍스트).
2. `get_notes`의 배열이 A,B,C(정본 불변 확인).
3. C 행에 `pointerdown(clientY=y0)` → `window pointermove(y0+8)` → A 행 중점 아래로 `pointermove` → `pointerup` 디스패치.
4. 폴링: DOM 순서 B,A,C; `get_notes` 배열 C,A,B(= 표시 역순).
5. 메모장 닫고 다시 열기 → 순서 유지. 새 메모 추가 → 맨 위.
6. `pointerdown` + 3px 이동 + `pointerup` → 순서 불변, 그 행이 선택됨(클릭 보존).
7. finally: 메모 3개 삭제.

### 5.2 실기
- 전역 메모 팝오버(작은 리사이즈 창)에서도 드래그·삽입선. 스크롤이 있는 긴 목록에서 아래쪽으로 드래그 시 컨테이너 자동 스크롤은 **없음**(ProjectList도 없음).
- 다른 창(플로팅/모아보기)에서는 메모장이 없다 — 해당 없음.

## 6. 위험

- "역순 표시" 규칙을 모르는 후속 변경이 `add_memo`를 `insert(0)`로 바꾸면 새 메모가 맨 아래로 간다 — `MemoPanel` 주석 + e2e 5가 잡는다.
- 안정 정렬 가정: Rust `sort_by_key`는 안정(문서 보장). JS 낙관 재정렬은 `Array#sort` 안정(ES2019+).

## 7. 열린 질문

| 질문 | 기본값 |
|---|---|
| 정렬 옵션(생성순/수정순 토글) | 없음 — 수동 순서 하나 |
| 드래그 중 컨테이너 자동 스크롤 | 없음(선례 동일) |

## 8. 구현 결과 (2026-09-07)

**구현 완료 · 정적 검증 통과(미커밋).** A안대로 스키마 변경 0 — 배열 순서가 정본, 표시는 `reverse()`.

- `notes.rs` `reorder_memos`(rank map + 안정 `sort_by_key`, 미포함 id는 tail) → `lib.rs` 등록 1줄
  (`commands/mod.rs`는 `pub use notes::*` 글롭이라 손댈 것 없음).
- `ipc.reorderMemos`(파일 끝 새 섹션) · `useReorderMemos`(낙관 재정렬 + onError invalidate·토스트).
- `MemoPanel`: 표시 `[...list].reverse()`, `data-memo-id` + `ProjectList` 포인터 드래그 복제(5px 임계·중점 삽입·
  `opacity-40`·accent 삽입선·꼬리선), 저장은 `ids.reverse()`.
- e2e 05에 `reorderBlock` — 표시/배열 방향 대조, 드래그 후 DOM·`get_notes` 양쪽, 재열기 유지, 새 메모 맨 위, 3px = 클릭.

**적대적 리뷰(2026-09-07)에서 확정돼 고친 것:**

| 지적 | 수정 |
|---|---|
| **(높음)** 끌던 행의 위쪽 절반에서 놓으면 `over === id` → `up()`이 splice 뒤 `indexOf`에서 -1을 받아 **맨 끝으로 보내고 저장**한다. 삽입선도 안 떠서 이유가 안 보인다. "집었다 제자리에 놓기"라는 가장 흔한 제스처가 순서를 망가뜨린다 | `move`의 후보 스캔에서 **끌고 있는 행을 건너뛴다** — 바로 다음 행이 잡혀 제자리가 되고 삽입선도 옳은 자리에 뜬다. (같은 잠복 결함이 `ProjectList.tsx:184`에도 있다 — 별도 커밋 대상) |
| 드래그를 **모달 배경 위에서** 놓으면 click이 pointerdown(행)과 pointerup(배경)의 공통 조상인 배경 div로 가 `MemoDialog`가 닫힌다. 행 onClick의 `dragged` 가드로는 못 막는다 | `up()`에서 **캡처 단계 one-shot `click` swallow**(window)로 교체. 셸 종류와 무관하게 막히므로 `dragged` ref는 삭제 |
| e2e finally가 `gp:memo-active:<fixtureId>` 키를 안 지워 실행마다 죽은 키가 쌓인다 | finally에 `localStorage.removeItem` 1줄 |

**미검증(§5.2 실기)**: 전역 메모 팝오버(작은 창)에서의 드래그·삽입선, 스크롤이 있는 긴 목록, e2e의 합성 포인터
시퀀스가 실제 앱에서 통과하는지.
