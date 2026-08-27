// 코드 도구 설정 (태스크 18) — 포매터/린터(ruff·biome) + LSP(언어 서버) + 동영상 도구(ffmpeg).
// 전부 작아 한 카테고리에 묶고 내부 소제목으로 구분. busy/status/onDownload류는 셸에서 주입.
import type { Project } from "../../../lib/ipc";
import { useVideoToolStatus } from "../../../queries";
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
  ffmpegBusy,
  ffmpegStatus,
  onFfmpegDownload,
}: SectionProps & {
  projects: Project[] | undefined;
  lspBusy: boolean;
  lspStatus: string;
  onDownload: () => void;
  ffmpegBusy: boolean;
  ffmpegStatus: string;
  onFfmpegDownload: () => void;
}) {
  // 발견 상태 표시용 — 다운로드 흐름(busy/status)은 셸이 소유한다(LSP와 동일 분업).
  const ffTool = useVideoToolStatus();
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
        켠 프로젝트만 언어 서버를 기동해 타입 인지 자동완성·정의·참조·시그니처·진단을 제공합니다.
        앱 내 다운로드: 파이썬(basedpyright)·TS/JS(typescript-language-server)·PHP(intelephense)·
        C/C++(clangd)·Rust(rust-analyzer)·Lua(lua-language-server)·Zig(zls). PATH 발견(툴체인 설치본):
        Go(gopls)·Ruby(ruby-lsp)·C#(csharp-ls)·Java(jdtls). 끄면 기존 휴리스틱으로 동작.
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

      <div className={`border-t border-edge pt-3 ${subHeading}`}>동영상 도구 (ffmpeg)</div>
      <div className="text-[11px] text-fg-dim">
        동영상 뷰어의 편집·내보내기(클립 추출·배속·화질·영역·GIF·프레임 캡처)에 씁니다. 발견
        순서: 명시 경로 → PATH → 앱 내 다운로드 설치본.
      </div>
      <Hl id="videoFfmpegPath" hl={hl}>
        <Field label="ffmpeg 경로" hint="비우면 자동 발견. ffprobe가 같은 폴더에 있어야 합니다">
          <input
            type="text"
            value={form.videoFfmpegPath ?? ""}
            placeholder="(자동 발견)"
            onChange={(e) => update("videoFfmpegPath", e.target.value)}
            className={`${inputCls} font-mono`}
          />
        </Field>
      </Hl>
      <Hl id="ffmpegDownload" hl={hl}>
        <div className="flex items-center gap-2">
          <button
            onClick={onFfmpegDownload}
            disabled={ffmpegBusy || !!ffTool.data?.found}
            className="shrink-0 rounded bg-accent/20 px-2 py-1 text-xs text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {ffmpegBusy ? "다운로드 중…" : "ffmpeg 다운로드"}
          </button>
          <span className="truncate text-[11px] text-fg-dim">
            {ffmpegStatus ||
              (ffTool.data?.found
                ? `발견됨 ✓ ${ffTool.data.version ?? ""} (${
                    { explicit: "명시 경로", path: "PATH", managed: "앱 설치본" }[
                      ffTool.data.source ?? ""
                    ] ?? ffTool.data.source
                  })${ffTool.data.probeFound ? "" : " — ⚠ ffprobe 없음"}`
                : ffTool.data?.managedSupported
                  ? "미발견 — 약 40~110MB 다운로드"
                  : "미발견 — 이 플랫폼은 패키지 관리자로 설치하세요 (brew/apt)")}
          </span>
        </div>
      </Hl>
    </>
  );
}
