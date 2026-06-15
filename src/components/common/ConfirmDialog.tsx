import { useUi } from "../../stores/ui";

/** 전역 확인 다이얼로그 호스트 — useUi.askConfirm 으로 띄운다 */
export function ConfirmHost() {
  const confirm = useUi((s) => s.confirm);
  const closeConfirm = useUi((s) => s.closeConfirm);

  if (!confirm) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={closeConfirm}
    >
      <div
        className="w-100 rounded-lg border border-edge bg-panel p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-semibold">{confirm.title}</div>
        <div className="mt-2 break-all text-[13px] leading-5 text-fg-muted">
          {confirm.message}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={closeConfirm}
            className="rounded px-3 py-1.5 text-[13px] text-fg-muted hover:bg-raised"
          >
            취소
          </button>
          <button
            autoFocus
            onClick={() => {
              confirm.onConfirm();
              closeConfirm();
            }}
            className={`rounded px-3 py-1.5 text-[13px] font-medium ${
              confirm.danger
                ? "bg-danger text-white hover:bg-danger/80"
                : "bg-accent text-on-accent hover:bg-accent-hover"
            }`}
          >
            {confirm.confirmLabel ?? "확인"}
          </button>
        </div>
      </div>
    </div>
  );
}
