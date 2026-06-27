import { RefreshCw, Settings as SettingsIcon, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Settings } from "../../lib/ipc";
import {
  useClearQuarantine,
  useGitCheck,
  useQuarantinedTools,
  useSetSettings,
  useSettings,
} from "../../queries";
import { useUi } from "../../stores/ui";

const isMacOS = /Mac/i.test(navigator.userAgent);

const inputCls =
  "w-full rounded border border-edge bg-base px-2 py-1 outline-none focus:border-accent";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 font-medium">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-fg-dim">{hint}</div>}
    </div>
  );
}

/**
 * macOS 격리 도구 검사 섹션.
 * brew cask로 설치한 CLI(예: claude)에 박힌 com.apple.quarantine을 스캔·해제한다.
 * 비-macOS에선 호출 측에서 렌더링하지 않는다.
 */
function QuarantineSection() {
  const { data, isFetching, refetch } = useQuarantinedTools();
  const clear = useClearQuarantine();
  const items = data ?? [];

  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 스캔 결과가 바뀌면 선택 상태를 초기화한다 — 사라진 항목이 선택돼 있으면 헷갈리니까.
  // 기본은 "전부 선택"으로 시작해 한 번에 해제하는 흐름을 자연스럽게 만든다.
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
    <>
      <div className="border-t border-edge pt-3 text-[11px] font-semibold tracking-widest text-fg-dim">
        macOS 격리 도구
      </div>
      <div className="text-[11px] leading-5 text-fg-muted">
        Homebrew cask로 설치한 CLI는 macOS 격리 속성이 박혀
        터미널에서 <span className="font-mono">permission denied</span>로
        실행이 막힙니다. 여기서 한 번에 해제할 수 있습니다.
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
          <span className="text-[12px] text-danger">
            ⚠️ 차단된 항목 {items.length}개
          </span>
        )}
      </div>

      {items.length > 0 && (
        <>
          <div className="max-h-44 overflow-y-auto rounded border border-edge bg-base">
            <label className="flex cursor-pointer items-center gap-2 border-b border-edge px-2 py-1.5 text-[12px] font-medium text-fg-muted hover:bg-raised">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="accent-accent"
              />
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
                  <div className="break-all font-mono text-[10px] text-fg-dim">
                    {it.path}
                  </div>
                </div>
              </label>
            ))}
          </div>
          <button
            onClick={() => clear.mutate(selectedList)}
            disabled={selectedList.length === 0 || clear.isPending}
            className="w-full rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {clear.isPending
              ? "해제 중…"
              : `선택 ${selectedList.length}개 격리 해제`}
          </button>
        </>
      )}
    </>
  );
}

/** 설정 모달 호스트 — 툴바 ⚙ 버튼으로 연다 (설계 F12). 테마는 후속 보류. */
export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const { data: settings } = useSettings();
  const { data: gitCheck } = useGitCheck();
  const save = useSetSettings();

  const [form, setForm] = useState<Settings | null>(null);

  // 모달을 열 때 현재 설정으로 폼을 초기화한다
  useEffect(() => {
    if (open && settings) setForm({ ...settings });
  }, [open, settings]);

  if (!open || !form) return null;

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  function handleSave() {
    if (!form) return;
    const cleaned: Settings = {
      ...form,
      gitPath: form.gitPath && form.gitPath.trim() ? form.gitPath.trim() : null,
      autoFetchMinutes: Math.max(0, Math.floor(form.autoFetchMinutes || 0)),
      diffFontSize: Math.min(
        24,
        Math.max(10, Math.floor(form.diffFontSize || 13)),
      ),
      terminalShell:
        form.terminalShell && form.terminalShell.trim()
          ? form.terminalShell.trim()
          : null,
      terminalFontSize: Math.min(
        24,
        Math.max(10, Math.floor(form.terminalFontSize || 13)),
      ),
    };
    save.mutate(cleaned, { onSuccess: () => setOpen(false) });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => setOpen(false)}
    >
      <div
        className="flex max-h-[85vh] w-[500px] flex-col rounded-lg border border-edge bg-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <SettingsIcon size={16} className="text-fg-muted" />
          <span className="font-semibold">설정</span>
          <div className="flex-1" />
          <button
            onClick={() => setOpen(false)}
            className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
          >
            <X size={15} />
          </button>
        </div>

        <div className="mt-4 flex-1 space-y-4 overflow-y-auto pr-1 text-[13px]">
          <Field label="테마">
            <div className="flex gap-2">
              {(["darcula", "monokai"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => update("theme", t)}
                  className={`flex-1 rounded border px-3 py-1.5 ${
                    form.theme === t
                      ? "border-accent bg-accent/15 text-fg"
                      : "border-edge text-fg-muted hover:bg-raised"
                  }`}
                >
                  {t === "darcula" ? "다크 (Darcula)" : "Monokai"}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Diff 폰트 크기" hint="10–24 px">
            <input
              type="number"
              min={10}
              max={24}
              value={form.diffFontSize}
              onChange={(e) => update("diffFontSize", Number(e.target.value))}
              className={inputCls}
            />
          </Field>

          <Field
            label="자동 fetch 주기 (분)"
            hint="0 = 끔. 켜면 모든 프로젝트를 주기적으로 fetch합니다 (기본 OFF)"
          >
            <input
              type="number"
              min={0}
              value={form.autoFetchMinutes}
              onChange={(e) =>
                update("autoFetchMinutes", Number(e.target.value))
              }
              className={inputCls}
            />
          </Field>

          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={form.confirmDiscard}
              onChange={(e) => update("confirmDiscard", e.target.checked)}
              className="accent-accent"
            />
            <span>변경 되돌리기·파일 삭제 전 확인 다이얼로그</span>
          </label>

          <Field label="git 실행 파일 경로" hint="비우면 PATH에서 자동 탐색 (변경은 다음 git 작업부터 적용)">
            <input
              type="text"
              value={form.gitPath ?? ""}
              placeholder="(자동 탐색)"
              onChange={(e) => update("gitPath", e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </Field>
          <div className="text-[11px] text-fg-dim">
            현재:{" "}
            {gitCheck?.found ? (
              <span className="font-mono text-fg-muted">
                {gitCheck.path} · {gitCheck.version}
              </span>
            ) : (
              <span className="text-danger">git을 찾지 못함</span>
            )}
          </div>

          <div className="border-t border-edge pt-3 text-[11px] font-semibold tracking-widest text-fg-dim">
            터미널
          </div>

          <Field
            label="셸"
            hint="비우면 자동 탐색 (pwsh → powershell → cmd). 새 터미널부터 적용"
          >
            <input
              type="text"
              value={form.terminalShell ?? ""}
              placeholder="(자동 탐색)"
              onChange={(e) => update("terminalShell", e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </Field>

          <Field label="터미널 폰트 크기" hint="10–24 px · 새 터미널부터 적용">
            <input
              type="number"
              min={10}
              max={24}
              value={form.terminalFontSize}
              onChange={(e) =>
                update("terminalFontSize", Number(e.target.value))
              }
              className={inputCls}
            />
          </Field>

          <div className="border-t border-edge pt-3 text-[11px] font-semibold tracking-widest text-fg-dim">
            알림
          </div>

          <Field
            label="AI 작업 완료 알림"
            hint="터미널의 Claude가 작업을 끝내면 OS 알림을 보냅니다. 상태바의 AI 칩을 클릭하면 해당 프로젝트로 이동합니다."
          >
            <select
              value={form.notifyMode || "project-inactive"}
              onChange={(e) =>
                update("notifyMode", e.target.value as Settings["notifyMode"])
              }
              className={inputCls}
            >
              <option value="off">끔</option>
              <option value="project-inactive">
                프로젝트 단위 · 창이 비활성일 때만
              </option>
              <option value="terminal">터미널 단위로 매번</option>
              <option value="always">항상 (포커스 중에도)</option>
            </select>
          </Field>

          {isMacOS && <QuarantineSection />}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => setOpen(false)}
            className="rounded px-3 py-1.5 text-fg-muted hover:bg-raised"
          >
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={save.isPending}
            className="rounded bg-accent px-3 py-1.5 font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {save.isPending ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}
