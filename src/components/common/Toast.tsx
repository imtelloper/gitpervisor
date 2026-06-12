import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";

import { useUi } from "../../stores/ui";

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismissToast = useUi((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="absolute bottom-8 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="flex max-w-96 items-start gap-2 rounded-md border border-edge bg-raised px-3 py-2 shadow-lg"
        >
          {t.kind === "error" ? (
            <CircleAlert size={15} className="mt-0.5 shrink-0 text-danger" />
          ) : t.kind === "success" ? (
            <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-ok" />
          ) : (
            <Info size={15} className="mt-0.5 shrink-0 text-accent" />
          )}
          <span className="select-text break-all text-[13px] leading-5">
            {t.message}
          </span>
          <button
            onClick={() => dismissToast(t.id)}
            className="ml-1 mt-0.5 shrink-0 text-fg-dim hover:text-fg"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
