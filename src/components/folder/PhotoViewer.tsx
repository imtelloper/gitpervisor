import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Ellipsis,
  ExternalLink,
  FlipHorizontal2,
  FlipVertical2,
  FolderOpen,
  GalleryHorizontal,
  Info,
  Link,
  Maximize2,
  Minimize2,
  Minus,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Save,
  Scan,
  ScanText,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { currentMessages, useMessages } from "../../i18n/ui-language";
import { copyFailMessage, copyImage, copyWithToast } from "../../lib/clipboard";
import { favThumbUrl, useFavThumbToken } from "../../lib/fav-thumb";
import { formatBytes } from "../../lib/format";
import { bytesToBase64, encodeCanvas, type ImgFormat } from "../../lib/image-codec";
import { errorMessage, ipc, isIpcError, type FavEntry, type FavImageInfo, type OcrResult } from "../../lib/ipc";
import { jpegExifTiffFromBase64, withJpegExif } from "../../lib/jpeg-exif";
import { isMac, isMod, modLabel } from "../../lib/platform";
import { webpExifTiffFromBase64, withWebpExif } from "../../lib/webp-exif";
import { useUi } from "../../stores/ui";
import { OcrPanel } from "../diff/OcrPanel";
import { Filmstrip } from "./Filmstrip";
import { PhotoInfoPanel } from "./PhotoInfoPanel";
import { PHOTO_MAX_SCALE, PHOTO_MIN_SCALE, photoFitScale, photoTransform, usePhotoZoom } from "./usePhotoZoom";
import { useViewerImage, viewerImageTarget } from "./useViewerImage";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toast = (kind: "success" | "error", message: string) => useUi.getState().pushToast(kind, message);

/** 슬라이드쇼 간격(설계 D5). */
const SLIDE_MS = 3000;
/** 배율 드롭다운의 고정 배율(맞춤은 따로). */
const ZOOM_PRESETS = [0.25, 0.5, 1, 2, 4];
/** 이 배율을 넘으면 보간을 끄고 픽셀을 그대로 — 이미지 뷰어(ImageView)와 같다. */
const PIXELATE_FROM = 2;
/** 배율 슬라이더 — 로그 눈금이라 1%~1600% 어디서든 한 칸의 체감이 같다. */
const SLIDER_MAX = 1000;
const LOG_RANGE = Math.log(PHOTO_MAX_SCALE / PHOTO_MIN_SCALE);
const toSlider = (s: number) => Math.round((SLIDER_MAX * Math.log(s / PHOTO_MIN_SCALE)) / LOG_RANGE);
const fromSlider = (v: number) => PHOTO_MIN_SCALE * Math.exp((v / SLIDER_MAX) * LOG_RANGE);

const STRIP_KEY = "gp:photo-filmstrip";
function readStrip(): boolean {
  try {
    return localStorage.getItem(STRIP_KEY) !== "0";
  } catch {
    return true; // 저장소를 못 읽으면 기본(켜짐) — 보기 설정일 뿐이다
  }
}

type Side = "info" | "ocr" | null;
type Menu = "more" | "open" | "zoom" | null;

/** 보이는 그대로(보기 회전·뒤집기 포함) 원본 해상도 캔버스 — 그림과 같은 순서(뒤집기는 회전 뒤, 화면 기준)로 그린다.
 *  이미지 복사(D9)와 회전한 대로 저장(D11)이 같은 그림을 쓴다. */
function shownCanvas(img: HTMLImageElement, rot: number, flipX: boolean, flipY: boolean): HTMLCanvasElement {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const side = rot % 180 !== 0;
  const c = document.createElement("canvas");
  c.width = side ? h : w;
  c.height = side ? w : h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error(currentMessages().lib.imageCodec.canvasContextUnavailable);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(img, -w / 2, -h / 2);
  return c;
}

/** 큰 그림을 기다리는 동안 썸네일을 큰 그림 맞춤과 같은 자리·크기로. 배율을 transform 이 아니라 크기로 거는 것은 흐림을
 *  화면 px 로 두려고다 — transform 의 scale 은 blur 반경까지 키운다(320 을 4배로 늘리면 2px 가 8px). `origLong` = 원본 긴 변
 *  (헤더를 못 읽는 형식은 Infinity) — 상자보다 작은 원본은 맞춤도 원본 크기라 썸네일을 그보다 키우지 않는다. */
/** 백엔드가 JPEG 로 변환해 주는 형식(HEIC·HEIF·AVIF) — 썸네일이 이미 서 있고, 큰 그림을 읽는 데 시간이 든다. */
const CONVERTED_STILL = /\.(heic|heif|hif|avif)$/i;

/** 뷰어 메모리 캐시의 무게 = base64 길이. */
const base64Weight = (v: { base64: string }) => v.base64.length;

function standInFor(
  thumb: { w: number; h: number },
  box: { w: number; h: number },
  rot: number,
  flipX: boolean,
  flipY: boolean,
  origLong: number,
): { size: { w: number; h: number }; transform: string } {
  const s = photoFitScale(thumb, box, rot, origLong / Math.max(thumb.w, thumb.h));
  const size = { w: thumb.w * s, h: thumb.h * s };
  return { size, transform: photoTransform({ scale: 1, x: box.w / 2, y: box.h / 2 }, size, rot, flipX, flipY) };
}

/**
 * "회전한 대로 저장"(설계 D11)이 **같은 형식으로** 다시 쓸 수 있으면 그 형식 — 웹뷰 캔버스가 인코딩하는 셋뿐이다.
 * 확장자와 내용(`fav_image_info` 의 형식)이 둘 다 맞아야 한다: 확장자만 jpg 인 HEIC 는 뷰어가 변환본(긴 변 4096)을 보고
 * 있어서, 그대로 쓰면 원본이 줄어들고 형식이 바뀐다.
 */
function rotateSaveFormat(name: string, sniffed: string | undefined): Extract<ImgFormat, "png" | "jpeg" | "webp"> | null {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const fmt = ext === "png" ? "png" : ext === "jpg" || ext === "jpeg" || ext === "jfif" ? "jpeg" : ext === "webp" ? "webp" : null;
  return fmt && sniffed === fmt.toUpperCase() ? fmt : null;
}

/**
 * 폴더 창·타이틀바 미리보기 공용 사진 뷰어(태스크 76 — Windows 사진 앱 수준). 원본을 `fav_read` 로 읽어 보인다.
 * 기능은 props 로 켠다: 휴지통(`onTrash`)·편집(`onEdit`)·이름 바꾸기(`onRename`)·필름스트립(`filmstrip`).
 *
 * **키 규약(설계 D1):** 이동(←→)·닫기(Esc)·삭제(Delete)는 **쓰는 쪽이** 건다 — 폴더 창은 자기 키 처리에 섞어 두었고,
 * 타이틀바 미리보기는 드롭다운의 Esc 보다 먼저 잡아야 해서 방식이 다르다. 뷰어 안 상태에 딸린 키(줌 + - 0 1, 회전 R,
 * 슬라이드쇼 Space, 전체 화면 F11, 이미지 복사 Ctrl+C)는 여기서 받는다. 전체 화면·메뉴가 열려 있으면 Esc 도 먼저
 * 여기서 먹는다(전체 화면 끄기·메뉴 닫기) — 그래서 리스너가 window **캡처**이고 마운트 때 한 번만 건다: 미리보기의
 * 캡처 리스너는 렌더마다 다시 걸리므로 늘 이것보다 뒤에 돈다.
 *
 * 회전·뒤집기는 **보기만** 바꾸고(파일은 그대로) 닫을 때까지 장을 넘겨도 유지된다 — 옆으로 누운 카메라 프레임
 * 수백 장을 넘겨 볼 때 장마다 다시 돌리지 않게. 파일을 돌려 저장하려면 [편집](이미지 편집기).
 */
export function PhotoViewer({
  path,
  name,
  index,
  total,
  onClose,
  onStep,
  onTrash,
  onEdit,
  onRename,
  filmstrip,
  version,
  onFileChanged,
}: {
  path: string;
  /** 파일 정체(목록의 mtime·크기) — 바뀌면 경로가 같아도 다시 읽는다(편집기 저장·회전 저장·밖에서 바뀜). */
  version?: string;
  /** 있으면 ⋯ 메뉴에 [회전한 대로 저장] — 파일을 쓴 뒤 부른다(목록을 다시 읽는 것은 쓰는 쪽). */
  onFileChanged?: () => void;
  name: string;
  index: number;
  total: number;
  onClose: () => void;
  onStep: (d: number) => void;
  /** 있으면 휴지통 버튼 — 키(Delete)는 다른 이동 키처럼 쓰는 쪽이 건다. */
  onTrash?: () => void;
  /** 있으면 [편집]. */
  onEdit?: () => void;
  /** 있으면 ⋯ 메뉴에 [이름 바꾸기] — 목록을 고치는 것은 쓰는 쪽이다. */
  onRename?: () => void;
  /** 있으면 필름스트립 — 넘나드는 순서의 이미지들과 그 절대경로. */
  filmstrip?: { images: FavEntry[]; pathOf: (name: string) => string };
}) {
  const msg = useMessages();
  const t = msg.folder.lightbox;
  const seq = filmstrip?.images;
  /** 지금 장의 목록 항목(mtime·크기) — 큰 그림 캐시 키와 기다리는 동안 띄울 썸네일 URL 에 쓴다. */
  const entry = seq?.[index]?.name === name ? seq[index] : undefined;
  const cur = viewerImageTarget(path, entry, version);
  // 진행 방향 — 다음에 미리 읽을 이웃. 자리가 그대로인 장 바뀜(지우기·이름 바꾸기)은 방향을 두고 간다.
  const [dir, setDir] = useState({ index, d: 1 });
  if (dir.index !== index) setDir({ index, d: index > dir.index ? 1 : -1 });
  const aheadEntry = seq?.[index + dir.d];
  // 미리 읽기는 변환이 필요한 형식만 — JPEG·PNG 는 원본을 통째로(최대 25MB) 받아 오므로 미리 읽으면 쓰지도 않을 IPC 만 무겁다.
  const ahead =
    filmstrip && aheadEntry && CONVERTED_STILL.test(aheadEntry.name)
      ? viewerImageTarget(filmstrip.pathOf(aheadEntry.name), aheadEntry)
      : null;
  /** 그려진 큰 그림의 크기 — 장 키에 묶어, 다른 장으로 넘어간 첫 렌더에 옛 크기가 새 그림에 걸리지 않게. */
  const [drawn, setDrawn] = useState<{ key: string; size: { w: number; h: number } } | null>(null);
  const natural = drawn?.key === cur.key ? drawn.size : null;
  const image = useViewerImage(ipc.favRead, cur, ahead, natural !== null, base64Weight);
  const bytes = image.value;
  const src = useMemo(() => (bytes ? `data:${bytes.mime};base64,${bytes.base64}` : null), [bytes]);
  /** 웹뷰가 디코드하지 못한 장의 키. */
  const [undecodable, setUndecodable] = useState<string | null>(null);
  const err = undecodable === cur.key ? msg.git.imageView.unsupportedTitle : image.error ? errText(image.error) : null;
  const [rot, setRot] = useState(0);
  const [flipX, setFlipX] = useState(false);
  const [flipY, setFlipY] = useState(false);
  const [info, setInfo] = useState<FavImageInfo | null>(null);
  const [infoErr, setInfoErr] = useState<string | null>(null);
  const [side, setSide] = useState<Side>(null);
  const [ocr, setOcr] = useState<OcrResult | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [hoverOcrLine, setHoverOcrLine] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [menu, setMenu] = useState<Menu>(null);
  const [strip, setStrip] = useState(readStrip);
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  /** 늦게 끝난 글자 인식이 다른 장으로 넘어간 뒤에 결과를 덮지 않게. */
  const pathNow = useRef(path);
  pathNow.current = path;
  const [rotSaving, setRotSaving] = useState(false);

  const stopSlides = useCallback(() => setPlaying(false), []);
  const zoom = usePhotoZoom(boxRef, natural, rot, cur.key, stopSlides);

  useEffect(() => {
    setOcr(null);
    setHoverOcrLine(null);
    setSide((s) => (s === "ocr" ? null : s)); // 정보 패널은 장을 넘겨도 열어 둔다(사진 앱과 같다)
  }, [cur.key]);

  // ---- 큰 그림을 기다리는 동안: 썸네일(320 — HEIC 도 내장 썸네일이라 싸다)을 큰 그림이 설 자리에 흐리게 ----
  const thumbToken = useFavThumbToken();
  // 변환 형식만 — 백엔드 썸네일은 EXIF 방향을 적용하지 않아(JPEG·WebP) 세로 사진이 누운 채로 비쳤다가 바로 서는 걸 장마다 보게 된다.
  // HEIC·AVIF 썸네일은 디코더가 이미 세워서 준다.
  const thumbUrl =
    thumbToken && entry && CONVERTED_STILL.test(name) ? favThumbUrl(path, entry, 320, thumbToken) : undefined;
  /** 받은 썸네일 크기(null = 못 받음) — URL 에 묶는다. */
  const [thumbGot, setThumbGot] = useState<{ url: string; size: { w: number; h: number } | null } | null>(null);
  const thumbSize = thumbGot && thumbGot.url === thumbUrl ? thumbGot.size : undefined;

  // 아래 줄의 형식·크기도 여기서 나온다 — 패널이 닫혀 있어도 읽는다(앞 1MB 라 싸다).
  useEffect(() => {
    let alive = true;
    setInfo(null);
    setInfoErr(null);
    void ipc
      .favImageInfo(path)
      .then((i) => alive && setInfo(i))
      .catch((e) => alive && setInfoErr(errText(e)));
    return () => {
      alive = false;
    };
  }, [path, version]);

  useEffect(() => {
    try {
      localStorage.setItem(STRIP_KEY, strip ? "1" : "0");
    } catch {
      /* 용량 초과 — 다음에 기본값(켜짐)으로 뜰 뿐이다 */
    }
  }, [strip]);

  // ---- 슬라이드쇼 (설계 D5) — 3초마다 다음 장, 끝에서 멈춘다(순환 없음 — 태스크 56 규약) ----
  const stepRef = useRef(onStep);
  stepRef.current = onStep;
  /** 이번 장 바뀜이 슬라이드쇼가 넘긴 것인가. */
  const slideStepped = useRef(false);
  // 슬라이드쇼가 넘긴 게 아닌 장 바뀜(←→·필름스트립·Delete·이름 바꾸기)은 "다른 조작" — 멈춘다. 자리(index)가 아니라
  // 경로로 본다: 지우면 다음 장이 같은 자리로 당겨 와 자리만으로는 못 가른다.
  useEffect(() => {
    if (!slideStepped.current) setPlaying(false);
    slideStepped.current = false;
  }, [path]);
  useEffect(() => {
    if (!playing) return;
    if (index >= total - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      slideStepped.current = true;
      stepRef.current(1);
    }, SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [playing, index, total]);
  const togglePlay = () => setPlaying((p) => !p && index < total - 1);

  // ---- 전체 화면 (설계 D8) ----
  /** 우리가 켰는가 — 닫을 때 되돌릴지. 장식 없는 창이라 뷰어 없이 전체 화면만 남으면 빠져나갈 단추가 없다. */
  const fsOurs = useRef(false);
  const setFs = useCallback(async (on: boolean) => {
    try {
      const w = getCurrentWindow();
      await w.setFullscreen(on);
      fsOurs.current = on;
      setFullscreen(await w.isFullscreen());
    } catch (e) {
      toast("error", currentMessages().folder.lightbox.fullscreenFailed(errText(e)));
    }
  }, []);
  const toggleFullscreen = useCallback(async () => {
    try {
      await setFs(!(await getCurrentWindow().isFullscreen()));
    } catch (e) {
      toast("error", currentMessages().folder.lightbox.fullscreenFailed(errText(e)));
    }
  }, [setFs]);
  useEffect(
    () => () => {
      if (fsOurs.current)
        void getCurrentWindow()
          .setFullscreen(false)
          .catch((e: unknown) => console.error("전체 화면을 되돌리지 못했습니다:", e));
    },
    [],
  );

  // ---- 동작 ----
  const rotate = (d: 90 | 270) => {
    stopSlides();
    setRot((r) => (r + d) % 360);
  };

  const copyShown = () => {
    const img = imgRef.current;
    if (!img?.naturalWidth) return;
    void encodeCanvas(shownCanvas(img, rot, flipX, flipY), "png")
      .then((bytes) => copyImage(bytes))
      .then((ok) => toast(ok ? "success" : "error", ok ? currentMessages().folder.lightbox.copyImageDone : copyFailMessage()))
      .catch((e) => toast("error", errText(e)));
  };

  // ---- 회전한 대로 저장 (설계 D11) ----
  const rotFmt = rotateSaveFormat(name, info?.format);
  const transformed = rot !== 0 || flipX || flipY;
  const saveRotated = () => {
    const img = imgRef.current;
    if (!img?.naturalWidth || !rotFmt || !transformed || !onFileChanged) return;
    stopSlides();
    const p = path;
    const shownName = name;
    /** 지금 보이는 그림의 원본(`fav_read` base64) — JPEG·WebP 는 여기서 EXIF 를 떠 새 파일에 옮겨 심는다. */
    const original = bytes?.base64 ?? null;
    /** 읽은 원본의 정체 — 그 사이 밖에서 바뀌었으면 덮지 않는다(`fav_write_image` CONFLICT). */
    const stamp = bytes?.stamp;
    const go = () => {
      setRotSaving(true);
      // 원본 해상도로 다시 그려 같은 형식으로 — 손실 형식은 사진 앱과 같은 품질(0.92).
      void Promise.resolve()
        .then(async () => {
          const canvas = shownCanvas(img, rot, flipX, flipY);
          const enc = await encodeCanvas(canvas, rotFmt, 92);
          if (!original) return enc;
          if (rotFmt === "jpeg") return withJpegExif(enc, jpegExifTiffFromBase64(original), canvas.width, canvas.height);
          if (rotFmt === "webp") return withWebpExif(enc, webpExifTiffFromBase64(original), canvas.width, canvas.height);
          return enc;
        })
        .then((out) => ipc.favWriteImage(p, bytesToBase64(out), true, stamp))
        .then(() => {
          // 파일이 이제 그 방향이다 — 보기 회전을 그대로 두면 한 번 더 돌아 보인다.
          setRot(0);
          setFlipX(false);
          setFlipY(false);
          toast("success", currentMessages().folder.lightbox.rotateSaveDone(shownName));
          onFileChanged();
        })
        .catch((e) => {
          const lb = currentMessages().folder.lightbox;
          if (isIpcError(e) && e.code === "CONFLICT") {
            toast("error", lb.rotateSaveConflict);
            onFileChanged(); // 디스크의 새 내용·새 정체를 다시 읽는다 — 보기 회전은 남겨 다시 저장할 수 있게
          } else toast("error", lb.rotateSaveFailed(errorMessage(e)));
        })
        .finally(() => setRotSaving(false));
    };
    if (rotFmt === "png") {
      go();
      return;
    }
    // 손실 형식은 다시 압축된다(EXIF 는 옮겨 심는다) — 원본을 덮기 전에 묻는다.
    const lb = currentMessages().folder.lightbox;
    useUi.getState().askConfirm({
      title: lb.rotateSaveConfirmTitle,
      message: lb.rotateSaveConfirmMessage(rotFmt === "jpeg" ? "JPEG" : "WebP"),
      detail: p,
      confirmLabel: lb.rotateSaveConfirm,
      danger: true,
      onConfirm: go,
    });
  };

  const runOcr = () => {
    stopSlides();
    setOcrBusy(true);
    const p = path;
    void ipc
      .favOcrImage(p)
      .then((res) => {
        if (pathNow.current !== p) return;
        setOcr(res);
        setHoverOcrLine(null);
        setSide("ocr");
      })
      .catch((e) => {
        // 엔진·언어팩이 없다는 오류엔 Rust 가 설치 방법을 담아 보낸다 — 이미지 뷰어(ImageView)와 같은 처리.
        if (isIpcError(e) && e.code === "TOOL_NOT_FOUND") toast("error", errorMessage(e));
        else toast("error", currentMessages().git.imageView.ocrFailed(errorMessage(e)));
      })
      .finally(() => setOcrBusy(false));
  };

  const openWith = (how: "default" | "reveal") =>
    void ipc.favOpen(path, how).catch((e) => {
      const w = currentMessages().folder.window;
      toast("error", how === "reveal" ? w.revealFailed : w.openFailedWithReason(errText(e)));
    });

  const pick = (fn: () => void) => () => {
    setMenu(null);
    fn();
  };

  // ---- 키 (위 주석의 규약) ----
  const keys = useRef<(ev: KeyboardEvent) => void>(() => {});
  keys.current = (ev) => {
    // 확인창(회전 저장 등)이 떠 있으면 뷰어 키는 쉰다 — R·Space 가 묻는 중인 그림을 바꾸면 안 된다.
    if (useUi.getState().confirm) return;
    const tg = ev.target;
    // 입력 중(⋯ › 이름 바꾸기 대화상자 등)엔 손대지 않는다. 슬라이더는 입력란이 아니다.
    if (
      tg instanceof HTMLTextAreaElement ||
      (tg instanceof HTMLInputElement && tg.type !== "range") ||
      (tg instanceof HTMLElement && tg.isContentEditable)
    )
      return;
    const plain = !ev.ctrlKey && !ev.metaKey && !ev.altKey;
    if (ev.key === "Escape") {
      if (menu) setMenu(null);
      else if (fullscreen) void setFs(false);
      else return; // 닫기는 쓰는 쪽 몫
    } else if (ev.key === "F11") {
      if (!ev.repeat) void toggleFullscreen();
    } else if (isMod(ev) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === "c") {
      // 글자 인식 패널·정보 패널에서 고른 글자가 있으면 그것을 복사하게 둔다(브라우저 기본).
      if (window.getSelection()?.toString()) return;
      copyShown();
    } else if (!plain) return;
    else if (ev.key === "+" || ev.key === "=") zoom.zoomIn();
    else if (ev.key === "-" || ev.key === "_") zoom.zoomOut();
    else if (ev.key === "0") zoom.fit();
    else if (ev.key === "1") zoom.zoomTo(1);
    else if (ev.key === "r" || ev.key === "R") rotate(ev.shiftKey ? 270 : 90);
    else if (ev.key === " ") {
      if (!ev.repeat) togglePlay();
    } else return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };
  useEffect(() => {
    const h = (ev: KeyboardEvent) => keys.current(ev);
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  const view = zoom.view;
  const transform = view && natural ? photoTransform(view, natural, rot, flipX, flipY) : undefined;
  const hoverBox = hoverOcrLine === null ? null : (ocr?.lines[hoverOcrLine]?.box ?? null);
  /** 보이는 그림의 치수(설계 D3 — 디코드한 크기, HEIC 는 변환본 = 원본 크기). 아직 못 그렸으면 백엔드 헤더 값. */
  const dims = natural ?? (info?.width && info.height ? { w: info.width, h: info.height } : null);
  const format = info?.format ?? ""; // 확장자 폴백은 백엔드가 한다(`fav_image_info`)
  const thumbStand =
    !natural && thumbSize && zoom.box.w > 0 && zoom.box.h > 0
      ? standInFor(thumbSize, zoom.box, rot, flipX, flipY, info?.width && info.height ? Math.max(info.width, info.height) : Infinity)
      : null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-base/95" onContextMenu={(e) => e.preventDefault()}>
      {/* 메뉴 밖을 누르면 닫힌다 — 메뉴(z-20) 아래, 나머지 위. */}
      {menu && <div className="fixed inset-0 z-10" onClick={() => setMenu(null)} />}

      {/* ── 위 줄 ── */}
      <div className="relative flex h-10 shrink-0 items-center gap-1 border-b border-edge px-2 text-[12px] text-fg-muted">
        {/* 이름·n/N 이 DOM 맨 앞이다 — e2e 60 이 이 뷰어의 첫 두 span 으로 짚는다. 화면 자리는 order 로 가운데. */}
        <div className="order-2 flex min-w-0 flex-1 items-center justify-center gap-2 px-2">
          <span className="truncate text-fg">{name}</span>
          <span className="shrink-0 tabular-nums text-fg-dim">
            {index + 1} / {total}
          </span>
        </div>
        <div className="order-1 flex shrink-0 items-center gap-0.5">
          {onEdit && (
            <Btn
              title={t.editTitle}
              onClick={() => {
                stopSlides();
                onEdit();
              }}
            >
              <Pencil size={14} /> {t.edit}
            </Btn>
          )}
          <Btn title={t.rotateLeftTitle} onClick={() => rotate(270)}>
            <RotateCcw size={15} />
          </Btn>
          <Btn title={t.rotateRightTitle} onClick={() => rotate(90)}>
            <RotateCw size={15} />
          </Btn>
          {onTrash && (
            <Btn danger title={t.trashTitle(isMac ? "⌘⌫" : "Del")} onClick={onTrash}>
              <Trash2 size={15} />
            </Btn>
          )}
          <Btn title={t.copyImageTitle(modLabel)} onClick={copyShown}>
            <Copy size={15} />
          </Btn>
          <div className="relative">
            <Btn title={t.moreTitle} active={menu === "more"} onClick={() => setMenu((m) => (m === "more" ? null : "more"))}>
              <Ellipsis size={15} />
            </Btn>
            {menu === "more" && (
              <Popover place="below-left">
                <MenuRow icon={<FlipHorizontal2 size={14} />} label={t.flipHorizontal} on={flipX} onClick={pick(() => setFlipX((v) => !v))} />
                <MenuRow icon={<FlipVertical2 size={14} />} label={t.flipVertical} on={flipY} onClick={pick(() => setFlipY((v) => !v))} />
                {onFileChanged && (
                  <MenuRow
                    icon={<Save size={14} />}
                    label={t.rotateSave}
                    title={!rotFmt ? t.rotateSaveUnsupported : !transformed ? t.rotateSaveNeedsRotation : t.rotateSaveTitle}
                    disabled={!rotFmt || !transformed || !src || rotSaving}
                    onClick={pick(saveRotated)}
                  />
                )}
                <div className="my-1 border-t border-edge" />
                <MenuRow
                  icon={<Link size={14} />}
                  label={msg.folder.menuCopyPath}
                  onClick={pick(() => copyWithToast(path, currentMessages().folder.copyPathDone))}
                />
                {onRename && <MenuRow icon={<Pencil size={14} />} label={msg.folder.window.menuRename} onClick={pick(onRename)} />}
                <MenuRow icon={<FolderOpen size={14} />} label={msg.folder.menuReveal} onClick={pick(() => openWith("reveal"))} />
              </Popover>
            )}
          </div>
        </div>
        <div className="order-3 flex shrink-0 items-center gap-0.5">
          <div className="relative">
            <Btn active={menu === "open"} onClick={() => setMenu((m) => (m === "open" ? null : "open"))}>
              <ExternalLink size={14} /> {t.openWith} <ChevronDown size={12} />
            </Btn>
            {menu === "open" && (
              <Popover place="below-right">
                <MenuRow icon={<ExternalLink size={14} />} label={msg.folder.menuOpenDefault} onClick={pick(() => openWith("default"))} />
                <MenuRow icon={<FolderOpen size={14} />} label={msg.folder.menuReveal} onClick={pick(() => openWith("reveal"))} />
              </Popover>
            )}
          </div>
          <Btn title={t.closeTitle} onClick={onClose}>
            <X size={16} />
          </Btn>
        </div>
      </div>

      {/* ── 그림 + 오른쪽 패널 ── */}
      <div className="flex min-h-0 flex-1">
        <div
          ref={boxRef}
          {...zoom.bind}
          className={`relative min-h-0 min-w-0 flex-1 select-none overflow-hidden ${
            zoom.fitted ? "" : zoom.dragging ? "cursor-grabbing" : "cursor-grab"
          }`}
        >
          {err ? (
            <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-danger">{err}</div>
          ) : (
            <>
              {thumbUrl && !natural && thumbSize !== null && (
                // 큰 그림이 그려지는 렌더에 사라진다 — 위에 남아 클릭·e2e 60 의 elementFromPoint 를 가로채지 않게.
                <img
                  key={thumbUrl}
                  src={thumbUrl}
                  alt=""
                  draggable={false}
                  onLoad={(e) =>
                    setThumbGot({ url: thumbUrl, size: { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight } })
                  }
                  onError={() => setThumbGot({ url: thumbUrl, size: null })}
                  style={
                    thumbStand
                      ? {
                          width: thumbStand.size.w,
                          height: thumbStand.size.h,
                          transformOrigin: "0 0",
                          transform: thumbStand.transform,
                        }
                      : { visibility: "hidden" }
                  }
                  className="pointer-events-none absolute left-0 top-0 max-w-none blur-[2px]"
                />
              )}
              {src && (
                // 장마다 새 `<img>` — 옛 그림이 새 장의 자리·크기로 한 프레임 비치지 않게(그동안은 위 썸네일이 보인다).
                <img
                  key={cur.key}
                  ref={imgRef}
                  src={src}
                  alt={name}
                  draggable={false}
                  onLoad={(e) =>
                    setDrawn({ key: cur.key, size: { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight } })
                  }
                  // 웹뷰가 디코드하지 못했다 — onLoad 가 영영 안 와 빈 화면만 남지 않게.
                  onError={() => setUndecodable(cur.key)}
                  style={{
                    width: natural?.w,
                    height: natural?.h,
                    transformOrigin: "0 0",
                    transform,
                    imageRendering: view && view.scale >= PIXELATE_FROM ? "pixelated" : "auto",
                    // 크기를 알기 전엔 숨긴다 — 원본 크기로 한 프레임 번쩍이지 않게.
                    visibility: transform ? "visible" : "hidden",
                  }}
                  className="absolute left-0 top-0 max-w-none"
                />
              )}
              {src && hoverBox && transform && natural && (
                // 그림과 같은 transform·크기의 형제 — 상자가 줌·회전·뒤집기를 좌표 계산 없이 따라간다(태스크 68 §3.6).
                <div
                  aria-hidden
                  style={{ width: natural.w, height: natural.h, transformOrigin: "0 0", transform }}
                  className="pointer-events-none absolute left-0 top-0"
                >
                  <div
                    data-ocr-highlight
                    style={{ left: hoverBox.x, top: hoverBox.y, width: hoverBox.w, height: hoverBox.h }}
                    className="absolute border border-accent bg-accent/25"
                  />
                </div>
              )}
              {!natural && (
                <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded bg-panel/80 px-2 py-0.5 text-[11px] text-fg-dim">
                  {msg.folder.loading}
                </div>
              )}
            </>
          )}
          {/* 이전·다음 — 그림 가운데를 덮지 않게 양 끝에만. 끝에서는 멈춘다(순환 없음). */}
          {index > 0 && (
            <button
              onClick={() => onStep(-1)}
              title={t.prev}
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-panel/70 p-2 text-fg-muted hover:bg-raised hover:text-fg"
            >
              <ChevronLeft size={18} />
            </button>
          )}
          {index < total - 1 && (
            <button
              onClick={() => onStep(1)}
              title={t.next}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-panel/70 p-2 text-fg-muted hover:bg-raised hover:text-fg"
            >
              <ChevronRight size={18} />
            </button>
          )}
        </div>
        {side === "info" && (
          <PhotoInfoPanel path={path} name={name} info={info} error={infoErr} dims={dims} onClose={() => setSide(null)} />
        )}
        {side === "ocr" && ocr && (
          <OcrPanel
            result={ocr}
            onHoverLine={setHoverOcrLine}
            onClose={() => {
              setOcr(null);
              setHoverOcrLine(null);
              setSide(null);
            }}
          />
        )}
      </div>

      {filmstrip && strip && (
        <Filmstrip images={filmstrip.images} pathOf={filmstrip.pathOf} index={index} onPick={(i) => onStep(i - index)} />
      )}

      {/* ── 아래 줄 ── */}
      <div className="relative flex h-10 shrink-0 items-center gap-1 border-t border-edge px-2 text-[12px] text-fg-muted">
        {filmstrip && (
          <Btn title={t.filmstripTitle} active={strip} onClick={() => setStrip((v) => !v)}>
            <GalleryHorizontal size={15} />
          </Btn>
        )}
        <Btn
          title={playing ? t.slideshowStop : t.slideshowStart}
          active={playing}
          disabled={!playing && index >= total - 1}
          onClick={togglePlay}
        >
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </Btn>
        <div className="mx-1 h-4 w-px bg-edge" />
        <div className="flex min-w-0 items-center gap-3 truncate tabular-nums text-fg-dim">
          {format && <span>{format}</span>}
          {dims && (
            <span>
              {dims.w} × {dims.h}
            </span>
          )}
          {info && <span>{formatBytes(info.bytes)}</span>}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Btn title={t.infoTitle} active={side === "info"} onClick={() => setSide((s) => (s === "info" ? null : "info"))}>
            <Info size={15} />
          </Btn>
          <Btn title={t.ocrTitle} active={side === "ocr"} disabled={ocrBusy || !src} onClick={runOcr}>
            <ScanText size={15} /> {ocrBusy ? t.ocrRunning : t.ocrRun}
          </Btn>
          <div className="mx-1 h-4 w-px bg-edge" />
          <Btn title={t.fitTitle} active={zoom.fitted} onClick={zoom.fit}>
            <Scan size={15} />
          </Btn>
          <div className="relative">
            <Btn title={t.zoomMenuTitle} active={menu === "zoom"} onClick={() => setMenu((m) => (m === "zoom" ? null : "zoom"))}>
              <span className="w-10 text-right tabular-nums">{view ? Math.round(view.scale * 100) : 100}%</span>
              <ChevronDown size={12} />
            </Btn>
            {menu === "zoom" && (
              <Popover place="above-right">
                <MenuRow label={t.zoomFit} on={zoom.fitted} onClick={pick(zoom.fit)} />
                {ZOOM_PRESETS.map((s) => (
                  <MenuRow
                    key={s}
                    label={`${s * 100}%`}
                    on={!zoom.fitted && view?.scale === s}
                    onClick={pick(() => zoom.zoomTo(s))}
                  />
                ))}
              </Popover>
            )}
          </div>
          <Btn title={t.zoomOutTitle} onClick={zoom.zoomOut}>
            <Minus size={15} />
          </Btn>
          <input
            type="range"
            min={0}
            max={SLIDER_MAX}
            value={view ? toSlider(view.scale) : toSlider(1)}
            onChange={(e) => zoom.zoomTo(fromSlider(Number(e.currentTarget.value)))}
            // 놓으면 포커스를 돌려준다 — 슬라이더가 쥐고 있으면 ←→ 가 장 넘기기 대신 배율을 움직인다.
            onPointerUp={(e) => e.currentTarget.blur()}
            title={t.zoomSliderTitle}
            className="w-28 accent-accent"
          />
          <Btn title={t.zoomInTitle} onClick={zoom.zoomIn}>
            <Plus size={15} />
          </Btn>
          <Btn title={fullscreen ? t.fullscreenExit : t.fullscreenEnter} onClick={() => void toggleFullscreen()}>
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </Btn>
        </div>
      </div>
    </div>
  );
}

function Btn({
  title,
  onClick,
  active,
  danger,
  disabled,
  children,
}: {
  title?: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-1 disabled:opacity-30 ${
        active ? "bg-raised text-accent" : danger ? "hover:bg-raised hover:text-danger" : "hover:bg-raised hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

function Popover({ place, children }: { place: "below-left" | "below-right" | "above-right"; children: React.ReactNode }) {
  const pos =
    place === "below-left" ? "left-0 top-full mt-1" : place === "below-right" ? "right-0 top-full mt-1" : "bottom-full right-0 mb-1";
  return (
    <div className={`absolute ${pos} z-20 min-w-44 rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl`}>{children}</div>
  );
}

function MenuRow({
  icon,
  label,
  on,
  title,
  disabled,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  on?: boolean;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left hover:bg-raised disabled:opacity-40 ${
        on ? "text-accent" : "text-fg-muted hover:text-fg"
      }`}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {label}
    </button>
  );
}
