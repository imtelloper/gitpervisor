// AI(로컬 LLM) 설정 (태스크 59 §3.6) — 상태 카드 · 런타임 다운로드 · 모델 표 · 테스트 · 고급.
//
// 다운로드/테스트의 busy·status는 **셸(SettingsDialog)이 소유**한다. 그래야 2.5GB를 받는 중에
// 카테고리를 옮겨도 진행 표시가 살아 있다(ffmpeg `ffmpegBusy/Status`와 같은 층, §3.6 I1).
import { useQuery } from "@tanstack/react-query";

import { ipc } from "../../../lib/ipc";
import { useLlmStatus } from "../../../lib/llm";
import { Field, Hl, inputCls, type SectionProps } from "./shared";

const subHeading = "text-[11px] font-semibold tracking-widest text-fg-dim";

function mb(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${Math.round(bytes / 1024 ** 2)}MB`;
}

/**
 * 이 머신에서 돌릴 만한가(§3.5). vram ≥ size*1.15면 전체 GPU 오프로드, 아니면
 * ram ≥ size*1.3 + 1GB면 CPU/부분, 둘 다 미달이면 권장하지 않음.
 * **다운로드 버튼은 어느 쪽이든 살려 둔다** — 사용자가 자기 머신을 더 잘 안다.
 */
function recommend(size: number, ram: number, vram: number): { label: string; tone: string } {
  if (vram >= size * 1.15) return { label: "GPU 전체", tone: "text-ok" };
  if (ram >= size * 1.3 + 1024 ** 3) return { label: "CPU/부분", tone: "text-fg-muted" };
  return { label: "권장 안 함", tone: "text-warn" };
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
            런타임{" "}
            {st?.runtime ? (
              <span className="text-ok">{st.runtime} 설치됨</span>
            ) : (
              <span className="text-fg-dim">없음</span>
            )}
          </span>
          <span>
            모델 <span className="text-fg-muted">{st?.models.filter((m) => m.present).length ?? 0}개</span>
          </span>
          <span>
            서버{" "}
            {st?.server ? (
              <span className="text-ok">
                :{st.server.port} {st.server.ready ? "준비됨" : "로드 중"} · 유휴{" "}
                {Math.floor(st.server.idleSecs / 60)}분
              </span>
            ) : (
              <span className="text-fg-dim">중지</span>
            )}
          </span>
        </div>
        <div className="mt-1 text-[11px] text-fg-dim">
          첫 요청에 서버가 자동 기동합니다(모델 로드 20~60초). 10분 쉬면 자동 종료, 앱 종료 시에도
          함께 내려갑니다.
        </div>
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
              ? "취소"
              : `런타임 다운로드 (${mb(st?.runtimeSize ?? 0)})`}
          </button>
          <span className="truncate text-[11px] text-fg-dim">
            {runtimeStatus ||
              (!st?.runtimeSupported
                ? "이 플랫폼용 공식 빌드가 없습니다 — 고급의 외부 서버 URL을 쓰세요"
                : st?.runtime
                  ? `설치됨 ✓ ${st.runtimePath ?? ""}`
                  : "llama.cpp b10809 · github.com/ggml-org/llama.cpp")}
          </span>
        </div>
      </Hl>

      {/* ③ 모델 표 */}
      <div className={`border-t border-edge pt-3 ${subHeading}`}>모델 (huggingface.co)</div>
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
                {rec && <span className={`shrink-0 text-[11px] ${rec.tone}`}>{rec.label}</span>}
                {m.present ? (
                  <button
                    onClick={() => onModelDelete(m.id, m.label)}
                    className="shrink-0 rounded px-2 py-0.5 text-[11px] text-danger hover:bg-danger/15"
                  >
                    삭제
                  </button>
                ) : (
                  <button
                    onClick={() => (busy ? onCancel(m.id) : onModelDownload(m.id))}
                    disabled={modelBusy != null && !busy}
                    className="shrink-0 rounded bg-accent/20 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/30 disabled:opacity-50"
                  >
                    {busy ? "취소" : "다운로드"}
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
              사용자 지정 GGUF
              <span className="ml-1 text-[11px] text-fg-dim">고급의 경로를 씁니다</span>
            </span>
            <span className={`shrink-0 text-[11px] ${st?.customModelOk ? "text-ok" : "text-fg-dim"}`}>
              {st?.customModelOk ? "확인됨" : "경로 없음"}
            </span>
          </label>
        </div>
      </Hl>
      <Hl id="llmModelDownload" hl={hl}>
        <div className="text-[11px] text-fg-dim">
          {modelStatus || "받는 즉시 sha256으로 검증하고 원자적으로 설치합니다. 취소하면 받던 파일을 지웁니다."}
        </div>
      </Hl>
      <Hl id="llmDeleteModels" hl={hl}>
        <div className="text-[11px] text-fg-dim">
          삭제한 모델은 다시 GB 단위로 받아야 합니다 — 확인 후 지웁니다.
        </div>
      </Hl>

      {/* ④ 테스트 */}
      <div className={`border-t border-edge pt-3 ${subHeading}`}>테스트</div>
      <Hl id="llmTest" hl={hl}>
        <div className="flex items-center gap-2">
          <button
            onClick={onTest}
            disabled={testBusy}
            className="shrink-0 rounded bg-accent/20 px-2 py-1 text-xs text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {testBusy ? "응답 대기 중…" : "테스트"}
          </button>
          <span className="truncate text-[11px] text-fg-dim">
            "안녕하세요. 한 문장으로 자기소개해 주세요."를 보냅니다
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
        <summary className={`cursor-pointer ${subHeading}`}>고급</summary>
        <div className="mt-3 space-y-4">
          <Hl id="llmProvider" hl={hl}>
            <Field label="제공자">
              <div className="flex gap-4">
                {(
                  [
                    ["managed", "앱이 관리 (llama-server)"],
                    ["external", "외부 OpenAI 호환 서버"],
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
                <Field
                  label="외부 서버 URL"
                  hint="Ollama는 http://localhost:11434/v1 — 끝의 /v1은 있어도 없어도 됩니다"
                >
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
                <Field label="모델 이름" hint="그 서버가 아는 이름 — 예: qwen3:4b">
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
                <Field label="API 키" hint="로컬 서버라면 대개 비워 둡니다. settings.json에 평문 저장됩니다">
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
            <Field label="사용자 지정 GGUF 경로" hint="모델에서 '사용자 지정 GGUF'를 골랐을 때만 씁니다">
              <input
                type="text"
                value={form.llmCustomModelPath ?? ""}
                placeholder="(없음)"
                onChange={(e) => update("llmCustomModelPath", e.target.value)}
                className={`${inputCls} font-mono`}
              />
            </Field>
          </Hl>
          <div className="flex gap-3">
            <Hl id="llmGpuLayers" hl={hl}>
              <Field label="GPU 레이어 (-ngl)" hint="99 = 가능한 만큼 전부, 0 = CPU만">
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
              <Field label="컨텍스트 (-c)" hint="2048 ~ 32768. 클수록 KV 캐시 메모리를 더 씁니다">
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
          <Hl id="llmReportModel" hl={hl}>
            <Field
              label="작업 리포트 전용 모델"
              hint="요약은 기다려도 되니 더 정확한(=느린) 모델을 쓸 수 있습니다. 번역·채팅은 위에서 고른 모델 그대로입니다. 둘을 번갈아 쓰면 그때마다 서버를 다시 띄웁니다(수 초~수십 초)"
            >
              <select
                value={form.llmReportModel ?? ""}
                onChange={(e) => update("llmReportModel", e.target.value || null)}
                className={inputCls}
              >
                <option value="">위에서 고른 모델 사용</option>
                {(st?.models ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {m.present ? "" : " (미설치)"}
                  </option>
                ))}
              </select>
            </Field>
          </Hl>
          <Hl id="llmLanguage" hl={hl}>
            <Field label="출력 언어" hint="작업 요약·번역의 기본 언어">
              <select
                value={form.llmLanguage}
                onChange={(e) => update("llmLanguage", e.target.value)}
                className={inputCls}
              >
                <option value="ko">한국어</option>
                <option value="en">English</option>
              </select>
            </Field>
          </Hl>
          <Hl id="llmBackend" hl={hl}>
            <Field
              label="백엔드"
              hint="Vulkan 초기화가 실패하면 앱이 자동으로 CPU 빌드를 받아 여기에 기록합니다"
            >
              <select
                value={form.llmBackend}
                onChange={(e) => update("llmBackend", e.target.value === "cpu" ? "cpu" : "auto")}
                className={inputCls}
              >
                <option value="auto">자동 (GPU 우선)</option>
                <option value="cpu">CPU 전용</option>
              </select>
            </Field>
          </Hl>
        </div>
      </details>
    </>
  );
}
