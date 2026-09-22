import { useEffect, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import type { Messages } from "../../i18n/messages";
import { useMessages } from "../../i18n/ui-language";
import { formatBytes } from "../../lib/format";
import { ipc } from "../../lib/ipc";
import type { DiskTreemapNode } from "../../lib/ipc";

/**
 * 스퀘어리파이드 트리맵(TreeSize의 "트리맵 차트") — disk-usage-analyzer 설계 §3.5.
 * 백엔드가 rel 하위 2레벨을 잘라 보내면(레벨당 상위 24 + "기타" 합) 여기서 배치만 한다.
 * 폴더 박스 클릭 = 드릴다운(rel 교체), 우클릭 = 탐색기에서 열기. 상위 이동은 브레드크럼.
 */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 크기 내림차순 values를 rect 안에 배치 — 표준 squarified(행 worst aspect ratio 최소화). */
function squarify(values: number[], rect: Rect): Rect[] {
  const out: Rect[] = new Array(values.length);
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) {
    return values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  }
  const scale = (rect.w * rect.h) / total;
  let { x, y, w, h } = rect;
  let i = 0;
  while (i < values.length && w > 0 && h > 0) {
    const side = Math.min(w, h);
    // 짧은 변을 따라 행을 쌓는다 — 항목을 추가했을 때 worst 비율이 나빠지기 직전까지.
    let rowSum = 0;
    let rowMin = Infinity;
    let rowMax = 0;
    let j = i;
    let prevWorst = Infinity;
    while (j < values.length) {
      const a = Math.max(values[j] * scale, 1e-6);
      const s = rowSum + a;
      const mn = Math.min(rowMin, a);
      const mx = Math.max(rowMax, a);
      const worst = Math.max(
        (side * side * mx) / (s * s),
        (s * s) / (side * side * mn),
      );
      if (worst > prevWorst) break;
      prevWorst = worst;
      rowSum = s;
      rowMin = mn;
      rowMax = mx;
      j++;
    }
    const thickness = rowSum / side;
    let off = 0;
    for (let k = i; k < j; k++) {
      const len = (Math.max(values[k] * scale, 1e-6) / rowSum) * side;
      out[k] =
        w >= h
          ? { x, y: y + off, w: thickness, h: len } // 왼쪽 세로 행
          : { x: x + off, y, w: len, h: thickness }; // 위쪽 가로 행
      off += len;
    }
    if (w >= h) {
      x += thickness;
      w -= thickness;
    } else {
      y += thickness;
      h -= thickness;
    }
    i = j;
  }
  // 배치 못 한 잔여(면적 0 수렴)는 크기 0으로.
  for (let k = i; k < values.length; k++) out[k] = { x, y, w: 0, h: 0 };
  return out;
}

type Tile =
  | { kind: "dir"; label: string; bytes: number; node: DiskTreemapNode }
  | { kind: "files" | "other"; label: string; bytes: number };

/** 노드 → 타일 목록(내림차순): 하위 폴더 + "[N 파일]"(직속) + "기타"(절단 잔여). */
function tilesOf(n: DiskTreemapNode, msg: Messages): Tile[] {
  const t: Tile[] = n.children.map((c) => ({
    kind: "dir",
    label: c.name,
    bytes: c.bytes,
    node: c,
  }));
  if (n.ownBytes > 0) {
    t.push({
      kind: "files",
      label: msg.sysmon.diskTreemap.ownFilesTile(n.ownFiles),
      bytes: n.ownBytes,
    });
  }
  if (n.otherBytes > 0)
    t.push({ kind: "other", label: msg.sysmon.diskTreemap.otherTile, bytes: n.otherBytes });
  return t.sort((a, b) => b.bytes - a.bytes);
}

/** 레벨1 폴더별 색 구분용 hue 팔레트 — 이웃끼리 대비가 크도록 섞어 둔 순서. */
const HUES = [210, 25, 130, 275, 45, 340, 180, 95, 315, 60, 240, 0];

const PAD = 2;
const HEADER = 15;
const MIN_PX = 3; // 이보다 작은 타일은 그리지 않는다(보이지도 않는 DOM 방지)

function tileTitle(t: Tile, total: number): string {
  const pct = total > 0 ? ((t.bytes / total) * 100).toFixed(1) : "0";
  return `${t.label} — ${formatBytes(t.bytes)} (${pct}%)`;
}

function leafStyle(t: Tile, hue: number | null): React.CSSProperties {
  if (t.kind === "files" || hue == null) {
    return { background: "hsla(220, 8%, 55%, 0.22)", border: "1px solid hsla(220, 8%, 60%, 0.35)" };
  }
  if (t.kind === "other") {
    return { background: `hsla(${hue}, 25%, 50%, 0.12)`, border: `1px solid hsla(${hue}, 25%, 55%, 0.25)` };
  }
  return { background: `hsla(${hue}, 55%, 52%, 0.28)`, border: `1px solid hsla(${hue}, 55%, 58%, 0.5)` };
}

export function DiskTreemap({
  scanRoot,
  rel,
  onDrill,
  onReveal,
}: {
  scanRoot: string;
  rel: string;
  /** 폴더 박스 클릭 → 그 폴더를 트리맵 루트로 */
  onDrill: (rel: string) => void;
  onReveal: (rel: string) => void;
}) {
  const msg = useMessages();
  const { data, isLoading, error } = useQuery({
    queryKey: ["disk-map", scanRoot, rel],
    queryFn: () => ipc.diskTreemap(rel, 2),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  });

  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setSize({ w: el.clientWidth, h: el.clientHeight }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const boxes: React.ReactNode[] = [];
  if (data && size.w > 20 && size.h > 20) {
    const tiles = tilesOf(data, msg);
    const rects = squarify(
      tiles.map((t) => t.bytes),
      { x: 0, y: 0, w: size.w, h: size.h },
    );
    tiles.forEach((t, i) => {
      const r = rects[i];
      if (r.w < MIN_PX || r.h < MIN_PX) return;
      const hue = t.kind === "dir" ? HUES[i % HUES.length] : null;
      const title = tileTitle(t, data.bytes);

      // 레벨1 폴더 박스 — 헤더가 들어갈 만하면 내부에 레벨2 타일을 깐다.
      if (t.kind === "dir" && r.w >= 56 && r.h >= HEADER + 22) {
        const inner: Rect = {
          x: PAD,
          y: HEADER,
          w: r.w - PAD * 2,
          h: r.h - HEADER - PAD,
        };
        const sub = tilesOf(t.node, msg);
        const subRects = squarify(
          sub.map((s) => s.bytes),
          inner,
        );
        boxes.push(
          <div
            key={`b:${t.label}`}
            title={title}
            onClick={() => onDrill(t.node.rel)}
            onContextMenu={(e) => {
              e.preventDefault();
              onReveal(t.node.rel);
            }}
            className="absolute cursor-pointer overflow-hidden rounded-[2px] hover:brightness-125"
            style={{
              left: r.x,
              top: r.y,
              width: r.w,
              height: r.h,
              background: `hsla(${hue}, 45%, 45%, 0.14)`,
              border: `1px solid hsla(${hue}, 50%, 58%, 0.55)`,
            }}
          >
            <div
              className="flex items-baseline gap-1 truncate px-1 text-[10px] leading-[15px]"
              style={{ color: `hsla(${hue}, 70%, 75%, 0.95)` }}
            >
              <span className="truncate font-medium">{t.label}</span>
              <span className="shrink-0 font-mono text-[9px] opacity-70">
                {formatBytes(t.bytes)}
              </span>
            </div>
            {sub.map((s, k) => {
              const sr = subRects[k];
              if (sr.w < MIN_PX || sr.h < MIN_PX) return null;
              const showLabel = sr.w >= 44 && sr.h >= 13;
              return (
                <div
                  key={`${s.kind}:${s.label}`}
                  title={tileTitle(s, data.bytes)}
                  onClick={
                    s.kind === "dir"
                      ? (e) => {
                          e.stopPropagation();
                          onDrill(s.node.rel);
                        }
                      : (e) => e.stopPropagation()
                  }
                  onContextMenu={
                    s.kind === "dir"
                      ? (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onReveal(s.node.rel);
                        }
                      : undefined
                  }
                  className={`absolute overflow-hidden rounded-[1px] ${
                    s.kind === "dir" ? "cursor-pointer hover:brightness-125" : ""
                  }`}
                  style={{
                    left: sr.x,
                    top: sr.y,
                    width: sr.w,
                    height: sr.h,
                    ...leafStyle(s, hue),
                  }}
                >
                  {showLabel ? (
                    <span className="block truncate px-0.5 text-[9px] leading-[12px] text-fg-muted">
                      {s.label}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>,
        );
        return;
      }

      // 작은 폴더·파일·기타 — 단일 타일.
      boxes.push(
        <div
          key={`t:${t.kind}:${t.label}`}
          title={title}
          onClick={t.kind === "dir" ? () => onDrill(t.node.rel) : undefined}
          onContextMenu={
            t.kind === "dir"
              ? (e) => {
                  e.preventDefault();
                  onReveal(t.node.rel);
                }
              : undefined
          }
          className={`absolute overflow-hidden rounded-[2px] ${
            t.kind === "dir" ? "cursor-pointer hover:brightness-125" : ""
          }`}
          style={{ left: r.x, top: r.y, width: r.w, height: r.h, ...leafStyle(t, hue) }}
        >
          {r.w >= 44 && r.h >= 13 ? (
            <span className="block truncate px-0.5 text-[9px] leading-[12px] text-fg-muted">
              {t.label}
            </span>
          ) : null}
        </div>,
      );
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 브레드크럼 — rel 세그먼트 클릭으로 상위 복귀 */}
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-edge/60 bg-panel px-2 py-1 text-[10px] text-fg-dim">
        <button
          type="button"
          onClick={() => onDrill("")}
          className={`shrink-0 rounded px-1 py-0.5 hover:bg-raised ${
            rel === "" ? "text-fg" : "hover:text-fg"
          }`}
        >
          {scanRoot}
        </button>
        {rel
          .split(/[/\\]/)
          .filter(Boolean)
          .map((seg, i, all) => (
            <span key={all.slice(0, i + 1).join("/")} className="flex shrink-0 items-center gap-0.5">
              <span className="text-fg-dim/60">›</span>
              <button
                type="button"
                onClick={() => onDrill(all.slice(0, i + 1).join("/"))}
                className={`rounded px-1 py-0.5 hover:bg-raised ${
                  i === all.length - 1 ? "text-fg" : "hover:text-fg"
                }`}
              >
                {seg}
              </button>
            </span>
          ))}
        <span className="ml-auto shrink-0 pl-2 font-mono tabular-nums">
          {data ? formatBytes(data.bytes) : ""}
        </span>
      </div>
      <div ref={ref} className="relative min-h-0 flex-1 overflow-hidden">
        {isLoading ? (
          <div className="px-3 py-4 text-[11px] text-fg-dim">{msg.sysmon.common.reading}</div>
        ) : error ? (
          <div className="px-3 py-4 text-[11px] text-danger/80">
            {msg.sysmon.diskTreemap.loadFailed}
          </div>
        ) : (
          boxes
        )}
      </div>
    </div>
  );
}
