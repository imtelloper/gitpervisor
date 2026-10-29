# 태스크 75 — PDF 편집 M3(확장)·M4(페이지 관리) 구현 계약

> 상위 설계: `DOCS/pdf-viewer-editor-design.md` §6.1(PdfMarkup·pageKey) · §7.2(다른 이름·정리 저장·평탄화) · §12 M3·M4.
> 선행: 태스크 74(M2 주석 코어 — `src/lib/pdf/{model,space,write,import,save,fonts}.ts`, PdfView 주석 모드).
> 요청(2026-10-29): "다음 회차로 미룬 것도 다 개발해" — 전문 PDF 편집 앱 수준.

## 범위

| # | 기능 | 판정 |
|---|---|---|
| **T1 텍스트 마크업** | 주석 모드 도구 `하이라이트·밑줄·취소선`(텍스트 위 드래그 = pdf.js 텍스트 레이어 선택) → `Highlight/Underline/StrikeOut` + `QuadPoints` + AP. 선택·삭제·색 변경·undo. 다시 열면 편집 가능(규칙 1·2) | 저장본 pdf.js 재로드 픽셀 |
| **T2 이미지** | `이미지` 도구: 파일 고르기(레포 안·밖 모두 — 기존 이미지 삽입 경로/다이얼로그 재사용) 또는 붙여넣기 → 페이지에 배치, 이동·크기조절 → `Stamp` + 이미지 XObject AP(PNG/JPG; 그 밖은 캔버스로 PNG 변환) | 왕복 |
| **T3 서명** | `서명` 도구: 서명 패드(펜으로 그리기) → 앱에 저장(여러 개, 이름·삭제) → 클릭으로 배치(Ink 묶음 = 펜 노드들 그룹 또는 단일 path) | 재시작 후에도 목록 유지 |
| **T4 저장 변형** | 다른 이름으로 저장(같은 레포 안 경로, 덮어쓰기 확인) · 정리 저장(`save({rewrite})`로 이전 리비전 제거 — 서명 문서면 막고 사유 표시) · 평탄화 내보내기(`<stem>-flattened.pdf`, AP 를 페이지 콘텐츠로) | 정리 저장 뒤 지운 주석 `/NM` 0건 · 평탄화본 `/Annots` 없음 |
| **T5 초안 사이드카** | 저장 안 한 편집을 앱 데이터에 자동 보관 → 앱 재시작 후 같은 파일(같은 stamp)을 열면 "저장 안 한 편집 복원" 배너 | 강제 종료 후 복원 |
| **T6 페이지 관리** | 모드 탭 `[보기 │ 주석 │ 페이지]`. 페이지 모드 = 전체 썸네일 그리드: 다중 선택, 드래그 순서 변경, 90° 회전(좌·우), 삭제, 빈 페이지 삽입(현재 크기), 다른 PDF 삽입(파일 고르기), 선택 페이지 추출(새 파일), 복제. 연산은 목록으로 쌓고 undo 가능, 저장 시 한 번에 적용 | 순서 변경 후 저장→다시 열기에서 노드가 같은 페이지 내용을 따라감 · 회전 시 노드도 같이 돈다 |

**영구 비범위**(설계 §16): 기존 본문 텍스트 직접 수정, 진짜 가리기(Redaction), 폼 입력, 전자서명 *생성*(인증서).

## 모델 변경 (M4 가 주도)

- `PdfPageInfo` 에 `key: string` 추가 — 원본 페이지 객체 ref `"12 0 R"`, 삽입 페이지 `"new:<uuid>"`. 노드·마크업·장부의 페이지
  소속은 **key** 로 바꾼다(`PdfLedger.pageOf: Map<id, string>`). index 는 표시 순서일 뿐이다. pdf.js 쪽 key 는 `page.ref`(`{num,gen}`).
- 페이지 연산 목록: `PageOp = {kind:"move",from,to} | {kind:"rotate",keys,delta:90|-90} | {kind:"delete",keys} | {kind:"insertBlank",at,w,h}
  | {kind:"insertPdf",at,sourcePath}(레포 상대 또는 절대) | {kind:"duplicate",keys}`. 저장 = 연산 적용 → 주석 증분과 **같은** 증분 하나.
- 회전: 그 페이지 노드에 `geometry.ts` 90° 델타 아핀(이미지 편집기 회전 경로) 적용, page space (w,h)→(h,w).
- 추출: 선택 key 들을 새 문서로 `copyPages` → 새 파일(replace, overwrite:false). 원본 불변.
- `PdfMarkup`(설계 §6.1)은 노드 트리 밖 페이지별 배열로 둔다. 히스토리 스냅샷에 pages(노드)·markups·pageOps 를 함께 넣는다.

## 모듈 소유

| 파일 | 소유 |
|---|---|
| `src/lib/pdf/pages.ts`(신규) · `src/components/pdf/PdfPagesGrid.tsx`(신규) · `model.ts` key 변경과 그 파급 | **pages** |
| `src/lib/pdf/markup.ts`(신규: 선택→quad, quad AP) · `src/components/pdf/PdfSignaturePad.tsx`(신규) · write/import 의 Highlight·Underline·StrikeOut·Stamp 분기 | **markup** |
| `src/lib/pdf/export.ts`(신규: saveAs·cleanSave·flatten) · `src/lib/pdf/draft.ts`(신규: 사이드카) · Rust 필요 시 `commands/raw_file.rs` 추가 | **export** |
| `PdfView.tsx` · `PdfAnnotate*.tsx` · `text-pdf.ts` · `ipc.ts` · `lib.rs` | 공유 — **추가 위주**, Edit 직전 재Read, 남의 블록 재작성 금지 |

## 검증

`npx tsc --noEmit` 0 · `node tests/pdf/core-check.mjs` 에 T1·T2·T4·T6 단언 추가(마크업 왕복, Stamp 이미지 왕복, 정리 저장 뒤 `/NM` 0건 + 그 전 ≥1건 대조,
평탄화 `/Annots` 0, 페이지 순서 변경·회전·삭제·삽입·추출 후 페이지 수·크기·노드 소속) · cargo test(추가 Rust 있으면) · dev 앱 CDP 실동작.
전체 e2e 는 돌리지 않는다.
