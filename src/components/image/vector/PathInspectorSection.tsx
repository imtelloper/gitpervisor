// 패스 속성 섹션(45 속성 탭 슬롯) — 시안 ③ `선 · 채우기 · 불리언 연산 · 평탄화 · 윤곽선화 ·
// 패스 분리 · 모양`.
//
// 색 스택(`fills`/`strokes` 겹·스와치·팔레트)은 **여기 없다.** `PropsTab` 이 모든 노드에 대해
// 이미 그린다 — 여기 한 벌 더 두면 같은 스택이 두 곳에서 편집되고, 한쪽이 겹 인덱스를 다르게
// 세는 순간 사용자가 보는 색과 문서의 색이 갈린다. 이 파일은 **패스에만 있는 선 기하**
// (정렬·대시·캡·조인·마이터·화살촉)와 `fillRule`·불리언·모양을 맡는다.
//
// 문서를 직접 만지지 않는다. 쓰기는 전부 `onLive`/`onCommit`/`onOp` 로 나가고, 그 함수는
// 단축키 표(42)가 부르는 것과 **같은 함수**여야 한다. 여기서 문서를 고치기 시작하면 같은 조작이
// 키와 버튼에서 갈라지고, 히스토리 라벨이 먼저 어긋난다.
//
// **스크럽은 틱마다 `onLive`, 손을 뗄 때 같은 값으로 `onCommit`** 한다. 편집기의 확정 커밋은
// 라이브 구간이 열려 있으면 그 칸을 덮고 봉인하므로(`ImageEditor.commitDoc`) 드래그 한 번이
// 정확히 히스토리 1칸이다. 마지막 커밋을 빼면 라이브 칸이 봉인되지 않아 **다음 편집이 그 칸에
// 붙는다** — Ctrl+Z 한 번이 서로 다른 두 조작을 함께 되돌린다.
//
// 정점 X/Y·핸들 in/out 은 47(노드 편집) 몫이라 자리를 비워 둔다.
//
// 배경: DOCS/task/46-image-vector-path.md §3.8

import { useRef, type ReactNode } from "react";
import {
  SquaresExclude,
  SquaresIntersect,
  SquaresSubtract,
  SquaresUnite,
  type LucideIcon,
} from "lucide-react";

import type { DefaultPaint, PathNode, PathVert, Rect } from "../../../lib/annotate/types";
import type { BoolOp } from "../../../lib/annotate/vector/boolean";
import { isRegularPolygon, polygonSubPath } from "../../../lib/annotate/vector/convert";
import { NumField } from "../inspector/fields/NumField";
import { Select } from "../inspector/fields/Select";
import { Toggle } from "../inspector/fields/Toggle";

/**
 * 이 섹션이 내보내는 패치.
 *
 * **계약(§4)의 `Partial<DefaultPaint> & Partial<Pick<PathNode,'fillRule'|'subpaths'>>` 를
 * 선 기하 키만큼 넓혔다** — 시안 ③ 이 요구하는 정렬·대시·캡·조인·마이터·화살촉이 `DefaultPaint`
 * 에 없어서 원래 타입으로는 표현할 수단이 아예 없다. 넓힌 대가는 호출자 쪽에 있다:
 * 37 `applyPaintPatch` 는 `DefaultPaint` 키만 처리하고 나머지는 **조용히 버린다**(switch 에
 * default 가 없고 `touched` 는 그래도 true 가 된다 — 새 참조가 나오지만 값은 그대로다).
 * 배선 단계는 여기 키들을 노드에 직접 얹고 `styleRefs.stroke` 를 떼야 한다.
 */
export type PathPatch = Partial<DefaultPaint> &
  Partial<
    Pick<
      PathNode,
      "fillRule" | "subpaths" | "strokeAlign" | "dash" | "cap" | "join" | "miterLimit" | "heads"
    >
  >;

export type PathOp = BoolOp | "flatten" | "outline" | "separate";

export interface PathInspectorSectionProps {
  node: PathNode;
  /** 스크럽 틱 — 히스토리를 쌓지 않고 문서만 갈아 끼운다. */
  onLive(patch: PathPatch): void;
  onCommit(patch: PathPatch, label?: string): void;
  onOp(op: PathOp): void;
  /** 게이트는 호출자가 판정한다(`canBoolean`/`canFlatten`/`canOutline` + 서브패스 수). */
  canOp: Record<PathOp, boolean>;
}

const BOOLS: readonly { op: BoolOp; short: string; title: string; Icon: LucideIcon }[] = [
  { op: "union", short: "합", title: "합집합", Icon: SquaresUnite },
  { op: "subtract", short: "차", title: "차집합", Icon: SquaresSubtract },
  { op: "intersect", short: "교", title: "교집합", Icon: SquaresIntersect },
  { op: "exclude", short: "제외", title: "제외", Icon: SquaresExclude },
];

const ALIGNS = [
  { value: "inside", label: "안쪽" },
  { value: "center", label: "가운데" },
  { value: "outside", label: "바깥" },
] as const;

const CAPS = [
  { value: "butt", label: "평평" },
  { value: "round", label: "둥근" },
  { value: "square", label: "사각" },
] as const;

const JOINS = [
  { value: "miter", label: "마이터" },
  { value: "round", label: "둥근" },
  { value: "bevel", label: "베벨" },
] as const;

const HEADS = [
  { value: "none", label: "없음" },
  { value: "arrow", label: "화살표" },
] as const;

export function PathInspectorSection({
  node,
  onLive,
  onCommit,
  onOp,
  canOp,
}: PathInspectorSectionProps) {
  // 마지막 라이브 값. 손을 뗄 때 이 값으로 커밋해 라이브 칸을 봉인한다(머리말 참조).
  const live = useRef<{ patch: PathPatch; label: string } | null>(null);
  const beginLive = (patch: PathPatch, label: string) => {
    live.current = { patch, label };
    onLive(patch);
  };
  const endLive = () => {
    const l = live.current;
    live.current = null;
    if (l) onCommit(l.patch, l.label);
  };

  /** 타이핑·방향키·스크럽이 같은 패치를 만들게 묶는다 — 세 경로가 갈리면 값이 갈린다. */
  const num = (make: (v: number) => PathPatch, label: (v: number) => string) => ({
    onCommit: (v: number) => onCommit(make(v), label(v)),
    onLive: (v: number) => beginLive(make(v), label(v)),
    onLiveEnd: endLive,
  });

  const dashLen = node.dash?.[0] ?? 0;
  // 간격을 안 적은 대시(`[8]`)는 캔버스에서 8/8 로 그려진다 — 그 값을 그대로 보여 준다.
  const dashGap = node.dash?.[1] ?? dashLen;
  const sides = isRegularPolygon(node);
  const open = node.subpaths.some((s) => !s.closed);

  return (
    <div>
      {/* 시안 ③ `열린 패스` — 이 한 줄이 없으면 `패스 분리`·정렬 옵션이 왜 어떤 패스에서만
          뜻이 있는지 화면에 단서가 없다(열린 서브패스는 안쪽/바깥 정렬이 성립하지 않는다). */}
      <div className="mb-1 text-[11px] text-fg-dim">{open ? "열린 패스" : "닫힌 패스"}</div>

      <Section title="선">
        <NumField
          label="두께"
          value={node.strokeWidth}
          unit="px"
          min={0}
          {...num((v) => ({ strokeWidth: v }), (v) => `두께 ${v}`)}
        />
        <Row label="정렬">
          <Select
            label="선 정렬"
            value={node.strokeAlign}
            options={[...ALIGNS]}
            onChange={(v) =>
              onCommit({ strokeAlign: v }, `선 정렬 ${labelOf(ALIGNS, v)}`)
            }
          />
        </Row>
        <div className="grid grid-cols-2 gap-x-2">
          <NumField
            label="대시"
            value={dashLen}
            unit="px"
            min={0}
            {...num(
              // 길이 0 은 실선이다. `[0, g]` 를 그대로 두면 butt 캡에서 **아무것도 안 그려지고**
              // 값만 남아, 선이 사라진 이유가 화면 어디에도 없다.
              (v) => ({ dash: v > 0 ? [v, dashGap] : null }),
              (v) => `대시 ${v}`,
            )}
          />
          <NumField
            label="간격"
            value={dashGap}
            unit="px"
            min={0}
            {...num(
              (v) => ({ dash: dashLen > 0 ? [dashLen, v] : null }),
              (v) => `대시 간격 ${v}`,
            )}
          />
        </div>
        <Row label="캡">
          <Select
            label="선 끝"
            value={node.cap}
            options={[...CAPS]}
            onChange={(v) => onCommit({ cap: v }, `선 끝 ${labelOf(CAPS, v)}`)}
          />
        </Row>
        <Row label="조인">
          <Select
            label="선 꺾임"
            value={node.join}
            options={[...JOINS]}
            onChange={(v) => onCommit({ join: v }, `선 꺾임 ${labelOf(JOINS, v)}`)}
          />
        </Row>
        <NumField
          label="마이터"
          value={node.miterLimit}
          min={1}
          {...num((v) => ({ miterLimit: v }), (v) => `마이터 ${v}`)}
        />
        <Row label="시작">
          <Select
            label="시작 화살촉"
            value={node.heads.start}
            options={[...HEADS]}
            onChange={(v) =>
              onCommit({ heads: { ...node.heads, start: v } }, `시작 ${labelOf(HEADS, v)}`)
            }
          />
        </Row>
        <Row label="끝">
          <Select
            label="끝 화살촉"
            value={node.heads.end}
            options={[...HEADS]}
            onChange={(v) =>
              onCommit({ heads: { ...node.heads, end: v } }, `끝 ${labelOf(HEADS, v)}`)
            }
          />
        </Row>
      </Section>

      <Section title="채우기">
        <div className="flex flex-wrap items-center gap-1">
          <Btn
            // 이미 비어 있으면 잠근다 — 눌러도 문서가 그대로면서 히스토리 칸만 하나 늘어난다.
            disabled={node.fills.length === 0}
            title="채우기 겹을 전부 지운다"
            onClick={() => onCommit({ fills: [] }, "채우기 없음")}
          >
            채우기 없음
          </Btn>
        </div>
        <Toggle
          checked={node.fillRule === "evenodd"}
          label="짝수-홀수"
          onChange={(v) =>
            onCommit({ fillRule: v ? "evenodd" : "nonzero" }, v ? "짝수-홀수" : "논제로")
          }
        />
      </Section>

      <Section title="불리언 연산">
        <div className="flex flex-wrap items-center gap-1">
          {BOOLS.map((b) => (
            <Btn
              key={b.op}
              title={b.title}
              disabled={!canOp[b.op]}
              onClick={() => onOp(b.op)}
            >
              <b.Icon size={13} />
              {b.short}
            </Btn>
          ))}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <Btn disabled={!canOp.flatten} onClick={() => onOp("flatten")}>
            평탄화
          </Btn>
          <Btn disabled={!canOp.outline} onClick={() => onOp("outline")}>
            윤곽선화
          </Btn>
          <Btn disabled={!canOp.separate} onClick={() => onOp("separate")}>
            패스 분리
          </Btn>
        </div>
      </Section>

      {/* 정다각형일 때만 — 임의 패스에 `변 수` 를 보이면 그 값을 넣는 순간 사용자가 그린 모양이
          말없이 정N각형으로 바뀐다. 시안에 없는 필드다(INDEX §10.3 열린 질문). */}
      {sides !== null && (
        <Section title="모양">
          <NumField
            label="변 수"
            value={sides}
            min={3}
            max={12}
            {...num((v) => sidesPatch(node, v), (v) => `변 수 ${v}`)}
          />
        </Section>
      )}
    </div>
  );
}

// ── 조각 ────────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-3 first:mt-0">
      <div className="mb-1 text-[11px] text-fg-dim">{title}</div>
      {children}
    </section>
  );
}

/** `Select` 앞의 라벨 열 — `NumField` 의 라벨 폭(`w-11`)에 맞춰야 줄이 어긋나지 않는다. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-1.5">
      <span className="w-11 shrink-0 text-[11px] text-fg-dim">{label}</span>
      {children}
    </div>
  );
}

function Btn({
  title,
  disabled,
  onClick,
  children,
}: {
  title?: string;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 items-center gap-1 rounded bg-raised px-2 text-[12px] text-fg-muted hover:text-fg disabled:opacity-40"
    >
      {children}
    </button>
  );
}

// ── 순수 조각 ───────────────────────────────────────────────────────────────

function labelOf<V extends string>(
  table: readonly { value: V; label: string }[],
  v: V,
): string {
  return table.find((o) => o.value === v)?.label ?? v;
}

/**
 * `변 수` 변경 — 같은 중심·같은 외접원으로 다시 만든다.
 *
 * `pathBounds` 를 쓰면 안 된다. `polygonSubPath` 는 사각형에 **내접**하는 N각형을 만드는데,
 * N각형의 실제 AABB 는 그 사각형보다 작다(예: 정삼각형은 아래 절반만 채운다). 그 AABB 를 다시
 * 넣으면 변 수를 바꿀 때마다 도형이 조금씩 줄어들어 3→6→3 이 처음 모양으로 돌아오지 않는다.
 * `isRegularPolygon` 이 참이면 정점이 전부 한 원 위에 있으므로(변 길이·중심거리 동일), 그 원에
 * 외접하는 정사각형이 곧 원래 프리셋이 쓴 사각형이다.
 */
function sidesPatch(node: PathNode, n: number): PathPatch {
  return { subpaths: [polygonSubPath(circumSquare(node.subpaths[0].verts), n)] };
}

function circumSquare(verts: readonly PathVert[]): Rect {
  let cx = 0;
  let cy = 0;
  for (const p of verts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= verts.length;
  cy /= verts.length;
  const r = Math.hypot(verts[0].x - cx, verts[0].y - cy);
  return { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r };
}
