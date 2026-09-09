// 인스펙터 조정 탭의 `스냅 · 가이드` 섹션(시안 ⑦).
//
// 값은 전부 42 스토어에 있다 — 여기 사본을 두면 상태바 토글(`EditorStatusBar`)과 이 섹션이
// **같은 토글의 다른 값**을 보여 준다. 두 곳이 같은 `toggles` 를 뒤집는 것이 의도다.
//
// 마운트는 통합 단계(45 조정 탭)가 한다.
//
// 배경: DOCS/task/43-image-chrome-snap.md §1 ⑦ · §3.8

import { useImageEditorUi, type EditorUiState } from "../../stores/imageEditor";

type Toggles = EditorUiState["toggles"];

/** 시안 ⑦ 체크 6줄 — 순서·문구가 시안 그대로다. */
const ROWS: {
  k: "snapPixel" | "snapObjects" | "snapGuides" | "smartGuides" | "gapBadges" | "rulers";
  label: string;
}[] = [
  { k: "snapPixel", label: "픽셀 그리드에 스냅 (1px)" },
  { k: "snapObjects", label: "오브젝트에 스냅" },
  { k: "snapGuides", label: "가이드에 스냅" },
  { k: "smartGuides", label: "스마트 가이드" },
  { k: "gapBadges", label: "간격 표시" },
  { k: "rulers", label: "눈금자 표시" },
];

const GRID_STEPS: { v: Toggles["grid"]; label: string }[] = [
  { v: 0, label: "끄기" },
  { v: 8, label: "8px" },
  { v: 16, label: "16px" },
];

/** 임계값 범위(css px). 1 미만은 절대 안 붙고, 16 을 넘으면 원하는 곳에 놓을 수 없다. */
const TOL_MIN = 1;
const TOL_MAX = 16;

export function SnapSection() {
  const toggles = useImageEditorUi((s) => s.toggles);
  const setToggle = useImageEditorUi((s) => s.setToggle);
  const tol = useImageEditorUi((s) => s.snapThresholdCss);

  return (
    <section className="mt-2 first:mt-0">
      <div className="mb-1.5 text-[11px] text-fg-dim">스냅 · 가이드</div>

      {ROWS.map((r) => (
        <label
          key={r.k}
          className="flex cursor-pointer items-center gap-2 py-0.5 text-[12px] text-fg-muted hover:text-fg"
        >
          <input
            type="checkbox"
            checked={toggles[r.k]}
            onChange={(e) => setToggle(r.k, e.target.checked)}
            className="accent-accent"
          />
          {r.label}
        </label>
      ))}

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-fg-dim">그리드</span>
        <select
          value={toggles.grid}
          onChange={(e) => setToggle("grid", Number(e.target.value) as Toggles["grid"])}
          className="rounded border border-edge bg-raised px-1.5 py-1 text-[12px] outline-none focus:border-accent"
        >
          {GRID_STEPS.map((g) => (
            <option key={g.v} value={g.v}>
              {g.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] text-fg-dim">임계값</span>
        <input
          type="number"
          min={TOL_MIN}
          max={TOL_MAX}
          value={tol}
          // 스토어에 전용 액션이 없어 `setState` 로 직접 쓴다(저장소 관례 —
          // `SettingsDialog.tsx:119`·`EnvDialog.tsx:43`). 빈 입력·문자는 `Number` 가 NaN 을
          // 주는데 그대로 넣으면 `tol / screen.scale` 이 NaN 이 돼 **스냅이 조용히 전부 꺼진다**.
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isFinite(v)) return;
            useImageEditorUi.setState({
              snapThresholdCss: Math.min(Math.max(Math.round(v), TOL_MIN), TOL_MAX),
            });
          }}
          className="w-16 rounded border border-edge bg-raised px-1.5 py-1 text-center font-mono text-[12px] outline-none focus:border-accent"
        />
      </div>
    </section>
  );
}
