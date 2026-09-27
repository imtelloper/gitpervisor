// 터미널 설정 (태스크 18) — 셸·폰트 크기·새 터미널 시작 에이전트.
import { useMessages } from "../../../i18n/ui-language";
import type { Settings } from "../../../lib/ipc";
import { Field, Hl, inputCls, type SectionProps } from "./shared";

export function TerminalSection({ form, update, hl }: SectionProps) {
  const msg = useMessages();
  return (
    <>
      <Hl id="terminalShell" hl={hl}>
        <Field label={msg.settings.terminal.shellLabel} hint={msg.settings.terminal.shellHint}>
          <input
            type="text"
            value={form.terminalShell ?? ""}
            placeholder={msg.settings.autoDetectPlaceholder}
            onChange={(e) => update("terminalShell", e.target.value)}
            className={`${inputCls} font-mono`}
          />
        </Field>
      </Hl>
      <Hl id="terminalStartAgent" hl={hl}>
        <Field
          label={msg.settings.terminal.startAgentLabel}
          hint={msg.settings.terminal.startAgentHint}
        >
          <select
            value={form.terminalStartAgent || ""}
            onChange={(e) =>
              update("terminalStartAgent", e.target.value as Settings["terminalStartAgent"])
            }
            className={inputCls}
          >
            <option value="">{msg.settings.terminal.startAgentShell}</option>
            <option value="claude">{msg.settings.terminal.startAgentClaude}</option>
            <option value="opencode">{msg.settings.terminal.startAgentOpenCode}</option>
          </select>
        </Field>
      </Hl>
      <Hl id="opencodeModel" hl={hl}>
        <Field label={msg.settings.terminal.opencodeModelLabel} hint={msg.settings.terminal.opencodeModelHint}>
          <select
            value={form.opencodeModel === "local" ? "local" : "free"}
            onChange={(e) => update("opencodeModel", e.target.value as Settings["opencodeModel"])}
            className={inputCls}
          >
            <option value="free">{msg.settings.terminal.opencodeModelFree}</option>
            <option value="local">{msg.settings.terminal.opencodeModelLocal}</option>
          </select>
        </Field>
      </Hl>
      <Hl id="terminalFontSize" hl={hl}>
        <Field
          label={msg.settings.terminal.fontSizeLabel}
          hint={msg.settings.terminal.fontSizeHint}
        >
          <input
            type="number"
            min={10}
            max={24}
            value={form.terminalFontSize}
            onChange={(e) => update("terminalFontSize", Number(e.target.value))}
            className={inputCls}
          />
        </Field>
      </Hl>
    </>
  );
}
