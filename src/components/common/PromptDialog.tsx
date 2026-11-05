import { useEffect, useRef, useState } from "react";

import { useMessages } from "../../i18n/ui-language";
import { useUi } from "../../stores/ui";

/** 닫히면 열 때 포커스가 있던 곳으로 되돌린다 — 그대로 두면 BODY 에 남아 연 화면의 단축키(Ctrl+S·Delete)가 죽는다. */
export function useReturnFocus(open: boolean) {
  const opener = useRef<Element | null>(null);
  // 렌더 중에 잡는다 — 커밋 단계의 autoFocus·입력 포커스가 옮긴 뒤면 다이얼로그 자신이 잡힌다.
  if (open && !opener.current) opener.current = document.activeElement;
  useEffect(() => {
    if (open) return;
    const el = opener.current;
    opener.current = null;
    // 확인 동작이 포커스를 다른 데로 옮겼으면(새 창·편집기) 빼앗지 않는다.
    if (el instanceof HTMLElement && el.isConnected && document.activeElement === document.body)
      el.focus({ preventScroll: true });
  }, [open]);
}

/** 전역 텍스트 입력 다이얼로그 호스트 — useUi.askPrompt 로 띄운다 (새 폴더 이름·다른 이름 저장 등). */
export function PromptHost() {
  const msg = useMessages();
  const prompt = useUi((s) => s.prompt);
  const closePrompt = useUi((s) => s.closePrompt);

  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useReturnFocus(!!prompt);

  // 새 요청이 뜰 때마다 기본값으로 초기화하고 입력에 포커스(파일명은 확장자 앞까지 선택).
  useEffect(() => {
    if (!prompt) return;
    const init = prompt.defaultValue ?? "";
    setValue(init);
    const id = window.setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const dot = init.lastIndexOf(".");
      el.setSelectionRange(0, dot > 0 ? dot : init.length);
    }, 0);
    return () => window.clearTimeout(id);
  }, [prompt]);

  if (!prompt) return null;

  const error = prompt.validate ? prompt.validate(value) : null;
  const canSubmit = (prompt.allowEmpty || value.trim().length > 0) && !error;

  const submit = () => {
    if (!canSubmit) return;
    prompt.onConfirm(value.trim());
    closePrompt();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={closePrompt}
    >
      <div
        className="w-100 rounded-lg border border-edge bg-panel p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-semibold">{prompt.title}</div>
        {prompt.label && (
          <div className="mt-1 text-[12px] text-fg-dim">{prompt.label}</div>
        )}
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // 다른 모달(이미지 편집기 등)의 전역 Esc 핸들러로 새지 않게 막는다.
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              closePrompt();
            }
          }}
          placeholder={prompt.placeholder}
          className="mt-2 w-full rounded border border-edge bg-raised px-2.5 py-1.5 text-[13px] outline-none focus:border-accent"
        />
        <div className="mt-1 h-4 text-[12px] text-danger">{error ?? ""}</div>
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={closePrompt}
            className="rounded px-3 py-1.5 text-[13px] text-fg-muted hover:bg-raised"
          >
            {msg.shell.dialogButtons.cancel}
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="rounded bg-accent px-3 py-1.5 text-[13px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {prompt.confirmLabel ?? msg.shell.dialogButtons.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
