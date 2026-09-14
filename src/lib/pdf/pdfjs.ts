// pdf.js 로더 — 앱 전체에서 pdfjs-dist를 런타임 import 하는 유일한 파일이다(나머지는 `import type`).
//
// 정적 import 한 줄이면 DiffViewer 유휴 선로딩(main.tsx)을 타고 pdf.js가 앱 시작마다 실린다.
// 순서도 계약이다: pdf_viewer.mjs는 모듈 평가 시점에 globalThis.pdfjsLib를 읽으므로 그 전에 대입한다.
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask, PDFWorker } from "pdfjs-dist/legacy/build/pdf.mjs";

export type PdfLib = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
export type PdfViewerLib = typeof import("pdfjs-dist/legacy/web/pdf_viewer.mjs");

export interface PdfDocOpts {
  cMapUrl: string | null;
  cMapPacked: boolean;
  standardFontDataUrl: string | null;
  wasmUrl: string | null;
  useWasm: boolean;
  enableXfa: boolean;
}

export interface Pdfjs {
  lib: PdfLib;
  viewer: PdfViewerLib;
  /** data의 버퍼는 워커로 transfer된다 — 호출 뒤 쓰지 마라. */
  open(data: Uint8Array, password?: string): { task: PDFDocumentLoadingTask; opts: PdfDocOpts };
  workerKind(): "worker" | "fake" | "pending";
}

// 절대 URL + 끝 슬래시 필수. 상대경로면 워커 안의 fetch/import가 워커 스크립트 기준으로 풀린다.
const ASSET = new URL("/pdfjs/", location.href).href;

let loading: Promise<Pdfjs> | null = null;
// 창당 1개 공유 워커 — 절대 destroy 하지 않는다. getDocument에 `worker`로 넘기면 task가 소유하지
// 않으므로(task._worker=null) task.destroy()가 워커를 죽이지 않는다. 자체 워커를 쓰면 destroy 도중
// 다른 getDocument가 'the worker is being destroyed'로 throw 한다(StrictMode·분할 4칸·Git 모달).
let worker: PDFWorker | null = null;

export function loadPdfjs(): Promise<Pdfjs> {
  loading ??= init().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

async function init(): Promise<Pdfjs> {
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  (globalThis as { pdfjsLib?: unknown }).pdfjsLib = lib;
  lib.GlobalWorkerOptions.workerSrc = workerUrl;
  // 타입 선언은 name을 null로만 적어 두었다(JSDoc 생성 오류) — 런타임은 문자열을 받는다.
  worker ??= new lib.PDFWorker({ name: "gpv-pdf" as unknown as null });
  const w = worker;
  const viewer = await import("pdfjs-dist/legacy/web/pdf_viewer.mjs");

  return {
    lib,
    viewer,
    open(data, password) {
      const merged = {
        cMapUrl: ASSET + "cmaps/",
        cMapPacked: true,
        standardFontDataUrl: ASSET + "standard_fonts/",
        wasmUrl: ASSET + "wasm/",
        useWasm: false,
        enableXfa: false,
        // e2e 반증 입력(예: {cMapUrl:null}) — prod 빌드에서는 분기째 제거된다.
        ...(import.meta.env.DEV
          ? (window as unknown as { __gpv?: { pdfOpts?: { doc?: Record<string, unknown> } } })
              .__gpv?.pdfOpts?.doc
          : undefined),
      } as PdfDocOpts;
      const opts: PdfDocOpts = {
        cMapUrl: merged.cMapUrl,
        cMapPacked: merged.cMapPacked,
        standardFontDataUrl: merged.standardFontDataUrl,
        wasmUrl: merged.wasmUrl,
        useWasm: merged.useWasm,
        enableXfa: merged.enableXfa,
      };
      // isEvalSupported는 넘기지 않는다 — 6.3.289 getDocument에 그런 옵션이 없다.
      const params = { ...merged, data, password, worker: w };
      return { task: lib.getDocument(params as Parameters<PdfLib["getDocument"]>[0]), opts };
    },
    workerKind() {
      const port: unknown = w.port;
      if (!port) return "pending";
      return port instanceof Worker ? "worker" : "fake";
    },
  };
}
