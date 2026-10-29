# 태스크 74 — PDF 주석 편집(M2 주석 코어) 구현 계약

> 상위 설계: `DOCS/pdf-viewer-editor-design.md`(§5 좌표 · §6 모델 · §7 저장 · §8 화면 · 부록 A pdf-lib 계약 L1~L3).
> 요청(2026-10-29): "PDF 보는 건 되는데 편집이 안 된다 — 전문적인 PDF 편집 앱처럼 쓸 수 있게."
> 이 문서는 **모듈 경계와 함수 시그니처**만 고정한다. 왜 그런지는 상위 설계서에 있다.

## 범위 (이번 회차)

- 주석 모드: 사각형·타원·직선·화살표·텍스트 상자(한글)·펜·형광펜 그리기 / 선택·이동·크기조절·삭제·복제 / undo·redo
- 속성: 선 색·채움 색(없음 포함)·두께·불투명도·글자 크기 — 선택 객체와 새 객체 기본값에 함께 적용
- 저장(Ctrl+S·버튼): **증분 저장**(원본 바이트 보존) + 표준 주석 사전 + AP 스트림. 다른 뷰어에서 같은 모양
- 다시 열기: 우리가 쓴 주석은 다시 편집 가능(규칙 1), 다른 앱의 Square/Circle/Line/Ink/평문 FreeText 도 편집 가능(규칙 2), 그 외는 건드리지 않음(규칙 3)
- dirty 표시, 저장 안 한 편집은 탭을 옮겼다 와도 남아 있음(창 메모리 초안), 외부 변경 시 배너
- **범위 밖(다음 회차)**: 텍스트 마크업(선택 텍스트 하이라이트/밑줄/취소선), 이미지·서명 삽입, 페이지 관리(M4),
  다른 이름으로 저장·정리 저장·평탄화, 세션 간 초안(사이드카). 기존 본문 텍스트 수정은 영구 비범위(설계 §16).

## 모듈

| 파일 | 소유 | 내용 |
|---|---|---|
| `src/lib/pdf/model.ts` | (고정) | `PdfPageInfo`·`PdfLedger`·`PdfTextLine`·`PdfFont`·`Affine` — 바꾸려면 양쪽 합의 |
| `src/lib/pdf/space.ts` | core | 아핀 곱·역행렬·점/사각형 변환(page↔user) |
| `src/lib/pdf/write.ts` | core | 노드 → 주석 사전 + AP(§6.2). pdf-lib 저수준 API(`context.obj`·`context.register`·`flateStream`/`stream`)만 |
| `src/lib/pdf/import.ts` | core | 규칙 1~3 · 작업 사본 inc₀(§6.3) |
| `src/lib/pdf/save.ts` | core | `buildIncrement`(순수) + `savePdf`(IPC 파이프라인 §7.1) |
| `src/lib/pdf/fonts.ts` | core | 한글 임베드 폰트 고르기·FontFace 등록(§6.4 5~7항) |
| `src-tauri/src/commands/fonts.rs` | rust | `pdf_font_candidates`·`font_read_raw` |
| `src/components/pdf/PdfAnnotate*.tsx`, `PdfView.tsx` 수정 | ui | 모드 탭·오버레이·도구 레일·속성 바·키·저장 버튼 |
| `tests/pdf/core-check.mjs` | core | Node 왕복 자가 검사(아래) |

## 시그니처 (core 가 export, ui 가 import)

```ts
// space.ts
export function mul(a: Affine, b: Affine): Affine;          // a 다음 b 적용 = b∘a
export function invert(m: Affine): Affine;
export function apply(m: Affine, x: number, y: number): [number, number];

// import.ts
export interface ImportResult {
  pages: EditorDoc[];            // pages.length === infos.length. 편집 가능 주석이 노드로 들어 있다
  ledger: PdfLedger;
  /** 편집 가능 주석을 /Annots 에서 뺀 표시용 바이트(원본 ⧺ inc₀). 가져온 주석이 없으면 null(원본 그대로 표시) */
  workingCopy: Uint8Array | null;
  /** 텍스트 노드 중 폰트가 없어 기본 폰트로 바꾼 수 등 — 사용자 안내용 */
  notes: string[];
}
export async function importAnnotations(bytes: Uint8Array, infos: PdfPageInfo[], font: PdfFont | null): Promise<ImportResult>;

// save.ts
export interface SaveModel {
  infos: PdfPageInfo[];
  pages: EditorDoc[];
  ledger: PdfLedger;
  /** 텍스트 노드의 줄 — 화면이 layoutText 로 계산해 넘긴다(Node 검사에서는 손으로 준다) */
  textLines: (node: TextNode) => PdfTextLine[];
  font: PdfFont | null;
}
/** 순수: 원본 바이트 → 증분 바이트 + 저장 뒤 장부. L1 saveIncremental(snapshot) · L2 /Annots 직접 · L3 fixSize */
export async function buildIncrement(bytes: Uint8Array, m: SaveModel): Promise<{ inc: Uint8Array; ledger: PdfLedger }>;
/** IPC: stamp 확인 → read_file_raw → buildIncrement → write_file_raw(append, expectedStamp, baseLen). 새 stamp 반환 */
export async function savePdf(projectId: string, path: string, expectedStamp: string, m: SaveModel): Promise<{ stamp: string; ledger: PdfLedger }>;
export function isDirty(pages: EditorDoc[], ledger: PdfLedger): boolean;

// fonts.ts
/** 후보 순서대로 font_read_raw → 임베드 사전 검사("가A" subset save) 통과한 첫 폰트를 FontFace 로 등록. 없으면 null. 결과 캐시 */
export async function ensurePdfFont(): Promise<PdfFont | null>;
```

`ipc.ts` 에 core 가 `writeFileRaw`(callMutating, raw 본문 + 헤더 — Rust `parse_write_headers` 참고), rust 가
`pdfFontCandidates`·`fontReadRaw` 래퍼를 **추가만** 한다.

## 주석 사전 규칙 (write.ts)

- 공통: `/Type /Annot /Subtype … /Rect`(user space) `/NM`(노드 id) `/F 4` `/M` `/P`(페이지 ref) `/C` `/CA` `/BS<</W /S /D>>`,
  `/GPV_Node`(노드 JSON, `PDFHexString.fromText`) `/GPV_APHash`(AP /N 스트림 **원시(압축 전이 아니라 파일에 쓰인) 바이트** FNV-1a hex).
- AP: `/AP<</N 스트림>>`, 스트림 `/BBox` = `/Rect`, `/Matrix` 항등, 내용 = `q <page→user 행렬> cm … Q`, 그 안은 page space 좌표.
  기하는 `toPathObject`/`toPathCmds`(annotate/vector) 한 출처. 화살촉은 `paint.ts` 의 머리 기하를 export 해 공유.
  노드 `rot` 은 기하에 이미 반영됐는지 확인하고, 아니면 cm 으로 회전.
- 텍스트: `1 0 0 -1 x baseline Tm`, 임베드 폰트 서브셋(`embedFont(bytes,{subset:true})` 은 PDFDocument 레벨 API 라 써도 된다 —
  L2 가 금지하는 건 **PDFPage 헬퍼**다), 커닝 없음, `/Contents` 평문, `/DA`.
- 형광펜: ExtGState `/BM /Multiply`. 불투명도는 `/CA`·ExtGState `/CA`·`/ca`.
- 재저장: `ledger.refs` 에 있는 노드는 **같은 ref 에 새 사전을 assign**(중복 생성 금지). 삭제는 그 ref 를 페이지 `/Annots` 에서 제거.
  페이지 `/Annots` 가 간접 배열이면 배열만, 직접이면 페이지 사전만 다시 쓴다(L2).

## 가져오기 규칙 (import.ts)

1. `/GPV_Node` + `FNV(/AP /N 원시 바이트) == /GPV_APHash` → JSON 무손실 복원(스키마 정규화 `normalizeDoc` 통과).
2. Square/Circle/Line(`/LE` None·OpenArrow·ClosedArrow, `/LL`·`/Cap` 없음)/Ink/FreeText(평문, `/RC`·Callout 없음),
   구름 테두리 `/BE` 없음 → 표준 키로 노드 생성.
3. 그 외 → 건드리지 않음(pdf.js 가 그린다).
- 규칙 1·2 해당 주석이 하나라도 있으면 그 ref 들을 `/Annots` 에서 뺀 증분 inc₀ 를 만들어 `workingCopy = 원본 ⧺ inc₀`.
- 암호화 문서는 편집 불가(호출 전에 ui 가 막는다 — pdf.js 로 암호를 받은 문서·권한 제한 문서).

## 화면 (ui)

- 툴바에 `[보기 | 주석]` 세그먼트. 주석 첫 진입 = `ensurePdfFont` + `read_file_raw` → `importAnnotations` → workingCopy 가 있으면
  pdf.js 를 그 바이트로 `setDocument` 교체(스크롤·줌 보존). 이후 외부 변경 폴링은 그대로 — 편집 없음이면 재로드+재가져오기,
  편집 있음이면 배너("다시 불러오기(편집 버림) / 계속 편집").
- 페이지 위 오버레이: 활성 페이지 1장 `AnnotationLayer`+`ChromeOverlay`, 노드 있는 비활성 페이지는 정적 `renderScene` 캔버스.
  배치·viewport 백킹·활성 전환 규칙은 `PdfAnnotateSpike.tsx`(S1 게이트 통과한 하니스)를 **그대로 옮긴다** — 단 페이지 div 는
  pdf.js `.page` 를 쓴다(React portal 로 각 `.page` 안에 붙인다. pdf.js 가 버퍼 밖 페이지 DOM 을 비워도 `.page` div 자체는 남는다).
- 보기 모드에서도 오버레이는 보인다(포인터 통과). 저장한 뒤에는 `seen` 을 새 stamp 로 맞춰 자기 저장이 재로드를 일으키지 않게.
- 레일: `ToolRail tools={PDF_TOOLS}`. 키: 주석 모드 + 뷰어 포커스일 때만 도구 키·Delete·Ctrl+Z/Ctrl+Shift+Z/Ctrl+Y·Ctrl+D·Esc,
  Ctrl+S 는 모드와 무관하게 저장(편집 있을 때). 앱 전역 단축키를 죽이지 않게 이 뷰어 루트 onKeyDown 에서만.
- 초안: 모듈 Map `projectId\0path → {pages, ledger, stamp}` — 언마운트 시 dirty 면 넣고, 마운트 시 같은 stamp 면 복원.
- 모든 UI 문구는 `src/i18n/text-pdf.ts` 에 ko/en 나란히.

## 검증

- `npx tsc --noEmit` 0, `cargo test --lib fonts` (rust), `node tests/pdf/core-check.mjs`(core): 새 PDF(클래식 xref `%PDF-1.3` 1개 +
  pdf-lib 기본 xref 스트림 1개, `/Rotate 90` 페이지 포함) → 7종 노드 저장 → ① 원본 접두사 바이트 동일 ② pdf-lib 재로드 주석 수·subtype
  ③ 규칙 1 가져오기 결과 노드 == 저장 노드(좌표 ±0.01) ④ 두 번째 저장(1개 수정·1개 삭제)에 주석 수 불변·삭제 반영 ⑤ trailer `/Size` 역행 없음
  ⑥ `/C` 를 바꾼 사본은 규칙 2로 바뀐 색이 들어온다. 실패하면 비 0 종료.
- 앱 실동작(통합 단계): dev 앱에서 CDP 로 그리기→저장→다시 열기→다시 편집, 한글 텍스트, 저장본을 pdf.js 새 로드로 픽셀 확인.
- 전체 e2e 는 돌리지 않는다(사용자 개발 중). e2e 62(스파이크)·`PdfAnnotateSpike.tsx` 정리는 이번 회차 범위 밖.
