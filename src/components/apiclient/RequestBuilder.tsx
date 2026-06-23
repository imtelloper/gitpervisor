import { Cog, Send } from "lucide-react";
import { forwardRef } from "react";

import { methodColor } from "../../lib/method-color";
import type { HttpMethod } from "../../stores/apiclient";
import { useApiClient } from "../../stores/apiclient";

const METHODS: HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

/**
 * 요청 빌더 헤더(§8.5) — DbWorkspace QueryEditor 헤더 미러(h-9).
 * method <select> + URL <input> + env <select> + Send 주요버튼(Ctrl+↵).
 * urlRef는 ApiClientTab의 Ctrl+L 포커스용.
 */
export const RequestBuilder = forwardRef<HTMLInputElement, { tabId: string }>(
  function RequestBuilder({ tabId }, urlRef) {
    const draft = useApiClient((s) => s.draftById[tabId]);
    const patchDraft = useApiClient((s) => s.patchDraft);
    const sending = useApiClient((s) => s.sending[tabId] ?? false);
    const send = useApiClient((s) => s.send);
    const environments = useApiClient((s) => s.environments);
    const activeEnvId = useApiClient((s) => s.activeEnvId);
    const setEnvironment = useApiClient((s) => s.setEnvironment);
    const openEnvDialog = useApiClient((s) => s.openEnvDialog);

    const globalEnvs = Object.values(environments).filter(
      (e) => e.scope === "global",
    );

    if (!draft) return null;

    return (
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge px-3">
        <select
          value={draft.method}
          onChange={(e) =>
            patchDraft(tabId, { method: e.target.value as HttpMethod })
          }
          title="HTTP 메서드"
          className={`rounded border border-edge bg-base px-1 py-0.5 text-xs font-semibold outline-none focus:border-accent ${methodColor(
            draft.method,
          )}`}
        >
          {METHODS.map((m) => (
            <option key={m} value={m} className="text-fg">
              {m}
            </option>
          ))}
        </select>

        <input
          ref={urlRef}
          value={draft.url}
          onChange={(e) => patchDraft(tabId, { url: e.target.value })}
          placeholder="{{base}}/users  또는  https://api.example.com/v1"
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-edge bg-base px-2 py-1 text-xs font-mono outline-none focus:border-accent"
        />

        <label className="flex shrink-0 items-center gap-1 text-xs text-fg-dim">
          env
          <select
            value={activeEnvId ?? ""}
            onChange={(e) => setEnvironment(e.target.value || null)}
            title="활성 환경(Global)"
            className="rounded border border-edge bg-base px-1 py-0.5 text-fg outline-none focus:border-accent"
          >
            <option value="">없음</option>
            {globalEnvs.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={openEnvDialog}
          title="환경 관리"
          className="shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <Cog size={14} />
        </button>

        <button
          onClick={() => void send(tabId)}
          disabled={sending || !draft.url.trim()}
          className="flex shrink-0 items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          <Send size={12} /> {sending ? "전송 중…" : "Send"}{" "}
          <span className="font-mono opacity-70">Ctrl+↵</span>
        </button>
      </div>
    );
  },
);
