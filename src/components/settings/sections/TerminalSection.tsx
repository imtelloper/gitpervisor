// 터미널 설정 (태스크 18) — 셸·폰트 크기.
import { Field, Hl, inputCls, type SectionProps } from "./shared";

export function TerminalSection({ form, update, hl }: SectionProps) {
  return (
    <>
      <Hl id="terminalShell" hl={hl}>
        <Field label="셸" hint="비우면 자동 탐색 (pwsh → powershell → cmd). 새 터미널부터 적용">
          <input
            type="text"
            value={form.terminalShell ?? ""}
            placeholder="(자동 탐색)"
            onChange={(e) => update("terminalShell", e.target.value)}
            className={`${inputCls} font-mono`}
          />
        </Field>
      </Hl>
      <Hl id="terminalFontSize" hl={hl}>
        <Field label="터미널 폰트 크기" hint="10–24 px · 새 터미널부터 적용">
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
