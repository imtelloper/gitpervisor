// 이미지 에셋 획득 — 붙여넣기·파일 선택·레포 안 파일 세 경로가 여기로 모인다(41 §3.5).
//
// 세 경로가 각자 상한을 검사하면 언젠가 한 곳이 빠지고, 그 경로로 들어온 100MB짜리가
// 사이드카를 32MB 상한(Rust `MAX_DOC_BYTES`)에 걸리게 만든다 — 그때는 **저장이 통째로**
// 실패하고, 사용자는 무엇 때문인지 알 길이 없다. 그래서 획득은 이 함수 하나만 쓴다.
//
// 배경: DOCS/task/41-image-doc-persist-history.md §3.5

import { currentMessages } from "../../i18n/ui-language";
import { newObjId, type AssetId, type EditorDoc } from "./types";

/** 문서 안 에셋 바이트 합 상한 — Rust 사이드카 상한 32MB 안쪽에 본문 몫을 남긴다. */
export const MAX_ASSET_BYTES = 16 * 1024 * 1024;
/** 픽셀 합 상한. 디코드된 비트맵은 4바이트/px 라 16MP = 64MB 가 WebView 메모리에 산다. */
export const MAX_ASSET_PIXELS = 16 * 1024 * 1024;

/** base64 문자열이 나타내는 실제 바이트 수(패딩 제외). */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** 이미 문서에 들어 있는 에셋의 바이트·픽셀 합. */
function usage(doc: EditorDoc): { bytes: number; px: number } {
  let bytes = 0;
  let px = 0;
  for (const a of Object.values(doc.assets)) {
    bytes += base64Bytes(a.data);
    px += a.w * a.h;
  }
  return { bytes, px };
}

/** base64 를 디코드해 자연 크기를 확정한다. 디코드 못 하면 던진다(그림이 아닌 바이트). */
async function decodeSize(mime: string, base64: string): Promise<{ w: number; h: number }> {
  const img = new Image();
  img.src = `data:${mime};base64,${base64}`;
  await img.decode();
  return { w: img.naturalWidth, h: img.naturalHeight };
}

/** 바이트 상한 검사. 넘으면 던진다 — 호출부가 토스트로 옮긴다. */
function assertBytesFit(doc: EditorDoc, bytes: number): void {
  if (usage(doc).bytes + bytes > MAX_ASSET_BYTES) {
    throw new Error(
      currentMessages().annotate.assets.tooLarge(Math.floor(MAX_ASSET_BYTES / 1024 / 1024)),
    );
  }
}

/**
 * 바이트 한 벌을 문서 에셋으로 들인다. 상한을 넘으면 **던진다** — 호출부가 토스트로 옮긴다.
 * 문서를 직접 바꾸지 않고 새 `assets` 를 돌려주므로 커밋 시점은 호출부가 정한다.
 */
export async function acquireAsset(
  doc: EditorDoc,
  src: { mime: string; base64: string },
): Promise<{ assets: EditorDoc["assets"]; id: AssetId; w: number; h: number }> {
  assertBytesFit(doc, base64Bytes(src.base64));
  const used = usage(doc);
  const { w, h } = await decodeSize(src.mime, src.base64);
  if (w <= 0 || h <= 0) throw new Error(currentMessages().annotate.assets.unreadable);
  if (used.px + w * h > MAX_ASSET_PIXELS) {
    throw new Error(
      currentMessages().annotate.assets.tooManyPixels(Math.floor(MAX_ASSET_PIXELS / 1024 / 1024)),
    );
  }
  const id = newObjId();
  return {
    assets: { ...doc.assets, [id]: { mime: src.mime, w, h, data: src.base64 } },
    id,
    w,
    h,
  };
}

/**
 * 붙여넣기·드래그로 들어온 파일 하나를 그대로 에셋으로 들인다.
 *
 * 크기는 **인코딩 앞에서** 본다 — 17MB 를 base64 로 펴는 데만 1~2초가 든다. 그 뒤에 거절하면
 * 사용자는 아무 반응 없는 1초를 보고 붙여넣기가 씹혔다고 생각한다.
 */
export async function acquireFromFile(
  doc: EditorDoc,
  file: File,
): Promise<{ assets: EditorDoc["assets"]; id: AssetId; w: number; h: number }> {
  assertBytesFit(doc, file.size);
  return acquireAsset(doc, await fileToBase64(file));
}

/** 파일 한 벌을 base64 로 꺼낸다. */
async function fileToBase64(file: File): Promise<{ mime: string; base64: string }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  // btoa 는 8비트 문자열만 받는다. 큰 파일을 한 번에 String.fromCharCode 로 펴면
  // 인자 개수 상한에 걸려 RangeError 가 난다 — 32KB 씩 끊어 붙인다.
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return { mime: file.type, base64: btoa(s) };
}
