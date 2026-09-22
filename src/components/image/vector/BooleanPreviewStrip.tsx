// 불리언 미리보기 스트립 — 시안 ③ 캔버스 하단 `불리언 미리보기 · 원본 · 합집합 · 차집합 · 교집합 · 제외`.
//
// **다섯 칸이 같은 변환을 쓴다.** 칸마다 자기 결과에 맞춰 확대하면 교집합 조각이 원본과 같은
// 크기로 그려져, 사용자는 "무엇이 얼마나 남는지"를 정확히 못 읽는다 — 이 스트립의 존재 이유가
// 그 비교 하나다. 그래서 배율·원점은 **입력 객체들의 합집합 AABB** 로 한 번만 잡는다.
//
// 그리는 것은 `renderScene` 이다(39 진입 하나). 손으로 `fill(path)` 하면 페인트 스택·블렌드·
// 효과가 빠져 미리보기와 적용 결과의 색이 달라지고, 그 차이는 눌러 봐야 알 수 있다.
//
// `nodes` 배열 참조가 메모 키다(노드는 불변이라 참조 비교로 충분하다). **호출자가 그 배열을
// 메모해야 한다** — 매 렌더 새 배열이면 선택 하나 움직일 때마다 불리언 4연산이 다시 돈다
// (§6: 200정점 곡선 ∪ rect 가 300ms 예산이다). `ImageEditor` 의 `selNodes` 가 이미 메모다.
//
// 호버 라이브 프리뷰는 없다(§3.8 탈락) — 마우스가 지나가는 것만으로 매 프레임 불리언이 돈다.
//
// 배경: DOCS/task/46-image-vector-path.md §3.8

import { useEffect, useMemo, useRef } from "react";

import type { Messages } from "../../../i18n/messages";
import { useMessages } from "../../../i18n/ui-language";
import { objectAABB } from "../../../lib/annotate/geometry";
import { renderScene } from "../../../lib/annotate/render";
import { sceneOfNodes } from "../../../lib/annotate/scene";
import type { GeomNode, Rect, SceneTransform } from "../../../lib/annotate/types";
import { booleanOp, type BoolOp } from "../../../lib/annotate/vector/boolean";
import { canBoolean } from "../../../lib/annotate/vector/convert";

/** 시안 ③ 썸네일 한 칸(CSS px). */
const CELL_W = 76;
const CELL_H = 60;
/** 선 두께가 셀 가장자리에서 잘리지 않게 두는 여백. */
const CELL_PAD = 6;

const OPS: readonly { op: BoolOp }[] = [
  { op: "union" },
  { op: "subtract" },
  { op: "intersect" },
  { op: "exclude" },
];

function boolOpLabel(msg: Messages, op: BoolOp): string {
  switch (op) {
    case "union":
      return msg.imageInspector.boolean.union;
    case "subtract":
      return msg.imageInspector.boolean.subtract;
    case "intersect":
      return msg.imageInspector.boolean.intersect;
    case "exclude":
      return msg.imageInspector.boolean.exclude;
  }
}

export function BooleanPreviewStrip({
  nodes,
  onApply,
}: {
  /** z 순서(앞이 아래) 선택 노드. `canBoolean` 이 거짓이면 스트립 자체가 없다. */
  nodes: readonly GeomNode[];
  onApply(op: BoolOp): void;
}) {
  const msg = useMessages();
  const ready = canBoolean(nodes);

  const cells = useMemo(() => {
    if (!ready) return null;
    return {
      nodes,
      box: unionAABB(nodes),
      // null = 그 연산의 결과가 비었다(겹치지 않는 두 도형의 교집합). 빈 칸을 눌러도 문서가
      // 바뀌지 않으므로 버튼을 잠근다 — 눌리는데 아무 일도 안 나면 앱이 고장 난 것으로 읽힌다.
      results: OPS.map((o) => booleanOp(nodes, o.op)),
    };
  }, [nodes, ready]);

  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);

  useEffect(() => {
    if (!cells) return;
    const dpr = window.devicePixelRatio || 1;
    const t = fitTransform(cells.box, dpr);
    draw(canvases.current[0], cells.nodes, t, dpr);
    cells.results.forEach((r, i) => draw(canvases.current[i + 1], r ? [r] : [], t, dpr));
  }, [cells]);

  if (!cells) return null;

  return (
    <div
      data-boolean-preview=""
      className="flex items-end gap-1.5 rounded border border-edge bg-panel px-2 py-1.5"
    >
      <span className="mb-4 shrink-0 text-[11px] text-fg-dim">
        {msg.imageInspector.boolean.previewTitle}
      </span>

      {[msg.imageInspector.boolean.original, ...OPS.map((o) => boolOpLabel(msg, o.op))].map((label, i) => {
        const op = i === 0 ? null : OPS[i - 1].op;
        const enabled = op !== null && cells.results[i - 1] !== null;
        const cell = (
          <>
            <canvas
              // 미리보기 그림은 옆 캡션이 이미 이름을 갖고 있다 — 접근성 트리에 두 번 넣지 않는다.
              aria-hidden
              ref={(el) => {
                canvases.current[i] = el;
              }}
              style={{ width: CELL_W, height: CELL_H }}
              className="rounded border border-edge bg-raised"
            />
            <span className="mt-0.5 block text-center text-[10px]">{label}</span>
          </>
        );
        return op === null ? (
          // 키는 번역되지 않는 값으로 — 라벨로 두면 언어 전환 때 캔버스가 새로 마운트되는데
          // 그리기 이펙트는 `cells` 만 보므로 칸이 빈 채로 남는다.
          <div key="original" className="shrink-0 text-fg-dim">
            {cell}
          </div>
        ) : (
          <button
            key={op}
            type="button"
            title={label}
            disabled={!enabled}
            onClick={() => onApply(op)}
            className="shrink-0 text-fg-muted hover:text-fg disabled:opacity-40"
          >
            {cell}
          </button>
        );
      })}
    </div>
  );
}

// ── 순수 조각 ───────────────────────────────────────────────────────────────

function unionAABB(nodes: readonly GeomNode[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of nodes) {
    const b = objectAABB(n);
    if (b.x < x0) x0 = b.x;
    if (b.y < y0) y0 = b.y;
    if (b.x + b.w > x1) x1 = b.x + b.w;
    if (b.y + b.h > y1) y1 = b.y + b.h;
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * AABB 를 셀 안에 맞추는 `(p + t) * s`. **바닥을 1px 로 잡는다** — 수직선처럼 폭이 0 인 상자에
 * 그냥 나누면 배율이 무한대가 되어 다섯 칸이 통째로 비고, 화면에는 원인이 될 만한 것이
 * 아무것도 남지 않는다.
 */
function fitTransform(box: Rect, dpr: number): SceneTransform {
  const w = CELL_W * dpr;
  const h = CELL_H * dpr;
  const pad = CELL_PAD * dpr;
  const bw = Math.max(box.w, 1);
  const bh = Math.max(box.h, 1);
  const s = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
  return {
    tx: (w - bw * s) / (2 * s) - box.x,
    ty: (h - bh * s) / (2 * s) - box.y,
    sx: s,
    sy: s,
  };
}

function draw(
  canvas: HTMLCanvasElement | null,
  list: readonly GeomNode[],
  t: SceneTransform,
  dpr: number,
): void {
  if (!canvas) return;
  const w = Math.round(CELL_W * dpr);
  const h = Math.round(CELL_H * dpr);
  // 크기 대입은 값이 같아도 백킹을 재할당하고 픽셀을 지운다 — 달라졌을 때만 건드린다.
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // 결과가 빈 연산은 빈 칸이다. `renderScene` 에 노드 0개를 넘겨도 같지만, 그러면 레이어 풀이
  // 이 크기로 한 번 더 재조정된다(render.ts `poolFor` 는 바이트 상한이 바뀌면 풀을 새로 만든다).
  if (list.length === 0) return;
  renderScene(ctx, sceneOfNodes(list), t);
}
