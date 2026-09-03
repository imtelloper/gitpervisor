// 사용자 정의 테마 편집기 (태스크 29) — 모양 섹션 안 **인라인 패널**이다(새 모달이 아님:
// SettingsDialog의 Esc 계층·단일 저장 모델을 건드리지 않는다).
// 편집 중 미리보기는 저장된 정의(<style id="gp-custom-themes">)를 덮는 별도 <style>을 심어
// 처리한다 — 저장하지 않고 취소하면 이 요소만 지우면 원상태다(스토어를 더럽히지 않는다).
import { useEffect, useMemo, useState } from "react";

import { refreshTerminalThemes } from "../../../lib/terminal";
import { BUILTIN_TOKENS, contrastRatio, customThemeCss, normalizeHex } from "../../../lib/theme-apply";
import {
  THEMES,
  THEME_TOKENS,
  type CustomTheme,
  type ThemeName,
  type ThemeToken,
} from "../../../lib/themes";
import { inputCls } from "./shared";

const PREVIEW_STYLE_ID = "gp-custom-theme-preview";

const TOKEN_LABEL: Record<ThemeToken, string> = {
  base: "바탕",
  panel: "패널",
  raised: "떠 있는 면",
  selection: "선택",
  edge: "경계선",
  accent: "강조",
  "accent-hover": "강조 hover",
  "on-accent": "강조 위 텍스트",
  fg: "본문",
  "fg-muted": "보조",
  "fg-dim": "흐림",
  ok: "정상",
  warn: "주의",
  danger: "위험",
  mod: "수정",
  add: "추가",
  del: "삭제",
  untrk: "미추적",
};

const GROUPS: { label: string; tokens: readonly ThemeToken[] }[] = [
  { label: "배경", tokens: ["base", "panel", "raised", "selection", "edge"] },
  { label: "텍스트", tokens: ["fg", "fg-muted", "fg-dim"] },
  { label: "강조", tokens: ["accent", "accent-hover", "on-accent"] },
  { label: "상태", tokens: ["ok", "warn", "danger"] },
  { label: "파일 변경", tokens: ["mod", "add", "del", "untrk"] },
];

// 대비 힌트 — 읽기가 실제로 걸리는 3쌍만(WCAG AA 본문 기준 4.5:1).
const HINTS: { label: string; fg: ThemeToken; bg: ThemeToken }[] = [
  { label: "본문 / 바탕", fg: "fg", bg: "base" },
  { label: "보조 / 바탕", fg: "fg-muted", bg: "base" },
  { label: "강조 위 텍스트 / 강조", fg: "on-accent", bg: "accent" },
];

export function CustomThemeEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: CustomTheme;
  onSave: (t: CustomTheme) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [base, setBase] = useState<ThemeName>(initial.base);
  // 편집 중인 hex는 **문자열 그대로** 들고 있는다(타이핑 중간값 허용) — 유효한 값만 색으로 승격.
  const [text, setText] = useState<Record<ThemeToken, string>>(() => ({ ...initial.colors }));

  const colors = useMemo(() => {
    const out = {} as Record<ThemeToken, string>;
    for (const k of THEME_TOKENS) out[k] = normalizeHex(text[k]) ?? BUILTIN_TOKENS[base][k];
    return out;
  }, [text, base]);
  const bad = THEME_TOKENS.filter((k) => normalizeHex(text[k]) == null);

  // 즉시 미리보기 — 색 드래그마다 <style> 재생성 + xterm 전체 갱신은 부담이라 150ms 디바운스.
  useEffect(() => {
    const timer = setTimeout(() => {
      let el = document.getElementById(PREVIEW_STYLE_ID);
      if (!el) {
        el = document.createElement("style");
        el.id = PREVIEW_STYLE_ID;
        // gp-custom-themes 뒤에 붙는다 — 같은 셀렉터라 나중 규칙이 이긴다(편집 중 정의 우선).
        document.head.appendChild(el);
      }
      el.textContent = customThemeCss({ ...initial, name, base, colors });
      document.documentElement.dataset.theme = initial.id;
      refreshTerminalThemes();
    }, 150);
    return () => clearTimeout(timer);
  }, [initial, name, base, colors]);

  // 편집 종료(저장·취소·섹션 이탈) — 미리보기 요소를 지운다. 테마 복원은 호출자(previewTheme).
  useEffect(
    () => () => {
      document.getElementById(PREVIEW_STYLE_ID)?.remove();
      refreshTerminalThemes();
    },
    [],
  );

  const setToken = (k: ThemeToken, v: string) => setText((t) => ({ ...t, [k]: v }));
  const canSave = name.trim().length > 0 && bad.length === 0;

  return (
    <div className="space-y-3 rounded border border-edge bg-base p-3">
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="테마 이름"
          className={`${inputCls} flex-1`}
        />
        <select
          value={base}
          onChange={(e) => {
            const next = e.target.value as ThemeName;
            setBase(next);
            setText({ ...BUILTIN_TOKENS[next] });
          }}
          className={`${inputCls} w-[180px]`}
        >
          {THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              기반: {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="text-[11px] text-fg-dim">
        기반 테마에서 에디터 문법색·터미널 ANSI 색을 물려받습니다. 기반을 바꾸면 아래 색이 그
        테마의 값으로 초기화됩니다.
      </div>

      {GROUPS.map((g) => (
        <div key={g.label}>
          <div className="mb-1 text-[11px] font-medium text-fg-muted">{g.label}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {g.tokens.map((k) => {
              const invalid = normalizeHex(text[k]) == null;
              return (
                <label key={k} className="flex items-center gap-2">
                  <span className="w-[92px] shrink-0 truncate text-fg-muted">
                    {TOKEN_LABEL[k]}
                  </span>
                  <input
                    type="color"
                    value={colors[k]}
                    onChange={(e) => setToken(k, e.target.value)}
                    className="h-6 w-8 shrink-0 cursor-pointer rounded border border-edge bg-transparent"
                  />
                  <input
                    value={text[k]}
                    onChange={(e) => setToken(k, e.target.value)}
                    spellCheck={false}
                    className={`${inputCls} font-mono ${invalid ? "border-danger" : ""}`}
                  />
                </label>
              );
            })}
          </div>
        </div>
      ))}

      <div>
        <div className="mb-1 text-[11px] font-medium text-fg-muted">
          대비 (WCAG AA 본문 4.5:1)
        </div>
        <div className="space-y-1">
          {HINTS.map((h) => {
            const ratio = contrastRatio(colors[h.fg], colors[h.bg]);
            const aa = ratio >= 4.5;
            return (
              <div key={h.label} className="flex items-center gap-2 text-[12px]">
                <span
                  className="flex h-5 w-16 shrink-0 items-center justify-center rounded border border-edge text-[11px]"
                  style={{ backgroundColor: colors[h.bg], color: colors[h.fg] }}
                >
                  Aa 가나
                </span>
                <span className="min-w-0 flex-1 truncate text-fg-muted">{h.label}</span>
                <span className="tabular-nums text-fg-dim">{ratio.toFixed(2)}:1</span>
                <span
                  className={`rounded px-1.5 text-[10px] ${
                    aa ? "bg-ok/20 text-ok" : "bg-warn/20 text-warn"
                  }`}
                >
                  {aa ? "AA" : "낮음"}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {bad.length > 0 && (
          <span className="text-[11px] text-danger">
            색 형식 오류: {bad.map((k) => TOKEN_LABEL[k]).join(", ")}
          </span>
        )}
        <div className="flex-1" />
        <button onClick={onCancel} className="rounded px-3 py-1 text-fg-muted hover:bg-raised">
          취소
        </button>
        <button
          disabled={!canSave}
          onClick={() => onSave({ ...initial, name: name.trim(), base, colors, updatedAt: Date.now() })}
          className="rounded bg-accent px-3 py-1 font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          저장
        </button>
      </div>
    </div>
  );
}
