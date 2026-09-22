import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  FolderSearch,
  HardDrive,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { open } from "@tauri-apps/plugin-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { Messages } from "../../i18n/messages";
import { useMessages } from "../../i18n/ui-language";
import { formatBytes } from "../../lib/format";
import { errorMessage, ipc } from "../../lib/ipc";
import type { DiskRoot, DiskScanStatus } from "../../lib/ipc";
import { useDiskChildren } from "../../queries";
import { useUi } from "../../stores/ui";
import { DiskTreemap } from "./DiskTreemap";

/** 부하 임계 색 — SysMonitor와 동일 규약. 디스크 점유율 바에 재사용한다. */
function pctBar(pct: number): string {
  return pct >= 88 ? "bg-danger" : pct >= 70 ? "bg-warn" : "bg-accent";
}

function fmtDate(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

/** 크기 셀 툴팁 — 할당 크기가 논리 크기와 다르면(압축·스파스) 함께 보여준다(§2.2). */
function sizeTip(bytes: number, alloc: number, msg: Messages): string | undefined {
  if (alloc === bytes) return undefined;
  return msg.sysmon.diskUsage.sizeTip(formatBytes(bytes), formatBytes(alloc), alloc < bytes);
}

/** 스캔 루트 + rel + name → 절대경로 ("탐색기에서 열기"용). 루트의 구분자를 따른다. */
function absPath(root: string, rel: string, name?: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const base = root.endsWith(sep) ? root.slice(0, -1) : root;
  const parts = [base, ...rel.split(/[/\\]/).filter(Boolean)];
  if (name) parts.push(name);
  return parts.join(sep);
}

/** 크기 대비 바 — 부모 폴더 안에서 이 항목이 차지하는 비율(TreeSize의 % 열). */
function ShareBar({ bytes, parentBytes }: { bytes: number; parentBytes: number }) {
  const pct = parentBytes > 0 ? Math.min(100, (bytes / parentBytes) * 100) : 0;
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-[5px] w-14 shrink-0 overflow-hidden rounded-full bg-edge">
        <div
          className={`h-full rounded-full ${pctBar(pct)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-[38px] text-right font-mono text-[10px] text-fg-dim tabular-nums">
        {pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%
      </span>
    </div>
  );
}

/** 폴더 1단계 — 펼칠 때만 마운트(지연 로딩, 파일트리 DirChildren 패턴). */
function DirLevel({
  scanRoot,
  rel,
  depth,
  parentBytes,
  onReveal,
}: {
  scanRoot: string;
  rel: string;
  depth: number;
  parentBytes: number;
  onReveal: (path: string) => void;
}) {
  const msg = useMessages();
  const { data, isLoading, error } = useDiskChildren(scanRoot, rel);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (isLoading) {
    return (
      <div
        className="py-1 text-[11px] text-fg-dim"
        style={{ paddingLeft: depth * 14 + 24 }}
      >
        {msg.sysmon.common.reading}
      </div>
    );
  }
  if (error || !data) {
    return (
      <div
        className="py-1 text-[11px] text-danger/80"
        style={{ paddingLeft: depth * 14 + 24 }}
      >
        {error ? errorMessage(error) : msg.sysmon.diskUsage.readFailed}
      </div>
    );
  }

  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  // % 분모: 루트 레벨은 스캔 전체(=자기 bytes), 그 외엔 부모 폴더 합산.
  const denom = depth === 0 ? data.bytes : parentBytes;

  return (
    <>
      {data.dirs.map((d) => {
        const childRel = rel ? `${rel}/${d.name}` : d.name;
        const isOpen = expanded.has(d.name);
        return (
          <div key={`d:${d.name}`}>
            <div
              className="group flex cursor-pointer items-center gap-1 border-b border-edge/40 py-[3px] pr-2 text-[11px] hover:bg-raised/50"
              style={{ paddingLeft: depth * 14 + 4 }}
              onClick={() => toggle(d.name)}
            >
              {isOpen ? (
                <ChevronDown size={12} className="shrink-0 text-fg-dim" />
              ) : (
                <ChevronRight size={12} className="shrink-0 text-fg-dim" />
              )}
              <Folder size={13} className="shrink-0 text-warn/80" />
              <span className="min-w-0 flex-1 truncate text-fg" title={d.name}>
                {d.name}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onReveal(absPath(scanRoot, childRel));
                }}
                title={msg.sysmon.common.revealInExplorer}
                className="shrink-0 rounded p-0.5 text-fg-dim opacity-0 hover:bg-raised hover:text-fg group-hover:opacity-100"
              >
                <FolderOpen size={11} />
              </button>
              <span
                className="w-[76px] shrink-0 text-right font-mono text-fg-muted tabular-nums"
                title={sizeTip(d.bytes, d.alloc, msg)}
              >
                {formatBytes(d.bytes)}
              </span>
              <span className="shrink-0 px-1.5">
                <ShareBar bytes={d.bytes} parentBytes={denom} />
              </span>
              <span className="w-[64px] shrink-0 text-right font-mono text-fg-dim tabular-nums">
                {fmtInt(d.files)}
              </span>
              <span className="w-[74px] shrink-0 text-right font-mono text-fg-dim tabular-nums">
                {fmtDate(d.modified)}
              </span>
            </div>
            {isOpen ? (
              <DirLevel
                scanRoot={scanRoot}
                rel={childRel}
                depth={depth + 1}
                parentBytes={d.bytes}
                onReveal={onReveal}
              />
            ) : null}
          </div>
        );
      })}
      {data.files.map((f) => (
        <div
          key={`f:${f.name}`}
          className="group flex items-center gap-1 border-b border-edge/40 py-[3px] pr-2 text-[11px] hover:bg-raised/50"
          style={{ paddingLeft: depth * 14 + 4 }}
        >
          <span className="w-3 shrink-0" />
          <File size={13} className="shrink-0 text-fg-dim" />
          <span className="min-w-0 flex-1 truncate text-fg-muted" title={f.name}>
            {f.name}
          </span>
          <button
            type="button"
            onClick={() => onReveal(absPath(scanRoot, rel, f.name))}
            title={msg.sysmon.common.revealInExplorer}
            className="shrink-0 rounded p-0.5 text-fg-dim opacity-0 hover:bg-raised hover:text-fg group-hover:opacity-100"
          >
            <FolderOpen size={11} />
          </button>
          <span
            className="w-[76px] shrink-0 text-right font-mono text-fg-muted tabular-nums"
            title={sizeTip(f.bytes, f.alloc, msg)}
          >
            {formatBytes(f.bytes)}
          </span>
          <span className="shrink-0 px-1.5">
            <ShareBar bytes={f.bytes} parentBytes={denom} />
          </span>
          <span className="w-[64px] shrink-0 text-right font-mono text-fg-dim tabular-nums">
            —
          </span>
          <span className="w-[74px] shrink-0 text-right font-mono text-fg-dim tabular-nums">
            {fmtDate(f.modified)}
          </span>
        </div>
      ))}
      {data.truncatedFiles > 0 ? (
        <div
          className="py-1 text-[10px] text-fg-dim"
          style={{ paddingLeft: depth * 14 + 24 }}
        >
          {msg.sysmon.diskUsage.truncatedFiles(data.truncatedFiles)}
        </div>
      ) : null}
    </>
  );
}

/** 전역 최대 파일 Top 100 — "SSD 꽉참"의 범인 지목 목록. */
function TopFilesList({
  scanRoot,
  onReveal,
}: {
  scanRoot: string;
  onReveal: (path: string) => void;
}) {
  const msg = useMessages();
  const { data, isLoading } = useQuery({
    queryKey: ["disk-top", scanRoot],
    queryFn: () => ipc.diskTopFiles(100),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  });
  if (isLoading) {
    return <div className="px-3 py-4 text-[11px] text-fg-dim">{msg.sysmon.common.reading}</div>;
  }
  const max = data?.[0]?.bytes ?? 0;
  return (
    <>
      {(data ?? []).map((f, i) => (
        <div
          key={f.path}
          className="group flex items-center gap-1.5 border-b border-edge/40 px-2 py-[3px] text-[11px] hover:bg-raised/50"
        >
          <span className="w-6 shrink-0 text-right font-mono text-[10px] text-fg-dim tabular-nums">
            {i + 1}
          </span>
          <File size={13} className="shrink-0 text-fg-dim" />
          <span
            className="min-w-0 flex-1 truncate text-fg"
            title={f.path}
            style={{ direction: "rtl", textAlign: "left" }}
          >
            {f.path}
          </span>
          <button
            type="button"
            onClick={() => onReveal(f.path)}
            title={msg.sysmon.common.revealInExplorer}
            className="shrink-0 rounded p-0.5 text-fg-dim opacity-0 hover:bg-raised hover:text-fg group-hover:opacity-100"
          >
            <FolderOpen size={11} />
          </button>
          <span className="w-[76px] shrink-0 text-right font-mono text-fg-muted tabular-nums">
            {formatBytes(f.bytes)}
          </span>
          <span className="shrink-0 px-1.5">
            <ShareBar bytes={f.bytes} parentBytes={max} />
          </span>
          <span className="w-[74px] shrink-0 text-right font-mono text-fg-dim tabular-nums">
            {fmtDate(f.modified)}
          </span>
        </div>
      ))}
    </>
  );
}

/**
 * 디스크 용량 분석 뷰(TreeSize류) — DOCS/disk-usage-analyzer-design.md.
 * 드라이브/폴더 스캔 → 폴더별 크기 트리(캐시) + 파일(live) + 전역 최대 파일 Top 100.
 * 진행률은 스캔 시작 시 만든 Channel로 스트리밍, 창 재오픈 시엔 status 폴링으로 재동기화.
 */
export function DiskUsageView() {
  const msg = useMessages();
  const qc = useQueryClient();
  const pushToast = useUi((s) => s.pushToast);
  const [status, setStatus] = useState<DiskScanStatus | null>(null);
  const [roots, setRoots] = useState<DiskRoot[]>([]);
  const [mode, setMode] = useState<"tree" | "map" | "top">("tree");
  /** 트리맵 드릴다운 루트(rel) — 새 스캔이 완료되면 스캔 루트로 복귀한다. */
  const [mapRel, setMapRel] = useState("");
  // 이 창 인스턴스가 진행 Channel을 소유하는가 — 아니면(재오픈) status 폴링으로 따라간다.
  const ownsChannel = useRef(false);

  // 부팅 시 1회: 볼륨 목록 + 상태 재동기화(창 재오픈 시 진행 중/완료 스캔 이어받기).
  useEffect(() => {
    void ipc.diskRoots().then(setRoots).catch(() => setRoots([]));
    void ipc
      .diskScanStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);

  // 채널 없이 스캔이 진행 중이면(창 재오픈) 1초 폴링으로 진행률을 따라간다.
  useEffect(() => {
    if (status?.phase !== "scanning" || ownsChannel.current) return;
    const t = setInterval(() => {
      void ipc
        .diskScanStatus()
        .then((s) => {
          setStatus(s);
          if (s.phase === "done") {
            setMapRel("");
            void qc.invalidateQueries({ queryKey: ["disk"] });
            void qc.invalidateQueries({ queryKey: ["disk-map"] });
            void qc.invalidateQueries({ queryKey: ["disk-top"] });
          }
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(t);
  }, [status?.phase, qc]);

  const startScan = (path: string) => {
    ownsChannel.current = true;
    // 낙관 반영 — 첫 진행 메시지(250ms 뒤)까지 버튼이 죽은 것처럼 보이지 않게.
    setStatus({
      phase: "scanning",
      root: path,
      bytes: 0,
      alloc: 0,
      files: 0,
      dirs: 0,
      skipped: 0,
      elapsedMs: 0,
      done: false,
      error: null,
    });
    void ipc
      .diskScanStart(path, (s) => {
        setStatus(s);
        if (s.done) {
          ownsChannel.current = false;
          setMapRel("");
          // 스캔 결과가 바뀌었다 — 트리·트리맵·Top 캐시 전체 무효화(설계 §3.2).
          void qc.invalidateQueries({ queryKey: ["disk"] });
          void qc.invalidateQueries({ queryKey: ["disk-map"] });
          void qc.invalidateQueries({ queryKey: ["disk-top"] });
          if (s.phase === "error" && s.error) pushToast("error", s.error);
        }
      })
      .catch((e) => {
        ownsChannel.current = false;
        setStatus(null);
        pushToast("error", errorMessage(e));
      });
  };

  const pickFolder = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: msg.sysmon.diskUsage.pickFolderDialogTitle,
    });
    if (!picked || Array.isArray(picked)) return;
    startScan(picked);
  };

  const reveal = (path: string) => {
    void ipc.revealPath(path).catch((e) => pushToast("error", errorMessage(e)));
  };

  const scanning = status?.phase === "scanning";
  const scanRoot = status?.phase === "done" ? status.root : null;
  // 드라이브 루트 스캔이면 사용 중 용량이 진행률 분모가 된다(그 외 폴더는 분모 미상).
  const expected = scanning
    ? roots.find((r) => r.mount === status?.root)
    : undefined;
  const progressPct = expected
    ? Math.min(
        100,
        ((status?.bytes ?? 0) / Math.max(1, expected.total - expected.available)) *
          100,
      )
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 스캔 대상 선택 + 진행 상태 */}
      <div className="shrink-0 border-b border-edge bg-panel px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {roots.map((r) => {
            const used = r.total - r.available;
            const usedPct = r.total > 0 ? (used / r.total) * 100 : 0;
            return (
              <button
                key={r.mount}
                type="button"
                disabled={scanning}
                onClick={() => startScan(r.mount)}
                title={msg.sysmon.diskUsage.rootTitle(
                  r.mount,
                  formatBytes(used),
                  formatBytes(r.total),
                )}
                className={`flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] transition-colors ${
                  status?.root === r.mount
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-edge text-fg-muted hover:bg-raised hover:text-fg"
                } ${scanning ? "cursor-default opacity-60" : ""}`}
              >
                <HardDrive size={12} />
                <span className="font-mono">{r.mount}</span>
                <span className="h-[4px] w-10 overflow-hidden rounded-full bg-edge">
                  <span
                    className={`block h-full rounded-full ${pctBar(usedPct)}`}
                    style={{ width: `${usedPct}%` }}
                  />
                </span>
                <span className="font-mono text-[10px] text-fg-dim tabular-nums">
                  {msg.sysmon.diskUsage.rootFree(formatBytes(r.available))}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            disabled={scanning}
            onClick={() => void pickFolder()}
            className={`flex items-center gap-1 rounded border border-edge px-2 py-1 text-[11px] text-fg-muted transition-colors hover:bg-raised hover:text-fg ${
              scanning ? "cursor-default opacity-60" : ""
            }`}
          >
            <FolderSearch size={12} />
            {msg.sysmon.diskUsage.pickFolder}
          </button>
          <div className="flex-1" />
          {scanning ? (
            <button
              type="button"
              onClick={() => void ipc.diskScanCancel()}
              className="flex items-center gap-1 rounded border border-danger/40 px-2 py-1 text-[11px] text-danger hover:bg-danger/15"
            >
              <Square size={10} className="fill-current" />
              {msg.sysmon.diskUsage.stop}
            </button>
          ) : null}
        </div>

        {status && status.phase !== "idle" ? (
          <div className="mt-2 flex items-center gap-2">
            {scanning ? (
              <div className="h-[4px] w-28 shrink-0 overflow-hidden rounded-full bg-edge">
                {progressPct != null ? (
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-300"
                    style={{ width: `${progressPct}%` }}
                  />
                ) : (
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
                )}
              </div>
            ) : null}
            <span className="min-w-0 truncate font-mono text-[10px] text-fg-dim tabular-nums">
              {scanning
                ? msg.sysmon.diskUsage.scanProgress(
                    formatBytes(status.bytes),
                    status.files,
                    status.dirs,
                  )
                : status.phase === "done"
                  ? msg.sysmon.diskUsage.scanDone(
                      status.root,
                      formatBytes(status.bytes),
                      // 할당 크기가 0.5% 이상 다르면(압축·스파스 볼륨) 함께 표기
                      Math.abs(status.alloc - status.bytes) > status.bytes * 0.005
                        ? formatBytes(status.alloc)
                        : null,
                      status.files,
                      status.dirs,
                      (status.elapsedMs / 1000).toFixed(1),
                    )
                  : status.phase === "cancelled"
                    ? msg.sysmon.diskUsage.scanCancelled
                    : (status.error ?? msg.sysmon.diskUsage.scanFailed)}
              {status.skipped > 0
                ? msg.sysmon.diskUsage.skippedDirs(status.skipped)
                : ""}
            </span>
            {scanRoot ? (
              <>
                <div className="flex-1" />
                <div className="flex shrink-0 overflow-hidden rounded border border-edge text-[10px]">
                  {(
                    [
                      ["tree", msg.sysmon.diskUsage.modeTree],
                      ["map", msg.sysmon.diskUsage.modeTreemap],
                      ["top", msg.sysmon.diskUsage.modeTopFiles],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setMode(k)}
                      className={`px-2 py-0.5 transition-colors ${
                        mode === k
                          ? "bg-accent/15 text-accent"
                          : "text-fg-dim hover:bg-raised hover:text-fg"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 결과 — 트리맵은 자체 배치라 스크롤 대신 영역을 꽉 채운다 */}
      <div
        className={`min-h-0 flex-1 select-text ${
          scanRoot && mode === "map" ? "overflow-hidden" : "overflow-y-auto"
        }`}
      >
        {scanRoot ? (
          mode === "tree" ? (
            <>
              <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-edge bg-panel py-1.5 pl-[4px] pr-2 text-[10px] font-medium text-fg-dim">
                <span className="w-3 shrink-0" />
                <span className="min-w-0 flex-1 pl-4">{msg.sysmon.common.columnName}</span>
                <span className="w-[76px] shrink-0 text-right">
                  {msg.sysmon.diskUsage.columnSize}
                </span>
                <span className="w-[110px] shrink-0 px-1.5 text-right">
                  {msg.sysmon.diskUsage.columnShare}
                </span>
                <span className="w-[64px] shrink-0 text-right">
                  {msg.sysmon.diskUsage.columnFiles}
                </span>
                <span className="w-[74px] shrink-0 text-right">
                  {msg.sysmon.diskUsage.columnModified}
                </span>
              </div>
              <DirLevel
                scanRoot={scanRoot}
                rel=""
                depth={0}
                parentBytes={status?.bytes ?? 0}
                onReveal={reveal}
              />
            </>
          ) : mode === "map" ? (
            <DiskTreemap
              scanRoot={scanRoot}
              rel={mapRel}
              onDrill={setMapRel}
              onReveal={(rel) => reveal(absPath(scanRoot, rel))}
            />
          ) : (
            <TopFilesList scanRoot={scanRoot} onReveal={reveal} />
          )
        ) : !status || status.phase === "idle" ? (
          <div className="px-4 py-10 text-center text-xs text-fg-dim">
            {msg.sysmon.diskUsage.emptyTitle}
            <div className="mt-1 text-[10px]">
              {msg.sysmon.diskUsage.emptyNote}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
