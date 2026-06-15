import { Settings as SettingsIcon, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { Settings } from "../../lib/ipc";
import { useGitCheck, useSetSettings, useSettings } from "../../queries";
import { useUi } from "../../stores/ui";

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
    };
    save.mutate(cleaned, { onSuccess: () => setOpen(false) });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[460px] rounded-lg border border-edge bg-panel p-5 shadow-xl"
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

        <div className="mt-4 space-y-4 text-[13px]">
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
            className="rounded bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {save.isPending ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}
