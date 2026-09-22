import { Copy, Languages, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Messages } from "../../i18n/messages";
import { useMessages } from "../../i18n/ui-language";
import { copyText } from "../../lib/clipboard";
import { errorMessage } from "../../lib/ipc";
import { llmReadyReason, useLlmStatus } from "../../lib/llm";
import { autoTarget, translateStream } from "../../lib/translate";
import { useSettings } from "../../queries";
import { useOccludesWebview } from "../../stores/occlusion";
import { useUi, type TranslateRequest } from "../../stores/ui";

/** 카드 토글이 다루는 두 언어(태스크 61 §7 — 목록 확장은 후속). 모르는 코드는 코드 그대로. */
function langLabel(msg: Messages, code: string): string {
  switch (code) {
    case "ko":
      return msg.shell.translateCard.langKorean;
    case "en":
      return msg.shell.translateCard.langEnglish;
    default:
      return code;
  }
}

/**
 * 선택 텍스트 번역 카드의 창별 호스트(태스크 61). `useUi`는 창마다 별개라 카드를 띄우는 창마다
 * 마운트해야 한다 — App·AggregateWindow·FloatingTerminal·DocWindow(ConfirmHost와 같은 이유).
 *
 * 차단 모달이 아니므로 selectBlockingOverlay가 아니라 여기서 점유를 등록한다(26 호버 카드와 같은 층):
 * 카드가 브라우저 셀의 네이티브 webview 위로 나가면 등록 없이는 통째로 가려 보이지 않는다.
 */
export function TranslateHost() {
  const req = useUi((s) => s.translate);
  const closeTranslate = useUi((s) => s.closeTranslate);
  useOccludesWebview(!!req);
  return req ? <TranslateCard req={req} onClose={closeTranslate} /> : null;
}

function TranslateCard({
  req,
  onClose,
}: {
  req: TranslateRequest;
  onClose: () => void;
}) {
  const msg = useMessages();
  const { data: settings } = useSettings();
  const { data: llm } = useLlmStatus();
  const pushToast = useUi((s) => s.pushToast);
  const openSettings = useUi((s) => s.openSettings);
  const boxRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [out, setOut] = useState("");
  /** 사용자에게 보일 진행 한 줄(모델 로드 중·대기 중). 토큰이 흐르기 시작하면 null. */
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // 방향 토글은 **이 요청에 한정**된다 — 새 요청(다른 선택)이 오면 자동 판정으로 돌아간다.
  // 카드는 언마운트되지 않으므로 요청 객체로 짝을 지어야 옛 토글이 새 요청에 묻어가지 않는다.
  const [override, setOverride] = useState<{ req: TranslateRequest; target: string } | null>(null);
  const target =
    override?.req === req ? override.target : autoTarget(req.text, settings?.llmLanguage);
  const other = target === "ko" ? "en" : "ko";
  const reason = llmReadyReason(llm, settings);

  // Esc·카드 바깥 mousedown → 닫힘. 진행 중이던 스트림 중단은 아래 효과의 정리(abort)가 한다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  // 요청·방향이 바뀔 때마다 처음부터 다시 번역한다. 정리에서 abort → llm_cancel(59)로 서버까지 끊긴다.
  useEffect(() => {
    if (reason) return; // 준비 안 됨 — 카드는 이유와 '설정 열기'만 보인다
    const ac = new AbortController();
    setOut("");
    setError(null);
    setDone(false);
    setPhase(null);
    translateStream(req.text, target, (d) => setOut((p) => p + d), ac.signal, setPhase)
      .then(() => setDone(true))
      .catch((e) => {
        if (!ac.signal.aborted) setError(errorMessage(e));
      });
    return () => ac.abort();
  }, [req, target, reason]);

  const modelLabel =
    settings?.llmProvider === "external"
      ? msg.shell.translateCard.externalServer
      : settings?.llmModel === "custom"
        ? msg.shell.translateCard.customModel
        : (llm?.models.find((m) => m.id === settings?.llmModel)?.label ??
          settings?.llmModel ??
          "");

  return (
    <div
      ref={boxRef}
      role="dialog"
      className="fixed z-50 flex max-h-[60vh] w-[min(520px,90vw)] flex-col rounded-md border border-edge bg-panel shadow-xl"
      style={{
        // max(8, …)은 창이 카드보다 좁을 때 — 플로팅 창은 최소 폭이 360이라 그대로 두면 음수가 된다.
        left: Math.max(8, Math.min(req.x, window.innerWidth - 540)),
        // ChangesPanel의 세로 뒤집기 관례 — 아래 절반에서 열면 카드가 위로 자란다.
        ...(req.y > window.innerHeight / 2
          ? { bottom: window.innerHeight - req.y }
          : { top: req.y }),
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-1.5 text-[12px]">
        <Languages size={13} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-fg-muted">
          {msg.shell.translateCard.header(langLabel(msg, target))}
        </span>
        <button
          onClick={() => setOverride({ req, target: other })}
          title={msg.shell.translateCard.translateToTitle(langLabel(msg, other))}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-fg-dim hover:bg-raised hover:text-fg"
        >
          → {other.toUpperCase()}
        </button>
        <button
          onClick={() =>
            void copyText(out).then((ok) =>
              pushToast(
                ok ? "success" : "error",
                ok ? msg.shell.translateCard.copied : msg.shell.translateCard.copyFailed,
              ),
            )
          }
          disabled={!out}
          title={msg.shell.translateCard.copyTitle}
          className="shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-fg disabled:opacity-40"
        >
          <Copy size={13} />
        </button>
        <button
          onClick={onClose}
          title={msg.shell.translateCard.close}
          className="shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <X size={13} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 원문 — 기본 3줄, 클릭하면 전문. */}
        <button
          onClick={() => setExpanded((v) => !v)}
          title={
            expanded ? msg.shell.translateCard.collapseSource : msg.shell.translateCard.expandSource
          }
          className="block w-full px-3 py-2 text-left text-[12px] leading-5 text-fg-dim hover:bg-raised/50"
        >
          <span
            className={expanded ? "whitespace-pre-wrap break-words" : "line-clamp-3 break-words"}
          >
            {req.text}
          </span>
        </button>
        <div className="border-t border-edge" />
        {reason ? (
          <div className="px-3 py-3 text-[12px] leading-5 text-fg-muted">
            {reason}
            <button
              onClick={() => openSettings("ai")}
              className="ml-2 rounded border border-edge px-1.5 py-0.5 text-[11px] text-fg-dim hover:bg-raised hover:text-fg"
            >
              {msg.shell.translateCard.openSettings}
            </button>
          </div>
        ) : error ? (
          <div className="px-3 py-3 text-[12px] leading-5 text-danger">{error}</div>
        ) : (
          <div className="whitespace-pre-wrap break-words px-3 py-2 text-[12px] leading-5 text-fg">
            {/* data 훅: e2e 49가 번역문만 따로 읽는다(커서·진행 문구가 섞이면 못 잰다). */}
            <span data-gpv-translation="">{out}</span>
            {!done &&
              (out ? (
                <span className="text-accent">▍</span>
              ) : (
                (phase ?? msg.shell.translateCard.translating)
              ))}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-edge px-3 py-1 text-[10px] text-fg-dim">
        <span className="min-w-0 flex-1 truncate">{modelLabel}</span>
        {req.truncated && (
          <span className="shrink-0 rounded bg-raised px-1 py-0.5 text-warn">
            {msg.shell.translateCard.truncated}
          </span>
        )}
        {!reason && !done && !error && (
          <button
            onClick={onClose}
            className="shrink-0 rounded px-1.5 py-0.5 hover:bg-raised hover:text-fg"
          >
            {msg.shell.translateCard.cancel}
          </button>
        )}
      </div>
    </div>
  );
}
