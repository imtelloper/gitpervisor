// 유지보수 (태스크 18) — 브라우저 데이터 초기화·진단 로그·macOS 격리. 전부 "폼이 아닌 즉시 액션"이라
// 저장/취소 대상이 아니고 자체 로컬 상태를 가진다. 셸이 이 섹션을 hidden 마운트로 유지해(§3.6 I1)
// 카테고리 왕복 시 선택 Set·busy·로그 뷰가 소실되지 않는다.
import {
  FolderOpen,
  Globe,
  RefreshCw,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { clearBrowserData } from "../../../lib/browser";
import { formatBytes } from "../../../lib/format";
import type { LogStatus } from "../../../lib/ipc";
import { errorMessage, ipc } from "../../../lib/ipc";
import { useClearQuarantine, useQuarantinedTools } from "../../../queries";
import { useUi } from "../../../stores/ui";
import { Hl } from "./shared";

const isMacOS = /Mac/i.test(navigator.userAgent);
const subHeading = "border-t border-edge pt-3 text-[11px] font-semibold tracking-widest text-fg-dim";

export function MaintenanceSection({ hl }: { hl: Set<string> }) {
  return (
    <>
      <Hl id="browserData" hl={hl}>
        <BrowserData />
      </Hl>
      <Hl id="crashLog" hl={hl}>
        <Diagnostics />
      </Hl>
      {isMacOS && (
        <Hl id="quarantine" hl={hl}>
          <Quarantine />
        </Hl>
      )}
    </>
  );
}

function BrowserData() {
  const [busy, setBusy] = useState(false);
  const toast = (kind: "error" | "success", m: string) => useUi.getState().pushToast(kind, m);
  const confirmClear = () =>
    useUi.getState().askConfirm({
      title: "브라우저 데이터 초기화",
      message:
        "임베디드 브라우저의 모든 로그인 세션·쿠키·사이트 데이터를 지웁니다. 모든 사이트에서 로그아웃됩니다.",
      confirmLabel: "초기화",
      danger: true,
      onConfirm: () => {
        setBusy(true);
        void clearBrowserData()
          .then(() => toast("success", "브라우저 로그인/쿠키 데이터를 지웠습니다"))
          .catch((e) => toast("error", errorMessage(e)))
          .finally(() => setBusy(false));
      },
    });
  return (
    <div className="space-y-2">
      <div className={subHeading}>브라우저</div>
      <div className="text-[11px] leading-5 text-fg-muted">
        임베디드 브라우저 탭·팝업이 공유하는 로그인 세션과 쿠키를 지웁니다. 북마크와 방문 기록은
        유지됩니다.
      </div>
      <button
        disabled={busy}
        onClick={confirmClear}
        className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-danger hover:bg-danger/15 disabled:opacity-50"
      >
        <Globe size={12} />
        {busy ? "초기화 중…" : "브라우저 데이터 초기화"}
      </button>
    </div>
  );
}

function Diagnostics() {
  const [status, setStatus] = useState<LogStatus | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    void ipc.getLogStatus().then(setStatus).catch(() => {});
  }, []);
  useEffect(() => refresh(), [refresh]);
  const hasCrash = !!status && status.panicLogBytes > 0;
  const toast = (kind: "error" | "success", m: string) => useUi.getState().pushToast(kind, m);
  return (
    <div className="space-y-2">
      <div className={subHeading}>진단 / 로그</div>
      <div className="text-[11px] leading-5 text-fg-muted">
        앱이 비정상 종료해도 원인과 백트레이스가 <span className="font-mono">panic.log</span>에
        기록됩니다. 여기서 로그 폴더를 열거나 마지막 크래시 내용을 확인할 수 있습니다.
      </div>
      {status?.logDir && (
        <div className="break-all font-mono text-[10px] text-fg-dim">{status.logDir}</div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void ipc.openLogsFolder().catch((e) => toast("error", errorMessage(e)))}
          className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-fg-muted hover:bg-raised hover:text-fg"
        >
          <FolderOpen size={12} />
          로그 폴더 열기
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setLog(await ipc.readCrashLog(256 * 1024));
            } catch (e) {
              toast("error", errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
          className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-50"
        >
          <ScrollText size={12} />
          패닉 로그 보기
        </button>
        {hasCrash && (
          <button
            onClick={async () => {
              try {
                await ipc.clearCrashLog();
                setLog(null);
                refresh();
                toast("success", "크래시 로그를 비웠습니다");
              } catch (e) {
                toast("error", errorMessage(e));
              }
            }}
            className="rounded border border-edge px-2.5 py-1 text-danger hover:bg-danger/15"
          >
            비우기
          </button>
        )}
      </div>
      {hasCrash ? (
        <span className="text-[12px] text-danger">
          ⚠️ 마지막 크래시: {status?.lastCrashAt ?? "?"} ({formatBytes(status?.panicLogBytes ?? 0)})
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-[12px] text-add">
          <ShieldCheck size={13} />
          크래시 기록 없음
        </span>
      )}
      {log !== null && (
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded border border-edge bg-base p-2 font-mono text-[10px] leading-4">
          {log || "(비어 있음)"}
        </pre>
      )}
    </div>
  );
}

function Quarantine() {
  const { data, isFetching, refetch } = useQuarantinedTools();
  const clear = useClearQuarantine();
  const items = data ?? [];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected(new Set(items.map((i) => i.path)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const allSelected = items.length > 0 && selected.size === items.length;
  const selectedList = useMemo(
    () => items.filter((i) => selected.has(i.path)).map((i) => i.path),
    [items, selected],
  );
  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(items.map((i) => i.path)));
  return (
    <div className="space-y-2">
      <div className={subHeading}>macOS 격리 도구</div>
      <div className="text-[11px] leading-5 text-fg-muted">
        Homebrew cask로 설치한 CLI는 macOS 격리 속성이 박혀 터미널에서{" "}
        <span className="font-mono">permission denied</span>로 실행이 막힙니다. 여기서 한 번에 해제할
        수 있습니다.
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => void refetch()}
          disabled={isFetching || clear.isPending}
          className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-50"
        >
          <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
          다시 검사
        </button>
        {items.length === 0 && !isFetching && (
          <span className="flex items-center gap-1.5 text-[12px] text-add">
            <ShieldCheck size={13} />
            차단된 항목 없음
          </span>
        )}
        {items.length > 0 && (
          <span className="text-[12px] text-danger">⚠️ 차단된 항목 {items.length}개</span>
        )}
      </div>
      {items.length > 0 && (
        <>
          <div className="max-h-44 overflow-y-auto rounded border border-edge bg-base">
            <label className="flex cursor-pointer items-center gap-2 border-b border-edge px-2 py-1.5 text-[12px] font-medium text-fg-muted hover:bg-raised">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-accent" />
              <span>전체 선택</span>
            </label>
            {items.map((it) => (
              <label
                key={it.path}
                className="flex cursor-pointer items-start gap-2 px-2 py-1.5 hover:bg-raised"
              >
                <input
                  type="checkbox"
                  checked={selected.has(it.path)}
                  onChange={() => toggle(it.path)}
                  className="mt-0.5 accent-accent"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px]">
                    <span className="font-medium">{it.name}</span>
                    <span className="ml-1 text-fg-dim">({it.cask})</span>
                  </div>
                  <div className="break-all font-mono text-[10px] text-fg-dim">{it.path}</div>
                </div>
              </label>
            ))}
          </div>
          <button
            onClick={() => clear.mutate(selectedList)}
            disabled={selectedList.length === 0 || clear.isPending}
            className="w-full rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {clear.isPending ? "해제 중…" : `선택 ${selectedList.length}개 격리 해제`}
          </button>
        </>
      )}
    </div>
  );
}
