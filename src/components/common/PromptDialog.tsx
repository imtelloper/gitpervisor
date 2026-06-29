import { useEffect, useRef, useState } from "react";

import { useUi } from "../../stores/ui";

/** 전역 텍스트 입력 다이얼로그 호스트 — useUi.askPrompt 로 띄운다 (새 폴더 이름·다른 이름 저장 등). */
export function PromptHost() {
  const prompt = useUi((s) => s.prompt);
  const closePrompt = useUi((s) => s.closePrompt);

  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

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
  const canSubmit = value.trim().length > 0 && !error;

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
            취소
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="rounded bg-accent px-3 py-1.5 text-[13px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {prompt.confirmLabel ?? "확인"}
          </button>
        </div>
      </div>
    </div>
  );
}
