// 리소스 모니터 PC 관리 — 정리 가능 공간(DOCS/pc-care-design.md §4.10). 디스크 탭 빈 상태 아래.
// 프런트는 후보 id만 보낸다 — 지울 경로는 서버의 고정 후보표가 정한다.

import { Eraser, RefreshCw } from "lucide-react";
import { useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { useMessages } from "../../i18n/ui-language";
import { formatBytes } from "../../lib/format";
import { errorMessage, ipc } from "../../lib/ipc";
import { useUi } from "../../stores/ui";

const BTN =
  "flex items-center gap-1 rounded border border-edge px-2 py-1 text-[11px] text-fg-muted transition-colors hover:bg-raised hover:text-fg";

export function CleanupPanel() {
  const msg = useMessages();
  const t = msg.pccareTools;
  const askConfirm = useUi((s) => s.askConfirm);
  const pushToast = useUi((s) => s.pushToast);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);

  // 검사는 사용자가 눌렀을 때만 — 캐시 폴더를 훑는 데 수 초가 걸린다.
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["pccare-cleanup-scan"],
    queryFn: () => ipc.cleanupScan(),
    enabled: false,
    retry: false,
  });

  const items = data ?? [];
  const chosen = items.filter((c) => selected.has(c.id));
  const chosenBytes = chosen.reduce((s, c) => s + c.bytes, 0);
  const busy = isFetching || running;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = () => {
    if (chosen.length === 0) return;
    askConfirm({
      title: t.cleanupRun,
      message: t.cleanupConfirmMessage(chosen.length, formatBytes(chosenBytes)),
      confirmLabel: t.cleanupConfirmLabel,
      danger: true,
      onConfirm: () => {
        setRunning(true);
        void ipc
          .cleanupRun(chosen.map((c) => c.id))
          .then((r) =>
            pushToast(
              r.skippedFiles > 0 ? "info" : "success",
              t.cleanupDone(formatBytes(r.freedBytes), r.deletedFiles, r.skippedFiles),
            ),
          )
          .catch((e) => pushToast("error", t.cleanupFailed(errorMessage(e))))
          .finally(() => {
            setRunning(false);
            setSelected(new Set());
            void refetch();
          });
      },
    });
  };

  return (
    <section className="mx-auto mt-6 max-w-[680px] overflow-hidden rounded border border-edge bg-panel text-left">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-1.5">
        <span className="text-[11px] font-medium text-fg">{t.cleanupTitle}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={busy}
          className={`${BTN} ${busy ? "cursor-default opacity-60" : ""}`}
        >
          <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
          {isFetching ? t.cleanupScanning : t.cleanupScan}
        </button>
        <button
          type="button"
          onClick={run}
          disabled={busy || chosen.length === 0}
          className={`flex items-center gap-1 rounded border border-danger/40 px-2 py-1 text-[11px] text-danger hover:bg-danger/15 ${
            busy || chosen.length === 0 ? "cursor-default opacity-50" : ""
          }`}
        >
          <Eraser size={12} />
          {running ? t.cleanupRunning : t.cleanupRun}
          {chosen.length > 0 ? ` (${formatBytes(chosenBytes)})` : ""}
        </button>
      </div>
      {error ? (
        <div className="px-3 py-3 text-[11px] text-danger/80">
          {t.cleanupScanFailed(errorMessage(error))}
        </div>
      ) : !data ? (
        <div className="px-3 py-3 text-[11px] text-fg-dim">
          {isFetching ? t.cleanupScanning : t.cleanupHint}
        </div>
      ) : items.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-fg-dim">{t.cleanupEmpty}</div>
      ) : (
        <ul className="text-[11px]">
          {items.map((c) => (
            <li key={c.id} className="border-b border-edge/40 last:border-0 hover:bg-hover">
              <label className="flex cursor-pointer items-start gap-2 px-3 py-1.5">
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  onChange={() => toggle(c.id)}
                  disabled={busy}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-fg">{c.label}</div>
                  {c.path ? (
                    <div className="truncate text-[10px] text-fg-dim" title={c.path}>
                      {c.path}
                    </div>
                  ) : null}
                  {c.note ? <div className="text-[10px] text-fg-dim">{c.note}</div> : null}
                </div>
                <div className="shrink-0 text-right tabular-nums">
                  <div className="text-fg-muted">{formatBytes(c.bytes)}</div>
                  <div className="text-[10px] text-fg-dim">{t.cleanupFiles(c.files)}</div>
                </div>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
