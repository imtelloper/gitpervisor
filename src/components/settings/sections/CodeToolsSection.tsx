// 코드 도구 설정 (태스크 18) — 포매터/린터(ruff·biome) + LSP(언어 서버) + 동영상 도구(ffmpeg).
// 전부 작아 한 카테고리에 묶고 내부 소제목으로 구분. busy/status/onDownload류는 셸에서 주입.
import type { Messages } from "../../../i18n/messages";
import { useMessages } from "../../../i18n/ui-language";
import type { Project } from "../../../lib/ipc";
import { useVideoToolStatus } from "../../../queries";
import { Field, Hl, inputCls, type SectionProps } from "./shared";

const subHeading = "text-[11px] font-semibold tracking-widest text-fg-dim";

/** ffmpeg 발견 경로 표기. 모르는 값은 그대로 보여 준다. */
function ffmpegSourceLabel(msg: Messages, source: string | null): string | null {
  switch (source) {
    case "explicit":
      return msg.settings.codeTools.ffmpegSourceExplicit;
    case "path":
      return "PATH";
    case "managed":
      return msg.settings.codeTools.ffmpegSourceManaged;
    default:
      return source;
  }
}

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
  const msg = useMessages();
  // 발견 상태 표시용 — 다운로드 흐름(busy/status)은 셸이 소유한다(LSP와 동일 분업).
  const ffTool = useVideoToolStatus();
  return (
    <>
      <div className={subHeading}>{msg.settings.codeTools.formatterHeading}</div>
      <Hl id="formatterRuffPath" hl={hl}>
        <Field label={msg.settings.codeTools.ruffPathLabel} hint={msg.settings.emptyUsesPathHint}>
          <input
            type="text"
            value={form.formatterRuffPath ?? ""}
            placeholder={msg.settings.autoDetectPlaceholder}
            onChange={(e) => update("formatterRuffPath", e.target.value)}
            className={`${inputCls} font-mono`}
          />
        </Field>
      </Hl>
      <Hl id="formatterBiomePath" hl={hl}>
        <Field label={msg.settings.codeTools.biomePathLabel} hint={msg.settings.emptyUsesPathHint}>
          <input
            type="text"
            value={form.formatterBiomePath ?? ""}
            placeholder={msg.settings.autoDetectPlaceholder}
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
          <span>{msg.settings.codeTools.formatOnSave}</span>
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
            {msg.settings.codeTools.projectLocalBinaries}
            <span className="mt-0.5 block text-[11px] text-danger">
              {msg.settings.codeTools.projectLocalWarning}
            </span>
          </span>
        </label>
      </Hl>

      <div className={`border-t border-edge pt-3 ${subHeading}`}>
        {msg.settings.codeTools.lspHeading}
      </div>
      <div className="text-[11px] text-fg-dim">{msg.settings.codeTools.lspIntro}</div>
      <Hl id="lspDownload" hl={hl}>
        <div className="flex items-center gap-2">
          <button
            onClick={onDownload}
            disabled={lspBusy}
            className="shrink-0 rounded bg-accent/20 px-2 py-1 text-xs text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {lspBusy ? msg.settings.codeTools.downloading : msg.settings.codeTools.lspDownload}
          </button>
          <span className="truncate text-[11px] text-fg-dim">
            {lspStatus || msg.settings.codeTools.lspDefaultStatus}
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
            {msg.settings.codeTools.workspaceTypescript}
            <span className="mt-0.5 block text-[11px] text-danger">
              {msg.settings.codeTools.workspaceTypescriptWarning}
            </span>
          </span>
        </label>
      </Hl>

      <div className={`border-t border-edge pt-3 ${subHeading}`}>
        {msg.settings.codeTools.videoHeading}
      </div>
      <div className="text-[11px] text-fg-dim">{msg.settings.codeTools.videoIntro}</div>
      <Hl id="videoFfmpegPath" hl={hl}>
        <Field
          label={msg.settings.codeTools.ffmpegPathLabel}
          hint={msg.settings.codeTools.ffmpegPathHint}
        >
          <input
            type="text"
            value={form.videoFfmpegPath ?? ""}
            placeholder={msg.settings.codeTools.ffmpegPathPlaceholder}
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
            {ffmpegBusy ? msg.settings.codeTools.downloading : msg.settings.codeTools.ffmpegDownload}
          </button>
          <span className="truncate text-[11px] text-fg-dim">
            {ffmpegStatus ||
              (ffTool.data?.found
                ? msg.settings.codeTools.ffmpegFound(
                    ffTool.data.version ?? "",
                    ffmpegSourceLabel(msg, ffTool.data.source),
                    ffTool.data.probeFound,
                  )
                : ffTool.data?.managedSupported
                  ? msg.settings.codeTools.ffmpegMissingManaged
                  : msg.settings.codeTools.ffmpegMissingUnsupported)}
          </span>
        </div>
      </Hl>
    </>
  );
}
