// AI › MCP 서버 소제목 (DOCS/mcp-server-design.md §7·§8). 토큰은 켤 때 여기서 만든다 — 백엔드는 빈 토큰이면
// 서버를 띄우지 않는다. 상태 줄은 **저장된** 설정 기준이라 폼을 고친 직후엔 "저장하면 적용"을 같이 보인다.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useMessages } from "../../../i18n/ui-language";
import { copyText } from "../../../lib/clipboard";
import { ipc } from "../../../lib/ipc";
import { subHeading } from "./AiSection";
import { Field, Hl, inputCls, type SectionProps } from "./shared";

const newToken = () => crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

export function McpSection({ form, update, hl }: SectionProps) {
  const msg = useMessages();
  const [copied, setCopied] = useState(false);
  // 저장 직후 바뀌는 값이라 짧게 다시 묻는다(로컬 조회 한 번 — 비용 없음). 섹션이 보일 때만 돈다.
  const { data: status } = useQuery({
    queryKey: ["mcp-status"],
    queryFn: () => ipc.mcpStatus(),
    refetchInterval: 2_000,
  });
  const command = `claude mcp add --transport http gitpervisor http://127.0.0.1:${form.mcpPort}/mcp --header "Authorization: Bearer ${form.mcpToken}"`;
  const saved = status?.running ? status.port === form.mcpPort : !form.mcpEnabled;
  const statusText = status?.error
    ? msg.settings.mcp.statusFailed(status.error)
    : status?.running && status.port != null
      ? msg.settings.mcp.statusRunning(status.port)
      : msg.settings.mcp.statusStopped;

  return (
    <>
      <div className={`border-t border-edge pt-3 ${subHeading}`}>{msg.settings.mcp.heading}</div>
      <div className="text-[11px] text-fg-dim">{msg.settings.mcp.intro}</div>
      <Hl id="mcpEnabled" hl={hl}>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.mcpEnabled}
            onChange={(e) => {
              if (e.target.checked && !form.mcpToken) update("mcpToken", newToken());
              update("mcpEnabled", e.target.checked);
            }}
            className="accent-accent"
          />
          <span>{msg.settings.mcp.enabled}</span>
          <span className={`ml-2 text-[11px] ${status?.error ? "text-warn" : "text-fg-dim"}`}>
            {statusText}
            {!saved && ` · ${msg.settings.mcp.unsavedHint}`}
          </span>
        </label>
      </Hl>
      {form.mcpEnabled && (
        <>
          <Hl id="mcpPort" hl={hl}>
            <Field label={msg.settings.mcp.portLabel} hint={msg.settings.mcp.portHint}>
              <input
                type="number"
                min={1024}
                max={65535}
                value={form.mcpPort}
                onChange={(e) => update("mcpPort", Number(e.target.value) || 47820)}
                className={`${inputCls} w-28`}
              />
            </Field>
          </Hl>
          <Hl id="mcpToken" hl={hl}>
            <Field label={msg.settings.mcp.tokenLabel} hint={msg.settings.mcp.regenerateHint}>
              <div className="flex gap-2">
                <input readOnly value={form.mcpToken} className={`${inputCls} font-mono text-[11px]`} />
                <button
                  onClick={() => update("mcpToken", newToken())}
                  className="shrink-0 rounded border border-edge px-2 py-1 text-fg-muted hover:bg-raised hover:text-fg"
                >
                  {msg.settings.mcp.regenerate}
                </button>
              </div>
            </Field>
          </Hl>
          <Field label={msg.settings.mcp.commandLabel}>
            <div className="flex gap-2">
              <input readOnly value={command} className={`${inputCls} font-mono text-[11px]`} />
              <button
                onClick={() =>
                  void copyText(command).then((ok) => {
                    setCopied(ok);
                    if (ok) setTimeout(() => setCopied(false), 1500);
                  })
                }
                className="shrink-0 rounded border border-edge px-2 py-1 text-fg-muted hover:bg-raised hover:text-fg"
              >
                {copied ? msg.settings.mcp.copied : msg.settings.mcp.copy}
              </button>
            </div>
          </Field>
        </>
      )}
    </>
  );
}
