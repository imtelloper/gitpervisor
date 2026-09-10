// 펜 드래프트 — 클릭을 **여러 번** 쌓아 패스 하나를 만드는 제스처(47 §3.1).
//
// **왜 `DragState` 가 아닌 별도 상태인가.** `pointer.ts` 의 제스처는 전부 down→move→up 한 번으로
// 끝난다 — `onPointerUp` 이 `dragRef` 를 무조건 비우고 `{mode:"draw"}` 는 그 자리에서 커밋한다
// (pointer.ts:950-955). 펜은 버튼을 뗀 뒤에도 살아 있어야 하고 다음 클릭이 같은 객체에 정점을
// 하나 더 얹는다. 그 경로에 얹으면 첫 up 에서 정점 1개짜리 객체가 문서에 남고, 반대로 정점마다
// 커밋하면 20정점 펜이 히스토리 20칸(상한 200)을 태워 직전 작업으로 못 돌아간다. 그래서 정점
// 누적은 **문서 밖** `PenDraft` 이고, `DragState` 에는 한 정점의 핸들 드래그만 실린다 — 그건
// 실제로 down→move→up 한 번이라 기존 틀과 모양이 같다.
//
// 이 파일은 순수하다. 드래프트는 문서가 아니므로 히스토리에 아무것도 쌓지 않는다:
//   - 완료(`penFinish`) 결과를 커밋하는 것이 **유일한** 문서 변경이고 그것이 히스토리 1칸이다.
//   - Backspace/Ctrl+Z 는 `penPop` 으로 드래프트 안에서만 되돌린다(문서 undo 로 새면 방금 그리기
//     전의 편집이 사라진다 — 47 §3.6 `handleUndo` 선점).
//   - **Esc 는 취소다.** 드래프트를 그냥 버린다(커밋 0). 설계 §3.1 표는 "정점 ≥ 2 면 열린 채
//     완료"라고 적었지만, 취소 키가 커밋을 하면 사용자는 되돌린 줄 알고 손을 떼고 문서에는
//     객체가 남는다 — 이 저장소가 텍스트 편집에서 같은 실수를 한 적이 있다. 완료는
//     Enter·더블클릭·첫 정점 클릭(닫기) 셋뿐이다. 그 판정은 레이어(핸들 체인)가 한다.
//
// 좌표는 전부 oriented px 다(types.ts 규약). 크롬 프리미티브의 두께·반경만 css px.

import { CHROME_COLORS, type ChromePrim } from "../../../lib/annotate/chrome";
import { snapAngle } from "../../../lib/annotate/geometry";
import { normalizeNode } from "../../../lib/annotate/schema";
import {
  DEFAULT_OPACITY,
  newObjId,
  SHIFT_SNAP_DEG,
  type DefaultPaint,
  type ObjId,
  type PathNode,
  type PathVert,
} from "../../../lib/annotate/types";
import type { VertRef } from "../../../lib/annotate/vector/edit";
import {
  flattenSubPath,
  normalizeAuto,
  vertModeOf,
  type SubPath,
} from "../../../lib/annotate/vector/path";
import type { Point } from "./pointer";

/**
 * 핸들 유무 임계(path.ts `HANDLE_EPS` 와 같은 값). 이보다 짧은 드래그는 클릭이다.
 *
 * 값이 갈리면 여기서 "곡선"으로 본 드래그를 `vertModeOf` 는 코너로 읽어, 만든 직후의 정점이
 * 인스펙터에 다른 모드로 뜬다.
 */
const HANDLE_EPS = 1e-3;

/** 커서 힌트 뱃지를 커서에서 띄우는 거리(css px) — 겹치면 포인터가 글자를 가린다. */
const HINT_GAP_CSS = 18;

/**
 * 진행 중인 펜 드래프트. **문서에 넣지 마라** — 넣으면 Ctrl+Z 가 그리던 중간 상태로 튄다.
 *
 * `dragging` 은 지금 핸들을 끌고 있는 정점(항상 마지막)이다. null 이면 버튼을 뗀 상태 —
 * 다음 down 이 정점을 하나 더 얹는다.
 */
export interface PenDraft {
  /** `append` 는 노드 편집 중 빈 곳 클릭 = 같은 객체에 서브패스 추가(구멍, §3.1). */
  target: { kind: "new" } | { kind: "append"; id: ObjId };
  verts: PathVert[];
  cursor: Point | null;
  dragging: VertRef | null;
}

/**
 * 다운 하나를 드래프트에 반영한다.
 *
 * `close: true` 면 **정점을 얹지 않고** 호출자가 `penFinish(draft, true, …)` 로 닫아 완료한다 —
 * 첫 정점 위를 클릭한 것이라 같은 자리에 정점이 둘 생기면 길이 0 짜리 변이 남는다.
 */
export function penDown(
  d: PenDraft | null,
  pt: Point,
  mods: { shift: boolean; alt: boolean },
  o: { curvature: boolean; tol: number; target?: PenDraft["target"] },
): { draft: PenDraft; close: boolean } {
  const verts = d ? d.verts : [];
  // 첫 정점 위 클릭 = 닫기(§3.1 표, 정점 ≥ 2). 정점을 얹지 않고 `close` 만 세운다 —
  // 같은 자리에 정점이 둘 생기면 길이 0 짜리 변이 남아 불리언·평탄화가 퇴화 입력을 받는다.
  if (d && verts.length >= 2) {
    const f = verts[0];
    if (Math.abs(f.x - pt.x) <= o.tol && Math.abs(f.y - pt.y) <= o.tol) {
      return { draft: { ...d, cursor: null, dragging: null }, close: true };
    }
  }
  const prev = verts.length ? verts[verts.length - 1] : null;
  // Shift 는 **직전 정점 기준** 15° 격자다. 첫 정점에는 기준이 없어 그대로 둔다.
  const q = mods.shift && prev ? snapAngle(prev.x, prev.y, pt.x, pt.y, SHIFT_SNAP_DEG) : pt;
  const next = [...verts, freshVert(q, o.curvature)];
  return {
    draft: {
      target: d?.target ?? o.target ?? { kind: "new" },
      verts: next,
      cursor: q,
      dragging: { sub: 0, vert: next.length - 1 },
    },
    close: false,
  };
}

/**
 * 누른 채 끄는 동안 마지막 정점의 핸들을 잡는다 — `out = 커서 − 앵커`, 기본은 대칭(`in = −out`).
 *
 * Alt 는 **들어오는 핸들을 고정**한다(Figma 의 break) — 모드는 손으로 붙이지 않고 언제나
 * `vertModeOf` 가 정한다. 그래야 "mirrored 라고 적혀 있는데 실제 핸들은 비대칭"인 정점이
 * 생기지 않는다(path.ts:52-58 과 같은 규칙).
 */
export function penDrag(
  d: PenDraft,
  pt: Point,
  mods: { shift: boolean; alt: boolean },
): PenDraft {
  const r = d.dragging;
  const v = r ? d.verts[r.vert] : undefined;
  // 드래그 중이 아니면 바뀐 것이 없다 — **같은 참조**를 돌려줘야 호출자가 다시 그리지 않는다.
  if (!r || !v) return d;
  const q = mods.shift ? snapAngle(v.x, v.y, pt.x, pt.y, SHIFT_SNAP_DEG) : pt;
  const outX = q.x - v.x;
  const outY = q.y - v.y;
  // 길이 0 = 클릭이다. 여기서 모드를 다시 매기면 곡률 토글이 만든 'auto' 가 'corner' 로 덮여
  // 클릭만으로 곡률 설정이 조용히 풀린다.
  if (Math.abs(outX) < HANDLE_EPS && Math.abs(outY) < HANDLE_EPS) return d;
  const inX = mods.alt ? v.inX : -outX;
  const inY = mods.alt ? v.inY : -outY;
  const verts = d.verts.slice();
  verts[r.vert] = { ...v, inX, inY, outX, outY, mode: vertModeOf(inX, inY, outX, outY) };
  return { ...d, verts, cursor: q };
}

/** 버튼을 뗐다. 다음 down 은 새 정점을 얹는다. */
export function penUp(d: PenDraft): PenDraft {
  return d.dragging ? { ...d, dragging: null } : d;
}

/** 커서만 갱신(러버밴드). 드래그 중이 아닐 때의 move. */
export function penHover(d: PenDraft, pt: Point | null): PenDraft {
  return { ...d, cursor: pt };
}

/**
 * Backspace / Ctrl+Z — 마지막 정점 하나만 무른다. 남는 정점이 없으면 `null`(드래프트 폐기).
 *
 * 문서 히스토리는 건드리지 않는다. 이 함수가 소비하지 않으면 Ctrl+Z 가 문서 undo 로 흘러
 * "그리기 전 편집"이 대신 사라진다.
 */
export function penPop(d: PenDraft): PenDraft | null {
  if (d.verts.length <= 1) return null;
  return { ...d, verts: d.verts.slice(0, -1), dragging: null };
}

/**
 * 드래프트를 문서 값으로 굳힌다. `target` 이 `append` 면 **서브패스만** 돌려준다 —
 * 호출자가 대상 객체의 `subpaths` 에 덧붙여 커밋 1회 한다(46 짝수-홀수 구멍이 이 경로다).
 *
 * 페인트는 `DefaultPaint` 에서 **복사**한다(참조를 공유하면 툴바를 만질 때 이미 커밋된 객체까지
 * 따라 바뀐다 — draft.ts `makeDraft` 와 같은 이유). 채우기는 비운다: 열린 패스에 채우기가 붙으면
 * 첫 정점과 끝 정점을 잇는 가짜 면이 칠해져, 지시선을 그렸는데 색면이 나온다.
 */
export function penFinish(
  d: PenDraft,
  closed: boolean,
  paint: DefaultPaint,
  opacity: number = DEFAULT_OPACITY,
): PathNode | { sub: SubPath } {
  const sub: SubPath = { verts: d.verts.map((v) => ({ ...v })), closed };
  if (d.target.kind === "append") return { sub };
  return pathOf(sub, paint, opacity, newObjId());
}

/**
 * 드래프트의 **확정된 부분**을 그리는 문서 밖 노드(§3.1 "라이브 객체로 렌더").
 *
 * 크롬으로 흉내 내지 않는 이유: 완료하는 순간 선 두께·캡·불투명도가 바뀌면 사용자는 자기가
 * 그린 것과 다른 것을 받는다. `penFinish` 와 **같은 생성기**를 지나므로 픽셀이 같다.
 *
 * `id` 는 호출자가 드래프트 하나 동안 고정한다 — 매 프레임 새 id 를 만들면 `ensureCache` 의
 * 제외 집합이 프레임마다 갈려 커밋 캐시가 통째로 무효화된다(포인터를 움직이는 내내 전체 재렌더).
 * 정점이 2개 미만이면 `null`: 점 하나는 그릴 것이 없고, 러버밴드는 `penPreview` 몫이다.
 */
export function penDraftNode(
  d: PenDraft,
  paint: DefaultPaint,
  opacity: number,
  id: ObjId,
): PathNode | null {
  if (d.verts.length < 2) return null;
  return pathOf({ verts: d.verts.map((v) => ({ ...v })), closed: false }, paint, opacity, id);
}

/** 정규화 경계를 지난 `path` 노드. 기본값을 `emptyBase`(draft.ts) 에서 베껴 두면 두 벌이 갈린다. */
function pathOf(sub: SubPath, paint: DefaultPaint, opacity: number, id: ObjId): PathNode {
  return normalizeNode({
    kind: "path",
    id,
    subpaths: [sub],
    fillRule: "nonzero",
    fills: [],
    strokes: paint.strokes.map((f) => ({ ...f })),
    strokeWidth: paint.strokeWidth,
    opacity,
  }) as PathNode;
}

/** 완료해도 되는가 — 정점 2개 미만은 점 하나라 문서에 남길 것이 없다(§3.1 표). */
export function penUsable(d: PenDraft | null): boolean {
  return !!d && d.verts.length >= 2;
}

/**
 * 드래프트 크롬(§3.5) — 러버밴드 겸 `Preview Segment`, 닫기 대상 강조, 커서 힌트.
 *
 * 확정된 부분은 여기서 그리지 않는다. 그쪽은 `penFinish` 결과를 **라이브 객체로 렌더**해
 * (`liveRef`) 커밋 뒤와 같은 픽셀이 되게 한다 — 크롬으로 흉내 내면 완료하는 순간 선 두께·캡이
 * 바뀐다.
 *
 * 대시 곡선은 `ChromePrim.path` 로 낼 수 없다(dash 필드가 없다, 43 소유). 그래서 다음 구간을
 * 평탄화해 대시 `line` 여러 개로 낸다 — 직선 구간이면 선 하나로 떨어져 러버밴드와 같은 그림이다.
 */
export function penPreview(
  d: PenDraft | null,
  cursor: Point | null,
  view: { scale: number; tol: number },
): ChromePrim[] {
  const out: ChromePrim[] = [];
  const at = cursor ?? d?.cursor ?? null;
  if (!d || !d.verts.length) {
    // 도구를 막 집었을 때의 안내. 정점이 쌓이면 자리를 비운다 — 계속 떠 있으면 커서를 따라다니는
    // 뱃지가 정작 그리는 선을 가린다.
    if (at) out.push(hint(at, view.scale));
    return out;
  }
  if (at) {
    const pend = normalizeAuto({
      verts: [...d.verts, freshVert(at, false)],
      closed: false,
    }).verts;
    const seg: SubPath = { verts: pend.slice(-2), closed: false };
    const pts = flattenSubPath(seg);
    for (let i = 2; i < pts.length; i += 2) {
      out.push({
        k: "line",
        x1: pts[i - 2],
        y1: pts[i - 1],
        x2: pts[i],
        y2: pts[i + 1],
        color: CHROME_COLORS.sel,
        dash: true,
      });
    }
    // 첫 정점 위면 "여기서 닫힌다"를 채운 원으로 알린다(§3.1 표) — 클릭하고 나서야 알면 늦다.
    const f = d.verts[0];
    if (
      d.verts.length >= 2 &&
      Math.abs(f.x - at.x) <= view.tol &&
      Math.abs(f.y - at.y) <= view.tol
    ) {
      out.push({
        k: "circle",
        cx: f.x,
        cy: f.y,
        rCss: 6,
        color: CHROME_COLORS.sel,
        fill: CHROME_COLORS.sel,
      });
    }
  }
  if (d.verts.length === 1 && at) out.push(hint(at, view.scale));
  return out;
}

// ── 내부 ────────────────────────────────────────────────────────────────────

/** 핸들 없는 새 정점. 곡률 토글이 켜져 있으면 이웃에서 핸들이 계산되는 `auto` 다(§3.1). */
function freshVert(p: Point, curvature: boolean): PathVert {
  return {
    x: p.x,
    y: p.y,
    inX: 0,
    inY: 0,
    outX: 0,
    outY: 0,
    mode: curvature ? "auto" : "corner",
  };
}

/**
 * 커서 힌트. `text` 프리미티브는 x 가 **가로 중앙**인 알약 뱃지라(ChromeOverlay `badge`)
 * 좌표를 그 기준으로 넘긴다 — 좌측 정렬 수단이 없다.
 */
function hint(at: Point, scale: number): ChromePrim {
  const gap = HINT_GAP_CSS / Math.max(scale, 1e-6);
  return { k: "text", x: at.x + gap * 2, y: at.y + gap, text: "클릭 = 코너 · 드래그 = 곡선" };
}
