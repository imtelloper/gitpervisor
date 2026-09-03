// 모양 설정 (태스크 18) — 테마 그리드(라이브 프리뷰)·내 테마(태스크 29)·Diff 폰트.
// previewTheme는 셸 소유(테마 복원 결합).
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ThemeId } from "../../../lib/ipc";
import { BUILTIN_TOKENS } from "../../../lib/theme-apply";
import { customThemeOf, isCustomThemeId, THEMES, type CustomTheme } from "../../../lib/themes";
import { useCustomThemes } from "../../../stores/customThemes";
import { useUi } from "../../../stores/ui";
import { CustomThemeEditor } from "./CustomThemeEditor";
import { Field, Hl, inputCls, type SectionProps } from "./shared";

/** 스와치 [배경, 강조, 추가, 위험] — 내장 THEMES.swatch와 같은 모양. */
function Swatch({ colors }: { colors: [string, string, string, string] }) {
  return (
    <span
      className="flex h-5 w-9 shrink-0 items-center justify-center gap-[3px] rounded border border-edge"
      style={{ backgroundColor: colors[0] }}
    >
      {colors.slice(1).map((c, i) => (
        <span key={i} className="h-2 w-2 rounded-full" style={{ backgroundColor: c }} />
      ))}
    </span>
  );
}

export function AppearanceSection({
  form,
  update,
  hl,
  previewTheme,
}: SectionProps & { previewTheme: (id: ThemeId) => void }) {
  const customThemes = useCustomThemes((s) => s.themes);
  const upsert = useCustomThemes((s) => s.upsert);
  const remove = useCustomThemes((s) => s.remove);
  // 편집 중인 초안 + 편집 시작 시점의 테마(취소 시 되돌릴 값). 초안은 참조가 안정해야
  // 편집기의 디바운스 미리보기가 매 렌더 재시작하지 않는다.
  const [editing, setEditing] = useState<{ draft: CustomTheme; prevTheme: ThemeId } | null>(null);

  // 편집 중 이 섹션이 사라지면(설정 카테고리 전환·검색 필터) 편집기가 <html data-theme>에 심어 둔
  // draft id가 남는다 — 정의가 없는 id라 앱 전체가 기본(darcula) 색으로 떨어진다. 편집 시작 시점의
  // 테마로 되돌린다. 저장·취소는 editing을 먼저 비우고, 다이얼로그 닫기는 closeWithoutSave가 이미
  // 저장값을 넣으므로 "정의 없는 커스텀 id"라는 조건에 둘 다 걸리지 않는다.
  const abandon = useRef<(() => void) | null>(null);
  abandon.current = editing ? () => previewTheme(editing.prevTheme) : null;
  useEffect(
    () => () => {
      const cur = document.documentElement.dataset.theme;
      if (isCustomThemeId(cur) && !customThemeOf(cur)) abandon.current?.();
    },
    [],
  );

  const startNew = () => {
    const base = isCustomThemeId(form.theme) ? "darcula" : form.theme;
    setEditing({
      draft: {
        id: `custom-${crypto.randomUUID().slice(0, 8)}`,
        name: "새 테마",
        base,
        colors: { ...BUILTIN_TOKENS[base] },
        updatedAt: Date.now(),
      },
      prevTheme: form.theme,
    });
  };

  const confirmRemove = (t: CustomTheme) =>
    useUi.getState().askConfirm({
      title: "테마 삭제",
      message: `"${t.name}" 테마를 삭제합니다. 되돌릴 수 없습니다.`,
      confirmLabel: "삭제",
      danger: true,
      onConfirm: () => {
        remove(t.id);
        // 선택 중이던 테마면 기반으로 — 정의가 사라진 id를 그대로 두면 기본 테마로 폴백된다.
        if (form.theme === t.id) previewTheme(t.base);
      },
    });

  // 정의를 못 찾는 커스텀 id(다른 identifier의 설정을 복사해 온 경우 등) — 조용히 죽지 않게 표시.
  const orphan = isCustomThemeId(form.theme) && !customThemes.some((t) => t.id === form.theme);

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
                <Swatch colors={t.swatch} />
                <span className="truncate">{t.label}</span>
              </button>
            ))}
          </div>
        </Field>

        <div className="mt-3">
          <div className="mb-1 font-medium">내 테마</div>
          {orphan && (
            <div className="mb-1.5 text-[11px] text-warn">
              선택된 테마({form.theme})의 정의를 찾을 수 없어 기본 테마로 표시 중입니다.
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            {customThemes.map((t) => (
              <div
                key={t.id}
                className={`flex items-center gap-2 rounded border px-2.5 py-1.5 ${
                  form.theme === t.id
                    ? "border-accent bg-accent/15 text-fg"
                    : "border-edge text-fg-muted"
                }`}
              >
                <button
                  onClick={() => previewTheme(t.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-fg"
                >
                  <Swatch
                    colors={[t.colors.base, t.colors.accent, t.colors.add, t.colors.danger]}
                  />
                  <span className="truncate">{t.name}</span>
                </button>
                <button
                  title="편집"
                  onClick={() => setEditing({ draft: t, prevTheme: form.theme })}
                  className="shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
                >
                  <Pencil size={13} />
                </button>
                <button
                  title="삭제"
                  onClick={() => confirmRemove(t)}
                  className="shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-danger"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {!editing && (
              <button
                onClick={startNew}
                className="flex items-center gap-1.5 rounded border border-dashed border-edge px-2.5 py-1.5 text-fg-muted hover:bg-raised hover:text-fg"
              >
                <Plus size={13} />새 테마 만들기
              </button>
            )}
          </div>
          {editing && (
            <div className="mt-2">
              <CustomThemeEditor
                initial={editing.draft}
                onSave={(t) => {
                  upsert(t);
                  setEditing(null);
                  previewTheme(t.id);
                }}
                onCancel={() => {
                  const prev = editing.prevTheme;
                  setEditing(null);
                  previewTheme(prev);
                }}
              />
            </div>
          )}
        </div>
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
