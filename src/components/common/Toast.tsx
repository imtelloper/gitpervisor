import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";

import { useUi } from "../../stores/ui";

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismissToast = useUi((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  // z-[55] — 설정·메모·이미지 편집기 모달(z-50)보다 위: 모달을 연 채로도 토스트의 X·액션 버튼을
  // 누를 수 있어야 한다(같은 z-50이면 DOM 뒤인 모달 오버레이가 hit-test를 가져간다).
  // 대신 확인/입력 다이얼로그(z-[60])보다는 아래 — 응답을 요구하는 차단성 UI다.
  // 우측 하단 카드 스택(App.tsx의 HealthBanner+StarPrompt, z-40)은 의도대로 모달 아래에 남는다.
  return (
    <div className="absolute bottom-8 right-4 z-[55] flex flex-col gap-2">
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
          {t.action && (
            <button
              onClick={() => {
                t.action?.run();
                dismissToast(t.id);
              }}
              className="ml-1 mt-0.5 shrink-0 rounded bg-accent/20 px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/30"
            >
              {t.action.label}
            </button>
          )}
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
