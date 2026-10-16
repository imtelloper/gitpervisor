// 리소스 모니터 PC 관리 — 파일 잠금 찾기(DOCS/pc-care-design.md §4.9). 프로세스 탭 헤더의 버튼 + 대화상자.
// 끝내기는 프로세스 탭과 같은 kill_processes(앱 자신 제외 규칙 포함)를 그대로 쓴다.

import { File, FolderOpen, Lock, RefreshCw, X } from "lucide-react";
import { useState } from "react";

import { open } from "@tauri-apps/plugin-dialog";
import { useQuery } from "@tanstack/react-query";

import { useMessages } from "../../i18n/ui-language";
import { errorMessage, ipc } from "../../lib/ipc";
import type { FileLocker } from "../../lib/ipc";
import { useUi } from "../../stores/ui";

const BTN =
  "flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-edge px-2 py-1 text-[11px] text-fg-muted transition-colors hover:bg-raised hover:text-fg";

export function FileLockButton() {
  const msg = useMessages();
  const [shown, setShown] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setShown(true)}
        title={msg.pccareTools.lockButtonTitle}
        className={BTN}
      >
        <Lock size={12} />
        {msg.pccareTools.lockButton}
      </button>
      {shown ? <FileLockDialog onClose={() => setShown(false)} /> : null}
    </>
  );
}

function FileLockDialog({ onClose }: { onClose: () => void }) {
  const msg = useMessages();
  const t = msg.pccareTools;
  const w = msg.sysmon.window;
  const askConfirm = useUi((s) => s.askConfirm);
  const pushToast = useUi((s) => s.pushToast);
  const [path, setPath] = useState<string | null>(null);

  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["pccare-file-lockers", path],
    queryFn: () => ipc.fileLockers(path ?? ""),
    enabled: path != null,
    retry: false,
    gcTime: 0,
  });

  const pick = async (directory: boolean) => {
    const picked = await open({
      directory,
      multiple: false,
      title: directory ? t.lockPickFolderDialogTitle : t.lockPickFileDialogTitle,
    });
    if (!picked || Array.isArray(picked)) return;
    setPath(picked);
  };

  const kill = (l: FileLocker) => {
    askConfirm({
      title: w.kill,
      message: w.killConfirm(`${l.name} (PID ${l.pid})`, ""),
      confirmLabel: w.kill,
      danger: true,
      onConfirm: () => {
        void ipc
          .killProcesses([l.pid])
          .then((r) => {
            const skipped = r.skipped.length ? w.killSkippedSelf(r.skipped.length) : "";
            if (r.failed.length === 0 && r.killed > 0) {
              pushToast("success", w.killDone(l.name, skipped));
            } else if (r.skipped.length > 0) {
              pushToast("info", w.killOnlySelf);
            } else {
              pushToast("error", w.killFailed);
            }
          })
          .catch((e) => pushToast("error", errorMessage(e)))
          .finally(() => void refetch());
      },
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[min(720px,92vw)] flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2">
          <Lock size={13} className="text-fg-dim" />
          <span className="text-[12px] font-medium text-fg">{t.lockButton}</span>
          <div className="flex-1" />
          <button type="button" onClick={onClose} title={t.lockClose} className="rounded p-1 text-fg-dim hover:bg-hover hover:text-fg">
            <X size={13} />
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2">
          <button type="button" onClick={() => void pick(false)} className={BTN}>
            <File size={12} />
            {t.lockPickFile}
          </button>
          <button type="button" onClick={() => void pick(true)} className={BTN}>
            <FolderOpen size={12} />
            {t.lockPickFolder}
          </button>
          <span className="min-w-0 flex-1 truncate text-[11px] text-fg-dim" title={path ?? undefined}>
            {path}
          </span>
          {path != null ? (
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className={`${BTN} ${isFetching ? "cursor-default opacity-60" : ""}`}
            >
              <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
              {t.lockRescan}
            </button>
          ) : null}
        </div>
        <div className="min-h-[120px] flex-1 overflow-y-auto">
          {path == null ? (
            <div className="px-4 py-10 text-center text-xs text-fg-dim">{t.lockPrompt}</div>
          ) : isFetching && !data ? (
            <div className="px-4 py-10 text-center text-xs text-fg-dim">{t.lockSearching}</div>
          ) : error ? (
            <div className="px-4 py-10 text-center text-xs text-danger/80">
              {t.lockFailed(errorMessage(error))}
            </div>
          ) : data ? (
            <>
              {data.truncated || data.notes.length ? (
                <div className="space-y-0.5 border-b border-edge px-3 py-1.5 text-[10px] text-fg-dim">
                  {data.truncated ? <div>{t.lockTruncated}</div> : null}
                  {data.notes.map((n) => (
                    <div key={n}>{n}</div>
                  ))}
                </div>
              ) : null}
              {data.lockers.length === 0 ? (
                <div className="px-4 py-10 text-center text-xs text-fg-dim">{t.lockNone}</div>
              ) : (
                <table className="w-full table-fixed border-collapse text-[11px]">
                  <thead className="sticky top-0 bg-panel text-fg-dim">
                    <tr className="border-b border-edge">
                      <th className="w-[22%] px-3 py-1 text-left font-normal">{t.lockColName}</th>
                      <th className="w-[10%] px-2 py-1 text-right font-normal">PID</th>
                      <th className="w-[26%] px-2 py-1 text-left font-normal">{t.lockColReason}</th>
                      <th className="px-2 py-1 text-left font-normal">{t.lockColExe}</th>
                      <th className="w-[96px] px-2 py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.lockers.map((l) => (
                      <tr key={l.pid} className="border-b border-edge/40 hover:bg-hover">
                        <td className="truncate px-3 py-1 text-fg" title={l.name}>{l.name}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-fg-muted">{l.pid}</td>
                        <td className="truncate px-2 py-1 text-fg-muted" title={l.reason}>{l.reason}</td>
                        <td className="truncate px-2 py-1 text-fg-dim" title={l.exePath ?? undefined}>
                          {l.exePath ?? "—"}
                        </td>
                        <td className="px-2 py-1 text-right">
                          <button
                            type="button"
                            onClick={() => kill(l)}
                            className="rounded border border-danger/40 px-1.5 py-0.5 text-[10px] text-danger hover:bg-danger/15"
                          >
                            {w.kill}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
