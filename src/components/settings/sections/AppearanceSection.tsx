// 모양 설정 (태스크 18) — 테마 그리드(라이브 프리뷰)·Diff 폰트. previewTheme는 셸 소유(테마 복원 결합).
import type { ThemeName } from "../../../lib/ipc";
import { THEMES } from "../../../lib/themes";
import { Field, Hl, inputCls, type SectionProps } from "./shared";

export function AppearanceSection({
  form,
  update,
  hl,
  previewTheme,
}: SectionProps & { previewTheme: (id: ThemeName) => void }) {
  return (
    <>
      <Hl id="theme" hl={hl}>
        <Field label="테마" hint="클릭 즉시 미리보기 — 저장하지 않고 닫으면 원래 테마로 돌아갑니다">
          <div className="grid grid-cols-2 gap-2">
            {THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => previewTheme(t.id)}
                className={`flex items-center gap-2 rounded border px-2.5 py-1.5 text-left ${
                  form.theme === t.id
                    ? "border-accent bg-accent/15 text-fg"
                    : "border-edge text-fg-muted hover:bg-raised"
                }`}
              >
                <span
                  className="flex h-5 w-9 shrink-0 items-center justify-center gap-[3px] rounded border border-edge"
                  style={{ backgroundColor: t.swatch[0] }}
                >
                  {t.swatch.slice(1).map((c, i) => (
                    <span
                      key={i}
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </span>
                <span className="truncate">{t.label}</span>
              </button>
            ))}
          </div>
        </Field>
      </Hl>

      <Hl id="diffFontSize" hl={hl}>
        <Field label="Diff 폰트 크기" hint="10–24 px">
          <input
            type="number"
            min={10}
            max={24}
            value={form.diffFontSize}
            onChange={(e) => update("diffFontSize", Number(e.target.value))}
            className={inputCls}
          />
        </Field>
      </Hl>
    </>
  );
}
