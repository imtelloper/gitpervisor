// 코드 도구 설정 (태스크 18) — 포매터/린터(ruff·biome) + LSP(언어 서버). 둘 다 작아 한 카테고리에
// 묶고 내부 소제목으로 구분. projects·lspBusy·lspStatus·onDownload는 셸에서 주입.
import type { Project } from "../../../lib/ipc";
import { Field, Hl, inputCls, type SectionProps } from "./shared";

const subHeading = "text-[11px] font-semibold tracking-widest text-fg-dim";

export function CodeToolsSection({
  form,
  update,
  hl,
  projects,
  lspBusy,
  lspStatus,
  onDownload,
}: SectionProps & {
  projects: Project[] | undefined;
  lspBusy: boolean;
  lspStatus: string;
  onDownload: () => void;
}) {
  return (
    <>
      <div className={subHeading}>포매터 / 린터</div>
      <Hl id="formatterRuffPath" hl={hl}>
        <Field label="ruff 경로 (Python)" hint="비우면 PATH에서 자동 탐색">
          <input
            type="text"
            value={form.formatterRuffPath ?? ""}
            placeholder="(자동 탐색)"
            onChange={(e) => update("formatterRuffPath", e.target.value)}
            className={`${inputCls} font-mono`}
          />
        </Field>
      </Hl>
      <Hl id="formatterBiomePath" hl={hl}>
        <Field label="biome 경로 (웹: ts/js/json/css)" hint="비우면 PATH에서 자동 탐색">
          <input
            type="text"
            value={form.formatterBiomePath ?? ""}
            placeholder="(자동 탐색)"
            onChange={(e) => update("formatterBiomePath", e.target.value)}
            className={`${inputCls} font-mono`}
          />
        </Field>
      </Hl>
      <Hl id="formatOnSave" hl={hl}>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={form.formatOnSave}
            onChange={(e) => update("formatOnSave", e.target.checked)}
            className="accent-accent"
          />
          <span>저장 시 자동 포맷 (Ctrl+S)</span>
        </label>
      </Hl>
      <Hl id="formatterProjectLocal" hl={hl}>
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={form.formatterProjectLocal}
            onChange={(e) => update("formatterProjectLocal", e.target.checked)}
            className="mt-0.5 accent-accent"
          />
          <span>
            프로젝트 로컬 바이너리 허용 (node_modules/.bin · .venv)
            <span className="mt-0.5 block text-[11px] text-danger">
              ⚠ 레포가 심은 실행 파일을 돌립니다 — 신뢰하는 프로젝트에서만. 린트는 파일
              열람만으로도 자동 실행됩니다.
            </span>
          </span>
        </label>
      </Hl>

      <div className={`border-t border-edge pt-3 ${subHeading}`}>LSP (타입 인지 · 실험적)</div>
      <div className="text-[11px] text-fg-dim">
        켠 프로젝트만 언어 서버(파이썬=basedpyright · TS/JS=typescript-language-server · C/C++=clangd ·
        Rust=rust-analyzer · Lua=lua-language-server · Go=gopls)를 기동해 타입 인지 자동완성·정의·참조·
        시그니처·진단을 제공합니다. 끄면 기존 휴리스틱으로 동작.
      </div>
      <Hl id="lspDownload" hl={hl}>
        <div className="flex items-center gap-2">
          <button
            onClick={onDownload}
            disabled={lspBusy}
            className="shrink-0 rounded bg-accent/20 px-2 py-1 text-xs text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {lspBusy ? "다운로드 중…" : "언어 서버 다운로드"}
          </button>
          <span className="truncate text-[11px] text-fg-dim">
            {lspStatus || "basedpyright~6 + TS~25 + clangd~27 + rust-analyzer~17 + lua~4MB · go는 PATH"}
          </span>
        </div>
      </Hl>
      <Hl id="lspEnabledProjects" hl={hl}>
        <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {(projects ?? []).map((p) => {
            const on = (form.lspEnabledProjects ?? []).includes(p.id);
            return (
              <label key={p.id} className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => {
                    const cur = form.lspEnabledProjects ?? [];
                    update(
                      "lspEnabledProjects",
                      e.target.checked ? [...cur, p.id] : cur.filter((id) => id !== p.id),
                    );
                  }}
                  className="accent-accent"
                />
                <span className="truncate">{p.name}</span>
              </label>
            );
          })}
        </div>
      </Hl>
      <Hl id="lspWorkspaceTsserver" hl={hl}>
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={form.lspWorkspaceTsserver}
            onChange={(e) => update("lspWorkspaceTsserver", e.target.checked)}
            className="mt-0.5 accent-accent"
          />
          <span>
            워크스페이스 TypeScript 사용 (node_modules/typescript)
            <span className="mt-0.5 block text-[11px] text-danger">
              ⚠ 레포가 심은 tsserver를 실행합니다 — 신뢰하는 프로젝트에서만. 끄면 번들 TS 사용.
            </span>
          </span>
        </label>
      </Hl>
    </>
  );
}
