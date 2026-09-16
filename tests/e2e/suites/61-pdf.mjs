// PDF M1 — 읽기 전용 PDF 뷰어(DOCS/pdf-viewer-editor-design.md §12 M1 수용 기준 7개 + 부가 단언).
//
// 창의 DEV 여부로 두 모드를 가른다:
//   dev 모드  (`__gpv.ui` 있음, npm run dev:app) — C1~C6 + 부가. C7(CSP)은 dev 창에 CSP 가 아예 없어
//             (Tauri 는 frontendDist 의 html 응답에만 헤더를 붙인다) '위반 0' 이 항상 참이라 사유를 달고 skip.
//   prod 모드 (`__gpv` 없음) — C7 만. 연결된 창 origin 이 http://tauri.localhost 가 아니면 skip 이 아니라 FAIL.
//
// 기준 C1~C7:
//   C1 레포 안 PDF → 첫 페이지 잉크 · git diff 스폰 0(get_file_diff · 프리페치 get_file_diffs · 쿼리 캐시)
//   C2 비임베드 한글(KSCms-UHC-H) 픽스처에서 '가나다' 검색 · 자산(cMap·nowasm) 서빙
//   C3 외부 링크 클릭 후 웹뷰 URL 불변 · javascript: 링크는 아무 일도 없음(문서 창 — 러너 보호)
//   C4 외부에서 다시 쓰면 3초 안에 재로드 · 현재 페이지 유지 (+C4-b 숨은 탭 · C4-c 반쯤 쓴 파일)
//   C5 암호 PDF — 틀린 암호는 재입력, 맞으면 표시(+취소·loading task 누수 0 · 폼 제출이 창을 리로드하지 않음)
//   C6 200쪽을 끝까지 넘겨도 페이지 캔버스 수가 max(10, 2·visible+1) 이내
//   C7 앱 WebView2(http://tauri.localhost)에서 CSP 위반 0 + JPX 픽셀 일치 + DEV 훅 누출 0
//
// **헛단언 방지** — 모든 단언에 "기능이 고장 나 있으면 빨개지는가"의 반증을 붙인다. 관측 수단이 없는 절반은
// pass 가 아니라 사유를 단 skip 이다(프리페치 형제 미관측 · CSP 양성 대조 미관측 등).
//
// 상태는 DEV 훅 `window.__gpv.pdf.byPath(path).state()`(PdfView.tsx)로 읽고, ipc 호출은 창이 **실제로 로드한**
// /src/lib/ipc.ts 모듈의 `ipc` 객체 속성을 갈아 끼워 기록한다(`__TAURI_INTERNALS__.invoke` 는 non-writable).
// PdfView·queries 는 호출 시점에 `ipc.xxx` 를 조회하므로(구조분해 금지 계약) 같은 객체만 잡으면 된다.
// 키·마우스는 CDP Input.* 실제 입력(히트 테스트·기본 동작·포커스 경로)으로 쏜다.
//
// 창 리로드가 끼면(워크트리 파일 저장 · 폼 GET 제출) 수치는 무효다 — performance.timeOrigin 불변을 단언한다.
//
// ── prod 모드(C7) 실행법 ─────────────────────────────────────────────────────────────────────────
//   dev 앱과 데이터 디렉터리·CDP 포트가 섞이지 않게 한다(CLAUDE.md '개발 실행' 의 사고 유형):
//   1) 두 워크트리(F:/gitpervisor · F:/gitpervisor-pdf)의 dev 앱이 모두 꺼져 있는지 **포트 소유 PID** 로 확인한다.
//        Get-NetTCPConnection -State Listen -LocalPort 29222,39090 -ErrorAction SilentlyContinue |
//          ForEach-Object { Get-Process -Id $_.OwningProcess | Select-Object Id, Path }
//      아무것도 안 나와야 한다. 다른 dev 앱이 29222 를 쥐고 있으면 러너가 그 앱에 붙어 dev 모드로 판정되고
//      C7 은 조용히 빠진다. 두 dev 앱은 identifier `.dev` 를 공유하므로 둘 다 꺼야 한다.
//   2) scratchpad 에 identifier 만 덮는 한 줄 설정을 둔다 — tauri.dev.conf.json(.dev)을 쓰면 dev 앱들과
//      projects.json·settings.json·session.json 을 공유한다:
//        {"identifier":"com.greathoon.gitpervisor.e2eprod"}   → <scratchpad>/tauri.e2eprod.conf.json
//   3) CARGO_TARGET_DIR=<레포 절대경로>/src-tauri/target/e2e-prod npm run tauri build -- --debug --no-bundle --config <그 파일의 절대경로>
//      (/target/ 아래라 .gitignore 에 걸린다 · 기준 디렉터리 해석에 기대지 않게 절대경로로 준다)
//      --debug: CDP 포트(29222)는 debug_assertions 전용이다. 비-dev(custom-protocol)라 origin 이
//      http://tauri.localhost 이고 security.csp 가 걸린다. target 을 분리해야 target/debug/gitpervisor.exe 가
//      custom-protocol 판으로 덮이지 않는다(덮이면 다음 dev:app 이 통째로 재빌드된다).
//      beforeBuildCommand(npm run build → prebuild)가 dist 와 public/pdfjs 를 새로 만든다 — 아래 누출 grep 대상.
//   4) src-tauri/target/e2e-prod/debug/gitpervisor.exe 를 띄운다. 데이터 디렉터리가 비어 있어도 러너가
//      add_project 로 픽스처를 직접 등록한다(run.mjs).
//   5) GPV_E2E_ONLY=61 node tests/e2e/run.mjs
//   끝나면 그 exe 를 끄고 dev 앱을 다시 띄운다.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { connectLabel } from "../lib/cdp.mjs";

export const name =
  "PDF M1 읽기 뷰어 (첫 페이지·diff 0 · 한글 검색 · 링크 · 외부 재기록 · 암호 · 200쪽 캔버스 · CSP/JPX)";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const J = JSON.stringify;
const WIN_API = "/node_modules/@tauri-apps/api/webviewWindow.js";
/** 워크트리 루트(tests/e2e/suites → ../../..) — dist·소스·node_modules grep 용. */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Windows·Linux 는 Ctrl(2), macOS 는 ⌘(4) — PdfView 의 isMod 와 같은 규칙. */
const MOD = process.platform === "darwin" ? 4 : 2;
const SHIFT = 8;
const GROUP = "gpv61-heap";

const DIR = "pdf-e2e";
const P = {
  // 워처가 무시하는 build/ 아래 — 이벤트(repo://changed) 무효화만으로 구현했다면 C4 가 빨개진다.
  p12: `${DIR}/build/pages12.pdf`,
  // 바이트 정렬상 pages12.pdf 바로 뒤 — 프리페치가 여기까지 봤다면 PDF 도 후보였다(C1 형제 대조).
  p12sib: `${DIR}/build/pages12.txt`,
  p200: `${DIR}/pages200.pdf`,
  kr: `${DIR}/kr-uhc.pdf`,
  krNo: `${DIR}/kr-uhc-nocmap.pdf`, // 같은 바이트 · 다른 경로 → 새 인스턴스 · 새 문서(cMap 캐시는 문서 단위)
  links: `${DIR}/links.pdf`,
  enc: `${DIR}/enc.pdf`,
  encCancel: `${DIR}/enc-cancel.pdf`,
  swap: `${DIR}/swap-to-enc.pdf`, // 평문으로 보다가 암호 PDF 로 재기록 — 재로드 중 암호 취소
  warm: `${DIR}/warm-import.ts`, // import 가 있는 텍스트 — 정의 예열(findDefinition)이 실제로 도는 대조
  jpx: `${DIR}/jpx.pdf`,
  bad: `${DIR}/bad.pdf`,
  nodir: `${DIR}/nodir/x.pdf`,
  unrelated: `${DIR}/unrelated.txt`,
};

// ── 픽스처 ─────────────────────────────────────────────────────────────────────────────────────────
// pdf-lib 는 M2 전까지 설치되지 않는다 — 바이트 오프셋 xref 를 직접 쓰는 최소 라이터(make_fixtures.py raw_pdf 의 JS 판).
// pdf.js 는 깨진 xref 를 조용히 재구성하므로 M1 이 통과해도 픽스처 정합성은 보증되지 않는다 → 자기검증으로 막는다.

/** AES-256(R6) 암호 PDF 1쪽 A4 Helvetica '(Encrypted GPV fixture)', 암호 gpv-pass.
 *  재생성 메모: scratch venv pikepdf 10.13 으로 만든 뒤
 *  `pdf.save(p, encryption=pikepdf.Encryption(user='gpv-pass', owner='gpv-owner', R=6))`.
 *  /ID 가 매번 바뀌므로 이 base64 가 정본이다(check-enc.mjs: 암호 없음 code 1 · 틀림 2 · 맞음 텍스트). */
const ENC_B64 =
  "JVBERi0xLjcKJb/3ov4KMSAwIG9iago8PCAvRXh0ZW5zaW9ucyA8PCAvQURCRSA8PCAvQmFzZVZlcnNpb24gLzEuNyAvRXh0ZW5zaW9uTGV2ZWwgOCA+PiA+PiAvUGFnZXMgMiAwIFIgL1R5cGUgL0NhdGFsb2cgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL0NvdW50IDEgL0tpZHMgWyAzIDAgUiBdIC9UeXBlIC9QYWdlcyA+PgplbmRvYmoKMyAwIG9iago8PCAvQ29udGVudHMgNCAwIFIgL01lZGlhQm94IFsgMCAwIDU5NSA4NDIgXSAvUGFyZW50IDIgMCBSIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDUgMCBSID4+ID4+IC9UeXBlIC9QYWdlID4+CmVuZG9iago0IDAgb2JqCjw8IC9MZW5ndGggODAgL0ZpbHRlciAvRmxhdGVEZWNvZGUgPj4Kc3RyZWFtCkvuhRe9P7uxNI4vNKWky+4A6+GRvG31JbpoW61MX939pKWgrti8Ulkte/brQK5IGcoSFinYdHwBEIYG6QFdb7ZUn5KxWxMHU1KRr2YUGXsbCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvQmFzZUZvbnQgL0hlbHZldGljYSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQgPj4KZW5kb2JqCjYgMCBvYmoKPDwgL0NGIDw8IC9TdGRDRiA8PCAvQXV0aEV2ZW50IC9Eb2NPcGVuIC9DRk0gL0FFU1YzIC9MZW5ndGggMzIgPj4gPj4gL0ZpbHRlciAvU3RhbmRhcmQgL0xlbmd0aCAyNTYgL08gPDI4MGMwNjMwYzEzYzcxYmIzYTU4MGU4M2EwMjcyZTA1MzQ4NzM0OTZlYWJlMDFhMGQwMWZlMDI4MzYyMjViM2IzMTU4N2ZhOWM2YWI5ZWMyODljYmZkY2QzN2MwYmNhZj4gL09FIDwwMmVjZWFlMmU2NjE3N2JjZDg3NTUzNWYxODc5YzI2NTg1NjMwN2Y5ODIxYTY0ZjAxYWNlMTk3OWQ1MmJjNjJhPiAvUCAtMTAyOCAvUGVybXMgPDVhMjFjZTNmYjk0MzQ5MDI4MDAxY2RmMDIwNjUwNmNlPiAvUiA2IC9TdG1GIC9TdGRDRiAvU3RyRiAvU3RkQ0YgL1UgPDk3YWFiNTc2MWM5MmMxMmFlOTFkY2VmZjM1OGQ2NmRkNGE3ODYyN2I2ZGJmZWNjMmMyY2MzMzNhZjhmZjAwZGY5MmIzOGM4ZDk1YzFiOTNkYTE3MGEwYWMwMzg4YWFlZT4gL1VFIDw0MGU0ZTUwZmZhMTNjMzdiYjhjN2NjYWQ3YjdlM2NhMWJiZDc0ZjNiMjRmYTZiNzkwN2E0YzUxNTVkZWM4MjRhPiAvViA1ID4+CmVuZG9iagp4cmVmCjAgNwowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDEzMCAwMDAwMCBuIAowMDAwMDAwMTg5IDAwMDAwIG4gCjAwMDAwMDAzMTcgMDAwMDAgbiAKMDAwMDAwMDQ2OCAwMDAwMCBuIAowMDAwMDAwNTM4IDAwMDAwIG4gCnRyYWlsZXIgPDwgL1Jvb3QgMSAwIFIgL1NpemUgNyAvSUQgWzxkMWYxZmNlNzM4M2ZiYjUzMzJjNDRlYmQzYTMzY2NhYj48ZDFmMWZjZTczODNmYmI1MzMyYzQ0ZWJkM2EzM2NjYWI+XSAvRW5jcnlwdCA2IDAgUiA+PgpzdGFydHhyZWYKMTA4OAolJUVPRgo=";
/** JPX 200×100(좌 220,20,20 · 우 20,20,220)을 400×200pt@(97,500)에 배치한 1쪽 A4 — wasm 없이 nowasm 폴백으로 그려져야 한다. */
const JPX_B64 =
  "JVBERi0xLjcKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA1OTUgODQyXSAvUmVzb3VyY2VzIDw8IC9YT2JqZWN0IDw8IC9JbTEgNSAwIFIgPj4gPj4gL0NvbnRlbnRzIDQgMCBSID4+CmVuZG9iago0IDAgb2JqCjw8ICAvTGVuZ3RoIDMzID4+CnN0cmVhbQpxIDQwMCAwIDAgMjAwIDk3IDUwMCBjbSAvSW0xIERvIFEKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9YT2JqZWN0IC9TdWJ0eXBlIC9JbWFnZSAvV2lkdGggMjAwIC9IZWlnaHQgMTAwIC9GaWx0ZXIgL0pQWERlY29kZSAvTGVuZ3RoIDUwMiA+PgpzdHJlYW0KAAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAZAAAAMgAAwcHAAAAAAAPY29scgEAAAAAABAAAAGpanAyY/9P/1EALwAAAAAAyAAAAGQAAAAAAAAAAAAAAMgAAABkAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAAUEBAAB/1wAE0BASEhQSEhQSEhQSEhQSEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS40/5AACgAAAAABIgAB/5PfgNAmje4oJETuHGABVq3D5UxlTsdhn2utF33yH8+0OBFQVKzRwAMJCEkCMJCPz7RYEVAi0Ob22oCm45wkIJQAlw4x1tADK8faEgAhbbnM2E5di/uAx9oSACIZu8zYTl2L38faEgAw0aaSDGDlBn+Ax9ocADF9qH0bdqCai8AYL32/w+oSAE+XxRY8XgKItobQAAAAAALjw4DD6g8AUEPHFjxeA41d8AADLIAWx9ouAIPtr2ZCujjJ8iwDCQl/IZ6MLAfhW3X1gMfaLgCDwq7mQro4yfIsAwkJfzYijCwH4Vt1v+P2igCeijHP/3+RVv4AAAAGEg+xbwkJf4Dj9ooAnl8xT/9/kVb+AAAABhIPsW8JCX//2QplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDY0IDAwMDAwIG4gCjAwMDAwMDAxMjEgMDAwMDAgbiAKMDAwMDAwMDI1MSAwMDAwMCBuIAowMDAwMDAwMzM1IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKOTYxCiUlRU9GCg==";
/** '가나다 한글검색' 의 cp949 — Node 에는 cp949 인코더가 없어 하드코딩하고 TextDecoder('euc-kr')로 역검증한다. */
const UHC_HEX = "B0A1B3AAB4D920C7D1B1DBB0CBBBF6";
const KR_TEXT = "가나다 한글검색";

const bin = (s) => (Buffer.isBuffer(s) ? s : Buffer.from(s, "latin1"));

function stream(dict, data) {
  const d = bin(data);
  return Buffer.concat([bin(`<< ${dict} /Length ${d.length} >>\nstream\n`), d, bin("\nendstream")]);
}

/** 객체 배열(1번부터) → PDF 바이트. 오프셋은 **바이트** 길이(JS 문자열 length 는 비ASCII 에서 틀린다). */
function pdf(objs) {
  const parts = [bin("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")];
  let len = parts[0].length;
  const off = [];
  const push = (b) => {
    parts.push(b);
    len += b.length;
  };
  objs.forEach((o, i) => {
    off.push(len);
    push(bin(`${i + 1} 0 obj\n`));
    push(bin(o));
    push(bin("\nendobj\n"));
  });
  const xref = len;
  push(
    bin(
      `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
        off.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
        `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );
  const out = Buffer.concat(parts);
  const m = /startxref\n(\d+)\n%%EOF\n$/.exec(out.toString("latin1", out.length - 40));
  if (!m || out.toString("latin1", Number(m[1]), Number(m[1]) + 4) !== "xref") {
    throw new Error("픽스처 라이터: startxref 가 xref 를 가리키지 않는다");
  }
  off.forEach((o, i) => {
    const h = `${i + 1} 0 obj`;
    if (out.toString("latin1", o, o + h.length) !== h) throw new Error(`픽스처 라이터: ${i + 1}번 객체 오프셋 불일치`);
  });
  return out;
}

/** 스위트가 쓰는 픽스처 바이트 전부. M2 에서 62 를 흡수할 때 재사용한다. */
export function buildFixtures() {
  const helv = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const page = (contents, extra = "") =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contents} 0 R${extra} >>`;
  /** 쪽마다 한 줄씩 — 1 카탈로그 · 2 페이지 트리 · 3 공유 Helvetica · 4+2i 페이지 · 5+2i 내용. */
  const textPages = (texts, size) => {
    const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "", helv];
    const kids = [];
    texts.forEach((t, i) => {
      kids.push(`${4 + 2 * i} 0 R`);
      objs.push(page(5 + 2 * i));
      objs.push(stream("", `BT /F1 ${size} Tf 72 700 Td (${t}) Tj ET`));
    });
    objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${texts.length} >>`;
    return pdf(objs);
  };

  if (new TextDecoder("euc-kr").decode(Buffer.from(UHC_HEX, "hex")) !== KR_TEXT) {
    throw new Error("UHC hex 역검증 실패 — TextDecoder('euc-kr') 결과가 기대 문자열이 아니다");
  }
  // make_fixtures.py:128-138 과 같은 구조 — 비임베드 CID 폰트 + KSCms-UHC-H. cMap 없이는 유니코드로 못 푼다.
  const kr = pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    stream("", `BT /F1 36 Tf 72 700 Td <${UHC_HEX}> Tj ET`),
    "<< /Type /Font /Subtype /Type0 /BaseFont /HYGoThic-Medium /Encoding /KSCms-UHC-H /DescendantFonts [6 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYGoThic-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> /FontDescriptor 7 0 R /DW 1000 >>",
    "<< /Type /FontDescriptor /FontName /HYGoThic-Medium /Flags 6 /FontBBox [-6 -145 1003 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>",
  ]);

  // 1쪽 /Annots 는 위에서 아래로 https · ftp · javascript: URI · JavaScript 액션 · 내부 /Dest.
  const annot = (rect, body) => `<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] ${body} >>`;
  const links = pdf([
    "<< /Type /Catalog /Pages 2 0 R /Dests << /chap3 [8 0 R /XYZ 0 842 null] >> /Outlines 15 0 R >>",
    "<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>",
    helv,
    page(5, " /Annots [10 0 R 11 0 R 12 0 R 13 0 R 14 0 R]"),
    stream("", "BT /F1 24 Tf 72 780 Td (Link fixture page 1) Tj ET"),
    page(7),
    stream("", "BT /F1 24 Tf 72 780 Td (Links P2) Tj ET"),
    page(9),
    stream("", "BT /F1 24 Tf 72 780 Td (Links P3) Tj ET"),
    annot("72 700 272 730", "/A << /S /URI /URI (https://gpv-e2e.invalid/ext) >>"),
    annot("72 650 272 680", "/A << /S /URI /URI (ftp://gpv-e2e.invalid/f) >>"),
    annot("72 600 272 630", "/A << /S /URI /URI (javascript:window.__gpvJsFired=1) >>"),
    annot("72 550 272 580", "/A << /S /JavaScript /JS (window.__gpvJsFired=2) >>"),
    annot("72 500 272 530", "/Dest /chap3"),
    "<< /Type /Outlines /First 16 0 R /Last 17 0 R /Count 2 >>",
    "<< /Title (Chapter 1) /Parent 15 0 R /Next 17 0 R /Dest [4 0 R /Fit] >>",
    "<< /Title (Chapter 3) /Parent 15 0 R /Prev 16 0 R /Dest [8 0 R /Fit] >>",
  ]);

  const pages12 = (rev) => textPages(Array.from({ length: 12 }, (_, i) => `P${i + 1}-${rev}`), 36);
  const dd = pages12("REV-DD");
  // 반쯤 쓴 판 = 끝의 '%%EOF\n' 만 빠진 판. pdf.js 는 이 판을 **연다**(xref·trailer 온전) — 그래서 완결성 게이트가
  // 없는 구현은 C4-c 에서 곧바로 로드해 빨개진다. 앞 절반처럼 pdf.js 도 못 여는 판이면 게이트가 없어도
  // '로드 실패 → 현 화면 유지' 가 같은 결과를 내 헛단언이 된다(실측: 앞 절반은 InvalidPDFException).
  const EOF = "%%EOF\n";
  if (dd.toString("latin1", dd.length - EOF.length) !== EOF) throw new Error("픽스처 라이터: 끝이 '%%EOF\\n' 이 아니다");
  const ddHalf = dd.subarray(0, dd.length - EOF.length);
  if (ddHalf.subarray(-1024).includes("%%EOF")) throw new Error("반쯤 쓴 판 끝 1KB 에 %%EOF 가 있다 — C4-c 가 완결성 게이트를 못 잰다");

  return {
    pages12,
    ddHalf,
    ddRest: dd.subarray(ddHalf.length),
    pages200: textPages(Array.from({ length: 200 }, (_, i) => `Page ${i + 1}`), 24),
    kr,
    links,
    enc: Buffer.from(ENC_B64, "base64"),
    jpx: Buffer.from(JPX_B64, "base64"),
    // 헤더 뒤 쓰레기 1KB — %%EOF 가 없어 완결성 게이트가 3초 미룬 뒤 로드하고, pdf.js 가 실패해야 한다.
    bad: Buffer.concat([bin("%PDF-1.7\n"), Buffer.alloc(1024, "gpv-garbage ")]),
  };
}

// ── 페이지 쪽 헬퍼 ────────────────────────────────────────────────────────────────────────────────
// dev 는 byPath 핸들의 root 로, prod(훅 없음)는 data-pdf-view 속성으로 인스턴스 루트를 찾는다.
const HELPERS = `(() => {
  const A = (window.__gpv61 = {});
  A.handle = (p) => (window.__gpv && window.__gpv.pdf && window.__gpv.pdf.byPath(p)) || null;
  A.root = (p) => {
    const h = A.handle(p);
    if (h) return h.root;
    return Array.from(document.querySelectorAll('[data-pdf-view]')).find((e) => e.getAttribute('data-pdf-view') === p) || null;
  };
  A.state = (p) => { const h = A.handle(p); return h ? h.state() : null; };
  A.scroll = (p) => { const r = A.root(p); return r ? r.querySelector('[data-pdf-scroll]') : null; };
  A.page = (p, n) => { const r = A.root(p); return (r && r.querySelector('.pdfViewer .page[data-page-number="' + n + '"]')) || null; };
  A.canvas = (p, n) => { const pg = A.page(p, n); return (pg && pg.querySelector('.canvasWrapper canvas:not(.detailView)')) || null; };
  A.loaded = (p, n) => { const pg = A.page(p, n); return !!pg && pg.hasAttribute('data-loaded') && !!A.canvas(p, n); };
  A.text = (p, n) => { const pg = A.page(p, n); const t = pg && pg.querySelector('.textLayer'); return t ? t.textContent : ''; };
  A.spans = (p, n) => { const pg = A.page(p, n); return pg ? pg.querySelectorAll('.textLayer span').length : 0; };
  A.span = (p, n, sub) => { const pg = A.page(p, n); return (pg && Array.from(pg.querySelectorAll('.textLayer span')).find((s) => (s.textContent || '').includes(sub))) || null; };
  A.box = (el) => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, left: b.left, top: b.top, w: b.width, h: b.height }; };
  A.visible = (el) => !!el && el.getClientRects().length > 0;
  /** pt 사각형(좌상단 원점) 안의 캔버스 픽셀 수 — dark: r+g+b < 600 · nonWhite: 어느 채널이든 < 250. */
  A.region = (p, n, x0, x1, y0, y1) => {
    const c = A.canvas(p, n);
    if (!c || !c.width) return null;
    const sx = c.width / 595, sy = c.height / 842;
    const W = Math.max(1, Math.floor((x1 - x0) * sx)), H = Math.max(1, Math.floor((y1 - y0) * sy));
    const d = c.getContext('2d').getImageData(Math.floor(x0 * sx), Math.floor(y0 * sy), W, H).data;
    let dark = 0, nonWhite = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] + d[i + 1] + d[i + 2] < 600) dark++;
      if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) nonWhite++;
    }
    return { dark, nonWhite, px: W * H, cw: c.width, ch: c.height };
  };
  /** PDF 좌표(pt, 아래 원점) 한 점의 캔버스 RGB. */
  A.rgbPdf = (p, n, x, y) => {
    const c = A.canvas(p, n);
    if (!c || !c.width) return null;
    const d = c.getContext('2d').getImageData(Math.floor(x * c.width / 595), Math.floor((842 - y) * c.height / 842), 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  return true;
})()`;

/** 창이 실제로 로드한 ipc 모듈을 잡아 기록 스파이를 건다. getDiff·getWorktreeDiffs·fileStamp 는 통과 래핑,
 *  openExternalUrl 은 **대체**(실제 OS 브라우저를 띄우지 않는다). */
const SPY = `(async () => {
  if (window.__gpv61spy) return { url: window.__gpv61spy.url, missing: [] };
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  let url = names.find((n) => n.includes('/src/lib/ipc.ts'));
  if (!url) {
    // Resource Timing 버퍼(기본 250)가 먼저 차면 목록에 없다 — 진입 모듈이 지금 import 하는 URL(vite 의 ?t= 포함)을 읽는다.
    const src = await fetch('/src/main.tsx').then((x) => x.text()).catch(() => '');
    const hit = /["'](\\/src\\/lib\\/ipc\\.ts(?:\\?[^"']*)?)["']/.exec(src);
    url = hit ? hit[1] : '/src/lib/ipc.ts';
  }
  const m = await import(url);
  const keys = ['getDiff', 'getWorktreeDiffs', 'fileStamp', 'openExternalUrl', 'findDefinition'];
  const missing = keys.filter((k) => typeof m.ipc[k] !== 'function');
  if (missing.length) return { url, missing };
  const s = { url, m, orig: {}, diff: [], wt: [], stamps: 0, opened: [], defs: [] };
  for (const k of keys) s.orig[k] = m.ipc[k];
  m.ipc.findDefinition = (pid, symbol, ext, lane) => { s.defs.push({ symbol, ext }); return s.orig.findDefinition(pid, symbol, ext, lane); };
  m.ipc.getDiff = (pid, t) => { s.diff.push(t ? t.path : null); return s.orig.getDiff(pid, t); };
  m.ipc.getWorktreeDiffs = (pid, paths) => { for (const x of paths || []) s.wt.push(x); return s.orig.getWorktreeDiffs(pid, paths); };
  m.ipc.fileStamp = (pid, rel) => { s.stamps++; return s.orig.fileStamp(pid, rel); };
  m.ipc.openExternalUrl = (u) => { s.opened.push(u); return Promise.resolve(); };
  window.__gpv61spy = s;
  return { url, missing };
})()`;
const UNSPY = `(() => {
  const s = window.__gpv61spy;
  if (!s) return false;
  for (const k of Object.keys(s.orig)) s.m.ipc[k] = s.orig[k];
  delete window.__gpv61spy;
  return true;
})()`;

/** 문서 창의 링크 섹션(1쪽)을 화면 위→아래로. 기대 순서: https · ftp · javascript: URI · JS 액션 · 내부. */
const LINK_SECTIONS = `(() => {
  const A = window.__gpv61;
  const pg = A.page(${J(P.links)}, 1);
  if (!pg) return null;
  return Array.from(pg.querySelectorAll('.annotationLayer section.linkAnnotation'))
    .map((s) => {
      const a = s.querySelector('a');
      return Object.assign(A.box(s), { id: s.getAttribute('data-annotation-id'), anchors: s.querySelectorAll('a').length, href: a ? a.getAttribute('href') : null });
    })
    .sort((u, v) => u.top - v.top);
})()`;

/** 앱 WebView2 CSP 수집 — 먼저 eval 양성 대조 1건을 만들고 buffered ReportingObserver 로 500ms 모은다. */
const CSP_PROBE = `(async () => {
  // CDP Runtime.evaluate 는 allowUnsafeEvalBlockedByCSP(기본 true)로 **평가의 동기 구간**에서 eval 을 CSP 로부터
  // 풀어 준다 — 거기서 eval 하면 CSP 가 걸린 prod 창에서도 안 막혀 양성 대조가 늘 skip 이 된다. 태스크를 넘긴 뒤 한다.
  await new Promise((res) => setTimeout(res, 0));
  let evalThrew = false, evalName = null;
  try { eval('1'); } catch (e) { evalThrew = true; evalName = e && e.name; }
  if (typeof ReportingObserver !== 'function') return { unsupported: true, evalThrew, evalName, reports: [] };
  const got = [];
  const ro = new ReportingObserver((rs) => { for (const x of rs) got.push(x); }, { types: ['csp-violation'], buffered: true });
  ro.observe();
  await new Promise((res) => setTimeout(res, 500));
  for (const x of ro.takeRecords()) got.push(x);
  ro.disconnect();
  return {
    unsupported: false, evalThrew, evalName,
    reports: got.map((x) => ({ directive: x.body.effectiveDirective, blocked: x.body.blockedURL, source: x.body.sourceFile, line: x.body.lineNumber })),
  };
})()`;

/** 뷰어 패널 원복용 스냅샷(51 스위트와 같은 필드). */
const VIEW_SNAP = `(() => {
  const s = window.__gpv.ui.getState();
  return JSON.stringify({
    layout: s.viewerLayout, active: s.viewerActivePaneId, byPane: s.viewerByPane,
    max: s.viewerMaximizedPaneId, diff: s.selectedDiff, repo: s.selectedDiffRepoId,
    project: s.selectedProjectId, agg: s.aggregateOpen, report: s.reportOpen,
  });
})()`;

// ── Node 쪽 헬퍼 ──────────────────────────────────────────────────────────────────────────────────
async function send(c, method, params) {
  const res = await c._send(method, params);
  if (res.error) throw new Error(`${method}: ${res.error.message}`);
  return res.result;
}

const KEYS = {
  f: { key: "f", code: "KeyF", windowsVirtualKeyCode: 70 },
  c: { key: "c", code: "KeyC", windowsVirtualKeyCode: 67 },
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  "+": { key: "+", code: "Equal", windowsVirtualKeyCode: 187 }, // Shift+= (modifiers 8)
  "-": { key: "-", code: "Minus", windowsVirtualKeyCode: 189 },
  0: { key: "0", code: "Digit0", windowsVirtualKeyCode: 48 },
};

/** 실제 키 입력 — rawKeyDown(+ Enter 는 char '\r' — 폼 암묵 제출·input Enter 가 이 경로다) + keyUp. */
async function press(c, name, modifiers = 0) {
  const { text, ...k } = KEYS[name];
  const base = { ...k, nativeVirtualKeyCode: k.windowsVirtualKeyCode, modifiers };
  await send(c, "Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" });
  if (text && !modifiers) await send(c, "Input.dispatchKeyEvent", { ...base, type: "char", text, unmodifiedText: text });
  await send(c, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

const BUTTONS = { left: 1, right: 2, middle: 4 };
async function clickAt(c, x, y, button = "left") {
  await send(c, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await send(c, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: BUTTONS[button], clickCount: 1 });
  await send(c, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1 });
}
const wheelAt = (c, x, y, deltaY, modifiers = 0) =>
  send(c, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers });

const poll = async (fn, ok, tries = 20, ms = 250) => {
  let v;
  for (let i = 0; i < tries; i++) {
    v = await fn().catch(() => null);
    if (ok(v)) return v;
    await sleep(ms);
  }
  return v;
};
/** "t0 부터 limit ms 안에" 류 단언 — 조건이 서면 즉시, 아니면 시한까지. { ok, v, ms(t0 기준) }. */
const until = async (fn, ok, t0, limit, ms = 100) => {
  for (;;) {
    const v = await fn().catch(() => null);
    const el = Date.now() - t0;
    if (ok(v)) return { ok: true, v, ms: el };
    if (el >= limit) return { ok: false, v, ms: el };
    await sleep(ms);
  }
};

/** 페이지 쪽 헬퍼 A 를 받는 함수 본문을 평가한다(본문은 return 으로 값을 낸다). */
const evalA = (c, body, opts) => c.eval(`(async () => { const A = window.__gpv61; ${body} })()`, opts);
const stateOf = (c, p) => evalA(c, `return A.state(${J(p)});`);
const readyOf = (c, p) =>
  evalA(c, `const s = A.state(${J(p)}); return s ? { status: s.status, loaded: A.loaded(${J(p)}, 1), s } : null;`);
const waitReady = (c, p, tries = 120) => poll(() => readyOf(c, p), (v) => v?.status === "ready" && v.loaded, tries, 250);
const near = (a, b, tol = 24) => Array.isArray(a) && a.length === 3 && a.every((v, i) => Math.abs(v - b[i]) <= tol);

function grepFile(file, token) {
  try {
    return readFileSync(file, "utf8").includes(token);
  } catch {
    return null;
  }
}

async function pageTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) });
    return (await res.json()).filter((t) => t.type === "page").length;
  } catch {
    return null;
  }
}

/** 강제 GC 뒤 힙의 캔버스 [개수, Σ면적] — 요소 질의 + 컨텍스트로만 붙잡힌 캔버스 합집합(62 와 같은 계측). */
async function heapCanvases(c) {
  await send(c, "HeapProfiler.collectGarbage");
  const protoEl = await send(c, "Runtime.evaluate", { expression: "HTMLCanvasElement.prototype", objectGroup: GROUP });
  const protoCtx = await send(c, "Runtime.evaluate", { expression: "CanvasRenderingContext2D.prototype", objectGroup: GROUP });
  try {
    const qe = await send(c, "Runtime.queryObjects", { prototypeObjectId: protoEl.result.objectId, objectGroup: GROUP });
    const qc = await send(c, "Runtime.queryObjects", { prototypeObjectId: protoCtx.result.objectId, objectGroup: GROUP });
    const v = await send(c, "Runtime.callFunctionOn", {
      objectId: qe.objects.objectId,
      functionDeclaration:
        "function(ctxs){const s=new Set(this);for(const x of ctxs)s.add(x.canvas);let a=0;for(const k of s)a+=k.width*k.height;return [s.size,a]}",
      arguments: [{ objectId: qc.objects.objectId }],
      returnByValue: true,
    });
    const [count, area] = v.result.value;
    return { count, area };
  } finally {
    await send(c, "Runtime.releaseObjectGroup", { objectGroup: GROUP });
  }
}

export async function run({ cdp, report: r, fix, port }) {
  const cdpPort = port ?? cdp.cdpPort ?? 29222;
  // 훅 노출은 폴링한다 — 다른 세션의 저장으로 vite 가 방금 리로드했으면 __gpv 대입 전일 수 있다(51 과 같은 이유).
  const dev = await poll(() => cdp.eval(`!!(window.__gpv && window.__gpv.ui)`), (v) => v === true, 16, 250);
  if (dev === true) {
    r.skip(
      "(C7) 앱 WebView2 CSP 위반 0 + JPX 픽셀 + DEV 훅 누출 0",
      "dev 모드 — dev 창은 devUrl 을 직접 로드해 CSP 가 없다(위반 0 이 항상 참). prod 모드(스위트 머리 주석)에서만 판정한다",
    );
    await devMode({ cdp, r, fix, cdpPort });
  } else {
    await prodMode({ cdp, r, fix, cdpPort });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// dev 모드 — C1~C6 + 부가
// ═══════════════════════════════════════════════════════════════════════════════════════════════
async function devMode({ cdp, r, fix, cdpPort }) {
  const pid = fix.projectId;
  const PANE = "gpv61-pane";
  const CONTROL = `control-${Date.now()}.txt`;
  const put = (rel, buf) => {
    const f = join(fix.repo, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, buf);
  };
  const open = (path, mode = "file") =>
    cdp.eval(
      `window.__gpv.ui.getState().selectDiff(${J(mode === "commit" ? { mode, sha: fix.headSha, path } : { mode, path })})`,
    );
  const gone = (p) => poll(() => stateOf(cdp, p), (v) => v === null, 40, 100);
  const setView = (paneId) =>
    cdp.eval(`window.__gpv.ui.setState({
      viewerLayout: { kind: 'leaf', paneId: ${J(paneId)} },
      viewerActivePaneId: ${J(paneId)},
      viewerByPane: {}, viewerMaximizedPaneId: null,
      selectedDiff: null, selectedDiffRepoId: null,
    })`);

  // 연결된 dev 앱이 **이 워크트리**를 서빙하는가 — 다른 워크트리의 dev 앱에 붙으면 이하가 전부 엉뚱하게 빨개진다.
  const served = await cdp
    .eval(
      `fetch('/src/lib/pdf/pdfjs.ts').then((x) => ({ ok: x.ok, type: x.headers.get('content-type') || '' })).catch((e) => ({ ok: false, type: String(e) }))`,
    )
    .catch((e) => ({ ok: false, type: e.message }));
  if (
    !r.check(
      "dev 앱이 M1 워크트리를 서빙한다(/src/lib/pdf/pdfjs.ts 가 HTML 폴백이 아닌 JS 로 온다)",
      served?.ok === true && !/text\/html/.test(served.type),
      `${J(served)} — HTML 이면 SPA 폴백(파일 없음) = 다른 워크트리의 dev 앱이다`,
    )
  )
    return;

  let F;
  try {
    F = buildFixtures();
  } catch (e) {
    r.check("픽스처 생성(xref 바이트 오프셋 자기검증 · UHC 역검증)", false, e.message);
    return;
  }

  const t0 = await cdp.eval(`performance.timeOrigin`);
  const snap = await cdp.eval(VIEW_SNAP);
  const origTab = await cdp.eval(
    `(() => { const t = window.__gpv.terminals.getState().activeTab; return t[${J(pid)}] || null; })()`,
  );
  const docLabels = [];

  try {
    // ── 셋업: 픽스처를 선택하고 Viewer 탭을 화면에 띄운다(51 과 같은 순서) ───────────────────
    await cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`).catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`).catch(() => {});
    await cdp
      .eval(`(() => { const s = window.__gpv.ui.getState(); if (s.reportOpen) s.toggleReport(); return true; })()`)
      .catch(() => {});
    await sleep(300);
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(pid)})`);
    const picked = await poll(
      () => cdp.eval(`window.__gpv.ui.getState().selectedProjectId`),
      (v) => v === pid,
      16,
      250,
    );
    if (!r.check("셋업: 픽스처 프로젝트 선택", picked === pid, String(picked))) return;
    await cdp.eval(`window.__gpv.terminals.getState().setActiveTab(${J(pid)}, 'viewer')`);
    await setView(PANE);
    if (!r.check("페이지 헬퍼 설치", (await cdp.eval(HELPERS)) === true)) return;

    // C1-1: ipc 스파이 먼저 — 파일을 쓰기 전에 걸어야 첫 프리페치 배치를 놓치지 않는다.
    const spy = await cdp.eval(SPY).catch((e) => ({ err: e.message }));
    if (
      !r.check(
        "ipc 스파이 설치 — 창이 실제로 로드한 /src/lib/ipc.ts 의 getDiff·getWorktreeDiffs·fileStamp·openExternalUrl",
        !!spy?.url && Array.isArray(spy.missing) && spy.missing.length === 0,
        J(spy),
      )
    )
      return;
    // 스파이는 opener 를 대체한다 — 실제 경로(ipc.openExternalUrl → invoke 'open_external_url' → generate_handler
    // 등록 → Rust)는 원본으로 한 번 구동한다. 파싱 불가 URL 이라 Url::parse 에서 거절되고 OS 런처는 뜨지 않는다.
    // 커맨드 이름·인자 키·등록이 틀어지면 code 가 INVALID_URL 이 아니다('Command … not found' 등).
    const extBad = await cdp.eval(
      `window.__gpv61spy.orig.openExternalUrl('gpv e2e not a url').then(() => ({ ok: true }), (e) => ({ ok: false, code: e && e.code, message: e && e.message }))`,
    );
    r.check(
      "(C3 경로) 원본 ipc.openExternalUrl 이 Rust open_external_url 까지 간다 — 파싱 불가 URL 은 code INVALID_URL 로 거절",
      extBad?.ok === false && extBad.code === "INVALID_URL",
      J(extBad),
    );
    // 메인 창 안전망 — 가로채기가 고장 나면 메인 웹뷰가 .invalid 로 이동해 러너가 통째로 죽는다. 기록은
    // preventDefault **전에** 하므로 단언(defaultPrevented)은 안전망에 가려지지 않는다.
    await cdp.eval(`(() => {
      const m = (window.__gpv61m = window.__gpv61m || {});
      m.clicks = []; m.keys = 0; m.copies = 0;
      if (!m.onClick) {
        m.onClick = (e) => {
          const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
          if (!a) return;
          m.clicks.push({ type: e.type, defaultPrevented: e.defaultPrevented, href: a.getAttribute('href') });
          if (!e.defaultPrevented) e.preventDefault();
        };
        m.onKey = (e) => { if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) m.keys++; };
        // copy 는 캡처로 센다 — pdf.js textLayer 리스너가 stopPropagation 해 버블에는 안 온다.
        m.onCopy = () => { m.copies++; };
        window.addEventListener('click', m.onClick);
        window.addEventListener('auxclick', m.onClick);
        window.addEventListener('keydown', m.onKey);
        window.addEventListener('copy', m.onCopy, true);
      }
      return true;
    })()`);

    // C1-2: 미추적 파일 — PDF·형제 txt 를 먼저, 워처가 보는 control txt 를 마지막에(그 이벤트의 상태 갱신이
    // build/ 아래 두 파일까지 목록에 싣는다). 나머지 픽스처도 여기서 쓴다 — bad.pdf 는 mtime 이 3초 넘게 묵어야 한다.
    put(P.p12, F.pages12("REV-A"));
    put(P.p12sib, "sibling of pages12.pdf\n");
    put(P.p200, F.pages200);
    put(P.kr, F.kr);
    put(P.krNo, F.kr);
    put(P.links, F.links);
    put(P.enc, F.enc);
    put(P.encCancel, F.enc);
    put(P.jpx, F.jpx);
    put(P.bad, F.bad);
    put(CONTROL, "control\n");

    // ── C1 ─────────────────────────────────────────────────────────────────────────────────────
    // 대조①: txt 는 get_file_diff 를 반드시 부른다 — 안 보이면 스파이가 queries 의 ipc 에 안 걸린 것이다.
    await open(CONTROL);
    const ctl = await poll(
      () => cdp.eval(`window.__gpv61spy.diff.slice()`),
      (v) => Array.isArray(v) && v.includes(CONTROL),
      40,
      250,
    );
    const spyOk = r.check(
      "(C1 대조①) txt 를 열면 스파이가 get_file_diff 를 본다 — 스파이가 queries 의 ipc 객체에 걸렸다는 증거",
      Array.isArray(ctl) && ctl.includes(CONTROL),
      J(ctl),
    );

    await open(P.p12);
    const rd = await waitReady(cdp, P.p12);
    if (
      !r.check(
        "(C1) 레포 안 PDF → status ready · 공유 워커가 진짜 Worker(workerKind) · 1쪽 캔버스 data-loaded",
        rd?.status === "ready" && rd.loaded && rd.s.workerKind === "worker",
        J({ status: rd?.status, loaded: rd?.loaded, workerKind: rd?.s?.workerKind, error: rd?.s?.error }),
      )
    )
      return;
    const workerGlobalInBundle = grepFile(
      join(ROOT, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
      "globalThis.pdfjsWorker",
    );
    const pw = await cdp.eval(`typeof globalThis.pdfjsWorker`);
    r.check(
      "(C1) 워커 모듈이 페이지 스레드에서 평가되지 않았다(globalThis.pdfjsWorker 없음 = fake worker 폴백 아님) · 반증: 워커 번들이 실제로 그 전역을 만든다",
      pw === "undefined" && workerGlobalInBundle === true,
      `typeof=${pw} · pdf.worker.min.mjs 에 'globalThis.pdfjsWorker' ${workerGlobalInBundle}`,
    );

    // data-loaded 는 그리기 **시작** 시점에 붙는다(pdf_viewer.mjs PDFPageView.draw) — 두 영역을 함께 폴링한다.
    // 캔버스가 alpha:false 라 그리기 전 빈 캔버스는 불투명 검정일 수 있다: 잉크만 보면 헛통과, 여백 흰색이 그걸 떨군다.
    const regions = await poll(
      () =>
        evalA(
          cdp,
          `return { ink: A.region(${J(P.p12)}, 1, 72, 400, 130, 160), margin: A.region(${J(P.p12)}, 1, 520, 580, 780, 830) };`,
        ),
      (v) => v?.ink?.dark > 0 && v.margin?.px > 0 && v.margin.nonWhite === 0,
      40,
      125,
    );
    const ink = regions?.ink;
    const margin = regions?.margin;
    r.check(
      "(C1) 1쪽 캔버스 텍스트 영역(72~400pt × 위에서 130~160pt)에 잉크 > 0 · 반증: 같은 좌표계의 여백(520~580 × 780~830)은 전부 흰색",
      ink?.dark > 0 && margin?.px > 0 && margin.nonWhite === 0,
      `잉크 ${J(ink)} · 여백 ${J(margin)}`,
    );

    await sleep(1000); // useDiff 가 켜져 있었다면 마운트 직후 이미 불렀다 — 늦은 호출까지 한 번 더 기다린다
    const pane = await cdp.eval(`(() => {
      const el = document.querySelector('[data-viewer-pane]');
      return el ? { pdf: !!el.querySelector('[data-pdf-view]'), monaco: el.querySelectorAll('.monaco-editor').length, binary: (el.textContent || '').includes('바이너리 파일') } : null;
    })()`);
    const diffPdf = await cdp.eval(`window.__gpv61spy.diff.filter((x) => /\\.pdf$/i.test(x || ''))`);
    r.check(
      "(C1) PDF 를 열어도 get_file_diff 0회 · 패널에 Monaco 0 · '바이너리 파일' 0 (대조① 유효)",
      spyOk && Array.isArray(diffPdf) && diffPdf.length === 0 && pane?.pdf === true && pane.monaco === 0 && !pane.binary,
      `getDiff pdf=${J(diffPdf)} · 패널 ${J(pane)} · 대조①=${spyOk}`,
    );
    const qcState = await cdp.eval(`(() => {
      const q = window.__gpv.queryClient.getQueryCache().find({ queryKey: ['diff', ${J(pid)}, ${J(`f:${P.p12}`)}] });
      return q ? { observers: q.getObserversCount(), dataUpdateCount: q.state.dataUpdateCount, errorUpdateCount: q.state.errorUpdateCount, fetchStatus: q.state.fetchStatus } : null;
    })()`);
    r.check(
      "(C1) 쿼리 캐시 ['diff',pid,'f:<pdf>'] — 관찰자 ≥1(키가 맞다는 반증) · dataUpdateCount 0 · fetchStatus idle",
      qcState?.observers >= 1 && qcState.dataUpdateCount === 0 && qcState.fetchStatus === "idle",
      J(qcState),
    );

    // 프리페치 절반: 형제가 기록된 뒤에야 판정한다(30개 상한·지연에 PDF 가 우연히 빠진 헛통과 방지).
    const wt = await poll(
      () => cdp.eval(`window.__gpv61spy.wt.slice()`),
      (v) => Array.isArray(v) && v.includes(P.p12sib),
      32,
      250,
    );
    if (Array.isArray(wt) && wt.includes(P.p12sib)) {
      const wtPdf = wt.filter((x) => /\.pdf$/i.test(x || ""));
      r.check(
        "(C1) 변경 프리페치(get_file_diffs)에 PDF 경로 0 — 바로 뒤에 정렬되는 형제 pages12.txt 가 기록된 뒤 판정",
        wtPdf.length === 0,
        `pdf=${J(wtPdf)} · 기록 ${wt.length}건`,
      );
    } else {
      r.skip(
        "(C1) 변경 프리페치(get_file_diffs)에 PDF 경로 0",
        `관측 불가 — 8초 안에 형제 ${P.p12sib} 가 get_file_diffs 기록에 안 나타났다(프리페치 30개 상한·상태 갱신 지연) · 기록=${J(wt)}`,
      );
    }

    // 박스 정합: Tailwind preflight 의 border-box 가 .page 에 남으면 캔버스(100%)만 테두리만큼 줄어든다.
    // 반증 문턱은 **실측 좌우 테두리 합**에 묶는다 — pdf.css 의 1px 테두리는 DPR 1.5 에서 1 디바이스 px(0.667 CSS px)로
    // 스냅돼 border-box 차가 1.33px 뿐이다. 고정 1.5px 문턱은 DPR 을 모른다. 테두리 합이 0 이면 반증이 성립하지 않는다.
    const BOX = `(() => {
      const A = window.__gpv61;
      const pg = A.page(${J(P.p12)}, 1);
      const t = pg && pg.querySelector('.textLayer');
      const c = A.canvas(${J(P.p12)}, 1);
      if (!t || !c) return null;
      const cs = getComputedStyle(pg);
      return { d: Math.abs(t.getBoundingClientRect().width - c.getBoundingClientRect().width), bw: parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth), dpr: devicePixelRatio };
    })()`;
    const box0 = await cdp.eval(BOX);
    await evalA(cdp, `A.page(${J(P.p12)}, 1).style.boxSizing = 'border-box'; return true;`);
    const boxB = await cdp.eval(BOX);
    await evalA(cdp, `A.page(${J(P.p12)}, 1).style.boxSizing = ''; return true;`);
    const box1 = await cdp.eval(BOX);
    r.check(
      "(C1 부가) 1쪽 textLayer 폭 = canvas 폭(차 < 0.5px) · 반증: page 를 border-box 로 바꾸면 차 ≥ 실측 좌우 테두리 합 × 0.9(합 ≥ 0.5px) · 원복 후 다시 < 0.5",
      box0 !== null && box0.d < 0.5 && boxB?.bw >= 0.5 && boxB.d >= 0.9 * boxB.bw && box1?.d < 0.5,
      `차 ${J(box0)} → border-box ${J(boxB)} → 원복 ${J(box1)}`,
    );
    const css = await cdp.eval(
      `(() => { const s = getComputedStyle(document.documentElement); return { scheme: s.colorScheme, border: s.getPropertyValue('--page-border').trim() }; })()`,
    );
    r.check(
      "(C1 부가) pdf_viewer.css 가 로드됐는데(:root --page-border = '9px solid transparent') 앱 전역 color-scheme 은 normal 로 남는다",
      css?.border === "9px solid transparent" && css.scheme === "normal",
      J(css),
    );

    // ── 복사 키: DOM 선택이 PDF 안에 있으면 Ctrl+C 가 window 버블(터미널 복사 폴백)까지 가지 않는다 ─────
    // 관측 수단 대조 — 뷰어 밖 평범한 텍스트 선택에서 CDP Ctrl+C 가 copy 이벤트를 만드는가. 안 만들면 아래 copy 절반은
    // "keydown 에서 preventDefault 해 네이티브 복사가 죽었다" 와 구별이 안 되므로 skip 한다.
    await cdp.eval(`(() => {
      const d = document.createElement('div');
      d.id = 'gpv61-copy-ctl'; d.tabIndex = 0; d.textContent = 'gpv61 copy control';
      d.style.cssText = 'position:fixed;left:0;bottom:0;z-index:2147483647;user-select:text;background:#fff;color:#000';
      document.body.appendChild(d);
      const rg = document.createRange(); rg.selectNodeContents(d);
      const s = document.getSelection(); s.removeAllRanges(); s.addRange(rg);
      d.focus({ preventScroll: true });
      window.__gpv61m.copies = 0;
      return true;
    })()`);
    await press(cdp, "c", MOD);
    await sleep(150);
    const copiesCtl = await cdp.eval(
      `(() => { const n = window.__gpv61m.copies; document.getElementById('gpv61-copy-ctl')?.remove(); document.getSelection().removeAllRanges(); return n; })()`,
    );
    const SELECT_PDF = `const sp = A.span(${J(P.p12)}, 1, 'REV-A');
       if (!sp) return null;
       const rg = document.createRange(); rg.selectNodeContents(sp);
       const s = document.getSelection(); s.removeAllRanges(); s.addRange(rg);
       A.scroll(${J(P.p12)}).focus({ preventScroll: true });
       window.__gpv61m.keys = 0; window.__gpv61m.copies = 0;`;
    const selSet = await evalA(
      cdp,
      `${SELECT_PDF}
       return { text: s.toString(), collapsed: s.isCollapsed, focused: document.activeElement === A.scroll(${J(P.p12)}) };`,
    );
    await press(cdp, "c", MOD);
    await sleep(150);
    const keysSel = await cdp.eval(`window.__gpv61m.keys`);
    const copiesSel = await cdp.eval(`window.__gpv61m.copies`);
    // copy 반증 — 같은 선택·포커스에서 캡처 keydown 이 preventDefault 하면 copy 는 0 이다. "선택 없음" 은 반증이 못 된다:
    // Chromium 은 선택이 비어도 Ctrl+C 에 네이티브 copy 를 보낸다(r2 실측 · JS 스택 없음). pdHits 1 = 주입이 실제로 그 키를 봤다.
    await evalA(
      cdp,
      `${SELECT_PDF}
       const m = window.__gpv61m; m.pdHits = 0;
       m.pdKey = (e) => { if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) { m.pdHits++; e.preventDefault(); } };
       window.addEventListener('keydown', m.pdKey, true);
       return true;`,
    );
    let pdCopy;
    try {
      await press(cdp, "c", MOD);
      await sleep(150);
    } finally {
      pdCopy = await cdp.eval(
        `(() => { const m = window.__gpv61m; window.removeEventListener('keydown', m.pdKey, true); delete m.pdKey; return { hits: m.pdHits, copies: m.copies, collapsed: document.getSelection().isCollapsed }; })()`,
      );
    }
    await evalA(
      cdp,
      `document.getSelection().removeAllRanges(); A.scroll(${J(P.p12)}).focus({ preventScroll: true }); window.__gpv61m.keys = 0; window.__gpv61m.copies = 0; return true;`,
    );
    await press(cdp, "c", MOD);
    await sleep(150);
    const keysNoSel = await cdp.eval(`window.__gpv61m.keys`);
    r.check(
      "(복사) PDF 텍스트 레이어에 선택이 있으면 Ctrl+C 가 window 버블(터미널 복사 폴백)에 닿지 않는다 · 반증: removeAllRanges 후 같은 키는 +1",
      selSet?.collapsed === false && selSet.focused && keysSel === 0 && keysNoSel === 1,
      `선택 ${J(selSet)} · 선택 있음 +${keysSel} · 선택 없음 +${keysNoSel}`,
    );
    if (copiesCtl !== 1) {
      r.skip(
        "(복사) PDF 텍스트 선택 Ctrl+C 가 네이티브 copy 를 진행한다",
        `관측 불가 — 뷰어 밖 대조 선택에서 CDP Ctrl+C 가 copy 이벤트를 ${copiesCtl}번 만들었다(1 기대 · 터미널 선택이 남아 폴백이 막았을 수 있다)`,
      );
    } else {
      r.check(
        "(복사) PDF 텍스트 선택 Ctrl+C → copy 이벤트 1회(keydown 에서 preventDefault 하지 않아 네이티브 복사가 진행) · 반증: 같은 선택에 캡처 keydown preventDefault 를 주입하면 copy 0(주입이 키를 1회 봤다) · 대조: 뷰어 밖 선택도 1",
        copiesSel === 1 && pdCopy?.hits === 1 && pdCopy.copies === 0 && pdCopy.collapsed === false,
        `PDF 선택 ${copiesSel} · 주입 preventDefault ${J(pdCopy)} · 대조 ${copiesCtl}`,
      );
    }

    // pdf.js '전체 복사' 가로채기 없음 — 선택이 숨은 #hiddenCopyElement 를 품으면 pdf.js document copy 리스너가 네이티브
    // 복사를 막고 PDF 전문을 clipboard.writeText 했다. 앱 전체 선택(마크다운 패널의 Ctrl+A 등)이 정확히 그 모양이다.
    // 합성 copy 로 리스너를 직접 구동한다(클립보드는 스텁). 하네스 반증: 같은 합성 copy 가 PDF span 선택에서는
    // pdf.js textLayer 리스너에 닿아 막힌다 — 합성 이벤트가 pdf.js 리스너까지 간다는 증거.
    if (process.platform === "darwin") {
      r.skip("(복사) 앱 전체 선택의 copy 를 pdf.js 전체 복사가 가로채지 않는다", "macOS 는 캡처 단계 복사 인터셉터가 pdf.js 리스너 앞에서 전파를 끊는다");
    } else {
      const hijack = await evalA(
        cdp,
        `const cb = navigator.clipboard; const calls = [];
         const own = Object.getOwnPropertyDescriptor(cb, 'writeText');
         cb.writeText = (t) => { calls.push(String(t).slice(0, 40)); return Promise.resolve(); };
         const s = document.getSelection();
         try {
           const sp = A.span(${J(P.p12)}, 1, 'REV-A');
           if (!sp) return null;
           const rg = document.createRange(); rg.selectNodeContents(sp); s.removeAllRanges(); s.addRange(rg);
           const e1 = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
           sp.dispatchEvent(e1);
           s.removeAllRanges(); s.selectAllChildren(document.body);
           const e2 = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
           document.body.dispatchEvent(e2);
           await new Promise((res) => setTimeout(res, 1500)); // 결함이면 getAllText 뒤 writeText 가 온다
           return { harness: e1.defaultPrevented, allPrevented: e2.defaultPrevented, writeText: calls, hidden: A.root(${J(P.p12)}).querySelectorAll('#hiddenCopyElement').length };
         } finally {
           if (own) Object.defineProperty(cb, 'writeText', own); else delete cb.writeText;
           s.removeAllRanges();
         }`,
      );
      r.check(
        "(복사) 앱 전체 선택(selectAllChildren(body))의 copy 를 pdf.js 전체 복사가 가로채지 않는다 — defaultPrevented 아님 · clipboard.writeText 0회 · 반증(하네스): PDF span 선택의 같은 합성 copy 는 textLayer 리스너가 막는다",
        hijack?.harness === true && hijack.allPrevented === false && hijack.writeText.length === 0,
        J(hijack),
      );
    }

    // ── 부가: 줌·맞춤·키 스코프 ──────────────────────────────────────────────────────────────────
    await zoomBlock({ cdp, r });

    // ── C4 · C4-b · C4-c — 외부 재기록 ──────────────────────────────────────────────────────────
    await reloadBlock({ cdp, r, fix, pid, put, F, t0, open, gone, CONTROL });

    // ── 부가: 자기 뷰어 파일(PDF)은 직전 파일의 diff placeholder 를 헤더 배지·정의 예열에 쓰지 않는다 ──────────
    await placeholderBlock({ cdp, r, pid, put, open, CONTROL });

    // ── C2 — 비임베드 한글 검색 · 자산 서빙 ────────────────────────────────────────────────────────
    await searchBlock({ cdp, r, open });

    // ── 부가: commit 모드 안내 배너 ────────────────────────────────────────────────────────────────
    await open(P.kr);
    const krFile = await waitReady(cdp, P.kr, 80);
    const noteFile = await cdp.eval(`document.querySelectorAll('[data-viewer-pane] [data-pdf-worktree-note]').length`);
    await open(P.kr, "commit");
    const noteCommit = await poll(
      () =>
        cdp.eval(`(() => {
          const n = document.querySelector('[data-viewer-pane] [data-pdf-worktree-note]');
          return n ? (n.textContent || '').trim() : null;
        })()`),
      (v) => typeof v === "string",
      40,
      250,
    );
    r.check(
      "(부가) commit 모드로 연 PDF 는 '작업 트리의 현재 파일' 배너를 보인다 · 반증: file 모드에서는 배너 0",
      krFile?.status === "ready" && noteFile === 0 && typeof noteCommit === "string" && noteCommit.includes("작업 트리"),
      `file 모드 ready=${krFile?.status} 배너 ${noteFile}개 · commit 모드 배너 ${J(noteCommit)}`,
    );

    // ── 부가: Git 모달 안 찾기 Esc — 찾기만 닫고 모달은 남는다 ─────────────────────────────────────
    await open(CONTROL);
    await gone(P.kr);
    await gitModalBlock({ cdp, r, pid });

    // ── C5 — 암호 · 취소 · 실패 task 누수 · 파일 없음 ─────────────────────────────────────────────
    await passwordBlock({ cdp, r, fix, open, t0, F });

    // ── C6 — 200쪽 캔버스 한계 ────────────────────────────────────────────────────────────────────
    await open(CONTROL);
    await sleep(800);
    const heap0 = await heapCanvases(cdp).catch((e) => ({ err: e.message }));
    await open(P.p200);
    const r200 = await waitReady(cdp, P.p200);
    if (!r.check("(C6) pages200.pdf 준비(사이드바 닫힘 · 초기 auto)", r200?.status === "ready", J(r200?.s?.error ?? r200?.status)))
      return;
    const c6 = await evalA(
      cdp,
      `const p = ${J(P.p200)}, h = A.handle(p);
       if (!h) return { err: 'no-handle' };
       const v = h.viewer();
       const wait = (ms) => new Promise((res) => setTimeout(res, ms));
       const steps = []; for (let n = 1; n <= 199; n += 3) steps.push(n); steps.push(200);
       let timeouts = 0; const violations = [], phrase = []; let maxVisible = 0;
       for (const n of steps) {
         v.currentPageNumber = n;
         const s0 = performance.now();
         while (!A.loaded(p, n)) { if (performance.now() - s0 > 2000) { timeouts++; break; } await wait(100); }
         const c = h.state().canvases;
         const limit = Math.max(10, 2 * c.visible + 1);
         maxVisible = Math.max(maxVisible, c.visible);
         if (c.cached > limit || c.dom > limit) violations.push(Object.assign({ n, limit }, c));
         if (c.visible <= 9 && c.dom > 10 + c.visible) phrase.push(Object.assign({ n }, c));
       }
       const last = h.state().canvases;
       const c200 = A.canvas(p, 200);
       return {
         steps: steps.length, timeouts, violations, phrase, maxVisible, last,
         p1: A.page(p, 1) ? A.page(p, 1).querySelectorAll('canvas').length : -1,
         p200: A.page(p, 200) ? A.page(p, 200).querySelectorAll('canvas').length : -1,
         area: c200 ? c200.width * c200.height : 0,
       };`,
      { timeoutMs: 240000 },
    );
    const c6pre = c6?.last?.renderedPages >= 30;
    r.check(
      "(C6-전제) 서로 다른 렌더 페이지 ≥ 30 — 한계보다 많이 그려져 퇴출이 실제로 일어났다(미달이면 C6 전체 무효)",
      c6pre,
      `renderedPages=${c6?.last?.renderedPages} ${c6?.err ?? ""}`,
    );
    r.info(`C6 단계 ${c6?.steps} · data-loaded 대기 타임아웃 ${c6?.timeouts}단계 · 최대 visible ${c6?.maxVisible}`);
    r.check(
      "(C6) 200쪽을 3쪽씩 끝까지 — 매 단계 cached·dom ≤ max(10, 2·visible+1) · 끝에서 1쪽 canvas 0 · 200쪽 canvas 1 · 대기 타임아웃 ≤ 5단계",
      c6pre && c6.violations.length === 0 && c6.p1 === 0 && c6.p200 === 1 && c6.timeouts <= 5,
      `위반 ${J(c6?.violations?.slice(0, 5))} · 1쪽 ${c6?.p1} · 200쪽 ${c6?.p200} · 타임아웃 ${c6?.timeouts} · 끝 ${J(c6?.last)}`,
    );
    r.check(
      "(C6) 설계 문구 dom ≤ 10 + visible (visible ≤ 9 인 단계) · 전제 유효",
      c6pre && c6.phrase.length === 0,
      J(c6?.phrase?.slice(0, 5)),
    );
    const heap1 = await heapCanvases(cdp).catch((e) => ({ err: e.message }));
    if (heap0.err || heap1.err) {
      r.skip("(C6 보조) 힙 캔버스 면적", `계측 실패 — ${heap0.err || heap1.err}`);
    } else {
      const limit = Math.max(10, 2 * (c6?.last?.visible ?? 0) + 1);
      const added = heap1.area - heap0.area;
      r.check(
        "(C6 보조) 강제 GC 후 PDF 가 더한 힙 캔버스 면적 ≤ limit × 페이지 캔버스 면적 × 1.5 · 전제: 페이지 면적 > 0 · 더한 면적 > 0",
        c6pre && c6.area > 0 && added > 0 && added <= limit * c6.area * 1.5,
        `더한 ${(added / 1e6).toFixed(1)}MP(${heap0.count}→${heap1.count}개) · 상한 ${((limit * (c6?.area ?? 0) * 1.5) / 1e6).toFixed(1)}MP(limit ${limit} × 페이지 ${c6?.area})`,
      );
    }

    // ── 부가: 썸네일로만 그린 페이지를 치운다(pdf.js thumbnailrendered 훅) ─────────────────────────────
    if (c6pre) await thumbsCleanupBlock({ cdp, r });

    // ── 부가: JPX(nowasm 폴백) 픽셀 ──────────────────────────────────────────────────────────────
    await open(P.jpx);
    const rj = await waitReady(cdp, P.jpx, 80);
    const jpx = await poll(
      () =>
        evalA(
          cdp,
          `const p = ${J(P.jpx)}; return { red: A.rgbPdf(p, 1, 197, 600), blue: A.rgbPdf(p, 1, 397, 600), white: A.rgbPdf(p, 1, 50, 50) };`,
        ),
      (v) => near(v?.red, [220, 20, 20]) && near(v?.blue, [20, 20, 220]),
      40,
      125,
    );
    r.check(
      "(부가) JPX 이미지가 wasm 없이 그려진다 — (197,600)pt ≈ (220,20,20) · (397,600) ≈ (20,20,220) · 반증: 이미지 밖 (50,50) 은 흰색(±24)",
      rj?.status === "ready" && near(jpx?.red, [220, 20, 20]) && near(jpx?.blue, [20, 20, 220]) && near(jpx?.white, [255, 255, 255]),
      `${J(jpx)} status=${rj?.status} docOpts=${J(rj?.s?.docOpts)}`,
    );

    // ── 부가: 먼저 연 인스턴스가 사라져도 남은 인스턴스의 선택·링크가 산다(pdf.js 전역 selection 리스너) ──
    await splitBlock({ cdp, r, open, gone, setView, PANE, CONTROL });

    // ── C3 + 부가 — 문서 창 ────────────────────────────────────────────────────────────────────────
    await docBlock({ cdp, r, pid, cdpPort, CONTROL, docLabels });

    // ── 끝: 스위트 내내 PDF get_file_diff 0 · 리로드 없음 ─────────────────────────────────────────
    const diffPdfAll = await cdp.eval(`window.__gpv61spy.diff.filter((x) => /\\.pdf$/i.test(x || ''))`);
    r.check(
      "(C1) 스위트 내내(C4 재로드·commit 모드·Git 모달 포함) PDF 경로 get_file_diff 0회 · 대조① 유효",
      spyOk && Array.isArray(diffPdfAll) && diffPdfAll.length === 0,
      J(diffPdfAll),
    );
    const t1 = await cdp.eval(`performance.timeOrigin`);
    r.check(
      "실행 중 메인 창 리로드 없음(performance.timeOrigin 불변) — 리로드가 끼었으면 위 수치는 무효",
      t1 === t0,
      `${t0} → ${t1}`,
    );
  } finally {
    await cdp.eval(`window.__gpv.ui.getState().closeGitDialog()`).catch(() => {});
    await cdp
      .eval(`(() => { const s = window.__gpv.ui.getState(); s.closeConfirm(); s.closePrompt(); return true; })()`)
      .catch(() => {});
    await cdp.eval(`(() => { delete window.__gpv.pdfOpts; return true; })()`).catch(() => {});
    await cdp
      .eval(`(() => {
        const m = window.__gpv61m;
        if (m && m.onClick) {
          window.removeEventListener('click', m.onClick);
          window.removeEventListener('auxclick', m.onClick);
          window.removeEventListener('keydown', m.onKey);
          window.removeEventListener('copy', m.onCopy, true);
        }
        if (m && m.pdKey) window.removeEventListener('keydown', m.pdKey, true);
        document.getElementById('gpv61-copy-ctl')?.remove();
        delete window.__gpv61m;
        const s = document.getSelection(); if (s) s.removeAllRanges();
        return true;
      })()`)
      .catch(() => {});
    await cdp.eval(UNSPY).catch(() => {});
    for (const label of docLabels) await closeDoc(cdp, label);
    await cdp
      .eval(`(() => {
        const p = JSON.parse(${J(snap)});
        window.__gpv.ui.setState({
          viewerLayout: p.layout, viewerActivePaneId: p.active, viewerByPane: p.byPane,
          viewerMaximizedPaneId: p.max, selectedDiff: p.diff, selectedDiffRepoId: p.repo,
        });
        return true;
      })()`)
      .catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().closeProjectViewerTabs(${J(pid)})`).catch(() => {});
    await cdp
      .eval(`(() => {
        const p = JSON.parse(${J(snap)});
        const orig = ${J(origTab)};
        const t = window.__gpv.terminals.getState();
        if (orig) t.setActiveTab(${J(pid)}, orig); else t.setActiveTab(${J(pid)}, 'viewer');
        if (p.project) window.__gpv.ui.getState().selectProject(p.project);
        if (p.agg) window.__gpv.ui.getState().setAggregateOpen(true);
        if (p.report) window.__gpv.ui.getState().toggleReport();
        window.__gpv.ui.setState({
          viewerLayout: p.layout, viewerActivePaneId: p.active, viewerByPane: p.byPane,
          viewerMaximizedPaneId: p.max, selectedDiff: p.diff, selectedDiffRepoId: p.repo,
        });
        return true;
      })()`)
      .catch(() => {});
    await cdp.eval(`delete window.__gpv61`).catch(() => {});
    await sleep(300);
    for (const rel of [DIR, CONTROL]) {
      try {
        rmSync(join(fix.repo, rel), { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* 앱이 쥐고 있으면 러너 teardown 이 픽스처째 지운다 */
      }
    }
  }
}

/** 부가 — 줌 버튼·키·Ctrl+휠·맞춤과 키 스코프(pages12.pdf 가 열려 있고 'auto' 인 상태에서 시작). */
async function zoomBlock({ cdp, r }) {
  const p = P.p12;
  const st = () => stateOf(cdp, p);
  const focusScroll = () => evalA(cdp, `A.scroll(${J(p)}).focus({ preventScroll: true }); return true;`);
  const center = await evalA(cdp, `return A.box(A.scroll(${J(p)}));`);
  const s0 = await st();
  if (!r.check("(줌) 시작 상태 — 초기 배율 'auto'", s0?.scaleValue === "auto", `scaleValue=${s0?.scaleValue} scale=${s0?.scale}`))
    return;

  // 스냅 반증 — 'auto'(소수 배율)에서 작은 Ctrl+휠은 반올림 결과가 같으면 updateScale 을 부르지 않아 배율이 **정확히**
  // 그대로다. 결함 구현(반올림 안 한 현재값과 비교)은 −1 에서 부르고, pdf.js 1% 반올림으로 배율이 위든 아래든 바뀐다.
  // `>=` 로 재면 결함이 위로 반올림하는 배율(0.7588 → 0.76)에서 통과해 버린다 → 두 전제가 설 때만 `===` 로 판정한다.
  const stepOk = grepFile(join(ROOT, "src/lib/zoom.ts"), "WHEEL_STEP = 1.1;") === true;
  const tiny = 1.1 ** (1 / 100); // PdfView: acc *= WHEEL_STEP ** (−deltaY / 100)
  const tinySame = Math.round(s0.scale * tiny * 100) === Math.round(s0.scale * 100);
  const faultyMoves = Math.abs(Math.round(s0.scale * tiny * 100) / 100 - s0.scale) > 1e-9;
  await wheelAt(cdp, center.x, center.y, -1, MOD);
  await sleep(250);
  const sTiny = await st();
  await wheelAt(cdp, center.x, center.y, -10, MOD);
  await sleep(250);
  const sTen = await st();
  if (!(stepOk && tinySame && faultyMoves)) {
    r.skip(
      "(줌) 'auto' 에서 작은 Ctrl+휠(deltaY −1)은 배율을 정확히 그대로 둔다",
      `판정 불가 배율 ${s0.scale} — WHEEL_STEP 1.1 확인 ${stepOk} · 반올림 같음 ${tinySame} · 결함 구현이면 바뀜 ${faultyMoves}`,
    );
  } else {
    r.check(
      "(줌) 'auto' 에서 작은 Ctrl+휠(deltaY −1)은 배율을 정확히 그대로 둔다(결함 구현이면 반드시 바뀌는 배율) · −10 은 줄이지 않는다",
      sTiny?.scale === s0.scale && sTen?.scale >= s0.scale,
      `auto ${s0.scale} → −1: ${sTiny?.scale} → −10: ${sTen?.scale}`,
    );
  }

  await focusScroll();
  const sPre = await st();
  await press(cdp, "+", SHIFT);
  const up = await poll(st, (v) => v?.scale > sPre.scale, 12, 150);
  await press(cdp, "0");
  const auto = await poll(st, (v) => v?.scaleValue === "auto", 12, 150);
  r.check(
    "(줌) 스크롤 컨테이너 포커스에서 '+' → 배율 증가 · '0' → 'auto'",
    up?.scale > sPre.scale && auto?.scaleValue === "auto",
    `${sPre.scale} → '+' ${up?.scale} → '0' ${auto?.scaleValue}`,
  );

  // Ctrl+휠 줌은 커서 아래 점을 고정한다 — 1쪽 텍스트 span 중심에 커서를 두고 그 점이 옮겨 간 거리를 잰다.
  // 맨 위로 되돌려 span 이 스크롤 컨테이너 안에 보이게 한다(휠의 히트 대상이 컨테이너여야 한다).
  await evalA(cdp, `A.scroll(${J(p)}).scrollTop = 0; await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))); return true;`);
  const g0 = await evalA(
    cdp,
    `const sp = A.span(${J(p)}, 1, 'REV'); if (!sp) return null;
     const b = A.box(sp), c = A.scroll(${J(p)}).getBoundingClientRect();
     if (b.y < c.top || b.y > c.bottom || b.x < c.left || b.x > c.right) return null;
     return Object.assign(b, { scale: A.state(${J(p)}).scale });`,
  );
  if (!g0) {
    r.skip("(줌) Ctrl+휠 커서 고정 · 수식키 없는 휠 반증", "1쪽 텍스트 span 이 없거나 스크롤 컨테이너 밖 — 커서 기준점을 둘 수 없다");
  } else {
    await wheelAt(cdp, g0.x, g0.y, -120, MOD);
    const zoomed = await poll(st, (v) => v?.scale > g0.scale, 16, 150);
    await sleep(800); // drawingDelay 400ms 뒤 텍스트 레이어가 새 배율로 다시 그려진다
    const g1 = await evalA(cdp, `const sp = A.span(${J(p)}, 1, 'REV'); return sp ? A.box(sp) : null;`);
    const fx = (g0.x - g0.left) / g0.w;
    const fy = (g0.y - g0.top) / g0.h;
    const dx = g1 ? g1.left + fx * g1.w - g0.x : null;
    const dy = g1 ? g1.top + fy * g1.h - g0.y : null;
    r.check(
      "(줌) Ctrl+휠(deltaY −120) → 배율 증가 · 커서 아래 텍스트 점의 이동 ≤ 8px",
      zoomed?.scale > g0.scale && dx !== null && Math.abs(dx) <= 8 && Math.abs(dy) <= 8,
      `${g0.scale} → ${zoomed?.scale} · 이동 (${dx?.toFixed(1)}, ${dy?.toFixed(1)})px`,
    );
    const sNo = await st();
    const top0 = await evalA(cdp, `return A.scroll(${J(p)}).scrollTop;`);
    await wheelAt(cdp, g0.x, g0.y, 120, 0);
    const top1 = await poll(() => evalA(cdp, `return A.scroll(${J(p)}).scrollTop;`), (v) => v !== top0, 12, 150);
    const sNo1 = await st();
    r.check(
      "(줌-반증) 수식키 없는 휠(같은 좌표)은 배율 불변 · 네이티브 스크롤(scrollTop 변화) — 모든 휠을 줌으로 먹지 않는다",
      sNo1?.scale === sNo?.scale && top1 !== top0,
      `scale ${sNo?.scale} → ${sNo1?.scale} · scrollTop ${top0} → ${top1}`,
    );
  }

  // 키 스코프 — 입력칸 안의 '-' 와 뷰어 밖 포커스의 '+' 는 줌이 아니다. 반증: 같은 '-' 가 스크롤 컨테이너에서는 줄인다.
  const sKey = await st();
  const inputFocused = await evalA(
    cdp,
    `const i = A.root(${J(p)})?.querySelector('[data-pdf-page-input]'); if (!i) return false; i.focus(); return document.activeElement === i;`,
  );
  await press(cdp, "-");
  await sleep(400);
  const sInput = await st();
  await cdp.eval(`(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); document.body.focus(); return document.activeElement === document.body; })()`);
  await press(cdp, "+", SHIFT);
  await sleep(400);
  const sBody = await st();
  await focusScroll();
  await press(cdp, "-");
  const down = await poll(st, (v) => v?.scale < sKey.scale, 12, 150);
  r.check(
    "(키 스코프) [data-pdf-page-input] 포커스의 '-' → 배율 불변 · 포커스가 뷰어 밖(body)일 때 '+' 도 불변(window 리스너가 아니다) · 반증: 같은 '-' 를 스크롤 컨테이너에서 누르면 줄고, 포커스 '+' 는 위에서 늘었다",
    inputFocused === true && sInput?.scale === sKey?.scale && sBody?.scale === sKey?.scale && down?.scale < sKey?.scale && up?.scale > sPre.scale,
    `${sKey?.scale} → 입력칸(포커스 ${inputFocused}) '-' ${sInput?.scale} → body '+' ${sBody?.scale} → 컨테이너 '-' ${down?.scale}`,
  );

  await evalA(
    cdp,
    `const s = A.root(${J(p)})?.querySelector('select[data-pdf-fit]'); if (!s) return null; s.value = 'page-width'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value;`,
  );
  const fit = await poll(st, (v) => v?.scaleValue === "page-width", 12, 150);
  r.check("(맞춤) [data-pdf-fit] = page-width → scaleValue 'page-width'", fit?.scaleValue === "page-width", `scaleValue=${fit?.scaleValue}`);
  await focusScroll();
  await press(cdp, "0");
  await poll(st, (v) => v?.scaleValue === "auto", 12, 150);
}

/** 부가 — 사이드바 썸네일은 doc 을 메인 뷰어와 공유한다. 썸네일로만 그린 페이지의 오퍼레이터 리스트·디코드 이미지는
 *  PDFPageProxy 에 남고(display 렌더는 스스로 치우지 않는다), 메인 뷰어는 자기 버퍼에서 밀어낸 페이지만 치운다 → 썸네일을
 *  한 번 훑으면 쪽수만큼 쌓인다. 'thumbnailrendered' 를 받으면 PDFViewer 가 버퍼 밖 페이지를 cleanup 한다.
 *  pages200.pdf 가 열려 있는 상태(C6 직후)에서 시작한다. */
async function thumbsCleanupBlock({ cdp, r }) {
  const p = P.p200;
  const S = (body, opts) =>
    evalA(cdp, `const h = A.handle(${J(p)}); if (!h) return null; const root = h.root, v = h.viewer(), d = h.doc(); ${body}`, opts);
  await S(`const b = root.querySelector('[data-pdf-sidebar-toggle]'); if (b) b.click(); return !!b;`);
  const count = await poll(() => S(`return root.querySelectorAll('[data-pdf-thumb]').length;`), (x) => x === 200, 20, 250);
  const walk = await S(
    `const l = root.querySelector('[data-pdf-thumbs]'); if (!l) return null;
     const wait = (ms) => new Promise((res) => setTimeout(res, ms));
     const drawn = new Set();
     l.scrollTop = 0; await wait(400);
     for (let i = 0; i < 150; i++) {
       for (const c of l.querySelectorAll('[data-pdf-thumb-canvas]')) { const b = c.closest('[data-pdf-thumb]'); if (b && c.width > 0) drawn.add(b.getAttribute('data-pdf-thumb')); }
       if (l.scrollTop + l.clientHeight >= l.scrollHeight - 2) break;
       l.scrollTop += Math.floor(l.clientHeight * 0.9);
       await wait(150);
     }
     await wait(1500); // 마지막 화면의 썸네일 렌더가 끝나고 훅이 돌 시간
     let withIntent = 0;
     for (let n = 1; n <= d.numPages; n++) { const pg = await d.getPage(n); if (pg._intentStates.size > 0) withIntent++; }
     return { drawn: drawn.size, canvases: l.querySelectorAll('[data-pdf-thumb-canvas]').length, cached: v.getCachedPageViews().size, withIntent };`,
    { timeoutMs: 90000 },
  );
  await S(`const b = root.querySelector('[data-pdf-sidebar-toggle]'); if (b) b.click(); return !!b;`);
  r.check(
    "(부가) 사이드바 썸네일 200개를 끝까지 훑은 뒤 오퍼레이터 리스트를 쥔 페이지 수 ≤ 메인 버퍼 + 남은 썸네일 캔버스 + 2 · 전제: 썸네일 캔버스를 붙인 서로 다른 페이지 ≥ 30(치울 거리가 실제로 생겼다 — 훅이 없으면 ≈200)",
    count === 200 && walk?.drawn >= 30 && walk.withIntent <= walk.cached + walk.canvases + 2,
    `썸네일 ${count} · ${J(walk)}`,
  );
}

/** C4 · C4-b · C4-c — build/ 아래 pages12.pdf 를 외부에서 다시 쓴다. */
async function reloadBlock({ cdp, r, fix, pid, put, F, t0, open, gone, CONTROL }) {
  const p = P.p12;
  const st = () => stateOf(cdp, p);
  const text7 = () => evalA(cdp, `return A.text(${J(p)}, 7);`);

  // 7쪽으로 — 페이지 입력칸 Enter(실제 키 경로).
  await evalA(cdp, `const i = A.root(${J(p)})?.querySelector('[data-pdf-page-input]'); if (!i) return false; i.focus(); i.select(); return true;`);
  await send(cdp, "Input.insertText", { text: "7" });
  await press(cdp, "Enter");
  const at7 = await poll(
    () => evalA(cdp, `const s = A.state(${J(p)}); return { page: s.currentPage, text: A.text(${J(p)}, 7) };`),
    (v) => v?.page === 7 && (v.text || "").includes("P7-REV-A"),
    40,
    250,
  );
  if (
    !r.check(
      "(C4) [data-pdf-page-input] '7' + Enter → currentPage 7 · 7쪽 textLayer 'P7-REV-A'(재기록 전 반증)",
      at7?.page === 7 && at7.text.includes("P7-REV-A"),
      J(at7),
    )
  )
    return;

  // repo://changed 계수 — 무관 파일(build/ 밖)은 이벤트가 오고, build/ 재기록은 오지 않는다(이벤트 방식이면 재로드 안 됐을 근거).
  await cdp.eval(`(async () => {
    const ev = await import('/node_modules/@tauri-apps/api/event.js');
    const m = window.__gpv61m;
    m.repoEvents = 0;
    if (m.unlistenRepo) m.unlistenRepo();
    m.unlistenRepo = await ev.listen('repo://changed', () => { m.repoEvents++; });
    return true;
  })()`).catch(() => {});

  // 찾기를 연 채 재로드 — 새 문서 기준으로 다시 찾아야 한다(setDocument 가 findController 를 비운다).
  await evalA(cdp, `A.scroll(${J(p)}).focus({ preventScroll: true }); return true;`);
  await press(cdp, "f", MOD);
  await send(cdp, "Input.insertText", { text: "REV-A" });
  const found = await poll(st, (v) => v?.find?.total === 12 && (v.find.state === 0 || v.find.state === 2), 40, 250);
  const b = await st();
  r.check(
    "(C4 전제) 찾기 'REV-A' → total 12 · 현재 페이지에서 시작해 7쪽 유지",
    found?.find?.total === 12 && b?.currentPage === 7,
    `find=${J(found?.find)} page=${b?.currentPage}`,
  );

  // 무관 쓰기 대조 — 무효화마다 다시 읽는 구현이면 readCount 가 는다.
  const repoEv0 = await cdp.eval(`window.__gpv61m.repoEvents`).catch(() => null);
  put(P.unrelated, `unrelated ${Date.now()}\n`);
  await sleep(3500);
  const u = await st();
  const repoEvUnrelated = await cdp.eval(`window.__gpv61m.repoEvents`).catch(() => null);
  r.check(
    "(C4 대조) 무관 파일 쓰기 후 3.5초(폴링 2회+) — loadCount·reloadCount·readCount 불변",
    u?.loadCount === b.loadCount && u.reloadCount === b.reloadCount && u.readCount === b.readCount,
    `load ${b.loadCount}→${u?.loadCount} reload ${b.reloadCount}→${u?.reloadCount} read ${b.readCount}→${u?.readCount}`,
  );

  // REV-BB(길이 다름) 재기록.
  await cdp.eval(`window.__gpv61m.repoEvents = 0`).catch(() => {});
  const w0 = Date.now();
  put(p, F.pages12("REV-BB"));
  const c4 = await until(
    () =>
      evalA(
        cdp,
        `const s = A.state(${J(p)}); return s && { id: s.id, page: s.currentPage, reload: s.reloadCount, read: s.readCount, status: s.status, error: s.error, vis: document.visibilityState, stamp: s.lastStamp, text: A.text(${J(p)}, 7), find: s.find, t0: performance.timeOrigin };`,
      ),
    (v) =>
      !!v &&
      v.text.includes("P7-REV-BB") &&
      v.reload === b.reloadCount + 1 &&
      v.id === b.id &&
      v.page === 7 &&
      v.stamp !== b.lastStamp &&
      v.t0 === t0,
    w0,
    3000,
  );
  r.check(
    "(C4) 외부 재기록 3초 안에 제자리 재로드 — 7쪽 'P7-REV-BB' · reloadCount+1 · 핸들 id 불변(리마운트 아님) · currentPage 7 · lastStamp 변경 · timeOrigin 불변",
    c4.ok,
    `${c4.ms}ms · ${J({ ...c4.v, find: undefined })} · 전 id=${b.id} reload=${b.reloadCount} read=${b.readCount} stamp=${b.lastStamp}`,
  );
  // 재로드는 annotationEditorMode DISABLE 을 풀면 안 된다 — pdf.js setDocument 는 기존 문서가 있으면 모드를 NONE 으로
  // 되돌려 AnnotationEditorUIManager(window keydown · document dragover/drop 리스너)를 만든다. 그러면 이미지 dragover 를
  // 막고, drop 하면 STAMP 모드로 들어가 창 안 textarea 의 Backspace·Ctrl+A 를 막는다. drop 은 쏘지 않는다(상태 변경).
  const ed = await evalA(
    cdp,
    `const h = A.handle(${J(p)}); if (!h) return null;
     const lp = h.viewer()._layerProperties;
     const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(8)], 'gpv61.png', { type: 'image/png' }));
     const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
     A.scroll(${J(p)}).dispatchEvent(ev);
     return { key: !!lp && 'annotationEditorUIManager' in lp, ui: lp ? lp.annotationEditorUIManager != null : null, layers: h.root.querySelectorAll('.annotationEditorLayer').length, dragPrevented: ev.defaultPrevented, reload: h.state().reloadCount };`,
  );
  r.check(
    "(C4 부가) 제자리 재로드 뒤에도 편집 UI 없음 — annotationEditorUIManager null · .annotationEditorLayer 0 · 이미지 dragover 를 막지 않는다 · 전제: 재로드가 일어났고(reloadCount+1) 접근자 키가 있다",
    c4.ok && ed?.key === true && ed.ui === false && ed.layers === 0 && ed.dragPrevented === false && ed.reload === b.reloadCount + 1,
    J(ed),
  );
  const findAfter = await poll(st, (v) => v?.find?.total === 0 && v.find.state === 1, 20, 150);
  r.check(
    "(C4 부가) 찾기가 열린 채 재로드되면 새 문서 기준으로 다시 찾는다 — 'REV-A' total 12 → 0 · NOT_FOUND",
    found?.find?.total === 12 && findAfter?.find?.total === 0 && findAfter.find.state === 1,
    `전 ${J(found?.find)} → 후 ${J(findAfter?.find)}`,
  );
  const repoEvBuild = await cdp.eval(`window.__gpv61m.repoEvents`).catch(() => null);
  r.info(
    `C4 repo://changed — 무관 파일(build/ 밖) ${repoEvUnrelated === null || repoEv0 === null ? "?" : repoEvUnrelated - repoEv0}건 · build/ 재기록 ${repoEvBuild}건(0 기대: 워처가 build/ 를 버린다)`,
  );
  // 찾기 닫기(입력칸 Esc) — 이후 단계에 강조·포커스가 섞이지 않게.
  await evalA(cdp, `const i = A.root(${J(p)}).querySelector('[data-pdf-find-input]'); if (i) i.focus(); return !!i;`);
  await press(cdp, "Escape");
  await poll(st, (v) => v?.find?.open === false, 12, 150);

  // ── C4-b: 숨은 탭에서는 읽지 않고, 보이면 곧바로 따라잡는다 ────────────────────────────────────
  await cdp.eval(`window.__gpv.terminals.getState().setActiveTab(${J(pid)}, 'gpv61-hidden')`);
  const hid = await poll(() => evalA(cdp, `return A.scroll(${J(p)}).clientWidth;`), (v) => v === 0, 20, 100);
  const bh = await st();
  put(p, F.pages12("REV-CCC"));
  await sleep(3500);
  const hh = await st();
  const shownAt = Date.now();
  await cdp.eval(`window.__gpv.terminals.getState().setActiveTab(${J(pid)}, 'viewer')`);
  const c4b = await until(
    () =>
      evalA(
        cdp,
        `const s = A.state(${J(p)}); return s && { page: s.currentPage, reload: s.reloadCount, read: s.readCount, text: A.text(${J(p)}, 7) };`,
      ),
    (v) => !!v && v.text.includes("P7-REV-CCC") && v.page === 7 && v.reload === bh.reloadCount + 1,
    shownAt,
    3000,
  );
  r.check(
    "(C4-b) 워크스페이스 탭을 숨긴 동안 재기록 → 3.5초간 readCount 불변 · 다시 보이면 3초 안에 'P7-REV-CCC' · currentPage 7 · reloadCount+1 · 반증: 보인 뒤 readCount 증가(감지는 살아 있다)",
    hid === 0 && hh?.readCount === bh.readCount && c4b.ok && c4b.v.read > bh.readCount,
    `숨김 clientWidth=${hid} · read ${bh.readCount}→${hh?.readCount}(숨김) → ${c4b.v?.read}(표시) · ${c4b.ms}ms ${J(c4b.v)}`,
  );

  // ── C4-c: 쓰다 멈춘 파일(끝의 %%EOF 없음)은 미룬다 ───────────────────────────────────────────
  // 픽스처는 pdf.js 가 **여는** 판이다(buildFixtures) — 게이트가 없으면 읽은 그 판을 곧바로 로드해 mid 에서 빨개진다.
  const bc = await st();
  const half = join(fix.repo, p);
  const tHalf = Date.now();
  writeFileSync(half, F.ddHalf);
  const readHalf = await until(() => st(), (v) => v?.readCount > bc.readCount, tHalf, 2500);
  // 게이트 없는 구현이 그 읽기를 끝까지 로드할 틈(12쪽 로드 ≪ 900ms)을 준 뒤 판정 — 단 3초 유예 전에.
  if (readHalf.ok) await sleep(Math.max(0, Math.min(readHalf.ms + 900, 2400) - (Date.now() - tHalf)));
  const mid = await evalA(
    cdp,
    `const s = A.state(${J(p)}); return { reload: s.reloadCount, read: s.readCount, page: s.currentPage, error: s.error, text: A.text(${J(p)}, 7) };`,
  );
  const midAge = Date.now() - tHalf;
  appendFileSync(half, F.ddRest);
  const tRest = Date.now();
  r.check(
    "(C4-c 반증) 반쯤 쓴 파일(끝의 %%EOF 만 없음)을 실제로 읽었다 — readCount 증가",
    readHalf.ok,
    `read ${bc.readCount} → ${readHalf.v?.readCount} (${readHalf.ms}ms)`,
  );
  if (midAge >= 2900) {
    r.skip("(C4-c) 반쯤 쓴 파일은 로드를 미룬다", `판정 시각이 쓰기 후 ${midAge}ms — 3초 유예가 끝나 합법적으로 로드될 수 있는 구간이라 판정 불가`);
  } else {
    r.check(
      "(C4-c) 반쯤 쓴 파일(pdf.js 는 열 수 있는 판 · 쓰기 후 3초 미만)은 로드하지 않는다 — reloadCount 불변 · 7쪽 이전 판 'P7-REV-CCC' 유지 · 오류 없음(로드 실패로 버틴 것이 아니다)",
      readHalf.ok && mid.reload === bc.reloadCount && mid.text.includes("P7-REV-CCC") && mid.page === 7 && mid.error === null,
      `${midAge}ms 시점 ${J(mid)} · 전 reload=${bc.reloadCount}`,
    );
  }
  const c4c = await until(
    () => evalA(cdp, `const s = A.state(${J(p)}); return { page: s.currentPage, reload: s.reloadCount, text: A.text(${J(p)}, 7) };`),
    (v) => !!v && v.text.includes("P7-REV-DD") && v.page === 7 && v.reload === bc.reloadCount + 1,
    tRest,
    3000,
  );
  r.check(
    "(C4-c) 나머지를 마저 쓰면 3초 안에 'P7-REV-DD' · currentPage 7 · reloadCount 정확히 +1(잘린 판을 끼워 로드하지 않았다)",
    c4c.ok,
    `${c4c.ms}ms ${J(c4c.v)} · 전 reload=${bc.reloadCount}`,
  );

  // 페이지 유지 반증 — 새 인스턴스(다른 파일 → 다시 이 파일)는 1쪽에서 시작한다. 7 이 기본값이 아니라는 증거.
  const oldId = (await st())?.id;
  await open(CONTROL);
  await gone(p);
  await open(p);
  const fresh = await waitReady(cdp, p, 80);
  r.check(
    "(C4 반증) 다른 파일을 열었다 돌아오면 새 인스턴스(id 변경) · currentPage 1 — 유지된 7 은 기본값이 아니다",
    fresh?.status === "ready" && fresh.s.id !== oldId && fresh.s.currentPage === 1,
    `id ${oldId} → ${fresh?.s?.id} · page ${fresh?.s?.currentPage}`,
  );
  await cdp
    .eval(`(() => { const m = window.__gpv61m; if (m && m.unlistenRepo) { m.unlistenRepo(); delete m.unlistenRepo; } return true; })()`)
    .catch(() => {});
}

/** 부가 — PDF 는 useDiff 가 꺼져 있어 같은 DiffViewer(파일마다 key 없음)의 diff 가 keepPreviousData 로 **직전 파일**
 *  값이다. 그걸 헤더 배지('추가됨')·import 예열(ext 'pdf' 로 pathspec 없는 레포 전체 git grep)에 쓰면 안 된다. */
async function placeholderBlock({ cdp, r, pid, put, open, CONTROL }) {
  const sym = `gpv61Warm${Date.now()}`;
  // file 모드 텍스트는 oldContent null(= 워크트리 모드 PDF 헤더에 새면 '추가됨') · import 가 있어 예열이 실제로 돈다.
  put(P.warm, `import { ${sym} } from "./gpv61-nowhere";\nexport const gpv61 = ${sym};\n`);
  const badge = () =>
    cdp.eval(`(() => { const el = document.querySelector('[data-viewer-pane]'); return el ? (el.textContent || '').includes('추가됨') : null; })()`);
  const defs = () => cdp.eval(`window.__gpv61spy.defs.slice()`);
  // 쿼리 관찰자가 이 키로 옮겨 붙었다 = 그 파일의 커밋 + DiffViewer passive effect(예열 effect 포함) 플러시가 끝났다.
  const q = (path) =>
    cdp.eval(`(() => {
      const x = window.__gpv.queryClient.getQueryCache().find({ queryKey: ['diff', ${J(pid)}, ${J(`f:${path}`)}] });
      return x ? { observers: x.getObserversCount(), content: x.state.data ? x.state.data.newContent : null } : null;
    })()`);

  // 대조: 텍스트를 열면 예열이 ext 'ts' 로 findDefinition 을 부른다 — 스파이가 예열 경로를 실제로 본다는 증거.
  await open(P.warm);
  const firstVisit = await poll(() => q(P.warm), (v) => v?.observers >= 1 && typeof v.content === "string" && v.content.includes(sym), 40, 250);
  // **첫 방문**에 진짜 내용으로 데웠나. 예열 effect 가 keepPreviousData placeholder(직전 파일 내용)로 먼저 돌면
  // warmedKeyRef 가 이 파일 키로 선점돼 진짜 내용 도착 렌더가 건너뛴다 → 이 심볼은 영영 안 나온다(= 빨강).
  // 불변식은 "직전 파일이 무엇인가"가 아니라 (a) placeholder 내용에 sym 이 없고 (b) sym 이 회차마다 유니크(:1406).
  // 직전은 PDF 지만 그 쿼리는 enabled:false 라 data 가 undefined → placeholder 원천은 그 앞 텍스트(CONTROL)다.
  const firstWarm = await poll(defs, (v) => Array.isArray(v) && v.some((d) => d.symbol === sym && d.ext === "ts"), 40, 250);
  r.check(
    "(부가) 첫 방문 예열이 **진짜 내용**으로 돈다 — ext 'ts' 로 findDefinition · placeholder(직전 파일)로 돌면 이 심볼이 안 나온다",
    !!firstVisit?.content?.includes?.(sym) &&
      Array.isArray(firstWarm) && firstWarm.some((d) => d.symbol === sym && d.ext === "ts"),
    `첫방문 내용=${!!firstVisit?.content?.includes?.(sym)} · 예열=${J(Array.isArray(firstWarm) ? firstWarm.filter((d) => d.symbol === sym) : firstWarm)}`,
  );
  // 사이의 CONTROL 은 텍스트여야 한다 — PDF 는 예열 effect 가 ownViewer 로 빠져 warmedKeyRef 가 warm 키에 남는다.
  await open(CONTROL);
  const ctlVisit = await poll(() => q(CONTROL), (v) => v?.observers >= 1, 40, 250);
  await open(P.warm);
  // 재방문은 심볼 캐시(goto-definition.ts)가 히트해 새 IPC 가 안 나간다 — defs 는 누적이라 some() 으로만 본다.
  const warmed = await poll(defs, (v) => Array.isArray(v) && v.some((d) => d.symbol === sym && d.ext === "ts"), 40, 250);
  const d0 = Array.isArray(warmed) ? warmed.length : 0;
  await open(P.p12, "worktree");
  const rp = await waitReady(cdp, P.p12, 80);
  await sleep(1500);
  const pdfBadge = await badge();
  const pdfDefs = ((await defs()) || []).slice(d0).filter((d) => d.ext === "pdf");
  // 반증: 같은 패널에서 미추적 txt 를 worktree 모드로 열면 '추가됨' 이 붙는다(배지·셀렉터가 산다).
  await open(CONTROL, "worktree");
  const txtBadge = await poll(badge, (v) => v === true, 40, 250);
  r.check(
    "(부가) 텍스트(file 모드) 다음 같은 패널에 worktree 모드 PDF — 헤더에 직전 파일의 '추가됨' 없음 · ext 'pdf' 정의 예열 0 · 대조: 텍스트(캐시된 재방문)는 ext 'ts' 로 예열됐다 · 반증: 미추적 txt worktree 모드는 '추가됨'",
    Array.isArray(warmed) && warmed.some((d) => d.symbol === sym && d.ext === "ts") &&
      rp?.status === "ready" && pdfBadge === false && pdfDefs.length === 0 && txtBadge === true,
    `예열 대조(재방문) ${J(Array.isArray(warmed) ? warmed.filter((d) => d.symbol === sym) : warmed)} · 첫 방문 캐시=${!!firstVisit?.content?.includes?.(sym)} CONTROL 관찰자=${ctlVisit?.observers} · PDF ready=${rp?.status} 배지=${pdfBadge} pdf예열=${J(pdfDefs)} · txt 배지=${txtBadge}`,
  );
}

/** C2 — kr-uhc.pdf 검색(키 경로 포함) · 자산 서빙 · cMap 없는 반증. */
async function searchBlock({ cdp, r, open }) {
  const runSearch = async (p, query) => {
    await evalA(cdp, `A.scroll(${J(p)}).focus({ preventScroll: true }); return true;`);
    await press(cdp, "f", MOD);
    const focused = await poll(
      () => evalA(cdp, `const i = A.root(${J(p)}).querySelector('[data-pdf-find-input]'); return !!i && document.activeElement === i;`),
      (v) => v === true,
      12,
      150,
    );
    await evalA(cdp, `const i = A.root(${J(p)}).querySelector('[data-pdf-find-input]'); if (i) { i.focus(); i.select(); } return !!i;`);
    await send(cdp, "Input.insertText", { text: query });
    await press(cdp, "Enter");
    return focused === true;
  };

  await open(P.kr);
  const rk = await waitReady(cdp, P.kr, 80);
  if (!r.check("(C2) kr-uhc.pdf(KSCms-UHC-H 비임베드) 준비", rk?.status === "ready", J(rk?.s?.error ?? rk?.status))) return;
  const keyPath = await runSearch(P.kr, "가나다");
  const hit = await poll(
    () =>
      evalA(
        cdp,
        `const s = A.state(${J(P.kr)}); const pg = A.page(${J(P.kr)}, 1);
         return { find: s.find, hl: pg ? Array.from(pg.querySelectorAll('.textLayer .highlight')).map((e) => e.textContent).join('') : null };`,
      ),
    (v) => (v?.find?.state === 0 || v?.find?.state === 2) && v.find.total >= 1 && v.hl === "가나다",
    40,
    250,
  );
  const krState = await stateOf(cdp, P.kr);
  // 부정 대조 — 없는 단어는 NOT_FOUND.
  await runSearch(P.kr, "없는단어");
  const miss = await poll(() => stateOf(cdp, P.kr), (v) => v?.find?.state === 1 && v.find.total === 0, 40, 250);

  // 자산 서빙(predev/prebuild 복사) — vite SPA 폴백은 없는 파일에도 200 + text/html 을 준다.
  const assets = await cdp.eval(`(async () => {
    const get = async (u) => { try { const x = await fetch(u); const b = await x.arrayBuffer(); return { ok: x.ok, type: x.headers.get('content-type') || '', bytes: b.byteLength }; } catch (e) { return { ok: false, type: String(e), bytes: 0 }; } };
    return {
      cmap: await get('/pdfjs/cmaps/KSCms-UHC-H.bcmap'),
      nowasm: await get('/pdfjs/wasm/openjpeg_nowasm_fallback.js'),
      missing: await get('/pdfjs/cmaps/__gpv61-missing.bcmap'),
    };
  })()`);
  const served = (a) => a?.ok === true && !/text\/html/.test(a.type) && a.bytes > 0;
  r.check(
    "(C2 자산) /pdfjs/cmaps/KSCms-UHC-H.bcmap · /pdfjs/wasm/openjpeg_nowasm_fallback.js 가 실제 파일로 온다 · 반증: 없는 경로는 같은 판정에서 떨어진다(HTML 폴백 또는 오류)",
    served(assets?.cmap) && served(assets?.nowasm) && !served(assets?.missing),
    J(assets),
  );
  r.check(
    "(C2 자산) docOpts — useWasm false · cMapUrl 이 /pdfjs/cmaps/ 로 끝난다",
    krState?.docOpts?.useWasm === false && typeof krState.docOpts.cMapUrl === "string" && krState.docOpts.cMapUrl.endsWith("/pdfjs/cmaps/"),
    J(krState?.docOpts),
  );

  // 반증 — cMap 없이 같은 바이트(다른 경로 = 새 문서)를 열면 '가나다' 를 못 찾아야 한다.
  let counter = null;
  try {
    await cdp.eval(`(() => { window.__gpv.pdfOpts = { doc: { cMapUrl: null } }; return true; })()`);
    await open(P.krNo);
    const rn = await waitReady(cdp, P.krNo, 80);
    await runSearch(P.krNo, "가나다");
    const nf = await poll(() => stateOf(cdp, P.krNo), (v) => v?.find?.state === 1 && v.find.total === 0, 40, 250);
    const txt = await evalA(cdp, `return A.text(${J(P.krNo)}, 1);`);
    counter = {
      ready: rn?.status === "ready",
      cMapUrl: rn?.s?.docOpts ? rn.s.docOpts.cMapUrl : "(docOpts 없음)",
      find: nf?.find,
      hasText: (txt || "").includes("가나다"),
      spans: await evalA(cdp, `return A.spans(${J(P.krNo)}, 1);`),
    };
  } finally {
    await cdp.eval(`(() => { delete window.__gpv.pdfOpts; return true; })()`).catch(() => {});
  }
  const counterOk =
    !!counter && counter.ready && counter.cMapUrl === null && counter.find?.state === 1 && counter.find.total === 0 && !counter.hasText;
  r.check(
    "(C2-반증) pdfOpts {cMapUrl:null} 로 같은 바이트(새 문서)를 열면 docOpts.cMapUrl null(오버라이드 적용) · '가나다' NOT_FOUND · textLayer 에 '가나다' 없음",
    counterOk,
    J(counter),
  );
  r.check(
    "(C2) [data-pdf-scroll] 포커스 → Ctrl+F 가 찾기 입력칸에 포커스 · '가나다' + Enter → FOUND/WRAPPED · total ≥ 1 · 1쪽 강조 텍스트 = '가나다' · 부정 대조 '없는단어' NOT_FOUND · 반증 유효",
    keyPath && !!hit && hit.hl === "가나다" && hit.find.total >= 1 && miss?.find?.state === 1 && counterOk,
    `키경로=${keyPath} · ${J(hit)} · 없는단어 ${J(miss?.find)} · 반증=${counterOk}`,
  );
}

/** 부가 — Git 모달 안 PdfView 에서 찾기 Esc 는 찾기만 닫는다(모달은 window 버블 Esc 로 닫힌다). */
async function gitModalBlock({ cdp, r, pid }) {
  const MODAL = `document.querySelector('div.fixed.inset-0.z-50')`;
  const p = P.kr;
  await cdp.eval(`window.__gpv.ui.getState().openGitDialog(${J(pid)})`);
  const row = await poll(
    () =>
      cdp.eval(`(() => {
        const m = ${MODAL};
        if (!m) return 'no-modal';
        const el = Array.from(m.querySelectorAll('div[title]')).find((x) => x.getAttribute('title') === ${J(p)});
        if (!el) return 'no-row';
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return 'ok';
      })()`),
    (v) => v === "ok",
    40,
    250,
  );
  const inModal = await poll(
    () =>
      evalA(cdp, `const h = A.handle(${J(p)}); const s = h && h.state(); return s ? { status: s.status, inModal: !!h.root.closest('div.fixed.inset-0.z-50') } : null;`),
    (v) => v?.status === "ready" && v.inModal,
    80,
    250,
  );
  if (row !== "ok" || !inModal?.inModal) {
    r.skip("(부가) Git 모달 찾기 Esc", `모달 PdfView 준비 실패(행=${row} 상태=${J(inModal)})`);
    await cdp.eval(`window.__gpv.ui.getState().closeGitDialog()`).catch(() => {});
    return;
  }
  await evalA(cdp, `A.scroll(${J(p)}).focus({ preventScroll: true }); return true;`);
  await press(cdp, "f", MOD);
  const opened = await poll(() => stateOf(cdp, p), (v) => v?.find?.open === true, 12, 150);
  await send(cdp, "Input.insertText", { text: "가나다" });
  await press(cdp, "Escape");
  const closed = await poll(() => stateOf(cdp, p), (v) => v?.find?.open === false, 12, 150);
  await sleep(200);
  const modalKept = await cdp.eval(`!!window.__gpv.ui.getState().gitDialog && !!${MODAL}`);
  // 반증 — 찾기가 닫힌 뒤(포커스는 스크롤 컨테이너) 같은 Esc 는 모달까지 올라가 모달을 닫는다.
  await press(cdp, "Escape");
  const modalGone = await poll(() => cdp.eval(`!window.__gpv.ui.getState().gitDialog`), (v) => v === true, 12, 150);
  r.check(
    "(부가) Git 모달 안 찾기 입력칸 Esc → 찾기만 닫힘 · 모달 유지 · 반증: 찾기가 닫힌 뒤 Esc 는 모달을 닫는다",
    opened?.find?.open === true && closed?.find?.open === false && modalKept === true && modalGone === true,
    `열림=${opened?.find?.open} 닫힘=${closed?.find?.open} 모달유지=${modalKept} 반증(모달닫힘)=${modalGone}`,
  );
  await cdp.eval(`window.__gpv.ui.getState().closeGitDialog()`).catch(() => {});
}

/** C5 — 암호 · 폼 제출 리로드 없음 · 기억한 암호 재사용 · 취소 · 실패 task 누수 · 파일 없음. */
async function passwordBlock({ cdp, r, fix, open, t0, F }) {
  const p = P.enc;
  const href0 = await cdp.eval(`location.href`);
  const nav = () => cdp.eval(`({ href: location.href, t0: performance.timeOrigin })`).catch(() => null);
  const navOk = (v) => !!v && v.href === href0 && v.t0 === t0;

  await open(p);
  const first = await poll(
    () =>
      evalA(
        cdp,
        `const s = A.state(${J(p)}); const root = A.root(${J(p)});
         return s ? { status: s.status, prompts: s.passwordPrompts, live: s.liveTasks, form: !!(root && root.querySelector('form[data-pdf-password]')), spans: A.spans(${J(p)}, 1), dom: root ? root.getAttribute('data-pdf-status') : null } : null;`,
      ),
    (v) => v?.status === "password" && J(v.prompts) === "[1]" && v.form,
    80,
    250,
  );
  r.check(
    "(C5) 암호 PDF → status password · passwordPrompts [1] · 폼 표시 · 텍스트 0 (처음부터 열리는 픽스처면 여기서 빨개진다)",
    first?.status === "password" && J(first.prompts) === "[1]" && first.form && first.spans === 0 && first.dom === "password",
    J(first),
  );
  const typePw = async (value) => {
    await evalA(cdp, `const i = A.root(${J(p)})?.querySelector('[data-pdf-password-input]'); if (!i) return null; i.focus(); i.select(); return i.type;`);
    await send(cdp, "Input.insertText", { text: value });
    await press(cdp, "Enter");
    await sleep(300);
    return nav();
  };

  const navWrong = await typePw("wrong");
  const wrong = await poll(
    () =>
      evalA(
        cdp,
        `const s = A.state(${J(p)}); const root = A.root(${J(p)});
         return s ? { status: s.status, prompts: s.passwordPrompts, err: A.visible(root && root.querySelector('[data-pdf-password-error]')), spans: A.spans(${J(p)}, 1) } : null;`,
      ),
    (v) => J(v?.prompts) === "[1,2]" && v.err,
    40,
    250,
  );
  r.check(
    "(C5) 틀린 암호 + Enter → passwordPrompts [1,2](pdf.js INCORRECT_PASSWORD) · 오류 문구 표시 · 여전히 password(error 아님) · 텍스트 0 · 폼 제출이 창을 이동·리로드하지 않음(href·timeOrigin 불변)",
    J(wrong?.prompts) === "[1,2]" && wrong.err && wrong.status === "password" && wrong.spans === 0 && navOk(navWrong),
    `${J(wrong)} · nav ${J(navWrong)}`,
  );

  const navRight = await typePw("gpv-pass");
  const right = await poll(
    () => evalA(cdp, `const s = A.state(${J(p)}); return s ? { status: s.status, text: A.text(${J(p)}, 1), prompts: s.passwordPrompts, reload: s.reloadCount } : null;`),
    (v) => v?.status === "ready" && (v.text || "").includes("Encrypted GPV fixture"),
    60,
    250,
  );
  r.check(
    "(C5) 맞는 암호 + Enter → status ready · 1쪽 textLayer 'Encrypted GPV fixture' · href·timeOrigin 불변",
    right?.status === "ready" && right.text.includes("Encrypted GPV fixture") && navOk(navRight),
    `${J(right)} · nav ${J(navRight)}`,
  );

  // 부가 — 1바이트를 덧붙여 stamp 를 바꾸면 기억한 암호로 프롬프트 없이 다시 연다.
  if (right?.status === "ready") {
    const w0 = Date.now();
    appendFileSync(join(fix.repo, p), "\n");
    const re = await until(
      () => stateOf(cdp, p),
      (v) => v?.reloadCount === right.reload + 1 && v.status === "ready" && v.passwordPrompts.length === right.prompts.length,
      w0,
      3000,
    );
    r.check(
      "(C5 부가) 재기록 3초 안에 reloadCount+1 · 암호 프롬프트 추가 없음(기억한 암호 재사용) · ready",
      re.ok,
      `${re.ms}ms reload ${right.reload}→${re.v?.reloadCount} prompts ${J(right.prompts)}→${J(re.v?.passwordPrompts)} status=${re.v?.status}`,
    );
  }

  // 취소 — update(Error) 를 안 부르는 구현은 password 에 영구히 남는다. liveTasks 로 실패 task 누수까지 본다.
  await open(P.encCancel);
  // live.status 는 onPassword 에서 즉시 바뀌고 폼은 다음 React 커밋에 생긴다 — 버튼이 그려진 뒤에 누른다.
  const pend = await poll(
    () =>
      evalA(
        cdp,
        `const s = A.state(${J(P.encCancel)}); const root = A.root(${J(P.encCancel)}); return s && Object.assign(s, { cancelBtn: !!(root && root.querySelector('[data-pdf-password-cancel]')) });`,
      ),
    (v) => v?.status === "password" && v.cancelBtn,
    80,
    250,
  );
  await evalA(cdp, `const b = A.root(${J(P.encCancel)}).querySelector('[data-pdf-password-cancel]'); if (b) b.click(); return !!b;`);
  const cancelled = await poll(
    () =>
      evalA(
        cdp,
        `const s = A.state(${J(P.encCancel)}); const root = A.root(${J(P.encCancel)});
         return s ? { status: s.status, error: s.error, live: s.liveTasks, retry: !!(root && root.querySelector('[data-pdf-retry]')) } : null;`,
      ),
    (v) => v?.status === "error" && v.retry && v.live === 0,
    40,
    250,
  );
  r.check(
    "(C5 취소) 암호 폼이 떠 있는 동안 liveTasks === 1(카운터가 실제로 센다) · [취소] → status error · [다시 시도] · liveTasks 0(거절된 task 도 destroy)",
    pend?.liveTasks === 1 && cancelled?.status === "error" && cancelled.retry && cancelled.live === 0,
    `대기 ${J({ status: pend?.status, live: pend?.liveTasks })} → 취소 ${J(cancelled)}`,
  );

  // 재로드 중 암호 취소 — 평문으로 보던 파일이 암호 PDF 로 재기록되면 프롬프트가 뜨고, [취소]는 **현 화면 유지**
  // (오류 오버레이 아님)다. 거절된 재로드 task 도 destroy 한다(liveTasks: 화면 문서 + 대기 task 2 → 1).
  const sw = P.swap;
  const swState = `const s = A.state(${J(sw)}); const root = A.root(${J(sw)});
     return s ? { status: s.status, prompts: s.passwordPrompts, live: s.liveTasks, reload: s.reloadCount, text: A.text(${J(sw)}, 1),
       cancelBtn: !!(root && root.querySelector('[data-pdf-password-cancel]')), errEl: !!(root && root.querySelector('[data-pdf-error]')) } : null;`;
  writeFileSync(join(fix.repo, sw), F.pages12("REV-A"));
  await open(sw);
  const sw0 = await poll(() => evalA(cdp, swState), (v) => v?.status === "ready" && (v.text || "").includes("P1-REV-A"), 80, 250);
  writeFileSync(join(fix.repo, sw), F.enc);
  const swPw = await poll(() => evalA(cdp, swState), (v) => v?.status === "password" && v.cancelBtn, 40, 250);
  await evalA(cdp, `const b = A.root(${J(sw)}).querySelector('[data-pdf-password-cancel]'); if (b) b.click(); return !!b;`);
  const swAfter = await poll(() => evalA(cdp, swState), (v) => v?.status === "ready" && v.live === 1, 40, 250);
  r.check(
    "(C5 부가) 보던 PDF 가 암호 PDF 로 재기록 → 프롬프트 [1] · 대기 중 liveTasks 2 · [취소] → status ready(오류 아님) · 1쪽 'P1-REV-A' 유지 · [data-pdf-error] 없음 · reloadCount 불변 · liveTasks 1(거절된 재로드 task destroy)",
    sw0?.status === "ready" &&
      J(swPw?.prompts) === "[1]" && swPw.live === 2 &&
      swAfter?.status === "ready" && swAfter.text.includes("P1-REV-A") && !swAfter.errEl && swAfter.reload === sw0.reload && swAfter.live === 1,
    `전 ${J(sw0 && { status: sw0.status, live: sw0.live, reload: sw0.reload })} · 대기 ${J(swPw && { status: swPw.status, prompts: swPw.prompts, live: swPw.live })} · 취소 후 ${J(swAfter && { ...swAfter, text: swAfter.text.slice(0, 20) })}`,
  );

  // 깨진 PDF — 첫 로드 실패 task 도 destroy 해야 한다(공유 워커에 문서 핸들·버퍼가 남는다).
  await open(P.bad);
  const bad = await poll(
    () => stateOf(cdp, P.bad),
    (v) => v?.status === "error" && v.liveTasks === 0,
    60,
    250,
  );
  r.check(
    "(C5 누수) %PDF 헤더 뒤 쓰레기 1KB → status error · liveTasks 0 · 실제로 읽었다(readCount ≥ 1)",
    bad?.status === "error" && bad.liveTasks === 0 && bad.readCount >= 1,
    J(bad && { status: bad.status, error: bad.error, live: bad.liveTasks, read: bad.readCount }),
  );

  // 상위 폴더가 없는 경로 — file_stamp 가 null 이 아니라 NOT_FOUND 로 reject 한다. 영구 loading 이면 빨개진다.
  const n0 = Date.now();
  await open(P.nodir);
  const nd = await until(
    () =>
      evalA(
        cdp,
        `const s = A.state(${J(P.nodir)}); const root = A.root(${J(P.nodir)}); const e = root && root.querySelector('[data-pdf-error]');
         return s ? { status: s.status, text: e ? e.textContent : null } : null;`,
      ),
    (v) => v?.status === "error" && (v.text || "").includes("찾을 수 없습니다"),
    n0,
    3000,
  );
  r.check(
    "(C5 부가) 없는 폴더의 pdf-e2e/nodir/x.pdf → 3초 안에 status error · [data-pdf-error] '찾을 수 없습니다'",
    nd.ok,
    `${nd.ms}ms ${J(nd.v)}`,
  );
}

/** 부가 — pdf.js TextLayerBuilder 전역 selection 리스너는 먼저 연 뷰어의 abortSignal 로 한 번만 설치된다.
 *
 *  명세는 "pane1 을 닫는다" 인데, 분할이 1칸으로 접히면 ViewerTab 트리 모양이 바뀌어(ViewerSplitView → ViewerLeafView)
 *  남은 pane2 까지 리마운트된다 — 그러면 전역 리스너가 새로 설치돼 결함이 재현되지 않는다(헛통과). 같은 조건
 *  (먼저 연 인스턴스 A 만 언마운트 · B 유지)을 pane1 의 파일을 txt 로 바꿔 만든다. B 의 핸들 id 불변을 전제로 단언한다. */
async function splitBlock({ cdp, r, open, gone, setView, PANE, CONTROL }) {
  await setView(PANE);
  await gone(P.jpx);
  await open(P.p12);
  const ra = await poll(
    () => evalA(cdp, `const s = A.state(${J(P.p12)}); return s ? { status: s.status, spans: A.spans(${J(P.p12)}, 1) } : null;`),
    (v) => v?.status === "ready" && v.spans > 0,
    80,
    250,
  );
  await cdp.eval(`(() => { const ui = window.__gpv.ui.getState(); ui.splitViewerPane(${J(PANE)}, 'col', false); return true; })()`);
  const pane2 = await poll(
    () => cdp.eval(`(() => { const s = window.__gpv.ui.getState(); return s.viewerActivePaneId !== ${J(PANE)} ? s.viewerActivePaneId : null; })()`),
    (v) => typeof v === "string",
    20,
    150,
  );
  await open(P.links);
  const rb = await poll(
    () => evalA(cdp, `const s = A.state(${J(P.links)}); return s ? { status: s.status, id: s.id, spans: A.spans(${J(P.links)}, 1) } : null;`),
    (v) => v?.status === "ready" && v.spans > 0,
    80,
    250,
  );
  await cdp.eval(`window.__gpv.ui.getState().setViewerActivePane(${J(PANE)})`);
  await open(CONTROL);
  const aGone = await gone(P.p12);
  const rb2 = await stateOf(cdp, P.links);
  if (ra?.status !== "ready" || !pane2 || rb?.status !== "ready" || aGone !== null || rb2?.id !== rb.id) {
    r.skip(
      "(부가) 먼저 연 인스턴스 언마운트 뒤 남은 인스턴스의 선택 해제·링크 클릭",
      `전제 실패 — A=${J(ra)} pane2=${pane2} B=${J(rb)} A언마운트=${aGone === null} B id ${rb?.id}→${rb2?.id}(바뀌면 전역 리스너가 새로 깔려 재현 불가)`,
    );
    return;
  }
  const spyReady = await poll(() => cdp.eval(`window.__gpv61spy.stamps`), (v) => v > 0, 20, 250);
  const pt = await evalA(
    cdp,
    `const sp = A.span(${J(P.links)}, 1, 'Link fixture'); if (!sp) return null; const b = A.box(sp); const hit = document.elementFromPoint(b.x, b.y); return Object.assign(b, { hit: !!hit && (hit === sp || sp.contains(hit)) });`,
  );
  const selecting = () => evalA(cdp, `return A.root(${J(P.links)}).querySelectorAll('.textLayer.selecting').length;`);
  let pressed = null;
  let released = null;
  if (pt?.hit) {
    await send(cdp, "Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y, button: "none", buttons: 0 });
    await send(cdp, "Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", buttons: 1, clickCount: 1 });
    pressed = await selecting();
    await send(cdp, "Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", buttons: 0, clickCount: 1 });
    released = await poll(selecting, (v) => v === 0, 5, 100);
    await cdp.eval(`(() => { document.getSelection().removeAllRanges(); return true; })()`);
  }
  r.check(
    "(부가) 먼저 연 인스턴스가 언마운트된 뒤 남은 인스턴스 텍스트를 눌렀다 떼면 .textLayer.selecting 이 500ms 안에 풀린다 · 반증: 누른 직후엔 ≥1",
    pt?.hit === true && pressed >= 1 && released === 0,
    `지점 ${J(pt)} · 누름 ${pressed} · 뗌 ${released}`,
  );
  const opened0 = await cdp.eval(`window.__gpv61spy.opened.length`);
  const clicks0 = await cdp.eval(`window.__gpv61m.clicks.length`);
  const link = await evalA(
    cdp,
    `const pg = A.page(${J(P.links)}, 1); const s = pg && Array.from(pg.querySelectorAll('.annotationLayer section.linkAnnotation')).sort((u, v) => u.getBoundingClientRect().top - v.getBoundingClientRect().top)[0]; return s ? A.box(s) : null;`,
  );
  if (link && spyReady > 0) await clickAt(cdp, link.x, link.y);
  await poll(() => cdp.eval(`window.__gpv61spy.opened.length`), (v) => v >= opened0 + 1, 12, 150);
  await sleep(300);
  const opened = await cdp.eval(`window.__gpv61spy.opened.slice()`);
  const clicks = await cdp.eval(`window.__gpv61m.clicks.slice(${clicks0})`);
  r.check(
    "(부가) 그 상태에서 https 링크 클릭 → openExternalUrl 스파이 +1 · defaultPrevented(pointer-events 가 selecting 에 막히지 않았다)",
    !!link && spyReady > 0 && opened?.length === opened0 + 1 && opened[opened0] === "https://gpv-e2e.invalid/ext" && clicks.some((c) => c.defaultPrevented),
    `스파이확인 stamps=${spyReady} · 호출 ${J(opened?.slice(opened0))} · 버블 ${J(clicks)}`,
  );
  await setView(PANE);
}

/** C3 + 부가(창 크기 · diff 0 · 썸네일 · 목차 · 내부 링크 · 중클릭) — 문서 창에서 한다(메인 웹뷰가 이동하면 러너가 죽는다). */
async function docBlock({ cdp, r, pid, cdpPort, CONTROL, docLabels }) {
  const labels = () =>
    cdp.eval(
      `(async () => { try { const m = await import(${J(WIN_API)}); return (await m.getAllWebviewWindows()).map((w) => w.label); } catch (e) { return []; } })()`,
    );
  const openDoc = async (path) => {
    const before = (await labels()) || [];
    await cdp.eval(`window.__gpv.openDocWindow(${J(pid)}, ${J(path)})`); // size 생략 — 호출부 기본 경로
    const label = await poll(
      async () => ((await labels()) || []).find((l) => l.startsWith("doc-") && !before.includes(l)) ?? null,
      (v) => !!v,
      20,
      500,
    );
    if (label) docLabels.push(label);
    return label;
  };
  const queryDiff = (c, path) =>
    c.eval(`(() => {
      const qc = window.__gpv && window.__gpv.docQueryClient;
      if (!qc) return { hook: false };
      const q = qc.getQueryCache().find({ queryKey: ['diff', ${J(pid)}, ${J(`f:${path}`)}] });
      return { hook: true, exists: !!q, dataUpdateCount: q ? q.state.dataUpdateCount : null, errorUpdateCount: q ? q.state.errorUpdateCount : null, fetchStatus: q ? q.state.fetchStatus : null };
    })()`);

  const p = P.links;
  const label = await openDoc(p);
  if (!r.check("(C3) links.pdf 문서 창(doc-*) 생성", !!label, label || "미발견")) return;
  let dc = null;
  try {
    dc = await connectLabel(label, { port: cdpPort }).catch((e) => {
      r.check("(C3) 문서 창 CDP 연결", false, e.message);
      return null;
    });
    if (!dc) return;
    await poll(() => dc.eval(`!!(window.__gpv && window.__gpv.ui)`), (v) => v === true, 20, 250);
    if (!r.check("(C3) 문서 창 페이지 헬퍼 설치", (await dc.eval(HELPERS)) === true)) return;
    const rd = await waitReady(dc, p);
    if (!r.check("(C3) 문서 창 PdfView 준비", rd?.status === "ready", J(rd?.s?.error ?? rd?.status))) return;

    const size = await dc.eval(`[window.innerWidth, window.innerHeight]`);
    await sleep(800);
    const pdfDiff = await queryDiff(dc, p);
    const hookInDoc = await dc.eval(`typeof (window.__gpv && window.__gpv.pdf && window.__gpv.pdf.byPath)`);
    r.check(
      "(C7 누출 반증) dev 문서 창에는 __gpv.pdf.byPath 가 있다 — prod 의 'typeof __gpv === undefined' 가 창 종류 탓이 아니라는 증거",
      hookInDoc === "function",
      `typeof=${hookInDoc}`,
    );

    const spy = await dc.eval(SPY).catch((e) => ({ err: e.message }));
    const stamps = await poll(() => dc.eval(`window.__gpv61spy ? window.__gpv61spy.stamps : -1`), (v) => v > 0, 20, 250);
    if (
      !r.check(
        "(C3) 문서 창 ipc 스파이가 이 창의 PdfView 가 쓰는 ipc 객체에 걸렸다(fileStamp 폴링 관측) — 확인 전에는 링크를 누르지 않는다",
        !!spy?.url && spy.missing?.length === 0 && stamps > 0,
        `${J(spy)} stamps=${stamps}`,
      )
    )
      return;
    await dc.eval(`(() => {
      const rec = [];
      window.__gpv61s = { href: location.href, t0: performance.timeOrigin, rec };
      const on = (e) => { const a = e.target && e.target.closest ? e.target.closest('a') : null; rec.push({ type: e.type, button: e.button, defaultPrevented: e.defaultPrevented, href: a ? a.getAttribute('href') : null }); };
      window.addEventListener('click', on);
      window.addEventListener('auxclick', on);
      return true;
    })()`);
    const nav0 = await dc.eval(`({ href: location.href, t0: performance.timeOrigin })`);
    const secs = await poll(() => dc.eval(LINK_SECTIONS), (v) => Array.isArray(v) && v.length === 5, 20, 250);
    if (!r.check("(C3) 1쪽 링크 섹션 5개(https · ftp · js-uri · js-action · internal) — 섹션이 있어야 '아무 일도 없음'이 헛클릭이 아니다", secs?.length === 5, J(secs)))
      return;
    const [https, ftp, jsUri, jsAct, internal] = secs;
    const snapDoc = () =>
      dc.eval(`(() => {
        const s = window.__gpv.pdf.byPath(${J(p)}).state();
        return { opened: window.__gpv61spy.opened.slice(), links: s.links, rec: window.__gpv61s.rec.slice(), page: s.currentPage, fired: typeof window.__gpvJsFired, href: location.href, t0: performance.timeOrigin };
      })()`);

    await clickAt(dc, https.x, https.y);
    await poll(snapDoc, (v) => v?.opened?.length >= 1, 12, 150);
    await sleep(300); // "정확히 1회" — 늦게 오는 중복 호출(click+auxclick 이중 처리 등)까지 본 뒤 판정한다
    const a1 = await snapDoc();
    const httpsRec = (a1?.rec || []).filter((x) => x.type === "click" && x.href === "https://gpv-e2e.invalid/ext");
    r.check(
      "(C3) https 링크 실제 클릭 → openExternalUrl 정확히 1회('https://gpv-e2e.invalid/ext') · 버블 click defaultPrevented · links {allowed:true} · 반증: 허공 클릭이면 호출·기록 둘 다 0",
      J(a1?.opened) === J(["https://gpv-e2e.invalid/ext"]) &&
        httpsRec.length === 1 &&
        httpsRec[0].defaultPrevented === true &&
        a1.links.some((l) => l.href === "https://gpv-e2e.invalid/ext" && l.allowed === true),
      `${J(a1?.opened)} · 버블 ${J(httpsRec)} · links ${J(a1?.links)}`,
    );

    await clickAt(dc, ftp.x, ftp.y);
    await sleep(400);
    const a2 = await snapDoc();
    r.check(
      "(C3) ftp 링크 클릭 → 스파이 증가 0 · links {allowed:false}(JS 1차 허용목록) · 기본 동작도 막힘",
      a2?.opened?.length === 1 &&
        a2.links.some((l) => l.href === "ftp://gpv-e2e.invalid/f" && l.allowed === false) &&
        a2.rec.some((x) => x.href === "ftp://gpv-e2e.invalid/f" && x.defaultPrevented === true),
      `opened ${J(a2?.opened)} · links ${J(a2?.links)}`,
    );

    const jsProbe = async (sec) => {
      const pre = await dc.eval(`(() => {
        const e = document.elementFromPoint(${sec.x}, ${sec.y});
        const s = e && e.closest('section');
        return { inSection: !!s && s.getAttribute('data-annotation-id') === ${J(sec.id)}, anchors: ${sec.anchors} };
      })()`);
      await clickAt(dc, sec.x, sec.y);
      await sleep(400);
      return { pre, after: await snapDoc() };
    };
    const j1 = await jsProbe(jsUri);
    const j2 = await jsProbe(jsAct);
    r.check(
      "(C3) javascript: URI · JavaScript 액션 링크 — 클릭 지점이 그 section 안 · section 에 <a> 0 · 스파이 증가 0 · window.__gpvJsFired 없음",
      [j1, j2].every((j) => j.pre?.inSection === true && j.pre.anchors === 0 && j.after?.opened?.length === 1 && j.after.fired === "undefined"),
      J([j1, j2].map((j) => ({ pre: j.pre, opened: j.after?.opened?.length, fired: j.after?.fired }))),
    );

    // 중클릭(auxclick) — 새 창·탭으로 새지 않고 같은 opener 로 간다.
    const targets0 = await pageTargets(cdpPort);
    await clickAt(dc, https.x, https.y, "middle");
    await poll(snapDoc, (v) => v?.opened?.length >= 2, 12, 150);
    await sleep(600);
    const a3 = await snapDoc();
    const targets1 = await pageTargets(cdpPort);
    r.check(
      "(C3 부가) https 링크 중클릭 → 스파이 +1 · location.href 불변 · CDP 페이지 대상 수 불변(새 창 없음)",
      a3?.opened?.length === 2 && a3.opened[1] === "https://gpv-e2e.invalid/ext" && a3.href === nav0.href && targets0 !== null && targets1 === targets0,
      `opened ${J(a3?.opened)} · 대상 ${targets0} → ${targets1}`,
    );

    await clickAt(dc, internal.x, internal.y);
    const a4 = await poll(snapDoc, (v) => v?.page === 3, 20, 150);
    r.check(
      "(C3 대조) 내부 링크(/Dest /chap3) 클릭 → currentPage 3 · href 불변 — 가로채기가 모든 앵커를 막는 과잉 차단이 아니다",
      a4?.page === 3 && a4.href === nav0.href,
      `page ${a4?.page} · href ${a4?.href === nav0.href}`,
    );
    const navEnd = await dc.eval(`({ href: location.href, t0: performance.timeOrigin, sentinel: !!window.__gpv61s })`);
    r.check(
      "(C3) 링크 전부 누른 뒤 location.href · performance.timeOrigin · 페이지 sentinel 모두 불변(웹뷰가 이동하지 않았다)",
      navEnd?.href === nav0.href && navEnd.t0 === nav0.t0 && navEnd.sentinel === true,
      `${J(nav0)} → ${J(navEnd)}`,
    );

    // 링크 앵커를 끌어 웹뷰에 떨어뜨리면 그 URL 로 이동할 수 있다 — 캡처 dragstart 가 앵커만 막는다.
    // 반증: 같은 페이지 텍스트 span 의 dragstart 는 막지 않는다(모든 드래그를 막는 과잉 차단이 아니다).
    const drag = await evalA(
      dc,
      `const pg = A.page(${J(p)}, 1); if (!pg) return null;
       const a = Array.from(pg.querySelectorAll('.annotationLayer a')).find((x) => x.getAttribute('href') === 'https://gpv-e2e.invalid/ext');
       const sp = pg.querySelector('.textLayer span');
       const fire = (el) => { if (!el) return null; const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true }); el.dispatchEvent(ev); return ev.defaultPrevented; };
       return { link: fire(a), text: fire(sp) };`,
    );
    r.check(
      "(C3 부가) https 링크 앵커의 dragstart → defaultPrevented · 반증: 같은 페이지 텍스트 span 의 dragstart 는 막히지 않는다",
      drag?.link === true && drag.text === false,
      J(drag),
    );

    // 썸네일·목차 — 클릭 전 페이지가 목표와 달라야 한다. 클릭 eval 결과(찾음·연결됨)와 pagechanging 이력을 detail 에 싣는다
    // — 간헐 실패가 '리마운트로 떨어진 노드를 눌렀다' 인지 '이동했다가 되돌아갔다' 인지 가르기 위해서다(판정 조건은 그대로).
    await evalA(
      dc,
      `const h = A.handle(${J(p)}); window.__gpv61pages = [];
       if (!window.__gpv61pagesOn) { window.__gpv61pagesOn = (e) => window.__gpv61pages.push(e.pageNumber); h.eventBus().on('pagechanging', window.__gpv61pagesOn); }
       return true;`,
    );
    const pageHist = () => dc.eval(`(window.__gpv61pages || []).splice(0)`).catch(() => null);
    const clickEl = (sel, text) =>
      evalA(
        dc,
        `const els = Array.from(A.root(${J(p)}).querySelectorAll(${J(sel)}));
         const b = ${text ? `els.find((x) => (x.textContent || '').trim() === ${J(text)})` : "els[0]"};
         if (!b) return { found: false };
         const connected = b.isConnected; b.click(); return { found: true, connected };`,
      );
    // 사이드바를 연 **직후**(리사이즈가 정리되기 전) 누른다 — 사람이 곧바로 누르는 경로이고, ResizeObserver 의
    // 프리셋 재대입이 옛 _location 으로 되감던 경합(PdfView update() 수정)을 잡는 자리다. 안정 대기를 넣으면 이 회귀가 숨는다.
    // 판정: 클릭 **직전** 페이지 ≠ 목표 · 목표 도달 · 700ms 뒤에도 목표 유지(되감김 검출).
    await evalA(dc, `const b = A.root(${J(p)}).querySelector('[data-pdf-sidebar-toggle]'); if (b) b.click(); return !!b;`);
    const thumbs = await poll(
      () => evalA(dc, `return A.root(${J(p)}).querySelectorAll('[data-pdf-thumb]').length;`),
      (v) => v === 3,
      20,
      250,
    );
    await pageHist();
    const before2 = (await stateOf(dc, p))?.currentPage;
    const click2 = await clickEl('[data-pdf-thumb="2"]');
    const at2 = await poll(() => stateOf(dc, p), (v) => v?.currentPage === 2, 20, 150);
    await sleep(700);
    const hold2 = (await stateOf(dc, p))?.currentPage;
    const hist2 = await pageHist();
    r.check(
      "(부가) 사이드바 토글 직후 [data-pdf-thumb] 3개 · 2번 클릭 → currentPage 2 · 700ms 뒤에도 2(리사이즈 되감김 없음) · 클릭 직전 ≠ 2",
      before2 !== 2 && thumbs === 3 && at2?.currentPage === 2 && hold2 === 2,
      `직전 ${before2} · 썸네일 ${thumbs} · 클릭 ${J(click2)} · 도달 ${at2?.currentPage} · 700ms 뒤 ${hold2} · pagechanging ${J(hist2)}`,
    );
    await evalA(dc, `const b = A.root(${J(p)}).querySelector('[data-pdf-sidebar-tab="outline"]'); if (b) b.click(); return !!b;`);
    const items = await poll(
      () => evalA(dc, `return Array.from(A.root(${J(p)}).querySelectorAll('[data-pdf-outline-item]')).map((b) => (b.textContent || '').trim());`),
      (v) => Array.isArray(v) && v.length === 2,
      20,
      250,
    );
    await pageHist();
    const before3 = (await stateOf(dc, p))?.currentPage;
    const click3 = await clickEl("[data-pdf-outline-item]", "Chapter 3");
    const at3 = await poll(() => stateOf(dc, p), (v) => v?.currentPage === 3, 20, 150);
    await sleep(700);
    const hold3 = (await stateOf(dc, p))?.currentPage;
    const hist3 = await pageHist();
    const scroll3 = await evalA(dc, `const el = A.scroll(${J(p)}); return el ? { top: el.scrollTop, h: el.scrollHeight, scaleValue: A.state(${J(p)}).scaleValue } : null;`);
    r.check(
      "(부가) 목차 탭 → 항목 ['Chapter 1','Chapter 3'] · 'Chapter 3' 클릭 → currentPage 3 · 700ms 뒤에도 3 · 클릭 직전 ≠ 3",
      before3 !== 3 && J(items) === J(["Chapter 1", "Chapter 3"]) && at3?.currentPage === 3 && hold3 === 3 && click3?.found === true,
      `직전 ${before3} · 항목 ${J(items)} · 클릭 ${J(click3)} · 도달 ${at3?.currentPage} · 700ms 뒤 ${hold3} · pagechanging ${J(hist3)} · 스크롤 ${J(scroll3)}`,
    );
    await evalA(
      dc,
      `const h = A.handle(${J(p)}); if (h && window.__gpv61pagesOn) h.eventBus().off('pagechanging', window.__gpv61pagesOn); delete window.__gpv61pagesOn; delete window.__gpv61pages; return true;`,
    ).catch(() => {});

    // ── txt 문서 창 반증 — 기본 크기 900×760 · diff 쿼리가 실제로 채워진다 ─────────────────────────────
    let txtSize = null;
    let txtDiff = null;
    const tLabel = await openDoc(CONTROL);
    if (tLabel) {
      const tc = await connectLabel(tLabel, { port: cdpPort }).catch(() => null);
      if (tc) {
        try {
          await poll(() => tc.eval(`!!(window.__gpv && window.__gpv.docQueryClient)`), (v) => v === true, 20, 250);
          txtSize = await tc.eval(`[window.innerWidth, window.innerHeight]`);
          txtDiff = await poll(() => queryDiff(tc, CONTROL), (v) => v?.dataUpdateCount >= 1, 30, 250);
        } finally {
          tc.close();
        }
      }
      await closeDoc(cdp, tLabel);
    }
    const within2 = (v, w, h) => Array.isArray(v) && Math.abs(v[0] - w) <= 2 && Math.abs(v[1] - h) <= 2;
    r.check(
      "(부가) PDF 문서 창을 size 없이 열면 1180±2 × 860±2 · 반증: 같은 호출의 txt 문서 창은 900±2 × 760±2(Rust 기본값)",
      within2(size, 1180, 860) && within2(txtSize, 900, 760),
      `pdf ${J(size)} · txt ${J(txtSize)}`,
    );
    // errorUpdateCount 도 0 이어야 한다 — 게이트가 없어져도 프리페치 get_file_diff 가 reject(부팅 직후 IPC 유실·타임아웃)되면
    // dataUpdateCount 0 · idle 로 통과해 버린다. 문서 창엔 부팅 시점 스파이가 없어 이 쿼리 상태가 유일한 증거다.
    const pdfDiffOk =
      pdfDiff?.hook === true &&
      (!pdfDiff.exists || (pdfDiff.dataUpdateCount === 0 && pdfDiff.errorUpdateCount === 0 && pdfDiff.fetchStatus === "idle"));
    const txtCounter = txtDiff?.hook === true && txtDiff.dataUpdateCount >= 1;
    r.check(
      "(부가) 문서 창 diff 0 — docQueryClient 의 ['diff',pid,'f:<pdf>'] 가 없거나 dataUpdateCount 0 · errorUpdateCount 0 · idle · 반증: 같은 방식의 txt 문서 창은 dataUpdateCount ≥ 1",
      pdfDiffOk && txtCounter,
      `pdf ${J(pdfDiff)} · txt ${J(txtDiff)}`,
    );
  } finally {
    if (dc) {
      await dc.eval(UNSPY).catch(() => {});
      dc.close();
    }
    await closeDoc(cdp, label);
  }
}

/** 문서 창 닫기 + localStorage(gp:doc-windows) 기록 제거 — dev·prod 공용(label 로 닫는 창 플러그인 커맨드). */
async function closeDoc(cdp, label) {
  if (!label) return;
  await cdp.try("plugin:window|close", { label }, { timeoutMs: 5000 });
  await cdp
    .eval(
      `(() => { try { const k = 'gp:doc-windows'; const v = JSON.parse(localStorage.getItem(k) || '{}'); delete v[${J(label.slice("doc-".length))}]; localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } })()`,
    )
    .catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// prod 모드 — C7
// ═══════════════════════════════════════════════════════════════════════════════════════════════
async function prodMode({ cdp, r, fix, cdpPort }) {
  const origin = await cdp.eval(`location.origin`).catch(() => null);
  if (
    !r.check(
      "(C7) prod 모드 — __gpv 없는 창의 origin 이 http://tauri.localhost 다",
      origin === "http://tauri.localhost",
      `origin=${origin} — dev 훅도 없고 앱 프로토콜도 아니면 엉뚱한 앱·빌드에 붙은 것이다(skip 이 아니라 실패)`,
    )
  )
    return;

  // ── 누출: dist 번들에 DEV 블록 고유 토큰이 없다 ──────────────────────────────────────────────────
  // '__gpv' 는 lsp/sync.ts 가 DEV 가드 없이 __gpvLsp 를 쓰므로 PDF 와 무관하게 남는다 → 토큰을 좁힌다.
  const distDir = join(ROOT, "dist", "assets");
  const jsFiles = existsSync(distDir) ? readdirSync(distDir).filter((f) => f.endsWith(".js")) : [];
  const bodies = jsFiles.map((f) => readFileSync(join(distDir, f), "utf8"));
  const hits = (tok) => jsFiles.filter((_, i) => bodies[i].includes(tok));
  const src = ["src/components/pdf/PdfView.tsx", "src/lib/pdf/pdfjs.ts"].map((f) => {
    try {
      return readFileSync(join(ROOT, f), "utf8");
    } catch {
      return "";
    }
  });
  const inSrc = (tok) => src.some((s) => s.includes(tok));
  if (!jsFiles.length) {
    r.skip("(C7 누출) dist 번들 토큰 0", `관측 불가 — ${distDir} 에 .js 가 없다(prod 빌드 산출물 없음)`);
  } else {
    const grepWorks = hits("getDocument").length > 0;
    r.check(
      "(C7 누출) dist/assets/*.js 에 'pdfOpts' · 'byPath' 0건 · 반증: 두 토큰이 소스(PdfView.tsx·pdfjs.ts)에 있고, 같은 grep 이 번들의 'getDocument' 는 찾는다",
      hits("pdfOpts").length === 0 && hits("byPath").length === 0 && inSrc("pdfOpts") && inSrc("byPath") && grepWorks,
      `pdfOpts ${J(hits("pdfOpts"))} · byPath ${J(hits("byPath"))} · 소스 pdfOpts=${inSrc("pdfOpts")} byPath=${inSrc("byPath")} · getDocument grep=${grepWorks} · js ${jsFiles.length}개`,
    );
  }
  const workerGlobalInBundle = grepFile(join(ROOT, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"), "globalThis.pdfjsWorker");

  let F;
  try {
    F = buildFixtures();
  } catch (e) {
    r.check("(C7) 픽스처 생성", false, e.message);
    return;
  }
  mkdirSync(join(fix.repo, DIR), { recursive: true });
  writeFileSync(join(fix.repo, P.kr), F.kr);
  writeFileSync(join(fix.repo, P.jpx), F.jpx);

  const labels = [];
  try {
    for (const doc of [
      { path: P.kr, tag: "kr-uhc" },
      { path: P.jpx, tag: "jpx" },
    ]) {
      const id = randomBytes(16).toString("hex");
      const label = `doc-${id}`;
      labels.push(label);
      // openDocWindow 와 같은 두 단계 — 대상은 localStorage, 창은 Rust 커맨드.
      await cdp.eval(`(() => {
        const k = 'gp:doc-windows';
        const v = JSON.parse(localStorage.getItem(k) || '{}');
        v[${J(id)}] = { projectId: ${J(fix.projectId)}, path: ${J(doc.path)} };
        localStorage.setItem(k, JSON.stringify(v));
        return true;
      })()`);
      const inv = await cdp.try("open_doc_window", {
        docId: id,
        title: doc.path.split("/").pop(),
        origin,
        size: [1180, 860],
      });
      if (!r.check(`(C7) ${doc.tag}: open_doc_window`, inv.ok, inv.ok ? label : `${inv.code} ${inv.message}`)) continue;
      const dc = await connectLabel(label, { port: cdpPort }).catch((e) => {
        r.check(`(C7) ${doc.tag}: 문서 창 CDP 연결`, false, e.message);
        return null;
      });
      if (!dc) continue;
      try {
        await dc.eval(HELPERS);
        const loaded = await poll(() => evalA(dc, `return A.loaded(${J(doc.path)}, 1);`), (v) => v === true, 60, 500);
        if (!r.check(`(C7) ${doc.tag}: 1쪽 캔버스 data-loaded`, loaded === true)) continue;

        if (doc.path === P.kr) {
          const t = await poll(() => evalA(dc, `return A.text(${J(doc.path)}, 1);`), (v) => (v || "").includes("가나다"), 20, 250);
          r.check("(C7) kr-uhc: 앱 WebView2 에서 비임베드 한글 textLayer 에 '가나다'(cMap 서빙 경로)", (t || "").includes("가나다"), J(t));
        } else {
          const px = await poll(
            () =>
              evalA(
                dc,
                `const p = ${J(doc.path)}; return { red: A.rgbPdf(p, 1, 197, 600), blue: A.rgbPdf(p, 1, 397, 600), white: A.rgbPdf(p, 1, 50, 50) };`,
              ),
            (v) => near(v?.red, [220, 20, 20]) && near(v?.blue, [20, 20, 220]),
            40,
            125,
          );
          r.check(
            "(C7) jpx: (197,600)pt ≈ (220,20,20) · (397,600) ≈ (20,20,220) · 반증: 이미지 밖 (50,50) 흰색 (±24)",
            near(px?.red, [220, 20, 20]) && near(px?.blue, [20, 20, 220]) && near(px?.white, [255, 255, 255]),
            J(px),
          );
        }

        const pw = await dc.eval(`typeof globalThis.pdfjsWorker`);
        r.check(
          `(C7) ${doc.tag}: 워커가 페이지 스레드로 폴백하지 않았다(globalThis.pdfjsWorker 없음) · 반증: 워커 번들이 그 전역을 만든다`,
          pw === "undefined" && workerGlobalInBundle === true,
          `typeof=${pw} · 번들 grep=${workerGlobalInBundle}`,
        );
        const gpv = await dc.eval(`typeof window.__gpv`);
        r.check(`(C7 누출) ${doc.tag}: 문서 창 typeof window.__gpv === 'undefined'`, gpv === "undefined", `typeof=${gpv}`);

        const csp = await dc.eval(CSP_PROBE, { timeoutMs: 15000 }).catch((e) => ({ err: e.message, reports: [] }));
        const ctrl = (csp.reports || []).filter((x) => x.blocked === "eval");
        const others = (csp.reports || []).filter((x) => x.blocked !== "eval");
        if (!csp.evalThrew || ctrl.length === 0) {
          r.skip(
            `(C7) ${doc.tag}: 대조 외 CSP 위반 0건`,
            `양성 대조 미관측 — eval 차단=${csp.evalThrew}(${csp.evalName}) · 대조 보고 ${ctrl.length}건 · ReportingObserver 미지원=${csp.unsupported} ${csp.err ?? ""} — 이 창에 CSP 가 걸렸는지 알 수 없다. 대안: CDP Log.enable 버퍼 재생`,
          );
        } else {
          r.check(
            `(C7) ${doc.tag}: 페이지 CSP 위반 = eval 양성 대조 1건뿐(그 외 0건)`,
            ctrl.length === 1 && others.length === 0,
            J(csp.reports),
          );
        }
        r.info(`C7 ${doc.tag}: 워커 CSP 는 판정하지 않는다(워커 스크립트 응답엔 헤더가 없을 가능성 — 추정). JPX 픽셀·nowasm 서빙으로 대체`);
      } finally {
        dc.close();
      }
    }
  } finally {
    for (const label of labels) await closeDoc(cdp, label);
    try {
      rmSync(join(fix.repo, DIR), { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* teardown 이 픽스처째 지운다 */
    }
  }
}
