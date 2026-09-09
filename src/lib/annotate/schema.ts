// 문서 모델 v2 의 **경계** — 바깥에서 들어온 모든 값(setDoc 리터럴·사이드카 JSON·붙여넣기)은
// 여기를 지나 완전한 `Node`/`EditorDoc` 이 된다.
//
// 그래서 내부 코드(geometry·render·tree·UI)는 `?? 기본값` 방어를 하지 않는다 — 방어 비용을
// 경계 한 곳으로 몰아넣는 것이 이 파일의 존재 이유다(DOCS/task/37-image-doc-model-v2.md §3.3).
//
// v1 문서(`{stroke, strokeWidth, fill, radius:number, head}`)도 같은 입구로 들어온다.
// `upgradeV1Object` 가 렌더 현행 해석 그대로 페인트 스택으로 옮긴다(§3.3 매핑표).

import {
  BLEND_MODES,
  DEFAULT_FONT_FAMILY,
  DEFAULT_MOSAIC_MODE,
  DEFAULT_MOSAIC_STRENGTH,
  DEFAULT_OPACITY,
  DEFAULT_STROKE,
  DEFAULT_STROKE_WIDTH,
  DEFAULT_TEXT_STYLE,
  HIGHLIGHT_OPACITY,
  solidFill,
  type AssetId,
  type BlendMode,
  type DefaultPaint,
  type EditorDoc,
  type Effect,
  type Fill,
  type InstanceOverride,
  type MosaicMode,
  type Node,
  type NodeBase,
  type ObjId,
  type Paint,
  type PathVert,
  type Rect,
  type TextStyle,
} from "./types";

/** 사이드카·클립보드 문서 버전. 이보다 높은 문서는 **읽지도 덮어쓰지도 않는다**. */
export const DOC_VERSION = 2;

// ── v1 모델(업그레이드 입력 전용) ────────────────────────────────────────────

interface CommonV1 {
  id: ObjId;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  rot: number;
}
export type AnnoObjectV1 = CommonV1 &
  (
    | { kind: "pen" | "highlight"; pts: number[] }
    | { kind: "line" | "arrow"; x1: number; y1: number; x2: number; y2: number; head: "end" | "both" }
    | { kind: "rect"; x: number; y: number; w: number; h: number; fill: string | null; radius: number }
    | { kind: "ellipse"; x: number; y: number; w: number; h: number; fill: string | null }
    | { kind: "text"; x: number; y: number; text: string; fontSize: number; fontFamily: string }
    | { kind: "badge"; x: number; y: number; n: number; fontSize: number; fill: string }
    | { kind: "mosaic"; x: number; y: number; w: number; h: number; mode: MosaicMode; strength: number }
  );

const KINDS = [
  "pen",
  "highlight",
  "line",
  "arrow",
  "rect",
  "ellipse",
  "text",
  "badge",
  "mosaic",
  "path",
  "frame",
  "group",
  "instance",
] as const;
type KnownKind = (typeof KINDS)[number];

// ── 원시 값 정규화 ───────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
function clamp01(v: unknown, d: number): number {
  return Math.max(0, Math.min(1, num(v, d)));
}
function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}
function str(v: unknown, d: string): string {
  return typeof v === "string" ? v : d;
}
function pick<T extends string>(v: unknown, allowed: readonly T[], d: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : d;
}
function color(v: unknown, d: string): string {
  return typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : d;
}
function numArray(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number" && Number.isFinite(n)) : [];
}

const ALIGNS = ["inside", "center", "outside"] as const;
const CAPS = ["butt", "round", "square"] as const;
const JOINS = ["miter", "round", "bevel"] as const;
const HEADS = ["none", "arrow"] as const;
const H_CONSTRAINTS = ["left", "right", "center", "scale", "stretch"] as const;
const V_CONSTRAINTS = ["top", "bottom", "center", "scale", "stretch"] as const;
const MASK_MODES = ["shape", "alpha"] as const;
const PAINT_TYPES = ["solid", "linear", "radial", "angular", "diamond", "image"] as const;
const EFFECT_TYPES = ["drop-shadow", "inner-shadow", "layer-blur", "background-blur"] as const;
const FORMATS = ["png", "jpg", "webp", "avif"] as const;
const PROFILES = ["srgb", "display-p3"] as const;
const VERT_MODES = ["corner", "mirrored", "asymmetric", "auto"] as const;
const FILL_RULES = ["nonzero", "evenodd"] as const;
const TEXT_ALIGNS = ["left", "center", "right", "justify"] as const;
const TEXT_VALIGNS = ["top", "middle", "bottom"] as const;
const TEXT_RESIZE = ["auto-width", "auto-height", "fixed"] as const;
const TEXT_SCRIPTS = ["none", "super", "sub"] as const;
const TEXT_CASES = ["none", "upper", "lower"] as const;
const TEXT_LISTS = ["none", "bullet", "number", "check"] as const;
const MOSAIC_MODES = ["pixelate", "blur"] as const;

function blend(v: unknown, d: BlendMode): BlendMode {
  return pick(v, BLEND_MODES as readonly BlendMode[], d);
}

function normPaint(v: unknown): Paint | null {
  if (!isRec(v)) return null;
  const type = pick(v.type, PAINT_TYPES, "solid");
  if (type === "solid") return { type, color: color(v.color, DEFAULT_STROKE), opacity: clamp01(v.opacity, 1) };
  if (type === "image") {
    const assetId = str(v.assetId, "");
    if (!assetId) return null;
    return { type, assetId, mode: pick(v.mode, ["fill", "fit", "stretch"] as const, "fill") };
  }
  const rawStops = Array.isArray(v.stops) ? v.stops : [];
  const stops = rawStops.filter(isRec).map((s) => ({
    pos: Math.max(0, Math.min(1, num(s.pos, 0))),
    color: color(s.color, DEFAULT_STROKE),
    opacity: clamp01(s.opacity, 1),
  }));
  return {
    type,
    stops: stops.length ? stops : [
      { pos: 0, color: DEFAULT_STROKE, opacity: 1 },
      { pos: 1, color: "#FFFFFF", opacity: 1 },
    ],
    angle: num(v.angle, 0),
    scale: num(v.scale, 1),
  };
}

function normFill(v: unknown): Fill | null {
  const paint = normPaint(v);
  if (!paint) return null;
  const rec = isRec(v) ? v : {};
  return { ...paint, visible: bool(rec.visible, true), blend: blend(rec.blend, "normal") };
}

function normFills(v: unknown): Fill[] {
  return Array.isArray(v) ? v.map(normFill).filter((f): f is Fill => f !== null) : [];
}

function normEffect(v: unknown): Effect | null {
  if (!isRec(v)) return null;
  const type = pick(v.type, EFFECT_TYPES, "drop-shadow");
  if (type === "layer-blur" || type === "background-blur") {
    return { type, radius: Math.max(0, num(v.radius, 0)), visible: bool(v.visible, true) };
  }
  return {
    type,
    x: num(v.x, 0),
    y: num(v.y, 0),
    blur: Math.max(0, num(v.blur, 0)),
    spread: num(v.spread, 0),
    color: color(v.color, "#000000"),
    opacity: clamp01(v.opacity, 0.25),
    visible: bool(v.visible, true),
  };
}

function normRadius(v: unknown): [number, number, number, number] {
  if (typeof v === "number" && Number.isFinite(v)) {
    const r = Math.max(0, v);
    return [r, r, r, r];
  }
  if (Array.isArray(v)) {
    const [a, b, c, d] = v;
    return [Math.max(0, num(a, 0)), Math.max(0, num(b, 0)), Math.max(0, num(c, 0)), Math.max(0, num(d, 0))];
  }
  return [0, 0, 0, 0];
}

function normVert(v: unknown): PathVert {
  const r = isRec(v) ? v : {};
  return {
    x: num(r.x, 0),
    y: num(r.y, 0),
    inX: num(r.inX, 0),
    inY: num(r.inY, 0),
    outX: num(r.outX, 0),
    outY: num(r.outY, 0),
    mode: pick(r.mode, VERT_MODES, "corner"),
  };
}

function normTextStyle(r: Rec): TextStyle {
  const d = DEFAULT_TEXT_STYLE;
  const f = isRec(r.features) ? r.features : {};
  return {
    fontFamily: str(r.fontFamily, DEFAULT_FONT_FAMILY),
    fontWeight: num(r.fontWeight, d.fontWeight),
    italic: bool(r.italic, d.italic),
    fontSize: Math.max(1, num(r.fontSize, d.fontSize)),
    lineHeight: num(r.lineHeight, d.lineHeight),
    letterSpacing: num(r.letterSpacing, d.letterSpacing),
    paragraphSpacing: num(r.paragraphSpacing, d.paragraphSpacing),
    indent: num(r.indent, d.indent),
    align: pick(r.align, TEXT_ALIGNS, d.align),
    valign: pick(r.valign, TEXT_VALIGNS, d.valign),
    resize: pick(r.resize, TEXT_RESIZE, d.resize),
    underline: bool(r.underline, d.underline),
    strike: bool(r.strike, d.strike),
    script: pick(r.script, TEXT_SCRIPTS, d.script),
    textCase: pick(r.textCase, TEXT_CASES, d.textCase),
    list: pick(r.list, TEXT_LISTS, d.list),
    listLevel: Math.max(0, num(r.listLevel, d.listLevel)),
    truncateLines: typeof r.truncateLines === "number" ? Math.max(1, r.truncateLines) : null,
    features: {
      liga: bool(f.liga, d.features.liga),
      onum: bool(f.onum, d.features.onum),
      tnum: bool(f.tnum, d.features.tnum),
      frac: bool(f.frac, d.features.frac),
    },
  };
}

// ── v1 → v2 페인트 매핑 (§3.3) ───────────────────────────────────────────────

/**
 * v1 객체의 색 필드를 페인트 스택으로 옮긴다. 매핑은 **현행 렌더 해석**에서 도출했다:
 * - pen/highlight/line/arrow: `stroke` = 획 색 (render.ts drawObject :98)
 * - rect/ellipse: `fill` = 내부, `stroke` = 테두리 (:119-128)
 * - text: `stroke` = **글자색** (drawText :265 fillStyle)
 * - badge: `fill` = 원 채움, `stroke` = 원 테두리(strokeWidth>0일 때만) (drawBadge :275-285)
 * - mosaic: 색을 쓰지 않는다
 * `strokeWidth === 0` 이면 선이 없으므로 `strokes` 는 빈 배열이다(v1 렌더와 동치).
 */
function v1Paints(kind: KnownKind, r: Rec): { fills: Fill[]; strokes: Fill[] } {
  const strokeColor = color(r.stroke, DEFAULT_STROKE);
  const width = num(r.strokeWidth, DEFAULT_STROKE_WIDTH);
  const outline = width > 0 ? [solidFill(strokeColor)] : [];
  const fillColor = typeof r.fill === "string" ? color(r.fill, strokeColor) : null;
  switch (kind) {
    case "text":
      return { fills: [solidFill(strokeColor)], strokes: [] };
    case "badge":
      return { fills: [solidFill(fillColor ?? strokeColor)], strokes: outline };
    case "rect":
    case "ellipse":
      return { fills: fillColor ? [solidFill(fillColor)] : [], strokes: outline };
    case "mosaic":
      return { fills: [], strokes: [] };
    default:
      return { fills: [], strokes: outline };
  }
}

// ── 노드 정규화 ──────────────────────────────────────────────────────────────

function normBase(r: Rec, kind: KnownKind): NodeBase {
  const isV1 = !Array.isArray(r.fills) && !Array.isArray(r.strokes) && typeof r.stroke === "string";
  const legacy = v1Paints(kind, r);
  const container = kind === "group" || kind === "frame" || kind === "instance";
  // 형광펜은 v1 에서도 multiply 로 그렸다(render.ts :107) — 값으로 옮긴다.
  const defaultBlend: BlendMode = kind === "highlight" ? "multiply" : container ? "pass-through" : "normal";
  const rawBlend = blend(r.blend, defaultBlend);
  return {
    id: str(r.id, ""),
    parentId: typeof r.parentId === "string" ? r.parentId : null,
    name: typeof r.name === "string" ? r.name : null,
    visible: bool(r.visible, true),
    locked: bool(r.locked, false),
    opacity: clamp01(r.opacity, kind === "highlight" ? HIGHLIGHT_OPACITY : DEFAULT_OPACITY),
    // pass-through 는 컨테이너 전용이다 — 리프에 오면 normal 로 되돌린다(§3.2).
    blend: !container && rawBlend === "pass-through" ? "normal" : rawBlend,
    rot: num(r.rot, 0),
    fills: isV1 ? legacy.fills : normFills(r.fills),
    strokes: isV1 ? legacy.strokes : normFills(r.strokes),
    strokeWidth: Math.max(0, num(r.strokeWidth, container ? 0 : DEFAULT_STROKE_WIDTH)),
    strokeAlign: pick(r.strokeAlign, ALIGNS, "center"),
    dash: Array.isArray(r.dash) && r.dash.length ? numArray(r.dash) : null,
    // 형광펜은 butt cap 이라야 획 끝이 뭉치지 않는다(v1 렌더가 kind 로 강제하던 규칙 —
    // 이제 문서 값이라 렌더가 종류를 몰라도 같은 그림이 나온다).
    cap: pick(r.cap, CAPS, kind === "highlight" ? "butt" : "round"),
    join: pick(r.join, JOINS, "round"),
    miterLimit: num(r.miterLimit, 4),
    heads: normHeads(r),
    effects: Array.isArray(r.effects)
      ? r.effects.map(normEffect).filter((e): e is Effect => e !== null)
      : [],
    constraints: {
      h: pick(isRec(r.constraints) ? r.constraints.h : undefined, H_CONSTRAINTS, "left"),
      v: pick(isRec(r.constraints) ? r.constraints.v : undefined, V_CONSTRAINTS, "top"),
    },
    mask: isRec(r.mask)
      ? { mode: pick(r.mask.mode, MASK_MODES, "shape"), invert: bool(r.mask.invert, false) }
      : null,
    exportRows: Array.isArray(r.exportRows)
      ? r.exportRows.filter(isRec).map((e) => ({
          scale: isRec(e.scale) ? { width: Math.max(1, num(e.scale.width, 1200)) } : Math.max(0.01, num(e.scale, 1)),
          suffix: str(e.suffix, ""),
          format: pick(e.format, FORMATS, "png"),
          quality: clamp01(e.quality, 0.92),
          profile: pick(e.profile, PROFILES, "srgb"),
        }))
      : [],
    styleRefs: isRec(r.styleRefs)
      ? {
          ...(typeof r.styleRefs.fill === "string" ? { fill: r.styleRefs.fill } : {}),
          ...(typeof r.styleRefs.stroke === "string" ? { stroke: r.styleRefs.stroke } : {}),
          ...(typeof r.styleRefs.text === "string" ? { text: r.styleRefs.text } : {}),
          ...(typeof r.styleRefs.effect === "string" ? { effect: r.styleRefs.effect } : {}),
        }
      : {},
  };
}

/** v1 `arrow.head:'end'|'both'` → `heads`. v2 문서는 `heads` 를 그대로 쓴다. */
function normHeads(r: Rec): { start: "none" | "arrow"; end: "none" | "arrow" } {
  if (isRec(r.heads)) {
    return { start: pick(r.heads.start, HEADS, "none"), end: pick(r.heads.end, HEADS, "none") };
  }
  if (r.kind === "arrow") {
    return { start: r.head === "both" ? "arrow" : "none", end: "arrow" };
  }
  return { start: "none", end: "none" };
}

/**
 * 알 수 없는 kind 는 `null` — 호출자(normalizeDoc)가 서브트리째 `foreign` 으로 보낸다.
 * id 가 없으면 호출자가 채운다(붙여넣기·리터럴 경로).
 */
export function normalizeNode(input: unknown): Node | null {
  if (!isRec(input)) return null;
  const kind = input.kind;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) return null;
  const k = kind as KnownKind;
  const r = input;
  const base = normBase(r, k);
  switch (k) {
    case "pen":
    case "highlight":
      return { ...base, kind: k, pts: numArray(r.pts) };
    case "line":
    case "arrow":
      return {
        ...base,
        kind: k,
        x1: num(r.x1, 0),
        y1: num(r.y1, 0),
        x2: num(r.x2, 0),
        y2: num(r.y2, 0),
        head: pick(r.head, ["end", "both"] as const, "end"),
      };
    case "rect":
      return {
        ...base,
        kind: k,
        x: num(r.x, 0),
        y: num(r.y, 0),
        w: num(r.w, 0),
        h: num(r.h, 0),
        radius: normRadius(r.radius),
      };
    case "ellipse":
      return { ...base, kind: k, x: num(r.x, 0), y: num(r.y, 0), w: num(r.w, 0), h: num(r.h, 0) };
    case "text":
      return {
        ...base,
        ...normTextStyle(r),
        kind: k,
        x: num(r.x, 0),
        y: num(r.y, 0),
        w: Math.max(0, num(r.w, 0)),
        h: Math.max(0, num(r.h, 0)),
        text: str(r.text, ""),
      };
    case "badge":
      return {
        ...base,
        kind: k,
        x: num(r.x, 0),
        y: num(r.y, 0),
        n: Math.round(num(r.n, 1)),
        fontSize: Math.max(1, num(r.fontSize, DEFAULT_TEXT_STYLE.fontSize)),
      };
    case "mosaic":
      return {
        ...base,
        kind: k,
        x: num(r.x, 0),
        y: num(r.y, 0),
        w: num(r.w, 0),
        h: num(r.h, 0),
        mode: pick(r.mode, MOSAIC_MODES, DEFAULT_MOSAIC_MODE) as MosaicMode,
        strength: Math.max(1, num(r.strength, DEFAULT_MOSAIC_STRENGTH)),
      };
    case "path": {
      const raw = Array.isArray(r.subpaths) ? r.subpaths : [];
      const subpaths = raw.filter(isRec).map((s) => ({
        verts: (Array.isArray(s.verts) ? s.verts : []).map(normVert),
        closed: bool(s.closed, false),
      }));
      return { ...base, kind: k, subpaths, fillRule: pick(r.fillRule, FILL_RULES, "nonzero") };
    }
    case "frame":
      return {
        ...base,
        kind: k,
        x: num(r.x, 0),
        y: num(r.y, 0),
        w: num(r.w, 0),
        h: num(r.h, 0),
        radius: normRadius(r.radius),
        clipsContent: bool(r.clipsContent, true),
      };
    case "group":
      return {
        ...base,
        kind: k,
        ...(typeof r.detachedFrom === "string" ? { detachedFrom: r.detachedFrom } : {}),
      };
    case "instance":
      return {
        ...base,
        kind: k,
        componentId: str(r.componentId, ""),
        overrides: isRec(r.overrides) ? (r.overrides as Record<ObjId, InstanceOverride>) : {},
      };
  }
}

/** v1 객체 하나를 v2 노드로. (내부적으로 normalizeNode 와 같은 경로다.) */
export function upgradeV1Object(o: AnnoObjectV1): Node {
  const n = normalizeNode(o);
  if (!n) throw new Error(`upgradeV1Object: 알 수 없는 kind ${(o as { kind?: string }).kind}`);
  return n;
}

// ── 문서 정규화 ──────────────────────────────────────────────────────────────

function normRect(v: unknown): Rect | null {
  if (!isRec(v)) return null;
  return { x: num(v.x, 0), y: num(v.y, 0), w: num(v.w, 0), h: num(v.h, 0) };
}

/**
 * 어떤 입력이든 완전한 `EditorDoc` 으로 만든다. v1 `EditorDoc`·`Partial<EditorDoc>`·`{}` 허용.
 *
 * 알 수 없는 kind 의 노드는 **서브트리째** `foreignOut` 으로 옮긴다 — parentId 사슬이 끊기지
 * 않아야 태스크 38 의 트리 불변식이 성립한다(§6 위험표).
 */
export function normalizeDoc(input: unknown, foreignOut?: unknown[]): EditorDoc {
  const r = isRec(input) ? input : {};
  const rawObjects = Array.isArray(r.objects) ? r.objects : [];

  // 1차: kind 판정으로 미지 노드 id 를 모은다(자손은 parentId 사슬로 따라간다).
  const badIds = new Set<string>();
  const idOf = (v: unknown): string => (isRec(v) && typeof v.id === "string" ? v.id : "");
  for (const raw of rawObjects) {
    const kind = isRec(raw) ? raw.kind : undefined;
    if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) badIds.add(idOf(raw));
  }
  if (badIds.size) {
    // DFS 전순 배열이므로 앞에서 뒤로 한 번만 훑으면 자손이 전부 잡힌다.
    for (const raw of rawObjects) {
      if (!isRec(raw)) continue;
      const parent = typeof raw.parentId === "string" ? raw.parentId : null;
      if (parent && badIds.has(parent)) badIds.add(idOf(raw));
    }
  }

  const objects: Node[] = [];
  const seen = new Set<string>();
  for (const raw of rawObjects) {
    const id = idOf(raw);
    if (badIds.has(id)) {
      foreignOut?.push(raw);
      continue;
    }
    const node = normalizeNode(raw);
    if (!node) {
      foreignOut?.push(raw);
      continue;
    }
    // id 중복·누락은 여기서 고친다(붙여넣기 경로).
    if (!node.id || seen.has(node.id)) node.id = crypto.randomUUID();
    seen.add(node.id);
    objects.push(node);
  }
  // 사라진 부모를 가리키는 노드는 최상위로 올린다(불변식 유지).
  for (const n of objects) {
    if (n.parentId && !seen.has(n.parentId)) n.parentId = null;
  }

  const assets: EditorDoc["assets"] = {};
  if (isRec(r.assets)) {
    for (const [k, v] of Object.entries(r.assets)) {
      if (!isRec(v) || typeof v.data !== "string") continue;
      assets[k as AssetId] = {
        mime: str(v.mime, "image/png"),
        w: Math.max(0, num(v.w, 0)),
        h: Math.max(0, num(v.h, 0)),
        data: v.data,
      };
    }
  }

  const imageMask = isRec(r.imageMask) && typeof r.imageMask.id === "string"
    ? {
        id: r.imageMask.id,
        mode: pick(r.imageMask.mode, MASK_MODES, "shape"),
        invert: bool(r.imageMask.invert, false),
      }
    : null;

  return {
    v: 2,
    objects,
    assets,
    guides: Array.isArray(r.guides)
      ? r.guides
          .filter(isRec)
          .map((g) => ({ axis: pick(g.axis, ["x", "y"] as const, "x"), pos: num(g.pos, 0) }))
      : [],
    imageMask,
    straighten: num(r.straighten, 0),
    rotation: ((Math.round(num(r.rotation, 0) / 90) * 90) % 360 + 360) % 360,
    flipH: bool(r.flipH, false),
    flipV: bool(r.flipV, false),
    crop: normRect(r.crop),
    outW: Math.max(0, Math.round(num(r.outW, 0))),
    outH: Math.max(0, Math.round(num(r.outH, 0))),
    brightness: num(r.brightness, 100),
    contrast: num(r.contrast, 100),
    saturate: num(r.saturate, 100),
  };
}

// ── 사이드카 직렬화 (태스크 41 이 소비) ──────────────────────────────────────

export interface ImageDocEnvelope {
  v: 2;
  projectId: string;
  relPath: string;
  /** 원본 이미지의 `read_file_base64` stamp — 불일치 시 배너(태스크 41). */
  imageStamp: string | null;
  imageW: number;
  imageH: number;
  savedAt: number;
  doc: EditorDoc;
  /** 이 앱이 모르는 노드 원문 — 저장 시 그대로 되돌려준다. */
  foreign: unknown[];
  /** 히스토리 라벨 로그(되돌리기는 스냅샷만 — INDEX §10.5). */
  log: { at: number; label: string }[];
}

export function serializeImageDoc(env: ImageDocEnvelope): string {
  return JSON.stringify({ ...env, v: DOC_VERSION });
}

/**
 * 사이드카 JSON 파싱. **상위 버전은 읽지도 덮어쓰지도 않는다** — 새 앱이 쓴 문서를
 * 옛 앱이 조용히 깎아 저장하는 사고를 막는다(§3.3).
 */
export function parseImageDoc(json: string): { env: ImageDocEnvelope; warnings: string[] } {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw Object.assign(new Error("사이드카 JSON 을 읽을 수 없습니다"), { code: "PARSE_ERROR" });
  }
  const r = isRec(raw) ? raw : {};
  const v = num(r.v, 1);
  if (v > DOC_VERSION) {
    throw Object.assign(new Error(`문서 버전 ${v} 은 이 앱보다 높습니다`), { code: "UNSUPPORTED_VERSION" });
  }
  const foreign: unknown[] = Array.isArray(r.foreign) ? [...r.foreign] : [];
  const before = foreign.length;
  const doc = normalizeDoc(r.doc, foreign);
  if (foreign.length > before) warnings.push(`알 수 없는 노드 ${foreign.length - before}개를 보존했습니다`);
  return {
    env: {
      v: 2,
      projectId: str(r.projectId, ""),
      relPath: str(r.relPath, ""),
      imageStamp: typeof r.imageStamp === "string" ? r.imageStamp : null,
      imageW: Math.max(0, num(r.imageW, 0)),
      imageH: Math.max(0, num(r.imageH, 0)),
      savedAt: num(r.savedAt, 0),
      doc,
      foreign,
      log: Array.isArray(r.log)
        ? r.log.filter(isRec).map((e) => ({ at: num(e.at, 0), label: str(e.label, "편집") }))
        : [],
    },
    warnings,
  };
}

// ── 페인트 패치 (v1 restyle / ToolStyle 대체) ────────────────────────────────

const PAINT_SLOTS: Record<keyof DefaultPaint, keyof NodeBase["styleRefs"] | null> = {
  fills: "fill",
  strokes: "stroke",
  strokeWidth: "stroke",
  radius: null,
  fontSize: "text",
  mosaicMode: null,
  mosaicStrength: null,
  typo: "text",
};

/**
 * 패치로 오는 페인트 값. `typo` 만 `DefaultPaint` 보다 **넓다** — 툴바가 드는 것은 완전한
 * `TextStyle` 이지만 인스펙터가 보내는 것은 만진 필드 하나뿐이다. 여기서 좁히면 행간을
 * 한 번 바꾸려고 타이포 필드 전부를 실어 보내야 하고, 그 사이 다른 필드가 옛 값으로 덮인다.
 */
export type PaintPatch = Omit<Partial<DefaultPaint>, "typo"> & {
  typo?: Partial<TextStyle>;
};

/**
 * 선택 노드에 툴바/인스펙터 값을 적용한다. kind 가 받지 않는 필드는 조용히 무시한다
 * (v1 `restyle` 의 kind 별 if 7개를 대체).
 *
 * 직접 편집하면 그 슬롯의 스타일 참조를 뗀다 — 라이브러리 값과 어긋난 채 링크가 남으면
 * 다음 라이브러리 변경이 사용자의 편집을 덮는다(태스크 51 §4).
 */
export function applyPaintPatch(node: Node, patch: PaintPatch): Node {
  const next = { ...node } as Node & Record<string, unknown>;
  let touched = false;
  const styleRefs = { ...node.styleRefs };

  for (const key of Object.keys(patch) as (keyof DefaultPaint)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    switch (key) {
      case "fills":
        if (!nodeTakesFill(node)) continue;
        next.fills = value as Fill[];
        break;
      case "strokes":
        if (!nodeTakesStroke(node)) continue;
        next.strokes = value as Fill[];
        break;
      case "strokeWidth":
        if (!nodeTakesStroke(node)) continue;
        next.strokeWidth = Math.max(0, value as number);
        break;
      case "radius":
        if (node.kind !== "rect" && node.kind !== "frame") continue;
        next.radius = value as [number, number, number, number];
        break;
      case "fontSize":
        if (node.kind !== "text" && node.kind !== "badge") continue;
        next.fontSize = Math.max(1, value as number);
        break;
      case "mosaicMode":
        if (node.kind !== "mosaic") continue;
        next.mode = value as MosaicMode;
        break;
      case "mosaicStrength":
        if (node.kind !== "mosaic") continue;
        next.strength = Math.max(1, value as number);
        break;
      case "typo": {
        // 타이포 필드는 `TextNode` 에 **평평하게** 얹혀 있다(37: TextNode = NodeBase & TextStyle).
        if (node.kind !== "text") continue;
        const typo = value as Partial<TextStyle>;
        Object.assign(next, typo);
        // 크기만 다시 조인다. 0 이나 음수가 들어오면 `layoutText` 의 가용 폭이 0 이 돼
        // 줄 채우기가 글자 하나마다 줄을 바꾸고, 상자가 세로로 무한히 자란다.
        if (typo.fontSize !== undefined) next.fontSize = Math.max(1, typo.fontSize);
        break;
      }
    }
    touched = true;
    const slot = PAINT_SLOTS[key];
    if (slot) delete styleRefs[slot];
  }
  if (!touched) return node;
  next.styleRefs = styleRefs;
  return next as Node;
}

/** 텍스트는 글자색을 fills 로 쓴다(v1 `stroke` 자리) — 모자이크만 페인트를 안 받는다. */
function nodeTakesFill(node: Node): boolean {
  return node.kind !== "mosaic";
}
function nodeTakesStroke(node: Node): boolean {
  return node.kind !== "mosaic";
}

/**
 * 노드의 타이포 한 벌. 텍스트가 아니면 기본값이다 — 사각형을 고른 채로 텍스트 도구를 들면
 * 그 값이 다음 글자에 쓰이므로, 옆 노드에서 주워 온 값이 아니라 기본값이어야 한다.
 * 키 목록의 정본은 `DEFAULT_TEXT_STYLE` 하나다(37 이 필드를 늘리면 여기가 자동으로 따라간다).
 */
function typoOf(node: Node): TextStyle {
  if (node.kind !== "text") return DEFAULT_TEXT_STYLE;
  const src = node as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULT_TEXT_STYLE)) out[k] = src[k];
  return out as unknown as TextStyle;
}

/** 선택 노드 → 툴바 표시값. */
export function paintOf(node: Node): DefaultPaint {
  return {
    fills: node.fills,
    strokes: node.strokes,
    strokeWidth: node.strokeWidth,
    radius: node.kind === "rect" || node.kind === "frame" ? node.radius : [0, 0, 0, 0],
    fontSize: node.kind === "text" || node.kind === "badge" ? node.fontSize : DEFAULT_TEXT_STYLE.fontSize,
    mosaicMode: node.kind === "mosaic" ? node.mode : DEFAULT_MOSAIC_MODE,
    mosaicStrength: node.kind === "mosaic" ? node.strength : DEFAULT_MOSAIC_STRENGTH,
    typo: typoOf(node),
  };
}

/** 문서에 쓰인 단색을 등장 순서대로, 중복 없이(시안 ④ 색 피커 '문서 색상'). */
export function documentColors(doc: EditorDoc): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (c: string) => {
    const key = c.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const n of doc.objects) {
    for (const f of [...n.fills, ...n.strokes]) {
      if (f.type === "solid") push(f.color);
      else if (f.type !== "image") for (const s of f.stops) push(s.color);
    }
  }
  return out;
}
