# 태스크 41 — 사이드카 영속·자동저장·히스토리 v2(라벨·jumpTo·스냅샷)·에셋 획득

> 상태: 설계(Design) · 대상: gitpervisor · 근거: 코드 실측 2026-09-04(워킹트리) · 선행: 태스크 37(`parseImageDoc/serializeImageDoc`·`ImageDocEnvelope`),
> `DOCS/pro-image-editor-design.md` §4(창 수명 stash — 이 문서가 대체)·§7.0(`expected_stamp` 저장 가드), `DOCS/image-annotation-design.md` §0(원 결정
> "레포에 새 파일 0") · 시안: `designs/image-editor-figma-v2.pen` ①(타이틀바 `편집됨`)⑤(히스토리 탭) · 상위: `00-INDEX.md` §10.2(영속 결정) — **M2 첫 태스크.**

## 1. 요구사항

시안 ① 타이틀바 `장비별 현황판 대시보드.png · 편집됨`, ⑤ 히스토리 탭 `전체 · 내 작업 · 스냅샷 · 오늘 15:24 지시선 벡터 노드 편집(방금·현재) · 번호 뱃지 #3 이동 1분 전 ·
텍스트 내용 수정 · 고객사명 모자이크 마스크 적용 · 오늘 14:50 … · 어제 스냅샷 · 1차 검토본 · 이미지 열기 · 되돌리기 · 스냅샷 저장`, 상태바 `실행 취소 12단계`,
인스펙터 푸터 `저장 (PNG) · 다른 이름으로`, 레일 `이미지` 도구(외부 이미지 소스).

받아들이는 조건:
- 편집기를 닫거나 창을 닫거나 앱을 재시작해도 **벡터 문서가 남고**, 같은 이미지를 다시 열면 그대로 이어진다(37 §3.1 "진화"의 존재 이유).
- 레포 안에는 **새 파일이 생기지 않는다**(원 설계 사용자 조건 승계). git 변경 목록·rename·이동이 사이드카를 모르는 채로 어긋나지 않는다.
- 히스토리 항목마다 **라벨·시각**이 있고 임의 항목으로 `jumpTo`할 수 있다. 상한 50 → 200. 명명 스냅샷을 저장·복원한다. 이전 세션 항목은 라벨만 보이고 되돌릴 수 없음을 정직하게 표시한다.
- 원본 이미지가 밖에서 바뀌면(다른 도구·git checkout·다른 창 저장) **낡은 문서로 덮어쓰지 않는다** — 배너로 알리고 크롭을 푼다.
- 이미지 페인트·붙여넣기에 쓸 **이미지 바이트 획득 경로 3개**(레포 안 파일·레포 밖 파일·클립보드)가 문서 `assets`로 들어온다(37 `EditorDoc.assets`).
- 이 태스크만 머지해도 쓸 수 있다: UI는 기존 편집기 그대로, 닫기 확인창이 사라지고 재오픈 시 복원된다.

## 2. 현황(근거)

- **영속은 창 수명 `Map`뿐**: `ImageEditor.tsx:86-99` `stash`(상한 8, `stashPut`) — 닫을 때 `requestClose`(`:847-869`)의 확인창 `편집기 닫기`를 지나야만 넣고, 재오픈 시 `:354-357`이 `stamp` 일치할 때만 배너(`:1029-1040 이어서 하기`), `restoreStashed`(`:699-705`)가 `applyDoc` 통째 교체. doc 창이 닫히면 `Map`째 사라진다 — `onCloseRequested`(`:885`)는 확인만 받는다. **앱 재시작 후 0.**
- **직렬화 경계 없음**: `parseImageDoc|serializeImageDoc` grep 0건(37이 정의). 스냅샷 파일 포맷·버전·마이그레이션 — 없음.
- **히스토리 v1**: `history.ts:10 HISTORY_LIMIT = 50`, `commit(next)`(`:46-54`)는 문서 참조만 스택에 넣고 **라벨·시각이 없다**. `undo()`(`ImageEditor.tsx:271-278`)는 `setSelectedIds([])`로 선택을 비운다(e2e 30 (p-2b)가 이걸 우회하려고 재선택 1줄을 넣었다). 커밋 깔때기는 둘: `AnnotationLayer.tsx:354 commitObjects`(호출 5곳 `:366 :369 :476 :606 :615`) → `onCommit` → `ImageEditor.tsx:241 applyDoc`(`patchDoc` 11곳, `applyDoc` 직접 2곳). 라벨을 달 자리가 **두 깔때기의 인자 하나**로 끝난다.
- **원본 정체 대조는 이미 있다**: `read_file_base64`가 `stamp:"<mtime_ms>:<len>"`(`diff.rs:232-252 stamp_of`)을 주고, `write_file_bytes(…, expected_stamp)`(`tree.rs:365-396`)가 `ErrorCode::Conflict`로 거절한다(§7.0). 프론트는 `:297/:319`에서 스탬프를 잡고 `:737`에서 되돌려 준다. **사이드카에도 같은 기제를 재사용**하면 다중 창 충돌이 공짜다.
- **원자적 사용자 데이터 쓰기 패턴**: `state.rs:129 SAVE_LOCK`(전역 직렬화) · `:176-189 save_json_at`(tmp → rename) · `:132 data_path = app_data_dir/<file>`. 손상 파일은 `.corrupt`로 옮기고 로그(`:140-150` 주석). 사용자 데이터 루트는 **둘**이 이미 있다: `app_data_dir`(projects/settings/notes — state.rs:132)와 `app_local_data_dir`(LSP 서버 바이너리 — `lsp/acquire.rs:80,517,684`). 문서는 사용자 데이터라 전자.
- **레포 사이드카가 안 되는 이유**(코드): `status.rs:144` `git status --untracked-files=all`이 새 파일을 전부 변경 목록에 올린다 → `<img>.gpv.json`이 매번 Changes 패널에 뜬다. 자동 무시에 필요한 `.git/info/exclude` 쓰기는 `tree.rs:1753-1767 validate_rel_file`의 `.git` 컴포넌트 거부(CVE 방어)와 충돌한다. `renamePath.mutate`(`FileTreePanel.tsx:912`)·`movePath`(`:659`)·`deletePath`(`:894`)는 사이드카를 모른다.
- **e2e 전제**: `30:630 openEditor`가 재오픈 시 `A.fresh()`(objects 0)를 폴링한다 — 자동 복원이 들어오면 앞 케이스의 객체가 남아 **스위트 전체가 무너진다**(pro 설계 K7의 근거). `34:344`는 Esc 뒤 `편집기 닫기` 오버레이 존재를 단언한다(ConfirmHost 마운트 증거). `15:86-`은 `write_file_bytes` 4단언(스탬프 일치/불일치/생략).
- 붙여넣기·레포 밖 파일 선택 경로: 없음. `write_file_bytes`는 `resolve_in_repo` 전용(`tree.rs:373`), 프론트가 절대경로를 넘기는 커맨드는 이 저장소에 없다(screen-capture 설계 §5.2 원칙).

## 3. 설계

### 3.1 저장 위치 — **`app_data_dir/image-docs/<hex sha256(projectId + "\0" + relPath)>.json`**

| 대안 | 평가 |
|---|---|
| **A. 앱 데이터 사이드카, 키 = 경로 정체(sha256(pid\0rel))** (채택) | 레포 오염 0. `state.rs` 원자 쓰기·`SAVE_LOCK`·`data_path` 재사용, `sha2`는 `Cargo.toml:71`에 이미 있다. 키가 stash(`:89`)와 같은 규칙이라 개념이 하나. 이름변경/이동/삭제는 앱 내 콜백 3곳에 `imageDocMove/Delete` 1줄씩 |
| B. 레포 안 `<img>.gpv.json` | §2의 세 근거(untracked 노출·`.git/info/exclude` 금지·rename 무추적). **프로젝트별 옵트인으로 후속** — INDEX §10.3 열린 질문 |
| C. 키 = 원본 **내용** 해시 | e2e 픽스처 3개가 바이트 동일(30/34/35 모두 200×200 흰색)이라 문서를 공유하고, 평탄화 저장 순간 내용이 바뀌어 키가 사라진다 |
| D. `localStorage` | `gp:file-draft:*`(미저장 파일 내용, 최대 1.5MB)와 5MB origin 경쟁 — 버려도 되는 주석 문서가 복구 불가능한 초안을 밀어낸다(pro 설계 K6) |
| E. `app_local_data_dir` | LSP 바이너리 루트. 사용자 데이터는 `app_data_dir`(projects/settings) 쪽이 관례 — 루트를 하나 더 늘리지 않는다 |

파일 = `ImageDocEnvelope`(37 §4: `v, projectId, relPath, imageStamp, imageW, imageH, savedAt, doc, foreign, log`). 스냅샷은 **별도 파일** `<key>.snapshots.json`(`{name, at, doc}[]`, 상한 20) — 자동저장 경로에 스냅샷이 섞이면 매 저장이 20벌을 다시 쓴다.

### 3.2 Rust — `commands/image_doc.rs` (커맨드 4 + 파일 선택 1)

- `image_doc_read(project_id, rel_path, kind:'doc'|'snapshots') → {json:String|null, stamp:String|null}` — 없으면 `null`(에러 아님). `stamp`는 사이드카 파일의 `stamp_of`.
- `image_doc_write(project_id, rel_path, kind, json, expected_stamp:Option<String>) → {stamp}` — `expected_stamp` 불일치 → `Conflict`(다른 창이 먼저 저장). **32MB 상한**(에셋 base64 16MB + 문서). `save_json_at`과 같은 tmp+rename·`SAVE_LOCK`. 경로 검증: `rel_path`는 `validate_rel_file` 통과 필수(키만 만들지만 로그·에러 문구에 쓴다).
- `image_doc_move(project_id, from, to)` / `image_doc_delete(project_id, rel_path)` — doc·snapshots 둘 다. 없으면 no-op.
- `asset_pick_file() → {mime, base64, w?, h?}|null` — Rust가 `tauri-plugin-dialog`로 파일을 고르고 **바이트만** 돌려준다(경로 미노출·16MB 상한·이미지 MIME만). 프론트가 절대경로를 다루지 않는 원칙 유지.
- `write_file_bytes`는 성공 시 `Option<String>`(새 stamp)을 돌려주도록 반환형 변경(`tree.rs:365`) — 평탄화 저장 직후 `imageStamp`를 갱신하려고 되읽지 않는다(15 e2e +1 단언).

### 3.3 프론트 — `annotate/persist.ts` `useImageDocPersist`

```
load(pid, rel)  → imageDocRead → parseImageDoc → hist.reset(env.doc, '이미지 열기', env.log)
                 · env.imageStamp !== 열 때 stamp || imageW/H !== naturalW/H → 배너 "원본이 바뀌었습니다" + doc.crop=null·outW/H 재설정(37 normalizeDoc)
markDirty()     → applyDoc(commit)마다. 1s 디바운스, 단일 비행(진행 중이면 dirty 플래그만), doc 참조 불변이면 skip
flush()         → 편집기 unmount·doc 창 onCloseRequested·window pagehide 에서 await. Conflict 면 확인창 "다른 창에서 저장됨 — 덮어쓰기 / 다시 불러오기"
deleteDoc()     → 평탄화 in-place 성공 시(R8) — '다른 이름으로'·내보내기(52)는 유지
saveSnapshot(name) / listSnapshots() / loadSnapshot(i)
```

- **닫기 확인창 삭제**(`:847-869`, `34:344` 단언은 §7로 이동): 잃는 것이 없다. doc 창 X는 `flush` 뒤 `destroy()`; flush 실패(Conflict·IO)에만 "그래도 닫기".
- `stash`(`:86-99`)·`recoverable` 배너(`:1029`)·`restoreStashed/discardStashed` 삭제 — 자동 복원이 대체. 원본 변경 배너는 남기되 의미가 바뀐다(위 load 규칙).
- 평탄화 확인 문구: `주석을 합쳐 저장`(`:801`) → **"레이어가 이미지에 구워지고 편집 문서가 삭제됩니다"**.
- 타이틀바 `편집됨` 점 = `dirty || 비행 중`(42가 그린다 — 여기서는 `persist.state: 'clean'|'dirty'|'saving'|'error'` 노출).
- 앱 내 콜백: `renamePath`(`FileTreePanel.tsx:912`)·`movePath`(`:659`)·`deletePath`(`:894`) 성공 후 `isImage`면 `imageDocMove/Delete`. 앱 밖 rename은 추적 불가 → 고아 문서는 남는다(용량 상한·수동 정리 없음, 열린 질문 아님: 파일당 ≤32MB·실사용 수십 개).

### 3.4 히스토리 v2 — `history.ts`

- `HistoryEntry{doc, label, at, readonly}`, `HISTORY_LIMIT = 200`(커밋 비용 = `objects` 배열 참조 복사 N×8B — 5,000노드 40KB×200 = 8MB 천장, 구조 공유 라이브러리 불필요), `entries/cursor`, `jumpTo(i)`(past/future 재구성), `reset(doc, label, priorLog)`.
- 라벨: 커밋 사이트가 아는 곳은 명시(`applyDoc(next,'commit', label)` — 크롭·회전·그룹·스타일·텍스트 확정), 나머지는 `describeChange(prev,next)` 폴백(추가 "사각형 생성", 삭제, 이동 "Δ12,−4", 속성 "채우기 F0398B"). `patchDoc`(11곳)·`commitObjects`(5곳)에 라벨 인자 추가.
- 이전 세션: `env.log`(`{at,label}` 200개 캡)는 **readonly 항목**으로 표시(⑤ `어제 · 이미지 열기`) — 되돌리기 불가. "세션 간 전체 스택 영속"은 자동저장마다 200벌을 쓰는 비용이라 채택 안 함(INDEX §10.5).
- `undo/redo` 뒤 `selectedIds`는 **존재하는 id만 남긴다**(`:278`의 전부 비우기 → 필터) — e2e 30 (p-2b)의 재선택 우회 삭제 가능.
- `ev.repeat` 무시(K5)·"드래그 1회 = 1칸" 유지.

### 3.5 에셋 획득 3경로 → `doc.assets`

| 경로 | 구현 |
|---|---|
| 레포 안 파일(파일트리 드래그·이미지 도구에서 선택) | 기존 `read_file_base64`(`ipc.ts:1071`) |
| 레포 밖 파일 | `asset_pick_file`(§3.2) |
| 클립보드 붙여넣기 | `AnnotationLayer` `paste` 핸들러 — `ClipboardEvent.clipboardData.files` → `FileReader` base64 |

공통: 디코드해 `w/h` 확정, 합 16MB·총 16MP 초과 시 거부(토스트), `assets[assetId] = {mime,w,h,data}`. 디코드 캐시(`ImageStore`)는 39 소유(→ 39 §4).

### 3.6 만들지 않는 것

- 레포 사이드카 옵트인(열린 질문), `.gpv.json` 내보내기/가져오기(52 후속), 세션 간 undo 스택 영속, 고아 문서 정리 UI, 클라우드/동기화, 히스토리 **패널 UI**(→ 44), 타이틀바 점 렌더(→ 42), 이미지 페인트 렌더(→ 39).

## 4. 계약 (소유: 41)

```rust
// src-tauri/src/commands/image_doc.rs  (lib.rs invoke_handler :943 옆에 5개 등록, mod.rs +1)
#[tauri::command] async fn image_doc_read(state, project_id: String, rel_path: String, kind: String) -> Result<ImageDocRead, IpcError>   // {json: Option<String>, stamp: Option<String>}
#[tauri::command] async fn image_doc_write(state, project_id, rel_path, kind, json: String, expected_stamp: Option<String>) -> Result<String, IpcError> // 새 stamp; 불일치 → Conflict; >32MB → Io
#[tauri::command] async fn image_doc_move(state, project_id, from: String, to: String) -> Result<(), IpcError>
#[tauri::command] async fn image_doc_delete(state, project_id, rel_path: String) -> Result<(), IpcError>
#[tauri::command] async fn asset_pick_file(app) -> Result<Option<AssetBytes>, IpcError>    // {mime, base64}; 이미지 MIME·≤16MB
// tree.rs: pub async fn write_file_bytes(…) -> Result<Option<String>, IpcError>          // 성공 시 새 stamp
```

```ts
// src/lib/ipc.ts
imageDocRead(projectId, relPath, kind:'doc'|'snapshots'): Promise<{json:string|null; stamp:string|null}>
imageDocWrite(projectId, relPath, kind, json, expectedStamp?): Promise<string>            // callMutating 60s
imageDocMove(projectId, from, to) · imageDocDelete(projectId, relPath) · assetPickFile(): Promise<{mime;base64}|null>
writeFileBytes(...): Promise<string|null>                                                 // 반환형만 변경

// src/lib/annotate/persist.ts
export function useImageDocPersist(pid, rel, hist: DocHistory): { load(): Promise<LoadResult>; markDirty(): void; flush(): Promise<void>;
  deleteDoc(): Promise<void>; saveSnapshot(name): Promise<void>; listSnapshots(): Promise<{name;at}[]>; loadSnapshot(i): Promise<EditorDoc>;
  state: 'clean'|'dirty'|'saving'|'error'; imageChanged: boolean }
type LoadResult = { doc: EditorDoc; log: {at;label}[]; imageChanged: boolean } | null

// src/lib/annotate/history.ts
export interface HistoryEntry { doc: EditorDoc; label: string; at: number; readonly: boolean }
export const HISTORY_LIMIT = 200;
class DocHistory { commit(next, label?); replace(next); undo(); redo(); jumpTo(i); get entries(): readonly HistoryEntry[]; get cursor(): number; reset(doc, label, priorLog?) }
export function describeChange(prev: EditorDoc, next: EditorDoc): string;
// ImageEditor: applyDoc(next, mode, label?) · patchDoc(patch, mode, label?) · AnnotationLayer onCommit(next, label?)
```

e2e 훅: `window.__gpv.imageDocs = { delete(pid, rel), read(pid, rel) }`, `window.__gpv.imageEditor.history = { entries(): {label; at; readonly}[]; cursor(); jumpTo(i); snapshot(name); state() }`.

## 5. 단계

1. **Rust**: `image_doc.rs` 신규(≈180) + `mod.rs`/`lib.rs` 등록(+6) + `tree.rs` 반환형(+6) + `asset_pick_file`(≈40, `tauri-plugin-dialog` 이미 의존). `cargo test`: 키 해시·32MB 상한·Conflict 단위 3개.
2. **history.ts** v2(88 → ≈180) + 커밋 사이트 라벨(`AnnotationLayer` 5곳 ≈+15, `ImageEditor` 13곳 ≈+30) + undo 선택 필터(+3).
3. **persist.ts** 신규(≈200) + `ImageEditor` 이행(stash·배너·확인창 삭제 ≈ −90, load/flush/deleteDoc/onCloseRequested 배선 ≈ +70, 평탄화 문구 +2) + `FileTreePanel` 콜백 3곳(+9) + `ipc.ts`(+30).
4. **에셋 획득**: `AnnotationLayer` paste(+40) · `ipc.assetPickFile` · 상한 검사 유틸(+30).
5. **e2e**: `37-image-doc-persist.mjs` 신설(§7), `30/34/35 openEditor`에 `imageDocs.delete` 1줄, `34:344` 단언 이전, `15` +1, `run.mjs` 1줄.

규모 **L**: Rust ≈ +230 · 프론트 ≈ +430/−100 · 신규 의존 0(`sha2`·`dialog` 기존).

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| 자동 복원이 e2e 30 `A.fresh()` 계약을 깬다 | 앞 케이스 객체가 재오픈에 남으면 40×250ms 타임아웃 후 스위트 통째 return | `openEditor` 헬퍼 첫 줄 `imageDocs.delete(repoId, p)`(30/34/35 각 1줄) + `run.mjs` teardown이 픽스처 프로젝트 문서 폴더 정리 |
| 러너 잔존 문서가 다음 실행을 오염 | 실패한 실행이 사이드카를 남긴다 | 위와 동일 + 키가 `projectId` 포함이라 픽스처 프로젝트 삭제 시 고아가 되지만 무해(다음 실행은 새 pid) |
| 히스토리 200 × 대형 문서 | 노드 5,000·에셋 16MB면 `doc.assets`는 참조 공유라 스냅샷 비용 0, `objects` 40KB×200 | 8MB 천장(§3.4). 에셋은 문서 안 한 벌 |
| 두 창이 같은 문서를 편집 | 나중 저장이 덮는다 | `image_doc_write` `expected_stamp` → Conflict → 확인창. 사용자 결정 없이 조용히 덮지 않는다 |
| 원본이 바뀐 뒤 낡은 crop으로 저장 | 빈 이미지가 원본 자리에 | load 시 `imageStamp`/`imageW/H` 대조 → crop 해제 + 배너(현 `:354-357` 규칙 승계) |
| `pagehide`에서 flush가 못 끝남 | 창이 먼저 죽는다 | 1s 디바운스 + 커밋 즉시 dirty라 손실 상한 1초. doc 창 X는 `onCloseRequested`가 `await flush()` 뒤 destroy |
| 붙여넣기가 텍스트 편집 textarea 붙여넣기를 가로챔 | 텍스트 입력 중 Ctrl+V | `editingRef`(AnnotationLayer:136-143) 있으면 통과, 캔버스 포커스일 때만 |
| 32MB 상한 초과 문서 | 에셋 많은 문서 저장 실패 | 획득 시점에 합 16MB·16MP 거부(토스트) — 저장은 넘길 수 없다 |

## 7. 검증

- **e2e 37 (신규)**: (a) 객체 2개 → `closeImageEditor` → 재오픈 → `getDoc().objects.length===2`·히스토리 첫 항목 라벨 `이미지 열기`·readonly. (b) `imageDocs.read`의 `json`이 `roundTrip` 동치, 파일 경로가 `app_data_dir/image-docs/<64hex>.json`(Rust 훅으로 존재 확인). (c) 원본을 `write_file_bytes`로 바꾼 뒤 재오픈 → 배너 + `crop===null`. (d) 제자리 평탄화 저장 → `imageDocs.read` `json===null`(R8). (e) `saveAs` → 문서 유지. (f) `renamePath` 후 새 경로로 재오픈 → 문서 따라옴; `deletePath` → 삭제. (g) 히스토리: 커밋 3회 → `entries().length===4`·라벨 3개 비어 있지 않음·`jumpTo(1)` 후 `objects.length===1`·`state()==='dirty'`→1.5s 뒤 `'clean'`. (h) `saveSnapshot('1차')` → `listSnapshots` 1건 → 객체 삭제 → `loadSnapshot(0)` 복원. (i) 다중 창: `imageDocWrite`를 낡은 stamp로 → `CONFLICT`. (j) `asset_pick_file` 취소 → `null`; 붙여넣기 이벤트 합성 → `doc.assets` 1건·`w/h` 채워짐; 17MB 합성 → 거부 토스트.
- **회귀**: 30(91)·34(32)·35(13) — `openEditor` +1줄 외 무변경으로 전부 pass. `34:344` "편집기 닫기" 단언 → 평탄화 확인창 `레이어가 이미지에 구워지고…` 오버레이 단언으로 교체(ConfirmHost 마운트 증거 유지). 15: `write_file_bytes` 반환 stamp가 다음 `read_file_base64.stamp`와 동일 +1.
- **Rust**: `cargo test` 키 해시 고정값·상한·Conflict.
- **실기**: 편집 → 창 X → 재오픈 복원; 앱 재시작 후 복원; 다른 창에서 같은 이미지 저장 → 충돌 확인창; 원본을 외부 편집기로 덮은 뒤 재오픈 배너.
