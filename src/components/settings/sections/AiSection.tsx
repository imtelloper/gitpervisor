// AI(로컬 LLM) 설정 (태스크 59 §3.6) — 상태 카드 · 런타임 다운로드 · 모델 표 · 테스트 · 고급.
//
// 다운로드/테스트의 busy·status는 **셸(SettingsDialog)이 소유**한다. 그래야 2.5GB를 받는 중에
// 카테고리를 옮겨도 진행 표시가 살아 있다(ffmpeg `ffmpegBusy/Status`와 같은 층, §3.6 I1).
import { useQuery } from "@tanstack/react-query";

import { useMessages } from "../../../i18n/ui-language";
import { ipc } from "../../../lib/ipc";
import { useLlmStatus } from "../../../lib/llm";
import { Field, Hl, inputCls, type SectionProps } from "./shared";

export const subHeading = "text-[11px] font-semibold tracking-widest text-fg-dim";

export function mb(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${Math.round(bytes / 1024 ** 2)}MB`;
}

/**
 * 이 머신에서 돌릴 만한가(§3.5). vram ≥ size*1.15면 전체 GPU 오프로드, 아니면
 * ram ≥ size*1.3 + 1GB면 CPU/부분, 둘 다 미달이면 권장하지 않음.
 * **다운로드 버튼은 어느 쪽이든 살려 둔다** — 사용자가 자기 머신을 더 잘 안다.
 */
export function recommend(
  size: number,
  ram: number,
  vram: number,
): { level: "gpu" | "cpu" | "no"; tone: string } {
  if (vram >= size * 1.15) return { level: "gpu", tone: "text-ok" };
  if (ram >= size * 1.3 + 1024 ** 3) return { level: "cpu", tone: "text-fg-muted" };
  return { level: "no", tone: "text-warn" };
}

export function AiSection({
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
  testBusy,
  testOutput,
  onTest,
}: SectionProps & {
  runtimeBusy: boolean;
  runtimeStatus: string;
  onRuntimeDownload: () => void;
  /** 다운로드 중인 모델 id(없으면 null) — 행마다 버튼을 바꾼다. */
  modelBusy: string | null;
  modelStatus: string;
  onModelDownload: (id: string) => void;
  onModelDelete: (id: string, label: string) => void;
  onCancel: (name: string) => void;
  testBusy: boolean;
  testOutput: string;
  onTest: () => void;
}) {
  const { data: st } = useLlmStatus();
  const msg = useMessages();
  // 리소스 모니터의 시스템 정보 탭과 **같은 캐시 키**를 쓴다(수집이 수 초라 두 번 돌리지 않는다).
  const { data: sys } = useQuery({
    queryKey: ["sys-info"],
    queryFn: () => ipc.sysInfoStatic(false),
    staleTime: Infinity,
    retry: false,
  });
  const ram = sys?.memory.totalBytes ?? 0;
  const vram = Math.max(0, ...(sys?.gpus ?? []).map((g) => g.vramBytes ?? 0));
  const external = form.llmProvider === "external";
  // 런타임 진행 이름은 백엔드 설정에 따라 "runtime"(auto)이거나 "runtime-cpu"(CPU 빌드)다.
  // 어느 쪽이 도는지 여기선 알 수 없으므로 둘 다 끊는다 — 없는 이름은 백엔드에서 no-op이다.
  const cancelRuntime = () => {
    onCancel("runtime");
    onCancel("runtime-cpu");
  };

  return (
    <>
      {/* ① 상태 카드 */}
      <div className="rounded border border-edge bg-base px-3 py-2 text-[12px]">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            {msg.settings.ai.runtimeLabel}{" "}
            {st?.runtime ? (
              <span className="text-ok">{msg.settings.ai.runtimeInstalled(st.runtime)}</span>
            ) : (
              <span className="text-fg-dim">{msg.settings.ai.runtimeNone}</span>
            )}
          </span>
          <span>
            {msg.settings.ai.modelsLabel}{" "}
            <span className="text-fg-muted">
              {msg.settings.ai.modelCount(st?.models.filter((m) => m.present).length ?? 0)}
            </span>
          </span>
          <span>
            {msg.settings.ai.serverLabel}{" "}
            {st?.server ? (
              <span className="text-ok">
                {msg.settings.ai.serverRunning(
                  st.server.port,
                  st.server.ready,
                  Math.floor(st.server.idleSecs / 60),
                )}
              </span>
            ) : (
              <span className="text-fg-dim">{msg.settings.ai.serverStopped}</span>
            )}
          </span>
        </div>
        <div className="mt-1 text-[11px] text-fg-dim">{msg.settings.ai.serverNote}</div>
      </div>

      {/* ② 런타임 다운로드 — "클릭이 곧 동의": 크기·출처를 버튼 옆 한 줄에 */}
      <Hl id="llmRuntimeDownload" hl={hl}>
        <div className="flex items-center gap-2">
          <button
            onClick={runtimeBusy ? cancelRuntime : onRuntimeDownload}
            disabled={!st?.runtimeSupported || (!runtimeBusy && !!st?.runtime)}
            className="shrink-0 rounded bg-accent/20 px-2 py-1 text-xs text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {runtimeBusy
              ? msg.settings.ai.cancel
              : msg.settings.ai.runtimeDownload(mb(st?.runtimeSize ?? 0))}
          </button>
          <span className="truncate text-[11px] text-fg-dim">
            {runtimeStatus ||
              (!st?.runtimeSupported
                ? msg.settings.ai.runtimeUnsupported
                : st?.runtime
                  ? msg.settings.ai.installedPath(st.runtimePath ?? "")
                  : "llama.cpp b10809 · github.com/ggml-org/llama.cpp")}
          </span>
        </div>
      </Hl>

      {/* ③ 모델 표 */}
      <div className={`border-t border-edge pt-3 ${subHeading}`}>
        {msg.settings.ai.modelsHeading}
      </div>
      <Hl id="llmModel" hl={hl}>
        <div className="flex flex-col gap-1">
          {(st?.models ?? []).map((m) => {
            // 시스템 정보가 아직(수집 수 초) 또는 영영(retry:false로 실패) 없으면 뱃지를 그리지
            // 않는다. 0으로 판정하면 로딩 내내 모든 모델이 "권장 안 함"으로 보인다.
            const rec = sys ? recommend(m.size, ram, vram) : null;
            const busy = modelBusy === m.id;
            return (
              <label
                key={m.id}
                className="flex items-center gap-2 rounded px-1 py-1 hover:bg-raised"
              >
                <input
                  type="radio"
                  name="llm-model"
                  checked={form.llmModel === m.id}
                  onChange={() => update("llmModel", m.id)}
                  className="accent-accent"
                />
                <span className="min-w-0 flex-1 truncate" title={`huggingface.co/${m.repo}`}>
                  {m.label}
                  <span className="ml-1 text-[11px] text-fg-dim">{m.note}</span>
                  {/* 다운로드 버튼이 곧 동의라 **출처를 누구인지** 보여야 한다(§3.6). 모델마다
                      제공자가 다르다 — 공식 벤더(Qwen·google)와 커뮤니티 변환본(bartowski·mykor)이 섞인다. */}
                  <span className="ml-1 text-[11px] text-fg-dim/70">{m.repo.split("/")[0]}</span>
                </span>
                <span className="shrink-0 text-[11px] text-fg-muted">{mb(m.size)}</span>
                {rec && (
                  <span className={`shrink-0 text-[11px] ${rec.tone}`}>
                    {msg.settings.ai.recommend[rec.level]}
                  </span>
                )}
                {m.present ? (
                  <button
                    onClick={() => onModelDelete(m.id, m.label)}
                    className="shrink-0 rounded px-2 py-0.5 text-[11px] text-danger hover:bg-danger/15"
                  >
                    {msg.settings.ai.delete}
                  </button>
                ) : (
                  <button
                    onClick={() => (busy ? onCancel(m.id) : onModelDownload(m.id))}
                    disabled={modelBusy != null && !busy}
                    className="shrink-0 rounded bg-accent/20 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/30 disabled:opacity-50"
                  >
                    {busy ? msg.settings.ai.cancel : msg.settings.ai.download}
                  </button>
                )}
              </label>
            );
          })}
          <label className="flex items-center gap-2 rounded px-1 py-1 hover:bg-raised">
            <input
              type="radio"
              name="llm-model"
              checked={form.llmModel === "custom"}
              onChange={() => update("llmModel", "custom")}
              className="accent-accent"
            />
            <span className="min-w-0 flex-1 truncate">
              {msg.settings.ai.customGguf}
              <span className="ml-1 text-[11px] text-fg-dim">{msg.settings.ai.customGgufNote}</span>
            </span>
            <span className={`shrink-0 text-[11px] ${st?.customModelOk ? "text-ok" : "text-fg-dim"}`}>
              {st?.customModelOk ? msg.settings.ai.customGgufOk : msg.settings.ai.customGgufMissing}
            </span>
          </label>
        </div>
      </Hl>
      <Hl id="llmModelDownload" hl={hl}>
        <div className="text-[11px] text-fg-dim">
          {modelStatus || msg.settings.ai.modelDownloadNote}
        </div>
      </Hl>
      <Hl id="llmDeleteModels" hl={hl}>
        <div className="text-[11px] text-fg-dim">{msg.settings.ai.deleteModelsNote}</div>
      </Hl>

      {/* ④ 테스트 */}
      <div className={`border-t border-edge pt-3 ${subHeading}`}>
        {msg.settings.ai.testHeading}
      </div>
      <Hl id="llmTest" hl={hl}>
        <div className="flex items-center gap-2">
          <button
            onClick={onTest}
            disabled={testBusy}
            className="shrink-0 rounded bg-accent/20 px-2 py-1 text-xs text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {testBusy ? msg.settings.ai.testWaiting : msg.settings.ai.testButton}
          </button>
          <span className="truncate text-[11px] text-fg-dim">
            {msg.settings.ai.testHint(msg.settings.ai.testPrompt)}
          </span>
        </div>
      </Hl>
      {testOutput && (
        <div className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded border border-edge bg-base px-2 py-1.5 text-[12px]">
          {testOutput}
        </div>
      )}

      {/* ⑤ 고급 */}
      <details className="border-t border-edge pt-3">
        <summary className={`cursor-pointer ${subHeading}`}>{msg.settings.ai.advanced}</summary>
        <div className="mt-3 space-y-4">
          <Hl id="llmProvider" hl={hl}>
            <Field label={msg.settings.ai.providerLabel}>
              <div className="flex gap-4">
                {(
                  [
                    ["managed", msg.settings.ai.providerManaged],
                    ["external", msg.settings.ai.providerExternal],
                  ] as const
                ).map(([id, label]) => (
                  <label key={id} className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="radio"
                      name="llm-provider"
                      checked={form.llmProvider === id}
                      onChange={() => update("llmProvider", id)}
                      className="accent-accent"
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </Field>
          </Hl>
          {external && (
            <>
              <Hl id="llmExternalUrl" hl={hl}>
                <Field label={msg.settings.ai.externalUrlLabel} hint={msg.settings.ai.externalUrlHint}>
                  <input
                    type="text"
                    value={form.llmExternalUrl ?? ""}
                    placeholder="http://localhost:11434/v1"
                    onChange={(e) => update("llmExternalUrl", e.target.value)}
                    className={`${inputCls} font-mono`}
                  />
                </Field>
              </Hl>
              <Hl id="llmExternalModel" hl={hl}>
                <Field label={msg.settings.ai.externalModelLabel} hint={msg.settings.ai.externalModelHint}>
                  <input
                    type="text"
                    value={form.llmExternalModel ?? ""}
                    placeholder="qwen3:4b"
                    onChange={(e) => update("llmExternalModel", e.target.value)}
                    className={`${inputCls} font-mono`}
                  />
                </Field>
              </Hl>
              <Hl id="llmExternalKey" hl={hl}>
                <Field label={msg.settings.ai.externalKeyLabel} hint={msg.settings.ai.externalKeyHint}>
                  <input
                    type="password"
                    value={form.llmExternalKey ?? ""}
                    onChange={(e) => update("llmExternalKey", e.target.value)}
                    className={`${inputCls} font-mono`}
                  />
                </Field>
              </Hl>
            </>
          )}
          <Hl id="llmCustomModelPath" hl={hl}>
            <Field label={msg.settings.ai.customPathLabel} hint={msg.settings.ai.customPathHint}>
              <input
                type="text"
                value={form.llmCustomModelPath ?? ""}
                placeholder={msg.settings.ai.customPathPlaceholder}
                onChange={(e) => update("llmCustomModelPath", e.target.value)}
                className={`${inputCls} font-mono`}
              />
            </Field>
          </Hl>
          <div className="flex gap-3">
            <Hl id="llmGpuLayers" hl={hl}>
              <Field label={msg.settings.ai.gpuLayersLabel} hint={msg.settings.ai.gpuLayersHint}>
                <input
                  type="number"
                  min={0}
                  max={999}
                  value={form.llmGpuLayers}
                  onChange={(e) => update("llmGpuLayers", Number(e.target.value))}
                  className={`${inputCls} w-24`}
                />
              </Field>
            </Hl>
            <Hl id="llmContext" hl={hl}>
              <Field label={msg.settings.ai.contextLabel} hint={msg.settings.ai.contextHint}>
                <input
                  type="number"
                  min={2048}
                  max={32768}
                  value={form.llmContext}
                  onChange={(e) => update("llmContext", Number(e.target.value))}
                  className={`${inputCls} w-28`}
                />
              </Field>
            </Hl>
          </div>
          <Hl id="reportAutoWeekly" hl={hl}>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={form.reportAutoWeekly}
                onChange={(e) => update("reportAutoWeekly", e.target.checked)}
                className="mt-0.5 accent-accent"
              />
              <span>
                {msg.settings.ai.reportAutoWeekly}
                <span className="ml-1 block text-[11px] text-fg-dim">
                  {msg.settings.ai.reportAutoWeeklyHintBefore}
                  <b>{msg.settings.ai.reportAutoWeeklyHintBold}</b>
                  {msg.settings.ai.reportAutoWeeklyHintAfter}
                </span>
              </span>
            </label>
          </Hl>
          <Hl id="llmReportModel" hl={hl}>
            <Field label={msg.settings.ai.reportModelLabel} hint={msg.settings.ai.reportModelHint}>
              <select
                value={form.llmReportModel ?? ""}
                onChange={(e) => update("llmReportModel", e.target.value || null)}
                className={inputCls}
              >
                <option value="">{msg.settings.ai.reportModelSameAsAbove}</option>
                {(st?.models ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {m.present ? "" : msg.settings.ai.notInstalledSuffix}
                  </option>
                ))}
              </select>
            </Field>
          </Hl>
          {/* 편집은 리포트 화면의 [프롬프트] 패널에서 한다(별도 리포트 창엔 설정 다이얼로그가 없다).
              여기 자리를 두는 이유는 favoriteFolders 와 같다 — 설정 검색으로 찾을 수 있어야 하고,
              SETTINGS_INDEX 완전성 가드(e2e 29 ⑤)가 모든 Settings 키에 항목을 요구한다. */}
          <Hl id="reportPrompt" hl={hl}>
            <Field label={msg.settings.ai.reportPromptLabel} hint={msg.settings.ai.reportPromptHint}>
              <div className="text-fg-muted">
                {form.reportPrompt?.trim() ? msg.settings.ai.reportPromptCustom : msg.settings.ai.reportPromptDefault}
              </div>
            </Field>
          </Hl>
          <Hl id="llmLanguage" hl={hl}>
            <Field label={msg.settings.ai.languageLabel} hint={msg.settings.ai.languageHint}>
              <select
                value={form.llmLanguage}
                onChange={(e) => update("llmLanguage", e.target.value)}
                className={inputCls}
              >
                <option value="ko">{msg.language.optionKorean}</option>
                <option value="en">{msg.language.optionEnglish}</option>
              </select>
            </Field>
          </Hl>
          <Hl id="llmBackend" hl={hl}>
            <Field label={msg.settings.ai.backendLabel} hint={msg.settings.ai.backendHint}>
              <select
                value={form.llmBackend}
                onChange={(e) => update("llmBackend", e.target.value === "cpu" ? "cpu" : "auto")}
                className={inputCls}
              >
                <option value="auto">{msg.settings.ai.backendAuto}</option>
                <option value="cpu">{msg.settings.ai.backendCpu}</option>
              </select>
            </Field>
          </Hl>
        </div>
      </details>
    </>
  );
}
