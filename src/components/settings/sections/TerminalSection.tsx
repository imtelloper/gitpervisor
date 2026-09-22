// 터미널 설정 (태스크 18) — 셸·폰트 크기.
import { useMessages } from "../../../i18n/ui-language";
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
