// AVIF 인코딩·디코딩 Worker(avif-encode.worker.ts)를 부르는 쪽 — 메모 이미지와 "AVIF로 변환"이 같이 쓴다.
//
// jsquash(WASM)를 메인 스레드에서 부르지 않는 이유가 둘이다. (1) 단일 스레드 인코더라 스크린샷 한 장에 수 초씩
// UI 가 멈춘다. (2) 릴리스의 문서 CSP 에 'wasm-unsafe-eval' 이 없어 메인 스레드의 WASM 컴파일은 **거절된다**
// (2026-11-24 프로덕션 번들 + 같은 CSP 로 WebView2 에서 확인 — DOCS/memo-todo-category-image-design.md §7.5).
// 같은 출처 파일로 만든 전용 Worker 는 자기 응답 헤더로 정책을 만들어 그 CSP 를 물려받지 않는다.

import type { AvifWorkerRequest, AvifWorkerResponse } from "./avif-encode.worker";

// WASM 메모리는 늘기만 하고 줄지 않는다. 메모장이 뜨는 창이 둘이라 안 끄면 창마다 인코더 힙이 상주한다.
const WORKER_IDLE_MS = 30_000;

type EncodeReply = Extract<AvifWorkerResponse, { ok: true; kind: "encode" }>;
type DecodeReply = Extract<AvifWorkerResponse, { ok: true; kind: "decode" }>;
type AvifWorkerJob =
  | Omit<Extract<AvifWorkerRequest, { kind: "encode" }>, "seq">
  | Omit<Extract<AvifWorkerRequest, { kind: "decode" }>, "seq">;

let worker: Worker | null = null;
let workerIdleTimer: ReturnType<typeof setTimeout> | undefined;
let workerSeq = 0;
const workerWaiting = new Map<
  number,
  { resolve: (r: AvifWorkerResponse) => void; reject: (e: Error) => void }
>();

function stopWorker(reason: string) {
  worker?.terminate();
  worker = null;
  clearTimeout(workerIdleTimer);
  for (const w of workerWaiting.values()) w.reject(new Error(reason));
  workerWaiting.clear();
}

function avifWorker(): Worker {
  if (worker) return worker;
  // `new URL(..., import.meta.url)` 꼴이어야 Vite 가 Worker 를 별도 파일로 낸다. `?worker&inline` 이나 blob: 로
  // 만들면 문서 CSP 를 물려받아 릴리스에서 WASM 컴파일이 막힌다(위 머리 주석).
  const w = new Worker(new URL("./avif-encode.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<AvifWorkerResponse>) => {
    const waiting = workerWaiting.get(e.data.seq);
    workerWaiting.delete(e.data.seq);
    waiting?.resolve(e.data);
    if (workerWaiting.size === 0) {
      clearTimeout(workerIdleTimer);
      workerIdleTimer = setTimeout(() => stopWorker("idle"), WORKER_IDLE_MS);
    }
  };
  // 스크립트 로드 실패·WASM 초기화 중 예외 — 기다리는 요청이 영원히 매달리지 않게 전부 실패로 돌린다.
  w.onerror = (e) => stopWorker(e.message || "AVIF worker failed");
  worker = w;
  return w;
}

async function callAvifWorker(job: AvifWorkerJob, transfer: Transferable[]): Promise<AvifWorkerResponse> {
  const w = avifWorker();
  clearTimeout(workerIdleTimer);
  const seq = ++workerSeq;
  const reply = await new Promise<AvifWorkerResponse>((resolve, reject) => {
    workerWaiting.set(seq, { resolve, reject });
    w.postMessage({ ...job, seq }, transfer);
  });
  if (!reply.ok) throw new Error(reply.error);
  return reply;
}

/**
 * RGBA 픽셀 → AVIF 바이트. **`rgba` 는 Worker 로 넘어간다(transfer)** — 부른 쪽에서는 그 뒤로 빈 버퍼다.
 * quality 0–100, speed 0(느리고 작음)–10(빠르고 큼).
 */
export async function encodeAvifInWorker(
  rgba: ArrayBuffer,
  width: number,
  height: number,
  quality: number,
  speed: number,
): Promise<ArrayBuffer> {
  const reply = (await callAvifWorker({ kind: "encode", rgba, width, height, quality, speed }, [
    rgba,
  ])) as EncodeReply;
  return reply.bytes;
}

/** AVIF 바이트 → RGBA 픽셀. **`bytes` 는 Worker 로 넘어간다(transfer)** — 남과 같이 쓰는 버퍼면 복사해서 넘겨라. */
export async function decodeAvifInWorker(
  bytes: ArrayBuffer,
): Promise<{ rgba: ArrayBuffer; width: number; height: number }> {
  const reply = (await callAvifWorker({ kind: "decode", bytes }, [bytes])) as DecodeReply;
  return { rgba: reply.rgba, width: reply.width, height: reply.height };
}
