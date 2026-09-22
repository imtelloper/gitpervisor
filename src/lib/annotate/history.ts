// 편집 히스토리 v2 — 라벨이 붙은 EditorDoc 스냅샷 스택.
//
// **문서 전체**를 스냅샷한다. 회전이 주석 기하를 변형하므로 주석만 되돌리면 좌표 공간이
// 어긋난다. 객체는 불변 갱신이라(변경분만 새 참조) 한 칸의 실제 비용은 `objects` 배열
// 참조 복사(N×8B)뿐이다 — 5,000노드 40KB × 200칸 = 8MB 천장이라 구조 공유 라이브러리가 필요 없다.
//
// 항목마다 **라벨**이 붙는다(시안 ⑤ `번호 뱃지 #3 이동 · 1분 전`). 커밋 사이트가 아는 것은
// 직접 주고, 모르면 `describeChange` 가 두 문서를 견줘 만든다.
//
// 배경: DOCS/task/41-image-doc-persist-history.md §3.4

import { currentMessages } from "../../i18n/ui-language";
import type { Messages } from "../../i18n/messages";
import type { EditorDoc, Node } from "./types";

/** 스냅샷 상한. 초과하면 가장 오래된 것부터 버린다. */
export const HISTORY_LIMIT = 200;

export interface HistoryEntry {
  doc: EditorDoc;
  label: string;
  at: number;
  /**
   * 이전 세션의 기록 — 라벨과 시각만 있고 문서가 없다(되돌릴 수 없다).
   * 세션 간 전체 스택을 영속하려면 자동저장마다 200벌을 써야 한다(INDEX §10.5).
   */
  readonly: boolean;
}

/** 이전 세션 로그 한 줄 — 사이드카 `env.log` 가 이 모양이다. */
export interface HistoryLogEntry {
  at: number;
  label: string;
}

/**
 * undo/redo 스택. 커밋 시점(pointerup, 텍스트 확정, 삭제, z-order, 복제, 회전/반전,
 * 크롭 확정, 슬라이더 onPointerUp)에만 `commit()` 을 부른다 — 드래그 중 매 틱이 아니다.
 */
export class DocHistory {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private cur: HistoryEntry;
  /** 이전 세션 기록(가장 오래된 것부터). 되돌리기 대상이 아니라 표시용이다. */
  private prior: HistoryEntry[] = [];

  constructor(initial: EditorDoc, label = currentMessages().annotate.history.openImage) {
    this.cur = { doc: initial, label, at: Date.now(), readonly: false };
  }

  /** 현재 문서. */
  get present(): EditorDoc {
    return this.cur.doc;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** 디버깅·테스트용 스택 깊이. */
  get depth(): { past: number; future: number } {
    return { past: this.past.length, future: this.future.length };
  }

  /**
   * 패널이 그리는 전체 목록 — 이전 세션 기록 → 과거 → 현재 → 미래(redo 가능) 순서.
   * `cursor` 가 가리키는 항목이 현재다.
   */
  get entries(): readonly HistoryEntry[] {
    return [...this.prior, ...this.past, this.cur, ...this.future].reverse();
  }

  /** `entries` 안에서 현재 항목의 위치(0 = 목록 맨 위 = 가장 최근). */
  get cursor(): number {
    return this.future.length;
  }

  /** 이전 세션 기록을 뺀 되돌리기 가능한 항목만(패널의 '내 작업' 필터가 쓴다). */
  get liveEntries(): readonly HistoryEntry[] {
    return [...this.past, this.cur, ...this.future].reverse();
  }

  /**
   * 새 커밋. 직전 문서를 undo 스택에 쌓고 redo 스택을 버린다(분기 히스토리는 만들지 않는다).
   * 라벨을 주지 않으면 두 문서의 차이에서 만든다.
   */
  commit(next: EditorDoc, label?: string): void {
    if (next === this.cur.doc) return;
    const desc = label ?? describeChange(this.cur.doc, next);
    this.past.push(this.cur);
    if (this.past.length > HISTORY_LIMIT) {
      this.past.splice(0, this.past.length - HISTORY_LIMIT);
    }
    this.future = [];
    this.cur = { doc: next, label: desc, at: Date.now(), readonly: false };
  }

  /**
   * 스냅샷 없이 현재 문서만 교체한다(드래그 중 라이브 갱신처럼 커밋이 아닌 변경).
   * undo/redo 스택은 건드리지 않는다.
   */
  replace(next: EditorDoc): void {
    this.cur = { ...this.cur, doc: next };
  }

  /** 한 단계 되돌린다. 되돌릴 것이 없으면 null. */
  undo(): EditorDoc | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(this.cur);
    this.cur = prev;
    return prev.doc;
  }

  /** 되돌린 것을 다시 적용한다. 없으면 null. */
  redo(): EditorDoc | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(this.cur);
    this.cur = next;
    return next.doc;
  }

  /**
   * 목록에서 항목 하나를 골라 그 시점으로 간다(시안 ⑤ 항목 클릭).
   * `i` 는 `entries` 인덱스다 — 이전 세션 항목(readonly)은 고를 수 없다.
   */
  jumpTo(i: number): EditorDoc | null {
    const list = this.entries;
    const target = list[i];
    if (!target || target.readonly) return null;
    if (target === this.cur) return this.cur.doc;
    // entries 는 최신이 앞이므로, 되돌리기 방향은 future 길이와의 차이로 정해진다.
    const steps = i - this.cursor;
    if (steps > 0) {
      for (let n = 0; n < steps; n++) if (!this.undo()) break;
    } else {
      for (let n = 0; n < -steps; n++) if (!this.redo()) break;
    }
    return this.cur.doc;
  }

  /**
   * 새 이미지를 열 때처럼 히스토리를 통째로 초기화한다.
   * `priorLog` 를 주면 이전 세션 기록으로 목록 아래쪽에 남는다(되돌리기 불가).
   */
  reset(
    doc: EditorDoc,
    label = currentMessages().annotate.history.openImage,
    priorLog?: readonly HistoryLogEntry[],
  ): void {
    this.past = [];
    this.future = [];
    this.prior = (priorLog ?? []).map((e) => ({
      doc,
      label: e.label,
      at: e.at,
      readonly: true,
    }));
    this.cur = { doc, label, at: Date.now(), readonly: false };
  }

  /** 사이드카에 남길 라벨 로그(문서는 빼고 시각·라벨만). */
  log(cap = HISTORY_LIMIT): HistoryLogEntry[] {
    return [...this.prior, ...this.past, this.cur]
      .slice(-cap)
      .map((e) => ({ at: e.at, label: e.label }));
  }
}

// ── 라벨 만들기 ─────────────────────────────────────────────────────────────

type HistoryText = Messages["annotate"]["history"];

function kindLabels(t: HistoryText): Record<string, string> {
  return {
    pen: t.kindPen,
    highlight: t.kindHighlight,
    line: t.kindLine,
    arrow: t.kindArrow,
    rect: t.kindRect,
    ellipse: t.kindEllipse,
    text: t.kindText,
    badge: t.kindBadge,
    mosaic: t.kindMosaic,
    path: t.kindPath,
    frame: t.kindFrame,
    group: t.kindGroup,
    instance: t.kindInstance,
  };
}

function nameOf(n: Node, t: HistoryText): string {
  return n.name ?? kindLabels(t)[n.kind] ?? n.kind;
}

/**
 * 커밋 사이트가 라벨을 모를 때 두 문서를 견줘 만든다.
 *
 * 완벽한 분류가 목적이 아니다 — 히스토리 패널에서 "뭘 한 칸인지" 알아볼 수 있으면 된다.
 * ponytail: 휴리스틱 천장. 더 정확한 라벨이 필요하면 그 커밋 사이트가 직접 주면 된다.
 */
export function describeChange(prev: EditorDoc, next: EditorDoc): string {
  const t = currentMessages().annotate.history;
  if (prev.objects !== next.objects) {
    const before = prev.objects.length;
    const after = next.objects.length;
    if (after > before) {
      const added = next.objects.filter((o) => !prev.objects.some((p) => p.id === o.id));
      if (added.length === 1) return t.created(nameOf(added[0], t));
      if (added.length > 1) return t.addedMany(added.length);
    }
    if (after < before) {
      const removed = prev.objects.filter((o) => !next.objects.some((p) => p.id === o.id));
      if (removed.length === 1) return t.deleted(nameOf(removed[0], t));
      if (removed.length > 1) return t.deletedMany(removed.length);
    }
    // 개수가 같으면 순서·값 변경이다.
    const moved = movedDelta(prev, next, t);
    if (moved) return moved;
    return t.propsChanged;
  }
  if (prev.crop !== next.crop) return next.crop ? t.crop : t.cropCleared;
  if (prev.rotation !== next.rotation) return t.rotate;
  if (prev.flipH !== next.flipH || prev.flipV !== next.flipV) return t.flip;
  if (prev.outW !== next.outW || prev.outH !== next.outH) return t.resize;
  if (
    prev.brightness !== next.brightness ||
    prev.contrast !== next.contrast ||
    prev.saturate !== next.saturate
  ) {
    return t.colorAdjust;
  }
  if (prev.straighten !== next.straighten) return t.straighten;
  if (prev.guides !== next.guides) return t.guides;
  return t.edit;
}

/** 같은 id 가 옮겨졌으면 "번호 뱃지 이동 Δ12,−4" 처럼. 아니면 null. */
function movedDelta(prev: EditorDoc, next: EditorDoc, t: HistoryText): string | null {
  const byId = new Map(prev.objects.map((o) => [o.id, o]));
  let one: { node: Node; dx: number; dy: number } | null = null;
  let count = 0;
  for (const n of next.objects) {
    const p = byId.get(n.id);
    if (!p || p === n) continue;
    count++;
    const a = anchorOf(p);
    const b = anchorOf(n);
    if (!a || !b) continue;
    const dx = Math.round(b.x - a.x);
    const dy = Math.round(b.y - a.y);
    if (dx === 0 && dy === 0) continue;
    if (!one) one = { node: n, dx, dy };
  }
  if (!one || count > 1) return null;
  const sign = (v: number) => (v < 0 ? `−${Math.abs(v)}` : `${v}`);
  return t.moved(nameOf(one.node, t), sign(one.dx), sign(one.dy));
}

/** 라벨용 대표 좌표 — 정확한 기하가 아니라 "움직였는가"만 본다(geometry 를 끌어오지 않는다). */
function anchorOf(n: Node): { x: number; y: number } | null {
  const any = n as unknown as { x?: number; y?: number; x1?: number; y1?: number; pts?: number[] };
  if (typeof any.x === "number" && typeof any.y === "number") return { x: any.x, y: any.y };
  if (typeof any.x1 === "number" && typeof any.y1 === "number") return { x: any.x1, y: any.y1 };
  if (Array.isArray(any.pts) && any.pts.length >= 2) return { x: any.pts[0], y: any.pts[1] };
  return null;
}
