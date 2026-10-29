// PDF 읽기 뷰어(M1, 보기 모드) — DiffViewer 의 lazy 분기로만 들어온다(뷰어 탭·Git 모달·문서 창 공통).
//
// 읽기 흐름: stamp 폴링(1.5초) → 전 stamp → readFileRaw → 후 stamp → 둘이 같고 끝이 온전하면 pdf.js 로.
// 외부 변경은 리마운트 없이 setDocument 로 제자리 교체하고 페이지·배율·스크롤 비율을 보존한다.
// pdfjs-dist 런타임은 lib/pdf/pdfjs.ts 만 불러온다 — 이 파일은 `import type` 과 CSS 만.
//
// 키는 루트 onKeyDown 한 곳에서만 받는다(window 리스너 없음) — 분할 4칸·Git 모달에 인스턴스가 여럿 뜬다.
//
// 주석 모드(M2, DOCS/task/74): 첫 진입 때 pdf-lib 코어를 늦게 불러 디스크 바이트에서 주석을 가져오고, 편집 가능한
// 주석을 뺀 작업 사본을 pdf.js 에 제자리 교체한다. 편집은 페이지별 EditorDoc(+문서 전체 스냅샷 undo), 저장은 증분.
// 오버레이·활성 페이지는 PdfAnnotateOverlay, 속성은 PdfPropsBar.

import "pdfjs-dist/legacy/web/pdf_viewer.css";
import "./pdf.css";

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileWarning,
  Lock,
  Minus,
  PanelLeft,
  Plus,
  Save,
  Search,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  EventBus,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/legacy/web/pdf_viewer.mjs";

import { currentMessages, useMessages } from "../../i18n/ui-language";
import { isGeomNode, translateObject } from "../../lib/annotate/geometry";
import { normalizeDoc } from "../../lib/annotate/schema";
import { matchShortcut, type ShortcutId } from "../../lib/annotate/shortcuts";
import { layoutText } from "../../lib/annotate/text-layout";
import { remove as treeRemove } from "../../lib/annotate/tree";
import {
  DUPLICATE_OFFSET,
  newObjId,
  type DefaultPaint,
  type EditorDoc,
  type Node,
  type ObjId,
  type TextNode,
} from "../../lib/annotate/types";
import { IS_DOC_WINDOW } from "../../lib/floating";
import { errorMessage, ipc, isIpcError, type DiffTarget } from "../../lib/ipc";
import {
  emptyLedger,
  type Affine,
  type PdfFont,
  type PdfLedger,
  type PdfPageInfo,
  type PdfTextLine,
} from "../../lib/pdf/model";
import { loadPdfjs, type PdfDocOpts, type Pdfjs } from "../../lib/pdf/pdfjs";
import { isMod, modLabel } from "../../lib/platform";
import { WHEEL_STEP } from "../../lib/zoom";
import { useImageEditorUi, type Tool } from "../../stores/imageEditor";
import { useUi } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";
import type { SelectionRef } from "../diff/DiffViewer";
import { TBtn } from "../diff/ImageView";
import type { AnnotationLayerHandle } from "../image/AnnotationLayer";
import ToolRail from "../image/ToolRail";
import PdfAnnotateOverlay from "./PdfAnnotateOverlay";
import { PDF_PAINT, PDF_TOOLS } from "./pdfAnnotateTools";
import PdfFindBar from "./PdfFindBar";
import PdfOutline from "./PdfOutline";
import PdfPropsBar, { applyPdfPaint, applyPdfPaintDefaults, type PdfPaintChange } from "./PdfPropsBar";
import PdfThumbs from "./PdfThumbs";

// ponytail: 인스턴스당 metadata IPC 0.67회/s(background 레인). 문제가 되면 repo://changed 로컬 listen 을
// 얹어 이벤트 때 즉시 tick 하고 주기를 늘린다 — 이벤트만으로는 build/·out/ 무시, 합성 id 불일치,
// 모아보기 창 미구독 구멍이 남는다(명세 decisions '외부 변경 감지').
const POLL_MS = 1500;
/** %%EOF 가 끝에 없어도 mtime 이 이만큼 지났으면 쓰기가 끝난 것으로 보고 그대로 연다(기형 PDF 허용). */
const EOF_GRACE_MS = 3000;
const PRESETS = new Set(["auto", "page-width", "page-fit", "page-actual"]);
/** 파일 없음 — 오버레이가 이 표식으로 '없음' 모양(외부 앱 버튼 없음·삭제 안내)을 고른다. 화면 문구가 아니라
 *  표식이다(표시는 렌더 때 `msg.pdf.view.fileNotFound`) — 문구를 담아 두면 언어를 바꾼 뒤 비교가 어긋난다. */
const NOT_FOUND = "pdf:not-found";

/** pdf.js 예외 문구는 영어다 — 흔한 것만 UI 언어로 바꾸고 그 밖(IPC 오류 등)은 원문. */
function loadErrorText(e: unknown): string {
  if ((e as Error | null)?.name === "InvalidPDFException") return currentMessages().pdf.view.invalidPdf;
  return errorMessage(e);
}

/**
 * updateScale 뒤 (ox, oy)(컨테이너 뷰포트 좌표) 아래의 페이지 점을 제자리로 되돌린다. pdf.js 는 "_location 으로
 * 스크롤 → origin 만큼 panBy" 두 단계라, 가운데 정렬(페이지가 컨테이너보다 좁음)에서 넘침으로 넘어가면 첫 단계의
 * 음수 scrollLeft 가 0 으로 잘린 몫(사라진 가운데 여백)을 보정하지 않는다(pdf_viewer.mjs #setScaleUpdatePages) —
 * 'auto' 에서 여는 첫 줌이 늘 이 전환을 탄다. 기준 페이지의 전후 사각형으로 남은 차이를 스크롤에 더한다.
 * 배율이 안 바뀌면 차이 0. 넘침이 없는 배율끼리는 스크롤이 0 에서 잘려 물리적으로 고정할 수 없다.
 */
function scaleAround(
  v: PDFViewer,
  el: HTMLElement,
  ox: number,
  oy: number,
  opts: { steps?: number; scaleFactor?: number; drawingDelay?: number },
  page: Element | null,
) {
  const pg: Element | undefined = page ?? v.getPageView(v.currentPageNumber - 1)?.div;
  const r = el.getBoundingClientRect();
  const b0 = pg?.getBoundingClientRect();
  const [top, left] = v.containerTopLeft;
  v.updateScale({ ...opts, origin: [ox + left, oy + top] });
  if (!pg || !b0?.width || !b0.height) return;
  const b1 = pg.getBoundingClientRect();
  // 줌 전 (ox, oy) 가 페이지의 어느 비율 지점이었나 → 줌 뒤 같은 비율 지점이 다시 (ox, oy) 에 오게
  const fx = (ox - (b0.left - r.left)) / b0.width;
  const fy = (oy - (b0.top - r.top)) / b0.height;
  el.scrollLeft += b1.left - r.left + fx * b1.width - ox;
  el.scrollTop += b1.top - r.top + fy * b1.height - oy;
}

type PdfStatus = "loading" | "password" | "ready" | "error";
type FindInfo = { open: boolean; query: string; state: number | null; current: number; total: number };

export interface PdfViewProps {
  projectId: string;
  path: string;
  /** commit·index 면 "작업 트리 파일" 배너 — 그 버전을 꺼내 오지 않는다. */
  mode?: DiffTarget["mode"];
  selectionRef?: SelectionRef;
}

/** 루트 밖으로 꺼내 쓰는 명령들 — effect 클로저가 소유한 상태(seen·task·암호 콜백)에 닿아야 해서 ref 로 연다. */
interface Ctl {
  viewer: PDFViewer | null;
  bus: EventBus | null;
  link: PDFLinkService | null;
  applyScale(value: string): void;
  retry(): void;
  submitPassword(pw: string): void;
  cancelPassword(): void;
  openLink(raw: string): void;
  /** 바이트를 화면 문서로 제자리 교체(스크롤·줌 보존). `data` 는 pdf.js 워커로 넘어가 파괴된다 — 사본을 넘겨라. */
  showBytes(data: Uint8Array, stamp: string): Promise<void>;
  /** 외부 변경 폴링이 이 stamp 를 이미 본 것으로 — 자기 저장·작업 사본 교체가 재로드를 부르지 않게. */
  markSeen(stamp: string): void;
  /** 폴링 읽기와 겹치지 않게 돈다(폴링이 끝나길 기다리고, 도는 동안 폴링은 건너뛴다). */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** 화면 문서의 페이지별 page space — 주석 좌표의 유일한 출처(getViewport scale 1). */
  pageInfos(): Promise<PdfPageInfo[]>;
}

// ── 주석 세션 ───────────────────────────────────────────────────────────────

type ViewMode = "view" | "annotate";
type EditBlock = "encrypted" | "restricted" | null;

/** 주석 편집 상태 한 벌 — undo 는 페이지 배열 스냅샷(엔진이 바뀐 노드만 새 참조라 싸다). 장부는 히스토리 밖이다(§6.1). */
interface AnnSession {
  infos: PdfPageInfo[];
  pages: EditorDoc[];
  ledger: PdfLedger;
  font: PdfFont | null;
  /** 장부가 가리키는 디스크 판 — 저장의 expectedStamp. */
  stamp: string;
  past: EditorDoc[][];
  future: EditorDoc[][];
}

const HISTORY_CAP = 200;

// ponytail: 창 메모리 초안 — 탭을 옮겼다 와도 남지만 앱을 끄면 사라진다. 세션 간 복구는 M3 사이드카(설계 §8.3).
const drafts = new Map<string, AnnSession>();

/** pdf-lib 를 끌고 오는 코어는 주석 모드 첫 진입 때만 — 보기 전용 사용자가 그 청크를 받지 않게. */
interface PdfCore {
  importAnnotations: typeof import("../../lib/pdf/import").importAnnotations;
  savePdf: typeof import("../../lib/pdf/save").savePdf;
  isDirty: typeof import("../../lib/pdf/save").isDirty;
  ensurePdfFont: typeof import("../../lib/pdf/fonts").ensurePdfFont;
}
let corePromise: Promise<PdfCore> | null = null;
/** 세션이 있으면 반드시 채워져 있다(세션은 코어를 받은 뒤에만 생긴다) — 렌더 중 dirty 판정용. */
let coreLoaded: PdfCore | null = null;
function loadPdfCore(): Promise<PdfCore> {
  corePromise ??= Promise.all([
    import("../../lib/pdf/import"),
    import("../../lib/pdf/save"),
    import("../../lib/pdf/fonts"),
  ]).then(
    ([i, s, f]) =>
      (coreLoaded = {
        importAnnotations: i.importAnnotations,
        savePdf: s.savePdf,
        isDirty: s.isDirty,
        ensurePdfFont: f.ensurePdfFont,
      }),
    (e: unknown) => {
      corePromise = null; // 청크 로드 실패는 다음 진입에서 다시 시도
      throw e;
    },
  );
  return corePromise;
}

const sessionDirty = (s: AnnSession | null) => !!s && !!coreLoaded && coreLoaded.isDirty(s.pages, s.ledger);

/**
 * 텍스트 노드의 저장 줄 — 화면 렌더(render.ts drawText)가 fillText 하는 런 하나 = PDF 줄 하나. 레이아웃 좌표는
 * 앵커 로컬이라 노드 x/y 를 더한다. 회전(rot)은 넣지 않는다 — 쓰는 쪽이 노드 rot 으로 cm 을 건다(계약 §write).
 */
function pdfTextLines(node: TextNode): PdfTextLine[] {
  const l = layoutText(node);
  const out: PdfTextLine[] = [];
  for (const line of l.lines) {
    for (const run of line.runs)
      if (run.text) out.push({ text: run.text, x: node.x + run.x, baseline: node.y + run.baseline });
    if (line.marker) out.push({ text: line.marker.text, x: node.x + line.marker.x, baseline: node.y + line.baseline });
  }
  return out;
}

/**
 * 텍스트 노드 글꼴을 PDF 임베드 폰트로 — 레이어는 새 텍스트를 고정 시스템 글꼴로 만든다(annotation/draft.ts).
 * 화면 줄바꿈과 저장본 글리프가 같은 폰트여야 줄이 안 어긋난다(§6.4 1항).
 */
function withPdfFont(nodes: Node[], font: PdfFont | null): Node[] {
  if (!font) return nodes;
  return nodes.map((n) => (n.kind === "text" && n.fontFamily !== font.family ? { ...n, fontFamily: font.family } : n));
}

const frames = (n = 2) =>
  new Promise<void>((res) => {
    const step = () => (--n > 0 ? requestAnimationFrame(step) : res());
    requestAnimationFrame(step);
  });

// ── DEV 훅(C-DEV) ─────────────────────────────────────────────────────────────
// window.__gpv.pdf = { list, byPath } — e2e 61 이 상태를 읽는다. 입력 쪽 window.__gpv.pdfOpts 는
// pdfjs.ts open 이 DEV 에서만 getDocument 옵션에 병합한다(이 파일은 읽지 않는다).
// 설치·등록은 전부 import.meta.env.DEV 분기 안이라 prod 번들에서 제거된다.

interface PdfDevState {
  id: number;
  projectId: string;
  path: string;
  status: PdfStatus;
  error: string | null;
  pagesCount: number;
  currentPage: number;
  scale: number;
  scaleValue: string | null;
  loadCount: number;
  reloadCount: number;
  readCount: number;
  lastStamp: string | null;
  passwordPrompts: number[];
  find: FindInfo;
  canvases: { dom: number; cached: number; visible: number; renderedPages: number };
  links: Array<{ href: string; allowed: boolean }>;
  workerKind: "worker" | "fake" | "pending";
  docOpts: PdfDocOpts | null;
  /** 만든 loading task 수 − destroy 한 수. 화면 문서 1 + 대기 중 task 외에는 0 이어야 한다. */
  liveTasks: number;
}

interface PdfDevHandle {
  readonly id: number;
  readonly projectId: string;
  readonly path: string;
  readonly root: HTMLElement;
  state(): PdfDevState;
  viewer(): unknown;
  eventBus(): unknown;
  doc(): unknown;
  /** 주석 모드 — 통합 검사가 CDP 로 몬다. */
  readonly annotate: PdfAnnotateDev;
}

type LastSave = { ok: true; stamp: string; at: number } | { ok: false; error: string; at: number };

interface PdfAnnotateDev {
  state(): {
    mode: ViewMode;
    /** 페이지별 노드 수 — 세션이 없으면 빈 배열. */
    nodes: number[];
    dirty: boolean;
    active: number;
    tool: Tool;
    editBlock: EditBlock;
    banner: "external" | "restored" | null;
    stamp: string | null;
    historyDepth: { past: number; future: number };
    lastSave: LastSave | null;
  };
  enterAnnotate(): Promise<void>;
  leaveAnnotate(): void;
  setTool(t: Tool): void;
  /** 스키마 정규화를 거쳐 페이지 노드를 통째로 바꾼다(undo 1칸). @returns 살아남은 노드 수 */
  setNodes(page: number, nodes: unknown[]): Promise<number>;
  getNodes(page: number): Node[];
  switchPage(page: number): void;
  save(): Promise<LastSave | null>;
  undo(): void;
  redo(): void;
  /** 페이지 page space (x,y) → client 좌표. */
  docToClient(page: number, x: number, y: number): { x: number; y: number } | null;
}

const devPdfs = import.meta.env.DEV ? new Set<PdfDevHandle>() : null;
if (import.meta.env.DEV) {
  const g = (window as unknown as { __gpv?: Record<string, unknown> }).__gpv;
  if (g)
    g.pdf = {
      list: () => [...devPdfs!],
      // 같은 path 중 가장 나중에 마운트된 것 — Set 은 삽입 순서를 지킨다.
      byPath: (p: string) => [...devPdfs!].filter((h) => h.path === p).pop(),
    };
}
let nextPdfId = 0;

/** 끝 1KB 에 %%EOF 가 있거나 mtime 이 충분히 지났나 — LaTeX·pandoc 이 쓰다 멈춘 파일을 걸러낸다. */
function looksComplete(data: Uint8Array, stamp: string): boolean {
  const tail = new TextDecoder("latin1").decode(data.subarray(Math.max(0, data.length - 1024)));
  if (tail.includes("%%EOF")) return true;
  // stamp = `<mtime_ms>:<len>`(diff.rs stamp_of) — mtime 을 해석하는 곳은 여기뿐이다.
  // 해석이 안 되면(NaN) 막지 않는다: `!(NaN < x)` 는 true.
  return !(Date.now() - Number(stamp.split(":")[0]) < EOF_GRACE_MS);
}

function findEvent(type: "" | "again", query: string, findPrevious: boolean) {
  return {
    source: null,
    type,
    query,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious,
    matchDiacritics: false,
  };
}

export default function PdfView({ projectId, path, mode, selectionRef }: PdfViewProps) {
  const msg = useMessages();
  const pushToast = useUi((s) => s.pushToast);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const pwInputRef = useRef<HTMLInputElement>(null);
  const ctl = useRef<Ctl | null>(null);

  // 리스너(effect 클로저)가 호출 시점 값을 읽어야 하는 것들 — 렌더 상태는 이것의 거울이다.
  const [live] = useState(() => ({
    status: "loading" as PdfStatus,
    error: null as string | null,
    loadCount: 0,
    reloadCount: 0,
    readCount: 0,
    lastStamp: null as string | null,
    liveTasks: 0,
    passwordPrompts: [] as number[],
    links: [] as Array<{ href: string; allowed: boolean }>,
    renderedPages: new Set<number>(),
    docOpts: null as PdfDocOpts | null,
    find: { open: false, query: "", state: null, current: 0, total: 0 } as FindInfo,
    lastSave: null as LastSave | null,
  }));

  const [status, setStatusState] = useState<PdfStatus>("loading");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [pw, setPw] = useState<{ reason: number } | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [loadCount, setLoadCount] = useState(0);
  const [pagesCount, setPagesCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [fit, setFit] = useState("auto");
  const [find, setFind] = useState<FindInfo>(live.find);
  const [sidebar, setSidebar] = useState(false);
  const [tab, setTab] = useState<"thumbs" | "outline">("thumbs");

  // ── 주석 ──
  const draftKey = `${projectId}\0${path}`;
  const [annMode, setModeState] = useState<ViewMode>("view");
  const modeRef = useRef<ViewMode>("view");
  const setMode = (m: ViewMode) => {
    modeRef.current = m;
    setModeState(m);
  };
  const [sess, setSessState] = useState<AnnSession | null>(null);
  // 리스너·비동기 저장이 호출 시점 값을 읽는다 — 커밋은 이 ref 를 동기로 갱신한다(같은 틱의 저장이 옛 페이지를 쓰지 않게).
  const sessRef = useRef<AnnSession | null>(null);
  const setSess = (s: AnnSession | null) => {
    sessRef.current = s;
    setSessState(s);
  };
  const [active, setActive] = useState(0);
  const activeRef = useRef(0);
  const [paint, setPaint] = useState<DefaultPaint>(PDF_PAINT);
  const [opacity, setOpacity] = useState(1);
  const [entering, setEntering] = useState(false);
  const enteringRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [banner, setBanner] = useState<{ kind: "external"; stamp: string } | { kind: "restored" } | null>(null);
  const [editBlock, setEditBlock] = useState<EditBlock>(null);
  const layerRef = useRef<AnnotationLayerHandle | null>(null);
  const tool = useImageEditorUi((s) => s.tool);
  const selectedIds = useImageEditorUi((s) => s.selectedIds);
  const askConfirm = useUi((s) => s.askConfirm);
  const annotating = annMode === "annotate" && sess !== null;
  const dirty = sessionDirty(sess);
  // 폴링(effect 클로저)이 부르는 주석 훅 — 렌더마다 최신 클로저로 바꿔 끼운다.
  const annHooks = useRef<{ hold(): boolean; onHeld(stamp: string): void; onReloaded(): void }>({
    hold: () => false,
    onHeld: (_stamp: string) => {},
    onReloaded: () => {},
  });
  const annDev = useRef<PdfAnnotateDev | null>(null);

  const setStatus = (s: PdfStatus, err: string | null = null) => {
    live.status = s;
    live.error = err;
    setStatusState(s);
    setErrorText(err);
  };
  const patchFind = (p: Partial<FindInfo>) => {
    live.find = { ...live.find, ...p };
    setFind(live.find);
  };

  useEffect(() => {
    let dead = false;
    const ac = new AbortController();
    const { signal } = ac;
    let lib: Pdfjs | null = null;
    let viewer: PDFViewer | null = null;
    let link: PDFLinkService | null = null;
    let ro: ResizeObserver | null = null;
    let timer: number | undefined;
    let busy = false;
    let seen: string | null = null;
    let task: PDFDocumentLoadingTask | null = null; // 화면 문서의 task
    let pending: PDFDocumentLoadingTask | null = null; // 여는 중(암호 대기 포함)
    let shown: PDFDocumentProxy | null = null;
    let password: string | undefined;
    let pwUpdate: ((pw: string | Error) => void) | null = null;
    let pendingScale: string | null = null;
    let prev: { page: number; scaleValue: string; ratio: number; pagesCount: number } | null = null;
    let handle: PdfDevHandle | undefined;

    // setDocument 에 넘긴 task 외에는 전부 destroy 한다 — worker 를 넘겼으니 공유 워커는 안 죽고
    // (task._worker=null), 워커 쪽 문서·전송 데이터(최대 256MB)만 Terminate 로 풀린다. 두 번 세지 않게 destroyed 로 거른다.
    const kill = (t: PDFDocumentLoadingTask | null) => {
      if (!t || t.destroyed) return;
      live.liveTasks--;
      t.destroy().catch(() => {});
    };

    const applyScale = (value: string) => {
      const el = scrollRef.current;
      if (!viewer || !el) return;
      // 프리셋 계산에 폭 0 가드가 없다(숨김 마운트) — 보일 때 ResizeObserver 가 적용한다.
      if (el.clientWidth > 0) {
        pendingScale = null;
        viewer.currentScaleValue = value;
      } else pendingScale = value;
    };

    const openLink = (raw: string) => {
      const allowed = /^(https?|mailto):/i.test(raw);
      if (import.meta.env.DEV) live.links.push({ href: raw, allowed });
      // ipc 는 호출 시점 속성 조회 — e2e 가 모듈의 ipc.openExternalUrl 을 스파이로 바꾼다.
      if (allowed) ipc.openExternalUrl(raw).catch((e) => pushToast("error", errorMessage(e)));
    };

    const swapIn = async (data: Uint8Array, stamp: string) => {
      if (!lib || !viewer || !link) return;
      let t: PDFDocumentLoadingTask | null = null;
      let opts: PdfDocOpts | null = null;
      let next: PDFDocumentProxy;
      let perms: Set<number> | null;
      let prompted = false;
      try {
        ({ task: t, opts } = lib.open(data, password));
        live.liveTasks++;
        pending = t;
        t.onPassword = (update: (pw: string | Error) => void, reason: number) => {
          if (import.meta.env.DEV) live.passwordPrompts.push(reason);
          if (dead) return update(new Error("unmounted"));
          prompted = true;
          pwUpdate = update;
          setPw({ reason });
          setStatus("password");
        };
        next = await t.promise;
        // 원래 권한은 아래에서 getPermissions 를 덮기 **전에** 읽는다. pdf.js 는 암호화 문서에서만 배열을 준다.
        perms = await next.getPermissions();
      } catch (e) {
        if (pending === t) pending = null;
        pwUpdate = null;
        kill(t);
        if (dead) return;
        setPw(null);
        // 암호 취소면 pdf.js 가 PasswordException 으로 거절한다.
        const cancelled = (e as Error | null)?.name === "PasswordException";
        if (shown) setStatus("ready", cancelled ? null : loadErrorText(e)); // 현 화면 유지
        else setStatus("error", cancelled ? currentMessages().pdf.view.passwordRequired : loadErrorText(e));
        return;
      }
      if (pending === t) pending = null;
      pwUpdate = null;
      if (dead) return kill(t);

      // annotationEditorMode DISABLE 을 재로드에도 지킨다. setDocument 는 기존 문서가 있으면 모드를 NONE 으로
      // 되돌려(pdf_viewer.mjs setDocument) 두 번째 로드부터 AnnotationEditorUIManager 를 만든다 — window keydown·
      // document dragover/drop 리스너가 붙고, 이미지를 떨어뜨리면 STAMP 모드로 들어가 창 안 textarea 의 Backspace·
      // Ctrl+A 기본 동작을 막는다. 모드를 되살리는 공개 경로는 권한뿐이다: enablePermissions + MODIFY_CONTENTS 만
      // 뺀 권한이면 #initializePermissions 가 DISABLE 로 내린다. 나머지는 전부 줘 복사·인쇄·폼 표시는 기본(권한
      // 무시)과 같다. 문서 자체의 권한 제한도 지금처럼 무시한다.
      const PF = lib.lib.PermissionFlag;
      const noEdit = new Set(Object.values(PF).filter((f) => f !== PF.MODIFY_CONTENTS));
      next.getPermissions = () => Promise.resolve(noEdit);
      // 암호화 문서의 증분 저장(새 객체를 문서 키로 암호화하는지)은 미검증이라 주석을 막는다(설계 §7.4).
      setEditBlock(
        perms === null && !prompted
          ? null
          : perms && !perms.has(PF.MODIFY_ANNOTATIONS)
            ? "restricted"
            : "encrypted",
      );

      const el = scrollRef.current!;
      const had = shown !== null;
      prev = had
        ? {
            page: viewer.currentPageNumber,
            scaleValue: pendingScale ?? viewer.currentScaleValue ?? "auto",
            ratio: el.scrollHeight ? el.scrollTop / el.scrollHeight : 0,
            pagesCount: viewer.pagesCount,
          }
        : null;
      viewer.setDocument(next);
      link.setDocument(next);
      kill(task); // 옛 task 는 setDocument 뒤에 — 그 전에 부수면 렌더 중인 페이지가 Transport destroyed 로 깨진다
      task = t;
      shown = next;
      live.loadCount++;
      if (had) live.reloadCount++;
      live.lastStamp = stamp;
      live.renderedPages.clear();
      if (import.meta.env.DEV) live.docOpts = opts;
      setDoc(next);
      setLoadCount(live.loadCount);
      setPagesCount(next.numPages);
      setPw(null);
      setStatus("ready");
    };

    const poll = async () => {
      const el = scrollRef.current;
      if (busy || !viewer || !el) return;
      // 숨은 탭(display:none)·최소화 창에서는 읽지 않는다 — 256MB 재읽기 비용에 더해, scrollHeight 0 에서
      // 재로드하면 스크롤 비율을 잃는다. 보일 때 ResizeObserver·visibilitychange 가 즉시 tick 한다.
      if (el.clientWidth === 0 || document.visibilityState === "hidden") return;
      let s: string | null;
      try {
        s = await ipc.fileStamp(projectId, path);
      } catch (e) {
        if (dead) return;
        // 상위 폴더째 사라지면(latexmk -C 등) null 이 아니라 NOT_FOUND 로 reject 한다.
        if (!(isIpcError(e) && e.code === "NOT_FOUND")) {
          if (!shown) setStatus("error", errorMessage(e));
          return;
        }
        s = null;
      }
      if (dead || busy) return;
      if (s === null) {
        if (!shown) setStatus("error", NOT_FOUND);
        return;
      }
      if (s === seen) return;
      // 저장 안 한 주석이 있으면 다시 읽지 않는다 — 배너로 묻는다(설계 §7.3). seen 을 안 바꾸니 tick 마다 다시 알린다.
      if (annHooks.current.hold()) {
        annHooks.current.onHeld(s);
        return;
      }
      busy = true;
      try {
        live.readCount++;
        let buf: ArrayBuffer;
        try {
          buf = await ipc.readFileRaw(projectId, path);
        } catch (e) {
          if (dead) return;
          seen = s; // 실패해도 기록 — 같은 stamp 를 무한히 다시 읽지 않게. [다시 시도]만 초기화한다.
          if (shown) live.error = errorMessage(e);
          else setStatus("error", errorMessage(e));
          return;
        }
        const after = await ipc.fileStamp(projectId, path).catch(() => undefined);
        // 읽는 사이 바뀌었으면 버린다(seen 그대로 → 다음 tick 에 다시).
        if (dead || after !== s) return;
        const data = new Uint8Array(buf);
        // 쓰다 멈춘 파일 — seen 을 기록하지 않아 다음 tick 에 다시 읽는다.
        if (!looksComplete(data, s)) return;
        seen = s;
        // 암호 입력 대기도 이 안에서 기다린다 → 그동안 busy 라 폴링 읽기가 멈춘다(제출·취소 후 재개).
        await swapIn(data, s);
        if (!dead && live.lastStamp === s) annHooks.current.onReloaded();
      } finally {
        busy = false;
      }
    };

    // setTimeout 체인 — 즉시 tick(뷰어 생성·다시 보임·다시 시도)이 끼어도 타이머는 하나만 둔다.
    const tick = async () => {
      if (dead) return;
      clearTimeout(timer);
      try {
        await poll();
      } finally {
        // busy 면 진행 중인 쪽이 끝나면서 다시 건다.
        if (!dead && !busy) {
          clearTimeout(timer);
          timer = window.setTimeout(tick, POLL_MS);
        }
      }
    };

    const start = async () => {
      try {
        lib = await loadPdfjs();
        if (dead) return;
        const container = scrollRef.current!;
        const V = lib.viewer;
        const bus = new V.EventBus();
        link = new V.PDFLinkService({ eventBus: bus });
        const findController = new V.PDFFindController({ eventBus: bus, linkService: link });
        // PDFViewer 에 abortSignal 을 넘기지 않는다. TextLayerBuilder 의 전역 selection 리스너는 static 이라
        // **처음** 텍스트 레이어를 만든 뷰어의 signal 로 한 번만 설치된다(pdf_viewer.mjs
        // #enableGlobalSelectionListener). 그 인스턴스가 먼저 언마운트돼 abort 하면 리스너가 사라지는데,
        // 다른 인스턴스의 텍스트 레이어가 남아 있으면 재설치되지 않는다 → 그쪽에서 `.selecting` 이 안 떨어져
        // 링크가 클릭되지 않는다(분할 4칸·Git 모달에서 먼저 연 패널을 닫으면 재현). 정리는 setDocument(null)
        // (_cancelRendering → textLayer.cancel → 전역 리스너 자체 해제)로 한다.
        // ponytail: 내부 ResizeObserver·scroll 리스너는 분리된 container 와 함께 수거된다고 본다(추정).
        // upstream 이 static 리스너를 인스턴스별로 고치면 abortSignal 로 되돌린다.
        const v = (viewer = new V.PDFViewer({
          container,
          viewer: innerRef.current!,
          eventBus: bus,
          linkService: link,
          findController,
          textLayerMode: 1,
          // 폼은 표시만(입력칸 없음), 편집 UI 매니저 없음(window keydown·selectionchange 리스너를 단다).
          annotationMode: lib.lib.AnnotationMode.ENABLE,
          annotationEditorMode: lib.lib.AnnotationEditorType.DISABLE,
          enablePermissions: true, // 재로드에도 편집 모드 DISABLE 유지 — swapIn 의 getPermissions 참고
        }));
        link.setViewer(v);
        c.viewer = v;
        c.bus = bus;
        c.link = link;
        const id = ++nextPdfId;

        const on = (name: string, fn: (e: never) => void) => bus.on(name, fn, { signal });
        // pdf.js goToDestination(내부 링크·목차)은 목적지 쪽 textlayerrendered 를 한 번 기다렸다가 textLayer.div.focus()
        // 를 부른다(pdf_viewer.mjs:6625-6633). 그 쪽이 이미 그려져 있으면 **다음** 재렌더(줌·사이드바 리사이즈) 때 발화해
        // 스크롤을 목적지로 되감는다 — 썸네일로 옮긴 2쪽이 수십 ms 뒤 3쪽으로 튀었다(계측: focus 스택이 6628).
        // EventBus 는 내부 리스너를 외부보다 먼저 돌리므로 textlayerrendered 에서 감싸면 늦고, 재렌더가 텍스트 레이어를
        // 새로 만들면 새 div 가 감싸이지 않는다. pagerender 는 draw() 끝에서 **동기로** 나가고 텍스트 레이어 렌더는
        // 비동기라, 여기서 감싸면 그 렌더의 textlayerrendered 보다 반드시 먼저다. 포커스 이동 자체는 유지한다.
        on("pagerender", (e: { source?: { textLayer?: { div?: HTMLElement } } }) => {
          const div = e.source?.textLayer?.div as (HTMLElement & { gpvNoScrollFocus?: true }) | undefined;
          if (!div || div.gpvNoScrollFocus) return;
          div.gpvNoScrollFocus = true;
          const focus = div.focus.bind(div);
          div.focus = (opts?: FocusOptions) => focus({ ...opts, preventScroll: true });
        });
        on("pagesinit", () => {
          // pdf.js '전체 복사' 트리거를 뗀다. 선택이 이 숨은 요소를 품으면 document copy 리스너가 네이티브 복사를
          // 막고 문서 전문을 clipboard.writeText 한다 — 선택 판정이 containsNode 라 앱 전체 Ctrl+A(마크다운 패널
          // 등)도 걸리고, 인스턴스마다 리스너가 있어 열린 PDF 가 여럿이면 마지막에 쓴 쪽이 이긴다. 떼면(분리 노드는
          // containsNode false) 리스너는 남아도 아무것도 안 한다. 뷰어 안 Ctrl+A 는 onKeyDown 이 이 컨테이너로 좁힌다.
          container.querySelectorAll(":scope > #hiddenCopyElement").forEach((x) => x.remove());
          const p = prev;
          prev = null;
          applyScale(p?.scaleValue ?? "auto");
          if (p) {
            if (p.pagesCount === v.pagesCount) container.scrollTop = p.ratio * container.scrollHeight;
            else v.currentPageNumber = Math.min(p.page, v.pagesCount);
          }
          setPagesCount(v.pagesCount);
          setCurrentPage(v.currentPageNumber);
          // setDocument 가 찾기 컨트롤러를 초기화한다 — 열린 채 재로드되면 새 문서로 다시 찾는다.
          if (live.find.open && live.find.query) bus.dispatch("find", findEvent("", live.find.query, false));
        });
        on("pagechanging", (e: { pageNumber: number }) => setCurrentPage(e.pageNumber));
        on("scalechanging", (e: { scale: number; presetValue?: string }) => {
          setScale(e.scale);
          setFit(e.presetValue && PRESETS.has(e.presetValue) ? e.presetValue : "");
        });
        on("updatefindmatchescount", (e: { matchesCount: { current: number; total: number } }) =>
          patchFind({ current: e.matchesCount.current, total: e.matchesCount.total }),
        );
        on(
          "updatefindcontrolstate",
          (e: { state: number; matchesCount: { current: number; total: number } }) =>
            patchFind({ state: e.state, current: e.matchesCount.current, total: e.matchesCount.total }),
        );
        on("pagerendered", (e: { pageNumber: number; isDetailView?: boolean }) => {
          if (!e.isDetailView) live.renderedPages.add(e.pageNumber);
        });

        // 링크: pdf.js 내부 이동은 앵커 onclick(return false)이 처리하고, 캡처 단계 preventDefault 는 그걸
        // 막지 않는다 — 그래서 href 와 무관하게 항상 막는다(빈 href 가 문서 창 자체를 리로드하는 경로 차단).
        // 외부 열기는 http/https/mailto 만(Rust 가 신뢰 경계에서 재검증). stopPropagation 은 하지 않는다.
        const linkOf = (e: Event) =>
          (e.target as Element | null)?.closest?.(".annotationLayer a") ?? null;
        const onLinkClick = (e: MouseEvent) => {
          const a = linkOf(e);
          // auxclick 은 우클릭에도 온다 — 컨텍스트 메뉴를 열려다 링크가 열리면 안 된다(중클릭만).
          if (!a || (e.type === "auxclick" && e.button !== 1)) return;
          e.preventDefault();
          const raw = a.getAttribute("href"); // a.href 는 절대 URL 로 풀려 '#…'·'' 판정이 틀어진다
          if (raw && !raw.startsWith("#")) openLink(raw);
        };
        container.addEventListener("click", onLinkClick, { capture: true, signal });
        container.addEventListener("auxclick", onLinkClick, { capture: true, signal });
        // 앵커를 끌어 웹뷰에 떨어뜨리면 그 URL 로 이동할 수 있다 — 앱에 drop 방지가 없다.
        container.addEventListener(
          "dragstart",
          (e) => {
            if (linkOf(e)) e.preventDefault();
          },
          { capture: true, signal },
        );

        // Ctrl/⌘+휠: 커서 고정 줌. updateScale 이 1% 단위로 반올림하므로 작은 delta(트랙패드)는 누적해
        // 반올림 결과가 달라질 때만 부른다 — 양쪽 다 반올림해 비교해야 'auto'(1.2345…)에서 스냅다운하지 않는다.
        let acc = 1;
        container.addEventListener(
          "wheel",
          (e) => {
            if (!(e.ctrlKey || e.metaKey)) return; // 일반 휠은 네이티브 스크롤
            e.preventDefault();
            if (!v.pdfDocument) return;
            acc *= Math.pow(WHEEL_STEP, -e.deltaY / 100);
            const cur = v.currentScale;
            if (Math.round(cur * acc * 100) === Math.round(cur * 100)) return;
            const r = container.getBoundingClientRect();
            scaleAround(
              v,
              container,
              e.clientX - r.left,
              e.clientY - r.top,
              { scaleFactor: acc, drawingDelay: 400 },
              (e.target as Element | null)?.closest?.(".page") ?? null,
            );
            acc = 1;
          },
          { passive: false, signal },
        );

        let lastWidth = container.clientWidth;
        ro = new ResizeObserver(() => {
          if (dead) return;
          const w = container.clientWidth;
          const appeared = lastWidth === 0 && w > 0;
          lastWidth = w;
          if (w === 0) return;
          if (appeared) void tick();
          if (!v.pdfDocument) return;
          if (pendingScale !== null) applyScale(pendingScale);
          // 내부 ResizeObserver 는 높이 변수만 갱신한다 — 프리셋이면 같은 값을 다시 대입해 재계산시킨다.
          else if (PRESETS.has(v.currentScaleValue))
            requestAnimationFrame(() => {
              if (dead || !PRESETS.has(v.currentScaleValue)) return;
              // 재대입은 _location(스크롤 이벤트로 늦게 갱신)으로 되감아 스크롤한다 — 리사이즈 직후 막 끝난 이동이
              // 옛 쪽으로 튄다(계측: scrollPageIntoView ← #setScaleUpdatePages, _location 3쪽). update()가 먼저 맞춘다.
              v.update();
              v.currentScaleValue = v.currentScaleValue;
            });
        });
        ro.observe(container);
        document.addEventListener(
          "visibilitychange",
          () => {
            if (document.visibilityState === "visible") void tick();
          },
          { signal },
        );

        if (selectionRef)
          selectionRef.current = () => {
            const s = document.getSelection();
            return s && !s.isCollapsed && rootRef.current?.contains(s.anchorNode) ? s.toString() : "";
          };

        if (import.meta.env.DEV) {
          const pdfjs = lib;
          const root = rootRef.current!;
          handle = {
            id,
            projectId,
            path,
            root,
            viewer: () => v,
            eventBus: () => bus,
            doc: () => shown,
            // 렌더마다 바뀌는 클로저로 위임한다 — 핸들은 effect 가 한 번 만든다.
            annotate: {
              state: () => annDev.current!.state(),
              enterAnnotate: () => annDev.current!.enterAnnotate(),
              leaveAnnotate: () => annDev.current!.leaveAnnotate(),
              setTool: (t) => annDev.current!.setTool(t),
              setNodes: (pg, nodes) => annDev.current!.setNodes(pg, nodes),
              getNodes: (pg) => annDev.current!.getNodes(pg),
              switchPage: (pg) => annDev.current!.switchPage(pg),
              save: () => annDev.current!.save(),
              undo: () => annDev.current!.undo(),
              redo: () => annDev.current!.redo(),
              docToClient: (pg, x, y) => annDev.current!.docToClient(pg, x, y),
            },
            state: () => ({
              id,
              projectId,
              path,
              status: live.status,
              error: live.error,
              pagesCount: v.pagesCount,
              currentPage: v.currentPageNumber,
              scale: v.currentScale,
              scaleValue: v.currentScaleValue ?? null,
              loadCount: live.loadCount,
              reloadCount: live.reloadCount,
              readCount: live.readCount,
              lastStamp: live.lastStamp,
              passwordPrompts: [...live.passwordPrompts],
              find: { ...live.find },
              canvases: {
                dom: root.querySelectorAll(".pdfViewer .page .canvasWrapper canvas:not(.detailView)")
                  .length,
                cached: v.getCachedPageViews().size,
                visible: (v._getVisiblePages() as { views: unknown[] }).views.length,
                renderedPages: live.renderedPages.size,
              },
              links: live.links.map((l) => ({ ...l })),
              workerKind: pdfjs.workerKind(),
              docOpts: live.docOpts && { ...live.docOpts },
              liveTasks: live.liveTasks,
            }),
          };
          devPdfs!.add(handle);
        }

        void tick(); // 뷰어 생성 직후 1회는 즉시
      } catch (e) {
        if (!dead) setStatus("error", errorMessage(e));
      }
    };

    const c: Ctl = {
      viewer: null,
      bus: null,
      link: null,
      applyScale,
      openLink,
      retry: () => {
        seen = null; // 암호(password)는 유지한다
        if (!shown) setStatus("loading");
        if (viewer) void tick();
        else void start(); // 로더·뷰어 생성 자체가 실패했던 경우
      },
      submitPassword: (value) => {
        const u = pwUpdate;
        if (!u) return;
        pwUpdate = null; // 판정 중 Enter 연타가 다음 프롬프트의 capability 를 옛 값으로 채우지 않게
        password = value; // trim 하지 않는다. 이후 재로드에 재사용
        u(value);
      },
      cancelPassword: () => {
        const u = pwUpdate;
        pwUpdate = null;
        u?.(new Error("cancelled"));
      },
      showBytes: swapIn,
      markSeen: (stamp) => {
        seen = stamp;
      },
      exclusive: async (fn) => {
        while (busy) await new Promise((r) => setTimeout(r, 50));
        busy = true;
        try {
          return await fn();
        } finally {
          busy = false;
          // 그사이 tick 이 busy 를 보고 타이머를 걸지 않았을 수 있다 — 폴링 체인을 다시 잇는다.
          if (!dead && viewer) void tick();
        }
      },
      pageInfos: async () => {
        const d = shown;
        if (!d) throw new Error(currentMessages().pdf.view.openFailed);
        return Promise.all(
          Array.from({ length: d.numPages }, async (_, i): Promise<PdfPageInfo> => {
            const vp = (await d.getPage(i + 1)).getViewport({ scale: 1 });
            return { index: i, w: vp.width, h: vp.height, toPage: [...vp.transform] as Affine };
          }),
        );
      },
    };
    ctl.current = c;
    void start();

    return () => {
      dead = true;
      clearTimeout(timer);
      const u = pwUpdate;
      pwUpdate = null;
      u?.(new Error("unmounted")); // 안 부르면 pdf.js #passwordCapability 가 영구 대기한다
      ac.abort();
      ro?.disconnect();
      if (viewer) {
        viewer.setDocument(null as unknown as PDFDocumentProxy);
        link?.setDocument(null);
      }
      kill(pending);
      kill(task); // 공유 워커는 destroy 하지 않는다(pdfjs.ts)
      if (selectionRef) selectionRef.current = null;
      if (ctl.current === c) ctl.current = null;
      if (import.meta.env.DEV && handle) devPdfs!.delete(handle);
    };
    // 마운트 1회 — projectId·path 가 바뀌면 DiffViewer 가 key 로 리마운트한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 스크롤 컨테이너 자체에 포커스가 있어야 Space·PageDown 네이티브 스크롤이 먹는다(ImageView 와 같은 패턴).
  useEffect(() => {
    scrollRef.current?.focus({ preventScroll: true });
  }, []);

  const liveViewer = () => ctl.current?.viewer ?? null;

  const zoom = (steps: number) => {
    const v = liveViewer();
    const el = scrollRef.current;
    if (!v || !el) return;
    scaleAround(v, el, el.clientWidth / 2, el.clientHeight / 2, { steps }, null);
  };

  const openFind = () => {
    // 닫혀 있으면 먼저 그려야 input 이 생긴다 — 숨은 요소의 focus() 는 조용히 실패한다.
    if (!live.find.open) flushSync(() => patchFind({ open: true }));
    findInputRef.current?.focus();
    findInputRef.current?.select();
  };
  const closeFind = () => {
    patchFind({ open: false });
    ctl.current?.bus?.dispatch("findbarclose", { source: null });
    scrollRef.current?.focus({ preventScroll: true });
  };
  const stepFind = (previous: boolean) =>
    ctl.current?.bus?.dispatch("find", findEvent("again", live.find.query, previous));
  const changeQuery = (query: string) => {
    patchFind({ query });
    ctl.current?.bus?.dispatch("find", findEvent("", query, false));
  };

  const commitPage = () => {
    const v = liveViewer();
    const n = parseInt(pageDraft ?? "", 10);
    setPageDraft(null);
    if (v?.pdfDocument && Number.isInteger(n)) v.currentPageNumber = Math.min(Math.max(n, 1), v.pagesCount);
  };

  const openExternal = () =>
    void ipc.runExecutable(projectId, path).catch((e) => pushToast("error", errorMessage(e)));

  // ── 주석 동작 ─────────────────────────────────────────────────────────────

  const ta = msg.pdf.annotate;
  const focusRoot = () => scrollRef.current?.focus({ preventScroll: true });
  const selIds = (): ObjId[] =>
    useImageEditorUi.getState().selectedIds.filter((id): id is ObjId => id !== "__base");

  /** 문서 전체 스냅샷 1칸 = 커밋 1회. */
  const commitPages = (pages: EditorDoc[]) => {
    const s = sessRef.current;
    if (!s) return;
    setSess({ ...s, pages, past: [...s.past, s.pages].slice(-HISTORY_CAP), future: [] });
  };
  const commitPageNodes = (page: number, objects: Node[]) => {
    const s = sessRef.current;
    if (!s?.pages[page]) return;
    commitPages(s.pages.map((d, i) => (i === page ? { ...d, objects: withPdfFont(objects, s.font) } : d)));
  };
  const activeObjects = () => sessRef.current?.pages[activeRef.current]?.objects ?? [];

  const undo = () => {
    // 펜 드래프트 중이면 마지막 정점만 무른다 — 문서 undo 로 새면 그리기 전 편집이 대신 사라진다.
    if (layerRef.current?.handleUndo()) return;
    const s = sessRef.current;
    if (!s?.past.length) return;
    useImageEditorUi.getState().select([]);
    setSess({ ...s, pages: s.past[s.past.length - 1], past: s.past.slice(0, -1), future: [s.pages, ...s.future] });
  };
  const redo = () => {
    const s = sessRef.current;
    if (!s?.future.length) return;
    useImageEditorUi.getState().select([]);
    setSess({ ...s, pages: s.future[0], past: [...s.past, s.pages].slice(-HISTORY_CAP), future: s.future.slice(1) });
  };
  const removeSel = () => {
    const ids = selIds();
    if (!ids.length) return;
    commitPageNodes(activeRef.current, treeRemove(activeObjects(), ids));
    useImageEditorUi.getState().select([]);
  };
  const duplicateSel = () => {
    const ids = new Set(selIds());
    const objs = activeObjects();
    // 컨테이너는 기하가 없다 — PDF 도구는 그룹을 만들지 않으므로 말단만 온다(ImageEditor duplicateSel 과 같은 범위).
    const copies = objs
      .filter((o) => ids.has(o.id))
      .map((o): Node =>
        isGeomNode(o)
          ? { ...translateObject(o, DUPLICATE_OFFSET, DUPLICATE_OFFSET), id: newObjId() }
          : { ...o, id: newObjId() },
      );
    if (!copies.length) return;
    commitPageNodes(activeRef.current, [...objs, ...copies]);
    useImageEditorUi.getState().select(copies.map((o) => o.id));
  };
  const nudgeSel = (e: KeyboardEvent) => {
    // auto-repeat 는 무시한다 — 초당 ~30 커밋이면 히스토리 200칸이 7초에 소진된다(ImageEditor K5).
    if (e.repeat) return;
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    const ids = new Set(selIds());
    if ((!dx && !dy) || !ids.size) return;
    commitPageNodes(
      activeRef.current,
      activeObjects().map((o) => (ids.has(o.id) && isGeomNode(o) ? translateObject(o, dx, dy) : o)),
    );
  };

  const changePaint = (c: PdfPaintChange) => {
    setPaint((p) => applyPdfPaintDefaults(p, c));
    if (c.opacity !== undefined) setOpacity(c.opacity);
    const ids = new Set(selIds());
    if (!ids.size || modeRef.current !== "annotate") return;
    const objs = activeObjects();
    let changed = false;
    const next = objs.map((o) => {
      if (!ids.has(o.id)) return o;
      const n = applyPdfPaint(o, c);
      if (n !== o) changed = true;
      return n;
    });
    if (changed) commitPageNodes(activeRef.current, next);
    // 스와치·색 칸에 포커스가 남으면 Space 가 손 도구 대신 그 버튼을 다시 누른다. 숫자 칸은 그대로 둔다 —
    // 여기서 blur 시키면 같은 값으로 onBlur 커밋이 한 번 더 돈다.
    const el = document.activeElement;
    if (el instanceof HTMLButtonElement || (el instanceof HTMLInputElement && el.type === "color")) focusRoot();
  };

  /** 활성 페이지 전환 — 순서가 계약이다(설계 §8.2): 텍스트 확정 → 스토어 잔재 정리 → flushSync 로 활성 변경. */
  const switchPage = (i: number) => {
    const s = sessRef.current;
    if (!s || i === activeRef.current || i < 0 || i >= s.pages.length) return;
    const ui = useImageEditorUi.getState();
    // 레이어에는 언마운트 확정 경로가 없고, 제거되는 textarea 의 onBlur 에 기댈 수도 없다.
    if (ui.textEditing) layerRef.current?.handleEscape();
    ui.select([]);
    ui.setHover(null);
    ui.setTextEditing(false);
    if (useImageEditorUi.getState().mode.kind !== "design") ui.setMode({ kind: "design" });
    activeRef.current = i;
    // 곧바로 이어지는 첫 클릭이 커밋 전 DOM 에 떨어지지 않게.
    flushSync(() => setActive(i));
  };

  const discardSession = () => {
    setSess(null);
    setMode("view");
    useImageEditorUi.getState().reset();
  };

  const enterAnnotate = async () => {
    const c = ctl.current;
    // ref 로 막는다 — 같은 렌더 클로저의 두 번 클릭은 entering 상태를 둘 다 false 로 본다.
    if (!c || enteringRef.current || editBlock || live.status !== "ready") return;
    if (sessRef.current) {
      setMode("annotate");
      return;
    }
    enteringRef.current = true;
    setEntering(true);
    try {
      const core = await loadPdfCore();
      const font = await core.ensurePdfFont();
      const notes = await c.exclusive(async () => {
        const s0 = await ipc.fileStamp(projectId, path);
        const buf = await ipc.readFileRaw(projectId, path);
        const s1 = await ipc.fileStamp(projectId, path);
        if (s0 === null || s0 !== s1) throw new Error(currentMessages().pdf.annotate.fileChanging);
        const bytes = new Uint8Array(buf);
        // 화면이 디스크보다 옛 판이면 먼저 맞춘다 — infos 와 가져오기가 같은 판을 봐야 한다.
        if (s0 !== live.lastStamp) await c.showBytes(bytes.slice(), s0);
        const infos = await c.pageInfos();
        const r = await core.importAnnotations(bytes.slice(), infos, font);
        // 편집 가능 주석을 뺀 작업 사본 — 오버레이와 pdf.js 가 같은 주석을 두 번 그리지 않게.
        if (r.workingCopy) await c.showBytes(r.workingCopy, s0);
        c.markSeen(s0);
        let next: AnnSession = {
          infos,
          pages: r.pages.map((d) => ({ ...d, objects: withPdfFont(d.objects, font) })),
          ledger: r.ledger,
          font,
          stamp: s0,
          past: [],
          future: [],
        };
        const d = drafts.get(draftKey);
        drafts.delete(draftKey);
        let restored = false;
        // 같은 판에서 만든 초안만 — 판이 바뀌었으면 장부(refs)가 엉뚱한 객체를 가리킨다.
        if (d && d.stamp === s0 && d.pages.length === infos.length) {
          next = { ...d, infos, font };
          restored = true;
        }
        useImageEditorUi.getState().reset(); // 창 싱글턴 편집기 UI 잔재를 한 번 비운다(도구도 select 로)
        const v = c.viewer;
        const first = Math.min(Math.max((v?.currentPageNumber ?? 1) - 1, 0), infos.length - 1);
        activeRef.current = first;
        setActive(first);
        setSess(next);
        setMode("annotate");
        setBanner(restored ? { kind: "restored" } : null);
        return r.notes;
      });
      if (!font) pushToast("info", ta.noFont);
      if (notes.length) pushToast("info", notes.join("\n"));
    } catch (e) {
      pushToast("error", currentMessages().pdf.annotate.enterFailed(errorMessage(e)));
    } finally {
      enteringRef.current = false;
      setEntering(false);
    }
  };

  const leaveAnnotate = () => {
    if (useImageEditorUi.getState().textEditing) layerRef.current?.handleEscape();
    useImageEditorUi.getState().select([]);
    setMode("view");
  };

  /** @param override 외부 변경 확인창에서 '그래도 저장' — 디스크 새 판 위에 장부 없이(전부 새 주석으로) 쓴다(설계 §7.3). */
  const save = async (override = false): Promise<LastSave | null> => {
    const c = ctl.current;
    const core = coreLoaded;
    if (!c || !core || !sessRef.current || savingRef.current) return null;
    // 입력 중인 글자도 저장에 들어가야 한다 — 확정 커밋이 sessRef 를 동기로 갱신한다.
    if (useImageEditorUi.getState().textEditing) layerRef.current?.handleEscape();
    savingRef.current = true;
    setSaving(true);
    let result: LastSave;
    try {
      const stamp = await c.exclusive(async () => {
        const s = sessRef.current!;
        let expected = s.stamp;
        let ledger = s.ledger;
        if (override) {
          const now = await ipc.fileStamp(projectId, path);
          if (now === null) throw new Error(currentMessages().pdf.view.fileNotFound);
          expected = now;
          // 새 판에도 우리가 전에 쓴 주석(/NM = 노드 id)이 남아 있으면 그 ref 를 다시 쓴다 — 빈 장부로 쓰면 전부 새로
          // 만들어 같은 주석이 두 겹이 된다(통합 검증 실측: 7개 → 14개). 이 세션이 모르는 id(외부에서 새로 단 주석)는
          // 장부에서 빼 건드리지 않는다. 판이 맞는지는 savePdf 가 expected 로 다시 확인한다.
          const fresh = await core.importAnnotations(
            new Uint8Array(await ipc.readFileRaw(projectId, path)),
            s.infos,
            s.font,
          );
          const known = new Set([...s.ledger.refs.keys(), ...s.pages.flatMap((d) => d.objects.map((o) => o.id))]);
          ledger = emptyLedger();
          for (const [id, ref] of fresh.ledger.refs) {
            const page = fresh.ledger.pageOf.get(id);
            if (!known.has(id) || page === undefined) continue;
            ledger.refs.set(id, ref);
            ledger.pageOf.set(id, page);
          }
        }
        const r = await core.savePdf(projectId, path, expected, {
          infos: s.infos,
          pages: s.pages,
          ledger,
          textLines: pdfTextLines,
          font: s.font,
        });
        c.markSeen(r.stamp); // 자기 저장으로 재로드되지 않게
        // 저장하는 동안 더 그린 것은 장부의 saved 와 참조가 달라 다음 저장에서 changed 로 잡힌다.
        const cur = sessRef.current ?? s;
        setSess({ ...cur, ledger: r.ledger, stamp: r.stamp });
        return r.stamp;
      });
      result = { ok: true, stamp, at: Date.now() };
      setBanner((b) => (b?.kind === "external" ? null : b));
      pushToast("success", currentMessages().pdf.annotate.saved);
    } catch (e) {
      result = { ok: false, error: errorMessage(e), at: Date.now() };
      const t = currentMessages().pdf.annotate;
      if (!override && isIpcError(e) && e.code === "CONFLICT")
        askConfirm({
          title: t.conflictTitle,
          message: t.conflictMessage,
          confirmLabel: t.conflictConfirm,
          danger: true,
          onConfirm: () => void save(true),
        });
      else pushToast("error", t.saveFailed(errorMessage(e)));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    live.lastSave = result;
    // 덮어 쓴 판은 외부 내용 + 우리 주석이다 — 화면은 옛 판이니 다시 가져와 작업 사본을 새로 만든다.
    if (override && result.ok) {
      const wasAnnotating = modeRef.current === "annotate";
      discardSession();
      if (wasAnnotating) await enterAnnotate();
      else ctl.current?.retry();
    }
    return result;
  };

  const reloadDiscard = () => {
    const wasAnnotating = modeRef.current === "annotate";
    setBanner(null);
    discardSession();
    if (wasAnnotating) void enterAnnotate();
    else ctl.current?.retry();
  };
  const keepEditing = () => {
    if (banner?.kind === "external") ctl.current?.markSeen(banner.stamp);
    setBanner(null);
  };

  annHooks.current = {
    hold: () => sessionDirty(sessRef.current),
    onHeld: (stamp) =>
      setBanner((b) => (b?.kind === "external" && b.stamp === stamp ? b : { kind: "external", stamp })),
    onReloaded: () => {
      // 편집 없는 세션 — 새 판에서 다시 가져온다(보기 모드면 세션을 버려 pdf.js 가 원래대로 그린다).
      if (!sessRef.current) return;
      const wasAnnotating = modeRef.current === "annotate";
      discardSession();
      if (wasAnnotating) void enterAnnotate();
    },
  };

  const fontReady = !!sess?.font;
  const railTools = fontReady ? PDF_TOOLS : PDF_TOOLS.filter((x) => x !== "text");
  const layerTool: Tool = (railTools as readonly string[]).includes(tool) ? tool : "select";

  const annActions: Partial<Record<ShortcutId, (e: KeyboardEvent) => void>> = {
    "tool.select": () => useImageEditorUi.getState().setTool("select"),
    "tool.rect": () => useImageEditorUi.getState().setTool("rect"),
    "tool.ellipse": () => useImageEditorUi.getState().setTool("ellipse"),
    "tool.line": () => useImageEditorUi.getState().setTool("line"),
    "tool.arrow": () => useImageEditorUi.getState().setTool("arrow"),
    "tool.pen": () => useImageEditorUi.getState().setTool("pen"),
    "tool.highlight": () => useImageEditorUi.getState().setTool("highlight"),
    "tool.text": () => {
      if (fontReady) useImageEditorUi.getState().setTool("text");
      else pushToast("info", ta.noFont);
    },
    // 홀드 — auto-repeat 마다 temporary 로 다시 들어가면 prevTool 이 손으로 덮인다. 뗌은 onKeyUp.
    hand: (e) => {
      if (!e.repeat) useImageEditorUi.getState().setTool("hand", { temporary: true });
    },
    undo,
    redo,
    duplicate: duplicateSel,
    delete: removeSel,
    nudge: nudgeSel,
    selectAll: () => {
      useImageEditorUi.getState().select(activeObjects().filter((o) => !o.locked).map((o) => o.id));
    },
  };

  /** 이 뷰어 루트가 PDF 주석 키를 받아도 되나 — 이미지 편집기 모달·확인창이 위에 있으면 그쪽 것이다. */
  const annKeysOn = () => {
    const u = useUi.getState();
    return annotating && !u.imageEditorPath && !u.confirm && !u.prompt;
  };

  if (import.meta.env.DEV)
    annDev.current = {
      state: () => {
        const s = sessRef.current;
        return {
          mode: modeRef.current,
          nodes: s ? s.pages.map((d) => d.objects.length) : [],
          dirty: sessionDirty(s),
          active: activeRef.current,
          tool: useImageEditorUi.getState().tool,
          editBlock,
          banner: banner?.kind ?? null,
          stamp: s?.stamp ?? null,
          historyDepth: { past: s?.past.length ?? 0, future: s?.future.length ?? 0 },
          lastSave: live.lastSave,
        };
      },
      enterAnnotate,
      leaveAnnotate,
      setTool: (t) => useImageEditorUi.getState().setTool(t),
      setNodes: async (pg, nodes) => {
        const objects = normalizeDoc({ objects: nodes }).objects;
        commitPageNodes(pg, objects);
        await frames(2);
        return sessRef.current?.pages[pg]?.objects.length ?? 0;
      },
      getNodes: (pg) => sessRef.current?.pages[pg]?.objects ?? [],
      switchPage,
      save: () => save(),
      undo,
      redo,
      docToClient: (pg, x, y) => {
        const div = ctl.current?.viewer?.getPageView(pg)?.div as HTMLElement | undefined;
        const info = sessRef.current?.infos[pg];
        if (!div || !info) return null;
        const r = div.getBoundingClientRect();
        const ds = (r.width - 2 * div.clientLeft) / info.w;
        return { x: r.left + div.clientLeft + x * ds, y: r.top + div.clientTop + y * ds };
      },
    };

  // 언마운트(탭 이동·분할 닫기) — 저장 안 한 편집을 창 메모리 초안으로 남긴다. 같은 판이면 다음 진입에서 복원.
  useEffect(
    () => () => {
      const s = sessRef.current;
      if (sessionDirty(s)) drafts.set(draftKey, s!);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 초안이 있는 파일을 다시 열면 주석 모드로 곧장 — 보기 모드로 열면 편집이 사라진 것처럼 보인다.
  const autoEnter = useRef(drafts.has(draftKey));
  useEffect(() => {
    if (status !== "ready" || !autoEnter.current) return;
    autoEnter.current = false;
    void enterAnnotate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // 문서 창 X 는 탭 닫기 가드를 지나지 않는다 — 이미지 편집기와 같은 방식(설계 §8.3 함정 C): onCloseRequested 로
  // 묻고 destroy(). close() 를 다시 부르면 CloseRequested 가 또 떠 확인창이 무한히 돈다.
  useEffect(() => {
    if (!IS_DOC_WINDOW) return;
    const win = getCurrentWebviewWindow();
    let off: (() => void) | undefined;
    let gone = false;
    void win
      .onCloseRequested((e) => {
        if (!sessionDirty(sessRef.current)) return;
        e.preventDefault();
        const t = currentMessages().pdf.annotate;
        useUi.getState().askConfirm({
          title: t.closeDirtyTitle,
          message: t.closeDirtyMessage,
          confirmLabel: t.closeDirtyConfirm,
          danger: true,
          onConfirm: () => void win.destroy(),
        });
      })
      .then((f) => {
        if (gone) f();
        else off = f;
      })
      .catch(() => {
        /* 창 API 를 못 쓰는 환경 — 가드 없이 종전처럼 닫힌다(ImageEditor 와 같은 처리) */
      });
    return () => {
      gone = true;
      off?.();
    };
  }, []);

  // 키 순서가 계약이다(명세 C-PdfView 9 + 비평 반영).
  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = isMod(e.nativeEvent);
    const k = e.key.toLowerCase();
    if (mod && !e.altKey && !e.shiftKey && k === "f") {
      e.preventDefault(); // WebView2 브라우저 찾기 액셀러레이터
      openFind();
      return;
    }
    if (e.key === "F3" || (mod && !e.altKey && k === "g")) {
      e.preventDefault();
      openFind();
      stepFind(e.shiftKey);
      return;
    }
    // 저장은 모드와 무관하게(보기 모드로 돌아와서도 편집이 남아 있으면) — 입력 칸 안에서도 받는다.
    if (mod && !e.altKey && !e.shiftKey && k === "s" && dirty) {
      e.preventDefault();
      e.stopPropagation();
      void save();
      return;
    }
    const tag = (e.target as HTMLElement).tagName;
    // Esc 계층(설계 §8.1): 텍스트 확정 → 드래프트 취소 → 선택 도구로 → 선택 해제 → 검색바 닫기.
    // 입력 칸(찾기·속성 숫자)의 Esc 는 그 칸 몫이라 레이어로 보내지 않는다.
    if (e.key === "Escape" && tag !== "INPUT" && annKeysOn() && layerRef.current?.handleEscape()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "Escape" && find.open) {
      closeFind();
      e.stopPropagation(); // Git 모달 등 바깥 Esc 가 같이 닫지 않게
      return;
    }
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (annKeysOn()) {
      // 단축키 표(shortcuts.ts)를 매칭에만 쓴다 — useEditorKeys 의 window capture 는 consume 행을 액션 없이도
      // 삼켜 앱 전역 단축키를 죽인다(설계 §8.2 끝). 이 맵에 없는 행은 아래 보기 키·앱 전역으로 그대로 흐른다.
      const ui = useImageEditorUi.getState();
      const id = matchShortcut(e.nativeEvent, {
        mode: ui.mode,
        sel: selIds().length,
        selKinds: new Set(),
        textEditing: ui.textEditing,
      });
      const act = id ? annActions[id] : undefined;
      if (act) {
        e.preventDefault();
        e.stopPropagation();
        act(e.nativeEvent);
        return;
      }
    }
    if (mod && !e.altKey && !e.shiftKey && k === "a") {
      // 전체 선택을 이 뷰어로 좁힌다 — 기본 select-all 은 앱 전체의 선택 가능한 텍스트를 고른다.
      e.preventDefault();
      if (scrollRef.current) document.getSelection()?.selectAllChildren(scrollRef.current);
      return;
    }
    if (e.key === " " && !mod && !e.altKey) {
      e.stopPropagation(); // VideoPlayer 전역 Space(window 버블)에 가지 않게 — 스크롤은 네이티브
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && k === "c") {
      // PDF 텍스트 선택 복사 — window 버블의 터미널 Ctrl+C 폴백이 터미널 선택으로 가로채지 않게 전파만 끊는다.
      // preventDefault 는 하지 않는다: 네이티브 copy 를 pdf.js textLayer copy 리스너가 정규화한다.
      const s = document.getSelection();
      if (s && !s.isCollapsed && rootRef.current?.contains(s.anchorNode)) e.stopPropagation();
      return;
    }
    if (mod || e.altKey) return; // 그 밖의 조합은 앱 전역 단축키에 양보
    if (e.key === "+" || e.key === "=") zoom(1);
    else if (e.key === "-" || e.key === "_") zoom(-1);
    else if (e.key === "0") ctl.current?.applyScale("auto");
    else return;
    e.preventDefault();
  };

  // Space 홀드(손)를 떼면 원래 도구로 — 일시 전환이 아니었으면 prevTool 이 비어 있어 아무 일도 없다.
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.code === "Space" && annotating) useImageEditorUi.getState().restoreTool();
  };

  return (
    <div
      ref={rootRef}
      data-pdf-view={path}
      data-pdf-status={status}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onPointerDownCapture={() => {
        // 주석 키는 이 루트 onKeyDown 으로만 온다 — 오버레이를 눌렀는데 포커스가 바깥에 남으면 도구 키가 죽는다.
        if (annotating && !rootRef.current?.contains(document.activeElement)) focusRoot();
      }}
      className="flex h-full flex-col bg-base"
    >
      {/* @container — 좁은 분할 칸·최소 크기 문서 창에서 덜 중요한 항목(맞춤 select → 쪽 수·배율 %)부터 숨겨
          오른쪽 [찾기]·[외부 앱]이 잘려 나가지 않게 한다(자연 폭 ≈450px). */}
      <div className="@container flex h-8 min-w-0 shrink-0 items-center gap-1 overflow-hidden border-b border-edge px-3 text-xs text-fg-dim">
        <TBtn
          data-pdf-sidebar-toggle
          aria-pressed={sidebar}
          label={msg.pdf.view.sidebarToggle}
          onClick={() => setSidebar((o) => !o)}
        >
          <PanelLeft size={13} />
        </TBtn>
        <div className="mx-1 h-4 w-px bg-edge" />
        <div role="group" aria-label={ta.modeGroup} className="flex shrink-0 overflow-hidden rounded border border-edge">
          <button
            data-pdf-mode="view"
            aria-pressed={!annotating}
            onClick={leaveAnnotate}
            className={`px-2 leading-5 ${!annotating ? "bg-raised text-fg" : "hover:text-fg"}`}
          >
            {ta.modeView}
          </button>
          {/* 비활성 버튼은 툴팁을 띄우지 않는 환경이 있어 사유는 감싼 span 에 단다. */}
          <span
            title={
              editBlock === "restricted"
                ? ta.blockedRestricted
                : editBlock === "encrypted"
                  ? ta.blockedEncrypted
                  : entering
                    ? ta.entering
                    : ta.modeAnnotateTitle
            }
            className="flex"
          >
            <button
              data-pdf-mode="annotate"
              aria-pressed={annotating}
              disabled={editBlock !== null || status !== "ready" || entering}
              onClick={() => void enterAnnotate()}
              className={`border-l border-edge px-2 leading-5 disabled:opacity-50 ${
                annotating ? "bg-raised text-fg" : "enabled:hover:text-fg"
              }`}
            >
              {ta.modeAnnotate}
            </button>
          </span>
        </div>
        <div className="mx-1 h-4 w-px bg-edge" />
        <TBtn data-pdf-prev label={msg.pdf.view.prevPage} onClick={() => liveViewer()?.previousPage()}>
          <ChevronLeft size={13} />
        </TBtn>
        <input
          data-pdf-page-input
          value={pageDraft ?? String(currentPage)}
          onChange={(e) => setPageDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={commitPage}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitPage();
          }}
          inputMode="numeric"
          aria-label={msg.pdf.view.pageNumber}
          className="w-10 shrink-0 rounded border border-edge bg-base px-1 py-0.5 text-center tabular-nums text-fg outline-none focus:border-accent"
        />
        <span data-pdf-pages className="tabular-nums @max-sm:hidden">
          / {pagesCount}
        </span>
        <TBtn data-pdf-next label={msg.pdf.view.nextPage} onClick={() => liveViewer()?.nextPage()}>
          <ChevronRight size={13} />
        </TBtn>
        <div className="flex-1" />
        <TBtn data-pdf-zoom-out label={msg.pdf.view.zoomOut} onClick={() => zoom(-1)}>
          <Minus size={13} />
        </TBtn>
        <span data-pdf-zoom className="w-12 shrink-0 text-center tabular-nums @max-sm:hidden">
          {Math.round(scale * 100)}%
        </span>
        <TBtn data-pdf-zoom-in label={msg.pdf.view.zoomIn} onClick={() => zoom(1)}>
          <Plus size={13} />
        </TBtn>
        <select
          data-pdf-fit
          value={fit}
          onChange={(e) => ctl.current?.applyScale(e.target.value)}
          title={msg.pdf.view.fitTitle}
          className="rounded border border-edge bg-base px-1 py-0.5 text-fg-muted outline-none focus:border-accent @max-lg:hidden"
        >
          <option value="" disabled>
            {msg.pdf.view.fitCustom}
          </option>
          <option value="auto">{msg.pdf.view.fitAuto}</option>
          <option value="page-width">{msg.pdf.view.fitWidth}</option>
          <option value="page-fit">{msg.pdf.view.fitPage}</option>
          <option value="page-actual">{msg.pdf.view.fitActual}</option>
        </select>
        <div className="mx-1 h-4 w-px bg-edge" />
        {dirty && (
          <span data-pdf-dirty className="flex shrink-0 items-center gap-1 text-fg-muted" title={ta.unsaved}>
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span className="@max-md:hidden">{ta.unsaved}</span>
          </span>
        )}
        {(annotating || dirty) && (
          <button
            data-pdf-save
            disabled={!dirty || saving}
            onClick={() => void save()}
            title={ta.saveTitle(modLabel)}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 enabled:hover:bg-raised enabled:hover:text-fg disabled:opacity-50"
          >
            <Save size={13} />
            <span className="@max-sm:hidden">{saving ? ta.saving : ta.save}</span>
          </button>
        )}
        <TBtn
          data-pdf-find-toggle
          label={msg.pdf.view.find(modLabel)}
          onClick={() => (find.open ? closeFind() : openFind())}
        >
          <Search size={13} />
        </TBtn>
        <TBtn data-pdf-open-external label={msg.pdf.view.openExternal} onClick={openExternal}>
          <ExternalLink size={13} />
        </TBtn>
      </div>

      {(mode === "commit" || mode === "index") && (
        <div
          data-pdf-worktree-note
          className="shrink-0 border-b border-edge bg-panel px-3 py-1 text-xs text-fg-dim"
        >
          {msg.pdf.view.worktreeNote}
        </div>
      )}

      {banner && (
        <div
          data-pdf-banner={banner.kind}
          className="flex shrink-0 items-center gap-2 border-b border-edge bg-panel px-3 py-1 text-xs text-fg-muted"
        >
          <span className="min-w-0 flex-1 truncate">
            {banner.kind === "external" ? ta.externalBanner : ta.draftRestored}
          </span>
          {banner.kind === "external" ? (
            <>
              <button
                data-pdf-banner-reload
                onClick={reloadDiscard}
                className="shrink-0 rounded border border-edge px-2 py-0.5 hover:bg-raised hover:text-fg"
              >
                {ta.reloadDiscard}
              </button>
              <button
                data-pdf-banner-keep
                onClick={keepEditing}
                className="shrink-0 rounded border border-edge px-2 py-0.5 hover:bg-raised hover:text-fg"
              >
                {ta.keepEditing}
              </button>
            </>
          ) : (
            <button
              onClick={() => setBanner(null)}
              className="shrink-0 rounded border border-edge px-2 py-0.5 hover:bg-raised hover:text-fg"
            >
              {ta.dismiss}
            </button>
          )}
        </div>
      )}

      {annotating && sess && (
        <PdfPropsBar
          paint={paint}
          opacity={opacity}
          selected={(() => {
            const ids = new Set(selectedIds);
            return (sess.pages[active]?.objects ?? []).filter((o) => ids.has(o.id));
          })()}
          onChange={changePaint}
        />
      )}

      <div className="relative flex min-h-0 flex-1">
        {sidebar && (
          // 탭 버튼은 aside 의 직계 자식이다(계약 셀렉터 `aside[data-pdf-sidebar] > button`) — 그래서 grid.
          <aside
            data-pdf-sidebar
            className="grid w-52 shrink-0 grid-cols-2 grid-rows-[auto_minmax(0,1fr)] border-r border-edge bg-panel text-xs"
          >
            {(["thumbs", "outline"] as const).map((t) => (
              <button
                key={t}
                data-pdf-sidebar-tab={t}
                aria-pressed={tab === t}
                onClick={() => setTab(t)}
                className={`border-b py-1.5 ${
                  tab === t
                    ? "border-accent text-fg"
                    : "border-edge text-fg-dim hover:text-fg"
                }`}
              >
                {t === "thumbs" ? msg.pdf.view.tabThumbs : msg.pdf.view.tabOutline}
              </button>
            ))}
            <div className="col-span-2 min-h-0">
              {status === "ready" &&
                doc &&
                (tab === "thumbs" ? (
                  <PdfThumbs
                    key={loadCount}
                    doc={doc}
                    currentPage={currentPage}
                    onGoto={(n) => {
                      const v = liveViewer();
                      if (v) v.currentPageNumber = n;
                    }}
                    // pdf.js 의 정리 훅 — PDFViewer 가 자기 버퍼에 없는 페이지만 pdfPage.cleanup() 한다. 안 쏘면
                    // 썸네일로만 그린 페이지의 오퍼레이터 리스트·디코드 이미지가 문서 수명 내내 남는다(쪽수 비례).
                    onRendered={(n, page) =>
                      ctl.current?.bus?.dispatch("thumbnailrendered", { source: null, pageNumber: n, pdfPage: page })
                    }
                  />
                ) : (
                  <PdfOutline
                    key={loadCount}
                    doc={doc}
                    onDest={(d) => void ctl.current?.link?.goToDestination(d)}
                    onUrl={(u) => ctl.current?.openLink(u)}
                  />
                ))}
            </div>
          </aside>
        )}

        {annotating && (
          <ToolRail tools={railTools} paint={paint} onFocusRoot={focusRoot} onPlaceImage={() => {}} />
        )}

        <div className="relative min-w-0 flex-1">
          {/* PDFViewer 는 absolute 컨테이너를 요구한다. 이 두 div 의 className 은 고정 — pdf.js 가 클래스·형제를
              직접 붙이므로 React 가 다시 쓰지 않게 한다. */}
          <div
            ref={scrollRef}
            data-pdf-scroll
            data-pdf-annotating={annotating ? "" : undefined}
            tabIndex={0}
            className="absolute inset-0 overflow-auto bg-base outline-none"
          >
            <div ref={innerRef} className="pdfViewer" />
          </div>

          {sess && ctl.current?.viewer && ctl.current.bus && scrollRef.current && (
            <PdfAnnotateOverlay
              viewer={ctl.current.viewer}
              bus={ctl.current.bus}
              container={scrollRef.current}
              infos={sess.infos}
              pages={sess.pages}
              active={active}
              interactive={annotating}
              tool={layerTool}
              paint={paint}
              opacity={opacity}
              layerRef={layerRef}
              onCommit={commitPageNodes}
              onActivate={switchPage}
            />
          )}

          {find.open && (
            <PdfFindBar
              inputRef={findInputRef}
              query={find.query}
              status={find}
              onQueryChange={changeQuery}
              onStep={stepFind}
              onClose={closeFind}
            />
          )}

          {status !== "ready" && (
            <div className="absolute inset-0 z-20 bg-base">
              {status === "loading" && <EmptyState title={msg.pdf.view.loading} />}
              {/* 암호 폼·오류는 컨트롤이 컨테이너의 직계 자식이다(계약 셀렉터 `form > input`, `[data-pdf-error] > button`)
                  — EmptyState 로 감싸지 않고 grid 로 같은 모양을 낸다. */}
              {status === "password" && (
                <form
                  data-pdf-password
                  onSubmit={(e) => {
                    e.preventDefault(); // 기본 GET 제출 = 창 전체 리로드
                    ctl.current?.submitPassword(pwInputRef.current?.value ?? "");
                  }}
                  className="mx-auto grid h-full w-56 grid-cols-2 content-center gap-2 text-center"
                >
                  <Lock size={32} className="col-span-2 mx-auto mb-1 text-fg-dim" strokeWidth={1.5} />
                  <div className="col-span-2 font-medium text-fg-muted">{msg.pdf.view.passwordProtected}</div>
                  <input
                    ref={pwInputRef}
                    type="password"
                    data-pdf-password-input
                    autoFocus
                    placeholder={msg.pdf.view.passwordPlaceholder}
                    className="col-span-2 rounded border border-edge bg-base px-2 py-1 text-xs text-fg outline-none focus:border-accent"
                  />
                  {pw?.reason === 2 && (
                    <div data-pdf-password-error className="col-span-2 text-xs text-danger">
                      {msg.pdf.view.passwordWrong}
                    </div>
                  )}
                  <button
                    type="submit"
                    className="mt-1 rounded bg-accent px-3 py-1.5 text-xs text-on-accent hover:bg-accent-hover"
                  >
                    {msg.pdf.view.passwordOpen}
                  </button>
                  <button
                    type="button"
                    data-pdf-password-cancel
                    onClick={() => ctl.current?.cancelPassword()}
                    className="mt-1 rounded border border-edge px-3 py-1.5 text-xs text-fg-muted hover:bg-raised hover:text-fg"
                  >
                    {msg.pdf.view.passwordCancel}
                  </button>
                </form>
              )}
              {status === "error" && (
                <div
                  data-pdf-error
                  className="grid h-full grid-cols-[auto_auto] content-center justify-center gap-2 px-6 text-center"
                >
                  <FileWarning size={32} className="col-span-2 mx-auto mb-1 text-fg-dim" strokeWidth={1.5} />
                  {/* 파일 없음은 제목이 곧 사유다. 변경 목록(worktree·index·commit)에서 누른 삭제된 PDF 는 정상 상태라
                      '삭제됨' 으로 말하고, 없는 파일에는 동작할 수 없는 [외부 앱으로 열기]를 두지 않는다. */}
                  <div className="col-span-2 font-medium text-fg-muted">
                    {errorText !== NOT_FOUND
                      ? msg.pdf.view.openFailed
                      : mode && mode !== "file"
                        ? msg.pdf.view.deletedInWorktree
                        : msg.pdf.view.fileNotFound}
                  </div>
                  {errorText && errorText !== NOT_FOUND && (
                    <div className="col-span-2 mx-auto max-w-80 text-xs leading-5 text-fg-dim">
                      {errorText}
                    </div>
                  )}
                  <button
                    data-pdf-retry
                    onClick={() => ctl.current?.retry()}
                    className={`mt-2 rounded border border-edge px-3 py-1.5 text-xs text-fg-muted hover:bg-raised hover:text-fg ${
                      errorText === NOT_FOUND ? "col-span-2 justify-self-center" : "justify-self-end"
                    }`}
                  >
                    {msg.pdf.view.retry}
                  </button>
                  {errorText !== NOT_FOUND && (
                    <button
                      onClick={openExternal}
                      className="mt-2 flex items-center gap-1.5 justify-self-start rounded border border-edge px-3 py-1.5 text-xs text-fg-muted hover:bg-raised hover:text-fg"
                    >
                      <ExternalLink size={13} /> {msg.pdf.view.openExternal}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
