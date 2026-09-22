// AI › 음성 인식(자막) 소제목(태스크 72 §3.5) — 엔진 행 · 모델 표 · 기본 언어. 새 카테고리를 만들지 않는다.
//
// 다운로드 busy·status는 AiSection과 같이 **셸(SettingsDialog)이 소유**한다 — 547MB를 받는 중에 카테고리를
// 옮겨도 진행 표시가 살아 있어야 한다. 취소는 기존 `llm_download_cancel`을 이름(stt-runtime·stt-model-<id>)으로.
import { useQuery } from "@tanstack/react-query";

import { useMessages } from "../../../i18n/ui-language";
import { ipc } from "../../../lib/ipc";
import { STT_LANGUAGES, useSttStatus } from "../../../lib/stt";
import { mb, recommend, subHeading } from "./AiSection";
import { Field, Hl, inputCls, type SectionProps } from "./shared";

export function SttSection({
  form,
  update,
  hl,
  runtimeBusy,
  runtimeStatus,
  onRuntimeDownload,
  modelBusy,
  modelStatus,
  onModelDownload,
  onModelDelete,
  onCancel,
}: SectionProps & {
  runtimeBusy: boolean;
  runtimeStatus: string;
  onRuntimeDownload: () => void;
  /** 다운로드 중인 모델 id(없으면 null). */
  modelBusy: string | null;
  modelStatus: string;
  onModelDownload: (id: string) => void;
  onModelDelete: (id: string, label: string) => void;
  onCancel: (name: string) => void;
}) {
  const { data: st } = useSttStatus();
  const msg = useMessages();
  // AiSection·리소스 모니터와 같은 캐시 키(수집이 수 초라 두 번 돌리지 않는다).
  const { data: sys } = useQuery({
    queryKey: ["sys-info"],
    queryFn: () => ipc.sysInfoStatic(false),
    staleTime: Infinity,
    retry: false,
  });
  const runtime = st?.runtime;
  const found = runtime?.state === "found";
  const ready = found && !!st?.vadInstalled;
  const unsupported = runtime?.state === "unsupported";

  return (
    <>
      <div className={`border-t border-edge pt-3 ${subHeading}`}>{msg.settings.stt.heading}</div>
      <div className="text-[11px] text-fg-dim">{msg.settings.stt.intro}</div>

      <Hl id="sttRuntimeDownload" hl={hl}>
        <div className="flex items-center gap-2">
          <button
            onClick={runtimeBusy ? () => onCancel("stt-runtime") : onRuntimeDownload}
            // 엔진이 없는 mac은 VAD만 받아 봐야 끝에 설치 안내 오류로 끝난다 — brew 설치 뒤에 열린다.
            disabled={!st || (!runtimeBusy && (ready || (unsupported && !found)))}
            className="shrink-0 rounded bg-accent/20 px-2 py-1 text-xs text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {runtimeBusy
              ? msg.settings.ai.cancel
              : found
                ? msg.settings.stt.vadDownload
                : msg.settings.stt.engineDownload(mb(st?.runtimeSize ?? 0))}
          </button>
          <span className="truncate text-[11px] text-fg-dim" title={found ? runtime.path : undefined}>
            {runtimeStatus ||
              (found
                ? msg.settings.stt.engineFound(
                    !!st?.vadInstalled,
                    runtime.path,
                    msg.settings.stt.sourceLabel[runtime.source],
                  )
                : unsupported
                  ? msg.settings.stt.unsupported
                  : "whisper.cpp b5130 + Silero VAD · github.com/ggml-org/whisper.cpp")}
          </span>
        </div>
      </Hl>

      <Hl id="sttModel" hl={hl}>
        <div className="flex flex-col gap-1">
          {(st?.models ?? []).map((m) => {
            // 음성 인식은 CPU만 쓴다(P1) — VRAM을 0으로 넘겨 "GPU 전체"가 뜨지 않게 한다.
            const rec = sys ? recommend(m.size, sys.memory.totalBytes, 0) : null;
            const busy = modelBusy === m.id;
            return (
              <label key={m.id} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-raised">
                <input
                  type="radio"
                  name="stt-model"
                  checked={form.sttModel === m.id}
                  onChange={() => update("sttModel", m.id)}
                  className="accent-accent"
                />
                <span className="min-w-0 flex-1 truncate" title="huggingface.co/ggerganov/whisper.cpp">
                  {m.label}
                  <span className="ml-1 text-[11px] text-fg-dim">{m.note}</span>
                </span>
                <span className="shrink-0 text-[11px] text-fg-muted">{mb(m.size)}</span>
                {rec && (
                  <span className={`shrink-0 text-[11px] ${rec.tone}`}>
                    {msg.settings.ai.recommend[rec.level]}
                  </span>
                )}
                {m.installed ? (
                  <button
                    onClick={() => onModelDelete(m.id, m.label)}
                    className="shrink-0 rounded px-2 py-0.5 text-[11px] text-danger hover:bg-danger/15"
                  >
                    {msg.settings.ai.delete}
                  </button>
                ) : (
                  <button
                    onClick={() => (busy ? onCancel(`stt-model-${m.id}`) : onModelDownload(m.id))}
                    disabled={modelBusy != null && !busy}
                    className="shrink-0 rounded bg-accent/20 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/30 disabled:opacity-50"
                  >
                    {busy ? msg.settings.ai.cancel : msg.settings.ai.download}
                  </button>
                )}
              </label>
            );
          })}
        </div>
      </Hl>
      <div className="text-[11px] text-fg-dim">
        {modelStatus || msg.settings.stt.modelDownloadNote}
      </div>

      <Hl id="sttLanguage" hl={hl}>
        <Field label={msg.settings.stt.languageLabel} hint={msg.settings.stt.languageHint}>
          <select
            value={form.sttLanguage}
            onChange={(e) => update("sttLanguage", e.target.value)}
            className={inputCls}
          >
            {STT_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </Field>
      </Hl>
    </>
  );
}
