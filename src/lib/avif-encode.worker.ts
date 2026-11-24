// 메모 이미지의 AVIF 인코딩·디코딩 Worker. 메인 스레드에서 돌리면 스크린샷 한 장에 수 초씩 UI 가 멈춘다
// (실측: DOCS/memo-todo-category-image-design.md §7.2). 요청·응답 타입은 memo-image-pipeline.ts 와 짝이다.
//
// **jsquash(WASM)는 이 Worker 안에서만 부른다.** 릴리스의 문서 CSP 에는 'wasm-unsafe-eval' 이 없다 —
// 같은 출처 파일로 만든 전용 Worker 는 자기 응답 헤더로 정책을 만들어 그 CSP 를 물려받지 않지만,
// 메인 스레드에서 부르거나 blob:/inline Worker 로 만들면 물려받아 릴리스에서만 조용히 막힌다(§7.5).

import decode from "@jsquash/avif/decode";
import encode from "@jsquash/avif/encode";

export type AvifWorkerRequest =
  | {
      seq: number;
      kind: "encode";
      rgba: ArrayBuffer;
      width: number;
      height: number;
      quality: number;
      speed: number;
    }
  | { seq: number; kind: "decode"; bytes: ArrayBuffer };

export type AvifWorkerResponse =
  | { seq: number; ok: true; kind: "encode"; bytes: ArrayBuffer }
  | { seq: number; ok: true; kind: "decode"; rgba: ArrayBuffer; width: number; height: number }
  | { seq: number; ok: false; error: string };

// 이 프로젝트의 tsconfig 는 DOM lib 만 쓴다 — Worker 전역 타입 대신 Window 와 겹치는 모양(onmessage,
// postMessage(data, { transfer }))만 써서 lib 를 늘리지 않는다. 런타임은 DedicatedWorkerGlobalScope 다.
const reply = (msg: AvifWorkerResponse, transfer: Transferable[] = []) =>
  self.postMessage(msg, { transfer });

self.onmessage = async (e: MessageEvent<AvifWorkerRequest>) => {
  const req = e.data;
  try {
    if (req.kind === "encode") {
      // jsquash 는 data.buffer 를 통째로 읽는다(byteOffset 무시) — 버퍼 전체를 덮는 새 뷰로 넘긴다.
      const pixels = new ImageData(new Uint8ClampedArray(req.rgba), req.width, req.height);
      const bytes = await encode(pixels, { quality: req.quality, speed: req.speed });
      reply({ seq: req.seq, ok: true, kind: "encode", bytes }, [bytes]);
    } else {
      const pixels = await decode(req.bytes);
      if (!pixels) throw new Error("AVIF decode returned no image");
      // 디코더가 준 버퍼가 뷰보다 클 수 있다 — 픽셀 범위만 잘라 보낸다.
      const rgba = pixels.data.buffer.slice(
        pixels.data.byteOffset,
        pixels.data.byteOffset + pixels.data.byteLength,
      );
      reply(
        { seq: req.seq, ok: true, kind: "decode", rgba, width: pixels.width, height: pixels.height },
        [rgba],
      );
    }
  } catch (err) {
    reply({ seq: req.seq, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
