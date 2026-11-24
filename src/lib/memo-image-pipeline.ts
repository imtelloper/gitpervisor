// 메모 이미지의 넣기·불러오기 — 모듈 수준 싱글턴(DOCS/memo-todo-category-image-design.md §7.1).
//
// **편집기 컴포넌트가 이걸 갖지 않는다.** 인코딩은 0.5~1초가 걸리는데, 그 사이 메모를 바꾸거나 팝오버를
// 닫으면 컴포넌트는 사라진다 — 거기 묶여 있으면 작업이 같이 죽어 토큰만 저장되고 파일은 영영 안 생긴다.

import { currentMessages } from "../i18n/ui-language";
import { useUi } from "../stores/ui";
import { decodeAvifInWorker, encodeAvifInWorker } from "./avif-worker-client";
import { loadImage } from "./image-codec";
import { errorMessage, ipc } from "./ipc";

// 합성 스크린샷 실측(§7.2): speed 6 은 장당 6~13초, speed 8 은 0.5~0.8초(크기 약 1.5배), speed 10 은 PNG 보다 커진다.
// 실제 스크린샷으로 다시 재서 고칠 수 있게 상수로 둔다.
export const MEMO_IMAGE_QUALITY = 70;
export const MEMO_IMAGE_SPEED = 8;
/** 긴 변이 이보다 크면 줄여서 저장한다(px). */
export const MEMO_IMAGE_MAX_EDGE = 2560;
/** 받는 원본의 상한 — 파일 선택 대화상자(asset_pick_file)의 상한과 같다. */
const MEMO_IMAGE_INPUT_MAX_BYTES = 16 * 1024 * 1024;

/** 이미지 바이트 → RGBA(긴 변 MEMO_IMAGE_MAX_EDGE 이하). 디코드·축소는 메인에서 한다 — 수 ms 이고 canvas 가 여기 있다. */
async function decodeToRgba(source: Blob): Promise<{ rgba: ArrayBuffer; width: number; height: number }> {
  const src = URL.createObjectURL(source);
  try {
    const img = await loadImage(src);
    const scale = Math.min(1, MEMO_IMAGE_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(currentMessages().lib.imageCodec.canvasContextUnavailable);
    ctx.drawImage(img, 0, 0, width, height);
    return { rgba: ctx.getImageData(0, 0, width, height).data.buffer, width, height };
  } finally {
    URL.revokeObjectURL(src);
  }
}

// id → 표시용 blob URL. 파일 내용은 바뀌지 않으므로(id 재사용 금지) 무효화가 없다. **성공만** 남긴다 —
// 못 찾은 것을 캐시하면, 다른 창이 토큰을 파일보다 먼저 받았을 때 그 창은 재시작 전까지 "이미지 없음"이다.
const memoImageUrls = new Map<string, Promise<string>>();
const encodingIds = new Set<string>();

function cacheMemoImageUrl(id: string, job: Promise<string>): Promise<string> {
  memoImageUrls.set(id, job);
  job.catch(() => {
    if (memoImageUrls.get(id) === job) memoImageUrls.delete(id);
  });
  return job;
}

async function encodeAndStore(id: string, source: Blob): Promise<string> {
  if (source.size > MEMO_IMAGE_INPUT_MAX_BYTES)
    throw new Error(
      currentMessages().notes.memoPanel.imageTooLarge(MEMO_IMAGE_INPUT_MAX_BYTES / 1024 / 1024),
    );
  const { rgba, width, height } = await decodeToRgba(source);
  const bytes = await encodeAvifInWorker(rgba, width, height, MEMO_IMAGE_QUALITY, MEMO_IMAGE_SPEED);
  // 저장이 끝난 뒤에야 그림을 보인다 — 화면에 보이는데 디스크에는 없는 상태를 만들지 않는다.
  await ipc.noteImagePut(id, new Uint8Array(bytes));
  return URL.createObjectURL(new Blob([bytes], { type: "image/avif" }));
}

/**
 * 이미지를 메모 이미지로 넣는다 — id 를 **바로** 돌려주고(부르는 쪽이 토큰을 본문에 넣는다) 인코딩·저장은 뒤따른다.
 * 실패해도 토큰은 지우지 않는다: 그 사이 다른 메모로 옮겼으면 지울 대상을 찾을 수 없고, 저장 전에 앱이 죽는
 * 경우 때문에 "이미지 없음" 자리표시는 어차피 있다. 실패는 토스트로만 알린다.
 */
export function addMemoImage(source: Blob): string {
  const id = crypto.randomUUID();
  encodingIds.add(id);
  const job = cacheMemoImageUrl(id, encodeAndStore(id, source));
  job
    .catch((e: unknown) =>
      useUi
        .getState()
        .pushToast("error", currentMessages().notes.memoPanel.imageInsertFailed(id, errorMessage(e))),
    )
    .finally(() => encodingIds.delete(id));
  return id;
}

/** 방금 넣어 아직 변환 중인 이미지인가 — 자리표시 문구("변환 중" / "불러오는 중")를 가른다. */
export function memoImageIsEncoding(id: string): boolean {
  return encodingIds.has(id);
}

/** 표시용 URL. id 당 한 번만 읽는다(같은 이미지가 편집기와 MD 보기에 함께 있어도). 없으면 reject. */
export function memoImageUrl(id: string): Promise<string> {
  return (
    memoImageUrls.get(id) ??
    cacheMemoImageUrl(
      id,
      ipc
        .noteImageGet(id)
        .then((buf) => URL.createObjectURL(new Blob([buf], { type: "image/avif" }))),
    )
  );
}

/**
 * `<img>` 가 AVIF 를 못 그리는 웹뷰(배포판 WebKitGTK)용 — Worker 로 풀어 PNG blob URL 을 만들고 캐시를 갈아 끼운다.
 * 세 OS 중 Linux 에서만 타는 길이라 **실기 확인 전**이다.
 */
export function memoImagePngFallbackUrl(id: string): Promise<string> {
  const job = (async () => {
    const buf = await ipc.noteImageGet(id);
    // 받은 버퍼를 그대로 넘기지 않는다 — ipc 가 같은 인자의 호출을 합쳐 주면 다른 소비자가 빈 버퍼를 받는다.
    const { rgba, width, height } = await decodeAvifInWorker(buf.slice(0));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(currentMessages().lib.imageCodec.canvasContextUnavailable);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error(currentMessages().lib.imageCodec.encodeFailed("PNG"));
    return URL.createObjectURL(png);
  })();
  return cacheMemoImageUrl(id, job);
}

/** 클립보드·드롭에서 이미지 파일만 골라낸다. */
export function imageFilesOf(data: DataTransfer | null): File[] {
  return [...(data?.files ?? [])].filter((f) => f.type.startsWith("image/"));
}

/** base64 + mime(파일 선택 대화상자가 주는 꼴) → Blob. */
export function blobFromBase64(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
