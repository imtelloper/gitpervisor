// 이미지 인코딩 코덱 — 변환·편집 저장의 공통 백엔드(프론트 전용).
//
// png/jpeg/webp 는 Chromium(WebView2)의 canvas.toBlob 으로 네이티브 인코딩한다(품질 인자 지원).
// avif 는 Chromium canvas 가 인코딩을 못 하므로 네이티브를 먼저 시도하고, 실패하면
// @jsquash/avif(WASM)로 폴백한다 — 코덱 wasm 은 avif 를 고를 때만 동적 로드한다.

export type ImgFormat = "png" | "jpeg" | "webp" | "avif";

/** UI에 노출하는 변환 대상 포맷(라벨/확장자). */
export const FORMATS: { id: ImgFormat; label: string; ext: string }[] = [
  { id: "png", label: "PNG", ext: "png" },
  { id: "jpeg", label: "JPG", ext: "jpg" },
  { id: "webp", label: "WebP", ext: "webp" },
  { id: "avif", label: "AVIF", ext: "avif" },
];

/** 포맷의 파일 확장자(jpeg→jpg). */
export function extOf(fmt: ImgFormat): string {
  return fmt === "jpeg" ? "jpg" : fmt;
}

/** 포맷의 MIME 타입. */
export function mimeOf(fmt: ImgFormat): string {
  return fmt === "jpeg" ? "image/jpeg" : `image/${fmt}`;
}

/** png는 무손실이라 품질 슬라이더가 없다. */
export function supportsQuality(fmt: ImgFormat): boolean {
  return fmt !== "png";
}

/** 확장자 → 포맷 추정(원본 포맷 기본값 선택용). 매핑 없으면 null. */
export function formatOfPath(path: string): ImgFormat | null {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "png";
    case "jpg":
    case "jpeg":
      return "jpeg";
    case "webp":
      return "webp";
    case "avif":
      return "avif";
    default:
      return null;
  }
}

/** canvas.toBlob 래퍼 — 요청 MIME 으로 인코딩되지 않으면(미지원→png 폴백) null 반환. */
async function canvasToBytes(
  canvas: HTMLCanvasElement,
  mime: string,
  quality?: number,
): Promise<Uint8Array | null> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), mime, quality),
  );
  if (!blob || blob.type !== mime) return null; // 미지원 포맷은 브라우저가 png로 폴백
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 캔버스 픽셀을 지정 포맷 바이트로 인코딩한다. quality 는 0–100(png 무시).
 * avif 는 네이티브 미지원 시 @jsquash/avif(WASM)로 폴백한다.
 */
export async function encodeCanvas(
  canvas: HTMLCanvasElement,
  fmt: ImgFormat,
  quality = 90,
): Promise<Uint8Array> {
  const q = Math.max(0, Math.min(100, Math.round(quality)));
  if (fmt === "png") {
    const out = await canvasToBytes(canvas, "image/png");
    if (!out) throw new Error("PNG 인코딩에 실패했습니다");
    return out;
  }
  if (fmt === "jpeg" || fmt === "webp") {
    const out = await canvasToBytes(canvas, mimeOf(fmt), q / 100);
    if (!out) throw new Error(`${fmt.toUpperCase()} 인코딩에 실패했습니다`);
    return out;
  }
  // ── avif ──
  // 일부 런타임은 네이티브 avif 인코딩을 지원할 수 있다 — 1x1 탐침으로 한 번만 확인해(캐시),
  // 미지원 런타임에서 전체 해상도 PNG를 헛인코딩하는 낭비를 피한다. 미지원이면 wasm로 폴백.
  if (await supportsNativeAvif()) {
    const native = await canvasToBytes(canvas, "image/avif", q / 100);
    if (native) return native;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("캔버스 컨텍스트를 얻지 못했습니다");
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const mod = await import("@jsquash/avif/encode");
  const buf = await mod.default(imageData, { quality: q });
  return new Uint8Array(buf);
}

/** 런타임의 네이티브 AVIF 캔버스 인코딩 지원 여부(1x1 탐침, 1회 캐시). */
let nativeAvifSupport: boolean | null = null;
async function supportsNativeAvif(): Promise<boolean> {
  if (nativeAvifSupport !== null) return nativeAvifSupport;
  const c = document.createElement("canvas");
  c.width = 1;
  c.height = 1;
  nativeAvifSupport = (await canvasToBytes(c, "image/avif", 0.5)) !== null;
  return nativeAvifSupport;
}

/** Uint8Array → base64 (IPC 전송용). 콜스택 폭주를 막는 청크 변환. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 data URL(또는 raw base64+mime)로부터 디코드된 HTMLImageElement 를 만든다. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("이미지를 디코드하지 못했습니다"));
    img.src = src;
  });
}
